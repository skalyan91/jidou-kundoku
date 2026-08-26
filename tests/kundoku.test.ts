import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import { classifyDep, classifyToken } from "../src/kundoku/depClassification.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildKundokuGlyphMap } from "../src/render/kundokuGlyphs.ts";
import type { KundokuMark } from "../src/kundoku/types.ts";

const fixturesPath = fileURLToPath(new URL("./fixtures/analects-raw-parses.json", import.meta.url));
const raw: Record<string, Token[][]> = JSON.parse(readFileSync(fixturesPath, "utf-8"));

function clauses(text: string): Sentence[] {
  return raw[text].map((tokens) => ({ tokens }));
}

function textOf(sentence: Sentence, ids: number[]): string {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t.text]));
  return ids.map((id) => byId.get(id)).join("");
}

describe("depClassification", () => {
  it("classifies the documented INVERT relations", () => {
    for (const dep of ["comp:obj", "comp:obl", "comp:obl@lmod", "comp:pred", "comp:aux", "comp@expl"]) {
      expect(classifyDep(dep)).toBe("invert");
    }
  });

  it("classifies documented NO-INVERT relations, including discourse particles", () => {
    for (const dep of ["subj", "mod", "mod@tmod", "cc", "ROOT", "punct", "discourse", "discourse@sp"]) {
      expect(classifyDep(dep)).toBe("no-invert");
    }
  });

  it("defaults an unrecognized relation to no-invert", () => {
    expect(classifyDep("totally-made-up-relation")).toBe("no-invert");
  });
});

describe("classifyToken (lemma-aware postpose)", () => {
  it("classifies mod-attached 不/未/弗/勿 as postpose", () => {
    for (const lemma of ["不", "未", "弗", "勿"]) {
      expect(classifyToken({ dep: "mod", lemma, pos: "ADV" })).toBe("postpose");
    }
  });

  it("does not postpose other mod adverbs", () => {
    expect(classifyToken({ dep: "mod", lemma: "亦", pos: "ADV" })).toBe("no-invert");
  });

  it("does not postpose 不/未 outside a mod relation", () => {
    expect(classifyToken({ dep: "subj", lemma: "不", pos: "ADV" })).toBe("no-invert");
  });
});

describe("reorderEngine + kundokuTenAssigner: 學而時習之，不亦說乎？", () => {
  const [xue, yue] = clauses("學而時習之，不亦說乎？");

  it("習/之 form a single splice group and read as レ点 (adjacent jump)", () => {
    const plan = computeReadingOrder(xue);
    expect(textOf(xue, plan.order)).toBe("學而時之習，");
    expect(plan.spliceGroups).toHaveLength(1);

    const marks = assignKundokuTen(plan);
    expect(plan.spliceGroups[0]).toMatchObject({ rankTokenIds: [4, 3], isRe: true, depth: 0 });
    // Real kanbun typesetting affixes レ点 to a single character in the
    // original text — here 習 (source-earlier, read second) — not 之.
    expect(marks.has(4)).toBe(false);
    expect(marks.get(3)).toEqual<KundokuMark>({ tier: "re" });
    expect(marks.has(2)).toBe(false); // 時 (mod@tmod) needs no jump
  });

  it("不亦說乎: 不 postposes past 說, but 亦 sits between them so it's a numeral jump", () => {
    const plan = computeReadingOrder(yue);
    expect(textOf(yue, plan.order)).toBe("亦說不乎？");
    expect(plan.spliceGroups).toHaveLength(1);

    const marks = assignKundokuTen(plan);
    const group = plan.spliceGroups[0];
    expect(group.rankTokenIds).toEqual([2, 0]); // 說 read first, 不 postposed after
    expect(group.isRe).toBe(false); // 亦(id1) sits between 不(id0) and 說(id2)
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
  });
});

