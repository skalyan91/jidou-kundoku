import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { attestedHistoricalReading } from "../src/reading/classicalEnding.ts";
import { chosenReading, chosenReadingParts, chosenReadingText } from "../src/reading/chosenReading.ts";
import { candidateReadings, type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findOverride } from "../src/reading/overridesLookup.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { SENTENCE_FINAL_WORD_LEMMAS, sentenceFinalParticle } from "../src/kakikudashi/bungoConjugation.ts";
import { pickedEnding, findRoot } from "../src/kakikudashi/conjugationContext.ts";
import { exportConllu } from "../src/parse/conlluExporter.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;

const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const makeToken = (overrides: Partial<Token>): Token => ({
  id: 0,
  text: "",
  lemma: "",
  pos: "",
  xpos: "",
  dep: "",
  head: 0,
  ...overrides,
});

const prose = (s: Sentence): string => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

// ---------------------------------------------------------------------------
// A hand-picked reading is stored modern and read back historical.
// ---------------------------------------------------------------------------

/** 甕中貯水 — 酒蟲 sent_id 30, whose 貯 carries the reader's own
 * `Reading=たくわ|Okurigana=える` in the MISC column. */
const storesWater = (misc: Record<string, string>): Sentence => ({
  tokens: [
    makeToken({ id: 0, text: "甕", lemma: "甕", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "compound", head: 1 }),
    makeToken({ id: 1, text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", morph: "Case=Loc", dep: "comp:obl", head: 2 }),
    makeToken({ id: 2, text: "貯", lemma: "貯", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 2, misc }),
    makeToken({ id: 3, text: "水", lemma: "水", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 2 }),
  ],
});

const PICKED = { Reading: "たくわ", Okurigana: "える" };

describe("a hand-picked reading is converted to 歴史的仮名遣い", () => {
  it("spells 貯's たくわ as たくは, which the verb lexicon attests", () => {
    // KANJIDIC2 offers the modern たくわ.える and the reader picked it; the
    // lexicon holds the same word as たくは + ハ行下二段 (貯ふ). Both halves
    // identify it — `attestedSenseByModernSpelling` is keyed by the whole
    // modern citation spelling — so this is a dictionary lookup rather than a
    // kana rule, which is the only thing that could be sound here.
    expect(attestedHistoricalReading("貯", "たくわ", "える")).toBe("たくは");
  });

  it("declines to convert anything the lexicon does not settle", () => {
    // No entry for the character at all.
    expect(attestedHistoricalReading("蟲", "むし", undefined)).toBe("むし");
    // An entry, but no sense spelling itself this way: 貯's other kanjidic
    // kun'yomi is た.める, which is a different word (下二段マ行 貯む).
    expect(attestedHistoricalReading("貯", "た", "める")).toBe("た");
    // The right reading with an okurigana no paradigm of that lemma surfaces
    // as — the pair is the headword, and half of it is not evidence.
    expect(attestedHistoricalReading("貯", "たくわ", "う")).toBe("たくわ");
    // Two senses match, so nothing is claimed: 用's もちいる is 用ゐる, 用ひる
    // and 用ゆ all three, and every one of them spells itself もちいる today.
    expect(attestedHistoricalReading("用", "もち", "いる")).toBe("もち");
    // No lemma to ask about — a reading is a stem, and only the character it
    // sits on says which word's stem it is.
    expect(attestedHistoricalReading(undefined, "たくわ", "える")).toBe("たくわ");
  });

  it("is idempotent, so a choice already stored historically is left alone", () => {
    expect(attestedHistoricalReading("貯", "たくは", "える")).toBe("たくは");
  });

  it("reaches both panels and the resolver through one function", () => {
    const token = storesWater(PICKED).tokens[2];
    expect(chosenReadingText(token)).toBe("たくは");
    expect(chosenReadingParts(token)?.reading).toBe("たくは");
    expect(chosenReading(token)?.reading).toBe("たくは");
  });

  it("shows たくは in the 訓読文 and in the 書き下し文 alike", () => {
    const sentence = storesWater(PICKED);
    expect(furiganaFor(sentence.tokens[2], sentence, resolve, historicalKana, kanjidic)).toBe("たくは");
    // The prose keeps the kanji (a picked reading is a content word's own
    // dictionary reading), so what it shows of the choice is the ending — but
    // the two panels are asked the same question and answer it once.
    expect(prose(sentence)).toContain("貯");
  });

  it("still finds the paradigm the pick had no ending to state", () => {
    // ハ行下二段, reached from the *stored* modern える through the lexicon —
    // `chosenConjClass` abstains on the whole あ row by design. Without it the
    // pick was frozen at its citation form.
    const sentence = storesWater(PICKED);
    const token = sentence.tokens[2];
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    const ending = pickedEnding(chosenReadingParts(token)!, token, findRoot(sentence), plan, resolve);
    expect(ending.okurigana).not.toBe("える");
  });

  it("converts on the way out, so the reader's own spelling survives a .conllu round trip", () => {
    // Where the conversion belongs, stated as a test: MISC keeps the string
    // the reader picked and the historical spelling is re-derived on every
    // render. Converting on the way *in* would have left every choice already
    // written to a file exactly as it was, with nothing to bring it up to
    // date — which is the case the user's own tree is.
    const conllu = [
      "# sent_id = 1",
      "# text = 貯水",
      "1\t貯\t貯\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\tReading=たくわ|Okurigana=える",
      "2\t水\t水\tNOUN\tn,名詞,可搬,道具\t_\t1\tcomp:obj\t_\t_",
      "",
    ].join("\n");
    const tree = parseConllu(conllu);
    const token = tree.sentences[0].tokens[0];
    expect(chosenReadingText(token)).toBe("たくは");
    expect(token.misc?.Reading).toBe("たくわ");
    expect(exportConllu(tree)).toContain("Reading=たくわ|Okurigana=える");
  });

  it("offers the same spelling in the furigana menu, so the item clicked is the reading shown", () => {
    const readings = candidateReadings(kanjidic, "貯", "VERB", historicalKana, jmdict).map((c) => c.reading);
    expect(readings).toContain("たくは");
    expect(readings).not.toContain("たくわ");
  });

  it("leaves the menu's own untouched readings alone", () => {
    // 貯's other kun'yomi, and its on'yomi — the conversion is per-sense and
    // claims nothing about a reading no sense of the character spells.
    const readings = candidateReadings(kanjidic, "貯", "VERB", historicalKana, jmdict).map((c) => c.reading);
    expect(readings).toContain("た");
    expect(readings).toContain("ちよ");
  });
});

// ---------------------------------------------------------------------------
// 歟 reads や, over the character.
// ---------------------------------------------------------------------------

describe("歟 is a sentence-final や", () => {
  it("is in the particle table, which is the entry both panels reach", () => {
    // Not `overrides.json`: both panels take the discourse branch before the
    // resolver is consulted at all, so a lemma that table did not know
    // rendered as nothing whatever the override said.
    expect(sentenceFinalParticle("歟")).toBe("や");
    expect(sentenceFinalParticle("欤")).toBe("や");
  });

  it("lands in the furigana slot, by construction", () => {
    // `SENTENCE_FINAL_WORD_LEMMAS` is every entry of that table with a
    // non-empty reading, so a particle added there is over the character and
    // not beside it without a second edit.
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("歟")).toBe(true);
    expect(SENTENCE_FINAL_WORD_LEMMAS.has("欤")).toBe(true);
  });

  it("says the same thing in the override table, for a 歟 tagged some other way", () => {
    expect(findOverride("歟")?.reading).toBe("や");
  });

  it("reads both 歟 of 然歟否歟？ — 酒蟲 sent_id 38", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "然", lemma: "然", pos: "ADV", xpos: "v,動詞,描写,態度", morph: "Degree=Pos|VerbForm=Conv", dep: "subj", head: 2 }),
        makeToken({ id: 1, text: "歟", lemma: "歟", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 0 }),
        makeToken({ id: 2, text: "否", lemma: "否", pos: "VERB", xpos: "v,動詞,描写,態度", morph: "Degree=Pos", dep: "ROOT", head: 2 }),
        makeToken({ id: 3, text: "歟", lemma: "歟", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 2 }),
        makeToken({ id: 4, text: "？", lemma: "？", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 2 }),
      ],
    };
    // Two や, one for each 歟 — the character used to contribute nothing at
    // all, so this sentence read 然…否む with both particles silently dropped.
    // The 否 between them is still the verb 否む: position is what tells the
    // two uses apart, and this one is the sentence's own ROOT.
    const out = prose(sentence);
    expect([...out].filter((k) => k === "や")).toHaveLength(2);
    expect(out).toContain("や否むや");
  });
});

