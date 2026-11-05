/** Marks a vertical panel's edges while there is more text beyond them, so
 * the CSS can fade that edge — see `.tategaki[data-more-left]` in
 * tategaki.css.
 *
 * The panels scroll sideways, and a column cut clean at the rail read as the
 * end of the passage: the critique found 者, 鮮 and 矣 sliced through with
 * nothing to say the text went on. A printed page has no such problem, its
 * edge being the edge of the text; a window onto a longer text has to say
 * that it is one.
 *
 * Both edges, because vertical-rl text starts at the *right*: the left edge
 * has more while the reader has not reached the end, and the right edge has
 * more once they have scrolled away from the start. `scrollLeft` runs from 0
 * at the start to `-(scrollWidth - clientWidth)` at the end, so the distance
 * travelled is its absolute value whichever sign a browser reports.
 *
 * Re-measured on scroll, on a change to the panel's own size, and on a change
 * to what is in it — a new text, a redraw after an edit, the reveal adding
 * columns — each folded into one measurement per frame. */
export function watchEdgeFade(panel: HTMLElement): void {
  let pending = false;

  function measure(): void {
    pending = false;
    const travel = panel.scrollWidth - panel.clientWidth;
    const at = Math.abs(panel.scrollLeft);
    // A pixel's grace either side: sub-pixel layouts leave a scroll that has
    // reached its end a fraction short of it.
    panel.toggleAttribute("data-more-left", travel > 1 && at < travel - 1);
    panel.toggleAttribute("data-more-right", travel > 1 && at > 1);
  }

  function schedule(): void {
    if (pending) return;
    pending = true;
    requestAnimationFrame(measure);
  }

  panel.addEventListener("scroll", schedule, { passive: true });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(panel);
  new MutationObserver(schedule).observe(panel, { childList: true, subtree: true });
  schedule();
}
