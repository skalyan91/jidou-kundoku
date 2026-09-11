import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sentence } from "../src/parse/types.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { decideConjForm, isConditionalTemporalClause } from "../src/kakikudashi/conjugationContext.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

// ---------------------------------------------------------------------------
// Two decisions about which form a construction imposes, both of them about a
// predicate the app was reading off the wrong evidence.
//
//  1. **A protasis this treebank tags ADV.** 學則不固 arrives with 學 as ADV
//     carrying `VerbForm=Conv`, which is the parser saying the word stands
//     preverbally in the 白文 — true, and silent about the reading. The 則 is
//     what says the clause is a protasis, and the received text reads 學べば
//     則ち固ならず where this app wrote 學びて. See `isConverbTaggedPredicate`.
//
//  2. **The non-final conjunct of a caused predicate.** 使驕且吝 is 驕り且つ吝
//     ならしめ: only the conjunct the しむ is written onto owes it a 未然形, and
//     the one before it hands on by 連用中止法. See `causedConjunctHandsOn`.
//
// Every tree is written out rather than parsed live, so the shape asserted is
// the gold treebank's own.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

function sentenceOf(rows: string): Sentence {
  const tree = parseConllu(rows);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

function prose(sentence: Sentence): string {
  return generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), resolve);
}

function tokenNamed(sentence: Sentence, text: string) {
  const token = sentence.tokens.find((t) => t.text === text);
  if (!token) throw new Error(`no ${text} in the sentence`);
  return token;
}

// ---------------------------------------------------------------------------
// 1. 學則不固 — the protasis the ADV tag was hiding.
// ---------------------------------------------------------------------------

/** 學則不固 (論語・學而 8), the gold arcs: 學 is ADV with `VerbForm=Conv` on
 * `mod`, 則 hangs off the apodosis 固, and 不 negates it. */
const XUE_ZE_BU_GU = `1\t學\t學\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t4\tmod\t_\t_
2\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t4\tmod\t_\t_
3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
4\t固\t固\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`;

/** The same shape on a 描写 stative, which `isAdverbialDescriptiveUse` used to
 * refuse a second time over: 過則勿憚改 (the same chapter). */
const GUO_ZE = `1\t過\t過\tADV\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Conv\t4\tmod\t_\t_
2\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t4\tmod\t_\t_
3\t勿\t勿\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t4\tmod\t_\t_
4\t憚\t憚\tVERB\tv,動詞,行為,態度\t_\t0\troot\t_\t_
`;

/** A converb with no connective anywhere — 學而思, where 學 hands on and must
 * keep its て. */
const XUE_SI = `1\t學\t學\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t2\tmod\t_\t_
2\t思\t思\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`;

describe("a protasis the treebank tags ADV with VerbForm=Conv", () => {
  it("reads 已然形 + ば under a 則, not the 連用形 + て its feature asks for", () => {
    const sentence = sentenceOf(XUE_ZE_BU_GU);
    const xue = tokenNamed(sentence, "學");
    expect(isConditionalTemporalClause(xue, sentence)).toBe(true);
    expect(decideConjForm(xue, tokenNamed(sentence, "則"), sentence)).toBe("izen");
    expect(prose(sentence)).toContain("學べば");
    expect(prose(sentence)).not.toContain("學びて");
  });

  it("claims a 描写 stative in the same slot — the tag is what put it in ADV", () => {
    const sentence = sentenceOf(GUO_ZE);
    expect(isConditionalTemporalClause(tokenNamed(sentence, "過"), sentence)).toBe(true);
  });

  it("leaves a converb with no connective alone, which is what the feature is for", () => {
    const sentence = sentenceOf(XUE_SI);
    expect(isConditionalTemporalClause(tokenNamed(sentence, "學"), sentence)).toBe(false);
    expect(prose(sentence)).toContain("て");
  });
});

// ---------------------------------------------------------------------------
// 2. 使驕且吝 — the 未然形 belongs to the conjunct the しむ lands on.
// ---------------------------------------------------------------------------

/** 使驕且吝 (論語・泰伯 11), the gold arcs: 驕 is 使's `comp:obj` and 吝 is
 * coordinated onto 驕, so 吝 is what is read last before the しむ. */
const SHI_JIAO_QIE_LIN = `1\t使\t使\tVERB\tv,動詞,行為,使役\t_\t0\troot\t_\t_
2\t驕\t驕\tVERB\tv,動詞,行為,態度\t_\t1\tcomp:obj\t_\t_
3\t且\t且\tADV\tv,副詞,頻度,重複\t_\t4\tcc\t_\t_
4\t吝\t吝\tVERB\tv,動詞,行為,態度\t_\t2\tconj:coord\t_\t_
`;

/** One caused predicate and no conjunct, where the edge and the attachment are
 * the same token and the 未然形 is owed: 使民戰 is 民をして戰はしむ. */
const SHI_MIN_ZHAN = `1\t使\t使\tVERB\tv,動詞,行為,使役\t_\t0\troot\t_\t_
2\t民\t民\tNOUN\tn,名詞,人,人\t_\t1\tcomp:obl\t_\t_
3\t戰\t戰\tVERB\tv,動詞,行為,交流\t_\t1\tcomp:obj\t_\t_
`;

describe("a caused predicate that is a non-final conjunct", () => {
  it("hands on by 連用中止法 and leaves the 未然形 to the conjunct the しむ lands on", () => {
    const sentence = sentenceOf(SHI_JIAO_QIE_LIN);
    const order = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(decideConjForm(tokenNamed(sentence, "驕"), tokenNamed(sentence, "且"), sentence)).toBe("renyou");
    expect(generateKakikudashi(order, resolve)).toContain("驕り");
  });

  it("keeps the 未然形 where the caused predicate is itself what the しむ attaches to", () => {
    const sentence = sentenceOf(SHI_MIN_ZHAN);
    expect(decideConjForm(tokenNamed(sentence, "戰"), tokenNamed(sentence, "使"), sentence)).toBe("mizen");
  });
});
