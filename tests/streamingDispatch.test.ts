import { describe, expect, it } from "vitest";
import { createFrontier } from "../src/parse/frontier.ts";
import { charsDrawnBy, nextBatch, regionsDrawnBy, splitProvisional } from "../src/parse/provisionalSentences.ts";

// ---------------------------------------------------------------------------
// Stage one and stage two together: the characters arriving, and the regions
// being asked about as they do.
//
// There is no browser here, so what is driven is the *sequencing* — the loop
// `main.ts` runs, against the same `createFrontier` and the same `nextBatch`,
// with a stand-in for the animation that advances the frontier and a stand-in
// for the worker that answers after a turn of the microtask queue. That is
// the half of the arrangement that can go wrong invisibly, and it is the half
// a browser would be the worst place to check.
//
// The invariant every test here is really about:
//
//   **No region is ever asked about before its last character is on the
//   screen.** Which is what makes the reveal safe to splice in the moment it
//   lands, with no queue of its own — see `revealAnnotatedSentences`.

interface Run {
  /** Each `[from, to)` handed to the parser, in order. */
  batches: [number, number][];
  /** The frontier at the moment each of those was handed over. */
  frontierAt: number[];
  /** Whether the loop ran to the end of the text. */
  finished: boolean;
  /** How many times it had nothing it was allowed to ask about yet — in the
   * app, how many times it awaited the frontier. */
  waits: number;
}

/** The loop from `onParseText`, with the parse and the animation stood in
 * for. `advance` is called after each answer and says where the animation has
 * got to; returning `null` means it has stopped without finishing, which is
 * what cancelling looks like from in here. */
async function driveDispatch(
  lengths: readonly number[],
  initialFrontier: number,
  advance: (batchesSoFar: number) => number | null,
): Promise<Run> {
  const drawn = createFrontier(initialFrontier, lengths.length);
  const run: Run = { batches: [], frontierAt: [], finished: false, waits: 0 };
  let dispatched = 0;
  /** The pump has to stop somewhere: an animation that never reaches the end
   * of the text would otherwise spin here. In the app this is `wait()`, and
   * what ends it is `release`. */
  let idle = 0;

  while (dispatched < lengths.length) {
    const batch = nextBatch(lengths, dispatched, drawn.value);
    if (!batch) {
      // The animation is asked where it has got to. In the app this arrives
      // on its own (a `requestAnimationFrame` callback advances the frontier
      // and wakes the `await drawn.wait()` below); here it is pumped, so the
      // wait is only taken when nothing moved — which in this harness means
      // nothing ever will.
      run.waits++;
      const before = drawn.value;
      const next = advance(run.batches.length);
      if (next === null) drawn.release();
      else drawn.set(next);
      if (drawn.value === before && ++idle > 10_000) break;
      if (drawn.value > before) idle = 0;
      continue;
    }
    run.batches.push(batch);
    run.frontierAt.push(drawn.value);
    await Promise.resolve(); // the round trip to the worker
    const next = advance(run.batches.length);
    if (next !== null) drawn.set(next);
    dispatched = batch[1];
  }
  run.finished = dispatched === lengths.length;
  return run;
}

