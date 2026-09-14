import { applyTranslations, getUiLang, onLangChange, setUiLang } from "../i18n/i18n.ts";

/** Background and acknowledgements, as a FAQ — a small, static counterpart to
 * `HelpModal.ts`'s tutorial. Where that dialog is built from live figures cut
 * from the app's own rendering, this one is a fixed list of questions and
 * answers (see `FAQ_IDS`); it shares that dialog's header chrome
 * (`.help-header`, `.help-lang`, `.help-close` in app.css) so the two read as
 * one family, but owns no state beyond what one small dialog needs.
 *
 * Raised because a reader asked, in these words: the interface was designed
 * with an LLM's help, but nothing at *reading time* is an LLM — the parse
 * comes from a dependency parser trained on a hand-annotated treebank, and
 * the kundoku from a rule system, both fixed before the page ever loads. */

let dialog: HTMLDialogElement | null = null;
let stopLangWatch: (() => void) | null = null;

/** One question, in the order the dialog asks it — broad claims about the
 * tool first (was any of this AI-written, does it run one), then the
 * provenance chain a specific claim invites ("what parser, whose treebank,
 * whose readings"), then the two questions any offline tool gets asked
 * ("does it replace the real thing", "does it phone home"), source code
 * last as the place a satisfied "how does this actually work" lands.
 *
 * Each id names both an `about.faq.<id>.q` and an `about.faq.<id>.a` key —
 * one lookup rather than two spellings of the same id to keep in step, the
 * same discipline `help.step.*` already keeps between its `.title`/`.body`
 * pair. Answers carry their own `<a>` markup (see `en.json`/`ja.json`): a
 * resource named in an answer is linked from inside that answer, not
 * collected into a reading list at the foot of the dialog — a reader asking
 * "where do the readings come from" wants the link right there, not a
 * citation number to go and resolve. */
const FAQ_IDS = ["aiHelp", "llm", "rules", "readings", "kakikudashi", "replace", "privacy", "source"] as const;

/** Closes `el` on a click outside its own box.
 *
 * Duplicated from `HelpModal.ts` rather than shared: two dialogs are not
 * enough call sites to justify a cross-module dependency on a file whose
 * every other line is tuned to the tutorial's figures, and this is the whole
 * of what would be shared. If a third modal joins these two, that is the
 * time to pull it out.
 *
 * The backdrop is not an element of its own, so there is nothing to listen
 * on: a click there arrives at the `<dialog>` itself, and so does a click in
 * the dialog's own padding — testing the target alone would dismiss the
 * dialog on a click at its margin, which is plainly still *on* it. Hence the
 * geometry: outside the box is the backdrop, and nothing else is.
 *
 * `detail` guards the keyboard, which reports a click at (0, 0) — a corner
 * outside the dialog, so activating the close button with Enter would
 * otherwise read as a stray backdrop click and close the dialog a second
 * time (harmlessly, since it is already closing, but the guard costs
 * nothing and removes the question). */
function closeOnBackdropClick(el: HTMLDialogElement): void {
  el.addEventListener("click", (event) => {
    if (event.detail === 0) return;
    if (!el.open || !el.isConnected) return;
    const box = el.getBoundingClientRect();
    const inside =
      event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) el.close();
  });
}

function build(): HTMLDialogElement {
  const el = document.createElement("dialog");
  el.className = "about-modal";
  el.setAttribute("aria-labelledby", "about-title");
  closeOnBackdropClick(el);

  const header = document.createElement("header");
  header.className = "help-header";
  const title = document.createElement("h2");
  title.id = "about-title";
  title.dataset.i18n = "about.title";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "help-close";
  close.textContent = "×";
  close.dataset.i18nAttr = "aria-label:help.close;title:help.close";
  close.addEventListener("click", () => el.close());

  // The same per-dialog language switch `HelpModal.ts` carries, and for the
  // same reason: `showModal` makes everything outside this dialog inert, so
  // the sidebar's own toggle is unreachable while it is open.
  const lang = document.createElement("button");
  lang.type = "button";
  lang.className = "help-lang";
  lang.dataset.i18n = "sidebar.languageToggle";
  lang.addEventListener("click", () => setUiLang(getUiLang() === "en" ? "ja" : "en"));

  const actions = document.createElement("div");
  actions.className = "help-header-actions";
  actions.append(lang, close);
  header.append(title, actions);

  // A definition list — the semantic shape of a FAQ, a question naming what
  // each answer defines — rather than the tutorial's heading-plus-paragraph
  // pairs. `help.step.*` earns that shape because each step is one move
  // among a sequence a reader works through in order; these are independent
  // questions a reader arrives having already picked, and jumps to.
  const body = document.createElement("dl");
  body.className = "about-faq";
  for (const id of FAQ_IDS) {
    const q = document.createElement("dt");
    q.dataset.i18n = `about.faq.${id}.q`;
    const a = document.createElement("dd");
    a.dataset.i18nHtml = `about.faq.${id}.a`;
    body.append(q, a);
  }

  el.append(header, body);
  document.body.append(el);
  applyTranslations(el);
  return el;
}

/** Opens the dialog, or rebuilds it in place if the interface language
 * changes while it is up — the same pattern `openHelpModal` uses, and for
 * the same reason: a stale dialog in the wrong language is worse than a
 * moment's flicker while its replacement takes over. */
export function openAboutModal(): void {
  dialog?.remove();
  show(build());

  stopLangWatch?.();
  stopLangWatch = onLangChange(() => {
    if (!dialog?.open) return;
    const outgoing = dialog;
    show(build());
    outgoing.remove();
  });
}

function show(built: HTMLDialogElement): void {
  dialog = built;
  built.showModal();
  built.addEventListener("close", () => {
    if (dialog !== built) return;
    stopLangWatch?.();
    stopLangWatch = null;
    dialog.remove();
    dialog = null;
  });
}
