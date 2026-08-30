#!/usr/bin/env node
// Downloads kaikki.org's Wiktionary (English-Wiktionary-sourced) Japanese
// extract and builds a compact JSON index of
// { kanjiSpelling: { modernReading: historicalKana } } at
// public/data/historical-kana-index.json — a general, data-driven
// replacement for hand-fixing 歴史的仮名遣い one word at a time. Dev-time
// only; not shipped as source, and the raw ~330MB dump is never committed —
// only this compact derived index is.
//
// Keyed by *kanji spelling*, not by the resulting modern kana reading: two
// unrelated words can share one modern kun'yomi (e.g. あい could be 藍
// "indigo" or an entirely different word) while having different — or no —
// attested historical spellings, so readingResolver.ts must look this up by
// the actual character it just resolved (`token.text`), not by whatever
// reading kanjidic happened to produce for it.
//
// Nested one level further by *modern reading*, not just kanji: a single
// kanji can itself have multiple readings with independently-attested
// historical spellings (氷's kun'yomi こおり historically こほり, but its
// on'yomi ひょう historically ひよう — two unrelated corrections on the same
// character) — collapsing those to one flat kanji->historical mapping would
// force picking one arbitrarily (or, worse, flagging them as a spurious
// "conflict" and dropping the correction for that kanji entirely, which is
// exactly what happened during development here for 氷 itself).
//
// Deliberately does *not* use an entry's `redirects` list as a source of
// kanji keys, even though that recovers a few more (e.g. 氷/凍り redirecting
// to a こおり kana entry) — verified during development that `redirects`
// is a much looser association than "this kanji spells this word": 藍
// picked up あひ this way from an entirely unrelated あい ("mutual,
// together") entry that happens to redirect from the same kana, when 藍's
// own direct entry (independently) attests あゐ instead. Every kanji key
// here comes from an entry's *own* word/forms only.
//
// A second extraction runs alongside that one, and it is what makes this
// index useful for on'yomi at all. A kanbun token is a single character, so
// only single-character keys can ever match — and of the 2008 keys the
// entry-level pass produces, only 827 are single characters, giving 989
// usable pairs. English Wiktionary annotates `hist=` on very few
// single-kanji on'yomi entries: 生's own affix entry for しょう carries none,
// and 習, 少 and 成 have no reading entry at all, so their historical
// spellings are unattested at the character level.
//
// They are attested at the *word* level, and the alignment below recovers
// them. A compound entry carries both a per-character `ruby` pairing and a
// whole-word historical form — 少年 gives ruby [[少,しょう],[年,ねん]] with
// hist せうねん — so splitting that string across the characters yields
// 少 しょう->せう. The split is checked rather than guessed:
// `historicalToModern` is the ordinary forward reading of 歴史的仮名遣い, and
// a piece is accepted only where normalising it reproduces that character's
// own modern reading. A word admitting more than one valid split is dropped
// — an ambiguous alignment is not evidence. Measured: 1537 corrections over
// 1260 characters, against the entry-level pass's 989 over 827.
//
// A third pass does for kun'yomi what that one does for on'yomi, and needed
// its own machinery to get there: a native word is written with okurigana, so
// the historical form has to be divided between the kanji's reading and the
// ending before either half means anything on its own. 2062 corrections over
// 1546 characters — see the block above `historicalCandidatesOf`.
//
// kaikki.org repackages Wiktextract's structured extraction of English
// Wiktionary; Wiktionary content (and this derived index) is CC BY-SA —
// see public/data/LICENSE-Wiktionary.txt.
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL = "https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl.gz";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "historical-kana-index.json");
// Optional: --local <path-to-.jsonl.gz> to use an already-downloaded copy
// (e.g. fetched via curl) instead of Node's own fetch, which has been
// unreliable against this host in some environments.
const localPathArgIndex = process.argv.indexOf("--local");
const LOCAL_PATH = localPathArgIndex !== -1 ? process.argv[localPathArgIndex + 1] : null;

const HIRAGANA_RE = /^[ぁ-ゟー]+$/;
const HAS_KANJI_RE = /[一-鿿㐀-䶿]/;
const KANJI_RUN_RE = /^[一-鿿㐀-䶿々]+$/;

