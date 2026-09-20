import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import { classifyDep, classifyToken, isCausedPredicateParataxis, isNegatedBareReport } from "../src/kundoku/depClassification.ts";
import { isCausedOrPassivePredicate, OBLIQUE_DEPS } from "../src/kakikudashi/conjugationContext.ts";
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

  it("inverts every oblique relation, in both the labels the gold treebank writes and the ones a parse writes", () => {
    // The gold `lzh-*.sud.conllu` files carry `udep@lmod`/`udep@tmod` and never
    // `mod@lmod`/`mod@tmod`; the parser disambiguates `udep` into `mod`/
    // `comp:obl` and carries the subtype across, so a live parse produces the
    // second pair. Both registers reach this app, so both are inverted. See
    // `OBLIQUE_DEPS`.
    for (const dep of OBLIQUE_DEPS) expect(classifyDep(dep)).toBe("invert");
    expect([...OBLIQUE_DEPS].sort()).toEqual(
      ["comp:obl", "comp:obl@lmod", "comp:obl@tmod", "mod@lmod", "mod@tmod", "udep@lmod", "udep@tmod"].sort(),
    );
  });

  it("classifies documented NO-INVERT relations, including discourse particles", () => {
    // Plain `mod` and plain `udep` stay put. `udep` is the relation the model
    // itself left underspecified, which is this file's standing reason never to
    // move one; its `@lmod`/`@tmod` subtypes are not underspecified and do move.
    for (const dep of ["subj", "mod", "udep", "cc", "ROOT", "punct", "discourse", "discourse@sp"]) {
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

describe("classifyToken: a causative reads after the predicate it governs", () => {
  const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });

  /** 使民戰 / 令民俯 — the causative heads the clause, the causee is its
   * `comp:obj`, and `dep` is whichever relation the parser gave the caused
   * predicate. Live parses of both sentences give it `comp:obl`; `comp:aux` is
   * the same complement under the label used for an auxiliary's governed
   * predicate; and a live parse of the longer 但令於日中俯臥 gives `parataxis`,
   * which is what this file had no answer for. */
  const caused = (dep: string, lemma = "使", pos = "VERB"): Sentence => ({
    tokens: [
      tok({ id: 0, text: lemma, lemma, pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "民", lemma: "民", pos: "NOUN", dep: "comp:obj", head: 0 }),
      tok({ id: 2, text: "戰", lemma: "戰", pos, dep, head: 0 }),
    ],
  });

  it("inverts a caused predicate on every relation the parser gives it", () => {
    for (const dep of ["comp:obl", "comp:aux", "parataxis"]) {
      const s = caused(dep);
      expect(classifyToken(s.tokens[2], s.tokens[0], s)).toBe("invert");
      // Inverting the complement is the whole of what postposes the
      // auxiliary: the しむ has nothing of its own to move.
      expect(textOf(s, computeReadingOrder(s).order)).toBe("民戰使");
    }
  });

  it("reads 但令於日中俯臥 with the しむ last, as the parser returns it", () => {
    // The live parse: 臥 hangs off 令 by `parataxis` with 俯 as its own `mod`,
    // and 於 is the causative's `comp:obl`. Before this the sentence read
    // 但し日の中より**しむ**俯す臥さ — the auxiliary in front of the clause it
    // closes.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "但", lemma: "但", pos: "ADV", dep: "mod", head: 1 }),
        tok({ id: 1, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "於", lemma: "於", pos: "ADP", dep: "comp:obl", head: 1 }),
        tok({ id: 3, text: "日", lemma: "日", pos: "NOUN", dep: "mod", head: 4 }),
        tok({ id: 4, text: "中", lemma: "中", pos: "NOUN", dep: "comp:obj", head: 2 }),
        tok({ id: 5, text: "俯", lemma: "俯", pos: "VERB", dep: "mod", head: 6 }),
        tok({ id: 6, text: "臥", lemma: "臥", pos: "VERB", dep: "parataxis", head: 1 }),
      ],
    };
    expect(textOf(s, computeReadingOrder(s).order)).toBe("但日中於俯臥令");
  });

  it("leaves a quotative frame's own parataxis where the source put it", () => {
    // `parataxis` is a mixed relation — a verb of speech reaching its reported
    // clause uses it too, and 子曰：「…」 is read straight through. The
    // causative-governor bound is what keeps the two apart.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "parataxis", head: 0 }),
      ],
    };
    expect(classifyToken(s.tokens[1], s.tokens[0], s)).toBe("no-invert");
    expect(textOf(s, computeReadingOrder(s).order)).toBe("曰學");
  });

  it("does not reach a nominal apposed after a causative", () => {
    const s = caused("parataxis", "令", "NOUN");
    expect(classifyToken(s.tokens[2], s.tokens[0], s)).toBe("no-invert");
  });

  it("asks nothing of a token whose governor it has not been given", () => {
    // `resolveEffectiveHead` and `spanCarrier.ts` both call the one-argument
    // form, where there is no governor to be a causative.
    expect(classifyToken({ dep: "parataxis", lemma: "俯", pos: "VERB" })).toBe("no-invert");
  });

  it("names the same caused predicate the conjugation layer conjugates", () => {
    // The 未然形 and the postposing have to land on one token: 俯臥さしむ, not
    // a 未然形 on one word and the auxiliary jumping past another. Asserted on
    // the `parataxis` edge, which is the one this file decides for itself —
    // the `comp:*` relations are `INVERT_DEPS` members however the causative
    // machinery reads them.
    for (const [lemma, pos, want] of [
      ["令", "VERB", true],
      ["令", "AUX", true],
      ["令", "NOUN", false],
      ["曰", "VERB", false],
    ] as const) {
      const s = caused("parataxis", lemma, pos);
      expect(isCausedPredicateParataxis(s.tokens[2], s.tokens[0])).toBe(want);
      expect(isCausedOrPassivePredicate(s.tokens[2], s)).toBe(want);
    }
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

  it("nests the 自/遠 レ点 inside the 有/來 splice, and the レ点 costs that splice no tier", () => {
    // 有㆓朋自㆑遠方來㆒. The inner jump is a レ点, which states its whole return
    // on one glyph and spends no rank alphabet, so the group that brackets it
    // has nothing to clear and stays on 一二点 — `assignDepths` counts only
    // numeral groups. A レ点 group is given no depth of its own for the same
    // reason: its tier is "re" whatever the nesting says.
    const plan = computeReadingOrder(you);
    const marks = assignKundokuTen(plan);

    const inner = plan.spliceGroups.find((g) => g.rankTokenIds.includes(2))!;
    expect(inner.rankTokenIds).toEqual([3, 2]);
    expect(inner.depth).toBe(0);
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

  it("marks only the span's boundary member (方) for the inner jump, and the outer jump takes the upper tier", () => {
    // 有㆘朋自㆓遠方㆒來㆖ — the span makes 自's jump a two-character return, so
    // it is a numeral series rather than the レ点 the no-span parse gives it,
    // and 有's return brackets it and has to clear it by a tier. That is the
    // textbook shape character for character: 見㆘読㆓漢文㆒者㆖, read
    // 漢・文・読・者・見. The inner series is 一二点 and the *enclosing* one is
    // 上下点, never the reverse.
    //
    // Nothing in the live app reaches this: 遠方 is not a JMdict span there, so
    // the anchor stays 有㆓朋自㆑遠方來㆒ (the case above). The spans are handed
    // in here to build the shape.
    const plan = computeReadingOrder(you, spans);
    const marks = assignKundokuTen(plan);

    const inner = plan.spliceGroups.find((g) => g.rankTokenIds.includes(2))!;
    expect(inner.rankTokenIds).toEqual([4, 2]); // 方 (span's last member), then 自
    expect(inner.depth).toBe(0);
    expect(inner.isRe).toBe(false); // 方(4) and 自(2) are not source-adjacent (遠 sits between)
    expect(marks.has(3)).toBe(false); // 遠 (carrier, non-boundary member) gets no mark of its own
    expect(marks.get(4)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });

    const outer = plan.spliceGroups.find((g) => g.rankTokenIds.includes(0))!;
    expect(outer.rankTokenIds).toEqual([5, 0]);
    expect(outer.depth).toBe(1);
    expect(marks.get(5)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 });

    expect(buildKundokuGlyphMap(plan).get(0)).toBe("㆘");
    expect(textOf(you, traceMarks(you, plan))).toBe("朋遠方自來有");
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
  it("3-member splice group (two INVERT children) is written 二…一, not 三…一二", () => {
    // Synthetic: ROOT(2) with two INVERT children at 8 and 10 — the ordinary
    // OV shape, where both complements stand after the governor in the source
    // and both have to be read before it.
    //
    // The governor used to be the source-*last* token here (children at 2 and
    // 8 under a ROOT at 10), and that version stated a return over nothing:
    // 2, 8, 10 is already the reading order, so the reader takes the three
    // characters straight through and the 一二三 the group wrote said nothing.
    // See the `returningOrders` note in `reorderEngine.ts`.
    //
    // Three members, but only one return: A and B stand in that order in the
    // text and are read in that order, so the reader reaches B by carrying
    // straight on, and the only jump is B back to C. That is a two-rank
    // series, C㆓ A B㆒, and this file used to write it C㆔ A㆒ B㆓ — a 一
    // standing in the text ahead of its own 二, which is not a shape the
    // notation has. See `returnPoints` in `kundokuTenAssigner.ts`.
    const sentence: Sentence = {
      tokens: [
        { id: 2, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "ROOT", head: 2 },
        { id: 8, text: "A", lemma: "A", pos: "X", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 10, text: "B", lemma: "B", pos: "X", xpos: "x", dep: "comp:obl", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([8, 10, 2]);
    expect(plan.spliceGroups).toHaveLength(1);
    expect(plan.spliceGroups[0].rankTokenIds).toEqual([8, 10, 2]);

    const marks = assignKundokuTen(plan);
    expect(plan.spliceGroups[0].isRe).toBe(false);
    expect(marks.has(8)).toBe(false); // A — read in forward continuation
    expect(marks.get(10)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(2)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });

    const glyphs = buildKundokuGlyphMap(plan);
    expect([glyphs.get(2), glyphs.get(8), glyphs.get(10)]).toEqual(["㆓", undefined, "㆒"]);
    expect(traceMarks(sentence, plan)).toEqual([8, 10, 2]);
  });

  it("writes no mark for an INVERT child the source already puts first", () => {
    // A kaeriten says "read the material below before this character". A
    // complement standing in front of its governor is read before it by
    // reading straight on, so there is nothing for a mark to state — and one
    // written anyway lands on a character the reader is meant to pass
    // through, sending them away from the column for no reason.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "A", lemma: "A", pos: "X", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 1, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "ROOT", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1]);
    expect(plan.spliceGroups).toHaveLength(0);
    expect(assignKundokuTen(plan).size).toBe(0);
  });

  it("still ranks the genuine children of a governor that also has a vacuous one", () => {
    // One complement in front of the governor and one behind it: only the one
    // behind needs a return, and the ranks close up around it rather than
    // leaving a gap where the other one used to be.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "A", lemma: "A", pos: "X", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 1, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "B", lemma: "B", pos: "X", xpos: "x", dep: "comp:obl", head: 1 },
        { id: 3, text: "D", lemma: "D", pos: "X", xpos: "x", dep: "comp:obj", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 3, 2, 1]);
    const groups = plan.spliceGroups.map((g) => g.rankTokenIds);
    expect(groups).toContainEqual([2, 1]);
    expect(groups.every((ranks) => !ranks.includes(0))).toBe(true);
  });

  it("three genuinely straddling nested splice groups put the outermost on kou-otsu", () => {
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

    // The innermost return is the one that encloses nothing, so it is the one
    // written 一二点; each series that brackets it climbs a tier.
    expect(inner.depth).toBe(0);
    expect(middle.depth).toBe(1);
    expect(outer.depth).toBe(2);

    expect(marks.get(25)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });
    expect(marks.get(27)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(20)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 });
    expect(marks.get(30)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 2 });
    expect(marks.get(50)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 1 });

    // And the marks still trace: R㆚ … M㆘ I㆓ K J㆒ N㆖ … O㆙, read
    // K・J・I・N・M・O・R.
    expect(traceMarks(sentence, plan)).toEqual(plan.order);
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

  it("does the same with the bracket taken away — for 曰/云 it decides nothing", () => {
    // **The one place the bracket test is stood down**, and the corpus is what
    // stands it down: 曰/云's clausal complements are 96.3% bracketed in
    // lzh-{train,dev,test} against 56.5% for the rest of the 伝達 class, so an
    // absent bracket says which edition this is and not what the sentence
    // means. kanbun.info's 白文 carries no quotation marks at all and every
    // 子曰 in it read 〜を曰ふ, the frame stranded at the end of the clause it
    // introduces — **2,950 edits** over its 2,795 parsed passages, and 11 the
    // other way over the 624 gold ones, whose 白文 does bracket. See
    // `isSpeechQuoteComplement`.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1, 2]);
    expect(plan.spliceGroups).toHaveLength(0);
    expect(plan.quoteEndIds).toEqual(new Set([2]));
  });

  it("still inverts an unquoted complement of the wider 伝達 class", () => {
    // 謂/言/問 keep the bracket test, because for them the corpus really is a
    // coin flip (56.5%) and the 謂其身有異疾 / 俱言不須 pair the reader has ruled
    // on lives in it. Unbracketed, the complement is an ordinary object: it
    // inverts, takes 連体形 + を, and no ト closes it.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 },
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

  /** 俱言不須。 — the reader's own sent_id 19, and the one shape of
   * *unbracketed* clausal complement that still takes と. The と cannot be
   * written by `conjugationContext.ts`'s `quotativeParticleFor`, which can only
   * reach the complement's own head word: 不 is postposed past 須, so the と
   * belongs after the ず — ともに用ゐ**ずと**言ふ — which is a position only
   * `quoteEndIds` addresses. See `isNegatedBareReport`, which is explicit about
   * resting on a shape rather than a discriminator. */
  it("closes a negated, subjectless complement with ト, and still inverts it (俱言不須)", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 1, text: "俱", lemma: "俱", pos: "ADV", xpos: "v,副詞,範囲,共同", dep: "mod", head: 2 },
        { id: 2, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 },
        { id: 3, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 4, morph: "Polarity=Neg" },
        { id: 4, text: "須", lemma: "須", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 2 },
        { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    // Unlike a bracketed quote, which stays put after its verb (子曰はく、「…」と),
    // this is an ordinary INVERT child and is read before it.
    expect(plan.order).toEqual([1, 4, 3, 2, 5]);
    // Two groups: 須 inverting before 言, and 不 postposing past 須.
    expect(plan.spliceGroups.map((g) => g.kind)).toEqual(["postpose", "invert"]);
    expect(plan.quoteEndIds).toEqual(new Set([3])); // 不 — the ト follows the ず
  });

  it("wants the negation and the missing subject both, so 謂其身有異疾 is untouched", () => {
    const gov = { lemma: "謂", dep: "ROOT", xpos: "v,動詞,行為,伝達" };
    // 有 in 謂其身有異疾 (酒蟲 sent_id 5): a clausal complement of a speech verb
    // with no bracket, but no negation either. This is the reading the reader
    // has seen and accepted as を, and it must not move.
    const disease: Sentence = {
      tokens: [
        { id: 0, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 0 },
        { id: 1, text: "身", lemma: "身", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 0 },
        { id: 2, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 0 },
        { id: 3, text: "疾", lemma: "疾", pos: "NOUN", xpos: "n,名詞,不可譲,疾病", dep: "comp:obj", head: 2 },
      ],
    };
    expect(isNegatedBareReport(disease.tokens[2], gov, disease)).toBe(false);

    // Negated, but with a subject of its own — the other half of the
    // conjunction. 言祿山必反 ("said An Lushan would surely revolt") is the
    // corpus's shape for this; negated, it is 言X不反, and the corpus gives a
    // subject-bearing negated complement no more claim on と than an unnegated
    // one (54.1% bracketed against a 57% baseline).
    const withSubject: Sentence = {
      tokens: [
        { id: 0, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 0 },
        { id: 1, text: "王", lemma: "王", pos: "NOUN", xpos: "n,名詞,主体,人", dep: "subj", head: 3 },
        { id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" },
        { id: 3, text: "反", lemma: "反", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 0 },
      ],
    };
    expect(isNegatedBareReport(withSubject.tokens[3], gov, withSubject)).toBe(false);
  });

  it("leaves a bracketed complement to the quote rule, so no second ト is written", () => {
    // 曰：「不知。」 — negated and subjectless, but bracketed, so
    // `isSpeechQuoteComplement` already owns it: the complement stays put after
    // 曰 and the ト is marked from there. Both rules firing would put two ト in
    // one sentence.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 0 },
        { id: 1, text: "「", lemma: "「", pos: "PUNCT", xpos: "s,記号,括弧,*", dep: "punct", head: 3 },
        { id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" },
        { id: 3, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 0 },
      ],
    };
    const gov = { lemma: "曰", dep: "ROOT", xpos: "v,動詞,行為,伝達" };
    expect(isNegatedBareReport(sentence.tokens[3], gov, sentence)).toBe(false);
    const plan = computeReadingOrder(sentence);
    expect(plan.order).toEqual([0, 1, 3, 2]); // no invert: the quote follows 曰
    expect(plan.quoteEndIds.size).toBe(1);
  });

  it("wants a verb of speech — an ordinary governor's negated object is unaffected", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "ROOT", head: 0 },
        { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 0 },
      ],
    };
    expect(isNegatedBareReport(sentence.tokens[2], { lemma: "得", dep: "ROOT", xpos: "v,動詞,行為,得失" }, sentence)).toBe(false);
    expect(computeReadingOrder(sentence).quoteEndIds).toEqual(new Set());
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
8\t半\t半\tADJ\tv,動詞,描写,量\tDegree=Pos\t9\tmod\t_\t_
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
    // The clause that used to vanish, in its own reading order:
    // 飲を以て累と為さざるなり — the 也 read last, on the finished predicate.
    expect(textOf(fu, plan.order)).toBe("負郭田三百畝、輒半黍種；而家豪富、飲以累為不也。");
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
7\t肥\t肥\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
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
  // Ids double as source positions in the synthetic fixtures and are often
  // sparse, so the executor is handed (and hands back) positions no token
  // occupies. They carry no mark and so only ever ride along in an unmarked
  // run; dropping them leaves the real tokens in the order the marks put them.
  return executeKunten(kuntens, isPunct).filter((id) => byId.has(id) && !isPunct(id));
}

describe("kundokuTenAssigner: a rank only where the reader has to return", () => {
  // A kaeriten series is read by running forward through the text, passing
  // over every marked character, and on reaching 一 reading it and jumping
  // back up to 二, then to 三. Every step of that walk goes *backwards*, so a
  // series stands in the text in descending order — 三 … 二 … 一 — and a
  // character the reader arrives at by carrying straight on needs no mark.
  //
  // Counted rather than reasoned out: 論語集説 as transcribed on ja.wikisource,
  // an Edo commentary edition carrying its own 訓点, has 1,204 same-tier steps
  // within a series and every one of them descends. See `returnPoints`.
  it("writes 告㆓諸往㆒ — 往 follows 諸 in the text, so 諸 carries nothing", () => {
    // 告諸往而知來者 (學而 1-15), read 諸に往を告げて. 告 governs both 諸 and 往
    // and both are read before it, but they are read in the order the text
    // already puts them in, so the only return is 往 back to 告.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "告", lemma: "告", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "諸", lemma: "諸", pos: "PRON", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 2, text: "往", lemma: "往", pos: "NOUN", xpos: "x", dep: "comp:obl", head: 0 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(textOf(sentence, plan.order)).toBe("諸往告");
    assignKundokuTen(plan);

    const glyphs = buildKundokuGlyphMap(plan);
    expect(sentence.tokens.map((t) => `${t.text}${glyphs.get(t.id) ?? ""}`).join("")).toBe("告㆓諸往㆒");
    expect(traceMarks(sentence, plan)).toEqual([1, 2, 0]);
  });

  it("never writes a lower rank ahead of a higher one, over both shipped samples", () => {
    // The invariant, asserted where it can be asserted in bulk: 論語・學而 and
    // 酒蟲, every sentence, every tier. Before the rule was corrected these two
    // texts wrote six series as 三…一二 between them.
    const tiers = ["一二三四", "上中下", "甲乙丙", "天地人"];
    for (const name of ["rongo-gakuji.conllu", "shuchu.conllu"]) {
      const path = fileURLToPath(new URL(`../public/data/samples/${name}`, import.meta.url));
      for (const sentence of parseConllu(readFileSync(path, "utf-8")).sentences) {
        const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
        assignKundokuTen(plan);
        const marks = buildPlainKuntenMarks(plan);
        for (const tier of tiers) {
          // The ranks of one tier, in the order the *text* has them.
          const written = sentence.tokens
            .flatMap((t) => [...(marks.get(t.id) ?? "")].map((c) => ({ token: t, rank: tier.indexOf(c) + 1 })))
            .filter((m) => m.rank > 0);
          for (let i = 1; i < written.length; i++) {
            // A 一 closes its series, so anything may follow it; anywhere else
            // the next rank of the same tier must be a lower one.
            if (written[i - 1].rank === 1) continue;
            expect(
              written[i].rank,
              `${textOf(sentence, sentence.tokens.map((t) => t.id))}: ${written[i - 1].token.text} then ${written[i].token.text}`,
            ).toBeLessThan(written[i - 1].rank);
          }
        }
      }
    }
  });
});

describe("kundokuTenAssigner: 一レ点 where the return is one character (不以飲為累也, 酒蟲 sent. 4)", () => {
  // 為(19) is the deferred governor of the INVERT group that reads 累 before
  // it, *and* the governor of the POSTPOSE group that reads 不 after it. Both
  // came out 一二点 and 為 was written 二一 — two ranks of one tier on one
  // character, which no edition does.
  //
  // **What settles it is where the 也 is read**, and it used to be read in the
  // wrong place. 也 is 断定 なり, and an auxiliary stands *on* a finished
  // predicate: it closes 為's clause, not 累's. Travelling inside 累's block it
  // put the order at 累・也・為・不 — 累なり爲さず, the assertion asserted before
  // its own predicate — and the 一 of the series on 也. It now stays where the
  // source has it and is read last (`isClosingParticle` in `reorderEngine.ts`,
  // which carries the treebank population this was measured over), so the
  // order is 飲・以・累・為・不・也 — 飲を以て累と爲さざるなり, the received
  // reading — and the return from 累 to 為 is over **one character**.
  //
  // A one-character return is レ点, by the same rule every other group here is
  // measured by, so 為 takes a レ点 and the 不 return above it a 一二点: the
  // stacked 一レ点 that real kanbun writes for exactly this shape. `fuseChains`
  // is not reached at all — it never absorbs a レ点 group — and the fused
  // 一二三点 it exists for is still exercised by 謂其身有異疾 below.
  //
  // **Before this, the sentence was written 不㆔ 以㆑ 飲 為㆓ 累 也㆒.** That is
  // the reading of a text whose 也 comes before its predicate; the reader's
  // ruling that a 一点 never lands on a sentence-final particle is what
  // replaced it.
  const fu = realSentence(JIU_CHONG_4);

  it("keeps the two returns apart — a レ点 is never fused into a numeral series", () => {
    const plan = computeReadingOrder(fu, findCompoundSpans(fu));
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([20, 19]); // 累 → 為
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([19, 16]); // 為 → 不

    const marks = assignKundokuTen(plan);
    expect(plan.spliceGroups.find((g) => g.kind === "chain")).toBeUndefined();
    expect(plan.spliceGroups.find((g) => g.rankTokenIds.join() === "20,19")!.isRe).toBe(true);

    expect(marks.get(19)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 }); // 為 一
    expect(marks.get(16)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 }); // 不 二
  });

  it("writes 不㆓ 以㆑ 飲 為㆒㆑ 累 也 — the 一 on the predicate, nothing on the 也", () => {
    const plan = computeReadingOrder(fu, findCompoundSpans(fu));
    assignKundokuTen(plan);
    const glyphs = buildKundokuGlyphMap(plan);
    expect(glyphs.get(16)).toBe("㆓"); // 不
    expect(glyphs.get(17)).toBe("㆑"); // 以 — レ点 over 飲
    expect(glyphs.get(19)).toBe("㆒㆑"); // 為 — 一レ点, the numeral above the レ
    expect(glyphs.get(20)).toBeUndefined(); // 累 — the レ点 states its own return
    expect(glyphs.get(21)).toBeUndefined(); // 也 — was carrying the 一
    expect(glyphs.get(8)).toBe("㆑"); // 種 — the other レ点 in the sentence
  });

  it("traces back to the same reading order: 飲・以・累・為・不・也", () => {
    const plan = computeReadingOrder(fu, findCompoundSpans(fu));
    assignKundokuTen(plan);
    const byId = new Map(fu.tokens.map((t) => [t.id, t]));
    expect(traceMarks(fu, plan)).toEqual(plan.order.filter((id) => byId.get(id)?.dep !== "punct"));
    expect(textOf(fu, traceMarks(fu, plan).slice(-6))).toBe("飲以累為不也");
  });
});

