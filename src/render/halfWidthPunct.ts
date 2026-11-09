/** **Half-width punctuation where the browser will not set it.**
 *
 * A mark of punctuation in the kundoku panel is set in half an em of the
 * column, through the font's own `vhal` feature (`.punct-cell` in
 * kunten.css), and the margins that hang it in the gap between two
 * characters are written against that half em.
 *
 * Safari (26.5) applies no vertical positioning feature at all: `vhal`,
 * `vpal`, `halt` and `palt` all leave 、 a whole 44px em tall, where Chrome
 * and Firefox give it 22px. Every mark then took half a character more than
 * its margins gave back, so a column held one character fewer than the
 * kundoku panel was sized for, and the fit that makes the two texts end
 * together (`fitPassageExtent` in KakikudashiView.ts) gave the kundoku panel
 * a step more height to make up for it: 671px of an 848px window, where
 * Chrome gives it 583px.
 *
 * So the feature is asked about rather than the browser: a mark is drawn
 * with `vhal` in a vertical line, in the kanbun face, and measured. Where it
 * comes back a whole em, `data-no-vhal` goes on the root and kunten.css
 * gives the cell its half em by hand, with the glyph placed where `vhal`
 * would have placed it (measured against Chrome: the ink of 、, 。 and every
 * closing bracket lies in the upper half of the em, and of every opening
 * bracket in the lower half, to within 0.01em). Measured after the face has
 * loaded, since a fallback face without the feature would answer for one
 * that has it; and `onChange` is called when the answer moves the layout,
 * so that a text already on the page is fitted again. */
export function installHalfWidthPunct(root: HTMLElement, onChange: () => void): void {
  const measure = (): void => {
    const probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.textContent = "、";
    probe.style.cssText = [
      "position: absolute",
      "visibility: hidden",
      "pointer-events: none",
      "writing-mode: vertical-rl",
      "display: inline-block",
      "font-size: 100px",
      "line-height: 1",
      "font-family: var(--font-kanbun)",
      'font-feature-settings: "vhal" 1',
    ].join(";");
    document.body.append(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    // Half an em is 50px; a whole one is 100. Anything nearer the whole one
    // is a browser that did not apply the feature.
    const missing = height > 75;
    if (missing === root.hasAttribute("data-no-vhal")) return;
    root.toggleAttribute("data-no-vhal", missing);
    onChange();
  };

  const face = getComputedStyle(root).getPropertyValue("--font-kanbun").trim();
  const loaded = face && document.fonts?.load ? document.fonts.load(`100px ${face}`, "、") : Promise.resolve();
  loaded.then(measure, measure);
}
