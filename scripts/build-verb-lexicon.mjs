#!/usr/bin/env node
// Downloads kaikki.org's Wiktionary (English-Wiktionary-sourced) Japanese
// extract and builds public/data/verb-lexicon-index.json — a general,
// data-driven replacement for hand-curating each kanbun content word's
// classical conjugation class one at a time in kakikudashi/verbLexicon.ts.
//
// The key insight: Wiktionary's {{ja-conj-bungo}} template (attached to
// most Japanese verb entries) already spells out the six classical base
// forms (未然形/連用形/終止形/連体形/已然形/命令形, tagged irrealis/
// continuative/terminative/attributive/realis/imperative) in the *correct
// historical kana* (は行 not わ行 for 四段ハ行 verbs, etc. — see
// `classicalConjugation.ts`'s own PARADIGMS, which this script's `SUFFIX_OF`
// table mirrors exactly). Subtracting the entry's own invariant kanji
// prefix from each of those six surface forms recovers exactly the
// per-word conjugation data `verbLexicon.ts` used to hand-verify: which
// `ConjClass` it is, and — for the handful of words whose okurigana
// boundary sits earlier than the paradigm's own suffix (説ばし, 曲がる,
// 来たる) — the fixed `okuriganaPrefix` between the kanji and that suffix.
//
// Adjectives have no such classical table in kaikki's data (only a modern
// -i/-katta inflection table) — ク/シク活用 is instead derived from a
// general rule with no per-word lookup at all: a modern -i adjective whose
// ending is -shii is classically シク活用, everything else plain -i is ク活用
// (see `kuOrShiku`) — this is the standard classical-grammar diagnostic,
// not a guess.
//
// A word's furigana `reading` *is* extracted here too — not left to
// `kanjidicLookup.ts`'s generic kun'yomi lookup — because kanjidic only
// knows the character, not which of its several kun'yomi belongs to *this*
// sense: 中's kun'yomi list is ["なか","うち","あた.る"], and a bare
// character-keyed lookup has no way to know a verb use of 中 wants the
// third one, not the first. This script's own matched conjugation block
// already picked out the one classical paradigm for the specific verb/
// adjective sense being conjugated, so the reading is read off the *same*
// block (its hiragana forms, minus the matched suffix) rather than
// re-derived — it's already sense-disambiguated data, not a guess.
// `KundokuView.ts` still runs this reading through the general
// historical-kana correction at render time (`historicalKana.ts`, keyed by
// kanji + this reading) rather than baking that in here, so a Wiktionary
// dump refresh keeps benefiting from that index without this script
// needing to duplicate it.
//
// 學/學-style kyūjitai spellings are resolved to their shinjitai entry via
// kaikki's own `pos: "character"` entries (`forms: [{form, tags:
// ["shinjitai"]}]`) — not a hand-authored variant-character list — so both
// spellings end up with the same derived entry.
//
// Dev-time only; the raw ~330MB dump is never committed, only this compact
// derived index is. Wiktionary content (and this derived index) is CC
// BY-SA — see public/data/LICENSE-Wiktionary.txt.
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL = "https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl.gz";
// Bundled as an ordinary source-tree JSON import (like reading/overrides.json)
// rather than fetched at runtime from public/data/ like kanjidic/jmdict/
// historical-kana-index.json — at ~20KB it's small enough that
// verbLexicon.ts can just `import` it directly and stay a synchronous
// module, matching every one of its call sites' existing (synchronous)
// signature instead of threading a fourth async-loaded index through
// generator.ts/KundokuView.ts alongside `resolve`.
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "kakikudashi", "verb-lexicon-index.json");
// Optional: --local <path-to-.jsonl.gz-or-.jsonl> to use an already-downloaded
// copy (e.g. fetched via curl) instead of Node's own fetch, which has been
// unreliable against this host in some environments.
const localPathArgIndex = process.argv.indexOf("--local");
const LOCAL_PATH = localPathArgIndex !== -1 ? process.argv[localPathArgIndex + 1] : null;

const KANJI_RE = /[一-鿿㐀-䶿]/;
const HIRAGANA_ONLY_RE = /^[ぁ-ゟー]+$/;

