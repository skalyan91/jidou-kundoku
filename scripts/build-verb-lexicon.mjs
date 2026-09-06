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
// and `EXTRA_SUFFIX_OF` tables together mirror exactly). Subtracting the entry's own invariant kanji
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
// *Every* successfully-classified sense is kept, not just the first, because
// one kanji routinely spells two different classical words — the
// transitive/intransitive pair being the case this app actually has to
// choose between at render time (肥 is こやす 四段サ行 with an object and
// こゆ ヤ行下二段 without one). The first-classified sense stays first in
// each list, so any consumer that doesn't select by reading — `VERB_LEXICON`
// itself — sees exactly the entry it saw when this file wrote one sense per
// kanji. See `verbLexicon.ts` for the selecting lookup built on top.
//
// 學/學-style kyūjitai spellings are resolved to their shinjitai entry via
// kaikki's own `pos: "character"` entries (`forms: [{form, tags:
// ["shinjitai"]}]`) — not a hand-authored variant-character list — so both
// spellings end up with the same derived entry.
//
// Dev-time only; the raw ~330MB dump is never committed, only the two compact
// derived indexes are (the lexicon, and the kyūjitai -> shinjitai character
// map — see `OUT_SHINJITAI`). Wiktionary content, and both derived indexes
// with it, is CC BY-SA — see public/data/LICENSE-Wiktionary.txt.
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const SOURCE_URL = "https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl.gz";
// Bundled as an ordinary source-tree JSON import (like reading/overrides.json)
// rather than fetched at runtime from public/data/ like kanjidic/jmdict/
// historical-kana-index.json — at well under 100KB it's small enough that
// verbLexicon.ts can just `import` it directly and stay a synchronous
// module, matching every one of its call sites' existing (synchronous)
// signature instead of threading a fourth async-loaded index through
// generator.ts/KundokuView.ts alongside `resolve`.
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "kakikudashi", "verb-lexicon-index.json");
// The kyūjitai -> shinjitai character map, emitted from the same scan.
//
// This script has always derived it (to give 學 the entry it builds for 学,
// rather than carry a hand-written variant list) and always thrown it away.
// It is wanted at runtime for a different reason: JMdict is keyed on modern
// spellings and kanbun is written in 旧字体, so 獨酌/大亂 miss a dictionary
// that has 独酌/大乱 — see `shinjitaiSpelling` in reading/jmdictLookup.ts.
// Emitted here rather than by a script of its own because the map falls out
// of a pass this one already makes; a second script would mean a second
// 330MB download to recompute what is already in hand. Same source-tree JSON
// treatment as the lexicon index and for the same reason (6KB, and its one
// consumer is synchronous).
const OUT_SHINJITAI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "reading", "shinjitai-index.json");
// Optional: --local <path-to-.jsonl.gz-or-.jsonl> to use an already-downloaded
// copy (e.g. fetched via curl) instead of Node's own fetch, which has been
// unreliable against this host in some environments.
const localPathArgIndex = process.argv.indexOf("--local");
const LOCAL_PATH = localPathArgIndex !== -1 ? process.argv[localPathArgIndex + 1] : null;

const KANJI_RE = /[一-鿿㐀-䶿]/;

/** Exactly one kanji — counted in code points, since a bare `.length === 1`
 * would let a surrogate pair through half-read. */
function isSingleKanji(text) {
  return [...text].length === 1 && KANJI_RE.test(text);
}
const HIRAGANA_ONLY_RE = /^[ぁ-ゟー]+$/;

