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
import { caseParticleFor, readsWithDativeObject } from "../src/kakikudashi/conjugationContext.ts";

// ---------------------------------------------------------------------------
// **The particle and the reading are one decision.**
//
// The reader's rule: 入's object takes を where the verb is read transitively
// and に where it is read intransitively — 之**を**入る against 門**に**入る. The
// app was taking that decision twice and from two premises. `hasObject` in
// `readingResolver.ts` answered the transitivity question off the tree alone
// (an object means the transitive kun, so any 入 with a `comp:obj` was 下二段
// 入る, "to put in"), while `DATIVE_OBJECT_LEMMAS` in `conjugationContext.ts`
// wrote the particle. The two disagreed on every one of these verbs: 入太廟
// came out 太廟**に**入れ, a dative complement on a transitive paradigm, which
// is neither of the two readings the rule names.
//
// **Which half moves is the received text's to settle, not preference's.** Over
// kanbun.info's 121 occurrences of 入 the site writes the intransitive 四段
// everywhere but two (入りて, 入らず, 入れば) and puts に in front of it 72 times;
// the two transitive ones are 之**を**入れ and 糧**を**罰し入れて, where the
// `comp:obj` is a theme and not a goal, and no tag in the treebank separates
// those from 門. So the reading follows the particle: a verb whose complement
// this app marks に is being read intransitively, and `readsWithDativeObject`
// is what says so to the transitivity question.
//
// Both panels are asserted for each verb — the 書き下し文 by the prose, and the
// 訓読文 by `furiganaFor` plus the conjugation class the 訓読文's own okurigana
// is conjugated by (`pickedEnding` inflects by exactly this class). A paradigm
// fixed in one panel and not the other is the failure this file exists to make
// impossible.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string, n = 0): Sentence => parseConllu(text).sentences[n];
const spansFor = (s: Sentence) => findCompoundSpans(s, { kanjidic, jmdict });
const prose = (s: Sentence): string =>
  generateKakikudashi(computeReadingOrder(s, spansFor(s)), resolve).replace(/\s+/g, "");
const tokenOf = (s: Sentence, text: string): Sentence["tokens"][number] => s.tokens.find((t) => t.text === text)!;
const furigana = (s: Sentence, text: string): string | undefined =>
  furiganaFor(tokenOf(s, text), s, resolve, historicalKana, kanjidic);
const classOf = (s: Sentence, text: string): string | undefined => {
  spansFor(s);
  return resolve(tokenOf(s, text), s)?.conjClass;
};

// ---------------------------------------------------------------------------
// 入太廟 — 太廟に入りて, not 太廟に入れ
// ---------------------------------------------------------------------------

/** 論語 郷党 14, gold (`KR1h0004_010_par21_sj1`). The place is 入's own
 * `comp:obj`, which is the relation the goal of a motion verb arrives on in
 * this treebank, and the one 之 arrives on in 開入之 too. */
const ENTER_TEMPLE = `# text = 入太廟，毎事問。
1	入	入	VERB	v,動詞,行為,移動	_	0	root	_	_
2	太	太	ADJ	v,動詞,描写,量	Degree=Pos|VerbForm=Part	3	mod	_	_
3	廟	廟	NOUN	n,名詞,固定物,建造物	Case=Loc	1	comp:obj	_	_
4	，	，	PUNCT	s,記号,読点,*	_	1	punct	_	_
5	毎	每	ADJ	v,動詞,描写,形質	Degree=Pos|VerbForm=Part	6	mod	_	_
6	事	事	NOUN	n,名詞,可搬,成果物	_	7	comp:obj	_	_
7	問	問	VERB	v,動詞,行為,伝達	_	1	parataxis	_	_
8	。	。	PUNCT	s,記号,句点,*	_	7	punct	_	_
`;

describe("太廟に入る — 入 with a に-marked complement is 四段, not 下二段", () => {
  it("writes the 四段 連用形 入り, which kanbun.info prints as 太廟に入りて", () => {
    // 下二段 入る is 入れ in this slot, and 太廟**に**入れ was what the two
    // premises between them produced.
    expect(prose(parsed(ENTER_TEMPLE))).toContain("太廟に入り");
  });

  it("marks the complement に, unchanged — the particle is what the reading now follows", () => {
    const s = parsed(ENTER_TEMPLE);
    expect(caseParticleFor(tokenOf(s, "廟"), s)).toBe("に");
  });

  it("and the 訓読文 draws い over the character on the 四段 paradigm", () => {
    // The reading slot never moved: 入る and 入る are both い, which is why the
    // reading ratchet cannot see this defect and the class had to be asserted.
    const s = parsed(ENTER_TEMPLE);
    expect(furigana(s, "入")).toBe("い");
    expect(classOf(s, "入")).toBe("yodan-ra");
  });
});

// ---------------------------------------------------------------------------
// 禍及國 — 国に及ぶ, not 国に及ぼす
// ---------------------------------------------------------------------------

