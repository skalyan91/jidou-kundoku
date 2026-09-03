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

async function parse(pyodide: PyodideInterface, text: string): Promise<WireTokenTree> {
  const chunks = JSON.stringify(chunkText(text));
  const resultJson = await pyodide.runPythonAsync(`
import json as _json
_chunks = _json.loads(${JSON.stringify(chunks)})
_out = []
for _doc in nlp.pipe(_chunks):
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
  return {
    source: "pyodide",
    sentences: sentences.map((tokens) => ({
      // Deprojectivized here rather than downstream: a `punct||mod` pair
      // matches no rule in the app, so a token carrying one would fall
      // through every classification without saying so — and collapsing the
      // label alone would leave the arc attached to an ancestor of its real
      // head. `deprojectivizeSentence` lowers it and collapses the label.
      //
      // In practice this finds nothing on this path: spaCy runs
      // `nonproj.deprojectivize` itself as a parser postprocess, so
      // `nlp.pipe` has already done the same work by the time the tokens
      // reach here. Applied anyway so that the app owns the invariant rather
      // than depending on a postprocess hook staying wired up in some future
      // wheel. See `deprojectivize.ts`.
      tokens: deprojectivizeSentence(
        tokens.map((t) => ({ ...t, morph: t.morph || undefined })),
      ).tokens,
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

type Request =
  | { id: number; type: "init" }
  | { id: number; type: "parse"; text: string }
  | { id: number; type: "arcScore"; text: string; heads: number[]; deps: string[]; headIndex: number; childIndex: number }
  | { id: number; type: "posScores"; text: string; tokenCount: number; tokenIndex: number };
type Response =
  | { id: number; ok: true; result?: WireTokenTree | ArcScore | Record<string, number> | null }
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
  } catch (err) {
    postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response);
  }
};
