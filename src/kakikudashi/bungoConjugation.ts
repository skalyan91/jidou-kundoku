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
  /** Rentaikei — the form taken by an ending that something else *attaches
   * onto* rather than one closing a sentence: a 副助詞 (のみ), a nominalizer
   * (者), a 係助詞 binding it (係り結び), a following 助動詞.
   *
   * Distinct from `alt`, which is documented above as a form the generator
   * does **not** auto-select, and which `COPULA` already spends on たり. A
   * caller asking "what is this ending's 連体形" needs a slot that answers only
   * that, exactly as `mizen`, `renyou` and `izen` do for their own forms.
   *
   * `NEGATION` states its 連体形 as `rentaiZari` and `alt` instead, and keeps
   * this slot empty: negation has two paradigms and the choice between ぬ and
   * ざる is `negationForm`'s, not a single-slot lookup's — see `ZU` and `ZARI`.
   * `COPULA` is the one filler at present. */
  rentai?: string;
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
//
// **And its 連体形 べき**, which is the same cell of the same ク活用 shape and
// is wanted by the same question every other predicate in this app is asked:
// a 断定 なり attaching onto the auxiliary leaves it attributive. 言可復也 is
// 言復む**べき**なり — 可きなり on the page, since `AUXILIARY_KANJI_KEPT` keeps
// 可's own character — against the 可**し**なり this table could spell before.
// Counted in the received reading: over kanbun.info's 書き下し文 「可きなり」
// stands **44** times and 「可しなり」 **0**. `selectedForm` is the one caller,
// and `isAssertiveParticleAhead` the question it asks. き and not かる, which
// is the other 連体形 べし has: かる is the カリ cell a *終止形接続* 助動詞 takes
// (`shuushiConnectiveForm`), and なり is not one of those — it is 連体形接続,
// and takes the plain attributive exactly as 者 and のみ do.
export const POTENTIAL: ConjugatedForm = { primary: "べし", mizen: "べから", rentai: "べき" }; // 可/能 — the standard kanbun rendering of potential/permissive mood
// まほし is シク活用, so its 連体形 is まほしき — 欲's own cell of the same
// question POTENTIAL's べき answers.
export const DESIDERATIVE: ConjugatedForm = { primary: "まほし", alt: "たし", rentai: "まほしき" }; // 欲 — まほし is the older/more classical register, たし a documented later alternative
export const NECESSITY: ConjugatedForm = { primary: "べし", mizen: "べから", rentai: "べき" }; // 須/當/應

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
// 民をして戰はしめ、而して歸る.
// The 連体形 is しむる, 下二段's own attributive, and it is asked for by the
// same 断定 なり the other auxiliaries answer to: 使…也 closes on しむる**なり**,
// not しむ+なり.
export const CAUSATIVE: ConjugatedForm = { primary: "しむ", mizen: "しめ", renyou: "しめ", rentai: "しむる" };

/** **The auxiliaries whose character the 書き下し文 keeps, and the part of the
 * form that is written over it.** The table above drops an auxiliary's kanji
 * outright — "their own kanji is dropped in kakikudashibun, same as negation" —
 * and for 不 that is what the received text does too (it stands in kanbun.info's
 * 書き下し文 on 42 of the 543 occurrences in its 白文 across the 624 gold
 * passages, and is written ず on the rest). For 可 it is not: 可 stands on
 * **143 of 143**, and it stands divided — 可きなり 20, 可からず 20, 可からざ 17,
 * 可し 10, 可きか 10, 可きのみ 8. The character is read べ and the inflection is
 * written beside it, exactly as `KANJI_RETAINED_ADVERBS` divides 必ず and
 * `OverrideEntry.spellOutInProse` divides 以て.
 *
 * **可 alone, and the six characters beside it in that table are the argument
 * for the bound rather than an omission.** Each was measured the same way over
 * the same 624 passages, and none of them is this shape:
 *
 *  - **能** is read あたはず or よく by the received text and never べし — 能わざる
 *    10, 能く之を 7, 能わず 6, 能く人を 5, of 75. Keeping its character under
 *    `POTENTIAL` would print 能し. That is not a division this table can state;
 *    it is a different word, and belongs to whatever rule decides that 能 is
 *    あたふ rather than to this one.
 *  - **欲** is read as the verb 欲す, not as まほし — 欲する 7, 欲す 6, 欲すれば 6,
 *    of 40. Same answer: the character is kept because a different reading keeps
 *    it, not because this form divides.
 *  - **須 / 當 / 應** are 再読文字, and their own reading (すべからく, まさに) is
 *    written on the character by `rereadCharacters.ts` while the べし lands on
 *    the predicate they govern. The gold attests none of them in that use — 須 1
 *    occurrence and it is 須や, 當 3 and all of them the verb あたる, 應 1 and it
 *    is the compound 應對 — so there is nothing here to measure and nothing is
 *    claimed.
 *
 * A form the stated reading does not begin is left undivided and takes the
 * kana-only path, which is the guard as well as the fallback: a division this
 * table cannot make is one it must not guess at. */
export const KANJI_RETAINED_AUXILIARIES: Record<string, string> = {
  可: "べ",
};

