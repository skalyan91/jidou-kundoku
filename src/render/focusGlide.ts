/**
 * The focus ring glides from one stop to the next.
 *
 * The reader: *"switching focus should animate the focus ring movement."*
 * Every stop in the kundoku panel draws its own ring (kunten.css): a
 * character on its head box (`.kanji-glyph::after`, or two shadows on the
 * glyph of a head), a reading and the relation label on their own `::after`,
 * and a 品詞 pill on the `::after` of its row, anchored to the pill. Those
 * rings stay what they are. When keyboard focus moves from one stop to
 * another in the same column, one stand-in ring is drawn from where the old
 * ring was to where the new ring is, and the new ring is held invisible
 * (`data-ring-arriving`, which sets `--focus-ink` to transparent) until the
 * stand-in lands on it.
 *
 * **The target is followed, not computed once.** A focused character steps
 * its annotations aside and the semantic pills unfold as focus reaches them,
 * both on a 160ms clock, so where the new ring will be is not known when
 * focus lands. Each frame measures the new ring where it is now and puts the
 * stand-in that share of the way from the start to it, eased; the last frame
 * is exactly on it.
 *
 * Positions are kept relative to the column (`.tategaki-column`), which
 * scrolls with the text, so a focus move that scrolls the panel does not
 * throw the start of the glide off. Not under reduced motion, where the ring
 * simply appears where focus is, as it always did.
 */

const STOP = ".kanji-cell[data-token-id], [data-reading-stop], .token-subtitle, .token-arrow-label";
const DURATION = 180;

interface RingBox {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** The element whose ring a stop's focus draws, and whose `--focus-ink` hides it. */
function ringHost(stop: HTMLElement): HTMLElement {
  if (stop.matches(".token-subtitle")) return stop.closest<HTMLElement>(".token-subtitle-row") ?? stop;
  return stop;
}

function px(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** The box of an absolutely positioned `::after`, in viewport coordinates. */
function pseudoBox(host: HTMLElement): RingBox | null {
  const s = getComputedStyle(host, "::after");
  if (s.content === "none" || s.position !== "absolute") return null;
  const r = host.getBoundingClientRect();
  return {
    x: r.left + host.clientLeft + px(s.left),
    y: r.top + host.clientTop + px(s.top),
    w: px(s.width),
    h: px(s.height),
    r: px(s.borderTopLeftRadius),
  };
}

/** Where the ring of a focused stop is drawn, in viewport coordinates. */
export function ringBox(stop: HTMLElement): RingBox | null {
  if (stop.matches(".kanji-cell")) {
    const glyph = stop.querySelector<HTMLElement>(".kanji-glyph");
    if (!glyph) return null;
    if (stop.matches(".token-cell-head, .token-drop-target")) {
      // The ring is a shadow round the glyph, out past the head box and its casing.
      const cs = getComputedStyle(stop);
      const reach = px(cs.getPropertyValue("--head-box-size")) + px(cs.getPropertyValue("--head-box-halo")) + strokeOf(stop);
      const r = glyph.getBoundingClientRect();
      return { x: r.left - reach, y: r.top - reach, w: r.width + 2 * reach, h: r.height + 2 * reach, r: reach + 3 };
    }
    return pseudoBox(glyph);
  }
  return pseudoBox(ringHost(stop));
}

/** `--head-box-stroke` is a calc on the type size, so it is measured, not read. */
function strokeOf(el: HTMLElement): number {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;width:var(--head-box-stroke);height:0";
  el.appendChild(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w || 1;
}

export function installFocusGlide(): void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let last: { stop: HTMLElement; column: HTMLElement; box: RingBox } | null = null;
  let running: { cancel: () => void } | null = null;

  const remember = (stop: HTMLElement): void => {
    const column = stop.closest<HTMLElement>(".tategaki-column");
    if (!column || !stop.matches(":focus-visible")) {
      last = null;
      return;
    }
    const box = ringBox(stop);
    if (!box) {
      last = null;
      return;
    }
    const c = column.getBoundingClientRect();
    last = { stop, column, box: { ...box, x: box.x - c.left, y: box.y - c.top } };
  };

  document.addEventListener("focusin", (event) => {
    const stop = (event.target as HTMLElement).closest?.<HTMLElement>(STOP);
    running?.cancel();
    if (!stop || event.target !== stop) {
      last = null;
      return;
    }
    const from = last && last.stop === event.relatedTarget && last.stop !== stop ? last : null;
    const column = stop.closest<HTMLElement>(".tategaki-column");
    // Measured after every other `focusin` handler has placed what it places.
    requestAnimationFrame(() => {
      if (document.activeElement !== stop) return;
      if (!from || reduce.matches || from.column !== column || !column || !stop.matches(":focus-visible")) {
        remember(stop);
        return;
      }
      running = glide(stop, column, from.box, () => {
        running = null;
        remember(stop);
      });
    });
  });

  // The ring a pointer gesture or a re-render leaves behind is not a start.
  document.addEventListener("pointerdown", () => {
    last = null;
  }, true);
}

function glide(stop: HTMLElement, column: HTMLElement, from: RingBox, done: () => void): { cancel: () => void } {
  const host = ringHost(stop);
  const ring = document.createElement("div");
  ring.className = "focus-glide";
  ring.setAttribute("aria-hidden", "true");
  if (stop.matches(".token-arrow-label")) ring.setAttribute("data-to-label", "");
  column.appendChild(ring);
  host.setAttribute("data-ring-arriving", "");

  const start = performance.now();
  let frame = 0;
  const finish = (): void => {
    cancelAnimationFrame(frame);
    ring.remove();
    host.removeAttribute("data-ring-arriving");
  };
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / DURATION);
    const k = 1 - (1 - t) ** 3;
    const c = column.getBoundingClientRect();
    const to = ringBox(stop);
    if (!to || !stop.isConnected || document.activeElement !== stop) {
      finish();
      return;
    }
    const tx = to.x - c.left;
    const ty = to.y - c.top;
    const lerp = (a: number, b: number): number => a + (b - a) * k;
    ring.style.left = `${lerp(from.x, tx) - column.clientLeft}px`;
    ring.style.top = `${lerp(from.y, ty) - column.clientTop}px`;
    ring.style.width = `${lerp(from.w, to.w)}px`;
    ring.style.height = `${lerp(from.h, to.h)}px`;
    ring.style.borderRadius = `${lerp(from.r, to.r)}px`;
    if (t < 1) frame = requestAnimationFrame(step);
    else {
      finish();
      done();
    }
  };
  step(start);
  return { cancel: finish };
}
