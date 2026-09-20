import type { Sentence, Token } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
// One-way: nothing in `conjugationContext.ts` imports back from here, so the
// guard can be reached from the two panels without joining any of that file's
// three module-level cycles.
import {
  CONTENT_WORD_POS,
  SLOT_MARKING_PARTICLES,
  caseParticleFor,
  coordinationClosingParticle,
  nextMeaningfulToken,
  rereadSecondReading,
  yuParts,
} from "./conjugationContext.ts";
import { chosenReadingParts, chosenSpellsOutInProse } from "../reading/chosenReading.ts";

// ---------------------------------------------------------------------------
// **One nominal, one slot marker.**
//
// The reader: *"I'm seeing 者はを; make sure we don't get ungrammatical
// sequences of particles."* The second half is the ask — not that 者はを be
// patched, but that the app stop being able to write a particle sequence
// classical Japanese does not have. This file is that guard, and the four
// shapes below are what it was measured against.
//
// **The stacks are written by two mechanisms meeting on one slot**, never by
// one mechanism writing twice. Counted over the whole of kanbun.info's prose
// (3,419 passages), the app wrote 258 of them, in four shapes:
//
//  1. **The token's own reading has already marked the slot**, and
//     `caseParticleFor` marks it again — 之を知る者**はは**上なり (74), 今の孝
//     者**はを** (7), 兵家**のは**勝つ (19), 者**はに** (1). The reading is
//     right in every one of them: 者 is the topic marker は
//     (`zheParticleReading`), 之 the genitive の.
//  2. **The next word read is itself a particle**, and `caseParticleFor` has
//     marked the word in front of it — 縲絏**をの**中に在り (119, the 之 of
//     縲絏之中), 犬馬**をに**至る (43, the 於 of 至於犬馬), **をと** (14, the 與
//     of 見物與侔), **はの** (1). The following particle is right in every one
//     of them, and the case particle is what is wrong: a word standing in front
//     of a genitive 之 or governed by a preposition is not the head of its
//     phrase, so the phrase's marking is not its to carry.
//  3. **A 再読文字 closes on it** — 猶ほ及ばざる**をが**ごとし (8). The が is the
//     連体格 がごとし carries and belongs to the clause 如し governs.
//  4. **A quotation closes right after it** — 敵は衆し**はと**雖も (5). The と
//     is `quoteClosing`'s and belongs to the clause, not to the word.
//
// The guard removes 177 of the 258. What is left is 29 on a content word whose
// *reading* is wrong (arm 1's own note below), 24 where two readings meet (the
// paragraph after next), and a tail of alignment artefacts where the kana in
// question is not a particle at all (繼**が**んとす, まさ**に**).
//
// **So the guard drops `caseParticleFor`'s particle and never the other one**,
// which is the whole of what makes it safe to apply blindly. The two are not
// symmetric: a reading is a fact about a word that both panels display, while
// the case particle is this app supplying a marker the 白文 does not write, and
// where the two collide it is the supplied one that has misjudged the slot.
// A rule that always dropped the *second* particle would be wrong half the
// time — 者はを wants the は kept and 縲絏をの wants the の kept, and those are
// opposite ends of the pair.
//
// **What this guard does not reach, and deliberately.** 24 instances over the
// corpus are two *readings* meeting — 王**はの**道 and 冕**はと**瞽者, where a
// topic は from `zheParticleReading` stands in front of a genitive 之 or a
// comitative 與. No case particle is involved, so there is nothing here to
// withhold: the fault is that 者 was read as a topic marker at all in a slot a
// genitive follows. **Since fixed**, in `zheParticleReading`
// (`readingResolver.ts`), whose topic-marker arm was gated by nothing at all
// where its two neighbours both asked `isTopicSlot`; it now asks the same
// question, and all 33 genitive collisions turned out to stand on `comp:obj`.
// (An earlier draft of this note named a `ZHE_TOPIC_RELATIONS` set, which does
// not exist and never did — the predicate is `isTopicSlot`.)
//
// **Measured.** Removing the 177 moved the prose ratchet from 10,613/69,405
// (gold/parser) to 10,575/69,210 — 194 passages closer, 8 further, net −233
// edits. Every one of the 8 is a correct drop whose cost is a coincidence: the
// app parses 為此之術 as the phrase 此の術 and the site reads it as the clause
// 此を為すの術, so the を this withheld happened to match a を in the received
// text. The reading ratchet does not move at all, this writing no readings.
// ---------------------------------------------------------------------------

