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
 * a tag absent from the result has probability zero. */
export async function posScores(args: {
  text: string;
  tokenCount: number;
  tokenIndex: number;
}): Promise<Record<string, number> | null> {
  await initParser();
  return send<Record<string, number> | null>({ type: "posScores", ...args });
}

