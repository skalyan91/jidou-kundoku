import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ITERATION_MARK, iterationMarkFor } from "../src/render/odoriji.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";

/** The 踊り字 test: which *reading* gets a 〻 hung below its character.
 *
 * The evidence is the shape of the reading and nothing else — see the header
 * of odoriji.ts for the kanjidic counts behind the two-kana minimum, for the
 * gold-treebank counts behind the relation-keyed design that was tried and set
 * aside, and for what this test knowingly over-claims. What the mark *looks
 * like* is not testable here: it is a `<span class="odoriji">` inside
 * `.kanji-glyph` (`cellFor` in KundokuView.ts), placed and coloured by
 * kunten.css. */

describe("iterationMarkFor", () => {
  it("marks a reading whose two halves are the same", () => {
    // The readings that brought the mark back. ますます is 益's, from
    // overrides.json; the rest are kanjidic kun'yomi or override readings on
    // characters this app actually meets.
    for (const reading of [
      "ますます",
      "いよいよ",
      "そもそも",
      "たまたま",
      "しばしば",
      "おのおの",
      "うやうや",
      "ほとほと",
      "つらつら",
      "もろもろ",
      "まにまに",
    ]) {
      expect(iterationMarkFor(reading), reading).toBe(ITERATION_MARK);
    }
  });

  it("marks a reading whose second half is the first with rendaku", () => {
    // ことごと is こと + ごと. A reduplication voices its second member and
    // the reading spells that voicing out, so the halves are not equal as
    // written; unvoicing the one kana that carries it makes them so.
    for (const reading of ["ことごと", "こもごも", "かたがた", "かはるがはる", "ところどころ"]) {
      expect(iterationMarkFor(reading), reading).toBe(ITERATION_MARK);
    }
  });

  it("leaves a two-kana reading alone, whatever it looks like", () => {
    // The load-bearing minimum, and the whole reason the test is not simply
    // "the halves match". Over kanjidic's 16,036 kun'yomi a one-kana half
    // matches 445 times and a two-kana one 41; these are what the 445 are.
    // ここ, もも, しし and ただ are whole readings; おお, すす, くく, ちぢ,
    // とど, ひび, こご are stems whose okurigana this panel writes separately,
    // so they reach the furigana slot exactly as they stand here.
    for (const reading of ["ここ", "もも", "しし", "ささ", "ただ", "おお", "すす", "くく", "ちぢ", "とど", "ひび", "こご"]) {
      expect(iterationMarkFor(reading), reading).toBeUndefined();
    }
  });

  it("leaves a reading of odd length alone", () => {
    // Nothing to halve. ことごとく is the *whole* reading with its okurigana
    // still attached, which is not what reaches the furigana slot — the panel
    // splits it into ことごと + ク — but a stray one must not fall through to
    // some ragged near-match.
    for (const reading of ["ことごとく", "しばしばあ", "あ", "ますま"]) {
      expect(iterationMarkFor(reading), reading).toBeUndefined();
    }
  });

  it("leaves a reading whose halves differ alone", () => {
    for (const reading of ["ますすす", "いよいや", "こともごも", "やうやく", "うつくしい"]) {
      expect(iterationMarkFor(reading), reading).toBeUndefined();
    }
  });

  it("unvoices only the dakuten series, and only the opening kana", () => {
    // ぱ is not a voicing of は for this purpose: no reduplication takes a
    // handakuten on its second member, and admitting the row would let
    // ぱらぱら-shaped readings in through a door nothing needs open.
    expect(iterationMarkFor("はらぱら")).toBeUndefined();
    // And the rendaku is on the *first* mora of the second half. A voicing
    // anywhere else is a different word, not a reduplication.
    expect(iterationMarkFor("かたかだ")).toBeUndefined();
    // The unvoicing runs one way. かた + かた is a reduplication; がた + かた
    // is not the same shape read backwards.
    expect(iterationMarkFor("がたかた")).toBeUndefined();
  });

  it("takes hiragana only", () => {
    // Katakana in this panel is okurigana — a grammar word's gloss or an
    // inflectional ending — and a doubled one is not a doubled word.
    for (const reading of ["マスマス", "ズシズシ", "洋洋", "ますmasu", "ます.ます"]) {
      expect(iterationMarkFor(reading), reading).toBeUndefined();
    }
  });

  it("takes a character with no reading at all", () => {
    // Most cells in this panel: a bare character, or one whose whole reading
    // sits in the okurigana slot instead (不 beside ザル).
    expect(iterationMarkFor(undefined)).toBeUndefined();
    expect(iterationMarkFor("")).toBeUndefined();
  });

  it("uses the vertical iteration mark", () => {
    // U+303B, not 々 (U+3005, its horizontal counterpart) and not the kana
    // marks ゝ/ゞ/〱/〲, which stand in for a kana of a reading — this one
    // does not, the reading being written out in full above it either way.
    expect(ITERATION_MARK).toBe("〻");
  });
});