// The six-suffix "shape" (mizen, renyou, shuushi, rentai, izen, meirei) that
// identifies a ConjClass, spelled exactly as classicalConjugation.ts's own
// PARADIGMS spell it. ク/シク adjectives aren't matched this way at all (see
// `kuOrShiku`), so they're not listed here.
//
// Split into two tables, and the split is the important part.
//
// `SUFFIX_OF` holds the rows that may decide a kanji's *default* sense — the
// one that lands in slot 0 and so becomes `VERB_LEXICON`'s single entry for
// the character. `EXTRA_SUFFIX_OF` holds every further row; a sense matched by
// one of those joins the kanji's list, where the by-reading lookup can find
// it, but is appended behind whatever the default rows already found.
//
// Widening coverage must not re-open the question of which word a character
// conjugates as by default. That is the same rule tier 2 below already states
// for kana-spelled tables, and for the same measured reason: adding the
// 二段 rows to one flat table re-ran the "first entry to classify wins" race
// and 18 kanji changed hands. Most of the new answers were *better* classical
// Japanese (告 こく -> つ, i.e. 告ぐ; 廣 -> 廣む; 憂 -> 上二段 憂ふ), but 食
// dropped from は行四段 食ふ to 下二段バ行 食ぶ — a real word, and the wrong
// one for kanbun — turning 食肉飲酒歌舞 into 肉を食ぶ…, which is what the
// generator's own test for that line caught. Whether any of those 18 should
// become the character's default is a question about words, not about rows,
// and it is not one a row table is entitled to answer as a side effect.
//
// Shapes are unique across *both* tables, so `matchBlock`'s scan cannot be
// order-dependent — `duplicateSuffixShapes` asserts it at build time.
export const SUFFIX_OF = {
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
  // ヤ行下二段 (肥ゆ, 見ゆ, 生ゆ) is a default row rather than an extra one
  // because it is not widening anything: it is the row that decides a word
  // the mechanical derivation cannot decide at all. A modern -eru with a
  // bare え could be ア行 (得), ヤ行 (見ゆ) or ワ行 (植う), so
  // `readingResolver.ts` refuses the whole あ row, and 馬肥 read the modern
  // 馬肥える for as long as this was absent. Its one effect on a default was
  // 萌 こやす -> こゆ, which is 萌ゆ "to sprout", the ordinary classical word.
  "shimo-nidan-ya": ["え", "え", "ゆ", "ゆる", "ゆれ", "えよ"],
  "kami-ichidan": ["", "", "る", "る", "れ", "よ"],
  "ka-hen": ["こ", "き", "く", "くる", "くれ", "こよ"],
  "sa-hen": ["せ", "し", "す", "する", "すれ", "せよ"],
  "na-hen": ["な", "に", "ぬ", "ぬる", "ぬれ", "ね"],
  "ra-hen": ["ら", "り", "り", "る", "れ", "れ"],
};

/** The rest of PARADIGMS' regular classes — every 二段 row but the two the
 * table above already carried, plus ワ行下二段 and ヤ行上二段, which had no
 * `ConjClass` at all until this fill. Between them they match 147 six-slot
 * blocks the build used to drop on the floor.
 *
 * ワ行下二段 is the one of these that is a correctness fix rather than
 * coverage. It completes the え trio ア行/ヤ行/ワ行 that modern spelling has
 * collapsed — 得る, 見える and 植える all show a plain え — so it is the row
 * that lets 植う/据う/飢う be told from 見ゆ/肥ゆ at all, and the row 種 needs
 * before it can conjugate (see `RESIDUAL` in verbLexicon.ts, which supplies
 * 種's own entry: Wiktionary files 植う under 植 and has no verb entry for 種).
 *
 * Four blocks in the current dump still match nothing at all, and each is a
 * genuine irregular rather than a gap:
 *  - 来る's degenerate ///る/れ/ (an empty imperative; カ変 proper is
 *    こ/き/く/くる/くれ/こよ, already above);
 *  - 存じる's ぜ/じ/ず/ずる/ずれ/ぜよ and 先んずる's んぜ/んじ/… — ザ変, サ変's
 *    voiced counterpart, whose mizen and renyou differ (ぜ/じ), so it is not
 *    下二段ザ行 (ぜ/ぜ/…) however similar it looks;
 *  - 異なる's なら/に/なり/なる/なれ/なれ, which is ナリ活用形容動詞. That class
 *    does exist in PARADIGMS and is still left out: 形容動詞 reach this index
 *    through `kuOrShiku` from *adjective* entries, and routing one word in
 *    through the verb path would cross that boundary for a single block — one
 *    `modernOkurigana` cannot express either, so no by-reading lookup could
 *    ever select it. */
