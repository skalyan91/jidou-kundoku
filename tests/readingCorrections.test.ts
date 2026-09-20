import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { attestedHistoricalReading } from "../src/reading/classicalEnding.ts";
import { chosenReading, chosenReadingParts, chosenReadingText, setChosenReading } from "../src/reading/chosenReading.ts";
import { candidateReadings, type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { createReadingResolver, LEXICALIZED_NUMERAL_COMPOUND } from "../src/reading/readingResolver.ts";
import { findOverride } from "../src/reading/overridesLookup.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { SENTENCE_FINAL_WORD_LEMMAS, sentenceFinalParticle } from "../src/kakikudashi/bungoConjugation.ts";
import { pickedEnding, findRoot, readsAsSentenceFinalWord } from "../src/kakikudashi/conjugationContext.ts";
import { lexiconEntryFor, usesLexiconEntry } from "../src/kakikudashi/conjugationContext.ts";
import { LEXICON_SENSES, VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
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

  it("puts a *picked* か on 乎 in the same slot as an unpicked one — over the character", () => {
    // The reader's report: *"it looks like 乎 can be read as か, which should be
    // furigana."* The default path already did that — 乎 is in
    // `SENTENCE_FINAL_WORD_LEMMAS` by construction, so `KundokuView.ts`'s
    // discourse branch draws や (or か, inside a 豈 frame) over the character.
    // The *pick* path did not: it stands above the discourse branch, because a
    // pick outranks every guess the app makes, and it decided the slot from
    // `chosenSpellsOutInProse` alone — true of every PART — so か chosen off the
    // menu landed *beside* the character where the identical か chosen by the app
    // went over it.
    //
    // The slot is now `readsAsSentenceFinalWord`'s, asked by both branches. There
    // is no DOM in this suite, so what is pinned here is that predicate: it is
    // where the decision lives, and a cell cannot put the kana in two places.
    const withParticle = (lemma: string, xpos: string, dep: string): Sentence => ({
      tokens: [
        makeToken({ id: 0, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: lemma, lemma, pos: "PART", xpos, dep, head: 0 }),
      ],
    });
    const yes = (lemma: string) => {
      const s = withParticle(lemma, "p,助詞,句末,*", "discourse@sp");
      return readsAsSentenceFinalWord(s.tokens[1], s);
    };
    expect(yes("乎")).toBe(true);
    for (const lemma of ["也", "耳", "哉", "夫", "歟", "與"]) expect(yes(lemma)).toBe(true);
    // 矣 and 焉 render as the empty string and are on neither side of the slot
    // question — a reading that is nothing goes in no slot, and the set is
    // built without them.
    //
    // 焉 joined 矣 with the work that made it a 置き字. It had been reading り —
    // the 完了の助動詞, て + あり, which attaches to a 四段已然形 and to nothing
    // else — and the particle branch was writing that after a 終止形 (思ふり), a
    // negation (在らずり) and a 連体形 (有るり) alike. It was never a reading of
    // the character in any of its uses; `overrides.json` has said "" for it all
    // along and was simply not reachable, and the two tables now agree. **561**
    // gold tokens are the sentence-final 助字, and 606 gold sentences change,
    // every one of them the deletion of a り.
    for (const lemma of ["矣", "焉"]) expect(yes(lemma)).toBe(false);
  });

  it("keeps the two conditions that say a token is the particle at all", () => {
    // The relation, or `isSentenceFinalParticleUse` for the one the parser
    // mis-tags. A 耳 that is the noun みみ, and a 乎 that is a タリ suffix, are not
    // particles and must not claim the furigana slot on the strength of a lemma.
    const asNoun: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "割", lemma: "割", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "耳", lemma: "耳", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(readsAsSentenceFinalWord(asNoun.tokens[1], asNoun)).toBe(false);

    // 否 is the mis-tag the positional predicate exists for: VERB/`comp:obj`,
    // standing last, and it *is* the particle.
    const orNot: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "醉", lemma: "醉", pos: "ADJ", xpos: "v,動詞,描写,態度", morph: "Degree=Pos", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "否", lemma: "否", pos: "ADJ", xpos: "v,動詞,描写,態度", morph: "Degree=Pos", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(readsAsSentenceFinalWord(orNot.tokens[1], orNot)).toBe(true);
  });

  it("leaves the prose alone — it writes the kana in place of the kanji either way", () => {
    // The divergence was the 訓読文's alone: `generator.ts` writes the bare
    // particle for a discourse token, and `chosenSpellsOutInProse` already makes
    // its picked branch write the bare kana too, so both panels print か with the
    // character dropped whether or not the reading was picked.
    const question: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "乎", lemma: "乎", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 0 }),
      ],
    };
    expect(prose(question)).toBe("有りや");
    setChosenReading(question.tokens[1], "か");
    expect(prose(question)).toBe("有りか");
  });

  it("says the same thing in the override table, for a 歟 tagged some other way", () => {
    expect(findOverride("歟")?.reading).toBe("や");
  });

  it("reads both 歟 of 然歟否歟？ — 酒蟲 sent_id 38", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "然", lemma: "然", pos: "ADV", xpos: "v,動詞,描写,態度", morph: "Degree=Pos|VerbForm=Conv", dep: "subj", head: 2 }),
        makeToken({ id: 1, text: "歟", lemma: "歟", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 0 }),
        makeToken({ id: 2, text: "否", lemma: "否", pos: "ADJ", xpos: "v,動詞,描写,態度", morph: "Degree=Pos", dep: "ROOT", head: 2 }),
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
    // The prose writes 非ず — the character with the ず beside it, the same
    // division read in the other panel, and what the received text prints (非
    // stands on 30 of the 30 occurrences in the gold's own 白文). The split was
    // an annotation-slot change when this was written and now shows in both
    // slots; see `OverrideEntry.spellOutInProse`.
    expect(resolved.spellOutInProse).toBe(false);
    expect(prose(sentence)).toContain("非ず");
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
        makeToken({ id: 1, text: "愚", lemma: "愚", pos: "ADJ", xpos: "v,動詞,描写,形質", morph: "Degree=Pos", dep: "ROOT", head: 1, misc: { Reading: "ぐ" } }),
        makeToken({ id: 2, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 1 }),
      ],
    };
    expect(endingFor(sentence, 1).conjClass).toBe("sa-hen");
    expect(prose(sentence)).toBe("僧之を愚す");
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

// ---------------------------------------------------------------------------
// **A pin inflects.** The reader's own 酒蟲 carries three pins in one sentence
// whose `Okurigana=` is a *form* rather than a citation — 覺 as おぼ + ゆる (the
// 連体形 of ヤ行下二段 覚ゆ), 癢 as かゆ + き, 出 as い + でる — and a pin that
// states a form freezes it, so the ending on the page stopped being the one the
// tree calls for. 覺 is `root` there with a `conj:coord` after it, which wants
// the 連用中止法, and the same text unpinned derives exactly that.
//
// Nothing in `misc` is migrated to fix it. What changed is that
// `chosenConjClass` now reaches a paradigm where the ending alone stated none —
// from the exact modern spelling of a `VERB_LEXICON` sense, and failing that
// from the word itself (`soleAttestedClass`) — and a pin that has a paradigm
// goes through the ordinary conjugation pipeline like any other word.
// ---------------------------------------------------------------------------
describe("a pin that stores an inflected form still inflects", () => {
  const sentence24 = (): Sentence =>
    parseConllu(
      [
        "# text = 忽覺咽中暴癢哇有物出直墮酒中",
        "1\t忽\t忽\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t2\tmod\t_\t_",
        "2\t覺\t覺\tVERB\tv,動詞,行為,動作\tNameType=Giv\t0\troot\t_\tReading=おぼ|Okurigana=ゆる",
        "3\t咽\t咽\tNOUN\tn,名詞,不可譲,身体\t_\t4\tcompound\t_\t_",
        "4\t中\t中\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t2\tcomp:obl\t_\t_",
        "5\t暴\t暴\tADV\tv,動詞,描写,態度\tDegree=Pos\t2\tmod\t_\t_",
        "6\t癢\t癢\tNOUN\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\tReading=かゆ|Okurigana=き",
        "7\t、\t、\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_",
        "8\t哇\t哇\tNOUN\tv,動詞,行為,動作\t_\t9\tsubj\t_\t_",
        "9\t有\t有\tVERB\tv,動詞,存在,存在\t_\t2\tconj:coord\t_\t_",
        "10\t物\t物\tNOUN\tn,名詞,可搬,道具\t_\t11\tsubj\t_\t_",
        "11\t出\t出\tVERB\tv,動詞,行為,移動\t_\t9\tcomp:obj\t_\tReading=い|Okurigana=でる",
        "12\t、\t、\tPUNCT\ts,記号,読点,*\t_\t9\tpunct\t_\t_",
        "13\t直\t直\tADV\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Conv\t14\tmod\t_\tReading=ただ|Okurigana=ちに",
        "14\t墮\t墮\tVERB\tv,動詞,行為,動作\t_\t9\tconj:coord\t_\t_",
        "15\t酒\t酒\tNOUN\tn,名詞,可搬,糧食\t_\t16\tmod\t_\t_",
        "16\t中\t中\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t14\tcomp:obl\t_\t_",
        "17\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_",
        "",
      ].join("\n"),
    ).sentences[0];

  it("reads the reader's 覺 as 覺え, the form the tree asks for", () => {
    const out = prose(sentence24());
    expect(out).toContain("覺え");
    expect(out).not.toContain("覺ゆる");
    // 出's pin is い + でる, a *modern* ending, and has always converted — the
    // 連体形 before 有り is 出づる. Asserted beside 覺 so the two routes to a
    // paradigm (the shape tables, and the word) are seen answering together.
    expect(out).toContain("出づる");
  });

  it("leaves the reader's stored choices exactly as they were written", () => {
    // The round trip is the constraint: a `.conllu` file read in and written
    // out again must be the same file, whatever the page now makes of it.
    const before = sentence24();
    prose(before);
    const misc = Object.fromEntries(before.tokens.filter((t) => t.misc).map((t) => [t.text, t.misc]));
    expect(misc["覺"]).toEqual({ Reading: "おぼ", Okurigana: "ゆる" });
    expect(misc["癢"]).toEqual({ Reading: "かゆ", Okurigana: "き" });
    expect(misc["出"]).toEqual({ Reading: "い", Okurigana: "でる" });
    expect(exportConllu({ sentences: [sentence24()], source: "conllu" })).toContain("Reading=おぼ|Okurigana=ゆる");
  });

  it("leaves an adverb's pin frozen, which is what an adverb wants", () => {
    // 直 as ただ + ちに and 但 as た + だ are not predicates and have no form
    // question to ask. Nothing in the lexicon holds those stems, so the new
    // route abstains and they print exactly as the reader wrote them.
    expect(prose(sentence24())).toContain("直ちに");
  });
});

