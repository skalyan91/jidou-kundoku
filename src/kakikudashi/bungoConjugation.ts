/** Classical-Japanese (文語) inflectional endings/auxiliaries keyed on the
 * morphologizer feature set actually produced by `lzh_sud_kyoto` (extracted
 * from the shipped **0.3.2** wheel's meta.json morphologizer label inventory).
 *
 * **157 labels, and the count has been 157 since 0.2.0 — but 0.3.2 is the
 * first release in which the *set* changed.** 0.3.0 changed the tagger's
 * representation and added `sent_join`, 0.3.1 added the `lzh_upos_rules` UPOS
 * repair pipe, and neither touched this component. 0.3.2 retrained it: exactly
 * **8 bundles move from VERB to ADJ**, the count staying 157 because it is a
 * recoding and not an addition. Read off the shipped wheel, the descriptive
 * class now divides `Degree=Pos|POS=ADJ` (8 bundles, with `Shared`/`VerbForm`/
 * `ExtPos` variants), `Degree=Pos|POS=ADV` (5) and `Degree=Pos|POS=NOUN` (1),
 * and **no VERB bundle carries `Degree=Pos` at all** — though VERB keeps its
 * five `Degree=Equ` ones, so it is the *value* and never the bare key that any
 * test here may read. `isDescriptiveToken` below is where that division is
 * turned into an answer; `isContentPredicatePos` in `parse/types.ts` is where
 * the consequences for every predicate test in the app are written out.
 *
 * This is a bounded, enumerable table matching that inventory — it does not
 * attempt open-ended classical-Japanese grammar coverage. */

import type { ConjClass, ConjForm } from "./classicalConjugation.ts";
import type { Token } from "../parse/types.ts";

export type MorphFeatures = Record<string, string>;

