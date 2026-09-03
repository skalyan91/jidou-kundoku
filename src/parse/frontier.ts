/** ── How much of the text is on the screen ────────────────────────────────
 *
 * A submitted text is disclosed a character at a time, and each region is
 * sent to the parser when its last character appears (see `main.ts`'s
 * `onParseText`). Two parties, running at different speeds, have to agree
 * about where the display has got to: the animation, which knows and can only
 * push the number up, and the dispatch loop, which cannot proceed past it and
 * has nothing to do until it moves.
 *
 * This is that number, and it is a monotonic count that can be waited on. It
 * is kept apart from both of them — and out of the DOM — so that the
 * sequencing it governs can be tested without a browser, which is where the
 * one property that matters actually lives:
 *
 *   **A waiter is only ever released by an advance, or by `release`.** So a
 *   dispatch loop can wait on this without any risk of waiting forever: the
 *   animation advances it while it runs and, however it ends — finished,
 *   cancelled, or a second text taking the panel over — `release` sets it to
 *   the whole text and everything waiting wakes to find out that it has. */
export interface Frontier {
  /** How many regions are fully drawn. */
  readonly value: number;
  /** Records an advance. Anything not an advance is ignored, which is what
   * lets the animation report the frontier every frame — most frames it is
   * the same number, and only a change should wake anybody. */
  set(next: number): void;
  /** Resolves when the frontier next moves. */
  wait(): Promise<void>;
  /** The end, however it was reached: the frontier goes to `total` and every
   * waiter wakes. Idempotent. */
  release(): void;
}

export function createFrontier(initial: number, total: number): Frontier {
  let value = initial;
  let waiters: (() => void)[] = [];

  const wake = (): void => {
    const woken = waiters;
    waiters = [];
    for (const resolve of woken) resolve();
  };

  return {
    get value(): number {
      return value;
    },
    set(next: number): void {
      if (next <= value) return;
      value = next;
      wake();
    },
    wait(): Promise<void> {
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release(): void {
      value = Math.max(value, total);
      wake();
    },
  };
}
