import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import { classifyDep, classifyToken } from "../src/kundoku/depClassification.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildKundokuGlyphMap } from "../src/render/kundokuGlyphs.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import type { KundokuMark } from "../src/kundoku/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { findCompoundSpans } from "../src/reading/jmdictLookup.ts";
import { carrierOf } from "../src/kundoku/spanCarrier.ts";

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

  it("does not postpose one whose reading was picked by hand", () => {
    // Postposing is what a negation gets because it is read after the verb it
    // negates. 未 read ひつじ negates nothing, and moving it left 未學禮 as
    // 禮を學ぶ未 — the character stranded at the end of a clause it is not in.
    expect(classifyToken({ dep: "mod", lemma: "未", pos: "ADV", misc: { Reading: "ひつじ" } })).toBe("no-invert");
    expect(classifyToken({ dep: "mod", lemma: "未", pos: "ADV", misc: {} })).toBe("postpose");
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
    //
    // Ids here stand in for source positions but the sentence only lists the
    // tokens the nesting needs, so the gaps between them hold nothing. K(26)
    // is a real character inside the innermost jump, which a real parse's
    // contiguous ids would always have supplied: without it that jump returns
    // over the single character J and is a レ点 (see `clauseLengthIn`), which
    // is a true statement about a two-character sentence and not the
    // three-tier nesting this test is about.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "R", lemma: "R", pos: "X", xpos: "x", dep: "ROOT", head: 0 },
        { id: 50, text: "O", lemma: "O", pos: "X", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 20, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "mod", head: 50 },
        { id: 30, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 20 },
        { id: 25, text: "I", lemma: "I", pos: "X", xpos: "x", dep: "mod", head: 30 },
        { id: 26, text: "K", lemma: "K", pos: "X", xpos: "x", dep: "mod", head: 27 },
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
    //
    // 亦(1) is in that sentence and belongs in the fixture: it is the
    // character between 不 and 說 that makes 不's jump a two-character return
    // and so a numeral one (see `clauseLengthIn`). Without it the postpose is
    // a one-character return, takes レ点, and nothing stacks — which is the
    // right answer for 不說乎 and not the case this test is about.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2 },
        { id: 1, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 2 },
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
    // 子曰：「學 — if 曰 behaved like an ordinary verb, its comp:obj
    // complement (學, the whole quote) would invert before it, same as 之
    // inverts before 習 in the real seed sentences. Real kanbun never
    // reorders a quote before 曰: it reads straight through, 子曰、「...」.
    //
    // The 「 is what makes it a quote, and has to be here: an *unquoted*
    // complement of 曰 is an ordinary object and does invert (the case below).
    // The parser hangs the opening bracket inside the quoted clause, on the
    // complement's own head here — see 酒蟲's sent_id 10.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "「", lemma: "「", pos: "PUNCT", xpos: "x", dep: "punct", head: 3 },
        { id: 3, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1, 2, 3]); // source order preserved, no invert splice group
    expect(plan.spliceGroups).toHaveLength(0);
  });

  it("inverts an *unquoted* complement of 曰, like 言/謂/問's", () => {
    // The same tree with the bracket taken away. A clausal complement of a
    // speech verb takes 終止形 + と only where the source quotes it; unquoted,
    // it is an ordinary object, so it inverts and no ト closes it. 曰/云 used
    // to bypass that test purely because the ト they take is written from
    // `quoteEndIds` rather than from `conjugationContext.ts`.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 2, 1]);
    expect(plan.spliceGroups).toHaveLength(1);
    expect(plan.quoteEndIds).toEqual(new Set());
  });

  it("admits a nominal complement closed by a sentence-final particle as a quote", () => {
    // 曰：「此蟲也。」 — 蟲 is a NOUN, which is ordinarily a *naming* complement
    // (名曰軒轅) and inverts. 也 says otherwise: nothing in Literary Chinese
    // puts a sentence-final particle after a bare name, so this nominal heads
    // an asserted clause — 「此れ蟲なり」と — and reads after 曰 with a closing
    // ト on the particle, not before it.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "「", lemma: "「", pos: "PUNCT", xpos: "x", dep: "punct", head: 3 },
        { id: 2, text: "此", lemma: "此", pos: "PRON", xpos: "x", dep: "subj", head: 3 },
        { id: 3, text: "蟲", lemma: "蟲", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 4, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 3 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1, 2, 3, 4]);
    expect(plan.spliceGroups).toHaveLength(0);
    expect(plan.quoteEndIds).toEqual(new Set([4])); // 也 — the ト follows the なり
  });

  it("admits that nominal even unbracketed — the particle is the whole of the evidence", () => {
    // The same tree with the bracket taken away. Unlike the clausal case
    // above, the bracket is not required here: what makes withholding と safe
    // for a clause is that 連体形 + を takes its place, and no such reading
    // exists for a nominal (`isUnquotedSpeechComplement` excludes NOUN/PROPN
    // outright). Requiring one would leave this with neither particle.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "此", lemma: "此", pos: "PRON", xpos: "x", dep: "subj", head: 2 },
        { id: 2, text: "蟲", lemma: "蟲", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 3, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1, 2, 3]);
    expect(plan.spliceGroups).toHaveLength(0);
    expect(plan.quoteEndIds).toEqual(new Set([3]));
  });

  it("still inverts a naming complement, which carries no such particle (名曰軒轅)", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "名", lemma: "名", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "軒轅", lemma: "軒轅", pos: "PROPN", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 2, 1]); // 軒轅と曰ふ
    expect(plan.spliceGroups).toHaveLength(1);
    expect(plan.quoteEndIds).toEqual(new Set());
  });

  it("inverts it under the real 伝達 tag too — the tag widens the class, not the test", () => {
    // The same anchor as the live parse writes it. The speech-verb class is
    // the treebank's own `v,動詞,…,伝達`, which 曰 carries; what tells a naming
    // complement from a quoted one is still the sentence-final particle (for a
    // nominal) and the opening bracket (for a clause), and 軒轅 has neither.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "名", lemma: "名", pos: "NOUN", xpos: "n,名詞,不可譲,属性", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 },
        { id: 2, text: "軒轅", lemma: "軒轅", pos: "PROPN", xpos: "n,名詞,人,名", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 2, 1]);
    expect(plan.quoteEndIds).toEqual(new Set());
  });

  it("keeps 問 in front of a quotation it introduces (問：「需何藥？」)", () => {
    // 酒蟲 sent_id 17, row for row. 問 carries the 伝達 tag, so its bracketed
    // complement is reported speech and reads after it — 問ふ、「…」と — where
    // the two-lemma set inverted the whole quote in front of the verb
    // (需なに藥問ふ). 藥 comes back UPOS VERB on a noun xpos; the movement rule
    // reads neither, only the relation and the bracket.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "問", lemma: "問", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 0 },
        { id: 1, text: "：", lemma: "：", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 },
        { id: 2, text: "「", lemma: "「", pos: "PUNCT", xpos: "s,記号,括弧開,*", dep: "punct", head: 5 },
        { id: 3, text: "需", lemma: "需", pos: "PROPN", xpos: "n,名詞,人,名", dep: "subj", head: 5 },
        { id: 4, text: "何", lemma: "何", pos: "PRON", xpos: "n,代名詞,疑問,*", dep: "det", head: 5 },
        { id: 5, text: "藥", lemma: "藥", pos: "VERB", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 0 },
        { id: 6, text: "？", lemma: "？", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 5 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 6]); // source order — nothing to mark
    expect(plan.spliceGroups).toEqual([]);
    expect(plan.quoteEndIds).toEqual(new Set([5])); // 藥, the last real token of the quote
  });

  it("still inverts 謂's complement where the source brackets nothing (謂其身有異疾)", () => {
    // 酒蟲 sent_id 5. 謂 was kept off the old two-lemma set because it also
    // means "to call X Y", so not every complement of it is a quotation. The
    // wider class does not lose that: the bracket answers it per sentence, and
    // this sentence has none — その身に異疾有るを謂ふ, an ordinary object.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 0 },
        { id: 1, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "det", head: 2 },
        { id: 2, text: "身", lemma: "身", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 0 },
        { id: 3, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 0 },
        { id: 4, text: "疾", lemma: "疾", pos: "NOUN", xpos: "n,名詞,不可譲,疾病", dep: "comp:obj", head: 3 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([1, 2, 4, 3, 0]); // 其の身に異疾有るを謂ふ
    expect(plan.quoteEndIds).toEqual(new Set());
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
        { id: 2, text: "「", lemma: "「", pos: "PUNCT", xpos: "x", dep: "punct", head: 3 },
        { id: 3, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 3 },
        { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    // 之 inverts before 學 (ordinary comp:obj, unaffected by the speech-verb
    // exception — that only suppresses inversion of the quote *as a whole*
    // relative to 曰, not grammar inside the quote), giving order 子,曰,「,之,學,。
    expect(plan.order).toEqual([0, 1, 2, 4, 3, 5]);
    expect(plan.quoteEndIds).toEqual(new Set([3])); // 學 — last non-punct token of the quote, not the trailing 。
  });
});

