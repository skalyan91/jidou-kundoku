import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import type { KundokuMark } from "../src/kundoku/types.ts";

/** Where a return mark lands when the phrase it returns over is a
 * *coordination chain*.
 *
 * The rule, stated in the terms the code can compute: when a member of a
 * coordination chain has a **backward dependency** — its governor stands
 * *earlier* in the source than it does, and the relation is one the reorder
 * engine INVERTs, so the governor is read *after* it and the reader has to
 * return backward to reach the governor — the mark that names the return
 * goes on the chain's **last** member, never its first. 縶手足 is read
 * 手足を縶ぐ: the reader takes in 手 and 足 as one noun phrase and only then
 * returns to 縶, so 足 is the character the return leaves from.
 *
 * Nothing in the assigner names coordination. The behaviour falls out of
 * `reorderEngine.ts`'s `lastMeaningful`, which represents an INVERT child by
 * the last token read in that child's own subtree — and a `conj:coord` chain
 * hangs off its first conjunct, so its later members are inside that subtree
 * and read after it. These tests pin the outcome rather than the mechanism,
 * because the outcome is what a reader tracing the marks depends on and the
 * mechanism is free to change.
 *
 * Both halves matter. Putting the mark on the first conjunct would not merely
 * point at the wrong character: it would shorten the clause the group returns
 * over from two characters to one, `clauseLengthIn` would call it a one-
 * character return, and the group would render as レ点 — 縶㆑手足, which reads
 * 手を縶ぎ…足, with 足 stranded after the verb it is the object of. The
 * placement is load-bearing for the レ点 rule, not decoration. */

function makeToken(id: number, text: string, pos: string, dep: string, head: number): Token {
  return { id, text, lemma: text, pos, xpos: "", dep, head };
}

function plansOf(sentence: Sentence) {
  const plan = computeReadingOrder(sentence);
  const marks = assignKundokuTen(plan);
  return { plan, marks };
}

/** The reading order a reader recovers from the marks alone (`executeKunten`),
 * as text — the trace that is the real test of where a mark sits. */
function tracedText(sentence: Sentence): string {
  const plan = computeReadingOrder(sentence);
  assignKundokuTen(plan);
  const marks = buildPlainKuntenMarks(plan);
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const isContent = (id: number) => byId.get(id)?.dep !== "punct";
  const maxId = Math.max(...sentence.tokens.map((t) => t.id));
  const kuntens = Array.from({ length: maxId + 1 }, (_, id) => marks.get(id));
  return executeKunten(kuntens, (id) => !isContent(id))
    .filter(isContent)
    .map((id) => byId.get(id)!.text)
    .join("");
}

function orderText(sentence: Sentence): string {
  const plan = computeReadingOrder(sentence);
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  return plan.order
    .filter((id) => byId.get(id)?.dep !== "punct")
    .map((id) => byId.get(id)!.text)
    .join("");
}

/** 縶手足 as both 酒蟲 parses return it (sent. 20 of each file): 手 is 縶's
 * `comp:obj` and 足 hangs off 手 by `conj:coord`. */
function chinShusoku(coordDep = "conj:coord"): Sentence {
  return {
    tokens: [
      makeToken(0, "縶", "VERB", "ROOT", 0),
      makeToken(1, "手", "NOUN", "comp:obj", 0),
      makeToken(2, "足", "NOUN", coordDep, 1),
    ],
  };
}

