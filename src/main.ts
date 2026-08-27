import "./app.css";
// After app.css, deliberately: `@media print` adds no specificity of its
// own, so the print overrides only beat the screen rules if they come
// later in the bundle. A CSS `@import` can't express that (it is only
// valid at the top of a stylesheet), so the ordering lives here.
import "./render/print.css";
import { applyTranslations, getUiLang, onLangChange, t } from "./i18n/i18n.ts";
import { renderSidebar } from "./render/Sidebar.ts";
import { renderKundokuView } from "./render/KundokuView.ts";
import { renderKakikudashiView } from "./render/KakikudashiView.ts";
import { parseConllu, validateConlluForLzh } from "./parse/conlluParser.ts";
import { annotateSourceLayout } from "./parse/sourceLayout.ts";
import { splitIntoSentences } from "./parse/splitSentences.ts";
import { parseText as parseWithPyodide } from "./parse/pyodideClient.ts";
import type { TokenTree } from "./parse/types.ts";
import type { ReadingResolver } from "./reading/types.ts";
import { createReadingResolver } from "./reading/readingResolver.ts";
import { loadKanjidicIndex, type KanjidicIndex } from "./reading/kanjidicLookup.ts";
import { loadJmdictIndex, type JmdictIndex } from "./reading/jmdictLookup.ts";
import { loadHistoricalKanaIndex, type HistoricalKanaIndex } from "./reading/historicalKana.ts";
import { setupScrollSync } from "./render/scrollSync.ts";
import { setupPrintLayout } from "./render/printLayout.ts";
import { setTokenEditHandler } from "./render/tokenInspector.ts";
import { setHistoryTree } from "./render/editHistory.ts";
import { renderSavedPanel } from "./render/SavedPanel.ts";

document.documentElement.lang = getUiLang();

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <aside class="sidebar" id="sidebar"></aside>
  <button class="rail rail-left" id="toggle-left" type="button" aria-expanded="true"></button>
  <main class="main" id="main">
    <section class="main-panel kundoku-panel">
      <h2 data-i18n="main.kundokuHeading"></h2>
      <div class="tategaki" id="kundoku-view"></div>
    </section>
    <button class="rail rail-kakikudashi" id="toggle-kakikudashi" type="button" aria-expanded="true"></button>
    <section class="main-panel kakikudashi-panel">
      <h2 data-i18n="main.kakikudashiHeading"></h2>
      <div class="tategaki" id="kakikudashi-view"></div>
    </section>
  </main>
  <button class="rail rail-right" id="toggle-right" type="button" aria-expanded="true"></button>
  <aside class="saved-panel" id="saved-panel"></aside>
`;
applyTranslations(app);
// The language toggle only flips the language; re-translating is done here
// so it reaches the *whole* document — the main panel headings sit outside
// the sidebar that owns the toggle. Status text is regenerated on the next
// parse rather than retranslated in place.
function syncDocumentTitle(): void {
  // The <title> isn't inside `#app`, so `applyTranslations` never reaches
  // it — set it from the same string the sidebar heading uses.
  document.title = t("app.title");
}
syncDocumentTitle();

onLangChange(() => {
  applyTranslations(app);
  syncDocumentTitle();
  // The saved-texts list is built in script, so its own translated bits
  // (the empty-state line, the delete button's labels) need rebuilding
  // rather than just re-walking `data-i18n` attributes.
  savedPanel?.refresh();
  syncRailLabels();
});

const kundokuView = document.querySelector<HTMLElement>("#kundoku-view")!;
const kakikudashiView = document.querySelector<HTMLElement>("#kakikudashi-view")!;
kundokuView.innerHTML = `<p class="main-empty" data-i18n="main.empty"></p>`;
kakikudashiView.innerHTML = "";
applyTranslations(kundokuView);
setupScrollSync(kundokuView, kakikudashiView);
// Printing goes through a paginated clone of these two panels rather than
// the panels themselves; `beforeprint` is the hook for both the button
// (window.print() fires it) and a plain Ctrl+P.
setupPrintLayout(kundokuView, kakikudashiView);

