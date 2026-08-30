import type { Sentence, Token } from "../parse/types.ts";
import type { CompoundSpan } from "../reading/jmdictLookup.ts";
import type { Piece } from "./generator.ts";
import { shinjitaiSpelling, type JmdictIndex } from "../reading/jmdictLookup.ts";
import { onyomiOf, type KanjidicIndex } from "../reading/kanjidicLookup.ts";
import { historical } from "../reading/compoundFurigana.ts";
import { modifierHeadPair } from "../reading/readingResolver.ts";
import type { HistoricalKanaIndex } from "../reading/historicalKana.ts";
import { hasChosenReading } from "../reading/chosenReading.ts";

/** The three indices the rules below consult, in the nullable shape the render
 * layer already passes around (they are fetched asynchronously, and a first
 * render can happen before they land). Nothing is glossed while any of them is
 * missing: a gloss is a claim that a word is uncommon, and with no dictionary
 * there is no evidence for such a claim. */
export interface RubyIndices {
  jmdict: JmdictIndex | null;
  kanjidic: KanjidicIndex | null;
  historicalKana: HistoricalKanaIndex | null;
}

/** A run of pieces that is one *word* for gloss purposes, with the reading the
 * panel would show over it.
 *
 * `text` is the kanji on the page and nothing else — a piece's own text can
 * carry conjugated okurigana after it (學び, 樂しから), which is already in
 * kana and must not end up under the ruby. `reading` is supplied by the caller
 * rather than resolved here, and deliberately: it has to be the reading the
 * 訓読文 panel prints over the same characters, or the two panels would gloss
 * one word two ways. */
export interface GlossWord {
  /** Indexes into the piece list this was built from. */
  pieceIndexes: number[];
  tokens: Token[];
  text: string;
  /** One entry per character of `text`, in 歴史的仮名遣い. */
  readings: (string | undefined)[];
}

/** Why a word was glossed. Returned rather than a bare boolean so the reason
 * can be asserted in tests and read off the DOM while tuning density. */
export type GlossReason = "propn" | "kango" | "reading";

/** Words already glossed, keyed by spelling *and* reading. Only the first
 * occurrence in the whole text takes ruby, and the panel renders a whole
 * `TokenTree`, so the ledger has to outlive any one sentence.
 *
 * Keyed by the pair, not by the spelling alone, because case 3 is about a
 * reading rather than about a word: 藍 read らん and 藍 read あゐ are two
 * different things to have to be told, and a text using both should be able to
 * say so twice. */
export type RubyLedger = Set<string>;

export function createRubyLedger(): RubyLedger {
  return new Set();
}

/** Whether every character of a piece's token is Han — the test for "this
 * piece kept its kanji", which is the only kind of piece there is anything to
 * put ruby over. A piece written out in kana (a particle, a negation, a
 * 再読文字's first reading) is already legible and has no base text at all. */
const ALL_HAN = /^\p{Script=Han}+$/u;

/** Whether this reading of this character is one of its on'yomi.
 *
 * KANJIDIC's on'yomi are modern, and the reading on the page is in
 * 歴史的仮名遣い, so the *list* is converted rather than the reading: running
 * the page's reading backwards to a modern spelling is not something the index
 * supports (it is keyed modern-to-historical and is many-to-one), while
 * converting each candidate forwards through the very same `historical` the
 * renderer used is exact by construction. */
function isOnyomi(char: string, reading: string | undefined, indices: RubyIndices): boolean {
  const { kanjidic, historicalKana } = indices;
  if (!kanjidic || reading === undefined) return false;
  return onyomiOf(kanjidic, char).some((on) => historical(char, on, historicalKana) === reading);
}

/** Whether these two adjacent units are one written word, though
 * `findCompoundSpans` does not fuse them.
 *
 * The case is the Sino-Japanese pair `readingResolver.ts` reads on'yomi
 * throughout — 大破 タイハ, 三人 サンニン, 獨酌 ドクシャク, 一壺 イッコ. Those
 * arrive as two ordinary adjacent tokens, and asked about one at a time the
 * dictionary is asked about 大 and about 破, neither of which is the word: the
 * gloss would then be gated on the commonness of a character rather than of
 * the compound. 大破 is a common Japanese word and 獨酌 is not, and only the
 * pair can say so.
 *
 * The syntactic half of the test is `modifierHeadPair`'s, imported rather than
 * restated: which adjacent pair is read as one Sino-Japanese word is a
 * question the resolver already answers, and a second answer here would drift
 * from it. (It is what keeps 姓公孫 apart — 姓 is read せい, an on'yomi,
 * directly before a name, and a `subj` is not a `mod`.) The reading half is
 * that both are read on'yomi, which is what "read as one Sino-Japanese word"
 * means, and which the pair rule having *declined* the pair is exactly what
 * fails: 則利 attaches 則 as a `mod` of 利 and is read すなはち, two words. */