// ---------------------------------------------------------------------------
// Two defects found on a reader's own hand-corrected 酒蟲 (聊齋志異) file. Both
// are reproduced from that file's arcs verbatim rather than from a tidied-up
// tree: what broke in each case was a shape the reader's own analysis has and
// an idealized example does not, so an idealized example cannot stand guard
// over it.
// ---------------------------------------------------------------------------

/** The sentence's own block of the reader's CoNLL-U, arcs untouched. */
function realSentence(conllu: string): Sentence {
  const tree = parseConllu(conllu);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

/** 酒蟲 sentence 4, the reader's own arcs — two separate defects live here
 * (a span member's dependents going missing, and the 一二三点 case below), so
 * the block is shared rather than pasted twice. */
const JIU_CHONG_4 = `# sent_id = 4
# text = 負郭田三百畝輒半種黍而家豪富不以飲為累也
1\t負\t負\tVERB\tv,動詞,行為,動作\t_\t2\tmod\t_\t_
2\t郭\t郭\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t3\tmod\t_\t_
3\t田\t田\tNOUN\tn,名詞,固定物,地形\tCase=Loc\t4\tsubj\t_\t_
4\t三百\t三百\tNUM\tn,数詞,数,*\t_\t0\troot\t_\t_
5\t畝\t畝\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t4\tclf\t_\t_
6\t、\t、\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
7\t輒\t輒\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t9\tmod\t_\t_
8\t半\t半\tVERB\tv,動詞,描写,量\tDegree=Pos\t9\tmod\t_\t_
9\t種\t種\tVERB\tv,動詞,行為,動作\t_\t4\tparataxis\t_\t_
10\t黍\t黍\tNOUN\tn,名詞,可搬,糧食\t_\t9\tcomp:obj\t_\t_
11\t；\t；\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_
12\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t14\tcc\t_\t_
13\t家\t家\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t14\tsubj\t_\t_
14\t豪\t豪\tADJ\tn,名詞,描写,態度\t_\t9\tconj:coord\t_\t_
15\t富\t富\tADJ\tn,名詞,可搬,成果物\t_\t14\tflat\t_\t_
16\t、\t、\tPUNCT\ts,記号,読点,*\t_\t12\tpunct\t_\t_
17\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t20\tmod\t_\t_
18\t以\t以\tVERB\tv,動詞,行為,動作\t_\t20\tmod\t_\t_
19\t飲\t飲\tNOUN\tn,名詞,可搬,糧食\t_\t18\tcomp:obj\t_\t_
20\t為\t爲\tVERB\tv,動詞,存在,存在\t_\t15\tconj:coord\t_\t_
21\t累\t累\tNOUN\tv,動詞,行為,動作\t_\t20\tcomp:pred\t_\t_
22\t也\t也\tPART\tp,助詞,句末,*\t_\t21\tdiscourse@sp\t_\t_
23\t。\t。\tPUNCT\ts,記号,句点,*\t_\t20\tpunct\t_\t_
`;

describe("reorderEngine: a span member's dependents survive the span (而家豪富、不以飲為累也)", () => {
  // 豪(13) and 富(14) are one JMdict span whose carrier is 豪; 為(19) hangs off
  // 富, the member the walk does not visit. 負(0)/郭(1) are a second span in
  // the same sentence, with 、(5) hanging off the non-carrier 負.
  const fu = realSentence(JIU_CHONG_4);

  it("finds the two spans the defect turns on, 豪富 carried by 豪", () => {
    const spans = findCompoundSpans(fu);
    expect(spans.map((s) => s.tokenIds)).toEqual([
      [0, 1],
      [13, 14],
    ]);
    expect(carrierOf(spans[1], fu).id).toBe(13); // 豪 — so 富(14) is never a walk node
  });

  it("reads every token exactly once — 不以飲為累也 hangs off the non-carrier 富", () => {
    const plan = computeReadingOrder(fu, findCompoundSpans(fu));
    expect([...plan.order].sort((a, b) => a - b)).toEqual(fu.tokens.map((t) => t.id));
    // The clause that used to vanish, in its own reading order: 飲を以て累と為さず。
    expect(textOf(fu, plan.order)).toBe("負郭田三百畝、輒半黍種；而家豪富、飲以累也為不。");
  });

  it("throws rather than silently dropping, if reading order ever fails to cover a sentence", () => {
    // A token whose head is off the tree entirely — the shape a dropped
    // subtree leaves behind. Nothing in either panel could show this, so the
    // engine must not hand back a plan that quietly omits it.
    const orphaned: Sentence = {
      tokens: [
        { id: 0, text: "甲", lemma: "甲", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "乙", lemma: "乙", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 9 },
      ],
    };
    expect(() => computeReadingOrder(orphaned)).toThrow(/dropped 1:乙/);
  });
});

describe("reorderEngine: unmarked reordering across a non-projective subject (長山劉氏、體肥嗜飲)", () => {
  // The reader attached the shared subject 劉(2) to the second conjunct 嗜(7)
  // while the first conjunct 肥(6) is the root: arc 2→7 crosses the root, so
  // 嗜's subtree (長山劉氏、…飲嗜) straddles 體肥 in the source. Emitting that
  // subtree as one block read 體肥 first, which no kaeriten can express — and
  // the assigner accordingly marked none of it, so the 訓読文 panel went on
  // saying 長山劉氏、體肥え飲を嗜む while the prose said 體肥え first.
  const liu = realSentence(`# sent_id = 2
# text = 長山劉氏體肥嗜飲
1\t長\t長\tADJ\tv,動詞,描写,量\tDegree=Pos|VerbForm=Part\t2\tmod\t_\t_
2\t山\t山\tNOUN\tn,名詞,固定物,地形\tCase=Loc\t3\tmod\t_\t_
3\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t8\tsubj\t_\t_
4\t氏\t氏\tNOUN\tn,名詞,不可譲,属性\t_\t3\tflat\t_\t_
5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
6\t體\t體\tNOUN\tn,名詞,不可譲,身体\t_\t7\tsubj\t_\t_
7\t肥\t肥\tVERB\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
8\t嗜\t嗜\tVERB\tv,動詞,行為,態度\t_\t7\tconj:coord\t_\t_
9\t飲\t飲\tNOUN\tv,動詞,行為,飲食\t_\t8\tcomp:obj\t_\t_
10\t。\t。\tPUNCT\ts,記号,句点,*\t_\t7\tpunct\t_\t_
`);

  it("leaves unmarked material in source order: only 飲/嗜 depart from it", () => {
    const plan = computeReadingOrder(liu, findCompoundSpans(liu));
    expect(textOf(liu, plan.order)).toBe("長山劉氏、體肥飲嗜。");
  });

  it("marks every departure it makes — one レ点 on 嗜, and nothing else moves", () => {
    const plan = computeReadingOrder(liu, findCompoundSpans(liu));
    const marks = assignKundokuTen(plan);
    expect(plan.spliceGroups).toHaveLength(1);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([8, 7]); // 飲 then 嗜
    expect(marks.get(7)).toEqual<KundokuMark>({ tier: "re" });
    expect([...marks.keys()]).toEqual([7]);

    // The contract the panels rely on: read the source straight through,
    // taking each marked jump as it comes, and you get the reading order back.
    const unmarked = plan.order.filter((id) => !marks.has(id) && !plan.spliceGroups[0].rankTokenIds.includes(id));
    expect(unmarked).toEqual([...unmarked].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// Overlapping (as against nesting) splice groups: 一二三点, 上中下点, 甲乙丙点.
//
// Two groups NEST when one has to be read out while the other's series is
// still in progress — the reader is tracking two series at once, which is
// what the tiers exist for. Two groups OVERLAP when they merely meet end to
// end: the last-read member of one is the first-read member of the next, so
// the returns are one continuous run and belong in one extended series.
// ---------------------------------------------------------------------------

/** The reading order a reader gets by following only the marks, with no tree
 * at all — `kuntenExecutor`'s inverse of the assigner, content tokens only.
 * That trace, not the glyphs, is what says a set of marks is right. */
function traceMarks(sentence: Sentence, plan: ReturnType<typeof computeReadingOrder>): number[] {
  const marks = buildPlainKuntenMarks(plan);
  const maxId = Math.max(...sentence.tokens.map((t) => t.id));
  const kuntens = Array.from({ length: maxId + 1 }, (_, id) => marks.get(id));
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const isPunct = (id: number) => byId.get(id)?.dep === "punct";
  return executeKunten(kuntens, isPunct).filter((id) => !isPunct(id));
}

describe("kundokuTenAssigner: an overlap becomes 一二三点 (不以飲為累也, 酒蟲 sent. 4)", () => {
  // 為(19) is the deferred governor of the INVERT group that reads 累也 before
  // it, *and* the governor of the POSTPOSE group that reads 不 after it. Both
  // came out 一二点 and 為 was written 二一 — two ranks of one tier on one
  // character, which no edition does. The two are one run of returns
  // (也 → 為 → 不) and belong in one three-rank series.
  const fu = realSentence(JIU_CHONG_4);

  it("fuses the two 一二点 groups into a single 一二三点 series", () => {
    const plan = computeReadingOrder(fu, findCompoundSpans(fu));
    // Before the assigner runs, the reorder engine still reports them apart.
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([21, 19]);
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([19, 16]);

    const marks = assignKundokuTen(plan);
    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual([21, 19, 16]); // 也, then 為, then 不
    expect(chain.depth).toBe(0);
    expect(chain.isRe).toBe(false);

    expect(marks.get(21)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 }); // 也 一
    expect(marks.get(19)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 }); // 為 二
    expect(marks.get(16)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 3 }); // 不 三
  });

  it("writes 不㆔ 以㆑ 飲 為㆓ 累 也㆒ — one mark per character, no stacked tier", () => {
    const plan = computeReadingOrder(fu, findCompoundSpans(fu));
    assignKundokuTen(plan);
    const glyphs = buildKundokuGlyphMap(plan);
    expect(glyphs.get(16)).toBe("㆔"); // 不
    expect(glyphs.get(17)).toBe("㆑"); // 以 — レ点 over 飲, untouched by the fuse
    expect(glyphs.get(19)).toBe("㆓"); // 為 — was "㆓㆒"
    expect(glyphs.get(21)).toBe("㆒"); // 也
    expect(glyphs.get(8)).toBe("㆑"); // 種 — the other レ点 in the sentence
  });

  it("traces back to the same reading order: 飲・以・累・也・為・不", () => {
    const plan = computeReadingOrder(fu, findCompoundSpans(fu));
    assignKundokuTen(plan);
    const byId = new Map(fu.tokens.map((t) => [t.id, t]));
    expect(traceMarks(fu, plan)).toEqual(plan.order.filter((id) => byId.get(id)?.dep !== "punct"));
    expect(textOf(fu, traceMarks(fu, plan).slice(-6))).toBe("飲以累也為不");
  });
});

describe("kundokuTenAssigner: an overlap on a *middle* rank (謂其身有異疾, 酒蟲 sent. 5)", () => {
  // The 為 case above joins two groups at a character that is the governor of
  // both, i.e. the first-read member of the second group. Here the join is one
  // rank further in: 謂 has two INVERT children (其身 and 異疾有), so its group
  // is 身㆒ 有㆓ 謂㆔, and 有 — its *second* rank — is also the deferred
  // governor of 異疾有's own group. 有 was written 下二, one tier's mark
  // stacked on another's, which is the 為㆓㆒ defect one tier up.
  //
  // The reader still passes through 有 once, on one continuous run: 疾 returns
  // to 有 and 有 goes straight on to 謂. So it is one series, and 身 — read on
  // the way down at the source position the text already gives it, with no
  // return ever landing on it — drops out of the ranks entirely.
  const kan = realSentence(`# sent_id = 5
# text = 一番僧見之謂其身有異疾
1\t一\t一\tNUM\tn,数詞,数字,*\t_\t2\tmod\t_\t_
2\t番僧\t番僧\tNOUN\tn,名詞,度量衡,*\t_\t3\tsubj\t_\t_
3\t見\t見\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
6\t謂\t謂\tVERB\tv,動詞,行為,伝達\t_\t3\tparataxis\t_\t_
7\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t8\tdet\t_\t_
8\t身\t身\tNOUN\tn,名詞,不可譲,身体\t_\t6\tcomp:obj\t_\t_
9\t有\t有\tVERB\tv,動詞,存在,存在\t_\t6\tcomp:obj\t_\t_
10\t異\t異\tVERB\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t11\tmod\t_\t_
11\t疾\t疾\tNOUN\tn,名詞,不可譲,疾病\t_\t9\tcomp:obj\t_\t_
12\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_
`);

  it("fuses on 有 even though it is 謂's rank 2, and drops the rank before it", () => {
    const plan = computeReadingOrder(kan, findCompoundSpans(kan));
    // The reorder engine still reports the two apart, 有(8) ending one and
    // sitting mid-way through the other.
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([10, 8]); // 疾, 有
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([7, 8, 5]); // 身, 有, 謂

    const marks = assignKundokuTen(plan);
    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual([10, 8, 5]); // 疾, then 有, then 謂
    // Both sides fused, the 上下点 that kept them apart on 有 has nothing left
    // to keep apart: the run sits on the tier nothing else encloses.
    expect(chain.depth).toBe(0);

    expect(marks.get(10)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 }); // 疾 一
    expect(marks.get(8)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 }); // 有 二
    expect(marks.get(5)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 3 }); // 謂 三
    expect(marks.has(7)).toBe(false); // 身 — read in source order, nothing returns to it
  });

  it("writes 謂㆔ 其 身 有㆓ 異 疾㆒ — no character carries two tiers", () => {
    const plan = computeReadingOrder(kan, findCompoundSpans(kan));
    assignKundokuTen(plan);
    const glyphs = buildKundokuGlyphMap(plan);
    expect(glyphs.get(5)).toBe("㆔"); // 謂
    expect(glyphs.get(7)).toBeUndefined(); // 身
    expect(glyphs.get(8)).toBe("㆓"); // 有 — was "㆘㆓"
    expect(glyphs.get(10)).toBe("㆒"); // 疾
    expect(glyphs.get(2)).toBe("㆑"); // 見 — the レ点 over 之, untouched by the fuse
  });

  it("traces back to the same reading order: 其・身・異・疾・有・謂", () => {
    const plan = computeReadingOrder(kan, findCompoundSpans(kan));
    assignKundokuTen(plan);
    const byId = new Map(kan.tokens.map((t) => [t.id, t]));
    expect(traceMarks(kan, plan)).toEqual(plan.order.filter((id) => byId.get(id)?.dep !== "punct"));
    expect(textOf(kan, traceMarks(kan, plan).slice(-6))).toBe("其身異疾有謂");
  });
});

