import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import { caseParticleFor, negationEnding } from "../src/kakikudashi/conjugationContext.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { findCompoundSpans } from "../src/reading/jmdictLookup.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";

/** What a subject is marked with, where a coordination chain ends, and which
 * form a negation takes in front of a 係助詞 — the four particle rules and the
 * two chain guards added together, each with the corpus measurement its own
 * doc in `conjugationContext.ts` states.
 *
 * Written as its own file rather than folded into `conjugationContext.test.ts`
 * because every case here is a *sentence*, not a unit of the module: the claim
 * being made is about what the two panels print, and the shortest honest way
 * to state it is to print it. */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });
const sent = (...tokens: Token[]): Sentence => ({ tokens });
const render = (sentence: Sentence): string =>
  generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), resolve);
const at = (sentence: Sentence, id: number): Token => sentence.tokens.find((t) => t.id === id)!;

// ---------------------------------------------------------------------------
// The ざるに on a plain-`mod` negated clause — 不飲一斗、適以益貧
// ---------------------------------------------------------------------------

/** 酒蟲 sent_id 35, tokens 17-25 as the reader's own tree has them. This is a
 * standing regression anchor, not a new rule: `isNegatedAdverbialPredicate` was
 * written for exactly this sentence, and the point of pinning it is that the
 * gate accepts a governor whose xpos says 副詞.
 *
 * 適 is UPOS `VERB` with xpos `v,副詞,頻度,偶発` — the *adverb* たまたま under a
 * verb tag — and `isVerbalXpos`, which the gate spends, tests only the `v,`
 * prefix. `v,副詞,…` has it, so the governor passes and the ざるに is written. */
const notOnePeck = (): Sentence =>
  sent(
    tok({ id: 17, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 18, morph: "Polarity=Neg" }),
    tok({ id: 18, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "mod", head: 22 }),
    tok({ id: 19, text: "一", lemma: "一", pos: "NUM", xpos: "n,数詞,数字,*", dep: "mod", head: 20 }),
    tok({ id: 20, text: "斗", lemma: "斗", pos: "NOUN", xpos: "n,名詞,度量衡,*", dep: "comp:obj", head: 18 }),
    tok({ id: 21, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 18 }),
    tok({ id: 22, text: "適", lemma: "適", pos: "VERB", xpos: "v,副詞,頻度,偶発", dep: "ROOT", head: 22 }),
  );

describe("不飲一斗 — the ざるに on a plain-`mod` negated clause", () => {
  it("writes ザルニ on the 不 even though the governor's xpos says 副詞", () => {
    const sentence = notOnePeck();
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(negationEnding(at(sentence, 17), plan)).toBe("ざるに");
  });

  it("…and the whole clause reads 一斗を飲まざるに", () => {
    expect(render(notOnePeck())).toContain("一斗を飲まざるに");
  });
});

// ---------------------------------------------------------------------------
// Coordination chains and the stop between conjuncts
// ---------------------------------------------------------------------------

/** 伯夷、叔齊不念舊惡 — the enumeration comma, which does **not** end a chain.
 * 4,566 of the corpus's 16,508 nominal chains have a stop between two members
 * and 4,912 of those stops are 、; every one of them is a list wanting a single
 * particle after its last member. */
describe("a 、 between conjuncts is the enumeration mark, not a boundary", () => {
  const twoWorthies = sent(
    tok({ id: 1, text: "伯夷", lemma: "伯夷", pos: "PROPN", xpos: "n,名詞,人,名", dep: "comp:obj", head: 5 }),
    tok({ id: 2, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 1 }),
    tok({ id: 3, text: "叔齊", lemma: "叔齊", pos: "PROPN", xpos: "n,名詞,人,名", dep: "conj:coord", head: 1 }),
    tok({ id: 5, text: "念", lemma: "念", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 5 }),
  );

  it("keeps the two conjuncts one phrase, and marks it once after the last", () => {
    expect(caseParticleFor(at(twoWorthies, 1), twoWorthies)).toBeUndefined();
    expect(caseParticleFor(at(twoWorthies, 3), twoWorthies)).toBe("を");
  });
});

