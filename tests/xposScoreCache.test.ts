import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** **The xpos cache: what is asked for, when, and how often.**
 *
 * The cache exists so that a 品詞 or 意味 menu can be shaded from the model in
 * the frame that draws it — the request goes out when the reader asks to see
 * the analysis (the right click), not when they open the menu. Nothing here
 * can watch a menu draw: there is no DOM in this suite, and no Pyodide either
 * (see the head of xposScores.test.ts for why the far half of this is
 * measured in a doc comment rather than asserted). What *is* observable is the
 * wire and the clock, and they are the two things the cache is about:
 *
 *   - that reading a warm entry is a plain synchronous return which sends
 *     nothing — "the menu does not wait" is exactly this;
 *   - that a sentence is fetched once however many characters of it are
 *     visited, and re-fetched when its *tokenization* changes;
 *   - that a refusal is remembered (asking again would cost a pipeline pass to
 *     be refused again) while a failure is not (the parser may yet arrive).
 *
 * The worker is faked, as in xposScores.test.ts: a class recording what it was
 * sent and answering with whatever the test hands it. So every assertion below
 * is about traffic and cache behaviour, never about what a model would say —
 * the distributions here are shapes with plausible keys and nothing more. */

interface WireMessage {
  id: number;
  type: string;
  [key: string]: unknown;
}

let answer: (msg: WireMessage) => unknown = () => null;
let sent: WireMessage[] = [];
/** Set by a test that wants the worker to break rather than refuse. */
let fail = false;

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(_url: unknown, _options?: unknown) {}

  postMessage(msg: WireMessage): void {
    sent.push(msg);
    queueMicrotask(() => {
      if (msg.type === "init") {
        this.onmessage?.({ data: { id: msg.id, ok: true } });
        return;
      }
      if (fail) {
        this.onmessage?.({ data: { id: msg.id, ok: false, error: "boom" } });
        return;
      }
      this.onmessage?.({ data: { id: msg.id, ok: true, result: answer(msg) } });
    });
  }

  terminate(): void {}
}

/** Two well-formed distributions, standing in for the tagger's answers on 說
 * (torn between the 悦 and 説 readings) and 學 (not torn at all). Shapes, not
 * measurements — nothing here claims the model says this, and the numbers are
 * halves and quarters on purpose: they sum to exactly 1, so the client's
 * defensive renormalisation is the identity on them and an assertion can
 * compare against the literal rather than against a rescaling of it. */
const SETSU = { "v,動詞,行為,態度": 0.75, "v,動詞,行為,伝達": 0.25 };
const GAKU = { "v,動詞,行為,交流": 0.875, "n,名詞,主体,人": 0.125 };

/** 學而時習之、不亦說乎 as the worker would answer for it: ten rows, 學 at 0
 * and 說 at 8, the rest of the sentence's rows left out as nulls so the
 * assertions can tell one row from another. */
const SENTENCE = "學而時習之、不亦說乎";
const ROWS = [GAKU, null, null, null, null, null, null, null, SETSU, null];

type Client = typeof import("../src/parse/pyodideClient.ts");
type Cache = typeof import("../src/parse/xposScoreCache.ts");

/** The client caches its worker at module scope and the cache module its map,
 * so a test that shared either with the previous one would inherit its
 * traffic. Both are imported from the same fresh graph so that the cache is
 * talking to the client the test is watching. */
async function fresh(): Promise<{ client: Client; cache: Cache }> {
  vi.resetModules();
  const client = (await import("../src/parse/pyodideClient.ts")) as Client;
  const cache = (await import("../src/parse/xposScoreCache.ts")) as Cache;
  return { client, cache };
}

/** A session with a parser in it — what the app has by the time any tree is on
 * the screen, since it inits the parser before it parses. */
async function warmSession(): Promise<{ client: Client; cache: Cache }> {
  const both = await fresh();
  await both.client.initParser();
  sent = [];
  return both;
}

const wireTypes = (): string[] => sent.map((m) => m.type);