describe("a return over a coordination chain lands on the chain's last member", () => {
  it("縶手足: 足 takes 一, 縶 takes 二, and 手 takes nothing", () => {
    const sentence = chinShusoku();
    const { plan, marks } = plansOf(sentence);
    expect(plan.spliceGroups).toHaveLength(1);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([2, 0]);
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
    expect(marks.has(1)).toBe(false);
    expect(orderText(sentence)).toBe("手足縶");
    expect(tracedText(sentence)).toBe("手足縶");
  });

  it("縶手足 is not a レ点 — the return crosses two characters, not one", () => {
    // The whole force of the rule. On the first conjunct the group would
    // measure a one-character clause, come out 縶㆑手足, and trace 手縶足 —
    // 足 read after the verb that governs it.
    const { plan } = plansOf(chinShusoku());
    expect(plan.spliceGroups[0].isRe).toBe(false);
  });

  it("縶手 alone, with no conjunct, is the レ点 the coordination displaces", () => {
    const sentence: Sentence = {
      tokens: [makeToken(0, "縶", "VERB", "ROOT", 0), makeToken(1, "手", "NOUN", "comp:obj", 0)],
    };
    const { plan, marks } = plansOf(sentence);
    expect(plan.spliceGroups[0].isRe).toBe(true);
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "re" });
    expect(marks.has(1)).toBe(false);
  });

  it("treats conj:coord@emb exactly as conj:coord — the mechanism never reads the label", () => {
    const sentence = chinShusoku("conj:coord@emb");
    const { plan, marks } = plansOf(sentence);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([2, 0]);
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(tracedText(sentence)).toBe("手足縶");
  });

  it("goes to the end of a three-member chain, not to its second member", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken(0, "縶", "VERB", "ROOT", 0),
        makeToken(1, "手", "NOUN", "comp:obj", 0),
        makeToken(2, "足", "NOUN", "conj:coord", 1),
        makeToken(3, "首", "NOUN", "conj:coord", 2),
      ],
    };
    const { plan, marks } = plansOf(sentence);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([3, 0]);
    expect(marks.get(3)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.has(1)).toBe(false);
    expect(marks.has(2)).toBe(false);
    expect(tracedText(sentence)).toBe("手足首縶");
  });

  it("discounts a comma standing between the conjuncts", () => {
    // Punctuation is not text a kaeriten passes over, but it is also not a
    // conjunct: the mark still goes to 足, and the group is still 一二点 —
    // the two content characters are what the return crosses.
    const sentence: Sentence = {
      tokens: [
        makeToken(0, "縶", "VERB", "ROOT", 0),
        makeToken(1, "手", "NOUN", "comp:obj", 0),
        makeToken(2, "、", "PUNCT", "punct", 1),
        makeToken(3, "足", "NOUN", "conj:coord", 1),
      ],
    };
    const { plan, marks } = plansOf(sentence);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([3, 0]);
    expect(plan.spliceGroups[0].isRe).toBe(false);
    expect(marks.get(3)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(tracedText(sentence)).toBe("手足縶");
  });

  it("求醫療 (酒蟲 sent. 14): 療 takes 一", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken(0, "求", "VERB", "ROOT", 0),
        makeToken(1, "醫", "NOUN", "comp:obj", 0),
        makeToken(2, "療", "NOUN", "conj:coord", 1),
      ],
    };
    const { marks } = plansOf(sentence);
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(tracedText(sentence)).toBe("醫療求");
  });

  it("置良醞一器 (酒蟲 sent. 21): the last conjunct takes 一 over its own modifier", () => {
    // 器 is the second conjunct and carries a numeral modifier of its own
    // (一器, "one vessel"). The mark belongs on 器 — the last character read
    // before the return — not on 醞 and not on the modifier.
    const sentence: Sentence = {
      tokens: [
        makeToken(0, "置", "VERB", "ROOT", 0),
        makeToken(1, "良", "VERB", "mod", 2),
        makeToken(2, "醞", "NOUN", "comp:obj", 0),
        makeToken(3, "一", "NUM", "mod", 4),
        makeToken(4, "器", "NOUN", "conj:coord", 2),
      ],
    };
    const { plan, marks } = plansOf(sentence);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([4, 0]);
    expect(marks.get(4)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.has(2)).toBe(false);
    expect(marks.has(3)).toBe(false);
    expect(tracedText(sentence)).toBe("良醞一器置");
  });
});

describe("a coordination chain inside a fused rank series", () => {
  /** 於日中縶手足, the shape 酒蟲 sent. 20 makes: 中 is 於's object, 縶 is
   * coordinated onto 中, and 手足 is 縶's own coordinated object. 縶's group
   * and 於's group meet at 縶 — the last-read member of the first and the
   * first-read member of the second — so `fuseChains` writes them as one
   * 一二三 series instead of two colliding 一二s. */
  const sentence: Sentence = {
    tokens: [
      makeToken(0, "於", "ADP", "ROOT", 0),
      makeToken(1, "日", "NOUN", "mod", 2),
      makeToken(2, "中", "NOUN", "comp:obj", 0),
      makeToken(3, "縶", "VERB", "conj:coord", 2),
      makeToken(4, "手", "NOUN", "comp:obj", 3),
      makeToken(5, "足", "NOUN", "conj:coord", 4),
    ],
  };

  it("fuses into one 一二三 series whose 一 is the last conjunct", () => {
    const { plan, marks } = plansOf(sentence);
    expect(plan.spliceGroups).toHaveLength(1);
    expect(plan.spliceGroups[0]).toMatchObject({ rankTokenIds: [5, 3, 0], kind: "chain", depth: 0, isRe: false });
    expect(marks.get(5)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(3)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 3 });
  });

  it("still traces back to the reading order the tree gives", () => {
    expect(orderText(sentence)).toBe("日中手足縶於");
    expect(tracedText(sentence)).toBe("日中手足縶於");
  });

  it("joins the two groups at the governor, which the conjunct's mark never moves", () => {
    // `tryFuse` joins on a group's *governor* end — 縶 here — so which
    // conjunct carries rank 1 cannot make or break a fuse. What it can change
    // is the group's span, and through the span every group's nesting depth;
    // the tier this series lands on is recomputed from the trial set, not
    // inherited.
    const { plan } = plansOf(sentence);
    expect(plan.spliceGroups[0].rankTokenIds[1]).toBe(3);
  });
});