let resolverPromise: Promise<{
  resolver: ReadingResolver;
  jmdict: JmdictIndex;
  kanjidic: KanjidicIndex;
  historicalKana: HistoricalKanaIndex;
}> | null = null;
function getResolver() {
  if (!resolverPromise) {
    resolverPromise = Promise.all([loadKanjidicIndex(), loadJmdictIndex(), loadHistoricalKanaIndex()]).then(
      ([kanjidic, jmdict, historicalKana]) => ({
        resolver: createReadingResolver(kanjidic, jmdict, historicalKana),
        jmdict,
        kanjidic,
        historicalKana,
      }),
    );
  }
  return resolverPromise;
}

/** Everything the last `renderTree` was given — kept so an in-place edit
 * from `tokenInspector.ts` (retagging a token, re-parenting one) can redraw
 * both panels from the same tree without the sidebar's parse path having to
 * run again. */
let lastRender: {
  tree: TokenTree;
  resolver: ReadingResolver;
  jmdict: JmdictIndex;
  kanjidic: KanjidicIndex;
  historicalKana: HistoricalKanaIndex;
} | null = null;

function renderTree(
  tree: TokenTree,
  resolver: ReadingResolver,
  jmdict: JmdictIndex,
  kanjidic: KanjidicIndex,
  historicalKana: HistoricalKanaIndex,
) {
  lastRender = { tree, resolver, jmdict, kanjidic, historicalKana };
  // Re-rendering after an edit passes the same tree object, so the undo
  // history survives; a genuinely new one (a fresh parse, a saved text
  // reopened) replaces it and clears the history with it.
  setHistoryTree(tree);
  renderKundokuView(kundokuView, tree, resolver, jmdict, kanjidic, historicalKana);
  renderKakikudashiView(kakikudashiView, tree, resolver);
}

// The inspector edits `tree`'s own token objects in place, so re-running
// the same render is all that's needed to reflect an edit — in both panels,
// and (since it's the same `TokenTree` the sidebar already holds) in the
// CoNLL-U export too.
setTokenEditHandler(() => {
  if (!lastRender) return;
  const { tree, resolver, jmdict, kanjidic, historicalKana } = lastRender;
  renderTree(tree, resolver, jmdict, kanjidic, historicalKana);
});

const sidebar = renderSidebar(document.querySelector<HTMLElement>("#sidebar")!, {
  async onParseText(text) {
    sidebar.setParsing(true);
    sidebar.setStatus(t("status.loadingParser"), "busy");
    try {
      sidebar.setStatus(t("status.parsing"), "busy");
      const [tree, { resolver, jmdict, kanjidic, historicalKana }] = await Promise.all([parseWithPyodide(text), getResolver()]);
      // Measure the source's own lines and paragraphs onto the tree, then
      // split it at every sentence boundary the parser missed — both the
      // punctuation it ignored and those line breaks. In that order: the
      // split reads the layout to know where the lines are.
      annotateSourceLayout(tree, text);
      const split = splitIntoSentences(tree);
      renderTree(split, resolver, jmdict, kanjidic, historicalKana);
      setTree(split);
      sidebar.setStatus(t("status.ready"));
    } catch (err) {
      console.error(err);
      sidebar.setStatus(t("error.parserUnavailable"), "error");
    } finally {
      sidebar.setParsing(false);
    }
  },

  async onUploadConllu(fileText) {
    sidebar.setParsing(true);
    try {
      const tree = parseConllu(fileText);
      const validation = validateConlluForLzh(tree);
      if (!validation.valid) {
        console.warn("CoNLL-U plausibility warnings:", validation.warnings);
        sidebar.setStatus(t("error.invalidConllu"), "error");
        return;
      }
      const { resolver, jmdict, kanjidic, historicalKana } = await getResolver();
      renderTree(tree, resolver, jmdict, kanjidic, historicalKana);
      setTree(tree);
      sidebar.setStatus(t("status.ready"));
    } catch (err) {
      console.error(err);
      sidebar.setStatus(t("status.error"), "error");
    } finally {
      sidebar.setParsing(false);
    }
  },
});

