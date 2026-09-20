import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import { classifyToken } from "../src/kundoku/depClassification.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";

/** **A clausal complement the reader reaches only across a pause mark is read
 * where it stands, and the governor closes in front of it.**
 *
 * A 返読 crosses characters, not clauses. Where the editor has put a 、 between
 * a verb and the predicate hung off it as `comp:obj`/`comp:pred`, what follows
 * the mark is a fresh predication, and the received reading says the governor
 * first: over the kanbun.info corpus, of the 784 such arcs whose order can be
 * read off the received 書き下し文 unambiguously, **775 read the governor first
 * and 9 the clause**. With no mark between them the same count is 592 against
 * 1,466 — the ordinary return, which is left exactly as it was. The table, the
 * nine counterexamples and why the condition carries no distance floor are in
 * `depClassification.ts`'s `isClausalComplementAcrossPause`.
 *
 * **What this was fixing.** Parser 0.3.5 joins two parser sentences with no
 * punctuation between them, which is right and which exposed this: a joined
 * clause is attached to a governor far to its left, and the whole clause was
 * then inverted in front of that governor. 六韜 59 is the worst of them — a
 * clause headed by 如, forty tokens from the 欲 it hangs off, was moved in
 * front of 欲す and carried eight other clauses with it. Over the whole corpus
 * the rule is **2,977 edits**, 470 passages read better and 37 worse.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
/** The panels' own call shape — `findCompoundSpans(sentence, { kanjidic, jmdict })`,
 * never the one-argument form, which renders a different app. */
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve).replace(/\s+/g, "");
const orderText = (s: Sentence): string => {
  const byId = new Map(s.tokens.map((t) => [t.id, t.text]));
  return planFor(s)
    .order.map((id) => byId.get(id))
    .join("");
};

/** 學也、祿在其中矣。 — 衞靈公 31, kanbun.info's own text and its 0.3.5 parse.
 * 在(5) is the `comp:obj` of 學(1) with the 、(3) between them, and the received
 * reading is 学ぶや、禄其の中に在り: the studying is said, and then where the
 * stipend is. */
const STUDY = `# text = 學也、祿在其中矣。
1	學	學	VERB	v,動詞,行為,動作	_	1	root	_	_
2	也	也	PART	p,助詞,句末,*	_	1	discourse@sp	_	_
3	、	、	PUNCT	s,記号,読点,*	_	1	punct	_	_
4	祿	祿	NOUN	n,名詞,可搬,成果物	_	5	subj	_	_
5	在	在	VERB	v,動詞,存在,存在	_	1	comp:obj	_	_
6	其	其	PRON	n,代名詞,人称,起格	Person=3|PronType=Prs	7	det	_	_
7	中	中	NOUN	n,名詞,固定物,関係	Case=Loc	5	comp:obj	_	_
8	矣	矣	PART	p,助詞,句末,*	_	5	discourse@sp	_	_
9	。	。	PUNCT	s,記号,句点,*	_	5	punct	_	_
`;

/** The same tree with the editor's mark and the 也 taken out, which is the
 * control: nothing else about the arc has changed, so whatever moves is the
 * mark's doing. */
const STUDY_UNMARKED = `# text = 學祿在其中矣。
1	學	學	VERB	v,動詞,行為,動作	_	1	root	_	_
2	祿	祿	NOUN	n,名詞,可搬,成果物	_	3	subj	_	_
3	在	在	VERB	v,動詞,存在,存在	_	1	comp:obj	_	_
4	其	其	PRON	n,代名詞,人称,起格	Person=3|PronType=Prs	5	det	_	_
5	中	中	NOUN	n,名詞,固定物,関係	Case=Loc	3	comp:obj	_	_
6	矣	矣	PART	p,助詞,句末,*	_	3	discourse@sp	_	_
7	。	。	PUNCT	s,記号,句点,*	_	3	punct	_	_
`;

