/** Keeps the kundoku and kakikudashi panels' horizontal scroll positions in
 * lockstep by *sentence*, not raw pixel offset — the two panels render the
 * same sentences at different widths (kundoku carries furigana/kunten,
 * kakikudashi doesn't), so a naive `scrollLeft` mirror would drift out of
 * alignment after the first sentence. Both panels are `vertical-rl`, so
 * reading (and block-progression) starts at each panel's own *right* edge
 * and proceeds leftward — "which sentence is currently leading" is
 * therefore whichever `.sentence-gap`'s right edge sits closest to (at or
 * just past) the panel's own right edge. */
export function setupScrollSync(panelA: HTMLElement, panelB: HTMLElement): void {
  // Which panel's *next* native 'scroll' event was caused by this module's
  // own write to its scrollLeft (see `sync`), not a real user/programmatic
  // scroll that should trigger syncing the other panel in turn. A single
  // shared boolean reset on a `requestAnimationFrame` timer (this
  // function's original guard) assumes the target's own 'scroll' event
  // fires within that one frame — browsers don't guarantee that, and
  // live-testing this exact panel pair showed the event arriving late
  // enough that the guard had already reset, letting `sync(target, source)`
  // fire back and forth a few times before settling on the wrong position.
  // Consuming the flag from *inside* the listener instead — whenever that
  // event actually arrives — has no such timing assumption. `pendingTimer`
  // is a safety net only, for the (normally unreachable, since `sync`
  // already skips a sub-1px write) case where the write doesn't actually
  // change scrollLeft and so never fires a 'scroll' event at all — without
  // it, a missed event would leave that panel's syncing permanently stuck.
  let suppressed: HTMLElement | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  function sentenceGaps(panel: HTMLElement): HTMLElement[] {
    return Array.from(panel.querySelectorAll<HTMLElement>(".sentence-gap"));
  }

  function leadingIndex(panel: HTMLElement, gaps: HTMLElement[]): number {
    const panelRight = panel.getBoundingClientRect().right;
    let best = 0;
    let bestDist = Infinity;
    gaps.forEach((el, i) => {
      const dist = panelRight - el.getBoundingClientRect().right;
      // The leading sentence is the one whose right edge is at or just past
      // (a small positive `dist`) the panel's own right edge — the closest
      // such candidate, not simply the smallest |dist|, since a sentence
      // that's scrolled *past* (right edge to the panel's right, negative
      // dist) is already fully read and shouldn't be treated as current.
      if (dist >= -2 && dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    return best;
  }

  // A panel's own natural minimum |scrollLeft| (its most-negative reachable
  // value — vertical-rl's `scrollLeft` runs from 0 at the panel's own right
  // edge, the reading start, down to this at the reading end). Read fresh
  // each time rather than cached, since it changes whenever the tree is
  // re-rendered (a new/edited text).
  function maxScroll(panel: HTMLElement): number {
    return -(panel.scrollWidth - panel.clientWidth);
  }

  function writeTarget(target: HTMLElement, value: number): void {
    if (Math.abs(target.scrollLeft - value) < 1) return;
    suppressed = target;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      if (suppressed === target) suppressed = null;
    }, 200);
    target.scrollLeft = value;
  }

  function sync(source: HTMLElement, target: HTMLElement): void {
    const sourceGaps = sentenceGaps(source);
    const targetGaps = sentenceGaps(target);
    if (sourceGaps.length === 0 || sourceGaps.length !== targetGaps.length) return;

    // "Start" and "end" are *absolute* concepts (scrollLeft 0, or this
    // panel's own natural maximum magnitude) — not per-sentence-relative
    // ones the general alignment below can express, since neither panel
    // has any content *before* the first sentence or *after* the last to
    // measure an inter-panel offset against. Each panel's own padding/
    // margin at these two edges is independent of the other's (confirmed
    // by measurement: at both panels' own true, unsynced starting
    // scrollLeft of 0, the two `.tategaki`'s own natural insets from panel
    // edge to first `.sentence-gap` differ) — snapping target to *its own*
    // 0/max here, rather than deriving a target position from source's
    // inset the way the per-sentence branch below does, is what makes
    // "source scrolled all the way to its start" reliably reach target's
    // start too instead of stopping wherever source's own inset happens to
    // land on target's geometry.
    if (source.scrollLeft >= -1) {
      writeTarget(target, 0);
      return;
    }
    if (source.scrollLeft <= maxScroll(source) + 1) {
      writeTarget(target, maxScroll(target));
      return;
    }

    const index = leadingIndex(source, sourceGaps);
    const targetEl = targetGaps[index];
    const delta = target.getBoundingClientRect().right - targetEl.getBoundingClientRect().right;
    writeTarget(target, target.scrollLeft - delta);
  }

  function onScroll(panel: HTMLElement, other: HTMLElement): void {
    if (suppressed === panel) {
      suppressed = null;
      clearTimeout(pendingTimer);
      return;
    }
    sync(panel, other);
  }

  panelA.addEventListener("scroll", () => onScroll(panelA, panelB));
  panelB.addEventListener("scroll", () => onScroll(panelB, panelA));
}
