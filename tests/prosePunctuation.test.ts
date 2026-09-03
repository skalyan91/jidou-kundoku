import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { generateKakikudashi, generateKakikudashiForTree, sentenceSeparator } from "../src/kakikudashi/generator.ts";

// ---------------------------------------------------------------------------
// Where punctuation lands in the 書き下し文 — three faults the reader found in
// 酒蟲, all of them about a mark's position in the emitted prose rather than
// about which mark it is.
//
// Real rows and the real resolver throughout (the trees below are the reader's
// own 酒蟲 parse, cut down to the clause each fault turns on), because every
// one of the three is a fact about how reading order and source order come
// apart, and a hand-built tree that never inverts anything cannot show it.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

const planFor = (sentence: Sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence));
const prose = (rows: string) => generateKakikudashiForTree(parseConllu(rows), planFor, resolve);

describe("a quotation's closing と is written outside the closing bracket", () => {
  // 劉答言：「無。」 — the parser cuts the sentence at the 。 inside the
  // quotation, so the 」 is left heading a sentence of its own and the と has
  // nothing after it to be written past. This is the shape the reader saw
  // ("「無しと」"), and it is the ordinary one: every quotation in 酒蟲 closes
  // this way.
  const ANSWER = `# text = 劉答言：「無。
1\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t2\tsubj\t_\t_
2\t答\t答\tVERB\tn,名詞,人,名\tNameType=Giv\t0\troot\t_\t_
3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t2\tconj:coord\t_\t_
4\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
5\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
6\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t3\tcomp:obj\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_

# text = 」
1\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t0\troot\t_\t_
`;

  it("carries the と past a 」 the parser left in the next sentence", () => {
    expect(prose(ANSWER)).toBe("劉答へ言ふ、「無し」と。");
  });

  it("writes it past a 」 standing in the quotation's own sentence too", () => {
    expect(
      prose(`# text = 曰：「無」
1\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t：\t：\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
3\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t4\tpunct\t_\t_
4\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t1\tcomp:obj\t_\t_
5\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t4\tpunct\t_\t_
`),
    ).toBe("曰はく、「無し」と。");
  });

  // 〜やと divides between the two brackets and not before them: the や is the
  // quoted question's own sentence-final particle and stays inside, the と is
  // the reporting frame's and goes outside. 問：「需何藥？」 is
  // 問ふ、「なにの藥を需ふや」と — never 「なにの藥を需ふ」やと, which asks
  // nothing inside the quotation marks.
  it("leaves the question's own や inside the bracket and takes only the と out", () => {
    expect(
      prose(`# text = 問：「需何藥？
1\t問\t問\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t：\t：\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
3\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t4\tpunct\t_\t_
4\t需\t需\tVERB\tv,動詞,行為,得失\t_\t1\tcomp:obj\t_\t_
5\t何\t何\tPRON\tn,代名詞,疑問,*\tPronType=Int\t6\tdet\t_\t_
6\t藥\t藥\tNOUN\tn,名詞,可搬,道具\t_\t4\tcomp:obj\t_\t_
7\t？\t？\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_

# text = 」
1\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t0\troot\t_\t_
`),
    ).toBe("問ふ、「なにの藥を需ふや」と。");
  });

  // 或言：『…。』然歟否歟？ — here the closing bracket heads a sentence that
  // carries on after it, so the と has to land *inside* that sentence, between
  // the 』 and what follows. Nothing but the brackets is stepped over. The 。
  // the source wrote inside the quotation follows the と, which is the mark
  // `deferredMark` is there to write: 『成る』と。然り, and not 『成る』と然り.
  it("stops at the bracket when the next sentence carries on after it", () => {
    expect(
      prose(`# text = 言：『成。
1\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t：\t：\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
3\t『\t『\tPUNCT\ts,記号,括弧開,*\t_\t4\tpunct\t_\t_
4\t成\t成\tVERB\tv,動詞,行為,動作\t_\t1\tcomp:obj\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_

# text = 』然
1\t』\t』\tPUNCT\ts,記号,括弧閉,*\t_\t2\tpunct\t_\t_
2\t然\t然\tVERB\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
`),
    ).toBe("言ふ、『成る』と。然り。");
  });
});

