import { positionCompoundLines } from "./KundokuView.ts";
import { applyHangingMarks, clearHangingMarks } from "./KakikudashiView.ts";

/** Builds the paginated, print-only view of the two panels.
 *
 * The screen layout can't be printed directly. Its panels are fixed-height
 * scrollers whose vertical-rl text overflows *sideways*, and page
 * fragmentation runs down the page — so a long passage simply runs off the
 * left edge instead of continuing overleaf. Worse, two sibling vertical-rl
 * blocks are pushed onto separate pages by Chromium regardless of size
 * (measured), which is why the panels can't just be turned loose in the
 * page flow either.
 *
 * So the pages are laid out here instead: sentences are dealt into pages,
 * each page holding a kundoku band above its own kakikudashi band, both
 * carrying *the same* sentences. That is what keeps the two in step across
 * a page break — page 2 continues both, rather than the panels drifting
 * apart at different rates.
 *
 * Sizes are in millimetres deliberately: they're absolute, so a band
 * measured here on screen wraps its columns exactly as it will on paper,
 * and the fit test below is therefore meaningful before anything is
 * printed. They must stay in step with `@page` in print.css. */
const PAGE_CONTENT_WIDTH_MM = 269; // A4 landscape (297mm) less 2x14mm margin

/** The two bands, against the 182mm a 210mm sheet leaves between its margins.
 *
 * They came to 110 and 68. The prose band now carries a `padding-bottom` of
 * one prose advance (`.print-band-kakikudashi` in print.css) so that a mark
 * of punctuation at a column's foot has somewhere to hang — on screen that
 * room is the panel's own inset, and a print band is a `.tategaki` outside
 * that panel with `padding: 0`, so it had none and the mark would have been
 * cut off at the band's edge by the `overflow: hidden` that keeps a long
 * sentence from painting over the band below.
 *
 * So the prose band grew by 7mm — one advance is 25.3px, which is 6.7mm — and
 * its *content* is the 68mm it always was. The 7mm comes off the kundoku
 * band rather than out of the 4mm the pair were leaving spare, so the two
 * still come to 178mm and the sheet still has that margin of error. The
 * kundoku band can afford it: at 110mm it held four 88px cells with 63.7px
 * over, and at 103mm it holds the same four with 37.3px over. Reasoned from
 * the arithmetic; there is no browser here to print from. */
const KUNDOKU_BAND_HEIGHT_MM = 103;
const KAKIKUDASHI_BAND_HEIGHT_MM = 75;

const ROOT_ID = "print-root";

function makeBand(kind: "kundoku" | "kakikudashi"): { band: HTMLElement; column: HTMLElement } {
  const band = document.createElement("div");
  band.className = `print-band print-band-${kind} tategaki`;
  band.style.width = `${PAGE_CONTENT_WIDTH_MM}mm`;
  band.style.height = `${kind === "kundoku" ? KUNDOKU_BAND_HEIGHT_MM : KAKIKUDASHI_BAND_HEIGHT_MM}mm`;

  const column = document.createElement("div");
  column.className = `tategaki-column ${kind === "kundoku" ? "text-main" : "text-kakikudashi"}`;
  // The band's own height is the vertical-rl *inline* size, so the column
  // must inherit it rather than size to content, or the text would run in
  // one long line instead of wrapping into page-height columns.
  column.style.height = "100%";
  band.append(column);
  return { band, column };
}

/** True once a band's content has grown wider than the page allows — i.e.
 * the sentences in it no longer fit on one sheet. In vertical-rl the text
 * advances along the *horizontal* axis, so it is `scrollWidth` that reports
 * how far the columns have marched, not `scrollHeight`. */
function overflows(band: HTMLElement): boolean {
  return band.scrollWidth > band.clientWidth + 1;
}

/** Rebuilds `#print-root` from what the two panels currently show. Safe to
 * call repeatedly; each call replaces the previous layout.
 *
 * Driven off `beforeprint`, which covers every route to paper: the button
 * (`window.print()` fires it), a plain Ctrl+P, and headless export —
 * Chromium's `Page.printToPDF` dispatches it too (verified: exports with
 * and without a hand-fired `beforeprint` came out byte-identical). */