/** The 格助詞 a stack may **begin** with — the adverbial cases, which mark a
 * nominal's relation to a predicate and may be followed by a 係助詞 or a
 * 副助詞.
 *
 * **の and が are deliberately absent.** They are adnominal: they mark a
 * nominal's relation to *another nominal*, so the phrase they build is not
 * finished at the particle and nothing binds onto it there. 兵家**のは**勝つ is
 * the shape that absence catches, 19 times over the corpus. */
const ADVERBIAL_CASE_PARTICLES: ReadonlySet<string> = new Set(["を", "に", "と", "へ", "より", "から", "にて"]);

/** The 係助詞 and 副助詞 a stack may **end** with — the particles that bind or
 * limit a phrase already marked for its case, and the only things classical
 * Japanese writes after a 格助詞.
 *
 * The evidence for the list is the construction itself: 其の疾**をのみ**憂ふ
 * (を + のみ), 日中**には** (に + は), 犬馬**にも** (に + も), 命**とは** (と +
 * は). One of the 120 をの the corpus reports is this — 其の疾をのみ — and is
 * why the guard is a list of pairs rather than a ban on two particles in a
 * row. */
const BOUND_PARTICLES: ReadonlySet<string> = new Set([
  "は", "も", "ぞ", "なむ", "や", "か", "こそ", "のみ", "ばかり", "さへ", "だに", "すら", "て",
]);

/** **What counts as a particle already written in the slot** — and it is
 * `SLOT_MARKING_PARTICLES`, imported rather than restated, because it is the
 * same question that table answers for `ownReadingSuppliesCaseParticle`: which
 * particles *mark a nominal's slot*, so that a second one marks it twice.
 *
 * Narrower than `BOUND_PARTICLES` on purpose, and the width is what keeps this
 * off ordinary words. か, も, や and て are the last kana of おろ**か**, いへど**も**,
 * あ**や**ふし and は**て** far more often than they are particles, and a
 * detection set holding them dropped the が of 愚なる**が**如し on the strength
 * of 愚's own おろ**か**. They stay in `BOUND_PARTICLES` above, which decides
 * whether a *found* pair is legal, and out of here, which decides whether
 * there is a pair at all. */
const PARTICLES: ReadonlySet<string> = SLOT_MARKING_PARTICLES;

/** **The closed list of legal stacks, stated once.** A 格助詞 marks the slot
 * and a 係助詞/副助詞 binds what is in it, in that order and in no other:
 * classical Japanese writes 之**をば**, 日中**には**, 命**とは**, 城**にて**,
 * 犬馬**にも**, 之**をも**, 其の疾**をのみ**, and nothing else with two
 * particles in it. So:
 *
 *  - a 係助詞 may follow an adverbial 格助詞 — every pair above;
 *  - nothing at all may follow a 係助詞 (者**はを**, 者**はは**);
 *  - no 格助詞 may follow another 格助詞 (縲絏**をの**, 犬馬**をに**);
 *  - nothing may follow the adnominal の/が (兵家**のは**).
 *
 * をば is the one pair not derivable from the two sets, being を + は with the
 * 濁音 the combination is written with, so it is named.
 *
 * The と that closes a 與 coordination (楯と矛と**を**, 聖と仁と**の**) is not on
 * this list and is not a 格助詞 marking the slot; `writtenCaseParticle` puts it
 * in front of whatever this guard lets through. */
export function stacksLegally(first: string, second: string): boolean {
  if (first === "を" && second === "ば") return true; // をば
  return ADVERBIAL_CASE_PARTICLES.has(first) && BOUND_PARTICLES.has(second);
}

/** Whether writing `particle` immediately after `written` — or immediately
 * before it — would make a sequence of particles classical Japanese does not
 * have. Both arguments may be undefined (nothing written there), and anything
 * this file does not recognise as a particle is nothing written there either. */
function stacks(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) return false;
  if (!PARTICLES.has(before) || !PARTICLES.has(after)) return false;
  return !stacksLegally(before, after);
}