// ---------------------------------------------------------------------------
// **A pick on a modifying adjective is honoured.** An adjacent
// adjective-plus-noun pair is drawn as one fused span with one whole-word
// reading, which `compoundFurigana` writes on'yomi throughout — so 高山 is
// かうざん. That default stays: the construction is far more often a lexicalised
// title than a live phrase (大夫, 太子, 寡人, 大王, 皇帝 are its commonest members
// by a wide margin, and nothing in the tree separates those from 高山).
//
// What was wrong is that the reader could not overrule it. The menu offers 高
// as たかシ and the resolver resolves the pick correctly, but the span drew over
// it and the choice vanished. A pick on either member now stands the fusion
// down, which gives the adjective a cell and an okurigana slot of its own —
// which is what 高き needs and what a span cannot hold.
// ---------------------------------------------------------------------------
describe("a picked kun reading on a modifying adjective reaches the page", () => {
  const highMountain = (): Sentence =>
    parseConllu(
      [
        "# text = 高山走",
        "1\t高\t高\tADJ\tv,動詞,描写,量\tDegree=Pos\t2\tmod\t_\t_",
        "2\t山\t山\tNOUN\tn,名詞,固定物,地形\t_\t3\tsubj\t_\t_",
        "3\t走\t走\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_",
        "",
      ].join("\n"),
    ).sentences[0];

  it("offers the kun reading in the first place, with its paradigm", () => {
    // The menu was never the problem — this is asserted so that it stays that
    // way, since the pick below is worthless without a candidate to make it.
    const offered = candidateReadings(kanjidic, "高", "ADJ", historicalKana, jmdict);
    expect(offered).toContainEqual(expect.objectContaining({ reading: "たか", okurigana: "し", conjClass: "ku-keiyoushi" }));
  });

  it("leaves the pair fused, and on'yomi, until something is picked", () => {
    expect(findCompoundSpans(highMountain())).toEqual([{ tokenIds: [0, 1], text: "高山" }]);
  });

  it("un-fuses the pair once either member carries a pick", () => {
    const onModifier = highMountain();
    setChosenReading(onModifier.tokens[0], "たか", "し", "ku-keiyoushi");
    expect(findCompoundSpans(onModifier)).toEqual([]);
    // Either end: the pair is one unit, and the head is as likely to be the
    // thing the reader is correcting.
    const onHead = highMountain();
    setChosenReading(onHead.tokens[1], "やま");
    expect(findCompoundSpans(onHead)).toEqual([]);
  });

  it("writes the adjective's 連体形, not the 終止形 a bare default gives", () => {
    // 高**き**山, never 高**し**山 — a sentence-ending form in the middle of a
    // noun phrase, which is what fell out before `modifiesAdjacentNominal`
    // existed. That rule had nothing to do until pairs started un-fusing.
    const sentence = highMountain();
    setChosenReading(sentence.tokens[0], "たか", "し", "ku-keiyoushi");
    expect(prose(sentence)).toBe("高き山走る");
  });

  it("keeps the lexicalised titles fused, which is the whole reason the default stands", () => {
    const title = (m: string, h: string): Sentence =>
      parseConllu(
        [
          `# text = ${m}${h}`,
          `1\t${m}\t${m}\tADJ\tv,動詞,描写,量\tDegree=Pos\t2\tmod\t_\t_`,
          `2\t${h}\t${h}\tNOUN\tn,名詞,人,役割\t_\t0\troot\t_\t_`,
          "",
        ].join("\n"),
      ).sentences[0];
    // 大夫 514 and 太子 354 over the recoded gold, against 賢人's 21 — and both
    // are read on'yomi in kundoku, so an unpicked pair must go on fusing.
    expect(findCompoundSpans(title("大", "夫"))).toHaveLength(1);
    expect(findCompoundSpans(title("太", "子"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A pinned 断定の助動詞, and a pinned particle that spells itself out.
//
// Both from 論語 學而 sent_id 3 (有子曰其為人也孝弟而好犯上者鮮矣…孝弟也者其為
// 仁之本與), as the reader annotates it. The trees are written out here rather
// than parsed from his file so the shape under test is fixed; the ids and
// relations are his.
// ---------------------------------------------------------------------------

describe("a pinned copula is the 断定の助動詞, not a reading drawn over the character", () => {
  /** 孝弟也者、其為仁之本與 — the reader's own labels: 也 is the `mod` of 者 with
   * `Reading=なり` on it, 者 is `dislocated` with `Reading=もの`, and 本 is the
   * `comp:pred` of a 為 the reader pins `Reading=たり`. */
  const zheFrame = (weiMisc?: Record<string, string>): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "孝", lemma: "孝", pos: "NOUN", xpos: "v,動詞,行為,態度", morph: "VerbForm=Part", dep: "subj", head: 2 }),
      makeToken({ id: 1, text: "弟", lemma: "弟", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "compound", head: 0 }),
      makeToken({ id: 2, text: "也", lemma: "也", pos: "PART", xpos: "p,助詞,提示,*", dep: "mod", head: 3, misc: { Reading: "なり" } }),
      makeToken({ id: 3, text: "者", lemma: "者", pos: "PART", xpos: "p,助詞,提示,*", dep: "dislocated", head: 8, misc: { Reading: "もの" } }),
      makeToken({ id: 4, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", morph: "Person=3|PronType=Prs", dep: "subj", head: 8 }),
      makeToken({ id: 5, text: "仁", lemma: "仁", pos: "NOUN", xpos: "n,名詞,描写,態度", dep: "comp:obj", head: 6 }),
      makeToken({ id: 6, text: "之", lemma: "之", pos: "PART", xpos: "p,助詞,接続,属格", dep: "mod", head: 7 }),
      makeToken({ id: 7, text: "本", lemma: "本", pos: "NOUN", xpos: "n,名詞,描写,形質", dep: "comp:pred", head: 8 }),
      makeToken({ id: 8, text: "為", lemma: "爲", pos: "VERB", xpos: "v,動詞,行為,生産", dep: "ROOT", head: 8, ...(weiMisc ? { misc: weiMisc } : {}) }),
      makeToken({ id: 9, text: "與", lemma: "與", pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 8 }),
    ],
  });

  it("孝弟也者 -> 孝弟なるものは — the pin inflects, and both particles spell out", () => {
    // Three faults in one phrase, all of them the pick path skipping the
    // grammar around the reading. The pinned なり printed frozen at its 終止形
    // (孝弟なり者), because a pin is a reading and nothing in the app knew this
    // one was an auxiliary; 也 and 者 both kept their kanji, because the picked
    // branch of each panel wrote `token.text` unconditionally; and the は a
    // nominalizing 者 carries in a topic slot was lost with the rest of
    // `zheParticleReading`'s answer.
    expect(prose(zheFrame())).toContain("孝弟なるものは");
  });

  it("其為仁之本與 -> 其れ仁の本なりや once the 為 is pinned たり", () => {
    // The pin says the character is the 断定の助動詞; `COPULA` is the one
    // paradigm the app holds for that, so it is written なり and inflects from
    // context. The complement takes no case particle: the copula standing after
    // it is what a に would otherwise have said.
    //
    // **なる, until the 終助詞 や was corrected.** 與 reads や, and this asserted
    // 本な**る**や on the analysis that や binds a 連体形. It is 終止形接続 —
    // ナリ活用 is ラ変型 and 「あはれなりや」 is the attested shape — so what the
    // pin prints here is the 終止形 なり. `COPULA.rentai` is still selected in
    // this very slot by のみ, by か, by かな and by a following 者; see
    // `selectedForm`.
    expect(prose(zheFrame({ Reading: "たり" }))).toContain("其れ仁の本なりや");
    // Unpinned, the 為 is the reader's own `v,動詞,行為,生産` — a verb of
    // becoming with a predicative complement — and keeps the に that split
    // gives it. Nothing about the copula class is claimed off the relation.
    expect(prose(zheFrame())).toContain("仁の本に");
  });
});

describe("務 is 務む, the transitive verb kanbun uses", () => {
  /** 君子務本 — 論語 學而 sent_id 3, with 本 as 務's `comp:obj`. */
  const junziWuBen: Sentence = {
    tokens: [
      makeToken({ id: 0, text: "君子", lemma: "君子", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }),
      makeToken({ id: 1, text: "務", lemma: "務", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 }),
      makeToken({ id: 2, text: "本", lemma: "本", pos: "NOUN", xpos: "n,名詞,描写,形質", dep: "comp:obj", head: 1 }),
    ],
  };

  it("reads 君子務本 as 君子本を務む, not the modern intransitive 務まる", () => {
    // `VERB_LEXICON`'s derived entry was 四段ラ行 つと + まる — an intransitive
    // verb governing a direct object — and it outranked the resolver's own
    // correct つと + む because no transitivity decision was made to mark that
    // answer `beatsLexicon`. See the RESIDUAL entry in `verbLexicon.ts`.
    expect(prose(junziWuBen)).toBe("君子本を務む");
  });
});

describe("鮮 is すくなし, the quantity word, not the modern あざやか", () => {
  /** 鮮 alone as a predicate, on the `v,動詞,描写,量` tag 16 of the corpus's
   * 20 鮮 carry — the *quantity* class, which is すくなし. */
  const min = (dep: string, head: number): Token =>
    makeToken({ id: 1, text: "鮮", lemma: "鮮", pos: "ADJ", xpos: "v,動詞,描写,量", morph: "Degree=Pos", dep, head });

  const minSubjects: Sentence = {
    tokens: [makeToken({ id: 0, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }), min("ROOT", 1)],
  };

  it("reads 民鮮 as 民鮮なし", () => {
    // KANJIDIC's sole kun for 鮮 is あざ.やか, which is right about modern
    // Japanese and wrong about kanbun — the classical "few" sense is not in
    // the dictionary at all, so the resolver offered a stem with no paradigm
    // and 鮮 could not inflect. See the RESIDUAL entry in `verbLexicon.ts`
    // for the 16 / 3 / 1 gold split the reader ruled on.
    expect(prose(minSubjects)).toBe("民鮮なし");
  });

  it("inflects, which is the whole point of giving it a class", () => {
    // 孝弟而好犯上者鮮矣；不好犯上… — 鮮 is a non-final conjunct across the ；,
    // so it takes 連用形. It read 鮮やか in every slot alike while あざ + やか
    // was a stem with no paradigm, which is how a coordination fix that was
    // already correct stayed invisible.
    const chained: Sentence = {
      tokens: [
        min("ROOT", 1),
        makeToken({ id: 2, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "parataxis", head: 1 }),
      ],
    };
    expect(prose(chained)).toContain("鮮なく");
  });

  it("still offers あざやか in the menu, which the 3 形質 tokens need", () => {
    // 鮮魚曰脡祭 · 鮮肥屬時禁 · 紅妝白日鮮 are the `v,動詞,描写,形質` sense and
    // will read 鮮なき where they want 鮮やかなる. The split is in the xpos and
    // `VERB_LEXICON` is keyed on the lemma, so it cannot be drawn there — what
    // the reader gets instead is the other reading, one click away.
    const offered = candidateReadings(kanjidic, "鮮", "ADJ", historicalKana, jmdict).map(
      (c) => c.reading + (c.okurigana ?? ""),
    );
    // せん (on'yomi) · あざやか (KANJIDIC's kun) · すくなし (the lexicon's own
    // citation form) — the new default is offered as a whole ク活用 word, and
    // the one it displaced is still one click away.
    expect(offered).toContain("すくなし");
    expect(offered).toContain("あざやか");
  });
});

// ---------------------------------------------------------------------------
// A numeral over a predicate counts occasions; a numeral over a noun counts
// things. Both are NUM on `mod`, and the head's category is the whole signal —
// see `adverbialNumeralReading` in `readingResolver.ts` and the series itself
// in `ADVERBIAL_NUMERAL_KUN` (kanjidicLookup.ts).
// ---------------------------------------------------------------------------

/** 曾子曰：「吾日三省吾身：為人謀而不忠乎？ — gold sent_id KR1h0004_001_par4_1-3,
 * verbatim. It is the one sentence that carries all three of this session's
 * rulings at once: 三 NUM/`mod` on a VERB (the adverbial numeral), 吾 PRON/`det`
 * on 身 (the genitive わが), and 為 ADP/`mod` (the ため + に split).
 *
 * **Parsed rather than hand-built, and that is the point of it.** `parseConllu`
 * normalises the DEPREL column, and an entry written against a spelling it does
 * not produce matches nothing in silence — the `root`/`ROOT` case this file
 * already records. Every dep these three rules key on (`mod`, `det`) reaches
 * them here through the parser that will feed them in the app. */
const ZENGZI = `# sent_id = KR1h0004_001_par4_1-3
1\t曾子\t曾子\tPROPN\tn,名詞,人,複合的人名\tNameType=Prs\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t8\tpunct\t_\t_
5\t吾\t吾\tPRON\tn,代名詞,人称,起格\tPerson=1|PronType=Prs\t8\tsubj\t_\t_
6\t日\t日\tNOUN\tn,名詞,時,*\tCase=Tem\t8\tmod@tmod\t_\t_
7\t三\t三\tNUM\tn,数詞,数字,*\t_\t8\tmod\t_\t_
8\t省\t省\tVERB\tv,動詞,行為,動作\t_\t14\tmod\t_\t_
9\t吾\t吾\tPRON\tn,代名詞,人称,起格\tPerson=1|PronType=Prs\t10\tdet\t_\t_
10\t身\t身\tNOUN\tn,名詞,不可譲,身体\t_\t8\tcomp:obj\t_\t_
11\t：\t：\tPUNCT\ts,記号,読点,*\t_\t8\tpunct\t_\t_
12\t為\t爲\tADP\tv,前置詞,源泉,*\tShared=Yes\t14\tmod\t_\t_
13\t人\t人\tNOUN\tn,名詞,人,人\t_\t12\tcomp:obj\t_\t_
14\t謀\t謀\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
15\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t17\tcc\t_\t_
16\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t17\tmod\t_\t_
17\t忠\t忠\tVERB\tv,動詞,行為,態度\t_\t14\tconj:coord\t_\t_
18\t乎\t乎\tPART\tp,助詞,句末,*\tShared=Yes\t17\tdiscourse@sp\t_\t_
19\t？\t？\tPUNCT\ts,記号,句点,*\t_\t14\tpunct\t_\t_

`;

/** 子曰：「三年學， — gold sent_id KR1h0004_008_par12_1-2#0, verbatim. The
 * control: 三 stands `mod` here too, and its head is the NOUN 年, so nothing
 * about it may move. This is the majority the rule must not break — a numeral
 * on `mod` has a nominal head **3,368** times over the gold against **698** with
 * a VERB/ADJ one. */
const THREE_YEARS = `# sent_id = KR1h0004_008_par12_1-2#0
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t7\tpunct\t_\t_
5\t三\t三\tNUM\tn,数詞,数字,*\t_\t6\tmod\t_\t_
6\t年\t年\tNOUN\tn,名詞,時,*\tCase=Tem\t7\tmod@tmod\t_\t_
7\t學\t學\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
8\t，\t，\tPUNCT\ts,記号,読点,*\t_\t7\tpunct\t_\t_

`;

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];

describe("a numeral modifying a predicate is read ひとたび / みたび", () => {
  it("reads 三省吾身's 三 as み + たび, the character kept with its ending beside it", () => {
    const sentence = parsed(ZENGZI);
    const three = sentence.tokens.find((t) => t.text === "三")!;
    // The dep the rule is keyed on, as the parser actually spells it.
    expect(three.dep).toBe("mod");
    const resolved = resolve(three, sentence);
    expect(resolved.reading).toBe("み");
    expect(resolved.okurigana).toBe("たび");
    // Not `spellOutInProse`: this is a content word and the 書き下し文 keeps its
    // kanji, exactly as 再 does (再拜 is 再び拜す, not ふたたび拜す).
    expect(resolved.spellOutInProse).toBeUndefined();
    expect(furiganaFor(three, sentence, resolve, historicalKana, kanjidic)).toBe("み");
    expect(prose(sentence)).toContain("三たび");
  });

  it("leaves 三年 alone, which is the majority the rule must not break", () => {
    const sentence = parsed(THREE_YEARS);
    const three = sentence.tokens.find((t) => t.text === "三")!;
    expect(three.dep).toBe("mod");
    expect(resolve(three, sentence).okurigana).not.toBe("たび");
    expect(prose(sentence)).not.toContain("たび");
  });

  it("outranks the JMdict pair reading from both ends of the pair", () => {
    // 三省 is a JMdict headword (さんせい) whose reading splits into two genuine
    // on'yomi, so `onyomiPairReading` claimed it and the reader's own headline
    // example came out 三省す. The stand-down has to reach the *head* as well:
    // with only the modifier answered, 三 read みたび while 省 went on taking
    // its half of さんせい, and one word was read two ways on one page.
    const sentence = parsed(ZENGZI);
    const xing = sentence.tokens.find((t) => t.text === "省")!;
    expect(resolve(xing, sentence).reading).not.toBe("せい");
    expect(prose(sentence)).toContain("三たび");
  });

  it("offers the reading in the furigana menu, so the page can be argued with", () => {
    // KANJIDIC2 gives 三 only み / み.つ / みっ.つ, so until `curatedCandidates`
    // grew an arm for this table the menu on a 三 the app was reading みたび
    // could not name the reading on the page. The escape hatch matters here in
    // particular: the head's POS is a noisy signal in one direction (一切, 三分,
    // 三友 — see `adverbialNumeralReading`), and さん is one click away.
    const offered = candidateReadings(kanjidic, "三", "NUM", historicalKana, jmdict).map(
      (c) => c.reading + (c.okurigana ?? ""),
    );
    expect(offered).toContain("みたび");
    expect(offered).toContain("さん");
  });

  it("stops the series where the dictionary stops it", () => {
    // ひとたび / ふたたび / みたび are the adverbial numerals kundoku writes, and
    // JMdict holds 一たび and 三たび as headwords and no 四たび, 五たび … 千たび.
    // ふたたび is 再's word — the app already reads 再び off KANJIDIC2's own
    // ふたた.び — so 二 is left alone, along with every numeral above three.
    for (const char of "二四五六七八九十") {
      const offered = candidateReadings(kanjidic, char, "NUM", historicalKana, jmdict).map(
        (c) => c.reading + (c.okurigana ?? ""),
      );
      expect(offered.filter((r) => r.endsWith("たび") && r !== "ふたたび")).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 兩 over a predicate is 兩つながら, "both"; 兩 over a noun is the numeral of
// 兩軍. The treebank tags both NOUN, so the head is the whole signal — see
// `distributiveBothReading` in `readingResolver.ts`.
// ---------------------------------------------------------------------------

/** 故曰、兵不兩勝、亦不兩敗。 — rikutou19#5 in the kanbun.info corpus parses,
 * verbatim; received 兵は両つながら勝たず、亦た両つながら敗れず. */
const BOTH_WIN = `# text = 故曰、兵不兩勝、亦不兩敗。
1\t故\t故\tADV\tv,副詞,判断,確定\t_\t2\tmod\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t、\t、\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t兵\t兵\tNOUN\tn,名詞,人,役割\t_\t7\tsubj\t_\t_
5\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t7\tmod\t_\t_
6\t兩\t兩\tNOUN\tn,名詞,数量,*\t_\t7\tudep\t_\t_
7\t勝\t勝\tVERB\tv,動詞,行為,交流\t_\t2\tcomp:obj\t_\t_
8\t、\t、\tPUNCT\ts,記号,読点,*\t_\t7\tpunct\t_\t_
9\t亦\t亦\tADV\tv,副詞,頻度,重複\t_\t12\tmod\t_\t_
10\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t12\tmod\t_\t_
11\t兩\t兩\tNOUN\tn,名詞,数量,*\t_\t12\tudep\t_\t_
12\t敗\t敗\tVERB\tv,動詞,行為,交流\t_\t7\tparataxis\t_\t_
13\t。\t。\tPUNCT\ts,記号,句点,*\t_\t12\tpunct\t_\t_

`;

/** 武王曰、兩軍相遇。 — rikutou12#3, verbatim: the control, 兩 on `mod` over the
 * noun 軍, received 両軍相遇う. */
const TWO_ARMIES = `# text = 武王曰、兩軍相遇。
1\t武\t武\tPROPN\tn,名詞,人,その他の人名\tNameType=Prs\t2\tcompound\t_\t_
2\t王\t王\tNOUN\tn,名詞,人,役割\t_\t3\tsubj\t_\t_
3\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
4\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
5\t兩\t兩\tNOUN\tn,名詞,数量,*\t_\t6\tmod\t_\t_
6\t軍\t軍\tNOUN\tn,名詞,主体,集団\t_\t8\tsubj\t_\t_
7\t相\t相\tADV\tv,副詞,範囲,共同\t_\t8\tmod\t_\t_
8\t遇\t遇\tVERB\tv,動詞,行為,交流\t_\t3\tcomp:obj\t_\t_
9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t8\tpunct\t_\t_

`;

describe("兩 over a predicate is read ふた + つながら", () => {
  it("reads 兵不兩勝、亦不兩敗 as 兩つながら twice, the character kept", () => {
    const sentence = parsed(BOTH_WIN);
    for (const both of sentence.tokens.filter((t) => t.text === "兩")) {
      const resolved = resolve(both, sentence);
      expect(resolved.reading).toBe("ふた");
      expect(resolved.okurigana).toBe("つながら");
      expect(resolved.spellOutInProse).toBeUndefined();
    }
    expect(prose(sentence).match(/兩つながら/g)).toHaveLength(2);
  });

  it("leaves 兩軍 alone, the numeral of a noun", () => {
    const sentence = parsed(TWO_ARMIES);
    const two = sentence.tokens.find((t) => t.text === "兩")!;
    expect(resolve(two, sentence).okurigana).not.toBe("つながら");
    expect(prose(sentence)).not.toContain("つながら");
  });

  it("offers the reading in the furigana menu", () => {
    const offered = candidateReadings(kanjidic, "兩", "NOUN", historicalKana, jmdict).map(
      (c) => c.reading + (c.okurigana ?? ""),
    );
    expect(offered).toContain("ふたつながら");
  });
});

// ---------------------------------------------------------------------------
// A first-person pronoun modifying a noun is a genitive: 吾 is わが, not われ.
// ---------------------------------------------------------------------------

describe("a first-person pronoun on det reads わが", () => {
  it("reads 省吾身's 吾 as わ + が, the split 其 takes as そ + の", () => {
    const sentence = parsed(ZENGZI);
    const mine = sentence.tokens.find((t) => t.dep === "det")!;
    expect(mine.text).toBe("吾");
    const resolved = resolve(mine, sentence);
    expect(resolved.reading).toBe("わ");
    expect(resolved.okurigana).toBe("が");
    // A PRON is the one POS whose override reading takes the furigana slot —
    // see `ResolvedReading.spellOutInProse` — so the 訓読文 draws 吾(わ)が身 and
    // the が sits beside the character rather than over it.
    expect(furiganaFor(mine, sentence, resolve, historicalKana, kanjidic)).toBe("わ");
    expect(prose(sentence)).toContain("吾が身");
  });

  it("leaves the subject 吾 as われ, which is the same sentence's other 吾", () => {
    // The reading and not the prose: the character is kept in both slots now
    // (`OverrideEntry.spellOutInProse`, and the received text keeps 吾 on 108
    // of 108), so what tells the two 吾 of 吾日三省吾身 apart on the page is the
    // が after the second and not a われ against a わ. The readings still differ
    // and are what this asserts.
    const sentence = parsed(ZENGZI);
    const subject = sentence.tokens.find((t) => t.text === "吾" && t.dep === "subj")!;
    expect(resolve(subject, sentence).reading).toBe("われ");
    expect(prose(sentence)).toContain("吾日");
  });

  it("is reachable for all five characters, on the dep the parser writes", () => {
    // The `contextDep` gotcha stated as a test: `findOverride` is asked with the
    // dep spelling `parseConllu` produces, and an entry keyed on anything else
    // would return the char-only われ here without failing anywhere.
    for (const char of ["吾", "我", "予", "余", "朕"]) {
      expect(findOverride(char, "PRON", "det")?.reading).toBe("わ");
      expect(findOverride(char, "PRON", "det")?.okurigana).toBe("が");
      expect(findOverride(char, "PRON", "subj")?.reading).toBe("われ");
    }
  });
});

// ---------------------------------------------------------------------------
// 為 as a preposition is ため + に, not one four-kana reading.
// ---------------------------------------------------------------------------

describe("a prepositional 為 is divided ため + に", () => {
  it("puts に in the okurigana slot and ため over the character", () => {
    // The 訓読文 cell for a `spellOutInProse` reading is built by the override
    // branch of `KundokuView.ts`'s render loop, and that branch keys on exactly
    // these two fields: an entry stating an `okurigana` of its own is a split —
    // reading over the character, ending beside it — and one stating none is a
    // whole gloss that goes in the okurigana slot entire. Asserted here rather
    // than on `furiganaFor`, which answers for the *prose* panel's ruby and
    // returns undefined for every `spellOutInProse` non-pronoun. Same shape the
    // 非 -> あら + ず case above is asserted on.
    const sentence = parsed(ZENGZI);
    const wei = sentence.tokens.find((t) => t.text === "為")!;
    expect(wei.pos).toBe("ADP");
    const resolved = resolve(wei, sentence);
    expect(resolved.reading).toBe("ため");
    expect(resolved.okurigana).toBe("に");
    expect(resolved.spellOutInProse).toBe(true);
  });

  it("changes nothing in the 書き下し文, which writes reading + okurigana", () => {
    expect(prose(parsed(ZENGZI))).toContain("ために");
  });

  it("does not disturb 為's other two entries", () => {
    // The copula and the char-only fallback are scored above/below this one by
    // `findOverride`'s specificity ranking, not by table order — see
    // `overridesLookup.ts`.
    expect(findOverride("為", "VERB", "ROOT")?.reading).toBe("たり");
    expect(findOverride("為", "VERB", "comp:obj")?.reading).toBe("なす");
    for (const char of ["為", "爲"]) {
      expect(findOverride(char, "ADP", "mod")?.reading).toBe("ため");
      expect(findOverride(char, "ADP", "mod")?.okurigana).toBe("に");
    }
  });
});

// ---------------------------------------------------------------------------
// A numeral-initial pair that is one Sino-Japanese word is read as that word,
// not as a numeral counting occasions of it: 一切 いっさい, 三分 さんぶん, 一片
// いっぺん — see `LEXICALIZED_NUMERAL_COMPOUND` in `readingResolver.ts`.
// ---------------------------------------------------------------------------

/** 請一切逐之。 — gold sent_id KR2b0041_008_par1_191-195, verbatim. The adverbial
 * 一切 ("in every case"), which is the same word and the same reading as the
 * Buddhist attributive one: 請ふ一切之を逐へ. Its 切 is ADJ, which is 32 of the
 * 36 gold 一切. */
const EXPEL_THEM_ALL = `# sent_id = KR2b0041_008_par1_191-195
1\t請\t請\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_
2\t一\t一\tNUM\tn,数詞,数字,*\t_\t3\tmod\t_\t_
3\t切\t切\tADJ\tv,動詞,描写,形質\tDegree=Pos\t4\tmod\t_\t_
4\t逐\t逐\tVERB\tv,動詞,行為,交流\t_\t1\tcomp:obj\t_\t_
5\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t4\tcomp:obj\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_

`;

/** 一切賢聖皆以無為法而有差別。」 — gold sent_id KR6c0023_001_par7_86-98, verbatim
 * (金剛般若波羅蜜經). The 4 一切 whose 切 the gold tags **VERB**, with
 * `Gloss=cut` on it and `VERB_LEXICON`'s きる waiting behind that tag — the
 * pair reading has to beat the lexicon and take no ending at all, since 一切す
 * is not a word. 一切の賢聖は皆無爲の法を以て差別有り. */
const ALL_THE_SAGES = `# sent_id = KR6c0023_001_par7_86-98
1\t一\t一\tNUM\tn,数詞,数字,*\t_\t2\tmod\t_\t_
2\t切\t切\tVERB\tv,動詞,行為,動作\tVerbForm=Part\t4\tmod\t_\t_
3\t賢\t賢\tADJ\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Part\t4\tmod\t_\t_
4\t聖\t聖\tNOUN\tn,名詞,人,役割\tShared=Yes\t6\tsubj\t_\t_
5\t皆\t皆\tADV\tv,副詞,範囲,総括\t_\t6\tmod\t_\t_
6\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
7\t無\t無\tADV\tv,動詞,存在,存在\tPolarity=Neg|VerbForm=Conv\t8\tmod\t_\t_
8\t為\t爲\tVERB\tv,動詞,行為,生産\t_\t9\tmod\t_\t_
9\t法\t法\tNOUN\tn,名詞,制度,儀礼\t_\t6\tcomp:obj\t_\t_
10\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_

`;

/** 三分天下 — gold sent_id KR1h0004_008_par20_44-47#0, verbatim. The reader's
 * ruling: 天下を三分す, not みたび分く. Its 分 is VERB and governs 天下 as
 * `comp:obj`, which is why this entry alone carries `suru`. */
const DIVIDE_THE_REALM = `# sent_id = KR1h0004_008_par20_44-47#0
1\t三\t三\tNUM\tn,数詞,数字,*\t_\t2\tmod\t_\t_
2\t分\t分\tVERB\tv,動詞,行為,設置\t_\t0\troot\t_\t_
3\t天\t天\tNOUN\tn,名詞,制度,場\tCase=Loc\t4\tcompound\t_\t_
4\t下\t下\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t2\tcomp:obj\t_\t_

`;

/** 一片孤城萬仞山 — gold sent_id KR4h0169_001_author#3191, verbatim (王之渙,
 * 涼州詞). 一片の孤城萬仞の山. 片 is ADJ standing `mod` on the noun after it and
 * governs nothing, so nothing here is a predicate being counted. */
const ONE_LONE_WALL = `# sent_id = KR4h0169_001_author#3191
1\t一\t一\tNUM\tn,数詞,数字,*\t_\t2\tmod\t_\t_
2\t片\t片\tADJ\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t4\tmod\t_\t_
3\t孤\t孤\tADJ\tv,動詞,描写,境遇\tDegree=Pos|VerbForm=Part\t4\tmod\t_\t_
4\t城\t城\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t0\troot\t_\t_
5\t萬\t萬\tNUM\tn,数詞,数字,*\t_\t6\tmod\t_\t_
6\t仞\t仞\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t7\tmod\t_\t_
7\t山\t山\tNOUN\tn,名詞,固定物,地形\tCase=Loc\t4\tconj:coord\t_\t_

`;

/** 權何得毋分，是我王果處三分之一也。」 — gold sent_id
 * KR2e0003_085_par1_363-369#1, verbatim. The same 三分 with a **NOUN** 分, which
 * the adverbial rule never saw and which must not be given a サ変 ending:
 * 是れ我が王果たして三分の一に處るなり. */
const ONE_THIRD = `# sent_id = KR2e0003_085_par1_363-369#1
1\t權\t權\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t何\t何\tADV\tv,副詞,疑問,原因\tAdvType=Cau\t3\tmod\t_\t_
3\t得\t得\tVERB\tv,動詞,行為,得失\t_\t11\tmod\t_\t_
4\t毋\t毋\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t5\tmod\t_\t_
5\t分\t分\tVERB\tv,動詞,行為,設置\t_\t3\tcomp:obj\t_\t_
6\t，\t，\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
7\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t11\tsubj\t_\t_
8\t我\t我\tPRON\tn,代名詞,人称,止格\tPerson=1|PronType=Prs\t9\tdet\t_\t_
9\t王\t王\tNOUN\tn,名詞,人,役割\t_\t11\tsubj\t_\t_
10\t果\t果\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t11\tmod\t_\t_
11\t處\t處\tVERB\tv,動詞,行為,設置\t_\t0\troot\t_\t_
12\t三\t三\tNUM\tn,数詞,数字,*\t_\t13\tmod\t_\t_
13\t分\t分\tNOUN\tn,名詞,数量,*\t_\t14\tcomp:obj\t_\t_
14\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t15\tmod\t_\t_
15\t一\t一\tNUM\tn,数詞,数字,*\t_\t11\tcomp:obj\t_\t_
16\t也\t也\tPART\tp,助詞,句末,*\t_\t11\tdiscourse@sp\t_\t_
17\t。\t。\tPUNCT\ts,記号,句点,*\t_\t11\tpunct\t_\t_
18\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t16\tpunct\t_\t_

`;

/** 背城一戰。 — the second clause of gold sent_id KR2b0041_011_par4_2288-2297,
 * verbatim. The control this whole table has to leave standing: 一 NUM/`mod` on
 * a VERB 戰 that is *not* a listed pair, so it goes on reading 一たび — 城を背に
 * して一たび戰ふ. */
const FIGHT_ONCE = `# sent_id = KR2b0041_011_par4_2288-2297b
1\t背\t背\tVERB\tv,動詞,変化,生物\t_\t0\troot\t_\t_
2\t城\t城\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t1\tcomp:obj\t_\t_
3\t一\t一\tNUM\tn,数詞,数字,*\t_\t4\tmod\t_\t_
4\t戰\t戰\tVERB\tv,動詞,行為,交流\t_\t1\tparataxis\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_

`;

describe("a lexicalized numeral-initial compound is read as one word", () => {
  const furigana = (sentence: Sentence, text: string): string | undefined =>
    furiganaFor(sentence.tokens.find((t) => t.text === text)!, sentence, resolve, historicalKana, kanjidic);

  it("reads 一切 as いつさい from both ends, where the numeral rule read 一たび切る", () => {
    const sentence = parsed(EXPEL_THEM_ALL);
    const [one, qie] = ["一", "切"].map((t) => sentence.tokens.find((k) => k.text === t)!);
    // The three features the adverbial rule keys on are all present and are all
    // satisfied — this is not a mis-annotation being worked around.
    expect([one.pos, one.dep, qie.pos]).toEqual(["NUM", "mod", "ADJ"]);
    expect(resolve(one, sentence).reading).toBe("いつ");
    expect(resolve(qie, sentence).reading).toBe("さい");
    expect(resolve(one, sentence).okurigana).toBeUndefined();
    // Both panels, one answer. The 書き下し文 keeps the kanji (source
    // "kanjidic", not "override"), so 一切 appears there as itself.
    expect(furigana(sentence, "一")).toBe("いつ");
    expect(furigana(sentence, "切")).toBe("さい");
    expect(prose(sentence)).toContain("一切");
    expect(prose(sentence)).not.toContain("たび");
    expect(prose(sentence)).not.toContain("切る");
  });

  it("beats VERB_LEXICON's きる on the 4 一切 whose 切 the gold tags VERB", () => {
    const sentence = parsed(ALL_THE_SAGES);
    const qie = sentence.tokens.find((t) => t.text === "切")!;
    expect(qie.pos).toBe("VERB");
    const resolved = resolve(qie, sentence);
    expect(resolved.beatsLexicon).toBe(true);
    // Both panels consult the lexicon ahead of the resolver for a VERB, so the
    // flag is what actually decides this one — without it the page reads 切る.
    expect(furigana(sentence, "切")).toBe("さい");
    // 一切 is a noun and an adverb; 一切す is not a word, so the head takes no
    // ending whatever its VerbForm says.
    expect(resolved.okurigana).toBeUndefined();
    expect(resolved.endingComplete).toBe(true);
    expect(prose(sentence)).toContain("一切");
  });

  it("reads 一片 as いつぺん, where 片 was falling to its kun'yomi かた", () => {
    const sentence = parsed(ONE_LONE_WALL);
    expect(furigana(sentence, "一")).toBe("いつ");
    expect(furigana(sentence, "片")).toBe("ぺん");
    expect(prose(sentence)).toContain("一片");
    expect(prose(sentence)).not.toContain("たび");
  });

  it("gives 三分 the サ変 ending its dictionary entry states, as a paradigm", () => {
    const sentence = parsed(DIVIDE_THE_REALM);
    const fen = sentence.tokens.find((t) => t.text === "分")!;
    const resolved = resolve(fen, sentence);
    expect(furigana(sentence, "三")).toBe("さん");
    expect(resolved.reading).toBe("ぶん");
    // す is only サ変's 終止形; naming the class lets the ordinary conjugation
    // pipeline inflect it, which 功蓋三分國 (連体形) needs.
    expect(resolved.okurigana).toBe("す");
    expect(resolved.conjClass).toBe("sa-hen");
    expect(prose(sentence)).not.toContain("たび");
    // **What this sentence does *not* yet do**, recorded rather than asserted
    // away: 分 is the verb and the reading order moves it behind 天下, so the
    // page reads 三天下を分す where the convention is 天下を三分す. 9 of the 10
    // gold 三分 do this, both panels identically. It is `computeReadingOrder`'s
    // gap and not this table's — the shipped 大破敵軍 comes out 大敵軍を破す for
    // exactly the same reason. See `LEXICALIZED_NUMERAL_COMPOUND`.
    expect(prose(sentence)).toContain("分す");
  });

  it("writes no ending on the same 三分 where the gold tags 分 a NOUN", () => {
    // 三分之一 is 三分の一. The `suru` flag is asked of the head's own tag as
    // well as of the table, and this is the token that makes that necessary.
    const sentence = parsed(ONE_THIRD);
    // The sentence holds two 分 — the VERB of 何得毋分 and the NOUN of 三分之一
    // — and only the second is half of a listed pair.
    const fen = sentence.tokens.filter((t) => t.text === "分").find((t) => t.pos === "NOUN")!;
    expect(fen.pos).toBe("NOUN");
    expect(resolve(fen, sentence).reading).toBe("ぶん");
    expect(resolve(fen, sentence).okurigana).toBeUndefined();
    expect(prose(sentence)).toContain("三分の一");
  });

  it("leaves 一戰 reading 一たび, which is the rule the table is carved out of", () => {
    const sentence = parsed(FIGHT_ONCE);
    const one = sentence.tokens.find((t) => t.text === "一")!;
    expect(resolve(one, sentence).reading).toBe("ひと");
    expect(resolve(one, sentence).okurigana).toBe("たび");
    expect(prose(sentence)).toContain("一たび");
  });

  it("reads as its JMdict headword, which is where every share comes from", () => {
    // The shares are divided by hand — `splitCompoundReading` cannot divide a
    // geminate compound, since 一's on'yomi are イチ and イツ and neither is the
    // いっ of いっさい — so this is the check that the hand division still adds
    // up to the dictionary's own reading of the whole word.
    for (const [word, entry] of Object.entries(LEXICALIZED_NUMERAL_COMPOUND)) {
      expect([...word].length).toBe(entry.shares.length);
      expect(entry.shares.join("")).toBe(jmdict[word]?.reading);
    }
    expect(Object.keys(LEXICALIZED_NUMERAL_COMPOUND)).toEqual(["一切", "一片", "三分"]);
  });

  it("keeps every share in the furigana menu, so the page can be argued with", () => {
    // Each share is the character's own on'yomi (一 イツ, 切 サイ, 三 サン, 分
    // ブン), so what is on the page is already one of the menu's own entries and
    // a reader who wants ひとたび or みたび back is one click away. 片 is the one
    // exception and it is a spelling one: いっぺん voices ヘン the way any
    // non-initial member of a jukugo may, and the menu lists the unvoiced へん
    // — `compoundMemberCandidates` adds the rendaku variant for the splitter,
    // not for the reader.
    for (const [char, share] of [["一", "いつ"], ["切", "さい"], ["片", "へん"], ["三", "さん"], ["分", "ぶん"]]) {
      const offered = candidateReadings(kanjidic, char, "NUM", historicalKana, jmdict).map((c) => c.reading);
      expect(offered).toContain(share);
    }
  });
});

// ---------------------------------------------------------------------------
// The 下二段 words a modern -eru spelling hides — `RESIDUAL` in verbLexicon.ts.
// ---------------------------------------------------------------------------

/** Gold sentences, verbatim, one per entry. **Parsed rather than hand-built**,
 * for the reason `ZENGZI` above gives at length: `parseConllu` normalises the
 * DEPREL column and an entry keyed on a spelling it does not produce matches
 * nothing in silence. Every one of these tokens reaches `usesLexiconEntry`
 * through the parser that will feed it in the app, and the assertions below
 * check that gate explicitly, so a lemma written into the table under a
 * spelling the treebank does not use would fail here rather than pass quietly.
 *
 * The sentences also carry their own variant question: 不絕樂's form is 絕 and
 * its lemma is 絶, which is how this treebank writes the character, so the
 * entry that has to answer is the one keyed 絶 and not the one keyed 絕. */
const GIVE_HIM_A_KETTLE = `# sent_id = KR1h0004_006_par4_13-14
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t5\tpunct\t_\t_
5\t與\t與\tVERB\tv,動詞,行為,交流\t_\t2\tcomp:obj\t_\t_
6\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t5\tcomp:obl\t_\t_
7\t釜\t釜\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t5\tcomp:obj\t_\t_
8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_
9\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t7\tpunct\t_\t_

`;

const SERVING_A_RULER = `# sent_id = KR1h0004_004_par26_1-3#0
1\t子游\t子游\tPROPN\tn,名詞,人,名\tNameType=Giv\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
5\t事\t事\tVERB\tv,動詞,行為,交流\t_\t7\tsubj\t_\t_
6\t君\t君\tNOUN\tn,名詞,人,役割\t_\t5\tcomp:obj\t_\t_
7\t數\t數\tADJ\tv,動詞,描写,量\tDegree=Pos\t2\tcomp:obj\t_\t_
8\t，\t，\tPUNCT\ts,記号,読点,*\t_\t7\tpunct\t_\t_

`;

const HANDED_DOWN = `# sent_id = KR1d0052_014_par27_48-53#1
1\t天\t天\tNOUN\tn,名詞,制度,場\tCase=Loc\t2\tcompound\t_\t_
2\t下\t下\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t3\tsubj\t_\t_
3\t傳\t傳\tVERB\tv,動詞,行為,伝達\t_\t5\tsubj\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t久\t久\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
6\t矣\t矣\tPART\tp,助詞,句末,*\t_\t5\tdiscourse@sp\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_

`;

const NEST_OF_WOOD = `# sent_id = KR2b0041_001_par1_79-82
1\t構\t構\tVERB\tv,動詞,行為,設置\t_\t0\troot\t_\t_
2\t木\t木\tNOUN\tn,名詞,固定物,樹木\t_\t1\tcomp:obj\t_\t_
3\t爲\t爲\tVERB\tv,動詞,行為,生産\t_\t1\tparataxis\t_\t_
4\t巢\t巢\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t3\tcomp:obj\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_

`;

const MUSIC_UNBROKEN = `# sent_id = KR1d0052_021_par30_43-45#1
1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t絕\t絶\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t樂\t樂\tNOUN\tn,名詞,制度,儀礼\t_\t2\tcomp:obj\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_

`;

/** 未可與適道 — 論語 子罕, verbatim. The **adverbial** 與, which is the same
 * character and not the same word: `v,動詞,行為,交流` ADV on `mod` with
 * `VerbForm=Conv`, the shape all 61 of the gold's adverbial 與 carry. */
const NOT_YET_TOGETHER = `# sent_id = KR1h0004_009_par30_1-2#1
1\t未\t未\tADV\tv,副詞,否定,有界\tPolarity=Neg\t2\tmod\t_\t_
2\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
3\t與\t與\tADV\tv,動詞,行為,交流\tVerbForm=Conv\t2\tmod\t_\t_
4\t適\t適\tVERB\tv,動詞,行為,移動\t_\t2\tcomp:aux\t_\t_
5\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t4\tcomp:obj\t_\t_
6\t；\t；\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_

`;

/** 大破秦兵鉅鹿下 — 十八史略, verbatim. Not a lexicon entry at all: the span
 * whose サ変 ending `onyomiPairReading` now records with `suruCompound`. */
const ROUTED_THE_QIN = `# sent_id = KR2b0041_008_par2_902-908
1\t大\t大\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t2\tmod\t_\t_
2\t破\t破\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_
3\t秦\t秦\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t4\tmod\t_\t_
4\t兵\t兵\tNOUN\tn,名詞,人,役割\t_\t2\tcomp:obl\t_\t_
5\t鉅鹿\t鉅鹿\tPROPN\tn,名詞,固定物,地名\tCase=Loc|NameType=Geo\t6\tmod\t_\t_
6\t下\t下\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t2\tcomp:obj\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_

`;

/** The same pipeline both panels run, with the **lexicon handed to
 * `findCompoundSpans`** — which is what the two panels do (`generator.ts` is
 * fed a plan built that way in `KakikudashiView.ts`, and `KundokuView.ts`
 * builds its own the same way). The `prose` helper at the top of this file
 * passes no lexicon and so sees no lexical-word span at all; 大破 is one, so it
 * needs this. */
const spannedProse = (s: Sentence): string =>
  generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })), resolve);

describe("the 下二段 words a modern -eru spelling hides", () => {
  it("reads 與之釜 as 與ふ, on the character, and not as the override's bare kana", () => {
    // The reading was never wrong and the ending was frozen: `overrides.json`
    // holds 與 as あた + ふ, and every entry in that table is returned
    // `endingComplete` and `spellOutInProse`, so the prose printed あたふ in
    // every position and the kanji never appeared at all.
    const sentence = parsed(GIVE_HIM_A_KETTLE);
    const give = sentence.tokens.find((t) => t.text === "與")!;
    expect(give.pos).toBe("VERB");
    expect(usesLexiconEntry(give)).toBe(true);
    expect(lexiconEntryFor(give, resolve(give, sentence), sentence)?.conjClass).toBe("shimo-nidan-ha");
    expect(prose(sentence)).toContain("釜を與ふ");
    expect(prose(sentence)).not.toContain("あたふ");
    // …and the same word over the character in the other panel, so the two
    // cannot be reading two different things.
    expect(furiganaFor(give, sentence, resolve, historicalKana, kanjidic)).toBe("あた");
  });

  it("reads 事君數's 事 as the 連体形 事ふる, and leaves the noun こと alone", () => {
    // 1,167 of 事's 1,715 gold tokens are the noun; only the 547 VERB reach the
    // table at all, which is `usesLexiconEntry`'s gate and not a narrowing here.
    const sentence = parsed(SERVING_A_RULER);
    const serve = sentence.tokens.find((t) => t.text === "事")!;
    expect(serve.dep).toBe("subj");
    expect(lexiconEntryFor(serve, resolve(serve, sentence), sentence)?.conjClass).toBe("shimo-nidan-ha");
    // 君**に**事ふる, not 君を: 事 is つかふ, "to serve", and what is served is
    // marked に. See `DATIVE_OBJECT_LEMMAS` in `conjugationContext.ts` for the
    // list this lemma heads and for the count — the particle written before 事
    // in kanbun.info's own 書き下し文 is に 72 times against を 7, and the 7 are
    // the *noun* 事 ("affairs"), which never reaches that rule.
    expect(prose(sentence)).toContain("君に事ふる");
    expect(prose(sentence)).not.toContain("事ひ");
    const asNoun = { ...serve, pos: "NOUN", xpos: "n,名詞,可搬,成果物" };
    expect(usesLexiconEntry(asNoun)).toBe(false);
  });

  it("reads 天下傳之久矣 as 傳ふ and not as the intransitive 傳はる", () => {
    // The derived lead is 四段ラ行 つた+は — 伝わる, "to be handed down" — which
    // printed an intransitive verb with a direct object.
    const sentence = parsed(HANDED_DOWN);
    const hand = sentence.tokens.find((t) => t.text === "傳")!;
    expect(lexiconEntryFor(hand, resolve(hand, sentence), sentence)?.conjClass).toBe("shimo-nidan-ha");
    expect(prose(sentence)).toContain("之を傳ふ");
    expect(prose(sentence)).not.toContain("傳はる");
  });

  it("reads 構木爲巢 as the 連用形 構へ and not the modern 構える", () => {
    const sentence = parsed(NEST_OF_WOOD);
    expect(prose(sentence)).toContain("木を構へ");
    expect(prose(sentence)).not.toContain("構える");
  });

  it("reads 不絕樂 as 絕えず, through the lemma this treebank writes", () => {
    // The form is 絕 and the lemma is 絶: `VERB_LEXICON` is keyed on the lemma,
    // so it is the 絶 entry that has to answer and the 絕 one that has to exist
    // for a text written the other way round. Both are here, and this is the
    // assertion that would fail if only one were.
    const sentence = parsed(MUSIC_UNBROKEN);
    const cut = sentence.tokens.find((t) => t.text === "絕")!;
    expect(cut.lemma).toBe("絶");
    expect(lexiconEntryFor(cut, resolve(cut, sentence), sentence)?.conjClass).toBe("shimo-nidan-ya");
    expect(VERB_LEXICON["絕"]?.conjClass).toBe("shimo-nidan-ya");
    expect(prose(sentence)).toContain("絕えず");
    expect(prose(sentence)).not.toContain("絕やさ");
  });

  it("keeps every derived sense behind the added one rather than in place of it", () => {
    // RESIDUAL is prepended, never substituted — the same guarantee 覺's own
    // test in reading.test.ts makes. 傳's 傳はる and 絶's 絶やす are real words
    // and a reader who picks either still reaches its paradigm.
    expect(LEXICON_SENSES["傳"]?.map((sense) => sense.conjClass)).toEqual([
      "shimo-nidan-ha",
      "yodan-ra",
      "yodan-ha",
    ]);
    expect(LEXICON_SENSES["絶"]?.map((sense) => sense.conjClass)).toEqual(["shimo-nidan-ya", "yodan-sa"]);
  });

  it("gives the furigana menu the same answer the page took, so the two cannot drift", () => {
    // `pairedARowKun` used to write these into the menu off a sibling while the
    // page read something else entirely; now `classicalVerbKun`'s first route
    // answers from the sense and the rule is a no-op for them. Same string,
    // same class, either way.
    for (const [char, reading, okurigana] of [
      ["傳", "つた", "ふ"],
      ["事", "つか", "ふ"],
      ["構", "かま", "ふ"],
      ["添", "そ", "ふ"],
      ["與", "あた", "ふ"],
    ]) {
      const offered = candidateReadings(kanjidic, char, "VERB", historicalKana, jmdict);
      expect(offered).toContainEqual(
        expect.objectContaining({ reading, okurigana, conjClass: "shimo-nidan-ha" }),
      );
      expect(offered.some((c) => c.okurigana?.endsWith("える"))).toBe(false);
    }
    // 絶 is the one whose sibling never existed, so the menu gains its
    // classical form here and nowhere else.
    expect(candidateReadings(kanjidic, "絶", "VERB", historicalKana, jmdict)).toContainEqual(
      expect.objectContaining({ reading: "た", okurigana: "ゆ", conjClass: "shimo-nidan-ya" }),
    );
  });
});

// ---------------------------------------------------------------------------
// The adverbial 與 is 與(とも)に and not the verb.
// ---------------------------------------------------------------------------

describe("an adverbial 與 is the comitative, not the verb 與ふ", () => {
  it("reads 未可與適道's 與 as ともに", () => {
    const sentence = parsed(NOT_YET_TOGETHER);
    const together = sentence.tokens.find((t) => t.text === "與")!;
    // The tag and the morph the entry is keyed against, as the parser spells
    // them — an ADV, and a converb, which is what admits it to the lexicon gate
    // in the first place and so what makes `beatsLexicon` necessary.
    expect(together.pos).toBe("ADV");
    expect(together.morph).toContain("VerbForm=Conv");
    expect(usesLexiconEntry(together)).toBe(true);
    const resolved = resolve(together, sentence);
    // **The word whole, where this used to be とも + に.** The division moved to
    // `KANJI_RETAINED_ADVERBS`, which is where this app divides a retained
    // adverb, so that the prose panel, the 訓読文 and the furigana menu take it
    // from one table; the entry states the word and the table splits it. What
    // is on the page is the same とも over the character and に beside it.
    expect(resolved.reading).toBe("ともに");
    expect(resolved.okurigana).toBeUndefined();
    expect(resolved.beatsLexicon).toBe(true);
    // …and so the lexicon's 與ふ does not reach it. The kanji now survives into
    // the prose besides — 可與言 is 與に言ふべし in received kundoku, and where a
    // curated table speaks for a word this app keeps the character. See
    // `senseReadings.test.ts` for that half and for the prepositional 與 it must
    // not touch.
    expect(prose(sentence)).toContain("與に");
    expect(prose(sentence)).not.toContain("與へ");
  });

  it("leaves the verb 與 exactly where it was", () => {
    // The entry is conditioned on the tag, so the two readings of one character
    // cannot collide: `findOverride` refuses an entry whose named POS this
    // token does not occupy.
    expect(findOverride("與", "ADV", "mod")?.reading).toBe("ともに");
    expect(findOverride("與", "VERB", "comp:obj")?.reading).toBe("あた");
    expect(findOverride("與", "ADP", "mod")?.reading).toBe("と");
  });
});

// ---------------------------------------------------------------------------
// A fused span read on'yomi keeps its サ変 ending.
// ---------------------------------------------------------------------------

describe("an on'yomi pair that is also a span keeps its ending", () => {
  it("reads 大破秦兵鉅鹿下 as 大破す", () => {
    // `findCompoundSpans` takes the lexicon now and so calls 大破 one span;
    // both panels then drop the members' own okurigana and ask
    // `compoundSuruOkurigana` for the group's, which is gated on
    // `suruCompound`. `onyomiPairReading` answers for this pair and had never
    // set that flag, so the ending vanished — 秦の兵に鉅鹿の下を大破.
    const sentence = parsed(ROUTED_THE_QIN);
    const span = findCompoundSpans(sentence, { kanjidic, jmdict }).find((s) => s.text === "大破");
    expect(span?.tokenIds).toEqual([0, 1]);
    const head = sentence.tokens.find((t) => t.text === "破")!;
    const resolved = resolve(head, sentence);
    expect(resolved.reading).toBe("は");
    expect(resolved.conjClass).toBe("sa-hen");
    expect(resolved.suruCompound).toBe(true);
    expect(spannedProse(sentence)).toContain("大破す");
  });

  it("says nothing about a pair that is not a span", () => {
    // The flag is read in exactly two places, `compoundSuruOkurigana` and
    // `compoundSuruRenyouTe`, and both are reached only from the panels'
    // fused-span branches. Built with no lexicon, 大破 is no span, and the
    // ending is then each member's own business exactly as before.
    const sentence = parsed(ROUTED_THE_QIN);
    expect(findCompoundSpans(sentence)).toEqual([]);
    expect(prose(sentence)).toContain("破す");
  });
});

// ---------------------------------------------------------------------------
// A ハ行 verb's 連用形 nominal is spelled with ひ.
// ---------------------------------------------------------------------------

describe("a 連用形 nominal off a ハ行 verb is offered classically", () => {
  const offered = (char: string) =>
    candidateReadings(kanjidic, char, undefined, historicalKana, jmdict).map(
      (c) => c.reading + (c.okurigana ?? ""),
    );

  it("offers 伝's bound -づた.い as づたひ", () => {
    // The reported case. The historical-kana index is keyed by the reading
    // alone, so `historicalKun` corrects づた and never the い beside it; the
    // 行 comes from the つた.う sibling, compared through 連濁 because KANJIDIC2
    // writes a bound form with its voicing already applied.
    expect(kanjidic["伝"].kun).toContain("-づた.い");
    expect(offered("伝")).toContain("づたひ");
    expect(offered("伝")).not.toContain("づたい");
  });

  it("offers the free ones the same way", () => {
    expect(offered("扱")).toContain("あつかひ"); // 扱ふ, off あつか.う
    expect(offered("問")).toContain("とひ"); // 問ふ
    expect(offered("匂")).toContain("にほひ"); // 匂ふ
    expect(offered("憂")).toContain("うれひ"); // 憂ふ — its sibling is うれ.える,
    // which `pairedARowKun` has already turned into うれ.ふ, and running behind
    // that rule is what lets this one see it.
  });

  it("leaves an い whose sibling is not ハ行 exactly as it was", () => {
    // 向い is the イ音便 stem of 向く, not a 連用形 nominal, and む.かう ends in
    // う without being ハ行 — which is why the sibling's *whole* okurigana has
    // to be ふ and not merely end in it.
    expect(offered("向")).toContain("むい");
    expect(offered("向")).toContain("むかい");
    expect(offered("向")).not.toContain("むひ");
    expect(offered("向")).not.toContain("むかひ");
  });

  it("leaves the adjectives alone, including the ones JMdict's own gate misses", () => {
    // 鈍い is filed under おそい and 尊い under とうとい, so `isAdjectiveReading`
    // is silent on にぶい and たっとい and the adjective conversion declines
    // them. None has a ハ行 sibling, so this rule declines them too — which is
    // the whole reason it asks for one.
    expect(offered("鈍")).toContain("にぶい");
    expect(offered("尊")).toContain("たつとい");
    expect(offered("良")).toContain("いい");
    for (const char of ["鈍", "尊", "良"]) {
      expect(offered(char).some((w) => w.endsWith("ひ"))).toBe(false);
    }
  });

  it("leaves 髫's うなゐ alone rather than writing ひ over a ワ行 word", () => {
    // うな.い is うなゐ and its only sibling is うな.る. A rule keyed on the
    // sibling's 行 says nothing here, which is right: the answer is ゑ-row, not
    // ひ, and nothing in the entry states it.
    expect(offered("髫")).toContain("うない");
    expect(offered("髫")).not.toContain("うなひ");
  });
});
