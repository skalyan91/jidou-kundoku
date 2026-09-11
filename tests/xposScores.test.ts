import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** **The xpos distribution's near side.**
 *
 * `xposScores` is two halves with a `postMessage` between them. The far half
 * — `xposDistribution` in pyodideWorker.ts — reads the tagger's joint softmax
 * out of a spaCy pipeline running under Pyodide/WASM, and nothing in this repo
 * can run it: there is no Pyodide in the vitest environment, and mocking one
 * would mean inventing the probabilities that are the whole point. That half
 * was validated by running the model, and the measurements are written into
 * its doc comment rather than asserted here.
 *
 * What *is* testable is everything on this side of the boundary, and it is not
 * nothing: that the request the worker will have to answer carries the three
 * things it needs (the text, the caller's own token count, the index), under
 * the type the worker switches on; and that whatever comes back is turned into
 * either a drawable distribution or a null, with no third possibility reaching
 * a menu. Both of those have gone wrong before in ways a type-checker cannot
 * see — a renamed request type still type-checks on both sides, since the
 * protocol is a string.
 *
 * The worker is faked rather than mocked out: a class standing in for the
 * `Worker` global that records what it was sent and answers with whatever the
 * test hands it. So the assertions are about the wire, never about what a
 * model would have said.
 *
 * `xposScoresForSentence` — the same measurement for every token of a sentence
 * in one pass, which is what the menus are shaded from now — is here for the
 * same reasons and under the same rules. What its *caller* does with the
 * answer, and when, is xposScoreCache.test.ts. */

interface WireMessage {
  id: number;
  type: string;
  [key: string]: unknown;
}

/** What the fake worker answers with, for the request the test is about.
 * Returning `undefined` means "answer `{ok: true}` with no result at all",
 * which is what a worker branch that fell through would do. */
let answer: (msg: WireMessage) => unknown = () => null;
/** Set by the fake so the test can assert on `init` as well as the request
 * under test — `xposScores` awaits `initParser()` first, and a client that
 * skipped that would work in a warm session and fail in a cold one. */
let sent: WireMessage[] = [];

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(_url: unknown, _options?: unknown) {}

  postMessage(msg: WireMessage): void {
    sent.push(msg);
    // Asynchronously, like the real thing: a client that resolved its promise
    // synchronously off its own `postMessage` would pass a test that awaited
    // nothing and deadlock against a real worker.
    queueMicrotask(() => {
      if (msg.type === "init") {
        this.onmessage?.({ data: { id: msg.id, ok: true } });
        return;
      }
      this.onmessage?.({ data: { id: msg.id, ok: true, result: answer(msg) } });
    });
  }

  terminate(): void {}
}

/** A real answer's shape, taken from the model's own output on 學而時習之、不亦
 * 說乎 (the 說 token, where the tagger is genuinely torn between the 悦 and 説
 * readings). Used only as *a well-formed distribution* — nothing here asserts
 * that these are the right numbers, which is the worker's doc's business. */
const SETSU = {
  "v,動詞,行為,態度": 0.557,
  "v,動詞,行為,伝達": 0.418,
  "v,動詞,行為,動作": 0.007,
  "n,名詞,行為,*": 0.005,
};

type Client = typeof import("../src/parse/pyodideClient.ts");

/** The client caches its worker and its init promise at module scope, so each
 * test needs its own module instance or the second one inherits the first's
 * worker. */
async function freshClient(): Promise<Client> {
  vi.resetModules();
  return (await import("../src/parse/pyodideClient.ts")) as Client;
}