export const EXTRA_SUFFIX_OF = {
  "kami-nidan-ga": ["ぎ", "ぎ", "ぐ", "ぐる", "ぐれ", "ぎよ"],
  "kami-nidan-ta": ["ち", "ち", "つ", "つる", "つれ", "ちよ"],
  "kami-nidan-da": ["ぢ", "ぢ", "づ", "づる", "づれ", "ぢよ"],
  "kami-nidan-ha": ["ひ", "ひ", "ふ", "ふる", "ふれ", "ひよ"],
  "kami-nidan-ba": ["び", "び", "ぶ", "ぶる", "ぶれ", "びよ"],
  "kami-nidan-ya": ["い", "い", "ゆ", "ゆる", "ゆれ", "いよ"],
  "kami-nidan-ra": ["り", "り", "る", "るる", "るれ", "りよ"],

  "shimo-nidan-ka": ["け", "け", "く", "くる", "くれ", "けよ"],
  "shimo-nidan-ga": ["げ", "げ", "ぐ", "ぐる", "ぐれ", "げよ"],
  "shimo-nidan-sa": ["せ", "せ", "す", "する", "すれ", "せよ"],
  "shimo-nidan-za": ["ぜ", "ぜ", "ず", "ずる", "ずれ", "ぜよ"],
  "shimo-nidan-ta": ["て", "て", "つ", "つる", "つれ", "てよ"],
  "shimo-nidan-da": ["で", "で", "づ", "づる", "づれ", "でよ"],
  "shimo-nidan-na": ["ね", "ね", "ぬ", "ぬる", "ぬれ", "ねよ"],
  "shimo-nidan-ha": ["へ", "へ", "ふ", "ふる", "ふれ", "へよ"],
  "shimo-nidan-ba": ["べ", "べ", "ぶ", "ぶる", "ぶれ", "べよ"],
  "shimo-nidan-ma": ["め", "め", "む", "むる", "むれ", "めよ"],
  "shimo-nidan-ra": ["れ", "れ", "る", "るる", "るれ", "れよ"],
  "shimo-nidan-wa": ["ゑ", "ゑ", "う", "うる", "うれ", "ゑよ"],
};

/** Both tables at once, for the pass that collects the non-default senses. */
export const ALL_SUFFIX_OF = { ...SUFFIX_OF, ...EXTRA_SUFFIX_OF };

const SLOT_TAG = ["irrealis", "continuative", "terminative", "attributive", "realis", "imperative"];

export const PARADIGMS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "kakikudashi",
  "classicalConjugation.ts",
);

/** The classes this script can emit that `classicalConjugation.ts` has no
 * `PARADIGMS` entry for — empty in a healthy tree.
 *
 * The two tables are written out separately (`SUFFIX_OF` in kana suffix
 * order, `PARADIGMS` through its row helpers), and nothing in the type system
 * connects them: the index is a JSON import, so a `conjClass` string it
 * carries is only ever *asserted* to be a `ConjClass`, never checked. Adding
 * ヤ行下二段 to `SUFFIX_OF` and forgetting it in `PARADIGMS` produced exactly
 * that — a clean `tsc`, a clean build, and `conjugate` throwing on undefined
 * the first time 馬肥 was rendered. Takes the paradigm source as an argument
 * rather than reading it, so a test can hand it a deliberately broken one and
 * watch this actually fire.
 *
 * **Scoped to the `PARADIGMS` record itself, and it had to be.** This was a
 * scan over the whole file, which worked only while `PARADIGMS` was the one
 * table in it keyed by class name. It no longer is: `CONJ_CLASS_CARTOUCHE`
 * writes every class out a second time, so a key deleted from `PARADIGMS`
 * would still be found in the cartouche table and the guard would report a
 * healthy tree over a broken one — which is exactly the failure it exists to
 * catch, arriving by a new route. `paradigmsBlock` cuts the record out by its
 * own declaration and its closing brace, and a source with no such
 * declaration yields "" and so reports every class missing, which is the right
 * answer for a file that has lost the table altogether. */
function paradigmsBlock(source) {
  const opens = source.indexOf("PARADIGMS: Record<ConjClass, Paradigm> = {");
  if (opens < 0) return "";
  const closes = source.indexOf("\n};", opens);
  return closes < 0 ? source.slice(opens) : source.slice(opens, closes);
}

