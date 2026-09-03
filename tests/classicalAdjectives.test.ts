import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { attestedAdjectiveClass, hasAttestedAdjectiveKunOnly, type KanjidicIndex, lookupKanji } from "../src/reading/kanjidicLookup.ts";
import { isAdjectiveLemma, isAdjectiveReading, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { kunWordClass } from "../src/reading/classicalEnding.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { LEXICON_SENSES, VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
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
  const plainVerb = (text: string) => makeToken({ text, lemma: text, pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT" });

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
