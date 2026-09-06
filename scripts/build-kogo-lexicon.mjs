#!/usr/bin/env node
// Downloads NINJAL's 中古和文UniDic (Early Middle Japanese prose UniDic) and
// builds public/data/kogo-lexicon-index.json — a *second*, independent source
// of classical conjugation classes and readings, standing beside (never
// merged into) the Wiktionary-derived src/kakikudashi/verb-lexicon-index.json.
//
// ## Why a second index at all, when one already exists
//
// `build-verb-lexicon.mjs` reads Wiktionary's `{{ja-conj-bungo}}` tables and
// covers 1,285 kanji. Its coverage has a shape, and the shape is a hole:
// Wiktionary attaches a bungo table to a *modern* entry, so a classical verb
// survives into that data only where its modern reflex kept a page worth
// conjugating. **下二段 is exactly the class that loses this bet.** 伝える,
// 構える, 仕える, 添える, 揃える, 震える, 教える and 考える all carry a modern
// 一段 inflection table and *no* bungo table whatever, so their 下二段 senses —
// 伝ふ, 構ふ, 仕ふ, 添ふ, 揃ふ, 震ふ, 教ふ, 考ふ — are simply absent, and a
// modern え-row verb is *by construction* what a 下二段 descends from. Each
// missing one has been filled by hand in `verbLexicon.ts`'s `RESIDUAL`, one
// lexical claim at a time.
//
// UniDic is built the other way round. It is a *corpus* dictionary keyed on
// the classical word itself: 中古和文UniDic's business is segmenting 源氏物語
// and 枕草子, so 教ふ is a first-class headword with its own 活用型
// (文語下二段-ハ行) and its own 仮名形 (ヲシフ) — the class and the historical
// reading together, from an entry that exists because the *classical* word
// exists, not because a modern descendant does. Measured against `RESIDUAL`,
// this index reproduces 33 of its 53 hand-written entries exactly and six more
// up to kana orthography or okurigana split; it supplies all eight of the
// named 下二段 gaps; and it carries 1,811 下二段 senses over 1,088 kanji
// against the Wiktionary index's 154 over 139.
//
// ## Why 中古和文 and not one of the other eight classical packages
//
// NINJAL offers nine classical UniDic variants. The three 文語 ones are the
// only candidates (the 口語 packages describe spoken Muromachi/Edo, whose
// grammar is not what kundoku prints). Of those three:
//
//  - **中古和文** is Heian prose, and Heian prose *is* the grammar this app
//    already implements. `classicalConjugation.ts`'s PARADIGMS are the 中古
//    inventory: 上二段 and 下二段 fully productive across every row, ラ変/ナ変/
//    カ変/サ変 as four separate irregulars, ク/シク 形容詞, 歴史的仮名遣い with
//    ゐ/ゑ/を still distinct. Its 活用型 vocabulary lands on that inventory
//    almost exactly (see `CONJ_CLASS_OF` below).
//  - **近世文語** (1.39 GB) and **近代文語** (1.22 GB) are Edo and Meiji
//    literary Japanese — 文語 as a deliberately archaising register, written
//    centuries after the grammar it imitates. They would add Sino-Japanese
//    bulk, not classical paradigms, and they are seven times the download for
//    it.
//
// So: one package, 中古和文, 186 MB. Not all nine, and not the two big ones.
//
// ## What it refuses
//
// Four filters, each of which is a claim about what a *kanbun* lexicon may
// contain, and each of which is counted in the run summary:
//
//  1. **Anything that is not one kanji followed by kana.** A kanbun token is a
//     character; 思ひ出づ and 教へ労はる are compounds whose leading kanji is not
//     the word. This drops the great majority of UniDic's 610,763 rows.
//  2. **Anything whose okurigana does not end in its own paradigm's 終止形.**
//     UniDic lists both 教ふ (kanaBase ヲシフ) and the modernised 教う (オシウ)
//     as separate rows of the same 文語下二段-ハ行 class. The ハ行 paradigm's
//     終止形 is ふ, so this one test keeps the historical spelling and discards
//     the modernised one — and simultaneously verifies that the row's
//     orthography and its declared class agree at all.
//  3. **Anything whose okurigana prefix runs past one kana.** 出しゃばる and
//     大がかり are single-kanji-plus-kana by shape and compounds by fact. The
//     existing index attests prefixes of one kana 185 times, of two 4 times
//     and of three once, so a one-kana cap costs almost nothing real and
//     removes 22,257 compounds.
//  4. **Word-initial 連濁.** 伝 づた and 作 づく are compound-medial artefacts
//     of 言ひ伝ふ and 物作る, never how the bare character is read. Refused only
//     where the same kanji and class already carry the voiceless sibling, so
//     no word whose reading is genuinely voiced is touched.
//
// Filter 2 has one consequence worth naming rather than discovering. **The
// bare カ変 and サ変 — 来 read く and 為 read す — cannot survive it, and should
// not.** Their whole paradigm is okurigana with no stem in front of it, so
// UniDic's citation form is the naked kanji (書字形基本形 来, 仮名形基本形 ク)
// and there is no okurigana for the ふ/く/す test to look at. Emitting them
// would mean writing `reading: "く"` for a word whose kanji carries no reading
// at all, and then printing 来く. Refused is the right answer; `RESIDUAL`'s own
// 爲/為 さ変 entry stays, and 来 keeps the lexicalized 四段ラ行 きたる that this
// index does supply.
//
// Senses are ordered by MeCab's own word cost, lowest first, so the sense a
// UniDic-based parser would actually pick leads each list. The Wiktionary
// index has no such signal and orders by discovery instead, and the ordering
// is most of what makes this data usable: 出 carries nine senses here and the
// cheapest is 下二段ダ行 い (出づ), 立 carries eight and the cheapest is
// 下二段タ行 た, 視 five and the cheapest is 下二段ヤ行 み.
//
// ## What it does not supply, and cannot
//
// Eleven `RESIDUAL` entries name a class this index does not offer for that
// character, and the honest reading of most of them is that no dictionary
// could: 仁 じん, 賢 けん, 暴 にはか and 需 もらふ are *kundoku* readings — a
// Sino-Japanese abstract predicated with なり, or a word the reader assigned to
// a character — and 中古和文 is a dictionary of Heian *wabun*, which is the one
// register that has no kanbun in it. 礪, 縶 and 仁 are absent from the package
// altogether. `RESIDUAL` is not retired by this file; it is *reduced*, and the
// entries that survive are the ones that were always lexical judgements rather
// than lookups.
//
// ## Licence — why this is a separate file and must stay one
//
// The classical UniDic packages are **CC BY-NC-SA 4.0**. Everything else this
// app ships derives from JMdict, KANJIDIC2 and Wiktionary, all **CC BY-SA**.
// Those two licences cannot be combined into one adapted work: BY-SA forbids
// the NonCommercial restriction downstream, BY-NC-SA requires it. So this
// index is emitted to its own path, read alongside the others rather than
// folded into any of them — aggregation, not adaptation. **Nothing here may
// ever be merged into verb-lexicon-index.json.** The project is
// non-commercial, which is what makes NC usable at all.
//
// See public/data/LICENSE-UniDic.txt for the attribution and terms.
//
// Dev-time only. The raw 186 MB package is never committed, exactly as
// `build-verb-lexicon.mjs`'s 330 MB kaikki dump never is — only the compact
// derived index is.
//
// Usage:
//   node scripts/build-kogo-lexicon.mjs
//   node scripts/build-kogo-lexicon.mjs --local /tmp/unidic-chuko-v202512.zip
import { inflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const SOURCE_URL = "https://clrd.ninjal.ac.jp/unidic_archive/2512/unidic-chuko-v202512.zip";

// public/data/, not src/. Two reasons, and they point the same way: it is the
// directory the runtime-fetched indexes live in (kanjidic, jmdict,
// historical-kana), which is what an index this size should be; and it is
// where LICENSE-Wiktionary.txt and LICENSE-EDRDG.txt sit, so the NC-licensed
// data and its licence file end up beside each other and physically apart
// from the BY-SA index in src/kakikudashi/.
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "kogo-lexicon-index.json");