/** 三略 上略, the last of its 則 chain. kanbun.info: 禍、国に及ぶ. */
const CALAMITY_REACHES = `# text = 禍及國。
1	禍	禍	NOUN	n,名詞,可搬,成果物	_	2	subj	_	_
2	及	及	VERB	v,動詞,行為,移動	_	0	root	_	_
3	國	國	NOUN	n,名詞,主体,集団	_	2	comp:obj	_	_
4	。	。	PUNCT	s,記号,句点,*	_	2	punct	_	_
`;

describe("國に及ぶ — 及 is およぶ, not the transitive およぼす", () => {
  it("writes 及ぶ in both the prose and the 訓読文's own reading", () => {
    const s = parsed(CALAMITY_REACHES);
    expect(prose(s)).toBe("禍國に及ぶ");
    expect(furigana(s, "及")).toBe("およ");
    expect(resolve(tokenOf(s, "及"), s)?.okurigana).toBe("ぶ");
  });
});

// ---------------------------------------------------------------------------
// 親仁 — 仁に親しむ, not the adjective 親し
// ---------------------------------------------------------------------------

/** 論語 學而 6's 汎愛衆而親仁. kanbun.info: 汎く衆を愛して仁に親しみ. */
const DRAW_NEAR = `# text = 汎愛衆而親仁
1	汎	汎	ADV	v,動詞,行為,動作	VerbForm=Conv	2	mod	_	_
2	愛	愛	VERB	v,動詞,行為,交流	_	0	root	_	_
3	衆	衆	NOUN	n,名詞,人,役割	_	2	comp:obj	_	_
4	而	而	CCONJ	p,助詞,接続,並列	_	5	cc	_	_
5	親	親	VERB	v,動詞,行為,態度	_	2	conj:coord	_	_
6	仁	仁	NOUN	n,名詞,描写,態度	_	5	comp:obj	_	_
`;

describe("仁に親しむ — 親 is the verb したしむ, not the adjective したし", () => {
  it("writes 親しみ where the app wrote the adjective's 親しく", () => {
    // 親 carries an adjective kun (した.しい) beside the verb, so it reaches the
    // transitivity question through the object-overrides-the-adjective gate —
    // which is why that gate goes on asking the plain syntactic `hasObject`
    // and only the *answer* is narrowed. Narrowing the gate too would have
    // withdrawn the question here and read the adjective.
    // The clause ends here, so the 終止形 親しむ stands where the site's own
    // longer sentence takes the 連用形 親しみ; both are したしむ and neither is
    // the adjective. 汎's ひろく is a different rule's business.
    const s = parsed(DRAW_NEAR);
    expect(prose(s)).toContain("仁に親しむ");
    expect(resolve(tokenOf(s, "親"), s)?.okurigana).toBe("しむ");
  });
});

// ---------------------------------------------------------------------------
// 加諸我 — 我に加ふ stays 下二段, and this is the exception that proves the rule
// ---------------------------------------------------------------------------

/** 論語 公冶長 11, gold. 加's `comp:obj` is the *recipient* 我 and its theme 諸
 * stands `comp:obl` beside it — so the に is a goal, the verb is transitive all
 * the same, and the coupling this file is about does not hold. See
 * `DATIVE_GOAL_TRANSITIVE_LEMMAS`. */
const ADD_TO_ME = `# text = 我不欲人之加諸我也
1	我	我	PRON	n,代名詞,人称,止格	Person=1|PronType=Prs	3	subj	_	_
2	不	不	ADV	v,副詞,否定,無界	Polarity=Neg	3	mod	_	_
3	欲	欲	VERB	v,動詞,行為,動作	_	0	root	_	_
4	人	人	NOUN	n,名詞,人,人	_	5	comp:obj	_	_
5	之	之	SCONJ	p,助詞,接続,属格	_	6	subj	_	_
6	加	加	VERB	v,動詞,行為,得失	_	3	comp:obj	_	_
7	諸	諸	PRON	n,代名詞,人称,他	PronType=Prs	6	comp:obl	_	_
8	我	我	PRON	n,代名詞,人称,止格	Person=1|PronType=Prs	6	comp:obj	_	_
9	也	也	PART	p,助詞,句末,*	_	6	discourse@sp	_	_
`;

describe("諸を我に加ふ — 加's に is a goal, so its reading stays transitive", () => {
  it("keeps 加 out of the coupling, and keeps the に it always had", () => {
    const s = parsed(ADD_TO_ME);
    expect(readsWithDativeObject(tokenOf(s, "加"))).toBe(false);
    expect(caseParticleFor(s.tokens[7], s)).toBe("に");
  });

  it("goes on reading the 下二段 くはふ, which is what the site prints", () => {
    // The site writes the 下二段 加ふ 35 times, 21 of them after a に, against
    // the 四段 加はる twice. Applied to 加 the coupling cost 21 forms and 26 edits.
    const s = parsed(ADD_TO_ME);
    expect(resolve(tokenOf(s, "加"), s)?.okurigana).toBe("える");
    expect(prose(s)).toContain("加ふる");
  });

  it("and 入 is inside it, which is the contrast the rule turns on", () => {
    const s = parsed(ENTER_TEMPLE);
    expect(readsWithDativeObject(tokenOf(s, "入"))).toBe(true);
  });
});
