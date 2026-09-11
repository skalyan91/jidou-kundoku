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
import { isConditionalTemporalClause, isNonFinalCoordinand, negationEnding } from "../src/kakikudashi/conjugationContext.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

// ---------------------------------------------------------------------------
// A protasis built out of coordinated verbs takes its 已然形 + ば on the **last**
// link only; every earlier link keeps the 連用中止法 a coordination chain gives
// it. 學而不思則罔 is 學びて思はざれば則ち罔し — not 學びて思はず則ち…, which is
// what a rule keyed on the token bearing the `mod` relation could produce,
// since that token is the one the protasis *begins* on.
//
// Every tree here is written out rather than parsed live: the shape is the gold
// treebank's (the clause head carries the relation, later conjuncts hang off it
// by `conj:coord`), and the live parser does not always return it.
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

/** 學而不思則罔 — the gold arcs: 學 carries the `mod` onto 罔, 思 is 學's
 * `conj:coord`, 不 negates 思, and 則 marks the apodosis. */
const XUE_ER_BU_SI = `1\t學\t學\tVERB\tv,動詞,行為,動作\t_\t6\tmod\t_\t_
2\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_
3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
4\t思\t思\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
5\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t6\tmod\t_\t_
6\t罔\t罔\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
`;

/** The same shape with no negation anywhere, so the ば lands on the verb's own
 * 已然形 rather than on a ざれ. */
const SHI_ROU_YIN_JIU_ZE_LE = `1\t食\t食\tVERB\tv,動詞,行為,動作\t_\t6\tmod\t_\t_
2\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t1\tcomp:obj\t_\t_
3\t飲\t飲\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
4\t酒\t酒\tNOUN\tn,名詞,可搬,糧食\t_\t3\tcomp:obj\t_\t_
5\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t6\tmod\t_\t_
6\t樂\t樂\tVERB\tv,動詞,行為,態度\t_\t0\troot\t_\t_
`;

describe("a coordinated protasis writes its ば on the last link", () => {
  it("學而不思則罔 -> 學びて思はざれば則ち罔し", () => {
    // 思 owes the postposed ず a 未然形 (思は), and it is the ず that has to be
    // 已然形 in front of the ば — 思はざれば, written by `negationEnding`.
    //
    // **罔し, not 罔る, since 罔 was given its ク活用 な.** The apodosis is not
    // what this test is about and it was reading 罔る all along — the 四段ラ行
    // ending a bare る states, off a character `verbLexicon.ts` held no entry
    // for — which is why the block comment above already says 罔し. It says it
    // now: the received text writes 罔く on this very sentence (論語 2.15, where
    // a second clause follows and the 連用形 is what that wants), so the entry
    // aligns and this apodosis, standing alone, closes on the 終止形.
    const sentence = sentenceOf(XUE_ER_BU_SI);
    expect(prose(sentence)).toBe("學びて思はざれば則ち罔し");
  });

  it("the ば is on 思 and the 連用形 on 學, and neither takes the other's", () => {
    const sentence = sentenceOf(XUE_ER_BU_SI);
    const xue = tokenNamed(sentence, "學");
    const si = tokenNamed(sentence, "思");
    expect(isConditionalTemporalClause(si, sentence)).toBe(true);
    expect(isConditionalTemporalClause(xue, sentence)).toBe(false);
    // The chain rule still sees the same chain, and still demotes only the
    // earlier link. A token cannot take both a 連用形 and a ば because these two
    // answers are exact complements over the chain's members.
    expect(isNonFinalCoordinand(xue, sentence)).toBe(true);
    expect(isNonFinalCoordinand(si, sentence)).toBe(false);
  });

  it("the negation carries the ば, on the ざり-paradigm 已然形", () => {
    const sentence = sentenceOf(XUE_ER_BU_SI);
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(negationEnding(tokenNamed(sentence, "不"), plan)).toBe("ざれば");
  });

  it("思而不學則殆 -> 思ひて學ばざれば則ち殆ふし", () => {
    // The couplet's other half, arcs verbatim from `lzh-train.sud.conllu`.
    const sentence = sentenceOf(`1\t思\t思\tVERB\tv,動詞,行為,動作\t_\t6\tmod\t_\t_
2\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_
3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
4\t學\t學\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
5\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t6\tmod\t_\t_
6\t殆\t殆\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
`);
    // **殆ふし and not 殆ど**, which is 為政 15's received reading — 學びて思はざれば
    // 則ち罔く、思ひて學ばざれば則ち殆ふし. The character was reading KANJIDIC2's
    // leading kun ほとん.ど, the modern adverb "almost", where kanbun reads the
    // ク活用 adjective 危ふし written with this graph; kanbun.info glosses 殆
    // あや in **13** of the 13 places it glosses it at all. See 殆's entry in
    // `verbLexicon.ts`. Nothing about the ば or the chain moves — this line is
    // the same clause with its last word read as the word it is.
    expect(prose(sentence)).toBe("思ひて學ばざれば則ち殆ふし");
  });

  it("an unnegated chain takes the ば on the verb's own 已然形", () => {
    // 肉を食ひ酒を飲めば則ち樂し — 食 keeps its 連用中止法 and 飲 alone
    // conditions the apodosis.
    expect(prose(sentenceOf(SHI_ROU_YIN_JIU_ZE_LE))).toBe("肉を食ひ酒を飲めば則ち樂し");
  });
});