const localPathArgIndex = process.argv.indexOf("--local");
const LOCAL_PATH = localPathArgIndex !== -1 ? process.argv[localPathArgIndex + 1] : null;

/** The okurigana UniDic's **citation form** ends in, per `ConjClass` in
 * `src/kakikudashi/classicalConjugation.ts` — the same relationship
 * `build-verb-lexicon.mjs`'s `SUFFIX_OF` has to that file, and kept here for
 * the same reason: this script has to subtract a paradigm's own ending from an
 * attested citation form to recover the stem, and cannot import a TypeScript
 * module to do it.
 *
 * For every inflecting class this **is** that paradigm's 終止形, and
 * `kogoLexicon.test.ts` asserts the two agree cell by cell. Three entries are
 * empty, and each emptiness is a fact rather than a hole:
 *
 *  - **`shimo-nidan-a`** (得) has no 終止形 okurigana in either analysis. Its
 *    terminative is the bare vowel already inside the kanji's own reading —
 *    得, never 得う — which is what PARADIGMS says too.
 *  - **`nari-keiyoudoushi` and `tari-keiyoudoushi`** are where the two
 *    analyses genuinely differ. This app's paradigm inflects なり/たり as part
 *    of the word, so its 終止形 is なり; UniDic makes the copula a separate
 *    助動詞 and leaves the 形状詞 uninflecting, so its 書字形基本形 is the bare
 *    語幹 (暴, not 暴なり). It is UniDic's citation form this table is
 *    subtracting from, so the entry is what UniDic writes.
 *
 * All three skip filter 2 in `buildIndex`, because an empty suffix gives the
 * orthography nothing to be tested against. */
