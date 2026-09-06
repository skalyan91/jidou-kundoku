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
import { parseConllu } from "../src/parse/conlluParser.ts";
import { COPULA, EXISTENCE, sentenceFinalParticle, SENTENCE_FINAL_WORD_LEMMAS } from "../src/kakikudashi/bungoConjugation.ts";
import { ZHE_NOMINALIZER_OKURIGANA, ZHE_NOMINALIZER_READING, ZHE_TOPIC_READING } from "../src/reading/classicalEnding.ts";

// ---------------------------------------------------------------------------
// Three readings the reader asked for, all of them about a particle the app
// was writing nothing (or the wrong thing) on:
//
//  - 與, whose interrogative use rendered blank and whose ADP use rendered a
//    modern KANJIDIC2 kun;
//  - 者, which was printing もの *in place of* the character where kundoku
//    keeps the character and writes only は beside it;
//  - なり, the synthesized copula, which stood at its 終止形 wherever the
//    sentence attached something onto it.
//
// Counts throughout are over the recoded gold the shipped parser 0.3.2 trains
// on: lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.
// rulemerged.adjfix.conllu.
//
// Trees are written out rather than parsed live, as the neighbouring test
// files do: the shape is what is under test, and the live parser does not
// always return it.
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

function named(sentence: Sentence, text: string) {
  const token = sentence.tokens.find((t) => t.text === text);
  if (!token) throw new Error(`no ${text} in the sentence`);
  return token;
}

// ---------------------------------------------------------------------------
// 1. 與 — the interrogative particle, and the comitative/coordinating ADP.
// ---------------------------------------------------------------------------

describe("與", () => {
  /** 「從我者，其由與」？ (Analects V) — 與 closing a question. 189 of the gold's
   * 與 stand this way, PART/`discourse@sp`. */
  const CONG_WO_ZHE = `1\t從\t從\tVERB\tv,動詞,行為,動作\t_\t3\tmod\t_\t_
2\t我\t我\tPRON\tn,代名詞,人称,止格\t_\t1\tcomp:obj\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t6\tsubj\t_\t_
4\t，\t，\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
5\t其\t其\tPART\tp,助詞,句頭,*\t_\t6\tdiscourse\t_\t_
6\t由\t由\tPROPN\tn,名詞,人,名\t_\t0\troot\t_\t_
7\t與\t與\tPART\tp,助詞,句末,*\t_\t6\tdiscourse@sp\t_\t_
`;

  /** 子罕言利與命 (Analects IX) — the coordinating 與 between two objects. The
   * parser tags it ADP `v,前置詞,関係,*`: 1,406 of the gold's 與 are ADP and
   * **none at all** is CCONJ, which is why the CCONJ-only override entry never
   * fired and the character fell through to KANJIDIC2's modern あた.える. */
  const LI_YU_MING = `1\t子\t子\tNOUN\tn,名詞,人,人\t_\t3\tsubj\t_\t_
2\t罕\t罕\tADV\tv,動詞,描写,量\t_\t3\tmod\t_\t_
3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
4\t利\t利\tNOUN\tn,名詞,描写,形質\t_\t3\tcomp:obj\t_\t_
5\t與\t與\tADP\tv,前置詞,関係,*\t_\t6\tcc\t_\t_
6\t命\t命\tNOUN\tn,名詞,不可譲,身体\t_\t4\tconj:coord\t_\t_
`;

  it("reads a sentence-final 與 as や, and puts it on the page", () => {
    // The failure this fixes is the one 歟's own note records: both panels take
    // the discourse branch before the resolver is consulted, so a lemma
    // `SENTENCE_FINAL_PARTICLES` does not know renders as *nothing at all*.
    // 「從我者，其由與」？ came out with the 與 simply absent.
    expect(sentenceFinalParticle("與")).toBe("や");
    expect(sentenceFinalParticle("与")).toBe("や");
    expect(prose(sentenceOf(CONG_WO_ZHE))).toContain("や");
  });

  it("gives it furigana rather than okurigana, like every other particle in the table", () => {
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("與")).toBe(true);
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("与")).toBe(true);
  });

  it("keeps the override table in step with that reading rather than on か", () => {
    // The entry is only reachable for a 與 tagged something other than
    // discourse/discourse@sp, exactly as 歟's is — and the two tables must not
    // give one character two readings.
    const yu = sentenceOf(CONG_WO_ZHE);
    expect(resolve(named(yu, "與"), yu).reading).toBe("や");
  });

  it("reads a coordinating/comitative 與 as と, on the ADP tag the parser gives it", () => {
    const sentence = sentenceOf(LI_YU_MING);
    const yu = resolve(named(sentence, "與"), sentence);
    expect(yu.reading).toBe("と");
    expect(yu.okurigana ?? "").toBe("");
    expect(prose(sentence)).toContain("利と命");
  });

  it("still reads a hand-corrected CCONJ 與 as と, and a VERB 與 as あたふ", () => {
    // CCONJ costs nothing (0 gold tokens) and is kept so a corrected tree still
    // answers; the verb 與ふ is a different word and keeps its own entry.
    const cconj = sentenceOf(`1\t利\t利\tNOUN\tn,名詞,描写,形質\t_\t0\troot\t_\t_
2\t與\t與\tCCONJ\tp,助詞,接続,並列\t_\t3\tcc\t_\t_
3\t命\t命\tNOUN\tn,名詞,不可譲,身体\t_\t1\tconj:coord\t_\t_
`);
    expect(resolve(named(cconj, "與"), cconj).reading).toBe("と");

    const verb = sentenceOf(`1\t與\t與\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,止格\t_\t1\tcomp:obj\t_\t_
`);
    const gave = resolve(named(verb, "與"), verb);
    expect(gave.reading).toBe("あた");
    expect(gave.okurigana).toBe("ふ");
  });
});