describe("kundokuTenAssigner: extended rank series on the tiers above 一二点", () => {
  /** A governor `M` with one INVERT child and one postposed negation — the
   * two groups meet at `M` and so fuse — wrapped in `levels` enclosing
   * groups, each a governor on the low side with an INVERT child on the high
   * side so its span straddles everything within it (the same construction
   * the kou-otsu nesting test above uses). Ids double as source positions,
   * as elsewhere in this file. */
  function nestedChain(levels: 1 | 2): { sentence: Sentence; ranks: [number, number, number] } {
    if (levels === 1) {
      return {
        ranks: [30, 20, 25],
        sentence: {
          tokens: [
            { id: 0, text: "R", lemma: "R", pos: "X", xpos: "x", dep: "ROOT", head: 0 },
            { id: 50, text: "O", lemma: "O", pos: "X", xpos: "x", dep: "comp:obj", head: 0 },
            { id: 20, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "mod", head: 50 },
            { id: 30, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 20 },
            { id: 25, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 20, morph: "Polarity=Neg" },
          ],
        },
      };
    }
    return {
      ranks: [35, 30, 33],
      sentence: {
        tokens: [
          { id: 0, text: "R", lemma: "R", pos: "X", xpos: "x", dep: "ROOT", head: 0 },
          { id: 50, text: "O", lemma: "O", pos: "X", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 20, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "mod", head: 50 },
          { id: 40, text: "P", lemma: "P", pos: "X", xpos: "x", dep: "comp:obj", head: 20 },
          { id: 30, text: "Q", lemma: "Q", pos: "X", xpos: "x", dep: "mod", head: 40 },
          { id: 35, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 30 },
          { id: 33, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 30, morph: "Polarity=Neg" },
        ],
      },
    };
  }

  it("one nesting deep, a fused chain is 上中下点 (not 上下 twice)", () => {
    const { sentence } = nestedChain(1);
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual([30, 20, 25]);
    expect(chain.depth).toBe(1);
    expect(marks.get(30)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 }); // 上
    expect(marks.get(20)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 }); // 中
    expect(marks.get(25)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 3 }); // 下

    const glyphs = buildKundokuGlyphMap(plan);
    expect([glyphs.get(30), glyphs.get(20), glyphs.get(25)]).toEqual(["㆖", "㆗", "㆘"]);
  });

  it("two nestings deep, a fused chain is 甲乙丙点", () => {
    const { sentence, ranks } = nestedChain(2);
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual(ranks);
    expect(chain.depth).toBe(2);
    expect(marks.get(ranks[0])).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 1 }); // 甲
    expect(marks.get(ranks[1])).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 2 }); // 乙
    expect(marks.get(ranks[2])).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 3 }); // 丙

    const glyphs = buildKundokuGlyphMap(plan);
    expect(ranks.map((id) => glyphs.get(id))).toEqual(["㆙", "㆚", "㆛"]);
  });
});

