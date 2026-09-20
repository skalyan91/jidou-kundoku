import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { caseParticleFor, coordinationClosingParticle } from "../src/kakikudashi/conjugationContext.ts";

/** **A case particle marking a clause is written after the whole coordination,
 * not after the conjunct that carries the relation** — `closesArgumentChain`.
 *
 * The nominal side of the app has always done this: 縶手足 is 手足を縶ぐ, one を
 * after the pair, never 手を足縶ぐ. A *predicate* standing in an argument slot
 * was not: 介者不拜，為其拜而蓌拜 printed 其の拜む**が**て蓌拜する, with the が
 * inside the very phrase it closes and the て of the chain following it.
 *
 * The same exposure ran through all four of the rules that pair a 連体形 with a
 * particle — `isNominalizedObjectPredicate` (を), `isNominalizedSubjectPredicate`
 * (こと), `isNominalizedObliquePredicate` (に) and `isPurposiveWeiComplement` (が)
 * — in two shapes: を and が were written in the wrong place, while こと and に
 * ask `readsLastInItsSubtree`, which a following conjunct always fails, so those
 * two were not written **at all**. Over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * that is 694 + 7 misplaced and 303 + 4 missing.
 *
 * Every sentence below is a gold tree, quoted as gold has it. */
describe("a case particle on a coordinated predicate closes the whole chain", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);
  const only = (rows: string[]): Sentence => {
    const tree = parseConllu(rows.join("\n") + "\n\n");
    expect(tree.sentences).toHaveLength(1);
    return tree.sentences[0];
  };
  const at = (s: Sentence, text: string, nth = 0): Sentence["tokens"][number] =>
    s.tokens.filter((t) => t.text === text)[nth];

  /** 介者不拜，為其拜而蓌拜 — the reader's own example, and the sentence the
   * whole round is named for. 拜 is the prepositional 為's `comp:obj` and 蓌 is
   * `conj:coord` onto it, so the clause the が closes ends on 蓌拜. */
  const jieZhe = only([
    "1\t介\t介\tNOUN\tn,名詞,可搬,道具\t_\t2\tmod\t_\t_",
    "2\t者\t者\tPART\tp,助詞,提示,*\t_\t4\tsubj\t_\t_",
    "3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_",
    "4\t拜\t拜\tVERB\tv,動詞,行為,動作\t_\t6\tmod\t_\t_",
    "5\t，\t，\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_",
    "6\t為\t爲\tADP\tv,前置詞,源泉,*\t_\t0\troot\t_\t_",
    "7\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t8\tsubj\t_\t_",
    "8\t拜\t拜\tVERB\tv,動詞,行為,動作\t_\t6\tcomp:obj\t_\t_",
    "9\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t10\tcc\t_\t_",
    "10\t蓌\t蓌\tVERB\tv,動詞,行為,動作\t_\t8\tconj:coord\t_\t_",
    "11\t拜\t拜\tVERB\tv,動詞,行為,動作\t_\t10\tcomp:obj\t_\t_",
    "12\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_",
  ]);

  it("writes the purposive が after 蓌拜, not between 拜 and its own て", () => {
    const line = run(jieZhe);
    expect(line).toContain("拜みて");
    expect(line).toContain("るがために");
    expect(line).not.toContain("拜むがて");
  });

  it("puts the が on the last conjunct and nothing on the head — one call, both panels", () => {
    // `caseParticleFor` is the single predicate the 訓読文 and the 書き下し文
    // both ask, so asserting it here asserts the two panels agree.
    expect(caseParticleFor(at(jieZhe, "拜", 1), jieZhe)).toBeUndefined();
    expect(caseParticleFor(at(jieZhe, "蓌"), jieZhe)).toBe("が");
  });

  /** 治則進，亂則退，伯夷也 — 進 is the `subj` of 伯夷 and 退 its `conj:coord`.
   * The こと was not misplaced here but **missing**: `isNominalizedSubjectPredicate`
   * asks `readsLastInItsSubtree`, and the conjunct standing after 進 failed it. */
  const boyi = only([
    "1\t治\t治\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t3\tmod\t_\t_",
    "2\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t3\tmod\t_\t_",
    "3\t進\t進\tVERB\tv,動詞,行為,移動\t_\t9\tsubj\t_\t_",
    "4\t，\t，\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_",
    "5\t亂\t亂\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t7\tmod\t_\t_",
    "6\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t7\tmod\t_\t_",
    "7\t退\t退\tVERB\tv,動詞,行為,移動\t_\t3\tconj:coord\t_\t_",
    "8\t，\t，\tPUNCT\ts,記号,読点,*\t_\t7\tpunct\t_\t_",
    "9\t伯夷\t伯夷\tPROPN\tn,名詞,人,複合的人名\tNameType=Prs\t0\troot\t_\t_",
    "10\t也\t也\tPART\tp,助詞,句末,*\t_\t9\tdiscourse@sp\t_\t_",
    "11\t。\t。\tPUNCT\ts,記号,句点,*\t_\t9\tpunct\t_\t_",
  ]);

  it("supplies the subject こと after the second conjunct, where it wrote none at all", () => {
    expect(run(boyi)).toContain("退くこと");
  });

  /** 及其聞一善言，見一善行 — 聞 is 及's `comp:obj` with 見 coordinated onto it.
   * The particle moves off the head and onto the last conjunct, and the head
   * takes the 連用中止法 the chain wants (聞き, not 聞くを).
   *
   * **The particle is に and not を, and this test said を until 及 was reached
   * in the object slot.** 及 stands in `DATIVE_OBJECT_LEMMAS` — 70 に against 0
   * を over the received reading, counted in that table's own doc — and that
   * table was consulted only where the complement is a nominal, so a *clause*
   * under the same verb was still getting the blanket を. 孟子's own reading of
   * this sentence is 其の一善言を聞き一善行を見る**に**及びては. What this test is
   * about is unchanged and is the placement: one particle, after the whole
   * chain, with 聞 handed on in 連用中止法 behind it. */
  const jiQi = only([
    "1\t及\t及\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_",
    "2\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t3\tsubj\t_\t_",
    "3\t聞\t聞\tVERB\tv,動詞,行為,伝達\t_\t1\tcomp:obj\t_\t_",
    "4\t一\t一\tNUM\tn,数詞,数字,*\t_\t6\tmod\t_\t_",
    "5\t善\t善\tNOUN\tn,名詞,描写,態度\t_\t6\tmod\t_\t_",
    "6\t言\t言\tNOUN\tn,名詞,可搬,伝達\t_\t3\tcomp:obj\t_\t_",
    "7\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_",
    "8\t見\t見\tVERB\tv,動詞,行為,動作\t_\t3\tconj:coord\t_\t_",
    "9\t一\t一\tNUM\tn,数詞,数字,*\t_\t11\tmod\t_\t_",
    "10\t善\t善\tNOUN\tn,名詞,描写,態度\t_\t11\tmod\t_\t_",
    "11\t行\t行\tNOUN\tn,名詞,行為,*\t_\t8\tcomp:obj\t_\t_",
    "12\t，\t，\tPUNCT\ts,記号,読点,*\t_\t8\tpunct\t_\t_",
  ]);

  it("moves the object を to the end of the chain and leaves 連用中止法 behind it", () => {
    const line = run(jiQi);
    expect(line).toContain("聞き");
    expect(line).toContain("見るに");
    expect(line).not.toContain("聞くに");
    expect(line).not.toContain("を及");
  });

  /** 又何如得此樂而樂之 — 得 is 如's `comp:obl`, 樂 its `conj:coord`. The oblique
   * に is the other rule that was writing nothing rather than writing it early. */
  const ruCi = only([
    "1\t又\t又\tADV\tv,副詞,頻度,重複\t_\t3\tmod\t_\t_",
    "2\t何\t何\tPRON\tn,代名詞,疑問,*\tPronType=Int\t3\tcomp:obj\t_\t_",
    "3\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_",
    "4\t得\t得\tVERB\tv,動詞,行為,得失\t_\t3\tcomp:obl\t_\t_",
    "5\t此\t此\tPRON\tn,代名詞,指示,*\tPronType=Dem\t6\tdet\t_\t_",
    "6\t樂\t樂\tNOUN\tn,名詞,描写,態度\t_\t4\tcomp:obj\t_\t_",
    "7\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t8\tcc\t_\t_",
    "8\t樂\t樂\tVERB\tv,動詞,行為,態度\t_\t4\tconj:coord\t_\t_",
    "9\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t8\tcomp:obj\t_\t_",
    "10\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_",
  ]);

  it("supplies the oblique に after the second conjunct", () => {
    expect(run(ruCi)).toContain("樂しむに");
  });

  /** 天祥爲製服哭焉 — 哭 hangs off 製 by **`parataxis`**, and the chain the
   * particle may cross is the explicit-coordinator one only. That is
   * `nominalCoordinationChain`'s own reason, transferred: a case particle
   * dragged across a `parataxis` lands in a different clause, and this sentence
   * is one — 哭 is what 天祥 *did*, not part of what the 爲 is the 爲 of. So the
   * が stays where a chain of one puts it, on 製する. */
  const tianXiang = only([
    "1\t天祥\t天祥\tPROPN\tn,名詞,人,名\tNameType=Giv\t2\tsubj\t_\t_",
    "2\t爲\t爲\tADP\tv,前置詞,源泉,*\t_\t0\troot\t_\t_",
    "3\t製\t製\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_",
    "4\t服\t服\tNOUN\tn,名詞,可搬,道具\t_\t3\tcomp:obj\t_\t_",
    "5\t哭\t哭\tVERB\tv,動詞,行為,動作\t_\t3\tparataxis\t_\t_",
    "6\t焉\t焉\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_",
    "7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_",
  ]);

  it("does not carry a particle across a parataxis", () => {
    expect(run(tianXiang)).toContain("製するが");
    expect(caseParticleFor(at(tianXiang, "哭"), tianXiang)).toBeUndefined();
  });

  /** 有七十二部落 — 部 is the existential's `comp:obj` and 落 its `conj:coord`.
   * An existent takes no particle, and it is the whole chain that takes none:
   * the head was suppressed and the last member picked up the blanket を from
   * `CASE_PARTICLE_FOR_DEP` — 七十二部落**を**有り. See `inExistentialChain`. */
  const buluo = only([
    "1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_",
    "2\t七十二\t七十二\tNUM\tn,数詞,数,*\t_\t3\tmod\t_\t_",
    "3\t部\t部\tNOUN\tn,名詞,主体,集団\t_\t1\tcomp:obj\t_\t_",
    "4\t落\t落\tNOUN\tn,名詞,主体,集団\t_\t3\tconj:coord\t_\t_",
    "5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_",
  ]);

  it("gives no member of an existential's chain a case particle", () => {
    expect(run(buluo)).not.toContain("を有り");
    expect(caseParticleFor(at(buluo, "部"), buluo)).toBeUndefined();
    expect(caseParticleFor(at(buluo, "落"), buluo)).toBeUndefined();
  });

  /** 有畏而哭之 — the same suppression with a *predicate* chain under it, where
   * what moves is the form: the 連体形 belongs to 哭, the member said last, and
   * 畏 hands on in 連用形. It read 畏るて before. */
  const youWei = only([
    "1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_",
    "2\t畏\t畏\tVERB\tv,動詞,行為,態度\t_\t1\tcomp:obj\t_\t_",
    "3\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_",
    "4\t哭\t哭\tVERB\tv,動詞,行為,動作\t_\t2\tconj:coord\t_\t_",
    "5\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t4\tcomp:obj\t_\t_",
    "6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_",
  ]);

  it("hands the existential's first conjunct on in 連用形 and writes no を", () => {
    const line = run(youWei);
    expect(line).toContain("畏りて");
    expect(line).not.toContain("を有り");
  });

  /** 秦豈得愛趙而憎韓哉 — the chain closes on 憎, and gold hangs the 哉 on 憎
   * rather than on the matrix 得, so the を would read 憎む**を**かな. It is
   * withheld instead: `closesArgumentChain` still asks `readsLastInItsSubtree`
   * of the member it is about to write on. 91 of the 1,008 gold chains go this
   * way, and the head no longer keeps the を it had no business holding. */
  const qinQi = only([
    "1\t臣\t臣\tNOUN\tn,名詞,人,役割\t_\t5\tsubj\t_\t_",
    "2\t竊\t竊\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t5\tmod\t_\t_",
    "3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t5\tmod\t_\t_",
    "4\t事\t事\tNOUN\tn,名詞,可搬,成果物\t_\t3\tcomp:obj\t_\t_",
    "5\t觀\t觀\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_",
    "6\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t5\tcomp:obj\t_\t_",
    "7\t，\t，\tPUNCT\ts,記号,読点,*\t_\t5\tpunct\t_\t_",
    "8\t秦\t秦\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t10\tsubj\t_\t_",
    "9\t豈\t豈\tADV\tv,副詞,疑問,反語\t_\t10\tmod\t_\t_",
    "10\t得\t得\tVERB\tv,動詞,行為,得失\t_\t5\tcomp:obj\t_\t_",
    "11\t愛\t愛\tVERB\tv,動詞,行為,交流\t_\t10\tcomp:obj\t_\t_",
    "12\t趙\t趙\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t11\tcomp:obj\t_\t_",
    "13\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t14\tcc\t_\t_",
    "14\t憎\t憎\tVERB\tv,動詞,行為,交流\t_\t11\tconj:coord\t_\t_",
    "15\t韓\t韓\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t14\tcomp:obj\t_\t_",
    "16\t哉\t哉\tPART\tp,助詞,句末,*\t_\t14\tdiscourse@sp\t_\t_",
    "17\t？\t？\tPUNCT\ts,記号,句点,*\t_\t10\tpunct\t_\t_",
  ]);

  it("withholds the particle where a 終助詞 stands after the last conjunct", () => {
    expect(caseParticleFor(at(qinQi, "愛"), qinQi)).toBeUndefined();
    expect(caseParticleFor(at(qinQi, "憎"), qinQi)).toBeUndefined();
    // 愛し + て, the サ変 連用形: this line is about the withheld を and not
    // about which word 愛 is, and the character moved to `VERB_LEXICON`'s
    // 愛す when `curatedOnyomiWord` (`reading/kanjidicLookup.ts`) stopped the
    // transitivity vote answering め.でる past a curated 漢語. It read 愛でて.
    expect(run(qinQi)).toContain("愛して");
  });
});

