import { conjugate, type ConjClass, type ConjForm } from "./classicalConjugation.ts";
import type { Token } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import {
  conjugatedOkurigana,
  converbSuffix,
  decideConjForm,
  nextMeaningfulToken,
  syntheticLexiconEntry,
  type PickedEnding,
  type SelectedForm,
} from "./conjugationContext.ts";
import { rereadGovernedForm } from "./rereadCharacters.ts";

/** **A display option, not a grammar change.**
 *
 * Two conventions are in print for a 連用形 that hands the clause on to the
 * next one. 連用中止法 leaves it bare — 肉を食ひ酒を飲み歌ひ舞ふ — and that is
 * this app's default, settled deliberately (see `converbSuffix`'s closing note
 * in `conjugationContext.ts`, and `tests/coordinationChain.test.ts`). The other
 * writes the connective out and makes every link a converb — 肉を食ひて酒を
 * 飲みて歌ひて舞ふ. Some editions do it one way throughout, some the other, and
 * a reader working through a text may want to see the joins spelled out.
 *
 * So this is a switch over how the same analysis is *written*, alongside
 * 振り仮名/送り仮名/訓点 in the sidebar. Off is the default and off must be
 * byte-identical to the app with this module absent — every function here
 * returns "" when the switch is off, and nothing else in the pipeline consults
 * it.
 *
 * **Module state rather than a threaded parameter**, because the two panels
 * are reached through `KakikudashiView.ts` and `KundokuView.ts`, and the prose
 * panel builds its pieces from `generateKakikudashiPieces` several layers down
 * from anything that could carry an option along. A render-time setting read
 * at the leaf is what the other display switches already are (they are classes
 * on `<body>`, read by CSS at paint time); this one changes what is written
 * rather than what is shown, so it is read in script instead — but it is the
 * same kind of thing, and `main.ts` redraws both panels when it changes, which
 * is what keeps them in step.
 */
let enabled = false;

export function setRenyouTe(on: boolean): void {
  enabled = on;
}

export function renyouTeOn(): boolean {
  return enabled;
}

/** The connective a 連用形 that already carries one ends in — にして
 * (`COPULA.renyou`) and として (`classicalConjugation.ts`'s タリ活用). Written
 * out here rather than imported because `conjugationContext.ts` keeps its own
 * copy private; the two say the same thing about the same two forms, and this
 * one is only ever asked to recognise them. */
const BUILT_IN_CONNECTIVE = "して";

/** What a 連用形 that is not a verb's adds instead of て — ナリ活用形容動詞 and
 * ク/シク活用形容詞 alike.
 *
 * For ナリ活用 the paradigm 連用形 is the bare に, and the converb of に is
 * にして — the same shape `COPULA.renyou` already has for a *synthesized* copula
 * on a bare nominal predicate, and the same shape タリ活用's として has. That
 * asymmetry (a 形容動詞 inflecting itself gets に, a noun handed a copula gets
 * にして) is noted in `isNonFinalCoordinand`'s doc and left standing by default,
 * which is right: に is what the ナリ table holds and 連用中止法 is what the
 * default writes. This switch is the reader asking for the other convention,
 * and under it the two agree.
 *
 * **The adjectives take the same して, and that is not a generalisation from
 * the copula but the register's own form.** 〜くて is the modern converb;
 * 漢文訓読体 writes 〜くして, and does so as a matter of course — 貧而樂 is
 * 貧しくして樂しみ, 貧而無諂 is 貧しくして諂ふこと無く, 無而爲有 is 無くして
 * 有りと爲す. This app targets 文語 (see the plan's scope note), and 貧しくて
 * standing beside 飲みて in one sentence would be two registers in one line.
 * So the split is verb against everything else: a verb's 連用形 takes て, an
 * adjective's or a 形容動詞's takes して. */
const NON_VERB_CONNECTIVE = "して";

/** The classes that take して rather than て — the two adjective classes and
 * the two 形容動詞 classes. タリ活用 is here for completeness only: its
 * paradigm 連用形 is already として, so `BUILT_IN_CONNECTIVE` catches it first
 * and nothing is added at all. */
const SHITE_CLASSES = new Set<ConjClass>([
  "ku-keiyoushi",
  "shiku-keiyoushi",
  "nari-keiyoudoushi",
  "tari-keiyoudoushi",
]);

