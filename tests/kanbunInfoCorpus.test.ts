import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import type { Sentence } from "../src/parse/types.ts";

// ---------------------------------------------------------------------------
// The app read against kanbun.info's own 書き下し文, over the whole of that
// site's prose.
//
// **What is in it.** 3,419 passages over 9,085 sentences, taken from 831 pages
// — the 経部 (論語, 大学, 孝経), the 史部 (史記抄), the whole of the 子部 兵書
// (老子, 孫子, 呉子, 司馬法, 尉繚子, 李衛公問対, 六韜, 三略) and the 故事名言
// collection. The 集部 is excluded entire: 詩経, 楚辞, 二十四詩品, 唐詩選 and
// the poets are verse, and kundoku of verse is a different art this app is not
// aimed at. 624 of the passages carry a gold parse and 2,795 a parsed one.
//
// **Provenance, and why this suite measures against data that is not here.**
// The 白文 is ancient and out of copyright — 102,193 characters of it. The
// 書き下し文 beside it is *kanbun.info's own editorial rendering* (Web漢文大系),
// 178,468 characters, and that is one editor's work rather than anything this
// project may hand on. So the corpus is kept whole and kept **out of the
// repository**: `kanbun-info-passages.json` and `kanbun-info-parses.conllu`
// are in `.gitignore`, built locally by
// `scripts/build-kanbun-info-corpus.py`, and this suite **skips** where they
// are absent — which is what a fresh checkout, and anyone else's machine, will
// find. Skipped and not passed: a machine that measured nothing must not show
// a green tick as though it had.
//
// `kanbun-info-baseline.json` *is* committed, and is the exception on purpose.
// It holds our own measurements and nothing else — one integer per passage,
// keyed by the site's page slug — so it carries none of the fetched text, and
// without it a ratchet would start from whatever each checkout happened to
// measure, which is no ratchet at all.
//
// The parses come from two places: the Kyoto SUD treebank
// (`SUD_Classical_Chinese-Kyoto`, CC BY-SA) where it has the passage, and
// otherwise from the shipped `lzh_sud_kyoto` wheel.
//
// **This suite does not assert that the app matches the site, and must not.**
// Three separate reasons, and the design answers each one:
//
//  1. **Orthography.** The site prints 現代仮名遣い and 新字体 (いわく, 習う,
//     学びて); this app deliberately writes 歴史的仮名遣い on the characters the
//     source uses (いはく, 習ふ, 學びて). That is a difference of convention and
//     not of reading, so `folded` below normalises the axis away before
//     anything is measured. See its own comment for what it folds and what it
//     refuses to.
//
//  2. **The parser is wrong sometimes**, and the reader explicitly allows for
//     it. A difference caused by a bad parse is not this app's fault.
//
//  3. **The received reading is one editor's.** 慍らず/憤らず, 曰く/のたまはく,
//     and the choice of whether to read 而 at all are all legitimate variation,
//     and the site's own 語釈 says so in as many words for several of them.
//
// **So the measure is a ratchet, not an equality.** For each passage the
// baseline file records the distance measured when the passage was added, and
// the suite asserts the distance is exactly that. Worse fails, with the diff
// printed. **Better also fails**, with an instruction to lower the baseline —
// an improvement that is silently absorbed is an improvement nobody can point
// at later, and a ratchet that only tightens by hand is a ratchet whose
// numbers mean something.
//
//     KANBUN_INFO_BASELINE=write npx vitest run tests/kanbunInfoCorpus.test.ts
//
// rewrites the baseline. `KANBUN_INFO_CENSUS=1` additionally prints the count
// per work and tier and the ranked difference classes — the work queue — and
// the candidate variant pairs `SHINJITAI` below was frozen from.
// `KANBUN_INFO_SHOW=<id prefix>` prints those passages in full with their
// diffs, which is how a class in the census is traced back to a passage.
//
// **Two tiers, kept apart, and the split is the point.** A passage whose 白文
// is in the Kyoto treebank is read from the treebank's own annotation. That
// annotation is right by construction, so reason 2 above does not apply to it:
// every remaining difference on a gold passage is either this app's fault or
// editorial variation, and there is no third excuse. A passage the treebank
// does not have is run through the shipped parser, and its differences carry
// the parser's error as well as the app's. Merging the two into one score
// would let a parse error hide behind an app fault and the other way round, so
// nothing here ever adds them together.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, "fixtures");
const PASSAGES_PATH = join(FIXTURES, "kanbun-info-passages.json");
const PARSES_PATH = join(FIXTURES, "kanbun-info-parses.conllu");
const BASELINE_PATH = join(FIXTURES, "kanbun-info-baseline.json");