describe("學也、祿在其中矣 — the clause behind the mark stays where it is", () => {
  it("reads 在 after 學 and not in front of it", () => {
    expect(orderText(parsed(STUDY))).toBe("學也、祿其中在矣。");
  });

  it("…so the 書き下し文 says the studying first, which is the received reading", () => {
    // 学ぶや、禄其の中に在り is kanbun.info's. The 也 is read なり here and や
    // there, which is a different rule's business and is not what this pins.
    expect(prose(parsed(STUDY))).toBe("學ぶなり、祿其の中に在り");
  });

  it("writes no kaeriten, because nothing is returned to", () => {
    // The whole of the 訓読文's side of this: a mark states "the material below
    // is read before this character", and 學 no longer reaches below the 、 for
    // anything. `returningOrders` in reorderEngine.ts writes a mark for an
    // INVERT child only, so the panel needed no change of its own.
    // 在's own object 中 still returns to it — that arc has no mark across it
    // and is untouched. What has gone is the group that took 學 back over the
    // whole clause behind the 、, and with it 學's numeral.
    const plan = planFor(parsed(STUDY));
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toEqual([[6, 4]]); // 中, then 在
    const marks = assignKundokuTen(plan);
    expect(marks.has(0)).toBe(false); // 學 — no mark at all
    expect(marks.get(4)).toEqual({ tier: "ichi-ni", rank: 2 }); // 在㆓, over 其中
    expect(marks.get(6)).toEqual({ tier: "ichi-ni", rank: 1 }); // 中㆒
  });

  it("and the marks alone recover that same order", () => {
    // Where the two panels are held to one answer: what the 訓読文 draws has to
    // trace the order the 書き下し文 was written from — here, straight on.
    const s = parsed(STUDY);
    const plan = planFor(s);
    assignKundokuTen(plan);
    const marks = buildPlainKuntenMarks(plan);
    const maxId = Math.max(...s.tokens.map((t) => t.id));
    const kuntens = Array.from({ length: maxId + 1 }, (_, id) => marks.get(id));
    const byId = new Map(s.tokens.map((t) => [t.id, t]));
    const isPunct = (id: number) => byId.get(id)?.dep === "punct";
    expect(executeKunten(kuntens, isPunct).filter((id) => byId.has(id))).toEqual(plan.order);
  });

  it("still returns over the identical clause once the mark is gone", () => {
    // The control. Same relation, same governor, same complement — 在 inverts,
    // 學 takes it as a nominalized object and `caseParticleFor` writes the を.
    expect(prose(parsed(STUDY_UNMARKED))).toBe("祿其の中に在るを學ぶ");
    // The group 學 no longer has in the marked tree: 祿其中在, then 學.
    expect(planFor(parsed(STUDY_UNMARKED)).spliceGroups.map((g) => g.rankTokenIds)).toEqual([
      [4, 2], // 中, then 在
      [2, 0], // 在's whole clause, then 學
    ]);
  });
});

/** 冉有曰、夫子欲之、吾二臣者、皆不欲也。 — 季氏 1, kanbun.info's text and its
 * 0.3.5 parse, verbatim. 欲(16) is the `comp:obj` of 欲(6) across two marks and
 * ten tokens, and the received reading is 夫子之を欲す、吾が二臣の者は、皆欲せざる
 * なり — the wanting is said, then who does not want it. This is 六韜 59's shape
 * at a length short enough to write out. */