// Mirrors classicalConjugation.ts's PARADIGMS exactly (mizen, renyou,
// shuushi, rentai, izen, meirei) — the six-suffix "shape" that identifies a
// ConjClass. ク/シク adjectives aren't matched this way at all (see
// `kuOrShiku`), so they're not listed here.
const SUFFIX_OF = {
  "yodan-ka": ["か", "き", "く", "く", "け", "け"],
  "yodan-ga": ["が", "ぎ", "ぐ", "ぐ", "げ", "げ"],
  "yodan-sa": ["さ", "し", "す", "す", "せ", "せ"],
  "yodan-ta": ["た", "ち", "つ", "つ", "て", "て"],
  "yodan-na": ["な", "に", "ぬ", "ぬ", "ね", "ね"],
  "yodan-ba": ["ば", "び", "ぶ", "ぶ", "べ", "べ"],
  "yodan-ma": ["ま", "み", "む", "む", "め", "め"],
  "yodan-ra": ["ら", "り", "る", "る", "れ", "れ"],
  "yodan-ha": ["は", "ひ", "ふ", "ふ", "へ", "へ"],
  "kami-nidan-ka": ["き", "き", "く", "くる", "くれ", "きよ"],
  "kami-nidan-ma": ["み", "み", "む", "むる", "むれ", "みよ"],
  "shimo-nidan-a": ["", "", "", "る", "れ", "よ"],
  "kami-ichidan": ["", "", "る", "る", "れ", "よ"],
  "ka-hen": ["こ", "き", "く", "くる", "くれ", "こよ"],
  "sa-hen": ["せ", "し", "す", "する", "すれ", "せよ"],
  "na-hen": ["な", "に", "ぬ", "ぬる", "ぬれ", "ね"],
  "ra-hen": ["ら", "り", "り", "る", "れ", "れ"],
};

const SLOT_TAG = ["irrealis", "continuative", "terminative", "attributive", "realis", "imperative"];

/** Splits an entry's `forms` array into separate {{ja-conj-bungo}} tables —
 * kaikki concatenates every conjugation template the page invokes (a word
 * with distinct transitive/intransitive classical paradigms, e.g. 学ぶ, gets
 * two) into one flat list, each announced by its own "inflection-template"
 * marker naming which template produced it. Only "ja-conj-bungo" blocks are
 * classical; a "ja-conj-*" (or absent) marker means a modern-only table,
 * which is skipped. */
function bungoBlocks(entry) {
  const blocks = [];
  let current = null;
  for (const f of entry.forms ?? []) {
    if (f.source !== "conjugation") continue;
    const tags = f.tags ?? [];
    if (tags.includes("inflection-template")) {
      current = f.form === "ja-conj-bungo" ? [] : null;
      if (current) blocks.push(current);
      continue;
    }
    if (tags.includes("table-tags") || !current || !tags.includes("stem")) continue;
    const slot = SLOT_TAG.findIndex((t) => tags.includes(t));
    if (slot === -1) continue;
    (current[slot] ??= []).push(f.form);
  }
  return blocks;
}

/** From one bungo block, the entry's own invariant kanji-covered stem plus
 * a per-`ConjClass` match, by finding the (possibly empty) common leading
 * substring that, once stripped from all six kanji-form suffixes, exactly
 * matches some class's own suffix table — that stripped leftover is
 * `okuriganaPrefix` (empty for the overwhelming majority of words, whose
 * okurigana boundary sits exactly at the paradigm's own suffix). Returns
 * null if the block doesn't have all six slots, or doesn't match any known
 * class at any stripping depth. */