beforeEach(() => {
  sent = [];
  fail = false;
  answer = () => ROWS;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("prefetching", () => {
  it("asks for the whole sentence, once, however many characters are visited", async () => {
    const { cache } = await warmSession();
    // Three right clicks in one sentence — the reader working across it.
    cache.prefetchXposScores(SENTENCE, 10);
    cache.prefetchXposScores(SENTENCE, 10);
    cache.prefetchXposScores(SENTENCE, 10);
    await cache.loadXposScores(SENTENCE, 10);
    expect(wireTypes()).toEqual(["xposScoresForSentence"]);
    expect(sent[0]).toMatchObject({ text: SENTENCE, tokenCount: 10 });
  });

  it("asks nothing at all in a session with no parser behind the tree", async () => {
    const { cache } = await fresh();
    // A CoNLL-U upload: nothing has called `initParser`, and a right click
    // must not be the thing that begins a ~46MB download.
    cache.prefetchXposScores(SENTENCE, 10);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(cache.cachedXposScores(SENTENCE, 10, 0)).toBeUndefined();
  });

  it("still lets a menu ask outright, which is how such a session gets its shading", async () => {
    const { cache } = await fresh();
    // `loadXposScores` is the menu's own path and is deliberately not gated:
    // opening a menu is the reader asking, and it inits the parser exactly as
    // it did before the prefetch existed.
    await cache.loadXposScores(SENTENCE, 10);
    expect(wireTypes()).toEqual(["init", "xposScoresForSentence"]);
    expect(cache.cachedXposScores(SENTENCE, 10, 8)).toMatchObject(SETSU);
  });

  it("does not throw out of the render path when the worker breaks", async () => {
    const { cache } = await warmSession();
    fail = true;
    // The one hard requirement on the fire-and-forget form: an unhandled
    // rejection here would surface in the middle of drawing the overlay.
    expect(() => cache.prefetchXposScores(SENTENCE, 10)).not.toThrow();
    await expect(cache.loadXposScores(SENTENCE, 10)).resolves.toBeUndefined();
  });
});

describe("reading a warm cache", () => {
  it("hands back the row synchronously, and sends nothing to do it", async () => {
    const { cache } = await warmSession();
    await cache.loadXposScores(SENTENCE, 10);
    const before = sent.length;
    const got = cache.cachedXposScores(SENTENCE, 10, 8);
    // Synchronous in the sense the menu needs: a value, not a thenable. An
    // `async` function runs to its first `await`, so a read that returned a
    // promise would cost `shadeRetagMenu` the frame it is shading in.
    expect(typeof (got as unknown as { then?: unknown })?.then).not.toBe("function");
    expect(got).toMatchObject(SETSU);
    // Every other character of the sentence is warm too, off the same request.
    expect(cache.cachedXposScores(SENTENCE, 10, 0)).toMatchObject(GAKU);
    expect(sent.length).toBe(before);
  });

  it("normalises on the way in, so the caller draws a distribution", async () => {
    const { cache } = await warmSession();
    await cache.loadXposScores(SENTENCE, 10);
    const got = cache.cachedXposScores(SENTENCE, 10, 8)!;
    expect(Object.values(got).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(got["v,動詞,行為,態度"]).toBeGreaterThan(got["v,動詞,行為,伝達"]);
  });

  it("is null for a token the model had nothing for, and null off the end", async () => {
    const { cache } = await warmSession();
    await cache.loadXposScores(SENTENCE, 10);
    expect(cache.cachedXposScores(SENTENCE, 10, 1)).toBeNull();
    expect(cache.cachedXposScores(SENTENCE, 10, 99)).toBeNull();
  });
});

describe("the three values of a read", () => {
  it("separates 'not yet asked' from 'asked and refused'", async () => {
    const { cache } = await warmSession();
    // Cold: undefined, the only value that means a caller should consider
    // waiting.
    expect(cache.cachedXposScores(SENTENCE, 10, 0)).toBeUndefined();
    answer = () => null;
    await cache.loadXposScores(SENTENCE, 10);
    // Refused: null, and a caller must shade from the corpus prior and stop
    // asking. Collapsing the two would spend a pipeline pass per menu open on
    // a refusal that is not going to change.
    expect(cache.cachedXposScores(SENTENCE, 10, 0)).toBeNull();
    const before = sent.length;
    await cache.loadXposScores(SENTENCE, 10);
    cache.prefetchXposScores(SENTENCE, 10);
    await Promise.resolve();
    expect(sent.length).toBe(before);
  });

  it("does not remember a failure, so the next attempt is a real retry", async () => {
    const { cache } = await warmSession();
    fail = true;
    await cache.loadXposScores(SENTENCE, 10);
    // Nothing cached: the worker breaking says nothing about the answer, and
    // the parser may be there next time.
    expect(cache.cachedXposScores(SENTENCE, 10, 8)).toBeUndefined();
    fail = false;
    await cache.loadXposScores(SENTENCE, 10);
    expect(cache.cachedXposScores(SENTENCE, 10, 8)).toMatchObject(SETSU);
    expect(wireTypes()).toEqual(["xposScoresForSentence", "xposScoresForSentence"]);
  });
});

describe("keying", () => {
  it("misses when the same characters are cut into a different number of tokens", async () => {
    const { cache } = await warmSession();
    await cache.loadXposScores(SENTENCE, 10);
    // The worker refuses to answer about any tokenization but the caller's, so
    // an entry fetched under one count says nothing about another: token 8 of
    // a nine-token cut is a different character. A miss, not a stale hit —
    // which is what makes the keying its own invalidation.
    expect(cache.cachedXposScores(SENTENCE, 9, 8)).toBeUndefined();
    answer = () => [GAKU, null, null, null, null, null, null, null, null];
    await cache.loadXposScores(SENTENCE, 9);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ tokenCount: 9 });
    // And the two live side by side, each answering for its own cut.
    expect(cache.cachedXposScores(SENTENCE, 9, 8)).toBeNull();
    expect(cache.cachedXposScores(SENTENCE, 10, 8)).toMatchObject(SETSU);
  });

  it("misses on different characters, however similar the shape", async () => {
    const { cache } = await warmSession();
    await cache.loadXposScores(SENTENCE, 10);
    expect(cache.cachedXposScores("學而時習之、不亦樂乎", 10, 8)).toBeUndefined();
  });

  it("cannot be made to collide by moving the boundary between its two halves", async () => {
    const { cache } = await warmSession();
    // A key built by pasting the count onto the text has to be unambiguous
    // about where one ends and the other begins, or a text that starts with a
    // digit can be made to answer for another.
    await cache.loadXposScores("1文", 2);
    expect(cache.cachedXposScores("文", 21, 0)).toBeUndefined();
  });
});

describe("eviction", () => {
  it("keeps the capacity most recent sentences and drops what falls off", async () => {
    const { cache } = await warmSession();
    const texts = Array.from({ length: cache.XPOS_CACHE_CAPACITY + 1 }, (_, i) => `第${i}句`);
    answer = () => [GAKU];
    for (const text of texts) await cache.loadXposScores(text, 1);
    // The oldest is gone; everything since is still here.
    expect(cache.cachedXposScores(texts[0], 1, 0)).toBeUndefined();
    for (const text of texts.slice(1)) {
      expect(cache.cachedXposScores(text, 1, 0), text).toMatchObject(GAKU);
    }
  });

  it("counts recency of use, not of fetch, so a sentence returned to survives", async () => {
    const { cache } = await warmSession();
    const texts = Array.from({ length: cache.XPOS_CACHE_CAPACITY }, (_, i) => `第${i}句`);
    answer = () => [GAKU];
    for (const text of texts) await cache.loadXposScores(text, 1);
    // The reader comes back to the first sentence — a menu opened in it, which
    // is a read.
    expect(cache.cachedXposScores(texts[0], 1, 0)).toMatchObject(GAKU);
    await cache.loadXposScores("新句", 1);
    // …so the one that falls off is the second, not the first.
    expect(cache.cachedXposScores(texts[0], 1, 0)).toMatchObject(GAKU);
    expect(cache.cachedXposScores(texts[1], 1, 0)).toBeUndefined();
  });

  it("empties on request, for the next test", async () => {
    const { cache } = await warmSession();
    await cache.loadXposScores(SENTENCE, 10);
    cache.resetXposScoreCache();
    expect(cache.cachedXposScores(SENTENCE, 10, 8)).toBeUndefined();
  });
});

describe("parserStarted", () => {
  it("is false until something asks for a parser, and true once it has", async () => {
    const { client } = await fresh();
    expect(client.parserStarted()).toBe(false);
    const ready = client.initParser();
    // True while the init is still in flight: what the prefetch needs to know
    // is whether asking would *start* the download or join it.
    expect(client.parserStarted()).toBe(true);
    await ready;
    expect(client.parserStarted()).toBe(true);
  });

  it("is false again after an init that failed, so a retry is a retry", async () => {
    const { client } = await fresh();
    fail = true;
    (globalThis as unknown as { Worker: unknown }).Worker = class extends FakeWorker {
      override postMessage(msg: WireMessage): void {
        sent.push(msg);
        queueMicrotask(() => {
          this.onmessage?.({ data: { id: msg.id, ok: false, error: "no wheels" } });
        });
      }
    };
    await expect(client.initParser()).rejects.toThrow("no wheels");
    expect(client.parserStarted()).toBe(false);
  });
});