function readsAsOnePair(a: GlossWord, b: GlossWord, sentence: Sentence, indices: RubyIndices): boolean {
  if (a.tokens.length !== 1 || b.tokens.length !== 1) return false;
  const pair = modifierHeadPair(a.tokens[0], sentence);
  if (!pair || pair.modifier.id !== a.tokens[0].id || pair.head.id !== b.tokens[0].id) return false;
  return [a, b].every((word) => [...word.text].every((ch, i) => isOnyomi(ch, word.readings[i], indices)));
}

/** The words in one sentence's rendered pieces, in the order they are written.
 *
 * Grouping is by word rather than by token, from two sources: the compound
 * spans the panel already computed for reading order (黃帝 is two tokens and
 * one name), and the on'yomi pairs `readsAsOnePair` recognises.
 *
 * `readingsOf` is handed in rather than resolved here so that the readings are
 * literally the ones the 訓読文 panel draws — see `GlossWord.readings`. It is
 * asked about a whole span at once (`tokens`, and their `text` joined),
 * because that is the unit the other panel resolves a span's furigana over:
 * per-token readings of 黃 and 帝 are きみかど, and 黃帝's own is くわうてい.
 * On'yomi pairs are *not* asked that way — the other panel resolves those a
 * token at a time too — which is why the pair pass runs second, over readings
 * already computed. */
export function glossWords(
  pieces: readonly Piece[],
  sentence: Sentence,
  spans: readonly CompoundSpan[],
  readingsOf: (tokens: readonly Token[], text: string) => (string | undefined)[],
  indices: RubyIndices,
): GlossWord[] {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const spanOf = new Map<number, CompoundSpan>();
  for (const span of spans) for (const id of span.tokenIds) spanOf.set(id, span);

  // Pass 1: spans and lone tokens, with a gap left wherever a piece is not a
  // kanji-retained word — two words with something written between them are
  // never one word, whatever the tree says.
  const units: { word: GlossWord; span: CompoundSpan | null; contiguous: boolean }[] = [];
  let openSpan: CompoundSpan | null = null;
  pieces.forEach((piece, index) => {
    const token = piece.kind === "token" ? byId.get(piece.tokenId) : undefined;
    // Kanji-retained only, and tested on the piece as well as on the token:
    // the generator writes several kinds of piece from a kanji token without
    // keeping the kanji (a modal auxiliary drops 可 entirely and writes べし),
    // and those are told apart by the piece's text no longer opening with the
    // character it came from.
    if (!token || !ALL_HAN.test(token.text) || !piece.text.startsWith(token.text)) {
      openSpan = null;
      return;
    }
    const span = spanOf.get(token.id) ?? null;
    const previous = units[units.length - 1];
    const follows = previous !== undefined && previous.word.pieceIndexes[previous.word.pieceIndexes.length - 1] === index - 1;
    if (follows && span !== null && span === openSpan) {
      previous.word.tokens.push(token);
      previous.word.pieceIndexes.push(index);
      previous.word.text += token.text;
    } else {
      units.push({
        word: { pieceIndexes: [index], tokens: [token], text: token.text, readings: [] },
        span,
        contiguous: follows,
      });
    }
    openSpan = span;
  });
  for (const unit of units) unit.word.readings = readingsOf(unit.word.tokens, unit.word.text);

  // Pass 2: the on'yomi pairs, which need those readings to be recognised.
  const words: GlossWord[] = [];
  for (const unit of units) {
    const previous = words[words.length - 1];
    if (previous && unit.contiguous && unit.span === null && readsAsOnePair(previous, unit.word, sentence, indices)) {
      previous.pieceIndexes.push(...unit.word.pieceIndexes);
      previous.tokens.push(...unit.word.tokens);
      previous.text += unit.word.text;
      previous.readings.push(...unit.word.readings);
      continue;
    }
    words.push(unit.word);
  }
  return words;
}

function jmdictEntry(jmdict: JmdictIndex, text: string) {
  // Kanbun is written in 旧字体 and JMdict is keyed on 新字体, so the modern
  // spelling has to be tried too, or the flag below reports "absent from the
  // dictionary" — i.e. rare — for perfectly ordinary words: 獨酌/大亂/獨立 are
  // all missing under the spelling on the page and present as 独酌/大乱/独立.
  // The same two-step `lookupModernisedLemma` makes, done over the entry
  // rather than over the reading because what is wanted here is the `common`
  // flag, which that helper does not carry back.
  return jmdict[text] ?? jmdict[shinjitaiSpelling(text)];
}

/** Whether JMdict marks this word common — 26,130 of its 228,774 headwords
 * (11.4%), which is the corpus-frequency signal this whole rule rests on.
 *
 * A word JMdict does not list at all is *not* common, which is the answer
 * wanted here: 太廟, 少典, 黃帝, 獨酌 and 軒轅 are absent outright, and being
 * absent from a 228k-headword dictionary of Japanese is the strongest
 * available statement that a Japanese reader will not know the word. */
function isCommonWord(jmdict: JmdictIndex, text: string): boolean {
  return jmdictEntry(jmdict, text)?.common === true;
}

