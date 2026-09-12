/// <reference lib="webworker" />
// Runs Pyodide + spaCy + lzh_sud_kyoto off the main thread. Loaded via
// `new Worker(new URL("./pyodideWorker.ts", import.meta.url), {type: "module"})`.
//
// Wheels are installed from a manifest (`/wasm/wheels/manifest.json`, an
// array of filenames relative to that same directory) rather than a
// hardcoded list, so the Phase 0 build output can change without editing
// this file. Vendored, self-hosted assets only — no PyPI/CDN network
// dependency at runtime, per the offline/static-site requirement.

import { chunkText } from "./chunkText.ts";
import { deprojectivizeSentence } from "./deprojectivize.ts";
import { gluedPunctuationTokens } from "./gluedPunctuation.ts";
import { BRACKETS, COMMAS, FULL_STOPS } from "./punctuation.ts";
import { normalizeDeprel } from "./types.ts";

interface PyodideInterface {
  loadPackage(names: string | string[]): Promise<void>;
  pyimport(name: string): PyProxy;
  runPythonAsync(code: string): Promise<unknown>;
}
// Minimal structural type for the pieces of a PyProxy this file touches;
// spaCy/micropip objects are otherwise treated as opaque.
type PyProxy = Record<string, unknown> & { (...args: unknown[]): unknown };

const PYODIDE_INDEX_URL = "/wasm/pyodide/";
const WHEELS_BASE_URL = "/wasm/wheels/";
const MODEL_PACKAGE = "lzh_sud_kyoto";

/** Every character `punctuation.ts` classifies as a mark, flattened to one
 * string and handed to the embedded Python below as a `set`. One source for
 * "what is punctuation" rather than two: `parse()`'s own retokenizing step
 * needs the identical test `gluedPunctuation.ts`'s guard runs afterward, and
 * a second, hand-copied character list in the Python string is exactly the
 * kind of thing that quietly stops matching the first one. */
const PYODIDE_PUNCTUATION_CHARS = [...FULL_STOPS, ...COMMAS, ...BRACKETS].join("");

let pyodideReady: Promise<PyodideInterface> | null = null;

