/** 踊り字 — the iteration mark an edition hangs below a character whose
 * reading is a reduplication, and the test for which reading that is.
 *
 * 益 ますます, 弥 いよいよ, 抑 そもそも, 適 たまたま, 屢 しばしば. One
 * character of Literary Chinese, read in Japanese as a doubled word; a 訓点本
 * marks that doubling with a small 〻 set below the character, in the same
 * vermilion as the reading it belongs to. The mark is a note *about the
 * reading* — it is not a character of the source, takes no cell in the
 * character grid, and hangs off its character the way the kaeriten does,
 * below-right where the kaeriten sits below-left.
 *
 * ── The test ────────────────────────────────────────────────────────────
 * The shape of the reading, and nothing else. Split it in half; the mark is
 * written when the two halves are the same, or the same once the second
 * half's opening kana is unvoiced — ことごと is こと + ごと, and ご unvoiced
 * is こ. (Only the dakuten series, が→か … ば→は. ぱ is not a voicing of は
 * for this purpose: no reduplication takes a handakuten on its second
 * member, and admitting the row would let ぱらぱら-shaped readings in
 * through a door nothing needs open.)
 *
 * Hiragana only. A reading in katakana is okurigana — a grammar word's
 * gloss, an inflectional ending — and those double for reasons that are not
 * reduplication (ズ + ズ never occurs, but the guard costs a character and
 * says what the test is about).
 *
 * ── Why each half must be at least two kana ─────────────────────────────
 * This is the load-bearing part of the test, and it was measured rather than
 * felt. Run the halves-match test over kanjidic's kun'yomi — the reading up
 * to the okurigana dot, which is exactly what reaches the furigana slot — and
 * a **one-kana half matches 445 times** out of 16,036 readings, almost none
 * of them a reduplication:
 *
 *   掩 おお.う, 蓋 おお.う, 勧 すす.める, 括 くく.る, 潅 そそ.ぐ, 屈 かが.む,
 *   係 かか.る, 讃 たた.える, 支 ささ.える, 縮 ちぢ.む, 止 とど.める,
 *   響 ひび.く, 凝 こご.る, 此 ここ, 股 もも, 笹 ささ, 獅 しし
 *
 * Not one of those is a doubled word; they are ordinary stems that happen to
 * repeat a mora, and the voiced branch catches the worst of them (ちぢ, とど,
 * ひび, こご) because a two-mora stem with a rendaku'd second mora is a common
 * shape in Japanese and a reduplication of a single mora is not. The app's own
 * override table shows the same thing: ただ (唯, 惟, 直, 特) is four more.
 *
 * A **half of two or more matches 41 times**, and nearly all of those are
 * real: いよいよ, うやうや(しい), おのおの, かたがた, かわるがわる, くどくど,
 * ことごと(く), こもごも, しばしば, たけだけ(しい), たまたま, つらつら,
 * ひしひし, ほとほと, まにまに, もろもろ. The handful that are not — 橙 だいだい,
 * 鰰 はたはた, 猩 しょうじょう — are single words that happen to be shaped
 * like one, and they are rare enough in kanbun to be worth the mark's
 * occasional wrong claim, where a rule that fired on 止 とど.める would put a
 * mark on half the page.
 *
 * So: halves of two or more, total length even. 445 to 41 is the whole
 * argument, and the minimum is not a tunable.
 *
 * ── Which mark ──────────────────────────────────────────────────────────
 * 〻 (U+303B, VERTICAL IDEOGRAPHIC ITERATION MARK). Its horizontal
 * counterpart is 々 (U+3005), the mark everyone knows from 人々 and 時々; 〻
 * is the same mark drawn for a vertical line, and this panel is set
 * vertically. Noto Serif JP carries it — checked rather than assumed, since
 * the subsets are built by `scripts/build-variable-cjk.mjs` and a missing
 * glyph would show as tofu: `uni303B` in `noto-serif-jp-vf-55.woff2`.
 *
 * Not ゝ/ゞ (U+309D/U+309E) and not 〱/〲 (U+3031/U+3032). Those repeat kana,
 * and the mark here is hung below a *Han character* to say something about the
 * word it is read as; it is not standing in for a kana of the reading, which
 * is written out in full above it either way. Nor is there a voiced variant to
 * reach for: the reading over the character already spells its own rendaku
 * (ところどころ is written out), so the mark has no voicing to carry.
 *
 * ── The relation-keyed design, tried and set aside ──────────────────────
 * A previous pass replaced all of the above with a test on the parser's
 * `compound@redup` relation: 洋洋 spelled out in the source, the second 洋
 * rewritten *as* a 〻 in the character grid, in the ink rather than the
 * vermilion. That is a real convention and the corpus work behind it is sound
 * — kept here so nobody has to re-derive it, and so nobody proposes it a
 * third time without knowing what it does and does not buy.
 *
 * Over the Kyoto gold treebank's `lzh_kyoto-sud-{train,dev,test}` (86,239
 * sentences, 433,169 tokens — and *only* those three files: the other 21
 * .conllu in that directory are relabelled variants of the same text, and
 * counting them all multiplies every figure here by exactly 8, 5,072 for the
 * 634 below):
 *
 *  - `compound@redup` occurs **634** times. In all 634 the dependent's text
 *    equals its head's, and in all 634 the head is the token immediately
 *    before it. The label is exact.
 *  - 89% are VERB (566/634), commonest xpos `v,動詞,描写,形質` (189) and
 *    `v,動詞,描写,態度` (173) — descriptive verbs of quality and manner, the
 *    タリ活用形容動詞 class in 訓読.
 *  - Bare adjacency is not a usable fallback: the same three files hold **882**
 *    adjacent identical single-character pairs, of which **248 (28.1%) are not
 *    labelled redup** — 使使 (27), ○○ (25) and □□ (7), which are lacuna
 *    markers for characters the manuscript has lost, 親親 (20), 之之 (11),
 *    王王 (11). Most are the V+O figure of Confucian prose (親を親とす) or two
 *    clauses meeting at a boundary. 13 characters occur both labelled and
 *    unlabelled — 人人 is a reduplication 6 times and not one 5 times — so the
 *    pair's own spelling cannot decide between them.
 *
 * It was set aside because it answers a different question. The two
 * conventions are not versions of one another: this file's mark says "the
 * reading of this character is a doubled word", and the relation-keyed one
 * says "the character before this one is written again here". They apply to
 * disjoint texts — 益 is one character and carries no relation to key on, 洋洋
 * is two characters whose readings (やう and やう) are not reduplications —
 * and the reading-keyed one is the one this app was asked for. Restoring it
 * does not rule the other out; a second, relation-keyed pass could stand
 * beside this one, and the counts above are what it would rest on.
 *
 * ── What the reading test over-claims, knowingly ────────────────────────
 * 悉 ことごとく and 屢 しばしば are *single characters* in the source. A 〻
 * below one is a note on its reading and not a claim of a 悉悉 in the text,
 * which is the convention this file implements — but a reader who takes the
 * mark for the character-grid kind will read it as one. No exclusion list is
 * kept: naming characters by hand would make the test two tests, one of them
 * unmeasurable, and the 41 above are not separable by any property of the
 * reading. If particular characters are ever to be spared, that is a decision
 * about those characters and belongs in `overrides.json` beside the readings
 * themselves, not in this test. */

