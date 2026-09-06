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

/** The six base forms, plus the two **カリ活用** slots the ク/シク 形容詞 have
 * and nothing else does.
 *
 * `mizenKar` and `rentaiKar` are not variants of `mizen` and `rentai`; they are
 * cells of a *second paradigm*. An adjective's own inflection is defective —
 * it has no 未然形 at all, and its 連体形 き can carry nothing after it — so the
 * language rebuilt it as く + あり, contracted to から・かり・○・**かる**・かれ・
 * かれ, ラ変 throughout. Exactly the shape ず rebuilt itself into as ざり (see
 * `ZARI` in `bungoConjugation.ts`, which is the same contraction of the same
 * verb onto a different defective suffix, with the same missing 終止形).
 *
 * The two are separate slots and the difference is what attaches:
 *
 *  - **`mizenKar` から** is the 未然形, so it is what a 未然形接続 助動詞 takes.
 *    ず is the one this app writes: 不淸 is 淸**から**ず, and 不可 is べ**から**ず
 *    on the very same paradigm (べし conjugates as a ク活用 adjective — see
 *    `POTENTIAL`).
 *  - **`rentaiKar` かる** is the 連体形, so it is what a 終止形接続 助動詞 takes,
 *    by the ラ変 rule `shuushiConnectiveForm` states below. 淸不可 is
 *    淸**かる**べからず.
 *
 * Which is why one does not stand in for the other, and why `conjugate`'s
 * fallback from `mizen` goes to `mizenKar` and stops there. The remaining カリ
 * cells — 連用形 かり and 已然/命令 かれ — are **not** in this union, and their
 * absence is a statement rather than an oversight: what reaches them is a
 * 連用形接続 助動詞 (高**かり**き, 高**かり**けり) or a 已然形+ば on the カリ
 * paradigm, and this app writes no き/けり at all and takes a negated protasis'
 * 已然形 from the ざり series instead. There is no rule that could ask for them.
 * A plain 連体形 き and a plain 已然形 けれ are ordinary slots and are in the
 * table already; it is only the カリ series that is partial here. */
export type ConjForm =
  | "mizen"
  | "mizenKar"
  | "renyou"
  | "shuushi"
  | "rentai"
  | "rentaiKar"
  | "izen"
  | "meirei";

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

  // The two adjective paradigms, each carrying its own inflection and the two
  // カリ活用 cells anything in this app asks for — see `ConjForm` above for why
  // から and かる are different slots rather than one under two names, and
  // `shuushiConnectiveForm` below for what selects かる.
  //
  // シク's カリ series is しから/しかる and not から/かる: the し belongs to the
  // stem's own ending (説ばし is 説ばしく, 説ばしき), and く+あり contracts onto
  // *that* く. 説ばしからず is what this app already writes for 不亦說乎's
  // negation, and 説ばしかるべし is the same word one slot along.
  "ku-keiyoushi": { mizenKar: "から", renyou: "く", shuushi: "し", rentai: "き", rentaiKar: "かる", izen: "けれ" },
  "shiku-keiyoushi": { mizenKar: "しから", renyou: "しく", shuushi: "し", rentai: "しき", rentaiKar: "しかる", izen: "しけれ" },
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

/** The paradigms that are **ラ変型** — あり/をり/はべり and everything that
 * conjugates on their shape, which here means the ナリ活用 and タリ活用
 * 形容動詞 as well (なら・に・**なり**・**なる**・なれ・なれ is ラ変 with a な in
 * front of it, and たり the same with a た).
 *
 * What the class is *for* is one rule and one rule only, `shuushiConnectiveForm`
 * below: a ラ変型 word has no 終止形 anything can be built on, so what is written
 * for it in a 終止形接続 slot is the 連体形. The set is therefore the set of
 * paradigms whose 終止形 and 連体形 differ **as り to る**, and it is written out
 * rather than derived from the table — `conjugate(c, "shuushi") + "る"` would be
 * true of these three by accident and false of ナ変 (死ぬ/死ぬる), which is not
 * ラ変型 and must not be caught.
 *
 * **The ク/シク 形容詞 are absent from this set, and that absence is now a
 * statement about *this set* rather than the gap it used to be.** A 終止形接続
 * 助動詞 after an adjective does go through a ラ変型 paradigm — the カリ活用,
 * から・かり・○・**かる**・かれ・かれ, which is く+あり contracted exactly as ざり
 * is ず+あり — so 高し + べし is 高**かる**べし. But the form it wants is not this
 * paradigm's own 連体形, and that is why the two adjectives cannot simply be
 * added here: 高**き**べし is not a reading, and a `"rentai"` returned for a
 * ク活用 would write exactly that. The カリ 連体形 is a cell of its own,
 * `rentaiKar` (see `ConjForm`), and `shuushiConnectiveForm` names it directly
 * in an arm of its own.
 *
 * So this set stays what its first paragraph says it is — the paradigms whose
 * 終止形 and 連体形 differ **as り to る** — and ナ変 stays out of it on the same
 * terms as before: 死ぬ/死ぬる is neither ラ変型 nor カリ-bearing, and 死ぬべし is
 * what kundoku writes. */
