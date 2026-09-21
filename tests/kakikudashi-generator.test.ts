import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sentence, Token, TokenTree } from "../src/parse/types.ts";
import type { ReadingPlan } from "../src/kundoku/types.ts";
import type { ReadingResolver, ResolvedReading } from "../src/reading/types.ts";
import {
  endingForMorph,
  parseMorphFeatures,
  renyoukeiEndsInISound,
  NEGATION,
  sentenceFinalParticle,
  SENTENCE_FINAL_PARTICLE_LEMMAS,
  SENTENCE_FINAL_WORD_LEMMAS,
} from "../src/kakikudashi/bungoConjugation.ts";
import { conjugate } from "../src/kakikudashi/classicalConjugation.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { generateKakikudashi, generateKakikudashiForTree, sentenceSeparator } from "../src/kakikudashi/generator.ts";
// The kanji-retained adverbs moved to `classicalEnding.ts`, so the furigana
// menu could read the same table the two panels do — see
// `KANJI_RETAINED_ADVERBS` there. The behaviour they are asserted for below is
// still this generator's, which is why the tests stay here.
import { KANJI_RETAINED_ADVERBS, retainedAdverbParts } from "../src/reading/classicalEnding.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { dirname, join } from "node:path";
import { type KanjidicIndex, retainedAdverbOkurigana } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { findCompoundSpans, lookupModernisedLemma, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { chosenReadingParts, setChosenReading } from "../src/reading/chosenReading.ts";
import {
  converbSuffix,
  findRoot,
  negationEnding,
  negationForm,
  nextMeaningfulToken,
  pickedEnding,
  quoteClosing,
} from "../src/kakikudashi/conjugationContext.ts";

// ---------------------------------------------------------------------------
// bungoConjugation.ts unit tests
// ---------------------------------------------------------------------------

describe("parseMorphFeatures", () => {
  it("parses a pipe-joined Key=Val string", () => {
    expect(parseMorphFeatures("Polarity=Neg|VerbForm=Conv")).toEqual({
      Polarity: "Neg",
      VerbForm: "Conv",
    });
  });
  it("returns {} for empty/undefined input", () => {
    expect(parseMorphFeatures("")).toEqual({});
  });
});

describe("endingForMorph", () => {
  it("maps VerbForm=Conv to て", () => {
    expect(endingForMorph({ VerbForm: "Conv" })?.primary).toBe("て");
  });
  it("maps Voice=Pass to る/らる", () => {
    const f = endingForMorph({ Voice: "Pass" });
    expect(f?.primary).toBe("る");
    expect(f?.alt).toBe("らる");
  });
  it("maps VerbType=Cop to なり with a なら mizenkei variant", () => {
    const f = endingForMorph({ "VerbType": "Cop" });
    expect(f?.primary).toBe("なり");
    expect(f?.mizen).toBe("なら");
  });
  it("returns null for a feature set with no mapped ending", () => {
    expect(endingForMorph({ POS: "NOUN" })).toBeNull();
  });
});

describe("sentenceFinalParticle", () => {
  it("maps 乎 to や", () => {
    expect(sentenceFinalParticle("乎")).toBe("や");
  });
  it("maps 否 to や — the alternative-question tag, …不醉否？", () => {
    expect(sentenceFinalParticle("否")).toBe("や");
  });
  it("puts 否 in SENTENCE_FINAL_WORD_LEMMAS with the rest — furigana, not okurigana", () => {
    // This asserted the opposite for as long as the set was partitioned by what
    // the kana attach to — 也's なり read in the character's place against 否's
    // や completing the predicate before it. The reader has overruled that:
    // sentence-final particles are content words and always take furigana. See
    // the set's own doc for the argument that was overturned and why.
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("也")).toBe(true);
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("否")).toBe(true);
  });
  it("maps 耳 to のみ — the 限定 particle, 易耳 -> 易きのみ", () => {
    expect(sentenceFinalParticle("耳")).toBe("のみ");
  });
  it("puts 耳 in SENTENCE_FINAL_WORD_LEMMAS — のみ is read in the character's place", () => {
    // A 副助詞 and no verb, and in the set all the same: のみ is the whole of
    // what 耳 is read as, and it governs the form of what precedes (連体形),
    // which is a word attaching to a form rather than an ending completing one.
    // The set was named for word class and is now named for what the kana
    // attach to; this is the case that forced the change.
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("耳")).toBe(true);
  });
  it("takes them all in — 乎, 哉, 夫 as well", () => {
    for (const lemma of ["乎", "哉", "夫"]) {
      expect(SENTENCE_FINAL_WORD_LEMMAS.has(lemma)).toBe(true);
    }
  });
  it("leaves 矣 and 焉 on neither side — neither has a reading to put anywhere", () => {
    // The set is built from the table's own non-empty entries, so a particle
    // that renders as nothing is out of it by construction rather than by a
    // rule written for it.
    //
    // **焉 was in the line above and is here now.** It read り — the
    // 完了の助動詞, which attaches to a 四段已然形 and to nothing else — and the
    // particle branch wrote it after whatever form stood in front of it
    // (思ふり, 在らずり, 有るり). The reader ruled "do whatever is conventional",
    // and the convention is the 置き字 one 矣 already takes here: 而・於・于・乎・
    // 焉・矣, unread. The character's other three words — the 疑問副詞 いづくんぞ,
    // the fused 於之 pronoun, the 状態 suffix's たり — are decided elsewhere and
    // never reach this table. See the entry's own note.
    for (const lemma of ["矣", "焉"]) {
      expect(SENTENCE_FINAL_WORD_LEMMAS.has(lemma)).toBe(false);
      expect(SENTENCE_FINAL_PARTICLE_LEMMAS.has(lemma)).toBe(true);
    }
  });
  it("leaves 矣 and 焉 unread, which 耳 does not change", () => {
    expect(sentenceFinalParticle("矣")).toBe("");
    expect(sentenceFinalParticle("焉")).toBe("");
  });
  it("returns '' for an unmapped lemma", () => {
    expect(sentenceFinalParticle("未知")).toBe("");
  });
});

describe("renyoukeiEndsInISound", () => {
  // Which classes take the connecting て — 答ひ→答ひて — and which hand on as
  // the bare 連用中止法 form instead.
  it("is true for every 四段 row", () => {
    for (const row of ["ka", "ga", "sa", "ta", "na", "ba", "ma", "ra", "ha"] as const) {
      expect(renyoukeiEndsInISound(`yodan-${row}`)).toBe(true);
    }
  });
  it("is true for every 上二段 row", () => {
    for (const row of ["ka", "ga", "ta", "da", "ha", "ba", "ma", "ya", "ra"] as const) {
      expect(renyoukeiEndsInISound(`kami-nidan-${row}`)).toBe(true);
    }
  });
  it("is true for 上一段, whose い is in the kanji's reading and not the okurigana", () => {
    // 見る/着る/居る write no renyoukei okurigana at all, so no test on the
    // suffix string could find the い — hence a table keyed by class.
    expect(conjugate("kami-ichidan", "renyou")).toBe("");
    expect(renyoukeiEndsInISound("kami-ichidan")).toBe(true);
  });
  it("is true for the irregulars whose renyoukei is an i-kana", () => {
    // カ変 き, サ変 し, ナ変 に, ラ変 り — 来て/して/死にて/ありて.
    expect(renyoukeiEndsInISound("ka-hen")).toBe(true);
    expect(renyoukeiEndsInISound("sa-hen")).toBe(true);
    expect(renyoukeiEndsInISound("na-hen")).toBe(true);
    expect(renyoukeiEndsInISound("ra-hen")).toBe(true);
  });
  it("is false for every 下二段 row — the family sits one grade down, on the e-kana", () => {
    for (const row of ["ka", "ga", "sa", "za", "ta", "da", "na", "ha", "ba", "ma", "ya", "ra", "wa"] as const) {
      expect(renyoukeiEndsInISound(`shimo-nidan-${row}`)).toBe(false);
    }
    // ア行下二段 (得) writes no okurigana either, and is an e-sound (え) — the
    // mirror of 上一段 above, and the other reason the test is by class.
    expect(conjugate("shimo-nidan-a", "renyou")).toBe("");
    expect(renyoukeiEndsInISound("shimo-nidan-a")).toBe(false);
  });
  it("is false for the adjective and adjectival-noun paradigms", () => {
    // く/しく are u-sounds; と is out plainly. ナリ's に *is* an i-sound and is
    // excluded anyway — what continues a nominal predicate here is the
    // copula's own にして, and a second て on top of it is the doubling
    // `precedingCopulaSuppliesShite` already exists to prevent.
    expect(renyoukeiEndsInISound("ku-keiyoushi")).toBe(false);
    expect(renyoukeiEndsInISound("shiku-keiyoushi")).toBe(false);
    expect(renyoukeiEndsInISound("nari-keiyoudoushi")).toBe(false);
    expect(renyoukeiEndsInISound("tari-keiyoudoushi")).toBe(false);
  });
});

describe("converbSuffix", () => {
  const conv = (over: Partial<Token>): Token => ({
    id: 1,
    text: "x",
    lemma: "x",
    pos: "ADV",
    xpos: "v",
    dep: "mod",
    head: 2,
    morph: "VerbForm=Conv",
    ...over,
  });

  it("writes て after an i-sound 連用形 — 直し -> 直して", () => {
    // 直 is 四段サ行 in the lexicon; 酒蟲's 直墮酒中 reads 直して.
    expect(VERB_LEXICON["直"]?.conjClass).toBe("yodan-sa");
    expect(converbSuffix(conv({ lemma: "直" }), undefined, VERB_LEXICON["直"]?.conjClass)).toBe("て");
  });

  it("writes nothing after a non-i-sound 連用形 — 無く, not 無くて", () => {
    // 無 is ク活用形容詞: 連用形 無く, a u-sound. The bare form is 連用中止法,
    // not a missing て. 異史氏曰 sentence: 無く其の富を損ふ.
    expect(VERB_LEXICON["無"]?.conjClass).toBe("ku-keiyoushi");
    expect(converbSuffix(conv({ lemma: "無" }), undefined, VERB_LEXICON["無"]?.conjClass)).toBe("");
  });

  it("still stands down before a 而 that writes its own て", () => {
    // 參 in 博學而日參省乎己 — 四段ラ行, an い-sound, so the class test passes
    // and the 而 test is the one holding the て back. Doubling it gave 參りてて.
    // Given an i-sound class deliberately: 博's own entry is ク活用形容詞, which
    // the class test would refuse on its own, and the 而 rule would then never
    // be the reason for the answer.
    expect(converbSuffix(conv({ lemma: "參" }), conv({ id: 2, lemma: "而", text: "而" }), "yodan-ra")).toBe("");
    expect(converbSuffix(conv({ lemma: "參" }), undefined, "yodan-ra")).toBe("て");
  });

  it("still writes nothing for a token whose morph is not VerbForm=Conv", () => {
    expect(converbSuffix(conv({ lemma: "直", morph: "" }), undefined, VERB_LEXICON["直"]?.conjClass)).toBe("");
  });

  it("falls through to て when the caller conjugated with no class at all", () => {
    // The generic `resolve()` path carries kanjidic's modern okurigana and no
    // paradigm, and a `fixedReading` entry has no conjugation to apply, so
    // there is nothing to test — that path wrote て before this rule and still
    // does. The rule only ever withholds a て.
    expect(converbSuffix(conv({ lemma: "ZZ" }), undefined, undefined)).toBe("て");
  });

  it("tests the class the caller conjugated with, not the lemma's — 見え, not 見えて", () => {
    // 見 with no object is read 見ゆ — 下二段ヤ行, an え-sound 連用形 — and that
    // is the class the resolver derives and hands the panels through
    // `syntheticLexiconEntry`. `VERB_LEXICON` is keyed by lemma and holds 見's
    // leading sense, the transitive 見る (上一段, an い-sound), so looking the
    // class up in here rather than taking the caller's tested the wrong
    // paradigm and wrote 見えて — 見る's て after 見ゆ's stem.
    expect(VERB_LEXICON["見"]?.conjClass).toBe("kami-ichidan");
    expect(converbSuffix(conv({ lemma: "見" }), undefined, "shimo-nidan-ya")).toBe("");
    expect(converbSuffix(conv({ lemma: "見" }), undefined, "kami-ichidan")).toBe("て");
  });
});

// ---------------------------------------------------------------------------
// generator.ts: synthetic test exercising the morph-driven ending pathway
// directly (a token whose lemma isn't in verbLexicon.ts, so it falls back
// to resolve()+endingForMorph rather than the lexicon's own conjugation).
// ---------------------------------------------------------------------------

describe("generateKakikudashi — morph-driven ending (lexicon-miss fallback)", () => {
  it("appends the CONVERB ending (て) when a token's morph carries VerbForm=Conv", () => {
    const tok = (over: Partial<Token>): Token => ({
      id: 0,
      text: "x",
      lemma: "x",
      pos: "VERB",
      xpos: "v",
      dep: "ROOT",
      head: 0,
      ...over,
    });
    const sentence: Sentence = {
      tokens: [tok({ id: 0, text: "行き", lemma: "xyz", morph: "VerbForm=Conv" })],
    };
    const plan: ReadingPlan = { sentence, order: [0], spans: [], spliceGroups: [], quoteEndIds: new Set(), rereadCloseIds: new Map() };
    // Non-"override" source — an override-sourced reading is already a
    // complete grammatical gloss (see generator.ts's own comment on this),
    // so a morph-driven ending only ever applies on top of a real
    // kanjidic/jmdict/unresolved reading.
    const resolve: ReadingResolver = () => ({ reading: "行き", source: "kanjidic" });
    expect(generateKakikudashi(plan, resolve)).toBe("行きて");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the four Analects 1:1 seed sentences, using the REAL
// reorderEngine.ts (no hand-idealized orders — that was a stand-in while
// reorderEngine.ts didn't exist yet; it's a real, tested dependency now) and
// the real fixture data captured from the shipped lzh_sud_kyoto-0.2.0 wheel.
//
// Content words with a verbLexicon.ts entry (學/習/曰/說/樂/知/慍/有/來) are
// conjugated by the real engine, not this test's fake resolver — the fake
// resolver below only covers what's left: genuine function words (而/自)
// and plain nouns without curated lexicon/override entries (子/朋/方/人/君子).
// Expected outputs were verified end-to-end against the live app (real
// Pyodide parse -> reorderEngine -> readingResolver -> generator).
// ---------------------------------------------------------------------------

const fixturesPath = fileURLToPath(new URL("./fixtures/analects-raw-parses.json", import.meta.url));
const raw: Record<string, Token[][]> = JSON.parse(readFileSync(fixturesPath, "utf-8"));

function clauses(text: string): Sentence[] {
  return raw[text].map((tokens) => ({ tokens }));
}

const fakeResolve: ReadingResolver = (token): ResolvedReading => {
  const functionWords: Record<string, string> = { 而: "て", 自: "より", 之: "これ" };
  if (token.lemma in functionWords) {
    // `spellOutInProse` is what puts the reading in the prose in place of the
    // character; it used to be inferred from `source === "override"`, and this
    // stub said only the latter. The two are separate facts now — a word can
    // be written out in kana whatever table its reading came from — so a stub
    // modelling a function word has to state it (see `ResolvedReading`).
    return { reading: functionWords[token.lemma], source: "override", spellOutInProse: true, endingComplete: true };
  }
  // Plain nouns with no curated entry: kanji-retained, matching what a real
  // kanjidic/jmdict/unresolved hit does in generator.ts.
  return { reading: token.text, source: "unresolved" };
};

function planFor(sentence: Sentence): ReadingPlan {
  return computeReadingOrder(sentence);
}

/** **不亦…乎 reads 〜ずや in every anchor below, which is where it started and
 * where the grammar puts it.**
 *
 * The route was not a straight line. `boundByBindingParticle` first carried a
 * lexical carve-out on the 亦 that kept the frame's 終止形 while every other
 * negation before a や/か took the 連体形; the reader struck it out — *"Don't
 * carve out 不亦"* — and these expectations moved to ざる. What the carve-out had
 * been compensating for, one formula at a time, was the 接続 of や itself: a
 * **終助詞 や takes the 終止形**, so 〜ずや falls out for every negation before one
 * and no carve-out is needed anywhere. See `TERMINAL_PARTICLE_READINGS`, and
 * `boundByBindingParticle` for the measurement the carve-out rested on. */
describe("Analects seed sentences — end to end (real reorderEngine)", () => {
  it("學而時習之，不亦說乎？", () => {
    const [clauseA, clauseB] = clauses("學而時習之，不亦說乎？");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    expect(out).toBe("學びて時にこれを習ふ、亦說ばしからずや。");
  });

  it("子曰：學而時習之。", () => {
    const [clauseA, clauseB] = clauses("子曰：學而時習之。");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    expect(out).toBe("子曰く、學びて時にこれを習ふ。");
  });

  it("有朋自遠方來，不亦樂乎？ (real, non-idealized tree — see kundoku.test.ts note)", () => {
    const [clauseA, clauseB] = clauses("有朋自遠方來，不亦樂乎？");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    // Faithfully reflects the real (non-idealized) parse tree: 自 attaches
    // as a plain `mod` of 來 with only 遠 as its own comp:obj, while 方 is a
    // separate `mod` of 來 — see kundoku.test.ts's note on this sentence.
    //
    // 朋**の**, and that の is new: 來 is the clause 有 asserts the existence
    // of, which stands in a nominal slot, and a clause in a nominal slot marks
    // its own subject の rather than は — 朋の遠方より來る有り, which is the
    // reading conjugationContext.ts's own docs have named as the target for
    // this anchor all along. See `inAttributiveClause`.
    expect(out).toBe("朋の遠しより方來る有り、亦樂しからずや。");
  });

  it("有朋自遠方來，不亦樂乎？ with 遠方 detected as a shared span keeps it together", () => {
    const [clauseA, clauseB] = clauses("有朋自遠方來，不亦樂乎？");
    const spans = [{ tokenIds: [3, 4], text: "遠方" }]; // see kundoku.test.ts's span-aware describe block
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const planForWithSpans = (sentence: Sentence) => computeReadingOrder(sentence, sentence === clauseA ? spans : []);
    const out = generateKakikudashiForTree(tree, planForWithSpans, fakeResolve);
    // …and the same の with the span detected — see the test above.
    //
    // **遠方, not 遠し方, and the し that used to stand between them was a
    // drift artefact.** This test hands the span to `computeReadingOrder`
    // only; the prose generator used to re-derive its own spans by calling
    // `findCompoundSpans(plan.sentence)`, and on this real (non-idealized)
    // tree that call finds nothing — 遠 is `comp:obj` of 自 and 方 a separate
    // `mod` of 來, neither a fusing relation. So the reading order held 遠方
    // together while the prose went on treating 遠 as a descriptive standing
    // on its own and gave it its own 連体形 し. The generator now reads the
    // spans off the plan (`ReadingPlan.spans`), so both halves of this panel
    // answer to the one span the caller declared, and the word is written
    // whole — which is what this test has always said it is for.
    expect(out).toBe("朋の遠方より來る有り、亦樂しからずや。");
  });

  it("人不知而不慍，不亦君子乎？", () => {
    const [clauseA, clauseB] = clauses("人不知而不慍，不亦君子乎？");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    expect(out).toBe("人知らずして慍らず、亦君子ならずや。");
  });

  it("a root-triggered copula attaches after a whole compound span, not spliced between its members", () => {
    // Real bug this regression-tests: when 君子 arrives as two separate
    // tokens joined by `flat` (rather than fused into one token by the
    // tokenizer, as in the fixture above), extraEndingFor(token, root)
    // checked per-individual-token used to fire on 君 alone (token.id ===
    // root.id), splicing なり between 君 and 子 -> "君なり子" instead of
    // the whole compound reading together as "君子なり".
    //
    // The closing 。 is what licenses the copula at all (see
    // `isPredicationLicensed`) — without a mark this reads as the bare noun
    // phrase 君子 and takes no copula, which is a different rule, tested on
    // its own below.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 1 },
        { id: 1, text: "君", lemma: "君", pos: "NOUN", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "flat", head: 1 },
        { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence, [{ tokenIds: [1, 2], text: "君子" }]);
    const out = generateKakikudashi(plan, fakeResolve);
    expect(out).toBe("亦君子なり");
  });

  it("a compound span's shared ending picks mizenkei from what follows the *last* member, not the carrier", () => {
    // Real bug this regression-tests: selectForm's "what comes next" check
    // used the carrier's own position in reading order (君, which sits
    // *before* 子), so a following negation was invisible to it and the
    // copula stayed shuushikei (なり) instead of mizenkei (なら) — 亦君子なりずや
    // instead of the correct 亦君子ならずや.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 1, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 2 },
        { id: 2, text: "君", lemma: "君", pos: "NOUN", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "flat", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence, [{ tokenIds: [2, 3], text: "君子" }]);
    const out = generateKakikudashi(plan, fakeResolve);
    expect(out).toBe("亦君子ならず");
  });

  it("子曰：「習之 — 曰 doesn't reorder its quote, and the quote ends with と", () => {
    // 曰's comp:obj complement (習之, "practices it") stays in place instead
    // of inverting before 曰 the way an ordinary object would — real kanbun
    // reads 子曰く、これを習ふと straight through, not と習ふ子曰これを. The
    // opening bracket is what says this is a quotation at all; without it the
    // complement is an ordinary object (see kundoku.test.ts's unquoted case).
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "「", lemma: "「", pos: "PUNCT", xpos: "x", dep: "punct", head: 3 },
        { id: 3, text: "習", lemma: "習", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 3 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const out = generateKakikudashi(plan, fakeResolve);
    expect(out).toBe("子曰く「これを習ふと");
  });
});

// ---------------------------------------------------------------------------
// 勸學 opening — real parse trees (captured live against the actual 0.2.0
// wheel), real resolver (kanjidic + jmdict + overrides.json, not fakeResolve)
// end to end. Regression-anchors several fixes found translating this text:
// 可以 as a fused modal (もって repositioned before its complement, not
// stranded after べからず), は on a modal-root's subject and on a fronted
// mod+Case:Loc topic, は on a coord-root's subject when the coordinate
// sibling is itself stative (but never double-topicalizing a subject that
// already has its own pattern-b topic), を never appearing on an
// adposition's own object, 於 always inverting before its governor and
// reading より — a source/standard-of-comparison relation, not a location
// one (mod@lmod is unconditionally INVERT — see depClassification.ts —
// whether that governor is a stative predicate, 藍より青し "bluer than
// indigo", or a plain action verb, 藍より取り "takes it from indigo", not
// 取り藍において), 而して (not て) bridging into a stative conj:coord
// clause, and VERB_LEXICON
// conjugation gated to POS=VERB so a noun use of the same lemma (青 as "the
// color blue" vs. 青 "is blue") doesn't wrongly conjugate.
// ---------------------------------------------------------------------------

describe("勸學 opening (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  it("學不可以已 -> 學ぶは以て已む可からず", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "subj", head: 2 },
        { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 2, text: "可", lemma: "可", pos: "AUX", xpos: "x", dep: "ROOT", head: 2, morph: "Mood=Pot" },
        { id: 3, text: "以", lemma: "以", pos: "VERB", xpos: "x", dep: "unk", head: 2 },
        { id: 4, text: "已", lemma: "已", pos: "PART", xpos: "x", dep: "comp:aux", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(generateKakikudashi(plan, resolve)).toBe("學ぶは以て已む可からず");
  });

  it("青取之於藍，而青於藍 -> 青は之を藍より取り而して藍より青し", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "青", lemma: "青", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "取", lemma: "取", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 3, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 1 },
        { id: 4, text: "藍", lemma: "藍", pos: "PROPN", xpos: "x", dep: "comp:obj", head: 3 },
        { id: 6, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 7 },
        { id: 7, text: "青", lemma: "青", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
        { id: 8, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 7 },
        { id: 9, text: "藍", lemma: "藍", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 8 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(generateKakikudashi(plan, resolve)).toBe("青は之を藍より取り而して藍より青し");
  });

  // 冰 is a fronted topic here, and the published reading is 冰は水 — but it
  // arrives as NOUN+`mod` over a `subj` head, the identical shape 山中有虎's
  // 山 and 門人問之's 門 arrive on. Nothing in the parse separates them, so
  // whatever the app does with a juxtaposed nominal pair it does to this line
  // too. It once cost a の (冰の水); it now costs the pair being written as one
  // term (冰水), because the received readings write a juxtaposed pair bare
  // 1,972 times against 251 — see `isJuxtaposedNominalTerm`. Neither is 冰は水
  // and both are one edit away from it. Pinned as it now reads, so the cost
  // stays visible rather than being forgotten.
  it("冰水為之，而寒於水 -> 冰水之を為し而して水より寒し (topic lost to the compound)", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "冰", lemma: "冰", pos: "NOUN", xpos: "x", dep: "mod", head: 1, morph: "Case=Loc" },
        { id: 1, text: "水", lemma: "水", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
        { id: 2, text: "為", lemma: "爲", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 5, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 6 },
        { id: 6, text: "寒", lemma: "寒", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 2, morph: "Degree=Pos" },
        { id: 7, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 6 },
        { id: 8, text: "水", lemma: "水", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 7 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(generateKakikudashi(plan, resolve)).toBe("冰水之を為し而して水より寒し");
  });

  // **The 悅 carries its own ending again.** 悅 is a kyūjitai KANJIDIC2 does
  // not list, so the character had no reading whatever and printed bare, and
  // this expectation had been trimmed to 民見え悅 while its own title went on
  // naming 悅ぶ. `kanjidicEntry` reads it through 悦 (よろこ.ぶ), and the 四段バ行
  // ending follows from that reading the ordinary way.
  //
  // `converbSuffix` is handed the class the caller actually conjugated with.
  // 見 with no object is read 見ゆ — 下二段ヤ行, an え-sound 連用形 — which the
  // resolver derives and hands over as a `syntheticLexiconEntry`; the て is
  // withheld from an え-sound, so this reads 民見え悅ぶ. Looking the class up
  // inside `converbSuffix` instead gave 民見えて悅ぶ, 見る's て after 見ゆ's stem:
  // the lookup is by lemma, `VERB_LEXICON` has no 見 at all, and a class it
  // cannot find is a class it cannot test.
  it("民見悅 -> 民見え悅ぶ — the て is withheld from the class actually used", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "民", lemma: "民", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
        { id: 1, text: "見", lemma: "見", pos: "VERB", xpos: "x", dep: "mod", head: 2, morph: "VerbForm=Conv" },
        { id: 2, text: "悅", lemma: "悅", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(generateKakikudashi(plan, resolve)).toBe("民見え悅ぶ");
  });
});

// ---------------------------------------------------------------------------
// A span whose members attach to different heads, through the real reading
// path: `findCompoundSpans` -> `computeReadingOrder(sentence, spans)`, which
// is how `KakikudashiView` calls it. The rest of this file passes no spans,
// so nothing here exercised the carrier rule end to end.
// ---------------------------------------------------------------------------

describe("史記五帝本紀 opening (real parse tree, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  it("黃帝者、少典之子也 -> 黃帝は、少典の子なり", () => {
    // 黃帝 is one span across two heads (黃 `compound` of 帝, 帝 `mod` of 者),
    // and 帝 is the only member attached outside it. Carrying the span on 黃
    // instead hung it off a token the walk removes, and the whole name went
    // missing: は、少典の子なり.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "黃", lemma: "黃", pos: "PROPN", xpos: "x", dep: "compound", head: 1, morph: "NameType=Giv" },
        { id: 1, text: "帝", lemma: "帝", pos: "NOUN", xpos: "x", dep: "mod", head: 2 },
        { id: 2, text: "者", lemma: "者", pos: "PART", xpos: "x", dep: "subj", head: 6 },
        { id: 3, text: "、", lemma: "、", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        { id: 4, text: "少典", lemma: "少典", pos: "PROPN", xpos: "x", dep: "comp:obj", head: 5, morph: "NameType=Giv" },
        { id: 5, text: "之", lemma: "之", pos: "SCONJ", xpos: "x", dep: "mod", head: 6 },
        { id: 6, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "ROOT", head: 6 },
        { id: 7, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 6 },
        { id: 8, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 6 },
      ],
    };
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(generateKakikudashi(plan, resolve)).toBe("黃帝は、少典の子なり");
  });
});

