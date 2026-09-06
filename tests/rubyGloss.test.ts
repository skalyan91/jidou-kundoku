import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { compoundFurigana } from "../src/reading/compoundFurigana.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiPieces } from "../src/kakikudashi/generator.ts";
import { setChosenReading } from "../src/reading/chosenReading.ts";
import { spreadRubyShares } from "../src/render/KakikudashiView.ts";
import {
  createRubyLedger,
  glossWords,
  isSinoJapaneseCompound,
  rubyFor,
  type GlossWord,
  type RubyIndices,
} from "../src/kakikudashi/rubyGloss.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadRealIndex = <T,>(filename: string): T => JSON.parse(readFileSync(join(DATA_DIR, filename), "utf-8")) as T;

const kanjidic = loadRealIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadRealIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadRealIndex<HistoricalKanaIndex>("historical-kana-index.json");
const indices: RubyIndices = { jmdict, kanjidic, historicalKana };
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

/** The readings the 訓読文 panel shows, asked exactly as `KakikudashiView.ts`
 * asks them — a whole span (or fused multi-character token) resolved together,
 * a lone character on its own. Duplicated here rather than exported from the
 * view, which is DOM code; what matters is that both go through the same two
 * functions, and a divergence would show up as a wrong reading in the
 * expectations below. */
function readingsOf(sentence: Sentence, tokens: readonly Token[], text: string): (string | undefined)[] {
  const chars = [...text];
  if (chars.length === 1) return [furiganaFor(tokens[0], sentence, resolve, historicalKana)];
  return compoundFurigana(chars, text, jmdict, kanjidic, historicalKana, (i) => {
    const owner = tokens.length === chars.length ? tokens[i] : tokens[0];
    return furiganaFor({ ...owner, text: chars[i] }, sentence, resolve, historicalKana);
  });
}

/** Every word in a sentence with the ruby it would be given, as
 * `text:reading`. Runs the whole pipeline the panel runs. */
function glossed(sentence: Sentence, ledger = createRubyLedger()): string[] {
  const spans = findCompoundSpans(sentence);
  const pieces = generateKakikudashiPieces(computeReadingOrder(sentence, spans), resolve);
  return glossWords(pieces, sentence, spans, (tokens, text) => readingsOf(sentence, tokens, text), indices)
    .filter((word) => rubyFor(word, indices, ledger) !== null)
    .map((word) => `${word.text}:${word.readings.join("")}`);
}

/** All the words, glossed or not — the denominator the density claims are
 * made against. */
function words(sentence: Sentence): GlossWord[] {
  const spans = findCompoundSpans(sentence);
  const pieces = generateKakikudashiPieces(computeReadingOrder(sentence, spans), resolve);
  return glossWords(pieces, sentence, spans, (tokens, text) => readingsOf(sentence, tokens, text), indices);
}

const tok = (id: number, text: string, pos: string, dep: string, head: number, over: Partial<Token> = {}): Token => ({
  id,
  text,
  lemma: text,
  pos,
  xpos: "x",
  dep,
  head,
  ...over,
});

// ---------------------------------------------------------------------------
// Case 1: a proper noun's first mention
// ---------------------------------------------------------------------------

