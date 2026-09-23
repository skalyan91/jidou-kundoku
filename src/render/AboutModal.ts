import { applyTranslations, getUiLang, onLangChange, setUiLang } from "../i18n/i18n.ts";

/** Background and acknowledgements, as a FAQ — a small, static counterpart to
 * `HelpModal.ts`'s tutorial. Where that dialog is built from live figures cut
 * from the app's own rendering, this one is a fixed list of questions and
 * answers (see `SECTIONS`); it shares that dialog's header chrome
 * (`.help-header`, `.help-lang`, `.help-close` in app.css) so the two read as
 * one family, but owns no state beyond what one small dialog needs.
 *
 * Raised because a reader asked, in these words: the interface was designed
 * with an LLM's help, but nothing at *reading time* is an LLM — the parse
 * comes from a dependency parser trained on a hand-annotated treebank, and
 * the kundoku from a rule system, both fixed before the page ever loads. */

let dialog: HTMLDialogElement | null = null;
let stopLangWatch: (() => void) | null = null;

/** One question, in the order the dialog asks it — **what the tool is for and
 * how far to trust it first**, since a reader who has just met a draft full of
 * marks wants that before anything else: what it produces and what is left to
 * them (`purpose`), **which of the many kundoku conventions it is reading in**
 * (`variation`), how much of the analysis it gets right and what correcting it
 * involves (`accuracy`), and the genre it was not built for (`wakan`).
 *
 * **`variation` is there because a reader asked for it in as many words**: a
 * tool that does not say which tradition it reads in cannot be used with
 * confidence by anyone who knows there are several. It names the convention
 * aimed at, the two places this app departs from the source it measures
 * against (the kana and the graphs), the schools it is *not* reproducing, and
 * what the reader is left to settle.
 * Then the broad claims about the tool (was any of this AI-written, does it
 * run one), then the provenance chain a specific claim invites ("what parser,
 * whose treebank, whose readings"), then what it is not for — a printed
 * edition's replacement, and a way past the reading students are there to
 * learn — then whether it phones home, and the source code last as the place
 * a satisfied "how does this actually work" lands.
 *
 * **`accuracy` names a figure and `purpose` names the exports**, which are the
 * two things a reader has had to be told by e-mail until now. Neither repeats
 * `HelpModal.ts`: that dialog shows the four editing gestures with figures cut
 * from the app's own rendering, and this one says why a reader would reach for
 * them and points at the button.
 *
 * Each id names both an `about.faq.<id>.q` and an `about.faq.<id>.a` key —
 * one lookup rather than two spellings of the same id to keep in step, the
 * same discipline `help.step.*` already keeps between its `.title`/`.body`
 * pair. Answers carry their own `<a>` markup (see `en.json`/`ja.json`): a
 * resource named in an answer is linked from inside that answer, not
 * collected into a reading list at the foot of the dialog — a reader asking
 * "where do the readings come from" wants the link right there, not a
 * citation number to go and resolve. */
const SECTIONS = [
  { id: "purpose", ids: ["purpose", "variation", "accuracy", "wakan"] },
  { id: "howItWorks", ids: ["aiHelp", "llm", "rules", "readings", "kakikudashi"] },
  { id: "usingIt", ids: ["replace", "students", "privacy", "source"] },
] as const;


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
  // One `<section>` per group, each headed by its own `<h3>` and holding a
  // `<dl>` of its questions — rather than one long list, which is what this
  // dialog was before it had thirteen questions in it and no way to see that
  // the first four answer "what is this", the next five "how does it work"
  // and the last four "what should I know before using it". A reader who
  // arrives with one of those three questions can now find its neighbourhood
  // without reading the other two.
  const sections = SECTIONS.map(({ id, ids }) => {
    const section = document.createElement("section");
    section.className = "about-section";
    const heading = document.createElement("h3");
    heading.dataset.i18n = `about.section.${id}`;
    const body = document.createElement("dl");
    body.className = "about-faq";
    for (const faqId of ids) {
      const q = document.createElement("dt");
      q.dataset.i18n = `about.faq.${faqId}.q`;
      const a = document.createElement("dd");
      a.dataset.i18nHtml = `about.faq.${faqId}.a`;
      body.append(q, a);
    }
    section.append(heading, body);
    return section;
  });

  el.append(header, ...sections);
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