/** VERTICAL IDEOGRAPHIC ITERATION MARK (U+303B). */
export const ITERATION_MARK = "〻";

/** Hiragana, and the two marks that can stand inside a reading (ゝゞ, ー).
 * Anything else — katakana, a kanji, a dot from kanjidic's okurigana
 * notation — is not a reading this test has an opinion about. */
const HIRAGANA_RUN = /^[ぁ-ゖゝゞー]+$/;

/** The dakuten series, voiced to plain, for the one place a reduplication's
 * two halves are allowed to differ: the rendaku on the second member's first
 * mora. ことごと, かたがた, ところどころ, こもごも, かわるがわる. */
const VOICED_KANA = "がぎぐげござじずぜぞだぢづでどばびぶべぼ";
const PLAIN_KANA = "かきくけこさしすせそたちつてとはひふへほ";

/** The mark to hang below a character whose reading is a reduplication, or
 * `undefined` if it is not one.
 *
 * Takes the *reading* and not the character, because the reading is the whole
 * of the evidence: 益 alone says nothing, and 益 read ますます says everything.
 * A character given a different reading from the menu loses the mark or gains
 * one on the same redraw, without anything having to be told. */
export function iterationMarkFor(reading: string | undefined): string | undefined {
  if (!reading || !HIRAGANA_RUN.test(reading)) return undefined;
  if (reading.length % 2 !== 0) return undefined;
  const half = reading.length / 2;
  // The 445-to-41 minimum. See the header: below this, the test stops finding
  // reduplications and starts finding stems that repeat a mora.
  if (half < 2) return undefined;

  const first = reading.slice(0, half);
  const second = reading.slice(half);
  if (second === first) return ITERATION_MARK;
  const voiced = VOICED_KANA.indexOf(second[0]);
  if (voiced >= 0 && PLAIN_KANA[voiced] + second.slice(1) === first) return ITERATION_MARK;
  return undefined;
}
