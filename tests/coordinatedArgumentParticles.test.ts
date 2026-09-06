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
import { caseParticleFor } from "../src/kakikudashi/conjugationContext.ts";

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
   * The を moves off the head and onto the last conjunct, and the head takes the
   * 連用中止法 the chain wants (聞き, not 聞くを). */
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
    expect(line).toContain("見るを");
    expect(line).not.toContain("聞くを");
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