beforeEach(() => {
  sent = [];
  answer = () => null;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("xposScores, over the worker protocol", () => {
  it("asks under the type the worker switches on, and asks it after init", async () => {
    const { xposScores } = await freshClient();
    answer = () => SETSU;
    await xposScores("學而時習之、不亦說乎", 10, 8);
    expect(sent.map((m) => m.type)).toEqual(["init", "xposScores"]);
  });

  it("carries the text, the caller's own token count, and the index", async () => {
    const { xposScores } = await freshClient();
    answer = () => SETSU;
    await xposScores("學而時習之、不亦說乎", 10, 8);
    const req = sent[1];
    // The token count is the load-bearing one: it is the caller's count, not
    // the model's, and the worker refuses to answer when the two disagree.
    // A client that dropped it would turn that refusal into a confident answer
    // about somebody else's tokenization.
    expect(req).toMatchObject({
      type: "xposScores",
      text: "學而時習之、不亦說乎",
      tokenCount: 10,
      tokenIndex: 8,
    });
    expect(typeof req.id).toBe("number");
  });

  it("hands back a distribution when the worker has one", async () => {
    const { xposScores } = await freshClient();
    answer = () => SETSU;
    const got = await xposScores("學而時習之、不亦說乎", 10, 8);
    expect(got).not.toBeNull();
    expect(Object.keys(got!).sort()).toEqual(Object.keys(SETSU).sort());
    expect(Object.values(got!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    // The ranking is the thing a menu draws with, and renormalising must not
    // disturb it.
    expect(got!["v,動詞,行為,態度"]).toBeGreaterThan(got!["v,動詞,行為,伝達"]);
  });

  it("passes the worker's refusal through as a refusal", async () => {
    const { xposScores } = await freshClient();
    answer = () => null;
    // Null is what the worker sends for every case it will not answer — no
    // such pipe, an index out of range, a tokenization that has moved under
    // the caller, a tagger with no joint block. The client must not turn any
    // of those into an empty distribution, which a caller would shade with.
    expect(await xposScores("學而時習之", 5, 0)).toBeNull();
  });

  it("lets a thrown worker error reach the caller", async () => {
    const { xposScores } = await freshClient();
    (globalThis as unknown as { Worker: unknown }).Worker = class extends FakeWorker {
      override postMessage(msg: WireMessage): void {
        sent.push(msg);
        queueMicrotask(() => {
          if (msg.type === "init") {
            this.onmessage?.({ data: { id: msg.id, ok: true } });
            return;
          }
          this.onmessage?.({ data: { id: msg.id, ok: false, error: "boom" } });
        });
      }
    };
    // Deliberately a rejection rather than a null: null is a measurement the
    // worker declined to make, and an exception is the pipeline breaking.
    // Callers catch it and fall back to the corpus prior, but they are the
    // ones who decide that.
    await expect(xposScores("學", 1, 0)).rejects.toThrow("boom");
  });
});

/** A second, well-formed distribution, so a sentence's rows can be told apart
 * — 學 in the same sentence, where the tagger is not torn at all. Again used
 * only as *a* distribution: no claim is made here that these are its numbers. */
const GAKU = {
  "v,動詞,行為,交流": 0.91,
  "n,名詞,主体,人": 0.09,
};

describe("xposScoresForSentence, over the worker protocol", () => {
  it("asks under its own type, after init, carrying the text and the count and no index", async () => {
    const { xposScoresForSentence } = await freshClient();
    answer = () => [GAKU, null, null, null, null, null, null, null, SETSU, null];
    await xposScoresForSentence("學而時習之、不亦說乎", 10);
    expect(sent.map((m) => m.type)).toEqual(["init", "xposScoresForSentence"]);
    expect(sent[1]).toMatchObject({ text: "學而時習之、不亦說乎", tokenCount: 10 });
    // No index, because the whole sentence is the question. A worker branch
    // reading one would find `undefined` and answer about token `NaN`.
    expect(sent[1].tokenIndex).toBeUndefined();
  });

  it("keeps the rows in token order, and each of them a drawable distribution", async () => {
    const { xposScoresForSentence } = await freshClient();
    answer = () => [GAKU, null, null, null, null, null, null, null, SETSU, null];
    const rows = (await xposScoresForSentence("學而時習之、不亦說乎", 10))!;
    expect(rows).toHaveLength(10);
    // Position is the token id: a caller indexes this list by it, and the
    // order arriving scrambled would shade one character's menu from another
    // character's opinion — a wrong answer rather than a missing one.
    expect(rows[0]!["v,動詞,行為,交流"]).toBeGreaterThan(rows[0]!["n,名詞,主体,人"]);
    expect(rows[8]!["v,動詞,行為,態度"]).toBeGreaterThan(rows[8]!["v,動詞,行為,伝達"]);
    expect(Object.values(rows[8]!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    // A token the model had nothing usable for stays a hole in the list, not
    // an empty object: the row is missing, the sentence is not.
    expect(rows[1]).toBeNull();
  });

  it("refuses a list of the wrong length rather than indexing into it", async () => {
    const { xposScoresForSentence } = await freshClient();
    // The worker refuses outright whenever the model's tokenization disagrees
    // with the caller's, so a list of some other length is not this
    // sentence's: reading it would hand token 8 the distribution of whatever
    // sits at 8 in somebody else's segmentation.
    answer = () => [GAKU, SETSU];
    expect(await xposScoresForSentence("學而時習之、不亦說乎", 10)).toBeNull();
  });

  it("passes the worker's refusal through as a refusal", async () => {
    const { xposScoresForSentence } = await freshClient();
    answer = () => null;
    expect(await xposScoresForSentence("學而時習之", 5)).toBeNull();
  });

  it("lets a thrown worker error reach the caller", async () => {
    const { xposScoresForSentence } = await freshClient();
    (globalThis as unknown as { Worker: unknown }).Worker = class extends FakeWorker {
      override postMessage(msg: WireMessage): void {
        sent.push(msg);
        queueMicrotask(() => {
          if (msg.type === "init") {
            this.onmessage?.({ data: { id: msg.id, ok: true } });
            return;
          }
          this.onmessage?.({ data: { id: msg.id, ok: false, error: "boom" } });
        });
      }
    };
    await expect(xposScoresForSentence("學", 1)).rejects.toThrow("boom");
  });
});

describe("normalizeXposScores", () => {
  it("refuses everything that is not an object of numbers", async () => {
    const { normalizeXposScores } = await freshClient();
    for (const raw of [null, undefined, 0, 1, "", "v,動詞,行為,動作", [], [1, 2], true]) {
      expect(normalizeXposScores(raw), String(raw)).toBeNull();
    }
    // An empty object is a distribution with nowhere to put its mass, which is
    // not a distribution.
    expect(normalizeXposScores({})).toBeNull();
  });

  it("drops entries that are not finite positives, rather than repairing them", async () => {
    const { normalizeXposScores } = await freshClient();
    const got = normalizeXposScores({
      "v,動詞,行為,動作": 0.8,
      "n,名詞,人,人": 0.2,
      "p,助詞,句末,*": Number.NaN,
      "s,記号,読点,*": Number.POSITIVE_INFINITY,
      "v,副詞,否定,無界": -0.01,
      "n,数詞,数,*": 0,
      "v,前置詞,基盤,*": "0.5" as unknown as number,
    });
    expect(Object.keys(got!).sort()).toEqual(["n,名詞,人,人", "v,動詞,行為,動作"]);
    expect(got!["v,動詞,行為,動作"]).toBeCloseTo(0.8, 12);
  });

  it("renormalises what survives, so the sum survives the dropping", async () => {
    const { normalizeXposScores } = await freshClient();
    const got = normalizeXposScores({
      "v,動詞,行為,動作": 0.6,
      "n,名詞,人,人": 0.2,
      "p,助詞,句末,*": Number.NaN,
    })!;
    expect(Object.values(got).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(got["v,動詞,行為,動作"]).toBeCloseTo(0.75, 12);
    expect(got["n,名詞,人,人"]).toBeCloseTo(0.25, 12);
  });

  it("leaves an already-normalised distribution where it is", async () => {
    const { normalizeXposScores } = await freshClient();
    // The worker normalises before sending, so this is the ordinary case and
    // the helper must be a no-op on it to within float noise — a "safety" step
    // that quietly moved the numbers would be worse than none.
    const got = normalizeXposScores(SETSU)!;
    const total = Object.values(SETSU).reduce((a, b) => a + b, 0);
    for (const [tag, p] of Object.entries(SETSU)) {
      expect(got[tag], tag).toBeCloseTo(p / total, 12);
    }
  });

  it("is null when nothing at all survives", async () => {
    const { normalizeXposScores } = await freshClient();
    expect(normalizeXposScores({ "v,動詞,行為,動作": Number.NaN, "n,名詞,人,人": 0 })).toBeNull();
  });

  it("is idempotent, so a caller may re-run it without drift", async () => {
    const { normalizeXposScores } = await freshClient();
    const once = normalizeXposScores(SETSU)!;
    const twice = normalizeXposScores(once)!;
    for (const tag of Object.keys(once)) {
      expect(twice[tag], tag).toBeCloseTo(once[tag], 15);
    }
  });
});
