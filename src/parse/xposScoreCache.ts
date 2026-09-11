import { parserStarted, xposScoresForSentence } from "./pyodideClient.ts";

/** **The tagger's opinion, fetched when the reader starts annotating rather
 * than when they open a menu.**
 *
 * The 品詞/意味 menus are shaded twice: from the corpus prior, synchronously,
 * and then from the model's own distribution over this token's xpos if one can
 * be had (see `shadeRetagMenu` and `xposPosterior` in tokenInspector.ts). The
 * second of those used to be fetched *by the menu*, one token at a time, on
 * the open — which meant every menu opened grey-from-frequency and then
 * re-shaded a moment later, and meant the same sentence was pushed through the
 * pipeline again for every character the reader looked at.
 *
 * This is the fix, and it is entirely about *when*: the numbers are the same
 * numbers. Showing the analysis for a character (the right click — the moment
 * the reader stops reading and starts annotating) kicks off one request for
 * that character's whole sentence, and by the time a menu is opened the answer
 * is usually already here, so the menu can be shaded from the posterior in the
 * frame that draws it, with no `await` anywhere in the path.
 *
 * **What is keyed, and why both halves.** A sentence's entry is keyed by its
 * text *and* its token count together — the same discipline the worker keeps,
 * which refuses to answer about any tokenization but the caller's. Text alone
 * would be the obvious key and is the wrong one: two renders can present the
 * same characters cut into different numbers of tokens (a re-parse whose
 * sentence splitting moved, a CoNLL-U upload beside a live parse of the same
 * passage), and an entry fetched under one of those must not be handed to the
 * other, whose token ids index something else. Keying on both makes a changed
 * tokenization a cache *miss* rather than a wrong answer; there is no
 * invalidation step to forget to run.
 *
 * Nothing else invalidates, and that is not an oversight: this distribution is
 * conditioned on the characters alone. The worker builds its own doc from the
 * text and runs its own pipeline over it, so the reader's edits — a corrected
 * xpos, a re-pointed head, a relabelled arc — cannot move it. An entry stays
 * true for as long as the sentence's characters and cut stay put, which is for
 * the whole session in practice, and re-fetching after an edit would spend a
 * pipeline pass to arrive at the identical row.
 *
 * **A cap, because the entries are not free.** The attested inventory is 121
 * tags and every one of them comes back with a probability, so a token's
 * distribution is 121 (tag, probability) pairs — measured on 子曰、道千乘之國…
 * (24 tokens), the sentence's answer is 108k characters of JSON, ~4.5KB per
 * token before it is parsed into objects whose keys share nothing with their
 * neighbours'. That is nothing for the sentence being annotated and a great
 * deal for a reader who annotates their way down a long text, where an
 * uncapped map would end the session holding hundreds of sentences it will
 * never be asked about again. So the map holds the `XPOS_CACHE_CAPACITY` most
 * recently *used* sentences and drops the oldest, which for this access
 * pattern (a reader works in one sentence, then the next) evicts nothing that
 * was going to be a hit. */

/** How many sentences' distributions are kept. A dozen is far more than the
 * one sentence a reader is annotating and the few around it, and bounds the
 * cache at a few megabytes at the sizes measured above. The number is a memory
 * bound, not a tuning parameter: hits come from the sentence the reader is
 * *in*, so nothing is gained by remembering the fiftieth-most-recent one, and
 * the cost of a miss is the round trip the reader used to pay on every menu.
 *
 * Exported for the tests, which fill the cache past it: a test that hard-coded
 * a dozen would start passing vacuously the moment this moved. */
export const XPOS_CACHE_CAPACITY = 12;

/** Settled answers, newest use last — `Map` iterates in insertion order, and
 * every read re-inserts, which is what makes eviction least-recently-*used*
 * rather than least-recently-fetched. A value of null is a settled refusal
 * (the worker declined: no parser pipe, a tokenization that disagrees) and is
 * cached exactly like an answer, because re-asking a question the worker has
 * already refused would cost a pipeline pass to be refused again. */
const settled = new Map<string, (Record<string, number> | null)[] | null>();

/** Requests in flight, so that N right clicks in one sentence make one
 * request. Cleared as each settles, and never cached as a value: a request
 * that threw (no parser in this session, a worker that died) leaves nothing
 * behind, so a later attempt is a genuine retry rather than a replay of the
 * failure — the same rule `initParser` keeps about its own init promise. */
