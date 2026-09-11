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