/** Whether a multi-character word is being read on'yomi throughout, which is
 * what makes it 漢語 (a Sino-Japanese compound) rather than two kun'yomi words
 * standing side by side.
 *
 * The same test `readingResolver.ts`'s `onyomiCompound` applies to a
 * modifier+head pair, and for the same reason: a reading that is each
 * character's attested on'yomi is a jukugo, and one that is not is two words
 * (大喜 reads おほいによろこぶ, not a compound at all). Single characters are
 * excluded outright — one character read on'yomi is not a compound, and
 * whether *its* reading wants glossing is case 3's question, not this one's. */
export function isSinoJapaneseCompound(word: GlossWord, indices: RubyIndices): boolean {
  const chars = [...word.text];
  if (chars.length < 2) return false;
  return chars.every((ch, i) => isOnyomi(ch, word.readings[i], indices));
}

/** Why this word deserves ruby in the 書き下し文, or null for the ordinary
 * vocabulary that is the great majority of any text.
 *
 * Real kakikudashibun carries no furigana at all, and the point of adding any
 * is that a reader meeting an unfamiliar name or word should not have to look
 * across to the other panel for it. That only works while the gloss stays rare
 * enough to mean something, so each of the three cases is gated on evidence:
 *
 *  1. `propn` — a proper noun. Names are the one class of word whose reading
 *     is unguessable in principle rather than merely unfamiliar: 軒轅 is
 *     けんゑん because that is the man's name, and no amount of Chinese or of
 *     Japanese tells a reader so. Taken straight off the parser's POS tag.
 *
 *  2. `kango` — an uncommon Sino-Japanese compound. Both halves are load
 *     bearing. 漢語-ness is what makes the reading non-obvious: a kun'yomi
 *     pair is each character read as the reader already knows it, while a
 *     jukugo picks one on'yomi out of several. Uncommonness is JMdict's
 *     `common` flag, which keeps the gloss off 君子 (くんし), 天下 (てんか),
 *     大破 (たいは), 三人 (さんにん), 明月, 千里 and 多少 — words a Japanese
 *     reader has — and puts it on 太廟, 啼鳥, 兵刃 and 獨酌, which the
 *     dictionary either does not list or does not mark common.
 *
 *  3. `reading` — a word read some way other than its own default. A word can
 *     be perfectly common while the reading this text gives it is not.
 *
 *     What this case is *not* driven by is the finding, and it was settled by
 *     enumeration over twelve classical passages (142 single kanji-retained
 *     words). `ResolvedReading.beatsLexicon` was the obvious candidate and is
 *     the wrong one: it fires 23 times, and in 18 of those the reading over
 *     the character has not moved at all — the transitive/intransitive split
 *     changes only the okurigana (立つ against 立てる), which is already in
 *     kana on the page beside the character. Glossing those glosses ならふ, くる
 *     and とる.
 *
 *     The five where `beatsLexicon` did move the reading — 一, 壺, 獨, 三, 人 —
 *     are every one of them half of an on'yomi pair, which is to say a
 *     *compound*, which is case 2's question and not this one's. That is why
 *     `glossWords` fuses those pairs: asked as a compound, 三人 is common
 *     (さんにん) and takes no gloss while 獨酌 is not and takes one, where
 *     asked one character at a time both would have been flagged.
 *
 *     Comparing the reading against KANJIDIC's own first choice was tried too
 *     and is worse. The reading on the page reaches it through the verb
 *     lexicon, `ziReading` and the rendaku rule as well as through KANJIDIC,
 *     so that comparison measures which internal path produced the reading
 *     rather than whether the reading is unusual: it put ruby on 子 in 子曰, on
 *     曰 itself, and on 學 — 24 glosses in 143 words. Its one hit not already
 *     covered here was 酒 read ざけ, which is 連濁 inside 一壺酒 and would tell
 *     a reader something false about 酒.
 *
 *     What is left is the one signal that means what it says: a reading the
 *     reader picked by hand from the furigana menu. That is a correction of
 *     every rule above it, so it is by construction not the default reading,
 *     and it costs nothing at all on a text nobody has edited. */
export function glossReason(word: GlossWord, indices: RubyIndices): GlossReason | null {
  const { jmdict, kanjidic } = indices;
  if (!jmdict || !kanjidic || word.readings.some((r) => !r)) return null;

  if (word.tokens.some((t) => t.pos === "PROPN")) return "propn";
  if (isSinoJapaneseCompound(word, indices)) return isCommonWord(jmdict, word.text) ? null : "kango";
  if (word.tokens.some(hasChosenReading)) return "reading";
  return null;
}

/** The reason to draw ruby over this word, or null — `glossReason` plus the
 * first-occurrence rule, in the one call the render layer makes.
 *
 * Consumes the ledger: calling this is what records the word as glossed, so it
 * must be called exactly once per word, in reading order, across the whole
 * tree. */
export function rubyFor(word: GlossWord, indices: RubyIndices, ledger: RubyLedger): GlossReason | null {
  const reason = glossReason(word, indices);
  if (!reason) return null;
  const key = `${word.text}|${word.readings.join("")}`;
  if (ledger.has(key)) return null;
  ledger.add(key);
  return reason;
}
