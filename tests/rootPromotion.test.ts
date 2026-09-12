import { describe, expect, it } from "vitest";
import { applyRootPromotion, assertSingleRootedTree, rootDemotionLabel } from "../src/render/tokenInspector.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

function token(id: number, text: string, head: number, dep: string): Token {
  return { id, text, lemma: text, pos: "VERB", xpos: "", dep, head };
}

/** A four-token chain, deep enough that promoting its leaf tests the one
 * case worth doubting: the new root sitting *inside* the old root's own
 * subtree, more than one hop down. 3 and 1 hang off 1 and 2 respectively;
 * 0 is 1's own child and 2 is the ROOT.
 *
 *   3 → 1 → 2(ROOT)
 *        ↖
 *   0 → 1
 */
function chain(): Sentence {
  return {
    tokens: [
      token(0, "a", 1, "mod"),
      token(1, "b", 2, "subj"),
      token(2, "c", 2, "ROOT"),
      token(3, "d", 1, "mod"),
    ],
  };
}

const shape = (sentence: Sentence) => sentence.tokens.map((t) => `${t.text}:${t.dep}:${t.head}`);

describe("applyRootPromotion", () => {
  it("re-hangs the old root under the new one, and touches nothing else", () => {
    const s = chain();
    applyRootPromotion(s, /* oldRootId */ 2, /* newRootId */ 1, "mod");
    expect(shape(s)).toEqual([
      "a:mod:1", // untouched — still 1's dependent
      "b:ROOT:1", // the new root: self-link
      "c:mod:1", // the old root: now 1's dependent, labelled as given
      "d:mod:1", // untouched — still 1's dependent
    ]);
  });

  it("leaves the old root's own dependents exactly where they were — no cascade", () => {
    // This is the whole of the retraction the reader asked for, checked as a
    // structural fact rather than trusted from the doc: promoting 2 (a leaf,
    // no dependents of its own) to root must not move 0's or 3's arcs, since
    // neither of them ever pointed at the old root (1) to begin with — they
    // point at 1, the *new* root, which is precisely why they must be
    // untouched by an edit about the old root's fate.
    const s = chain();
    const before = shape(s).filter((_, i) => i === 0 || i === 3); // a, d
    applyRootPromotion(s, 2, 1, "mod");
    const after = shape(s).filter((_, i) => i === 0 || i === 3);
    expect(after).toEqual(before);
  });

  it("stays a single-rooted, acyclic tree when the new root is nested inside the old one's own subtree", () => {
    // 0 is a grandchild of the ROOT (0 → 1 → 2), the case the task calls out
    // by name: reparenting the old root onto a token that used to be *under*
    // it needs care, because the arc that is about to be added (2 → 0) runs
    // in the opposite direction from the arc (1 → 2 → ... ) that used to
    // connect them.
    const s = chain();
    applyRootPromotion(s, 2, 0, "mod");
    expect(() => assertSingleRootedTree(s)).not.toThrow();
    // The real proof: the reading order recurses over this tree with no
    // cycle guard of its own (see `assertSingleRootedTree`'s own doc), so it
    // terminating at all is the assertion.
    expect(() => computeReadingOrder(s)).not.toThrow();
    expect(shape(s)).toEqual([
      "a:ROOT:0", // the new root: self-link
      "b:subj:2", // untouched — still 2's dependent
      "c:mod:0", // the old root: now 0's dependent
      "d:mod:1", // untouched — still 1's dependent
    ]);
  });

  it("stays a single-rooted, acyclic tree for every possible promotion in the fixture", () => {
    // Every token in turn, including the root promoting itself (a no-op
    // shape) and every depth of nesting the four-token chain has to offer.
    for (const newRootId of [0, 1, 2, 3]) {
      const s = chain();
      const oldRoot = s.tokens.find((t) => t.head === t.id)!;
      if (oldRoot.id === newRootId) continue;
      applyRootPromotion(s, oldRoot.id, newRootId, rootDemotionLabel(null));
      expect(() => assertSingleRootedTree(s), `promoting ${newRootId}`).not.toThrow();
      expect(() => computeReadingOrder(s), `promoting ${newRootId}`).not.toThrow();
    }
  });

  it("never writes ROOT onto the old root's own new arc", () => {
    // `applyRootPromotion` writes whatever label it is given — excluding
    // "ROOT" is `rootDemotionLabel`'s job — but the caller in this codebase
    // is always `promoteToRoot`, which always routes the label through
    // `rootDemotionLabel` first; this checks the pairing does what it must.
    const s = chain();
    applyRootPromotion(s, 2, 1, rootDemotionLabel(null));
    const oldRoot = s.tokens.find((t) => t.id === 2)!;
    expect(oldRoot.dep).not.toBe("ROOT");
  });

  it("does nothing when either id is missing from the sentence", () => {
    const s = chain();
    const before = shape(s);
    applyRootPromotion(s, 99, 1, "mod");
    expect(shape(s)).toEqual(before);
    applyRootPromotion(s, 2, 99, "mod");
    expect(shape(s)).toEqual(before);
  });
});