// ---------------------------------------------------------------------------
// 2. 矣 — the one particle in the table that is deliberately unread.
// ---------------------------------------------------------------------------

describe("矣", () => {
  /** 無過矣 (荀子・勸學) — the reader's own line. */
  const WU_GUO_YI = `1\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t0\troot\t_\t_
2\t過\t過\tVERB\tv,動詞,描写,態度\tDegree=Pos\t1\tcomp:obj\t_\t_
3\t矣\t矣\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`;

  it("is rendered as nothing, which is the 置き字 convention and not a gap", () => {
    // 1,850 of 矣's 1,852 gold tokens stand PART/discourse@sp, so this is what
    // effectively every occurrence does. See the entry's own note in
    // `bungoConjugation.ts` for why, and for what a reading would have to be.
    expect(sentenceFinalParticle("矣")).toBe("");
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("矣")).toBe(false);
    expect(prose(sentenceOf(WU_GUO_YI))).toBe("過ち無し");
  });
});

// ---------------------------------------------------------------------------
// 3. 者 — the nominalizer keeps its kanji and takes は as okurigana.
// ---------------------------------------------------------------------------

describe("者", () => {
  /** 不復挺者 (荀子・勸學) — the reader's own line, and the commonest shape the
   * character has: 2,744 VERB + 610 ADJ + 260 AUX `mod` modifiers in the gold,
   * against 770 NOUN + 106 PROPN for the topic use below. */
  const BU_FU_TING_ZHE = `1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
2\t復\t復\tADV\tv,副詞,頻度,重複\t_\t3\tmod\t_\t_
3\t挺\t挺\tVERB\tv,動詞,行為,動作\t_\t4\tmod\t_\t_
4\t者\t者\tPART\tp,助詞,提示,*\t_\t0\troot\t_\t_
`;

  /** 黃帝者、少典之子也 — the topic marker after a name, unchanged. */
  const HUANG_DI = `1\t黃帝\t黃帝\tPROPN\tn,名詞,人,名\t_\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t5\tsubj\t_\t_
3\t少典\t少典\tPROPN\tn,名詞,人,名\t_\t5\tmod\t_\t_
4\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t3\tcase\t_\t_
5\t子\t子\tNOUN\tn,名詞,人,人\t_\t0\troot\t_\t_
`;

  it("writes only は beside a 者 with a dependent predicate, keeping the character", () => {
    const sentence = sentenceOf(BU_FU_TING_ZHE);
    const zhe = resolve(named(sentence, "者"), sentence);
    expect(zhe.reading).toBe(ZHE_NOMINALIZER_READING);
    expect(zhe.okurigana).toBe(ZHE_NOMINALIZER_OKURIGANA);
    // Not spelled out: 者 is a noun here ("the one who…") and stays in the
    // prose, where it was printing もの in kana in place of the character.
    expect(zhe.spellOutInProse).toBe(false);
    expect(prose(sentence)).toBe("復挺かぬ者は");
  });

  it("does the same for an adjective and for an auxiliary modifier", () => {
    for (const [pos, xpos] of [
      ["ADJ", "v,動詞,描写,態度"],
      ["AUX", "v,助動詞,可能,*"],
    ]) {
      const sentence = sentenceOf(`1\t賢\t賢\t${pos}\t${xpos}\tDegree=Pos\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t0\troot\t_\t_
`);
      const zhe = resolve(named(sentence, "者"), sentence);
      expect(zhe.reading).toBe(ZHE_NOMINALIZER_READING);
      expect(zhe.okurigana).toBe(ZHE_NOMINALIZER_OKURIGANA);
    }
  });

  it("does not write は on a nominalizing 者 standing as an object", () => {
    // 見知者 is 知る者を見る, not 知る者は見る: は marks a topic, and 928 of the
    // gold's 3,562 predicate-modified 者 stand on comp:obj. Those are left on
    // the もの entry — `caseParticleFor` declines a PART, so this branch could
    // give the character back but not the を that must follow it.
    const sentence = sentenceOf(`1\t見\t見\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t知\t知\tVERB\tv,動詞,行為,動作\t_\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t1\tcomp:obj\t_\t_
`);
    const zhe = resolve(named(sentence, "者"), sentence);
    expect(zhe.reading).toBe("もの");
    expect(zhe.okurigana ?? "").toBe("");
  });

  it("writes it on a 者 standing as a subject — 知者勝 is 知る者は勝つ", () => {
    const sentence = sentenceOf(`1\t知\t知\tVERB\tv,動詞,行為,動作\t_\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t3\tsubj\t_\t_
3\t勝\t勝\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    expect(resolve(named(sentence, "者"), sentence).okurigana).toBe(ZHE_NOMINALIZER_OKURIGANA);
    expect(prose(sentence)).toContain("者は");
  });

  it("leaves the topic marker after a noun or name reading は in place of the character", () => {
    // 黃帝者 is 黃帝は — 者 is a particle there and nothing else, so it is
    // spelled out in kana like every other particle the prose writes.
    const sentence = sentenceOf(HUANG_DI);
    const zhe = resolve(named(sentence, "者"), sentence);
    expect(zhe.reading).toBe(ZHE_TOPIC_READING);
    expect(zhe.okurigana ?? "").toBe("");
    expect(zhe.spellOutInProse).toBe(true);
    expect(prose(sentence)).toContain("黃帝は");
  });

  it("leaves a bare 者 with no modifier at all on もの", () => {
    // 12 of the gold's 4,786 提示 者 have no non-punct dependent — the
    // stand-alone pronoun-like "someone", which is neither of the two uses.
    const sentence = sentenceOf(`1\t者\t者\tPART\tp,助詞,提示,*\t_\t0\troot\t_\t_
`);
    expect(resolve(named(sentence, "者"), sentence).reading).toBe("もの");
  });

  it("nominalizes a chain whose *head* is a noun and whose later link is not", () => {
    // 孝弟而好犯上者 — 孝弟 hangs off 者 by `mod` and 好 is coordinated onto
    // that, so the link carrying the relation is a noun and the predicate is
    // one edge further out. Read off the modifier alone this was a topic
    // marker, and wrote a bare は with the character gone: 上を犯すを好みて**は**
    // where the word is ものは.
    //
    // Rare and uniform: over the recoded gold a nominal modifier of 者 heads a
    // chain with a predicate link **7** times against 833 that head no chain,
    // and all 7 are nominalizers — 惡勇而無禮者, 死三日而后斂者, 十人而從一人者.
    const sentence = sentenceOf(`1\t孝\t孝\tNOUN\tv,動詞,行為,態度\t_\t5\tmod\t_\t_
2\t弟\t弟\tNOUN\tv,動詞,行為,態度\t_\t1\tcompound\t_\t_
3\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_
4\t好\t好\tVERB\tv,動詞,行為,態度\t_\t1\tconj:coord\t_\t_
5\t者\t者\tPART\tp,助詞,提示,*\t_\t6\tsubj\t_\t_
6\t鮮\t鮮\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
`);
    const zhe = resolve(named(sentence, "者"), sentence);
    expect(zhe.reading).toBe(ZHE_NOMINALIZER_READING);
    expect(zhe.okurigana).toBe(ZHE_NOMINALIZER_OKURIGANA);
  });

  it("leaves a noun that heads no chain on the topic marker", () => {
    // The 833, and what 黃帝者 needs: 黃帝は, は in the reading slot and the
    // character spelled out.
    const sentence = sentenceOf(HUANG_DI);
    expect(resolve(named(sentence, "者"), sentence).reading).toBe(ZHE_TOPIC_READING);
  });

  it("keeps the two uses tellable apart by which slot the は lands in", () => {
    // What `isNominalizerAhead` in conjugationContext.ts needs: the topic
    // marker fills `reading` with the は and leaves `okurigana` unset, while the
    // nominalizer puts もの in `reading` and the は in `okurigana`.
    //
    // The nominalizer's `reading` was empty when this was written, and the
    // reader corrected it: もの is what the 訓読文 draws over 者, and leaving the
    // slot empty wrote the は beside a character with nothing above it. The two
    // uses stay tellable apart, which is all this test is for — one puts は in
    // `reading`, the other in `okurigana`.
    const topic = sentenceOf(HUANG_DI);
    const nominalizer = sentenceOf(BU_FU_TING_ZHE);
    const a = resolve(named(topic, "者"), topic);
    const b = resolve(named(nominalizer, "者"), nominalizer);
    expect([a.reading, a.okurigana ?? ""]).toEqual([ZHE_TOPIC_READING, ""]);
    expect([b.reading, b.okurigana ?? ""]).toEqual([ZHE_NOMINALIZER_READING, ZHE_NOMINALIZER_OKURIGANA]);
  });
});

// ---------------------------------------------------------------------------
// 4. なり — the copula conjugates.
// ---------------------------------------------------------------------------

describe("the synthesized copula's paradigm", () => {
  it("states all of ナリ活用, 連体形 and 已然形 included", () => {
    // なら / に(して) / なり / なる / なれ — the same six
    // `classicalConjugation.ts` writes out under `nari-keiyoudoushi`. The last
    // two were missing, which is why a copula something attached onto printed
    // its 終止形 regardless: 君子なりのみ for 君子なるのみ, 是れ知なりや for
    // 是れ知なるや.
    expect(COPULA.mizen).toBe("なら");
    expect(COPULA.primary).toBe("なり");
    expect(COPULA.rentai).toBe("なる");
    expect(COPULA.izen).toBe("なれ");
  });

  it("states the same two for the existential ending, ラ変 throughout", () => {
    // あら / あり / あり / ある / あれ. Both endings carry them because the
    // selector that will ask for a 連体形 is handed whichever of the two the
    // sentence called for.
    expect(EXISTENCE.mizen).toBe("あら");
    expect(EXISTENCE.primary).toBe("あり");
    expect(EXISTENCE.rentai).toBe("ある");
    expect(EXISTENCE.izen).toBe("あれ");
  });
});

// ---------------------------------------------------------------------------
// 4. The first conjunct of a clause a 者 nominalises.
//
// 論語 學而 sent_id 3 — 其為人也孝弟而好犯上者鮮矣, as the reader annotates it:
// 孝 is the `mod` of 者 with 弟 `compound` onto it and 好 `conj:coord` onto the
// pair, so a noun compound heads a two-link chain whose later link is a
// predicate. The reader's rule for that shape — *if a noun compound is
// conjoined with a predicate, then it must be a predicate as well, and should
// take the 連用形 of なり* — reached it through neither of the two arms
// `isCoordinateClauseHead` had: it is not the ROOT, and its own relation is
// `mod` rather than a coordination one.
// ---------------------------------------------------------------------------

describe("a coordination chain standing as a 者 clause", () => {
  /** 孝弟而好犯上者鮮矣, with 孝弟 as the reader labels it. */
  const XIAO_TI_ZHE = (mark: string) => `1\t孝\t孝\tNOUN\tv,動詞,行為,態度\t_\t8\tmod\t_\t_
2\t弟\t弟\tNOUN\tv,動詞,行為,態度\t_\t1\tcompound\t_\t_
3\t${mark}\t${mark}\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
4\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t5\tcc\t_\t_
5\t好\t好\tVERB\tv,動詞,行為,態度\tVerbForm=Conv\t1\tconj:coord\t_\t_
6\t犯\t犯\tVERB\tv,動詞,行為,態度\t_\t5\tcomp:obj\t_\t_
7\t上\t上\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t6\tcomp:obj\t_\t_
8\t者\t者\tPART\tp,助詞,提示,*\t_\t9\tsubj\t_\t_
9\t鮮\t鮮\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
`;

  it("gives the compound the copula, and its 連用形 — 孝弟にして", () => {
    // It got no ending at all: `mod` is in neither `NOMINAL_COORDINATION_DEPS`
    // nor `COORDINATION_DEPS`, so the walk to the root refused it on its first
    // step and `extraEndingFor` synthesised nothing. The `mod` of a particle is
    // a clause position for the same reason the ROOT is one — see
    // `PARTICLE_HEAD_POS`.
    expect(prose(sentenceOf(XIAO_TI_ZHE("，")))).toContain("孝弟にして");
  });

  it("keeps the 連用形 in front of a しかも, where a ROOT nominal closes", () => {
    // 臣、而君明 reads 臣**なり**、しかも君は明し: a mark before a 而 makes it
    // しかも, a word read *on* 而 rather than an ending, and the predicate in
    // front of it closes. Inside a 者 clause nothing can close — what closes is
    // the 連体形 好む that meets the particle — so the guard stands down and
    // both halves are written, exactly as the タリ chain writes 愕然として、しかも
    // 笑ふ. See `isNominalisedClauseMember`.
    const withMark = prose(sentenceOf(XIAO_TI_ZHE("，")));
    expect(withMark).toContain("孝弟にして");
    expect(withMark).toContain("しかも");
    expect(withMark).not.toContain("孝弟なり");
  });
});