export function buildPrintLayout(kundokuView: HTMLElement, kakikudashiView: HTMLElement): void {
  document.getElementById(ROOT_ID)?.remove();

  const kundokuSentences = [...kundokuView.querySelectorAll<HTMLElement>(".tategaki-column > .sentence-gap")];
  // A hidden kakikudashi panel stays hidden on paper: printing what the
  // reader has switched off would be a surprise, and pairing bands is the
  // only reason this layout exists at all.
  const showKakikudashi = !document.querySelector("#app")?.classList.contains("kakikudashi-collapsed");
  const kakiSentences = showKakikudashi
    ? [...kakikudashiView.querySelectorAll<HTMLElement>(".tategaki-column > .sentence-gap")]
    : [];
  if (kundokuSentences.length === 0) return;

  const root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.append(root);

  let page: HTMLElement | null = null;
  let kundokuColumn: HTMLElement | null = null;
  let kakiColumn: HTMLElement | null = null;
  let kundokuBand: HTMLElement | null = null;
  let kakiBand: HTMLElement | null = null;
  let sentencesOnPage = 0;

  const startPage = () => {
    page = document.createElement("section");
    page.className = "print-page";
    const k = makeBand("kundoku");
    const g = makeBand("kakikudashi");
    kundokuBand = k.band;
    kundokuColumn = k.column;
    kakiBand = g.band;
    kakiColumn = g.column;
    // With no kakikudashi to pair, the kundoku band has the whole page.
    if (showKakikudashi) {
      page.append(k.band, g.band);
    } else {
      k.band.style.height = `${KUNDOKU_BAND_HEIGHT_MM + KAKIKUDASHI_BAND_HEIGHT_MM}mm`;
      page.append(k.band);
    }
    root.append(page);
    sentencesOnPage = 0;
  };

  startPage();

  for (let i = 0; i < kundokuSentences.length; i++) {
    const kundokuClone = kundokuSentences[i].cloneNode(true) as HTMLElement;
    const kakiClone = kakiSentences[i]?.cloneNode(true) as HTMLElement | undefined;
    // The screen panel's hanging marks come across with the clone, and they
    // were chosen for the screen's column length. Stripped here rather than
    // after the pages are dealt, because a mark whose advance has been given
    // back shortens the band it is in, and the fit test below is a measurement
    // of exactly that.
    if (kakiClone) clearHangingMarks(kakiClone);
    kundokuColumn!.append(kundokuClone);
    if (kakiClone) kakiColumn!.append(kakiClone);

    // One sentence that overflows on its own has nowhere better to go, so
    // it stays and is allowed to spill; otherwise move it to a fresh page.
    if ((overflows(kundokuBand!) || overflows(kakiBand!)) && sentencesOnPage > 0) {
      kundokuClone.remove();
      kakiClone?.remove();
      startPage();
      kundokuColumn!.append(kundokuClone);
      if (kakiClone) kakiColumn!.append(kakiClone);
    }
    sentencesOnPage += 1;
  }

  // The connecting line under a compound is positioned from measured glyph
  // centres, and the clones carry the offsets measured against the
  // *screen* columns. Print columns are a different length, so a compound
  // can wrap at a different point here — re-measure against this layout
  // rather than trusting the inherited inline values.
  for (const column of root.querySelectorAll<HTMLElement>(".print-band-kundoku .tategaki-column")) {
    positionCompoundLines(column);
  }

  // And the hanging marks. The screen panel's own were stripped from each
  // clone as it was dealt (see `clearHangingMarks` above); these are the ones
  // a *print* column comes to, which is a different column — six characters
  // at the shipped viewport against the ten a 68mm band holds.
  //
  // A band goes through **no fit at all**: `fitPassageExtent` and
  // `fitColumnTracking` (KakikudashiView.ts) run on the live panel and are
  // never called on anything built here, so a band keeps the drawn 0.15em
  // (the fallback in `.text-kakikudashi`) and holds `floor(measure /
  // advance)` characters with the remainder standing at its foot, where the
  // panel holds `round(…)` exactly. What the two share is the thing the model
  // needs — a *fixed* advance, the same for every character of the column —
  // so the same walk answers both, and `applyHangingMarks` reads the measure
  // and the tracking off whichever box it is handed rather than being told
  // which case it is in.
  //
  // After the pages are dealt rather than during: hanging can only make a band
  // shorter, never longer, so it cannot push a sentence off a page that the
  // fit test has already accepted.
  for (const band of root.querySelectorAll<HTMLElement>(".print-band-kakikudashi")) {
    const column = band.querySelector<HTMLElement>(":scope > .tategaki-column");
    if (column) applyHangingMarks(band, column);
  }
}

export function teardownPrintLayout(): void {
  document.getElementById(ROOT_ID)?.remove();
}

/** Wires the automatic rebuild for users who print via Ctrl+P rather than
 * the button, and clears the (large) cloned DOM again afterwards so it
 * isn't left sitting in the document. */
export function setupPrintLayout(kundokuView: HTMLElement, kakikudashiView: HTMLElement): void {
  window.addEventListener("beforeprint", () => buildPrintLayout(kundokuView, kakikudashiView));
  window.addEventListener("afterprint", teardownPrintLayout);
}
