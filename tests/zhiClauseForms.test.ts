import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { findCompoundSpans } from "../src/reading/jmdictLookup.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { negationEnding } from "../src/kakikudashi/conjugationContext.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { type JmdictIndex } from "../src/reading/jmdictLookup.ts";

// ---------------------------------------------------------------------------
// The forms a clause takes where it meets a 之 or a closing particle — three
// faults met in 韓非子 難一's 矛盾 passage, on the passage hand-corrected to
// the Kyoto treebank conventions. Each block below is one of them, and each
// is stated as the general shape rather than as that one tree:
//
//  1. 莫能陷也 with the 也 on the complement 陷: the reading already puts the
//     也 after the 莫, and the 莫 must be the 連体形 莫き for the なり.
//  2. A negated clause modifying a noun through a genitive 之 is attributive
//     at its last word, the ず or the postposed 無: 陷す可からざるの楯,
//     陷らざる無きの矛.
//  3. A 主之謂 clause (N之V) standing as a subject is nominalized with 連体形
//     + は: 堯舜の兩つながら譽む可からざるは、矛楯の説なり — and with こと where
//     the predicate it is the subject of measures it: 吾が楯の堅きこと、….
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

function sentence(conllu: string): Sentence {
  const parsed = parseConllu(conllu.trim().replace(/^ +/gm, "") + "\n");
  expect(parsed.sentences).toHaveLength(1);
  return parsed.sentences[0];
}

const prose = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);
const byText = (s: Sentence, text: string, nth = 0) => s.tokens.filter((t) => t.text === text)[nth];

describe("a 也 the tree hangs off the complement still closes on the 莫", () => {
  // 吾楯之堅、莫能陷也 — the 也 on 陷, the `comp:aux` of 能, as the treebank and
  // the parser both attach it. The reorder reads it after the 莫, and the form
  // has to agree with that order: 莫きなり, never 莫しなり.
  const s = sentence(`
    1\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t2\tmod\t_\t_
    2\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
    3\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:aux\t_\t_
    4\t也\t也\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
    5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
  `);

  it("writes 莫きなり", () => {
    expect(prose(s)).toMatch(/莫きなり$/);
  });

  it("does not claim a 也 that closes another clause", () => {
    // 莫能陷、X也: the 也 hangs off a clause beside 能 rather than inside it, so
    // it is not the particle of the clause the 莫 closes, and the 莫 stays 莫し.
    const t = sentence(`
      1\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t2\tmod\t_\t_
      2\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
      3\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:aux\t_\t_
      4\t、\t、\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
      5\t堅\t堅\tADJ\tv,動詞,描写,形質\tDegree=Pos\t2\tparataxis\t_\t_
      6\t也\t也\tPART\tp,助詞,句末,*\t_\t5\tdiscourse@sp\t_\t_
      7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
    `);
    expect(prose(t)).toContain("莫し、");
  });
});

describe("a negated clause before a genitive 之 is attributive", () => {
  it("reads 不可陷之楯 as 〜可からざるの楯", () => {
    const s = sentence(`
      1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
      2\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t4\tcomp:obj\t_\t_
      3\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:aux\t_\t_
      4\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t5\tmod\t_\t_
      5\t楯\t楯\tNOUN\tn,名詞,可搬,道具\t_\t0\troot\t_\t_
      6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_
    `);
    expect(prose(s)).toContain("可からざるの楯");
    expect(negationEnding(byText(s, "不"), computeReadingOrder(s), resolve)).toBe("ざる");
  });

  it("reads 不得之姦 the same way when the parser tags the 之 PART", () => {
    // 尉繚子's 得ざるの姦 — the parsed tier returns the genitive 之 as SCONJ, PART
    // or PRON on `mod`, and the one `isGenitiveComplement` test covers all three.
    const s = sentence(`
      1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
      2\t得\t得\tVERB\tv,動詞,行為,得失\t_\t3\tcomp:obj\t_\t_
      3\t之\t之\tPART\tp,助詞,接続,属格\t_\t4\tmod\t_\t_
      4\t姦\t姦\tNOUN\tn,名詞,人,人\t_\t0\troot\t_\t_
    `);
    expect(prose(s)).toContain("ざるの姦");
  });

  it("reads 無不陷之矛 as 陷らざる無きの矛", () => {
    // The 無 is read last in the clause (`isPredicateNegationPostpose`), so it
    // is the 無 that meets the の and the 無 that goes attributive; the 不 in
    // front of it keeps the ざる it owes the 無.
    const s = sentence(`
      1\t無\t無\tADV\tv,動詞,存在,存在\tPolarity=Neg\t3\tmod\t_\t_
      2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
      3\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t4\tcomp:obj\t_\t_
      4\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t5\tmod\t_\t_
      5\t矛\t矛\tNOUN\tn,名詞,可搬,道具\t_\t0\troot\t_\t_
    `);
    expect(prose(s)).toContain("ざる無きの矛");
  });

  it("leaves a clause-final negation that no genitive 之 follows in its 終止形", () => {
    const s = sentence(`
      1\t無\t無\tADV\tv,動詞,存在,存在\tPolarity=Neg\t3\tmod\t_\t_
      2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
      3\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
      4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_
    `);
    expect(prose(s)).toMatch(/ざる無し$/);
  });
});