describe("the dispatch loop", () => {
  it("asks about a region only once its last character is on the screen", async () => {
    const lengths = [5, 5, 5, 5, 5];
    // The animation is slower than the parser: one more region drawn per
    // answer, which is the short-text case.
    const run = await driveDispatch(lengths, 0, (batches) => batches + 1);
    expect(run.finished).toBe(true);
    for (const [i, [, to]] of run.batches.entries()) {
      expect(to).toBeLessThanOrEqual(run.frontierAt[i]);
    }
  });

  it("hands over one region at a time while the animation is the slower of the two", async () => {
    const lengths = [5, 5, 5, 5, 5];
    const run = await driveDispatch(lengths, 0, (batches) => batches + 1);
    expect(run.batches).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
  });

  it("takes everything waiting when the parser is the slower of the two", async () => {
    const lengths = [5, 5, 5, 5, 5];
    // The whole text is drawn during the first round trip — the batches then
    // grow to the cap of their own accord, with no schedule saying they
    // should.
    const run = await driveDispatch(lengths, 0, () => lengths.length);
    expect(run.batches).toEqual([
      [0, 1],
      [1, 5],
    ]);
  });

  it("never waits at all for a text drawn at once", async () => {
    const lengths = [5, 5, 5, 5, 5];
    const run = await driveDispatch(lengths, lengths.length, () => lengths.length);
    expect(run.waits).toBe(0);
    expect(run.batches).toEqual([
      [0, 1],
      [1, 5],
    ]);
    expect(run.finished).toBe(true);
  });

  it("covers every region exactly once, in order", async () => {
    const lengths = Array.from({ length: 40 }, (_, i) => (i % 5) + 1);
    // A frontier that moves in fits: nothing, nothing, then a jump.
    const run = await driveDispatch(lengths, 0, (batches) => Math.min(lengths.length, batches * 3 + 1));
    expect(run.finished).toBe(true);
    let next = 0;
    for (const [from, to] of run.batches) {
      expect(from).toBe(next);
      expect(to).toBeGreaterThan(from);
      next = to;
    }
    expect(next).toBe(lengths.length);
  });

  it("stops rather than waiting forever when the animation is cancelled short", async () => {
    // A second text taking the panel over: the animation is cancelled with
    // the frontier still short of the end. `release` is what wakes the loop,
    // and without it this test hangs rather than failing — which is exactly
    // the failure it is here to rule out.
    const lengths = [5, 5, 5, 5, 5];
    const run = await driveDispatch(lengths, 0, (batches) => (batches >= 2 ? null : batches + 1));
    expect(run.batches.length).toBeGreaterThanOrEqual(2);
    // Released to the whole text, so the loop finishes rather than stalling;
    // `main.ts` then finds its generation superseded and draws none of it.
    expect(run.finished).toBe(true);
  });

  it("drives a real text end to end without ever outrunning the characters", async () => {
    const source = "子曰：「學而時習之，不亦說乎？」\n有朋自遠方來、不亦樂乎。\n人不知而不慍，不亦君子乎。";
    const lengths = splitProvisional(source).map((r) => r.length);
    // The animation on its own clock: the frontier is whatever
    // `regionsDrawnBy` says at the elapsed time each answer lands.
    let elapsed = 0;
    const total = lengths.reduce((a, b) => a + b, 0);
    const run = await driveDispatch(lengths, 0, () => {
      elapsed += 40; // ms per turn — faster than the parser, slower than nothing
      return regionsDrawnBy(lengths, charsDrawnBy(elapsed, total));
    });
    expect(run.finished).toBe(true);
    for (const [i, [, to]] of run.batches.entries()) {
      expect(to).toBeLessThanOrEqual(run.frontierAt[i]);
    }
    expect(run.batches[0]).toEqual([0, 1]);
  });
});

describe("createFrontier", () => {
  it("ignores anything that is not an advance", () => {
    const f = createFrontier(3, 10);
    f.set(2);
    f.set(3);
    expect(f.value).toBe(3);
    f.set(4);
    expect(f.value).toBe(4);
  });

  it("wakes every waiter on one advance", async () => {
    const f = createFrontier(0, 10);
    const woken: number[] = [];
    const waits = [f.wait().then(() => woken.push(1)), f.wait().then(() => woken.push(2))];
    f.set(1);
    await Promise.all(waits);
    expect(woken).toEqual([1, 2]);
  });

  it("does not wake a waiter for a report of the same number", async () => {
    const f = createFrontier(2, 10);
    let woke = false;
    const wait = f.wait().then(() => {
      woke = true;
    });
    f.set(1);
    f.set(2);
    await Promise.resolve();
    expect(woke).toBe(false);
    f.set(3);
    await wait;
    expect(woke).toBe(true);
  });

  it("releases to the whole text, and does so idempotently", async () => {
    const f = createFrontier(1, 7);
    const wait = f.wait();
    f.release();
    await wait;
    expect(f.value).toBe(7);
    f.release();
    expect(f.value).toBe(7);
  });

  it("wakes a loop that is genuinely awaiting it when the animation is cancelled", async () => {
    // The real shape of the thing the harness above only models: a dispatch
    // loop suspended on `wait()` with a frontier that is never going to
    // advance on its own. Without `release` this test would time out, which
    // is precisely the failure it rules out of `onParseText`.
    const drawn = createFrontier(0, 4);
    let woke = false;
    const loop = drawn.wait().then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    drawn.release();
    await loop;
    expect(woke).toBe(true);
    expect(drawn.value).toBe(4);
  });

  it("never moves backwards, release included", () => {
    const f = createFrontier(9, 7);
    f.release();
    expect(f.value).toBe(9);
  });
});