/** The particle a token's **own reading** has already written in its slot, or
 * undefined.
 *
 * Two shapes, and both are on the page as a particle rather than as a kana
 * that ends a word:
 *
 *  - the reading is *nothing but* the particle — 之 read の, 於 read に, 與 read
 *    と. These are `spellOutInProse` function words whose whole rendering is
 *    the particle.
 *  - the reading is a word plus the particle in the okurigana slot — 者 read
 *    もの + は, 為 read ため + に. Matched whole, exactly as
 *    `ownReadingSuppliesCaseParticle` matches: 幸 さいは + ひに and 再 ふたた +
 *    び end in a particle's kana and contain no particle.
 *
 * `yuParts` is asked first because it, and not the resolver, is what answers
 * for 於/于/乎 in both panels — see its own note, and the two branches in
 * `generator.ts` and `KundokuView.ts` that consult it ahead of the resolver. */
function slotParticleWrittenBy(
  token: Token,
  sentence: Sentence,
  resolve: ReadingResolver,
): { leading?: string; trailing?: string } {
  const yu = yuParts(token, sentence);
  if (yu) {
    // より/に written in place of the character is the whole word; おいて is
    // written on it and is a verb form, not a particle.
    if (!yu.reading && PARTICLES.has(yu.okurigana)) return { leading: yu.okurigana, trailing: yu.okurigana };
    return {};
  }
  const pinned = chosenReadingParts(token);
  const parts = pinned
    ? { reading: pinned.reading, okurigana: pinned.okurigana, spellOut: chosenSpellsOutInProse(token) }
    : (() => {
        const r = resolve(token, sentence);
        return { reading: r.reading, okurigana: r.okurigana, spellOut: r.spellOutInProse === true };
      })();
  // The empty okurigana is no okurigana. Several override entries state one
  // deliberately — 之 carries `"okurigana": ""` so that the の goes *over* the
  // character rather than beside it — and a `=== undefined` test reads those as
  // "has an okurigana" and then finds no particle in it. See the 之 entry's own
  // gloss in `overrides.json`.
  const okurigana = parts.okurigana === undefined || parts.okurigana === "" ? undefined : parts.okurigana;
  const out: { leading?: string; trailing?: string } = {};
  if (okurigana !== undefined && PARTICLES.has(okurigana)) out.trailing = okurigana;
  if (parts.spellOut) {
    // **The whole rendering, not its first kana.** A word written out in kana
    // *is* a particle only when there is nothing else in it: 之 is の and 於 is
    // に, while 者 is もの + は, whose は marks the slot at the end and leaves
    // nothing standing in front of the next word.
    const whole = parts.reading + (okurigana ?? "");
    if (PARTICLES.has(whole)) {
      out.leading = whole;
      out.trailing = whole;
    }
  }
  return out;
}

/** The particle a 再読文字 closing on `closingId` writes in front of whatever
 * stands there — が for 猶/由 (がごとし) and nothing for any of the others. See
 * arm 3 of `writtenCaseParticle` for why reading a first character is safe
 * here and nowhere else in this file. */
function rereadSecondParticleAfter(
  plan: ReadingPlan,
  closingId: number,
  resolve: ReadingResolver,
): string | undefined {
  for (const rereadId of plan.rereadCloseIds.get(closingId) ?? []) {
    const reread = plan.sentence.tokens.find((t) => t.id === rereadId);
    if (!reread) continue;
    const head = [...rereadSecondReading(reread, plan, resolve)][0];
    if (head !== undefined && PARTICLES.has(head)) return head;
  }
  return undefined;
}

/** **The guard, and the one entry point both panels call in place of
 * `caseParticleFor`.**
 *
 * `caseParticleFor` answers what particle the token's *relation* wants; this
 * answers what may actually be written, which is the same thing except where
 * the slot is already marked. Placed here — at the point of assembly, one
 * token and one particle slot — rather than at the dozen branches inside
 * `caseParticleFor` that can each write one: what makes a stack is two
 * mechanisms meeting, and neither of them can see the other from where it
 * stands. `ownReadingSuppliesCaseParticle` is the one such test that already
 * lives inside `caseParticleFor`, and it stays there because
 * `readingResolver.ts` asks that function the same question for its own
 * purposes; this generalises it — to any reading rather than the override
 * table's, and to the *next* word as well as this one.
 *
 * `afterId` is the token the next-word half looks past, for the one caller
 * whose particle is written after a span rather than after its carrier: the
 * carrier holds the relation, the span's last member holds the position. */