export function missingParadigmEntries(paradigmsSource) {
  const block = paradigmsBlock(paradigmsSource);
  return [...Object.keys(ALL_SUFFIX_OF), "ku-keiyoushi", "shiku-keiyoushi"].filter(
    (cls) => !block.includes(`"${cls}":`),
  );
}

/** Any six-suffix shape claimed by more than one class. `matchBlock` finds a
 * class by scanning `SUFFIX_OF` for the first whose shape fits, so two
 * classes sharing a shape would make the answer depend on key order — which
 * is not a thing this table should ever encode. Empty in a healthy tree. */
export function duplicateSuffixShapes() {
  const byShape = new Map();
  const clashes = [];
  for (const [cls, suffixes] of Object.entries(ALL_SUFFIX_OF)) {
    const shape = suffixes.join("/");
    if (byShape.has(shape)) clashes.push(`${byShape.get(shape)} / ${cls}: ${shape}`);
    byShape.set(shape, cls);
  }
  return clashes;
}

function assertBuildTablesAreSound() {
  const missing = missingParadigmEntries(readFileSync(PARADIGMS_PATH, "utf-8"));
  if (missing.length > 0) {
    throw new Error(`classicalConjugation.ts has no PARADIGMS entry for: ${missing.join(", ")}`);
  }
  const clashes = duplicateSuffixShapes();
  if (clashes.length > 0) throw new Error(`SUFFIX_OF has classes sharing one shape: ${clashes.join("; ")}`);
}

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
function matchBlock(block, suffixTable) {
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
    const conjClass = Object.keys(suffixTable).find((cls) => suffixTable[cls].every((s, i) => s === remainders[i]));
    if (conjClass) {
      // The mizen slot's hiragana form, minus the same (okuriganaPrefix +
      // paradigm-suffix) tail length just matched on the kanji side, is
      // this word's own kanji-covered reading — see this file's top-of-file
      // doc for why this is read off the matched block rather than a bare
      // character lookup.
      const tailLen = stripped.length + suffixTable[conjClass][0].length;
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
function matchKanaBlock(block, tail, suffixTable) {
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
    const conjClass = Object.keys(suffixTable).find((cls) => suffixTable[cls].every((s, i) => s === remainders[i]));
    if (!conjClass) continue;

    const terminative = suffixTable[conjClass][2];
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

/** An entry's matched paradigms, most likely first — every one of them is
 * kept now, so this only decides the *order*.
 *
 * When a word has multiple valid classical paradigms (a transitive/
 * intransitive pair sharing one modern spelling, e.g. 学ぶ's 上二段
 * "to be learned" alongside its far more common 四段 "to learn"), the one to
 * lead with is whichever matches the word's own modern conjugation row: a
 * modern godan verb's classical ancestor is always 四段 in the *same*
 * consonant row, so `type` "1"/"1s" (godan) prefers a "yodan-" match; any
 * other modern type (ichidan, kuru, etc.) prefers a non-"yodan-" match, since
 * a godan-shaped classical class for a non-godan modern verb would be the
 * rarer sense. The rest keep the order the entry's own tables came in. */
function orderMatches(entry, matches) {
  if (matches.length <= 1) return matches;
  const type = entry.head_templates?.[0]?.args?.type;
  const wantYodan = type === "1" || type === "1s";
  const preferred = matches.findIndex((m) => m.conjClass.startsWith("yodan-") === wantYodan);
  if (preferred <= 0) return matches;
  return [matches[preferred], ...matches.filter((_, i) => i !== preferred)];
}

/** Appends one classified sense to a kanji's list, skipping an exact
 * duplicate. Duplicates are the common case, not the exception: one word is
 * routinely reachable through several entries (its own kanji headword, a kana
 * headword listing that kanji as an alternate spelling, a kyūjitai variant),
 * and each of them derives the identical {class, prefix, reading} triple.
 * Without this the file would grow by repetition rather than by senses —
 * which is the one thing it cannot afford, being imported synchronously as an
 * ordinary source-tree JSON. */
function addSense(target, kanji, sense) {
  const senses = (target[kanji] ??= []);
  const key = `${sense.conjClass}|${sense.okuriganaPrefix ?? ""}|${sense.reading ?? ""}`;
  if (senses.some((s) => `${s.conjClass}|${s.okuriganaPrefix ?? ""}|${s.reading ?? ""}` === key)) return;
  // Rebuilt field-by-field rather than spread, so `matchBlock`'s own
  // `kanjiPrefix` (an internal of the match, not part of the entry) can never
  // ride along into the shipped file.
  senses.push({ conjClass: sense.conjClass, okuriganaPrefix: sense.okuriganaPrefix, reading: sense.reading });
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
  assertBuildTablesAreSound();
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

  const index = {}; // kanji -> [{ conjClass, okuriganaPrefix?, reading? }, ...], first-classified first
  const kanaDerived = {}; // same, from kana-spelled tables — see "Tier 2" below
  const extended = {}; // same, from EXTRA_SUFFIX_OF rows — appended last, never a default
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
      // Both sides must be exactly one kanji. kaikki's "shinjitai" form is
      // sometimes a whole word or a parenthesised note rather than a bare
      // character (127 of them in the current dump), and this map is a
      // character-for-character substitution — anything longer could not be
      // applied to a spelling one character at a time anyway.
      const shinjitai = (entry.forms ?? []).find((f) => f.tags?.includes("shinjitai"));
      const target = shinjitai?.form ?? "";
      if (isSingleKanji(entry.word) && isSingleKanji(target) && target !== entry.word) shinjitaiOf[entry.word] = target;
      continue;
    }

    for (const word of candidateSpellings(entry)) {
      const tail = word.slice(1);
      if (!HIRAGANA_ONLY_RE.test(tail)) continue; // only plain single-kanji-headed content words
      const kanji = word[0];

      const type = entry.head_templates?.[0]?.args?.type;
      const godanClass = (type === "1" || type === "1s") && GODAN_ROW_OF_FINAL_KANA[tail.at(-1)];

      // Every row, including the extra ones, collected off to the side. Run
      // first and unconditionally — ahead of the default-row logic below and
      // outside its `continue`s — so that whether a sense is *collected* never
      // depends on whether some other row already answered for this kanji.
      // Which of them can be a *default* is settled entirely by which table
      // matched, not by where in this loop the match happened.
      if (entry.pos === "verb") {
        const widened = orderMatches(
          entry,
          bungoBlocks(entry)
            .map((block) => matchBlock(block, ALL_SUFFIX_OF))
            .filter((m) => m !== null),
        );
        for (const match of widened) addSense(extended, kanji, match);
      }

      // Every entry for a kanji is now read, not just entries up to the first
      // one that classifies — that first one merely stays at the head of the
      // list. Appending in scan order is what makes the head stable: the
      // sense that used to be the kanji's single entry is still the sense
      // that lands in slot 0, so `VERB_LEXICON` is unchanged by this.
      let classified = false;
      if (entry.pos === "verb") {
        const matches = orderMatches(
          entry,
          bungoBlocks(entry)
            .map((block) => matchBlock(block, SUFFIX_OF))
            .filter((m) => m !== null),
        );
        for (const match of matches) {
          addSense(index, kanji, match);
          classified = true;
        }
        if (!classified) {
          const modernReading = modernReadingOf(entry);
          if (godanClass && modernReading?.endsWith(tail)) {
            addSense(index, kanji, { conjClass: godanClass, reading: modernReading.slice(0, -tail.length) || undefined });
            classified = true;
          }
        }
      } else if (entry.pos === "adj" && tail.endsWith("い")) {
        const conjClass = kuOrShiku(tail);
        const modernReading = modernReadingOf(entry);
        if (conjClass && modernReading?.endsWith(tail)) {
          addSense(index, kanji, { conjClass, reading: modernReading.slice(0, -tail.length) || undefined });
          classified = true;
        }
      }
      if (classified) continue;

      // Tier 2: entries whose classical data is spelled in kana. Held apart
      // from `index` and merged in afterwards for keys it never filled, so
      // that widening coverage can only ever *add* a kanji — never change
      // which entry wins one that already resolved. (Merging these inline
      // did exactly that: more entries classifying successfully re-ran the
      // "first match wins" race, and 53 kanji changed hands, 有 among them,
      // dropping from ra-hen to yodan-ra — which would have turned 朋有り
      // into 朋有る.)
      //
      // Still merged whole-list-or-nothing now that a kanji holds several
      // senses, rather than appending kana-derived senses behind
      // kanji-derived ones: the hazard above is not confined to slot 0 any
      // more. 有's kana-derived 四段ラ行 carries the very same reading あ as
      // its correct ラ変, so appending it would put two indistinguishable
      // candidates in front of the by-reading lookup for a kanji that
      // currently has exactly one right answer. A kanji no kanji-spelled
      // table reached has no such answer to lose.
      if (entry.pos === "verb") {
        const matches = orderMatches(
          entry,
          bungoBlocks(entry)
            .map((block) => matchKanaBlock(block, tail, SUFFIX_OF))
            .filter((m) => m !== null),
        );
        if (matches.length > 0) {
          for (const match of matches) addSense(kanaDerived, kanji, match);
          continue;
        }
        const kanaReading = kanaHeadwordReading(entry);
        if (godanClass && kanaReading?.endsWith(tail)) {
          addSense(kanaDerived, kanji, { conjClass: godanClass, reading: kanaReading.slice(0, -tail.length) || undefined });
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

  // Before the extended senses are folded in, not after: a kyūjitai spelling
  // has to inherit its shinjitai's *default* rather than acquire one of its
  // own from a row that isn't allowed to set defaults. 廣 takes 広's entry;
  // it does not get to lead with a 下二段マ行 sense 広 itself doesn't lead with.
  let copied = 0;
  for (const [kyujitai, shinjitai] of Object.entries(shinjitaiOf)) {
    if (!index[kyujitai] && index[shinjitai]) {
      index[kyujitai] = index[shinjitai];
      copied++;
    }
  }

  // The extended rows, last of all. `addSense` drops the duplicates this
  // produces — every default-row sense was matched by the widened pass too —
  // so what actually lands here is only the senses no default row could
  // reach, behind everything that could.
  let widenedSenses = 0;
  let widenedKanji = 0;
  for (const [kanji, senses] of Object.entries(extended)) {
    const before = index[kanji]?.length ?? 0;
    if (!index[kanji]) widenedKanji++;
    for (const sense of senses) addSense(index, kanji, sense);
    widenedSenses += (index[kanji]?.length ?? 0) - before;
  }

  // And the kyūjitai pass again, for spellings that only the extended rows
  // reached at all — those have no default to preserve, so inheriting one is
  // strictly better than leading with nothing.
  for (const [kyujitai, shinjitai] of Object.entries(shinjitaiOf)) {
    if (!index[kyujitai] && index[shinjitai]) {
      index[kyujitai] = index[shinjitai];
      copied++;
    }
  }

  const senseCount = Object.values(index).reduce((n, senses) => n + senses.length, 0);
  const multiSense = Object.values(index).filter((senses) => senses.length > 1).length;
  console.log(`Scanned ${scanned} Japanese entries.`);
  console.log(
    `Derived ${Object.keys(index).length - copied - fromKana} kanji from kanji-spelled tables, ` +
      `${fromKana} more from kana-spelled ones, plus ${copied} kyūjitai aliases.`,
  );
  console.log(`${senseCount} senses over ${Object.keys(index).length} kanji; ${multiSense} kanji carry more than one.`);
  console.log(`${widenedSenses} of those senses (over ${widenedKanji} otherwise-absent kanji) come from EXTRA_SUFFIX_OF rows.`);

  const json = JSON.stringify(index);
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1e3).toFixed(1)} KB)`);

  const shinjitaiJson = JSON.stringify(shinjitaiOf);
  writeFileSync(OUT_SHINJITAI, shinjitaiJson);
  console.log(`Wrote ${OUT_SHINJITAI} (${Object.keys(shinjitaiOf).length} characters, ${(shinjitaiJson.length / 1e3).toFixed(1)} KB)`);
}

// Only when run as a script. The build tables and their soundness checks are
// exported for `conjugationContext.test.ts` to assert against, and importing
// this module must not kick off a 330MB download to do it.
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
