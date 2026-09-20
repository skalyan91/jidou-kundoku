import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { LEXICON_SENSES, VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { findOverride } from "../src/reading/overridesLookup.ts";

/** **Which word a character is read as, for the four senses 論語 學而 turned
 * up.** Each is a *sense* correction and not a kana one: the character had a
 * real Japanese word attached to it and the wrong one of its words.
 *
 * The received readings are kanbun.info's (`keibu/rongo0101.html` …
 * `rongo0106.html`), which prints its furigana in modern kana; this app writes
 * 歴史的仮名遣い, so いきどお there is いきどほ here and that difference is not
 * one of these tests' business.
 *
 * Both panels are asserted for each: the 書き下し文 by the prose, and the 訓読文
 * by `furiganaFor` — the very function `KundokuView.ts` draws the reading over
 * the character with. A sense fixed in one panel and not the other is the
 * failure this file exists to make impossible. */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
/** The panels' own call shape — never the one-argument `findCompoundSpans`. */
const spansFor = (s: Sentence) => findCompoundSpans(s, { kanjidic, jmdict });
const prose = (s: Sentence): string => generateKakikudashi(computeReadingOrder(s, spansFor(s)), resolve).replace(/\s+/g, "");
const furigana = (s: Sentence, text: string): string | undefined =>
  furiganaFor(s.tokens.find((t) => t.text === text)!, s, resolve, historicalKana, kanjidic);

// ---------------------------------------------------------------------------
// 慍 is いきどほる, not うらむ
// ---------------------------------------------------------------------------

/** 人不知而不慍 — 學而 1, tokens 28-33 of the reader's own file, renumbered. */
const UNRESENTED = `# text = 人不知而不慍
1	人	人	NOUN	n,名詞,人,人	_	3	subj	_	_
2	不	不	ADV	v,副詞,否定,無界	Polarity=Neg	3	mod	_	_
3	知	知	VERB	v,動詞,行為,動作	_	3	root	_	_
4	而	而	CCONJ	p,助詞,接続,並列	_	6	cc	_	_
5	不	不	ADV	v,副詞,否定,無界	Polarity=Neg	6	mod	_	_
6	慍	慍	VERB	v,動詞,行為,態度	_	3	conj:coord	_	_
`;

describe("人知らずして慍らず — 慍 is 四段ラ行 いきどほる", () => {
  it("writes the 未然形 慍ら before the ず", () => {
    // うらむ is 恨/怨's word, and 上二段マ行 gave 慍み — a different word in a
    // different paradigm, so the ending moved with the sense.
    expect(prose(parsed(UNRESENTED))).toBe("人知らずして慍らず");
  });

  it("and the 訓読文 draws いきどほ over the character", () => {
    expect(furigana(parsed(UNRESENTED), "慍")).toBe("いきどほ");
  });

  it("keeps うらむ nowhere — the lexicon holds one sense for this character", () => {
    // Nothing survives behind it here, unlike 省 and 愛 below: 慍's entry is a
    // `RESIDUAL` gap-filler, Wiktionary having no entry for the character at
    // all, so correcting it replaces the only sense there was.
    expect(VERB_LEXICON["慍"]).toEqual({ conjClass: "yodan-ra", reading: "いきどほ" });
  });
});

// ---------------------------------------------------------------------------
// 省 is かへりみる, not はぶく — and はぶく stays reachable
// ---------------------------------------------------------------------------

/** 省吾身 — the object half of 學而 4's 吾日三省吾身. The adverbs are
 * `preHeadInvertOrder.test.ts`'s business; this is the verb's. */
const EXAMINE = `# text = 省吾身
1	省	省	VERB	v,動詞,行為,動作	_	1	root	_	_
2	吾	吾	PRON	n,代名詞,人称,起格	Person=1|PronType=Prs	3	det	_	_
3	身	身	NOUN	n,名詞,不可譲,身体	_	1	comp:obj	_	_
`;

describe("吾が身を省みる — 省 is 上一段 かへりみる", () => {
  it("writes 省みる, the reading kanbun.info prints かえり over", () => {
    expect(prose(parsed(EXAMINE))).toBe("吾が身を省みる");
  });

  it("and the 訓読文 draws かへり over the character, with み+る beside it", () => {
    // The word divides かへり + みる: `okuriganaPrefix` carries the み in front
    // of 上一段's own る, the same division 用 takes as もち + ゐる.
    expect(furigana(parsed(EXAMINE), "省")).toBe("かへり");
    expect(VERB_LEXICON["省"]).toEqual({ conjClass: "kami-ichidan", okuriganaPrefix: "み", reading: "かへり" });
  });

  it("keeps はぶく behind it rather than deleting it", () => {
    // 省刑罰, 省婦事, 當去奢省費 are that word and are roughly 18 of the gold's
    // 43 predicate uses against かへりみる's 22. What changed is which of the
    // two the page writes unasked; the other is still what the furigana menu
    // offers and what a hand-picked reading reaches.
    expect(LEXICON_SENSES["省"]).toContainEqual({ conjClass: "yodan-ka", reading: "はぶ" });
  });
});

// ---------------------------------------------------------------------------
// 愛 is 愛す, not 愛づ
// ---------------------------------------------------------------------------

/** 弗愛 — 孟子 盡心, gold. The arm with no object of its own: KANJIDIC2's
 * transitivity vote, asked about a 愛 that governs nothing, finds no
 * intransitive candidate among いと.しい / かな.しい / め.でる / お.しむ and
 * answers nothing at all, so the entry was always what this reached. The
 * object-taking arm is 汎愛眾 below, which the vote used to answer instead. */
const UNLOVED = `# text = 食而弗愛
1	食	食	VERB	v,動詞,行為,飲食	_	1	root	_	_
2	而	而	CCONJ	p,助詞,接続,並列	_	4	cc	_	_
3	弗	弗	ADV	v,副詞,否定,無界	Polarity=Neg	4	mod	_	_
4	愛	愛	VERB	v,動詞,行為,交流	_	1	conj:coord	_	_
`;

describe("食ひて愛せず — 愛 is サ変 愛す", () => {
  it("writes the 未然形 愛せ before the ず, where it wrote the adjective 愛しから", () => {
    expect(prose(parsed(UNLOVED))).toBe("食ひて愛せず");
  });

  it("and the character keeps its on'yomi あい", () => {
    expect(furigana(parsed(UNLOVED), "愛")).toBe("あい");
  });

  it("puts 愛す in the same paradigm as the 漢語 verbs beside it", () => {
    // A VERB with no lexicon entry of its own reaches `onyomiPairReading`'s サ変
    // and prints 忠す, 信す, 大破す. 愛 differs from those only in having an
    // entry, and the entry should not put it in a different conjugation.
    expect(VERB_LEXICON["愛"]).toEqual({ conjClass: "sa-hen", reading: "あい" });
    expect(LEXICON_SENSES["愛"]).toContainEqual({ conjClass: "shimo-nidan-da", reading: "め" });
  });
});

// ---------------------------------------------------------------------------
// 汎愛眾 is 汎く眾を愛す, not 眾を汎愛す
// ---------------------------------------------------------------------------

/** 汎愛眾 — 學而 6, tokens 18-20 of the reader's own file, renumbered. */
const BROADLY = `# text = 汎愛眾
1	汎	汎	ADV	v,動詞,行為,動作	VerbForm=Conv	2	mod	_	_
2	愛	愛	VERB	v,動詞,行為,交流	_	2	root	_	_
3	眾	衆	NOUN	n,名詞,人,役割	_	2	comp:obj	_	_
`;

describe("汎く眾を愛す — the lexical-word pair rule stood down by a curated entry", () => {
  it("does not fuse 汎愛 into one span", () => {
    // 汎愛 is a JMdict headword (はんあい) and 汎 stands as an adverbial `mod`
    // directly on 愛 — the 大破敵軍 shape `oneLexicalWordPair` fuses. What
    // stands it down is `curatedInRole`: a conditioned entry in
    // `overrides.json` speaks about the character in the very role it occupies.
    expect(spansFor(parsed(BROADLY))).toEqual([]);
    expect(findOverride("汎", "ADV", "mod")).toMatchObject({ reading: "ひろ", okurigana: "く" });
  });

  it("reads 汎く in front of the object, as the received text does", () => {
    // Fused, the pair travelled as one word behind 眾 and printed 眾を汎愛し;
    // the received reading is 汎く衆を愛して.
    //
    // **And the 愛 is 愛す, which is the half of this the vote used to answer.**
    // A 愛 *with an object* went to KANJIDIC2's transitivity vote — め.でる over
    // いと.しい — which returned `transitivitySelected` and so `beatsLexicon`,
    // standing the サ変 entry down before it was asked, and this line read
    // ひろく眾を愛づ. `curatedOnyomiWord` (`reading/kanjidicLookup.ts`) is what
    // holds the vote back now, and holds it back on the narrowest ground there
    // is: 愛す is 漢語 read on'yomi, so it was never one of the kun'yomi the
    // vote grades and the vote's answer refuted nothing. The vote must keep
    // outranking a curated entry whose word *is* one of its candidates — 出づ
    // against 出だす, 成る against 成す — and that doc carries the counts.
    expect(prose(parsed(BROADLY))).toBe("ひろく眾を愛す");
  });

  it("draws あい over the character in the 訓読文 too", () => {
    // The 書き下し文 above reads its 愛 through `VERB_LEXICON`; this is the
    // 訓読文 reading the same entry through `furiganaFor`, which is what
    // `KundokuView.ts` draws. It was め.
    expect(furigana(parsed(BROADLY), "愛")).toBe("あい");
  });

  it("leaves a VERB 汎 to KANJIDIC2, the tag being what separates the two", () => {
    // 漾漾汎菱荇 is ただよふ, and the entry is `contextPos: ["ADV"]` so that it
    // never claims that use — the arrangement 遂 and 惟 already have.
    expect(findOverride("汎", "VERB", "root")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// …and the vote keeps winning where the curated word is one of its candidates
// ---------------------------------------------------------------------------

/** 不出令 — 春秋左氏傳, gold `KR2b0041_007_par16_121-124#1`, verbatim. */
const NO_ORDER = `# text = 不出令。
1	不	不	ADV	v,副詞,否定,無界	Polarity=Neg	2	mod	_	_
2	出	出	VERB	v,動詞,行為,移動	_	0	root	_	_
3	令	令	NOUN	n,名詞,可搬,伝達	_	2	comp:obj	_	_
4	。	。	PUNCT	s,記号,句点,*	_	2	punct	_	_
`;

/** 不成器 — 禮記, gold `KR1d0052_018_par2_1-3#1`, verbatim. */
const UNMADE = `# text = 不成器；
1	不	不	ADV	v,副詞,否定,無界	Polarity=Neg	2	mod	_	_
2	成	成	VERB	v,動詞,行為,生産	_	0	root	_	_
3	器	器	NOUN	n,名詞,可搬,道具	_	2	comp:obj	_	_
4	；	；	PUNCT	s,記号,読点,*	_	2	punct	_	_
`;

/** The other side of `curatedOnyomiWord`, and the reason it asks about the
 * *word* rather than about curation. 出 and 成 are `RESIDUAL` lemmas exactly as
 * 愛 is — 出 is hand-stated 下二段ダ行 出づ, 成 四段ラ行 成る — and both of those
 * words are kun'yomi of their character, sitting on the very list the vote
 * grades, beside the transitive partner the vote picks. There the vote is not
 * answering past the entry but choosing between it and its own partner, on the
 * one piece of evidence that separates them, and as a *class* of entries it has
 * to keep winning: 出 carries a `comp:obj` on 406 of its 906 gold VERB tokens
 * and 成 on 280 of its 569. Yielding to curation as such moved 1,981 sentences
 * and printed 兵を出でもつて for 兵を出だす and 踊るを成る for 踊を成す.
 *
 * **成 still shows it; 出 no longer does, and that is a decision about one
 * character.** 出 has since been named in `SUPPLEMENTARY_KUN`
 * (reading/kanjidicLookup.ts), which stands the vote down for that lemma alone
 * — the same door 來 and 調 go through — so 不出令 now reads 令を出でず. It was
 * measured: over the kanbun.info corpus 出 reads 6 edits closer on the gold tier
 * and 50 closer on the parser tier, because the received text writes the
 * intransitive 出で/出づ four times as often as the transitive 出だす, and the 60
 * corpus tokens that do govern an object — this one among them — are what that
 * buys. So this test now records the cost rather than the rule, and 成, which
 * nothing has named, records the rule. */
describe("令を出づ, 器を成す — what the vote decides, and where a supplement outranks it", () => {
  it("reads the curated 出づ even where the 出 governs an object, the supplement having stood the vote down", () => {
    expect(prose(parsed(NO_ORDER))).toBe("令を出でず");
    expect(furigana(parsed(NO_ORDER), "出")).toBe("い");
  });

  it("keeps な.す over the curated 成る where the 成 governs an object", () => {
    expect(prose(parsed(UNMADE))).toBe("器を成さず");
    expect(furigana(parsed(UNMADE), "成")).toBe("な");
  });
});

// ---------------------------------------------------------------------------
// 懷 is おもふ, and いだく over a thing held
// ---------------------------------------------------------------------------

/** 君子懷刑、小人懷惠 — 論語 里仁 11, the kanbun.info parse of `rongo0411#1`,
 * second sentence. */
const CHERISHED = `# text = 君子懷刑、小人懷惠。
1	君子	君子	NOUN	n,名詞,人,役割	_	2	subj	_	_
2	懷	懷	VERB	v,動詞,行為,態度	_	0	root	_	_
3	刑	刑	NOUN	n,名詞,制度,儀礼	_	2	comp:obj	_	_
4	、	、	PUNCT	s,記号,読点,*	_	2	punct	_	_
5	小	小	ADJ	v,動詞,描写,量	Degree=Pos	6	mod	_	_
6	人	人	NOUN	n,名詞,人,人	_	7	subj	_	_
7	懷	懷	VERB	v,動詞,行為,態度	_	2	conj:coord	_	_
8	惠	惠	NOUN	n,名詞,描写,態度	_	7	comp:obj	_	_
9	。	。	PUNCT	s,記号,句点,*	_	7	punct	_	_
`;

/** 是以聖人被褐而懷玉 — 老子 70, the kanbun.info parse of `roushi70#2`. */
const HELD = `# text = 是以聖人、被褐而懷玉。
1	是	是	PRON	n,代名詞,指示,*	PronType=Dem	2	comp:obj	_	_
2	以	以	VERB	v,動詞,行為,動作	_	6	mod	_	_
3	聖	聖	NOUN	n,名詞,人,役割	_	4	mod	_	_
4	人	人	NOUN	n,名詞,人,人	_	6	subj	_	_
5	、	、	PUNCT	s,記号,読点,*	_	2	punct	_	_
6	被	被	VERB	v,動詞,行為,動作	_	0	root	_	_
7	褐	褐	NOUN	n,名詞,可搬,道具	_	6	comp:obj	_	_
8	而	而	CCONJ	p,助詞,接続,並列	_	9	cc	_	_
9	懷	懷	VERB	v,動詞,行為,態度	_	6	conj:coord	_	_
10	玉	玉	NOUN	n,名詞,可搬,道具	_	9	comp:obj	_	_
11	。	。	PUNCT	s,記号,句点,*	_	6	punct	_	_
`;

/** kanbun.info reads 君子懷德、小人懷土 as 徳を懐い、土を懐う, and なつかしむ never.
 * The transitivity vote took なつ.かしむ, the first transitive kun'yomi KANJIDIC2
 * lists; `SUPPLEMENTARY_KUN` settles おも.ふ ahead of it and `RESIDUAL` states
 * its paradigm. Over a `可搬` object the word is いだく (`OBJECT_CLASS_SENSES`). */
describe("刑を懷ひ, 玉を懷く — 懷 by what it takes", () => {
  it("reads おもふ over an abstract object, in both panels", () => {
    expect(prose(parsed(CHERISHED))).toBe("君子刑を懷ひ、小人惠を懷ふ");
    expect(furigana(parsed(CHERISHED), "懷")).toBe("おも");
  });

  it("reads いだく over a thing that can be carried", () => {
    expect(prose(parsed(HELD))).toBe("是を以て聖人、褐を被りて玉を懷く");
    expect(furigana(parsed(HELD), "懷")).toBe("いだ");
  });
});

// ---------------------------------------------------------------------------
// 奇 is き: the noun, and the ナリ predicate
// ---------------------------------------------------------------------------

/** 凡將正而無奇 — 李衛公問対, the kanbun.info parse of `montai08#6`, first
 * sentence. 奇 is an ADJ standing bare as the object of 無. */
const NO_SURPRISE = `# text = 凡將、正而無奇、則守將也。
1	凡	凡	ADV	v,動詞,描写,形質	Degree=Pos|VerbForm=Conv	4	mod	_	_
2	將	將	NOUN	n,名詞,人,役割	_	4	subj	_	_
3	、	、	PUNCT	s,記号,読点,*	_	1	punct	_	_
4	正	正	ADJ	v,動詞,描写,形質	Degree=Pos	0	root	_	_
5	而	而	CCONJ	p,助詞,接続,並列	_	6	cc	_	_
6	無	無	VERB	v,動詞,存在,存在	Polarity=Neg	4	conj:coord	_	_
7	奇	奇	ADJ	v,動詞,描写,態度	Degree=Pos	6	comp:obj	_	_
8	、	、	PUNCT	s,記号,読点,*	_	4	punct	_	_
9	則	則	ADV	v,副詞,時相,緊接	AdvType=Tim	10	mod	_	_
10	守	守	VERB	v,動詞,行為,動作	VerbForm=Part	4	conj:coord	_	_
11	將	將	NOUN	n,名詞,人,役割	_	10	comp:obj	_	_
12	也	也	PART	p,助詞,句末,*	_	10	discourse@sp	_	_
13	。	。	PUNCT	s,記号,句点,*	_	10	punct	_	_
`;

/** 二術爲奇 — the same text, `montai04#2`, trimmed to its last clause. 奇 is
 * tagged NOUN. */
const TWO_FOR_SURPRISE = `# text = 二術爲奇。
1	二	二	NUM	n,数詞,数字,*	_	2	mod	_	_
2	術	術	NOUN	n,名詞,可搬,伝達	_	3	subj	_	_
3	爲	爲	AUX	v,動詞,存在,存在	VerbType=Cop	0	root	_	_
4	奇	奇	NOUN	v,動詞,描写,態度	_	3	comp:pred	_	_
5	。	。	PUNCT	s,記号,句点,*	_	3	punct	_	_
`;

/** 能與人共之者仁也 — 六韜, the kanbun.info parse of `rikutou01#10`, second
 * sentence. 仁 is tagged NOUN and closed by 也. */
const BENEVOLENCE_IS = `# text = 能與人共之者仁也。
1	能	能	AUX	v,助動詞,可能,*	Mood=Pot	6	mod	_	_
2	與	與	ADP	v,前置詞,関係,*	_	4	mod	_	_
3	人	人	NOUN	n,名詞,人,人	_	2	comp:obj	_	_
4	共	共	VERB	v,動詞,行為,交流	_	1	comp:aux	_	_
5	之	之	PRON	n,代名詞,人称,止格	Person=3|PronType=Prs	4	comp:obj	_	_
6	者	者	PART	p,助詞,提示,*	_	7	subj	_	_
7	仁	仁	NOUN	v,動詞,描写,態度	_	0	root	_	_
8	也	也	PART	p,助詞,句末,*	_	7	discourse@sp	_	_
9	。	。	PUNCT	s,記号,句点,*	_	7	punct	_	_
`;

/** kanbun.info glosses 奇 き 87 times out of 87. See its `RESIDUAL` entry,
 * `pickKun` for the noun, `sinoNominalArgumentReading` for the bare argument,
 * and `repeatsPredicateCopula` for the なり a NOUN head keeps. */
describe("奇無く, 奇と爲す, 仁なり — a 漢語 ナリ word as a noun", () => {
  it("writes a bare ADJ 奇 in an object slot as the noun, with no なる", () => {
    expect(prose(parsed(NO_SURPRISE))).toContain("奇無く");
    expect(furigana(parsed(NO_SURPRISE), "奇")).toBe("き");
  });

  it("reads a NOUN 奇 on'yomi, not KANJIDIC2's くし", () => {
    expect(prose(parsed(TWO_FOR_SURPRISE))).toContain("奇と爲す");
    expect(furigana(parsed(TWO_FOR_SURPRISE), "奇")).toBe("き");
  });

  it("keeps the なり of 也 after a NOUN whose entry is a ナリ word", () => {
    expect(prose(parsed(BENEVOLENCE_IS))).toMatch(/仁なり$/);
  });
});