function matchBlock(block) {
  if (![0, 1, 2, 3, 4, 5].every((i) => block[i]?.length)) return null;
  const kanjiForms = block.map((opts) => opts.find((f) => KANJI_RE.test(f)));
  if (kanjiForms.some((f) => f === undefined)) return null;
  const hiraganaForms = block.map((opts) => opts.find((f) => HIRAGANA_ONLY_RE.test(f)));
  if (hiraganaForms.some((f) => f === undefined)) return null;

  let prefixLen = 0;
  const first = kanjiForms[0];
  while (prefixLen < Math.min(...kanjiForms.map((f) => f.length)) && KANJI_RE.test(first[prefixLen])) {
    if (!kanjiForms.every((f) => f[prefixLen] === first[prefixLen])) break;
    prefixLen++;
  }
  if (prefixLen === 0) return null;
  const kanjiPrefix = first.slice(0, prefixLen);
  const rawSuffixes = kanjiForms.map((f) => f.slice(prefixLen));

  const maxStrip = Math.min(...rawSuffixes.map((s) => s.length));
  for (let strip = 0; strip <= maxStrip; strip++) {
    const stripped = rawSuffixes[0].slice(0, strip);
    if (!rawSuffixes.every((s) => s.startsWith(stripped))) break;
    const remainders = rawSuffixes.map((s) => s.slice(strip));
    const conjClass = Object.keys(SUFFIX_OF).find((cls) => SUFFIX_OF[cls].every((s, i) => s === remainders[i]));
    if (conjClass) {
      // The mizen slot's hiragana form, minus the same (okuriganaPrefix +
      // paradigm-suffix) tail length just matched on the kanji side, is
      // this word's own kanji-covered reading — see this file's top-of-file
      // doc for why this is read off the matched block rather than a bare
      // character lookup.
      const tailLen = stripped.length + SUFFIX_OF[conjClass][0].length;
      const reading = hiraganaForms[0].slice(0, hiraganaForms[0].length - tailLen) || undefined;
      return { kanjiPrefix, conjClass, okuriganaPrefix: stripped || undefined, reading };
    }
  }
  return null;
}

/** The same match as `matchBlock`, for an entry whose bungo table is spelled
 * in *kana* rather than kanji.
 *
 * Common native verbs are filed on Wiktionary under their kana headword
 * (のむ, not 飲む — 飲む's own page is a bare soft-redirect), and such a
 * table's six stems are pure hiragana, so `matchBlock` finds no kanji form
 * to subtract an invariant prefix from and gives up. The classical data is
 * fully present, though: のま/のみ/のむ/のむ/のめ/のめ is マ行四段 as plainly
 * as any kanji-spelled table. `candidateSpellings` already recovers the
 * kanji spellings from such an entry's own "kanji" forms, so all that is
 * missing is a match that works off the hiragana.
 *
 * The reading is the common leading substring the six forms share, and
 * `tail` — the caller's kanji spelling's own okurigana (がる for 曲がる, む
 * for 飲む) — decides how much of it the kanji actually covers: whatever
 * `tail` carries beyond the paradigm's own terminative suffix is
 * `okuriganaPrefix`, and comes off the reading. */
function matchKanaBlock(block, tail) {
  if (![0, 1, 2, 3, 4, 5].every((i) => block[i]?.length)) return null;
  const forms = block.map((opts) => opts.find((f) => HIRAGANA_ONLY_RE.test(f)));
  if (forms.some((f) => f === undefined)) return null;

  const first = forms[0];
  let common = 0;
  while (common < Math.min(...forms.map((f) => f.length)) && forms.every((f) => f[common] === first[common])) common++;

  // Longest reading first, shortening until a paradigm matches — the same
  // direction `matchBlock` strips in, so a word whose stem happens to begin
  // with its own paradigm's kana isn't mis-split.
  for (let cut = common; cut >= 0; cut--) {
    const remainders = forms.map((f) => f.slice(cut));
    const conjClass = Object.keys(SUFFIX_OF).find((cls) => SUFFIX_OF[cls].every((s, i) => s === remainders[i]));
    if (!conjClass) continue;

    const terminative = SUFFIX_OF[conjClass][2];
    if (!tail.endsWith(terminative)) continue;
    const okuriganaPrefix = tail.slice(0, tail.length - terminative.length);
    let reading = first.slice(0, cut);
    if (okuriganaPrefix) {
      if (!reading.endsWith(okuriganaPrefix)) continue;
      reading = reading.slice(0, reading.length - okuriganaPrefix.length);
    }
    return { conjClass, okuriganaPrefix: okuriganaPrefix || undefined, reading: reading || undefined };
  }
  return null;
}

// A modern godan verb's classical ancestor is *always* 四段 in the exact
// same consonant row — an exceptionless fact of Japanese historical
// linguistics, not a per-word guess — so a godan entry with no
// {{ja-conj-bungo}} table at all (common: plenty of ordinary verb pages
// never got the template added) can still be resolved from nothing but its
// own modern dictionary-form ending. The one non-obvious row is う itself:
// a modern -u godan verb (言う, 習う, 買う) descends from historical -ふ
// (yodan-ha), not from a literal わ行.
const GODAN_ROW_OF_FINAL_KANA = {
  る: "yodan-ra",
  く: "yodan-ka",
  ぐ: "yodan-ga",
  す: "yodan-sa",
  つ: "yodan-ta",
  ぬ: "yodan-na",
  ぶ: "yodan-ba",
  む: "yodan-ma",
  う: "yodan-ha",
};

