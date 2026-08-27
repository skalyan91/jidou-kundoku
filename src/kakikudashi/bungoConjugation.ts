/** Classical-Japanese (文語) inflectional endings/auxiliaries keyed on the
 * morphologizer feature set actually produced by `lzh_sud_kyoto` (extracted
 * from the shipped 0.2.0 wheel's meta.json morphologizer label inventory).
 * This is a bounded, enumerable table matching that inventory — it does not
 * attempt open-ended classical-Japanese grammar coverage. */

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
export const PASSIVE: ConjugatedForm = {
  primary: "る", // after a yodan/ra-hen (四段/ラ変) stem
  alt: "らる", // after other stem classes — caller must pick based on the governing verb's conjugation class, not determinable from morph features alone
};
export const CONVERB: ConjugatedForm = { primary: "て" }; // renyoukei connective
export const PERFECT: ConjugatedForm = { primary: "たり", alt: "り" };
export const COPULA: ConjugatedForm = {
  primary: "なり", // shuushikei — declarative
  mizen: "なら", // mizenkei — required before ず (e.g. 君子ならずや)
  alt: "たり", // attributive-heavy classical copula variant
};
export const SURU: ConjugatedForm = {
  primary: "す", // サ変動詞終止形 — the do-verb supplied for a bare noun used
  // verbally as its own coordinate clause's predicate (神靈 -> 神靈す), as
  // opposed to an equative "X is Y" nominal predicate (which stays なり —
  // see extraEndingFor in conjugationContext.ts for the distinction).
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
};

export function sentenceFinalParticle(lemma: string): string {
  return SENTENCE_FINAL_PARTICLES[lemma] ?? "";
}

export const SENTENCE_FINAL_PARTICLE_LEMMAS: ReadonlySet<string> = new Set(Object.keys(SENTENCE_FINAL_PARTICLES));
