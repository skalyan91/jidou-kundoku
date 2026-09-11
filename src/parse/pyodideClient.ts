import type { TokenTree } from "./types.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();
let initPromise: Promise<void> | null = null;

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./pyodideWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      const { id, ok, result, error } = event.data;
      const req = pending.get(id);
      if (!req) return;
      pending.delete(id);
      if (ok) req.resolve(result);
      else req.reject(new Error(error));
    };
  }
  return worker;
}

function send<T>(message: { type: string; [key: string]: unknown }): Promise<T> {
  const id = nextId++;
  const w = ensureWorker();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, ...message });
  });
}

/** Initializes the in-browser parser (Pyodide + spaCy + lzh_sud_kyoto),
 * caching the result for the session — subsequent calls resolve immediately.
 * Rejects if the vendored wheels/model aren't available; callers should
 * treat that as "live parsing unavailable, fall back to CoNLL-U upload"
 * rather than a fatal error. A failed attempt is not cached: the worker
 * (whose own internal init state would otherwise wedge on the first error)
 * is torn down and recreated, so the next call is a genuine retry rather
 * than replaying the same stale failure forever. */
/** Whether this session has a parser behind it *at all* — true once
 * `initParser` has been called and has not (yet) failed, false in a session
 * that has never asked for one and false again after an attempt rejected.
 *
 * Not "is the parser ready": an init still in flight answers true, because
 * what the one caller needs to know is whether asking would *start* the
 * download rather than join it. That caller is the xpos prefetch
 * (`xposScoreCache.ts`), which fires on a right click and must be free: the
 * app calls `initParser` before it parses, so a live-parsed tree always
 * answers true here, and a CoNLL-U upload — a tree the model never saw, and a
 * session that has deliberately not paid for 20MB of Pyodide and 26.5MB of
 * wheels — answers false and is left alone. The menus in such a session behave
 * exactly as they did before there was a prefetch: opening one asks, and
 * whatever that costs is a cost the reader has asked for by opening it. */
export function parserStarted(): boolean {
  return initPromise !== null;
}

export function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = send<void>({ type: "init" }).catch((err) => {
      initPromise = null;
      worker?.terminate();
      worker = null;
      throw err;
    });
  }
  return initPromise;
}

export async function parseText(text: string): Promise<TokenTree> {
  await initParser();
  return send<TokenTree>({ type: "parse", text });
}

/** What this parser makes of one specific head→child arc, given the rest of
 * the sentence's tree: the relation it scores highest there, and how much of
 * its probability mass at that point of the parse goes to making the arc at
 * all. See `scoreArc` in the worker for how both are derived and when the
 * whole thing comes back null (an arc the transition oracle can't reach).
 *
 * `heads`/`deps` are the whole sentence's values, indexed by token id, for
 * *the tree the arc is being scored inside*. Which tree that is differs by
 * caller: relabelling asks about the edited tree, with the new head already
 * applied, while ranking an existing arc's confidence asks about the tree
 * that arc actually belongs to. */
export interface ArcScore {
  label: string;
  /** In [0, 1] — see `scoreArc`. The sum of `labels`. */
  confidence: number;
  /** Per relation, the probability the parser puts on giving this arc that
   * relation. A relation absent from here is one the transition system
   * ruled out at this point of the parse: a probability of zero, not a
   * missing measurement. Also carries spaCy's deprojectivization
   * pseudo-labels (`punct||mod`), which match nothing a caller shows. */
  labels: Record<string, number>;
}

export async function scoreArc(args: {
  text: string;
  heads: number[];
  deps: string[];
  headIndex: number;
  childIndex: number;
}): Promise<ArcScore | null> {
  await initParser();
  return send<ArcScore | null>({ type: "arcScore", ...args });
}

/** The model's own distribution over UPOS for one token of `text`, keyed by
 * tag — see `posDistribution` in the worker for which pipe answers this and
 * what it covers. `tokenCount` is the caller's own token count, checked
 * against the model's tokenization so an answer is never given about a
 * different segmentation of the same string. Null where it cannot answer;
 * a tag absent from the result has probability zero.
 *
 * **Nothing in the app calls this today.** It shaded the 品詞 menu until that
 * menu stopped offering UPOS: it offers the treebank's own four-field xpos
 * now, and the morphologiser has no opinion about one — see `xposPrior` in
 * tokenInspector.ts, which says why mapping this distribution onto xpos rows
 * would be worse than not asking. Kept rather than deleted because it is a
 * faithful reading of a pipe the model really has, and the pipe's own half of
 * it (`posDistribution` in the worker) is what would have to go with it; a
 * caller that wants the model's UPOS opinion will find it here. */
export async function posScores(args: {
  text: string;
  tokenCount: number;
  tokenIndex: number;
}): Promise<Record<string, number> | null> {
  await initParser();
  return send<Record<string, number> | null>({ type: "posScores", ...args });
}

