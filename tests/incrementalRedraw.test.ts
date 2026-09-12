/** @vitest-environment jsdom
 *
 * This one file opts into jsdom, against the rest of the suite's own rule
 * (see `tests/customProperties.test.ts`'s note on why: "jsdom has no layout
 * for an end-to-end test to measure"). That is still true here — every
 * `getBoundingClientRect()` the fit calls comes back zero, so nothing this
 * file checks is a claim about pixels or about which column a character
 * lands in. What it needs jsdom *for* is real `Element`/`Text` construction:
 * `renderKundokuView`/`renderKakikudashiView` build actual DOM trees, and the
 * one property this suite cannot check any other way is that two different
 * routes to the same tree produce the *same* tree of elements — same tag
 * names, same classes, same `data-*`, same text. `innerHTML` equality is
 * exactly that comparison and needs nothing about layout to be meaningful.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { chosenSpellsOutInProse, setChosenReading } from "../src/reading/chosenReading.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import type { Sentence, Token, TokenTree } from "../src/parse/types.ts";
import { redrawKundokuSentencesInPlace, renderKundokuView } from "../src/render/KundokuView.ts";
import { redrawKakikudashiSentencesInPlace, renderKakikudashiView } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// **The guard the report asks for**: an edit plus the incremental redraw must
// leave both panels in exactly the state a full redraw of the same edited
// tree would — not "close", not "the same prose", the same tree of DOM nodes.
//
// The method is two trees, not one. `treeA` is rendered once (a "last full
// render"), edited in place, then redrawn *incrementally* — exactly what
// `main.ts`'s `redrawInPlace` now does. `treeB` is a deep clone of the
// *original*, never rendered before, given the identical edit, then rendered
// *once, in full*. Because `treeB`'s `Sentence`/`Token` objects are new,
// every module-level memo in `KundokuView.ts`/`KakikudashiView.ts` (keyed by
// object identity — see `sentenceMemo.ts`) misses on every one of them, so
// `renderKakikudashiView(..., treeB, ...)` is a genuine full computation with
// nothing reused. If the incremental path skipped an invalidation it should
// not have, `treeA`'s panel would still show the *old* content for the
// sentence that needed to change, or an untouched neighbour would show
// something `treeB`'s honest recomputation does not — either way the
// `innerHTML` comparison catches it.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const historicalKana = JSON.parse(
  readFileSync(join(DATA, "historical-kana-index.json"), "utf-8"),
) as HistoricalKanaIndex;
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

// jsdom implements no scrolling at all (there is no layout to scroll within),
// so `Element.scrollTo` — which both render functions call, unconditionally,
// to reset the panel to its reading start — is simply absent. Stubbed rather
// than worked around at the call site: scrolling is not a claim this file
// makes about either panel, and every other environment this code runs in
// (a real browser) has the method.
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

function cloneToken(t: Token): Token {
  return { ...t, misc: t.misc ? { ...t.misc } : undefined };
}

function cloneSentence(s: Sentence): Sentence {
  return { tokens: s.tokens.map(cloneToken) };
}

function cloneTree(tree: TokenTree): TokenTree {
  return { source: tree.source, sentences: tree.sentences.map(cloneSentence) };
}

/** The 酒蟲 sample, several copies over — "several copies" is the report's
 * own suggestion for a document long enough that an edit touching one
 * sentence in the middle of it is a meaningful test of "only that sentence
 * moved". Copied by *sentence* (not by re-parsing repeated text), so token
 * ids stay small and sentence-relative exactly as a real long document's
 * would be. */
function longTree(copies: number): TokenTree {
  const base = parseConllu(readFileSync(join(DATA, "samples", "shuchu.conllu"), "utf-8"));
  const sentences: Sentence[] = [];
  for (let c = 0; c < copies; c++) for (const s of base.sentences) sentences.push(cloneSentence(s));
  return { source: "conllu", sentences };
}

/** Renders both panels for `tree` into two fresh, unattached containers — no
 * `.main` ancestor, deliberately: the fit's whole candidate search needs a
 * companion kundoku column to measure against (`fitPassageExtent`'s own
 * `container.closest(".main")`), finds none here, and takes the "no panel to
 * match" branch on every call — the same branch a print band or a fixture
 * takes today. That keeps every render in this file, incremental or full,
 * on the one fit path that does not depend on `getBoundingClientRect`
 * returning anything but zero, which is all jsdom will ever give it. */
function renderBoth(tree: TokenTree): { kundoku: HTMLElement; kaki: HTMLElement } {
  const kundoku = document.createElement("div");
  const kaki = document.createElement("div");
  renderKundokuView(kundoku, tree, resolve, jmdict, kanjidic, historicalKana, null);
  renderKakikudashiView(kaki, tree, resolve, jmdict, kanjidic, historicalKana, null);
  return { kundoku, kaki };
}

/** A token this sentence's inspector could plausibly retag — its own SUD
 * relation flipped to something else attested in the corpus, which is
 * exactly what the retag menu does. */
function pickEditableToken(sentence: Sentence): Token {
  const candidate = sentence.tokens.find((t) => t.dep !== "ROOT");
  if (!candidate) throw new Error("fixture sentence has no non-root token");
  return candidate;
}