/** Both panels take a tree at once — the left one to enable its export and
 * print buttons, the right one its save button. */
function setTree(tree: TokenTree | null): void {
  sidebar.setTree(tree);
  savedPanel.setTree(tree);
}

const savedPanel = renderSavedPanel(document.querySelector<HTMLElement>("#saved-panel")!, {
  currentSource: () => sidebar.sourceText(),
  async onOpenSaved(source, tree) {
    // Straight from storage: the saved tree already carries any hand edits,
    // and re-parsing `source` would throw them away (as well as needing the
    // parser up just to reopen something already annotated).
    sidebar.setSourceText(source);
    sidebar.setParsing(true);
    try {
      const { resolver, jmdict, kanjidic, historicalKana } = await getResolver();
      renderTree(tree, resolver, jmdict, kanjidic, historicalKana);
      setTree(tree);
      sidebar.setStatus(t("status.ready"));
    } catch (err) {
      console.error(err);
      sidebar.setStatus(t("status.error"), "error");
    } finally {
      sidebar.setParsing(false);
    }
  },
});
applyTranslations(document.querySelector<HTMLElement>("#saved-panel")!);

/** Collapsing either panel is a class on `#app`, so the grid columns (and
 * the rails' own arrows) are described in one place in CSS rather than
 * being poked at from script. The choice persists so a preferred working
 * layout survives a reload. */
const COLLAPSE_KEY = "jidou-kundoku:collapsed";
const railLeft = document.querySelector<HTMLButtonElement>("#toggle-left")!;
const railRight = document.querySelector<HTMLButtonElement>("#toggle-right")!;
const railKakikudashi = document.querySelector<HTMLButtonElement>("#toggle-kakikudashi")!;

function syncRailLabels(): void {
  const leftOpen = !app.classList.contains("left-collapsed");
  const rightOpen = !app.classList.contains("right-collapsed");
  railLeft.title = t(leftOpen ? "sidebar.collapseLeft" : "sidebar.expandLeft");
  railLeft.setAttribute("aria-label", railLeft.title);
  railLeft.setAttribute("aria-expanded", String(leftOpen));
  railRight.title = t(rightOpen ? "sidebar.collapseRight" : "sidebar.expandRight");
  railRight.setAttribute("aria-label", railRight.title);
  railRight.setAttribute("aria-expanded", String(rightOpen));
  const kakiOpen = !app.classList.contains("kakikudashi-collapsed");
  railKakikudashi.title = t(kakiOpen ? "main.collapseKakikudashi" : "main.expandKakikudashi");
  railKakikudashi.setAttribute("aria-label", railKakikudashi.title);
  railKakikudashi.setAttribute("aria-expanded", String(kakiOpen));
}

function persistCollapse(): void {
  try {
    localStorage.setItem(
      COLLAPSE_KEY,
      JSON.stringify({
        left: app.classList.contains("left-collapsed"),
        right: app.classList.contains("right-collapsed"),
        kakikudashi: app.classList.contains("kakikudashi-collapsed"),
      }),
    );
  } catch {
    // Unavailable (private mode) — the layout just won't persist.
  }
}

try {
  const stored = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  app.classList.toggle("left-collapsed", stored.left === true);
  app.classList.toggle("right-collapsed", stored.right === true);
  app.classList.toggle("kakikudashi-collapsed", stored.kakikudashi === true);
} catch {
  // Ignore a corrupt entry and open both.
}
syncRailLabels();

railLeft.addEventListener("click", () => {
  app.classList.toggle("left-collapsed");
  syncRailLabels();
  persistCollapse();
});
railRight.addEventListener("click", () => {
  app.classList.toggle("right-collapsed");
  syncRailLabels();
  persistCollapse();
});
railKakikudashi.addEventListener("click", () => {
  app.classList.toggle("kakikudashi-collapsed");
  syncRailLabels();
  persistCollapse();
});
