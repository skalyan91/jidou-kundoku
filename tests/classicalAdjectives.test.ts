import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { attestedAdjectiveClass, candidateReadings, hasAttestedAdjectiveKunOnly, type KanjidicIndex, lookupKanji } from "../src/reading/kanjidicLookup.ts";
import { isAdjectiveLemma, isAdjectiveReading, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { classicalConjClass, kunWordClass } from "../src/reading/classicalEnding.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { LEXICON_SENSES, VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { conjugate } from "../src/kakikudashi/classicalConjugation.ts";
import { derivedConjClass } from "../src/reading/chosenReading.ts";
import { conjClassCartouches } from "../src/render/tokenInspector.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const load = <T>(f: string): T => JSON.parse(readFileSync(join(DATA_DIR, f), "utf-8")) as T;
const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
const jmdict = load<JmdictIndex>("jmdict-index.json");
// No historical-kana index, for `nominalReadings.test.ts`'s reason: these tests
// are about which ending is written, not about how the stem is spelled.
const resolve = createReadingResolver(kanjidic, jmdict);

const makeToken = (o: Partial<Token>): Token => ({ id: 1, text: "", lemma: "", pos: "", xpos: "", dep: "", head: 0, ...o });
const sentenceOf = (tokens: Token[]): Sentence => ({ tokens }) as Sentence;
const readingOf = (token: Token, sentence?: Sentence) => {
  const r = resolve(token, sentence ?? sentenceOf([token]));
  return r.reading + (r.okurigana ?? "");
};

/** 文語 is かゆし, not かゆい, and the tag on the token is not what says so.
 *
 * The conversion existed and was reachable only through `Degree=Pos` (or a
 * topicalization, or a complement of becoming). Measured over lzh-train/dev/test
 * before this, 109 characters reached the page with a modern い okurigana and 71
 * of them had no `VERB_LEXICON` entry standing behind to correct it. */
describe("an い-final kun'yomi the dictionary vouches for is written classically", () => {
  // **Deliberately VERB, and deliberately not the `v,動詞,描写,*` class**, which
  // is the whole premise of this block: the conversion here is the one the
  // *dictionary* licenses for a token whose tag says nothing about being an
  // adjective. Parser 0.3.2 recodes 描写 to ADJ with `Degree=Pos` on it, and a
  // token shaped that way answers `isDescriptiveToken` and takes the ordinary
  // feature-driven route instead — which is right for it, and would make this
  // block test something else. A 行為 verb over an adjectival kun'yomi is what
  // is left once the recoding has taken the marked cases away, and it is the
  // shape the 71 unmarked characters this describe-block's doc counts arrive in.
  const plainVerb = (text: string) => makeToken({ text, lemma: text, pos: "VERB", xpos: "v,動詞,行為,態度", dep: "ROOT" });

  it("writes 癢 as かゆし on a VERB carrying no Degree=Pos at all", () => {
    expect(readingOf(plainVerb("癢"))).toBe("かゆし");
  });

  it("reaches the characters JMdict has no headword for, by their reading", () => {
    // Not one of these has an entry under its own spelling — 幽い, 趍しい, 侔しい
    // and 癢い are all absent — and every one of their readings is an ordinary
    // `adj-i` entry under another character.
    expect(isAdjectiveLemma(jmdict, "癢い", "かゆい")).toBe(false);
    expect(isAdjectiveReading(jmdict, "かゆい")).toBe(true);
    expect(readingOf(plainVerb("幽"))).toBe("ふかし");
    expect(readingOf(plainVerb("趍"))).toBe("ひさし");
    expect(readingOf(plainVerb("侔"))).toBe("ひとし");
  });

  it("leaves the 連用形 nominals KANJIDIC2 writes with the same final い alone", () => {
    // The ambiguity `kunWordClass` documents, and the reason the gate is the
    // dictionary's answer and not the shape. 沽 is the sharp case: it lists
    // あた.い ("price", a noun) *and* あら.い ("coarse"), so an answer found by
    // the okurigana alone would have given the second one's ending to the first.
    expect(kunWordClass("あた.い")).toBe("i-final");
    expect(readingOf(plainVerb("沽"))).toBe("あたい");
    expect(readingOf(plainVerb("祥"))).toBe("さいわい");
  });

  it("is asked of a kun'yomi only, so an on'yomi keeps its last mora", () => {
    // 齊's kun list holds the undotted はやい, and a rule reading undotted kun
    // without checking the series would have trimmed the on'yomi せい to せし on
    // all 1,505 齊 of the corpus.
    const qi = makeToken({ text: "齊", lemma: "齊", pos: "PROPN", xpos: "n,名詞,固有,国", dep: "subj" });
    expect(readingOf(qi)).toBe("せい");
    expect(attestedAdjectiveClass(kanjidic, jmdict, "齊", "せい", undefined)).toBeUndefined();
  });

  it("names the paradigm the modern ending distinguishes and the classical one does not", () => {
    expect(attestedAdjectiveClass(kanjidic, jmdict, "癢", "かゆ", "い")).toBe("ku-keiyoushi");
    expect(attestedAdjectiveClass(kanjidic, jmdict, "趍", "ひさ", "しい")).toBe("shiku-keiyoushi");
  });
});

/** The other half: the same character tagged NOUN in an object slot. */
describe("a character whose only kun is an adjective nominalises in an object slot", () => {
  // 忽覺咽中暴癢 (sent_id 24) — 癢 is NOUN in the UPOS column, 動詞 in the xpos,
  // and `comp:obj` of 覺.
  const itch = makeToken({ id: 6, text: "癢", lemma: "癢", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 2 });

  it("reads 癢 as its own quality-noun rather than as a bare on'yomi stem", () => {
    expect(readingOf(itch)).toBe("かゆさ");
  });

  it("selects on the character offering no nominal reading to take instead", () => {
    expect(hasAttestedAdjectiveKunOnly(kanjidic, jmdict, "癢")).toBe(true);
    // The characters `isVerbalNominal`'s object-slot exclusion was argued on:
    // each has a nominal reading available, so none of them is touched.
    for (const char of ["療", "釀", "累", "仇"]) {
      expect(hasAttestedAdjectiveKunOnly(kanjidic, jmdict, char)).toBe(false);
    }
  });

  it("does not reach a predicate slot, where the 終止形 and not a noun is wanted", () => {
    // 良 tagged NOUN and heading its own clause is the corpus's one other token
    // passing the character test; a nominalisation there would print よさ.
    const good = makeToken({ text: "良", lemma: "良", pos: "NOUN", xpos: "v,動詞,描写,態度", dep: "ROOT" });
    expect(hasAttestedAdjectiveKunOnly(kanjidic, jmdict, "良")).toBe(true);
    expect(readingOf(good)).toBe("りょう");
  });
});

/** 饞火上熾 (sent_id 23) — 熾んなり, the ナリ活用形容動詞 KANJIDIC2 writes as an
 * undivided さかん and divides on 盛 alone. */
describe("熾 is read さか + ン as a ナリ活用形容動詞", () => {
  it("gives the stem its boundary and its paradigm", () => {
    const blaze = makeToken({ text: "熾", lemma: "熾", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord" });
    const r = resolve(blaze, sentenceOf([blaze]));
    expect([r.reading, r.okurigana]).toEqual(["さか", "ん"]);
    expect(VERB_LEXICON["熾"]).toEqual({ conjClass: "nari-keiyoudoushi", okuriganaPrefix: "ん", reading: "さか" });
  });

  it("holds the supplementary reading back from the transitivity vote", () => {
    // JMdict lists 熾る as intransitive and 熾す as transitive, so the vote has
    // an answer for the two readings KANJIDIC2 supplies and none for the one a
    // person did — and the flag it reports would have stood the lexicon entry
    // down. This is the trap 適's entry in `verbLexicon.ts` records.
    const withObject = makeToken({ id: 1, text: "熾", lemma: "熾", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT" });
    const object = makeToken({ id: 2, text: "火", lemma: "火", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 1 });
    const hit = lookupKanji(kanjidic, "熾", "VERB", { wantTransitive: true, jmdict });
    expect([hit?.reading, hit?.okurigana, hit?.transitivitySelected]).toEqual(["さか", "ん", undefined]);
    expect(readingOf(withObject, sentenceOf([withObject, object]))).toBe("さかん");
  });

  it("keeps 熾す behind it rather than discarding it", () => {
    // `RESIDUAL` is prepended to a kanji's derived senses, so the build script's
    // own 四段サ行 おこ is still there for a reader who picks おこ.
    expect(LEXICON_SENSES["熾"]?.map((sense) => sense.reading)).toEqual(["さか", "おこ", "おこ"]);
    // And the character's own on'yomi still reaches a PROPN, which never takes
    // a kun'yomi at all.
    expect(lookupKanji(kanjidic, "熾", "PROPN")?.reading).toBe("し");
  });
});

/** 論語 學而 10 — 其諸異乎人之求之與, which kanbun.info reads 其れ諸れ人の之を
 * 求むるに**異なる**か. The app read 異**る**, and the reader reported it as the
 * menu's own problem: ことる is not a candidate `candidateReadings` ever builds,
 * so the page was showing a form the furigana menu could not offer.
 *
 * Two halves, and both are needed. `verbLexicon.ts` states the class for the
 * page (the derived entry was 四段ラ行 こと, from the build script's godan
 * fallback over the modern 五段 verb 異なる), and `LEXICAL_KUN` in
 * `classicalEnding.ts` states the ending for the menu (KANJIDIC2's own
 * こと.なる is modern, and no shape rule reads a な row). Each entry carries its
 * own argument and its own measurement. */
describe("異 is read こと + ナリ as a ナリ活用形容動詞", () => {
  it("inflects by the ナリ paradigm instead of growing a る the stem never had", () => {
    expect(VERB_LEXICON["異"]).toEqual({ conjClass: "nari-keiyoudoushi", reading: "こと" });
    expect(conjugate("nari-keiyoudoushi", "shuushi")).toBe("なり");
    expect(conjugate("nari-keiyoudoushi", "rentai")).toBe("なる");
    expect(conjugate("nari-keiyoudoushi", "mizen")).toBe("なら");
    // What it used to write, and the reason the menu could not offer it: こと is
    // a 形容動詞 stem, not a 四段 one, so こと + る is no form of any word.
    expect(conjugate("yodan-ra", "shuushi")).toBe("る");
  });

  it("offers the page's own reading in the menu, with its paradigm attached", () => {
    // The reader's complaint in its exact shape: the menu has to be able to
    // offer what the page draws. KANJIDIC2 writes 異's only kun'yomi こと.なる —
    // modern Japanese — and the menu now converts it to the 終止形 the page
    // prints, carrying the class so a picked 異 goes on inflecting.
    const kun = candidateReadings(kanjidic, "異", "ADJ", undefined, jmdict).filter((c) => c.kind === "kun");
    expect(kun).toEqual([{ reading: "こと", okurigana: "なり", conjClass: "nari-keiyoudoushi", gloss: "uncommon", kind: "kun" }]);
    // And a reading picked off it derives the same paradigm rather than
    // standing frozen at the ending it was picked with.
    expect(derivedConjClass("異", "こと", "なり")).toBe("nari-keiyoudoushi");
    expect(derivedConjClass("異", "こと", "なる")).toBe("nari-keiyoudoushi");
    // No cartouche: `conjClassCartouches` labels a *collision*, and 異 offers
    // this reading once. See `conjClassCartouche.test.ts` for the census, which
    // this entry does not move.
    expect(conjClassCartouches("異", candidateReadings(kanjidic, "異", "ADJ", undefined, jmdict))).toEqual([undefined, undefined]);
  });

  it("carries no derived 四段ラ行 sense behind it any more", () => {
    // `RESIDUAL` is prepended, as it is for 熾 above, and used to sit in front
    // of the 四段ラ行 こと the godan fallback made of 異なる. That sense was never
    // 異なる: it was こと + る, with the な deleted, and the build script now
    // refuses any fallback match whose okurigana runs past the ending (see
    // `derivedSense` in `scripts/build-verb-lexicon.mjs`).
    expect(LEXICON_SENSES["異"]).toEqual([{ conjClass: "nari-keiyoudoushi", reading: "こと" }]);
  });

  it("leaves 重なる and 連なる alone, which are genuine 四段ラ行 verbs", () => {
    // The shape 〜.なる is 16 characters in the shipped index and this fault is
    // one of them; `LEXICAL_KUN` is keyed by the word, so かさなる and つらなる
    // reach no row of it. See 異's entry in `verbLexicon.ts` for the count.
    expect(classicalConjClass("なる", { lemma: "重", reading: "かさ" })).toBeUndefined();
    expect(classicalConjClass("なる", { lemma: "連", reading: "つら" })).toBeUndefined();
    expect(classicalConjClass("なる", { lemma: "異", reading: "こと" })).toBe("nari-keiyoudoushi");
    // Their own derived senses state the な as a stem prefix, which is exactly
    // what the godan fallback could not supply for 異. Not the leading sense of
    // either character — 連 leads with 四段マ行 つる (連む) and 重 with ク活用
    // おも — which is why this asks the sense list and not `VERB_LEXICON`.
    expect(LEXICON_SENSES["連"]).toContainEqual({ conjClass: "yodan-ra", okuriganaPrefix: "な", reading: "つら" });
    expect(LEXICON_SENSES["重"]).toContainEqual({ conjClass: "yodan-ra", okuriganaPrefix: "な", reading: "かさ" });
  });
});