/** 傳昭明。相士。 — the same coordination across a **full stop**, which is four
 * sentences of one name each in the corpus's own text. 586 nominal chains
 * (3.6%) and 686 predicate chains (2.1%) cross one. */
describe("a full stop between conjuncts ends the chain", () => {
  const twoSentences = sent(
    tok({ id: 1, text: "昭明", lemma: "昭明", pos: "PROPN", xpos: "n,名詞,人,名", dep: "comp:obj", head: 5 }),
    tok({ id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 1 }),
    tok({ id: 3, text: "相士", lemma: "相士", pos: "PROPN", xpos: "n,名詞,人,名", dep: "conj:coord", head: 1 }),
    tok({ id: 5, text: "傳", lemma: "傳", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 5 }),
  );

  it("marks the head, not a conjunct on the far side of the stop", () => {
    expect(caseParticleFor(at(twoSentences, 1), twoSentences)).toBe("を");
    expect(caseParticleFor(at(twoSentences, 3), twoSentences)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A subordinate subject takes の
// ---------------------------------------------------------------------------

/** 有朋自遠方來 — the standing anchor, and the shape the rule is bounded to:
 * the 有 stands before the subject, the subject before its own verb, and no
 * stop anywhere between. 242 subjects in the corpus wear it. */
describe("the subject of the clause an existential asserts takes の", () => {
  const friendFromAfar = sent(
    tok({ id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 1 }),
    tok({ id: 2, text: "朋", lemma: "朋", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "subj", head: 6 }),
    tok({ id: 6, text: "來", lemma: "來", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "comp:obj", head: 1 }),
  );

  it("marks 朋 の — 朋の來る有り", () => {
    expect(caseParticleFor(at(friendFromAfar, 2), friendFromAfar)).toBe("の");
  });

  it("refuses it where the 有 stands after the subject — a cross-clause attachment", () => {
    const crossClause = sent(
      tok({ id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 1 }),
      tok({ id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 1 }),
      tok({ id: 3, text: "我", lemma: "我", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "subj", head: 4 }),
      tok({ id: 4, text: "見", lemma: "見", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 1 }),
    );
    // 蓋有之矣，我未之見也 is two sentences and the parse joins them; the stop
    // between the 有 and its supposed clause is what says so.
    expect(caseParticleFor(at(crossClause, 3), crossClause)).toBeUndefined();
  });

  it("leaves an ordinary matrix subject unmarked", () => {
    const plainSubject = sent(
      tok({ id: 1, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: "subj", head: 2 }),
      tok({ id: 2, text: "散", lemma: "散", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 2 }),
    );
    expect(caseParticleFor(at(plainSubject, 1), plainSubject)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A noun resumed by a demonstrative is dislocated, and takes は
// ---------------------------------------------------------------------------

/** 蟲是劉之福 — 酒蟲 sent_id 36, tokens 5-6, both `subj` of 成. */
describe("a noun a demonstrative resumes takes は", () => {
  const wormIsFortune = sent(
    tok({ id: 5, text: "蟲", lemma: "蟲", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "subj", head: 20 }),
    tok({ id: 6, text: "是", lemma: "是", pos: "PRON", xpos: "n,代名詞,指示,*", dep: "subj", head: 20, morph: "PronType=Dem" }),
    tok({ id: 20, text: "成", lemma: "成", pos: "VERB", xpos: "v,動詞,行為,生産", dep: "ROOT", head: 20 }),
  );

  it("marks 蟲 は and leaves the resumptive itself bare", () => {
    expect(caseParticleFor(at(wormIsFortune, 5), wormIsFortune)).toBe("は");
    expect(caseParticleFor(at(wormIsFortune, 6), wormIsFortune)).toBeUndefined();
  });

  it("holds when the relation is corrected to `dislocated`, which is what gold writes", () => {
    const corrected = sent(
      { ...at(wormIsFortune, 5), dep: "dislocated" },
      at(wormIsFortune, 6),
      at(wormIsFortune, 20),
    );
    expect(caseParticleFor(at(corrected, 5), corrected)).toBe("は");
  });

  it("refuses 其, which is the 其…乎 modal frame and not a resumption", () => {
    // 泰山其頹乎 — 156 of the corpus's 206 subject-sibling pronouns are this 其,
    // and none of them resumes anything.
    const mountTai = sent(
      tok({ id: 1, text: "泰山", lemma: "泰山", pos: "PROPN", xpos: "n,名詞,固定物,地名", dep: "subj", head: 3 }),
      tok({ id: 2, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "subj", head: 3, morph: "PronType=Prs" }),
      tok({ id: 3, text: "頹", lemma: "頹", pos: "VERB", xpos: "v,動詞,行為,変化", dep: "ROOT", head: 3 }),
    );
    expect(caseParticleFor(at(mountTai, 1), mountTai)).toBeUndefined();
  });

  it("refuses a demonstrative that is only a determiner — 惟此文王", () => {
    const thisKing = sent(
      tok({ id: 1, text: "惟", lemma: "惟", pos: "PRON", xpos: "n,代名詞,指示,*", dep: "det", head: 3 }),
      tok({ id: 2, text: "此", lemma: "此", pos: "PRON", xpos: "n,代名詞,指示,*", dep: "det", head: 3, morph: "PronType=Dem" }),
      tok({ id: 3, text: "王", lemma: "王", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "ROOT", head: 3 }),
    );
    // Both are `det`, which is neither a subject relation nor `dislocated`.
    expect(caseParticleFor(at(thisKing, 1), thisKing)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A nominalised verb compound puts its こと at the end
// ---------------------------------------------------------------------------

/** 豈飲啄固有數乎 — 酒蟲 sent_id 35, tokens 28-32. 飲 is 有's `subj` with 啄
 * fused onto it by `flat@vv`; 飲啄 is one word, so the こと belongs after 啄.
 * A VERB on `subj` has a `flat@vv` child 1,012 times in the corpus. */
describe("a nominalised verb compound is marked once, after its last member", () => {
  const drinkAndPeck = sent(
    tok({ id: 28, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "subj", head: 31 }),
    tok({ id: 29, text: "啄", lemma: "啄", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "flat@vv", head: 28 }),
    tok({ id: 31, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 31 }),
    tok({ id: 32, text: "數", lemma: "數", pos: "NOUN", xpos: "n,名詞,数量,*", dep: "comp:obj", head: 31 }),
  );

  it("asks the carrier for the particle and gives the fused member none", () => {
    expect(caseParticleFor(at(drinkAndPeck, 28), drinkAndPeck)).toBe("こと");
    expect(caseParticleFor(at(drinkAndPeck, 29), drinkAndPeck)).toBeUndefined();
  });

  it("prints it after the whole compound — 飲啄こと, never 飲こと啄", () => {
    // Typed on its own the span is a JMdict する-verb, so the ending reads
    // 飲啄すること; inside 酒蟲's own sentence it is bare 飲啄こと. Either way the
    // こと falls after 啄 and never between the two characters, which is the
    // whole claim.
    expect(render(drinkAndPeck)).toMatch(/飲啄(する)?こと/);
    expect(render(drinkAndPeck)).not.toContain("飲こと");
  });
});

// ---------------------------------------------------------------------------
// 係り結び on a negated clause
// ---------------------------------------------------------------------------

describe("a negation a 係助詞 binds takes the 連体形 ざる", () => {
  /** 君飲嘗不醉否 with the 否 attached to the predicate it closes. */
  const notDrunk = sent(
    tok({ id: 5, text: "君", lemma: "君", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 6 }),
    tok({ id: 6, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "ROOT", head: 6 }),
    tok({ id: 7, text: "嘗", lemma: "嘗", pos: "ADV", xpos: "v,動詞,行為,動作", dep: "mod", head: 9 }),
    tok({ id: 8, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 9, morph: "Polarity=Neg" }),
    tok({ id: 9, text: "醉", lemma: "醉", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "conj:coord", head: 6, morph: "Degree=Pos" }),
    tok({ id: 10, text: "否", lemma: "否", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 9 }),
  );

  it("醉はざるや — the ず is what stands in front of the や, so the ず is attributive", () => {
    const plan = computeReadingOrder(notDrunk, findCompoundSpans(notDrunk));
    expect(negationEnding(at(notDrunk, 8), plan)).toBe("ざる");
    expect(render(notDrunk)).toContain("醉はざるや");
  });

  it("不亦…乎 takes it too — 亦說ばしからざるや, the 亦 no longer carving anything out", () => {
    // 不亦說乎. This asserted 〜ずや, on a lexical carve-out keyed on the 亦: 72 of
    // the corpus's 276 negation-before-question-particle edges carry one, and all
    // 72 are 不亦…乎; 不亦 itself is followed by 乎 in 78 of its 82 sentences.
    //
    // **The reader has overruled the carve-out** — *"Don't carve out 不亦"* — so
    // the expectation moves from ず to ざる by decision, not by drift. The counts
    // above are kept because they are what is being given up.
    const notAlsoPleasant = sent(
      tok({ id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" }),
      tok({ id: 2, text: "亦", lemma: "亦", pos: "ADV", xpos: "v,副詞,頻度,重複", dep: "mod", head: 3 }),
      tok({ id: 3, text: "說", lemma: "說", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 3, morph: "Degree=Pos" }),
      tok({ id: 4, text: "乎", lemma: "乎", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 3 }),
    );
    const plan = computeReadingOrder(notAlsoPleasant, findCompoundSpans(notAlsoPleasant));
    expect(negationEnding(at(notAlsoPleasant, 1), plan)).toBe("ざる");
    expect(render(notAlsoPleasant)).toContain("ざるや");
  });

  it("…and so does 斯不亦惠而不費乎, where the 亦 sat on the other conjunct", () => {
    // This was the carve-out's widest reach: the frame brackets the whole
    // coordination, so a 亦 on 惠 refused the 連体形 to the ず closing 費. With the
    // carve-out gone by the reader's decision, the coordination chain is no
    // longer walked for a 亦 at all and this ず is attributive like any other.
    const neitherLavish = sent(
      tok({ id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" }),
      tok({ id: 2, text: "亦", lemma: "亦", pos: "ADV", xpos: "v,副詞,頻度,重複", dep: "mod", head: 3 }),
      tok({ id: 3, text: "惠", lemma: "惠", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 3, morph: "Degree=Pos" }),
      tok({ id: 4, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 5, morph: "Polarity=Neg" }),
      tok({ id: 5, text: "費", lemma: "費", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "conj:coord", head: 3, morph: "Degree=Pos" }),
      tok({ id: 6, text: "乎", lemma: "乎", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 5 }),
    );
    const plan = computeReadingOrder(neitherLavish, findCompoundSpans(neitherLavish));
    expect(negationEnding(at(neitherLavish, 4), plan)).toBe("ざる");
  });

  it("but takes 連体形 on a 不…乎 with no 亦 — 不其然乎", () => {
    const surelySo = sent(
      tok({ id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" }),
      tok({ id: 2, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "subj", head: 3, morph: "PronType=Prs" }),
      tok({ id: 3, text: "然", lemma: "然", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 3, morph: "Degree=Pos" }),
      tok({ id: 4, text: "乎", lemma: "乎", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 3 }),
    );
    const plan = computeReadingOrder(surelySo, findCompoundSpans(surelySo));
    expect(negationEnding(at(surelySo, 1), plan)).toBe("ざる");
  });
});