/** When a word has multiple valid classical paradigms (a transitive/
 * intransitive pair sharing one modern spelling, e.g. 学ぶ's 上二段
 * "to be learned" alongside its far more common 四段 "to learn"), prefer
 * whichever matches the word's own modern conjugation row: a modern godan
 * verb's classical ancestor is always 四段 in the *same* consonant row, so
 * `type` "1"/"1s" (godan) prefers a "yodan-" match; any other modern type
 * (ichidan, kuru, etc.) prefers a non-"yodan-" match, since a godan-shaped
 * classical class for a non-godan modern verb would be the rarer sense. */
function pickBlock(entry, matches) {
  if (matches.length <= 1) return matches[0];
  const type = entry.head_templates?.[0]?.args?.type;
  const wantYodan = type === "1" || type === "1s";
  return matches.find((m) => m.conjClass.startsWith("yodan-") === wantYodan) ?? matches[0];
}

/** Every kanji-headed spelling this entry's own data attests for its word:
 * the headword itself, when it's already kanji-initial, plus (crucially)
 * any of its own `forms` tagged "kanji" when the headword is pure kana
 * instead — common native verbs are routinely filed under their kana
 * spelling on Wiktionary with the kanji spelling(s) listed only as
 * alternates (成る/為る both turned up this way under the kana headword
 * なる, not as their own entries — 成る's own direct entry is a bare
 * soft-redirect with no data at all), the exact same shape of gap
 * `build-historical-kana-index.mjs`'s own `kanjiKeysOf` already had to
 * solve for readings. Excludes forms *also* tagged "historical" (an old
 * kanji substitution, a different axis than "this is how the word is
 * currently spelled"). A single entry can yield more than one kanji this
 * way (なる -> both 成 and 為) — each is tried independently below. */
function candidateSpellings(entry) {
  const word = entry.word ?? "";
  const spellings = [];
  if (KANJI_RE.test(word[0])) spellings.push(word);
  if (HIRAGANA_ONLY_RE.test(word)) {
    for (const f of entry.forms ?? []) {
      const tags = f.tags ?? [];
      if (tags.includes("kanji") && !tags.includes("historical") && KANJI_RE.test((f.form ?? "")[0])) {
        spellings.push(f.form);
      }
    }
  }
  return spellings;
}

/** ク活用 vs シク活用 from the modern -i adjective spelling alone — the
 * standard classical-grammar diagnostic (a シク adjective's stem itself
 * historically ends in the continuative し, surfacing in modern Japanese as
 * -shii; every other -i adjective is ク活用), not a per-word guess. `tail`
 * is the word's own hiragana okurigana (already known to end in "い" by
 * construction — see the caller). */
function kuOrShiku(tail) {
  if (tail === "い") return "ku-keiyoushi";
  if (tail.endsWith("しい")) return "shiku-keiyoushi";
  return null;
}

/** The entry's own modern phonetic reading (e.g. "きたる" for 来る, "あおい"
 * for 青い) straight from its head template's own declared reading arg —
 * used only as the *input* to stripping off `tail` (the word's own
 * okurigana) to recover the kanji-covered reading, for the two cases that
 * don't already go through a matched bungo block's own hiragana forms
 * (`matchBlock`'s `reading`): the godan-with-no-bungo-table fallback, and
 * every adjective (kaikki has no classical table for adjectives at all). */
function modernReadingOf(entry) {
  return entry.head_templates?.[0]?.args?.["1"];
}

/** A kana headword *is* its own reading, and carries no separate arg to
 * declare it (のむ's head-template args are just {tr: "trans", type: "1"}),
 * so the godan fallback would otherwise reject every such entry for having
 * no reading at all. Tier 2 only — see `kanaDerived` in `main`. */
