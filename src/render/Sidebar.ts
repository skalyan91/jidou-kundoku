import { applyTranslations, getUiLang, setUiLang, t } from "../i18n/i18n.ts";
import type { TokenTree } from "../parse/types.ts";
import { exportConllu } from "../parse/conlluExporter.ts";
import { titleOf } from "../parse/savedTexts.ts";
import { generateAnnotationText, generateKanbunTex, scrapeAnnotationTokens } from "../kanbun/texAnnotation.ts";
import { openHelpModal } from "./HelpModal.ts";
import { animateAnnotationShift } from "./KundokuView.ts";

export interface SidebarCallbacks {
  onParseText: (text: string) => void;
  onUploadConllu: (fileText: string) => void;
  /** Puts the app back to its opening state — both panels emptied, nothing
   * to export or save. The input box is cleared here; everything else lives
   * in `main.ts`, which owns what is on screen. */
  onClear: () => void;
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
    </fieldset>

    <div class="export-menu">
      <button id="export-btn" type="button" class="secondary" data-i18n="sidebar.exportButton"
              aria-haspopup="true" aria-expanded="false" aria-controls="export-options" disabled></button>
      <ul class="export-options" id="export-options" hidden>
        <li><button type="button" data-export="conllu" data-i18n="sidebar.exportConllu"></button></li>
        <li><button type="button" data-export="pdf" data-i18n="sidebar.exportPdf"></button></li>
        <li><button type="button" data-export="tex" data-i18n="sidebar.exportTex"
                    data-i18n-attr="title:sidebar.exportTexHint"></button></li>
      </ul>
    </div>

    <p class="status-line" id="status-line" data-state="idle"></p>

    <button id="lang-toggle" type="button" class="secondary lang-toggle" data-i18n="sidebar.languageToggle"></button>
  `;
  applyTranslations(container);

  setupDisplayToggles(container);

  const textarea = container.querySelector<HTMLTextAreaElement>("#kundoku-input")!;
  const parseBtn = container.querySelector<HTMLButtonElement>("#parse-btn")!;
  const uploadBtn = container.querySelector<HTMLButtonElement>("#upload-btn")!;
  const fileInput = container.querySelector<HTMLInputElement>("#conllu-input")!;
  const statusLine = container.querySelector<HTMLElement>("#status-line")!;
  const langToggle = container.querySelector<HTMLButtonElement>("#lang-toggle")!;
  const clearBtn = container.querySelector<HTMLButtonElement>("#clear-btn")!;
  const exportBtn = container.querySelector<HTMLButtonElement>("#export-btn")!;
  const exportOptions = container.querySelector<HTMLElement>("#export-options")!;

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

  function closeExportMenu(): void {
    exportOptions.hidden = true;
    exportBtn.setAttribute("aria-expanded", "false");
  }

  /** Puts the menu where it can actually be seen.
   *
   * It is fixed to the viewport rather than laid under the button, because
   * the sidebar scrolls and would otherwise clip it — see `.export-options`
   * in app.css. Which leaves the placing to be done here: as wide as the
   * button and aligned with it, below if there is room and above if there
   * isn't, and never past either edge of the window. */
  function openExportMenu(): void {
    exportOptions.hidden = false;
    exportBtn.setAttribute("aria-expanded", "true");
    const anchor = exportBtn.getBoundingClientRect();
    const gap = 4;
    exportOptions.style.left = `${anchor.left}px`;
    exportOptions.style.width = `${anchor.width}px`;
    // Measured after it is shown and given its width: its height depends on
    // that width, and a hidden element measures zero.
    const height = exportOptions.getBoundingClientRect().height;
    const below = anchor.bottom + gap;
    exportOptions.style.top =
      below + height <= window.innerHeight ? `${below}px` : `${Math.max(gap, anchor.top - gap - height)}px`;
  }

  exportBtn.addEventListener("click", () => {
    if (exportOptions.hidden) openExportMenu();
    else closeExportMenu();
  });

  // Fixed to the viewport, it does not travel with the panel it belongs to,
  // so a scroll would leave it pointing at nothing. Capture, since the
  // sidebar scrolls itself and that does not bubble.
  window.addEventListener("scroll", () => !exportOptions.hidden && closeExportMenu(), true);
  window.addEventListener("resize", () => !exportOptions.hidden && closeExportMenu());

  // Anywhere else puts it away, the same as any other menu in this app.
  document.addEventListener("pointerdown", (event) => {
    if (exportOptions.hidden) return;
    if (!(event.target as HTMLElement).closest(".export-menu")) closeExportMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !exportOptions.hidden) closeExportMenu();
  });

  exportOptions.addEventListener("click", (event) => {
    const kind = (event.target as HTMLElement).closest<HTMLElement>("[data-export]")?.dataset.export;
    if (!kind || !currentTree) return;
    closeExportMenu();
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
      exportBtn.disabled = !tree;
      if (!tree) closeExportMenu();
    },
    /** The current contents of the input box — the saved-texts panel keeps
     * it alongside a saved tree so reopening can restore the input too. */
    sourceText: () => textarea.value.trim(),
    /** Replaces the input box's contents, e.g. when a saved text is
     * reopened from the other panel. */
    setSourceText: (text: string) => void (textarea.value = text),
  };
}