/** The worker's answer, made safe to draw with — the client half of
 * `xposScores`'s contract, and pure so that it can be tested without a
 * worker (there is no harness in this repo that can run Pyodide).
 *
 * The worker already returns a normalised distribution; this exists because
 * *the worker* is the thing on the far side of a `postMessage` and a
 * `JSON.parse`, and a caller that shades a menu by these numbers should not
 * have to ask whether one of them is a string, a NaN, or a negative that a
 * float32 renormalisation let through. Entries that are not finite positives
 * are dropped rather than repaired: a probability that arrives malformed is
 * not a small probability, it is no measurement at all, and the row it names
 * is better left to the corpus prior. What survives is divided by its own
 * sum, so the caller's "these sum to 1" holds whatever was dropped, and an
 * answer with nothing left in it comes back null like any other refusal. */
export function normalizeXposScores(raw: unknown): Record<string, number> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kept: [string, number][] = [];
  let total = 0;
  for (const [tag, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    kept.push([tag, value]);
    total += value;
  }
  if (!kept.length || !(total > 0)) return null;
  return Object.fromEntries(kept.map(([tag, value]) => [tag, value / total]));
}

/** The model's own distribution over the treebank's four-field xpos for one
 * token of `text`, keyed by the whole tag (`"v,動詞,行為,動作"`) and summing to
 * 1 — see `xposDistribution` in the worker for which pipe answers this, why
 * it is the tagger's *joint* head rather than its four per-field ones, and
 * what it was validated against.
 *
 * Unlike `posScores`, whose 品詞 menu it replaced, this speaks the same
 * vocabulary the menus are made of: its label set is the treebank's own
 * attested inventory, so nothing has to be marginalised or mapped on the way
 * out. Two caveats for a caller holding `xpos-inventory.json`, which is built
 * from the treebank rather than from the model's tables and differs from them
 * by one tag each way: `n,名詞,思考,*` is in the menu and can never be
 * predicted (the tagger never saw it), and `s,文字,*,*` can be predicted and
 * is not in the menu. Neither is an error; a caller should tolerate a key it
 * does not recognise and treat a missing one as zero.
 *
 * `tokenCount` is the caller's own token count, checked against the model's
 * tokenization so an answer is never given about a different segmentation of
 * the same string. Null where it cannot answer — no such pipe, index out of
 * range, tokenization moved, or a tagger with no attested inventory or no
 * joint block — and callers shade from the corpus prior in that case.
 *
 * **Nothing in the app calls this today**, for a reason that is worth stating
 * rather than being rediscovered. The menus it was written for now read the
 * cache in `xposScoreCache.ts`, which is filled by `xposScoresForSentence`
 * below: the worker's pass tags the whole doc anyway, so a menu that asked
 * about one token at a time was paying for the sentence and keeping one row
 * of it. It is not a fallback for that path either — the two share their
 * Python in the worker and refuse in exactly the same cases, so a token the
 * batch declined to score is not a token this would score. Kept because it is
 * the honest one-token form of a measurement the model really makes, and a
 * caller wanting one token's distribution and nothing else will find it here
 * — the same grounds `posScores` above is kept on. */
export async function xposScores(
  text: string,
  tokenCount: number,
  tokenIndex: number,
): Promise<Record<string, number> | null> {
  await initParser();
  const raw = await send<unknown>({ type: "xposScores", text, tokenCount, tokenIndex });
  return normalizeXposScores(raw);
}

/** The same distribution for every token of the sentence at once, in token
 * order — `xposScores`'s answer for index *i* at position *i*, and null at a
 * position the model had nothing usable for. Null instead of the list where
 * the question itself is refused, for the reasons on `xposScores`: no such
 * pipe, a tokenization other than the caller's, a tagger with no joint block.
 *
 * **One request, not N.** The worker runs the whole pipeline prefix over the
 * whole doc to answer about one token, and then throws away the other rows;
 * asking token by token re-runs that prefix once per token over the same
 * string. This is the shape the menus actually want — a reader annotating a
 * sentence opens menus on several of its characters — and it is what
 * `xposScoreCache.ts` fills its cache from. See `xposDistributions` in the
 * worker, where row *i* is the single-token call's answer for *i* by
 * construction, the two sharing their Python.
 *
 * The length check is not a formality. `tokenCount` is the caller's own count
 * and the worker refuses whenever the model's tokenization disagrees with it,
 * so a list that comes back a different length is not a shorter answer to the
 * question asked — it is an answer to some other question, and the only safe
 * reading of it is that there is no answer. Callers index this list by token
 * id and would otherwise silently read a neighbouring token's distribution. */
export async function xposScoresForSentence(
  text: string,
  tokenCount: number,
): Promise<(Record<string, number> | null)[] | null> {
  await initParser();
  const raw = await send<unknown>({ type: "xposScoresForSentence", text, tokenCount });
  if (!Array.isArray(raw) || raw.length !== tokenCount) return null;
  return raw.map((row) => normalizeXposScores(row));
}
