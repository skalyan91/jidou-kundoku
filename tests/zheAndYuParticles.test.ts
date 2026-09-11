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
import { extraEndingFor, findRoot, selectedForm } from "../src/kakikudashi/conjugationContext.ts";
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
    // **No は here, reversing what this test used to assert.** 不復挺者 is a
    // ROOT 者 with nothing after it, and the reader has ruled — overriding his
    // own committed anchor — that a 者 closing its clause is that clause's
    // *predicate*: it takes the copula なり, and a topic marker with no comment
    // after it is not a topic at all. `isSentenceFinalZhe` in
    // `conjugationContext.ts` holds the condition and the counts;
    // `zheParticleReading` withholds the は. Measured against kanbun.info:
    // **−4** (4 passages closer, 3 further, both regressions a mis-parse).
    //
    // No なり either, and that is a second rule and not this one: the tree
    // carries no punctuation, and an unpunctuated string asserts nothing
    // (`isPredicationLicensed`), so 不復挺者 is the bare noun phrase
    // 復た挺かぬ者. Punctuated — 不復挺者。 — it reads 復た挺かぬ者なり, which the
    // test below asserts.
    expect(zhe.okurigana ?? "").toBe("");
    // Not spelled out: 者 is a noun here ("the one who…") and stays in the
    // prose, where it was printing もの in kana in place of the character.
    expect(zhe.spellOutInProse).toBe(false);
    expect(prose(sentence)).toBe("復た挺かぬ者");
  });

  it("writes the same なり in the 訓読文 — both panels move together", () => {
    // The 訓読文 draws its okurigana from the very decisions the prose does, and
    // this asserts the three that carry the copula there: the reading brings no
    // は of its own, it no longer claims `endingComplete` (the flag on which
    // *both* panels skip `extraEndingFor` outright — the third of the three
    // gates that kept 者 from its copula), and `extraEndingFor` answers なり.
    // 者(なり), with nothing else beside the character.
    const sentence = sentenceOf(`${BU_FU_TING_ZHE}5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
`);
    const zhe = named(sentence, "者");
    const resolved = resolve(zhe, sentence);
    expect(resolved.okurigana ?? "").toBe("");
    expect(resolved.endingComplete ?? false).toBe(false);
    const extra = extraEndingFor(zhe, findRoot(sentence), sentence);
    expect(extra).not.toBeNull();
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict }));
    expect(selectedForm(extra!, plan, zhe.id).text).toBe("なり");
  });

  it("leaves a 者 followed by 也 exactly as it was — 也 already is the copula", () => {
    // The reader's own question about this change, and the answer is by
    // construction: 也 is never `punct` (over the corpus's parses it wears
    // `discourse@sp` 1,407 times, `subj` 105, `mod` 13 and a tail), so a 者 with
    // a 也 after it is never the last non-`punct` token and `isSentenceFinalZhe`
    // never sees it. It keeps its は, and the 也 keeps writing the なり — which
    // is the whole reason a second one must not be synthesized.
    const sentence = sentenceOf(`1\t賢\t賢\tADJ\tv,動詞,描写,態度\tDegree=Pos\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t0\troot\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
`);
    const zhe = named(sentence, "者");
    expect(resolve(zhe, sentence).okurigana).toBe(ZHE_NOMINALIZER_OKURIGANA);
    // And no *synthesized* copula on it: the outer guard `extraEndingFor`
    // already carried (`hasExplicitCopulaParticle`) stands the rule down over a
    // root that has its own 也, so the two never stack.
    expect(extraEndingFor(zhe, findRoot(sentence), sentence)).toBeNull();
    // The なり the prose writes here is the 也's own reading and not this
    // rule's. Whether 賢なる者**は**なり should lose that は in front of an
    // explicit 也 is a separate question about a separate construction, and
    // this change neither asks nor answers it — the line is asserted only to
    // record that it did not move.
    expect(prose(sentence)).toBe("賢なる者はなり");
  });

  it("gives a clause-closing 者 the copula once the sentence is punctuated", () => {
    // The same tree with the 。 the reader's own text has. Both panels move
    // together: the 訓読文 draws its okurigana from this same decision, so the
    // なり is written over the 者 there and the は is gone from both.
    const sentence = sentenceOf(`${BU_FU_TING_ZHE}5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
`);
    expect(prose(sentence)).toBe("復た挺かぬ者なり");
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
      // No は: this 者 too is a ROOT with nothing after it, and takes the
      // predicate reading rather than the topic marker — the same reversal as
      // the test above, on the reader's explicit instruction.
      expect(zhe.okurigana ?? "").toBe("");
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

  it("withholds the topic marker from a 者 in an argument slot — 閒者之言, 王者之迹", () => {
    // **The topic marker is bounded by its relation, and until this it was
    // bounded by nothing.** 王者之迹熄 came out 王**はの**迹: a topic marker in
    // a `comp:obj` slot, with the genitive の of 之 behind it, and one nominal
    // cannot wear both. What falls through is right and not merely less wrong
    // — the catch-all もの override keeps the character — so the reading is
    // 王者の迹, which is what kanbun.info prints.
    //
    // Over the recoded gold a PART 者 stands immediately in front of a
    // particle-writing 之/與/於 88 times and 33 of those wrote a stacked
    // particle; every one of the genitive-之 cases came through *this* branch
    // and every one of them stands on `comp:obj`. That is why the fix is the
    // relation and not a lookahead at what follows.
    // 何異閒者之言邪 — the gold's own tree, 者 on `comp:obj` of the genitive 之
    // and 之 on `mod` of the noun it builds the phrase over.
    const jianZhe = sentenceOf(`1\t何\t何\tADV\tv,副詞,疑問,原因\tAdvType=Cau\t2\tmod\t_\t_
2\t異\t異\tVERB\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
3\t閒\t間\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t4\tmod\t_\t_
4\t者\t者\tPART\tp,助詞,提示,*\t_\t5\tcomp:obj\t_\t_
5\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t6\tmod\t_\t_
6\t言\t言\tNOUN\tn,名詞,可搬,伝達\t_\t2\tcomp:obj\t_\t_
7\t邪\t邪\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
`);
    const zhe = resolve(named(jianZhe, "者"), jianZhe);
    expect(zhe.reading).toBe("もの");
    expect(zhe.okurigana ?? "").toBe("");
    expect(zhe.spellOutInProse).toBe(false);
    // The character kept and 之 supplying the phrase's one particle — 閒者の言.
    // Before this rule it was 閒**はの**言.
    expect(prose(jianZhe)).toContain("閒者の言");
  });

  it("keeps it on the same 者 + 與 in a subject slot — 帝者與師處", () => {
    // The other half of the same evidence, and what rules a lookahead out.
    // 冕者與瞽者 has its 者 on `comp:obj`/`conj:coord` and loses the は —
    // 冕者と瞽者とを見る, kanbun.info's own reading — while 帝者與師處 has it on
    // `subj` and keeps it. Both are 者 followed by a comitative 與, so a rule
    // keyed on the neighbour would have taken the は off both.
    const sentence = sentenceOf(`1\t帝\t帝\tNOUN\tn,名詞,人,役割\t_\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t5\tsubj\t_\t_
3\t與\t與\tADP\tp,助詞,行為,943\t_\t4\tcase\t_\t_
4\t師\t師\tNOUN\tn,名詞,人,役割\t_\t5\tcomp:obl\t_\t_
5\t處\t處\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    expect(resolve(named(sentence, "者"), sentence).reading).toBe(ZHE_TOPIC_READING);
  });

  it("withholds it from a fronted temporal 昔者 too, which the parse hangs on mod/udep", () => {
    // **The one class the bound moves that is not an argument slot, and it is
    // the one the reader may want back.** 昔者吾友、嘗從事於斯矣 is 昔者吾が友、
    // 嘗て斯に從事せり with the character kept, where it used to be 昔は吾が友.
    // 昔者 modifies the whole clause, so it lands on `mod` or `udep` rather than
    // on `subj`; of the 178 bare-noun 者 on those two relations in the recoded
    // gold, 152 are 昔 (96), 古 (32), 今 (12), 日 (7), 前 (2), 昨 (2) or 頃 (1).
    //
    // A variant admitting `mod` and `udep` alongside `isTopicSlot` was measured
    // in the same process as this rule and is **3 edits and 3 net passages
    // further** from kanbun.info, which is the whole reason it was not shipped
    // — see `zheParticleReading`. kanbun.info is not itself consistent on the
    // word (古者、言の出ださざるは against 古は民に三疾有り), and 昔者 is really
    // a word むかし with 者 suffixed to it: the answer it wants is a lexical
    // entry, not a relation.
    for (const dep of ["mod", "udep"]) {
      const sentence = sentenceOf(`1\t昔\t昔\tNOUN\tn,名詞,時,*\t_\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t5\t${dep}\t_\t_
3\t吾\t吾\tPRON\tn,代名詞,人称,起点\t_\t4\tdet\t_\t_
4\t友\t友\tNOUN\tn,名詞,人,関係\t_\t5\tsubj\t_\t_
5\t從事\t從事\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
      expect(resolve(named(sentence, "者"), sentence).reading).toBe("もの");
    }
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
    //
    // **Read off a 者 in a subject slot now, not off 不復挺者.** A 者 that ends
    // its sentence has lost the は altogether (the reader's reversal — see the
    // first test in this block), so it can no longer stand for the nominalizer
    // in a test about *where the は goes*. 知者勝 is the same nominalizer with a
    // predicate still to come, and keeps it.
    const topic = sentenceOf(HUANG_DI);
    const nominalizer = sentenceOf(`1\t知\t知\tVERB\tv,動詞,行為,動作\t_\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t3\tsubj\t_\t_
3\t勝\t勝\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    const a = resolve(named(topic, "者"), topic);
    const b = resolve(named(nominalizer, "者"), nominalizer);
    expect([a.reading, a.okurigana ?? ""]).toEqual([ZHE_TOPIC_READING, ""]);
    expect([b.reading, b.okurigana ?? ""]).toEqual([ZHE_NOMINALIZER_READING, ZHE_NOMINALIZER_OKURIGANA]);
  });

  // -------------------------------------------------------------------------
  // The two rulings above compose, and for an hour they did not.
  //
  // The copula work gave a clause-closing 者 なり and took its は away
  // (`isSentenceFinalZhe`, ROOT/`parataxis`/`conj:coord`); the topic-marker
  // work then gave *this* module's nominalizer arm the same `isTopicSlot` bound
  // its neighbours carry (`subj`/ROOT/`dislocated`, and rightly no
  // `parataxis`). Between them a 者 on `parataxis` was declined by the arm,
  // fell through to the catch-all もの override — `endingComplete`, like every
  // entry in that table — and both panels skipped `extraEndingFor` outright, so
  // the copula `isSentenceFinalZhe` had already licensed could not be written.
  // The arms now ask both questions.
  // -------------------------------------------------------------------------

  /** 論語 學而 15, 告諸往而知來者。 as the treebank's own joined segmentation has
   * it: 者 on `parataxis` under the 可 of the clause before, with a VERB `mod`
   * child and nothing but punctuation after it. This is the shape the app's
   * 論語 sample carries and the one the reader read the fault off. */
  const GAO_ZHU = `1\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
2\t告\t吿\tVERB\tv,動詞,行為,伝達\t_\t8\tmod\t_\t_
3\t諸\t諸\tPRON\tn,代名詞,人称,他\tPronType=Prs\t2\tcomp:obl\t_\t_
4\t往\t往\tVERB\tv,動詞,行為,移動\t_\t2\tcomp:obj\t_\t_
5\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t6\tcc\t_\t_
6\t知\t知\tVERB\tv,動詞,行為,動作\t_\t2\tconj:coord\t_\t_
7\t來\t來\tVERB\tv,動詞,行為,移動\tShared=No\t6\tcomp:obj\t_\t_
8\t者\t者\tPART\tp,助詞,提示,*\t_\t1\tparataxis\t_\t_
`;

  it("gives a clause-closing 者 on parataxis the copula — 論語 學而 15", () => {
    // The received reading is 来を知る者**なり**; the app wrote 來るを知る者 with
    // no ending at all. Not `isSentenceFinalZhe`'s fault — that returns true
    // here — and not `extraEndingFor`'s: it was never asked, because the
    // reading 者 fell through to claimed `endingComplete`.
    const sentence = sentenceOf(`${GAO_ZHU}9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t8\tpunct\t_\t_
`);
    const zhe = named(sentence, "者");
    const resolved = resolve(zhe, sentence);
    // The character kept, no は, and — the load-bearing one — no claim to
    // carry its own ending, which is what lets the panels ask for なり.
    expect(resolved.reading).toBe(ZHE_NOMINALIZER_READING);
    expect(resolved.okurigana ?? "").toBe("");
    expect(resolved.endingComplete ?? false).toBe(false);
    expect(resolved.spellOutInProse).toBe(false);
    // Both panels move together: the 訓読文 draws its okurigana from this same
    // ending, exactly as the ROOT case above asserts.
    const extra = extraEndingFor(zhe, findRoot(sentence), sentence);
    expect(extra).not.toBeNull();
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict }));
    expect(selectedForm(extra!, plan, zhe.id).text).toBe("なり");
    expect(prose(sentence)).toContain("來るを知る者なり");
  });

  it("does the same on conj:coord, the third of the clause-closing slots", () => {
    const sentence = sentenceOf(`1\t取\t取\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t習\t習\tVERB\tv,動詞,行為,動作\t_\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t1\tconj:coord\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_
`);
    expect(resolve(named(sentence, "者"), sentence).okurigana ?? "").toBe("");
    expect(prose(sentence)).toContain("習ふ者なり");
  });

  it("still writes no は on a parataxis 者 that does not close its clause", () => {
    // **The other ruling, which this must not undo.** `parataxis` is not a
    // topic slot and nothing here makes it one: what the arm now also answers
    // for is a 者 that is the sentence's *predicate*, and this one is not — a
    // predicate follows it. So it falls through to the catch-all もの with
    // neither は nor なり, exactly as it did before.
    const sentence = sentenceOf(`1\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
2\t知\t知\tVERB\tv,動詞,行為,動作\t_\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t1\tparataxis\t_\t_
4\t勝\t勝\tVERB\tv,動詞,行為,動作\t_\t3\tconj:coord\t_\t_
`);
    const resolved = resolve(named(sentence, "者"), sentence);
    expect(resolved.reading).toBe("もの");
    expect(resolved.okurigana ?? "").toBe("");
    expect(prose(sentence)).toBe("可し知る者勝つ");
  });

  it("writes no なり on the same tree unpunctuated — the two questions differ", () => {
    // は is withheld by the *clause* and なり by the *sentence*: an unpunctuated
    // string asserts nothing (`isPredicationLicensed`), so 告諸往而知來者 with no
    // 。 is the bare noun phrase it was for 不復挺者 above.
    const sentence = sentenceOf(GAO_ZHU);
    expect(resolve(named(sentence, "者"), sentence).okurigana ?? "").toBe("");
    expect(prose(sentence)).toContain("來るを知る者");
    expect(prose(sentence)).not.toContain("者なり");
  });

  it("leaves a 者 followed by 也 on parataxis exactly where it was", () => {
    // 也 is never `punct`, so `isSentenceFinalZhe` never sees such a 者 as
    // closing anything, and `parataxis` is not a topic slot: it falls through
    // to もの with no は of its own, and the 也 goes on writing the なり. The
    // ROOT/`subj` version of this — 賢者也。 — keeps its は and is asserted
    // higher up in this block; neither line moved.
    const sentence = sentenceOf(`1\t賢\t賢\tADJ\tv,動詞,描写,態度\tDegree=Pos\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t4\tparataxis\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
4\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
`);
    const resolved = resolve(named(sentence, "者"), sentence);
    expect(resolved.reading).toBe("もの");
    expect(resolved.okurigana ?? "").toBe("");
  });

  it("adds nothing on subj — 王者之迹 keeps the character and takes the genitive の", () => {
    // The reader's question, and the answer is that `subj` was never
    // `isSentenceFinalZhe`'s (a sentence-final 者 on `subj` is a fragment whose
    // predicate the parse has lost, which is why that set names ROOT,
    // `parataxis` and `conj:coord` and not `subj`). 王者之迹 itself stands on
    // `comp:obj` in every gold instance of the shape — 王者之道, 王者之兵 — so it
    // is neither a topic slot nor a clause-closing one, falls through to もの,
    // and 之 supplies the phrase's one particle: 王者の道.
    const sentence = sentenceOf(`1\t王\t王\tNOUN\tn,名詞,人,役割\t_\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t3\tcomp:obj\t_\t_
3\t之\t之\tPART\tp,助詞,接続,属格\t_\t4\tmod\t_\t_
4\t道\t道\tNOUN\tn,名詞,可搬,伝達\t_\t0\troot\t_\t_
`);
    expect(resolve(named(sentence, "者"), sentence).reading).toBe("もの");
    expect(prose(sentence)).toContain("王者の道");
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

  it("keeps the 連用形 in front of a 而して, where a ROOT nominal closes", () => {
    // 臣、而君明 reads 臣**なり**、而して君は明し: a mark before a 而 makes it
    // 而して, a word read *on* 而 rather than an ending, and the predicate in
    // front of it closes. Inside a 者 clause nothing can close — what closes is
    // the 連体形 好む that meets the particle — so the guard stands down and
    // both halves are written, exactly as the タリ chain writes 愕然として、而して
    // 笑ふ. See `isNominalisedClauseMember`.
    const withMark = prose(sentenceOf(XIAO_TI_ZHE("，")));
    expect(withMark).toContain("孝弟にして");
    expect(withMark).toContain("而して");
    expect(withMark).not.toContain("孝弟なり");
  });
});