/** **A與B is AとBと** — `coordinationClosingParticle`.
 *
 * 與 reads と, and that is the first と; the second goes after the last
 * conjunct, in front of whatever case particle the phrase takes. kanbun.info
 * states the rule in its note on 楯與矛 (「A与B」の場合は、「AとB与」と読む) and
 * writes it across its received readings: 性と天道とを, 父と君とを, 文と武とは,
 * 吾と女と. The app wrote the first と and not the second.
 *
 * The first two trees are gold, quoted as gold has them; the last two are
 * lzh_sud_kyoto 0.3.3 parses from the same corpus. */
describe("a 與 coordination closes on a second と", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  // With the lexicon, as the app runs, so that 天道 is the one word it is and
  // not 天の道.
  const run = (s: Sentence) =>
    generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })), resolve);
  const only = (rows: string[]): Sentence => {
    const tree = parseConllu(rows.join("\n") + "\n\n");
    expect(tree.sentences).toHaveLength(1);
    return tree.sentences[0];
  };
  const at = (s: Sentence, text: string, nth = 0): Sentence["tokens"][number] =>
    s.tokens.filter((t) => t.text === text)[nth];

  /** 夫子之言性與天道 (論語 公冶長 13) — 性 is 言's `comp:obj`, 道 its
   * `conj:coord` with 與 as `cc`. Received: 夫子の性と天道とを言ふは. */
  const xingYuTiandao = only([
    "1\t夫子\t夫子\tNOUN\tn,名詞,人,人\t_\t2\tcomp:obj\t_\t_",
    "2\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t3\tsubj\t_\t_",
    "3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_",
    "4\t性\t性\tNOUN\tn,名詞,不可譲,属性\t_\t3\tcomp:obj\t_\t_",
    "5\t與\t與\tADP\tv,前置詞,関係,*\t_\t7\tcc\t_\t_",
    "6\t天\t天\tNOUN\tn,名詞,制度,場\tCase=Loc\t7\tmod\t_\t_",
    "7\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t4\tconj:coord\t_\t_",
    "8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_",
  ]);

  it("writes と after the last conjunct and the を after that — 性と天道とを", () => {
    expect(run(xingYuTiandao)).toContain("性と天道とを");
  });

  it("leaves the case particle itself where it was, on the carrier", () => {
    // The と is added at assembly (`writtenCaseParticle`), not by
    // `caseParticleFor`, whose other callers ask about case alone.
    expect(caseParticleFor(at(xingYuTiandao, "道"), xingYuTiandao)).toBe("を");
    expect(coordinationClosingParticle(at(xingYuTiandao, "道"), xingYuTiandao)).toBe("と");
    expect(coordinationClosingParticle(at(xingYuTiandao, "性"), xingYuTiandao)).toBeUndefined();
  });

  /** 吾與女弗如也 (論語 公冶長 9) — a coordinated subject, which takes no case
   * particle of its own. Received: 吾と女と如かざるなり. */
  const wuYuRu = only([
    "1\t吾\t吾\tPRON\tn,代名詞,人称,起格\tPerson=1|PronType=Prs\t5\tsubj\t_\t_",
    "2\t與\t與\tADP\tv,前置詞,関係,*\t_\t3\tcc\t_\t_",
    "3\t女\t女\tPRON\tn,代名詞,人称,起格\tPerson=2|PronType=Prs\t1\tconj:coord\t_\t_",
    "4\t弗\t弗\tADV\tv,副詞,否定,無界\tPolarity=Neg\t5\tmod\t_\t_",
    "5\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_",
    "6\t也\t也\tPART\tp,助詞,句末,*\t_\t5\tdiscourse@sp\t_\t_",
    "7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_",
  ]);

  it("writes the second と on a subject too, where no case particle follows — 吾と女と", () => {
    expect(run(wuYuRu)).toContain("吾と女と");
  });

  /** 漢軍及諸侯兵圍之數重 (史記 項羽本紀) — the same chain with 及, which the
   * received reading writes および with no と after the last conjunct:
   * 漢軍及び諸侯の兵、之を囲むこと数重なり. */
  const hanJunJi = only([
    "1\t漢\t漢\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t2\tmod\t_\t_",
    "2\t軍\t軍\tNOUN\tn,名詞,主体,集団\t_\t7\tsubj\t_\t_",
    "3\t及\t及\tADP\tv,前置詞,関係,*\t_\t6\tcc\t_\t_",
    "4\t諸\t諸\tNOUN\tn,名詞,数量,*\t_\t5\tmod\t_\t_",
    "5\t侯\t侯\tNOUN\tn,名詞,人,役割\t_\t6\tmod\t_\t_",
    "6\t兵\t兵\tNOUN\tn,名詞,人,役割\t_\t2\tconj:coord\t_\t_",
    "7\t圍\t圍\tVERB\tv,動詞,行為,動作\t_\t10\tsubj\t_\t_",
    "8\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t7\tcomp:obj\t_\t_",
    "9\t數\t數\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t10\tmod\t_\t_",
    "10\t重\t重\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_",
    "11\t。\t。\tPUNCT\ts,記号,句点,*\t_\t10\tpunct\t_\t_",
  ]);

  it("adds nothing after a 及 coordination", () => {
    expect(coordinationClosingParticle(at(hanJunJi, "兵"), hanJunJi)).toBeUndefined();
    expect(run(hanJunJi)).not.toContain("兵と");
  });

  /** 與命與仁 (論語 子罕 1, in 荻生徂徠's division) — the parser makes the first
   * 與 a preposition heading the sentence, read と after the phrase. That と
   * already closes the phrase, and adding the closing と gave 命と仁とと. */
  const yuMingYuRen = only([
    "1\t與\t與\tADP\tv,前置詞,関係,*\t_\t0\troot\t_\t_",
    "2\t命\t命\tNOUN\tn,名詞,不可譲,身体\t_\t1\tcomp:obj\t_\t_",
    "3\t與\t與\tADP\tv,前置詞,関係,*\t_\t4\tcc\t_\t_",
    "4\t仁\t仁\tNOUN\tn,名詞,描写,態度\t_\t2\tconj:coord\t_\t_",
    "5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_",
  ]);

  it("stands down where the next word read is itself と", () => {
    expect(run(yuMingYuRen)).not.toContain("とと");
  });

  /** 夫不可陷之楯、與無不陷之矛、不可同世而立 (韓非子 難一, the 矛盾 story), hand-
   * corrected to treebank conventions — 矛 is `conj:coord` of 楯 with 與 as
   * `cc`, and the 、 between them is 楯's `punct`. kanbun.info: 陥す可からざるの
   * 楯と、陥さざる無きの矛とは. The 與 is read in its own place, after the
   * mark, so the cut through the source boundary wrote 楯、と. See
   * `coordinatorClosingFirstConjunct` (reorderEngine.ts). */
  const maoDun = only([
    "1\t夫\t夫\tPART\tp,助詞,句頭,*\t_\t16\tdiscourse\t_\t_",
    "2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_",
    "3\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t5\tcomp:obj\t_\t_",
    "4\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t3\tcomp:aux\t_\t_",
    "5\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t6\tmod\t_\t_",
    "6\t楯\t楯\tNOUN\tn,名詞,可搬,道具\t_\t16\tsubj\t_\t_",
    "7\t、\t、\tPUNCT\ts,記号,読点,*\t_\t6\tpunct\t_\t_",
    "8\t與\t與\tADP\tv,前置詞,関係,*\t_\t13\tcc\t_\t_",
    "9\t無\t無\tADV\tv,動詞,存在,存在\tPolarity=Neg\t11\tmod\t_\t_",
    "10\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t11\tmod\t_\t_",
    "11\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t12\tcomp:obj\t_\t_",
    "12\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t13\tmod\t_\t_",
    "13\t矛\t矛\tNOUN\tn,名詞,可搬,道具\t_\t6\tconj:coord\t_\t_",
    "14\t、\t、\tPUNCT\ts,記号,読点,*\t_\t13\tpunct\t_\t_",
    "15\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t16\tmod\t_\t_",
    "16\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_",
    "17\t同\t同\tADJ\tv,動詞,描写,形質\tDegree=Pos\t16\tcomp:aux\t_\t_",
    "18\t世\t世\tNOUN\tn,名詞,制度,場\t_\t17\tcomp:obj\t_\t_",
    "19\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t20\tcc\t_\t_",
    "20\t立\t立\tVERB\tv,動詞,行為,姿勢\t_\t17\tconj:coord\t_\t_",
    "21\t。\t。\tPUNCT\ts,記号,句点,*\t_\t16\tpunct\t_\t_",
  ]);

  it("writes the と of 與 before the mark that separates the conjuncts — 楯と、", () => {
    const prose = run(maoDun);
    expect(prose).toContain("楯と、");
    expect(prose).not.toContain("、と");
    // The mark that closes the whole phrase stays after the second と.
    expect(prose).toContain("矛とは、");
  });

  /** A comitative 與 after a mark, in the shape of 事君能致其身、與朋友交 (論語
   * 學而 7): 與 is `mod` of the verb and read after its object, so its と
   * already follows 朋友 and the mark stays where the source put it. */
  const withFriends = only([
    "1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_",
    "2\t往\t往\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_",
    "3\t、\t、\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_",
    "4\t與\t與\tADP\tv,前置詞,関係,*\t_\t6\tmod\t_\t_",
    "5\t朋友\t朋友\tNOUN\tn,名詞,人,関係\t_\t4\tcomp:obj\t_\t_",
    "6\t交\t交\tVERB\tv,動詞,行為,交流\t_\t2\tconj:coord\t_\t_",
    "7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_",
  ]);

  it("leaves the mark before a comitative 與 where it was — 、朋友と", () => {
    expect(run(withFriends)).toContain("往き、朋友と交");
  });
});