describe("reorderEngine: 子曰：學而時習之。", () => {
  const [ziyue, xue] = clauses("子曰：學而時習之。");

  it("subj 子 needs no jump", () => {
    const plan = computeReadingOrder(ziyue);
    expect(plan.spliceGroups).toHaveLength(0);
    expect(textOf(ziyue, plan.order)).toBe("子曰：");
  });

  it("repeats the 習/之 レ点 pattern", () => {
    const plan = computeReadingOrder(xue);
    const marks = assignKundokuTen(plan);
    expect(marks.has(4)).toBe(false);
    expect(marks.get(3)).toEqual<KundokuMark>({ tier: "re" });
  });
});

describe("reorderEngine + kundokuTenAssigner: 有朋自遠方來 (nested inversion, real non-idealized tree)", () => {
  const [you] = clauses("有朋自遠方來，不亦樂乎？");

  it("produces reading order 朋,遠,自,方,來,有 from the model's actual tree", () => {
    const plan = computeReadingOrder(you);
    // Real parse: 來 comp:obj→有 (outer INVERT); 遠 comp:obj→自 (inner INVERT);
    // 自/方 both plain `mod`→來, kept in source order as 來's pre-children.
    // This deliberately does NOT match the idealized "自 takes 方 as object"
    // reading — the app must faithfully reorder whatever tree it's given.
    expect(plan.order.slice(0, 6)).toEqual([1, 3, 2, 4, 5, 0]);
    expect(plan.spliceGroups).toHaveLength(2);
  });

  it("nests the 自/遠 splice (depth 1, レ点) inside the 有/來 splice (depth 0, 一二点)", () => {
    const plan = computeReadingOrder(you);
    const marks = assignKundokuTen(plan);

    const inner = plan.spliceGroups.find((g) => g.rankTokenIds.includes(2))!;
    expect(inner.rankTokenIds).toEqual([3, 2]);
    expect(inner.depth).toBe(1);
    expect(inner.isRe).toBe(true);
    expect(marks.has(3)).toBe(false);
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "re" });

    const outer = plan.spliceGroups.find((g) => g.rankTokenIds.includes(0))!;
    expect(outer.rankTokenIds).toEqual([5, 0]);
    expect(outer.depth).toBe(0);
    expect(outer.isRe).toBe(false);
    expect(marks.get(5)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });

    expect(marks.has(1)).toBe(false); // 朋 (subj) needs no jump
    expect(marks.has(4)).toBe(false); // 方 (mod) needs no jump
  });
});

describe("reorderEngine: span-aware reordering keeps a split lexical compound together", () => {
  const [you] = clauses("有朋自遠方來，不亦樂乎？");
  // 遠(id3, comp:obj of 自) and 方(id4, plain mod of 來) are real JMdict 遠方
  // but the parser attaches them to two different governors — this is
  // exactly the case findCompoundSpans(sentence, jmdict) detects via
  // adjacent-text lookup (see reading.test.ts) rather than a tree relation.
  const spans = [{ tokenIds: [3, 4], text: "遠方" }];

  it("emits 遠,方 contiguously (carrier 遠's own comp:obj inversion), unlike the no-spans baseline", () => {
    const plan = computeReadingOrder(you, spans);
    expect(plan.order.slice(0, 6)).toEqual([1, 3, 4, 2, 5, 0]);
  });

  it("marks only the span's boundary member (方) for the inner jump, and depth/isRe still nest correctly", () => {
    const plan = computeReadingOrder(you, spans);
    const marks = assignKundokuTen(plan);

    const inner = plan.spliceGroups.find((g) => g.rankTokenIds.includes(2))!;
    expect(inner.rankTokenIds).toEqual([4, 2]); // 方 (span's last member), then 自
    expect(inner.depth).toBe(1);
    expect(inner.isRe).toBe(false); // 方(4) and 自(2) are not source-adjacent (遠 sits between)
    expect(marks.has(3)).toBe(false); // 遠 (carrier, non-boundary member) gets no mark of its own
    expect(marks.get(4)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 });
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 });

    const outer = plan.spliceGroups.find((g) => g.rankTokenIds.includes(0))!;
    expect(outer.rankTokenIds).toEqual([5, 0]);
    expect(marks.get(5)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
  });

  it("omitting spans (the default) falls back to the no-spans baseline order", () => {
    expect(computeReadingOrder(you).order.slice(0, 6)).toEqual([1, 3, 2, 4, 5, 0]);
  });
});