describe("kundokuTenAssigner: what a fused chain never does", () => {
  it("never absorbs a レ点 — 不飲酒 stays 不㆑ 飲㆑ 酒", () => {
    // 酒 inverts before 飲 (source-adjacent), and 不 postposes after 飲 (also
    // source-adjacent). The two meet at 飲 exactly as the 為 case's groups
    // meet at 為 — but a レ点 pair states its whole jump on its own, and a
    // chain of them is ordinary notation. Fusing here would silently trade
    // two marks editions do write for a numeral series they would not.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Polarity=Neg" },
        { id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "酒", lemma: "酒", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);
    expect(plan.spliceGroups.map((g) => g.kind)).not.toContain("chain");
    expect(marks.get(1)).toEqual<KundokuMark>({ tier: "re" }); // 飲㆑, over 酒
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "re" }); // 不㆑, over 飲
    expect(traceMarks(sentence, plan)).toEqual([2, 1, 0]); // 酒・飲・不
  });

  it("escalates instead of fusing when the series would outrun its tier", () => {
    // Same shape as the 上中下 case, but the inner governor takes *two*
    // INVERT children, so the fused series would need four ranks. 一二三四
    // exists; 上中下 has no fourth symbol. Nested one level deep the fuse is
    // therefore refused, and the continuation is escalated onto 甲乙点
    // instead — a nesting the reader can still follow, rather than a symbol
    // no edition has or a second 上中下 series colliding on the same
    // character.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "R", lemma: "R", pos: "X", xpos: "x", dep: "ROOT", head: 0 },
        { id: 20, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "mod", head: 50 },
        { id: 30, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 20 },
        { id: 40, text: "P", lemma: "P", pos: "X", xpos: "x", dep: "comp:obl", head: 20 },
        { id: 25, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 20, morph: "Polarity=Neg" },
        { id: 50, text: "O", lemma: "O", pos: "X", xpos: "x", dep: "comp:obj", head: 0 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    expect(plan.spliceGroups.map((g) => g.kind)).not.toContain("chain");
    const invert = plan.spliceGroups.find((g) => g.rankTokenIds.length === 3)!;
    expect(invert.rankTokenIds).toEqual([30, 40, 20]);
    expect(invert.depth).toBe(1); // 上中下 — three ranks, which that tier has
    const postpose = plan.spliceGroups.find((g) => g.kind === "postpose")!;
    expect(postpose.rankTokenIds).toEqual([20, 25]);
    expect(postpose.depth).toBe(2); // 甲乙 — the continuation, one tier up

    expect(marks.get(20)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 1 });
    // 20 carries one mark from each tier, never two of the same one.
    expect(buildKundokuGlyphMap(plan).get(20)).toBe("㆘㆙");
  });
});