// ---------------------------------------------------------------------------
// 非 takes ず alone in the okurigana slot.
// ---------------------------------------------------------------------------

describe("非 is あら over the character and ズ beside it", () => {
  it("states the split in the override entry, which is what moves the slot", () => {
    // An entry with an okurigana of its own is a reading plus an ending;
    // one without is a whole gloss standing in the okurigana slot. あらず was
    // the second shape, so the whole word sat beside a bare 非.
    const entry = findOverride("非", "ADV", "mod");
    expect(entry?.reading).toBe("あら");
    expect(entry?.okurigana).toBe("ず");
  });

  it("puts あら in the furigana slot for the ADV of 酒蟲 sent_id 36", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "非", lemma: "非", pos: "ADV", xpos: "v,副詞,否定,体言否定", morph: "Polarity=Neg", dep: "mod", head: 2 }),
        makeToken({ id: 1, text: "劉", lemma: "劉", pos: "PROPN", xpos: "n,名詞,人,姓氏", morph: "NameType=Sur", dep: "comp:obj", head: 2 }),
        makeToken({ id: 2, text: "病", lemma: "病", pos: "NOUN", xpos: "n,名詞,不可譲,疾病", dep: "ROOT", head: 2 }),
      ],
    };
    // Asserted on the resolver's own split rather than on `furiganaFor`,
    // which answers for the *prose* panel's ruby and returns undefined for
    // every `spellOutInProse` reading — the 訓読文 cell is built by the
    // override branch of `KundokuView.ts`'s render loop, and that branch reads
    // exactly these two fields. The same shape the 之 -> の + "" case is
    // asserted on in `reading.test.ts`.
    const resolved = resolve(sentence.tokens[0], sentence);
    expect(resolved.reading).toBe("あら");
    expect(resolved.okurigana).toBe("ず");
    // Nothing about the prose moves: both halves are written out there, so
    // the split is an annotation-slot change and not a reading change.
    expect(resolved.spellOutInProse).toBe(true);
    expect(prose(sentence)).toContain("あらず");
  });

  it("leaves the noun 非 unclaimed, as the entry's ADV condition always did", () => {
    expect(findOverride("非", "NOUN", "conj:coord")).toBeNull();
  });
});