describe("what the chain rule must not reach", () => {
  it("學而時習之 — a chain with no 則 keeps its plain 連用形 and gains no ば", () => {
    const sentence = sentenceOf(`1\t學\t學\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_
3\t時\t時\tNOUN\tn,名詞,時,*\t_\t4\tmod@tmod\t_\t_
4\t習\t習\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
5\t之\t之\tPRON\tn,代名詞,人称,止格\t_\t4\tcomp:obj\t_\t_
`);
    expect(sentence.tokens.every((t) => !isConditionalTemporalClause(t, sentence))).toBe(true);
    expect(prose(sentence)).toBe("學びて時に之を習ふ");
  });

  it("邦有道則知 — a single-predicate protasis is untouched", () => {
    const sentence = sentenceOf(`1\t邦\t邦\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t2\tsubj\t_\t_
2\t有\t有\tVERB\tv,動詞,存在,存在\t_\t5\tmod\t_\t_
3\t道\t道\tNOUN\tn,名詞,可搬,伝達\t_\t2\tcomp:obj\t_\t_
4\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t5\tmod\t_\t_
5\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).toBe("邦に道有れば則ち知る");
  });

  it("言不聞則不入 — a negated single-predicate protasis is untouched", () => {
    const sentence = sentenceOf(`1\t言\t言\tNOUN\tn,名詞,可搬,伝達\t_\t3\tsubj\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t聞\t聞\tVERB\tv,動詞,行為,知覚\t_\t6\tmod\t_\t_
4\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t6\tmod\t_\t_
5\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t6\tmod\t_\t_
6\t入\t入\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).toBe("言聞こえざれば則ち入らず");
  });

  it("食肉飲酒歌舞 — a bare chain with no connective at all takes no ば", () => {
    const sentence = sentenceOf(`1\t食\t食\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t1\tcomp:obj\t_\t_
3\t飲\t飲\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
4\t酒\t酒\tNOUN\tn,名詞,可搬,糧食\t_\t3\tcomp:obj\t_\t_
5\t歌\t歌\tVERB\tv,動詞,行為,動作\t_\t3\tconj:coord\t_\t_
6\t舞\t舞\tVERB\tv,動詞,行為,動作\t_\t5\tconj:coord\t_\t_
`);
    expect(sentence.tokens.every((t) => !isConditionalTemporalClause(t, sentence))).toBe(true);
    expect(prose(sentence)).toBe("肉を食ひ酒を飲み歌ひ舞ふ");
  });

  it("the connective must follow the whole protasis, not merely its first link", () => {
    // 則 written *between* the two conjuncts is not marking an apodosis that
    // follows this clause, so nothing here is a protasis. The id test is made
    // against the link the ば would land on, which is the end of the clause.
    const sentence = sentenceOf(`1\t學\t學\tVERB\tv,動詞,行為,動作\t_\t2\tmod\t_\t_
2\t罔\t罔\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t2\tmod\t_\t_
4\t思\t思\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
`);
    expect(sentence.tokens.every((t) => !isConditionalTemporalClause(t, sentence))).toBe(true);
  });
});
