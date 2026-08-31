/** Classical Japanese (文語) conjugation paradigms.
 *
 * These produce *okurigana only* — the kana that follows the kanji in the
 * written form, per standard okurigana convention (e.g. 学ぶ: kanji 学
 * covers the reading "まな", and okurigana is just "ぶ"/"び"/"ば" etc.; the
 * reading itself is never written out in 書き下し文, only used for the
 * kundoku panel's furigana). Each paradigm entry is therefore a bare
 * suffix, meant to be appended directly to the token's own kanji text —
 * `verbLexicon.ts` supplies which class/row applies per word, not a stem.
 *
 * Historical kana usage (歴史的仮名遣い) is authored directly into the
 * suffix tables below (は/ひ/ふ/へ/ほ rows, not わ/い/う/え/お) rather than
 * derived by converting modern spelling — a general modern-to-historical
 * kana converter isn't reliably deterministic (the same modern kana can
 * come from different historical sources), so correctness here is a
 * data-authoring concern, verified per word in `verbLexicon.ts`. */

export type ConjClass =
  | "yodan-ka"
  | "yodan-ga"
  | "yodan-sa"
  | "yodan-ta"
  | "yodan-na"
  | "yodan-ba"
  | "yodan-ma"
  | "yodan-ra"
  | "yodan-ha" // historical は行四段 (讀む-type verbs whose modern reflex is わ行五段, e.g. 習ふ)
  | "kami-nidan-ka" // 上二段カ行 (起く)
  | "kami-nidan-ga" // 上二段ガ行 (過ぐ)
  | "kami-nidan-ta" // 上二段タ行 (落つ)
  | "kami-nidan-da" // 上二段ダ行 (恥づ — modern 恥じる, whose じ is this ぢ)
  | "kami-nidan-ha" // 上二段ハ行 (生ふ/強ふ — modern 生いる/強いる)
  | "kami-nidan-ba" // 上二段バ行 (綻ぶ)
  | "kami-nidan-ma" // 上二段マ行 (慍む)
  | "kami-nidan-ya" // 上二段ヤ行 (老ゆ/悔ゆ/報ゆ — modern 老いる/悔いる/報いる)
  | "kami-nidan-ra" // 上二段ラ行 (懲る)
  | "shimo-nidan-a" // 下二段ア行 (得)
  | "shimo-nidan-ka" // 下二段カ行 (別く)
  | "shimo-nidan-ga" // 下二段ガ行 (上ぐ)
  | "shimo-nidan-sa" // 下二段サ行 (寄す)
  | "shimo-nidan-za" // 下二段ザ行 (混ず)
  | "shimo-nidan-ta" // 下二段タ行 (立つ — the *transitive* 立, modern 立てる)
  | "shimo-nidan-da" // 下二段ダ行 (出づ)
  | "shimo-nidan-na" // 下二段ナ行 (尋ぬ)
  | "shimo-nidan-ha" // 下二段ハ行 (與ふ)
  | "shimo-nidan-ba" // 下二段バ行 (述ぶ)
  | "shimo-nidan-ma" // 下二段マ行 (求む)
  | "shimo-nidan-ya" // 下二段ヤ行 (肥ゆ/見ゆ/生ゆ — modern 肥える/見える/生える)
  | "shimo-nidan-ra" // 下二段ラ行 (恐る)
  | "shimo-nidan-wa" // 下二段ワ行 (植う/飢う/据う — modern 植える/飢える/据える)
  | "kami-ichidan" // 上一段 (見る/着る/居る — a small closed class; unlike the
                    // nidan families, the row's consonant never surfaces in
                    // the suffix itself (mizen/renyou are the bare kanji
                    // with nothing appended — 見ず, not 見みず), so one
                    // shape covers every row, with the row's own vowel
                    // supplied by the kanji's ordinary kun'yomi reading)
  | "ka-hen" // カ行変格 (来— the bare "く" reading, as opposed to the lexicalized yodan-ra 来たる)
  | "sa-hen" // サ行変格 (為/す)
  | "na-hen" // ナ行変格 (死ぬ/往ぬ)
  | "ra-hen" // ラ行変格 (あり/をり/はべり)
  | "ku-keiyoushi" // ク活用形容詞 (modern -i, not -shii: 高し)
  | "shiku-keiyoushi" // シク活用形容詞 (modern -shii: 楽し/悲し/美し)
  | "nari-keiyoudoushi" // ナリ活用形容動詞
  | "tari-keiyoudoushi"; // タリ活用形容動詞

export type ConjForm = "mizen" | "mizenKar" | "renyou" | "shuushi" | "rentai" | "izen" | "meirei";

type Paradigm = Partial<Record<ConjForm, string>>;

function yodanRow(row: [string, string, string, string, string, string]): Paradigm {
  const [a, i, u, , e] = row;
  return { mizen: a, renyou: i, shuushi: u, rentai: u, izen: e, meirei: e };
}