export const CITATION_OKURIGANA_OF = {
  "yodan-ka": "く",
  "yodan-ga": "ぐ",
  "yodan-sa": "す",
  "yodan-ta": "つ",
  "yodan-na": "ぬ",
  "yodan-ba": "ぶ",
  "yodan-ma": "む",
  "yodan-ra": "る",
  "yodan-ha": "ふ",
  "kami-nidan-ka": "く",
  "kami-nidan-ga": "ぐ",
  "kami-nidan-ta": "つ",
  "kami-nidan-da": "づ",
  "kami-nidan-ha": "ふ",
  "kami-nidan-ba": "ぶ",
  "kami-nidan-ma": "む",
  "kami-nidan-ya": "ゆ",
  "kami-nidan-ra": "る",
  "shimo-nidan-a": "",
  "shimo-nidan-ka": "く",
  "shimo-nidan-ga": "ぐ",
  "shimo-nidan-sa": "す",
  "shimo-nidan-za": "ず",
  "shimo-nidan-ta": "つ",
  "shimo-nidan-da": "づ",
  "shimo-nidan-na": "ぬ",
  "shimo-nidan-ha": "ふ",
  "shimo-nidan-ba": "ぶ",
  "shimo-nidan-ma": "む",
  "shimo-nidan-ya": "ゆ",
  "shimo-nidan-ra": "る",
  "shimo-nidan-wa": "う",
  "kami-ichidan": "る",
  "ka-hen": "く",
  "sa-hen": "す",
  "na-hen": "ぬ",
  "ra-hen": "り",
  "ku-keiyoushi": "し",
  "shiku-keiyoushi": "し",
  "nari-keiyoudoushi": "",
  "tari-keiyoudoushi": "",
};

const ROW_OF = {
  ア: "a",
  カ: "ka",
  ガ: "ga",
  サ: "sa",
  ザ: "za",
  タ: "ta",
  ダ: "da",
  ナ: "na",
  ハ: "ha",
  バ: "ba",
  マ: "ma",
  ヤ: "ya",
  ラ: "ra",
  ワ: "wa",
};

const FAMILY_OF = { 四段: "yodan", 上二段: "kami-nidan", 下二段: "shimo-nidan" };

