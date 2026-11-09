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
 * columns — each folded into one measurement per frame.
 *
 * **`"y"` measures the block axis of a horizontal list instead** — the saved
 * texts, which scroll down — and marks `data-more-top` and
 * `data-more-bottom` by the same rule, `scrollTop` running from 0 at the top
 * to the whole travel at the foot. One function for both, so the two fades
 * keep one idea of when an edge has more beyond it. */
export function watchEdgeFade(panel: HTMLElement, axis: "x" | "y" = "x"): void {
  let pending = false;

  /** **The scrollbar is kept out of the fade.** The CSS lays a solid mask
   * layer over the scrollbar strip, and this says how thick the strip is:
   * `--scrollbar-block` for a panel that scrolls sideways (its scrollbar runs
   * along the foot), `--scrollbar-inline` for a list that scrolls down (its
   * scrollbar stands at the right).
   *
   * A classic scrollbar takes its room out of the box, so the difference
   * between the border box and the client box, less the borders, is its
   * thickness exactly. An overlay scrollbar (macOS by default) takes no room
   * and measures 0, though it is painted over the content all the same and
   * was faded with it; for that one the strip is `OVERLAY_SCROLLBAR`, the
   * width a macOS overlay scrollbar grows to under the pointer. The text in
   * the panels stops short of it — measured at 1440px, the lowest em box in
   * the kundoku panel ends 14.7px above its foot — so the strip leaves the
   * fade on the text as it was. No scroll, no scrollbar, no strip. */
  const OVERLAY_SCROLLBAR = 15;
  function scrollbarStrip(travel: number): void {
    const cs = getComputedStyle(panel);
    const thickness =
      axis === "y"
        ? panel.offsetWidth - panel.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)
        : panel.offsetHeight - panel.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
    const strip = travel > 1 ? (thickness > 0 ? thickness : OVERLAY_SCROLLBAR) : 0;
    panel.style.setProperty(axis === "y" ? "--scrollbar-inline" : "--scrollbar-block", `${strip}px`);
    if (axis === "x") blurFoot(strip);
  }

  /** **Where the blur over the right fade has to stop**, written onto the
   * box that holds the scroller: `--fade-blur-foot`, the distance from the
   * foot of that box up to the top of the scrollbar strip. The blur
   * (`.kundoku-panel::before` and its fellows in tategaki.css) cannot hang
   * on the scroller, whose own children scroll and whose own pseudo-elements
   * would scroll with them, so it hangs on the panel instead; and a rule on
   * the panel cannot read a custom property set on a child of the panel, so
   * the strip has to be said again one level up.
   *
   * Said as a distance from the foot rather than as the thickness of the
   * strip alone, because the scroller does not always reach the foot of the
   * panel: the kundoku scroller rounds its height down to a whole number of
   * characters, and with the prose panel shut the remainder is left under the
   * scroller inside the panel (`#app:not(.kakikudashi-collapsed)` in
   * tategaki.css says why). `offsetTop` is measured from the padding edge of
   * the offset parent and `clientHeight` is the height of that same padding
   * box, so the difference is the bottom inset an absolutely positioned
   * child of the panel needs. Only written where the panel is that offset
   * parent, which is the one case in which the inset means anything. */
  function blurFoot(strip: number): void {
    const host = panel.parentElement;
    if (!host || panel.offsetParent !== host) return;
    const below = host.clientHeight - panel.offsetTop - panel.offsetHeight;
    host.style.setProperty("--fade-blur-foot", `${Math.max(0, below) + strip}px`);
  }

  function measure(): void {
    pending = false;
    if (axis === "y") {
      const travel = panel.scrollHeight - panel.clientHeight;
      const at = panel.scrollTop;
      scrollbarStrip(travel);
      panel.toggleAttribute("data-more-top", travel > 1 && at > 1);
      panel.toggleAttribute("data-more-bottom", travel > 1 && at < travel - 1);
      return;
    }
    const travel = panel.scrollWidth - panel.clientWidth;
    const at = Math.abs(panel.scrollLeft);
    scrollbarStrip(travel);
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
  if (typeof ResizeObserver !== "undefined") {
    const resized = new ResizeObserver(schedule);
    resized.observe(panel);
    // The panel as well, for `--fade-blur-foot`: the panel can grow by less
    // than a character without the rounded scroller inside it changing size
    // at all, and the gap under the scroller then changes unobserved.
    if (axis === "x" && panel.parentElement) resized.observe(panel.parentElement);
  }
  new MutationObserver(schedule).observe(panel, { childList: true, subtree: true });
  schedule();
}