async function initPyodide(): Promise<PyodideInterface> {
  const { loadPyodide } = await import(
    /* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`
  );
  const pyodide: PyodideInterface = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  await pyodide.loadPackage("micropip");

  const manifestRes = await fetch(`${WHEELS_BASE_URL}manifest.json`);
  if (!manifestRes.ok) {
    throw new Error(`Wheel manifest not found at ${WHEELS_BASE_URL}manifest.json — Phase 0 wheels not vendored yet`);
  }
  const wheelFiles: string[] = await manifestRes.json();

  const micropip = pyodide.pyimport("micropip") as unknown as {
    install(specs: string[]): Promise<void>;
  };
  await micropip.install(wheelFiles.map((f) => `${WHEELS_BASE_URL}${f}`));

  await pyodide.runPythonAsync(`
import spacy
nlp = spacy.load("${MODEL_PACKAGE}")
`);

  return pyodide;
}

interface WireToken {
  id: number;
  text: string;
  lemma: string;
  pos: string;
  xpos: string;
  dep: string;
  head: number;
  morph?: string;
}
interface WireSentence {
  tokens: WireToken[];
}
interface WireTokenTree {
  sentences: WireSentence[];
  source: "pyodide";
}

/** Runs the model in two stages rather than one, so a token the tokenizer
 * fuses a punctuation mark onto (see `gluedPunctuation.ts` for how often and
 * in what shapes) is corrected *before* the tagger and parser ever read it,
 * rather than repaired afterward by a rule of this app's own guessing what
 * they would have said.
 *
 * `nlp.tokenizer(_text)` alone produces a `Doc` with tokens and nothing
 * else — no tags, no parse, no sentence boundaries. `_analyze_glue` is the
 * Python twin of `gluedPunctuationTokens`' own detector (same character set,
 * `PYODIDE_PUNCTUATION_CHARS` below, so the two cannot drift), and every
 * token it flags is handed to `Doc.retokenize().split()` before anything
 * else runs. Only then does the rest of `nlp.pipeline` see the doc — in
 * order, by name, rather than assumed: `tok2vec`, `parser`, `morphologizer`,
 * `tagger`, then the rule-based pipes `sud_shared` through `lzh_upos_rules`,
 * which is this wheel's own `meta.json`, read rather than guessed at. Every
 * component therefore tags, attaches and segments the *real* tokens itself;
 * nothing here decides an attachment on the model's behalf.
 *
 * A chunk with nothing to split pays for one empty `with doc.retokenize()`
 * block and nothing else — the ordinary case, since the defect this exists
 * for reaches about one token in 8,586.
 *
 * `nlp.pipe(_chunks)`'s own batching is given up for this: a per-chunk
 * `Doc` is needed to retokenize before its own parse, and Pyodide's single
 * WASM thread was never the batched-throughput case that convenience was
 * for. */
async function parse(pyodide: PyodideInterface, text: string): Promise<WireTokenTree> {
  const chunks = JSON.stringify(chunkText(text));
  const resultJson = await pyodide.runPythonAsync(`
import json as _json

_PUNCT = set(${JSON.stringify(PYODIDE_PUNCTUATION_CHARS)})

def _analyze_glue(_text):
    _n = len(_text)
    _lead = 0
    while _lead < _n and _text[_lead] in _PUNCT:
        _lead += 1
    _trail = _n
    while _trail > _lead and _text[_trail - 1] in _PUNCT:
        _trail -= 1
    if _lead == 0 and _trail == _n:
        return None
    _content = _text[_lead:_trail]
    if not _content:
        return None
    return _text[:_lead], _content, _text[_trail:]

_chunks = _json.loads(${JSON.stringify(chunks)})
_out = []
for _chunk in _chunks:
    _doc = nlp.tokenizer(_chunk)
    with _doc.retokenize() as _retok:
        for _t in _doc:
            _shape = _analyze_glue(_t.text)
            if _shape is None:
                continue
            _lead, _content, _trail = _shape
            _orths = list(_lead) + [_content] + list(_trail)
            _retok.split(_t, _orths, heads=[(_t, 0)] * len(_orths))
    for _name, _proc in nlp.pipeline:
        _doc = _proc(_doc)
    for _sent in _doc.sents:
        _base = _sent[0].i
        _out.append([
            {
                "id": _t.i - _base,
                "text": _t.text,
                "lemma": _t.lemma_,
                "pos": _t.pos_ or _t.tag_,
                "xpos": _t.tag_,
                "dep": _t.dep_,
                "head": _t.head.i - _base,
                "morph": str(_t.morph),
            }
            for _t in _sent
        ])
_json.dumps(_out, ensure_ascii=False)
`);
  const sentences: WireToken[][] = JSON.parse(resultJson as string);
  const normalized = sentences.map((tokens) => tokens.map((t) => ({ ...t, morph: t.morph || undefined })));

  // The invariant `gluedPunctuation.ts` exists to state: no token below
  // should ever mix a mark with a character. Not expected to fire — that is
  // exactly what the retokenizing above is for — so this is a live guard
  // against a future wheel producing a shape `_analyze_glue` does not
  // anticipate (a mark buried mid-word, say, rather than at either edge),
  // reported rather than silently carried downstream to panels that assume
  // it cannot happen.
  const stillGlued = normalized.flatMap(gluedPunctuationTokens);
  if (stillGlued.length > 0) {
    console.warn(
      `lzh_sud_kyoto still produced a mark glued to content after retokenizing: ${stillGlued.map((t) => JSON.stringify(t.text)).join(", ")}`,
    );
  }

  return {
    source: "pyodide",
    sentences: normalized.map((tokens) => ({
      // Deprojectivized here rather than downstream: a `punct||mod` pair
      // matches no rule in the app, so a token carrying one would fall
      // through every classification without saying so — and collapsing the
      // label alone would leave the arc attached to an ancestor of its real
      // head. `deprojectivizeSentence` lowers it and collapses the label.
      //
      // In practice this finds nothing on this path: spaCy runs
      // `nonproj.deprojectivize` itself as a parser postprocess (part of
      // `Parser.set_annotations`, run above when `_proc` is the parser), so
      // the tokens already reach here deprojectivized. Applied anyway so
      // that the app owns the invariant rather than depending on a
      // postprocess hook staying wired up in some future wheel. See
      // `deprojectivize.ts`.
      tokens: deprojectivizeSentence(tokens).tokens,
    })),
  };
}

/** What the parser itself makes of one specific arc: the whole distribution
 * over relations it could give that arc, the relation it scores highest,
 * and how much of its probability mass at that moment goes to making the
 * arc at all.
 *
 * The label is used when the user re-parents a token by dragging, to
 * relabel it the way the model would have, rather than leaving the old
 * head's label stranded on a relation it no longer describes. The
 * confidence is used when a drag creates a cycle and one of the cycle's
 * existing arcs has to give way: the least confident goes (see
 * `planCycleBreak` in `tokenInspector.ts`). The distribution shades the
 * 係り受け menu, so that a relation the model would never give this arc
 * looks like one (see `shadeRetagMenu`).
 *
 * This can't come from an ordinary re-parse (that just re-derives the
 * parser's own preferred tree, ignoring the user's choice of head) or from
 * beam parses (measured: even a 256-wide beam on a 5-token sentence only
 * ever proposes 2-4 of the 5 possible heads per token, so an arbitrary
 * drag target usually isn't in it at all). Instead it drives the parser's
 * own transition system to exactly the state where this arc gets made and
 * reads the model's label distribution there:
 *
 *  1. Build an `Example` whose gold tree is the *edited* one — the user's
 *     new head for this token, with a placeholder label. Only the head
 *     matters: the state the oracle walks through is the same whatever
 *     label the gold names, so one pass suffices rather than one per label.
 *  2. Take that gold's oracle transition sequence — the moves that build
 *     precisely this tree — and replay them.
 *  3. Stop at the move that creates this arc (`ArcEager`'s `L-<label>`/
 *     `R-<label>`, whose direction says which of stack-top/buffer-front is
 *     the head) and read the model's scores at that state. The
 *     highest-scoring *valid* labelled move of that direction names the
 *     relation.
 *
 * `labels` is the softmax of those same scores over every move valid at
 * that state, restricted to the moves that make this arc — so one entry per
 * relation the model could give it, and `confidence` is their sum. They are
 * real numbers out of the model, normalized so that arcs scored at
 * different states of the same sequence can be compared. (Raw scores cannot
 * be: they are unnormalized logits whose scale drifts from state to state,
 * so the largest raw score does not mean the most confident arc.) They are
 * local transition probabilities, not global marginals over trees; what
 * they answer is "how sure was the parser when it built this arc, and of
 * what", which is exactly the question asked of them.
 *
 * Deliberately *not* renormalized over the relations alone. Divided through
 * by `confidence` they would answer "given that this arc exists, which
 * relation" — the same ranking, but with the parser's doubt about the arc
 * itself divided out, so that a relation the parser barely wanted at all
 * came back looking certain. Left as they are, one number says both things
 * at once: 三百→田 tops out at 0.013 and 黍→種 at 0.985, which is the
 * difference between an arc the parser is guessing at and one it is sure
 * of, and the menu shows that difference.
 *
 * A relation absent from `labels` is one the transition system ruled
 * *invalid* at this state, which is a probability of zero and not an
 * absence of information: spaCy's arc-eager only allows a relation in a
 * direction it was trained to take (measured on 負郭田三百畝、輒半種黍: 24 of
 * the 34 relations are available rightward and 21 leftward — `clf` never
 * goes leftward, a classifier always following its numeral). `labels` also
 * carries the deprojectivization pseudo-labels (`punct||mod` and the like),
 * which no caller has a use for and which simply match nothing.
 *
 * Returns null when the arc can't be reached: the arc-eager oracle only
 * realizes projective trees, so a drag that would cross another arc has no
 * transition sequence to walk (verified: 2 of 6 sampled arcs on a test
 * sentence). An unreached arc has *no* confidence, which is not the same as
 * a low one — see `planCycleBreak`, which will not drop an arc it could not
 * score in favour of one it could. Callers leave the existing label alone
 * in that case. */
async function scoreArc(
  pyodide: PyodideInterface,
  text: string,
  heads: number[],
  deps: string[],
  headIndex: number,
  childIndex: number,
): Promise<ArcScore | null> {
  const result = await pyodide.runPythonAsync(`
import json as _json
import math as _math
from spacy.training import Example as _Example

_p = nlp.get_pipe("parser")
_m = _p.moves
_NAMES = [_m.get_class_name(_i) for _i in range(_m.n_moves)]

def _arc_label(_text, _heads, _deps, _head_i, _child_i):
    _doc = nlp.make_doc(_text)
    # Tokenization must line up with the tree the caller measured against;
    # bail rather than score a mismatched arc.
    if len(_doc) != len(_heads):
        return None
    for _nm, _pipe in nlp.pipeline:
        if _nm != "parser":
            _doc = _pipe(_doc)
    _eg = _Example.from_dict(_doc, {"heads": _heads, "deps": _deps})
    _seq = [_x if isinstance(_x, str) else _NAMES[_x] for _x in _m.get_oracle_sequence(_eg)]
    _step = _p.model.predict([_doc])
    _state = _m.init_batch([_doc])[0]
    for _name in _seq:
        _s0 = _state.S(0) if _state.stack_depth() > 0 else -1
        _b0 = _state.B(0)
        if _s0 == _head_i and _b0 == _child_i:
            _want = "R-"
        elif _b0 == _head_i and _s0 == _child_i:
            _want = "L-"
        else:
            _want = None
        if _want and _name.startswith(_want):
            _scores = _step.predict([_state])[0]
            _valid = [_i for _i in range(_m.n_moves) if _m.is_valid(_state, _NAMES[_i])]
            _arc = [_i for _i in _valid if _NAMES[_i].startswith(_want)]
            if not _arc:
                return None
            # Softmax over the valid moves only — the invalid ones are not
            # choices the parser could have made here, so letting them take
            # mass would understate every arc by a different amount.
            # Shifted by the maximum, the usual guard against exp overflow.
            _top = max(float(_scores[_i]) for _i in _valid)
            _exp = {_i: _math.exp(float(_scores[_i]) - _top) for _i in _valid}
            _tot = sum(_exp.values())
            _best = max(_arc, key=lambda _i: float(_scores[_i]))
            _labels = {_NAMES[_i][2:]: _exp[_i] / _tot for _i in _arc}
            return {
                "label": _NAMES[_best][2:],
                "confidence": sum(_labels.values()),
                "labels": _labels,
            }
        _m.apply_transition(_state, _name)
    return None

_json.dumps(_arc_label(
    ${JSON.stringify(text)},
    _json.loads(${JSON.stringify(JSON.stringify(heads))}),
    _json.loads(${JSON.stringify(JSON.stringify(deps))}),
    ${headIndex}, ${childIndex}))
`);
  const arc = JSON.parse(result as string) as ArcScore | null;
  // The winning move's name can itself be a deprojectivization pseudo-label
  // (`subj||comp:obj` is the one such move this model has), and callers put
  // this straight onto `token.dep` when the user re-parents by dragging —
  // the one place in the app where a decorated label could still reach a
  // tree, now that both parse entry points deprojectivize. Collapsed, not
  // deprojectivized: the head half of the pair describes a lift the *parser*
  // would have made, and the user has just chosen the head by hand, so there
  // is nothing to lower. `labels` is left as it is — see the note above on
  // why the distribution keeps them.
  return arc === null ? null : { ...arc, label: normalizeDeprel(arc.label) };
}

/** One arc as the parser sees it — see `scoreArc`. `confidence` is in
 * [0, 1], and is the sum of `labels`. */
interface ArcScore {
  label: string;
  confidence: number;
  labels: Record<string, number>;
}

/** The model's own distribution over UPOS for one token — used to shade the
 * 品詞 menu the way `scoreArc`'s `labels` shades the 係り受け one.
 *
 * A different pipe answers this: the tag comes from the `morphologizer`,
 * not the parser, so this is its distribution and not a second opinion
 * squeezed out of the parser's. Its 157 classes are whole morphological
 * analyses (`Degree=Pos|POS=VERB|VerbForm=Part`), so the UPOS distribution
 * is the softmax over those, summed by the `POS=` each carries — a
 * marginal, arrived at by adding up probabilities that already are ones.
 *
 * Validated on 負郭田三百畝、輒半種黍: the argmax matches the tag the pipeline
 * itself assigned for all ten tokens, and where the sentence is genuinely
 * ambiguous the runners-up are the right ones — 半 comes out VERB 0.786 /
 * ADV 0.204, 種 VERB 0.933 / NOUN 0.066 (to sow, against a kind), 郭 NOUN
 * 0.965 / PROPN 0.034.
 *
 * The model has 14 of the 17 UPOS the menu offers: ADJ, DET and X are not
 * in its label set at all, which for this treebank is a fact about
 * Classical Chinese rather than a gap (adjectives are stative verbs there).
 * They come back absent, which is a probability of zero — the model cannot
 * emit them — and not an absence of information.
 *
 * Null where there is no such pipe, where the token index is out of range,
 * or where the tokenization the caller measured against no longer matches;
 * callers leave the menu unshaded in that case. */
async function posDistribution(
  pyodide: PyodideInterface,
  text: string,
  tokenCount: number,
  tokenIndex: number,
): Promise<Record<string, number> | null> {
  const result = await pyodide.runPythonAsync(`
import json as _json
import math as _math

def _pos_dist(_text, _count, _i):
    if "morphologizer" not in nlp.pipe_names or "tok2vec" not in nlp.pipe_names:
        return None
    _doc = nlp.make_doc(_text)
    # Same discipline as _arc_label: never answer about a tokenization other
    # than the one the caller is looking at.
    if len(_doc) != _count or _i < 0 or _i >= len(_doc):
        return None
    # Only the tok2vec, whose vectors the morphologizer's own model reads
    # through its listener. The rest of the pipeline has no bearing on the
    # tag distribution and would cost a parse for nothing.
    _doc = nlp.get_pipe("tok2vec")(_doc)
    _mo = nlp.get_pipe("morphologizer")
    _scores = _mo.model.predict([_doc])
    _row = (_scores[0] if isinstance(_scores, list) else _scores)[_i]
    _labels = list(_mo.labels)
    # Raw logits, not probabilities — softmax them (shifted by the maximum,
    # the usual guard against exp overflow) before adding anything up.
    _top = max(float(_x) for _x in _row)
    _exp = [_math.exp(float(_x) - _top) for _x in _row]
    _tot = sum(_exp)
    _out = {}
    for _k, _lab in enumerate(_labels):
        for _part in _lab.split("|"):
            if _part.startswith("POS="):
                _pos = _part[4:]
                _out[_pos] = _out.get(_pos, 0.0) + _exp[_k] / _tot
                break
    return _out

_json.dumps(_pos_dist(${JSON.stringify(text)}, ${tokenCount}, ${tokenIndex}))
`);
  return JSON.parse(result as string) as Record<string, number> | null;
}

/** The Python behind *both* xpos requests, defined once and evaluated by
 * either of the two wrappers below with a different last line.
 *
 * There are two entry points because there are two callers — one asking about
 * a token, one about a sentence — and one body because they are the same
 * measurement: `_xpos_row` is `_xpos_rows(...)[i]`, spelled that way rather
 * than duplicated so that "the batch agrees with the single call" is a fact
 * about the source and not a thing to keep testing. The index check is
 * deliberately in front of `_xpos_rows` rather than inside it: an out-of-range
 * index is refused for the price of two comparisons instead of a forward pass,
 * which is what the version with the check next to the tokenization check
 * used to do. It is exact, too — `_xpos_rows` only returns a list at all when
 * `len(_doc) == _count`, so an index inside `[0, _count)` is inside the doc.
 *
 * Everything the two share — which pipe, why the joint block, why these are
 * already probabilities, why the whole pipeline prefix runs — is documented on
 * `xposDistribution` below, which is the older of the two and where a reader
 * will look first. */
const XPOS_PYTHON = `
import json as _json

def _xpos_rows(_text, _count):
    if "tagger" not in nlp.pipe_names or "tok2vec" not in nlp.pipe_names:
        return None
    _tg = nlp.get_pipe("tagger")
    # A plain spaCy tagger has neither of these, and a multifield_tagger built
    # with joint=false has no joint block to read: refuse rather than answer
    # out of the field marginals, which are a distribution over a grid that is
    # 99.93% empty.
    _att = list(getattr(_tg, "attested", None) or [])
    _jo = getattr(_tg, "joint_offset", None)
    if not _att or _jo is None:
        return None
    _doc = nlp.make_doc(_text)
    # Same discipline as _arc_label and _pos_dist: never answer about a
    # tokenization other than the one the caller is looking at.
    if len(_doc) != _count:
        return None
    # Everything upstream of the tagger, because the tagger's own encoder reads
    # the POS and morphological features the morphologizer writes — see the
    # note on xposDistribution, where tagging off a bare tok2vec is measured
    # going wrong.
    for _name, _pipe in nlp.pipeline:
        if _name == "tagger":
            break
        _doc = _pipe(_doc)
    _scores = _tg.predict([_doc])
    _rows = _scores[0] if isinstance(_scores, list) else _scores
    _out = []
    for _i in range(len(_doc)):
        _row = _rows[_i]
        # A row too short to hold the joint block is a model that is not the
        # component this reads — a fact about the pipeline, not about this
        # token, so the whole answer goes rather than one entry of it.
        if len(_row) < _jo + len(_att):
            return None
        # Already a softmax (Softmax_v2, normalize_outputs default), so this is
        # a renormalisation against float32 drift and nothing more. The clamp
        # is for the same drift: a probability cannot be negative, and one that
        # reads as -1e-9 must not be handed to a caller that draws it.
        _block = [max(0.0, float(_x)) for _x in _row[_jo:_jo + len(_att)]]
        _tot = sum(_block)
        # Per token, because a block that summed to nothing says only that this
        # token has no usable distribution; its neighbours' are still good.
        _out.append(None if _tot <= 0.0 else {_tag: _p / _tot for _tag, _p in zip(_att, _block) if _p > 0.0})
    return _out

def _xpos_row(_text, _count, _i):
    if _i < 0 or _i >= _count:
        return None
    _rows = _xpos_rows(_text, _count)
    return None if _rows is None else _rows[_i]
`;

/** The model's own distribution over the treebank's four-field xpos for one
 * token, keyed by the whole tag (`"v,動詞,行為,動作"`), values summing to 1 —
 * the counterpart of `posDistribution`, and the one the 品詞/意味 menus are
 * actually shaded from, those menus being made of xpos rows rather than UPOS.
 *
 * **Which pipe, and what its output row looks like.** The `tagger` here is not
 * spaCy's: it is this wheel's own `multifield_tagger`
 * (`lzh_sud_kyoto/sud_multifield_tagger.py`), whose model
 * `sud.MultiFieldTagger.v2` puts *five* softmaxes side by side in one row —
 * one per xpos field (4 / 12 / 46 / 84 columns, the fields of `v,動詞,行為,動作`)
 * and then a joint one over the 121 whole tags the training data attests.
 * Measured on the shipped wheel: 267 columns, the joint block starting at 146.
 * The component publishes all of that — `attested`, `offsets`, `joint_offset` —
 * so none of it is inferred here.
 *
 * **The joint block, not a product of the four field marginals.** The fields
 * are nowhere near independent: the component's own module doc puts 121 of the
 * 4 × 12 × 46 × 84 = 185,472 combinations in the treebank, 0.07% of the grid,
 * and multiplying four marginals would spread most of the mass over the other
 * 99.93% — `v,動詞` crossed with `句点`, and so on for 185,351 tags that cannot
 * exist. The joint head is trained on whole codes and puts zero there by
 * construction. It is also what the component itself decodes from: with the
 * shipped `project = true`, `joint = true`, `field_weight = 0.0`, `_decode`
 * ranks the attested tags by the joint log-probability alone and the field
 * heads never enter. The marginals were the documented fallback for a model
 * built with `joint = false`; that model would have no block to read and this
 * returns null instead, because a fallback nothing in the app can exercise is
 * a second decoder to keep correct rather than a safety net.
 *
 * **These are already probabilities — do not softmax them.** Each block is a
 * `Softmax_v2` at its default `normalize_outputs`, so `predict` hands back a
 * normalised distribution per block (verified: every field block and the joint
 * block sum to 1.000 on all ten tokens of 負郭田三百畝、輒半種黍). This is the
 * one place where this function must *not* copy `posDistribution`, whose
 * morphologizer is a `spacy.Tagger.v2` configured `normalize = false` and so
 * really does emit logits. Exponentiating a row that is already normalised
 * would flatten it beyond recovery — no two values in [0, 1] can come out more
 * than a factor of e apart — so the only arithmetic here is a defensive
 * renormalisation against float32 drift.
 *
 * **Every pipe before the tagger is run, not just the tok2vec.** The other
 * departure from `posDistribution`, and it is forced: the tagger's encoder is
 * `sud.Tok2VecPlusFeats.v1`, whose `sud.MultiHashEmbedFeats.v1` reads `POS`
 * and the Case/NameType/Degree/VerbForm/PronType/Person features off the
 * token — all of them written by the morphologizer, which runs upstream. Feed
 * it a doc carrying only tok2vec vectors and it is tagging blind on the very
 * features it was trained to lean on: measured over 60 tokens of four
 * sentences, 2 argmaxes then disagree with the tag the pipeline itself
 * assigned (道 in 道千乘之國 goes 固定物,建造物 → 制度,儀礼; 將 in 天將降大任
 * goes 副詞,時相,将来 → 名詞,人,役割), against 0 when the upstream pipes have
 * run. The parser is in that prefix and contributes exactly nothing — over 94
 * tokens, dropping it changes no score by a single float — which is what the
 * config predicts, no `DEP` appearing in the tagger's features or the
 * morphologizer's. It is run anyway so that the invariant is "the doc is in
 * the state the tagger sees in the pipeline" rather than a fact about which
 * features this wheel's config happens to list.
 *
 * **Validated on 負郭田三百畝、輒半種黍, 學而時習之、不亦說乎, 子曰、道千乘之國…
 * and 天將降大任於是人也…**: the argmax of this distribution equals `_t.tag_`
 * from a full `nlp()` for all 60 tokens. That is an identity rather than a
 * coincidence — see `_decode` above — but it is the identity that would break
 * first if the offsets were read wrongly, so it is the thing worth measuring.
 * Where the sentence is genuinely ambiguous the runners-up are the right ones:
 * 說 comes out 行為,態度 0.557 / 行為,伝達 0.418 (the 悦 and 説 readings of the
 * same graph), 任 in 大任 splits 505/478 between the verbal 行為,役割 and the
 * nominal 名詞,人,役割, 也 splits 提示 0.605 / 句末 0.391, and 種黍 gives
 * 行為,動作 0.843 over 固定物,樹木 0.133 — to sow, against a kind.
 *
 * **The UPOS mask is deliberately not applied.** `upos_mask` is what the
 * component was built for — restrict the candidates to the tags a UPOS was
 * seen with, so that a hand-corrected UPOS drags the xpos after it — and the
 * config in the wheel asks for it. It is nevertheless *off* in the shipped
 * pipeline: `from_disk` does `cfg.update(...)` from the component's serialised
 * `cfg`, which carries the factory default `false`, and the value in
 * `config.cfg` loses. Not restored here either, because this distribution
 * shades a menu the reader is using to *disagree* with the pipeline: masking
 * would delete from the menu exactly the rows that contradict a UPOS which is
 * itself only the morphologizer's guess (the component's doc measures that
 * guess wrong 6.87% of the time). A tag the mask would have removed comes back
 * with the small probability the model gives it, which is the more honest
 * thing to draw.
 *
 * Null in the same cases as `posDistribution` — no such pipe, index out of
 * range, a tokenization other than the caller's — and additionally where the
 * pipe named `tagger` is not this component at all (no `attested` inventory,
 * or `joint_offset` null because it was built `joint = false`). Callers fall
 * back to the corpus prior. A tag absent from the result is one the joint
 * softmax underflowed to zero, which is a probability of zero and not a gap —
 * in practice a float32 softmax underflows rarely and all 121 come back, so a
 * caller gets the whole inventory scored rather than a shortlist. */
async function xposDistribution(
  pyodide: PyodideInterface,
  text: string,
  tokenCount: number,
  tokenIndex: number,
): Promise<Record<string, number> | null> {
  const result = await pyodide.runPythonAsync(`${XPOS_PYTHON}
_json.dumps(_xpos_row(${JSON.stringify(text)}, ${tokenCount}, ${tokenIndex}), ensure_ascii=False)
`);
  return JSON.parse(result as string) as Record<string, number> | null;
}

/** The same distribution for *every* token of the sentence, in token order —
 * one entry per token, each of them what `xposDistribution` would have
 * returned for that index, and null in place of an entry the tagger's joint
 * block underflowed to nothing. Null instead of the list where the whole
 * question is refused: the cases are `xposDistribution`'s own, minus the
 * out-of-range index, which cannot arise when nobody is naming an index.
 *
 * **This is the same work as one token's, and that is the whole point.** The
 * Python is literally shared — `_xpos_row` below is `_xpos_rows(...)[i]` — so
 * the two cannot drift, and row *i* of this list is the single-token call's
 * answer for *i* by construction rather than by agreement. What differs is
 * only what is thrown away: the pipeline that has to run before the tagger
 * (tok2vec, morphologizer, and everything else upstream — see above for why
 * the whole prefix is needed) runs over the whole doc either way and produces
 * a score row per token either way, and picking one row out of the array was
 * the only thing that made the single-token call single. So a caller wanting
 * the sentence pays one pass here where N separate `xposScores` calls would
 * have re-run the pipeline N times over the same string. The extra cost of
 * keeping the other rows is building N dicts of ≤121 floats and serialising
 * them, which is nothing beside a forward pass.
 *
 * **Measured**, on the shipped model outside Pyodide (spaCy 3.8.15 +
 * lzh_sud_kyoto 0.3.2, this same Python `exec`'d against a real pipeline):
 * over 負郭田三百畝、輒半種黍, 學而時習之、不亦說乎, 子曰、道千乘之國… and
 * 天將降大任於是人也 — 53 tokens — every row of this equals the single-token
 * call's answer for the same index exactly, and every row's argmax is still
 * the tag the full `nlp()` assigns. The pass costs 4–6ms per sentence against
 * 32–139ms for the same sentence's tokens asked one at a time (10 tokens:
 * 5ms against 39ms; 24 tokens: 6ms against 139ms), which is the linear
 * blow-up this exists to remove — native numbers, so the WASM ones are larger
 * but in the same ratio.
 *
 * The size of the answer is worth knowing before caching it: all 121 attested
 * tags come back scored (nothing underflows in practice), which is ~4.5KB of
 * JSON per token — 108k characters for the 24-token 子曰、道千乘之國…. That is
 * small per sentence and not small per document, which is why the client
 * caches the sentences the reader has actually opened, and caps how many —
 * see `xposScoreCache.ts`. */
async function xposDistributions(
  pyodide: PyodideInterface,
  text: string,
  tokenCount: number,
): Promise<(Record<string, number> | null)[] | null> {
  const result = await pyodide.runPythonAsync(`${XPOS_PYTHON}
_json.dumps(_xpos_rows(${JSON.stringify(text)}, ${tokenCount}), ensure_ascii=False)
`);
  return JSON.parse(result as string) as (Record<string, number> | null)[] | null;
}

type Request =
  | { id: number; type: "init" }
  | { id: number; type: "parse"; text: string }
  | { id: number; type: "arcScore"; text: string; heads: number[]; deps: string[]; headIndex: number; childIndex: number }
  | { id: number; type: "posScores"; text: string; tokenCount: number; tokenIndex: number }
  | { id: number; type: "xposScores"; text: string; tokenCount: number; tokenIndex: number }
  | { id: number; type: "xposScoresForSentence"; text: string; tokenCount: number };
type Response =
  | {
      id: number;
      ok: true;
      result?: WireTokenTree | ArcScore | Record<string, number> | (Record<string, number> | null)[] | null;
    }
  | { id: number; ok: false; error: string };

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, type } = event.data;
  try {
    if (type === "init") {
      if (!pyodideReady) pyodideReady = initPyodide();
      await pyodideReady;
      postMessage({ id, ok: true } satisfies Response);
      return;
    }
    if (type === "parse") {
      if (!pyodideReady) throw new Error("Parser not initialized — call init first");
      const pyodide = await pyodideReady;
      const result = await parse(pyodide, event.data.text);
      postMessage({ id, ok: true, result } satisfies Response);
      return;
    }
    if (type === "arcScore") {
      if (!pyodideReady) throw new Error("Parser not initialized — call init first");
      const pyodide = await pyodideReady;
      const { text, heads, deps, headIndex, childIndex } = event.data;
      const result = await scoreArc(pyodide, text, heads, deps, headIndex, childIndex);
      postMessage({ id, ok: true, result } satisfies Response);
      return;
    }
    if (type === "posScores") {
      if (!pyodideReady) throw new Error("Parser not initialized — call init first");
      const pyodide = await pyodideReady;
      const { text, tokenCount, tokenIndex } = event.data;
      const result = await posDistribution(pyodide, text, tokenCount, tokenIndex);
      postMessage({ id, ok: true, result } satisfies Response);
      return;
    }
    if (type === "xposScores") {
      if (!pyodideReady) throw new Error("Parser not initialized — call init first");
      const pyodide = await pyodideReady;
      const { text, tokenCount, tokenIndex } = event.data;
      const result = await xposDistribution(pyodide, text, tokenCount, tokenIndex);
      postMessage({ id, ok: true, result } satisfies Response);
      return;
    }
    if (type === "xposScoresForSentence") {
      if (!pyodideReady) throw new Error("Parser not initialized — call init first");
      const pyodide = await pyodideReady;
      const { text, tokenCount } = event.data;
      const result = await xposDistributions(pyodide, text, tokenCount);
      postMessage({ id, ok: true, result } satisfies Response);
      return;
    }
  } catch (err) {
    postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response);
  }
};