function kanaHeadwordReading(entry) {
  return HIRAGANA_ONLY_RE.test(entry.word ?? "") ? entry.word : undefined;
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
  const raw = LOCAL_PATH?.endsWith(".jsonl") ? gz.toString("utf-8") : gunzipSync(gz).toString("utf-8");
  console.log(`Decompressed: ${(raw.length / 1e6).toFixed(1)} MB`);

  const index = {}; // kanji -> { conjClass, okuriganaPrefix? }
  const kanaDerived = {}; // same, from kana-spelled tables — see "Tier 2" below
  const shinjitaiOf = {}; // kyūjitai kanji -> shinjitai kanji
  let scanned = 0;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.lang_code !== "ja") continue;
    scanned++;

    if (entry.pos === "character") {
      const shinjitai = (entry.forms ?? []).find((f) => f.tags?.includes("shinjitai"));
      if (shinjitai && KANJI_RE.test(entry.word) && entry.word.length === 1) shinjitaiOf[entry.word] = shinjitai.form;
      continue;
    }

    for (const word of candidateSpellings(entry)) {
      const tail = word.slice(1);
      if (!HIRAGANA_ONLY_RE.test(tail)) continue; // only plain single-kanji-headed content words
      const kanji = word[0];
      if (index[kanji]) continue; // first successfully-classified entry for this kanji wins

      const type = entry.head_templates?.[0]?.args?.type;
      const godanClass = (type === "1" || type === "1s") && GODAN_ROW_OF_FINAL_KANA[tail.at(-1)];

      if (entry.pos === "verb") {
        const picked = pickBlock(
          entry,
          bungoBlocks(entry)
            .map(matchBlock)
            .filter((m) => m !== null),
        );
        if (picked) {
          index[kanji] = { conjClass: picked.conjClass, okuriganaPrefix: picked.okuriganaPrefix, reading: picked.reading };
          continue;
        }
        const modernReading = modernReadingOf(entry);
        if (godanClass && modernReading?.endsWith(tail)) {
          index[kanji] = { conjClass: godanClass, reading: modernReading.slice(0, -tail.length) || undefined };
          continue;
        }
      } else if (entry.pos === "adj" && tail.endsWith("い")) {
        const conjClass = kuOrShiku(tail);
        const modernReading = modernReadingOf(entry);
        if (conjClass && modernReading?.endsWith(tail)) {
          index[kanji] = { conjClass, reading: modernReading.slice(0, -tail.length) || undefined };
          continue;
        }
      }

      // Tier 2: entries whose classical data is spelled in kana. Held apart
      // from `index` and merged in afterwards for keys it never filled, so
      // that widening coverage can only ever *add* a kanji — never change
      // which entry wins one that already resolved. (Merging these inline
      // did exactly that: more entries classifying successfully re-ran the
      // "first match wins" race, and 53 kanji changed hands, 有 among them,
      // dropping from ra-hen to yodan-ra — which would have turned 朋有り
      // into 朋有る.)
      if (kanaDerived[kanji]) continue;
      if (entry.pos === "verb") {
        const picked = pickBlock(
          entry,
          bungoBlocks(entry)
            .map((block) => matchKanaBlock(block, tail))
            .filter((m) => m !== null),
        );
        if (picked) {
          kanaDerived[kanji] = { conjClass: picked.conjClass, okuriganaPrefix: picked.okuriganaPrefix, reading: picked.reading };
          continue;
        }
        const kanaReading = kanaHeadwordReading(entry);
        if (godanClass && kanaReading?.endsWith(tail)) {
          kanaDerived[kanji] = { conjClass: godanClass, reading: kanaReading.slice(0, -tail.length) || undefined };
        }
      }
    }
  }

  let fromKana = 0;
  for (const [kanji, derived] of Object.entries(kanaDerived)) {
    if (!index[kanji]) {
      index[kanji] = derived;
      fromKana++;
    }
  }

  let copied = 0;
  for (const [kyujitai, shinjitai] of Object.entries(shinjitaiOf)) {
    if (!index[kyujitai] && index[shinjitai]) {
      index[kyujitai] = index[shinjitai];
      copied++;
    }
  }

  console.log(`Scanned ${scanned} Japanese entries.`);
  console.log(
    `Derived ${Object.keys(index).length - copied - fromKana} kanji from kanji-spelled tables, ` +
      `${fromKana} more from kana-spelled ones, plus ${copied} kyūjitai aliases.`,
  );

  const json = JSON.stringify(index);
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1e3).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
