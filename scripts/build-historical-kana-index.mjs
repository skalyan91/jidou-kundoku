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
// only single-character keys can ever match — and of the 16181 keys the
// entry-level pass produced, only 859 were single characters, giving 1042
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
// — an ambiguous alignment is not evidence. Measured: 1705 corrections over
// 1383 characters, against the entry-level pass's 1042 over 859.
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

/** This entry's own modern reading, as plain hiragana: `word` itself when
 * the entry *is* a kana headword, the reading half of a `canonical` form's
 * `ruby` pairing when the entry is a kanji headword annotated that way
 * (氷's own canonical form carries `ruby: [["氷","こおり"]]` — the reading
 * lives there, not as a separate top-level hiragana form), or otherwise
 * whichever of its own `forms` is hiragana but *not* itself historical (a
 * kanji-headword entry's own reading annotation given as a plain form
 * instead of via ruby). Returns null when no such reading can be found —
 * the entry is then skipped rather than guessing which reading its
 * correction applies to. */
function modernReadingOf(entry) {
  if (HIRAGANA_RE.test(entry.word)) return entry.word;
  for (const f of entry.forms ?? []) {
    if (!f.tags?.includes("canonical")) continue;
    for (const [, reading] of f.ruby ?? []) {
      if (HIRAGANA_RE.test(reading ?? "")) return reading;
    }
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
    if (!modern || modern === historical) continue;

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
  // of compounds. Collected separately and merged only at the end, so a
  // character's own attestation always beats one inferred from a word that
  // happens to contain it.
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
    if (hf.length === 0) continue;
    for (const [kanji, modern, hist] of alignedPairsOf(entry, hf[0].form)) {
      if (!isSpellingOf(hist, modern)) {
        overlong++;
        continue;
      }
      const seen = (aligned[kanji] ??= {})[modern];
      if (seen !== undefined && seen !== hist) {
        alignedConflicts.add(kanji + "\u0000" + modern);
        continue;
      }
      aligned[kanji][modern] = hist;
    }
  }
  for (const pairKey of alignedConflicts) {
    const [kanji, modern] = pairKey.split("\u0000");
    if (aligned[kanji]) delete aligned[kanji][modern];
  }
  let alignedAdded = 0;
  for (const [kanji, readings] of Object.entries(aligned)) {
    for (const [modern, hist] of Object.entries(readings)) {
      if (index[kanji]?.[modern] !== undefined) continue;
      (index[kanji] ??= {})[modern] = hist;
      alignedAdded++;
    }
  }
  console.log(`Aligned ${alignedAdded} further pairs out of compounds (${alignedConflicts.size} conflicting, dropped).`);

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