describe("reorderEngine: 人不知而不慍，不亦君子乎？ (negation postposing)", () => {
  const [ren, jun] = clauses("人不知而不慍，不亦君子乎？");

  it("postposes both 不 past their verbs: 人,知,不,而,慍,不，", () => {
    const plan = computeReadingOrder(ren);
    expect(textOf(ren, plan.order)).toBe("人知不而慍不，");
    expect(plan.spliceGroups).toHaveLength(2);
  });

  it("marks each postposed 不 with レ点 on the negator itself (adjacent to its verb)", () => {
    const plan = computeReadingOrder(ren);
    const marks = assignKundokuTen(plan);

    const zhiNeg = plan.spliceGroups.find((g) => g.rankTokenIds.includes(2))!;
    expect(zhiNeg.rankTokenIds).toEqual([2, 1]); // 知 read first, 不 postposed after
    expect(zhiNeg.isRe).toBe(true);
    expect(marks.has(2)).toBe(false);
    expect(marks.get(1)).toEqual<KundokuMark>({ tier: "re" });

    const yunNeg = plan.spliceGroups.find((g) => g.rankTokenIds.includes(5))!;
    expect(yunNeg.rankTokenIds).toEqual([5, 4]); // 慍 read first, 不 postposed after
    expect(yunNeg.isRe).toBe(true);
    expect(marks.has(5)).toBe(false);
    expect(marks.get(4)).toEqual<KundokuMark>({ tier: "re" });
  });

  it("second clause: 不 postposes past 君子, but 亦 sits between them so it's a numeral jump, not レ点", () => {
    const plan = computeReadingOrder(jun);
    expect(textOf(jun, plan.order)).toBe("亦君子不乎？");
    expect(plan.spliceGroups).toHaveLength(1);

    const marks = assignKundokuTen(plan);
    const group = plan.spliceGroups[0];
    expect(group.rankTokenIds).toEqual([2, 0]); // 君子 read first, 不 postposed after
    expect(group.isRe).toBe(false); // 亦(id1) sits between 不(id0) and 君子(id2)
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
  });
});

