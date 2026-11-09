import { applyTranslations, getUiLang, onLangChange, setUiLang, t } from "../i18n/i18n.ts";
import type { TokenTree } from "../parse/types.ts";
import { exportConllu } from "../parse/conlluExporter.ts";
import { titleOf } from "../parse/savedTexts.ts";
import { generateAnnotationText, generateKanbunTex, scrapeAnnotationTokens } from "../kanbun/texAnnotation.ts";
import { openHelpModal } from "./HelpModal.ts";
import { openAboutModal } from "./AboutModal.ts";
import { animateAnnotationShift } from "./KundokuView.ts";
import { setRenyouTe } from "../kakikudashi/renyouTe.ts";
import { createStatusLine, type StatusOptions } from "./statusLine.ts";
import type { StringKey } from "../i18n/i18n.ts";

/** The texts that ship with the app, in the order their buttons stand.
 *
 * Two, and deliberately unlike each other: a canonical philosophical text in
 * short parallel clauses, and a piece of narrative prose. Between them they
 * exercise most of what the annotator has to do — the 論語 is quotation,
 * 而-coordination and the 不亦…乎 frame, the 酒蟲 is a story with proper
 * names, a nested quotation and a long tail of 之/其 anaphora — so a reader
 * opening the app for the first time can see it work on both kinds of prose
 * without having a file of their own to hand.
 *
 * Each is a CoNLL-U tree rather than a 白文, so a click takes the upload's
 * route (`onLoadSample` → `openConlluText` in `main.ts`) and never the
 * parser's. That is not a shortcut: these are *annotated* texts, and running
 * them through the in-browser parser would replace a checked analysis with a
 * predicted one and make the samples a demonstration of the parser rather
 * than of the app. It also means a sample opens without Pyodide having to
 * come up at all, which on a cold load is the difference between a click and
 * a wait of several seconds.
 *
 * `label` is a key in both `en.json` and `ja.json`; the titles themselves are
 * the same Han in either language. */
export const SAMPLE_TEXTS = [
  { id: "sample-rongo", path: "/data/samples/rongo-gakuji.conllu", label: "sidebar.sampleRongo", hint: "sidebar.sampleRongoFull" },
  { id: "sample-shuchu", path: "/data/samples/shuchu.conllu", label: "sidebar.sampleShuchu", hint: "sidebar.sampleShuchuFull" },
  // The third is verse, and is here for what verse asks of the panel that
  // prose does not: eight lines of five characters, and a 韻 hung on the end
  // of each of them in 割注 (`rimeAnnotation.ts`). It is also the only shipped
  // text whose lines the reader can see are lines — `LineBreak` on every one.
  { id: "sample-shunbou", path: "/data/samples/shunbou.conllu", label: "sidebar.sampleShunbou", hint: "sidebar.sampleShunbouFull" },
] as const;

export interface SidebarCallbacks {
  onParseText: (text: string) => void;
  onUploadConllu: (fileText: string) => void;
  /** One of the shipped samples was asked for, by the URL it is served
   * from. The fetch is `main.ts`'s and not this panel's, because what comes
   * back is a document to be put on the page, and every other route that
   * does that is already there — this one joins them rather than opening a
   * second way in. */
  onLoadSample: (path: string) => void;
  /** Puts the app back to its opening state — both panels emptied, nothing
   * to export or save. The input box is cleared here; everything else lives
   * in `main.ts`, which owns what is on screen. `previousText` is what the
   * box held, so that `main.ts` can offer the whole page back — box and all —
   * from the status line. */
  onClear: (previousText: string) => void;
  /** The 連用形-て switch was flipped. Unlike the three switches above it,
   * this one changes what the panels *write* rather than what they show, so
   * neither a class on `<body>` nor a repaint can carry it: both panels have
   * to be drawn again from the tree. `main.ts` is what holds that tree, so it
   * is what does the redrawing. */
  onRenyouTeChange: () => void;
  /** The Save button. The store is the saved panel's, so this only asks. */
  onSave: () => void;
}

