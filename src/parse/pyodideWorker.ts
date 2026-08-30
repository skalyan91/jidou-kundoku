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
      tokens: tokens.map((t) => ({ ...t, morph: t.morph || undefined })),
    })),
  };
}

/** What the parser itself makes of one specific arc: the relation label it
 * scores highest for that arc, and how much of its probability mass at that
 * moment goes to making the arc at all.
 *
 * The label is used when the user re-parents a token by dragging, to
 * relabel it the way the model would have, rather than leaving the old
 * head's label stranded on a relation it no longer describes. The
 * confidence is used when a drag creates a cycle and one of the cycle's
 * existing arcs has to give way: the least confident goes (see
 * `planCycleBreak` in `tokenInspector.ts`).
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
 * The confidence is the softmax of those same scores over every move valid
 * at that state, summed across the moves that make this arc. It is a real
 * number out of the model — the mass it puts on attaching here and now,
 * against shifting, reducing, or attaching the other way — normalized so
 * that arcs scored at different states of the same sequence can be
 * compared. (Raw scores cannot be: they are unnormalized logits whose scale
 * drifts from state to state, so the largest raw score does not mean the
 * most confident arc.) It is a local transition probability, not a global
 * marginal over trees; what it answers is "how sure was the parser when it
 * built this arc", which is exactly the question asked of it.
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
            return {
                "label": _NAMES[_best][2:],
                "confidence": sum(_exp[_i] for _i in _arc) / _tot,
            }
        _m.apply_transition(_state, _name)
    return None

_json.dumps(_arc_label(
    ${JSON.stringify(text)},
    _json.loads(${JSON.stringify(JSON.stringify(heads))}),
    _json.loads(${JSON.stringify(JSON.stringify(deps))}),
    ${headIndex}, ${childIndex}))
`);
  return JSON.parse(result as string) as ArcScore | null;
}

/** One arc as the parser sees it — see `scoreArc`. `confidence` is in
 * [0, 1]. */
interface ArcScore {
  label: string;
  confidence: number;
}

type Request =
  | { id: number; type: "init" }
  | { id: number; type: "parse"; text: string }
  | { id: number; type: "arcScore"; text: string; heads: number[]; deps: string[]; headIndex: number; childIndex: number };
type Response =
  | { id: number; ok: true; result?: WireTokenTree | ArcScore | null }
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
  } catch (err) {
    postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response);
  }
};