/** Printed by the skip when the corpus is not on this machine. */
const BUILD_COMMAND =
  "python3 scripts/build-kanbun-info-corpus.py fetch && " +
  "python3 scripts/build-kanbun-info-corpus.py extract && " +
  "python3 scripts/build-kanbun-info-corpus.py parse";

interface Passage {
  id: string;
  work: string;
  title: string;
  page: string;
  han: string;
  yomi: string;
  tier: "gold" | "parser";
  source: string;
  sentences: number;
}

interface Measured extends Passage {
  /** What the app actually wrote, in its own orthography. */
  raw: string;
  /** The two texts as the distance sees them — `folded` applied to `yomi` and
   * to `raw`. */
  received: string;
  produced: string;
  distance: number;
}

// ---------------------------------------------------------------------------
// The orthographic fold, which is the one thing here that has to be got right:
// everything it fails to fold shows up as a difference this app does not have,
// and everything it over-folds is a real difference nobody will ever see.
// ---------------------------------------------------------------------------

/** 歴史的仮名遣い writes 促音 and 拗音 full size. Folded the other way — small
 * to large — so that the fold runs in the many-to-one direction on *both*
 * strings: しょう and しよう both become しよう, and no guess is made about
 * which of けう/きやう/きよう a modern きょう came from. */
const SMALL_TO_LARGE: Record<string, string> = {
  っ: "つ", ゃ: "や", ゅ: "ゆ", ょ: "よ", ぁ: "あ", ぃ: "い", ぅ: "う", ぇ: "え", ぉ: "お", ゎ: "わ",
  ッ: "ツ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ",
};

/** ハ行転呼, the ワ行 merger and 四つ仮名 — the three regular changes that turn
 * a historical spelling into a modern one, and the only three that can be
 * applied without knowing the word. Applied from index 1 onward because
 * ハ行転呼 is a word-*medial* change; in running prose almost everything is
 * medial, so this is nearly total, and that is fine in this direction: it is
 * applied to the site's string as well, so a は the site writes and a は this
 * app writes still agree. */
const MEDIAL_MERGERS: Record<string, string> = {
  は: "わ", ひ: "い", ふ: "う", へ: "え", ほ: "お",
  ゐ: "い", ゑ: "え", を: "お", ぢ: "じ", づ: "ず",
};

/** 開合 and the -u fusions: あう→おう, えう→よう, いう→ゆう. A long vowel's
 * historical spelling is a lexical fact and this is the one direction that is
 * a function rather than a guess — 「まうす」 and 「もうす」 both land on もうす.
 * Written as one table over the *first* kana of the digraph, applied only when
 * the next kana is う and only after `MEDIAL_MERGERS` has run, so 「たまふ」 has
 * already become 「たまう」 by the time 「まう」 is looked at. */