const RA_HEN_TYPE_CLASSES: ReadonlySet<ConjClass> = new Set([
  "ra-hen",
  "nari-keiyoudoushi",
  "tari-keiyoudoushi",
]);

/** **The ラ変 exception, named once.** The form a 終止形接続 element attaches
 * to: the 終止形 for every ordinary paradigm, and the **連体形** for a ラ変型 one.
 *
 * 可有 is 有る**べし**, not 有りべし; 當然 is 然る**べし**. The rule is the received
 * one — 終止形接続の助動詞（べし・らむ・まじ・めり・らし・伝聞のなり）はラ変型
 * 活用語には連体形に付く — and its reason is that ラ変's 終止形 あ**り** is a
 * closed shape nothing was ever built on, so the language reached for the 連体形
 * instead and the habit generalised to everything conjugating like it.
 *
 * **It is the *element* that has to be 終止形接続, not merely the slot.** A
 * predicate that simply ends a sentence takes its own 終止形 and this function
 * must not be asked about it — 弟子三千人**あり**。 is right and 弟子三千人ある。 is
 * not. So the caller's question is always "does a 終止形接続 助動詞 attach here",
 * and only then is the paradigm consulted. `decideConjForm`'s closing line is
 * the one caller.
 *
 * **The 終助詞 や is not one of these**, which is the other half of the same
 * decision and is argued where the particle is: 「ありやなしや」, 「然りや否や」,
 * 「あはれなりや」 — a 終助詞 attaches to the plain 終止形 of a ラ変型 word, and
 * the received 亦説ばしから**ず**や would be 〜ざるや if it did not. See
 * `TERMINAL_PARTICLE_READINGS` in `conjugationContext.ts`.
 *
 * ---
 *
 * **And the ク/シク 形容詞, which are the same exception reached by a second
 * route.** An adjective under a 終止形接続 助動詞 also goes through a ラ変型
 * paradigm, but not its own: it switches to the **カリ活用**, く+あり
 * contracted, and takes that paradigm's 連体形 **かる**. 淸不可 is
 * 淸**かる**べからず, and 可有 is 有**る**べし — the ラ変型 by the arm above,
 * the 形容詞 by this one. 淸**し**べからず, which is what this
 * function wrote before, is not a reading: a 助動詞 cannot attach to an
 * adjective's 終止形 at all, which is the whole reason the カリ series exists
 * (see `ConjForm`, and `ZARI` in `bungoConjugation.ts` for the same
 * contraction rebuilding ず).
 *
 * **`rentaiKar` and not `rentai`, and the two adjectives are not in
 * `RA_HEN_TYPE_CLASSES`.** Their own 連体形 is き/しき and it is a real form
 * doing a different job — 賢しき者, 高き山 — so a set membership that returned
 * `"rentai"` for them would write 高**き**べし. The カリ 連体形 is a cell of its
 * own and is named as one.
 *
 * **The one 助動詞 that reaches this is べし**, and it is not this file that
 * knows so: `SHUUSHI_CONNECTIVE_AUXILIARY` in `conjugationContext.ts` is the
 * whole list, because べし is the only 終止形接続 ending this app writes
 * (可/能 as POTENTIAL, 須/當/応/應 as NECESSITY). The rest attach elsewhere and
 * none of them asks — **ず** takes the 未然形, which for an adjective is the
 * *other* カリ cell から and has been in this table all along (淸からず), so ず
 * is emphatically not a caller of this; **しむ** and **る/らる** take 未然形 too;
 * **まほし** takes 未然形; the **断定 なり** this app writes for 也 takes a
 * 連体形 or a nominal and gets き/しき, correctly. **めり・らむ・まじ・らし・
 * 伝聞のなり** are 終止形接続 and would each want かる — they are named in this
 * function's own opening paragraph — and the app renders none of them, so
 * adding one is covered by construction rather than needing this arm widened.
 *
 * **Measured.** Rendered through `computeReadingOrder` + `generateKakikudashi`
 * over the whole gold with this arm off and on, **78** of the 68,893 sentences
 * change, and every change is one adjective's ending in front of a べし —
 * nothing else in the corpus moves by a character. **51** are ク活用, where the
 * 終止形 し gives way to かる, and **27** are シク活用, where the stem's own し
 * stands and かる is added after it:
 *
 *   祖逖不能淸中原   淸**し**べからず   -> 淸**かる**べからず
 *   人不可以無恥     恥無**し**べからず -> 恥無**かる**べからず
 *   敖不可長         長**し**べからず   -> 長**かる**べからず
 *   能惡人           惡**し**べし       -> 惡**かる**べし
 *   未能正於樂人     正**し**べからず   -> 正**しかる**べからず  (シク)
 *   能說之           說ば**し**べし     -> 說ば**しかる**べし    (シク)
 *
 * The count is bounded by the shape rather than by this table:
 * `isShuushiAuxiliaryAhead` requires the べし to be both the adjective's own
 * governor and the very next thing read, which is a narrow frame and a
 * deliberately narrow one (see that function for what the adjacency test cost
 * and why it is right). The ラ変型 arm above draws on the same frame and moves
 * 23 sentences of its own; the two populations are disjoint, a predicate having
 * one paradigm. */