const WANTED = `# text = 冉有曰、夫子欲之、吾二臣者、皆不欲也。
1	冉	冉	PROPN	n,名詞,人,姓氏	NameType=Sur	3	subj	_	_
2	有	有	PROPN	n,名詞,人,名	NameType=Giv	1	flat	_	_
3	曰	曰	VERB	v,動詞,行為,伝達	_	0	root	_	_
4	、	、	PUNCT	s,記号,読点,*	_	3	punct	_	_
5	夫子	夫子	NOUN	n,名詞,人,人	_	6	subj	_	_
6	欲	欲	VERB	v,動詞,行為,動作	_	3	comp:obj	_	_
7	之	之	PRON	n,代名詞,人称,止格	Person=3|PronType=Prs	6	comp:obj	_	_
8	、	、	PUNCT	s,記号,読点,*	_	6	punct	_	_
9	吾	吾	PRON	n,代名詞,人称,起格	Person=1|PronType=Prs	11	det	_	_
10	二	二	NUM	n,数詞,数字,*	_	11	mod	_	_
11	臣	臣	NOUN	n,名詞,人,役割	_	12	comp:obj	_	_
12	者	者	PART	p,助詞,提示,*	_	16	subj	_	_
13	、	、	PUNCT	s,記号,読点,*	_	12	punct	_	_
14	皆	皆	ADV	v,副詞,範囲,総括	_	16	mod	_	_
15	不	不	ADV	v,副詞,否定,無界	Polarity=Neg	16	mod	_	_
16	欲	欲	VERB	v,動詞,行為,動作	_	6	comp:obj	_	_
17	也	也	PART	p,助詞,句末,*	_	16	discourse@sp	_	_
18	。	。	PUNCT	s,記号,句点,*	_	16	punct	_	_
`;

describe("夫子欲之、吾二臣者、皆不欲也 — a governor ten tokens back", () => {
  it("leaves the whole 皆不欲 clause where the source has it", () => {
    // Before this rule the reading order carried 皆不欲也 and its subject 吾二臣者
    // in front of 欲 — 夫子皆欲せざるなり吾が二臣を者之を欲す — which is the fault
    // in miniature.
    expect(orderText(parsed(WANTED))).toBe("冉有曰、夫子之欲、吾二臣者、皆欲不也。");
  });

  it("closes the governor before the mark and writes no を after the clause", () => {
    // **The particle matters as much as the order.** A nominalized object takes
    // 連体形 + を, and with the clause standing behind the mark that を would
    // have landed ten tokens after the verb it belongs to. It is
    // `isNominalizedObjectPredicate` that writes it, and that rule stands down
    // here, so the clause closes on its own ending instead.
    //
    // 欲**し** and not the received 欲**す**: the governor is non-final in its
    // own sentence and takes 連用中止法, which is the corpus's majority answer
    // for this slot (worth 74 edits over the 915 passages that hold an arc of
    // this shape) and is not what kanbun.info writes here. The remaining
    // differences — 臣**を**者 for 臣**の**者**は**, and the closing と — belong
    // to other rules and are not this one's to fix.
    expect(prose(parsed(WANTED))).toBe("冉有曰く、夫子之を欲し、吾が二臣を者、皆欲せざるなりと");
  });
});

describe("classifyToken: the mark is the whole of the condition", () => {
  const sentenceOf = (conllu: string) => parsed(conllu);
  const kid = (s: Sentence, id: number) => s.tokens.find((t) => t.id === id)!;
  const gov = (s: Sentence, t: { head: number }) => s.tokens.find((x) => x.id === t.head)!;

  it("reads a predicate complement behind a 、 in place", () => {
    const s = sentenceOf(STUDY);
    const zai = kid(s, 4); // `parseConllu` numbers from 0: 在 is token 5 in the file
    expect(zai.text).toBe("在");
    expect(classifyToken(zai, gov(s, zai), s)).toBe("no-invert");
  });

  it("inverts the same complement with no mark between", () => {
    const s = sentenceOf(STUDY_UNMARKED);
    const zai = kid(s, 2);
    expect(zai.text).toBe("在");
    expect(classifyToken(zai, gov(s, zai), s)).toBe("invert");
  });

  it("leaves a nominal object alone, mark or no mark", () => {
    // A NOUN there is a name or an object and returns like any other object —
    // the exclusion `isSpeechComplement` already makes, for its reason. 中 is
    // 在's own `comp:obj` and has a 、 four tokens behind it.
    const s = sentenceOf(STUDY);
    const zhong = kid(s, 6);
    expect(zhong.text).toBe("中");
    expect(classifyToken(zhong, gov(s, zhong), s)).toBe("invert");
  });
});