const A_ROW_TO_O_ROW: Record<string, string> = {
  か: "こ", が: "ご", さ: "そ", ざ: "ぞ", た: "と", だ: "ど", な: "の", ば: "ぼ", ぱ: "ぽ",
  ま: "も", や: "よ", ら: "ろ", あ: "お",
};
const E_ROW_TO_I_ROW: Record<string, string> = {
  け: "き", げ: "ぎ", せ: "し", ぜ: "じ", て: "ち", で: "ぢ", ね: "に", べ: "び", ぺ: "ぴ",
  め: "み", れ: "り", え: "い",
};
const I_ROW = new Set("きぎしじちにびぴみり");

const HAN = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{20000}-\u{2FFFF}]/u;

/** 新字体 for 舊字體, one character for one, as kanbun.info's 書き下し文 writes
 * them against the 白文 it prints beside them.
 *
 * **Counted, not assumed.** Every pair below was mined from this corpus's own
 * differences under the rule: the app writes A where the site writes B, A
 * stands in that passage's 白文 and B does not, and the pair recurs across at
 * least three separate passages. That rule cannot pick up a *semantic*
 * substitution (the app never chooses a character — it prints the one the
 * source has), and each pair was then read once by eye. The number after each
 * is the count of distinct passages the pair was found in.
 *
 * Deliberately not derived from JMdict's alternative spellings, which was
 * tried first: same-reading same-gloss headword pairs give 6,928 candidates
 * and the top of that list is 目/眼, 食/喰, 型/形 — synonyms sharing a reading,
 * not graphs sharing a character. Folding those would erase real differences. */
const SHINJITAI: Record<string, string> = {
  // Found in 3 or more passages each, 爲/為 in 73 of them.
  爲: "為", 學: "学", 禮: "礼", 德: "徳", 國: "国", 從: "従", 樂: "楽", 齊: "斉", 惡: "悪",
  與: "与", 顏: "顔", 脩: "修", 亂: "乱", 盡: "尽", 爭: "争", 觀: "観", 衞: "衛", 傳: "伝",
  乘: "乗", 歸: "帰", 愼: "慎", 舉: "挙", 遲: "遅", 勞: "労", 對: "対", 寢: "寝", 聽: "聴",
  隱: "隠", 稱: "称", 繼: "継", 獨: "独", 發: "発", 竊: "窃", 辭: "辞", 說: "説", 處: "処",
  廢: "廃", 黨: "党", 舊: "旧", 黃: "黄", 數: "数", 餘: "余", 閒: "間", 經: "経", 戰: "戦",
  祿: "禄", 來: "来", 讓: "譲", 惠: "恵", 拜: "拝",
  // In 2 passages each.
  沒: "没", 實: "実", 釋: "釈", 卽: "即", 體: "体", 藏: "蔵", 寶: "宝", 恆: "恒", 獻: "献",
  雞: "鶏", 擇: "択", 曾: "曽", 萬: "万", 陷: "陥", 儉: "倹", 關: "関", 鄰: "隣", 產: "産",
  輕: "軽", 舍: "舎", 飮: "飲", 戶: "戸", 氣: "気", 莊: "荘", 靈: "霊", 聲: "声",
  // Once each, and taken only where the pair is a 常用漢字表 新旧字体 correspondence
  // or an established 異体字 — the once-only band is where the mining rule's
  // noise lives (義/当, 者/択, 難/与 all appeared twice and are alignment
  // artefacts, not variants; they are not here).
  聰: "聡", 旣: "既", 賴: "頼", 廣: "広", 巖: "巌", 拂: "払", 條: "条", 冰: "氷", 續: "続",
  嚴: "厳", 勸: "勧", 繪: "絵", 攝: "摂", 懷: "懐", 參: "参", 臺: "台", 徑: "径", 變: "変",
  濟: "済", 默: "黙", 擧: "挙", 絕: "絶", 兩: "両", 晝: "昼", 醬: "醤", 藥: "薬", 廏: "厩",
  踐: "践", 讀: "読", 盜: "盗", 會: "会", 證: "証", 醫: "医", 晉: "晋", 淺: "浅", 總: "総",
  壤: "壌", 將: "将", 蠻: "蛮", 卷: "巻", 羣: "群", 龜: "亀", 當: "当", 佛: "仏", 獸: "獣",
  稻: "稲", 亞: "亜", 溫: "温", 號: "号", 弦: "絃", 餧: "餒",
  // A second mining pass over the finished corpus, which is four times the size
  // the first was run on and is where the 兵書 live. Same rule, same 3-passage
  // floor for the first block and 2 for the second.
  權: "権", 穰: "穣", 壘: "塁", 險: "険", 澤: "沢", 圍: "囲", 擊: "撃", 專: "専", 應: "応",
  隨: "随", 圖: "図", 單: "単", 屬: "属", 徃: "往", 靜: "静", 壯: "壮", 豫: "予", 營: "営",
  顯: "顕", 壞: "壊", 殘: "残", 狹: "狭", 拔: "抜", 雜: "雑", 霸: "覇", 嶽: "岳", 皋: "皐",
  獵: "猟", 龍: "竜", 榮: "栄", 縱: "縦", 丗: "世", 鐵: "鉄", 據: "拠", 筭: "算", 邊: "辺",
  籠: "篭", 燒: "焼", 效: "効", 勵: "励", 假: "仮", 肅: "粛", 豐: "豊", 斷: "断",
  壽: "寿", 歷: "歴", 畱: "留", 騷: "騒", 兔: "兎", 畫: "画", 壓: "圧", 粮: "糧", 搖: "揺",
  驅: "駆", 挾: "挟", 吳: "呉", 辯: "弁", 轉: "転", 驗: "験", 覽: "覧", 樓: "楼", 滿: "満",
  讎: "讐", 賣: "売", 圓: "円", 聮: "聯", 囊: "嚢", 卻: "却",
  // 陳 for 陣, in 35 passages and all of them 兵書. Not a graph simplification
  // but a 通用字 the editor normalises throughout — 陳 is the older way of
  // writing the battle-formation word, and every occurrence here is that word.
  // Folded on that reading, which is a judgement and is flagged as one: if the
  // reader would rather see 陳/陣 counted as a difference, this is the line to
  // delete.
  陳: "陣",
};