export function shuushiConnectiveForm(conjClass: ConjClass): ConjForm {
  if (conjClass === "ku-keiyoushi" || conjClass === "shiku-keiyoushi") return "rentaiKar";
  return RA_HEN_TYPE_CLASSES.has(conjClass) ? "rentai" : "shuushi";
}

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

/** The traditional abbreviation for each paradigm — what a printed 古語辞典
 * sets in a cartouche beside a headword, and what the readings menu sets in
 * one beside an entry whose spelling does not tell it from its neighbour (see
 * `conjClassCartouches` in `render/tokenInspector.ts`).
 *
 * **行 first, then the grade**, which is the form the dictionaries use: 日本国
 * 語大辞典 and the 古語辞典 write カ四, ハ下二, ヤ上二. The alternative order
 * (四カ) is nobody's, and the run being vertical here makes no difference to
 * it — a label reads down the column in the order it would read across a line.
 *
 * **The 行 is written wherever the class records one, and nowhere else.** That
 * is the whole rule, and it is not a length economy: 下二 alone does not name a
 * paradigm — タ下二 and ハ下二 inflect differently in five of their six cells —
 * so a label without the row would only be readable against the entry standing
 * beside it, which is a diacritic and not a label. The classes that get no row
 * are the ones that have none to give:
 *
 *   上一   `kami-ichidan` carries no row at all in this app's model. The
 *          consonant never surfaces in the suffix (見ず, not 見みず), so one
 *          table covers every row and the vowel comes from the kanji's own
 *          reading — see the union above, where the point is argued.
 *   カ変   The four 変格 name their own 行 in the class name itself; writing it
 *   サ変   twice (カカ変) would be a stutter, not a specification.
 *   ナ変
 *   ラ変
 *   ク     The two adjective and two 形容動詞 paradigms are not 行-organised in
 *   シク    the first place: the distinction among them is the stem's own
 *   ナリ    ending, which is what the abbreviation already names.
 *   タリ
 *
 * A `Record<ConjClass, string>` and not a function with a default, so that a
 * paradigm added to the union above cannot reach the menu unlabelled: the
 * compiler asks for its abbreviation at the same time it asks for its
 * paradigm. There are 41 of them and every one is written out. */