/** How a selected auxiliary form divides for a character the table above keeps
 * — べから as 可 + から, べき as 可 + き. Undefined for every other auxiliary,
 * and for a form that does not begin with the stated reading, which is what
 * sends both panels back to writing the form whole in kana.
 *
 * Shared by `generator.ts` and `KundokuView.ts` for the reason every other
 * division in this app is shared: the prose writes the okurigana after the
 * character and the 訓読文 draws the reading above it, and those are two halves
 * of one answer. */
export function retainedAuxiliaryParts(
  lemma: string,
  form: string,
): { reading: string; okurigana: string } | undefined {
  const reading = KANJI_RETAINED_AUXILIARIES[lemma];
  if (!reading || !form.startsWith(reading) || form.length <= reading.length) return undefined;
  return { reading, okurigana: form.slice(reading.length) };
}

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
  // **能, and only where the reader pins べし on it.** The character's own two
  // words are 能く and 能はず — see `positiveNengReading` in
  // `conjugationContext.ts` for the count that says so — and `auxiliaryFormFor`
  // declines this entry for every unpinned 能 accordingly. It stays in the table
  // because a pin is resolved *through* the table: `chosenAuxiliary` asks
  // whether the stored reading is this character's own auxiliary, and with the
  // entry gone a reader who picks べし off 能's menu gets a frozen word with no
  // paradigm behind it, which is exactly the freezing that function was written
  // to end. One entry, two readers of it, and they ask different questions.
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
// Both are 下二段 and take るる/らるる attributively, for the reason
// `POTENTIAL`'s べき records: a 断定 なり standing on the auxiliary wants its
// 連体形.
export const PASSIVE_RU: ConjugatedForm = { primary: "る", mizen: "れ", rentai: "るる" };
export const PASSIVE_RARU: ConjugatedForm = { primary: "らる", mizen: "られ", rentai: "らるる" };
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
 *  - **ザ変** (じ — 投じて), which is サ変 voiced and is here for exactly the
 *    reason サ変 is. It is also the whole of what separates the class from
 *    `shimo-nidan-za` (混ぜて), whose e-sound 連用形 is refused below with the
 *    rest of the 下二段 family: 之を亡地に投**じ**て and 弟の象を封**じ**て are
 *    the received readings, and a ザ変 left out of this set would write the
 *    bare 投じ instead.
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
  "za-hen",
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
  // 連体形 なる and 已然形 なれ — **the copula conjugates, and these are the two
  // slots it was missing.**
  //
  // 断定の助動詞 なり is ナリ活用 throughout: なら / に(なり) / なり / なる /
  // なれ / なれ, the same six `classicalConjugation.ts` already writes out under
  // `nari-keiyoudoushi` for the 形容動詞 that shares the paradigm. Three of the
  // six were here (なら, にして, なり) and the sentence-final one was standing in
  // for all the rest, so a copula that something attached onto printed its
  // 終止形 regardless. Measured through the real pipeline, before this:
  //
  //   君子耳       -> 君子なりのみ    (kundoku: 君子なるのみ)
  //   是知乎       -> 是れ知なりや    (kundoku: 是れ知なるや)
  //   是誰之過與   -> …過なりや       (kundoku: …過なるや)
  //
  // のみ is a 副助詞 and takes a 連体形 — the very rule `isLimitingParticleAhead`
  // already enforces on a *verb* (易きのみ, never 易しのみ) — and や/か bind one
  // by 係り結び, which `BINDING_PARTICLE_READINGS` already enforces on a verb
  // too. Both rules were right and had nothing to select for a nominal
  // predicate, because this table had no 連体形 in it. なれ is the same
  // statement for 已然形+ば (君子なれば), the slot `isConditionalTemporalClause`
  // asks `NEGATION` for.
  //
  // **The two 乎 lines above have since been withdrawn, and the のみ line has
  // not.** A 終助詞 や takes the **終止形**, not the 連体形 — 「あはれなりや」,
  // and 亦說ばしから**ず**や is what the received kundoku of 不亦說乎 writes — so
  // 是知乎 is 是れ知**なり**や after all and 是誰之過與 …過**なり**や. What
  // selects なる here is now のみ, the 係助詞 **か** (a 邪/耶, or a 乎 in a 豈
  // frame), the 終助詞 **かな** and a following 者. See
  // `BINDING_PARTICLE_READINGS` and `TERMINAL_PARTICLE_READINGS` in
  // `conjugationContext.ts` for the argument. 君子なるのみ is untouched, and so
  // is every use of なる this table was given for.
  //
  // **Nothing selects either of them yet, and the missing half is named here
  // rather than assumed.** `selectForm`/`selectedForm` in
  // `conjugationContext.ts` choose among `primary`/`mizen`/`renyou` only — its
  // `SelectedSlot` union has three members — so the two forms below reach the
  // page only once that function asks the questions it already asks for a
  // verb (`isLimitingParticleAhead`, `closingParticleReading` +
  // `BINDING_PARTICLE_READINGS`, `isNominalizerAhead`, and
  // `isConditionalTemporalClause` for なれ). Stated all the same, on the
  // discipline `meireiZari` above states: the paradigm written here is the
  // whole paradigm, not the part currently reachable, so that what is missing
  // is a selector and not data.
  rentai: "なる",
  izen: "なれ",
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
  // 連体形 ある and 已然形 あれ, the last two slots of ラ変 — 弟子三千人あるのみ,
  // 弟子三千人あれば. Written for the reason `COPULA`'s なる/なれ just above are
  // and stated at length there: the paradigm here is the whole paradigm, and
  // the two forms are unreachable until `selectForm` learns to ask for them.
  //
  // Both endings carry them rather than only the copula, because the selector
  // that will ask is one function handed whichever of the two the sentence
  // called for — a 連体形 branch that worked for なり and not for あり would put
  // 弟子三千人ありのみ on the page for the same reason 君子なりのみ was there.
  rentai: "ある",
  izen: "あれ",
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
 * (乎 as rhetorical や vs. genuine interrogative か) — each is given one
 * reasonable default rather than left unhandled, with the uncertain ones
 * flagged, and a second reading stated in `GENUINE_QUESTION_PARTICLES` where
 * the sentence can settle which of two words a character is.
 *
 * **矣 and 焉 are the two entries that read as nothing**, and neither is a gap:
 * both are 置き字 — 而・於・于・乎・焉・矣 — and the blank is what the page shows.
 * The sentence beginning this doc once named them together as "frequently
 * under-rendered", which was true of the practice and not of this table, where
 * 矣 was blank and 焉 was a り no edition prints. See each entry.
 *
 * ---
 *
 * **Measured against the received text, character by character.** Every entry
 * below was checked against kanbun.info's own 書き下し文 over the 624 gold
 * passages of `tests/kanbunInfoCorpus.test.ts` — the tier whose parse comes
 * from the Kyoto treebank, so a disagreement there is this app's and not the
 * parser's. Both texts punctuate the same way and kundoku reordering is always
 * clause-internal, so the 白文's clauses pair with the 書き下し文's, and for a
 * clause the 白文 closes with a particle the received clause's own last word is
 * what that particle became. 791 of the 1,107 particle tokens in the gold pair
 * that way; the rest fall in passages the editor repunctuated:
 *
 *     也  366   なり 217   や 72   unread 77*
 *     矣  134   unread 93   なり 18   のみ 17   か 3   かな 2   たり 1
 *     乎   88   か 45   や 35   かな 3   unread 4   たり 1
 *     焉   55   unread 51   なり 4
 *     與   30   か 21   unread 6   や 3
 *     哉   25   や 14   かな 10   unread 1
 *     夫    6   かな 3   unread 2   か 1
 *     耳    1   のみ 1
 *     邪    1   unread 1
 *     歟/欤/与/耶/否 — no gold token at all
 *
 *     *the 22 counted たり are 〜如也 (翕如たり, 申申如たり), where the たり is
 *      如's own タリ suffix and the 也 is unread. They belong to this column.
 *
 * And the runs, which are the same answer said twice: 也與 か 9 / や 2, 矣夫
 * かな 5 / か 3, 矣乎 か 5 / かな 3, 乎哉 や 5 / かな 1, 矣哉 かな 3.
 *
 * **What that confirms.** 也 なり (217 of 366, and 852 of 1,018 on the parser
 * tier), 矣 unread (93 of 134, 150 of 179), 焉 unread (51 of 55, 59 of 63), 夫
 * かな (9 against 1, counting 矣夫 and 也夫), 耳 のみ. The reader's ruling that
 * *矣 is silent* is what the received text does with it in seven cases out of
 * ten, and the 18 なり + 17 のみ that remain are 也 and 耳's words lent to a
 * character this table deliberately leaves bare.
 *
 * **What it does not settle, and why nothing here moved for it.** 乎's か 45
 * against や 35, and 哉's や 14 against かな 10, are not a default this table
 * got wrong: they are one word each way, split by whether the question is a
 * real one or a 反語, and the received text draws that line by the *clause*
 * (不亦說乎 説ばしからずや, 何以別乎 別たんや, 人焉廋哉 廋さんや —
 * against 不忠乎 忠ならざるか, 傳不習乎 習わざるを伝うるか). This app draws the
 * same line and draws it narrower, on the 反語 adverb 豈 alone
 * (`GENUINE_QUESTION_PARTICLES`, and `closesRhetoricalQuestion` in
 * conjugationContext.ts). Widening it is a rule and not a table entry, and it
 * is left for the reader to say how wide.
 *
 * **A conflict, named and not acted on.** The received text reads 與 as **か**
 * — 21 against 3 over the gold, 7 against 2 on the parser tier — and 歟 as か
 * in all 9 of the parser-tier tokens it has (the gold has none). This table
 * reads both や, with か beside them in `GENUINE_QUESTION_PARTICLES` at the
 * reader's own instruction — *"矣 is silent, but 與 should have か as a possible
 * reading"* — which puts か there as the alternative and や as the default.
 * Making か the default would overturn the shape of that instruction rather
 * than extend it, so it is reported here and left alone. */
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
  //
  // **It is the one blank entry in this table, and the blank is what the page
  // shows.** 矣 is PART/`p,助詞,句末,*` on `discourse@sp` in **1,850** of its
  // 1,852 tokens over the recoded gold
  // (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`),
  // so effectively every occurrence takes the panels' discourse branch, reads
  // this entry, and renders as nothing at all: 無過矣 is 過ち無し, with the
  // character standing bare. That is the 置き字 convention — 而・於・于・乎・
  // 焉・矣 — and it is a deliberate answer rather than a gap, which is worth
  // saying because a *missing* entry produces the identical blank (see the 歟
  // and 與 notes below, both of which were exactly that).
  //
  // What a reading would have to be, if one is wanted: **かな** for the
  // exclamatory 甚矣/已矣 (but that is 哉's and 夫's word here), or **り/たり**
  // for the completive (which the paragraph above refuses on grammatical
  // grounds). Neither is a reading kundoku editions actually print for a
  // plain sentence-final 矣, so nothing is written until a reader names one.
  //
  // 焉's entry below once took that り while flagging itself uncertain, which is
  // why this paragraph named it. It no longer does — the grammatical objection
  // raised here against 矣 holds of 焉 word for word, り being an auxiliary that
  // attaches to a 四段已然形 and to nothing else — and 焉 is now the second blank
  // in this table for the reason 矣 is the first.
  //
  // The 訓読文 furigana menu is the other place this shows: KANJIDIC2 gives 矣
  // only the on'yomi イ and no kun at all, so `candidateReadings` offers い —
  // the character's Sino-Japanese sound, not a reading of the particle — and a
  // reader wanting to mark 矣 by hand has nothing to pick. `overrides.json` has
  // no 矣 entry to bound that with, for the same reason: there is no word to
  // put in one.
  矣: "",
  也: "なり", // assertive/copula-like sentence-final particle
  // 夫 — exclamatory かな, and **this is only one of the two words the
  // character writes**. 夫 is also the sentence-*initial* topic-introducer
  // それ (夫仁者己欲立而立人 -> 夫れ仁者は…), which is not a sentence-final
  // particle at all and is read from `overrides.json` instead.
  //
  // The relation tells them apart cleanly and is the only thing that does:
  // over the recoded gold
  // (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
  // 夫 is PART/`discourse@sp` **29** times, 27 of them clause-final, and
  // PART/`discourse` **499** times, 495 of them *not* clause-final. Both panels
  // used to take either relation into the branch that reads this table, so all
  // 499 of the second group got this entry's かな — 夫如是則四方之民 came out
  // かな是の如ければ… — and the fix is in the relation rather than here: see
  // `isSentenceFinalParticleUse` in conjugationContext.ts, which now admits
  // `discourse@sp` alone. **Nothing about this entry changed**, and the かな it
  // gives 命矣夫 (命なるかな) and 吾知免夫 (吾免るるを知るかな) is what it was.
  //
  // Measured against the received text, かな is what a sentence-final 夫 gets:
  // over the kanbun.info gold the clause-final 夫 and its runs 矣夫/也夫 read
  // かな **9** times against **1** か and 2 unread, which is the same shape 哉
  // shows and the reason the two share a word here.
  夫: "かな",
  // 焉 — **置き字, and so the second blank entry in this table.** The reader's
  // instruction was "do whatever is conventional", and 焉 is a member of the
  // 置き字 list this file's 矣 note already recites — 而・於・于・乎・焉・矣 —
  // in every one of its sentence-final uses.
  //
  // **What was here was り, and り is not a reading of this character at all.**
  // The 完了の助動詞 り is て+あり contracted; it attaches to a 四段已然形 and to
  // nothing else. This table is consulted for whatever token the particle
  // branch admits, so the り was written after any form that happened to stand
  // in front of it. Measured through the real pipeline over the whole gold,
  // before this:
  //
  //   見賢思齊焉     -> 賢を見齊はんと思ふ**り**   (a 終止形, not a 已然形)
  //   心不在焉       -> 心在らず**り**             (a negation, which り cannot take)
  //   焉有子死…者乎  -> …有**る**り                (a 連体形, from 係り結び)
  //
  // The 係り結び case is what made it visible, and it is not the defect: an
  // auxiliary printed after six forms it does not attach to was already wrong
  // in the other five. That is not an uncertain reading, which is what the line
  // this replaces called it; it is a reading no edition prints.
  //
  // **焉 is four words sharing a character, and this entry answers for one of
  // them.** Over the recoded gold
  // (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
  // its **764** tokens divide, by POS and relation:
  //
  //  - **PART on `discourse`/`discourse@sp` — 561** (477 standing last among
  //    the non-punctuation tokens, 84 medial). 見賢思齊焉, 有君子之道四焉：….
  //    The sentence-final 助字, and **this entry's word**: 置き字, unread. That
  //    is what 論語 editions print — 賢を見ては齊しからんことを思ひ — and the
  //    character stands bare.
  //  - **ADV on `mod`/`subj` — 96**. 擇不處仁，焉得知？ — the 疑問副詞, いづくんぞ,
  //    and **already read**: it never reaches this table, because the particle
  //    branch is keyed on the relation. See `INTERROGATIVE_BINDING_READINGS` in
  //    `conjugationContext.ts`, which binds a 係り結び on the ぞ, and that set's
  //    own note on the one wart left — 安/惡 take いづくんぞ from `overrides.json`
  //    while 焉 takes the modern-kana いずくんぞ from KANJIDIC2.
  //  - **PRON on `udep`/`comp:obj`/`mod@lmod`/`subj`/`comp:obl@lmod` — 83**
  //    (`udep` 55, `comp:obj` 21, `mod@lmod` 5, `subj` 1, `comp:obl@lmod` 1).
  //    大舜有大焉, 心不在焉, 二女女焉 — the fused 於之/於是, "in it", "therein".
  //    Conventionally **read**, ここに or これ(に/より) by whether the antecedent
  //    is a place or a thing: 心焉に在らず is the received 大學 line. **Read now,
  //    and none of them reaches this entry.** `overrides.json` gives a PRON 焉
  //    ここ + に, and `isSentenceFinalParticleUse` refuses a PRON outright, so
  //    the pronoun goes to the resolver wherever it stands.
  //
  //    That refusal is the half this note used to be waiting on. Until it
  //    landed, the **48** pronouns that stand last (36 `udep`, 12 `comp:obj`)
  //    were claimed by the positional fallback and routed here, and this entry
  //    silenced them — **silence is the 置き字 treatment and not a wrong one**,
  //    since 焉 is on that list precisely *because* it fuses 於 + 之 the way 於
  //    itself is, but ここに is the sharper answer and this table cannot give it,
  //    being keyed on the lemma alone by design (see
  //    `SENTENCE_FINAL_WORD_LEMMAS`). Rendered over the whole gold with the gate
  //    and without it, **48** of the 68,893 sentences change and every one of
  //    them is the insertion of ここに and nothing else — 心不在焉 心在らず ->
  //    心在らず**ここに**, 二女女焉 二女女し -> 二女**ここに**女し, 藏焉 藏む ->
  //    **ここに**藏む. **12** of the 48 would have written a second particle
  //    besides (ここに**を**, all of them the `comp:obj` twelve);
  //    `ownReadingSuppliesCaseParticle` stands it down, which is right on the
  //    character's own account and not merely tidy — 焉 is 於之, so its slot is
  //    locative and can never be accusative. (It was already standing 14 more
  //    down for the medial pronouns this table never claimed: 8 を and 6 に.)
  //  - **PART on `unk` — 20**. 皇皇焉, 圉圉焉 — the 状態 suffix, read as a
  //    タリ活用形容動詞's たり: 皇皇焉たり. **Already read**, and already kept off
  //    this table by name — 焉 is in `TARI_SUFFIX_CHARS`, and
  //    `isSentenceFinalParticleUse` refuses a suffix that has a stem even where
  //    it stands last (6 of the 20 do). **One** of those six has no stem — the
  //    binom is unrendered, so that guard finds nothing to protect — and falls
  //    through to the positional fallback, which is why the count below is 610
  //    and not 609.
  //
  // That is 760 of the 764. The remaining **4** are a PART on `udep` (3) or
  // `subj` (1) — 我不憾焉者, 故先王焉為之立中制節 — none of them last, so none
  // reaches this table either way; they are counted here rather than left to be
  // rediscovered as a discrepancy.
  //
  // **Measured.** Rendered through `computeReadingOrder` + `generateKakikudashi`
  // over the whole gold with り and with the blank, **606** of the 68,893
  // sentences change, and every change is the deletion of one り: **610** in
  // all (561 + 48 + 1, exactly the tokens `isSentenceFinalParticleUse` admitted
  // when that was measured), nothing else differing by a single character
  // anywhere. 見賢思齊焉 思ふ**り** -> 思ふ, 必有我師焉 わが師有り**り** ->
  // わが師有り, 邦有道，貧且賤焉 賤し**り** -> 賤し.
  //
  // The 48 in that sum have since left: the PRON gate above takes them to the
  // resolver instead, so what this entry answers for today is 561 + 1 — the
  // 助字 and the one stemless タリ suffix. The arithmetic is left as it was
  // measured rather than rewritten, because it is a record of that change and
  // not a claim about this one.
  //
  // So three of the four are decided elsewhere and correctly, and the blank
  // here is the answer for the fourth. Like 矣 above, 焉 leaves
  // `SENTENCE_FINAL_WORD_LEMMAS` by construction — that set is this table's
  // non-empty entries — so neither panel writes anything for it, and the
  // 訓読文 and the 書き下し文 agree because they are reading one table.
  //
  // `overrides.json` has said the same thing all along and could not be heard:
  // its 焉 entry is `contextDep: ["discourse", "discourse@sp"]`, reading `""`,
  // glossed "sentence-final particle (often fused 於之, unread or これ)". Both
  // panels take the discourse branch before the resolver is consulted, so that
  // entry was never reached — the identical mechanism the 歟/與/邪/耶 notes in
  // this table record — and the り overrode it in fact while the two tables
  // disagreed on paper. They now agree.
  焉: "",
  // 哉 — exclamatory/rhetorical, read かな.
  //
  // **かな takes a 連体形**, which is a fact about the predicate in front of it
  // rather than about this table and lives in `conjugationContext.ts`:
  // `EXCLAMATORY_PARTICLE_READINGS` for a plain predicate and `negationForm` for
  // a negated one, both of them reading this entry through
  // `sentenceFinalParticle` rather than testing the lemma, exactly as the なり
  // and のみ rules already do. かな is か + な and inherits the 接続 of its first
  // half; 賢哉囘也 is 賢なるかな囘や and 大哉堯之爲君 大なるかな, which is what
  // 論語 prints wherever the character falls. The **334** gold 哉 on
  // `discourse`/`discourse@sp` took a 終止形 until that rule was written.
  哉: "かな",
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
  // 與 closing a question — 是誰之過與？, 「從我者，其由與」？. The same
  // interrogative particle 歟 is, and read the same や: 與/与 is the older
  // spelling of the word 歟 writes, and the two are interchangeable in this
  // position throughout the corpus.
  //
  // **Added because the character was rendering as nothing at all**, which is
  // the exact failure the 歟 note above records and for the same mechanism: the
  // gold treebank (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.
  // punct.rulemerged.adjfix.conllu`) has **189** 與 tagged PART/`discourse@sp`,
  // every one of which takes the panels' discourse branch before the reading
  // resolver is consulted — and a lemma this table does not know renders blank
  // there. 「從我者，其由與」？ came out 我に從ふ者は、由なり with the 與 simply
  // absent. `overrides.json` has held a か for it all along and never been
  // reached, exactly as 歟's was not.
  //
  // か, in that unreached entry, is corrected to や alongside this one, so the
  // two tables cannot give one character two readings — the same repair 歟's
  // entry got. か is not wrong about the word (乎 keeps it as
  // `GENUINE_QUESTION_PARTICLES`' documented alternative); や is this app's
  // default for the whole 乎/歟/邪/耶/否 series, and 與 is a member of it.
  //
  // **The か is back, at the reader's instruction, as the alternative and not
  // as a replacement** — "矣 is silent, but 與 should have か as a possible
  // reading". It is in `GENUINE_QUESTION_PARTICLES` below, which is the one
  // place this codebase keeps a second reading of one particle, and it is
  // there rather than in `overrides.json` for exactly the reason the paragraph
  // above gives: that table's 與 entry is not reached from the discourse
  // branch and a か restored to it would be a か nothing prints. So the
  // paragraph above still holds of `overrides.json` — its 與 reads や and stays
  // や — and what has changed is that か is no longer only a remark in a
  // comment. The 訓読文 furigana menu offers it (`curatedCandidates` in
  // `kanjidicLookup.ts`), and a 與 closing a 豈 clause reads it outright, the
  // same frame and the same test that already answer for 乎.
  //
  // や is still the default and is still what nearly every occurrence gets:
  // of the 189 gold 與 above, **2** have a 豈 in the clause they close
  // (曰：「豈謂是與？ and 豈不辯智之期與」？, both in train), so 187 read や
  // exactly as they did.
  與: "や",
  // The 新字体, listed for the reason 欤 is listed beside 歟: nothing normalises
  // a lemma to one spelling before this table is keyed by it. (与 does not
  // appear at all in the gold treebank, which writes the character 與
  // throughout; it is what a reader typing a modern text will write.) It is in
  // `GENUINE_QUESTION_PARTICLES` beside 與 for the same reason it is here.
  与: "や",
  // 邪 and 耶 closing a question — 子真是耶。, 「天道是邪非邪」. **か**, the
  // genuine interrogative, which is what `overrides.json` has read them as since
  // it was written and what `quoteClosing`'s own doc names for the pair
  // ("乎/歟/邪/耶 read や" was that doc's earlier wording; the override table is
  // the more specific statement and か is what it says).
  //
  // **Added because the two characters were rendering as nothing at all** —
  // the third time this table has had that failure, after 歟 and 與, and by the
  // identical mechanism: both panels take the `discourse`/`discourse@sp` branch
  // before the reading resolver is consulted, that branch reads *this* table,
  // and a lemma it does not know renders blank. 子真是耶。 came out 子是を真 with
  // the character simply absent, and 邪 the same. Over the recoded gold
  // (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
  // **69** 邪 and **38** 耶 stand on `discourse`/`discourse@sp`, across **105**
  // sentences, and every one of them was blank.
  //
  // The override entries are left exactly as they are — か, the same reading —
  // so the two tables cannot give one character two answers. What they go on
  // doing is the furigana menu, which reaches `overrides.json` by a route this
  // table is not on.
  //
  // **They are 連体形-binding and were already treated as such.**
  // `closingParticleReading` consults the caller's resolver for a particle this
  // table does not know, so `decideConjForm` was already selecting 有**る** in
  // front of a 邪 while the page printed no か at all — the form of a 係り結び
  // with the 係助詞 missing. Both halves now come from here.
  //
  // 邪 is also the ordinary noun/adjective よこしま (13 gold tokens,
  // `n,名詞,描写,態度`) and 耶 a phonetic in transcribed names (耶律), which is
  // what `isSentenceFinalParticleUse`'s NOUN/PROPN guard is for: neither is
  // rescued by position, and 邪說暴行 keeps 邪しき說.
  邪: "か",
  耶: "か",
  // 否 closing a question — 君飲嘗不醉否？, "…or not?". The alternative-
  // question tag, read や, the same rhetorical/interrogative particle 乎 takes.
  //
  // **In `SENTENCE_FINAL_WORD_LEMMAS` below, like every other entry here with a
  // reading**, so the や goes over the character as furigana. This once said the
  // opposite — *out* of that set, for the reason 乎's own や was, that it lands
  // on a predicate already complete without it and is therefore an ending rather
  // than a word read in the character's place. That division was overturned by
  // the reader (*sentence-final particles should always carry furigana rather
  // than okurigana — they are content words*) and the set has been built from
  // this table by construction ever since; the sentence was left behind, and it
  // is corrected here rather than deleted because it was the argument the
  // division rested on.
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
  // as furigana the way 也's なり is. It was kept out at first on the grounds
  // that a 副助詞 is not a verb, and then admitted on the criterion that
  // replaced it — what the kana attach to: のみ is the whole of what 耳 is read
  // as and it pulls the predicate before it into 連体形, which is a word
  // governing a form and not an ending completing one.
  //
  // A clause here once contrasted this with 乎's や and 哉's かな as kana set
  // *beside* the character. They are not, and have not been since the reader
  // ruled that every sentence-final particle carries furigana: the set is built
  // from this table's own non-empty entries, so 乎 and 哉 are in it by
  // construction. The clause is struck rather than left to mislead — see that
  // set's closing note, which is where the ruling is recorded.
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
 * register the table above could only guess at — **乎, 與 and 与 as か**, each
 * an entry whose own comment up there already named the alternative.
 *
 * 乎's default や is the rhetorical one, which is the right default because
 * kanbun's 乎 usually is rhetorical and nothing in the character says
 * otherwise. 豈 does say otherwise — it is the 反語 adverb, "how could it be
 * that…", and this parser tags it `v,副詞,疑問,反語`, naming the class in the
 * tag. 豈飲啄固有數乎？ is あに飲啄もとより數有らんか.
 *
 * **與/与 are here at the reader's instruction** — "矣 is silent, but 與 should
 * have か as a possible reading" — and *beside* their や rather than in place of
 * it, which is the whole of what this table is for. The word 與 writes at the
 * end of a question is the word 歟 writes, and か is what that word is when the
 * question is a real one: 曰：「豈謂是與？ is 曰く「あに是を謂ふか」と. It is the
 * same 豈…乎 frame with the other spelling at the end of it, so admitting them
 * took nothing in `conjugationContext.ts` — `closesRhetoricalQuestion` asks
 * about the 反語 adverb and the clause, never about which particle closes it.
 *
 * **The switch is rare, and the default is what nearly every occurrence
 * gets.** Over the recoded gold
 * (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
 * **189** 與 stand PART/`discourse@sp`, and **2** of them have a 豈 in the
 * clause they close — 曰：「豈謂是與？ and 豈不辯智之期與」？, both in train — so
 * 187 read や exactly as before. 乎 is the same shape at a larger scale: **17**
 * of its **893**. 与 has no gold token at all and is listed for the reason it
 * is listed above, that nothing normalises a lemma to one spelling before
 * either table is keyed by it.
 *
 * **乎's menu already had this か and 與's did not**, which is worth saying
 * because the furigana menu is where the reader asked for it. Two tables in
 * front of `curatedCandidates` state 乎 → か on their own account: KANJIDIC2
 * lists か among 乎's kun readings outright, and `overrides.json` holds a
 * char-only entry for it (`overrideReadings` hands the menu every entry for a
 * character whatever role it names). Both are listed ahead of the arm that
 * reads this table, so the か it emits for 乎 folds into the dictionary's by the
 * de-duplication in `candidateReadings` and that menu is unchanged. 與/与 have
 * neither — KANJIDIC2 reads them あた.える/ともに/よ, and their override entries
 * read や — so this table is the whole of what offers them か.
 *
 * Kept beside `SENTENCE_FINAL_PARTICLES` rather than in the rule that consults
 * it, so the two readings of one character sit in one place, exactly as the
 * table's own 乎 comment has said since it was written. What *decides* between
 * them needs a sentence and so lives in `conjugationContext.ts` — see
 * `sentenceFinalParticleFor`, which is what both panels must call. */
const GENUINE_QUESTION_PARTICLES: Record<string, string> = {
  乎: "か",
  與: "か",
  与: "か",
};

/** The か-reading of a particle that has one, or undefined. See
 * `GENUINE_QUESTION_PARTICLES`. */
export function genuineQuestionParticle(lemma: string): string | undefined {
  return GENUINE_QUESTION_PARTICLES[lemma];
}

/** The lemmas that have one, for the invariant tests that ask of a whole table
 * what readings it can put on a page — the counterpart of
 * `SENTENCE_FINAL_PARTICLE_LEMMAS` below, and exported for the same reason:
 * `tests/candidateReadings.test.ts` re-derives the offered-reading claim over
 * every shipped table each run, and a table it cannot enumerate is a table that
 * can grow past its own test. */
export const GENUINE_QUESTION_PARTICLE_LEMMAS: ReadonlySet<string> = new Set(Object.keys(GENUINE_QUESTION_PARTICLES));

/** **也 on a postposed topic — the 提示の也, read や** — and the second table
 * beside `SENTENCE_FINAL_PARTICLES` that gives one character a second word.
 *
 * 也 is なり by default because that is what the character overwhelmingly is at
 * the end of a kanbun sentence: the 断定 copula, 7,317 tokens of it on
 * `discourse`/`discourse@sp` over the recoded gold
 * (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`).
 * But the character also writes the **提示の也**, the particle that marks a
 * topic instead of closing a predicate, and that one is **や**: 由也好勇 is
 * 由**や**勇を好む, 其為人也孝弟 其の人と爲る**や**孝弟なり. `overrides.json`
 * already reads it so, on a long `contextDep` list of every relation that is not
 * `discourse`, because a 提示 也 heads the phrase it marks and therefore wears
 * whatever role that phrase plays.
 *
 * **What this table adds is the one place the same word arrives tagged
 * `discourse@sp` all the same** — the 〜哉…也 frame, where the subject is said
 * *after* the predicate that exclaims about it:
 *
 *   賢哉回也        賢なるかな回**や**
 *   君哉舜也        君なるかな舜**や**
 *   野哉由也        野なるかな由**や**
 *   善哉問也        善きかな問ふ**や**
 *   誠哉是言也      誠なるかな是の言**や**
 *   不仁哉梁惠王也  不仁なるかな梁惠王**や**
 *   久矣哉，由之行詐也  久しきかな、由の詐を行ふ**や**
 *
 * The reader asked for 賢哉囘也 as the received **賢なるかな囘や**, and 賢's own
 * `VERB_LEXICON` entry supplies the 賢なるかな half; this is the other.
 *
 * **The annotation distinguishes it cleanly, and on the *head* rather than on
 * the particle.** The postposed subject is tagged **`dislocated`** — that is
 * exactly what the relation is for — and the 也 hangs off it as
 * `discourse@sp`. So the key is *a 也 whose head bears `dislocated`*, and over
 * the whole gold that is **8 tokens in 8 sentences** (賢哉回也 occurring twice,
 * in two sentences), every one of them the 〜哉…也 frame listed above, with no
 * false positive at all.
 *
 * **A test on the head's POS would have been wrong**, which is worth recording
 * because it is the first thing the frame suggests: the eight heads are PROPN 4,
 * VERB 2 and NOUN 2, and meanwhile **121** 也 stand on a PROPN head that is *not*
 * dislocated — 61 of them on a PROPN `root` — and every one of those is the
 * ordinary assertive. 至於他邦，則曰，『猶吾大夫崔子也。』 is 猶わが大夫崔子**なり**,
 * and a POS key would have turned all 121 into や.
 *
 * Kept here beside `GENUINE_QUESTION_PARTICLES` rather than in the rule that
 * consults it, for that table's own reason: the two readings of one character
 * sit in one place. What *decides* between them needs a sentence and so lives in
 * `conjugationContext.ts` — see `sentenceFinalParticleFor`, which is what both
 * panels must call, so the 訓読文 and the 書き下し文 cannot disagree about the
 * character.
 *
 * **The furigana menu already offers this reading** and needs nothing added:
 * `overrides.json`'s 提示 也 entry states や for the character, and
 * `overrideReadings` hands the menu every entry for a character whatever role it
 * names. That is also why no lemma set is exported beside this one — the
 * offered-reading invariant in `tests/candidateReadings.test.ts` is already
 * satisfied through that entry, and a second route to the same や would list it
 * twice. */
const POSTPOSED_TOPIC_PARTICLES: Record<string, string> = {
  也: "や",
};

/** The 提示 reading of a particle that has one, or undefined. See
 * `POSTPOSED_TOPIC_PARTICLES`. */
export function postposedTopicParticle(lemma: string): string | undefined {
  return POSTPOSED_TOPIC_PARTICLES[lemma];
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
 *  - **乎 → や**, **哉/夫 → かな**, and, when this was written, **焉 → り**.
 *    These land on the predicate already standing there and finish it off.
 *    不亦說乎 is 亦説ばしからず + や, the や liaised onto a negation that was
 *    complete without it; 焉's り was the 完了の助動詞, an auxiliary suffix by
 *    definition. Nothing is read on the character — the kana are written after
 *    the word before it, which is what the okurigana slot is.
 *  - **矣** renders as nothing at all and is on neither side.
 *
 * 焉 has since joined 矣 there: り was not a reading of the character in any of
 * its four uses, and the entry is now blank (see it). The clause is left as it
 * stood because it is part of the argument being recorded, not a claim about
 * the table as it is now.
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
 * 夫's かな and 否's や join 也's なり and 耳's のみ over the character, and the
 * "what do the kana attach to" criterion argued above no longer decides
 * anything, because nothing is left on the other side of it. (焉's り was in
 * that list too, and is now nowhere: the entry reads as nothing, so 焉 sits
 * beside 矣 on neither side.)
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
