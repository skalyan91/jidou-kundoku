import { describe, expect, it } from "vitest";
import { ITERATION_MARK, iterationMarkFor } from "../src/render/odoriji.ts";

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