export interface SidebarHandle {
  root: HTMLElement;
  /** Shows a status message by its key, or empties the line (null). Keys
   * rather than strings, so the line re-translates itself when the language
   * changes — see `statusLine.ts`. */
  setStatus: (key: StringKey | null, options?: StatusOptions) => void;
  setParsing: (busy: boolean) => void;
  /** Enables the export/print/save buttons against this tree, or disables
   * them (pass null) — e.g. while a new parse is in flight. */
  setTree: (tree: TokenTree | null) => void;
  setSourceText: (text: string) => void;
  /** What the input box holds right now, exactly as typed. */
  getSourceText: () => string;
}

/** Which annotations the kundoku panel shows. Each is a class on <body>
 * naming what is *hidden*, so the default — everything shown — needs no
 * class at all, and the print layout's cloned DOM picks the state up for
 * free rather than needing it threaded through.
 *
 * Persisted, since it is a way of working (reading unaided, checking
 * yourself against the annotations) rather than a per-text choice. */
const DISPLAY_TOGGLES = [
  { id: "show-furigana", hideClass: "hide-furigana", key: "jidou-kundoku:show-furigana" },
  { id: "show-okurigana", hideClass: "hide-okurigana", key: "jidou-kundoku:show-okurigana" },
  { id: "show-kunten", hideClass: "hide-kunten", key: "jidou-kundoku:show-kunten" },
];

/** The 連用形-て switch, which sits with the three above it and is not one of
 * them.
 *
 * Those name something the panel *has* and hide it, so they are classes on
 * `<body>`, they default to on, and what they persist is the word "off". This
 * one names a printing convention the panels do not use by default — a bare
 * 連用形 written out as a converb (see `kakikudashi/renyouTe.ts`) — so it
 * defaults to **off**, it persists the word "on", and flipping it has to redraw
 * both panels rather than repaint them: the て is part of what the generator
 * writes, not part of what CSS shows.
 *
 * Stored under the same key prefix as the others, and restored before either
 * panel is first drawn (`renderSidebar` runs ahead of every render in
 * `main.ts`), so a reload comes back showing what the reader left. */
const RENYOU_TE_KEY = "jidou-kundoku:renyou-te";

function setupRenyouTeToggle(container: HTMLElement, onChange: () => void): void {
  const box = container.querySelector<HTMLInputElement>("#renyou-te");
  if (!box) return;
  let on = false;
  try {
    on = localStorage.getItem(RENYOU_TE_KEY) === "on";
  } catch {
    // Storage unavailable (private mode); the choice just won't persist.
  }
  box.checked = on;
  setRenyouTe(on);
  box.addEventListener("change", () => {
    // **Both panels change**, and only one of them is wrapped here.
    //
    // The 訓読文 gets `animateAnnotationShift`, the same walk the three
    // switches above go through. That walk had to learn one thing to cover
    // this switch. The three above repaint, so the okurigana it carries from
    // one place to the other is the same element both times and can simply be
    // measured twice; this one redraws both panels from the tree, and every
    // node the first measurement held is thrown away before the second one
    // runs. So the two measurements are keyed to what survives a redraw — the
    // sentence, the token id, and which cell of that token — rather than
    // paired off by position. See `keyedCells`, and `animateAnnotationShift`
    // for what a redraw moves that a repaint does not: a reading that stops
    // being centred when a bare テ arrives in its lane, and a lane that
    // overflows and sends its reading outside.
    //
    // The 書き下し文 is wrapped by `main.ts` instead, and deliberately not
    // here. It used to be nested inside this call — this switch was the one
    // thing that panel animated, so the switch was where the wrapping went.
    // The panel now settles on *every* redraw of a tree the reader already
    // has open (an annotation edit as much as this switch), and the one place
    // that knows a redraw is that kind is `main.ts`, which owns the tree. So
    // `onChange` below reaches `animateKakikudashiReflow` on its own way
    // through, one wrapping deep rather than two, and there is no route into a
    // redraw that has to remember to ask for it. See `redrawInPlace` there.
    //
    // Two more things happen inside `onChange` that this switch does not have
    // to ask for, both for the same reason — they belong to *any* redraw of a
    // text the reader already has open, and the funnel is where they go. It
    // stops a character reveal still running, which this switch can otherwise
    // move the page out from under; and it re-answers the fit, this being the
    // one switch that changes how many characters the prose holds and so how
    // the two panels divide the height between them. Both are argued at
    // `redrawInPlace` and at `fitPassageExtent`.
    //
    // The whole change is still inside this call, the module flag as well as
    // the redraw, so what this measures is the page exactly as the reader last
    // saw it — and `setRenyouTe` writes nothing to the page on its own, so the
    // prose panel's own before-reading, taken a moment later inside `onChange`,
    // is of that same unchanged page.
    animateAnnotationShift(() => {
      setRenyouTe(box.checked);
      onChange();
    });
    try {
      localStorage.setItem(RENYOU_TE_KEY, box.checked ? "on" : "off");
    } catch {
      /* not persisted */
    }
  });
}