/** This entry's own modern reading, as plain hiragana: `word` itself when
 * the entry *is* a kana headword, the reading half of a `canonical` form's
 * `ruby` pairing when the entry is a kanji headword annotated that way
 * (氷's own canonical form carries `ruby: [["氷","こおり"]]` — the reading
 * lives there, not as a separate top-level hiragana form), or otherwise
 * whichever of its own `forms` is hiragana but *not* itself historical (a
 * kanji-headword entry's own reading annotation given as a plain form
 * instead of via ruby). Returns null when no such reading can be found —
 * the entry is then skipped rather than guessing which reading its
 * correction applies to.
 *
 * The ruby branch reads a whole *word's* reading, so it only applies where
 * the ruby covers the whole word: a `ruby` pairing annotates the kanji, and
 * for a headword written with okurigana (幸い, 柔らか, 僅か) the reading it
 * carries is the *stem* alone while the entry's historical form is still the
 * whole word. Pairing those two put a word where a reading belongs, under a
 * key a single character reaches — 幸 さいわ -> さいはひ and 僅 わず -> わづか
 * were both in the shipped index, and 幸's kun'yomi really is さいわ.い, so
 * that one was one parse away from printing さいはひ over the character with
 * its own okurigana い after it. The alignment pass below is what recovers
 * those entries correctly, having divided the historical form across the
 * stem and the okurigana first. */
function modernReadingOf(entry) {
  if (HIRAGANA_RE.test(entry.word)) return entry.word;
  for (const f of entry.forms ?? []) {
    if (!f.tags?.includes("canonical")) continue;
    if ((f.ruby ?? []).length !== 1 || f.ruby[0][0] !== entry.word) continue;
    const reading = f.ruby[0][1];
    if (HIRAGANA_RE.test(reading ?? "")) return reading;
  }
  for (const f of entry.forms ?? []) {
    const tags = f.tags ?? [];
    if (!tags.includes("historical")) {
      const form = (f.form ?? "").replace(/\^/g, "").trim();
      if (HIRAGANA_RE.test(form)) return form;
    }
  }
  return null;
}

/** Whether a reading can be a *key* here at all — which means being written
 * in modern kana, since a modern reading is what every lookup arrives with.
 * ゐ and ゑ are not, and a handful of Wiktionary entries pair their two
 * spellings the other way round: 夷, 戎 and 恵比須 all ruby their headword
 * ゑびす and give えびす as the "historical" annotation, which indexed
 * verbatim produces a key nothing can ever match. */
function isModernReading(reading) {
  return !/[ゐゑ]/.test(reading);
}

/** Every kanji spelling this entry's *own* data associates with its modern
 * reading: the headword itself (when written in kanji) and any
 * non-historical `forms` entry tagged "kanji" (a current alternative
 * spelling of the *same* entry/sense — e.g. 氷's own entry lists 凍り as an
 * alternative). Deliberately does not use `redirects` (see this file's own
 * top-of-file doc for why) or forms *also* tagged "historical" (those are
 * old kanji substitutions — こおり's own 評 for the "district" sense — a
 * different orthographic axis than the kana reading correction extracted
 * here). */
function kanjiKeysOf(entry) {
  const keys = new Set();
  if (HAS_KANJI_RE.test(entry.word)) keys.add(entry.word);
  for (const f of entry.forms ?? []) {
    const tags = f.tags ?? [];
    if (tags.includes("kanji") && !tags.includes("historical") && HAS_KANJI_RE.test(f.form ?? "")) {
      keys.add(f.form);
    }
  }
  return keys;
}

/** 歴史的仮名遣い -> modern kana: the ordinary forward reading of the older
 * spelling. Used only to CHECK a candidate alignment, never to produce a
 * historical form. The forward direction is regular; the backward one is
 * not — けう, きやう and きよう all give きょう — which is the whole reason
 * this index has to exist at all.
 *
 * Validated against every pair the entry-level pass attests. */
