import type { ConjForm } from "./classicalConjugation.ts";

/** 再読文字 — the characters read twice.
 *
 * A 再読文字 is read once where it stands, as an adverb, and again after the
 * clause it governs, as a verb or auxiliary: 未 in 未果 is read いまダ at the
 * character itself and ず after 果, giving 未だ果たさず. Every other
 * character in kanbun is read once, which is why this needs its own
 * mechanism rather than a reading with a long okurigana — writing 未 as
 * いまダず in one place puts the negation before the verb it negates.
 *
 * The set is closed and small: this is all of it, as given in any kanbun
 * grammar. The readings are in historical kana, like every other reading
 * this app produces.
 *
 * `form` is the conjugation the *governed* predicate takes, which follows
 * from what the second reading is — ず and ざる want 未然形, べし wants
 * 終止形, ごとし wants 連体形 (and its own が). Recorded here rather than
 * inferred at the point of use, since the pairing is a property of the
 * character.
 *
 * Compiled from the standard grammar, cross-checked against the worked
 * answer keys in the 学校ネット and 昇文社 teaching materials the user
 * supplied — 猶…ごとし over a 連体形, 且…んとす, 須…べし and 未…ず all appear
 * there fully marked up. Their sentences are not reproduced; the test suite
 * uses its own. */
export interface RereadCharacter {
  /** Read where the character stands. */
  first: string;
  /** Read again after the governed clause. */
  second: string;
  /** The form the governed predicate takes before `second`. */
  form: ConjForm;
}

export const REREAD_CHARACTERS: Readonly<Record<string, RereadCharacter>> = {
  未: { first: "いまだ", second: "ず", form: "mizen" },

  // 将/且 "on the point of ~ing". The ん is the auxiliary む in its own
  // 終止形, so the governed predicate is 未然形: 行 -> 行かんとす.
  将: { first: "まさに", second: "んとす", form: "mizen" },
  將: { first: "まさに", second: "んとす", form: "mizen" },
  且: { first: "まさに", second: "んとす", form: "mizen" },

  // The べし group. All four differ only in their adverb.
  当: { first: "まさに", second: "べし", form: "shuushi" },
  當: { first: "まさに", second: "べし", form: "shuushi" },
  応: { first: "まさに", second: "べし", form: "shuushi" },
  應: { first: "まさに", second: "べし", form: "shuushi" },
  宜: { first: "よろしく", second: "べし", form: "shuushi" },
  須: { first: "すべからく", second: "べし", form: "shuushi" },

  // ごとし takes 連体形 and brings its own が (過ぎたるは猶ほ及ばざるが
  // ごとし) — carried in `second` rather than left to the caller, since it
  // belongs to this construction and to no other.
  猶: { first: "なほ", second: "がごとし", form: "rentai" },
  由: { first: "なほ", second: "がごとし", form: "rentai" },

  // 盍 = 何不, a rhetorical "why not ~?", so the ざる is 未然形 + ず in
  // 連体形.
  盍: { first: "なんぞ", second: "ざる", form: "mizen" },
};

/** The 再読文字 entry for a character, or null. Keyed on `text` rather than
 * `lemma`: the parser lemmatizes some of these to a different character,
 * and it is the written form that is read twice. */
export function rereadCharacter(text: string): RereadCharacter | null {
  return REREAD_CHARACTERS[text] ?? null;
}

/** Whether a token is being *used* as a 再読文字 rather than in one of its
 * ordinary senses. Several of these characters have common non-再読 uses —
 * 且 as "moreover", 猶 as a plain verb "to resemble", 当 as "to face" — and
 * the difference is whether it is modifying a predicate.
 *
 * The test is the token's own relation: a 再読文字 attaches to the predicate
 * it governs as a modifier or auxiliary. A 且 tagged `cc` is coordinating
 * two clauses ("and"), not announcing an imminent one, and a 猶 heading its
 * own clause is the verb. Deliberately narrow — a missed 再読 reads as it
 * did before this existed, while a false one rewrites a clause that was
 * right. */
const REREAD_DEPS: ReadonlySet<string> = new Set(["mod", "comp:aux", "mod@tmod"]);

export function isRereadUse(token: { text: string; dep: string; pos: string }): boolean {
  if (!rereadCharacter(token.text)) return false;
  if (!REREAD_DEPS.has(token.dep)) return false;
  // A noun reading of one of these (當 in 當時 "at that time") is not a
  // re-read use however it attaches.
  return token.pos === "ADV" || token.pos === "AUX" || token.pos === "VERB" || token.pos === "PART";
}