/** Both strings, brought into one orthography before anything is measured. */
export function folded(s: string): string {
  const chars = [...s];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i];
    c = SMALL_TO_LARGE[c] ?? c;
    if (out.length > 0) c = MEDIAL_MERGERS[c] ?? c;
    c = SHINJITAI[c] ?? c;
    out.push(c);
  }
  // The -u fusions, in a second pass so that they see the post-merger string.
  const fused: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (out[i + 1] === "う") {
      if (A_ROW_TO_O_ROW[c]) { fused.push(A_ROW_TO_O_ROW[c]); continue; }
      if (E_ROW_TO_I_ROW[c]) { fused.push(E_ROW_TO_I_ROW[c], "よ"); continue; }
      if (I_ROW.has(c)) { fused.push(c, "ゆ"); continue; }
    }
    fused.push(c);
  }
  return fused.join("")
    // Punctuation the two sides simply spell differently. 、 and ， divide a
    // sentence and 。 and ． end one; nothing about a reading turns on which
    // glyph either is written with.
    .replace(/[，]/g, "、")
    .replace(/[．]/g, "。");
}

// ---------------------------------------------------------------------------
// The distance.
//
// **Character-level Levenshtein over the folded strings**, and the choice is
// not arbitrary. 書き下し文 is written without word boundaries, and the
// disagreements between this app and the site are overwhelmingly *inside* a
// word: one kana of okurigana (讀む/讀みて), a particle present or absent, a
// 終止形 where the site has a 連体形. A word-level measure would need a
// Japanese tokenizer this repository does not have and would score a
// one-kana ending difference the same as a wholly different verb. A character
// distance needs no tokenizer, is a true metric so two passages' figures are
// comparable, and counts in the unit the differences actually occur in.
//
// Reported alongside its rate — edits over the length of the received reading
// — because 3 edits in a 12-character passage and 3 in a 200-character one are
// not the same news.
// ---------------------------------------------------------------------------

