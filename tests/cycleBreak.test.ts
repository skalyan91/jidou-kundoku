import { describe, expect, it } from "vitest";
import {
  applyCycleBreak,
  assertSingleRootedTree,
  cycleBreakCandidates,
  cycleChildOfDraggedToken,
  cyclePath,
  planCycleBreak,
} from "../src/render/tokenInspector.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

function token(id: number, text: string, head: number, dep: string, pos: string, xpos: string): Token {
  return { id, text, lemma: text, pos, xpos, dep, head };
}

/** 負郭田三百畝、輒半種黍 — "he had a hundred acres by the city wall, and
 * always sowed half of it with millet". The parse below is exactly what the
 * shipped lzh_sud_kyoto model produces for it (captured from a live parse in
 * the browser), because the whole point of this sentence here is the shape
 * of that particular tree: 種 is the ROOT, so every one of its eight
 * possible drop targets lies inside its own subtree, and 負 loses four of
 * its eight the same way. 16 of the 72 draggable pairs close a cycle. */
function fuKakuDen(): Sentence {
  return {
    tokens: [
      token(0, "負", 8, "mod", "VERB", "v,動詞,行為,動作"),
      token(1, "郭", 2, "mod", "NOUN", "n,名詞,固定物,建造物"),
      token(2, "田", 0, "comp:obj", "NOUN", "n,名詞,固定物,地形"),
      token(3, "三百", 2, "mod", "NUM", "n,数詞,数,*"),
      token(4, "畝", 3, "clf", "NOUN", "n,名詞,度量衡,*"),
      token(5, "、", 0, "punct", "PUNCT", "s,記号,読点,*"),
      token(6, "輒", 8, "mod", "ADV", "v,副詞,時相,緊接"),
      token(7, "半", 8, "mod", "ADJ", "v,動詞,描写,量"),
      token(8, "種", 8, "ROOT", "VERB", "v,動詞,行為,動作"),
      token(9, "黍", 8, "comp:obj", "NOUN", "n,名詞,可搬,糧食"),
    ],
  };
}

/** The parser's own confidence in each arc of that tree, keyed by the arc's
 * dependent — the number `scoreArc` returns, measured against this exact
 * tree in the running app. Kept as a fixture so the ranking can be tested
 * without a browser and a 200MB Pyodide image; the numbers themselves are
 * checked against the live parser separately.
 *
 * They are worth reading. The stereotyped arcs sit near 1 (黍 as 種's object,
 * 0.997; 輒 as its adverb, 0.994) and the one genuine attachment ambiguity
 * in the sentence sits near 0: 三百 under 田, 0.022, the numeral-classifier
 * phrase the model would rather have built some other way. */
const CONFIDENCE = new Map<number, number | null>([
  [0, 0.6703675376032125],
  [1, 0.9115543611329573],
  [2, 0.9751733796269939],
  [3, 0.022132907365924884],
  [4, 0.5974801322893628],
  [5, 0.9057966629001701],
  [6, 0.9940762617322443],
  [7, 0.9834319119164687],
  [9, 0.9968772276513721],
]);

const shape = (sentence: Sentence) => sentence.tokens.map((t) => `${t.text}:${t.dep}:${t.head}`);

/** The whole drop, as `reparentBreakingCycle` performs it: plan against the
 * pre-drag tree, apply, and check the result is still a tree. */
function drop(sentence: Sentence, childId: number, newHeadId: number, confidences = CONFIDENCE) {
  const plan = planCycleBreak(sentence, childId, newHeadId, confidences);
  if (!plan) throw new Error("expected a cycle to break");
  applyCycleBreak(sentence, childId, newHeadId, plan);
  assertSingleRootedTree(sentence);
  return plan;
}

describe("cyclePath", () => {
  it("finds no cycle where the target is outside the dragged token's subtree", () => {
    const s = fuKakuDen();
    expect(cyclePath(s, 9, 0)).toBeNull(); // 黍 onto 負
    expect(cyclePath(s, 4, 8)).toBeNull(); // 畝 onto 種
    expect(cyclePath(s, 1, 3)).toBeNull(); // 郭 onto 三百
  });

  it("returns the cycle, drop target first, when the target is inside it", () => {
    const s = fuKakuDen();
    expect(cyclePath(s, 0, 2)).toEqual([2, 0]); // 負 onto 田
    expect(cyclePath(s, 0, 4)).toEqual([4, 3, 2, 0]); // 負 onto 畝
    expect(cyclePath(s, 2, 4)).toEqual([4, 3, 2]); // 田 onto 畝
  });

  it("makes a cycle of every target for the ROOT, which has the whole sentence under it", () => {
    const s = fuKakuDen();
    for (const target of [0, 1, 2, 3, 4, 6, 7, 9]) {
      expect(cyclePath(s, 8, target)).not.toBeNull();
    }
  });

  it("lists every arc on the cycle except the reader's own, dragged token first", () => {
    const s = fuKakuDen();
    expect(cycleBreakCandidates(s, cyclePath(s, 0, 4)!, 0)).toEqual([
      { child: 2, head: 0, dep: "comp:obj" },
      { child: 3, head: 2, dep: "mod" },
      { child: 4, head: 3, dep: "clf" },
    ]);
  });
});