describe("incremental redraw matches a full redraw of the same edited tree", () => {
  it("kundoku panel: a relation edit produces the same markup as a fresh render, for the whole document", () => {
    const treeA = longTree(2);
    const { kundoku: kundokuA } = renderBoth(treeA);
    const treeB = cloneTree(treeA);

    const editIndex = Math.floor(treeA.sentences.length / 2);
    const tokenA = pickEditableToken(treeA.sentences[editIndex]);
    const tokenB = treeB.sentences[editIndex].tokens.find((t) => t.id === tokenA.id)!;
    const newDep = tokenA.dep === "mod" ? "comp:obj" : "mod";
    tokenA.dep = newDep;
    tokenB.dep = newDep;

    const changed = redrawKundokuSentencesInPlace(kundokuA, treeA, resolve, jmdict, kanjidic, historicalKana, null);
    expect(changed).toBe(true);

    const { kundoku: kundokuB } = renderBoth(treeB);
    expect(kundokuA.innerHTML).toBe(kundokuB.innerHTML);
  });

  it("prose panel: the same relation edit produces the same markup as a fresh render, for the whole document", () => {
    const treeA = longTree(2);
    const { kaki: kakiA } = renderBoth(treeA);
    const treeB = cloneTree(treeA);

    const editIndex = Math.floor(treeA.sentences.length / 2);
    const tokenA = pickEditableToken(treeA.sentences[editIndex]);
    const tokenB = treeB.sentences[editIndex].tokens.find((t) => t.id === tokenA.id)!;
    const newDep = tokenA.dep === "mod" ? "comp:obj" : "mod";
    tokenA.dep = newDep;
    tokenB.dep = newDep;

    redrawKakikudashiSentencesInPlace(kakiA, treeA, resolve, jmdict, kanjidic, historicalKana);

    const { kaki: kakiB } = renderBoth(treeB);
    expect(kakiA.innerHTML).toBe(kakiB.innerHTML);
  });

  it("a reading choice on a content word that keeps its kanji leaves the prose panel untouched", () => {
    const treeA = longTree(2);
    const { kundoku: kundokuA, kaki: kakiA } = renderBoth(treeA);
    const kakiBefore = kakiA.innerHTML;
    const kundokuBefore = kundokuA.innerHTML;
    const treeB = cloneTree(treeA);

    // A content word — one `chosenSpellsOutInProse` says the prose keeps as
    // kanji regardless of reading (see the report's own argument for the
    // on'yomi exception, generalized here to any such token rather than
    // narrowed to on'yomi specifically).
    let editIndex = -1;
    let tokenA: Token | undefined;
    for (let i = 0; i < treeA.sentences.length && !tokenA; i++) {
      const found = treeA.sentences[i].tokens.find(
        (t) => /\p{Script=Han}/u.test(t.text) && !chosenSpellsOutInProse(t),
      );
      if (found) {
        editIndex = i;
        tokenA = found;
      }
    }
    if (!tokenA) throw new Error("fixture has no content-word token to pick a reading on");
    const tokenB = treeB.sentences[editIndex].tokens.find((t) => t.id === tokenA!.id)!;
    // Any reading distinct from whatever is already resolved will do — the
    // claim under test is that the *prose* is indifferent to which one, not
    // that this particular kana is realistic.
    setChosenReading(tokenA, "ぽんぽこ");
    setChosenReading(tokenB, "ぽんぽこ");

    const kakiChanged = redrawKakikudashiSentencesInPlace(kakiA, treeA, resolve, jmdict, kanjidic, historicalKana);
    const kundokuChanged = redrawKundokuSentencesInPlace(
      kundokuA,
      treeA,
      resolve,
      jmdict,
      kanjidic,
      historicalKana,
      null,
    );

    // The invariant, both directions: nothing the reader would call "the
    // prose" moved, and the panel where the reading actually shows — the
    // furigana above the kundoku cell — did.
    expect(kakiChanged).toBe(false);
    expect(kakiA.innerHTML).toBe(kakiBefore);
    expect(kundokuChanged).toBe(true);
    expect(kundokuA.innerHTML).not.toBe(kundokuBefore);

    // And still identical to an honest full recomputation of the edited tree
    // — the reading did reach the kundoku panel, correctly, not merely
    // "something changed".
    const { kundoku: kundokuB } = renderBoth(treeB);
    expect(kundokuA.innerHTML).toBe(kundokuB.innerHTML);
  });

  it("an edit to one sentence leaves every other sentence's kundoku cells the very same DOM nodes", () => {
    // Not just equal markup — the *same elements*, which is the stronger
    // claim the report makes ("no character ever moves") and the one that
    // actually matters for scroll position, the inspector's own selection
    // bookkeeping, and animation continuity across an edit.
    const tree = longTree(2);
    const { kundoku } = renderBoth(tree);
    const column = kundoku.querySelector(":scope > .tategaki-column")!;
    const untouchedIndex = 1; // never the edited sentence, below
    const before = column.children[untouchedIndex];

    const editIndex = Math.floor(tree.sentences.length / 2);
    const token = pickEditableToken(tree.sentences[editIndex]);
    token.dep = token.dep === "mod" ? "comp:obj" : "mod";
    redrawKundokuSentencesInPlace(kundoku, tree, resolve, jmdict, kanjidic, historicalKana, null);

    expect(column.children[untouchedIndex]).toBe(before);
  });
});
