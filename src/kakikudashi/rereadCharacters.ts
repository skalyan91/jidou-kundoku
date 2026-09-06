import type { ConjForm } from "./classicalConjugation.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { isContentPredicatePos } from "../parse/types.ts";
import { storedReadingText } from "../reading/chosenReading.ts";

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
  /** The part of `first` written **beside** the character rather than over it
   * — 未(いま)だ, 將(まさ)に, 宜(よろ)しく. Absent leaves the whole of `first` in
   * the furigana slot and the character out of the prose entirely, which is
   * what every entry did before this field existed.
   *
   * **It is the two panels' disagreement that this field closes, not only the
   * distance from the received text.** `KundokuView.ts` has always drawn the
   * first reading *over the character* and kept the character; `generator.ts`
   * wrote the same reading as bare kana and dropped it. One character of one
   * text saying two things — 未 drawn 未[いまだ] in the 訓読文 against a bare
   * いまだ in the 書き下し文 — and the received reading agrees with the panel
   * rather than with the prose: 未 stands in kanbun.info's own 書き下し文 on
   * **56 of the 56** occurrences in its 白文 across the 624 gold passages,
   * written 未だ, and 將 19/19, 宜 7/7, 猶 20/20 the same way.
   *
   * Stated per entry and measured per entry; an entry the gold does not
   * measure leaves it absent rather than guessing where its kanji ends. */
  firstOkurigana?: string;
  /** Read again after the governed clause. */
  second: string;
  /** The form the governed predicate takes before `second`. */
  form: ConjForm;
}

/** How a 再読文字's **first** reading divides between the two slots: what goes
 * over the character and what goes beside it. Undefined where the entry states
 * no division, which is both panels' signal to write the reading whole in kana
 * and drop the character — the behaviour every entry had.
 *
 * Shared by `generator.ts` and `KundokuView.ts` for the reason the second
 * reading is (`rereadSecondReading`): the prose writes the okurigana after the
 * character and the 訓読文 draws the reading above it, and a division made
 * twice is a division that can come apart. */
export function rereadFirstParts(
  entry: RereadCharacter,
): { reading: string; okurigana: string } | undefined {
  const { first, firstOkurigana } = entry;
  if (firstOkurigana === undefined) return undefined;
  if (!first.endsWith(firstOkurigana) || first.length <= firstOkurigana.length) return undefined;
  return { reading: first.slice(0, -firstOkurigana.length), okurigana: firstOkurigana };
}