describe("case 1 — a proper noun is glossed on its first mention", () => {
  // 黃帝者、少典之子也。 — the parse this project opens on. 黃帝 arrives as two
  // tokens fused by `findCompoundSpans`, which is why the gloss has to be
  // asked about the span and not about 黃 and 帝 one at a time (per-token it
  // reads きみかど).
  const huangdi: Sentence = {
    tokens: [
      tok(0, "黃", "PROPN", "compound", 1),
      tok(1, "帝", "NOUN", "mod", 6),
      tok(2, "者", "PART", "subj", 6),
      tok(3, "、", "PUNCT", "punct", 6),
      tok(4, "少典", "PROPN", "comp:obj", 6),
      tok(5, "之", "SCONJ", "mod", 4),
      tok(6, "子", "NOUN", "ROOT", 6),
      tok(7, "也", "PART", "discourse:sp", 6),
      tok(8, "。", "PUNCT", "punct", 6),
    ],
  };

  it("glosses 黃帝 with the whole compound's reading, not each character's own", () => {
    expect(glossed(huangdi)).toContain("黃帝:くわうてい");
  });

  it("glosses a fused multi-character name too", () => {
    expect(glossed(huangdi)).toContain("少典:せうてん");
  });

  it("leaves the ordinary nouns of the same sentence alone", () => {
    // 子 is a NOUN read こ, and 者 is written out in kana as は — neither is a
    // name, an uncommon compound, or a moved reading.
    expect(glossed(huangdi).join(" ")).not.toMatch(/子|者/);
  });

  it("glosses a name once, however often the text names it", () => {
    const ledger = createRubyLedger();
    expect(glossed(huangdi, ledger)).toContain("黃帝:くわうてい");
    expect(glossed(huangdi, ledger)).toEqual([]);
  });

  it("keeps the ledger per text, not per app — a fresh one glosses again", () => {
    expect(glossed(huangdi)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 2: an uncommon 漢語
// ---------------------------------------------------------------------------

describe("case 2 — an uncommon Sino-Japanese compound", () => {
  // 子入太廟。 — 太廟 (the Grand Temple) is absent from JMdict entirely.
  const taimiao: Sentence = {
    tokens: [
      tok(0, "子", "NOUN", "subj", 1),
      tok(1, "入", "VERB", "ROOT", 1),
      tok(2, "太", "VERB", "mod", 3, { morph: "Degree=Pos" }),
      tok(3, "廟", "NOUN", "comp:obj", 1),
      tok(4, "。", "PUNCT", "punct", 1),
    ],
  };

  it("glosses 太廟, which JMdict does not list at all", () => {
    expect(glossed(taimiao)).toEqual(["太廟:たいべう"]);
  });

  it("leaves 君子 alone — a compound JMdict marks common", () => {
    const junzi: Sentence = {
      tokens: [
        tok(0, "亦", "ADV", "mod", 1),
        tok(1, "君", "NOUN", "ROOT", 1),
        tok(2, "子", "NOUN", "flat", 1),
        tok(3, "。", "PUNCT", "punct", 1),
      ],
    };
    expect(glossed(junzi)).toEqual([]);
  });

  it("recognises 漢語 by every character being read on'yomi", () => {
    const word: GlossWord = { pieceIndexes: [], tokens: [], text: "太廟", readings: ["たい", "べう"] };
    expect(isSinoJapaneseCompound(word, indices)).toBe(true);
  });

  it("does not call a kun'yomi pair 漢語, however uncommon the pair is", () => {
    // 大喜 is in JMdict as おおよろこび and is exactly the case
    // `readingResolver.ts`'s own on'yomi test is built to refuse: read
    // おほいによろこぶ, two words rather than one.
    const word: GlossWord = { pieceIndexes: [], tokens: [], text: "大喜", readings: ["おほ", "よろこ"] };
    expect(isSinoJapaneseCompound(word, indices)).toBe(false);
  });

  it("never calls a single character a compound", () => {
    const word: GlossWord = { pieceIndexes: [], tokens: [], text: "帝", readings: ["てい"] };
    expect(isSinoJapaneseCompound(word, indices)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The on'yomi pair, which is what makes case 2's commonness test meaningful
// ---------------------------------------------------------------------------

describe("an on'yomi pair is one word, so the dictionary is asked about the pair", () => {
  const pair = (modifier: string, modifierPos: string, head: string, headPos: string): Sentence => ({
    tokens: [
      tok(0, modifier, modifierPos, "mod", 1),
      tok(1, head, headPos, "ROOT", 1),
      tok(2, "。", "PUNCT", "punct", 1),
    ],
  });

  it("fuses 三人 and then leaves it alone, JMdict marking さんにん common", () => {
    const sentence = pair("三", "NUM", "人", "NOUN");
    expect(words(sentence).map((w) => w.text)).toContain("三人");
    expect(glossed(sentence)).toEqual([]);
  });

  it("fuses 獨酌 and glosses it — 独酌 is listed, and not marked common", () => {
    // The 旧字体/新字体 step is what makes this work at all: 獨酌 is absent from
    // JMdict and 独酌 is in it. Without the normalisation the word would still
    // be glossed, but for the wrong reason (absent rather than uncommon), and
    // 大破/大亂 would be glossed with it.
    expect(glossed(pair("獨", "ADV", "酌", "VERB"))).toEqual(["獨酌:どくしやく"]);
  });

  it("fuses 大破 and leaves it alone — the same shape, but a common word", () => {
    const sentence = pair("大", "ADV", "破", "VERB");
    expect(words(sentence).map((w) => w.text)).toContain("大破");
    expect(glossed(sentence)).toEqual([]);
  });

  it("does not fuse two on'yomi neighbours that are not a modifier and its head", () => {
    // 姓公孫 — 姓 is read せい, an on'yomi, directly before a name, and the two
    // are siblings. Fusing them would put the dictionary question to 姓公孫.
    const sentence: Sentence = {
      tokens: [
        tok(0, "姓", "NOUN", "subj", 2),
        tok(1, "公孫", "PROPN", "subj", 2),
        tok(2, "曰", "VERB", "ROOT", 2),
        tok(3, "。", "PUNCT", "punct", 2),
      ],
    };
    expect(words(sentence).map((w) => w.text)).toContain("公孫");
    expect(words(sentence).map((w) => w.text)).not.toContain("姓公孫");
  });
});

// ---------------------------------------------------------------------------
// Case 3: an uncommon reading
// ---------------------------------------------------------------------------

describe("case 3 — a reading the reader corrected by hand", () => {
  it("glosses a token carrying a hand-picked reading", () => {
    const token = tok(0, "中", "NOUN", "ROOT", 0);
    setChosenReading(token, "ちゆう");
    expect(glossed({ tokens: [token, tok(1, "。", "PUNCT", "punct", 0)] })).toEqual(["中:ちゆう"]);
  });

  it("does not gloss a transitivity-chosen reading, which moves only the okurigana", () => {
    // 立 with an object is 下二段 立てる rather than 四段 立つ — a reading the
    // syntax chose (`beatsLexicon`), and the flag that was the obvious signal
    // for this case. The ruby half of the reading is た either way, so a gloss
    // here would say nothing: the difference is in the okurigana, which the
    // prose already prints beside the character.
    const sentence: Sentence = {
      tokens: [
        tok(0, "立", "VERB", "ROOT", 0),
        tok(1, "廟", "NOUN", "comp:obj", 0),
        tok(2, "。", "PUNCT", "punct", 0),
      ],
    };
    expect(glossed(sentence)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Density: what the rule leaves alone is the point of it
// ---------------------------------------------------------------------------

describe("density — ordinary vocabulary keeps no ruby at all", () => {
  it("glosses nothing in the Analects' opening line", () => {
    // 學而時習之，不亦說乎？ — every word here is one a reader of bungo has.
    const sentence: Sentence = {
      tokens: [
        tok(0, "學", "VERB", "ROOT", 0),
        tok(1, "而", "CCONJ", "cc", 3),
        tok(2, "時", "NOUN", "mod@tmod", 3),
        tok(3, "習", "VERB", "conj:coord", 0),
        tok(4, "之", "PRON", "comp:obj", 3),
        tok(5, "。", "PUNCT", "punct", 0),
      ],
    };
    expect(glossed(sentence)).toEqual([]);
    expect(words(sentence).length).toBeGreaterThan(0);
  });

  it("says nothing where the dictionaries have not loaded", () => {
    const sentence: Sentence = { tokens: [tok(0, "軒轅", "PROPN", "ROOT", 0)] };
    const spans = findCompoundSpans(sentence);
    const pieces = generateKakikudashiPieces(computeReadingOrder(sentence, spans), resolve);
    const bare: RubyIndices = { jmdict: null, kanjidic: null, historicalKana: null };
    const found = glossWords(pieces, sentence, spans, (tokens, text) => readingsOf(sentence, tokens, text), bare);
    expect(found.every((word) => rubyFor(word, bare, createRubyLedger()) === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The grouping itself
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// モノルビ — every share centred on its own character, and what that costs
// where two annotated characters stand side by side
// ---------------------------------------------------------------------------

describe("spreadRubyShares", () => {
  // The panel's live geometry, measured: a 22px character stepping 24.85px
  // down the column (its size plus the fitted tracking), annotated at 11px a
  // kana. The placement itself is the stylesheet's (`top: 50%` against a
  // one-character `<ruby>`), so what is tested here is only the displacement
  // away from that centre.
  const ADVANCE = 24.85;
  const KANA = 11;
  const round = (out: number[]) => out.map((d) => +d.toFixed(2));
  /** Whether every neighbouring pair of shares clears the one beside it:
   * two runs at full spacing meet exactly when the distance between their
   * centres is the two half-lengths that face each other. */
  const clear = (counts: number[], out: number[]) =>
    counts.every((n, i) => {
      if (i === 0) return true;
      const apart = ADVANCE + out[i] - out[i - 1];
      return apart >= ((counts[i - 1] + n) * KANA) / 2 - 0.001;
    });
  /** Whether each share, wherever it has been moved to, is still over the
   * character it is the reading of — its own centre inside that character,
   * and its ink still across the character's centre. Not *covering* the whole
   * character, which a share as narrow as its character stops doing the
   * moment it moves at all, and which a one-kana share never did. */
  const over = (counts: number[], out: number[]) =>
    counts.every((n, i) => Math.abs(out[i]) <= Math.min(11, (n * KANA) / 2) + 0.001);

  it("moves nothing where every share fits its own character", () => {
    // 少典 — せう + てん, two kana apiece, each exactly filling its character.
    expect(spreadRubyShares([2, 2], ADVANCE, KANA)).toEqual([0, 0]);
  });

  it("moves nothing where a short share stands beside a long one", () => {
    // 一壺 — いち fills 一 completely and こ is one kana with room to spare, so
    // neither is anywhere near the other.
    expect(spreadRubyShares([2, 1], ADVANCE, KANA)).toEqual([0, 0]);
  });

  it("lets a lone share overhang its character as far as it likes", () => {
    // 驚's きやう is 33px of kana over a 22px character and hangs 5.5px into
    // the lane either side of it, where there is nothing but plain prose.
    expect(spreadRubyShares([3], ADVANCE, KANA)).toEqual([0]);
    expect(spreadRubyShares([1, 3], ADVANCE, KANA)).toEqual([0, 0]);
  });

  it("moves two crowded shares apart by the overlap, half to each", () => {
    // 長山 — ちやう (33px) beside さん (22px) against a 24.85px step. The two
    // have to stand 27.5px apart and stand 24.85 apart, so 2.65px of overlap;
    // the forward pass pushes さん down by all of it and the re-centring
    // splits it, which is what leaves both ends travelling.
    const out = spreadRubyShares([3, 2], ADVANCE, KANA);
    expect(round(out)).toEqual([-1.32, 1.32]);
    expect(clear([3, 2], out)).toBe(true);
    expect(over([3, 2], out)).toBe(true);
  });

  it("moves the same pair the same way whichever side the long share is on", () => {
    // 獨酌 — the long share second rather than first.
    expect(round(spreadRubyShares([2, 3], ADVANCE, KANA))).toEqual([-1.32, 1.32]);
  });

  it("spreads a chain of crowded shares and keeps the run on its own centre", () => {
    // 良醞一器 in the shipped text: らう・うん・いち・き, a three-kana share
    // and then a two, a two and a one. Only the first pair overlaps, and the
    // mean of what it pushes comes back off all four — which is why the three
    // that were never crowded each give up 0.66px.
    const out = spreadRubyShares([3, 2, 2, 1], ADVANCE, KANA);
    expect(round(out)).toEqual([-0.66, 1.99, -0.66, -0.66]);
    expect(Math.abs(out.reduce((sum, d) => sum + d, 0))).toBeLessThan(1e-9);
    expect(clear([3, 2, 2, 1], out)).toBe(true);
    expect(over([3, 2, 2, 1], out)).toBe(true);
  });

  it("never leaves two shares overlapping, whatever the run holds", () => {
    for (const counts of [[3, 2], [2, 3], [1, 4], [3, 3], [4, 4], [2, 3, 2], [3, 1, 3], [4, 2, 4], [3, 3, 3, 3]]) {
      const out = spreadRubyShares(counts, ADVANCE, KANA);
      expect(clear(counts, out)).toBe(true);
      // And the run is always left on its own centre of gravity, which is the
      // only thing the constraints leave free.
      expect(Math.abs(out.reduce((sum, d) => sum + d, 0))).toBeLessThan(1e-9);
    }
  });

  it("leaves every share over its own character on the shapes the text has", () => {
    // A three-kana share among ones and twos is the whole of what 酒蟲 asks
    // for, and there the displacement stays a fraction of a character. Four
    // three-kana shares in a row would not — twelve kana over four characters
    // is 132px of reading in 99px of column, and the ends of that run have to
    // stand off their characters — but nothing in the corpus comes near it,
    // and the answer if one ever did is a smaller ruby, not a tighter one.
    for (const counts of [[3, 2], [2, 3], [1, 3], [2, 3, 2], [3, 2, 2, 1], [3, 1, 3]]) {
      const out = spreadRubyShares(counts, ADVANCE, KANA);
      expect(over(counts, out)).toBe(true);
      expect(Math.max(...out.map(Math.abs))).toBeLessThan(KANA / 2);
    }
  });

  it("keeps every kana at its natural spacing, whatever it has to solve", () => {
    // The whole point of the exercise, and the thing the condensation it
    // replaced could not promise: the function returns *positions*, so there
    // is no width anywhere in what it can say. A five-kana share beside a
    // three-kana one — the case the old bound had no answer for at all —
    // comes back as two displacements like any other.
    const out = spreadRubyShares([5, 3], ADVANCE, KANA);
    expect(clear([5, 3], out)).toBe(true);
    expect(over([5, 3], out)).toBe(true);
  });

  it("has nothing to say about a lone share or a lone character", () => {
    expect(spreadRubyShares([1], ADVANCE, KANA)).toEqual([0]);
    expect(spreadRubyShares([1, 1], ADVANCE, KANA)).toEqual([0, 0]);
    expect(spreadRubyShares([], ADVANCE, KANA)).toEqual([]);
  });
});

describe("glossWords", () => {
  it("carries only the kanji into the word, not the okurigana beside it", () => {
    // 學 is written 學び; the ruby is of 學, and び is already kana on the page.
    const sentence: Sentence = { tokens: [tok(0, "學", "VERB", "ROOT", 0), tok(1, "。", "PUNCT", "punct", 0)] };
    expect(words(sentence).map((w) => w.text)).toEqual(["學"]);
  });

  it("skips a word the panel writes out in kana", () => {
    // 也 is なり in the prose, so there is no character under the reading.
    // **A particle and not a pronoun**, which is the line the table itself now
    // draws: the object 之 beside it used to serve for this case and no longer
    // can — the received text keeps its character and so does this app, so 之れ
    // has a character under its reading like any other word
    // (`OverrideEntry.spellOutInProse`).
    const sentence: Sentence = {
      tokens: [tok(0, "習", "VERB", "ROOT", 0), tok(1, "也", "PART", "discourse@sp", 0), tok(2, "。", "PUNCT", "punct", 0)],
    };
    expect(words(sentence).map((w) => w.text)).toEqual(["習"]);
  });
});