function setupDisplayToggles(container: HTMLElement): void {
  for (const { id, hideClass, key } of DISPLAY_TOGGLES) {
    const box = container.querySelector<HTMLInputElement>(`#${id}`);
    if (!box) continue;
    let shown = true;
    try {
      shown = localStorage.getItem(key) !== "off";
    } catch {
      // Storage unavailable (private mode); the choice just won't persist.
    }
    const apply = () => {
      box.checked = shown;
      document.body.classList.toggle(hideClass, !shown);
    };
    apply();
    box.addEventListener("change", () => {
      shown = box.checked;
      // Through `animateAnnotationShift`, which carries the okurigana from
      // where this leaves it back to where it was and lets it travel — only
      // on a change the reader made, never on the initial `apply` above,
      // where there is no previous state to have come from.
      animateAnnotationShift(apply);
      try {
        localStorage.setItem(key, shown ? "on" : "off");
      } catch {
        /* not persisted */
      }
    });
  }
}

/** Marks the sidebar while its scrolling body holds more than it shows, so
 * the footer can draw the rule that says so — see
 * `.sidebar[data-body-overflows]` in app.css.
 *
 * Watched on the body *and* on its children: the body's own box only changes
 * when the window does, but its contents change height on their own — Export
 * appears with the first text, and a language switch rewraps the tagline. */
/** **What the PDF will leave out, said at Export.** The Show switches and
 * the 書き下し文 panel's rail decide what is printed, and nothing at the point
 * of printing said so: a teacher who had switched the 振り仮名 off to read
 * unaided got a handout without them and had to find out from the paper.
 *
 * What each format does with a hidden layer, as the code stands:
 *
 *   - **PDF** follows the screen. The print layout clones the panels inside
 *     `<body>`, so the `body.hide-*` rules (kunten.css, rime.css,
 *     typography.css) reach the clone and fade the same marks to nothing;
 *     and `buildPrintLayout` leaves out the 書き下し文 band altogether while
 *     `#app.kakikudashi-collapsed` is set. So all four are left out.
 *   - **LaTeX** follows none of them. `scrapeAnnotationTokens` reads each
 *     reading, okurigana and kaeriten off the panel by `textContent`, which a
 *     faded mark still has, and the document has no 書き下し文 at all, shown
 *     or not. So a hidden 振り仮名, 送り仮名 or 訓点 is still in the file, and
 *     that is worth one sentence, because it is the opposite of what the PDF
 *     does a line above it.
 *   - **CoNLL-U** is the analysis, not the page: the switches have nothing in
 *     it to remove. It gets no sentence, since it does exactly what it says.
 *
 * The 連用形-て switch is not in this list: it changes what is written rather
 * than hiding anything, and every format that carries a reading carries it.
 *
 * **One sentence with a slot, and the list built by `Intl.ListFormat`.**
 * Fifteen combinations of four layers are too many to write out, and gluing
 * fragments together is how a sentence comes out in English word order in
 * Japanese. The template is a whole sentence in each language, and the list
 * inside it is joined by the platform's own rules for that language: "A, B,
 * and C" in English, 「A、B、C」 in Japanese. The template also sidesteps
 * agreement — "Hidden, so not in the PDF: X" needs no "is/are" for X — so it
 * reads the same whether one layer is off or four. It is short on purpose:
 * the note stands in a sidebar that has to fit a laptop screen without
 * scrolling, and two lines of it are worth more there than three. */