function distance(a: string, b: string): number {
  const A = [...a], B = [...b];
  let prev = new Int32Array(B.length + 1);
  let cur = new Int32Array(B.length + 1);
  for (let j = 0; j <= B.length; j++) prev[j] = j;
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[B.length];
}

interface Edit { kind: "sub" | "ins" | "del"; site: string; app: string; at: number }

/** The same distance, with its backtrace, so a failure can print what changed
 * rather than a number that went from 41 to 43. Runs the full matrix, so it is
 * called only when a passage is being reported on. */
function edits(site: string, app: string): Edit[] {
  const A = [...site], B = [...app];
  const w = B.length + 1;
  const d = new Int32Array((A.length + 1) * w);
  for (let j = 0; j <= B.length; j++) d[j] = j;
  for (let i = 1; i <= A.length; i++) {
    d[i * w] = i;
    for (let j = 1; j <= B.length; j++) {
      d[i * w + j] = Math.min(
        d[(i - 1) * w + j] + 1,
        d[i * w + j - 1] + 1,
        d[(i - 1) * w + j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1),
      );
    }
  }
  const out: Edit[] = [];
  let i = A.length, j = B.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * w + j] === d[(i - 1) * w + j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)) {
      if (A[i - 1] !== B[j - 1]) out.push({ kind: "sub", site: A[i - 1], app: B[j - 1], at: i - 1 });
      i--; j--;
    } else if (j > 0 && d[i * w + j] === d[i * w + j - 1] + 1) {
      out.push({ kind: "ins", site: "", app: B[j - 1], at: i });
      j--;
    } else {
      out.push({ kind: "del", site: A[i - 1], app: "", at: i - 1 });
      i--;
    }
  }
  return out.reverse();
}

/** Adjacent edits gathered into one run. A verb ending that changed by three
 * kana is one disagreement, not three, and the census counts disagreements. */
function runsOf(site: string, app: string): { site: string; app: string; at: number }[] {
  const runs: { site: string; app: string; at: number }[] = [];
  for (const e of edits(site, app)) {
    const last = runs[runs.length - 1];
    if (last && e.at <= last.at + last.site.length) {
      last.site += e.site;
      last.app += e.app;
    } else {
      runs.push({ site: e.site, app: e.app, at: e.at });
    }
  }
  return runs;
}

/** What a passage's disagreement looks like, so a failure says what moved
 * rather than only by how much.
 *
 * Both texts are printed as they are actually written — the received one in
 * 現代仮名遣い and the app's in 歴史的仮名遣い — because that is what a reader
 * can check against the page. The runs beneath are in the *normalised*
 * orthography the distance is measured in, which is why they read oddly (を
 * folds to お and 學 to 学 there); they are positions in the measurement, not
 * quotations of either text. */