describe("reorderEngine: a sentence-final particle is read after the return, not before it (未足與議也, 論語 里仁 9)", () => {
  // The same rule as 不以飲為累也 above, reaching one step further. 也 is
  // 断定 なり and stands *on* a finished predicate, so it closes the clause the
  // 返り点 returns *to* and is read after it — 未だ与に議るに足らざる**なり**,
  // which is the received reading kanbun.info prints.
  //
  // **What was stopping it was the punctuation behind the particle.** The rule
  // holds a trailing sentence-final particle back out of an INVERT child's
  // travelling block, and it walked back from the end of that block over
  // particles only; a 也 followed by 。」 — which is what a 也 ending reported
  // speech always is — was never reached at all. So the order came out
  // 未・議・**也**・足・與, the assertion asserted before its own predicate, and
  // 未足與議也 read 未だ議す**なり**足す與にず.
  //
  // **The 返り点 did not move, and that is the point.** `lastMeaningful`
  // already refused to rank the particle, so the marks already said
  // 未㆓足㆓與㆒議㆒也 — the 一 on 議, the 二 on 足, nothing on the 也 — and it
  // was the *reading order* that disagreed with them. Over the kanbun.info
  // corpus the block held 98 numeral groups and 30 レ点 ones in that state;
  // fixing it left 0 of either, and the marks-only round trip
  // (`kuntenExecutor`, the same trace `traceMarks` runs) went from 1,507
  // failing sentences to 1,319 — **188 repaired and none broken**.
  const shi = realSentence(`# sent_id = rongo0409
# text = 子曰：「士志於道，而恥惡衣惡食者，未足與議也。」
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
5\t士\t士\tNOUN\tn,名詞,人,役割\t_\t6\tsubj\t_\t_
6\t志\t志\tVERB\tv,動詞,行為,態度\t_\t2\tparataxis\t_\t_
7\t於\t於\tADP\tv,前置詞,基盤,*\t_\t6\tcomp:obl\t_\t_
8\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t7\tcomp:obj\t_\t_
9\t，\t，\tPUNCT\ts,記号,読点,*\t_\t6\tpunct\t_\t_
10\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t16\tmod\t_\t_
11\t恥\t恥\tVERB\tv,動詞,行為,態度\t_\t16\tmod\t_\t_
12\t惡\t惡\tNOUN\tn,名詞,描写,態度\t_\t13\tmod\t_\t_
13\t衣\t衣\tNOUN\tn,名詞,可搬,道具\t_\t11\tcomp:obj\t_\t_
14\t惡\t惡\tNOUN\tn,名詞,描写,態度\t_\t15\tmod\t_\t_
15\t食\t食\tNOUN\tn,名詞,可搬,糧食\t_\t13\tconj:coord\t_\t_
16\t者\t者\tPART\tp,助詞,提示,*\t_\t19\tsubj\t_\t_
17\t，\t，\tPUNCT\ts,記号,読点,*\t_\t16\tpunct\t_\t_
18\t未\t未\tADV\tv,副詞,否定,有界\tPolarity=Neg\t19\tmod\t_\t_
19\t足\t足\tAUX\tv,助動詞,可能,*\tMood=Pot\t6\tparataxis\t_\t_
20\t與\t與\tADV\tv,動詞,行為,交流\tVerbForm=Conv\t19\tmod\t_\t_
21\t議\t議\tVERB\tv,動詞,行為,交流\t_\t19\tcomp:aux\t_\t_
22\t也\t也\tPART\tp,助詞,句末,*\t_\t21\tdiscourse@sp\t_\t_
23\t。\t。\tPUNCT\ts,記号,句点,*\t_\t19\tpunct\t_\t_
24\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t22\tpunct\t_\t_
`);

  it("reads the 也 last, after the character the 一 returns to", () => {
    const plan = computeReadingOrder(shi, findCompoundSpans(shi));
    const byId = new Map(shi.tokens.map((t) => [t.id, t]));
    const read = plan.order.filter((id) => byId.get(id)?.dep !== "punct");
    // 議(20) → 足(18) → 與(19) → 也(21). The 與 standing after 足 rather than
    // before 議 is a separate matter and is not what this pins; what this pins
    // is that the 也 is last of the four, not second.
    expect(textOf(shi, read.slice(-4))).toBe("議足與也");
  });

  it("writes 未㆓ 足㆓ 與㆒ 議㆒ 也 — nothing on the particle", () => {
    const plan = computeReadingOrder(shi, findCompoundSpans(shi));
    assignKundokuTen(plan);
    const glyphs = buildKundokuGlyphMap(plan);
    expect(glyphs.get(18)).toBe("㆓"); // 足
    expect(glyphs.get(20)).toBe("㆒"); // 議 — the 一 the return leaves from
    expect(glyphs.get(21)).toBeUndefined(); // 也 — outside the clause it closes
  });
});

