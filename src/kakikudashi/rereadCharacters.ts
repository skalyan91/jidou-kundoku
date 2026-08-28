import type { ConjForm } from "./classicalConjugation.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { chosenReadingText } from "../reading/chosenReading.ts";

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

/** The form a predicate must take because a 再読文字 closes on it — 未然形
 * before ず, 終止形 before べし, 連体形 before ごとし. Null when no re-read
 * governs this token, leaving the ordinary rules to decide.
 *
 * Lives here, beside the table it reads, rather than in the one panel that
 * happened to need it first: the governed form is a fact about the
 * construction, and both panels have to reach the same one or they say
 * different things about the same character. They did — 未來 came out
 * いまだ來たらず in the kakikudashibun and きタル in the ruby, because only the
 * generator was consulting this. */
export function rereadGovernedForm(tokenId: number, plan: ReadingPlan): ConjForm | null {
  const closing = plan.rereadCloseIds.get(tokenId);
  if (!closing || closing.length === 0) return null;
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  // The innermost re-read is the one immediately following the predicate,
  // so its requirement is the one the predicate has to satisfy.
  return rereadCharacter(byId.get(closing[0])?.text ?? "")?.form ?? null;
}

/** The relations by which a re-read character modifies the predicate it
 * governs. A 且 tagged `cc` is coordinating two clauses ("and"), not
 * announcing an imminent one, so it is not here. */
const REREAD_DEPS: ReadonlySet<string> = new Set(["mod", "comp:aux", "mod@tmod"]);

/** The relations by which a re-read character that *heads* its clause holds
 * the predicate it governs — see `governsPredicate`. */
const GOVERNED_DEPS: ReadonlySet<string> = new Set(["comp:aux", "comp:obj"]);

function isVerbal(pos: string): boolean {
  return pos === "VERB" || pos === "AUX" || pos === "ADV" || pos === "PART";
}

/** The predicate a clause-heading re-read character governs, or null.
 *
 * The four modal ones (須, 当, 応, 宜) don't come back as modifiers at all:
 * the parser makes the character the head of its own clause and hangs the
 * predicate off it (須 ROOT with 學 as `comp:aux`, 当 ROOT with 勉 as
 * `comp:obj` — both measured). They are re-read exactly as the modifier
 * ones are, so they have to be recognised from the other end of the
 * relation. */
export function governedPredicate<T extends { id: number; dep: string; head: number; pos: string }>(
  token: { id: number; text: string; dep: string },
  sentence: { tokens: T[] },
): T | null {
  if (!rereadCharacter(token.text)) return null;
  return (
    sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && GOVERNED_DEPS.has(t.dep) && isVerbal(t.pos)) ?? null
  );
}

/** Whether a token is being *used* as a 再読文字 rather than in one of its
 * ordinary senses. Several of these characters have common non-再読 uses —
 * 且 as "moreover", 猶 as a plain verb "to resemble", 当 as "to face" — and
 * the difference is whether it stands in a modifying relation to a
 * predicate, or (passing `sentence`) heads a clause whose predicate hangs
 * off it.
 *
 * Deliberately narrow — a missed re-read reads as it did before this
 * existed, while a false one rewrites a clause that was right. */
export function isRereadUse(
  token: { id?: number; text: string; dep: string; pos: string; misc?: Record<string, string> },
  sentence?: { tokens: { id: number; dep: string; head: number; pos: string }[] },
): boolean {
  const entry = rereadCharacter(token.text);
  if (!entry) return false;
  // A reading picked by hand settles it, both ways. Choosing 未's 再読 reading
  // out of the menu (which offers it as いまだ…ズ) leaves nothing stored and
  // falls through to the evidence below, the way every other default does;
  // choosing any *other* reading says this occurrence is not the construction
  // at all, and the character is read once like any other. That has to be
  // decided here rather than at the point of rendering, because the second
  // reading is emitted after a whole clause: the reading order itself
  // (`computeReadingOrder`) asks this question, and a choice the order didn't
  // know about would leave a ず at the end of a sentence that no longer
  // begins with an いまだ.
  const chosen = chosenReadingText(token);
  if (chosen !== undefined && chosen !== entry.first) return false;
  // A noun reading of one of these (當 in 當時 "at that time") is not a
  // re-read use however it attaches.
  if (!isVerbal(token.pos)) return false;
  if (REREAD_DEPS.has(token.dep)) return true;
  if (sentence && token.id !== undefined) {
    return governedPredicate({ id: token.id, text: token.text, dep: token.dep }, sentence) !== null;
  }
  return false;
}