/** 上二段: mizen and renyou coincide on the row's i-sound, shuushi/rentai on
 * the u-sound — this is exactly why 慍みず (mizen=renyou="み") is correct
 * while a modern-godan-shaped guess (which would derive mizen "慍ま" from
 * the -mu ending) is not. */
function kaminidanRow(i: string, u: string): Paradigm {
  return { mizen: i, renyou: i, shuushi: u, rentai: u + "る", izen: u + "れ", meirei: i + "よ" };
}

/** 下二段: the same shape one grade down — mizen and renyou coincide on the
 * row's *e*-sound where 上二段 has its i-sound, shuushi/rentai on the same
 * u-sound.
 *
 * The e-sound mizen/renyou is the whole reason this family has to be
 * distinguished from 四段 at all rather than left to the reading's own
 * ending: transitive 立 is 下二段タ行, so its renyoukei is 立て (廟を立てて),
 * while the intransitive 立 that shares the very same 終止形 立つ is 四段タ行
 * and gives 立ち (廟立ちて). A form derived from the citation form alone
 * cannot tell those apart — only the class can. */
function shimonidanRow(e: string, u: string): Paradigm {
  return { mizen: e, renyou: e, shuushi: u, rentai: u + "る", izen: u + "れ", meirei: e + "よ" };
}

const PARADIGMS: Record<ConjClass, Paradigm> = {
  "yodan-ka": yodanRow(["か", "き", "く", "く", "け", "け"]),
  "yodan-ga": yodanRow(["が", "ぎ", "ぐ", "ぐ", "げ", "げ"]),
  "yodan-sa": yodanRow(["さ", "し", "す", "す", "せ", "せ"]),
  "yodan-ta": yodanRow(["た", "ち", "つ", "つ", "て", "て"]),
  "yodan-na": yodanRow(["な", "に", "ぬ", "ぬ", "ね", "ね"]),
  "yodan-ba": yodanRow(["ば", "び", "ぶ", "ぶ", "べ", "べ"]),
  "yodan-ma": yodanRow(["ま", "み", "む", "む", "め", "め"]),
  "yodan-ra": yodanRow(["ら", "り", "る", "る", "れ", "れ"]),
  "yodan-ha": yodanRow(["は", "ひ", "ふ", "ふ", "へ", "へ"]),

  "kami-nidan-ka": kaminidanRow("き", "く"),
  "kami-nidan-ga": kaminidanRow("ぎ", "ぐ"),
  "kami-nidan-ta": kaminidanRow("ち", "つ"),
  // ぢ/づ, not じ/ず — 恥づ's modern 恥じる spells the same mora じ because
  // 四つ仮名 merged ぢ into じ, not because the row is ザ行. Authored
  // historically here as every row in this file is.
  "kami-nidan-da": kaminidanRow("ぢ", "づ"),
  "kami-nidan-ha": kaminidanRow("ひ", "ふ"),
  "kami-nidan-ba": kaminidanRow("び", "ぶ"),
  "kami-nidan-ma": kaminidanRow("み", "む"),
  // ヤ行上二段, the 上 grade of the ヤ行 row below: い/ゆ where 下二段 has え/ゆ.
  // 老ゆ/悔ゆ/報ゆ, whose modern reflexes 老いる/悔いる/報いる are 上一段.
  "kami-nidan-ya": kaminidanRow("い", "ゆ"),
  "kami-nidan-ra": kaminidanRow("り", "る"),
  // ア行下二段 (得 — the row has no consonant of its own, so unlike every
  // other nidan row, even the terminative "u" mora is already fully
  // represented by the kanji's own reading, not written out as separate
  // okurigana: 得ず/得/得るる (mizen/shuushi/rentai), never 得えず/得う.
  "shimo-nidan-a": { mizen: "", renyou: "", shuushi: "", rentai: "る", izen: "れ", meirei: "よ" },
  "shimo-nidan-ka": shimonidanRow("け", "く"),
  "shimo-nidan-ga": shimonidanRow("げ", "ぐ"),
  "shimo-nidan-sa": shimonidanRow("せ", "す"),
  "shimo-nidan-za": shimonidanRow("ぜ", "ず"),
  "shimo-nidan-ta": shimonidanRow("て", "つ"),
  "shimo-nidan-da": shimonidanRow("で", "づ"),
  "shimo-nidan-na": shimonidanRow("ね", "ぬ"),
  // は行, not わ行 — 歴史的仮名遣い authored directly, the way this file's
  // own header doc says every historical row is: the modern reflex of this
  // class is a -eru verb spelled with え (與える, 教える), and there is no
  // deterministic route from that spelling back to へ/ふ, so the row is
  // written out rather than converted.
  "shimo-nidan-ha": shimonidanRow("へ", "ふ"),
  "shimo-nidan-ba": shimonidanRow("べ", "ぶ"),
  "shimo-nidan-ma": shimonidanRow("め", "む"),
  // ヤ行, whose e-sound is written え — the row's own kana are や/い/ゆ/え/よ,
  // so unlike ハ行 above there is nothing historical to restore here; this is
  // simply what 肥ゆ/見ゆ/生ゆ conjugate as, and Wiktionary's own bungo tables
  // spell them that way (肥え/肥え/肥ゆ/肥ゆる/肥ゆれ/肥えよ). The row exists
  // because the modern -eru spelling cannot be worked backwards to it: 肥える
  // could descend from ア行 (得), ヤ行 (見ゆ) or ワ行 (植う) for all its
  // surface form says, which is why `readingResolver.ts` refuses the whole あ
  // row and the class has to arrive from the lexicon's attested data instead.
  "shimo-nidan-ya": shimonidanRow("え", "ゆ"),
  "shimo-nidan-ra": shimonidanRow("れ", "る"),
  // ワ行下二段: ゑ, the row's own e-kana, against ヤ行's え and ア行's bare
  // vowel — the three-way distinction modern spelling has lost entirely
  // (植える, 見える and 得る all show a plain え today) and the reason
  // `readingResolver.ts` refuses to derive any of them from a modern -eru.
  // 植う/飢う/据う; the terminative is the bare う of the row, so the kanji
  // carries the stem and う is all the okurigana there is.
  "shimo-nidan-wa": shimonidanRow("ゑ", "う"),
  "kami-ichidan": { mizen: "", renyou: "", shuushi: "る", rentai: "る", izen: "れ", meirei: "よ" },

  "ka-hen": { mizen: "こ", renyou: "き", shuushi: "く", rentai: "くる", izen: "くれ", meirei: "こよ" },
  "sa-hen": { mizen: "せ", renyou: "し", shuushi: "す", rentai: "する", izen: "すれ", meirei: "せよ" },
  "na-hen": { mizen: "な", renyou: "に", shuushi: "ぬ", rentai: "ぬる", izen: "ぬれ", meirei: "ね" },
  "ra-hen": { mizen: "ら", renyou: "り", shuushi: "り", rentai: "る", izen: "れ", meirei: "れ" },

  "ku-keiyoushi": { mizenKar: "から", renyou: "く", shuushi: "し", rentai: "き", izen: "けれ" },
  "shiku-keiyoushi": { mizenKar: "しから", renyou: "しく", shuushi: "し", rentai: "しき", izen: "しけれ" },
  "nari-keiyoudoushi": { mizen: "なら", renyou: "に", shuushi: "なり", rentai: "なる", izen: "なれ", meirei: "なれ" },
  // 連用形 として, not the bare と — the same shape `bungoConjugation.ts`'s
  // `COPULA.renyou` already has, and written here for the same reason. たり's
  // own 連用形 is と, and として is that と plus the して that joins it to what
  // follows; the whole connective is one entry because the して is the
  // 形容動詞's way of continuing and not a separate word the sentence
  // supplies. 莞爾而笑 is 莞爾として笑ふ and 卒然問之 is 卒然として之を問ふ,
  // neither of which a bare と reaches.
  //
  // Paired with a stand-down, exactly as にして is: a 而 following this form
  // writes nothing of its own (see `precedingFormSuppliesShite`), or the して
  // would be written twice — としてて, the third of the doublings this file's
  // neighbours guard (博くてて, 王仁人にしてて). `renyoukeiEndsInISound`
  // refuses this class besides, so `converbSuffix` adds no て either.
  "tari-keiyoudoushi": { mizen: "たら", renyou: "として", shuushi: "たり", rentai: "たる", izen: "たれ", meirei: "たれ" },
};