// ---------------------------------------------------------------------------
// **The mark and a mark of punctuation share one gap**, and the reader has
// ruled how they divide it.
// ---------------------------------------------------------------------------

describe("a 踊り字 with punctuation after it", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const DATA = join(ROOT, "public", "data");
  const load = <T,>(f: string): T => JSON.parse(readFileSync(join(DATA, f), "utf-8")) as T;
  const kunten = readFileSync(join(ROOT, "src", "render", "kunten.css"), "utf-8");

  it("has something to rule about — the 論語 sample sets a 〻 immediately before a 、", () => {
    // 夫子溫、良、恭、儉、讓 (學而 10). 恭 reads うやうや, which is a
    // reduplication and takes the mark, and the very next token is the 、 that
    // divides the list. Asserted so the rule below is known to have a subject:
    // a displacement nothing triggers is a displacement nobody can see.
    const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
    const jmdict = load<JmdictIndex>("jmdict-index.json");
    const resolve = createReadingResolver(kanjidic, jmdict, load<HistoricalKanaIndex>("historical-kana-index.json"));
    const tree = parseConllu(readFileSync(join(DATA, "samples", "rongo-gakuji.conllu"), "utf-8"));
    const pairs: string[] = [];
    for (const sentence of tree.sentences) {
      findCompoundSpans(sentence, { kanjidic, jmdict });
      sentence.tokens.forEach((token, i) => {
        const reading = resolve(token, sentence)?.reading;
        if (!iterationMarkFor(reading)) return;
        const next = sentence.tokens[i + 1];
        if (next?.pos === "PUNCT") pairs.push(`${token.text}${reading}${next.text}`);
      });
    }
    expect(pairs).toContain("恭うやうや、");
    // The budget `sampleTexts.test.ts` explains: this resolves every token of
    // the 論語 sample through the real indexes, which is 1.7s alone and timed
    // out against vitest's default 5s on a loaded runner while passing on its
    // own.
  }, 30_000);

  it("steps the mark down by a third of a cell, and only downwards", () => {
    // The reader's measure, written as the rule rather than as a number of
    // pixels: `--size-main` is the cell and the mark moves a third of it.
    expect(kunten).toContain("--punct-odoriji-above: calc(var(--size-main) / 3);");
    // Folded into the same step the analysis boxes use, and *added* to theirs
    // rather than maxed with it — a 踊り字 hangs below a box's foot, so a
    // character wearing both puts the mark below the sum. See the property's
    // own note in kunten.css.
    expect(kunten).toContain("var(--punct-box-above) + var(--punct-odoriji-above) - var(--punct-box-below)");
    // One direction only. The mark hangs below its character, so a 踊り字 on
    // the character *after* the gap is nowhere near it, and the absence of a
    // `below` counterpart is the claim rather than an omission.
    // Asked of a *declaration* and not of the string: the block above names
    // the absent counterpart in prose, which is the point of it.
    expect(kunten).not.toContain("--punct-odoriji-below:");
    expect(kunten).not.toContain("@property --punct-odoriji-below");
    // Registered, so it animates on the same 160ms clock as the two boxes
    // instead of snapping while they glide.
    expect(kunten).toContain("@property --punct-odoriji-above");
    // **No `:has()` inside a `:has()`, anywhere in the file.** The first
    // version of the rule above wrote `.no-break-unit:has(> .kanji-cell:has(
    // .odoriji))`, which is invalid by spec — and an invalid selector in a
    // comma-separated list discards *the whole rule*, so the two valid
    // selectors beside it went with it and the mark never moved. Nothing in
    // the declaration was wrong, which is why reading it found nothing; it was
    // the rule not existing. Asserted over the whole stylesheet rather than
    // this block, since the trap is the language's and not this rule's.
    const withoutComments = kunten.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of withoutComments.matchAll(/:has\(/g)) {
      let depth = 0;
      for (let i = m.index! + ":has".length; i < withoutComments.length; i++) {
        if (withoutComments[i] === "(") depth++;
        else if (withoutComments[i] === ")" && --depth === 0) {
          expect(withoutComments.slice(m.index! + ":has(".length, i)).not.toContain(":has(");
          break;
        }
      }
    }
    expect(kunten).toContain("--punct-odoriji-above 160ms ease-out");
  });
});
