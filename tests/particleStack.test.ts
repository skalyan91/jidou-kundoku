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
import { parseConllu } from "../src/parse/conlluParser.ts";
import { caseParticleFor } from "../src/kakikudashi/conjugationContext.ts";
import { stacksLegally, writtenCaseParticle } from "../src/kakikudashi/particleStack.ts";

// ---------------------------------------------------------------------------
// **One nominal, one slot marker.**
//
// The reader: *"I'm seeing 者はを; make sure we don't get ungrammatical
// sequences of particles."* This pins the guard that answers it — see
// `particleStack.ts` for the argument, and for the census the counts below
// come from (the whole of kanbun.info's prose, 3,419 passages).
//
// Trees are written out rather than parsed live, as the neighbouring test
// files do: the shape is what is under test. Each is the gold parse of the
// passage named, taken from the Kyoto SUD treebank.
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
// 1. The closed list — which two-particle sequences classical Japanese has.
// ---------------------------------------------------------------------------

describe("the stacks classical Japanese writes", () => {
  it("admits a 係助詞 or 副助詞 after an adverbial 格助詞", () => {
    // をば, には, とは, にて, にも, をも, and 副助詞 のみ/ばかり after a case
    // particle — the list the reader gave, and the one `stacksLegally` states.
    for (const [first, second] of [
      ["を", "ば"], ["に", "は"], ["と", "は"], ["に", "て"], ["に", "も"],
      ["を", "も"], ["を", "のみ"], ["に", "のみ"], ["を", "ばかり"], ["と", "も"],
      ["に", "ぞ"], ["を", "こそ"], ["より", "は"], ["へ", "は"],
    ] as const) {
      expect(stacksLegally(first, second), `${first}${second}`).toBe(true);
    }
  });

  it("refuses a 格助詞 after a 格助詞, anything after a 係助詞, and anything after の/が", () => {
    for (const [first, second] of [
      // 格助詞 + 格助詞 — 縲絏をの中, 犬馬をに至る, 卒にを, 徒にの.
      ["を", "の"], ["を", "に"], ["を", "と"], ["を", "が"],
      ["に", "を"], ["に", "の"], ["に", "が"], ["に", "に"], ["と", "の"],
      // 係助詞 + anything — 者はを, 者はは, 者はの, 衆しはと.
      ["は", "を"], ["は", "に"], ["は", "の"], ["は", "と"], ["は", "は"],
      // the adnominal の/が, which finishes no phrase and binds nothing — 兵家のは.
      ["の", "は"], ["の", "も"], ["が", "は"], ["の", "を"], ["が", "を"],
    ] as const) {
      expect(stacksLegally(first, second), `${first}${second}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The token's own reading has already marked the slot.
// ---------------------------------------------------------------------------

describe("a word whose own reading wrote the particle", () => {
  // 論語 為政 7. 者 heads the topic 今之孝者 and reads は, and `caseParticleFor`
  // marked the slot を on top of it: 今の孝**はを**、是れ能く養ふを謂ふ — the
  // reader's own 者はを. The は is right (者 is the topic marker) and the を is
  // what goes.
  const jinzhixiao = sentenceOf(`
1	今	今	NOUN	n,名詞,時,*	Case=Tem	2	comp:obj	_	_
2	之	之	SCONJ	p,助詞,接続,属格	_	3	mod	_	_
3	孝	孝	NOUN	n,名詞,描写,態度	_	4	mod	_	_
4	者	者	PART	p,助詞,提示,*	_	7	subj	_	_
5	，	，	PUNCT	s,記号,読点,*	_	4	punct	_	_
6	是	是	PRON	n,代名詞,指示,*	PronType=Dem	7	comp@expl	_	_
7	謂	謂	VERB	v,動詞,行為,伝達	_	0	root	_	_
8	能	能	AUX	v,助動詞,可能,*	Mood=Pot	7	comp:obj	_	_
9	養	養	VERB	v,動詞,行為,動作	_	8	comp:aux	_	_
10	。	。	PUNCT	s,記号,句点,*	_	7	punct	_	_
`);

  it("keeps the reading's は on 者 and drops the case particle after it", () => {
    expect(prose(jinzhixiao)).not.toContain("者はを");
    expect(prose(jinzhixiao)).toContain("今の孝は");
    // The relation still wants a を. It is this guard, and not `caseParticleFor`,
    // that withholds it — the two answer different questions, and
    // `readingResolver.ts` goes on asking the first one.
    const plan = computeReadingOrder(jinzhixiao, findCompoundSpans(jinzhixiao));
    expect(caseParticleFor(named(jinzhixiao, "者"), jinzhixiao)).toBe("を");
    expect(writtenCaseParticle(named(jinzhixiao, "者"), plan, resolve)).toBeUndefined();
  });

  // 論語 季氏 9. The same 者, on `subj`, where the particle the relation wanted
  // was the topic は itself: 之を知る者**はは**上なり — the largest single class
  // in the census at 74 instances, and one the reader's own scan (係助詞 followed
  // by 格助詞) did not reach.
  it("does not write は twice on one 者", () => {
    const shengEr = sentenceOf(`
1	生	生	VERB	v,動詞,変化,生物	_	5	mod	_	_
2	而	而	CCONJ	p,助詞,接続,並列	_	3	cc	_	_
3	知	知	VERB	v,動詞,行為,動作	_	1	conj:coord	_	_
4	之	之	PRON	n,代名詞,人称,止格	Person=3|PronType=Prs	3	comp:obj	_	_
5	者	者	PART	p,助詞,提示,*	_	6	subj	_	_
6	上	上	NOUN	n,名詞,固定物,関係	Case=Loc	0	root	_	_
7	也	也	PART	p,助詞,句末,*	_	6	discourse@sp	_	_
8	。	。	PUNCT	s,記号,句点,*	_	6	punct	_	_
`);
    expect(prose(shengEr)).not.toContain("はは");
    expect(prose(shengEr)).toContain("者は上なり");
  });
});

// ---------------------------------------------------------------------------
// 3. The next word read is itself a particle.
// ---------------------------------------------------------------------------

describe("a word standing in front of a particle", () => {
  // 論語 公冶長 1. 縲 is the `comp:obj` of the genitive 之, so the coordination
  // put a を on 絏 and 之 then wrote its own の: 縲絏**をの**中に在り, 119
  // instances over the corpus and the largest class the reader reported. A word
  // in front of a genitive 之 is not the head of its phrase and carries none of
  // the phrase's marking.
  const leixie = sentenceOf(`
1	雖	雖	ADV	v,副詞,判断,逆接	_	2	mod	_	_
2	在	在	VERB	v,動詞,存在,存在	_	0	root	_	_
3	縲	縲	NOUN	n,名詞,可搬,道具	_	5	comp:obj	_	_
4	絏	絏	NOUN	n,名詞,可搬,道具	_	3	conj:coord	_	_
5	之	之	SCONJ	p,助詞,接続,属格	_	6	mod	_	_
6	中	中	NOUN	n,名詞,固定物,関係	Case=Loc	2	comp:obj	_	_
7	。	。	PUNCT	s,記号,句点,*	_	2	punct	_	_
`);

  it("drops the case particle before a genitive 之", () => {
    expect(prose(leixie)).not.toContain("をの");
    expect(prose(leixie)).toContain("縲絏の中");
  });

  // 論語 為政 7. 犬 is the object of the preposition 於, 馬 its coordinand; the
  // に is 於's and the を was the coordinand's — 犬馬**をに**至る, 43 instances.
  it("drops the case particle before a preposition's own に", () => {
    const zhiyu = sentenceOf(`
1	至	至	VERB	v,動詞,行為,移動	_	0	root	_	_
2	於	於	ADP	v,前置詞,基盤,*	_	1	comp:obl	_	_
3	犬	犬	NOUN	n,名詞,主体,動物	_	2	comp:obj	_	_
4	馬	馬	NOUN	n,名詞,主体,動物	_	3	conj:coord	_	_
5	。	。	PUNCT	s,記号,句点,*	_	1	punct	_	_
`);
    expect(prose(zhiyu)).not.toContain("をに");
    expect(prose(zhiyu)).toContain("犬馬に至る");
  });
});

// ---------------------------------------------------------------------------
// 4. What the guard must NOT take away.
// ---------------------------------------------------------------------------

describe("the stacks that stay", () => {
  // 論語 為政 6. **をのみ is grammatical** — を marks the slot and のみ limits
  // what is in it — and it was one of the 120 をの the raw scan turned up. A
  // guard that banned two particles in a row rather than checking the pair
  // against a list would delete it.
  it("leaves をのみ alone", () => {
    const jizhi = sentenceOf(`
1	父	父	NOUN	n,名詞,人,関係	_	7	subj	_	_
2	母	母	NOUN	n,名詞,人,関係	_	1	flat	_	_
3	唯	唯	ADV	v,副詞,範囲,限定	_	7	mod	_	_
4	其	其	PRON	n,代名詞,人称,起格	Person=3|PronType=Prs	5	det	_	_
5	疾	疾	NOUN	n,名詞,不可譲,疾病	_	7	comp:obj	_	_
6	之	之	PRON	n,代名詞,人称,止格	Person=3|PronType=Prs	7	comp@expl	_	_
7	憂	憂	VERB	v,動詞,行為,態度	_	0	root	_	_
8	。	。	PUNCT	s,記号,句点,*	_	7	punct	_	_
`);
    expect(prose(jizhi)).toContain("疾をのみ");
  });

  // 論語 為政 11, and the boundary this guard shares with
  // `ownReadingSuppliesCaseParticle`: 故 is read ゆゑ**に** by an override entry
  // whose context conditions are too wide for the noun 故 "the old", and the を
  // written after it is the *right* particle on a wrong word (故きを溫ねて). So
  // the stack stays: the content-word exclusion leaves it standing, and the
  // correction belongs to that entry in `overrides.json`. 29 instances over the
  // corpus, on 故, 徒 and 卒. Withholding the を moved this very passage away
  // from the received reading, which is the measurement the exclusion predicts.
  it("leaves a content word's stack for overrides.json to fix", () => {
    const wengu = sentenceOf(`
1	溫	溫	VERB	v,動詞,変化,態度	_	0	root	_	_
2	故	故	NOUN	n,名詞,時,*	_	1	comp:obj	_	_
3	。	。	PUNCT	s,記号,句点,*	_	1	punct	_	_
`);
    const plan = computeReadingOrder(wengu, findCompoundSpans(wengu));
    expect(writtenCaseParticle(named(wengu, "故"), plan, resolve)).toBe("を");
  });
});