// ---------------------------------------------------------------------------
// A 再読文字 over a predicate that carries a coordinate clause — the scope
// question, end to end through the real resolver.
// ---------------------------------------------------------------------------

describe("a 再読文字 with a coordinate clause beside it (real parse tree, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  /** 未學禮而不知。 as the wheel returns it. */
  const sentence: Sentence = {
    tokens: [
      { id: 0, text: "未", lemma: "未", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Polarity=Neg" },
      { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
      { id: 2, text: "禮", lemma: "禮", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
      { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 5 },
      { id: 4, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 5, morph: "Polarity=Neg" },
      { id: 5, text: "知", lemma: "知", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
      { id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
    ],
  };

  it("未學禮而不知 -> 未だ禮を學ばずして知らず", () => {
    // Three things at once, all of them consequences of where 未's ず lands.
    // It used to close at the end of the whole subtree, past the coordinate
    // clause, which put it after 不's own ず (知らずず), left 學 in the 連用形
    // (學びて) instead of the 未然形 未 governs, and left 而 reading て because
    // the negation in front of it was a re-read close rather than a token.
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(generateKakikudashi(plan, resolve)).toBe("未だ禮を學ばずして知らず");
  });

  it("keeps closing at the end of the clause when nothing is coordinated onto it", () => {
    const alone: Sentence = { tokens: sentence.tokens.filter((t) => t.id <= 2 || t.id === 6) };
    const plan = computeReadingOrder(alone, findCompoundSpans(alone));
    expect(generateKakikudashi(plan, resolve)).toBe("未だ禮を學ばず");
  });
});

// ---------------------------------------------------------------------------
// A reading picked by hand on a grammar word — the branches that render those
// used to claim the character before the choice was ever consulted.
// ---------------------------------------------------------------------------

describe("a hand-picked reading on a grammar word (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  /** 未學禮。 as the wheel returns it, optionally with a reading chosen on 未. */
  const weiXueLi = (reading?: string): Sentence => ({
    tokens: [
      { id: 0, text: "未", lemma: "未", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Polarity=Neg", ...(reading ? { misc: { Reading: reading } } : {}) },
      { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
      { id: 2, text: "禮", lemma: "禮", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
    ],
  });

  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("未學禮 -> 未だ禮を學ばず with nothing picked", () => {
    expect(run(weiXueLi())).toBe("未だ禮を學ばず");
  });

  it("未學禮 -> 未禮を學ぶ once 未 is read ひつじ", () => {
    // Three things follow from the choice, and all three used to be missed.
    // The reading itself has to appear at all — the negation branch claimed
    // the character first and emitted a bare ず, so the prose read 禮を學ばず
    // with no 未 in it. Nothing may go on conjugating against a negation that
    // is no longer there, or 學 keeps the 未然形 and dangles: 未禮を學ば. And
    // the character must stop being postposed, which is done to negations
    // because they are read after what they negate: 禮を學ぶ未.
    expect(run(weiXueLi("ひつじ"))).toBe("未禮を學ぶ");
  });

  it("also lets a sentence-final particle be overruled", () => {
    const withYe = (reading?: string): Sentence => ({
      tokens: [
        { id: 0, text: "習", lemma: "習", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 0, ...(reading ? { misc: { Reading: reading } } : {}) },
      ],
    });
    expect(run(withYe())).toBe("習ふなり");
    // **習ふや, and it read 習ふ也 until a pinned particle learned to spell
    // itself out.** The overruling this case is named for is the *reading* —
    // the branch used to claim the character before the choice was consulted
    // at all — and it was got right while the display was left as the branch
    // happened to write it, `token.text` plus the ending. That put the same
    // character on the page two ways: unpinned it is the なり above, in kana,
    // and pinned it was 也, the kanji, in a 書き下し文 that writes no particle
    // as its kanji. See `chosenSpellsOutInProse`, which both panels ask.
    expect(run(withYe("や"))).toBe("習ふや");
  });
});

// ---------------------------------------------------------------------------
// What falls between one clause and the next. The parser segments at every
// mark, so `tree.sentences` is a list of clauses; the mark each clause was
// closed with is what decides whether 、 or 。 goes after it.
// ---------------------------------------------------------------------------

describe("sentenceSeparator", () => {
  const sentence = (...texts: string[]): Sentence => ({
    tokens: texts.map((text, id) => ({
      id,
      text,
      lemma: text,
      pos: /[、。，？！「」]/.test(text) ? "PUNCT" : "NOUN",
      xpos: "x",
      dep: /[、。，？！「」]/.test(text) ? "punct" : "ROOT",
      head: 0,
    })),
  });

  it("writes 、 after a clause a comma divided", () => {
    const list = [sentence("學", "，"), sentence("說")];
    expect(sentenceSeparator(list, 0)).toBe("、");
  });

  it("writes 。 after a clause a question mark closed", () => {
    // ？ closes a sentence even though the parser segments on ， as well —
    // 學而時習之，不亦說乎？有朋自遠方來 is three clauses and two sentences.
    const list = [sentence("說", "？"), sentence("有")];
    expect(sentenceSeparator(list, 0)).toBe("。");
  });

  it("writes 。 after the last clause of the text", () => {
    expect(sentenceSeparator([sentence("學", "，")], 0)).toBe("。");
  });

  it("writes nothing before a closing bracket, which belongs to what it closes", () => {
    const list = [sentence("說", "？"), sentence("」")];
    expect(sentenceSeparator(list, 0)).toBe("");
  });

  it("writes nothing after an opening bracket, which belongs to what it opens", () => {
    const list = [sentence("曰", "「"), sentence("學")];
    expect(sentenceSeparator(list, 0)).toBe("");
  });

  it("asks the last clause that had a mark, past a bracket standing alone", () => {
    // 子曰：「…罔。」思而… — the 」 comes back as a sentence of its own, the 。
    // inside the quote having ended the one before it. The quotation ends a
    // sentence, so what follows it opens a new one.
    const list = [sentence("罔", "。"), sentence("」"), sentence("思")];
    expect(sentenceSeparator(list, 1)).toBe("。");
  });

  it("writes nothing where the parser cut a clause the source left unmarked", () => {
    // **This asserted the 、, and the 、 was the app's own default rather than
    // anything the reader had asked for** — no comment here or on `markFor`
    // ever attributed it to him. What replaced it is his instruction: "don't
    // end a clause with a comma in the prose panel unless it ends with *some*
    // kind of punctuation in the original". The fallback punctuated a boundary
    // the edition does not punctuate, the parser having split where the text
    // simply runs on.
    //
    // Measured over kanbun.info before the change was kept: **171 passages
    // moved, 151 closer and 20 further, net −158 edits.** See `markFor`, which
    // now returns null rather than a mark when neither this sentence nor any
    // before it closed on one.
    const list = [sentence("矣"), sentence("仁")];
    expect(sentenceSeparator(list, 0)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Genitive の, the withheld copula, あり for a count, and a chain that isn't
// flat — each through the real resolver, on the tree the live parser returns
// for the text named. Verified end to end against the running app.
// ---------------------------------------------------------------------------

describe("nominal-modifier の and the sentence-final endings (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("楚人至。 -> 楚人至る", () => {
    // 楚 was picking up the fronted-topic は instead: 楚は人至る. The の that
    // stopped it was itself wrong: kanbun.info writes a state name on 人 bare
    // 26 times in 26, and this asserted 楚の人至る until that was counted. See
    // `isStateNameOnItsPeople`.
    expect(
      run({
        tokens: [
          { id: 0, text: "楚", lemma: "楚", pos: "PROPN", xpos: "x", dep: "mod", head: 1, morph: "Case=Loc|NameType=Nat" },
          { id: 1, text: "人", lemma: "人", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
          { id: 2, text: "至", lemma: "至", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("楚人至る");
  });

  it("梁惠王曰。 -> 梁の惠王曰く — the の reaches past the name 惠王", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "梁", lemma: "梁", pos: "PROPN", xpos: "x", dep: "mod", head: 2, morph: "Case=Loc|NameType=Nat" },
          { id: 1, text: "惠", lemma: "惠", pos: "PROPN", xpos: "x", dep: "compound", head: 2, morph: "NameType=Prs" },
          { id: 2, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 3 },
          { id: 3, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 3 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 3 },
        ],
      }),
    ).toBe("梁の惠王曰く");
  });

  /** 君子, with or without the mark that closes it. */
  const junzi = (punctuated: boolean): Sentence => ({
    tokens: [
      { id: 0, text: "君子", lemma: "君子", pos: "NOUN", xpos: "x", dep: "ROOT", head: 0 },
      ...(punctuated ? [{ id: 1, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 }] : []),
    ],
  });

  it("君子 with no punctuation stays a noun phrase", () => {
    expect(run(junzi(false))).toBe("君子");
  });

  it("君子。 is a predication and takes なり", () => {
    expect(run(junzi(true))).toBe("君子なり");
  });

  it("弟子三千人。 -> 弟子三千人あり — a count, not an identity", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "弟子", lemma: "弟子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "三千", lemma: "三千", pos: "NUM", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "人", lemma: "人", pos: "NOUN", xpos: "x", dep: "clf", head: 1, morph: "NounType=Clf" },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("弟子三千人あり");
  });

  it("食肉飲酒歌舞。 -> 肉を食ひ酒を飲み舞ふ歌ふ — only the last conjunct is finite", () => {
    // 歌 hangs off 飲 rather than off the chain's head 食, which used to make
    // 飲 look like the last member of its own two-verb chain: 酒を飲む.
    //
    // **食ひ and 飲み are bare, and that is the reader's settled decision**: a
    // coordination chain links its members by 連用中止法, and 連用中止法 is a
    // bare 連用形. Both are い-sound 連用形, so the て rule `converbSuffix`
    // applies to a converb would take them if the chain were let into it —
    // 肉を食ひて酒を飲みて舞ふ歌ふ — and it is deliberately kept out. This
    // expectation is where that stands pinned; see `converbSuffix`'s closing
    // note for the gate (a coordinand carries no `VerbForm=Conv` of its own).
    //
    // The tail of this expectation is *wrong Japanese*, and pinned anyway
    // because the cause is upstream. The reading wanted is 肉を食ひ酒を飲み
    // 歌ひ舞ふ — four verbs in a list. What the parser returns is 舞 as the
    // `comp:obj` of 歌 ("to sing a dance") rather than a fourth conjunct, and
    // both defects follow from that one relation: an object is read before
    // its verb, which reverses them, and an object is not in the chain, which
    // leaves it uninflected. Correcting that single dep — measured, nothing
    // else touched — makes this line come out 肉を食ひ酒を飲み歌ひ舞ふ with no
    // change to this project at all, so the chain walk is not what is at
    // fault here: 食ひ and 飲み are its work, and 歌 really is the last
    // conjunct of the chain this tree describes.
    expect(
      run({
        tokens: [
          { id: 0, text: "食", lemma: "食", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "肉", lemma: "肉", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "x", dep: "parataxis", head: 0 },
          { id: 3, text: "酒", lemma: "酒", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
          { id: 4, text: "歌", lemma: "歌", pos: "VERB", xpos: "x", dep: "parataxis", head: 2 },
          { id: 5, text: "舞", lemma: "舞", pos: "VERB", xpos: "x", dep: "comp:obj", head: 4 },
          { id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("肉を食ひ酒を飲み舞ふ歌ふ");
  });

  /** 僧曰：「君飲嘗不醉否？」 — 酒蟲 sent_id 8, on the tree the parser really
   * returns: 否 tagged VERB and `comp:obj` of 醉, not the `discourse@sp` a
   * particle arrives on. */
  /** 否 as the parser tags it (VERB, `comp:obj` of 醉) and as a corrected tree
   * has it (`discourse@sp`), on otherwise identical trees. */
  const orNot = (particle: boolean): Sentence => ({
    tokens: [
      { id: 4, text: "君", lemma: "君", pos: "NOUN", xpos: "x", dep: "subj", head: 5 },
      { id: 5, text: "飲", lemma: "飲", pos: "VERB", xpos: "x", dep: "subj", head: 8 },
      { id: 6, text: "嘗", lemma: "嘗", pos: "VERB", xpos: "x", dep: "mod", head: 8 },
      { id: 7, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 8, morph: "Polarity=Neg" },
      { id: 8, text: "醉", lemma: "醉", pos: "ADJ", xpos: "x", dep: "ROOT", head: 8, morph: "Degree=Pos" },
      particle
        ? { id: 9, text: "否", lemma: "否", pos: "PART", xpos: "x", dep: "discourse@sp", head: 8 }
        : { id: 9, text: "否", lemma: "否", pos: "ADJ", xpos: "x", dep: "comp:obj", head: 8, morph: "Degree=Pos" },
      { id: 10, text: "？", lemma: "？", pos: "PUNCT", xpos: "x", dep: "punct", head: 8 },
    ],
  });

  it("君飲嘗不醉否 on a corrected tree -> 君飲む嘗て醉はずや", () => {
    // 醉は**ざる**や, not 醉はずや. The 否 reads や, a 係助詞 of the class whose
    // 結び is a 連体形 — and the 不 is postposed past its verb, so the thing
    // standing in front of the particle is the ず, and it is the ず that has to
    // be attributive. The same division of labour 苦不得飲 (得ざるに) and
    // 學而不思則罔 (思はざれば) already run on. See `boundByBindingParticle`,
    // and the 不亦…乎 anchors below, which its 亦 carve-out keeps as 〜ずや.
    expect(run(orNot(true))).toBe("君飲む嘗て醉はずや");
  });

  it("…and still reads や where the parser has tagged the 否 a verb", () => {
    // 酒蟲 sent_id 8 as the parser really returns it. The branch that spends
    // `sentenceFinalParticle` is keyed on `dep === "discourse"`, which this 否
    // has not got, so it went to the lexicon/resolver path and printed the
    // verb: 君飲む嘗て否む醉はず. `isSentenceFinalParticleUse` stands beside that
    // dep test now and catches this one by position — last among the
    // sentence's non-punctuation tokens.
    //
    // The や lands *before* 醉はず rather than closing the sentence, and that
    // is pinned as it stands because the cause is upstream and not here: a
    // `comp:obj` is unconditionally INVERT (see `depClassification.ts`), so
    // reading order puts this token in front of its governor whatever it is
    // read as — 否む sat in exactly the same wrong place before. Only the
    // *reading* is this rule's business; the position needs the same
    // position-based test applied to the reading order, in a file this change
    // does not own. Both panels agree on the placement, so nothing is split:
    // the 訓読文 prints 否 last in source order with the kunten that send the
    // reader to it first.
    expect(run(orNot(false))).toBe("君飲む嘗てや醉はず");
  });

  it("然歟否歟？ -> the 否 with a 歟 after it stays the verb", () => {
    // The other side of the same test. Position is the only discriminator
    // available, and it has to cut both ways: this 否 is the sentence's own
    // ROOT with a 歟 following, so it is 否む and not the tag.
    expect(
      run({
        tokens: [
          { id: 0, text: "然", lemma: "然", pos: "ADV", xpos: "x", dep: "subj", head: 2, morph: "Degree=Pos|VerbForm=Conv" },
          { id: 1, text: "歟", lemma: "歟", pos: "PART", xpos: "x", dep: "discourse@sp", head: 0 },
          { id: 2, text: "否", lemma: "否", pos: "ADJ", xpos: "x", dep: "ROOT", head: 2, morph: "Degree=Pos" },
          { id: 3, text: "歟", lemma: "歟", pos: "PART", xpos: "x", dep: "discourse@sp", head: 2 },
          { id: 4, text: "？", lemma: "？", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toContain("否");
  });

  /** 劉答言：「無。」 — 酒蟲 sent_id 6. `named` gives the tree an earlier parse
   * returned, where 劉答 had been read as a personal name (答 PROPN,
   * NameType=Giv, `flat` of 劉); `named: false` has 答 as the VERB it is,
   * everything else untouched. */
  const replied = (named: boolean): Sentence => ({
    tokens: [
      { id: 1, text: "劉", lemma: "劉", pos: "PROPN", xpos: "x", dep: "subj", head: 3, morph: "NameType=Sur" },
      named
        ? { id: 2, text: "答", lemma: "答", pos: "PROPN", xpos: "x", dep: "flat", head: 1, morph: "NameType=Giv" }
        : { id: 2, text: "答", lemma: "答", pos: "VERB", xpos: "x", dep: "mod", head: 3, morph: "VerbForm=Conv" },
      { id: 3, text: "言", lemma: "言", pos: "VERB", xpos: "x", dep: "ROOT", head: 3 },
      { id: 4, text: "：", lemma: "：", pos: "PUNCT", xpos: "x", dep: "punct", head: 3 },
      { id: 6, text: "無", lemma: "無", pos: "VERB", xpos: "x", dep: "comp:obj", head: 3, morph: "Polarity=Neg" },
    ],
  });

  it("劉答言 -> 劉答へ言ふ — 答 is conjugated, not remembered", () => {
    // 答's 連用形 is derived like any other verb's. KANJIDIC2 has only the
    // modern こた.える, which `classicalConjClass` refuses; the class comes from
    // JMdict instead, which lists 答ふ as 下二段ハ行 outright (see
    // `attestedClassicalParadigm`), and 下二段ハ行's 連用形 is 答へ. The bridge
    // is gated on `pos === "VERB"`, which is why the tag matters here.
    //
    // え-sound 連用形, so `converbSuffix`'s い-sound rule gives it no connecting
    // て — the て appears only under the 連用形の「て」 display switch, which is
    // off by default and is not touched here.
    //
    // 言 reads 言ふ. Only 曰 carries `fixedReading` はく, and 言 never did — see
    // `VERB_LEXICON`.
    //
    // **無 is now read after 言 and not in front of it**, which is where the
    // received reading has it: 劉答へて言ふ、「無し」と. The ： between them is
    // what decides — a clausal complement the reader reaches only across a
    // pause mark is read where it stands, and nothing returns to it (see
    // `depClassification.ts`'s `isClausalComplementAcrossPause`). Before that
    // rule this read 劉答へ、無し言ふ, with the mark stranded after 答へ because
    // 無 had been carried in front of the verb; the mark now falls after 言ひ,
    // which is the cut the received reading makes too.
    //
    // The closing と is still missing. That is `isSpeechQuoteComplement`'s
    // business and not this rule's: what closes a quotation is the ト
    // `reorderEngine.ts` marks, 言 reaches that rule only where the source
    // brackets the quotation, and this tree has no bracket.
    //
    // **言ひ and not 言ふ, because this tree carries no xpos.** The 連用形 is
    // what any verb takes with another predication still to come, and what
    // stands the rule down is the treebank's 伝達 class on the governor — a
    // verb of speech and the words it reports are one clause, so the verb keeps
    // its own form (see `hasClausalComplementAcrossPause`). Every token here is
    // tagged `xpos: "x"`, this file's placeholder, so 言 is read as an ordinary
    // verb. 酒蟲's own parse tags it `v,動詞,行為,伝達` and reads 劉答言ふ、無し;
    // `tests/kundoku.test.ts` holds that same line with its real tags.
    expect(run(replied(false))).toBe("劉答へ言ひ、無し");
  });

  it("…and 劉答 fuses into one span on the tree that mis-tags 答 as a name", () => {
    // `flat` is a fusing relation, so `findCompoundSpans` draws 劉答 as one
    // span — bare kanji under a single reading, JMdict knowing no 劉答, so the
    // panels fall back to per-character on'yomi (りうたふ) — and the 答 loses
    // its own conjugated ending. This is a **parser error surfacing**, not an
    // app rule to be worked around: 答 before a speech verb is the verb "to
    // reply", not the second half of a given name, and the correct annotation
    // is the one the reader's own 酒蟲 tree now carries — 答 VERB, governing
    // 言, with 劉 its `subj`. Pinned to keep the cost of the mis-tag visible.
    //
    // 無 stays after 言 for the reason the case above sets out, and the fused
    // span does not change that: 劉答 is one atom read first either way.
    expect(run(replied(true))).toBe("劉答言ひ、無し");
    expect(findCompoundSpans(replied(true)).map((s) => s.text)).toEqual(["劉答"]);
    expect(findCompoundSpans(replied(false))).toEqual([]);
  });

  it("毎得書讀之。 -> 書を得る毎に之を讀む — 毎 wants 連体形", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "毎", lemma: "每", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Conv" },
          { id: 1, text: "得", lemma: "得", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "書", lemma: "書", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
          { id: 3, text: "讀", lemma: "讀", pos: "VERB", xpos: "x", dep: "parataxis", head: 1 },
          { id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 3, morph: "Person=3|PronType=Prs" },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("書を得る毎に之を讀む");
  });
});

// ---------------------------------------------------------------------------
// The transitive/intransitive split, conjugated. `beatsLexicon` stands
// VERB_LEXICON down so the syntax-chosen reading can reach the page, and with
// the entry went the conjugation class it was carrying — the reading arrived
// in citation form wherever an inflected one was called for (廟を立つて, which
// is not Japanese). Both trees below are the live parser's own, exported from
// the running app as CoNLL-U.
// ---------------------------------------------------------------------------

describe("a transitivity-selected reading conjugates (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("王立廟而去。 -> 王廟を立てて去ぬ — 立 with an object is 下二段タ行", () => {
    // 廟 is 立's comp:obj, so the reading is the transitive 立てる, whose
    // classical class is 下二段タ行: renyoukei 立て before 而's て. The
    // lexicon's own 立 entry (四段タ行 たつ) is the intransitive word and is
    // rightly stood down here — but its class went with it, and 立つて is
    // what came out instead.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "廟", lemma: "廟", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1, morph: "Case=Loc" },
          { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王廟を立てて去ぬ");
  });

  it("廟立而王去。 -> 廟立ちて王去ぬ — the same character with no object is 四段タ行", () => {
    // The regression's control: nothing moves this reading, so it goes on
    // through the lexicon and its 四段 renyoukei 立ち, exactly as before.
    expect(
      run({
        tokens: [
          { id: 0, text: "廟", lemma: "廟", pos: "NOUN", xpos: "x", dep: "subj", head: 1, morph: "Case=Loc" },
          { id: 1, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 3, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("廟立ちて王去ぬ");
  });

  it("王不立廟。 -> 王廟を立てず — the 下二段 mizenkei, through the ordinary negation rule", () => {
    // The point of rebuilding a lexicon entry rather than special-casing the
    // ending: every context rule downstream (here, postposed 不) keeps
    // working on the syntax-chosen reading unchanged.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
          { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
          { id: 2, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "廟", lemma: "廟", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2, morph: "Case=Loc" },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("王廟を立てず");
  });

  it("leaves an okurigana shape no class can be read off exactly as it was", () => {
    // 起 with an object resolves to お.こす — not a -eru/-iru verb, so the
    // mechanical derivation reads no class off it. The lexicon's own attested
    // 起こす (四段サ行, okuriganaPrefix こ) now supplies one, which is what
    // makes 起こし available where a 連用形 is called for — but the 終止形 is
    // 起こす either way, so this sentence is unchanged. Asserted so that a
    // future widening cannot alter the surface here silently.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "起", lemma: "起", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "兵", lemma: "兵", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王兵を起こす");
  });

  // -------------------------------------------------------------------------
  // 見, the 上一段 verb the derivation's 四段 default turned into another word.
  // A one-kana modern okurigana is *usually* a 四段 終止形, and 見る's bare る
  // is exactly where it is not: 連用形 見り, where 上一段's is the bare stem.
  // The 立 pair above is the control that has to survive the fix, since its
  // whole distinction is chosen by syntax and not by the lexicon.
  // -------------------------------------------------------------------------

  it("僧見之而去。 -> 僧之を見て去ぬ — 見 with an object is 上一段, whose 連用形 is the bare stem", () => {
    // 見 read み is three words in the lexicon — 見る 上一段, 見す 四段サ行 and
    // 見ゆ 下二段ヤ行 — and only 見る spells itself みる in modern Japanese,
    // which is what identifies it. Before, a bare る gave 四段ラ行 and this
    // read 僧之を見りて去ぬ.
    expect(
      run({
        tokens: [
          { id: 0, text: "僧", lemma: "僧", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "見", lemma: "見", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 1, morph: "Person=3|PronType=Prs" },
          { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("僧之を見て去ぬ");
  });

  it("僧着衣而去。 -> 僧衣を着て去ぬ — the same shape in the other 上一段 verbs", () => {
    // 着る, like 見る, keeps its る in classical and takes the bare stem for
    // both 未然形 and 連用形; 煮る and 干る are the two others the transitivity
    // check reaches (see reading.test.ts).
    expect(
      run({
        tokens: [
          { id: 0, text: "僧", lemma: "僧", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "着", lemma: "着", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "衣", lemma: "衣", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
          { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("僧衣を着て去ぬ");
  });

  it("王謁之而去。 -> 王之に謁して去ぬ — a verb with no kun'yomi is read サ変", () => {
    // KANJIDIC2 lists 謁 no kun'yomi at all, so the lookup falls through to
    // its on'yomi えつ — which arrived with no ending and printed 王之に謁。
    // Naming サ変 rather than a fixed す is what makes the 連用形 available:
    // the ending is 謁し here, 謁す in isolation and 謁せ under 不.
    //
    // **封 was this test's character until it gained a `RESIDUAL` entry**
    // (下二段ザ行 封(ほう)ず, the reading kanbun.info prints 10 times out of 10),
    // and a hand entry reaches the page ahead of the kun-less on'yomi rule. The
    // rule is unchanged and 謁 carries it; see 封's entry in `verbLexicon.ts`.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "謁", lemma: "謁", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 1, morph: "Person=3|PronType=Prs" },
          { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王之を謁して去ぬ");
  });

  // -------------------------------------------------------------------------
  // 肥, the pair the mechanical derivation cannot separate on its own. Both
  // trees are the live parser's own, exported from the running app as
  // CoNLL-U; note that it tags 肥 `Degree=Pos` in both, which is why the
  // transitivity question has to be put to it anyway (see `hasAdjectiveKun`).
  // -------------------------------------------------------------------------

  it("馬肥。 -> 馬肥ゆ — 肥 with no object is 下二段ヤ行, which only the lexicon knows", () => {
    // KANJIDIC2 gives the intransitive reading as こ+える, and a modern -eru
    // with a bare え could descend from ア行, ヤ行 or ワ行下二段 — so
    // `classicalConjClass` refuses it and the reading used to reach the page
    // in its modern citation form, 馬肥える. Wiktionary's own bungo table for
    // 肥ゆ settles the row, and it is reached by matching the resolver's
    // reading and okurigana against the lexicon's senses for this lemma.
    expect(
      run({
        tokens: [
          { id: 0, text: "馬", lemma: "馬", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "肥", lemma: "肥", pos: "ADJ", xpos: "x", dep: "ROOT", head: 1, morph: "Degree=Pos" },
          { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("馬肥ゆ");
  });

  it("馬肥而王去。 -> 馬肥えて王去ぬ — the same word's 連用形, which the citation form had no way to give", () => {
    // The class is what a conjugated form needs, not just the ending: without
    // it this read 馬肥えるて王去ぬ, a modern 終止形 with 而's て glued onto it.
    expect(
      run({
        tokens: [
          { id: 0, text: "馬", lemma: "馬", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "肥", lemma: "肥", pos: "ADJ", xpos: "x", dep: "ROOT", head: 1, morph: "Degree=Pos" },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 3, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("馬肥えて王去ぬ");
  });

  // -------------------------------------------------------------------------
  // The rows added when SUFFIX_OF was filled out. Both trees are the live
  // parser's own, exported from the running app as CoNLL-U.
  // -------------------------------------------------------------------------

  it("種樹於園。 -> 樹園より種う — ワ行下二段, which had no ConjClass at all", () => {
    // KANJIDIC2 has only たね and the on'yomi for 種, so `SUPPLEMENTARY_KUN`
    // supplies the reading う — and a reading with no class conjugates
    // nowhere: this came out 樹園より種, the bare character. Wiktionary files
    // the word under 植 and has no verb entry for 種, so the class is
    // hand-supplied in `RESIDUAL` — which it could not be until ワ行下二段
    // existed to name.
    expect(
      run({
        tokens: [
          { id: 0, text: "種", lemma: "種", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "樹", lemma: "樹", pos: "VERB", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 2, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 0 },
          { id: 3, text: "園", lemma: "園", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2, morph: "Case=Loc" },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
        ],
      }),
      // 園**に**種う: 種 is not a descriptive predicate and takes no source, so
      // its 於 is the plain 置き字 and its object takes に. See `yuParts`.
      //
      // **樹す, and the す is the tag's doing rather than this row's word.**
      // 樹 here is the trees being planted and the parse calls it VERB all the
      // same (this tree is the live parser's own export). KANJIDIC2 gives the
      // character only the undotted noun き, so `pickKun` now reads a VERB 樹
      // on'yomi and the サ変 す follows — the same exposure to a mis-tag that
      // `spanSuruReading` names as the price of the rule. The word is not
      // invented: kanbun.info writes 樹して twice (邦君樹塞門 -> 邦君は樹して門
      // を塞ぐ, and 管氏亦樹塞門) against no bare verbal 樹 at all. It printed a
      // bare 樹 before, which said nothing at all about the tag.
    ).toBe("樹す園に種う");
  });

  it("王悔過。 -> 王過を悔ゆ — ヤ行上二段, whose modern 悔いる hides the row", () => {
    // 悔いる is 上一段 in modern Japanese and 上二段ヤ行 in classical, and the
    // い gives no more away about the row than 肥える's え does — the same
    // gap, one grade up.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "悔", lemma: "悔", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "過", lemma: "過", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王過を悔ゆ");
  });

  it("肥馬。 -> 馬を肥やす — the same character with an object is the other word entirely", () => {
    // The control for the pair. こやす and こゆ share the reading こ and are
    // told apart only by their okurigana, so this is the assertion that the
    // by-reading lookup has not simply started answering with whichever sense
    // comes first.
    expect(
      run({
        tokens: [
          { id: 0, text: "肥", lemma: "肥", pos: "ADJ", xpos: "x", dep: "ROOT", head: 0, morph: "Degree=Pos|VerbForm=Part" },
          { id: 1, text: "馬", lemma: "馬", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("馬を肥やす");
  });
});

// ---------------------------------------------------------------------------
// A reading picked by hand on a content word: it has to inflect for where the
// character stands, and it must not cost the sentence its predicate. The
// trees are the shape the wheel returns for the text named; expectations were
// verified end to end against the running app.
// ---------------------------------------------------------------------------

describe("a hand-picked reading inflects, and keeps the sentence's own ending", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s));
  const run = (s: Sentence) => generateKakikudashi(planFor(s), resolve);

  /** Puts a choice on one token of `sentence`, the way the furigana menu
   * does — through `setChosenReading`, so the stored shape is the menu
   * candidate's own (modern) okurigana and not something pre-converted. */
  const pick = (sentence: Sentence, id: number, reading: string, okurigana?: string): Sentence => {
    const token = sentence.tokens.find((t) => t.id === id)!;
    setChosenReading(token, reading, okurigana);
    return sentence;
  };

  /** 王立太子而去。, optionally with a reading chosen on 立. */
  const wangLi = (): Sentence => ({
    tokens: [
      { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
      { id: 1, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
      { id: 2, text: "太", lemma: "太", pos: "ADJ", xpos: "x", dep: "mod", head: 3, morph: "Degree=Pos" },
      { id: 3, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
      { id: 4, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 5 },
      { id: 5, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
      { id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
    ],
  });

  it("conjugates a picked kun'yomi instead of printing its citation form", () => {
    // KANJIDIC writes 立's transitive reading た.てる, a modern 下一段 ending.
    // Converting it alone gives the 終止形 立つ, which is classically spelled
    // and still the wrong form here: 立つて. Only the class — read off the
    // *modern* ending, which is the one place 四段タ行 and 下二段タ行 are still
    // distinguishable — gets the 連用形 立て that the following 而 wants.
    expect(run(wangLi())).toBe("王太子を立てて去ぬ");
    expect(run(pick(wangLi(), 1, "た", "てる"))).toBe("王太子を立てて去ぬ");
  });

  it("takes the mizenkei before a negation, like any other conjugating verb", () => {
    const negated: Sentence = {
      tokens: [
        { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
        { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 2, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "廟", lemma: "廟", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
      ],
    };
    expect(run(pick(negated, 2, "た", "てる"))).toBe("王廟を立てず");
  });

  it("reads a verb picked on'yomi as サ変 rather than freezing it at す", () => {
    // An on'yomi candidate stores no ending, and す is only サ変's 終止形 —
    // naming the class is what gets the 連用形 し before 而.
    expect(run(pick(wangLi(), 1, "りつ"))).toBe("王太子を立して去ぬ");
  });

  it("leaves an ending no class can be read off exactly as picked", () => {
    // お.こす is two kana not ending in る, which `classicalConjClass`
    // abstains on — and an uninflected classical ending is what this path
    // printed before, where a guessed paradigm would be worse than either.
    const qi: Sentence = {
      tokens: [
        { id: 0, text: "君", lemma: "君", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "起", lemma: "起", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    };
    expect(run(pick(qi, 1, "お", "こす"))).toBe("君起こす");
  });

  it("keeps the あり of a quantity predication whose carrier was repicked", () => {
    // `quantityPredicateCarrier` hangs the あり off whatever closes the
    // quantity — 畝 here — and the picked branch used to `continue` past
    // `extraEndingFor` entirely, so changing that character's reading made
    // the sentence's whole predicate vanish. Picking the original reading
    // back did not restore it either: the choice is still stored, so the
    // token stays on this branch.
    const mu = (): Sentence => ({
      tokens: [
        { id: 0, text: "田", lemma: "田", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "三百", lemma: "三百", pos: "NUM", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "畝", lemma: "畝", pos: "NOUN", xpos: "x", dep: "clf", head: 1, morph: "NounType=Clf" },
        { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    });
    expect(run(mu())).toBe("田三百畝あり");
    expect(run(pick(mu(), 2, "うね"))).toBe("田三百畝あり");
    // …and switching back to the reading it already had, which leaves the
    // choice stored rather than clearing it.
    expect(run(pick(mu(), 2, "せ"))).toBe("田三百畝あり");
  });

  it("keeps the なり of a bare nominal root that was repicked", () => {
    const dao = (): Sentence => ({
      tokens: [
        { id: 0, text: "道", lemma: "道", pos: "NOUN", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      ],
    });
    expect(run(dao())).toBe("道なり");
    expect(run(pick(dao(), 0, "だう"))).toBe("道なり");
  });

  it("routes that ending through selectForm, so a coordinand takes renyoukei", () => {
    // 道。 alone closes with なり; as a non-final link in a coordination chain
    // it hands on with なり's renyoukei なり->なり… — `selectForm` is what
    // knows the difference, and emitting `primary` directly would have made a
    // picked token differ from an unpicked one in the same position.
    //
    // **The second conjunct was 德 and is now 山**, and only because the
    // fixture stopped being a coordination: `sinoNominalPairReading` in
    // readingResolver.ts reads two adjacent single-character nominals that
    // JMdict lists as one Sino-Japanese word on'yomi throughout as that word,
    // and 道德 is one — どうとく, which the app now writes 道德なり with no
    // にして between, correctly. What this test is about is `selectForm` and
    // the chain's renyoukei, so it wants a pair no dictionary joins; 道山 is
    // in neither order (checked against the shipped JMdict index) and every
    // other token here is unchanged.
    const chain = (): Sentence => ({
      tokens: [
        { id: 0, text: "道", lemma: "道", pos: "NOUN", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "山", lemma: "山", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 0 },
        { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      ],
    });
    expect(run(pick(chain(), 0, "だう"))).toBe(run(chain()));
  });

  it("does not put back a morph ending the choice was overruling", () => {
    // 未 is `Polarity=Neg`, and reading it ひつじ is the reader saying it is
    // not a negation here. `extraEndingFor` answers with the morph ending
    // ahead of everything else, so taking it would write the ず straight back
    // (未ず禮を學ぶ) — the very thing this branch outranks the grammar-word
    // branches to prevent.
    const wei: Sentence = {
      tokens: [
        { id: 0, text: "未", lemma: "未", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Polarity=Neg" },
        { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "禮", lemma: "禮", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
      ],
    };
    expect(run(pick(wei, 0, "ひつじ"))).toBe("未禮を學ぶ");
  });

  it("gives the two panels the same ending, part for part", () => {
    // The 訓読文 concatenates what the 書き下し文 emits as separate pieces, so
    // the only way they can agree is by asking one function — this one. What
    // it returns is what KundokuView.ts puts in the cell's okurigana slot and
    // what generator.ts splits across its token and ending pieces.
    //
    // The three fields beside those two are not written anywhere: they say how
    // the okurigana was conjugated, for the 連用形の「て」 switch, which cannot
    // read that off the finished string. See `PickedEnding`. 立 picked as た+てる
    // is 下二段タ行 and its 連用形 *is* 立て, which is exactly why the converb
    // suffix has to be reported apart from it — 立てて is a form and 立ててて is
    // not.
    const sentence = pick(wangLi(), 1, "た", "てる");
    const li = sentence.tokens[1];
    const parts = pickedEnding(chosenReadingParts(li)!, li, findRoot(sentence), planFor(sentence), resolve);
    expect(parts).toEqual({ okurigana: "て", extra: "", form: "renyou", conjClass: "shimo-nidan-ta", converbTe: "" });
    expect(run(sentence)).toContain(li.text + parts.okurigana + parts.extra);

    const mu: Sentence = {
      tokens: [
        { id: 0, text: "田", lemma: "田", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "三百", lemma: "三百", pos: "NUM", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "畝", lemma: "畝", pos: "NOUN", xpos: "x", dep: "clf", head: 1, morph: "NounType=Clf" },
        { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    };
    pick(mu, 2, "うね");
    const mou = mu.tokens[2];
    const muParts = pickedEnding(chosenReadingParts(mou)!, mou, findRoot(mu), planFor(mu), resolve);
    // No class was derivable for うね, so the picked okurigana stood as it was
    // and there is no form to report — a word at its citation form, which the
    // switch has no opinion about.
    expect(muParts).toEqual({ okurigana: "", extra: "あり", form: undefined, conjClass: undefined, converbTe: "" });
    expect(run(mu)).toContain(mou.text + muParts.okurigana + muParts.extra);
  });
});

// ---------------------------------------------------------------------------
// A noun with a subject is a predication: it takes なり where it closes, and
// にして where it hands on. Every tree below is the one the wheel returns for
// the text named, exported from the running app as CoNLL-U.
// ---------------------------------------------------------------------------

describe("a noun with a subject predicates (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("takes なり from a subject on the root, as it already did from the mark", () => {
    // 此吾師。 — 此 is 師's `subj`, and 吾 is only its `det`, so "my teacher"
    // alone would not have done it. Two licences reach this one now, which is
    // the point. (Dropping the 。 is *not* how to see the subject licence on
    // its own: the parser returns a different tree entirely for the
    // unpunctuated text — 此 as the root, 師 a `mod` of it, no subject
    // anywhere — and correctly gets nothing. The にして test below uses a
    // tree the parser really does produce for an unlicensed sentence.)
    expect(
      run({
        tokens: [
          { id: 0, text: "此", lemma: "此", pos: "PRON", xpos: "x", dep: "subj", head: 2, morph: "PronType=Dem" },
          { id: 1, text: "吾", lemma: "吾", pos: "PRON", xpos: "x", dep: "det", head: 2, morph: "Person=1|PronType=Prs" },
          { id: 2, text: "師", lemma: "師", pos: "NOUN", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
      // 此れ, not 此: a demonstrative 此 read これ is written with れ as its
      // okurigana, the same division 之 takes — see `korePronounSplit` in
      // readingResolver.ts. A kanjidic reading, so the prose keeps the kanji.
      //
      // わが, not われ: 吾 stands `det` on 師 here — the tree above says so —
      // and a first-person pronoun modifying a noun is genitive, so 此吾師 is
      // 此れ吾が師なり. The reading is わ with が as okurigana, the split 其
      // already takes as そ + の; see the `contextDep: ["det"]` entries in
      // overrides.json. This assertion is the only one in the suite the rule
      // moves, which is what makes it the one worth pinning here.
    ).toBe("此れ吾が師なり");
  });

  it("leaves 秦王 and 君子 alone, which is what that licence exists for", () => {
    // 秦 is a `compound` on 王 and bare 君子 has no child at all, so neither
    // has a subject — and with nothing closing them they stay the noun
    // phrases "the king of Qin" and "a gentleman". 秦王 with no の between
    // the two, as the received readings write it 42 times in 43.
    expect(
      run({
        tokens: [
          { id: 0, text: "秦", lemma: "秦", pos: "PROPN", xpos: "x", dep: "compound", head: 1, morph: "Case=Loc|NameType=Nat" },
          { id: 1, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "ROOT", head: 1 },
        ],
      }),
    ).toBe("秦王");
    expect(run({ tokens: [{ id: 0, text: "君子", lemma: "君子", pos: "NOUN", xpos: "x", dep: "ROOT", head: 0 }] })).toBe("君子");
  });

  /** 弟子三千人 — 弟子 is the `subj` of the numeral that heads it. */
  const disciples = (punctuated: boolean): Sentence => ({
    tokens: [
      { id: 0, text: "弟子", lemma: "弟子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
      { id: 1, text: "三千", lemma: "三千", pos: "NUM", xpos: "x", dep: "ROOT", head: 1 },
      { id: 2, text: "人", lemma: "人", pos: "NOUN", xpos: "x", dep: "clf", head: 1, morph: "NounType=Clf" },
      ...(punctuated ? [{ id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 }] : []),
    ],
  });

  it("still counts rather than equates, though the count has a subject too", () => {
    // 弟子 is `subj` of 三千, so a count is a nominal with a subject — but
    // あり is what a count takes, and なり would say the three thousand *are*
    // the disciples.
    expect(run(disciples(true))).toBe("弟子三千人あり");
  });

  it("does not let that subject license an unpunctuated count", () => {
    // The subject of a count is what is being counted, not something the
    // count is asserted of — so this licence is the copula's alone, and
    // 弟子三千人 unmarked stays the noun phrase "three thousand disciples".
    expect(run(disciples(false))).toBe("弟子三千人");
  });

  it("leaves a nominal root whose numeral modifies it counting as well", () => {
    // 沛公兵十萬, not 沛の公の兵十萬: both `mod` edges here are juxtaposed
    // nominal pairs, and `isJuxtaposedNominalTerm` withholds the の from
    // both. 沛公 is the gain — it is 劉邦's title, read as one word — and 公兵
    // is the loss, since 兵 is among the heads that lean the other way (の 6,
    // bare 3 in the received readings). The test is about the count, and the
    // あり is what it asserts.
    expect(
      run({
        tokens: [
          { id: 0, text: "沛", lemma: "沛", pos: "PROPN", xpos: "x", dep: "mod", head: 1, morph: "Case=Loc|NameType=Geo" },
          { id: 1, text: "公", lemma: "公", pos: "NOUN", xpos: "x", dep: "mod", head: 2 },
          { id: 2, text: "兵", lemma: "兵", pos: "NOUN", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "十萬", lemma: "十萬", pos: "NUM", xpos: "x", dep: "mod", head: 2 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("沛公兵十萬あり");
  });

  it("does not write a second copula where 也 already writes one", () => {
    // 者 is tagged `subj` of 子 here, so the new rule fires on exactly the
    // predicate that already has its copula spelled out — 也 reads なり, and
    // both writing it gives 少典の子なりなり.
    expect(
      run({
        tokens: [
          { id: 0, text: "黃", lemma: "黃", pos: "PROPN", xpos: "x", dep: "compound", head: 1, morph: "NameType=Giv" },
          { id: 1, text: "帝", lemma: "帝", pos: "NOUN", xpos: "x", dep: "mod", head: 2 },
          { id: 2, text: "者", lemma: "者", pos: "PART", xpos: "x", dep: "subj", head: 6 },
          { id: 3, text: "、", lemma: "、", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
          { id: 4, text: "少典", lemma: "少典", pos: "PROPN", xpos: "x", dep: "comp:obj", head: 5, morph: "NameType=Giv" },
          { id: 5, text: "之", lemma: "之", pos: "SCONJ", xpos: "x", dep: "mod", head: 6 },
          { id: 6, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "ROOT", head: 6 },
          { id: 7, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 6 },
          { id: 8, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 6 },
        ],
      }),
    ).toBe("黃帝は、少典の子なり");
  });

  /** 王仁人而智者。 — 人 is a `mod` of the 者 that heads the sentence and has
   * 王 as its own `subj`, with 智 coordinated onto it. */
  const renZhi = (punctuated: boolean): Sentence => ({
    tokens: [
      { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
      { id: 1, text: "仁", lemma: "仁", pos: "ADJ", xpos: "x", dep: "mod", head: 2, morph: "Degree=Pos|VerbForm=Part" },
      { id: 2, text: "人", lemma: "人", pos: "NOUN", xpos: "x", dep: "mod", head: 5 },
      { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
      { id: 4, text: "智", lemma: "智", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 2, morph: "Degree=Pos" },
      { id: 5, text: "者", lemma: "者", pos: "PART", xpos: "x", dep: "ROOT", head: 5 },
      ...(punctuated ? [{ id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 5 }] : []),
    ],
  });

  it("hands on with にして where the predication is not the last link", () => {
    // The rule fires on a token that is not the root at all, and what that
    // token takes is the 連用形 — 智 is coordinated onto it, so the clause
    // hands on rather than closing. Before this it got no ending whatsoever
    // and the sentence read 王仁人て智は.
    expect(run(renZhi(true))).toContain("人にして");
    expect(run(renZhi(true))).not.toContain("にしてて");
  });

  it("licenses that にして by the subject alone, with nothing closing the sentence", () => {
    // Strip the mark and the root 者 has no licence of any kind — no
    // punctuation, no sentence-final particle, no negation. The subject on 人
    // is the whole of what says a predication is being made here.
    expect(run(renZhi(false))).toContain("人にして");
  });

  it("keeps the negated bare-nominal root on its mizenkei", () => {
    // 不亦君子乎？ — no subject anywhere, licensed as it always was by the
    // particle and the negation, and なら〜 rather than にして. That 未然形 なら
    // is what this test is about and is unchanged; the ざる after it moved from
    // ず with the 不亦 carve-out the reader removed (see the describe-level note
    // on the Analects anchors above).
    expect(
      run({
        tokens: [
          { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
          { id: 1, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 2 },
          { id: 2, text: "君子", lemma: "君子", pos: "NOUN", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "乎", lemma: "乎", pos: "PART", xpos: "x", dep: "discourse@sp", head: 2 },
          { id: 4, text: "？", lemma: "？", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("亦た君子ならずや");
  });
});

// ---------------------------------------------------------------------------
// A verb coordinated with a following noun or adjective: the verb hands on in
// 連用形, and the noun predicates with なり. The second half reverses a rule
// that stood here deliberately — see `extraEndingFor`, which used to give such
// a noun the do-verb す. Trees are the ones the wheel returns for the text
// named, exported from the running app.
// ---------------------------------------------------------------------------

describe("a verb coordinated with a nominal or adjectival conjunct", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** 王學而君子。 — the shape, with 君子's part of speech left to the caller.
   *
   * Which one the parser returns for this very text depends on what else is
   * in the same input, and both were measured live: on its own, and as the
   * only line of input, 君子 comes back `VERB` (with its own xpos still
   * reading 名詞,人,役割); inside a longer four-line input it comes back
   * `NOUN`. The relation is `conj:coord` on the root either way. Both
   * readings are pinned below, because the difference between them is the
   * whole of why this rule fires on the sentence in one context and not in
   * the other, and it is not something this file can decide. */
  const wangXueErJunzi = (junziPos: string): Sentence => ({
    tokens: [
      { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 },
      { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 },
      { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 },
      { id: 3, text: "君子", lemma: "君子", pos: junziPos, xpos: "n,名詞,人,役割", dep: "conj:coord", head: 1 },
      { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 1 },
    ],
  });

  it("gives a coordinated noun なり where it used to give it す", () => {
    // 君子 is `conj:coord` on the root 學 and has no subject of its own, so
    // this branch is the only route to an ending for it. It was 王學びて君子す,
    // on the reading that a noun coordinated onto a verb is a denominal
    // action parallel to it; it is the ordinary equative predication now.
    expect(run(wangXueErJunzi("NOUN"))).toBe("王學びて君子なり");
  });

  it("declines to fire where the parse says the conjunct is a verb", () => {
    // The same text, the same relation, tagged VERB — which is what the
    // parser returns for this sentence on its own. The rule asks the parse
    // whether the conjunct is a nominal and takes the answer, so it does not
    // fire, and 君子 closes the sentence with no ending. The UPOS contradicts
    // the token's own xpos here, but resolving that is the tagger's business:
    // second-guessing it in this file would move the problem rather than fix
    // it, and would silently overrule the parse wherever it is right.
    expect(run(wangXueErJunzi("VERB"))).toBe("王學びて君子");
  });

  it("renders 生而神靈 the same way, by whichever route reaches it first", () => {
    // The line the す rule was written for. This parse splits it into 神 as
    // the `subj` of 靈, so the subject rule claims it before the coordination
    // branch is reached — two routes, one `return`, and the ending is written
    // once either way. It read 生きて神靈す before either rule existed.
    // **生じて, not 生きて.** 生 now has a `RESIDUAL` line of its own (ザ変
    // 生ず), because that is what kanbun.info reads over a verbal 生: the kana
    // it writes after the character are ず 27, じ 22 and ぜ 7 — **56** ザ変
    // forms — against the い-word **20** (き 10, く 10) and the う-word **13**
    // (む 8, ま 5). Measured over the whole of that corpus the entry is
    // **−11 edits**, 24 passages closer and 17 further. The received reading
    // of this very line is neither: 史記 五帝本紀 has 生**まれて**神霊 (and
    // 高辛生**れて**神霊なり), the う-word, which no rule keyed on 生 alone can
    // reach — what separates 生まる from 生ず is the sentence and not the
    // character, the same open question the 命 entry in `verbLexicon.ts`
    // records for 命く. So this line pins what the app writes, as it did
    // before, and the word it writes is now the commonest of the three.
    expect(
      run({
        tokens: [
          { id: 0, text: "生", lemma: "生", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 3 },
          { id: 2, text: "神", lemma: "神", pos: "NOUN", xpos: "x", dep: "subj", head: 3 },
          { id: 3, text: "靈", lemma: "靈", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 0 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("生じて神靈なり");
  });

  it("leaves an adjectival conjunct to conjugate itself", () => {
    // "Where required" is nominals only: 賢 comes back ADJ with Degree=Pos and
    // supplies its own ending through the lexicon, so it never reaches the
    // copula branch at all — 王は學びて賢なり, not 賢なりなり.
    //
    // The ending is **なり and not the し this asserted before**, and the change
    // is 賢's own: it is a ナリ活用形容動詞 (賢哉囘也 is 賢なるかな囘や, which the
    // reader has ruled), and its `VERB_LEXICON` entry says so. The claim this
    // test makes is untouched by that — the point is that the conjunct writes
    // *its own* ending rather than being handed the copula the nominal branch
    // supplies, and a paradigm whose 終止形 happens to be なり is the sharpest
    // possible case of it: a second copula here would read 賢なりなり.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 3 },
          { id: 3, text: "賢", lemma: "賢", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王は學びて賢なり");
  });

  it("does not give a ナリ活用形容動詞 a second copula", () => {
    // 仁 carries なり through its own paradigm. It is tagged VERB, so the
    // nominal branch cannot reach it — but this is the case that would show
    // a doubled 仁なりなり if it ever did.
    const out = run({
      tokens: [
        { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 3 },
        { id: 3, text: "仁", lemma: "仁", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
        { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    });
    expect(out).toBe("王は學びて仁なり");
    expect(out).not.toContain("なりなり");
  });

  it("reads 賢 and 大 as the ナリ活用形容動詞 they are, not as ク/シク adjectives", () => {
    // **賢哉囘也 is 賢なるかな囘や**, which is what 論語 prints and what the
    // reader has ruled; the app wrote 賢しきかな. さかし ("clever, shrewd" — the
    // word 小賢しい still carries) is a real Japanese word and a different one
    // from the 賢 of 賢者・不賢, which is the Sino-Japanese けん predicated with
    // なり exactly as 仁 above is. 大 was worse off: its derived entry was
    // ク活用 おお, whose 終止形 大し is おほし — the word modern Japanese writes
    // 多し — and there is no ク活用 adjective 大し at all.
    //
    // Both entries live in `verbLexicon.ts`; each carries its own measurement.
    // 149 gold sentences change for 賢 and 723 for 大.
    //
    // **大's own spelling is おほ + `okuriganaPrefix` い**, which is KANJIDIC2's
    // division of the character (it lists `-おお.いに` among 大's kun) and is what
    // kundoku prints: 大いなるかな, 大いに簡ぶ. It could not be written until
    // `attestedSense` was told which *form* the resolver's okurigana was in —
    // see `okuriganaForm` in `reading/types.ts` — because the ADV/`VerbForm=Conv`
    // 大 arrives with a 連用形 seed, matched no sense against a 終止形
    // conjugation, and fell back on an entry rebuilt from the reading alone,
    // which carries no prefix. Measured over
    // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
    // against a baseline re-rendered immediately before: **691** of the 68,893
    // sentences change and every one of the 706 changes is the same い —
    // 402 大いに, 205 大いなり, 91 大いなる, 8 大いなら — with reading order
    // untouched. **381** of those 402 are the ones the mechanism carries; the
    // other 21 reach the prefix through the plain `VERB_LEXICON` path, which
    // never lost it.
    expect(VERB_LEXICON["賢"]).toEqual({ conjClass: "nari-keiyoudoushi", reading: "けん" });
    expect(VERB_LEXICON["大"]).toEqual({ conjClass: "nari-keiyoudoushi", okuriganaPrefix: "い", reading: "おほ" });
    // 賢哉 — the 終助詞 かな binds a 連体形 (see `EXCLAMATORY_PARTICLE_READINGS`),
    // and what it now binds is なる.
    expect(
      run({
        tokens: [
          { id: 0, text: "賢", lemma: "賢", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos" },
          { id: 1, text: "哉", lemma: "哉", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 0 },
        ],
      }),
    ).toContain("賢なるかな");
    // 大哉 — the same frame on the other character. 大きかな before, and the
    // prefix rides through the same 連体形 the かな binds.
    expect(
      run({
        tokens: [
          { id: 0, text: "大", lemma: "大", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "ROOT", head: 0, morph: "Degree=Pos" },
          { id: 1, text: "哉", lemma: "哉", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 0 },
        ],
      }),
    ).toContain("大いなるかな");
  });

  it("walks to a nominal conjunct, so the verb before it is not the last link", () => {
    // The chain walk required a verb at both ends of every edge, so a verb
    // whose only conjunct is a noun found a chain of one and closed the
    // sentence it is half of. With no 而 present nothing else supplies the
    // 連用形 — the 而 rule in `decideConjForm` is what hides this wherever a
    // 而 is written, which is why the asyndetic shape is the one to pin.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "君子", lemma: "君子", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王學び君子なり");
  });

  it("does not widen what parataxis may reach", () => {
    // `parataxis` is the relation that also links a quotative frame to what
    // it introduces and an appositive to its host, so the far end of one of
    // those edges stays verb-only — a nominal across it is not a conjunct
    // and must not demote the verb before it.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "君子", lemma: "君子", pos: "NOUN", xpos: "x", dep: "parataxis", head: 1 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王學ぶ君子");
  });

  // The all-verb chain anchor (食肉飲酒歌舞。 -> 肉を食ひ酒を飲み舞ふ歌ふ) is
  // not repeated here: it already has its own test above, on the tree the
  // parser really returns, and it is what guards the walk against admitting
  // nominals having changed anything verb-to-verb.
});

// ---------------------------------------------------------------------------
// 而 behind a punctuation mark. The mark decides how 而 is *read*; what stands
// before it is the coordination chain's business wherever there is one. Trees
// are the ones the wheel returns for the text named, parsed on its own and
// exported from the running app.
// ---------------------------------------------------------------------------

describe("a 而 set off behind a mark (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("keeps the chain's 連用形 in front of it, and 而して after", () => {
    // 種黍；而富 — the ； does not split a sentence (it is medial, not final),
    // so the mark and the 而 sit together in one tree and the punctuation
    // heuristic could see them. It read 黍を種う、而して富む: 終止形 closing a
    // sentence, and then a "moreover" carrying on from the sentence it had
    // just closed. The parse says 富 is coordinated onto 種, so 種 is not the
    // predicate that ends anything — 連用中止法 is what the ； wants.
    expect(
      run({
        tokens: [
          { id: 0, text: "種", lemma: "種", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "黍", lemma: "黍", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 2, text: "；", lemma: "；", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
          { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 4 },
          { id: 4, text: "富", lemma: "富", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 0, morph: "Degree=Pos" },
        ],
      }),
    ).toBe("黍を種ゑ、而して富む");
  });

  it("does the same for a 、, on 勸學's own line", () => {
    // 青取之於藍、而青於藍。 read 取る、而して. The hand-built tree for this
    // line elsewhere in this file omits the 、 token altogether, which is why
    // it never caught this: with the mark absent the heuristic could not fire.
    expect(
      run({
        tokens: [
          { id: 0, text: "青", lemma: "青", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "取", lemma: "取", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 1, morph: "Person=3|PronType=Prs" },
          { id: 3, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "comp:obl", head: 1 },
          { id: 4, text: "藍", lemma: "藍", pos: "PROPN", xpos: "x", dep: "comp:obj", head: 3, morph: "Case=Loc|NameType=Geo" },
          { id: 5, text: "、", lemma: "、", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
          { id: 6, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 7 },
          { id: 7, text: "青", lemma: "青", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
          { id: 8, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 7 },
          { id: 9, text: "藍", lemma: "藍", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 8 },
          { id: 10, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 7 },
        ],
      }),
    ).toBe("青は之を藍より取り、而して藍より青し");
  });

  it("leaves the mark in charge where no chain contradicts it", () => {
    // Nothing is coordinated onto 學 here, so the heuristic is still the only
    // evidence about what the 而 is doing and still decides — 終止形.
    expect(
      run({
        tokens: [
          { id: 0, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "、", lemma: "、", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 3 },
          { id: 3, text: "禮", lemma: "禮", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
        ],
      }),
    ).toContain("學ぶ");
  });

  it("renders the parser's own analysis faithfully, locative and all", () => {
    // 輒半種黍；而家豪富 as the parser returns it. 家 carries `Case=Loc` and
    // means "at home", and it still takes にして — which looks like the copula
    // rule misfiring on an adjunct and is not: にして is the 連用形, and it is
    // there because a further conjunct (豪, then 富) follows. The locative
    // feature has no part in it.
    //
    // A `Case=Loc` guard was written here to suppress that にして and has been
    // taken out again: it compensated for the tree rather than fixing
    // anything, buying nothing on the corrected tree (where 家 is a `subj`
    // and this branch is never reached) and, on this one, only trading
    // 家にして豪富む for the equally wrong 家豪富む. What is wrong here is that
    // 豪富 is one adjectival predicate with 家 as its subject and the parser
    // has split it in two — see the corrected tree below. Pinned as it reads
    // so that the faithful output stays visible and a guard cannot come back
    // unnoticed.
    const s: Sentence = {
      tokens: [
        { id: 0, text: "輒", lemma: "輒", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "AdvType=Tim" },
        { id: 1, text: "半", lemma: "半", pos: "ADJ", xpos: "x", dep: "mod", head: 2, morph: "Degree=Pos" },
        { id: 2, text: "種", lemma: "種", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "黍", lemma: "黍", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 4, text: "；", lemma: "；", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        { id: 5, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 6 },
        { id: 6, text: "家", lemma: "家", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 2, morph: "Case=Loc" },
        { id: 7, text: "豪", lemma: "豪", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 6 },
        { id: 8, text: "富", lemma: "富", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 7, morph: "Degree=Pos" },
      ],
    };
    // Each of 家/豪/富 gets its own ending, because the tree really does
    // coordinate three predicates onto 種 in a chain — 家 onto 種, 豪 onto 家,
    // 富 onto 豪. 豪 used to get none, not because it was not a clause head
    // but because the clause-head test only looked one edge from the root and
    // could not see past 家. Faithful to a tree that is itself wrong: the
    // corrected analysis has 豪富 as one `flat` span and gets one 豪富にして.
    //
    // **輒ち and not すなはち**, here and in the two sentences below that share
    // this 白文. 輒's entry in `overrides.json` was the only one of the
    // すなはち-class connectives without `spellOutInProse: false`, so it alone
    // printed its reading in kana while 則 and 乃 kept their character;
    // kanbun.info writes 輒ち 2 times out of 2 and すなはち never. See that
    // entry.
    expect(run(s)).toBe("輒ち半ば黍を種ゑ、而して家にして豪にして富む");
  });

  it("renders the corrected tree the way the reading calls for", () => {
    // The analysis the raw parser does not reach: 豪富 is one adjectival
    // predicate with 家 as its subject, coordinated onto 種 — not the flat
    // 種→家→豪→富 chain of nominals the parser returns. Fed in through the
    // CoNLL-U upload path rather than by fighting the parser into this shape,
    // so the tree under test is exactly the one written down.
    //
    // Three things have to come together: 種 takes 連用形 because an
    // adjective is coordinated onto it (not merely because a mark precedes
    // the 而), 家 is a subject and so takes は rather than any copula, and
    // 豪富 carries the one なり for the whole predicate.
    const s: Sentence = {
      tokens: [
        { id: 0, text: "輒", lemma: "輒", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "AdvType=Tim" },
        { id: 1, text: "半", lemma: "半", pos: "ADJ", xpos: "x", dep: "mod", head: 2, morph: "Degree=Pos" },
        { id: 2, text: "種", lemma: "種", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "黍", lemma: "黍", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 4, text: "；", lemma: "；", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        { id: 5, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 7 },
        { id: 6, text: "家", lemma: "家", pos: "NOUN", xpos: "x", dep: "subj", head: 7, morph: "Case=Loc" },
        { id: 7, text: "豪富", lemma: "豪富", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 2, morph: "Degree=Pos" },
      ],
    };
    expect(run(s)).toBe("輒ち半ば黍を種ゑ、而して家は豪富なり");
  });

  it("gives a multi-character token the same ending both panels show", () => {
    // 豪富 is one token of two characters, which `KundokuView`'s
    // `compoundGroupCell` renders through the same function it renders a
    // fused span with — passing `isDenominalCompound` for both. This loop had
    // no branch for a multi-character token and reached `extraEndingFor` with
    // that flag off, so the 訓読文 showed 豪富ナリ while the prose showed a
    // bare 豪富. A whole-word reading has no okurigana of its own to carry an
    // ending, and that is as true of a token the tokenizer fused as of a span
    // this app did.
    // Minimal shape: the flag is read only inside the coordinate-clause
    // branch, so the conjunct relation is what has to be present, not merely
    // a two-character token.
    const s: Sentence = {
      tokens: [
        { id: 0, text: "種", lemma: "種", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "豪富", lemma: "豪富", pos: "ADJ", xpos: "x", dep: "conj:coord", head: 0, morph: "Degree=Pos" },
        { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      ],
    };
    expect(run(s)).toContain("豪富なり");
  });

});

// ---------------------------------------------------------------------------
// Either side of a coordination heads a clause. Which of two coordinated
// predicates the parser makes the head is a fact about the tree, not about
// the reading, so the same sentence written either way round must render the
// same. Trees fed through the shape the CoNLL-U upload path produces.
// ---------------------------------------------------------------------------

describe("a first conjunct is a clause head too (real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** 而家豪富、不以飲為累也。 with the 豪富–為 coordination pointing either way.
   * `firstIsRoot` is the analysis the reading implies (豪富 first, 為 hanging
   * off it); the other is the same coordination with the head swapped. */
  const haofu = (firstIsRoot: boolean): Sentence => ({
    tokens: [
      { id: 0, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 2 },
      { id: 1, text: "家", lemma: "家", pos: "NOUN", xpos: "x", dep: "subj", head: 2, morph: "Case=Loc" },
      { id: 2, text: "豪富", lemma: "豪富", pos: "ADJ", xpos: "x", morph: "Degree=Pos",
        ...(firstIsRoot ? { dep: "ROOT", head: 2 } : { dep: "conj:coord", head: 7 }) },
      { id: 3, text: "、", lemma: "、", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
      { id: 4, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 7, morph: "Polarity=Neg" },
      { id: 5, text: "以", lemma: "以", pos: "VERB", xpos: "x", dep: "mod", head: 7 },
      { id: 6, text: "飲", lemma: "飲", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 5 },
      { id: 7, text: "為", lemma: "爲", pos: "VERB", xpos: "x",
        ...(firstIsRoot ? { dep: "conj:coord", head: 2 } : { dep: "ROOT", head: 7 }) },
      { id: 8, text: "累", lemma: "累", pos: "NOUN", xpos: "x", dep: "comp:pred", head: 7 },
      { id: 9, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 7 },
      { id: 10, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
    ],
  });

  it("gives the first conjunct its copula, as it always gave the second", () => {
    // 豪富 as the ROOT got no ending at all: the clause-head test asked only
    // whether the token was a `conj:coord`, so the *first* conjunct — which
    // is the ROOT precisely because it comes first — never qualified. It is
    // 連用形 rather than 終止形 because 為 still follows.
    expect(run(haofu(true))).toContain("豪富にして");
  });

  it("renders the same coordination the same way whichever end heads it", () => {
    // The one thing this fix is for. The two differ only in the topic は on
    // 家, which comes from a separate rule with the same first-conjunct blind
    // spot (`isTopicalizedAdjective`) — reported, not changed here.
    expect(run(haofu(true)).replace("家", "家は")).toBe(run(haofu(false)));
  });

  it("hands no ending to a verbal clause head that now qualifies", () => {
    // 生 and 學 are verbal ROOTs with a conjunct on them, so both are clause
    // heads under the widened test where neither was before. What the branch
    // returns is gated on the token being a nominal or a `Degree=Pos`
    // denominal compound, and a plain verb is neither.
    expect(
      run({
        tokens: [
          { id: 0, text: "生", lemma: "生", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 3 },
          { id: 2, text: "神", lemma: "神", pos: "NOUN", xpos: "x", dep: "subj", head: 3 },
          { id: 3, text: "靈", lemma: "靈", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 0 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
        ],
      }),
      // 生じて for the reason the same line records a few hundred lines above:
      // 生 has a `RESIDUAL` ザ変 entry of its own now.
    ).toBe("生じて神靈なり");
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 3 },
          { id: 3, text: "君子", lemma: "君子", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王學びて君子なり");
  });

  it("leaves a ROOT with no conjunct alone", () => {
    // 而家豪富。 on its own. The widened test needs a `conj:coord` child, and
    // there is none, so this is untouched — it gets no copula, which is a
    // separate pre-existing gap and not this fix's business.
    expect(
      run({
        tokens: [
          { id: 0, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 2 },
          { id: 1, text: "家", lemma: "家", pos: "NOUN", xpos: "x", dep: "subj", head: 2, morph: "Case=Loc" },
          { id: 2, text: "豪富", lemma: "豪富", pos: "ADJ", xpos: "x", dep: "ROOT", head: 2, morph: "Degree=Pos" },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("而して家豪富");
  });

  it("takes the ざり rentaikei before an assertive 也", () => {
    // 也 reads なり, the 断定 auxiliary, and an auxiliary attaches to a
    // 連体形 — 累と為せず + なり was ending the clause twice over. ざる rather
    // than ぬ because the ざり paradigm is what carries a following
    // auxiliary; ぬ is for a following noun.
    //
    // 為せ, not 為さ: `VERB_LEXICON["爲"]` is サ変 with the reading な, whose
    // 未然形 is せ. The class comes from the lexicon, not from the surface.
    expect(run(haofu(true))).toContain("為せざるなり");
  });

  it("still gives the ざり-paradigm 連体形 and not the なり-driven one", () => {
    // The discrimination this pins is unchanged: 也 reads なり and pulls a 連体形
    // as an *auxiliary*, while 乎 is や and 矣 unread, so neither of those two
    // does. What reaches 連体形 here instead is the 係り結び — や binds its
    // predicate — which the 不亦 carve-out used to refuse and which the reader
    // has restored (see the describe-level note on the Analects anchors above).
    // Both routes write ざる, so the assertion below no longer separates them on
    // its own; the sentence next door (為せざるなり) is where the なり route is
    // pinned.
    expect(
      run({
        tokens: [
          { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
          { id: 1, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 2 },
          { id: 2, text: "說", lemma: "說", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "乎", lemma: "乎", pos: "PART", xpos: "x", dep: "discourse@sp", head: 2 },
          { id: 4, text: "？", lemma: "？", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("亦た說ばしからずや");
  });
});

// ---------------------------------------------------------------------------
// 酒蟲, sentence 4, exactly as the user's hand-corrected file has it. The
// coordination here is nested two edges below the root and its first conjunct
// is half of a `flat` span, which is the shape real text keeps producing and
// none of the synthetic trees above had.
// ---------------------------------------------------------------------------

describe("a nested coordination whose conjunct is a span (the 酒蟲 tree)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** 負郭田三百畝、輒半種黍；而家豪富、不以飲為累也。
   *
   * The root is 三百 (a numeral predication), 種 is `parataxis` onto it, and
   * the 豪富 clause is `conj:coord` onto 種 — two edges down. 豪 and 富 are a
   * `flat` span with 豪 as its carrier, and 為 is coordinated onto 富, the
   * member that is *not* the carrier. */
  const jiuChong: Sentence = {
    tokens: [
      { id: 0, text: "負", lemma: "負", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "mod", head: 1 },
      { id: 1, text: "郭", lemma: "郭", pos: "NOUN", xpos: "n,名詞,固定物,建造物", dep: "mod", head: 2, morph: "Case=Loc" },
      { id: 2, text: "田", lemma: "田", pos: "NOUN", xpos: "n,名詞,固定物,地形", dep: "subj", head: 3, morph: "Case=Loc" },
      { id: 3, text: "三百", lemma: "三百", pos: "NUM", xpos: "n,数詞,数,*", dep: "ROOT", head: 3 },
      { id: 4, text: "畝", lemma: "畝", pos: "NOUN", xpos: "n,名詞,度量衡,*", dep: "clf", head: 3, morph: "NounType=Clf", misc: { Reading: "ほ" } },
      { id: 5, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 },
      { id: 6, text: "輒", lemma: "輒", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 8, morph: "AdvType=Tim" },
      { id: 7, text: "半", lemma: "半", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "mod", head: 8, morph: "Degree=Pos" },
      { id: 8, text: "種", lemma: "種", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "parataxis", head: 3 },
      { id: 9, text: "黍", lemma: "黍", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 8 },
      { id: 10, text: "；", lemma: "；", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 3 },
      { id: 11, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 13 },
      { id: 12, text: "家", lemma: "家", pos: "NOUN", xpos: "n,名詞,固定物,建造物", dep: "subj", head: 13, morph: "Case=Loc" },
      { id: 13, text: "豪", lemma: "豪", pos: "ADJ", xpos: "n,名詞,描写,態度", dep: "conj:coord", head: 8 },
      { id: 14, text: "富", lemma: "富", pos: "ADJ", xpos: "n,名詞,可搬,成果物", dep: "flat", head: 13 },
      { id: 15, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 11 },
      { id: 16, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 19, morph: "Polarity=Neg" },
      { id: 17, text: "以", lemma: "以", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "mod", head: 19 },
      { id: 18, text: "飲", lemma: "飲", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 17 },
      { id: 19, text: "為", lemma: "爲", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "conj:coord", head: 14 },
      { id: 20, text: "累", lemma: "累", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:pred", head: 19 },
      { id: 21, text: "也", lemma: "也", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 20 },
      { id: 22, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 19 },
    ],
  };

  it("gives the nested conjunct its copula", () => {
    // 豪 is `conj:coord` two edges below the root (三百 ← 種 ← 豪), and the
    // clause-head test used to require the conjunct hang directly off the
    // root. The ending lands after 富, not between the two — it is the span's,
    // not the carrier's.
    expect(run(jiuChong)).toContain("豪富にして");
    expect(run(jiuChong)).not.toContain("豪にして");
  });

  it("sees the conjunct that hangs off the span's other member", () => {
    // にして and not なり: 為 is coordinated onto 富, the member that is not
    // the carrier, so the walk has to look through the `flat` edge to find
    // it. Without that it saw no conjunct after 豪富 and closed the clause.
    expect(run(jiuChong)).not.toContain("豪富なり");
  });

  it("puts the verb before it on 連用形 too", () => {
    // 種 has that same 豪 coordinated onto it, so it hands on rather than
    // closing — 黍を種ゑ, not 黍を種う. It read 種う because 豪 is tagged ADJ
    // and only a verb or a bare nominal counted as a further link.
    expect(run(jiuChong)).toContain("種ゑ");
    expect(run(jiuChong)).not.toContain("種う");
  });
});

// ---------------------------------------------------------------------------
// The three routes to a Sino-Japanese reading, in the prose panel, on the rows
// 酒蟲 actually returns. Each of these printed something else before: 果然す
// for a pair kanbun reads kun throughout, and a bare 蠕動 for a span JMdict
// calls a する-verb. The 訓読文's own copies of these decisions were checked
// against the live page at the same time — 果はタシテ然しかリ and 蠕ぜん動だうス —
// since the two panels agreeing is the point of the shared helpers.
// ---------------------------------------------------------------------------

describe("酒蟲: on'yomi pairs and fused spans (real parse rows, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("劉使試之、果然 -> ends はたして然り, not 果然す", () => {
    // 果然 is a JMdict headword (かぜん) whose reading splits into two attested
    // on'yomi, so the pair rule accepted it and the head 然, tagged VERB, took
    // サ変. Standard kundoku reads it はたして然り throughout.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "劉", lemma: "劉", pos: "PROPN", xpos: "x", dep: "subj", head: 2, morph: "NameType=Giv" },
        { id: 1, text: "使", lemma: "使", pos: "VERB", xpos: "x", dep: "flat", head: 0 },
        { id: 2, text: "試", lemma: "試", pos: "VERB", xpos: "x", dep: "subj", head: 6 },
        { id: 3, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 2, morph: "Person=3|PronType=Prs" },
        { id: 4, text: "、", lemma: "、", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        { id: 5, text: "果", lemma: "果", pos: "VERB", xpos: "x", dep: "mod", head: 6, morph: "ExtPos=VERB" },
        { id: 6, text: "然", lemma: "然", pos: "ADJ", xpos: "x", dep: "ROOT", head: 6, morph: "Degree=Pos" },
      ],
    };
    expect(run(sentence)).toContain("果たして然り");
    expect(run(sentence)).not.toContain("果然");
  });

  it("豈飲啄固有數乎 -> もとより…有り, not 固有す", () => {
    // The same shape, the second one in this text: 固有 is JMdict's こゆう, and
    // 有's own curated VERB entry is what stands the pair rule down.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "豈", lemma: "豈", pos: "ADV", xpos: "x", dep: "mod", head: 1 },
        { id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "x", dep: "subj", head: 4 },
        { id: 2, text: "啄", lemma: "啄", pos: "VERB", xpos: "x", dep: "flat@vv", head: 1 },
        { id: 3, text: "固", lemma: "固", pos: "ADV", xpos: "x", dep: "mod", head: 4 },
        { id: 4, text: "有", lemma: "有", pos: "VERB", xpos: "x", dep: "ROOT", head: 4 },
        { id: 5, text: "數", lemma: "數", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 4 },
      ],
    };
    // 固より, not a spelled-out もとより: 固 is now in `KANJI_RETAINED_ADVERBS`
    // (an adverb is a content word with a dictionary reading, which is the whole
    // of what that table asserts), so the character stays and もと goes over it.
    expect(run(sentence)).toContain("固より");
    expect(run(sentence)).toContain("有り");
    expect(run(sentence)).not.toContain("有す");
    // …and the 飲啄 span beside it takes サ変 of its own. No dictionary lists
    // 飲啄, which is why it printed as two bare characters for as long as the
    // ending was gated on JMdict's `vs` tag; it is いん+たく, on'yomi
    // throughout, over a VERB carrier, and that is the whole of the reader's
    // rule for it.
    expect(run(sentence)).toContain("飲啄す");
  });

  it("蠕動如游魚 -> 蠕動す, while 游魚 in the same clause stays bare", () => {
    // 蠕動 is "noun or participle which takes the aux. verb する" and 游魚 is a
    // plain noun. Both are spans of identical shape, so the dictionary's part
    // of speech is the only thing that separates them — and it must, or one
    // would print with an ending it has no claim to.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "蠕", lemma: "蠕", pos: "VERB", xpos: "x", dep: "subj", head: 2 },
        { id: 1, text: "動", lemma: "動", pos: "VERB", xpos: "x", dep: "flat@vv", head: 0 },
        { id: 2, text: "如", lemma: "如", pos: "VERB", xpos: "x", dep: "ROOT", head: 2, morph: "Degree=Equ" },
        { id: 3, text: "游", lemma: "游", pos: "VERB", xpos: "x", dep: "mod", head: 4, morph: "VerbForm=Part" },
        { id: 4, text: "魚", lemma: "魚", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
      ],
    };
    expect(run(sentence)).toContain("蠕動す");
    // 游魚の, not 游魚に: what a positive 如 is compared *to* is a genitive.
    // See `caseParticleFor`'s 如 branches — the に belongs to the negated
    // 〜に如かず and to that alone.
    expect(run(sentence)).toContain("游魚の");
    expect(run(sentence)).not.toContain("游魚す");
  });

  it("writes the span's own サ変 after a span, not a member's verb class", () => {
    // 俯臥 is in no dictionary, and 俯 on its own resolves to ふ+す (四段サ行)
    // carrying `beatsLexicon` for it. The two answers spell the same 終止形 and
    // part company everywhere else — サ行四段's 未然形 is さ and サ変's is せ —
    // so the ending has to be the *span's*, which is what `suruCompound` says
    // and what this asserts by conjugating it.
    // The closing 。 is load-bearing since the title rule landed: a fused span
    // that is the whole of an *unpunctuated* sentence writes no ending at all
    // (see `isUnpunctuatedTitleSpan`). This fixture is about the span mechanism
    // rather than about titles, so it says so with a mark and asserts exactly
    // what it did.
    const bare: Sentence = {
      tokens: [
        { id: 0, text: "俯", lemma: "俯", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "臥", lemma: "臥", pos: "VERB", xpos: "x", dep: "flat@vv", head: 0 },
        { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      ],
    };
    expect(run(bare)).toBe("俯臥す");
    const negated: Sentence = {
      tokens: [
        ...bare.tokens,
        { id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 0, morph: "Polarity=Neg" },
      ],
    };
    expect(run(negated)).toBe("俯臥せず");
  });

  it("puts the caused predicate 俯臥 in 未然形 せ for the しむ that follows", () => {
    // The reader's 但令於日中俯臥 (酒蟲 sent_id 20). Two things had to be true
    // at once for this line: the span needed a サ変 ending at all — it had
    // none, JMdict not listing 俯臥 — and 俯 needed to be read as the caused
    // predicate rather than as the causee, which is the annotation's business
    // and not this app's. `isCausedPredicateOf` admits `comp:obl`, `comp:aux`,
    // a verbal `comp:obj` and a verbal `parataxis`, and the four read
    // identically.
    const causative = (dep: string): Sentence => ({
      tokens: [
        { id: 0, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 },
        { id: 1, text: "俯", lemma: "俯", pos: "VERB", xpos: "v,動詞,行為,動作", dep, head: 0 },
        { id: 2, text: "臥", lemma: "臥", pos: "VERB", xpos: "v,動詞,行為,姿勢", dep: "flat@vv", head: 1 },
      ],
    });
    // The file the reader is correcting has 俯 on `comp:obj` instead, and that
    // reads the same now. It did not: the causative machinery admitted three
    // relations and not this one, so the span fell to
    // `isNominalizedObjectPredicate` and printed 俯臥**するを**しむ — a 連体形
    // and an object marker wedged between the act and the auxiliary that
    // causes it. `comp:obj` is not a mis-annotation to be compensated for; it
    // is what gold writes for 332 of the 1,470 verbal complements of a
    // causative, and object-majority for 敎 (19 oblique / 35 object). The two
    // labels say the same thing about the same construction and the app now
    // reads either. See `isCausedPredicateOf` for the counts.
    for (const dep of ["comp:obl", "comp:aux", "comp:obj", "parataxis"]) {
      expect(run(causative(dep)), dep).toBe("俯臥せしむ");
    }
  });

  it("使民戰 -> 民をして戰はしむ — the caused predicate takes no oblique に", () => {
    // The regression this guards. SUD gives a causative its governed predicate
    // on `comp:obl`, which is one of `OBLIQUE_DEPS`, so
    // `isNominalizedObliquePredicate` saw a verb on an oblique edge under a
    // verbal governor and marked it: 民をして戰は*に*しむ, a に wedged between the
    // 未然形 and the しむ.
    //
    // The 俯臥 case above did not catch it, and the reason is worth recording:
    // 俯 has 臥 read after it, so the rule's own end-of-clause test
    // (`readsLastInItsSubtree`) already withheld the particle there. 戰 is
    // childless, so nothing stood between it and the に. A caused predicate has
    // to be excluded because the auxiliary owns it, not because something
    // happens to follow it.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "使", lemma: "使", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 },
        { id: 1, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 0 },
        { id: 2, text: "戰", lemma: "戰", pos: "VERB", xpos: "v,動詞,行為,戦争", dep: "comp:obl", head: 0 },
      ],
    };
    expect(run(sentence)).toBe("民をして戰はしむ");
    expect(run(sentence)).not.toContain("戰はに");
  });

  it("the exclusion is the auxiliary's claim, not the causative lemma alone", () => {
    // Same shape with a non-causative governor: 得 on `comp:obl` under 苦 is a
    // genuine nominalized oblique and keeps its 連体形 + に. So the guard added
    // for 使民戰 removes the particle exactly where an auxiliary governs the
    // predicate, and nowhere else — the two rules coexist rather than one
    // shadowing the other.
    const oblique: Sentence = {
      tokens: [
        { id: 0, text: "苦", lemma: "苦", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos", misc: { Reading: "くる", Okurigana: "しむ" } },
        { id: 1, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "comp:obl", head: 0 },
      ],
    };
    expect(run(oblique)).toBe("得るに苦しむ");
  });
});

// ---------------------------------------------------------------------------
// 需 as 貰ふ. KANJIDIC2 gives 需 no kun'yomi at all, so `SUPPLEMENTARY_KUN`
// supplies the reading and `RESIDUAL` the class — neither table alone makes
// the word conjugate, which is what the entry it replaces (a class-less
// もらゑる) could not do.
// ---------------------------------------------------------------------------

describe("需 is 貰ふ, ハ行四段", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("names the whole paradigm the reader chose", () => {
    const lex = VERB_LEXICON["需"];
    expect(lex.reading).toBe("もら");
    expect(lex.conjClass).toBe("yodan-ha");
    // もらは / もらひ / もらふ / もらふ / もらへ. 已然形 is asserted here and
    // not through a sentence: nothing in `generator.ts` asks for one.
    expect((["mizen", "renyou", "shuushi", "rentai", "izen"] as const).map((f) => lex.reading! + conjugate(lex.conjClass!, f)))
      .toEqual(["もらは", "もらひ", "もらふ", "もらふ", "もらへ"]);
  });

  it("需藥。 -> 藥を需ふ — the 終止形, where the old entry froze at もらゑる", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "需", lemma: "需", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "藥", lemma: "藥", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("藥を需ふ");
  });

  it("不需藥。 -> 藥を需はず — the 未然形", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Polarity=Neg" },
          { id: 1, text: "需", lemma: "需", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "藥", lemma: "藥", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("藥を需はず");
  });

  it("需藥而去。 -> 藥を需ひて去ぬ — the 連用形, with the connecting て an い-sound takes", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "需", lemma: "需", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "藥", lemma: "藥", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 3 },
          { id: 3, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 0 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("藥を需ひて去ぬ");
  });
});

// ---------------------------------------------------------------------------
// タリ活用形容動詞 — the suffix-driven rule.
//
// Rows below carry the real XPOS (`p,接尾辞,*,*`), because that tag is the
// whole discriminator and a test written with the placeholder `xpos: "x"`
// every other block here uses would exercise nothing. Verified against a live
// parse of each string: 愕然 comes back 愕 VERB/`v,動詞,行為,態度` + 然
// PART/`p,接尾辞,*,*`/`unk`, and 莞爾 the same shape.
// ---------------------------------------------------------------------------

describe("タリ活用形容動詞 (suffix-driven, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  const SUFFIX_XPOS = "p,接尾辞,*,*";
  const gaku = (dep: string, head: number): Token =>
    ({ id: 0, text: "愕", lemma: "愕", pos: "VERB", xpos: "v,動詞,行為,態度", dep, head, morph: "ExtPos=VERB" });
  const zen = (head: number, dep = "unk"): Token =>
    ({ id: 1, text: "然", lemma: "然", pos: "PART", xpos: SUFFIX_XPOS, dep, head });

  it("愕然。 -> 愕然たり — the 終止形, where before the rule there was no ending at all", () => {
    expect(
      run({
        tokens: [
          gaku("ROOT", 0),
          zen(0),
          { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("愕然たり");
  });

  it("愕然者 -> 愕然たる者 — the paradigm is live, not a frozen たり", () => {
    // The whole reason the resolver names `tari-keiyoudoushi` rather than
    // handing back the string たり: a following 者 wants the 連体形, and only a
    // class can supply one.
    expect(
      run({
        tokens: [
          gaku("mod", 2),
          zen(0),
          { id: 2, text: "者", lemma: "者", pos: "PART", xpos: "p,助詞,提示,*", dep: "ROOT", head: 2 },
        ],
      }),
    ).toContain("愕然たる");
  });

  it("莞爾而笑。 -> 莞爾として笑ふ — the 連用形 として before a 而", () => {
    // として, not と, and not としてて: the paradigm writes the whole connective
    // (the same arrangement `COPULA.renyou`'s にして has) and the 而 standing
    // after it writes nothing of its own.
    expect(
      run({
        tokens: [
          { id: 0, text: "莞", lemma: "莞", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos|ExtPos=VERB" },
          { id: 1, text: "爾", lemma: "爾", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 0 },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 },
          { id: 3, text: "笑", lemma: "笑", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 0 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("莞爾として笑ふ");
  });

  it("王卒然問之。 -> 卒然として — the 連用形 from the stem's own VerbForm=Conv", () => {
    // No 而 here at all: the stem carries Conv, `conjugationSubject` hands that
    // to `decideConjForm`, and the 連用形 it asks for is the whole として.
    // `converbSuffix` adds nothing on top — タリ is not an い-sound class.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "PROPN", xpos: "n,名詞,主体,人", dep: "subj", head: 3 },
          { id: 1, text: "卒", lemma: "卒", pos: "VERB", xpos: "v,動詞,変化,終了", dep: "mod", head: 3, morph: "VerbForm=Conv" },
          { id: 2, text: "然", lemma: "然", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 1 },
          { id: 3, text: "問", lemma: "問", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 3 },
          { id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人,他称", dep: "comp:obj", head: 3 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 3 },
        ],
      }),
    ).toContain("卒然として");
  });

  it("愕然、而笑。 -> the chain outranks the mark — 愕然として、而して笑ふ", () => {
    // This expected 愕然たり、而して until タリ was let into the coordination
    // rule, and the reason it changed is the rule `decideConjForm`'s 而 branch
    // already stated for verbs: an explicit chain outranks the punctuation
    // heuristic, because a mark is evidence about how the author broke the
    // line up and cannot close a clause the tree says is still open (輒半種黍；
    // 而家豪富 is 黍を種ゑ、而して, not 種う、而して). 笑 is `conj:coord` onto
    // 愕, so 愕然 is non-final and takes として.
    //
    // Both halves are then written, and that is the point of the assertion.
    // The 而's own stand-down (`precedingFormSuppliesShite`) exists to stop a
    // second て landing on a 連用形 that already contains one; 而して is a
    // reading over 而 itself and doubles nothing, so it survives — 愕然として、
    // 而して笑ふ, not the 愕然として、笑ふ the stand-down gave before it learned
    // the difference.
    const out = run({
      tokens: [
        gaku("ROOT", 0),
        zen(0),
        { id: 2, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 },
        { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 },
        { id: 4, text: "笑", lemma: "笑", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 0 },
        { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
      ],
    });
    expect(out).toBe("愕然として、而して笑ふ");
    expect(out).not.toContain("たり");
    expect(out).not.toContain("としてて");
    expect(out).not.toContain("してして");
  });

  it("劉愕然、便求醫療。 -> 劉愕然として — a chain with no 而 in it at all", () => {
    // The reader's own sent_id 14. 求 is `conj:coord` onto 愕 with only a 、
    // between them, so nothing but the chain says 愕然 is non-final — and
    // nothing else can: this is the shape the old adjectival exclusion left
    // reading 劉愕然たり、すなはち醫療を求む, a 終止形 in mid-sentence.
    //
    // として is たり's own 連用形, so this is 連用中止法 and no て is appended
    // to it — the reader's settled rule for coordinate predicates (see
    // `converbSuffix`'s closing note).
    expect(
      run({
        tokens: [
          { id: 1, text: "劉", lemma: "劉", pos: "PROPN", xpos: "n,名詞,人,姓氏", dep: "subj", head: 2, morph: "NameType=Sur" },
          { id: 2, text: "愕", lemma: "愕", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "ROOT", head: 2, morph: "ExtPos=VERB" },
          { id: 3, text: "然", lemma: "然", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 2 },
          { id: 4, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 1 },
          { id: 5, text: "便", lemma: "便", pos: "ADV", xpos: "v,動詞,描写,形質", dep: "mod", head: 6, morph: "Degree=Pos|VerbForm=Conv" },
          { id: 6, text: "求", lemma: "求", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord", head: 2 },
          { id: 7, text: "醫", lemma: "醫", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "compound", head: 8 },
          { id: 8, text: "療", lemma: "療", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 6 },
          { id: 9, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("劉愕然として、すなはち醫療を求む");
  });

  /** The same sentence with 愕 tagged **ADJ**, which is what the reader's own
   * tree of 酒蟲 now holds — the parser tags a descriptive VERB with
   * `Degree=Pos` most of the time and sometimes uses the plain tag instead.
   * The test above passed throughout while the reader's file printed
   * 劉愕然たり, because `isNonFinalCoordinand` admitted an ADJ as a link the
   * walk *arrives at* and not as the token the form question is *put to*. */
  const gakuAdj = (dep: string, head: number): Token =>
    ({ id: 0, text: "愕", lemma: "愕", pos: "ADJ", xpos: "v,動詞,行為,態度", dep, head, morph: "ExtPos=VERB" });

  it("劉愕然、便求醫療。 with 愕 tagged ADJ -> 劉愕然として, the same as the VERB tagging", () => {
    expect(
      run({
        tokens: [
          { id: -1, text: "劉", lemma: "劉", pos: "PROPN", xpos: "n,名詞,人,姓氏", dep: "subj", head: 0, morph: "NameType=Sur" },
          gakuAdj("ROOT", 0),
          zen(0),
          { id: 2, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: -1 },
          { id: 3, text: "便", lemma: "便", pos: "ADV", xpos: "v,動詞,描写,形質", dep: "mod", head: 4, morph: "Degree=Pos|VerbForm=Conv" },
          { id: 4, text: "求", lemma: "求", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord", head: 0 },
          { id: 5, text: "醫", lemma: "醫", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "compound", head: 6 },
          { id: 6, text: "療", lemma: "療", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 4 },
          { id: 7, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("劉愕然として、すなはち醫療を求む");
  });

  it("愕然。 with 愕 tagged ADJ still closes on たり — non-finality is the condition, not the tag", () => {
    // として is not what a タリ活用 takes wherever it stands: a predicate that
    // ends its sentence takes the 終止形, and nothing but a further conjunct
    // demotes it. Chain of one, so 終止形.
    expect(
      run({
        tokens: [
          gakuAdj("ROOT", 0),
          zen(0),
          { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
        ],
      }),
    ).toBe("愕然たり");
  });

  it("writes no doubled て anywhere a タリ predicate hands on", () => {
    // The three shapes the ending can meet — a 而, a mark, and nothing — with
    // one assertion each that the して is written exactly once.
    const withEru = run({
      tokens: [
        gaku("ROOT", 0),
        zen(0),
        { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 },
        { id: 3, text: "笑", lemma: "笑", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 0 },
      ],
    });
    expect(withEru).toBe("愕然として笑ふ");
    expect(withEru).not.toContain("としてて");
    expect(run({ tokens: [gaku("ROOT", 0), zen(0)] })).toBe("愕然たり");
  });

  it("reads the whole binom on'yomi, divided one share per character", () => {
    const sentence: Sentence = { tokens: [gaku("ROOT", 0), zen(0)] };
    const stem = resolve(sentence.tokens[0], sentence);
    const suffix = resolve(sentence.tokens[1], sentence);
    // がく, not the kun おどろ KANJIDIC lists for 愕 and the lexicon holds as
    // 四段カ行 — the binom licenses on'yomi throughout on its own.
    expect(stem.reading).toBe("がく");
    expect(suffix.reading).toBe("ぜん");
    // The stem takes no ending: the binom's belongs to the suffix.
    expect(stem.endingComplete).toBe(true);
    expect(stem.okurigana).toBeUndefined();
    expect(suffix.conjClass).toBe("tari-keiyoudoushi");
    expect(suffix.okurigana).toBe(conjugate("tari-keiyoudoushi", "shuushi"));
  });

  it("licenses on'yomi without a dictionary entry for the binom", () => {
    // 憮然 is a real タリ形容動詞 and 愕然's twin in the corpus; the point of
    // the pairing is that the rule must not be reading the dictionary. Each
    // character's own first on'yomi is the fallback, and it is what makes the
    // rule reach the binoms JMdict does not list.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "憮", lemma: "憮", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos" },
        { id: 1, text: "然", lemma: "然", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 0 },
      ],
    };
    expect(lookupModernisedLemma(jmdict, "憮然")).toBeTruthy(); // guard: swap the word if this ever goes false
    expect(resolve(sentence.tokens[0], sentence).reading).toBe("ぶ");
    expect(resolve(sentence.tokens[1], sentence).reading).toBe("ぜん");
    expect(run(sentence)).toBe("憮然たり");
  });

  it("declines a suffix-tagged 乎 standing last, rather than reading it や", () => {
    // The collision that kept 乎 out. 洋乎 is the commonest sentence-final one
    // (6 of the 34), and before the guard in `isSentenceFinalParticleUse` the
    // positional fallback claimed it: the same tag read as the binom medially
    // and as the particle finally.
    const out = run({
      tokens: [
        { id: 0, text: "洋", lemma: "洋", pos: "NOUN", xpos: "n,名詞,固定物,地形", dep: "ROOT", head: 0 },
        { id: 1, text: "乎", lemma: "乎", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 0 },
        { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
      ],
    });
    expect(out).not.toContain("や");
    expect(out).toContain("たり");
  });

  it("keeps a discourse-tagged 乎 the particle — the 不亦說乎 tag, not the suffix tag", () => {
    // 1792 of the corpus's 2440 乎 carry `p,助詞,句末,*` against these 102, and
    // the dep test in `isSentenceFinalParticleUse` answers before the suffix
    // guard is ever reached.
    const out = run({
      tokens: [
        { id: 0, text: "說", lemma: "說", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos" },
        { id: 1, text: "乎", lemma: "乎", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 0 },
      ],
    });
    expect(out).toContain("や");
    expect(out).not.toContain("たり");
  });

  it("refuses 嗟乎 and 惡乎 — the two shapes that are not 形容動詞", () => {
    // 嗟乎 (20) is ああ, an INTJ stem `TARI_STEM_POS` never admitted; 惡乎 (14)
    // is いづくにか, refused on the interrogative subcategory of its stem's
    // XPOS. Together with the 8 `discourse@sp` and 2 `root` rows, 46 of 乎's
    // 102 are out and the 56 that remain are all descriptive binoms.
    expect(
      run({
        tokens: [
          { id: 0, text: "嗟", lemma: "嗟", pos: "INTJ", xpos: "p,感嘆詞,*,*", dep: "ROOT", head: 0 },
          { id: 1, text: "乎", lemma: "乎", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 0 },
        ],
      }),
    ).not.toContain("たり");
    expect(
      run({
        tokens: [
          { id: 0, text: "惡", lemma: "惡", pos: "ADV", xpos: "v,副詞,疑問,所在", dep: "mod", head: 2 },
          { id: 1, text: "乎", lemma: "乎", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 0 },
          { id: 2, text: "在", lemma: "在", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 2 },
        ],
      }),
    ).not.toContain("たり");
  });

  it("admits 焉, which needed neither guard — 忽焉 is こつえんとして", () => {
    // All 36 suffix-tagged 焉 are `unk` with a 描写/行為/固定物/変化/時相 stem;
    // none is interrogative or exclamatory. 忽 carries `VerbForm=Conv` here,
    // so the group takes the 連用形 — として, item 1's paradigm, not a bare と.
    const out = run({
      tokens: [
        { id: 0, text: "忽", lemma: "忽", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 2, morph: "VerbForm=Conv" },
        { id: 1, text: "焉", lemma: "焉", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 0 },
        { id: 2, text: "去", lemma: "去", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "ROOT", head: 2 },
      ],
    });
    expect(out).toContain("として");
    expect(out).not.toContain("り。");
  });

  it("leaves 然 tagged VERB alone — 果然 is はたして然り, not 果然たり", () => {
    // The anchor the discriminator exists for. The same two characters, and
    // the XPOS is the only thing that differs.
    expect(
      run({
        tokens: [
          { id: 0, text: "果", lemma: "果", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "mod", head: 1, morph: "ExtPos=VERB" },
          { id: 1, text: "然", lemma: "然", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 1, morph: "Degree=Pos" },
        ],
      }),
    ).toContain("果たして然り");
  });

  it("leaves the clause-initial 然 alone — the four `mod` rows the corpus has", () => {
    // 收恢台之孟夏兮，然欿傺而沈藏: a 然 that stands after a comma and heads
    // what follows. It carries the suffix XPOS and is しかれども, not a suffix
    // — which is the whole of why `dep === "unk"` stands beside the tag.
    const out = run({
      tokens: [
        { id: 0, text: "兮", lemma: "兮", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 2 },
        { id: 1, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 2 },
        { id: 2, text: "然", lemma: "然", pos: "PART", xpos: SUFFIX_XPOS, dep: "mod", head: 3 },
        { id: 3, text: "藏", lemma: "藏", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 3 },
      ],
    });
    expect(out).not.toContain("たり");
  });

  it("does not fall back on the lexicon's standalone 然り when the group has no stem", () => {
    // 然 opening a sentence with nothing before it to suffix. `VERB_LEXICON`
    // holds 然 as ラ変 しか, and reaching it here would print 然り for a token
    // the parser has tagged a bound suffix.
    expect(VERB_LEXICON["然"]?.conjClass).toBe("ra-hen"); // guard: the entry this must not reach
    const out = run({
      tokens: [
        { id: 0, text: "然", lemma: "然", pos: "PART", xpos: SUFFIX_XPOS, dep: "unk", head: 1 },
        { id: 1, text: "藏", lemma: "藏", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 },
      ],
    });
    expect(out).not.toContain("然り");
    expect(out).not.toContain("たり");
  });
});

// ---------------------------------------------------------------------------
// タリ活用形容動詞, the other shape: a reduplicated descriptive rendered through
// the fused-span branch. See `redupTariReading` in readingResolver.ts for the
// rule and its corpus, and `descriptiveRedupSpan` in conjugationContext.ts for
// the test both it and the として guard run.
// ---------------------------------------------------------------------------

describe("タリ活用形容動詞 (reduplication-driven, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  const DESC = "v,動詞,描写,態度";
  /** A reduplicated pair at ids 1 and 2, head at `head` with relation `dep`. */
  // ADJ, not the VERB this fixture was built with: parser 0.3.2 recodes the
  // `v,動詞,描写,*` class off VERB entirely (over the recoded gold that xpos is
  // ADJ 22,368 / ADV 4,511 / NOUN 1 and VERB **0**), so a reduplicated
  // descriptive now arrives tagged ADJ with `Degree=Pos` on it.
  const redup = (ch: string, dep: string, head: number, xpos = DESC, morph = "Degree=Pos", pos = "ADJ"): Token[] => [
    { id: 1, text: ch, lemma: ch, pos, xpos, dep, head, morph: morph || undefined },
    { id: 2, text: ch, lemma: ch, pos, xpos, dep: "compound@redup", head: 1, morph: morph || undefined },
  ];
  const ki = (id: number, head: number): Token =>
    ({ id, text: "木", lemma: "木", pos: "NOUN", xpos: "n,名詞,固定物,植物", dep: "subj", head });

  it("木蕭蕭 -> 木蕭蕭たり, not the サ変 木蕭蕭す", () => {
    // The span is on'yomi throughout (せう + せう) with a VERB carrier, which is
    // exactly `spanSuruReading`'s pair of conditions — so before the タリ rule
    // stood in front of it this read 木蕭蕭す. A Sino-Japanese *descriptive*
    // compound is タリ活用, and the reduplication is that class's other shape.
    expect(run({ tokens: [ki(0, 1), ...redup("蕭", "ROOT", 1)] })).toBe("木蕭蕭たり");
  });

  it("writes the group's ending once, after the last member", () => {
    // The failure a per-member rule would have: 木蕭たり蕭たり. The ending
    // belongs to the span, and `compoundSuruOkurigana` is what writes it.
    const out = run({ tokens: [ki(0, 1), ...redup("蕭", "ROOT", 1)] });
    expect(out.match(/たり/g)).toHaveLength(1);
    expect(out.indexOf("たり")).toBe(out.length - 2);
  });

  it("inflects — 連用形 として for a non-final coordinand, 未然形 たら before しむ", () => {
    // として is タリ's own 連用形, so 連用中止法 needs no て appended to it, and
    // none is: `renyoukeiEndsInISound` refuses the class.
    const coordinated = run({
      tokens: [
        ki(0, 1),
        ...redup("蕭", "ROOT", 1),
        { id: 3, text: "水", lemma: "水", pos: "NOUN", xpos: "n,名詞,固定物,地形", dep: "subj", head: 4 },
        { id: 4, text: "洋", lemma: "洋", pos: "ADJ", xpos: DESC, dep: "conj:coord", head: 1, morph: "Degree=Pos" },
        { id: 5, text: "洋", lemma: "洋", pos: "ADJ", xpos: DESC, dep: "compound@redup", head: 4, morph: "Degree=Pos" },
      ],
    });
    expect(coordinated).toBe("木は蕭蕭として水は洋洋たり");
    expect(coordinated).not.toContain("としてて");

    expect(
      run({
        tokens: [
          { id: 1, text: "使", lemma: "使", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 },
          { id: 2, text: "木", lemma: "木", pos: "NOUN", xpos: "n,名詞,固定物,植物", dep: "comp:obj", head: 1 },
          { id: 3, text: "蕭", lemma: "蕭", pos: "ADJ", xpos: DESC, dep: "comp:obl", head: 1, morph: "Degree=Pos" },
          { id: 4, text: "蕭", lemma: "蕭", pos: "ADJ", xpos: DESC, dep: "compound@redup", head: 3, morph: "Degree=Pos" },
        ],
      }),
    ).toBe("木をして蕭蕭たらしむ");
  });

  it("writes no doubled して where a 而 follows the span", () => {
    // として contains the connective outright, so the 而 has nothing left to
    // write — `precedingFormSuppliesShite`'s span arm, which is the same claim
    // its タリ-suffix arm makes about 莞爾而笑. 悾悾而不信 read 悾悾としてて信ぜず
    // until it did.
    const out = run({
      tokens: [
        ...redup("悾", "ROOT", 1),
        { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 },
        { id: 4, text: "信", lemma: "信", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 1 },
      ],
    });
    expect(out).toContain("悾悾として");
    expect(out).not.toContain("としてて");
  });

  it("takes no ending at all where a タリ suffix is already writing the group's", () => {
    // 巍巍乎 is one word: a two-character stem with a タリ suffix on it, which
    // `tariSuffixGroup` reads backwards from the 乎. Anything written after the
    // span writes the ending twice — 巍巍す乎たり before this, and 巍巍たり乎たり
    // had the タリ rule been left to claim the span as well.
    const out = run({
      tokens: [
        ...redup("巍", "ROOT", 1),
        { id: 3, text: "乎", lemma: "乎", pos: "PART", xpos: "p,接尾辞,*,*", dep: "unk", head: 1 },
      ],
    });
    expect(out).toBe("巍巍乎たり");
    expect(out.match(/たり/g)).toHaveLength(1);
  });

  it("leaves a reduplication the treebank does not call descriptive exactly as it was", () => {
    // 人人, 世世, 處處 are nominal and 往往, 遲遲 adverbial; 孳孳 and the 濟濟 of
    // 濟濟漆漆 are `v,動詞,行為,*`. None of them is a 形容動詞, and たり is not
    // what any of them takes. 252 of the gold treebank's 634 reduplications.
    expect(
      run({
        tokens: [
          { id: 1, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "ROOT", head: 1 },
          { id: 2, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "compound@redup", head: 1 },
        ],
      }),
    ).toBe("人人");
    // A VERB carrier with no `Degree=Pos` goes on reading サ変, which is
    // `spanSuruReading`'s answer and unchanged by any of this.
    // …and it is still VERB under 0.3.2: only the `v,動詞,描写,*` class moved to
    // ADJ, so a 行為 verb is tagged exactly as it was.
    // The closing 。 is load-bearing since the title rule landed — see
    // `isUnpunctuatedTitleSpan`, and the note in the 俯臥 test above.
    expect(
      run({
        tokens: [
          ...redup("孳", "ROOT", 1, "v,動詞,行為,態度", "", "VERB"),
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("孳孳す");
  });

  it("declines a span that is not a reduplication of one character", () => {
    // 陶陶遂遂 — the gold treebank's one span of four, two different
    // reduplicated pairs joined by a `flat@vv`. Not a reduplication of
    // anything, so the same-character test refuses it and the サ変 rule behind
    // it answers as before.
    expect(
      run({
        tokens: [
          ...redup("陶", "ROOT", 1),
          { id: 3, text: "遂", lemma: "遂", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "flat@vv", head: 1 },
          { id: 4, text: "遂", lemma: "遂", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "compound@redup", head: 3 },
          // The closing 。 is load-bearing since the title rule landed — see
          // `isUnpunctuatedTitleSpan`, and the note in the 俯臥 test above.
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("陶陶遂遂す");
  });

  it("carries the span's ending through a bare pin on any member", () => {
    // A pick corrects the *reading*, not the grammar. `compoundSuruOkurigana`
    // will only write a group ending for a reading carrying `suruCompound`, and
    // a pick carries none — so pinning the carrier used to delete the ending
    // outright (木蕭蕭, bare). Both members, and both together, now give the
    // string the unpinned sentence gives.
    for (const pins of [[1], [2], [1, 2]]) {
      const sentence: Sentence = { tokens: [ki(0, 1), ...redup("蕭", "ROOT", 1)] };
      for (const id of pins) setChosenReading(sentence.tokens.find((t) => t.id === id)!, "せう");
      expect(run(sentence)).toBe("木蕭蕭たり");
    }
  });

  it("carries a サ変 span's ending through a bare pin too", () => {
    // The same defect and the same line: the span branch simply did not know
    // about picks. 蠕動 lost its す the moment either character was pinned.
    // The closing 。 is load-bearing since the title rule landed — see
    // `isUnpunctuatedTitleSpan`, and the note in the 俯臥 test above.
    const build = (): Sentence => ({
      tokens: [
        { id: 1, text: "蠕", lemma: "蠕", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 },
        { id: 2, text: "動", lemma: "動", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "compound", head: 1 },
        { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    });
    expect(run(build())).toBe("蠕動す");
    for (const id of [1, 2]) {
      const sentence = build();
      setChosenReading(sentence.tokens.find((t) => t.id === id)!, id === 1 ? "ぜん" : "どう");
      expect(run(sentence)).toBe("蠕動す");
    }
  });
});

// ---------------------------------------------------------------------------
// ナリ活用形容動詞, the commonest shape of all: a two-character descriptive
// binome joined by `flat@vv`. See `descriptiveBinomeNariReading` in
// readingResolver.ts for the rule and its corpus, and `descriptiveBinomeSpan`
// in conjugationContext.ts for the five conditions on the span.
// ---------------------------------------------------------------------------

describe("ナリ活用形容動詞 (descriptive binome, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** A descriptive binome at ids 1 and 2, head at `head` with relation `dep`. */
  const binome = (a: string, b: string, dep: string, head: number, xpos = "v,動詞,描写,量"): Token[] => [
    { id: 1, text: a, lemma: a, pos: "ADJ", xpos, dep, head, morph: "Degree=Pos" },
    { id: 2, text: b, lemma: b, pos: "ADJ", xpos, dep: "flat@vv", head: 1, morph: "Degree=Pos" },
  ];
  const stop = (id: number, head: number): Token =>
    ({ id, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head });

  it("恢洪 -> 恢洪なり, not the サ変 恢洪す", () => {
    // 趙爽's preface to the 周髀算經: 體恢洪而廓落. The span is on'yomi
    // throughout (くわい + こう) over an ADJ carrier with a verbal xpos, which
    // is exactly `spanSuruReading`'s pair of conditions since parser 0.3.2
    // recoded the descriptive class to ADJ — so before this rule stood in
    // front of it the whole passage read 恢洪して, 脩廣して, 宏遠すること. A
    // two-character Sino-Japanese *quality* is a 形容動詞, not a verb.
    expect(run({ tokens: [...binome("恢", "洪", "ROOT", 1), stop(3, 1)] })).toBe("恢洪なり");
  });

  it("writes the group's ending once, after the last member", () => {
    // The failure a per-member rule would have: 恢なり洪なり. The ending belongs
    // to the span, and `compoundSuruOkurigana` is what writes it.
    const out = run({ tokens: [...binome("恢", "洪", "ROOT", 1), stop(3, 1)] });
    expect(out.match(/なり/g)).toHaveLength(1);
    expect(out.endsWith("なり")).toBe(true);
  });

  it("inflects — 連体形 なる before the noun it modifies", () => {
    // 然而宏遠不可指掌也 — the received reading is 其の宏遠**なる**こと、
    // 指掌すべからざるなり, where this printed 宏遠**する**こと. Naming the class
    // rather than freezing なり is what lets `decideConjForm` reach the slot.
    expect(
      run({
        tokens: [
          ...binome("宏", "遠", "mod", 3),
          { id: 3, text: "者", lemma: "者", pos: "PART", xpos: "p,助詞,提示,*", dep: "ROOT", head: 3 },
          stop(4, 3),
        ],
      }),
    ).toContain("宏遠なる");
  });

  it("stands down where the span is itself another verb's object — that is a noun", () => {
    // A 形容動詞 stem is a 体言, and 遠近を計る, 吉凶を視る, 輕重を以てす use it
    // as one. Of the 61 corpus binomes of this shape in a `comp:obj` slot the
    // received reading writes 43 bare and only 5 with ナリ, so the slot is left
    // to the サ変 rule as it was rather than given a なり nothing answers to.
    expect(
      run({
        tokens: [
          ...binome("遠", "近", "comp:obj", 3),
          { id: 3, text: "計", lemma: "計", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 3 },
          stop(4, 3),
        ],
      }),
    ).not.toContain("なり");
  });

  it("gives a 而 after the span して, not て — 恢洪にして and never 恢洪にて", () => {
    // 體恢洪而廓落 is 體は恢洪**にして**廓落. ナリ活用's 連用形 is the bare に, so
    // unlike the copula's own にして and unlike タリ活用's として it leaves the
    // connective for the 而 to write — and unlike a サ変 span's し (悾悾して) what
    // it wants there is して. `precedingSpanWroteNariRenyou` is the branch.
    const out = run({
      tokens: [
        ...binome("恢", "洪", "ROOT", 1),
        { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 },
        { id: 4, text: "廓", lemma: "廓", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
        { id: 5, text: "落", lemma: "落", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "flat@vv", head: 4, morph: "Degree=Pos" },
      ],
    });
    expect(out).toContain("恢洪にして");
    expect(out).not.toContain("にてて");
    expect(out).not.toContain("にしてて");
  });

  it("leaves a binome the treebank does not call descriptive exactly as it was", () => {
    // 彌綸 and 欽若, from the same preface, are `v,動詞,行為,*` VERB — Sino-
    // Japanese noun-verbs, and サ変 is right for them. The xpos is the whole
    // of the line between them and 恢洪, and it is the corpus's own: over the
    // kanbun.info 書き下し文 the descriptive binomes read ナリ 23 to サ変 10
    // while the rest read サ変 297 to ナリ 39. 蠕動 stands for them here
    // because KANJIDIC2 gives every character of it an on'yomi, which is what
    // `spanSuruReading` needs before it will write anything at all (彌 does
    // not, and 彌綸 comes out bare both before this rule and after it).
    expect(
      run({
        tokens: [
          { id: 1, text: "蠕", lemma: "蠕", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 },
          { id: 2, text: "動", lemma: "動", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "flat@vv", head: 1 },
          stop(3, 1),
        ],
      }),
    ).toBe("蠕動す");
  });

  it("declines a reduplication, which is the タリ class and not this one", () => {
    // 蕭蕭 joined by `flat@vv` rather than `compound@redup` reaches neither
    // `descriptiveRedupSpan` (no redup edge) nor this rule (every member the
    // same character), and falls through to サ変 as it always did. The
    // same-character test is here so that a reduplication `redupTariReading`
    // has *declined* cannot land on なり — 蕭蕭なり is not a reading.
    const out = run({
      tokens: [
        { id: 1, text: "蕭", lemma: "蕭", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 1, morph: "Degree=Pos" },
        { id: 2, text: "蕭", lemma: "蕭", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "flat@vv", head: 1, morph: "Degree=Pos" },
        stop(3, 1),
      ],
    });
    expect(out).not.toContain("なり");
  });

  it("stands down where the carrier governs an object — a 形容動詞 governs none", () => {
    // The guard `descriptiveRedupSpan` and `pinnedKeiyoudoushi` both make on
    // the same evidence, and it pays here: of the five corpus binomes of this
    // shape whose carrier has a `comp:obj`, four are read サ変 by the received
    // text — 便章百姓 is 百姓を便章**す**, not 百姓を便章**なり**.
    expect(
      run({
        tokens: [
          { id: 1, text: "便", lemma: "便", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "ROOT", head: 1, morph: "Degree=Pos" },
          { id: 2, text: "章", lemma: "章", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "flat@vv", head: 1, morph: "Degree=Pos" },
          { id: 3, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 1 },
          stop(4, 1),
        ],
      }),
    ).toContain("便章す");
  });

  it("carries the span's ending through a bare pin on any member", () => {
    // A pick corrects the reading, not the grammar — the claim the resolver's
    // hand-picked branch already made for the タリ and サ変 spans, and which
    // this rule joins. Pinned, the span kept its reading and lost its なり.
    for (const pins of [[1], [2], [1, 2]]) {
      const sentence: Sentence = { tokens: [...binome("恢", "洪", "ROOT", 1), stop(3, 1)] };
      for (const id of pins) setChosenReading(sentence.tokens.find((t) => t.id === id)!, id === 1 ? "くわい" : "こう");
      expect(run(sentence)).toBe("恢洪なり");
    }
  });
});

// ---------------------------------------------------------------------------
// End to end, on the reader's own corrected 酒蟲 trees (loaded through
// `#conllu-input`, so these rows are the CoNLL-U as written, ids and all).
// Two decisions meet here: a non-final conjunct takes 連用形 whatever paradigm
// it inflects by (`isNonFinalCoordinand`), and one narrow shape of unbracketed
// complement of a speech verb still takes 終止形 + と
// (`depClassification.ts`'s `isNegatedBareReport`).
// ---------------------------------------------------------------------------

describe("酒蟲 — the coordination chain and the と/を decision (real trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("俱言不須。 -> ともに須ゐずと言ふ — と, and after the ず", () => {
    // sent_id 19. 須 carries the reader's own picked reading in MISC
    // (Reading=もち|Okurigana=ゐる|ConjClass=kami-ichidan), so the panel prints
    // 須 with ゐ after it and もち as ruby — 用ゐず in the reader's spelling.
    //
    // The whole of the change is in the last three morae. This read
    // ともに須ゐをず言ふ before: a 連体形 with を on it, the particle written on
    // 須's own piece and so landing *ahead* of the ず that 不 postposes past it.
    // と cannot be written from there at all, which is why it comes from
    // `reorderEngine.ts` — see `isNegatedBareReport`.
    expect(
      run({
        tokens: [
          { id: 1, text: "俱", lemma: "俱", pos: "ADV", xpos: "v,副詞,範囲,共同", dep: "mod", head: 2 },
          { id: 2, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 },
          { id: 3, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 4, morph: "Polarity=Neg" },
          {
            id: 4,
            text: "須",
            lemma: "須",
            pos: "VERB",
            xpos: "v,動詞,行為,動作",
            dep: "comp:obj",
            head: 2,
            misc: { Reading: "もち", Okurigana: "ゐる", ConjClass: "kami-ichidan" },
          },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("ともに須ゐずと言ふ");
  });

  it("謂其身有異疾 -> 其の身に異疾有るを謂ふ — unnegated, so the と rule never reaches it", () => {
    // sent_id 5, tokens 6-11. The companion assertion to the one above, and the
    // reason the rule is a conjunction rather than "unbracketed reported speech
    // takes と": this complement is unbracketed reported speech too, and the
    // reader has seen it as を and let it stand.
    expect(
      run({
        tokens: [
          { id: 6, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 6 },
          { id: 7, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "det", head: 8, morph: "Person=3|PronType=Prs" },
          { id: 8, text: "身", lemma: "身", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 6 },
          { id: 9, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 6 },
          { id: 10, text: "異", lemma: "異", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "mod", head: 11, morph: "Degree=Pos|VerbForm=Part" },
          { id: 11, text: "疾", lemma: "疾", pos: "NOUN", xpos: "n,名詞,不可譲,疾病", dep: "comp:obj", head: 9 },
          { id: 12, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 6 },
        ],
      }),
    ).toBe("其の身に異疾有るを謂ふ");
  });

  it("體漸瘦、家亦日貧、後飲食至不能給。 -> 日に貧しく — a ク/シク adjective conjunct", () => {
    // sent_id 34. 貧 is the ROOT with 至 hung off it by `parataxis`, so it is a
    // non-final conjunct and takes 連用形 — 貧しく, where it closed the clause
    // as 貧し while the adjectival paradigms were excluded from the chain rule.
    // This is 山高く水長し in the reader's own text.
    const out = run({
      tokens: [
        { id: 1, text: "體", lemma: "體", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "subj", head: 3 },
        { id: 2, text: "漸", lemma: "漸", pos: "ADV", xpos: "v,副詞,時相,変化", dep: "mod", head: 3, morph: "AdvType=Tim" },
        { id: 3, text: "瘦", lemma: "瘦", pos: "PROPN", xpos: "v,動詞,行為,動作", dep: "subj", head: 8, morph: "Case=Loc|NameType=Geo" },
        { id: 4, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 3 },
        { id: 5, text: "家", lemma: "家", pos: "NOUN", xpos: "n,名詞,固定物,建造物", dep: "subj", head: 8, morph: "Case=Loc" },
        { id: 6, text: "亦", lemma: "亦", pos: "ADV", xpos: "v,副詞,頻度,重複", dep: "mod", head: 8 },
        { id: 7, text: "日", lemma: "日", pos: "NOUN", xpos: "n,名詞,時,*", dep: "mod@tmod", head: 8, morph: "Case=Tem" },
        { id: 8, text: "貧", lemma: "貧", pos: "ADJ", xpos: "v,動詞,描写,境遇", dep: "ROOT", head: 8, morph: "Degree=Pos" },
        { id: 9, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 8 },
        { id: 10, text: "後", lemma: "後", pos: "NOUN", xpos: "n,名詞,時,*", dep: "mod@tmod", head: 11, morph: "Case=Tem" },
        { id: 11, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "subj", head: 13 },
        { id: 12, text: "食", lemma: "食", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 11 },
        { id: 13, text: "至", lemma: "至", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "parataxis", head: 8 },
        { id: 14, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 15, morph: "Polarity=Neg" },
        { id: 15, text: "能", lemma: "能", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "comp:obj", head: 13, morph: "Mood=Pot" },
        { id: 16, text: "給", lemma: "給", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "comp:aux", head: 15 },
        { id: 17, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 13 },
      ],
    });
    expect(out).toContain("日に貧しく");
    expect(out).not.toContain("日に貧し、");
  });
});

// ---------------------------------------------------------------------------
// A modern kun'yomi whose ending states no paradigm gets one from the
// dictionary the app already ships — see `attestedClassicalParadigm` in
// jmdictLookup.ts, and `kunWordClass` in classicalEnding.ts for the word-class
// test that decides which readings are even asked about.
// ---------------------------------------------------------------------------

describe("a kanjidic kun'yomi with no derivable paradigm (real indexes, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** 不X。 — X as the ROOT with a plain negation over it. */
  const negated = (text: string): Sentence => ({
    tokens: [
      { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" },
      { id: 1, text, lemma: text, pos: "VERB", xpos: "v,動詞,行為,交流", dep: "ROOT", head: 1 },
      { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 1 },
    ],
  });

  it("不答。 -> 答へず — the ハ行下二段 mizenkei, where the modern える stood uninflected", () => {
    // KANJIDIC gives 答 the modern こた.える, whose bare え could be ア行, ヤ行,
    // ワ行 or (through ハ行転呼) ハ行 下二段 — so `classicalConjClass` abstains
    // and the reading reached the page as 答えるず, a modern dictionary form
    // with a classical negation glued to it. JMdict holds the classical word
    // itself, 答ふ, labelled 下二段ハ行, and that is where the paradigm now
    // comes from.
    //
    // This case was first written for 応, the character that raised it. 応
    // and 應 no longer reach this path: kanbun reads the verb as ザ変 おうず
    // (応ぜず), and `VERB_LEXICON` says so (see the 應 entry there).
    expect(run(negated("答"))).toBe("答へず");
  });

  it("does the same for every character that spells the word — 對, 荅", () => {
    // The classical word is one word however many characters write it, and
    // JMdict lists it under 答ふ alone. Keying the lookup by the *reading* is
    // what carries the answer to the others; a spelling-keyed one would have
    // answered for 答 and not for 對.
    //
    // 対 is left out and is not a counter-example: its entry also lists むか.う,
    // and with no object in the clause the transitivity check picks that word
    // instead, so the character never arrives here reading こた at all.
    for (const text of ["對", "荅"]) {
      expect(run(negated(text)), text).toBe(`${text}へず`);
    }
  });

  it("reaches rows that had no mechanical route at all — 餓ゑず, ワ行下二段", () => {
    // The three あ-row 下二段 families collapsed onto one え in modern
    // spelling, which is why `SHIMO_NIDAN_SHUUSHI` excludes the row outright.
    // JMdict separates them by name: 植う is labelled a 'u' ending "with 'we'
    // conjugation", and 餓's う.える is that word. The ゑ is the whole
    // distinction, and nothing derived it before.
    expect(run(negated("餓"))).toBe("餓ゑず");
    expect(run(negated("消"))).toBe("消えず"); // 消ゆ, ヤ行下二段
  });

  it("不謀。 -> 謀らず — a paradigm the ending did state, which nothing was carrying", () => {
    // 謀's own first inflecting kun'yomi is はか.る, whose 四段ラ行 the ending
    // states plainly. A character in this position printed its modern ending
    // all the same: `VERB_LEXICON` has no entry for it, the syntax made no
    // choice, and the class had no way to travel. There is nothing here to
    // outrank, so it travels now.
    //
    // 應 raised this, reading あた.る, and has since left the population: the
    // kun'yomi was the wrong word, and kanbun reads 應 as ザ変 おうず.
    expect(run(negated("謀"))).toBe("謀らず");
    expect(run(negated("應"))).toBe("應ぜず");
  });

  it("不譽。 -> 譽めず — the verb, not the noun ほまれ read as one", () => {
    // Two faults stood behind 譽る. KANJIDIC2 lists the 連用形 noun ほ.まれ ahead
    // of the verb ほ.める, and `pickKun` took the first; and the verb lexicon
    // held 譽 as ほ + 四段ラ行, the godan fallback's reading of ほめちぎる with
    // めちぎ deleted, which the panels conjugated whatever the resolver read.
    // With the noun passed over and that sense refused at the build, the
    // modern める gives 下二段マ行 and its 未然形.
    expect(run(negated("譽"))).toBe("譽めず");
  });

  it("leaves a word whose paradigm neither the ending nor the dictionary states", () => {
    // 顫's ふる.える is the same あ-row shape as 応's こた.える, and no classical
    // 顫ふ/顫ゆ/顫う is listed anywhere. It keeps the modern ending it always
    // had rather than being given a paradigm on a guess — 1,026 of the shipped
    // index's verb kun'yomi are in this position, and this is what they do.
    expect(run(negated("顫"))).toBe("顫えるず");
  });

  it("names the paradigm outright where the lexicon now holds one — 視ず", () => {
    // 視's み.る is a one-kana ending, which `classicalConjClass` reads as
    // 四段ラ行 — a guess, and the wrong one: the word is 上一段 見る. This
    // asserted 視るず, the citation form `isModernIchidanLemma` leaves standing
    // when JMdict's "Ichidan verb" rules the guess out *without naming a
    // replacement*: better than inflecting wrongly (視り for 視て), and still
    // not a word.
    //
    // `RESIDUAL` in verbLexicon.ts now names it — `kami-ichidan` み, which is
    // what 見 already carries and what Wiktionary's soft-redirect kept the
    // build script from deriving. So the 未然形 is the bare stem: 視ず, the
    // same form 見ず is.
    //
    // What forced the gap open was 解縛視之: the clause is a temporal protasis,
    // so the form asked for is 已然形, and 上一段's 已然形 みれ is the first one
    // that differs from the citation form the stand-down was printing. The
    // negation asks for the other one, 未然形 み, and it differs too.
    //
    // **`isModernIchidanLemma` is not what changed and is still the guard** for
    // every kun'yomi of this shape the lexicon has no entry for; this character
    // simply no longer reaches it.
    expect(run(negated("視"))).toBe("視ず");
  });
});

// ---------------------------------------------------------------------------
// Oblique relations, an oblique predicate, an asking verb's quotation, and
// the simile 如's standard. Real 酒蟲 trees throughout (sent_id 23/24/25/17
// and 30), real resolver.
// ---------------------------------------------------------------------------

describe("oblique relations take に (real trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("marks a plain comp:obl nominal, not only the @lmod/@tmod subtypes", () => {
    // 直墮酒中 (酒蟲 sent_id 24) — 中 is 墮's `comp:obl` carrying `Case=Loc`,
    // the ordinary shape of a locative argument, and it was getting nothing at
    // all while the identical noun one edge over (`mod@lmod`) got its に.
    //
    // The verb's own ending is not this test's subject. It read 墮す while the
    // verb lexicon held 墮 as お + 四段サ行, which was 堕ろす with its ろ deleted
    // by the build script's godan fallback; that sense is refused now (see
    // `derivedSense`), and KANJIDIC2's おち.る is what stands — 墮る, still
    // short of the classical 墮つ.
    //
    // 酒中, not 酒の中: the two stand side by side, and the received readings
    // write X中 bare — 軍中 12, 城中 8, 日中 6, 嚢中 6, 國中 5, 山中 2 against
    // 澤の中 2 and 軍の中 2. See `isJuxtaposedNominalTerm`. The に on 中 is
    // what this test asserts and it is untouched.
    expect(
      run({
        tokens: [
          { id: 0, text: "直", lemma: "直", pos: "ADV", xpos: "v,動詞,描写,形質", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Conv", misc: { Reading: "ただ", Okurigana: "ちに" } },
          { id: 1, text: "墮", lemma: "墮", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 },
          { id: 2, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "mod", head: 3 },
          { id: 3, text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "comp:obl", head: 1, morph: "Case=Loc" },
        ],
      }),
    ).toBe("直ちに酒中に墮る");
  });

  it("leaves an adposition on comp:obl unmarked — it carries its own case", () => {
    // 52% of the corpus's `comp:obl` tokens are ADP (5,548 of 10,610). An
    // adposition inverts already carrying the case marking, so a second
    // particle on it would be 於により. The nominal gate in `caseParticleFor`
    // is what keeps the whole class off them.
    expect(
      run({
        tokens: [
          { id: 0, text: "取", lemma: "取", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "ROOT", head: 0 },
          { id: 1, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "comp:obl", head: 0 },
          { id: 2, text: "藍", lemma: "藍", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 1 },
        ],
      }),
    ).toBe("藍より取る");
  });

  it("苦不得飲 -> 飲むを得ざるに苦しむ — an oblique *predicate* takes 連体形 and に", () => {
    // 酒蟲 sent_id 23. 苦 governs 得 by `mod@tmod` and 得 governs 飲 by
    // `comp:obj`, with 不 negating 得 — so the whole negated clause 飲むを得ざる
    // is an adjunct of 苦しむ. Three things have to happen together: the
    // relation has to invert (it read 苦しむ飲むを得ず before), 得 has to take
    // the 未然形 the following ず wants, and the ず — which is what actually
    // stands at the end of the clause — has to become the 連体形 ざる and carry
    // the に. A に written on 得's own piece would have come out 得にず.
    expect(
      run({
        tokens: [
          { id: 0, text: "苦", lemma: "苦", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos", misc: { Reading: "くる", Okurigana: "しむ" } },
          { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
          { id: 2, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "mod@tmod", head: 0 },
          { id: 3, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 2 },
        ],
      }),
    ).toBe("飲むを得ざるに苦しむ");
  });

  it("writes the same ざるに into the 訓読文, which drew a bare ズ", () => {
    // The same 苦不得飲 tree, asked the question `KundokuView.ts` asks of its 不
    // cell. That panel called `negationForm` with only the next token, so it
    // knew nothing of the clause the ず closes and printed ズ against a prose
    // panel already writing ざるに — the two panels disagreeing about one
    // character, which is the failure mode `negationEnding`'s own doc names.
    // Both now call the one function, so the strings cannot come apart.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "苦", lemma: "苦", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos", misc: { Reading: "くる", Okurigana: "しむ" } },
        { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 2, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "mod@tmod", head: 0 },
        { id: 3, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    const negation = sentence.tokens[1];
    expect(negationEnding(negation, plan)).toBe("ざるに");
    // The call the kundoku panel used to make, kept as the statement of what
    // changed: it is not a shorter spelling of the same answer.
    expect(negationForm(nextMeaningfulToken(plan, negation.id))).toBe("ず");
  });

  it("an *un*negated oblique predicate carries the に on its own 連体形", () => {
    // The same rule with the negation taken out: nothing else closes the
    // clause, so 得 itself is the end of it and writes both halves.
    expect(
      run({
        tokens: [
          { id: 0, text: "苦", lemma: "苦", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos", misc: { Reading: "くる", Okurigana: "しむ" } },
          { id: 1, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "mod@tmod", head: 0 },
          { id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 1 },
        ],
      }),
    ).toBe("飲むを得るに苦しむ");
  });

  it("keeps a nominal oblique out of the predicate rule — 何用 is 何に用ゐる", () => {
    // 酒蟲 sent_id 28. 何 is 用's `comp:obl` and a NOUN, so it takes the plain
    // table's に rather than the 連体形 an oblique *predicate* would.
    expect(
      run({
        tokens: [
          { id: 0, text: "何", lemma: "何", pos: "NOUN", xpos: "v,副詞,疑問,原因", dep: "comp:obl", head: 1, morph: "AdvType=Cau" },
          { id: 1, text: "用", lemma: "用", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 },
        ],
      }),
    ).toBe("何に用ゐる");
  });
});

describe("a conditional protasis takes 已然形 + ば (real trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** 邦有道，則知 — 論語公冶長, gold tree, ids renumbered from 0 and the
   * quotation frame dropped. 有 hangs off 知 by `mod` and 則 is 知's own ADV
   * `mod`, which is the whole of the trigger. */
  const bangYouDao = (): Sentence => ({
    tokens: [
      { id: 0, text: "邦", lemma: "邦", pos: "NOUN", xpos: "n,名詞,主体,集団", dep: "subj", head: 1 },
      { id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "mod", head: 4 },
      { id: 2, text: "道", lemma: "道", pos: "NOUN", xpos: "n,名詞,制度,儀礼", dep: "comp:obj", head: 1 },
      { id: 3, text: "則", lemma: "則", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 4, morph: "AdvType=Tim" },
      { id: 4, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 4 },
    ],
  });

  it("邦有道，則知 -> 邦に道有れば則ち知る — the ラ変 已然形 れ, and ば", () => {
    // The construction the whole rule is keyed on. 則 marks the apodosis, so
    // what precedes it was a protasis, and kundoku closes a protasis 已然形+ば.
    // This is `izen`'s first consumer in the app: every paradigm in
    // classicalConjugation.ts has always supplied one and nothing asked.
    expect(run(bangYouDao())).toBe("邦に道有れば則ち知る");
  });

  it("takes the trigger away and the same tree closes 終止形, with no ば", () => {
    // The control. Nothing about the relation changed — 有 is still 知's `mod`
    // — so this is the statement that the rule is *lexical*: it is 則 standing
    // on the governor that makes the clause a protasis, and with 則 gone there
    // is nothing to say it was one. The relation could not have decided this:
    // `udep@tmod` is carried 5,074 times in the gold treebank and not one of
    // its dependents is a VERB.
    const s = bangYouDao();
    s.tokens = s.tokens.filter((t) => t.lemma !== "則");
    expect(run(s)).not.toContain("ば");
  });

  it("既灌，然後迎牲 -> the 既 on the clause itself is the other trigger", () => {
    // 禮記, gold tree. Here nothing stands on the governor; the trigger is 既
    // ("already", XPOS `v,副詞,時相,完了`) sitting inside the clause it marks.
    // 既/旣 are the one member of the proposed 既/旣/及/至/比 set that is an
    // adverb marking someone else's clause rather than a VERB heading its own
    // — see `RESULTATIVE_CONNECTIVE_LEMMAS` for why 及/至/比 were excluded.
    // 灌 is 四段ガ行, so the 已然形 is 灌げ.
    expect(
      run({
        tokens: [
          { id: 0, text: "既", lemma: "既", pos: "ADV", xpos: "v,副詞,時相,完了", dep: "mod", head: 1, morph: "AdvType=Tim|Aspect=Perf" },
          { id: 1, text: "灌", lemma: "灌", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "mod", head: 2 },
          { id: 2, text: "迎", lemma: "迎", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "ROOT", head: 2 },
          { id: 3, text: "牲", lemma: "牲", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "comp:obj", head: 2 },
        ],
      }),
      // 既**に**, keeping the character: the received text writes 既に 60 times
      // and すでに in kana none. See `overrides.json`'s entry.
    ).toBe("既に灌げば牲を迎える");
  });

  it("父母不在，則稱 -> 父母在らざれば — a negated protasis, and the ざれ it needed", () => {
    // `negationForm` had no 已然形 at all before this rule: NEGATION supplied
    // ず, ぬ and ざる and nothing else. The negation is what actually stands at
    // the end of the clause, so it is the negation that has to be 已然形 and
    // carry the ば — 在にば or 在らずば would both be wrong. Exactly the
    // arrangement 苦不得飲's ざるに already uses, one construction over.
    //
    // A reachable case, not a slot filled on spec: 246 of the 1,754 gold 則
    // conditionals negate their protasis, and 83 of them have the shape this
    // rule reads (the dependent standing last in its own clause).
    expect(
      run({
        tokens: [
          { id: 0, text: "父", lemma: "父", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "subj", head: 2 },
          { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
          { id: 2, text: "在", lemma: "在", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "mod", head: 4 },
          { id: 3, text: "則", lemma: "則", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 4, morph: "AdvType=Tim" },
          { id: 4, text: "稱", lemma: "稱", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 4 },
        ],
      }),
    ).toContain("在らざれば");
  });

  it("writes that same ざれば into the 訓読文, so the two panels cannot come apart", () => {
    // The kundoku panel's own question, asked of the 不 cell. Both panels go
    // through `negationEnding` and nothing else, the discipline the ざるに case
    // above already pins — a ば written from `caseParticleFor` onto 在's piece
    // and a ず written here would have been the two panels disagreeing about
    // one character.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "父", lemma: "父", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "subj", head: 2 },
        { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 2, text: "在", lemma: "在", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "mod", head: 4 },
        { id: 3, text: "則", lemma: "則", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 4, morph: "AdvType=Tim" },
        { id: 4, text: "稱", lemma: "稱", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 4 },
      ],
    };
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(negationEnding(sentence.tokens[1], plan)).toBe("ざれば");
    // The answer with no conditional over it, kept as the statement of what
    // changed rather than a shorter spelling of the same thing.
    expect(negationForm(nextMeaningfulToken(plan, 1))).toBe("ず");
  });

  it("a 描写 stative on the same relation stays a manner adverb — 輒半種黍 is 半ば", () => {
    // 酒蟲, live parse. 半 is 種's `mod` and 輒 stands on 種, which is the
    // trigger's exact signature — but 半 is `v,動詞,描写,量`, a degree adverb
    // reading 半ば, and 半ばば is not a word. The tagset's 描写 class in an
    // adverbial slot is manner or degree rather than a clause, and that is the
    // boundary the rule draws. The eventive classes and the existentials
    // 有/無 are what a protasis is built from.
    expect(run({
      tokens: [
        { id: 0, text: "輒", lemma: "輒", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 2, morph: "AdvType=Tim" },
        { id: 1, text: "半", lemma: "半", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "mod", head: 2, morph: "Degree=Pos" },
        { id: 2, text: "種", lemma: "種", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 2 },
        { id: 3, text: "黍", lemma: "黍", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 2 },
      ],
      // The whole string, not a `not.toContain("ば")` — 半ば ends in the very
      // kana the rule would have written, so only the exact reading can say
      // which ば this is.
    })).toBe("輒ち半ば黍を種う");
  });

  it("the distributive 每 outranks it — 每獨酌、輒盡一甕 is 酌むごとに, not 酌めば", () => {
    // 酒蟲, live parse, and the one place in that file where both a 每 and a
    // 輒 stand on the same clause. Two conjunctions on one protasis is one too
    // many, and 每 is the more specific: the reading is 獨り酌むごとに輒ち一甕を
    // 盡くす, 連体形+ごとに, which `hasDistributivePostposeChild` already
    // writes. The predicate declines the case itself rather than leaning on
    // `decideConjForm`'s ordering, because `caseParticleFor` consults these
    // rules in a different order and would otherwise have written a ば onto a
    // 連体形.
    const out = run({
      tokens: [
        { id: 0, text: "每", lemma: "每", pos: "ADV", xpos: "v,動詞,描写,形質", dep: "mod", head: 1 },
        { id: 1, text: "酌", lemma: "酌", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "mod", head: 3 },
        { id: 2, text: "輒", lemma: "輒", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 3, morph: "AdvType=Tim" },
        { id: 3, text: "盡", lemma: "盡", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 3 },
      ],
    });
    expect(out).toContain("ごとに");
    expect(out).not.toContain("ば");
  });

  it("leaves 苦不得飲 alone — an oblique predicate is still 連体形 and に", () => {
    // The target a *relation*-keyed rule would have broken. 得 hangs off 苦 by
    // `mod@tmod`, which is an oblique relation and travels the same code path
    // a temporal one would; keying the ば on the relation would have given
    // 得ざれば here. The rule is keyed on the lexeme instead, there is no
    // すなはち-class connective anywhere in this tree, and the ざるに stands.
    expect(
      run({
        tokens: [
          { id: 0, text: "苦", lemma: "苦", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos", misc: { Reading: "くる", Okurigana: "しむ" } },
          { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
          { id: 2, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "mod@tmod", head: 0 },
          { id: 3, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 2 },
        ],
      }),
    ).toBe("飲むを得ざるに苦しむ");
  });

  it("leaves a caused predicate alone even under a trigger — 使民戰 takes no ば", () => {
    // 使民戰's own gold tree, with a 則 added to it that has no business
    // firing. A caused predicate owes its governor a 未然形 and takes no
    // particle at all, and what keeps it safe is the *relation*: this parser
    // puts a caused predicate on `comp:obl` (here), `comp:aux` or `parataxis`,
    // and none of the three is one this rule reads.
    //
    // An `isCausedOrPassivePredicate` guard was written into the predicate and
    // then taken out on finding it could not fire — the relations are disjoint.
    // This test is what replaced it: it states the protection where the
    // protection actually is, and would fail the day the rule widened past
    // `mod`/`udep` without noticing what else lives out there.
    expect(
      run({
        tokens: [
          { id: 0, text: "使", lemma: "使", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 },
          { id: 1, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 0 },
          { id: 2, text: "戰", lemma: "戰", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "comp:obl", head: 0, morph: "SudSubject=ObjRaising" },
          { id: 3, text: "則", lemma: "則", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 0, morph: "AdvType=Tim" },
        ],
      }),
    ).toBe("民をして戰はしむ則ち");
  });

  it("does not reach a coordination chain — 學而不思則罔 keeps its 連用形", () => {
    // The stated boundary, and the canonical example that falls outside it.
    // In the gold tree the clause 則 answers is headed by 學, and 思 is 學's
    // `conj:coord` — so the protasis *ends* at 思, a token the relation is not
    // on. Writing the ば there wants the "whichever member is said last" trick
    // `nominalCoordinationChain` already does for nominals, applied to
    // predicates, and that is a second mechanism rather than a condition on
    // this one. 243 gold protases have this shape. Until then 學びて思はず
    // stands, which is what the app wrote before and is at least a form 思
    // genuinely takes.
    const out = run({
      tokens: [
        { id: 0, text: "學", lemma: "學", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "mod", head: 4 },
        { id: 1, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 },
        { id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" },
        { id: 3, text: "思", lemma: "思", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord", head: 0 },
        { id: 4, text: "罔", lemma: "罔", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 4, morph: "Polarity=Neg" },
      ],
    });
    expect(out).toContain("學びて");
    expect(out).not.toContain("ば");
  });
});

describe("已然形 — the string every paradigm supplies and nothing asked for until now", () => {
  // `conjugate(class, "izen")` had no production caller at all before the
  // conditional rule. These pin the answer for one representative of every
  // family the rule can reach, so that a paradigm edit shows up here rather
  // than as a wrong ば in the prose. The families and their shapes:
  // 四段 the row's e-kana, 上二段/下二段 that row's u-kana + れ, the irregulars
  // their own, ク/シク けれ/しけれ, ナリ/タリ なれ/たれ.
  const cases: [string, string][] = [
    ["yodan-ka", "け"],
    ["yodan-ga", "げ"],
    ["yodan-sa", "せ"],
    ["yodan-ta", "て"],
    ["yodan-na", "ね"],
    ["yodan-ba", "べ"],
    ["yodan-ma", "め"],
    ["yodan-ra", "れ"],
    ["yodan-ha", "へ"],
    ["kami-nidan-ka", "くれ"],
    ["kami-nidan-ha", "ふれ"],
    ["kami-nidan-ra", "るれ"],
    ["shimo-nidan-ka", "くれ"],
    ["shimo-nidan-sa", "すれ"],
    ["shimo-nidan-ta", "つれ"],
    ["shimo-nidan-na", "ぬれ"],
    ["shimo-nidan-ma", "むれ"],
    ["shimo-nidan-ra", "るれ"],
    ["kami-ichidan", "れ"],
    ["ka-hen", "くれ"],
    ["sa-hen", "すれ"],
    ["na-hen", "ぬれ"],
    ["ra-hen", "れ"],
    ["ku-keiyoushi", "けれ"],
    ["shiku-keiyoushi", "しけれ"],
    ["nari-keiyoudoushi", "なれ"],
    ["tari-keiyoudoushi", "たれ"],
  ];
  for (const [cls, izen] of cases) {
    it(`${cls} 已然形 is ${izen}`, () => {
      expect(conjugate(cls as Parameters<typeof conjugate>[0], "izen")).toBe(izen);
    });
  }

  it("ず's own 已然形 is ざれ, the ざり paradigm's and not the bare ね", () => {
    // ね is the plain ず-paradigm 已然形 and survives only in fixed idiom; the
    // ざり paradigm exists precisely because ず could not carry anything after
    // it and had to be rebuilt as ず+あり to do so, and a ば is something after
    // it. Kanbun kundoku writes ざれば throughout.
    expect(NEGATION.izen).toBe("ざれ");
  });
});

describe("an asking verb's quotation closes やと (real trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** 問：「需何藥？」 — 酒蟲 sent_id 17. `speech` swaps the asking verb for
   * whatever lemma/xpos the case wants, leaving the tree otherwise identical. */
  const asked = (lemma: string, xpos: string): Sentence => ({
    tokens: [
      { id: 0, text: lemma, lemma, pos: "VERB", xpos, dep: "ROOT", head: 0 },
      { id: 1, text: "：", lemma: "：", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 },
      { id: 2, text: "「", lemma: "「", pos: "PUNCT", xpos: "s,記号,括弧開,*", dep: "punct", head: 5 },
      { id: 3, text: "需", lemma: "需", pos: "VERB", xpos: "n,名詞,人,名", dep: "comp:obj", head: 0, morph: "NameType=Giv" },
      { id: 4, text: "何", lemma: "何", pos: "PRON", xpos: "n,代名詞,疑問,*", dep: "det", head: 5, morph: "PronType=Int" },
      { id: 5, text: "藥", lemma: "藥", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 3 },
    ],
  });

  it("問：「需何藥？」 -> 問ふ、「何の藥を需ふやと", () => {
    // The や is inside the quotation (it is what makes the quoted sentence a
    // question) and the と is outside it (it is what reports the quotation), so
    // the order is 〜やと and never 〜とや.
    expect(run(asked("問", "v,動詞,行為,伝達"))).toBe("問ふ、「何の藥を需ふやと");
  });

  it("hangs the same やと off the 訓読文's closing token, which drew a bare ト", () => {
    // `KundokuView.ts`'s `withQuoteEnd` appended a literal と of its own, so the
    // panel drew 需 フト beside a prose panel already writing 需ふやと. It now
    // appends `quoteClosing`, which is the same string on the same token —
    // `reorderEngine.ts` already picks that token, and only what is written
    // there changes, so no kunten and no reading order moves.
    const sentence = asked("問", "v,動詞,行為,伝達");
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    const [closingId] = [...plan.quoteEndIds];
    expect(sentence.tokens.find((t) => t.id === closingId)?.lemma).toBe("需");
    expect(quoteClosing(closingId, plan)).toBe("やと");
  });

  it("closes a telling verb's quotation with the bare と the 訓読文 always drew", () => {
    // The other half of the swap: where the asking-verb walk finds nothing,
    // `quoteClosing` returns exactly the と the old literal wrote, so 曰's
    // quotations are untouched by this change.
    const sentence = asked("曰", "v,動詞,行為,伝達");
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    const [closingId] = [...plan.quoteEndIds];
    expect(quoteClosing(closingId, plan)).toBe("と");
  });

  it("a telling verb's quotation still closes with a bare と", () => {
    // 曰 is the same 伝達 class and is not an asking verb. The corpus draws no
    // line between them (one flat bucket of 29,266 tokens over 45 lemmas), so
    // the lemma list is what does — see `INTERROGATIVE_SPEECH_LEMMAS`.
    expect(run(asked("曰", "v,動詞,行為,伝達"))).toBe("曰く、「何の藥を需ふと");
  });

  it("refuses a 問 the parse does not tag as a verb of communication", () => {
    // 問 is also the noun "a question" (`n,名詞,可搬,伝達`, 5 in the corpus).
    // Both halves are required, exactly as `isCommunicationVerb` requires both
    // of its own.
    // Tagged that way it is not a speech verb at all, so `reorderEngine.ts`
    // marks no quote end and neither particle is written — which is the
    // stand-down this is checking, whatever else the reordering then does.
    expect(run(asked("問", "n,名詞,可搬,伝達"))).not.toContain("や");
  });
});

describe("如's standard takes の (real trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("蠕動如游魚 — 魚, 如's nominal mod, takes の", () => {
    // 酒蟲 sent_id 25. 如 is tagged ADJ with `Degree=Equ` — the simile read
    // ごとし — and its standard is a genitive. (Where ごとし itself falls
    // relative to 游魚の is 如's own reading-order half, which is not this
    // rule's; see the report.)
    expect(
      run({
        tokens: [
          { id: 0, text: "如", lemma: "如", pos: "ADJ", xpos: "v,動詞,行為,分類", dep: "ROOT", head: 0, morph: "Degree=Equ" },
          { id: 1, text: "游", lemma: "游", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "mod", head: 2, morph: "VerbForm=Part" },
          { id: 2, text: "魚", lemma: "魚", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "mod", head: 0 },
        ],
      }),
    ).toContain("游魚の");
  });

  it("takes the の on a VERB-tagged 如 too — the POS is not what decides it", () => {
    // 惡酒如仇 (酒蟲 sent_id 33). This asserted 仇に as long as the two
    // constructions were told apart by 如's UPOS — VERB meaning 〜に如かず. The
    // corpus says that cannot be the test: 如 is VERB 2,526 times out of 2,920
    // and `v,動詞,行為,分類` — "resemble" — 2,594 times, so tagged VERB is what
    // an ordinary comparison looks like, not what marks the negated one.
    expect(
      run({
        tokens: [
          { id: 0, text: "如", lemma: "如", pos: "VERB", xpos: "v,動詞,行為,分類", dep: "ROOT", head: 0, morph: "Degree=Equ" },
          { id: 1, text: "仇", lemma: "仇", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "comp:obj", head: 0 },
        ],
      }),
    ).toContain("仇の");
  });

  it("keeps 〜に如かず, which is what negation marks", () => {
    // 不如仇 — the same tree with a 不 on the 如. 594 of the corpus's 2,920 如
    // stand after a negator (不 498, 莫 76, 弗 14, 未 6), and that is the whole
    // of the construction whose standard takes に.
    expect(
      run({
        tokens: [
          { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" },
          { id: 1, text: "如", lemma: "如", pos: "VERB", xpos: "v,動詞,行為,分類", dep: "ROOT", head: 1, morph: "Degree=Equ" },
          { id: 2, text: "仇", lemma: "仇", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "comp:obj", head: 1 },
        ],
      }),
    ).toContain("仇に");
  });

  it("keeps 莫如 too, whose negator the ず machinery does not own", () => {
    // 莫如舜 — 舜に如くは莫し. 莫 is the existential negation and so is not in
    // `NEGATION_LEMMAS`; `COMPARATIVE_NEGATION_LEMMAS` holds it because for
    // *this* question a comparison denied by 莫 is as negative as one denied
    // by 不.
    expect(
      run({
        tokens: [
          { id: 0, text: "莫", lemma: "莫", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1 },
          { id: 1, text: "如", lemma: "如", pos: "VERB", xpos: "v,動詞,行為,分類", dep: "ROOT", head: 1, morph: "Degree=Equ" },
          { id: 2, text: "舜", lemma: "舜", pos: "PROPN", xpos: "n,名詞,人,名", dep: "comp:obj", head: 1 },
        ],
      }),
    ).toContain("に");
  });

  it("leaves 何如 alone — a preposed complement is the idiom, not a comparison", () => {
    // The corpus's 220 preposed `comp:obj` of 如 against 2,264 postposed are
    // this one fixed interrogative. Nothing of the の rule reaches it.
    expect(
      run({
        tokens: [
          { id: 0, text: "何", lemma: "何", pos: "NOUN", xpos: "v,副詞,疑問,原因", dep: "comp:obj", head: 1 },
          { id: 1, text: "如", lemma: "如", pos: "VERB", xpos: "v,動詞,行為,分類", dep: "ROOT", head: 1, morph: "Degree=Equ" },
        ],
      }),
    ).not.toContain("何の");
  });

  it("leaves もし alone — the conditional 如 carries no Degree=Equ", () => {
    // 如有復我者 — 如 as "if" is ADV `v,副詞,判断,推定` (198 tokens) and the
    // feature the の rule keys on is absent from every one of them.
    expect(
      run({
        tokens: [
          { id: 0, text: "如", lemma: "如", pos: "ADV", xpos: "v,副詞,判断,推定", dep: "mod", head: 1 },
          { id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 1 },
          { id: 2, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 1 },
        ],
      }),
    ).not.toContain("酒の");
  });

  it("leaves an adverbial mod of 如 alone — の goes on nominals only", () => {
    // `mod` under a `Degree=Equ` 如 is an ADV 1,280 times in the corpus against
    // 176 VERB, so the nominal gate is doing most of the work.
    expect(
      run({
        tokens: [
          { id: 0, text: "如", lemma: "如", pos: "ADJ", xpos: "v,動詞,行為,分類", dep: "ROOT", head: 0, morph: "Degree=Equ" },
          { id: 1, text: "亦", lemma: "亦", pos: "ADV", xpos: "v,副詞,頻度,重複", dep: "mod", head: 0 },
        ],
      }),
    ).not.toContain("の");
  });
});

// ---------------------------------------------------------------------------
// A hand-picked reading whose *shape* states no paradigm.
// ---------------------------------------------------------------------------

describe("a picked reading reaches the verb lexicon when the ending's shape cannot", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  const pickedNegated = (text: string, reading: string, okurigana: string): Sentence => ({
    tokens: [
      { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" },
      { id: 1, text, lemma: text, pos: "VERB", xpos: "v,動詞,行為,交流", dep: "ROOT", head: 1, misc: { Reading: reading, Okurigana: okurigana } },
      { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 1 },
    ],
  });

  it("不肥 with こ.える picked -> 肥えず, not the citation form 肥えるず", () => {
    // `chosenConjClass` reads the paradigm off the modern okurigana and
    // abstains on the あ row (a bare え could be ア行, ヤ行, ワ行 or ハ行 下二段),
    // so the pick arrived with no class and `pickedEnding` printed it
    // uninflected. `attestedSenseByModernSpelling` answers that exact question
    // from the verb lexicon — 肥 read こ with the modern ending える is 肥ゆ,
    // ヤ行下二段 — and was unreachable from this branch, because the entry was
    // looked up only once a class had already been found.
    expect(run(pickedNegated("肥", "こ", "える"))).toBe("肥えず");
  });

  it("still prints the citation form where nothing states a paradigm", () => {
    // 顫's ふる.える is the same あ-row shape and no classical 顫ふ/顫ゆ/顫う is
    // listed anywhere, so the fallback finds nothing and the reading keeps the
    // modern ending it always had. An uninflected ending is what this path
    // produced before; a confidently wrong paradigm would be worse.
    expect(run(pickedNegated("顫", "ふる", "える"))).toBe("顫えるず");
  });

  it("leaves a picked on'yomi with no okurigana on the サ変 route", () => {
    // A pick carrying no ending at all must not reach the lexicon: a bare
    // `undefined` okurigana matches every 形容動詞 sense there and would
    // conjugate the word into なり. `chosenConjClass` gives a VERB read on'yomi
    // サ変 outright, so it never needs the fallback.
    expect(
      run({
        tokens: [
          { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" },
          { id: 1, text: "破", lemma: "破", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1, misc: { Reading: "は" } },
        ],
      }),
    ).toBe("破せず");
  });
});

// ---------------------------------------------------------------------------
// Adverbs are ruby'd like adjectives: kanji retained, reading over, ending
// beside. `retainedAdverbParts` is the split, shared with KundokuView.ts.
// ---------------------------------------------------------------------------

describe("retainedAdverbParts", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const realKanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const realHistoricalKana = JSON.parse(
    readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8"),
  ) as HistoricalKanaIndex;

  // The okurigana is `retainedAdverbOkurigana`'s answer for the character —
  // KANJIDIC2's own dot for fourteen of the eighteen entries, the table's
  // assertion for the residue. Written out here because these are unit tests of
  // the *split*, which is a string operation and holds whatever the dictionary
  // says; that the dictionary says these is asserted in reading.test.ts.
  it("divides a reading into what goes over the character and what goes beside it", () => {
    expect(retainedAdverbParts("かならず", "ず")).toEqual({ reading: "かなら", okurigana: "ず" });
    expect(retainedAdverbParts("ことごとく", "く")).toEqual({ reading: "ことごと", okurigana: "く" });
    expect(retainedAdverbParts("ただし", "し")).toEqual({ reading: "ただ", okurigana: "し" });
  });

  it("puts the whole reading over a character whose adverb has no ending", () => {
    // 亦 is the case that shows the bug this split exists for: the kundoku
    // panel drew マタ in the okurigana slot with no furigana at all, and marked
    // the cell `kanaOnly` — a claim that the prose drops the kanji, which the
    // very table this serves says it does not.
    expect(retainedAdverbParts("また", "")).toEqual({ reading: "また", okurigana: "" });
    expect(retainedAdverbParts("みな", "")).toEqual({ reading: "みな", okurigana: "" });
  });

  it("declines a lemma the table does not hold, and a reading that is not that word", () => {
    // No entry, so no okurigana to divide at: the resolver attaches the field
    // only for a character `KANJI_RETAINED_ADVERBS` holds.
    expect(retainedAdverbParts("まなぶ", undefined)).toBeUndefined();
    // 獨 read どく as half of the compound 獨酌 does not end in 獨り's り, so the
    // split is refused rather than the string cut blindly — the same stand-down
    // `beatsLexicon` makes at the rule's own call sites.
    expect(retainedAdverbParts("どく", "り")).toBeUndefined();
    expect(retainedAdverbParts(undefined, "ず")).toBeUndefined();
  });

  it("agrees with the okurigana the prose panel actually prints", () => {
    // The split and the prose take the same value from the same place, so they
    // cannot drift: what `retainedAdverbParts` puts beside the character is
    // exactly what `generateKakikudashiPieces` writes after it. Walked over the
    // real dictionary, since that is where the value comes from.
    for (const char of Object.keys(KANJI_RETAINED_ADVERBS)) {
      const okurigana = retainedAdverbOkurigana(realKanjidic, char, realHistoricalKana);
      expect(okurigana, char).toBeTypeOf("string");
      expect(retainedAdverbParts("よ" + okurigana, okurigana)?.okurigana, char).toBe(okurigana);
    }
  });
});

describe("the 訓読文 divides a retained adverb too (real trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  /** 不亦說乎？ — the second half of 學而時習之，不亦說乎？. */
  const sentence: Sentence = {
    tokens: [
      { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
      { id: 1, text: "亦", lemma: "亦", pos: "ADV", xpos: "v,副詞,頻度,重複", dep: "mod", head: 2 },
      { id: 2, text: "說", lemma: "說", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 2, morph: "Degree=Pos" },
      { id: 3, text: "乎", lemma: "乎", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse:sp", head: 2 },
    ],
  };

  it("hands the split exactly what the resolver gives the kundoku panel", () => {
    // The branch this covers reads the resolved reading and the okurigana that
    // rides beside it, so what has to hold is that the *resolver's own* answer
    // for 亦 divides — not merely that the literal "また" does (which the unit
    // tests above already say). This is the step that was missing: the reading
    // arrived whole, the panel had no split to make and dropped the whole of it
    // into the okurigana slot.
    //
    // The resolver here is built with no historical-kana index, which the
    // derivation needs for 尚/猶 and not for 亦 — また is また in both
    // orthographies.
    const resolved = resolve(sentence.tokens[1], sentence);
    expect(resolved.reading).toBe("また");
    expect(resolved.retainedAdverbOkurigana).toBe("た");
    expect(retainedAdverbParts(resolved.reading, resolved.retainedAdverbOkurigana)).toEqual({
      reading: "ま",
      okurigana: "た",
    });
  });

  it("marks 亦 as spelled out in prose, which is the claim the panel must not repeat", () => {
    // `spellOutInProse` is what sent 亦 down the kana-only branch and tagged the
    // cell — and it is wrong for this word, which is why the retained-adverb
    // branch is placed ahead of it in both panels rather than the flag being
    // changed. The flag is still true here; it is simply no longer reached.
    expect(resolve(sentence.tokens[1], sentence).spellOutInProse).toBe(true);
  });

  it("keeps the character in the prose, which is what the two panels must agree on", () => {
    // The prose panel's own answer, unchanged by any of this: 亦 keeps its
    // kanji. A kundoku cell claiming otherwise is the disagreement.
    expect(generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), resolve)).toContain("亦");
  });
});

describe("negation endings: the attributive ざる, 莫し and 無不 (real trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  const period = (id: number, head: number): Token => ({ id, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head });
  const ye = (id: number, head: number): Token => ({ id, text: "也", lemma: "也", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head });
  const bu = (id: number, head: number): Token => ({ id, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head, morph: "Polarity=Neg" });
  const maku = (id: number, head: number): Token => ({ id, text: "莫", lemma: "莫", pos: "ADV", xpos: "v,副詞,否定,禁止", dep: "mod", head, morph: "Polarity=Neg" });
  const mu = (id: number, head: number): Token => ({ id, text: "無", lemma: "無", pos: "ADV", xpos: "v,動詞,存在,存在", dep: "mod", head, morph: "Polarity=Neg|VerbForm=Conv" });
  const zhi = (id: number, head: number, dep: string): Token => ({ id, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep, head });

  it("does not let a negation before a 、 modify the noun opening the next clause", () => {
    // 不知、人來。 The first clause ends on the negation; 人 belongs to the
    // second. Looking through the 、 at 人, the attributive test wrote 知らぬ、.
    const s: Sentence = {
      tokens: [
        bu(0, 1),
        zhi(1, 1, "ROOT"),
        { id: 2, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 1 },
        { id: 3, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "subj", head: 4 },
        { id: 4, text: "來", lemma: "來", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "parataxis", head: 1 },
        period(5, 1),
      ],
    };
    expect(run(s)).toContain("知らず、");
  });

  it("reads 莫能及 as 能く及ぶ莫し, with the 莫 inflected", () => {
    // 吳子 圖國 羣臣莫能及. 莫 is ADV and carries no `VerbForm=Conv`, so it
    // printed no reading at all until `usesLexiconEntry` admitted a postposed
    // predicate negation; and the ending is 莫し, a ク活用 adjective like 無し.
    const s: Sentence = {
      tokens: [
        maku(0, 1),
        { id: 1, text: "能", lemma: "能", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "ROOT", head: 1, morph: "Mood=Pot" },
        { id: 2, text: "及", lemma: "及", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "comp:aux", head: 1 },
        period(3, 1),
      ],
    };
    expect(run(s)).toBe("能く及ぶ莫し");
  });

  it("gives 莫 its 連体形 before the なり of a 也 hanging off 能", () => {
    // 莫能陷也 is 能く陷す莫きなり: the 也 hangs off 能, not off 莫, but it is read
    // straight after the 莫 and is what the 莫 has to be attributive for.
    const s: Sentence = {
      tokens: [
        maku(0, 1),
        { id: 1, text: "能", lemma: "能", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "ROOT", head: 1, morph: "Mood=Pot" },
        { id: 2, text: "及", lemma: "及", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "comp:aux", head: 1 },
        ye(3, 1),
        period(4, 1),
      ],
    };
    expect(run(s)).toBe("能く及ぶ莫きなり");
  });

  it("reads 莫不知也 as 知らざる莫きなり", () => {
    const s: Sentence = { tokens: [maku(0, 2), bu(1, 2), zhi(2, 2, "ROOT"), ye(3, 2), period(4, 2)] };
    expect(run(s)).toBe("知らざる莫きなり");
  });

  it("reads 無不知 as 知らざる無し, and writes the same ざる into the 訓読文", () => {
    // 老子 59 無不克 has this shape: 無 as ADV with `VerbForm=Conv`, 不 beside
    // it on the same verb. The 不 saw the 無 after it, which is neither a noun
    // nor a particle, and wrote 知らず無し.
    const s: Sentence = { tokens: [mu(0, 2), bu(1, 2), zhi(2, 2, "ROOT"), period(3, 2)] };
    expect(run(s)).toBe("知らざる無し");
    const plan = computeReadingOrder(s, findCompoundSpans(s));
    expect(negationEnding(s.tokens[1], plan, resolve)).toBe("ざる");
  });
});