describe("kundokuTenAssigner: a レ点 neighbour costs a numeral series no tier", () => {
  it("keeps a series at 一二点 when its governor is the unmarked half of a レ点 pair", () => {
    // 令㆑於: the レ点 pair is 於(1) read then 令(0), and the whole pair is
    // written on 令 alone — 於 carries nothing from it. 於 is in turn the
    // deferred governor of its own two-character return (乙 back to 於), so a
    // numeral lands on 於. Nothing collides there: one character takes the レ,
    // the other takes the numeral. Escalating the numeral series to 上下点 to
    // "make room" spends a tier on a conflict that does not exist — and,
    // 上中下 being three symbols where 一二三四 is four, spends the room a
    // longer run of returns would need (但令㆑於…、縶… in the reader's own
    // file is exactly that run).
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "令", lemma: "令", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 2, text: "甲", lemma: "甲", pos: "NOUN", xpos: "x", dep: "mod", head: 3 },
        { id: 3, text: "乙", lemma: "乙", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "re" }); // 令㆑, over 於
    expect(marks.get(3)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 }); // 乙 一
    expect(marks.get(1)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 }); // 於 二 — not 下
    expect(traceMarks(sentence, plan)).toEqual([2, 3, 1, 0]); // 甲・乙・於・令
  });
});

