import { applyTranslations, getUiLang, setUiLang, t } from "../i18n/i18n.ts";
import type { TokenTree } from "../parse/types.ts";
import { exportConllu } from "../parse/conlluExporter.ts";
import { openHelpModal } from "./HelpModal.ts";

export interface SidebarCallbacks {
  onParseText: (text: string) => void;
  onUploadConllu: (fileText: string) => void;
}

export interface SidebarHandle {
  root: HTMLElement;
  setStatus: (message: string, state?: "idle" | "busy" | "error") => void;
  setParsing: (busy: boolean) => void;
  /** Enables the export/print/save buttons against this tree, or disables
   * them (pass null) — e.g. while a new parse is in flight. */
  setTree: (tree: TokenTree | null) => void;
  sourceText: () => string;
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
      apply();
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
    <button id="parse-btn" type="button" data-i18n="sidebar.parseButton"></button>

    <div class="divider" data-i18n="sidebar.orDivider"></div>

    <label data-i18n="sidebar.uploadLabel" for="conllu-input"></label>
    <button id="upload-btn" type="button" class="secondary" data-i18n="sidebar.uploadButton"></button>
    <input id="conllu-input" type="file" accept=".conllu,.conll,text/plain" class="visually-hidden" />
    <p class="upload-hint" data-i18n="sidebar.uploadHint"></p>

    <button id="download-conllu-btn" type="button" class="secondary" data-i18n="sidebar.downloadConlluButton" disabled></button>
    <button id="print-btn" type="button" class="secondary" data-i18n="sidebar.printButton" disabled></button>
    <button id="help-btn" type="button" class="secondary" data-i18n="help.button"></button>

    <fieldset class="display-toggles">
      <legend data-i18n="sidebar.displayHeading"></legend>
      <label><input type="checkbox" id="show-furigana" /><span data-i18n-html="sidebar.showFurigana"></span></label>
      <label><input type="checkbox" id="show-okurigana" /><span data-i18n-html="sidebar.showOkurigana"></span></label>
      <label><input type="checkbox" id="show-kunten" /><span data-i18n-html="sidebar.showKunten"></span></label>
    </fieldset>

    <p class="status-line" id="status-line" data-state="idle"></p>

    <button id="lang-toggle" type="button" class="secondary lang-toggle" data-i18n="sidebar.languageToggle"></button>
  `;
  applyTranslations(container);

  setupDisplayToggles(container);

  const textarea = container.querySelector<HTMLTextAreaElement>("#kundoku-input")!;
  const parseBtn = container.querySelector<HTMLButtonElement>("#parse-btn")!;
  const uploadBtn = container.querySelector<HTMLButtonElement>("#upload-btn")!;
  const fileInput = container.querySelector<HTMLInputElement>("#conllu-input")!;
  const downloadBtn = container.querySelector<HTMLButtonElement>("#download-conllu-btn")!;
  const statusLine = container.querySelector<HTMLElement>("#status-line")!;
  const langToggle = container.querySelector<HTMLButtonElement>("#lang-toggle")!;
  const printBtn = container.querySelector<HTMLButtonElement>("#print-btn")!;

  let currentTree: TokenTree | null = null;
  downloadBtn.addEventListener("click", () => {
    if (!currentTree) return;
    const blob = new Blob([exportConllu(currentTree)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kundoku.conllu";
    a.click();
    URL.revokeObjectURL(url);
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

  // The browser's own print pipeline, driven by the `@media print` rules in
  // print.css — "Save as PDF" is a destination in that dialog on every
  // major platform. Nothing here can write a PDF directly: no browser lets
  // a page save one without the user confirming through this dialog.
  printBtn.addEventListener("click", () => window.print());

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
      downloadBtn.disabled = !tree;
      printBtn.disabled = !tree;
    },
    /** The current contents of the input box — the saved-texts panel keeps
     * it alongside a saved tree so reopening can restore the input too. */
    sourceText: () => textarea.value.trim(),
    /** Replaces the input box's contents, e.g. when a saved text is
     * reopened from the other panel. */
    setSourceText: (text: string) => void (textarea.value = text),
  };
}