describe("a 主之謂 clause standing as a subject takes 連体形 + は", () => {
  it("reads 今堯舜之不可兩譽、矛楯之説也 with 可からざるは", () => {
    // The treebank shape: 之 `subj` of the predicate, the subject noun its
    // `comp:obj`. The predicate is the auxiliary 可, which on its own is not a
    // content predicate; the 之 is what makes the clause a nominal.
    const s = sentence(`
      1\t今\t今\tNOUN\tn,名詞,時,*\tCase=Tem\t13\tmod@tmod\t_\t_
      2\t堯\t堯\tPROPN\tn,名詞,人,名\tNameType=Giv\t4\tcomp:obj\t_\t_
      3\t舜\t舜\tPROPN\tn,名詞,人,名\tNameType=Giv\t2\tconj:coord\t_\t_
      4\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t6\tsubj\t_\t_
      5\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t6\tmod\t_\t_
      6\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t13\tsubj\t_\t_
      7\t兩\t兩\tADV\tv,副詞,範囲,総括\t_\t8\tmod\t_\t_
      8\t譽\t譽\tVERB\tv,動詞,行為,交流\t_\t6\tcomp:aux\t_\t_
      9\t、\t、\tPUNCT\ts,記号,読点,*\t_\t6\tpunct\t_\t_
      10\t矛\t矛\tNOUN\tn,名詞,可搬,道具\t_\t12\tcomp:obj\t_\t_
      11\t楯\t楯\tNOUN\tn,名詞,可搬,道具\t_\t10\tflat@vv\t_\t_
      12\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t13\tmod\t_\t_
      13\t説\t説\tNOUN\tn,名詞,可搬,伝達\t_\t0\troot\t_\t_
      14\t也\t也\tPART\tp,助詞,句末,*\t_\t13\tdiscourse@sp\t_\t_
      15\t。\t。\tPUNCT\ts,記号,句点,*\t_\t13\tpunct\t_\t_
    `);
    expect(prose(s)).toContain("可からざるは、");
  });

  it("writes は on an unnegated verb — 人之在道、若魚之在水", () => {
    // 三略 下略, 人の道に在るは、魚の水に在るが若し: the verb in the subject slot,
    // with the 之 on `subj` and 人 its `comp:obj`.
    const s = sentence(`
      1\t人\t人\tNOUN\tn,名詞,人,人\t_\t2\tcomp:obj\t_\t_
      2\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t3\tsubj\t_\t_
      3\t在\t在\tVERB\tv,動詞,存在,存在\t_\t6\tsubj\t_\t_
      4\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t3\tcomp:obl\t_\t_
      5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
      6\t若\t若\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_
      7\t魚\t魚\tNOUN\tn,名詞,主体,動物\t_\t8\tcomp:obj\t_\t_
      8\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t9\tsubj\t_\t_
      9\t在\t在\tVERB\tv,動詞,存在,存在\t_\t6\tcomp:obj\t_\t_
      10\t水\t水\tNOUN\tn,名詞,可搬,液体\t_\t9\tcomp:obl\t_\t_
      11\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_
    `);
    expect(prose(s)).toContain("在るは、");
  });

  it("writes ざるは on a negated verb — 道之不行、已知之矣", () => {
    // 論語 微子, 道の行はれざるは、已に之を知れり. The ず closes the clause, so the
    // ず is what carries the は (`negationEndingParts`).
    const s = sentence(`
      1\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t2\tcomp:obj\t_\t_
      2\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t4\tsubj\t_\t_
      3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
      4\t行\t行\tVERB\tv,動詞,行為,移動\t_\t7\tsubj\t_\t_
      5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_
      6\t已\t已\tADV\tv,副詞,時相,完了\t_\t7\tmod\t_\t_
      7\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
      8\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t7\tcomp:obj\t_\t_
      9\t矣\t矣\tPART\tp,助詞,句末,*\t_\t7\tdiscourse@sp\t_\t_
      10\t。\t。\tPUNCT\ts,記号,句点,*\t_\t7\tpunct\t_\t_
    `);
    expect(prose(s)).toContain("ざるは、");
  });

  it("keeps こと where the governing predicate measures the clause — 丘之禱久矣", () => {
    // 論語 述而, 丘の禱ること久し: an adjective saying how long, the extent
    // construction 去首半尺 (首を去ること半尺) anchors.
    const s = sentence(`
      1\t丘\t丘\tPROPN\tn,名詞,人,名\tNameType=Giv\t2\tcomp:obj\t_\t_
      2\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t3\tsubj\t_\t_
      3\t禱\t禱\tVERB\tv,動詞,行為,交流\t_\t4\tsubj\t_\t_
      4\t久\t久\tADJ\tv,動詞,描写,時間\tDegree=Pos\t0\troot\t_\t_
      5\t矣\t矣\tPART\tp,助詞,句末,*\t_\t4\tdiscourse@sp\t_\t_
      6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
    `);
    expect(prose(s)).toContain("ること久し");
  });

  it("keeps こと before a clause a postposed 莫 closes — 吾楯之堅、莫能陷也", () => {
    // The 矛盾 passage, 吾が楯の堅きこと、能く陷す莫きなり: what the hardness is
    // measured by is the adjective 莫し.
    const s = sentence(`
      1\t吾\t吾\tPRON\tn,代名詞,人称,起格\tPerson=1|PronType=Prs\t2\tdet\t_\t_
      2\t楯\t楯\tNOUN\tn,名詞,可搬,道具\t_\t3\tcomp:obj\t_\t_
      3\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t4\tsubj\t_\t_
      4\t堅\t堅\tADJ\tv,動詞,描写,形質\tDegree=Pos\t7\tsubj\t_\t_
      5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_
      6\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t7\tmod\t_\t_
      7\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
      8\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t7\tcomp:aux\t_\t_
      9\t也\t也\tPART\tp,助詞,句末,*\t_\t8\tdiscourse@sp\t_\t_
      10\t。\t。\tPUNCT\ts,記号,句点,*\t_\t7\tpunct\t_\t_
    `);
    const out = prose(s);
    expect(out).toContain("堅きこと、");
    expect(out).toMatch(/莫きなり$/);
  });

  it("writes は on an existential with a genitive subject — 人之有技", () => {
    // 大學 傳十章, 人の技有るは. Without the 之 an existential heads a whole
    // predication (山中有虎) and is not nominalized; with it the clause is.
    const s = sentence(`
      1\t人\t人\tNOUN\tn,名詞,人,人\t_\t2\tcomp:obj\t_\t_
      2\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t3\tsubj\t_\t_
      3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t7\tsubj\t_\t_
      4\t技\t技\tNOUN\tn,名詞,可搬,伝達\t_\t3\tcomp:obj\t_\t_
      5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
      6\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t7\tmod\t_\t_
      7\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
      8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t7\tpunct\t_\t_
    `);
    expect(prose(s)).toContain("技有るは、");
  });

  it("keeps こと on a subject clause with no 之 — 去首半尺", () => {
    const s = sentence(`
      1\t去\t去\tVERB\tv,動詞,行為,移動\t_\t4\tsubj\t_\t_
      2\t首\t首\tNOUN\tn,名詞,身体,部位\t_\t1\tcomp:obj\t_\t_
      3\t半\t半\tNUM\tn,数詞,数,*\t_\t4\tnummod\t_\t_
      4\t尺\t尺\tNOUN\tn,名詞,度量衡,単位\t_\t0\troot\t_\t_
    `);
    expect(prose(s)).toContain("こと");
  });
});