// **Every `firstOkurigana` below, and what each is measured on.** Rendering the
// 624 gold passages with one entry's division added at a time, against a
// baseline re-rendered immediately before: **未 −96 edits** (41 passages closer,
// none further), **將 −23** (11), **猶 −11** (11), **且 −6** (2), **盍 −4** (2),
// **當 −2** (2). Not one passage anywhere reads further from the received text
// under any of the thirteen.
//
// The remaining seven come out at exactly 0 because the gold does not hold that
// *spelling* of the character, and each is stated all the same rather than left
// to disagree with the entry beside it: 将/当/応 are the same words as the
// measured 將/當/應, 由 the same word as 猶. 宜(よろ)しく and 須(すべか)らく are
// genuinely unmeasured — the gold's one 須 is not the 再読 use — and are written
// as every kanbun grammar divides them. Leaving those two alone would not have
// been neutral: it would have left the two panels saying different things about
// them, which is what this field exists to stop.
export const REREAD_CHARACTERS: Readonly<Record<string, RereadCharacter>> = {
  未: { first: "いまだ", firstOkurigana: "だ", second: "ず", form: "mizen" },

  // 将/且 "on the point of ~ing". The ん is the auxiliary む in its own
  // 終止形, so the governed predicate is 未然形: 行 -> 行かんとす.
  将: { first: "まさに", firstOkurigana: "に", second: "んとす", form: "mizen" },
  將: { first: "まさに", firstOkurigana: "に", second: "んとす", form: "mizen" },
  且: { first: "まさに", firstOkurigana: "に", second: "んとす", form: "mizen" },

  // The べし group. All four differ only in their adverb.
  当: { first: "まさに", firstOkurigana: "に", second: "べし", form: "shuushi" },
  當: { first: "まさに", firstOkurigana: "に", second: "べし", form: "shuushi" },
  応: { first: "まさに", firstOkurigana: "に", second: "べし", form: "shuushi" },
  應: { first: "まさに", firstOkurigana: "に", second: "べし", form: "shuushi" },
  宜: { first: "よろしく", firstOkurigana: "しく", second: "べし", form: "shuushi" },
  須: { first: "すべからく", firstOkurigana: "らく", second: "べし", form: "shuushi" },

  // ごとし takes 連体形 and brings its own が (過ぎたるは猶ほ及ばざるが
  // ごとし) — carried in `second` rather than left to the caller, since it
  // belongs to this construction and to no other.
  猶: { first: "なほ", firstOkurigana: "ほ", second: "がごとし", form: "rentai" },
  由: { first: "なほ", firstOkurigana: "ほ", second: "がごとし", form: "rentai" },

  // 盍 = 何不, a rhetorical "why not ~?", so the ざる is 未然形 + ず in
  // 連体形.
  盍: { first: "なんぞ", firstOkurigana: "ぞ", second: "ざる", form: "mizen" },
};

/** The 再読文字 entry for a character, or null. Keyed on `text` rather than
 * `lemma`: the parser lemmatizes some of these to a different character,
 * and it is the written form that is read twice. */
export function rereadCharacter(text: string): RereadCharacter | null {
  return REREAD_CHARACTERS[text] ?? null;
}

/** Whether the second reading a character closes with negates the predicate
 * it closes on. 未 and 盍 close in the ず paradigm (ず, ざる); every other
 * entry asserts (べし, んとす, がごとし).
 *
 * It matters to whatever follows that predicate. 而 after a negation reads
 * して rather than て — 學ばずして, not 學ばずて — and a re-read's negation is
 * invisible to the ordinary test for that, which looks for a postposed 不 or
 * 未 sitting in reading order: the ず of a re-read is no token of its own. */
export function rereadNegates(text: string): boolean {
  const entry = rereadCharacter(text);
  return entry !== null && negates(entry);
}

