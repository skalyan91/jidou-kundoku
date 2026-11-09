/** Switches on the cut edge of the two sidebars (paperEdge.css).
 *
 * **Why the sidebars are leaves.** The text is the page of the edition, and
 * the two sidebars are the working papers laid beside it: a sheet of notes
 * on the left, a sheet listing the saved texts on the right. A ruled line
 * between them said "frame", which is the language of a program; the edge of
 * a second sheet says "another piece of paper on the desk".
 *
 * **A cut edge, not a deckle.** The reader: *"I wanted a straight edge with
 * light reflecting off it, not a deckled washi paper edge."* A trimmed sheet
 * ends in a straight line, and the thickness of the paper at that line
 * catches the light as a thin bright edge, with the sheet casting a faint
 * shade on the page beyond it. Both are plain CSS (a lit 1px border and a
 * soft `box-shadow`), so nothing is drawn by script any more; the canvas
 * deckle this file used to draw is gone.
 *
 * **What is left here is the switch.** The edge is on only while
 * `data-paper-edge` is on the root, and it is taken off under reduced
 * transparency, more contrast and forced colours, the three preferences
 * under which paper.css withdraws the grain, so the panels go back to their
 * hairline. Done with `matchMedia` rather than with the same three queries
 * in the stylesheet because an engine that does not know
 * `prefers-reduced-transparency` evaluates a query naming it as false, and
 * written as a condition for the edge that would switch the edge off
 * everywhere such an engine runs. `matchMedia` answers the three as "does
 * not match" there, which leaves the edge on. Print drops the sidebars
 * altogether (print.css). */
const PLAIN = "(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)";

export function installPaperEdge(root: HTMLElement = document.documentElement): void {
  const plain = matchMedia(PLAIN);
  const refresh = () => {
    if (plain.matches) delete root.dataset.paperEdge;
    else root.dataset.paperEdge = "";
  };
  refresh();
  plain.addEventListener("change", refresh);
}