const OMISSION_LAYERS: readonly { hidden: () => boolean; key: StringKey; inTex: boolean }[] = [
  { hidden: () => document.body.classList.contains("hide-furigana"), key: "sidebar.layerFurigana", inTex: true },
  { hidden: () => document.body.classList.contains("hide-okurigana"), key: "sidebar.layerOkurigana", inTex: true },
  { hidden: () => document.body.classList.contains("hide-kunten"), key: "sidebar.layerKunten", inTex: true },
  {
    hidden: () => document.querySelector("#app")?.classList.contains("kakikudashi-collapsed") ?? false,
    key: "sidebar.layerKakikudashi",
    inTex: false,
  },
];

/** The note's markup for what is hidden right now, or "" when nothing is.
 * Markup because the English names are italicised; every piece comes from
 * this app's own translation files, as `applyTranslations` argues for
 * `data-i18n-html`. */
function describeOmissions(): string {
  const hidden = OMISSION_LAYERS.filter((layer) => layer.hidden());
  if (hidden.length === 0) return "";
  const list = new Intl.ListFormat(getUiLang(), { type: "conjunction" }).format(hidden.map((layer) => t(layer.key)));
  const sentences = [t("sidebar.exportOmitted").replace("{list}", list)];
  if (hidden.some((layer) => layer.inTex)) sentences.push(t("sidebar.exportTexKeeps"));
  // The two sentences sit side by side as prose would: a space between them
  // in English, none in Japanese, where 。 already closes the first.
  return sentences.join(getUiLang() === "ja" ? "" : " ");
}

function watchOverflow(container: HTMLElement): void {
  const body = container.querySelector<HTMLElement>(".sidebar-body");
  if (!body || typeof ResizeObserver === "undefined") return;
  const check = () => container.toggleAttribute("data-body-overflows", body.scrollHeight > body.clientHeight + 1);
  const observer = new ResizeObserver(check);
  observer.observe(body);
  for (const child of body.children) observer.observe(child);
}

