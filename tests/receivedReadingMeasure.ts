// ---------------------------------------------------------------------------
// The measure two suites share: the orthographic fold, the character distance
// over it, and the backtrace that says what moved.
//
// **Why it is a module and not a copy.** `tests/kanbunInfoCorpus.test.ts`
// measures this app against kanbun.info's 3,419 passages;
// `tests/shuuhiPrefaceGoldReading.test.ts` measures it against one verified
// reading of 趙爽's preface to the 周髀算經. Two ratchets whose numbers get
// quoted beside each other have to be measured on one scale, and a second copy
// of a 200-line 新字体 table is a scale that drifts. Neither suite may import
// the other: both register their suites at the top level, so importing one
// into the other would run its whole measurement as a side effect.
//
// This file is deliberately not named `*.test.ts`, so vitest's `include`
// (`tests/**/*.test.ts`) does not collect it.
//
// The prose below was written for the corpus suite and is moved here unchanged.
// It speaks of "the site" throughout, because kanbun.info is the comparison it
// was written for.
// What it says about *how* the fold works holds for any received reading; what
// it says about which axes a given comparison needs folded does not, and the
// 周髀 suite settles that question in its own header.
// ---------------------------------------------------------------------------

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

export const HAN = /[\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{20000}-\u{2FFFF}]/u;

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
    .replace(/[．]/g, "。")
    // **The quotation marks, deleted from both sides, and the one exclusion in
    // this table that is not orthographic.** See `QUOTATION_MARKS`.
    .replace(QUOTATION_MARKS, "")
    // **And the two dividing marks folded into one**, which is the same
    // exclusion continued. See `QUOTATION_MARKS`' third paragraph.
    .replace(/[。]/g, "、");
}

/** 「」『』 and the ： that introduces a quotation — **struck out of both
 * strings before anything is measured**, and the one thing this fold removes
 * that is not a difference of orthography.
 *
 * **They are two editions' source text differing, not two readings differing.**
 * The 白文 this app is handed for a gold passage is the Kyoto treebank's, which
 * punctuates reported speech 子曰：「…」; the 白文 kanbun.info prints beside its
 * own 書き下し文 is 子曰、…, with no quotation marks anywhere in it. Both are
 * editorial punctuation of an ancient text that carried none. The app prints
 * the marks its source gives it, faithfully, and was charged **479** edits for
 * the 「, **181** for the 」, **34** more and **21** for the 『 — on the gold
 * tier alone, 4.9% of its whole distance — for printing a character the other
 * edition's source does not contain. That is not a reading this app got wrong;
 * it is the two texts being punctuated by different editors.
 *
 * **Struck from both sides, not from ours.** kanbun.info writes 「」 44 times
 * and 『』 25 in its own 書き下し文 where its editor chose to, so a one-sided
 * deletion would have started charging us for *not* printing them there.
 *
 * **The ： goes with them**, being the same editor's mark for the same thing:
 * the treebank writes 子曰：「, and `punctuation.ts` turns that ： into the 、
 * after 曰はく. It stands 39 times in the received reading and never in either
 * 白文.
 *
 * **And 。 is folded into 、, which is this exclusion's own consequence.** A
 * quotation in the treebank's punctuation frequently spans several sentences —
 * 曰：「甲。乙。」 — and the app writes the inner 。 as a medial 、, because the
 * sentence has not ended. Strike the brackets and that 、 is left standing
 * against the site's 。 with nothing to explain it: **188** edits on the gold
 * tier, and **24** the other way. Both marks divide; which of the two an editor
 * writes is a convention, exactly as ，-against-、 and ．-against-。 are, and the
 * two lines above already forgive those. Folding them to one glyph forgives the
 * *substitution* only — a mark present on one side and absent on the other is
 * an insertion or a deletion and is still counted, which is what keeps the 147
 * gold edits where the app writes no mark at all visible.
 *
 * **What is NOT excluded: the と.** A quotation this app reads closes with a
 * quotative と — 子曰く、「…」と — and that と is the app's own reading decision,
 * not its source's punctuation. It stays counted, and it is why the 181-edit
 * run above reads 受「∅」本「」と」 rather than 受「∅」本「」」: only the bracket
 * comes out of it.
 *
 * **So the figure this suite reports is not a like-for-like character
 * comparison of the two texts**, and must not be quoted as one. It is the
 * distance between them *after* four orthographic axes and one punctuational
 * one have been normalised away — 歴史的仮名遣い against 現代仮名遣い, 舊字體
 * against 新字体, the three mark-glyph pairs, and the quotation marks and the
 * mark division that follow from them. Everything else the two texts disagree
 * about is in the number. The gold tier read **14,478** edits (45.3%) under the
 * fold without this exclusion and **12,810** (40.1%) with it; the parser tier
 * read 71,568 (48.9%) and 71,292 (48.7%), the difference being small there
 * because kanbun.info's own 白文 is what those passages are parsed from and it
 * brackets nothing. The two columns are measurements of different things and
 * neither is comparable to the other. */
const QUOTATION_MARKS = /[「」『』：]/g;

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

export function distance(a: string, b: string): number {
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

export interface Edit { kind: "sub" | "ins" | "del"; site: string; app: string; at: number }

/** The same distance, with its backtrace, so a failure can print what changed
 * rather than a number that went from 41 to 43. Runs the full matrix, so it is
 * called only when a passage is being reported on. */
export function edits(site: string, app: string): Edit[] {
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
export function runsOf(site: string, app: string): { site: string; app: string; at: number }[] {
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