describe("kundokuTenAssigner: レ点 is the one-character return, punctuation discounted", () => {
  // 劉答言：無。 — the reader's own 酒蟲 sent_id 6 with its quotation marks
  // taken off, which is what leaves 無 an ordinary inverting complement:
  // `isSpeechQuoteComplement` reads the opening bracket, and 言 carries the
  // treebank's 伝達 class, so the bracketed form is read frame-first with no
  // return mark at all (its own test follows). Unbracketed, 言(2) governs 無(4)
  // and returns over it, but ：(3) sits between them — so a test that counts
  // source positions calls that a two-position jump and writes 一二点. The
  // clause is one character.
  const yan = realSentence(`# sent_id = 6
# text = 劉答言無
1\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t3\tsubj\t_\t_
2\t答\t答\tPROPN\tv,動詞,行為,伝達\tNameType=Giv\t1\tflat\t_\t_
3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
4\t：\t：\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
5\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t3\tcomp:obj\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_
`);

  it("gives 言 a レ点 over 無, two token positions away but one character", () => {
    const plan = computeReadingOrder(yan, findCompoundSpans(yan));
    const group = plan.spliceGroups.find((g) => g.rankTokenIds.includes(2))!;
    expect(group.rankTokenIds).toEqual([4, 2]); // 無 read first, then 言

    const marks = assignKundokuTen(plan);
    expect(group.isRe).toBe(true);
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "re" });
    expect(marks.has(4)).toBe(false); // レ点 marks only its source-earlier member
    expect(buildKundokuGlyphMap(plan).get(2)).toBe("㆑");
  });

  it("still traces to 無 before 言 — a レ点 returns over the next character, not the next comma", () => {
    const plan = computeReadingOrder(yan, findCompoundSpans(yan));
    assignKundokuTen(plan);
    expect(textOf(yan, traceMarks(yan, plan))).toBe("劉答無言");
  });

  // The same sentence as the reader's file actually writes it. The 「 makes 無
  // a quotation, so the speech frame stands first and the whole clause is read
  // in source order — no return mark anywhere, and the quote's closing ト on 無.
  it("marks nothing at all once the complement is bracketed", () => {
    const quoted = realSentence(`# sent_id = 6
# text = 劉答言無
1\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t3\tsubj\t_\t_
2\t答\t答\tPROPN\tv,動詞,行為,伝達\tNameType=Giv\t1\tflat\t_\t_
3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
4\t：\t：\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
5\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
6\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t3\tcomp:obj\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_
`);
    const plan = computeReadingOrder(quoted, findCompoundSpans(quoted));
    expect(textOf(quoted, plan.order)).toBe("劉答言：「無。");
    expect(plan.spliceGroups).toEqual([]);
    expect(assignKundokuTen(plan).size).toBe(0);
    expect(plan.quoteEndIds.has(5)).toBe(true); // 無 — 「無し」ト
  });

  it("counts characters, not tokens: a two-character token next door is 一二点", () => {
    // 見番僧 with 番僧 one NOUN token. The return is over two characters
    // however the tokenizer split them, and レ点 is the one-character return.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "見", lemma: "見", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "番僧", lemma: "番僧", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);
    expect(plan.spliceGroups[0].isRe).toBe(false);
    expect(marks.get(1)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
  });

  it("leaves the anchors' レ点/一二点 split exactly where it was", () => {
    // 有朋自遠方來 is the case a clause-length rule could most easily spoil:
    // 自's jump over 遠 is one character and stays レ点, while 有's jump over
    // 朋自遠方來 is five and stays 一二点. Neither moves.
    const [you] = clauses("有朋自遠方來，不亦樂乎？");
    const plan = computeReadingOrder(you);
    const marks = assignKundokuTen(plan);
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "re" }); // 自㆑, over 遠
    expect(marks.get(5)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 }); // 來㆒
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 }); // 有㆓
    expect(textOf(you, traceMarks(you, plan))).toBe("朋遠自方來有");
  });
});
