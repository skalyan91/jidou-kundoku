import { applyTranslations, getUiLang, setUiLang, t } from "../i18n/i18n.ts";
import type { TokenTree } from "../parse/types.ts";
import { exportConllu } from "../parse/conlluExporter.ts";
import { titleOf } from "../parse/savedTexts.ts";
import { generateAnnotationText, generateKanbunTex, scrapeAnnotationTokens } from "../kanbun/texAnnotation.ts";
import { openHelpModal } from "./HelpModal.ts";
import { animateAnnotationShift } from "./KundokuView.ts";
import { setRenyouTe } from "../kakikudashi/renyouTe.ts";

export interface SidebarCallbacks {
  onParseText: (text: string) => void;
  onUploadConllu: (fileText: string) => void;
  /** Puts the app back to its opening state — both panels emptied, nothing
   * to export or save. The input box is cleared here; everything else lives
   * in `main.ts`, which owns what is on screen. */
  onClear: () => void;
  /** The 連用形-て switch was flipped. Unlike the three switches above it,
   * this one changes what the panels *write* rather than what they show, so
   * neither a class on `<body>` nor a repaint can carry it: both panels have
   * to be drawn again from the tree. `main.ts` is what holds that tree, so it
   * is what does the redrawing. */
  onRenyouTeChange: () => void;
}

export interface SidebarHandle {
  root: HTMLElement;
  setStatus: (message: string, state?: "idle" | "busy" | "error") => void;
  setParsing: (busy: boolean) => void;
  /** Enables the export/print/save buttons against this tree, or disables
   * them (pass null) — e.g. while a new parse is in flight. */
  setTree: (tree: TokenTree | null) => void;
  setSourceText: (text: string) => void;
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

export function renderSidebar(container: HTMLElement, callbacks: SidebarCallbacks): SidebarHandle {
  container.innerHTML = `
    <h1 data-i18n="app.title"></h1>
    <p class="app-tagline" data-i18n="app.tagline"></p>

    <label data-i18n="sidebar.textLabel" for="kundoku-input"></label>
    <textarea id="kundoku-input" data-i18n-attr="placeholder:sidebar.textPlaceholder"></textarea>
    <div class="button-row">
      <button id="parse-btn" type="button" data-i18n="sidebar.parseButton"></button>
      <button id="clear-btn" type="button" class="secondary" data-i18n="sidebar.clearButton"></button>
    </div>

    <div class="divider" data-i18n="sidebar.orDivider"></div>

    <label data-i18n="sidebar.uploadLabel" for="conllu-input"></label>
    <button id="upload-btn" type="button" class="secondary" data-i18n="sidebar.uploadButton"></button>
    <input id="conllu-input" type="file" accept=".conllu,.conll,text/plain" class="visually-hidden" />
    <p class="upload-hint" data-i18n="sidebar.uploadHint"></p>

    <button id="help-btn" type="button" class="secondary" data-i18n="help.button"></button>

    <fieldset class="display-toggles">
      <legend data-i18n="sidebar.displayHeading"></legend>
      <label><input type="checkbox" id="show-furigana" /><span data-i18n-html="sidebar.showFurigana"></span></label>
      <label><input type="checkbox" id="show-okurigana" /><span data-i18n-html="sidebar.showOkurigana"></span></label>
      <label><input type="checkbox" id="show-kunten" /><span data-i18n-html="sidebar.showKunten"></span></label>
      <label><input type="checkbox" id="renyou-te" /><span data-i18n-html="sidebar.showRenyouTe"></span></label>
    </fieldset>

    <select id="export-select" class="export-select" data-i18n-attr="aria-label:sidebar.exportButton" hidden disabled>
      <!-- What the closed control reads, and nothing more: hidden keeps it
           out of the list that opens, and disabled keeps a keyboard walking
           the options from landing on it. Setting the value back to it in
           script still works — that restriction is on the reader, not on
           the page. -->
      <option value="" data-i18n="sidebar.exportButton" hidden disabled></option>
      <option value="conllu" data-i18n="sidebar.exportConllu"></option>
      <option value="pdf" data-i18n="sidebar.exportPdf"></option>
      <option value="tex" data-i18n="sidebar.exportTex" data-i18n-attr="title:sidebar.exportTexHint"></option>
    </select>

    <p class="status-line" id="status-line" data-state="idle"></p>

    <button id="lang-toggle" type="button" class="secondary lang-toggle" data-i18n="sidebar.languageToggle"></button>
  `;
  applyTranslations(container);

  setupDisplayToggles(container);
  setupRenyouTeToggle(container, callbacks.onRenyouTeChange);

  const textarea = container.querySelector<HTMLTextAreaElement>("#kundoku-input")!;
  const parseBtn = container.querySelector<HTMLButtonElement>("#parse-btn")!;
  const uploadBtn = container.querySelector<HTMLButtonElement>("#upload-btn")!;
  const fileInput = container.querySelector<HTMLInputElement>("#conllu-input")!;
  const statusLine = container.querySelector<HTMLElement>("#status-line")!;
  const langToggle = container.querySelector<HTMLButtonElement>("#lang-toggle")!;
  const clearBtn = container.querySelector<HTMLButtonElement>("#clear-btn")!;
  const exportSelect = container.querySelector<HTMLSelectElement>("#export-select")!;

  let currentTree: TokenTree | null = null;

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
    textarea.value = "";
    textarea.focus();
    callbacks.onClear();
  });

  parseBtn.addEventListener("click", () => {
    const text = textarea.value.trim();
    if (!text) {
      statusLine.textContent = t("error.emptyInput");
      statusLine.dataset.state = "error";
      return;
    }
    callbacks.onParseText(text);
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

  langToggle.addEventListener("click", () => {
    // Only flips the language; `main.ts` re-applies translations across the
    // whole document in response (the panel headings are outside this
    // sidebar, so re-translating `container` alone would leave them stale).
    setUiLang(getUiLang() === "en" ? "ja" : "en");
  });

  return {
    root: container,
    setStatus(message, state = "idle") {
      statusLine.textContent = message;
      statusLine.dataset.state = state;
    },
    setParsing(busy) {
      parseBtn.disabled = busy;
      uploadBtn.disabled = busy;
    },
    setTree(tree) {
      currentTree = tree;
      // Gone rather than greyed: there is nothing to export until something
      // has been annotated, and a control that cannot be used is one more
      // thing to read past on the way to the ones that can. It returns the
      // moment there is a text to export.
      exportSelect.hidden = !tree;
      exportSelect.disabled = !tree;
      exportSelect.value = "";
    },
    /** Replaces the input box's contents, e.g. when a saved text is
     * reopened from the other panel. */
    setSourceText: (text: string) => void (textarea.value = text),
  };
}