const inFlight = new Map<string, Promise<void>>();

/** Text and token count in one string. The count goes first, so the digits
 * before the separator are unambiguous however the text begins, and the
 * separator is NUL, which nothing the parser was handed can contain — between
 * them, no two (text, count) pairs can be made to collide by moving the
 * boundary. */
function keyOf(text: string, tokenCount: number): string {
  return `${tokenCount}\u0000${text}`;
}

function remember(key: string, rows: (Record<string, number> | null)[] | null): void {
  settled.set(key, rows);
  while (settled.size > XPOS_CACHE_CAPACITY) {
    const oldest = settled.keys().next();
    if (oldest.done) break;
    settled.delete(oldest.value);
  }
}

/** Fetches the sentence's distributions into the cache, and resolves when
 * there is nothing further to wait for — with the answer cached, with a
 * refusal cached, or with neither if the request failed outright. Never
 * rejects: every caller of this is either drawing something or about to, and
 * has the corpus prior to fall back on.
 *
 * Idempotent and safe to call on a sentence already cached or already in
 * flight; the second caller joins the first request rather than making a
 * second one. */
export async function loadXposScores(text: string, tokenCount: number): Promise<void> {
  const key = keyOf(text, tokenCount);
  if (settled.has(key)) return;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = xposScoresForSentence(text, tokenCount)
    .then((rows) => {
      remember(key, rows);
    })
    .catch(() => {
      // No parser in this session, or the worker broke. Deliberately not
      // remembered: unlike the worker's null, which is a considered refusal,
      // this is the machinery failing, and the next attempt should be allowed
      // to find it working.
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Starts the fetch and returns immediately — the form the render path uses.
 *
 * Two properties matter to that caller and both are load-bearing. It does no
 * work of its own before returning (the client's `postMessage` and the
 * promise's `then` are all that happen synchronously), so the overlay draws in
 * the frame the right click asked for it in; and it cannot throw, so nothing
 * that goes wrong in the worker can reach a render path that has no business
 * catching it.
 *
 * **It declines to start a parser that this session never started.** Asking
 * for a distribution is asking `initParser` first, and in a session built from
 * a CoNLL-U upload that would begin a ~46MB download on a right click — a
 * gesture that costs nothing today. `parserStarted` distinguishes the two
 * cases: a live-parsed tree has a parser (the app inits one before parsing, so
 * this is true by the time any tree exists) and this prefetches; an uploaded
 * tree has none and this does nothing at all. Its menus then behave exactly as
 * they always have, opening on the corpus prior and asking the model — and
 * paying for it — only if the reader opens one. */
export function prefetchXposScores(text: string, tokenCount: number): void {
  if (!parserStarted()) return;
  void loadXposScores(text, tokenCount);
}

/** What the cache has for one token, read synchronously — the whole point of
 * the cache, since a menu that has to `await` this has already lost the frame
 * it was trying to shade in.
 *
 * Three-valued on purpose, and the third value is the useful one:
 *
 *   - a distribution, to shade from;
 *   - `null`, the model's settled refusal to answer about this token — shade
 *     from the corpus prior and *do not ask again*;
 *   - `undefined`, nothing cached yet, which is the only case where a caller
 *     should consider waiting.
 *
 * Collapsing the last two into one null is the mistake this signature exists
 * to prevent: a caller that could not tell them apart would re-ask, on every
 * menu open, a question the worker has already declined once — a pipeline pass
 * per open, for a refusal that is not going to change.
 *
 * Reading also refreshes the entry's recency, so the sentence a reader keeps
 * coming back to is the last thing evicted. */
export function cachedXposScores(
  text: string,
  tokenCount: number,
  tokenIndex: number,
): Record<string, number> | null | undefined {
  const key = keyOf(text, tokenCount);
  const rows = settled.get(key);
  if (rows === undefined) return undefined;
  settled.delete(key);
  settled.set(key, rows);
  if (rows === null) return null;
  // In range by construction — the client checks the list's length against
  // this same `tokenCount` before it is ever cached — but a token id from a
  // stale render is cheap to guard against and expensive to mistake for a
  // neighbour's distribution.
  return rows[tokenIndex] ?? null;
}

/** Empties the cache. For tests, which need each of them to start cold; the
 * app has no reason to forget an answer that cannot go stale. */
export function resetXposScoreCache(): void {
  settled.clear();
  inFlight.clear();
}
