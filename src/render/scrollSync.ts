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
  // Where this module last put each panel, so its own writes can be told
  // apart from a real user scroll that should sync the other panel in turn.
  //
  // Identifying them by *position* rather than by counting pending writes is
  // what makes this robust to the browser coalescing several writes into one
  // 'scroll' event, or dropping one: a stale entry is simply a position that
  // never comes back, and the next genuine scroll — which lands somewhere
  // else — matches nothing and syncs normally. Two earlier guards were tried
  // and both failed on a timing assumption: a boolean reset on a
  // `requestAnimationFrame` (the event can arrive a frame later), and the
  // same boolean consumed from inside the listener (one slot cannot hold two
  // pending writes, so the second event went unsuppressed).
  //
  // The recorded value is read back *after* the write rather than being the
  // value asked for, so a write the browser clamps (asking for 0 on a panel
  // already there, or past either end) still records where the panel
  // actually landed.
  const written = new Map<HTMLElement, number>();

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
    // Explicitly instant, overriding the `scroll-behavior: smooth` the panel
    // carries in tategaki.css. That declaration is there for the one
    // programmatic scroll that should glide — `scrollIntoView` onto an
    // inspected character — but a mirrored panel is not navigating anywhere:
    // it is tracking the panel under the user's finger, and should stay
    // locked to it rather than easing along behind.
    //
    // Animating these writes is also what made the panels oscillate at the
    // start of the text. A smooth write emits scroll events for the whole
    // length of its animation, not one; as the user's scroll decelerated
    // into the beginning, its steps fell under the sub-pixel threshold above
    // and this function started returning early, recording nothing — while
    // the target was still animating from a write issued several frames
    // before. Those leftover events matched no recorded write, so each was
    // read as a fresh user scroll and synced *backwards*, dragging the panel
    // the user had just brought to the start back off it by ~50px.
    target.scrollTo({ left: value, behavior: "instant" });
    written.set(target, target.scrollLeft);
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
    const ours = written.get(panel);
    if (ours !== undefined && Math.abs(panel.scrollLeft - ours) < 1) {
      written.delete(panel);
      return;
    }
    sync(panel, other);
  }

  panelA.addEventListener("scroll", () => onScroll(panelA, panelB));
  panelB.addEventListener("scroll", () => onScroll(panelB, panelA));
}
