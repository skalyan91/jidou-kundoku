import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The analysis's tab order and the ring round a focused reading.
 *
 * Read off the source, as the rest of this suite's wiring tests are: both are
 * facts about the DOM order and the measurement a browser makes, and this
 * suite runs in Node with no layout engine. They were checked on the page
 * (學而 at a scale of 3): Tab went 子 → し → 名詞 → 人 → 人 → 主語 and
 * Shift+Tab the same road back, and the ring stood 4px off the kana's em
 * square on all four sides for し, まなビ, テ and a 再読文字's ザル. These
 * tests hold the wiring that produced that. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inspector = readFileSync(join(root, "src/render/tokenInspector.ts"), "utf8");
const css = readFileSync(join(root, "src/render/kunten.css"), "utf8");

function body(name: string): string {
  const at = inspector.indexOf(`function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  return inspector.slice(at, inspector.indexOf("\n}\n", at));
}

describe("the analysis's tab order", () => {
  it("puts the pill row ahead of the relation label in the document", () => {
    // Document order is tab order: 品詞 (and its pills) before the relation.
    expect(inspector).toContain("overlay.insertBefore(subtitle, overlay.querySelector(DEPREL_LABEL));");
    expect(inspector).not.toContain("overlay.append(subtitle);");
    // And no positive tabindex anywhere, which would reorder the whole page.
    expect(inspector).not.toMatch(/tabIndex = [1-9]|"tabindex", "[1-9]/);
  });

  it("keeps the row painted over the label from its new place", () => {
    const rule = /\.token-inspector-overlay > \.token-subtitle-row \{\s*z-index: 1;\s*\}/;
    expect(css).toMatch(rule);
  });

  it("walks back into the row onto its last pill", () => {
    const enter = body("enterRowFromBehind");
    // Only on Shift+Tab, onto the 品詞 pill, from past the row, not from a menu.
    expect(enter).toContain("if (!tabbingBack) return;");
    expect(enter).toContain('target.matches(".token-subtitle-pos")');
    expect(enter).toContain("Node.DOCUMENT_POSITION_FOLLOWING");
    expect(enter).toContain(`from.closest('[role="menu"]')`);
    expect(body("watchSemantics")).toContain("enterRowFromBehind(row, event);");
    expect(body("watchModality")).toContain('tabbingBack = event.key === "Tab" && event.shiftKey;');
  });
});

describe("the ring round a focused reading", () => {
  it("is fitted to the kana, not to the box of the .kanji-reading", () => {
    const fit = body("fitReadingRing");
    // The union starts from the runs, never from the box: the box is where a
    // centred furigana is *not*, and where okurigana alone are not either.
    expect(fit).not.toMatch(/let \{ top, bottom, left, right \} = own;/);
    // Across the column, an inline run is measured by its line (the em), not
    // by its content area.
    expect(fit).toContain('getComputedStyle(run).display === "inline"');
    // A 再読文字's second reading has no runs and is measured as itself.
    expect(fit).toContain("runs.length > 0 ? runs : [part]");
  });
});

/** The first Tab after a text opens, and Escape letting the focus go.
 *
 * Checked on the page (Chromium): after 學而 was opened, by a click or by
 * Enter on its button, the first Tab landed on its first character (the 學 of
 * the title) and Shift+Tab from there on the rail before the text; Escape on
 * a character, on the 品詞 pill and on a rail left nothing focused, and the
 * next Tab from a character or a pill went back to the same character; a
 * dialog still closed on Escape, and a menu still closed before anything
 * else. These hold the wiring. */
const main = readFileSync(join(root, "src/main.ts"), "utf8");

function exported(name: string): string {
  const at = inspector.indexOf(`export function ${name}(`);
  expect(at).toBeGreaterThan(-1);
  return inspector.slice(at, inspector.indexOf("\n}\n", at));
}

describe("the first Tab after a text opens", () => {
  it("is asked for only when a new tree is adopted, after both panels are drawn", () => {
    expect(main).toContain("const opened = lastRender?.tree !== tree;");
    expect(main).toContain("if (opened && populated) startAtText(kundokuView);");
    // The question comes before the answer is overwritten.
    expect(main.indexOf("const opened = lastRender?.tree !== tree;")).toBeLessThan(
      main.indexOf("lastRender = { tree, resolver, jmdict, kanjidic, historicalKana, rimes };"),
    );
  });

  it("forgets the old text's place, and leaves a field or a dialog alone", () => {
    const start = exported("startAtText");
    expect(start).toContain("tabStop = null;");
    expect(start).toContain("focusHome = null;");
    expect(start).toContain("if (modalIsOpen() || isTypingField(document.activeElement)) return;");
    expect(start).toContain("putFocusAtThreshold(container);");
  });

  it("puts focus at the threshold without leaving the panel focusable", () => {
    const threshold = body("putFocusAtThreshold");
    expect(threshold).toContain("container.focus({ preventScroll: true });");
    expect(threshold).toContain("container.blur();");
    expect(threshold).toContain('if (lent) container.removeAttribute("tabindex");');
  });
});

describe("Escape lets the focus go", () => {
  it("last, on window, for a press nothing else spent", () => {
    const release = exported("setupEscapeReleasesFocus");
    expect(release).toContain('window.addEventListener("keydown"');
    expect(release).not.toContain("capture");
    expect(release).toContain('if (event.key !== "Escape" || event.defaultPrevented) return;');
    expect(release).toContain("if (modalIsOpen()) return;");
    expect(release).toContain("isTypingField(active)");
    // Attached from the start, not by the first render.
    expect(main).toContain("setupEscapeReleasesFocus(kundokuView);");
  });

  it("goes with the selection when the focus is on the selection", () => {
    expect(inspector).toContain("if (event.defaultPrevented || !selected) return;");
    expect(inspector).toContain("if (onSelection) putFocusAtThreshold(container);");
  });
});