/** UniDic's 活用型 (and, for the 形容動詞, its 品詞) onto `ConjClass`.
 *
 * The correspondence is close to exact, and the places it is not are worth
 * naming, because each is a statement about one of the two inventories:
 *
 *  - **形容動詞 have no 活用型 in UniDic at all.** UniDic analyses ナリ/タリ as
 *    a separate 助動詞 (文語助動詞-ナリ-断定, 文語助動詞-タリ-断定) attached to
 *    an *uninflecting* 形状詞, where this app treats 形容動詞 as one word with
 *    a paradigm of its own. So `nari-keiyoudoushi` and `tari-keiyoudoushi` are
 *    reached from `pos1 === "形状詞"` — pos2 タリ for the second, 一般 for the
 *    first — and never from a 活用型. The two analyses agree about the
 *    language; they disagree about where the word boundary is.
 *  - **文語上二段-ザ行 and 文語上二段-ワ行 have no `ConjClass`.** 27 UniDic rows
 *    between them. `ConjClass` carries nine 上二段 rows and these are the two
 *    it lacks; adding them is a change to `classicalConjugation.ts`, which
 *    this script does not make, so both are refused and counted.
 *  - **文語下一段-カ行 has no `ConjClass`.** 22 rows, and all of them are 蹴る —
 *    classical Japanese has exactly one 下一段 verb, and this app has never had
 *    a reason to write it.
 *  - **文語助動詞-* is deliberately unmapped.** ズ, ベシ, ム, ケリ, ツ, ヌ, リ,
 *    マジ, ゴトシ and the rest are auxiliaries, and this app conjugates them in
 *    `bungoConjugation.ts` rather than looking them up per character. They are
 *    not a gap.
 *  - **無変化型, 五段-*, 下一段-*, 上一段-* (unprefixed) and 形容詞
 *    (unprefixed) are the modern classes** UniDic carries for modernised
 *    spellings inside the same package. Refused: this index exists to supply
 *    classical paradigms, and a modern one has nothing to say here.
 *
 * Every other 文語 活用型 in the package maps, and every `ConjClass` except the
 * two adjective-verb ones is reachable from one. */
export function conjClassOf(cType, pos1, pos2) {
  if (cType === "*") {
    if (pos1 !== "形状詞") return null;
    return pos2 === "タリ" ? "tari-keiyoudoushi" : "nari-keiyoudoushi";
  }
  if (!cType.startsWith("文語")) return null;
  const body = cType.slice(2);
  const graded = /^(四段|上二段|下二段)-(.)行(?:-一般)?$/.exec(body);
  if (graded) {
    const row = ROW_OF[graded[2]];
    if (!row) return null;
    const cls = `${FAMILY_OF[graded[1]]}-${row}`;
    return cls in CITATION_OKURIGANA_OF ? cls : null;
  }
  if (body.startsWith("上一段-")) return "kami-ichidan";
  if (body === "カ行変格") return "ka-hen";
  if (body === "サ行変格") return "sa-hen";
  if (body === "ナ行変格") return "na-hen";
  if (body === "ラ行変格") return "ra-hen";
  if (body === "形容詞-ク") return "ku-keiyoushi";
  if (body === "形容詞-シク") return "shiku-keiyoushi";
  return null;
}

const VOICED_TO_VOICELESS = {
  が: "か", ぎ: "き", ぐ: "く", げ: "け", ご: "こ",
  ざ: "さ", じ: "し", ず: "す", ぜ: "せ", ぞ: "そ",
  だ: "た", ぢ: "ち", づ: "つ", で: "て", ど: "と",
  ば: "は", び: "ひ", ぶ: "ふ", べ: "へ", ぼ: "ほ",
  ぱ: "は", ぴ: "ひ", ぷ: "ふ", ぺ: "へ", ぽ: "ほ",
};

const KANJI = "[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u{20000}-\\u{3ffff}]";
const KANA = "[\\u3041-\\u309f\\u30a0-\\u30ff\\u31f0-\\u31ff\\uff66-\\uff9f]";
const ONE_KANJI_PLUS_KANA = new RegExp(`^(${KANJI})(${KANA}*)$`, "u");

const katakanaToHiragana = (s) =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// --- ZIP and MeCab dictionary readers -------------------------------------
//
// Both are written out rather than pulled from a dependency for the same
// reason `build-verb-lexicon.mjs` uses only `node:zlib`: this is a dev-time
// script in a project with no build-time dictionary tooling, and both formats
// are small enough to read directly. The package ships *only* compiled MeCab
// binaries — NINJAL publishes no lex.csv for the classical variants — so
// there is no simpler route to the lexicon than parsing sys.dic.