export interface RenyouTeContext {
  /** The form the caller actually conjugated with — the same discipline
   * `converbSuffix` takes its `form` by. Only a 連用形 gets a て; a 已然形
   * takes ば and a 連体形 takes what it modifies. */
  form: ConjForm | undefined;
  /** The class it conjugated with, again the caller's own and never a fresh
   * `VERB_LEXICON` lookup: what is written depends on the paradigm actually on
   * the page, and only ナリ活用 writes して rather than て. */
  conjClass?: ConjClass;
  /** The okurigana that paradigm wrote, before any connective — so a 連用形
   * that already contains its own して (として) is recognised and left alone. */
  okurigana: string;
  /** What `converbSuffix` already returned for this token. Non-empty means the
   * て is on the page already (a `VerbForm=Conv` token with an い-sound 連用形),
   * and a second one would give 參りてて. Kept separate from `okurigana` because
   * a 下二段タ行 連用形 *is* 立て and does want a further て (立てて) — the two
   * cannot be told apart by looking at the finished string. */
  converbTe: string;
  /** The next token in reading order. A 而 writes its own connective (see
   * `teOrShite`), so this stands down in front of one exactly as
   * `converbSuffix` does — 學而時習之 stays 學びて, never 學びてて. */
  nextToken: Token | undefined;
}

/** The connecting て this switch adds after a paradigm-conjugated 連用形, or
 * "" — which is the answer for every token when the switch is off, and the
 * answer whenever the connective is already written.
 *
 * Called at the two lexicon call sites that already pair `conjugatedOkurigana`
 * with `converbSuffix` (`generator.ts` and `KundokuView.ts`), and there
 * specifically: that pairing is the one place where the form, the class and the
 * okurigana actually written are all in hand at once, which is exactly what
 * deciding this needs. */
export function renyouTeSuffix(ctx: RenyouTeContext): string {
  if (!enabled) return "";
  if (ctx.form !== "renyou") return "";
  if (ctx.nextToken?.lemma === "而") return "";
  if (ctx.converbTe !== "") return "";
  if (ctx.okurigana.endsWith(BUILT_IN_CONNECTIVE)) return "";
  return ctx.conjClass !== undefined && SHITE_CLASSES.has(ctx.conjClass) ? NON_VERB_CONNECTIVE : "て";
}

/** The same for a *synthesized* ending — the copula and the auxiliaries this
 * app supplies where the source has no token realizing them, chosen by
 * `selectedForm` rather than by a paradigm table.
 *
 * **The selection is asked, not reconstructed.** This took the string
 * `selectForm` returned and worked backwards to the form — the 連用形 was taken
 * exactly when what came back was `form.renyou` and that differed from
 * `form.primary` — and that reasoning was wrong wherever two slots of one table
 * hold the same kana, which two of them do:
 *
 *  - **`CAUSATIVE.mizen` and `CAUSATIVE.renyou` are both しめ**, because 下二段
 *    is (see the table's own note). A 未然形 was therefore indistinguishable
 *    from a 連用形, and this wrote a converb in front of the very ず that had
 *    asked for the 未然形: 不使勝食氣 came out 食の氣を勝つをしめ**て**ず. A て
 *    between a 未然形 and its own negation is not a printing convention, it is
 *    ungrammatical, and the switch is a printing convention only.
 *  - **`EXISTENCE.renyou` and `EXISTENCE.primary` are both あり**, ラ変 being
 *    あら/あり/あり/ある/あれ/あれ. That one cost nothing wrong — the comparison
 *    could not tell the two apart, so this declined outright and a quantity
 *    predication kept its bare あり in both switch states.
 *
 * `selectedForm` now reports the slot it took, so both are answered by asking.
 * The `EXISTENCE` one is answered **yes**: 大夫五介五牢 reads 大夫五介**ありて**
 * 五牢なり, a quantity predication handing on to the next instead of closing.
 * The case for the て is that a source 而 standing in that place already makes
 * this app write it — 喪三日而殯 is 喪三日**ありて**殯 in both switch states,
 * through `teOrShite` — so writing the join out where the source spells the
 * connective but not where the reader asks for it would put ありて and a bare
 * あり in one paragraph. That is the argument `NEGATION_CONVERB` makes for
 * ずして, reached from the other side. It is 24 of the gold treebank's 86,239
 * sentences, all of them enumerations of that shape. */
export function synthesizedRenyouTe(selected: SelectedForm, nextToken: Token | undefined): string {
  if (!enabled) return "";
  if (selected.which !== "renyou") return "";
  if (nextToken?.lemma === "而") return "";
  // `COPULA.renyou` is にして, which is the converb already — this switch has
  // nothing to add to it, and adding one would give にしてて, the doubling
  // `precedingFormSuppliesShite` guards from the other side.
  if (selected.text.endsWith(BUILT_IN_CONNECTIVE)) return "";
  return "て";
}

