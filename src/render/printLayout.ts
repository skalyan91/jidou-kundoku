import { positionCompoundLines } from "./KundokuView.ts";

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
const KUNDOKU_BAND_HEIGHT_MM = 110;
const KAKIKUDASHI_BAND_HEIGHT_MM = 68;

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
  const kakiSentences = [...kakikudashiView.querySelectorAll<HTMLElement>(".tategaki-column > .sentence-gap")];
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
    page.append(k.band, g.band);
    root.append(page);
    sentencesOnPage = 0;
  };

  startPage();

  for (let i = 0; i < kundokuSentences.length; i++) {
    const kundokuClone = kundokuSentences[i].cloneNode(true) as HTMLElement;
    const kakiClone = kakiSentences[i]?.cloneNode(true) as HTMLElement | undefined;
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