export const CONJ_CLASS_CARTOUCHE: Record<ConjClass, string> = {
  "yodan-ka": "カ四",
  "yodan-ga": "ガ四",
  "yodan-sa": "サ四",
  "yodan-ta": "タ四",
  "yodan-na": "ナ四",
  "yodan-ba": "バ四",
  "yodan-ma": "マ四",
  "yodan-ra": "ラ四",
  // ハ行四段, written as the historical row it is — 習ふ, not the わ行五段 its
  // modern reflex became. The whole file is authored in 歴史的仮名遣い and the
  // label has to be too, or it would name a paradigm this app never inflects.
  "yodan-ha": "ハ四",

  "kami-nidan-ka": "カ上二",
  "kami-nidan-ga": "ガ上二",
  "kami-nidan-ta": "タ上二",
  // ダ行, not ザ行: 恥づ's modern 恥じる spells じ because 四つ仮名 merged ぢ
  // into じ, and the row is the one the paradigm above is written on.
  "kami-nidan-da": "ダ上二",
  "kami-nidan-ha": "ハ上二",
  "kami-nidan-ba": "バ上二",
  "kami-nidan-ma": "マ上二",
  "kami-nidan-ya": "ヤ上二",
  "kami-nidan-ra": "ラ上二",

  // ア行下二段 is 得 and its compounds and nothing else — the row with no
  // consonant of its own. It is written out like any other because the reader
  // meeting it in a menu needs to know it is *not* ヤ行 or ワ行, which is the
  // one thing modern spelling has lost (得る/見える/植える all show a plain え).
  "shimo-nidan-a": "ア下二",
  "shimo-nidan-ka": "カ下二",
  "shimo-nidan-ga": "ガ下二",
  "shimo-nidan-sa": "サ下二",
  "shimo-nidan-za": "ザ下二",
  "shimo-nidan-ta": "タ下二",
  "shimo-nidan-da": "ダ下二",
  "shimo-nidan-na": "ナ下二",
  "shimo-nidan-ha": "ハ下二",
  "shimo-nidan-ba": "バ下二",
  "shimo-nidan-ma": "マ下二",
  "shimo-nidan-ya": "ヤ下二",
  "shimo-nidan-ra": "ラ下二",
  "shimo-nidan-wa": "ワ下二",

  "kami-ichidan": "上一",

  "ka-hen": "カ変",
  "sa-hen": "サ変",
  "na-hen": "ナ変",
  "ra-hen": "ラ変",

  "ku-keiyoushi": "ク",
  "shiku-keiyoushi": "シク",
  "nari-keiyoudoushi": "ナリ",
  "tari-keiyoudoushi": "タリ",
};

/** What a cartouche says where no paradigm could be established at all.
 *
 * **Not a gap, and the difference is the whole reason this string exists.** A
 * candidate the app has no class for is not one it will inflect at some
 * default: `chosenConjClass` returns undefined, no `syntheticLexiconEntry` is
 * built, and the reading stands at the form the menu showed it in wherever the
 * sentence puts it. That is a fact about what picking the entry will *do*, and
 * an entry that showed nothing beside its twin would be read as the plain one
 * of the pair rather than as the one the app cannot inflect.
 *
 * 未詳 is the philological term for it and the honest one: the paradigm is
 * undetermined here, not absent from the language. It is reached exactly once
 * over every collision in the shipped index — 黑's くろ+し under a nominal tag,
 * where an unclassed 終止形 arrives from the nominalisation arm beside the
 * ク活用 one the adjective rule built, and none of `derivedConjClass`'s three
 * routes will read ク off a bare し. Rare is what it should be, and it is not
 * the reason to leave it out: the state it names is one the reader would
 * otherwise have to discover by picking the entry and watching nothing
 * inflect. */
export const CONJ_CLASS_UNKNOWN_CARTOUCHE = "未詳";

/** Conjugation class -> okurigana for one of the six base forms, or for one of
 * the two カリ活用 cells, meant to be appended directly after the token's own
 * kanji.
 *
 * **One fallback, in one direction, and it is not symmetrical with the other
 * カリ cell.** ク/シク adjectives have no plain `mizen` at all — a classical
 * adjective's only 未然形 is the カリ から/しから — so requesting `"mizen"` on one
 * of those classes falls through to `mizenKar` automatically, and every caller
 * asking a paradigm for its 未然形 gets the right answer without knowing which
 * family it holds.
 *
 * `rentaiKar` has no such fallback **and must not have one**: unlike the 未然形,
 * an adjective's plain 連体形 き/しき exists and is the ordinary attributive
 * form (賢しき者, 高き山). The two are selected by different questions, and only
 * `shuushiConnectiveForm` asks the one that wants かる — so a caller that wants
 * かる names it, and every other caller keeps き.
 *
 * A form a paradigm has no cell for throws, which is what keeps that
 * arrangement honest: `rentaiKar` on a 四段 is a question about a paradigm that
 * has no カリ series, and nothing may quietly answer it with something else.
 * Nothing asks it — `shuushiConnectiveForm` returns `"rentaiKar"` for the two
 * adjective classes and for no other — so the throw is the statement of an
 * invariant rather than a branch on live input. */
export function conjugate(conjClass: ConjClass, form: ConjForm): string {
  const paradigm = PARADIGMS[conjClass];
  const suffix = paradigm[form] ?? (form === "mizen" ? paradigm.mizenKar : undefined);
  if (suffix === undefined) {
    throw new Error(`${conjClass} has no ${form} form`);
  }
  return suffix;
}
