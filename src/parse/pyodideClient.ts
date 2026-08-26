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

/** The relation label this parser scores highest for one specific
 * head→child arc, given the rest of the sentence's tree — see
 * `bestDeprelForArc` in the worker for how it's derived and when it
 * returns null (an arc the transition oracle can't reach). `heads`/`deps`
 * are the whole sentence's current values, indexed by token id, *with the
 * caller's intended new head already applied*. */
export async function bestDeprelForArc(args: {
  text: string;
  heads: number[];
  deps: string[];
  headIndex: number;
  childIndex: number;
}): Promise<string | null> {
  await initParser();
  return send<string | null>({ type: "arcLabel", ...args });
}