describe("edge cases beyond the real fixtures", () => {
  it("3-member splice group (two INVERT children) gets numeral ranks, not レ点", () => {
    // Synthetic: ROOT(10) <- invert(8) <- invert(2), source order 2,8,10.
    const sentence: Sentence = {
      tokens: [
        { id: 2, text: "A", lemma: "A", pos: "X", xpos: "x", dep: "comp:obj", head: 10 },
        { id: 8, text: "B", lemma: "B", pos: "X", xpos: "x", dep: "comp:obl", head: 10 },
        { id: 10, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "ROOT", head: 10 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.spliceGroups).toHaveLength(1);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([2, 8, 10]);

    const marks = assignKundokuTen(plan);
    expect(plan.spliceGroups[0].isRe).toBe(false);
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(8)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
    expect(marks.get(10)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 3 });
  });

  it("three genuinely straddling nested splice groups reach kou-otsu at depth 2", () => {
    // Mirrors the shape of the real 有朋自遠方來 case (a governor's INVERT
    // child subtree contains a NO-INVERT pre-child that is itself a governor
    // with its own INVERT child), one level deeper. Each level's governor id
    // sits on the low side and its invert child's subtree extends to the
    // high side, so each outer span's [min,max] straddles the next one in:
    //   outer  (0, 50)  ⊃  middle (20, 30)  ⊃  inner (25, 27)
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "R", lemma: "R", pos: "X", xpos: "x", dep: "ROOT", head: 0 },
        { id: 50, text: "O", lemma: "O", pos: "X", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 20, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "mod", head: 50 },
        { id: 30, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 20 },
        { id: 25, text: "I", lemma: "I", pos: "X", xpos: "x", dep: "mod", head: 30 },
        { id: 27, text: "J", lemma: "J", pos: "X", xpos: "x", dep: "comp:obj", head: 25 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.spliceGroups).toHaveLength(3);

    const marks = assignKundokuTen(plan);
    const outer = plan.spliceGroups.find((g) => g.rankTokenIds.includes(0))!;
    const middle = plan.spliceGroups.find((g) => g.rankTokenIds.includes(20))!;
    const inner = plan.spliceGroups.find((g) => g.rankTokenIds.includes(25))!;

    expect(outer.rankTokenIds).toEqual([50, 0]);
    expect(middle.rankTokenIds).toEqual([30, 20]);
    expect(inner.rankTokenIds).toEqual([27, 25]);

    expect(outer.depth).toBe(0);
    expect(middle.depth).toBe(1);
    expect(inner.depth).toBe(2);

    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
    expect(marks.get(50)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(20)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 });
    expect(marks.get(30)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 });
    expect(marks.get(25)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 2 });
    expect(marks.get(27)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 1 });
  });

  it("a token that's both a postpose source (negated) and an invert target (governs a comp:obl) doesn't crash, and shows both marks stacked", () => {
    // Real case this reproduces: text concatenated without sentence-boundary
    // whitespace confused the segmenter into attaching 乎 as comp:obl of 說
    // (instead of the usual discourse@sp), while 說 was also separately
    // negated by 不 — 說 ends up simultaneously the *target* of 乎's invert
    // jump and the *source* of 不's postpose jump, landing it in two
    // different splice groups at once.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2 },
        { id: 2, text: "說", lemma: "說", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "乎", lemma: "乎", pos: "ADP", xpos: "x", dep: "comp:obl", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.spliceGroups).toHaveLength(2);
    expect(() => assignKundokuTen(plan)).not.toThrow();

    const glyphs = buildKundokuGlyphMap(plan);
    expect(glyphs.get(2)?.length).toBeGreaterThan(1); // both marks stacked on the shared token
    // レ点 always nests below/inside a numeral tier, never the other way —
    // regardless of which splice group the tree walk happened to push first.
    expect(glyphs.get(2)).toBe("㆒㆑");
  });
});

describe("reorderEngine: speech verbs (曰/云) don't invert their quoted complement", () => {
  it("keeps a comp:obj complement of 曰 in place (no jump), unlike an ordinary comp:obj", () => {
    // 子曰學而時習之 — if 曰 behaved like an ordinary verb, its comp:obj
    // complement (學, the whole quote) would invert before it, same as 之
    // inverts before 習 in the real seed sentences. Real kanbun never
    // reorders a quote before 曰: it reads straight through, 子曰、「...」.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1, 2]); // source order preserved, no invert splice group
    expect(plan.spliceGroups).toHaveLength(0);
  });

  it("still inverts an ordinary comp:obj when the governor isn't a speech verb", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "習", lemma: "習", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 0 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([1, 0]); // 之 inverts before 習
    expect(plan.spliceGroups).toHaveLength(1);
  });

  it("marks the last non-punctuation token of the quote as quoteEndIds (for the trailing ト)", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 3, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    // 之 inverts before 學 (ordinary comp:obj, unaffected by the speech-verb
    // exception — that only suppresses inversion of the quote *as a whole*
    // relative to 曰, not grammar inside the quote), giving order 子,曰,之,學,。
    expect(plan.order).toEqual([0, 1, 3, 2, 4]);
    expect(plan.quoteEndIds).toEqual(new Set([2])); // 學 — last non-punct token of the quote, not the trailing 。
  });
});
