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
    ).toBe("曰く、「無し」と。");
  });

  // 〜やと divides between the two brackets and not before them: the や is the
  // quoted question's own sentence-final particle and stays inside, the と is
  // the reporting frame's and goes outside. 問：「需何藥？」 is
  // 問ふ、「何の藥を需ふや」と — never 「何の藥を需ふ」やと, which asks
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
    ).toBe("問ふ、「何の藥を需ふや」と。");
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
2\t然\t然\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
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
1\t異\t異\tADJ\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t2\tmod\t_\t_
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
6\t愚\t愚\tADJ\tv,動詞,描写,形質\tDegree=Pos\t2\tcomp:obj\t_\tReading=ぐ
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

  /** 曰：「甲來。乙去。」 as **one** sentence, which is what the pipeline now
   * hands over: `splitProvisional` keeps a quotation whole, so the parser sees
   * it entire and returns it entire, and `splitIntoSentences` no longer cuts it
   * back apart. The four-block `NESTED` fixture below is the *old* shape and is
   * kept as it is — a `.conllu` saved before this change still looks like that,
   * and it still has to read. */
  const ONE_SENTENCE_QUOTE = `# text = 曰：「甲來。乙去。」
1\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t：\t：\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
3\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t5\tpunct\t_\t_
4\t甲\t甲\tNOUN\tn,名詞,人,人\t_\t5\tsubj\t_\t_
5\t來\t來\tVERB\tv,動詞,行為,移動\t_\t1\tcomp:obj\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_
7\t乙\t乙\tNOUN\tn,名詞,人,人\t_\t8\tsubj\t_\t_
8\t去\t去\tVERB\tv,動詞,行為,移動\t_\t5\tconj:coord\t_\t_
9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t8\tpunct\t_\t_
10\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t8\tpunct\t_\t_
`;

  it("puts the と after the *last* sentence of a multi-sentence quotation", () => {
    // **The bug this fixes.** The quotation used to be cut at its internal 。
    // before it ever reached the parser, so 曰 governed only the first of the
    // two clauses and the と closed there — 「甲來ると。乙去ぬ — while the later
    // fragments, re-rooted by the cut, were no longer any speech verb's
    // complement and got none at all. Kept whole, `quoteEndIds` finds the
    // complement's real last token and the と lands once, after 去.
    expect(prose(ONE_SENTENCE_QUOTE)).toBe("曰く、「甲來る。乙去ぬ」と。");
  });

  it("keeps the quoted text's own sentence marks, which the join no longer supplies", () => {
    // The 。 between 甲來 and 乙去 closes a sentence of the *quoted* text, not of
    // the sentence doing the quoting. It used to fall on a sentence boundary
    // and be written by the join; inside one sentence there is no join to write
    // it, and leaving it there ran the two clauses together.
    expect(prose(ONE_SENTENCE_QUOTE)).toContain("甲來る。乙去ぬ");
    // …while the one before the closing bracket is still the join's, and is
    // written once. Emitting it here as well gave 乙去ぬと。」。
    expect(prose(ONE_SENTENCE_QUOTE)).not.toContain("。」");
    expect(prose(ONE_SENTENCE_QUOTE).match(/。/g)).toHaveLength(2);
  });

  it("carries each と to the bracket that shuts its own quotation", () => {
    expect(prose(NESTED)).toBe("異史氏曰く、「豈に飲啄固より數有るか。或ひと言ふ、『僧之を愚す』と。然りや」と。");
  });

  // The と the inner quotation is closed with used to be the last thing in the
  // prose that had any mark after it: 『…愚す』と然るや否むや」。 ran the
  // reported sentence into the question that follows it, and the 。 the source
  // wrote inside the quotation was written nowhere at all.
  it("writes the reported sentence's own 。 after the と and not before the bracket", () => {
    // 然る -> 然り with the 終助詞 や's correction (`TERMINAL_PARTICLE_READINGS`);
    // nothing about the mark moved, which is what this asserts.
    expect(prose(NESTED)).toContain("』と。然りや");
    expect(prose(NESTED)).not.toContain("』と然りや");
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
1\t異\t異\tADJ\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t2\tmod\t_\tLineBreak=para
2\t史\t史\tNOUN\tn,名詞,人,姓氏\tNameType=Sur\t4\tsubj\t_\t_
3\t氏\t氏\tNOUN\tn,名詞,不可譲,属性\t_\t2\tflat\t_\t_
4\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
`;

  it("keeps the 。 in front of a paragraph break", () => {
    expect(sentenceSeparator(parseConllu(PARAGRAPH).sentences, 0)).toBe("。");
    expect(prose(PARAGRAPH)).toBe("體やうやく瘦す。\n　異史氏曰く。");
  });

  // The break is the separator only where nothing else is. 酒蟲's own title
  // stands on its own line with no mark after it, and a 。 there would be
  // punctuation the source never wrote.
  it("writes nothing where the source closed the line with no mark at all", () => {
    const title = `# text = 酒蟲
1\t酒\t酒\tNOUN\tn,名詞,可搬,糧食\t_\t2\tmod\t_\t_
2\t蟲\t蟲\tNOUN\tn,名詞,主体,動物\t_\t0\troot\t_\t_

# text = 長山
1\t長\t長\tADJ\tv,動詞,描写,量\tDegree=Pos|VerbForm=Part\t2\tmod\t_\tLineBreak=para
2\t山\t山\tNOUN\tn,名詞,固定物,地形\t_\t0\troot\t_\t_
`;
    expect(sentenceSeparator(parseConllu(title).sentences, 0)).toBe("");
    expect(prose(title)).toBe("酒の蟲\n　長山。");
  });
});

describe("a mark follows what the source put in front of it, wherever that is read", () => {
  // 無損其富； — 無 governs 損 and is read after it, so the ； hung off 損
  // sorted in ahead of 無 and the clause came out 其の富を損する、無く: the mark
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
    expect(generateKakikudashi(plan, resolve)).toBe("其の富を損する無く、一斗を飲まず");
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
    expect(generateKakikudashi(planFor(sentence), resolve)).toBe("縛を解き之を視る、赤肉にして備はる");
  });
});

describe("two 読点 never stand together, however reading order brings them", () => {
  // 移時、燥渴、思飲為極 (酒蟲). The source writes two medial 、, one after 時
  // and one after 渴, with 燥渴 between them. Rows as parser 0.3.1 returns
  // them, exported from the page.
  //
  // **This sentence no longer brings the two marks together, and it is the one
  // case measured worse by the anchor rule in `placeMarks`.** Reading order
  // lifts 燥渴 in front of 移; under the old anchor — the last token read out
  // of everything the source put before the mark — the first 、 followed 移し
  // and the two closed up, 移し、、飲むこと, which is what this case was
  // written for. The mark now takes the cut fewest tokens cross, and that cut
  // falls one slot earlier: holding it back past 燥渴 strands two post-mark
  // tokens ahead of it, while releasing it after 時を strands only 移.
  //
  // So the first 、 comes out after 時を, which is **wrong** — 時を is 移し's
  // object and nothing should divide them. It is kept here, asserted as it now
  // stands rather than quietly deleted, because the two sentences this rule has
  // to serve want opposite answers and this is the one that loses: 移時、 wants
  // the mark held back past the hoisted 燥渴, and 若決積水於千仞之谿者、形也
  // wants it released before the hoisted 若. No weighting of the two kinds of
  // crossing satisfies both — that was tried — so the corpus decides, and over
  // the corpus the new anchor is 822 passages closer against 89 further, this
  // among the 87. See `placeMarks` for the whole measurement.
  //
  // The collapse itself is untouched and is still exercised: `writeDeferredMarks`
  // below reaches it, and the run-adjacency rule fires on adjacency alone.
  const THIRST = `# text = 移時、燥渴、思飲為極。
1\t移\t移\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
2\t時\t時\tNOUN\tn,名詞,時,*\tCase=Tem\t1\tcomp:obj\t_\t_
3\t、\t、\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
4\t燥\t燥\tADJ\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t2\tconj:coord\t_\t_
5\t渴\t渴\tNOUN\tv,動詞,描写,境遇\t_\t4\tflat\t_\t_
6\t、\t、\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_
7\t思\t思\tVERB\tv,動詞,行為,動作\t_\t1\tparataxis\t_\t_
8\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t9\tsubj\t_\t_
9\t為\t爲\tAUX\tv,動詞,存在,存在\tVerbType=Cop\t7\tcomp:obj\t_\t_
10\t極\t極\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t9\tcomp:pred\t_\t_
11\t。\t。\tPUNCT\ts,記号,句点,*\t_\t9\tpunct\t_\t_
`;

  it("brings no two marks together, the anchor having separated them", () => {
    const out = prose(THIRST);
    expect(out).not.toContain("、、");
    expect(out).toBe("時を、燥渴す移し、飲むこと極と為し思ふ。");
  });

  it("keeps a lone medial 、 — the collapse is about a run, not about the mark", () => {
    // 青、取之於藍. One mark with text on both sides of it is the ordinary case
    // and must be untouched; the rule fires on adjacency and nothing else.
    expect(
      prose(`# text = 青、取之於藍。
1\t青\t青\tNOUN\tn,名詞,描写,形質\t_\t3\tsubj\t_\t_
2\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
3\t取\t取\tVERB\tv,動詞,行為,得失\t_\t0\troot\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\t_\t3\tcomp:obj\t_\t_
5\t於\t於\tADP\tv,前置詞,起点,*\t_\t6\tcase\t_\t_
6\t藍\t藍\tNOUN\tn,名詞,可搬,伝達\t_\t3\tudep@lmod\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_
`),
    ).toContain("青、");
  });

  it("keeps the 。 where a divider abuts one, not the 、", () => {
    // The asymmetry the rule turns on. A clause boundary standing inside a
    // sentence boundary *is* the sentence boundary. Reached through
    // `writeDeferredMarks`, which splices the 。 sentence 1 is owed past the 」
    // heading sentence 2 — and sentence 2 carries a medial 、 of its own right
    // behind that bracket.
    const out = prose(`# text = 曰：「無。
1\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t：\t：\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
3\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t4\tpunct\t_\t_
4\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t1\tcomp:obj\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_

# text = 」、然
1\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t0\troot\t_\t_
2\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
3\t然\t然\tADJ\tv,動詞,描写,態度\t_\t1\tparataxis\t_\t_
`);
    expect(out).not.toContain("。、");
    expect(out).not.toContain("、。");
    expect(out).toContain("。");
  });

  it("leaves a closing bracket beside a mark alone — 」。 is not a run", () => {
    // A bracket belongs to the clause it closes rather than standing between
    // two, which this file says twice already. It breaks a run rather than
    // joining one.
    expect(
      prose(`# text = 劉答言：「無。
1\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t2\tsubj\t_\t_
2\t答\t答\tVERB\tn,名詞,人,名\tNameType=Giv\t0\troot\t_\t_
3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t2\tconj:coord\t_\t_
4\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
5\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
6\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t3\tcomp:obj\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_

# text = 」
1\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t0\troot\t_\t_
`),
    ).toBe("劉答へ言ふ、「無し」と。");
  });
});

describe("燥渴 — one span reading, and one annotation to correct", () => {
  // The same sentence, and the reader's second question about it: the panel
  // labels 燥 VERB reading さう with no okurigana, and 渴 NOUN reading かつ + ス
  // — a verb ending on a noun, apparently crossed.
  //
  // **It is not crossed and it is not two faults.** 燥渴 is one fused span:
  // both members are `SPAN_FUSING_DEPS` neighbours, the span is read as a
  // Sino-Japanese compound さうかつ, and the サ変 ending is written once after
  // the *last* member — which is the same arrangement 俯臥せしむ is in. What the
  // panel shows is one word with one ending, split across two cells that
  // happen to carry different POS chips.
  //
  // **The annotation is a different matter and is the parser's.** Parser 0.3.1
  // returns 渴 as `NOUN` over the *verbal* xpos `v,動詞,描写,境遇`, attached by
  // plain `flat`. Gold has no such shape: over
  // `lzh_kyoto-sud-{train,dev,test}` all 8 渴 are VERB with that same verbal
  // xpos and none is a NOUN, 燥's three NOUN uses all carry the *nominal* xpos
  // `n,名詞,描写,形質` instead, and a NOUN dependent hanging off a VERB head by
  // plain `flat` occurs **0 times** against **5,370** VERB-on-VERB `flat@vv`.
  // The correct annotation is 渴 **VERB** `v,動詞,描写,境遇` on **`flat@vv`**
  // with head 燥 — the shape gold writes for 飢渴 three times over.
  const span = (deprel: string, pos: string) => `# text = 燥渴。
1\t燥\t燥\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
2\t渴\t渴\t${pos}\tv,動詞,描写,境遇\t_\t1\t${deprel}\t_\t_
3\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_
`;

  it("reads the span the same under the correct annotation as under the parser's", () => {
    // Which is why this is named rather than compensated for: the reading does
    // not depend on the fault. `flat@vv`'s own exclusion in `findCompoundSpans`
    // is for a *nominal-headed* one, and 燥 is a predicate (ADJ over a verbal
    // xpos), so the span forms either way and carries the same ending.
    expect(prose(span("flat@vv", "ADJ"))).toBe(prose(span("flat", "NOUN")));
  });

  it("writes one ending for the whole span, after its last member", () => {
    expect(prose(span("flat@vv", "ADJ"))).toBe("燥渴す。");
  });
});

// ---------------------------------------------------------------------------
// **Every mark that divides a sentence reaches the page as 、.** The reader's
// 學而時習之，不亦說乎？ lost its comma outright — 學びて時に之を習ひ亦說ばし
// からずや — while the same sentence written with 、 kept it.
//
// The cause was a set that had been right for a reason that stopped holding.
// `medialPunctuation` had a list of its own (、：；) which omitted ，, and that
// cost nothing for as long as ， was *also* sentence-final: a mark in that set
// is written by the join between two sentences rather than by the generator, so
// ， reached the page by the other route. Taking it out of `SENTENCE_FINAL_PUNCT`
// — because it divides a sentence rather than ending one — left it in neither
// set, and the generator dropped it.
//
// It also had the two panels disagreeing about one character, which is the
// failure mode this project keeps shared predicates for: the 訓読文 panel writes
// its marks through `japanesePunct`, which has always mapped every comma-class
// mark to 、, so it went on showing the comma the prose had lost.
// ---------------------------------------------------------------------------
describe("a medial mark is written wherever the source put one", () => {
  /** 學而時習之X不亦說乎, with the dividing mark swapped in — the shape a live
   * 0.3.2 parse returns, 說 tagged ADJ and the mark a `punct` child of 學. */
  const xueEr = (mark: string) => `# text = 學而時習之${mark}不亦說乎
1\t學\t學\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_
3\t時\t時\tNOUN\tn,名詞,時,*\tCase=Tem\t4\tmod@tmod\t_\t_
4\t習\t習\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
5\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t4\tcomp:obj\t_\t_
6\t${mark}\t${mark}\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
7\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t9\tmod\t_\t_
8\t亦\t亦\tADV\tv,副詞,話題,累加\t_\t9\tmod\t_\t_
9\t說\t說\tADJ\tv,動詞,描写,態度\tDegree=Pos\t1\tconj:coord\t_\t_
10\t乎\t乎\tPART\tp,助詞,句末,*\t_\t9\tdiscourse@sp\t_\t_
`;

  it("writes a ， exactly as it writes a 、", () => {
    expect(prose(xueEr("，"))).toBe("學びて時に之を習ひ、亦た說ばしからずや。");
    expect(prose(xueEr("，"))).toBe(prose(xueEr("、")));
  });

  it("writes the Western forms the same, since a source may use either", () => {
    // `punctuation.ts` carries both widths of each mark for exactly this
    // reason — a Literary Chinese text and a Western edition must classify
    // alike — and `medialPunctuation` now reads that one set.
    expect(prose(xueEr(","))).toBe(prose(xueEr("、")));
    expect(prose(xueEr("·"))).toBe(prose(xueEr("、")));
  });

  it("writes every medial mark as 、, and leaves the chain running across all but ：", () => {
    // A ； closed the chain in front of it until the reader withdrew the rule —
    // see `CLAUSE_CLOSING_MARKS`, which keeps the measurement that argued for it
    // and the instruction that took it out. A ； does not close a clause: it
    // marks material too closely bound to stand apart, so the form before it is
    // the 連用形 a ，/、 leaves, and 習 hands on rather than closing.
    for (const mark of ["；", ";", ":"]) {
      expect(prose(xueEr(mark))).toBe(prose(xueEr("、")));
    }
    // **The full-width ： is back in that set**, on the reader's ruling that
    // alignment with the received text decides and on its own measurement — 21
    // edits closer on the kanbun.info gold tier, level on the parser tier. So
    // the chain stops in front of one and 習 closes on the 終止形. The *mark* is
    // written 、 either way, which is this describe block's own subject and is
    // what the second assertion holds: only the form before it moves.
    expect(prose(xueEr("："))).toBe("學びて時に之を習ふ、亦た說ばしからずや。");
    expect(prose(xueEr("："))).not.toBe(prose(xueEr("、")));
  });
});