describe("cycleChildOfDraggedToken", () => {
  // The one direct dependent of the dragged token that the dependent-cascade
  // feature (`cascadeDependents` in tokenInspector.ts) must leave entirely to
  // this older machinery — offering it a second "move to the new head" option
  // would be offering a move into its own descendant, since the new head sits
  // inside its subtree by the very construction that put it on the cycle.
  it("names the token on the cycle path whose own head really is the dragged token", () => {
    const s = fuKakuDen();
    // 負 onto 畝: the cycle runs 畝→三百→田→負, and 田 (id 2) is the one whose
    // own `head` field is 負 (id 0) — confirmed against `cycleBreakCandidates`,
    // whose first entry is this same arc by the same construction.
    const cycle = cyclePath(s, 0, 4)!;
    expect(cycle).toEqual([4, 3, 2, 0]);
    expect(cycleChildOfDraggedToken(cycle)).toBe(2);
    expect(cycleBreakCandidates(s, cycle, 0)[0].child).toBe(cycleChildOfDraggedToken(cycle));
  });

  it("is the new head itself in the one-step case", () => {
    const s = fuKakuDen();
    // 負 onto 田: dragging a token onto its own direct child leaves a cycle of
    // exactly two, and the token immediately below the dragged one on that
    // path is the new head itself — there is nothing else on the path to be.
    const cycle = cyclePath(s, 0, 2)!;
    expect(cycle).toEqual([2, 0]);
    expect(cycleChildOfDraggedToken(cycle)).toBe(2);
  });

  it("holds for every one of the sentence's real cycles, not just the two worked above", () => {
    for (const child of [0, 1, 2, 3, 4, 6, 7, 8, 9]) {
      for (const target of [0, 1, 2, 3, 4, 6, 7, 8, 9]) {
        if (child === target) continue;
        const s = fuKakuDen();
        const cycle = cyclePath(s, child, target);
        if (!cycle) continue;
        const byId = new Map(s.tokens.map((t) => [t.id, t]));
        const found = cycleChildOfDraggedToken(cycle)!;
        expect(byId.get(found)!.head, `${child} onto ${target}: cycle ${cycle}`).toBe(child);
      }
    }
  });

  it("is undefined for an input too short to hold one", () => {
    // `cyclePath` itself never returns anything this short — null for "no
    // cycle" or an array of two or more for a real one — but the function
    // does not assume that of its argument.
    expect(cycleChildOfDraggedToken([])).toBeUndefined();
    expect(cycleChildOfDraggedToken([5])).toBeUndefined();
    expect(cycleChildOfDraggedToken([5, 7])).toBe(5);
  });
});

describe("planCycleBreak", () => {
  it("drops the parser's least confident arc on the cycle", () => {
    const s = fuKakuDen();
    // 負 onto 畝 — three arcs in the way, and 三百→田 (0.022) is the one the
    // parser was least sure of.
    const plan = planCycleBreak(s, 0, 4, CONFIDENCE)!;
    expect(plan.dropped).toEqual({ child: 3, head: 2, dep: "mod" });
    expect(plan.confidence).toBeCloseTo(0.0221, 4);
    expect(plan.candidateCount).toBe(3);
  });

  it("never drops the reader's own edge", () => {
    const s = fuKakuDen();
    for (const [child, target] of [
      [8, 4],
      [0, 4],
      [2, 4],
      [3, 4],
    ]) {
      const plan = planCycleBreak(s, child, target, CONFIDENCE)!;
      expect(plan.dropped.child).not.toBe(child);
      expect(plan.cycle).toContain(child);
    }
  });

  it("re-hangs the orphan on the dragged token's old head", () => {
    const s = fuKakuDen();
    // 田's old head is 負; dragging 田 under 畝 leaves whatever it drops
    // hanging from 負.
    expect(planCycleBreak(s, 2, 4, CONFIDENCE)!.reattachTo).toBe(0);
  });

  it("makes the orphan the new ROOT when the dragged token was the ROOT", () => {
    const s = fuKakuDen();
    expect(planCycleBreak(s, 8, 4, CONFIDENCE)!.reattachTo).toBeNull();
  });

  it("treats an unscored arc as unknown, not as unconfident", () => {
    const s = fuKakuDen();
    // 三百→田 is the lowest-scoring arc in the sentence; with no score at all
    // it must not be preferred to an arc that has one, however confident.
    const partial = new Map(CONFIDENCE);
    partial.set(3, null);
    const plan = planCycleBreak(s, 0, 4, partial)!;
    expect(plan.dropped.child).toBe(4); // 畝→三百, 0.597 — the lowest that is known
    expect(plan.confidence).toBeCloseTo(0.5975, 4);
  });

  it("falls back to the arc into the dragged token when nothing can be scored", () => {
    const s = fuKakuDen();
    const plan = planCycleBreak(s, 0, 4, new Map())!;
    expect(plan.dropped).toEqual({ child: 2, head: 0, dep: "comp:obj" });
    // Null, not zero: the caller has to be able to tell a measurement from
    // its absence, because it tells the reader which one it had.
    expect(plan.confidence).toBeNull();
  });

  it("refuses a token dropped on itself, which has no arc to give up", () => {
    const s = fuKakuDen();
    expect(planCycleBreak(s, 4, 4, CONFIDENCE)).toBeNull();
  });
});