/** A bare pinned reading on a descriptive is a 形容動詞 — see
 * `pinnedKeiyoudoushi` in `conjugationContext.ts` for the rule and for what
 * the corpus says about each of its conditions. */
describe("a pinned on'yomi on an adjective", () => {
  /** 不飲一斗、適以益貧 — the reader's own 酒蟲, with 貧 tagged ADJ and pinned
   * `Reading=ひん`. 貧 is `comp:pred` of 適, a verb of becoming, so the form
   * `isBecomingComplement` asks for is the 連用形. */
  const becomingComplement = (misc?: Record<string, string>): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "適", lemma: "適", pos: "VERB", xpos: "v,副詞,頻度,偶発", dep: "ROOT", head: 0 }),
      makeToken({
        id: 1, text: "貧", lemma: "貧", pos: "ADJ", xpos: "v,動詞,描写,境遇",
        morph: "Degree=Pos", dep: "comp:pred", head: 0, ...(misc ? { misc } : {}),
      }),
    ],
  });

  const endingFor = (sentence: Sentence, id: number) => {
    const token = sentence.tokens.find((t) => t.id === id)!;
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    return pickedEnding(chosenReadingParts(token)!, token, findRoot(sentence), plan, resolve);
  };

  it("inflects a pinned ひん as ナリ活用 instead of standing at its citation form", () => {
    // Bare 貧(ひん) before this: `chosenOkurigana` gives a pin with no stored
    // ending サ変's す on a VERB and nothing at all on an ADJ, and neither is
    // a paradigm a descriptive can take a 連用形 out of.
    const ending = endingFor(becomingComplement({ Reading: "ひん" }), 1);
    expect(ending.conjClass).toBe("nari-keiyoudoushi");
    expect(ending.form).toBe("renyou");
    expect(ending.okurigana).toBe("に");
  });

  it("reads 貧(ひん)に in both panels' shared answer, where the kun reading reads 貧しく", () => {
    expect(prose(becomingComplement({ Reading: "ひん" }))).toBe("貧に適く");
    expect(prose(becomingComplement())).toBe("貧しく適く");
  });

  it("leaves a pin that states its own okurigana or class exactly as it was", () => {
    // The reader has said what they want; the rule is for a bare `Reading=`.
    const withEnding = endingFor(becomingComplement({ Reading: "まづ", Okurigana: "し", ConjClass: "shiku-keiyoushi" }), 1);
    expect(withEnding.conjClass).toBe("shiku-keiyoushi");
    expect(withEnding.okurigana).toBe("しく");
  });

  it("declines a descriptive that governs an object, which is a transitive use", () => {
    // 僧愚之 — 愚 is `Degree=Pos` `v,動詞,描写,形質` with 之 as its `comp:obj`,
    // pinned `Reading=ぐ` in the reader's own tree. "The monk made a fool of
    // him", not "the monk was foolish": サ変 stands. Same evidence
    // `readingResolver.ts`'s own transitivity check runs on.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "僧", lemma: "僧", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }),
        makeToken({ id: 1, text: "愚", lemma: "愚", pos: "VERB", xpos: "v,動詞,描写,形質", morph: "Degree=Pos", dep: "ROOT", head: 1, misc: { Reading: "ぐ" } }),
        makeToken({ id: 2, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 1 }),
      ],
    };
    expect(endingFor(sentence, 1).conjClass).toBe("sa-hen");
    expect(prose(sentence)).toBe("僧これを愚す");
  });

  /** 元帝愕然 — the タリ binom, from the gold treebank verbatim. */
  const gakuzen = (stem?: Record<string, string>, suffix?: Record<string, string>): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "帝", lemma: "帝", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }),
      makeToken({ id: 1, text: "愕", lemma: "愕", pos: "VERB", xpos: "v,動詞,行為,態度", morph: "ExtPos=VERB", dep: "ROOT", head: 1, ...(stem ? { misc: stem } : {}) }),
      makeToken({ id: 2, text: "然", lemma: "然", pos: "PART", xpos: "p,接尾辞,*,*", dep: "unk", head: 1, ...(suffix ? { misc: suffix } : {}) }),
    ],
  });

  it("agrees with tariSuffixReading from either end of a binom, where a pin used to contradict it", () => {
    // Unpinned, 愕然たり — `tariSuffixReading`'s own answer. A pick is
    // consulted ahead of it, so before this a pinned stem printed the サ変 す
    // *inside* the word (愕す然たり) and a pinned suffix printed no ending at
    // all (愕然), the たり gone.
    expect(prose(gakuzen())).toBe("帝愕然たり");
    expect(prose(gakuzen({ Reading: "がく" }))).toBe("帝愕然たり");
    expect(prose(gakuzen(undefined, { Reading: "ぜん" }))).toBe("帝愕然たり");
    expect(prose(gakuzen({ Reading: "がく" }, { Reading: "ぜん" }))).toBe("帝愕然たり");
  });

  it("gives the pinned suffix タリ活用 and the pinned stem no ending of its own", () => {
    expect(endingFor(gakuzen(undefined, { Reading: "ぜん" }), 2).conjClass).toBe("tari-keiyoudoushi");
    // The ending belongs to the binom and the suffix is already writing it —
    // the reason `tariSuffixReading` marks the stem `endingComplete`.
    const stem = endingFor(gakuzen({ Reading: "がく" }), 1);
    expect(stem.conjClass).toBeUndefined();
    expect(stem.okurigana).toBe("");
  });

  /** 忽覺咽中暴癢 — the reader's own sent_id 24, with 暴 tagged ADV and pinned
   * `Reading=にはか`. The 形容動詞 is being used adverbially, so the form is the
   * 連用形 whatever the predicate it modifies turns out to be — the argument
   * `adverbialCopulaEnding` (readingResolver.ts) makes for the *unpinned*
   * token, which the pin used to route around. Trimmed to the three tokens the
   * rule turns on. */
  const suddenItch = (misc?: Record<string, string>): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "覺", lemma: "覺", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 }),
      makeToken({
        id: 1, text: "暴", lemma: "暴", pos: "ADV", xpos: "v,動詞,描写,態度",
        morph: "Degree=Pos", dep: "mod", head: 0, ...(misc ? { misc } : {}),
      }),
      makeToken({ id: 2, text: "癢", lemma: "癢", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 0 }),
    ],
  });

  it("gives a pinned ADV the 連用形, where the pin used to freeze it at 終止形", () => {
    // 暴なり before this: `decideConjForm` reads the tree, finds a `mod` edge
    // onto the root and none of its 連体形/未然形 environments, and answers
    // 終止形 — right for a predicate and wrong for a word that is not one.
    const ending = endingFor(suddenItch({ Reading: "にはか" }), 1);
    expect(ending.conjClass).toBe("nari-keiyoudoushi");
    expect(ending.form).toBe("renyou");
    expect(ending.okurigana).toBe("に");
  });

  it("reads 暴に pinned and unpinned alike — the pin corrects the reading, not the form", () => {
    // The unpinned line is `adverbialCopulaEnding`'s own and is unchanged; the
    // claim is that the pinned route, which goes round that rule entirely, now
    // arrives at the same 連用形. Asserted as the two lines agreeing rather than
    // against a written-out string: where in the line 暴 is *read* is the
    // reorder engine's business and not this rule's (a `mod` on the root is
    // read after the object here — see `tests/postposedSubject.test.ts`).
    const pinned = prose(suddenItch({ Reading: "にはか" }));
    expect(pinned).toBe(prose(suddenItch()));
    expect(pinned).toContain("暴に");
    expect(pinned).not.toContain("暴なり");
  });

  it("leaves a pinned descriptive that is *not* an ADV at the form the tree asks for", () => {
    // The 連用形 is the adverb's, not every pin's. 貧 above is `comp:pred` of a
    // verb of becoming and takes 連用形 from `isBecomingComplement`; the same
    // pin heading its own clause still closes it.
    const standalone: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "王", lemma: "王", pos: "PROPN", xpos: "n,名詞,人,姓氏", morph: "NameType=Sur", dep: "subj", head: 1 }),
        makeToken({ id: 1, text: "貧", lemma: "貧", pos: "ADJ", xpos: "v,動詞,描写,境遇", morph: "Degree=Pos", dep: "ROOT", head: 1, misc: { Reading: "ひん" } }),
      ],
    };
    expect(endingFor(standalone, 1).form).toBe("shuushi");
    expect(prose(standalone)).toBe("王貧なり");
  });
});