/** **A 連用形 taken inside a function that conjugates for itself.**
 *
 * Two okurigana in this app go through the conjugation pipeline inside a
 * function that writes the finished string itself: `pickedEnding` for a
 * hand-picked reading and `compoundSuruOkurigana` for a fused サ変 span. Both
 * spend `decideConjForm` and `converbSuffix` internally, and neither panel sees
 * the form or the class — so there was nothing left to decide a further て
 * from, and a 連用形 taken by one of those routes was left bare beside one this
 * switch had reached: 貧しく standing next to 瘦せて in the same sentence,
 * because the reader had picked 貧's reading by hand and 瘦's was the
 * resolver's.
 *
 * **`pickedEnding` reports them now** and `pickedRenyouTe` below is one call.
 * `compoundSuruOkurigana` does not, and the reason is at its own definition:
 * both panels concatenate its answer directly, so widening it is a change to be
 * made together with the 訓読文 panel's line rather than before it. Until then
 * the span arm re-derives the form from the same inputs and then **checks its
 * work** — the て is written only where the re-derivation reproduces, character
 * for character, the okurigana that function actually returned. So the failure
 * mode of the copy drifting from the original is not a wrong て but no て at
 * all, which is the same thing the switch does when it is off. */
export function pickedRenyouTe(ending: PickedEnding, nextToken: Token | undefined): string {
  return renyouTeSuffix({
    form: ending.form,
    conjClass: ending.conjClass,
    okurigana: ending.okurigana,
    converbTe: ending.converbTe,
    nextToken,
  });
}

/** For a fused span JMdict lists as a する-verb — see `compoundSuruOkurigana`,
 * whose lines this mirrors, including its split between the carrier (which
 * decides the form) and the last member (where the ending is written, and so
 * whose neighbour "what comes next" means). */
export function compoundSuruRenyouTe(
  carrier: Token,
  lastMemberId: number,
  plan: ReadingPlan,
  resolve: ReadingResolver,
  written: string,
): string {
  if (!enabled) return "";
  const resolved = resolve(carrier, plan.sentence);
  // Only a class belonging to the *span* may be written after the span — the
  // same guard `compoundSuruOkurigana` makes, and for its reason: a member
  // routinely carries a class of its own for its single character.
  const lex = resolved.suruCompound ? syntheticLexiconEntry(resolved, carrier.lemma) : undefined;
  const conjClass = lex?.conjClass;
  if (!conjClass) return "";
  const next = nextMeaningfulToken(plan, lastMemberId);
  const form =
    rereadGovernedForm(lastMemberId, plan) ?? decideConjForm(carrier, next, plan.sentence, conjClass, resolve);
  const okurigana = conjugatedOkurigana(lex!, form);
  const converbTe = converbSuffix(carrier, next, conjClass, form);
  if (okurigana + converbTe !== written) return "";
  return renyouTeSuffix({ form, conjClass, okurigana, converbTe, nextToken: next });
}

/** For a 形容動詞 the parser has tagged an **adverb**, whose 連用形 the resolver
 * writes directly rather than through the conjugation pipeline (see
 * `adverbialCopulaEnding` in `readingResolver.ts`). No form has to be
 * recovered here, and none could be: an ADV-tagged 形容動詞 is in its 連用形 by
 * construction, which is that function's whole argument for answering without
 * asking the pipeline.
 *
 * **This is the ナリ活用 に the switch is chiefly about.** 忽覺咽中暴癢 is
 * 忽ち咽中暴かに癢を覺ゆ, and 暴かにして under the switch.
 *
 * The equality against the paradigm's own 連用形 is the same check-your-work
 * guard `recoveredRenyouTe` makes: a resolver ending that is not the 連用形 on
 * the page is not the thing this describes, and nothing is written. */
export function adverbialRenyouTe(
  token: Token,
  resolved: { conjClass?: ConjClass; okurigana?: string },
  nextToken: Token | undefined,
): string {
  if (!enabled) return "";
  if (token.pos !== "ADV") return "";
  const conjClass = resolved.conjClass;
  if (conjClass !== "nari-keiyoudoushi" && conjClass !== "tari-keiyoudoushi") return "";
  const okurigana = resolved.okurigana;
  if (okurigana === undefined || !okurigana.endsWith(conjugate(conjClass, "renyou"))) return "";
  return renyouTeSuffix({ form: "renyou", conjClass, okurigana, converbTe: "", nextToken });
}
