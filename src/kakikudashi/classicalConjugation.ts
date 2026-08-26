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
  | "kami-nidan-ma" // 上二段マ行 (慍む)
  | "shimo-nidan-a" // 下二段ア行 (得)
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
  "kami-nidan-ma": kaminidanRow("み", "む"),
  // ア行下二段 (得 — the row has no consonant of its own, so unlike every
  // other nidan row, even the terminative "u" mora is already fully
  // represented by the kanji's own reading, not written out as separate
  // okurigana: 得ず/得/得るる (mizen/shuushi/rentai), never 得えず/得う.
  "shimo-nidan-a": { mizen: "", renyou: "", shuushi: "", rentai: "る", izen: "れ", meirei: "よ" },
  "kami-ichidan": { mizen: "", renyou: "", shuushi: "る", rentai: "る", izen: "れ", meirei: "よ" },

  "ka-hen": { mizen: "こ", renyou: "き", shuushi: "く", rentai: "くる", izen: "くれ", meirei: "こよ" },
  "sa-hen": { mizen: "せ", renyou: "し", shuushi: "す", rentai: "する", izen: "すれ", meirei: "せよ" },
  "na-hen": { mizen: "な", renyou: "に", shuushi: "ぬ", rentai: "ぬる", izen: "ぬれ", meirei: "ね" },
  "ra-hen": { mizen: "ら", renyou: "り", shuushi: "り", rentai: "る", izen: "れ", meirei: "れ" },

  "ku-keiyoushi": { mizenKar: "から", renyou: "く", shuushi: "し", rentai: "き", izen: "けれ" },
  "shiku-keiyoushi": { mizenKar: "しから", renyou: "しく", shuushi: "し", rentai: "しき", izen: "しけれ" },
  "nari-keiyoudoushi": { mizen: "なら", renyou: "に", shuushi: "なり", rentai: "なる", izen: "なれ", meirei: "なれ" },
  "tari-keiyoudoushi": { mizen: "たら", renyou: "と", shuushi: "たり", rentai: "たる", izen: "たれ", meirei: "たれ" },
};

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