/** Whether an arbitrary string names one of the paradigms above.
 *
 * `ConjClass` is a compile-time union, and a class name that arrives at
 * runtime has not been through the compiler: `chosenReading.ts` stores the
 * class a hand-picked reading inflects by in the token's `misc` map, which is
 * written to a `.conllu` file's MISC column and read back from whatever that
 * column then says — a hand-edited file, or one written by another tool. An
 * unrecognised name must be refused there rather than reaching `conjugate`,
 * which throws on a paradigm it has no table for.
 *
 * Keyed off `PARADIGMS` itself, so the check cannot come to disagree with
 * what `conjugate` can actually inflect. */
export function isConjClass(value: string): value is ConjClass {
  return Object.prototype.hasOwnProperty.call(PARADIGMS, value);
}

/** Conjugation class -> okurigana for one of the six base forms, meant to
 * be appended directly after the token's own kanji. ク/シク adjectives have
 * no plain `mizen` (classical adjectives only take the -から/-しから mizen,
 * formed via the fused ari-auxiliary) — requesting `"mizen"` on one of
 * those classes falls back to `mizenKar` automatically. */
export function conjugate(conjClass: ConjClass, form: ConjForm): string {
  const paradigm = PARADIGMS[conjClass];
  const suffix = paradigm[form] ?? (form === "mizen" ? paradigm.mizenKar : undefined);
  if (suffix === undefined) {
    throw new Error(`${conjClass} has no ${form} form`);
  }
  return suffix;
}