/** Extracts one member from a ZIP archive held in memory. */
function unzipMember(buf, wanted) {
  // End of central directory: signature 0x06054b50, then 16 bytes to the
  // central-directory offset. Scanned backwards because a trailing comment may
  // follow it.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive (no end-of-central-directory record)");
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf-8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      // The local file header repeats the name and extra fields at its own
      // lengths, which need not match the central directory's.
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method} for ${wanted}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not found in archive`);
}

/** Reads a compiled MeCab system dictionary's tokens and feature strings.
 *
 * Layout: a 72-byte header (ten uint32s then a 32-byte charset name), a
 * double-array trie of `dsize` bytes, `lexsize` 16-byte tokens, then a blob of
 * NUL-terminated feature strings. The trie holds the surface forms and is
 * skipped entirely — UniDic's feature string already carries the 書字形基本形
 * this script keys on, so the surface adds nothing. */
function readMecabDictionary(dic) {
  const magic = dic.readUInt32LE(0);
  const lexsize = dic.readUInt32LE(12);
  const dsize = dic.readUInt32LE(24);
  const tsize = dic.readUInt32LE(28);
  const fsize = dic.readUInt32LE(32);
  const charset = dic.toString("utf-8", 40, 72).replace(/\0.*$/, "");
  if (charset.toUpperCase() !== "UTF-8") throw new Error(`unexpected dictionary charset ${charset}`);
  if (72 + dsize + tsize + fsize !== dic.length) {
    throw new Error(`sys.dic section sizes do not account for the file (magic ${magic})`);
  }
  const tokens = 72 + dsize;
  const features = tokens + tsize;
  const out = [];
  for (let i = 0; i < lexsize; i++) {
    const at = tokens + i * 16;
    const wcost = dic.readInt16LE(at + 6);
    const offset = features + dic.readUInt32LE(at + 8);
    let end = offset;
    while (dic[end] !== 0) end++;
    out.push({ wcost, feature: dic.toString("utf-8", offset, end) });
  }
  return out;
}

// UniDic 3.1's 29-column feature layout, of which this script wants five.
const POS1 = 0;
const POS2 = 1;
const C_TYPE = 4; // 活用型
const ORTH_BASE = 10; // 書字形基本形 — kanji + okurigana, citation form
const KANA_BASE = 21; // 仮名形基本形 — the same form in kana, historical where UniDic has it

export function buildIndex(rows) {
  const stats = {
    rows: rows.length,
    unmappedConjType: new Map(),
    notOneKanji: 0,
    orthographyDisagreesWithClass: 0,
    kanaDoesNotCoverOkurigana: 0,
    prefixTooLong: 0,
    rendakuShadow: 0,
  };
  /** @type {Map<string, Map<string, {sense: object, wcost: number}>>} */
  const byKanji = new Map();

  for (const { wcost, feature } of rows) {
    const f = feature.split(",");
    if (f.length < 22) continue;
    const pos1 = f[POS1];
    const pos2 = f[POS2];
    if (pos1 !== "動詞" && pos1 !== "形容詞" && pos1 !== "形状詞") continue;
    if (pos2 !== "一般" && pos2 !== "タリ" && pos2 !== "非自立可能") continue;

    const conjClass = conjClassOf(f[C_TYPE], pos1, pos2);
    if (conjClass === null) {
      const t = f[C_TYPE];
      if (t.startsWith("文語") && !t.startsWith("文語助動詞")) {
        stats.unmappedConjType.set(t, (stats.unmappedConjType.get(t) ?? 0) + 1);
      }
      continue;
    }

    // Filter 1: one kanji, then kana, and nothing else.
    const shape = ONE_KANJI_PLUS_KANA.exec(f[ORTH_BASE]);
    if (!shape) {
      stats.notOneKanji++;
      continue;
    }
    const [, kanji, okurigana] = shape;
    const suffix = CITATION_OKURIGANA_OF[conjClass];

    // Filter 2: the okurigana must end in the paradigm's own 終止形. Skipped
    // where the paradigm has none to test against (得, and the 形容動詞).
    if (suffix && !okurigana.endsWith(suffix)) {
      stats.orthographyDisagreesWithClass++;
      continue;
    }

    // The reading is the kana citation form minus the okurigana the kanji does
    // not cover — the same subtraction `build-verb-lexicon.mjs` performs
    // against a Wiktionary bungo table, against UniDic's 仮名形基本形 here.
    const kana = katakanaToHiragana(f[KANA_BASE]);
    if (!kana.endsWith(okurigana) || kana.length <= okurigana.length) {
      stats.kanaDoesNotCoverOkurigana++;
      continue;
    }
    const reading = kana.slice(0, kana.length - okurigana.length);
    const okuriganaPrefix = okurigana.slice(0, okurigana.length - suffix.length);

    // Filter 3: a prefix past one kana means a compound, not okurigana.
    if (okuriganaPrefix.length > 1) {
      stats.prefixTooLong++;
      continue;
    }

    const sense = { conjClass, reading };
    if (okuriganaPrefix) sense.okuriganaPrefix = okuriganaPrefix;
    const key = `${conjClass} ${reading} ${okuriganaPrefix}`;
    let senses = byKanji.get(kanji);
    if (!senses) byKanji.set(kanji, (senses = new Map()));
    const existing = senses.get(key);
    // One lexeme spreads over every inflected form it has, so a key is seen
    // many times; keep the cheapest cost MeCab assigned any of them.
    if (!existing) senses.set(key, { sense, wcost });
    else if (wcost < existing.wcost) existing.wcost = wcost;
  }

  // Filter 4: word-initial 連濁, only where the voiceless sibling is present
  // under the same kanji and class.
  const index = {};
  for (const kanji of [...byKanji.keys()].sort()) {
    const senses = byKanji.get(kanji);
    const kept = [];
    for (const [key, entry] of senses) {
      const { conjClass, reading, okuriganaPrefix = "" } = entry.sense;
      const voiceless = VOICED_TO_VOICELESS[reading[0]];
      if (voiceless) {
        const sibling = `${conjClass} ${voiceless}${reading.slice(1)} ${okuriganaPrefix}`;
        if (senses.has(sibling)) {
          stats.rendakuShadow++;
          continue;
        }
      }
      kept.push({ key, ...entry });
    }
    if (!kept.length) continue;
    // Cheapest first — MeCab's word cost is the closest thing this data has to
    // "which sense would a parser actually choose", and the key breaks ties so
    // a rebuild is byte-identical.
    kept.sort((a, b) => a.wcost - b.wcost || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    index[kanji] = kept.map((k) => k.sense);
  }
  return { index, stats };
}

async function main() {
  let zip;
  if (LOCAL_PATH) {
    console.log(`Reading ${LOCAL_PATH} ...`);
    zip = readFileSync(LOCAL_PATH);
  } else {
    console.log(`Fetching ${SOURCE_URL} (about 186 MB) ...`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    zip = Buffer.from(await res.arrayBuffer());
  }

  const rows = readMecabDictionary(unzipMember(zip, "sys.dic"));
  const { index, stats } = buildIndex(rows);

  const kanji = Object.keys(index).length;
  const senses = Object.values(index).reduce((n, s) => n + s.length, 0);
  const multi = Object.values(index).filter((s) => s.length > 1).length;
  console.log(`Read ${stats.rows} lexicon entries from sys.dic.`);
  console.log(
    `Refused: ${stats.notOneKanji} not one kanji plus kana, ` +
      `${stats.orthographyDisagreesWithClass} whose okurigana disagrees with their 活用型, ` +
      `${stats.kanaDoesNotCoverOkurigana} whose 仮名形 does not cover their okurigana, ` +
      `${stats.prefixTooLong} with an okurigana prefix past one kana, ` +
      `${stats.rendakuShadow} word-initial 連濁 shadowing a voiceless sibling.`,
  );
  for (const [t, n] of [...stats.unmappedConjType].sort((a, b) => b[1] - a[1])) {
    console.log(`  no ConjClass for 活用型 ${t} (${n} rows)`);
  }
  console.log(`${senses} senses over ${kanji} kanji; ${multi} kanji carry more than one.`);

  const json = JSON.stringify(index);
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1e3).toFixed(1)} KB)`);
  console.log("CC BY-NC-SA 4.0 — see public/data/LICENSE-UniDic.txt. Never merge into verb-lexicon-index.json.");
}

// Only when run as a script: `kogoLexicon.test.ts` imports the mapping table
// and the builder to assert against, and importing this module must not kick
// off a 186 MB download to do it.
if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