export function renderSidebar(container: HTMLElement, callbacks: SidebarCallbacks): SidebarHandle {
  // **Two regions, and only the first of them scrolls.** The footer used to
  // be a sticky row inside the one scrolling column, and a sticky row is
  // painted *over* whatever is still beneath it: at 1280×800 it covered the
  // last display switch and half of Export, and it covered the status line
  // outright, so "Ready", "Saved" and every error were written where no one
  // could see them. Now the body scrolls on its own and the footer is a row
  // of its own below it, which nothing can pass under — and the status line
  // lives in it, so the one place the app answers the reader is the one place
  // that is always on screen.
  container.innerHTML = `
    <div class="sidebar-body">
    <div class="sidebar-head">
      <h1 data-i18n="app.title"></h1>
      <button id="lang-toggle" type="button" class="quiet lang-toggle" data-i18n="sidebar.languageToggle"></button>
    </div>
    <p class="app-tagline" data-i18n-html="app.tagline"></p>

    <p class="sample-label" data-i18n="sidebar.sampleLabel"></p>
    <!-- **The work's full name is the button's accessible name**, and not a
         tooltip. A title attribute drew a native tooltip over whatever lay
         under the pointer — the box below, the sample row itself — and was
         the one place 論語・學而 was said. aria-label carries it to a screen
         reader instead, and since it ends in the visible 學而 the spoken name
         still contains the one a voice-control user reads off the button.
         A sighted reader is not left short: the title is the first line of
         the passage the button opens. -->
    <div class="button-row sample-row">
      ${SAMPLE_TEXTS.map(
        (s) =>
          `<button id="${s.id}" type="button" class="secondary sample" data-i18n="${s.label}" data-i18n-attr="aria-label:${s.hint}"></button>`,
      ).join("\n      ")}
    </div>

    <!-- Clear stands with the box it empties rather than beside Annotate.
         Side by side, the one action that throws a page away was a slip of
         the pointer from the one that every visit ends on; up here it is
         plainly about the box, and it is undoable besides. -->
    <div class="field-head">
      <label data-i18n="sidebar.textLabel" for="kundoku-input"></label>
      <button id="clear-btn" type="button" class="destructive field-action" data-i18n="sidebar.clearButton"></button>
    </div>
    <textarea id="kundoku-input" data-i18n-attr="placeholder:sidebar.textPlaceholder"></textarea>
    <button id="parse-btn" type="button" class="primary" data-i18n="sidebar.parseButton"></button>

    <!-- One control, one tab stop. The file input is only the browser's
         picker, opened by the button's click handler; left focusable it was
         a second, invisible stop after the button that a keyboard reader
         landed on with nothing showing. So it is taken out of the tab order
         and out of the accessibility tree.

         **One row says it: "or [Open a CoNLL-U file…]".** It took three —
         a ruled "or" across the panel, a heading ("Upload CoNLL-U file"),
         and a button under the heading that said only "Choose file…" — which
         was two rows and two gaps of the sidebar spent saying one thing
         twice. The button now carries the whole of it, and the "or" stands
         in front of it on the same line, so the row still reads as the other
         way in after Annotate rather than as a step that follows it. -->
    <div class="upload-row">
      <span class="upload-or" data-i18n="sidebar.orDivider"></span>
      <button id="upload-btn" type="button" class="secondary" data-i18n="sidebar.uploadButton" aria-describedby="upload-hint"></button>
    </div>
    <input id="conllu-input" type="file" accept=".conllu,.conll,text/plain" class="visually-hidden" tabindex="-1" aria-hidden="true" />
    <!-- What a CoNLL-U file *is*, said where the reader is asked for one.
         A teacher who reads kanbun has no reason to know a treebank format
         by name, and the only other place it was explained was the About
         FAQ, which nobody opens to find out what a button wants. Tied to the
         button as its description, so a screen reader hears it on arriving
         there. -->
    <p class="field-hint upload-hint" id="upload-hint" data-i18n="sidebar.uploadHint"></p>

    <!-- **Which switches say what they do, and how loudly.** Every one of
         them has a description, carried as aria-description on the box, and
         two of them also say something on the page.

         振り仮名 and 送り仮名 are the words the reader already uses for
         what goes away, and what the app adds to them is detail — that the
         readings go from both panels, that a 再読文字's second reading goes
         with the okurigana — which the accessible description carries
         without a word on the page. They share a row, being the pair whose
         labels are short enough to.

         The other two are not self-explanatory to a reader who knows kanbun
         perfectly well. 訓点 in the ordinary sense takes in the okurigana and
         the punctuation as well, and this switch hides neither: it hides the
         kaeriten, and the rhyme notes on verse (body.hide-kunten in
         kunten.css and rime.css). And "Te on the ren'yōkei" names a printing
         convention, not something on the page, so the only way to know what
         it does is to see the reading change — which the note does in
         advance, on the first line of the 學而 sample (習ひ → 習ひて).

         **Each of those two says it in a parenthesis on its own row**, not
         in a paragraph under it. The paragraphs were 2 lines each and the
         sidebar overflowed a laptop screen; the parenthesis keeps the part a
         reader acts on — what goes, what the reading becomes — and the full
         sentence moves into the accessible description with the other two.
         The note is aria-hidden so that it is not read twice, once as part
         of the label's name and again as the description.

         No title attributes on any of them: a native tooltip drew over the
         switches below the one under the pointer. -->
    <fieldset class="display-toggles">
      <legend data-i18n="sidebar.displayHeading"></legend>
      <label><input type="checkbox" id="show-furigana" data-i18n-attr="aria-description:sidebar.showFuriganaHint" /><span data-i18n-html="sidebar.showFurigana"></span></label>
      <label><input type="checkbox" id="show-okurigana" data-i18n-attr="aria-description:sidebar.showOkuriganaHint" /><span data-i18n-html="sidebar.showOkurigana"></span></label>
      <label class="toggle-wide"><input type="checkbox" id="show-kunten" data-i18n-attr="aria-description:sidebar.showKuntenHint" /><span data-i18n-html="sidebar.showKunten"></span><span class="toggle-note" aria-hidden="true" data-i18n-html="sidebar.showKuntenNote"></span></label>
      <label class="toggle-wide"><input type="checkbox" id="renyou-te" data-i18n-attr="aria-description:sidebar.showRenyouTeHint" /><span data-i18n-html="sidebar.showRenyouTe"></span><span class="toggle-note" aria-hidden="true" data-i18n-html="sidebar.showRenyouTeNote"></span></label>
    </fieldset>

    <!-- The two things done *with* the text on screen, side by side: send it
         somewhere, or keep it here. Save came over from the saved panel,
         which is a drawer now and shut most of the time. Both appear with
         the first text and not before. -->
    <div class="button-row output-row" hidden>
    <select id="export-select" class="export-select" data-i18n-attr="aria-label:sidebar.exportButton" aria-describedby="export-note" disabled>
      <!-- What the closed control reads, and nothing more: hidden keeps it
           out of the list that opens, and disabled keeps a keyboard walking
           the options from landing on it. Setting the value back to it in
           script still works — that restriction is on the reader, not on
           the page. -->
      <option value="" data-i18n="sidebar.exportButton" hidden disabled></option>
      <!-- Each entry says what it makes, in the entry itself: the menu is the
           platform's, so a line of text in the list is the one description
           every reader sees. The closed control still reads only "Export…",
           so the longer entries cost the sidebar no width.

           The rest — that a CoNLL-U file reopens here, that the PDF goes
           through the print dialog, that the LaTeX is LuaLaTeX — was a title
           on each, and is now an accessible description instead. A tooltip
           opened over the menu's own next entry, and showed in some browsers
           and not others; and what a sighted reader most needs of it, that
           the PDF leaves out what is switched off, is said on the page by
           the note under this row (describeOmissions, below), at the moment it is
           true rather than on hover. -->
      <option value="conllu" data-i18n="sidebar.exportConllu" data-i18n-attr="aria-description:sidebar.exportConlluHint"></option>
      <option value="pdf" data-i18n="sidebar.exportPdf" data-i18n-attr="aria-description:sidebar.exportPdfHint"></option>
      <option value="tex" data-i18n="sidebar.exportTex" data-i18n-attr="aria-description:sidebar.exportTexHint"></option>
    </select>
    <button id="save-btn" type="button" class="secondary" data-i18n="sidebar.saveButton" disabled></button>
    </div>
    <!-- What the PDF will leave out, written by describeOmissions below
         and shown only while something is. -->
    <p class="field-hint export-note" id="export-note" hidden></p>

    </div>

    <div class="sidebar-foot">
      <p class="status-line" id="status-line" data-state="idle"></p>
      <div class="sidebar-footer-actions">
        <button id="about-btn" type="button" class="quiet" data-i18n="about.button"></button>
        <button id="help-btn" type="button" class="quiet" data-i18n="help.button"></button>
      </div>
    </div>
  `;
  applyTranslations(container);

  setupDisplayToggles(container);
  setupRenyouTeToggle(container, callbacks.onRenyouTeChange);
  watchOverflow(container);

  const textarea = container.querySelector<HTMLTextAreaElement>("#kundoku-input")!;
  const parseBtn = container.querySelector<HTMLButtonElement>("#parse-btn")!;
  const uploadBtn = container.querySelector<HTMLButtonElement>("#upload-btn")!;
  const fileInput = container.querySelector<HTMLInputElement>("#conllu-input")!;
  const status = createStatusLine(container.querySelector<HTMLElement>("#status-line")!);
  const langToggle = container.querySelector<HTMLButtonElement>("#lang-toggle")!;
  const clearBtn = container.querySelector<HTMLButtonElement>("#clear-btn")!;
  const exportSelect = container.querySelector<HTMLSelectElement>("#export-select")!;
  const saveBtn = container.querySelector<HTMLButtonElement>("#save-btn")!;
  const outputRow = container.querySelector<HTMLElement>(".output-row")!;
  const exportNote = container.querySelector<HTMLElement>("#export-note")!;
  saveBtn.addEventListener("click", () => callbacks.onSave());

  let currentTree: TokenTree | null = null;

  /** Rewrites the note under Export from what is hidden now — see
   * `describeOmissions`. Shown only with a text on screen, since the note is
   * about a PDF of it, and with Export itself gone there is nothing for it to
   * qualify. */
  function updateExportNote(): void {
    const note = currentTree ? describeOmissions() : "";
    exportNote.hidden = !note;
    // Only on a change: `#app` takes classes for every panel animation, and
    // rewriting the same markup each time would be layout work for nothing.
    if (exportNote.innerHTML !== note) exportNote.innerHTML = note;
  }
  // **Watched, not told.** Four controls decide what is hidden and only three
  // of them are in this panel: the 書き下し文 rail is `main.ts`'s, and it
  // restores its state from storage on its own. Every one of them leaves its
  // answer as a class — on `<body>` for the switches, on `#app` for the rail
  // — and the print layout reads those same classes, so watching them is
  // watching exactly what the PDF will do, by whatever route it changed.
  const classWatch = new MutationObserver(updateExportNote);
  classWatch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const app = document.querySelector("#app");
  if (app) classWatch.observe(app, { attributes: true, attributeFilter: ["class"] });
  onLangChange(updateExportNote);

  /** What to call a downloaded file: the text's own title, which is what the
   * saved list calls it too, so a file and its entry answer to the same
   * name.
   *
   * Stripped of the characters a file name may not carry — the reserved
   * ASCII punctuation, and the control range — and of the ellipsis `titleOf`
   * adds when it truncates, which is a display convention and not part of
   * the text. Everything else stays: a Literary Chinese title is Han
   * characters and full-width punctuation, all of which every current
   * filesystem takes. Falls back to the app's own name where a title would
   * come out empty, which is anything untitled or written entirely in
   * reserved characters. */
  function fileNameFor(extension: string): string {
    const stem = titleOf(textarea.value)
      .replace(/…$/, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
      .trim();
    return `${stem || "kundoku"}.${extension}`;
  }

  function download(name: string, contents: string): void {
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** The export menu is a real `<select>`, which is the whole point of it.
   *
   * It began as a button opening a list of its own, and that list has to be
   * put *somewhere*: laid under the button it was clipped by the sidebar's
   * own scrolling, and fixed to the viewport it flipped above the button and
   * covered the Show switches, which reads as those switches changing rather
   * than as a menu opening. A native dropdown is drawn by the browser
   * outside the page entirely — nothing can clip it, it lands where the
   * platform puts its menus, and it is obviously a menu.
   *
   * Choosing is the act, so the choice is not kept: the value goes straight
   * back to the placeholder and the control reads "Export…" again, ready for
   * the next one. There is no state here to show — these are three things to
   * do, not three settings one of which is current. */
  exportSelect.addEventListener("change", () => {
    const kind = exportSelect.value;
    exportSelect.value = "";
    if (!kind || !currentTree) return;
    if (kind === "conllu") {
      download(fileNameFor("conllu"), exportConllu(currentTree));
      return;
    }
    if (kind === "pdf") {
      // The browser's own print pipeline, driven by the `@media print` rules
      // in print.css — "Save as PDF" is a destination in that dialog on
      // every major platform. Nothing here can write a PDF directly: no
      // browser lets a page save one without the user confirming through
      // this dialog.
      window.print();
      return;
    }
    // Read off the rendered panel rather than rebuilt from the tree: what is
    // on the screen has been through the reading order, the readings and any
    // hand edits, and the annotation format is exactly what the LaTeX body
    // is (see `generateAnnotationText`).
    const view = document.querySelector("#kundoku-view");
    if (!view) return;
    download(fileNameFor("tex"), generateKanbunTex(generateAnnotationText(scrapeAnnotationTokens(view))));
  });

  clearBtn.addEventListener("click", () => {
    const previousText = textarea.value;
    textarea.value = "";
    textarea.focus();
    callbacks.onClear(previousText);
  });

  // Typing into the box after a Clear is a new start, and the Undo beside
  // "Cleared" would now put the old text back over it — so the offer is
  // withdrawn the moment the box is written in. The same holds for the offer
  // to restore a passage that opening a document wrote over (see `showSource`
  // in `main.ts`): once the reader is writing in the box again, putting the old
  // passage back would overwrite what they have just typed.
  textarea.addEventListener("input", () => {
    if (status.shows("status.cleared") || status.shows("status.draftReplaced")) status.set(null);
  });

  parseBtn.addEventListener("click", () => {
    const text = textarea.value.trim();
    if (!text) {
      status.set("error.emptyInput", { state: "error" });
      return;
    }
    callbacks.onParseText(text);
  });

  // The samples take the upload's route and are disabled alongside it —
  // `setParsing` covers `uploadBtn` and these together, since a click on any
  // of them replaces the document, and a parse already in flight owns the
  // page until it is superseded deliberately.
  const sampleBtns = SAMPLE_TEXTS.map((sample) => {
    const btn = container.querySelector<HTMLButtonElement>(`#${sample.id}`)!;
    btn.addEventListener("click", () => callbacks.onLoadSample(sample.path));
    return btn;
  });

  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    callbacks.onUploadConllu(text);
    fileInput.value = "";
  });

  // Never disabled: the guide explains the editing gestures using its own
  // live examples, so it is just as useful before anything has been parsed.
  container.querySelector<HTMLButtonElement>("#help-btn")!.addEventListener("click", openHelpModal);
  container.querySelector<HTMLButtonElement>("#about-btn")!.addEventListener("click", openAboutModal);

  langToggle.addEventListener("click", () => {
    // Only flips the language; `main.ts` re-applies translations across the
    // whole document in response (the panel headings are outside this
    // sidebar, so re-translating `container` alone would leave them stale).
    setUiLang(getUiLang() === "en" ? "ja" : "en");
  });

  return {
    root: container,
    setStatus: status.set,
    setParsing(busy) {
      parseBtn.disabled = busy;
      uploadBtn.disabled = busy;
      for (const btn of sampleBtns) btn.disabled = busy;
    },
    setTree(tree) {
      currentTree = tree;
      // Gone rather than greyed: there is nothing to export until something
      // has been annotated, and a control that cannot be used is one more
      // thing to read past on the way to the ones that can. It returns the
      // moment there is a text to export.
      outputRow.hidden = !tree;
      exportSelect.disabled = !tree;
      saveBtn.disabled = !tree;
      exportSelect.value = "";
      updateExportNote();
    },
    /** Replaces the input box's contents, e.g. when a saved text is
     * reopened from the other panel. */
    setSourceText: (text: string) => void (textarea.value = text),
    getSourceText: () => textarea.value,
  };
}
