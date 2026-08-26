import type { TokenTree } from "../parse/types.ts";
import type { ReadingResolver } from "../reading/types.ts";
import { findCompoundSpans } from "../reading/jmdictLookup.ts";
import { computeReadingOrder } from "../kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../kakikudashi/generator.ts";

/** Spans (see `findCompoundSpans`) change reading order
 * (`computeReadingOrder`'s `spans` param) — must be the exact same
 * tree-based detection the kundoku panel uses, or the two panels could
 * silently diverge on word order. */
export function renderKakikudashiView(container: HTMLElement, tree: TokenTree, resolve: ReadingResolver): void {
  container.replaceChildren();
  const column = document.createElement("div");
  column.className = "tategaki-column text-kakikudashi";
  // One `.sentence-gap` span per sentence (mirroring KundokuView.ts's own
  // structure) rather than one flat text blob for the whole tree — plain
  // text carries no sentence-boundary information at all, which
  // `scrollSync.ts` needs to align this panel with the kundoku panel by
  // corresponding sentence rather than raw scroll offset.
  tree.sentences.forEach((sentence, i) => {
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    const body = generateKakikudashi(plan, resolve);
    const wrapper = document.createElement("span");
    wrapper.className = "sentence-gap";
    wrapper.append(body + (i === tree.sentences.length - 1 ? "。" : "、"));
    column.append(wrapper);
  });
  container.append(column);
  // Reading starts at this (vertical-rl) panel's own *right* edge —
  // `scrollLeft = 0` is that start, not the browser's own idea of "start"
  // carried over from whatever position scroll-anchoring (or a previous
  // render's leftover scrollLeft on this same, reused container element)
  // last left it at. Without this, a fresh render can open already
  // scrolled partway through the text, cutting off content at *both*
  // edges instead of showing the beginning. Set after the new content is
  // in the DOM, since scrollWidth isn't known beforehand.
  container.scrollLeft = 0;
}