describe("applyCycleBreak", () => {
  it("re-roots the sentence when the ROOT is dragged onto its own object", () => {
    const s = fuKakuDen();
    const plan = drop(s, 8, 9); // 種 onto 黍
    expect(plan.dropped).toEqual({ child: 9, head: 8, dep: "comp:obj" });
    expect(shape(s)).toEqual([
      "負:mod:8",
      "郭:mod:2",
      "田:comp:obj:0",
      "三百:mod:2",
      "畝:clf:3",
      "、:punct:0",
      "輒:mod:8",
      "半:mod:8",
      "種:dep:9",
      "黍:ROOT:9",
    ]);
    // 種 is left unclassified rather than still calling itself ROOT, until
    // the async relabel names the arc; what matters structurally is that the
    // self-link moved.
    expect(s.tokens.filter((t) => t.head === t.id).map((t) => t.text)).toEqual(["黍"]);
  });

  it("reverses an arc when a token is dragged onto its own dependent", () => {
    const s = fuKakuDen();
    const plan = drop(s, 0, 2); // 負 onto 田
    expect(plan.dropped).toEqual({ child: 2, head: 0, dep: "comp:obj" });
    expect(shape(s)).toEqual([
      "負:mod:2",
      "郭:mod:2",
      "田:comp:obj:8",
      "三百:mod:2",
      "畝:clf:3",
      "、:punct:0",
      "輒:mod:8",
      "半:mod:8",
      "種:ROOT:8",
      "黍:comp:obj:8",
    ]);
  });

  it("cuts the cycle at the least confident arc, not at either end of it", () => {
    const s = fuKakuDen();
    drop(s, 0, 4); // 負 onto 畝
    expect(shape(s)).toEqual([
      "負:mod:4",
      "郭:mod:2",
      "田:comp:obj:0",
      "三百:mod:8", // was 三百→田; re-hung on 負's old head, 種
      "畝:clf:3",
      "、:punct:0",
      "輒:mod:8",
      "半:mod:8",
      "種:ROOT:8",
      "黍:comp:obj:8",
    ]);
  });

  it("leaves a single-rooted, acyclic tree for every pair that used to be refused", () => {
    const refused: [number, number][] = [];
    for (const child of [0, 1, 2, 3, 4, 6, 7, 8, 9]) {
      for (const target of [0, 1, 2, 3, 4, 6, 7, 8, 9]) {
        if (child !== target && cyclePath(fuKakuDen(), child, target)) refused.push([child, target]);
      }
    }
    expect(refused).toHaveLength(16);

    for (const [child, target] of refused) {
      const s = fuKakuDen();
      const plan = drop(s, child, target);
      expect(plan.dropped.child).not.toBe(child);
      // The real proof: the reading order recurses over this tree with no
      // cycle guard of its own, so it terminating at all is the assertion.
      expect(() => computeReadingOrder(s)).not.toThrow();
    }
  });
});

describe("assertSingleRootedTree", () => {
  it("accepts the parse it was given", () => {
    expect(() => assertSingleRootedTree(fuKakuDen())).not.toThrow();
  });

  it("rejects a sentence with two roots", () => {
    const s = fuKakuDen();
    s.tokens[0].head = 0;
    expect(() => assertSingleRootedTree(s)).toThrow(/exactly one ROOT/);
  });

  it("rejects a sentence with no root", () => {
    const s = fuKakuDen();
    s.tokens[8].head = 9;
    expect(() => assertSingleRootedTree(s)).toThrow(/exactly one ROOT/);
  });

  it("rejects a cycle that leaves the root standing elsewhere", () => {
    const s = fuKakuDen();
    // 田 ⇄ 三百, off to one side of a sentence that still has its ROOT.
    s.tokens[2].head = 3;
    expect(() => assertSingleRootedTree(s)).toThrow(/cycles/);
  });

  it("rejects a head pointing outside the sentence", () => {
    const s = fuKakuDen();
    s.tokens[1].head = 42;
    expect(() => assertSingleRootedTree(s)).toThrow(/isn't in the sentence/);
  });
});