function negates(entry: RereadCharacter): boolean {
  return entry.second === "ず" || entry.second === "ざる";
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

/** The token a 再読文字's clause **closes on** — where its second reading is
 * written — or null where the plan recorded no such place.
 *
 * `plan.rereadCloseIds` is keyed the other way round, closing token -> the
 * re-reads that close there, because that is the question the prose asks:
 * the 書き下し文 writes the second reading as an ending emitted at the closing
 * token, so it walks the map forwards and already holds the key (see
 * `markRereadClose`). The 訓読文 draws the same reading down the *再読文字's
 * own* left-hand side (`.reread-second`), so at the moment it needs the
 * string it holds the character and not the token whose clause it ends —
 * exactly the inverse. Written once, here beside the forward lookup, rather
 * than as a search at that call site: what the second reading inflects for is
 * one question, and a panel that answers it with its own loop is a panel free
 * to answer it differently.
 *
 * A re-read is recorded at **one** closing token at most — `reorderEngine.ts`
 * pushes its id once, as it expands the node the character hangs off — so the
 * inverse is a function and not a choice. Null where nothing was recorded: a
 * clause-heading 須 whose close would fall on itself is dropped there, and
 * then no second reading is written in the prose at all. */
export function rereadCloseId(rereadId: number, plan: ReadingPlan): number | null {
  for (const [closeAt, ids] of plan.rereadCloseIds) if (ids.includes(rereadId)) return closeAt;
  return null;
}

/** The relations by which a re-read character modifies the predicate it
 * governs. A 且 tagged `cc` is coordinating two clauses ("and"), not
 * announcing an imminent one, so it is not here. */
const REREAD_DEPS: ReadonlySet<string> = new Set(["mod", "comp:aux", "mod@tmod"]);

/** The relations by which a re-read character that *heads* its clause holds
 * the predicate it governs — see `governsPredicate`. */
const GOVERNED_DEPS: ReadonlySet<string> = new Set(["comp:aux", "comp:obj"]);

/** ADJ joins the four since parser 0.3.2 recoded the stative class off VERB —
 * see `isContentPredicatePos`. What a 再読文字 governs is a predicate, and a
 * stative one is still a predicate: 未賢 wants いまだ賢からず, not a 未 with
 * nothing under it. Over the recoded gold a `comp:aux`/`comp:obj` dependent of
 * one of these characters is NOUN 261 / VERB 193 / PRON 31 / **ADJ 25** — small
 * beside the verbs, and every one of the 25 a token that under 0.3.1 was a VERB
 * this test admitted. */
function isVerbal(pos: string): boolean {
  return isContentPredicatePos(pos) || pos === "AUX" || pos === "ADV" || pos === "PART";
}

/** The POS tags a **nominal predicate** can carry — the NOUN/PROPN/PRON that
 * `conjugationContext.ts` synthesizes a なり copula for, and NUM, which the
 * same file treats as a predicate of its own kind (a count, taking あり).
 *
 * Not shared with that file's `NOMINAL_PREDICATE_POS` even though the first
 * three are the same three, and the reason is the import graph rather than a
 * judgement: `conjugationContext.ts` imports this module, so the edge cannot
 * run the other way. The overlap is stated here so that a change to either
 * list is a change made knowing about the other. */
const NOMINAL_PREDICATE_POS: ReadonlySet<string> = new Set(["NOUN", "PROPN", "PRON", "NUM"]);

/** Whether a nominal head is a **predicate** this 再読文字 may be read around
 * — the other kind of head a `mod` re-read can have, beside the verbal one.
 *
 * Literary Chinese realizes a nominal predicate with no verb in it at all
 * (君子。 is "[he] is a gentleman"), and this app writes the missing copula
 * itself. A 再読文字 over one of those is the ordinary construction and not a
 * special case: 未十年 is "it is not yet ten years", いまだ十年ならず, with the
 * copula's own 未然形 なら standing exactly where a verb's would. Without this
 * the 未 fell through to its plain-negation branch and the ず was written
 * *inside* the phrase it negates — 十ぬ年, which is not a reading of anything.
 *
 * **Two conditions, and the second is what keeps 當時 out.** The head has to
 * be the sentence's own root, so that the nominal is what the sentence
 * predicates rather than a noun inside a phrase; and the re-read has to be one
 * that *negates* (`negates` — 未 and 盍, against the べし and んとす group).
 *
 * The negation condition is not a hedge, and it is not about 未 being special.
 * A bare nominal only becomes a predication where the source marks it as one
 * — `isPredicationLicensed` in `conjugationContext.ts` is where that is
 * decided, and a negation over the root is one of the three things it accepts
 * (不亦君子 -> 亦君子ならず). So a *negating* 再読文字 standing over a nominal
 * root is itself the licence for the copula it then governs, while 當 over the
 * noun 時 licenses nothing: 當時 is "at that time", a noun phrase with no
 * predication in it, and admitting it here would have written まさに時なるべし.
 * That licence cannot be asked for directly — the module that holds it imports
 * this one — so what is checked here is the fact that supplies it.
 *
 * A 再読文字 still requires a predicate to govern, and this widens what counts
 * as one rather than dropping the requirement: 不須 and a bare 須 supply no
 * head of either kind and go on being read as the ordinary verb もちゐる. */
function isNominalPredicate<T extends { id: number; dep: string; head: number; pos: string }>(
  entry: RereadCharacter,
  head: T,
): boolean {
  if (!negates(entry) || !NOMINAL_PREDICATE_POS.has(head.pos)) return false;
  return head.dep === "ROOT" || head.head === head.id;
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

/** The predicate a *modifying* re-read character governs, or null — the
 * other half of `governedPredicate`, for the other shape these characters
 * arrive on.
 *
 * A `mod` 再読文字 does not hold its predicate; it hangs off it. 未 is `mod`
 * of the verb it negates, 且 `mod` of the one it says is imminent, so what
 * the character governs is its own *head*, where a clause-heading modal
 * holds it as a child. Two relations, read from opposite ends, asking the
 * same question: does the sentence supply a predicate for this character to
 * be read twice around?
 *
 * The head has to be a predicate, and that is the whole point of this function
 * — `REREAD_DEPS.has(dep)` used to answer yes on its own, which says only that
 * the character *modifies* something. 當 tagged ADV over the noun 時 modifies
 * a noun, and 當時 is "at that time", not まさに…べし.
 *
 * A predicate here is a verbal head or a **nominal** one the sentence
 * predicates with a copula it never wrote — see `isNominalPredicate`, which is
 * where the second kind is settled and where the 當時 case is kept out. */
export function modifiedPredicate<T extends { id: number; dep: string; head: number; pos: string }>(
  token: { id: number; text: string; dep: string; head?: number },
  sentence: { tokens: T[] },
): T | null {
  const entry = rereadCharacter(token.text);
  if (!entry) return null;
  if (!REREAD_DEPS.has(token.dep) || token.head === undefined) return null;
  const head = sentence.tokens.find((t) => t.id === token.head);
  if (!head || head.id === token.id) return null;
  return isVerbal(head.pos) || isNominalPredicate(entry, head) ? head : null;
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
  token: { id?: number; text: string; dep: string; head?: number; pos: string; misc?: Record<string, string> },
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
  //
  // `storedReadingText` and not `chosenReadingText`: four of these characters
  // are auxiliaries as well as 再読文字 (須/當/応/應 are all `NECESSITY`), and a
  // reader picking べし off one of their menus is picking the plain auxiliary
  // over the double reading — 須飲酒 as 酒を飲むべし rather than
  // すべからく酒を飲むべし. `chosenReadingText` declines to report that choice,
  // because nothing is to be *drawn* from it that the auxiliary branch does not
  // draw itself (see `chosenAuxiliary`); what it settles is this question, of
  // which of the character's two constructions the occurrence is in, and that
  // has to be answered from what is stored.
  const chosen = storedReadingText(token);
  if (chosen !== undefined && chosen !== entry.first) return false;
  // A noun reading of one of these (當 in 當時 "at that time") is not a
  // re-read use however it attaches.
  if (!isVerbal(token.pos)) return false;
  // A 再読文字 announces a predicate, and is the construction only where the
  // sentence supplies one. 須學 is すべからく學ぶべし — both halves, with 學 the
  // thing enjoined; 不須 and 須 alone supply no 學, and a 須 read as the
  // construction there emits the second half of something whose first half
  // nothing opened (they came out べからず and べし, with the すべからく silently
  // dropped). What that 須 is instead is the ordinary verb もちゐる, "to need",
  // which is what the plain lookup gives it once this declines.
  //
  // Both shapes are checked, because these characters arrive on two: the
  // modifiers hang off their predicate (`modifiedPredicate` — the head), the
  // clause-heading modals hold it (`governedPredicate` — a child). Neither
  // can be answered without the sentence, so without one this is false —
  // the same answer the child path has always given, now given by both.
  if (!sentence || token.id === undefined) return false;
  const self = { id: token.id, text: token.text, dep: token.dep, head: token.head };
  return modifiedPredicate(self, sentence) !== null || governedPredicate(self, sentence) !== null;
}