/** Parses spaCy's `token.morph_` / CoNLL-U FEATS string ("Key1=Val1|Key2=Val2"). */
export function parseMorphFeatures(raw: string): MorphFeatures {
  const out: MorphFeatures = {};
  if (!raw) return out;
  for (const pair of raw.split("|")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** **Whether the parser calls this token a descriptive** — the one test every
 * 形容動詞 rule in this app runs, so they cannot come apart.
 *
 * `Degree=Pos`, and `ADJ` beside it, and **VERB excluded outright**. All three
 * clauses changed meaning under parser 0.3.2 and each is now doing a different
 * job from the one it did before, so read them one at a time.
 *
 * **`Degree=Pos` no longer means "a descriptive VERB".** Up to 0.3.1 it was
 * the *only* signal there was: the gold treebank used ADJ for 0 of its 433,169
 * tokens and tagged every descriptive VERB or ADV `Degree=Pos` instead, so a
 * feature test was the adjective test. 0.3.2 recodes the class — see
 * `isContentPredicatePos` in `parse/types.ts` — and the feature has come apart
 * from it: of the wheel's 14 `Degree=Pos` bundles **8 are ADJ, 5 are ADV and 1
 * is NOUN**, and **no VERB bundle carries `Degree=Pos` at all**. So what this
 * clause now contributes is the descriptive standing in an *adverbial* or
 * nominal slot — 暴 as にはかに, 深 as ふかく — which is exactly what a
 * 形容動詞 rule wants and what the ADJ tag alone would miss.
 *
 * **`ADJ` is now the main clause rather than the fallback**, and it is kept
 * unconditional on the feature for the tree that carries no morphology at all
 * (a hand-written CoNLL-U, another tool's output): every ADJ the parser itself
 * emits carries `Degree=Pos`, so on live output the two clauses agree.
 *
 * **VERB is refused, and that is the one behavioural change here.** A VERB
 * carrying `Degree=Pos` is a shape 0.3.2 will never emit again, but it is one
 * this app can still be handed — from a saved text written earlier in the
 * session, or from the canonical treebank files uploaded as `.conllu`. The
 * annotation editor shows such a token as 動詞 and offers 形容詞 as a one-click
 * correction (which sets ADJ and lands it on one of the wheel's own eight ADJ
 * bundles, since the feature is already there). A token that *displayed* as a
 * verb while silently taking an adjective's reading is the one inconsistency
 * that arrangement leaves, and refusing VERB here is where it is closed: such
 * a token now reads as the verb its chip says it is, one click from correct.
 * Note that this costs nothing on a genuine verb — an action VERB never
 * carried `Degree=Pos` in the first place.
 *
 * `Degree=Equ` is refused with the tag: the comparison 如/若 is ごとし, not a
 * 形容動詞, and it is the same feature `predicativeComplementParticle` and
 * `isComparativeYu` already key that sense on. The value and not the key is
 * what is read, which matters now that **VERB keeps its 5 `Degree=Equ`
 * bundles** and only `Degree=Pos` left it.
 *
 * Asked by `conjugationContext.ts`'s `pinnedKeiyoudoushi` of a single pinned
 * character, by its `redupTariReading` of every member of a reduplicated span,
 * by `chosenReading.ts`'s `chosenOkurigana` of a hand-picked ending, and by
 * `readingResolver.ts` of every token it reads. Five rules naming the same
 * class from the same evidence is exactly the set that must not drift, which
 * is why the evidence is written once — and why the definition sits here, in
 * the module that owns `parseMorphFeatures`, rather than in
 * `conjugationContext.ts`, which `chosenReading.ts` cannot import from
 * without closing a cycle. */
export function isDescriptiveToken(token: Pick<Token, "pos" | "morph">): boolean {
  if (token.pos === "VERB") return false;
  const degree = parseMorphFeatures(token.morph ?? "").Degree;
  return degree === "Pos" || (token.pos === "ADJ" && degree === undefined);
}

export interface ConjugatedForm {
  /** Default/citation form — shuushikei (sentence-final) or rentaikei as
   * appropriate for the auxiliary; used unless a following piece requires a
   * different attachment form. */
  primary: string;
  /** Mizenkei-class form, used when the next piece is a mizenkei-attaching
   * auxiliary (chiefly the ず negation ending). */
  mizen?: string;
  /** A documented secondary form the caller may choose instead of `primary`
   * (e.g. a rentaikei variant, or an equally valid classical alternative);
   * not auto-selected by the generator. */
  alt?: string;
  /** Renyoukei — the form a non-final link in a coordination chain takes,
   * so the clause hands on to the next rather than closing (see
   * `selectForm`). Only given where it differs in *use* from `primary`;
   * for ラ変 あり the two are the same string, and stating it is what makes
   * the choice explicit rather than accidental. */
  renyou?: string;
  /** The ざり-paradigm rentaikei (ざる), for the constructions that require
   * it specifically — see `NEGATION` and `ZARI`. */
  rentaiZari?: string;
  /** The ざり-paradigm mizenkei (ざら) and renyoukei (ざり). Held in their own
   * fields for the reason `rentaiZari` is: `mizen` and `renyou` above are what
   * `selectForm` reads, and they mean "the form to take when a further piece
   * attaches" for an ending this app *synthesizes*. Negation's two paradigms
   * both fill those slots and the choice between them is not `selectForm`'s to
   * make — see `NEGATION`, and `negationForm`, which is the one function that
   * makes it. */
  mizenZari?: string;
  renyouZari?: string;
  /** The ざり-paradigm meireikei (ざれ). Nothing selects it: kanbun has no
   * construction that puts a negation in the imperative that this app renders
   * (勿/毋 are the prohibitive and realise their own なかれ, which is 無し's own
   * 命令形 and not this). Stated so that the paradigm below is the whole
   * paradigm rather than the part currently reachable — see `ZARI`. */
  meireiZari?: string;
  /** Izenkei — the form a 已然形+ば conditional takes, so the clause reads
   * "when/since …" rather than closing. Supplied only where a construction
   * actually asks for it; `NEGATION` is the one that does, and
   * `isConditionalTemporalClause` in conjugationContext.ts is what asks. */
  izen?: string;
}

/** **The ず series** — the defective paradigm classical negation starts from.
 *
 * 未然 (ず) / 連用 ず / 終止 ず / 連体 ぬ / 已然 ね, and no 命令形 at all. The
 * 未然形 is parenthesised in every grammar and here as well: it is ず only in the
 * fossilised ずは/ずば, and everything that would want a real 未然形 out of a
 * negation — ざらむ, ざらば — takes the ざり series instead.
 *
 * Written as a `Paradigm` (`classicalConjugation.ts`'s own shape) rather than as
 * loose fields, because that is what it is: six slots, some of them empty, and
 * the empties are as much a statement as the filled ones. `NEGATION` below is
 * assembled out of this and `ZARI` so that the two tables are the record and the
 * fields are pointers into them. */
export const ZU: Readonly<Partial<Record<ConjForm, string>>> = {
  mizen: "ず",
  renyou: "ず",
  shuushi: "ず",
  rentai: "ぬ",
  izen: "ね",
};

/** **The ざり series** — ず + あり, contracted, and therefore ラ変 throughout.
 *
 * 未然 ざら / 連用 ざり / 終止 — / 連体 ざる / 已然 ざれ / 命令 ざれ. Compare
 * `EXISTENCE`'s あら/あり/あり/ある/あれ/あれ, which is the same six slots on the
 * same paradigm; the missing 終止形 is the one place the contraction did not
 * take, ず itself having always been available there.
 *
 * **Why the language grew a second paradigm at all**, which is also the rule for
 * choosing between the two wherever both have a form: ず could carry nothing
 * after it. It is a bare suffix, not a verb, so no 助動詞 could attach to it —
 * there is no ずき, no ずべし — and the language rebuilt it as ず+あり so that
 * something could. That is why every slot this app reaches for is the ざり one
 * whenever something further attaches (ざるがごとし, ざるなり, ざるのみ, ざれば,
 * ざるに) and the ず one whenever nothing does (知らぬ人, and the bare 連用中止法
 * ず — see `negationForm`, which is where the line is drawn once).
 *
 * The 命令形 is stated and nothing selects it; see `ConjugatedForm.meireiZari`. */
export const ZARI: Readonly<Partial<Record<ConjForm, string>>> = {
  mizen: "ざら",
  renyou: "ざり",
  // No 終止形. Not an omission — the ざり series has none, and a negation
  // closing a sentence is ず.
  rentai: "ざる",
  izen: "ざれ",
  meirei: "ざれ",
};

/** Classical negation, as the two interlocking paradigms it actually is —
 * `ZU` above and `ZARI` beside it, with every field here a pointer into one of
 * them rather than a second copy of a kana string.
 *
 * The fields are the app's own names for the slots its rules reach for, and the
 * pairing of a name to a series is the whole of the grammar in this table:
 *
 *  - **`primary` = ず**, the 終止形, which the ざり series has not got. Also the
 *    ず series' own 連用形, and so what a bare 連用中止法 writes — 飲まず食はず.
 *  - **`alt` = ぬ**, the ず-series 連体形, used where the negated predicate
 *    *modifies* a following noun or nominalizer: 知らぬ人, 挺かぬ者. Nothing
 *    attaches to it; it is the modification itself.
 *  - **`rentaiZari` = ざる**, the ざり-series 連体形, used where something
 *    attaches after the negation — a 再読文字's がごとし, a 断定 なり, a 副助詞
 *    のみ, a case particle, a 係助詞's 結び. Not interchangeable with ぬ: see
 *    `ZARI` for why the second paradigm exists at all.
 *  - **`izen` = ざれ**, the ざり-series 已然形, in front of the ば of a
 *    已然形+ば conditional: 學而不思則罔 is 學びて思はざれば則ち罔し. ざれ and not
 *    ね by the same line — ね is the plain form and survives in fixed idiom
 *    (…ねばならぬ), while a ば is something attaching after the negation.
 *    246 of the 1,754 gold 則 conditionals negate their protasis, so this is a
 *    form the rule reaches rather than a slot filled on spec.
 *  - **`mizenZari` = ざら / `renyouZari` = ざり / `meireiZari` = ざれ**, the rest
 *    of the ざり paradigm, so that a negation inflects like any other predicate
 *    rather than being a fixed string with three exceptions bolted on. The
 *    reader asked for exactly this. What reaches each of them, and what does
 *    not yet, is `negationForm`'s to say and is said there.
 *
 * Which slot a given negation takes is decided in one place — `negationForm` in
 * conjugationContext.ts — and `negationEnding` is the only thing both panels
 * call, so the ず one panel prints and the ず the other prints cannot come
 * apart. */
export const NEGATION: ConjugatedForm = {
  primary: ZU.shuushi!,
  alt: ZU.rentai!,
  rentaiZari: ZARI.rentai!,
  izen: ZARI.izen!,
  mizenZari: ZARI.mizen!,
  renyouZari: ZARI.renyou!,
  meireiZari: ZARI.meirei!,
};
// べし conjugates via the same から/く/し/き/けれ shape as a ク活用 adjective —
// its mizenkei (needed whenever a further auxiliary like ず attaches) is
// べから, not a bare べ+ず: 不可 is べからず, never 可ず or べしず.
export const POTENTIAL: ConjugatedForm = { primary: "べし", mizen: "べから" }; // 可/能 — the standard kanbun rendering of potential/permissive mood
export const DESIDERATIVE: ConjugatedForm = { primary: "まほし", alt: "たし" }; // 欲 — まほし is the older/more classical register, たし a documented later alternative
export const NECESSITY: ConjugatedForm = { primary: "べし", mizen: "べから" }; // 須/當/應

// 使役 — 使/令/教/遣. しむ (下二段マ行) attaches to the caused predicate's
// mizenkei, and the causee is marked をして: 使民戰 -> 民をして戰はしむ.
//
// The 連用形 is しめ, and it is the same kana as the 未然形 above because
// that is what 下二段 is: mizen and renyou coincide on the row's e-sound
// (see `shimonidanRow` — しめ/しめ/しむ/しむる/しむれ/しめよ). Both are stated
// rather than one being left to stand for the other, because they are
// selected by different questions — `selectForm` takes `mizen` for a ず
// following and `renyou` for a chain still running on — and a paradigm whose
// two forms happen to be spelled alike must not be the reason a rule cannot
// fire — nor the reason one fires wrongly, which is the other half of the same
// point and cost a real defect: the 連用形の「て」 switch recovered the form by
// comparing the returned string to this table, could not tell these two apart,
// and wrote a converb in front of the ず that had asked for the 未然形
// (不使勝食氣 -> …しめ**て**ず). `selectedForm` reports the slot now, and
// nothing reads the kana to work out which question was answered. Without the
// `renyou` entry a chain-medial 使役 fell through to
// `primary`: 王令民戰、而歸 closed the causative clause with 戰はしむ and then
// carried on regardless, where 連用中止法 is what the tree asks for —
// 民をして戰はしめ、しかも歸る.
export const CAUSATIVE: ConjugatedForm = { primary: "しむ", mizen: "しめ", renyou: "しめ" };

/** Modal auxiliary lemmas that render as a pure-kana conjugating auxiliary
 * (their own kanji is dropped in kakikudashibun, same as negation, and
 * their reading is treated as okurigana — not furigana — in the kundoku
 * panel, since they're grammatical markers rather than an independent
 * word's dictionary reading). Each conjugates via `selectForm`, so 不可
 * correctly chains to べからず (可's own mizenkei べから + ず) instead of
 * naively concatenating a bare "べし"+ず. Bounded to the clearest,
 * unambiguous cases — 可/能 (potential), 須/當/應/応 (necessity) — not a
 * general modal-auxiliary classifier.
 *
 * **Here rather than in `conjugationContext.ts`, where it was written**, for
 * the reason `KANJI_RETAINED_ADVERBS` moved to `classicalEnding.ts`: the
 * furigana menu has to offer whatever reading the page shows, and
 * `candidateReadings` reaches this table from `src/reading/`, which cannot
 * import `conjugationContext.ts` — that module sits at the far end of the
 * pipeline (it is already in a module cycle with `depClassification.ts`) and
 * the edge would drag the whole of it into the data layer. This file is a
 * leaf and `kanjidicLookup.ts` already reads `sentenceFinalParticle` out of
 * it. Nothing is lost by the move: every form the table names — POTENTIAL,
 * NECESSITY, DESIDERATIVE, CAUSATIVE — is defined immediately above, so the
 * table is nearer its own values here than it was there.
 *
 * `auxiliaryFormFor` in conjugationContext.ts stays where it is: it asks the
 * question *of a token in a sentence* (a 再読文字 used in its own right is not
 * an auxiliary at all), and that is a matter for the pipeline, not for a
 * table of endings. */
export const AUXILIARY_LEMMAS: Record<string, ConjugatedForm> = {
  可: POTENTIAL,
  能: POTENTIAL,
  須: NECESSITY,
  當: NECESSITY,
  応: NECESSITY,
  應: NECESSITY,
  欲: DESIDERATIVE,
  // 使役. These four behave exactly as the modals above do — their own
  // kanji is dropped and they render as a conjugating auxiliary after the
  // predicate they govern — and they bring one thing more: the causee
  // takes をして rather than a plain を (see `caseParticleFor`).
  使: CAUSATIVE,
  令: CAUSATIVE,
  教: CAUSATIVE,
  // 敎, the same character in the spelling the treebank lemmatizes to — all
  // 338 of its occurrences over `lzh_kyoto-sud-{train,dev,test}`, against 0
  // for 教. Listed beside it and not instead of it, for the reason
  // `CAUSATIVE_LEMMAS` gives at length: nothing normalizes a lemma before
  // these tables are keyed by it. `overrides.json` already carries the pair
  // (both spellings, `contextPos: ["AUX"]`, reading しむ), so until this entry
  // existed the furigana menu offered a しむ on 敎 that no branch could then
  // realize — `chosenAuxiliary` identifies a picked auxiliary by looking the
  // lemma up *here*, so the choice was stored and never rendered.
  敎: CAUSATIVE,
  遣: CAUSATIVE,
};

// 受身 — 被/見. Classical passive is る after a mizenkei ending in -a
// (四段, ナ変, ラ変) and らる after every other, which is a property of the
// verb underneath, not of the auxiliary: see `passiveForm`.
export const PASSIVE_RU: ConjugatedForm = { primary: "る", mizen: "れ" };
export const PASSIVE_RARU: ConjugatedForm = { primary: "らる", mizen: "られ" };
export const PASSIVE: ConjugatedForm = {
  primary: "る", // after a yodan/ra-hen (四段/ラ変) stem
  alt: "らる", // after other stem classes — caller must pick based on the governing verb's conjugation class, not determinable from morph features alone
};
export const CONVERB: ConjugatedForm = { primary: "て" }; // renyoukei connective

/** The conjugation classes whose 連用形 ends in an い-sound, and so takes the
 * connecting て — 答ひ→答ひて, 直し→直して, 然り→然りて.
 *
 * This is a phonological fact about each paradigm, read straight off
 * `classicalConjugation.ts`'s own tables rather than inferred from the
 * rendered string, because the string is not always the whole of the form:
 *
 *  - **四段**, every row. `yodanRow`'s second slot is the row's i-kana —
 *    き/ぎ/し/ち/に/び/み/り/ひ — so all nine qualify without exception.
 *  - **上二段**, every row. `kaminidanRow` is *built* on the row's i-sound
 *    (mizen and renyou coincide there — き/ぎ/ち/ぢ/ひ/び/み/い/り), which is
 *    the very thing that distinguishes the family from 下二段.
 *  - **上一段**. Its renyoukei okurigana is the empty string, so no test on
 *    the written suffix could find the い — the vowel is carried by the
 *    kanji's own reading (見 み, 着 き, 居 ゐ), which is what "上一段" names.
 *    Listed by class for exactly that reason.
 *  - **カ変** (き — 来て) and **サ変** (し — して).
 *  - **ナ変** (に — 死にて) and **ラ変** (り — ありて). Neither was named when
 *    this rule was asked for, and both are i-sound by the same reading of the
 *    same tables; they are included because the rule is about the sound, and
 *    死にて/ありて are what classical Japanese writes.
 *
 * Everything else is deliberately absent, and each absence is a different
 * kind:
 *
 *  - **下二段**, every row: the family's mizen/renyou sit one grade *down*,
 *    on the row's e-kana (け/げ/せ/ぜ/て/で/ね/へ/べ/め/え/れ/ゑ). ア行下二段
 *    (得) writes no okurigana at all and is still an e-sound (え) — the mirror
 *    of 上一段 above, and the reason neither can be decided from the suffix.
 *  - **ク/シク形容詞**: く/しく, a u-sound. An adjective handing on to what
 *    follows does it with the bare 連用形 (長く敦く敏し) — 連用中止法, which is
 *    what a non-i-sound 連用形 does generally.
 *  - **ナリ/タリ形容動詞**: ナリ's に *is* an i-sound and is excluded anyway,
 *    and タリ's 連用形 is として. Both of those already contain their own
 *    connective, written as one piece by the form itself rather than supplied
 *    by whatever follows — `COPULA.renyou`'s にして (see its doc) and
 *    `classicalConjugation.ts`'s として, both stood down for by
 *    `precedingFormSuppliesShite`. A second て bolted on by this rule would be
 *    the third occurrence of the doubling that file already guards twice.
 *
 * A 連用形 that is *not* in this set gets nothing written after it: the bare
 * form stands, which is 連用中止法 and a complete classical construction, not
 * a gap. */
const RENYOU_I_SOUND_CLASSES: ReadonlySet<ConjClass> = new Set<ConjClass>([
  "yodan-ka",
  "yodan-ga",
  "yodan-sa",
  "yodan-ta",
  "yodan-na",
  "yodan-ba",
  "yodan-ma",
  "yodan-ra",
  "yodan-ha",
  "kami-nidan-ka",
  "kami-nidan-ga",
  "kami-nidan-ta",
  "kami-nidan-da",
  "kami-nidan-ha",
  "kami-nidan-ba",
  "kami-nidan-ma",
  "kami-nidan-ya",
  "kami-nidan-ra",
  "kami-ichidan",
  "ka-hen",
  "sa-hen",
  "na-hen",
  "ra-hen",
]);

/** Whether this class's 連用形 ends in an い-sound — see
 * `RENYOU_I_SOUND_CLASSES`. */
export function renyoukeiEndsInISound(conjClass: ConjClass): boolean {
  return RENYOU_I_SOUND_CLASSES.has(conjClass);
}
export const PERFECT: ConjugatedForm = { primary: "たり", alt: "り" };
export const COPULA: ConjugatedForm = {
  primary: "なり", // shuushikei — declarative
  mizen: "なら", // mizenkei — required before ず (e.g. 君子ならずや)
  alt: "たり", // attributive-heavy classical copula variant
  // 連用形, for a nominal predicate that hands on instead of closing —
  // 王仁人にして智…, not 王仁人なり智…. なり's own 連用形 is the bare に, and
  // にして is that に plus the して that joins it to what follows; the whole
  // connective is written here rather than split because the して is the
  // copula's way of continuing and not a separate word the sentence
  // supplies. Where a 而 *is* present it therefore writes nothing of its own
  // — see `teOrShite`, which stands down rather than adding a second て on
  // top of this one. `classicalConjugation.ts`'s タリ活用 として is the same
  // arrangement, and stands down through the same guard.
  renyou: "にして",
};
export const EXISTENCE: ConjugatedForm = {
  primary: "あり", // ラ変終止形 — the existential predicate supplied for a
  // *quantity* predication (弟子三千人あり, "[he] had three thousand
  // disciples"), as opposed to the identificational なり. Counting how many
  // of something there are is an assertion that they exist in that number,
  // not an assertion that one thing *is* another — see
  // `isNumeralPredication` in conjugationContext.ts.
  mizen: "あら", // ラ変未然形 — before ず (あらず)
  // ラ変連用形, wanted where the predication is a non-final link in a
  // coordination chain (see `selectForm`). Identical to the 終止形 above —
  // ラ変 is あら/あり/あり/ある/あれ/あれ — so choosing it changes which *form*
  // is selected and not, by itself, what is written.
  //
  // **It does reach the page, through what attaches after it.** The
  // 連用形の「て」 switch writes 大夫五介ありて五牢なり where the default leaves
  // the bare あり, and it can only do that because `selectedForm` reports which
  // slot it took rather than only the kana — the two being one string here is
  // exactly what defeated the recovery this table's `CAUSATIVE` note also
  // records. Where the source spells the 而 the same ありて is written with the
  // switch off, which is the argument for writing it with the switch on.
  renyou: "あり",
};
/** サ変, as an ending a *synthesized* predicate could take. Nothing reaches it
 * at present: it was the do-verb supplied for a bare noun coordinated onto
 * the predicate, read as a denominal action parallel to it (生而神靈 ->
 * 生まれて神靈す), and that reading has been overturned in favour of the
 * ordinary equative なり — see `extraEndingFor` in conjugationContext.ts.
 * Kept because the paradigm is right and a synthesized す may be wanted
 * again; it is stated here as unused so that nobody reads its presence as a
 * claim that some branch still emits it. (The サ変 a *verb read on'yomi*
 * takes is a different thing entirely and goes through `conjugate` with the
 * `sa-hen` class, not through this.) */
export const SURU: ConjugatedForm = {
  primary: "す", // サ変動詞終止形
  mizen: "せ", // サ変未然形 — before ず (せず)
};

/** Maps one token's morph features to the single ending the generator should
 * apply, by the first matching rule below. Returns null when no mapped
 * feature is present (the common case — most tokens carry no such ending). */
export function endingForMorph(morph: MorphFeatures): ConjugatedForm | null {
  if (morph.Polarity === "Neg") return NEGATION;
  if (morph.Mood === "Pot") return POTENTIAL;
  if (morph.Mood === "Des") return DESIDERATIVE;
  if (morph.Mood === "Nec") return NECESSITY;
  if (morph.Voice === "Pass") return PASSIVE;
  if (morph.VerbForm === "Conv") return CONVERB;
  if (morph.Aspect === "Perf") return PERFECT;
  if (morph.VerbType === "Cop") return COPULA;
  return null;
}

/** Standard classical-kakikudashi realizations of the sentence-final
 * discourse particles (dep `discourse`/`discourse@sp`), keyed by lemma.
 * Several of these are register/context-dependent in real classical Japanese
 * (乎 as rhetorical や vs. genuine interrogative か; 矣 and 焉 in particular
 * are frequently under-rendered or absorbed into the preceding predicate's
 * own ending in real philological practice) — each is given one reasonable
 * default rather than left unhandled, with the uncertain ones flagged. */
const SENTENCE_FINAL_PARTICLES: Record<string, string> = {
  乎: "や", // rhetorical default; か is the documented alternative for genuine yes/no questions
  // 矣 deliberately unread (real kanbun convention — this completive/
  // perfective sense has no standalone Japanese particle of its own,
  // unlike 也/乎/哉/夫 below). たり was tried here previously, but たり is
  // specifically a copula/perfective *auxiliary* — た(り)-けいようどうし
  // attaches after a NOUN, り(perfective たり, from て+あり) attaches after
  // a VERB's renyoukei — neither of which describes "whatever predicate
  // happens to precede 矣": it doesn't attach onto an already-complete
  // predicate (e.g. an adjective's own shuushikei, 無し) at all, so it was
  // never actually a suffix 矣 could take regardless of context.
  矣: "",
  也: "なり", // assertive/copula-like sentence-final particle
  夫: "かな", // exclamatory
  焉: "り", // fuses locative + assertive force — conventionally under-rendered (uncertain)
  哉: "かな", // exclamatory/rhetorical
  // 歟 closing a question — 然歟否歟？, "is it so, or is it not?". や, the same
  // rhetorical/interrogative particle 乎 and 否 take, and the reading
  // `quoteClosing`'s own doc has named for this character since it was written
  // ("乎/歟/邪/耶 read や").
  //
  // **It belongs here and not in `overrides.json`, where it was.** That table
  // has held 歟 as か all along and neither panel ever reached the entry: both
  // take the `dep === "discourse"`/`discourse@sp` branch before the reading
  // resolver is consulted at all, and that branch reads this table. A lemma
  // this table does not know renders as *nothing* there — which is what 歟 was
  // doing on the page, 然歟否歟？ coming out with two bare characters — so the
  // か in the override table was neither what appeared nor reachable. The
  // entry is corrected to や alongside this one so the two cannot disagree
  // about a 歟 that arrives tagged some other way.
  //
  // In `SENTENCE_FINAL_WORD_LEMMAS` below by construction, that set being every
  // entry here with a non-empty reading — so や goes over the character as
  // furigana, which is what the reader asked of these particles.
  歟: "や",
  // The 新字体 of the same character. Listed for the reason `overrides.json`
  // lists both: nothing normalises a lemma to one spelling before this table is
  // keyed by it, so a 歟 written 欤 would otherwise reach a different answer
  // from the identical character written the other way.
  欤: "や",
  // 否 closing a question — 君飲嘗不醉否？, "…or not?". The alternative-
  // question tag, read や, the same rhetorical/interrogative particle 乎 takes.
  // Out of `SENTENCE_FINAL_WORD_LEMMAS` below, for the reason 乎's own や is:
  // it lands on a predicate that was already complete without it, so it is an
  // ending written after that predicate rather than a word read in the
  // character's place.
  //
  // 否 is also a real verb (否む, "to refuse") and this parser tags it one, so
  // unlike 乎/哉/夫 the character alone is not evidence — see
  // `conjugationContext.ts`'s `isSentenceFinalParticleUse`, which is where the
  // two uses are told apart by position, and which both panels ask beside
  // their own `dep === "discourse"` test so that a mis-tagged 否 reaches this
  // entry.
  否: "や",
  // 耳 closing a clause — the 限定 particle, "…and that is all". のみ is what
  // kanbun kundoku reads it as: 易耳 is 易きのみ, 直不百步耳 is
  // 直だ百歩ならざるのみ.
  //
  // Not the blank 矣 takes above, though the two look alike at the end of a
  // line. 矣 is unread because the completive force it carries has no
  // standalone Japanese particle to carry it; 耳 has one, and のみ is it.
  //
  // In `SENTENCE_FINAL_WORD_LEMMAS` below, so のみ is set over the character
  // as furigana the way 也's なり is, and not beside it the way 乎's や and 哉's
  // かな are. It was kept out at first on the grounds that a 副助詞 is not a
  // verb — see that set's own doc, where the criterion is now stated as what
  // the kana attach to: のみ is the whole of what 耳 is read as and it pulls
  // the predicate before it into 連体形, which is a word governing a form and
  // not an ending completing one.
  //
  // のみ is a 副助詞 and so attaches to a 連体形 — 易きのみ, never 易しのみ.
  // That is a fact about the predicate in front of it rather than about this
  // table, and lives in conjugationContext.ts: `isLimitingParticleAhead` for
  // the plain predicate and `negationForm` for a negated one. Both read this
  // entry (via `sentenceFinalParticle`) instead of testing the lemma
  // themselves, exactly as the 也/なり rule in `negationForm` already does, so
  // what pulls the 連体形 cannot drift from what is written here.
  //
  // 耳 is also the noun みみ, and unlike 否 above the parser gets that right —
  // 割其耳 comes back NOUN/`comp:obj`, and the particle comes back
  // PART/`discourse@sp`. What this entry does put at risk is the opposite
  // error: `isSentenceFinalParticleUse`'s positional fallback claiming that
  // noun merely because it stands last. See the guard there.
  耳: "のみ",
};

export function sentenceFinalParticle(lemma: string): string {
  return SENTENCE_FINAL_PARTICLES[lemma] ?? "";
}

/** The reading a particle takes when the sentence around it settles the
 * register the table above could only guess at — currently the one entry whose
 * own comment already named the alternative: **乎 as か**.
 *
 * 乎's default や is the rhetorical one, which is the right default because
 * kanbun's 乎 usually is rhetorical and nothing in the character says
 * otherwise. 豈 does say otherwise — it is the 反語 adverb, "how could it be
 * that…", and this parser tags it `v,副詞,疑問,反語`, naming the class in the
 * tag. 豈飲啄固有數乎？ is あに飲啄もとより數有らんか.
 *
 * Kept beside `SENTENCE_FINAL_PARTICLES` rather than in the rule that consults
 * it, so the two readings of one character sit in one place, exactly as the
 * table's own 乎 comment has said since it was written. What *decides* between
 * them needs a sentence and so lives in `conjugationContext.ts` — see
 * `sentenceFinalParticleFor`, which is what both panels must call. */
const GENUINE_QUESTION_PARTICLES: Record<string, string> = {
  乎: "か",
};

/** The か-reading of a particle that has one, or undefined. See
 * `GENUINE_QUESTION_PARTICLES`. */
export function genuineQuestionParticle(lemma: string): string | undefined {
  return GENUINE_QUESTION_PARTICLES[lemma];
}

export const SENTENCE_FINAL_PARTICLE_LEMMAS: ReadonlySet<string> = new Set(Object.keys(SENTENCE_FINAL_PARTICLES));

/** Those of the above whose kana are read *in place of the character* — a
 * word of the kundoku sentence, standing where the character stands — as
 * against kana that complete the *preceding* predicate's own form. The first
 * kind goes over the character as furigana, the second beside it as
 * okurigana, which is the same division `cellFor` draws for every other token
 * (a content word's reading above, a grammatical ending below).
 *
 * **The criterion is what the kana attach to, not what word class they
 * belong to.** This set was once called `SENTENCE_FINAL_VERB_LEMMAS` and
 * argued from word class — 也 admitted because なり is the copula *verb*, and
 * や/かな/り excluded as particles — which put 耳's のみ on the wrong side.
 * のみ is a 副助詞 and no verb at all, and it still belongs here: it is the
 * whole of what 耳 is read as, a word occupying its own slot in the sentence,
 * and it is 耳 that supplies it. The word class was never doing the work.
 *
 * What separates the two, applied to the table above:
 *
 *  - **也 → なり** and **耳 → のみ**. Each is the character's own reading, a
 *    constituent in its own right, and each *governs the form of what
 *    precedes it* rather than completing it: なり is the predication (the
 *    nominal before it supplies nothing), and のみ, a 副助詞, pulls the
 *    predicate into 連体形 — 易きのみ, never 易しのみ (see
 *    `isLimitingParticleAhead`). Something that imposes a form on the word
 *    before it is not part of that word's form.
 *  - **乎 → や**, **哉/夫 → かな**, **焉 → り**. These land on the predicate
 *    already standing there and finish it off. 不亦說乎 is 亦説ばしからず + や,
 *    the や liaised onto a negation that was complete without it; 焉's り is
 *    the 完了の助動詞, an auxiliary suffix by definition. Nothing is read on
 *    the character — the kana are written after the word before it, which is
 *    what the okurigana slot is.
 *  - **矣** renders as nothing at all and is on neither side.
 *
 * **Keyed on the lemma, and safe to be, because the one thing that reads it
 * is already inside the particle branch.** 耳 is also the ordinary noun みみ
 * and 焉 also a pronoun, so a set consulted anywhere else would have to carry
 * the use test with it. `KundokuView.ts` asks this only after
 * `dep === "discourse"`/`discourse@sp` or `isSentenceFinalParticleUse` has
 * admitted the token, and only where `sentenceFinalParticle` gave it a
 * reading at all — so by the time membership is consulted, *this token is the
 * particle* on the app's own single definition of that. 割其耳 never reaches
 * it: 耳 there comes back NOUN/`comp:obj`, which that predicate's own
 * NOUN/PROPN guard refuses, and the character reads みみ with a を after it.
 * Anything added here later must check that gate still holds rather than
 * assume it.
 *
 * Kept here beside the table it partitions rather than in either panel: both
 * of them take the discourse branch before the reading resolver is ever
 * consulted (which is why `overrides.json` cannot express this — an entry
 * added there for 也 is never reached), so the fact has to travel with the
 * particle itself.
 *
 * ---
 *
 * **The partition is gone, and the set is now every particle the table reads.**
 * Everything above is kept because it is the argument this set was built on and
 * it is worth being able to see what was overturned; what overturns it is the
 * reader's own decision, that *sentence-final particles should always carry
 * furigana rather than okurigana — they are content words*. So 乎's や, 哉's and
 * 夫's かな, 焉's り and 否's や join 也's なり and 耳's のみ over the character,
 * and the "what do the kana attach to" criterion argued above no longer decides
 * anything, because nothing is left on the other side of it.
 *
 * The line drawn above is not *wrong* about the grammar — 亦説ばしからず + や
 * really is a particle liaised onto a predicate that was complete without it,
 * and なり really does govern the nominal in front of it. It is a distinction
 * about what the kana are doing grammatically, and the slot is being asked to
 * carry a different distinction: whether the character is read as a word of the
 * sentence at all. Every one of these is — 乎 *is* や, in the sense that a
 * reader meeting the character says や — and that is what the furigana slot is
 * for. The okurigana slot stays what it was, for kana that spell a *form*: an
 * inflection, a negation's ず, an auxiliary's べし.
 *
 * **矣 is still on neither side**, and needs no rule for it: it renders as the
 * empty string, and both panels ask this set only where
 * `sentenceFinalParticle` gave a reading at all, so a particle with no reading
 * never reaches the question. Built from the table's own entries rather than
 * relisted, so a particle added there is in this set by construction and the
 * two cannot come apart.
 *
 * **The lemma gate above still holds and still has to.** 耳 is also みみ and 焉
 * also a pronoun; widening this set widens nothing about *which tokens are
 * particles*, which stays `dep === "discourse"`/`discourse@sp` or
 * `isSentenceFinalParticleUse`. 割其耳 still comes back NOUN/`comp:obj` and
 * never reaches here. */
export const SENTENCE_FINAL_WORD_LEMMAS: ReadonlySet<string> = new Set(
  Object.keys(SENTENCE_FINAL_PARTICLES).filter((lemma) => SENTENCE_FINAL_PARTICLES[lemma] !== ""),
);
