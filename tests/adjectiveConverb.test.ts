// The form an adjective — or a 然 — takes, in the four places 趙爽's preface to
// the 周髀算經 showed the app getting it wrong. 夫高而大者，莫大於天；厚而廣者，
// 莫廣於地 is the whole of the first sentence and three of the four faults are
// in it, with the same tree twice over: 高 and 厚 are both ADJ `mod` on an
// adjacent 者 with a `conj:coord` sibling between them, and they came out
// 高く**て** and 厚**して**.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { Sentence, Token } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { decideConjForm, isAdversativeZhen } from "../src/kakikudashi/conjugationContext.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const load = <T>(f: string): T => JSON.parse(readFileSync(join(DATA_DIR, f), "utf-8")) as T;
const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
const jmdict = load<JmdictIndex>("jmdict-index.json");
// No historical-kana index, for `classicalAdjectives.test.ts`'s reason: these
// tests are about which ending is written, not about how the stem is spelled.
const resolve = createReadingResolver(kanjidic, jmdict);

const sentenceOf = (tokens: Token[]): Sentence => ({ tokens }) as Sentence;
const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })), resolve);

/** 夫高而大者，莫大於天；厚而廣者，莫廣於地, the hand-corrected tree verbatim. */
const GAO_HOU = sentenceOf([
  { id: 0, text: "夫", lemma: "夫", pos: "PART", xpos: "p,助詞,句頭,*", dep: "discourse", head: 7 },
  { id: 1, text: "高", lemma: "高", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "mod", head: 4, morph: "Degree=Pos" },
  { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 },
  { id: 3, text: "大", lemma: "大", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
  { id: 4, text: "者", lemma: "者", pos: "PART", xpos: "p,助詞,提示,*", dep: "subj", head: 7 },
  { id: 5, text: "，", lemma: "，", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 4 },
  { id: 6, text: "莫", lemma: "莫", pos: "ADV", xpos: "v,副詞,否定,禁止", dep: "mod", head: 7, morph: "Polarity=Neg" },
  { id: 7, text: "大", lemma: "大", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "ROOT", head: 7, morph: "Degree=Pos" },
  { id: 8, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "comp:obl", head: 7 },
  { id: 9, text: "天", lemma: "天", pos: "NOUN", xpos: "n,名詞,制度,場", dep: "comp:obj", head: 8, morph: "Case=Loc" },
  { id: 10, text: "；", lemma: "；", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 7 },
  { id: 11, text: "厚", lemma: "厚", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "mod", head: 14, morph: "Degree=Pos" },
  { id: 12, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 13 },
  { id: 13, text: "廣", lemma: "廣", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "conj:coord", head: 11, morph: "Degree=Pos" },
  { id: 14, text: "者", lemma: "者", pos: "PART", xpos: "p,助詞,提示,*", dep: "subj", head: 17 },
  { id: 15, text: "，", lemma: "，", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 14 },
  { id: 16, text: "莫", lemma: "莫", pos: "ADV", xpos: "v,副詞,否定,禁止", dep: "mod", head: 17, morph: "Polarity=Neg" },
  { id: 17, text: "廣", lemma: "廣", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "conj:coord", head: 7, morph: "Degree=Pos" },
  { id: 18, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "comp:obl", head: 17 },
  { id: 19, text: "地", lemma: "地", pos: "NOUN", xpos: "n,名詞,固定物,地形", dep: "comp:obj", head: 18, morph: "Case=Loc" },
  { id: 20, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 17 },
]);

describe("a ク/シク活用形容詞 in front of a 而 writes して, not て", () => {
  // 〜くて is the modern converb. Over the `yomi` field of
  // `tests/fixtures/kanbun-info-passages.json` a ク活用 連用形 before 而 is
  // written くして **176** times against くて **1** — and that one is
  // 「言葉に出さなくても」, inside a modern-Japanese 解釈 gloss — and a シク活用
  // one しくして **32** against しくて **0**. See `teOrShite`.
  it("reads 夫高而大者 as 夫れ高くして…, not 高くて", () => {
    expect(run(GAO_HOU)).toContain("高くして");
    expect(run(GAO_HOU)).not.toContain("高くて");
  });

  it("writes the same ending on an adjective VERB_LEXICON has no entry for — 厚くして", () => {
    // The fault this pair was reported on: identical trees, one ending each.
    // 高 is in the lexicon and inflected; 厚 is not, and stood in its citation
    // form with the connective glued on — 厚**して**. See the adjective class
    // `readingResolver.ts` now carries out of the kanjidic branch.
    expect(VERB_LEXICON["高"]?.conjClass).toBe("ku-keiyoushi");
    expect(VERB_LEXICON["厚"]).toBeUndefined();
    expect(run(GAO_HOU)).toContain("厚くして");
    expect(run(GAO_HOU)).not.toContain("厚して");
  });

  it("leaves a 四段 stative on て — 其旨約而遠 is 約まるて, not 約まるして", () => {
    // The parser writes `Degree=Pos` on every stative, and a great many of
    // those inflect as verbs here: 約 is つづまる, 四段ラ行. The して is the
    // paradigm's and not the feature's, which is why the two arms are separate.
    const sentence = sentenceOf([
      { id: 0, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "det", head: 1, morph: "Person=3|PronType=Prs" },
      { id: 1, text: "旨", lemma: "旨", pos: "NOUN", xpos: "n,名詞,可搬,伝達", dep: "subj", head: 2 },
      { id: 2, text: "約", lemma: "約", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "ROOT", head: 2, morph: "Degree=Pos" },
      { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 },
      { id: 4, text: "遠", lemma: "遠", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "conj:coord", head: 2, morph: "Degree=Pos" },
    ]);
    expect(run(sentence)).toContain("約まるて");
    expect(run(sentence)).not.toContain("約まるして");
  });

  it("asks a span's carrier and not its last member — 形脩廣而幽清 is 脩廣にして", () => {
    // 脩廣 is one span whose last member 廣 is a ク活用 adjective in its own
    // right, and asking 廣 rather than the carrier printed 脩廣**しして**.
    //
    // **The span writes ナリ活用 here, not サ変**, which is
    // `descriptiveBinomeNariReading`'s doing and not this rule's: both members
    // are descriptive, so the pair is a quality and takes なり (23 against サ変
    // 10 over the corpus — see that function). What this test pins is
    // unchanged by which of the two classes wins: the ending is written once,
    // off the *carrier*, and the 而 after it is して. 周髀算經's own
    // 形脩廣而幽清 is received 形は脩廣にして幽清なり.
    const sentence = sentenceOf([
      { id: 0, text: "形", lemma: "形", pos: "NOUN", xpos: "n,名詞,描写,形質", dep: "subj", head: 1 },
      { id: 1, text: "脩", lemma: "脩", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "ROOT", head: 1, morph: "Degree=Pos" },
      { id: 2, text: "廣", lemma: "廣", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "flat@vv", head: 1, morph: "Degree=Pos" },
      { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 },
      { id: 4, text: "幽", lemma: "幽", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
      { id: 5, text: "清", lemma: "清", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "flat@vv", head: 4, morph: "Degree=Pos" },
    ]);
    expect(run(sentence)).toContain("脩廣にして");
    expect(run(sentence)).not.toContain("脩廣しして");
    expect(run(sentence)).not.toContain("脩廣にて");
  });
});

describe("an adjective standing on an adjacent 者 takes the 連体形", () => {
  // 者 stands after き **80** times in the received 書き下し文 and after し
  // **4** — and all four of those し are the 連体形 of the past 助動詞 き
  // (我を生みし者, 陳・蔡に従いし者), never an adjective's 終止形. Over the
  // corpus parses every one of the 123 non-NOUN/PROPN heads an adjacent ADJ
  // `mod` takes is this 者. See `modifiesAdjacentNominal`.
  it("reads 厚而廣者 as …廣き者, not 廣し者", () => {
    expect(run(GAO_HOU)).toContain("廣き者");
    expect(run(GAO_HOU)).not.toContain("廣し者");
  });

  it("answers 連体形 from the tree alone, with no resolver to read the 者 with", () => {
    // 善者果而已 — the ordinary shape of the 123, an ADJ `mod` on the very
    // next token. `isNominalizerAhead` answers the same question for it and
    // needs the resolver to do so, 者 having a second reading (は, the topic
    // marker) after which nothing is attributive. This one is a fact about the
    // tree and holds either way. The two cannot disagree about the topic
    // marker: that 者 is one a bare noun or name modifies, and this branch is
    // reached only from an ADJ.
    //
    // The 廣 of 厚而廣者 above is *not* this shape — it reaches 者 as a
    // `conj:coord` sibling of 厚 rather than as its own `mod` — which is why
    // both rules are needed and neither covers the other.
    const shan: Token = { id: 0, text: "善", lemma: "善", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "mod", head: 1, morph: "Degree=Pos" };
    const zhe: Token = { id: 1, text: "者", lemma: "者", pos: "PART", xpos: "p,助詞,提示,*", dep: "subj", head: 2 };
    const guo: Token = { id: 2, text: "果", lemma: "果", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 2 };
    const sentence = sentenceOf([shan, zhe, guo]);
    expect(decideConjForm(shan, zhe, sentence, "ku-keiyoushi")).toBe("rentai");
    expect(run(sentence)).toContain("善き者");
  });
});

describe("然 opening a clause against the last one is 然れども", () => {
  // Over the kanbun.info parses 然 followed by 而 or by 其 at the head of a
  // clause is 5 tokens and every one of them is 然れども in the received text
  // (論語 19-15, 尉繚子 6, 大學序, 史記 64, 呉子 4); 然りて, which the app was
  // writing, stands 0 times in the corpus against 然れども 17. See
  // `isAdversativeZhen`.
  const zhen = (follower: Token[]): Sentence =>
    sentenceOf([
      { id: 0, text: "課", lemma: "課", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 },
      { id: 1, text: "，", lemma: "，", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 },
      { id: 2, text: "然", lemma: "然", pos: "ADV", xpos: "v,動詞,描写,態度", dep: "mod", head: 5, morph: "Degree=Pos|VerbForm=Conv" },
      ...follower,
    ]);

  /** …，然而宏不可… — 而 `mod` on the same head 然 hangs off, as the parse writes it. */
  const ER = zhen([
    { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "mod", head: 5 },
    { id: 4, text: "宏", lemma: "宏", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "subj", head: 5, morph: "Degree=Pos" },
    { id: 5, text: "可", lemma: "可", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "conj:coord", head: 0, morph: "Mood=Pot" },
    { id: 6, text: "指", lemma: "指", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:aux", head: 5 },
  ]);

  /** …，然其巨可… — the same 然 with the possessive opening the clause. */
  const QI = zhen([
    { id: 3, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "det", head: 4, morph: "Person=3|PronType=Prs" },
    { id: 4, text: "巨", lemma: "巨", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "subj", head: 5, morph: "Degree=Pos" },
    { id: 5, text: "可", lemma: "可", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "conj:coord", head: 0, morph: "Mood=Pot" },
    { id: 6, text: "度", lemma: "度", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:aux", head: 5 },
  ]);

  it("reads 然而 as 然れども, with the 而 writing nothing at all", () => {
    expect(run(ER)).toContain("然れども");
    expect(run(ER)).not.toContain("然りて");
    // Not 然れどもして either: the 然 carries `Degree=Pos` like every other
    // stative, so the adjective arm of `teOrShite` would have claimed it.
    expect(run(ER)).not.toContain("然れどもして");
  });

  it("reads a clause-initial 然其 the same way", () => {
    expect(run(QI)).toContain("然れども");
    expect(run(QI)).not.toContain("然り");
  });

  it("leaves every other 然 alone — 然後 is 然る後, not 然れども後", () => {
    // 然る後 is 27 of the corpus passages and 然らば則ち 4, both of them ADV
    // `mod` with the identical morph. The follower is the whole of what
    // separates them, which is why the condition names two characters.
    const hou = zhen([
      { id: 3, text: "後", lemma: "後", pos: "NOUN", xpos: "n,名詞,時,*", dep: "mod", head: 5, morph: "Case=Tem" },
      { id: 4, text: "能", lemma: "能", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "mod", head: 5 },
      { id: 5, text: "定", lemma: "定", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord", head: 0 },
    ]);
    expect(run(hou)).not.toContain("然れども");
    expect(isAdversativeZhen(hou.tokens[2], hou)).toBe(false);
  });

  it("refuses a 然 that is a binom's own suffix — 繟然而 is not 繟れども", () => {
    // 繟然 and 欣然 are the other two 然而 in the corpus and both are 〜然と.
    // Clause-initiality is what keeps them out, exactly as it does for 而.
    const chan = sentenceOf([
      { id: 0, text: "繟", lemma: "繟", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos" },
      { id: 1, text: "然", lemma: "然", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "flat@vv", head: 0, morph: "Degree=Pos" },
      { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 },
      { id: 3, text: "謀", lemma: "謀", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord", head: 0 },
    ]);
    expect(isAdversativeZhen(chan.tokens[1], chan)).toBe(false);
  });
});

describe("the reading layer hands an adjective the paradigm it derived", () => {
  // `classicalConjClass` answers undefined for every adjective by construction
  // (both classes spell their 終止形 し), and the verb arms require the ending
  // to be unchanged, which the adjective conversion has just changed — so a
  // ク/シク adjective outside `VERB_LEXICON` reached the panels with a reading,
  // an ending and no paradigm at all. Over the kanbun.info parses this hands a
  // class to 527 tokens across 83 lemmas.
  const adj = (text: string): Token => ({
    id: 0, text, lemma: text, pos: "ADJ", xpos: "v,動詞,描写,量", dep: "ROOT", head: 0, morph: "Degree=Pos",
  });

  it("carries ク活用 out for 厚 and 廣, which the lexicon is silent about", () => {
    for (const text of ["厚", "廣"]) {
      const token = adj(text);
      const resolved = resolve(token, sentenceOf([token]));
      expect(VERB_LEXICON[text]).toBeUndefined();
      expect(resolved.conjClass).toBe("ku-keiyoushi");
      // The class alone is inert: both panels reach a resolver-supplied one
      // only through `syntheticLexiconEntry`, and only on this flag.
      expect(resolved.beatsLexicon).toBe(true);
    }
  });

  it("leaves a lemma the lexicon answers for to its own entry — 高", () => {
    const token = adj("高");
    const resolved = resolve(token, sentenceOf([token]));
    expect(resolved.conjClass).toBeUndefined();
    expect(resolved.beatsLexicon).toBeUndefined();
  });

  it("gives no class where the ending was never converted — 暖 is あたたか", () => {
    // The gate is that the adjective conversion actually rewrote the ending,
    // which is the same test `verbKun` makes from the other side. 暖's kun is
    // the 形容動詞 stem あたた.か, no い anywhere in it and no ク活用 paradigm to
    // put it in; a class here would inflect a stem the reading never grew.
    const resolved = resolve(adj("暖"), sentenceOf([adj("暖")]));
    expect(VERB_LEXICON["暖"]).toBeUndefined();
    expect(resolved.okurigana).toBe("か");
    expect(resolved.conjClass).toBeUndefined();
  });
});