const I_ROW = "きしちにひみりぎじぢびぴ";
const E_ROW = { え: "よ", け: "きょ", せ: "しょ", て: "ちょ", ね: "にょ", へ: "ひょ", め: "みょ", れ: "りょ", げ: "ぎょ", ぜ: "じょ", で: "じょ", べ: "びょ", ぺ: "ぴょ" };
const A_ROW = { あ: "お", か: "こ", さ: "そ", た: "と", な: "の", は: "ほ", ま: "も", や: "よ", ら: "ろ", わ: "お", が: "ご", ざ: "ぞ", だ: "ど", ば: "ぼ", ぱ: "ぽ" };
const I_LONG = { い: "ゆ", き: "きゅ", し: "しゅ", ち: "ちゅ", に: "にゅ", ひ: "ひゅ", み: "みゅ", り: "りゅ", ぎ: "ぎゅ", じ: "じゅ", ぢ: "じゅ", び: "びゅ", ぴ: "ぴゅ" };

export function historicalToModern(s) {
  let t = s;
  // ハ行 away from the head of the word became ワ行.
  t = t.replace(/(?<=.)[はひふへほ]/g, (c) => ({ は: "わ", ひ: "い", ふ: "う", へ: "え", ほ: "お" })[c]);
  t = t.replace(/ゐ/g, "い").replace(/ゑ/g, "え").replace(/(?<=.)を/g, "お");
  t = t.replace(/ぢ/g, "じ").replace(/づ/g, "ず");
  t = t.replace(/くわ/g, "か").replace(/ぐわ/g, "が").replace(/くゎ/g, "か").replace(/ぐゎ/g, "が");
  // 拗音 was written full-size; modern kana writes it small.
  t = t.replace(new RegExp(`([${I_ROW}])([やゆよ])`, "g"), (_, c, y) => c + ({ や: "ゃ", ゆ: "ゅ", よ: "ょ" })[y]);
  // The long-vowel fusions, longest context first.
  t = t.replace(/([ゃゅょ])う/g, (_, y) => ({ ゃ: "ょ", ゅ: "ゅ", ょ: "ょ" })[y] + "う");
  t = t.replace(new RegExp(`([${Object.keys(E_ROW).join("")}])う`, "g"), (_, c) => E_ROW[c] + "う");
  t = t.replace(new RegExp(`([${Object.keys(A_ROW).join("")}])う`, "g"), (_, c) => A_ROW[c] + "う");
  t = t.replace(new RegExp(`([${Object.keys(I_LONG).join("")}])う`, "g"), (_, c) => I_LONG[c] + "う");
  return t;
}

// A compound's modern reading can be assimilated where its historical one is
// not: 学校 is ruby'd がっ+こう against hist がくかう, the く becoming っ before
// the following k. Allowed in that direction only, and only for the kana
// that actually do it.
const SOKUON_SOURCES = ["く", "つ", "ち", "き", "ふ"];
function pieceMatches(historicalPiece, modernPart) {
  const m = historicalToModern(historicalPiece);
  if (m === modernPart) return true;
  if (!modernPart.endsWith("っ")) return false;
  const stem = modernPart.slice(0, -1);
  return SOKUON_SOURCES.some((s) => m === stem + s);
}

/** Splits `historical` across `parts` so that each piece normalises to its
 * part. Returns the split only when it is unique: a word admitting two valid
 * alignments says nothing about which character contributed what. */
function alignHistorical(parts, historical) {
  const found = [];
  const walk = (i, pos, acc) => {
    if (found.length > 1) return;
    if (i === parts.length) {
      if (pos === historical.length) found.push([...acc]);
      return;
    }
    for (let end = pos + 1; end <= historical.length - (parts.length - i - 1); end++) {
      const piece = historical.slice(pos, end);
      if (!pieceMatches(piece, parts[i])) continue;
      acc.push(piece);
      walk(i + 1, end, acc);
      acc.pop();
    }
  };
  walk(0, 0, []);
  return found.length === 1 ? found[0] : null;
}

/** The per-character corrections a compound entry attests, through its own
 * ruby pairing and its historical form. */