describe("reorderEngine: a 。 behind the particle does not pin it inside the block (自古之政也)", () => {
  // The minimal shape, and the one the walk used to stop at. 政 is 自's INVERT
  // child and 也 hangs off 政, so the particle travels with the child unless it
  // is held back; the 。 sits behind it and is what the old walk hit first.
  //
  // Stepping over the mark is free because a mark's slot in this order is not
  // settled by the tree walk at all — `placeMarks` re-anchors every one of them
  // to the source token it follows once the walk has run — which is why the 。
  // comes out last either way.
  const ji = realSentence(`# sent_id = shiba01
# text = 自古之政也。
1\t自\t自\tADP\tv,前置詞,経由,*\t_\t0\troot\t_\t_
2\t古\t古\tNOUN\tn,名詞,時,*\tCase=Tem\t3\tcomp:obj\t_\t_
3\t之\t之\tPART\tp,助詞,接続,属格\t_\t4\tmod\t_\t_
4\t政\t政\tNOUN\tn,名詞,制度,儀礼\t_\t1\tcomp:obj\t_\t_
5\t也\t也\tPART\tp,助詞,句末,*\t_\t4\tdiscourse@sp\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
`);

  it("reads 古・之・政・自・也 and marks 政㆒ 自㆓", () => {
    const plan = computeReadingOrder(ji, findCompoundSpans(ji));
    assignKundokuTen(plan);
    const glyphs = buildKundokuGlyphMap(plan);
    expect(textOf(ji, plan.order)).toBe("古之政自也。");
    expect(glyphs.get(3)).toBe("㆒"); // 政
    expect(glyphs.get(0)).toBe("㆓"); // 自
    expect(glyphs.get(4)).toBeUndefined(); // 也
    // And the marks trace the order back, which is the whole claim.
    const byId = new Map(ji.tokens.map((t) => [t.id, t]));
    expect(traceMarks(ji, plan)).toEqual(plan.order.filter((id) => byId.get(id)?.dep !== "punct"));
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
10\t異\t異\tADJ\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t11\tmod\t_\t_
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
  /** A governor `M` with one INVERT child `N` and one postposed negation — the
   * two groups meet at `M` and so fuse into a three-rank chain — bracketing
   * `levels` nested numeral groups of its own. The chain's span runs from the
   * negation (source-first, read last) out to `N`, and each enclosed group is
   * built inside that span as a governor with its own INVERT child and one
   * character between them, so the return is two characters and takes
   * numerals rather than レ点.
   *
   * A chain climbs a tier for what it *brackets*, so the nesting has to sit
   * inside it — the enclosing wrapper the old version of this fixture used
   * would now escalate the wrapper and leave the chain on 一二三点. Ids double
   * as source positions, as elsewhere in this file, and are spaced out to
   * leave room for the nestings. */
  function nestedChain(levels: 1 | 2): { sentence: Sentence; ranks: [number, number, number] } {
    const chain: Token[] = [
      { id: 100, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 150, morph: "Polarity=Neg" },
      // 亦's role in 不亦說乎: one character between the negation and its verb,
      // which is what makes the postposing a two-character return and so a
      // numeral group rather than a レ点 (レ点 never fuses).
      { id: 120, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 150 },
      { id: 150, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "ROOT", head: 150 },
      { id: 300, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 150 },
      // The nesting the chain brackets: G1 reads C1 before itself, and F sits
      // between them so that return is a numeral one.
      { id: 200, text: "G", lemma: "G", pos: "X", xpos: "x", dep: "mod", head: 300 },
      { id: 250, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "comp:obj", head: 200 },
    ];
    if (levels === 1) {
      return {
        ranks: [300, 150, 100],
        sentence: { tokens: [...chain, { id: 220, text: "F", lemma: "F", pos: "X", xpos: "x", dep: "mod", head: 250 }] },
      };
    }
    // A second nesting inside the first: G2 reads C2 before itself, and both
    // sit strictly inside G1's span, so G1 clears C2's series and the chain
    // clears G1's.
    return {
      ranks: [300, 150, 100],
      sentence: {
        tokens: [
          ...chain,
          { id: 210, text: "H", lemma: "H", pos: "X", xpos: "x", dep: "mod", head: 250 },
          { id: 230, text: "D", lemma: "D", pos: "X", xpos: "x", dep: "comp:obj", head: 210 },
          { id: 220, text: "F", lemma: "F", pos: "X", xpos: "x", dep: "mod", head: 230 },
        ],
      },
    };
  }

  it("one nesting deep, a fused chain is 上中下点 (not 上下 twice)", () => {
    const { sentence, ranks } = nestedChain(1);
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual(ranks);
    expect(chain.depth).toBe(1);
    expect(marks.get(300)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 }); // 上
    expect(marks.get(150)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 }); // 中
    expect(marks.get(100)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 3 }); // 下

    // The series it brackets keeps 一二点 — the tier a return that encloses
    // nothing else is written on.
    const nested = plan.spliceGroups.find((g) => g.rankTokenIds.includes(200))!;
    expect(nested.depth).toBe(0);
    expect(marks.get(250)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(200)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 2 });

    const glyphs = buildKundokuGlyphMap(plan);
    expect([glyphs.get(300), glyphs.get(150), glyphs.get(100)]).toEqual(["㆖", "㆗", "㆘"]);
    expect(traceMarks(sentence, plan)).toEqual(plan.order);
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

    // 一二点 innermost, 上下点 around it, 甲乙丙点 around that — the tiers in the
    // order the convention stacks them.
    expect(plan.spliceGroups.find((g) => g.rankTokenIds.includes(210))!.depth).toBe(0);
    expect(plan.spliceGroups.find((g) => g.rankTokenIds.includes(200))!.depth).toBe(1);

    const glyphs = buildKundokuGlyphMap(plan);
    expect(ranks.map((id) => glyphs.get(id))).toEqual(["㆙", "㆚", "㆛"]);
    expect([glyphs.get(230), glyphs.get(210)]).toEqual(["㆒", "㆓"]);
    expect([glyphs.get(250), glyphs.get(200)]).toEqual(["㆖", "㆘"]);
    expect(traceMarks(sentence, plan)).toEqual(plan.order);
  });
});