describe("a quotation that runs past the end of its sentence is closed where it ends", () => {
  // 異史氏曰：「…豈飲啄固有數乎？或言：『僧愚之。』然歟？」 — the whole of 酒蟲's
  // last paragraph in miniature, and the shape the reader's two complaints
  // turn on. The outer quotation is opened in the first sentence and shut in
  // the fourth, with an inner quotation of its own in between; the inner one
  // is opened in the second and shut at the head of the third, which then
  // carries on with the outer speaker's own question.
  //
  // Both と are written outside the bracket that shuts their own quotation —
  // the inner one after 』, the outer one after 」, three sentences from where
  // it was read — and the 。 each reported sentence closed on is written after
  // its と. The outer speaker's own か is left unclosed by a と, because the
  // quotation it belongs to has not ended there.
  const NESTED = `# text = 異史氏曰：「豈飲啄固有數乎？
1\t異\t異\tVERB\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t2\tmod\t_\t_
2\t史\t史\tNOUN\tn,名詞,人,姓氏\tNameType=Sur\t4\tsubj\t_\t_
3\t氏\t氏\tNOUN\tn,名詞,不可譲,属性\t_\t2\tflat\t_\t_
4\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
5\t：\t：\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_
6\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t11\tpunct\t_\t_
7\t豈\t豈\tADV\tv,副詞,疑問,反語\t_\t11\tmod\t_\t_
8\t飲\t飲\tNOUN\tv,動詞,行為,飲食\t_\t11\tsubj\t_\t_
9\t啄\t啄\tNOUN\tv,動詞,行為,飲食\t_\t8\tcompound\t_\t_
10\t固\t固\tADV\tv,副詞,判断,確定\t_\t11\tmod\t_\t_
11\t有\t有\tVERB\tv,動詞,存在,存在\t_\t4\tcomp:obj\t_\t_
12\t數\t數\tNOUN\tn,名詞,数量,*\t_\t11\tcomp:obj\t_\t_
13\t乎\t乎\tPART\tp,助詞,句末,*\t_\t11\tdiscourse@sp\t_\t_
14\t？\t？\tPUNCT\ts,記号,句点,*\t_\t11\tpunct\t_\t_

# text = 或言：『僧愚之。
1\t或\t或\tPRON\tn,代名詞,人称,起格\tPronType=Prs\t2\tsubj\t_\t_
2\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t『\t『\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
5\t僧\t僧\tNOUN\tn,名詞,人,役割\t_\t6\tsubj\t_\t_
6\t愚\t愚\tVERB\tv,動詞,描写,形質\tDegree=Pos\t2\tcomp:obj\t_\tReading=ぐ
7\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t6\tcomp:obj\t_\t_
8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_

# text = 』然歟？
1\t』\t』\tPUNCT\ts,記号,括弧閉,*\t_\t2\tpunct\t_\t_
2\t然\t然\tADV\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Conv\t0\troot\t_\t_
3\t歟\t歟\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
4\t？\t？\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_

# text = 」
1\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t0\troot\t_\t_
`;

  it("carries each と to the bracket that shuts its own quotation", () => {
    expect(prose(NESTED)).toBe("異史氏曰はく、「豈に飲啄固より數有るか。あるひと言ふ、『僧これを愚す』と。然るや」と。");
  });

  // The と the inner quotation is closed with used to be the last thing in the
  // prose that had any mark after it: 『…愚す』と然るや否むや」。 ran the
  // reported sentence into the question that follows it, and the 。 the source
  // wrote inside the quotation was written nowhere at all.
  it("writes the reported sentence's own 。 after the と and not before the bracket", () => {
    expect(prose(NESTED)).toContain("』と。然るや");
    expect(prose(NESTED)).not.toContain("』と然るや");
  });

  // And the outer quotation's と was being written where its first sentence
  // ended — 豈に飲啄固より數有るかと。 — closing a quotation three sentences
  // before its bracket, and leaving the 」 that ends the passage with none.
  it("leaves no と where the outer quotation merely runs out of sentence", () => {
    expect(prose(NESTED)).toContain("數有るか。");
    expect(prose(NESTED)).toContain("」と。");
  });
});