export function writtenCaseParticle(
  token: Token,
  plan: ReadingPlan,
  resolve: ReadingResolver,
  afterId: number = token.id,
): string | undefined {
  const particle = guardedCaseParticle(token, plan, resolve, afterId);
  const closing = coordinationClosingParticle(token, plan.sentence);
  if (closing === undefined) return particle;
  // **A與B closes on a second と, and the case particle stacks after it** —
  // 楯と矛とを, 聖と仁との, 文と武とは, 後母と弟とに. See
  // `coordinationClosingParticle`.
  //
  // This is the one stack this file writes rather than refuses, and it sits
  // outside every arm of the guard on purpose. The coordinating と is not a
  // 格助詞 marking the slot, so the pairs `stacksLegally` lists do not describe
  // it: と+を and と+の are illegal there (no 格助詞 follows another) and are
  // exactly what AとBとを and AとBとの are. So the guard is asked about the case
  // particle alone, as if the と were not there, and the と is put in front of
  // whatever survives. Where the guard withheld the case particle because the
  // next word is itself one (a genitive 之 read の after the phrase), the と
  // still stands and meets that の as AとBとの, the shape of the received
  // 聖と仁との若き.
  //
  // It stands down only where **another と already follows**, since a と
  // followed by a と is no reading: a quotation closing on the same word, whose
  // と `quoteClosing` writes, and a next word read と. The second is the parse
  // of 與命與仁 that makes the first 與 a preposition heading the sentence and
  // reads it after the phrase: 命と仁と is already written without this, and
  // adding the closing と gave 命と仁とと.
  if (plan.quoteEndIds.has(afterId)) return particle;
  const next = nextMeaningfulToken(plan, afterId);
  if (next && slotParticleWrittenBy(next, plan.sentence, resolve).leading === closing) return particle;
  return closing + (particle ?? "");
}

/** `writtenCaseParticle` before the coordinating と is added: the case
 * particle the relation wants, less any the four arms below withhold. */
function guardedCaseParticle(
  token: Token,
  plan: ReadingPlan,
  resolve: ReadingResolver,
  afterId: number,
): string | undefined {
  const particle = caseParticleFor(token, plan.sentence);
  if (particle === undefined) return undefined;

  // 1. This word's own reading has already marked the slot.
  //
  // **Not on a content word**, on `ownReadingSuppliesCaseParticle`'s own
  // boundary and for the reason its `CONTENT_WORD_POS` doc gives at length: a
  // NOUN or VERB or ADJ whose reading ends in a particle is one whose *reading*
  // is wrong, and standing down there deletes the one correct piece and leaves
  // the wrong word standing. 溫**故**知新 is the case — 故 read ゆゑ**に** by an
  // over-broad override entry where the noun 故 "the old" is meant, and the を
  // this would withhold is the right particle on a wrong word (故きを溫ねて).
  // Withholding it moved that passage *away* from the received reading, which
  // is the measurement that boundary predicts. Same for 徒 いたづらに and 卒
  // にはかに: 29 stacks over the corpus, left standing on purpose, because the
  // correction is to those entries' context conditions in `overrides.json` and
  // not to the particle written after them.
  const own = CONTENT_WORD_POS.has(token.pos)
    ? {}
    : slotParticleWrittenBy(token, plan.sentence, resolve);
  if (stacks(own.trailing, particle)) return undefined;

  // 2. A quotation closes on this word — `quoteClosing` writes its と after
  //    whatever is written here, and the と belongs to the clause.
  if (plan.quoteEndIds.has(afterId) && stacks(particle, "と")) return undefined;

  // 3. A 再読文字 closes on this word, and its second reading opens with the
  //    particle that governs the clause — 猶/由, whose がごとし carries the 連体格
  //    が that 如し takes. 猶ほ及ばざる**をが**ごとし is what that reaches, 8 times
  //    over the corpus; the received reading is 猶ほ及ばざるがごとし, and the が
  //    belongs to ごとし while the を belonged to nothing.
  //
  //    The one place in this file that looks at a particle's *first* character
  //    rather than matching a whole word, and safe only because what it looks at
  //    is a **closed table of twelve strings** (`REREAD_CHARACTERS`) that can be
  //    read at a glance: ず, んとす, べし, ざる and がごとし, of which がごとし is
  //    the only one that opens with a particle at all.
  if (stacks(particle, rereadSecondParticleAfter(plan, afterId, resolve))) return undefined;

  // 4. The next word read is itself a particle.
  const next = nextMeaningfulToken(plan, afterId);
  if (next && stacks(particle, slotParticleWrittenBy(next, plan.sentence, resolve).leading)) return undefined;

  return particle;
}
