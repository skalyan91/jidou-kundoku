/** Classical-Japanese (文語) inflectional endings/auxiliaries keyed on the
 * morphologizer feature set actually produced by `lzh_sud_kyoto` (extracted
 * from the shipped 0.2.0 wheel's meta.json morphologizer label inventory).
 * This is a bounded, enumerable table matching that inventory — it does not
 * attempt open-ended classical-Japanese grammar coverage. */

import type { ConjClass } from "./classicalConjugation.ts";

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
   * it specifically — see `NEGATION`. */
  rentaiZari?: string;
}

export const NEGATION: ConjugatedForm = {
  primary: "ず", // shuushikei — also correct pre-や in the classical "ずや" rhetorical-question pattern
  // The true classical rentaikei of ず is ぬ (the old special ず-conjugation:
  // mizen ず/ざら, renyou ず/ざり, shuushi ず, rentai ぬ, izen ね/ざれ) — used
  // when the negated predicate modifies a following noun (知らぬ人, not the
  // later/looser ざる, which belongs to the separate ざり-based paradigm).
  alt: "ぬ",
  // The ざり-paradigm rentaikei, kept separate from `alt` above precisely
  // because they are not interchangeable: ぬ modifies a following noun,
  // while ざる is what a 再読文字 wanting 連体形 takes — 及ばざるがごとし,
  // and 盍's own なんぞ…ざる. See `negationForm`.
  rentaiZari: "ざる",
};
// べし conjugates via the same から/く/し/き/けれ shape as a ク活用 adjective —
// its mizenkei (needed whenever a further auxiliary like ず attaches) is
// べから, not a bare べ+ず: 不可 is べからず, never 可ず or べしず.
export const POTENTIAL: ConjugatedForm = { primary: "べし", mizen: "べから" }; // 可/能 — the standard kanbun rendering of potential/permissive mood
export const DESIDERATIVE: ConjugatedForm = { primary: "まほし", alt: "たし" }; // 欲 — まほし is the older/more classical register, たし a documented later alternative
export const NECESSITY: ConjugatedForm = { primary: "べし", mizen: "べから" }; // 須/當/應

// 使役 — 使/令/教/遣. しむ (下二段) attaches to the caused predicate's
// mizenkei, and the causee is marked をして: 使民戰 -> 民をして戰はしむ.
export const CAUSATIVE: ConjugatedForm = { primary: "しむ", mizen: "しめ" };

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
 *  - **ナリ/タリ形容動詞**: と is a t-row o-sound and plainly out, but ナリ's
 *    に *is* an i-sound and is excluded anyway. What continues a nominal
 *    predicate in this app is `COPULA.renyou`'s にして, written as one piece
 *    by the copula itself (see its doc, and `precedingCopulaSuppliesShite`);
 *    a second て bolted onto に by this rule would be the third occurrence of
 *    the doubling that file already guards twice.
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
  // top of this one.
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
  // ラ変 is あら/あり/あり/ある/あれ/あれ — so this changes which *form* is
  // selected rather than what is written, which matters to whatever attaches
  // after it rather than to the page.
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
  // 否 closing a question — 君飲嘗不醉否？, "…or not?". The alternative-
  // question tag, read や, the same rhetorical/interrogative particle 乎 takes.
  // A *particle*, so it stays out of `SENTENCE_FINAL_VERB_LEMMAS` below: や is
  // an ending written beside the character, not a word read in its place the
  // way 也's なり is.
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
  // A *particle*, so it stays out of `SENTENCE_FINAL_VERB_LEMMAS` below — kana
  // written beside the character as okurigana, the way 乎's や and 哉's かな
  // are, and not over it the way 也's なり is (なり being the copula verb, a
  // word read in the character's place).
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

export const SENTENCE_FINAL_PARTICLE_LEMMAS: ReadonlySet<string> = new Set(Object.keys(SENTENCE_FINAL_PARTICLES));

/** Those of the above whose Japanese realization is a *word* rather than a
 * particle, so the kana belong over the character as furigana instead of
 * beside it as okurigana.
 *
 * 也 is the case: a bare grammatical marker in Chinese, but what kundoku
 * reads it as — なり — is the copula *verb*, with its own conjugation. That
 * makes なり a reading of the character, the same kind of thing 之's これ is.
 * や, かな and り are not: they are endings, written beside the character
 * they follow, and nothing is read in their place.
 *
 * Kept here beside the table it partitions rather than in either panel: both
 * of them take the discourse branch before the reading resolver is ever
 * consulted (which is why `overrides.json` cannot express this — an entry
 * added there for 也 is never reached), so the fact has to travel with the
 * particle itself. */
export const SENTENCE_FINAL_VERB_LEMMAS: ReadonlySet<string> = new Set(["也"]);