describe("the mark a paragraph ends on is written", () => {
  // 體漸瘦、家亦日貧、後飲食至不能給。 ends the paragraph that 異史氏曰 opens,
  // and its 。 went missing: the line break was treated as the separator and
  // the mark the source actually wrote was dropped with it.
  const PARAGRAPH = `# text = 體漸瘦。
1\t體\t體\tNOUN\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t漸\t漸\tADV\tv,副詞,時相,変化\tAdvType=Tim\t3\tmod\t_\t_
3\t瘦\t瘦\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_

# text = 異史氏曰
1\t異\t異\tVERB\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t2\tmod\t_\tLineBreak=para
2\t史\t史\tNOUN\tn,名詞,人,姓氏\tNameType=Sur\t4\tsubj\t_\t_
3\t氏\t氏\tNOUN\tn,名詞,不可譲,属性\t_\t2\tflat\t_\t_
4\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
`;

  it("keeps the 。 in front of a paragraph break", () => {
    expect(sentenceSeparator(parseConllu(PARAGRAPH).sentences, 0)).toBe("。");
    expect(prose(PARAGRAPH)).toBe("體やうやく瘦す。\n　異史氏曰はく。");
  });

  // The break is the separator only where nothing else is. 酒蟲's own title
  // stands on its own line with no mark after it, and a 。 there would be
  // punctuation the source never wrote.
  it("writes nothing where the source closed the line with no mark at all", () => {
    const title = `# text = 酒蟲
1\t酒\t酒\tNOUN\tn,名詞,可搬,糧食\t_\t2\tmod\t_\t_
2\t蟲\t蟲\tNOUN\tn,名詞,主体,動物\t_\t0\troot\t_\t_

# text = 長山
1\t長\t長\tVERB\tv,動詞,描写,量\tDegree=Pos|VerbForm=Part\t2\tmod\t_\tLineBreak=para
2\t山\t山\tNOUN\tn,名詞,固定物,地形\t_\t0\troot\t_\t_
`;
    expect(sentenceSeparator(parseConllu(title).sentences, 0)).toBe("");
    expect(prose(title)).toBe("酒の蟲\n　長山。");
  });
});

describe("a mark follows what the source put in front of it, wherever that is read", () => {
  // 無損其富； — 無 governs 損 and is read after it, so the ； hung off 損
  // sorted in ahead of 無 and the clause came out その富を損する、無く: the mark
  // one element early, exactly where an element had moved.
  it("writes the ； after the negation it was read past, not before it", () => {
    const sentence = parseConllu(`# text = 無損其富；不飲一斗
1\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg|VerbForm=Conv\t0\troot\t_\t_
2\t損\t損\tVERB\tv,動詞,行為,得失\t_\t1\tcomp:obj\t_\tReading=そん
3\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t4\tdet\t_\t_
4\t富\t富\tNOUN\tn,名詞,可搬,成果物\t_\t2\tcomp:obj\t_\t_
5\t；\t；\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
6\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t7\tmod\t_\t_
7\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t1\tparataxis\t_\t_
8\t一\t一\tNUM\tn,数詞,数字,*\t_\t9\tclf\t_\tReading=いち
9\t斗\t斗\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t7\tcomp:obj\t_\t_
`).sentences[0];
    const plan = planFor(sentence);
    const text = (id: number) => sentence.tokens.find((t) => t.id === id)!.text;
    expect(plan.order.map(text).join("")).toBe("其富損無；一斗飲不");
    expect(generateKakikudashi(plan, resolve)).toBe("その富を損する無く、一斗を飲まず");
  });

  // 解縛視之、赤肉… — 解 is an INVERT child of 肉 and 赤肉 is one span, so the
  // whole run 縛-解-之-視 travels inside the atom keyed at 赤; the 、 in front
  // of it sorted ahead of that atom and opened the sentence, 、縛を解き…
  it("writes the 、 after the clause it closes, not in front of it", () => {
    const sentence = parseConllu(`# text = 解縛視之、赤肉
1\t解\t解\tVERB\tv,動詞,行為,動作\tNameType=Sur\t7\tmod@tmod\t_\tReading=と|Okurigana=く
2\t縛\t縛\tNOUN\tv,動詞,行為,動作\tNameType=Giv\t1\tcomp:obj\t_\t_
3\t視\t視\tVERB\tv,動詞,行為,動作\t_\t1\tparataxis\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t7\tmod\t_\t_
6\t赤\t赤\tADJ\tn,名詞,描写,形質\t_\t7\tmod\t_\t_
7\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t0\troot\t_\t_
8\t備\t備\tVERB\tv,動詞,行為,設置\t_\t7\tconj:coord\t_\t_
`).sentences[0];
    expect(generateKakikudashi(planFor(sentence), resolve)).toBe("縛を解きこれを視る、赤肉にして備はる");
  });
});