function showDiff(m: Measured): string {
  const shown = runsOf(m.received, m.produced).map((r) => {
    const before = m.received.slice(Math.max(0, r.at - 4), r.at);
    return `…${before}[受 ${r.site || "∅"} / 本 ${r.app || "∅"}]…`;
  });
  return [
    `\n      受: ${m.yomi}`,
    `      本: ${m.raw}`,
    `      ${shown.join("\n      ")}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The corpus is built locally and is not in the repository. See the header.
// ---------------------------------------------------------------------------

if (existsSync(PASSAGES_PATH) && existsSync(PARSES_PATH)) {
  measureAgainstTheReceivedReading();
} else {
  describe("the kanbun.info corpus", () => {
    // Skipped, not passed and not failed. A machine without the corpus has
    // measured nothing, and a green tick would say it had.
    it.skip(`is not built on this machine — build it with: ${BUILD_COMMAND}`, () => {});
  });
}

/** Everything that touches a fixture. Declared rather than inlined so that the
 * guard above can decline to call it, and so that a checkout without the
 * corpus loads no index and reads no file. */
function measureAgainstTheReceivedReading(): void {
  const DATA = join(import.meta.dirname, "..", "public", "data");
  const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA, file), "utf-8")) as T;

  const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
  const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
  const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  const passages: Passage[] = JSON.parse(
    readFileSync(join(FIXTURES, "kanbun-info-passages.json"), "utf-8"),
  ).passages;

  /** The parses, split back into passages. `parseConllu` drops comment lines, so
   * the `# passage =` markers have to be honoured here rather than by it. */
  const parsesById = new Map<string, Sentence[]>();
  {
    const raw = readFileSync(join(FIXTURES, "kanbun-info-parses.conllu"), "utf-8");
    for (const chunk of raw.split(/(?=^# passage = )/m)) {
      const id = /^# passage = (.+)$/m.exec(chunk)?.[1];
      if (!id) continue;
      parsesById.set(id, parseConllu(chunk).sentences);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering, through the panels' own call shape.
  // ---------------------------------------------------------------------------

  function render(id: string): string {
    const sentences = parsesById.get(id);
    if (!sentences) throw new Error(`no parse fixture for ${id}`);
    return generateKakikudashiForTree(
      { sentences, source: "conllu" },
      // The two-argument `findCompoundSpans`. The one-argument form sees no
      // lexical-word span at all and renders a different app.
      (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
      resolve,
    );
  }

  const measured: Measured[] = passages.map((p) => {
    const raw = render(p.id);
    const received = folded(p.yomi);
    const produced = folded(raw);
    return { ...p, raw, received, produced, distance: distance(received, produced) };
  });

  // ---------------------------------------------------------------------------
  // The ratchet.
  // ---------------------------------------------------------------------------


  if (process.env.KANBUN_INFO_BASELINE === "write") {
    const out: Record<string, number> = {};
    for (const m of measured) out[m.id] = m.distance;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 1)}\n`);
  }

  const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

  const works = [...new Set(measured.map((m) => `${m.tier} ${m.work}`))].sort();

  for (const key of works) {
    const [tier, work] = key.split(" ");
    const group = measured.filter((m) => m.tier === tier && m.work === work);
    const total = group.reduce((n, m) => n + m.distance, 0);
    const chars = group.reduce((n, m) => n + [...m.received].length, 0);

    describe(`${work} — ${tier} parses (${group.length} passages, ${chars} received characters, ${total} edits)`, () => {
      it("is no further from the received reading than it was", () => {
        const worse: string[] = [];
        const better: string[] = [];
        for (const m of group) {
          const was = baseline[m.id];
          expect(was, `${m.id} has no baseline — run with KANBUN_INFO_BASELINE=write`).toBeTypeOf("number");
          if (m.distance > was) {
            worse.push(`  ${m.id} (${m.title}) ${was} → ${m.distance}${showDiff(m)}`);
          } else if (m.distance < was) {
            better.push(`  ${m.id} (${m.title}) ${was} → ${m.distance}`);
          }
        }
        const report: string[] = [];
        if (worse.length > 0) {
          report.push(`${worse.length} passage(s) read further from the received text than before:`, ...worse);
        }
        if (better.length > 0) {
          report.push(
            `${better.length} passage(s) read closer than the baseline records — this is an improvement,`,
            "and the baseline has to be lowered so that it stays one:",
            "  KANBUN_INFO_BASELINE=write npx vitest run tests/kanbunInfoCorpus.test.ts",
            ...better,
          );
        }
        expect(report.join("\n")).toBe("");
      });
    });
  }

  // ---------------------------------------------------------------------------
  // The census. Not an assertion — a standing count of what the two texts
  // disagree about, ranked, which is the work queue the ratchet exists to
  // protect. Printed under KANBUN_INFO_CENSUS=1.
  // ---------------------------------------------------------------------------

  describe("the corpus itself", () => {
    it("shows the passages KANBUN_INFO_SHOW names", () => {
      const want = process.env.KANBUN_INFO_SHOW;
      if (!want) return;
      for (const m of measured.filter((x) => x.id.startsWith(want)).slice(0, 12)) {
        console.log(`\n${m.id} ${m.work} ${m.title} [${m.tier}] ${m.distance}\n  白: ${m.han}${showDiff(m)}`);
      }
    });

    it("has a parse for every passage and a passage for every parse", () => {
      expect(passages.map((p) => p.id).sort()).toEqual([...parsesById.keys()].sort());
    });

    it("counts its two tiers", () => {
      const gold = measured.filter((m) => m.tier === "gold");
      const parser = measured.filter((m) => m.tier === "parser");
      expect(gold.length + parser.length).toBe(measured.length);
      if (process.env.KANBUN_INFO_CENSUS) {
        const rate = (g: Measured[]): string => {
          const d = g.reduce((n, m) => n + m.distance, 0);
          const c = g.reduce((n, m) => n + [...m.received].length, 0);
          return `${String(g.length).padStart(5)}p ${String(c).padStart(7)}ch ${String(d).padStart(6)}ed  ${(100 * d / c).toFixed(1)}%`;
        };
        const rows: string[] = [];
        for (const tier of ["gold", "parser"] as const) {
          const t = measured.filter((m) => m.tier === tier);
          rows.push(`${tier.padEnd(8)} ALL          ${rate(t)}`);
          for (const work of [...new Set(t.map((m) => m.work))].sort()) {
            rows.push(`${tier.padEnd(8)} ${work.padEnd(12)} ${rate(t.filter((m) => m.work === work))}`);
          }
        }
        console.log(`\nper work and tier (passages, received characters, edits, edit rate):\n${rows.join("\n")}`);

        const classes = new Map<string, { n: number; where: Set<string> }>();
        for (const m of measured) {
          for (const r of runsOf(m.received, m.produced)) {
            const key = `${m.tier.padEnd(6)} 受「${r.site || "∅"}」 本「${r.app || "∅"}」`;
            const seen = classes.get(key) ?? { n: 0, where: new Set<string>() };
            seen.n++;
            seen.where.add(m.id);
            classes.set(key, seen);
          }
        }
        const ranked = [...classes].sort((a, b) => b[1].n - a[1].n).slice(0, 150);
        console.log(
          `\nranked difference classes (occurrences, passages):\n` +
          [...ranked.map(([k, v]) => `${String(v.n).padStart(5)}  ${v.where.size.toString().padStart(4)}p  ${k}`)].join("\n"),
        );

        // The mining rule `SHINJITAI` is kept by. A substitution qualifies as a
        // candidate graphic variant when the character this app printed stands
        // in the passage's own 白文 and the one the site printed does not — the
        // app never *chooses* a character, so a pair meeting that test is the
        // site rewriting the source's graph rather than the two disagreeing
        // about a word. Reported, never applied: the table is frozen by eye.
        const variants = new Map<string, Set<string>>();
        for (const m of measured) {
          for (const e of edits(m.received, m.produced)) {
            if (e.kind !== "sub") continue;
            if (!HAN.test(e.site) || !HAN.test(e.app)) continue;
            if (!m.han.includes(e.app) || m.han.includes(e.site)) continue;
            const key = `${e.app} → ${e.site}`;
            variants.set(key, (variants.get(key) ?? new Set()).add(m.id));
          }
        }
        console.log(
          "\ncandidate 新字体 pairs (本 → 受), passages:\n" +
            [...variants]
              .filter(([, w]) => w.size >= 3)
              .sort((a, b) => b[1].size - a[1].size)
              .map(([k, w]) => `  ${k}  ${w.size}`)
              .join("\n"),
        );
      }
    });
  });

}