describe("kundokuTenAssigner: which of two colliding series climbs", () => {
  it("puts the group that holds the other's governor as a plain member on the upper tier", () => {
    // V takes two INVERT children — A, and the whole 不亦M…N clause, whose
    // last-read character is the postposed 不. So 不 is a plain member of V's
    // series *and* the deferred governor of the chain N㆖ M㆗ 不㆘, and the two
    // series meet on it. `fuseChains` declines the join: the run it would make
    // is four returns (N, M, 不, V) and it brackets the C/G nesting, so it
    // lands on 上中下, which has no fourth symbol. The run therefore has to be
    // written as a nesting after all.
    //
    // Neither span contains the other — V's is [50,100] and the chain's is
    // [100,300], and they merely abut — so nothing but the shared character
    // says which way round the tiers go. The chain's whole series is read out
    // at the moment V's series reaches 不, and V is still waiting for its own
    // last rank, so V's is the series that brackets and V's is the one that
    // climbs. Escalating the *inner* one instead resolves the same collision —
    // it is what this file used to do — but it writes the enclosing return on
    // the lower tier, the reverse of 「上中下点は、一二三点を挟んで使います」.
    //
    // A carries nothing: it is read first and the reader reaches 不 from it by
    // carrying straight on, so V's series is written 不㆙ … V㆚ and spends two
    // symbols, not three (see `returnPoints`).
    const sentence: Sentence = {
      tokens: [
        { id: 50, text: "V", lemma: "V", pos: "X", xpos: "x", dep: "ROOT", head: 50 },
        { id: 70, text: "A", lemma: "A", pos: "X", xpos: "x", dep: "comp:obj", head: 50 },
        { id: 100, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 150, morph: "Polarity=Neg" },
        { id: 120, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 150 },
        { id: 150, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "comp:obl", head: 50 },
        { id: 200, text: "G", lemma: "G", pos: "X", xpos: "x", dep: "mod", head: 300 },
        { id: 220, text: "F", lemma: "F", pos: "X", xpos: "x", dep: "mod", head: 250 },
        { id: 250, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "comp:obj", head: 200 },
        { id: 300, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 150 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);
    expect(textOf(sentence, plan.order)).toBe("A亦FCGNM不V");

    const outer = plan.spliceGroups.find((g) => g.rankTokenIds.includes(50))!;
    expect(outer.rankTokenIds).toEqual([70, 100, 50]);
    expect(outer.depth).toBe(2);
    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual([300, 150, 100]);
    expect(chain.depth).toBe(1);

    expect(marks.has(70)).toBe(false); // A — nothing returns to it
    expect(marks.get(100)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 1 }); // 不 甲
    expect(marks.get(50)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 2 }); // V 乙
    expect(marks.get(300)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 }); // N 上
    // The shared character carries one mark from each tier, inner first — the
    // order `kuntenExecutor` peels them in.
    expect(buildKundokuGlyphMap(plan).get(100)).toBe("㆘㆙");
    expect(traceMarks(sentence, plan)).toEqual(plan.order);
  });

  it("clears the deepest nesting by one tier, not one tier per group nested", () => {
    // O's return brackets two separate numeral series (M1's and M2's) that do
    // not bracket each other: the reader finishes the first entirely before
    // meeting the second, never tracking both at once, so the two share 一二点
    // quite happily. O has to clear them by one tier, not by two — counting
    // the groups it encloses instead of measuring how deep they nest would
    // spend a tier per sibling and write 甲乙点 for a sentence with no 上下点
    // in it.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "R", lemma: "R", pos: "X", xpos: "x", dep: "ROOT", head: 0 },
        { id: 100, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "mod", head: 500 },
        { id: 150, text: "F", lemma: "F", pos: "X", xpos: "x", dep: "mod", head: 200 },
        { id: 200, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "comp:obj", head: 100 },
        { id: 300, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "mod", head: 500 },
        { id: 350, text: "G", lemma: "G", pos: "X", xpos: "x", dep: "mod", head: 400 },
        { id: 400, text: "D", lemma: "D", pos: "X", xpos: "x", dep: "comp:obj", head: 300 },
        { id: 500, text: "O", lemma: "O", pos: "X", xpos: "x", dep: "comp:obj", head: 0 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    const first = plan.spliceGroups.find((g) => g.rankTokenIds.includes(100))!;
    const second = plan.spliceGroups.find((g) => g.rankTokenIds.includes(300))!;
    const outer = plan.spliceGroups.find((g) => g.rankTokenIds.includes(0))!;
    expect([first.depth, second.depth]).toEqual([0, 0]);
    expect(outer.depth).toBe(1);

    expect(marks.get(200)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(400)).toEqual<KundokuMark>({ tier: "ichi-ni", rank: 1 });
    expect(marks.get(500)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 });
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 });
    expect(traceMarks(sentence, plan)).toEqual(plan.order);
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

  it("counts the ranks it would write, not its members, before refusing", () => {
    // The 上中下 chain above with a second INVERT child on M. Four members
    // reach the fused run — P, Q, M, 不 — but P and Q stand in the text in the
    // order they are read, so the reader crosses from P to Q unbidden and only
    // three of the four ever carry a rank. 上中下 has exactly three symbols, so
    // the fuse is admissible and the run is one series rather than a nesting.
    //
    // The count that matters is the count of ranks *written* — measuring the
    // members instead refuses this fuse and escalates the postposing onto
    // 甲乙点, spending a tier the notation never needed.
    const sentence: Sentence = {
      tokens: [
        { id: 100, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 150, morph: "Polarity=Neg" },
        { id: 120, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 150 },
        { id: 150, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "ROOT", head: 150 },
        { id: 200, text: "G", lemma: "G", pos: "X", xpos: "x", dep: "mod", head: 300 },
        { id: 220, text: "F", lemma: "F", pos: "X", xpos: "x", dep: "mod", head: 250 },
        { id: 250, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "comp:obj", head: 200 },
        { id: 300, text: "P", lemma: "P", pos: "X", xpos: "x", dep: "comp:obj", head: 150 },
        { id: 400, text: "Q", lemma: "Q", pos: "X", xpos: "x", dep: "comp:obl", head: 150 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual([300, 400, 150, 100]);
    expect(chain.depth).toBe(1); // 上中下 — three ranks, which that tier has
    expect(marks.has(300)).toBe(false); // P — read straight through to Q
    expect(marks.get(400)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 1 }); // Q 上
    expect(marks.get(150)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 2 }); // M 中
    expect(marks.get(100)).toEqual<KundokuMark>({ tier: "jou-ge", rank: 3 }); // 不 下

    // The nesting that pushed the chain up to 上中下 in the first place keeps
    // 一二点: it encloses nothing.
    expect(plan.spliceGroups.find((g) => g.rankTokenIds.includes(200))!.depth).toBe(0);
    expect(traceMarks(sentence, plan)).toEqual(plan.order);
  });

  it("escalates instead of fusing when the series would outrun its tier", () => {
    // The same 上中下 chain, now the object of an outer governor V, so the run
    // carries on from 不 to V and needs a fourth rank — N, M, 不, V, every one
    // of them a return. 一二三四 would spell it, but this run brackets a
    // nesting of its own and so lands on 上中下, which has no fourth symbol.
    // The fuse is therefore refused, and the continuation — the group still
    // open once the other's series has closed — is escalated onto 甲乙点
    // instead: a nesting the reader can still follow, rather than a symbol no
    // edition has or a second 上中下 series colliding on the same character.
    //
    // Which side climbs is the whole point: the 上中下 series is read out
    // entirely (N·M·不) and the 甲乙 series is the one that then carries on
    // from 不 to V, exactly as 見㆘読㆓漢文㆒者㆖'s 上 is picked up at the
    // character 読's 二 closes on. The continuation brackets, so the
    // continuation climbs.
    const sentence: Sentence = {
      tokens: [
        { id: 50, text: "V", lemma: "V", pos: "X", xpos: "x", dep: "ROOT", head: 50 },
        { id: 70, text: "W", lemma: "W", pos: "X", xpos: "x", dep: "mod", head: 150 },
        { id: 100, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 150, morph: "Polarity=Neg" },
        { id: 120, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 150 },
        { id: 150, text: "M", lemma: "M", pos: "X", xpos: "x", dep: "comp:obj", head: 50 },
        { id: 200, text: "G", lemma: "G", pos: "X", xpos: "x", dep: "mod", head: 300 },
        { id: 220, text: "F", lemma: "F", pos: "X", xpos: "x", dep: "mod", head: 250 },
        { id: 250, text: "C", lemma: "C", pos: "X", xpos: "x", dep: "comp:obj", head: 200 },
        { id: 300, text: "N", lemma: "N", pos: "X", xpos: "x", dep: "comp:obj", head: 150 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const marks = assignKundokuTen(plan);

    const chain = plan.spliceGroups.find((g) => g.kind === "chain")!;
    expect(chain.rankTokenIds).toEqual([300, 150, 100]);
    expect(chain.depth).toBe(1); // 上中下 — three ranks, which that tier has
    const outer = plan.spliceGroups.find((g) => g.rankTokenIds.includes(50))!;
    expect(outer.rankTokenIds).toEqual([100, 50]);
    expect(outer.depth).toBe(2); // 甲乙 — the continuation, one tier up

    // The nesting that pushed the chain up to 上中下 in the first place keeps
    // 一二点: it encloses nothing.
    expect(plan.spliceGroups.find((g) => g.rankTokenIds.includes(200))!.depth).toBe(0);

    expect(marks.get(100)).toEqual<KundokuMark>({ tier: "kou-otsu", rank: 1 });
    // 100 carries one mark from each tier, never two of the same one, and the
    // inner tier is written first — the order `kuntenExecutor` peels them in.
    expect(buildKundokuGlyphMap(plan).get(100)).toBe("㆘㆙");
    expect(traceMarks(sentence, plan)).toEqual(plan.order);
  });
});

describe("kundokuTenAssigner: a レ点 neighbour costs a numeral series no tier", () => {
  it("keeps a series at 一二点 when its governor is the unmarked half of a レ点 pair", () => {
    // 令㆑於: the レ点 pair is 於(1) read then 令(0), and the whole pair is
    // written on 令 alone — 於 carries nothing from it. 於 is in turn the
    // deferred governor of its own two-character return (乙 back to 於), so a
    // numeral lands on 於. Nothing collides there: one character takes the レ,
    // the other takes the numeral. The レ点 pair is what holds 於, this
    // series' governor, as a plain member, so it is the pair that would climb
    // — and a レ点 has no tier to climb to. Escalating the numeral series
    // instead, to "make room", spends a tier on a conflict that does not
    // exist — and,
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
  // 見：僧 — a governor and a one-character object with an editor's mark
  // standing between them. A test that counted source *positions* would call
  // that a two-position jump and write 一二点; the clause returned over is one
  // character, and a mark is not a character a reader comes back across.
  //
  // **The vehicle this claim used to ride on was 劉答言：無。** — 酒蟲 sent_id 6
  // with its quotation marks taken off — and that sentence no longer inverts
  // at all: a *clausal* complement reached only across a pause mark is now read
  // where it stands (see `depClassification.ts`'s
  // `isClausalComplementAcrossPause`), so there is no return to mark. Its own
  // test is below, beside the bracketed form it now agrees with. A **nominal**
  // object is untouched by that rule and carries the claim unchanged.
  const seeMonk: Sentence = {
    tokens: [
      { id: 0, text: "見", lemma: "見", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
      { id: 1, text: "：", lemma: "：", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      { id: 2, text: "僧", lemma: "僧", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
    ],
  };

  it("gives 見 a レ点 over 僧, two token positions away but one character", () => {
    const plan = computeReadingOrder(seeMonk);
    const group = plan.spliceGroups.find((g) => g.rankTokenIds.includes(0))!;
    expect(group.rankTokenIds).toEqual([2, 0]); // 僧 read first, then 見

    const marks = assignKundokuTen(plan);
    expect(group.isRe).toBe(true);
    expect(marks.get(0)).toEqual<KundokuMark>({ tier: "re" });
    expect(marks.has(2)).toBe(false); // レ点 marks only its source-earlier member
    expect(buildKundokuGlyphMap(plan).get(0)).toBe("㆑");
  });

  it("still traces to 僧 before 見 — a レ点 returns over the next character, not the next comma", () => {
    const plan = computeReadingOrder(seeMonk);
    assignKundokuTen(plan);
    expect(textOf(seeMonk, traceMarks(seeMonk, plan))).toBe("僧見");
  });

  // 劉答言：無。 — the reader's own 酒蟲 sent_id 6 with its quotation marks taken
  // off. 言(2) governs 無(4) as `comp:obj`, and the ：(3) between them is what
  // decides: a clause the reader reaches only across a pause mark is read in
  // place, so 無 stays where the editor put it, nothing returns and nothing is
  // marked. **That is the same answer the bracketed form below gives**, which
  // is the point worth pinning: the brackets are one edition's typography, and
  // whether they are printed or not cannot change which word is said first.
  const yan = realSentence(`# sent_id = 6
# text = 劉答言無
1\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t3\tsubj\t_\t_
2\t答\t答\tPROPN\tv,動詞,行為,伝達\tNameType=Giv\t1\tflat\t_\t_
3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
4\t：\t：\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
5\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t3\tcomp:obj\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_
`);

  it("marks nothing where a 、 stands between the verb and the clause it governs", () => {
    const plan = computeReadingOrder(yan, findCompoundSpans(yan));
    expect(textOf(yan, plan.order)).toBe("劉答言：無。");
    expect(plan.spliceGroups).toEqual([]);
    expect(assignKundokuTen(plan).size).toBe(0);
    expect(textOf(yan, traceMarks(yan, plan))).toBe("劉答言無");
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