function alignedPairsOf(entry, historical) {
  const ruby = (entry.forms ?? []).find((f) => (f.tags ?? []).includes("canonical"))?.ruby;
  if (!ruby || ruby.length < 2) return [];
  const chars = ruby.map((r) => r[0] ?? "");
  const parts = ruby.map((r) => r[1] ?? "");
  if (!parts.every((p) => HIRAGANA_RE.test(p))) return [];
  const split = alignHistorical(parts, historical);
  if (!split) return [];
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    if ([...chars[i]].length !== 1 || !HAS_KANJI_RE.test(chars[i])) continue;
    if (split[i] === parts[i]) continue;
    out.push([chars[i], parts[i], split[i]]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The kun'yomi pass. Everything above this line indexes a *word's* reading —
// which is all an on'yomi ever is, a single character read as one syllable
// block — and it is exactly why the two passes above leave kun'yomi almost
// untouched: a kanbun token is one character, and a native word written with
// one kanji is written with okurigana after it. 思う is an entry whose
// reading is おもう and whose historical form is おもふ, while the reading
// KANJIDIC2 gives 思 is おも — the stem alone, with the う held separately as
// okurigana. Nothing that keys the whole word can ever answer for that stem.
//
// Measured before this pass existed: of the 14,635 distinct kun'yomi stems
// KANJIDIC2 gives the characters in this index, 360 had an attested
// historical spelling. The two passes above are not failing at kun'yomi so
// much as not addressing them. With this one, 481 — and four of the original
// 360 were wrong, being the whole-word values `modernReadingOf` used to pair
// with a stem.
//
// What this pass adds is the division. A canonical form's `ruby` pairs each
// kanji run with its own reading and leaves the okurigana as literal kana, so
// the headword decomposes into an ordered sequence of pieces whose modern
// spellings are all known — 終わり is [終 = お][わり], 尊ぶ is [尊 = たっと][ぶ]
// — and the historical form is then split across that sequence exactly as
// `alignedPairsOf` splits a compound's across its characters. 終わり's をはり
// divides as を|はり, which attests 終 お -> を; 尊ぶ's たつとぶ divides as
// たつと|ぶ, which attests 尊 たっと -> たつと. A split that is not unique is
// dropped, as everywhere else here: an ambiguous alignment is not evidence.
//
// Two things had to be sharpened for that to work on words rather than on
// jukugo.
//
// First, where the historical spelling *is*. `forms` carries it for 13,947
// entries, and the head templates carry it — in `hhira`, or `hist`, or
// `hist1`..`hist4` for an entry with several readings — for 17,722, which is
// not the same set: 尊ぶ's only record of たっと -> たつと is `hist2` on its
// `ja-verb` template, with nothing in `forms` at all. Both are read, and the
// union is offered to the alignment as candidates.
//
// Second, which historical spelling goes with which reading. An entry with
// two readings has two canonical forms and two historical spellings, and the
// numbering that pairs them differs by template (`ja-pos` puts the part of
// speech in argument 1 and the reading in argument 2). Rather than learn
// each template's convention, the pairing is *derived*: a canonical form
// takes a historical candidate only when exactly one of them divides across
// its pieces. 尊ぶ's とうと reading admits たふとぶ and not たつとぶ, and its
// たっと reading admits たつとぶ and not たふとぶ, so both readings pair
// themselves. This is the same "unique or nothing" rule the alignment already
// runs on, applied one level up.
// ---------------------------------------------------------------------------

/** Wiktionary's own historical annotations, from both of the places its data
 * puts one — a `forms` entry tagged hiragana+historical, and the `hhira` /
 * `hist` / `hist1`..`hist4` arguments of a head template. The okurigana dot
 * some of them carry (`ja-adj` gives 大きい the historical おほき.い) is a
 * typesetting mark showing where the okurigana begins, not part of the
 * spelling, and is dropped along with the `^` wiktextract uses for its own
 * annotations. `hkata` is skipped: it is the katakana spelling of the same
 * fact, and this index is written in hiragana throughout. */
function historicalCandidatesOf(entry) {
  const candidates = new Set();
  const plain = (s) => (s ?? "").replace(/[.^\s]/g, "");
  for (const f of entry.forms ?? []) {
    if (f.tags?.includes("hiragana") && f.tags?.includes("historical")) candidates.add(plain(f.form));
  }
  for (const template of entry.head_templates ?? []) {
    for (const [key, value] of Object.entries(template.args ?? {})) {
      if (/^(hhira|hist[1-4]?)$/.test(key)) candidates.add(plain(value));
    }
  }
  return [...candidates].filter((h) => HIRAGANA_RE.test(h));
}

/** A headword divided into the pieces a historical spelling has to be split
 * across: one piece per kanji run the `ruby` annotates (carrying that run's
 * own modern reading) and one per stretch of literal kana between or after
 * them (carrying itself — okurigana is written the same in both
 * orthographies at this level, and it is the alignment that decides how the
 * historical form spells it).
 *
 * Returns null where the ruby does not line up with the word — a run it
 * names is not found in the headword, a "reading" is not hiragana, or the
 * literal stretch between two runs is not kana. All three mean the pairing
 * cannot be trusted to say which part of the word each reading belongs to,
 * which is the only thing this function exists to establish. */
function segmentsOf(word, ruby) {
  const segments = [];
  let pos = 0;
  for (const pair of ruby) {
    const run = pair?.[0] ?? "";
    const reading = pair?.[1] ?? "";
    if (!KANJI_RUN_RE.test(run) || !HIRAGANA_RE.test(reading)) return null;
    const at = word.indexOf(run, pos);
    if (at === -1) return null;
    if (at > pos) segments.push({ kanji: null, text: word.slice(pos, at) });
    segments.push({ kanji: run, text: reading });
    pos = at + run.length;
  }
  if (pos < word.length) segments.push({ kanji: null, text: word.slice(pos) });
  return segments.every((s) => HIRAGANA_RE.test(s.text)) ? segments : null;
}

/** `historicalToModern` for one piece of a word, which needs to know whether
 * the piece stands at the head of that word.
 *
 * Two of the mergers are position-sensitive and that function, written for
 * whole words, applies its lookbehind to the string it is given — so a piece
 * taken out of the middle of a word arrives looking word-initial and keeps a
 * は that the word around it turned into わ. 賑わい's はひ is the case: read on
 * its own it comes back はい, and the alignment then refuses a division that
 * is correct. A sentinel kana in front restores the context. ん is the one to
 * use: it appears in no rule in that function, on either side, so it can
 * neither be consumed nor combine with what follows it.
 *
 * At the head the ハ行 keeps its own value (母 はは, 花 はな) and that
 * lookbehind is doing its job. ゐ/ゑ/を do not: word-initial を is modern お
 * throughout (をとこ -> おとこ, をんな -> おんな), and it is only the
 * *particle* を that stays, which no reading ever is. That function
 * deliberately leaves it — see `isSpellingOf`, which relies on the leniency —
 * so the head case is finished off here instead of by changing it under the
 * pass that wants it as it is. */
function pieceToModern(historical, wordInitial) {
  if (!wordInitial) return historicalToModern("ん" + historical).slice(1);
  const forward = historicalToModern(historical);
  return forward.startsWith("を") ? "お" + forward.slice(1) : forward;
}

/** Whether `historical` is a spelling of `modern`, read forwards.
 *
 * The 促音 allowance is the one thing beyond the regular mergers. 歴史的仮名遣い
 * writes it with a full-size kana — the one the word historically had, つ or
 * く or ち or き or ふ — where modern kana writes っ, so a historical piece
 * may show any of those five wherever the modern one shows っ. Built as a
 * character class over the forward reading rather than tested at the end of
 * the piece only, because in a word the assimilation is word-*internal*:
 * 尊ぶ's たつと is たっと, and 以て's もつて is もって. The five kana are
 * `SOKUON_SOURCES` above, shared with `pieceMatches`: the same fact about the
 * language, read at the end of a compound's member there and anywhere within
 * a word here. */
function readsAs(historical, modern, wordInitial) {
  const forward = pieceToModern(historical, wordInitial);
  if (forward === modern) return true;
  if (!SOKUON_SOURCES.some((s) => forward.includes(s))) return false;
  const pattern = [...forward].map((c) => (SOKUON_SOURCES.includes(c) ? `[${c}っ]` : c)).join("");
  return new RegExp(`^${pattern}$`).test(modern);
}

/** Splits `historical` across `parts` so that each piece reads as its part,
 * and only when that split is unique — the same rule, and for the same
 * reason, as `alignHistorical` below. */
function alignAcrossSegments(parts, historical) {
  const found = [];
  const walk = (i, pos, acc) => {
    if (found.length > 1) return;
    if (i === parts.length) {
      if (pos === historical.length) found.push([...acc]);
      return;
    }
    for (let end = pos + 1; end <= historical.length - (parts.length - i - 1); end++) {
      const piece = historical.slice(pos, end);
      if (!readsAs(piece, parts[i], i === 0)) continue;
      acc.push(piece);
      walk(i + 1, end, acc);
      acc.pop();
    }
  };
  walk(0, 0, []);
  return found.length === 1 ? found[0] : null;
}

/** The per-character corrections this entry attests, one canonical form (one
 * reading) at a time. Only single-character kanji runs are reported: a run
 * of two or more is a spelling whose reading the ruby gives as one block,
 * with nothing saying which character contributed which mora, and a kanbun
 * token is a single character in any case. */
function kunPairsOf(entry) {
  const candidates = historicalCandidatesOf(entry);
  if (candidates.length === 0 || !HAS_KANJI_RE.test(entry.word)) return [];

  const pairs = [];
  for (const form of entry.forms ?? []) {
    if (!(form.tags ?? []).includes("canonical") || !(form.ruby ?? []).length) continue;
    const segments = segmentsOf(entry.word, form.ruby);
    if (!segments) continue;
    const parts = segments.map((s) => s.text);
    const splits = candidates.map((h) => alignAcrossSegments(parts, h)).filter((s) => s !== null);
    if (splits.length !== 1) continue;
    for (let i = 0; i < segments.length; i++) {
      const { kanji, text } = segments[i];
      if (!kanji || [...kanji].length !== 1 || splits[0][i] === text) continue;
      if (!isModernReading(text)) continue;
      pairs.push([kanji, text, splits[0][i]]);
    }
  }
  return pairs;
}

/** Whether `historical` can be a spelling of `modern` at all, by length.
 *
 * A historical spelling replaces a modern one mora for mora. It may be
 * *shorter* — きゅう is きう, and 937 entries legitimately lose a mora that
 * way — and it may gain at most one, which is what くわ for か and ぐわ for が
 * do (539 entries). Anything longer is not a spelling of that reading: it is
 * a whole word, picked up where an entry's `forms` offered a truncated
 * modern reading beside a full historical one. 住 す -> すまひ, 候 そう ->
 * さうろう, 月 が -> ぐわち. Twenty-six of those were in the index, and any
 * one of them would print a word where a reading belongs.
 *
 * Both sides are folded to full-size kana before measuring, because the
 * historical convention writes 拗音 full-size and the raw lengths would
 * otherwise penalise exactly the correction this index exists to make:
 * きょう -> きやう is one mora becoming one mora, and three characters
 * becoming three, only once ょ and や are counted alike.
 *
 * Length rather than reading the spelling forward through
 * `historicalToModern`, which would be the stronger test and is wrong here:
 * it rejects 311 legitimate pairs, because を at the head of an isolated
 * reading is modern お (惡 お -> を, 女 おんな -> をんな, 夫 おっと -> をつと)
 * while を at the head of a *word* stays を, and that function is calibrated
 * for the whole words the alignment feeds it. */
const SMALL_KANA = { "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お", "っ": "つ" };
const foldSmall = (s) => [...s].map((c) => SMALL_KANA[c] ?? c).join("");
function isSpellingOf(historical, modern) {
  return foldSmall(historical).length - foldSmall(modern).length <= 1;
}

async function main() {
  let gz;
  if (LOCAL_PATH) {
    console.log(`Reading local ${LOCAL_PATH} ...`);
    gz = readFileSync(LOCAL_PATH);
  } else {
    console.log(`Fetching ${SOURCE_URL} ...`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    gz = Buffer.from(await res.arrayBuffer());
  }
  const jsonl = gunzipSync(gz).toString("utf-8");
  console.log(`Decompressed: ${(jsonl.length / 1e6).toFixed(1)} MB`);

  const index = {}; // kanji -> { modernReading -> historicalReading }
  const conflicting = new Set(); // "kanji modernReading" pairs
  const aligned = {}; // same shape, from the compound-alignment pass below
  const alignedConflicts = new Set();
  const kun = {}; // same shape again, from the kun'yomi pass below
  const kunConflicts = new Set();
  let scanned = 0;
  let pairCount = 0;
  let overlong = 0;

  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.lang_code !== "ja") continue;
    scanned++;

    // A form tagged both "hiragana" and "historical" is Wiktionary's own
    // 歴史的仮名遣い annotation (see readingResolver.ts's doc for a worked
    // example: こおり's ja-noun head template carries hist="こほり", surfaced
    // here as this same fact in `forms`).
    const historicalForms = (entry.forms ?? []).filter((f) => f.tags?.includes("hiragana") && f.tags?.includes("historical"));
    if (historicalForms.length === 0) continue;
    const historical = historicalForms[0].form;

    const modern = modernReadingOf(entry);
    if (!modern || modern === historical || !isModernReading(modern)) continue;

    const keys = kanjiKeysOf(entry);
    if (keys.size === 0) continue;

    if (!isSpellingOf(historical, modern)) {
      overlong++;
      continue;
    }

    for (const kanji of keys) {
      const pairKey = `${kanji} ${modern}`;
      const existing = index[kanji]?.[modern];
      if (existing !== undefined && existing !== historical) {
        conflicting.add(pairKey);
        continue;
      }
      (index[kanji] ??= {})[modern] = historical;
    }
  }

  // Second pass over the same entries: per-character corrections aligned out
  // of compounds, and — from `kunPairsOf` — out of words written with
  // okurigana. Both are collected separately and merged only at the end, so a
  // character's own attestation always beats one inferred from a word that
  // happens to contain it, and the compound alignment (measured against this
  // corpus already) beats the newer kun'yomi one.
  const collect = (into, conflicts, pairs) => {
    for (const [kanji, modern, hist] of pairs) {
      if (!isSpellingOf(hist, modern)) {
        overlong++;
        continue;
      }
      const seen = (into[kanji] ??= {})[modern];
      if (seen !== undefined && seen !== hist) {
        conflicts.add(kanji + " " + modern);
        continue;
      }
      into[kanji][modern] = hist;
    }
  };
  const merge = (source, conflicts) => {
    for (const pairKey of conflicts) {
      const [kanji, modern] = pairKey.split(" ");
      if (source[kanji]) delete source[kanji][modern];
    }
    let added = 0;
    for (const [kanji, readings] of Object.entries(source)) {
      for (const [modern, hist] of Object.entries(readings)) {
        if (index[kanji]?.[modern] !== undefined) continue;
        (index[kanji] ??= {})[modern] = hist;
        added++;
      }
    }
    return added;
  };
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.lang_code !== "ja") continue;
    const hf = (entry.forms ?? []).filter((f) => f.tags?.includes("hiragana") && f.tags?.includes("historical"));
    if (hf.length > 0) collect(aligned, alignedConflicts, alignedPairsOf(entry, hf[0].form));
    collect(kun, kunConflicts, kunPairsOf(entry));
  }
  const alignedAdded = merge(aligned, alignedConflicts);
  console.log(`Aligned ${alignedAdded} further pairs out of compounds (${alignedConflicts.size} conflicting, dropped).`);
  const kunAdded = merge(kun, kunConflicts);
  console.log(`Aligned ${kunAdded} further pairs out of words written with okurigana (${kunConflicts.size} conflicting, dropped).`);

  for (const pairKey of conflicting) {
    const [kanji, modern] = pairKey.split(" ");
    delete index[kanji][modern];
    if (Object.keys(index[kanji]).length === 0) delete index[kanji];
  }

  for (const readings of Object.values(index)) pairCount += Object.keys(readings).length;

  console.log(`Scanned ${scanned} Japanese entries.`);
  console.log(`Rejected ${overlong} values too long to be a spelling of the reading they were keyed to.`);
  console.log(`Indexed ${Object.keys(index).length} kanji (${pairCount} kanji+reading->historical-kana pairs, ${conflicting.size} conflicting pairs dropped).`);

  const json = JSON.stringify(index);
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1e3).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
