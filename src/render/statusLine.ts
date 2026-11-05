import { onLangChange, t, type StringKey } from "../i18n/i18n.ts";

/** One line of status under a panel, and the one thing either panel says
 * back to the reader.
 *
 * Shared by the input sidebar and the saved panel so that both speak the
 * same way, and so that three things each of them needed are written once:
 *
 * **It is given a key, not a string.** A status is translated when it is
 * shown *and again whenever the language changes*: the line remembers what
 * it was asked to say and re-says it in the other language. A string handed
 * in already translated could not be, which is how a "Saved" outlived a
 * switch to Japanese.
 *
 * **It can carry one action.** "Cleared" and "Deleted" are the two messages
 * that report something the reader may not have meant, and each comes with
 * the button that takes it back. The action lives exactly as long as the
 * message does: the next status replaces both, so an Undo is never left
 * standing beside a page that has moved on to something it no longer
 * describes.
 *
 * **It is a live region.** `role="status"` is polite, so a screen reader
 * reads each new message once the reader has finished what they were doing,
 * rather than interrupting them. The element is the same `<p>` the two
 * panels already had; only its contents are managed here. */

export type StatusState = "idle" | "busy" | "error";

export interface StatusAction {
  label: StringKey;
  run: () => void;
}

export interface StatusOptions {
  state?: StatusState;
  action?: StatusAction;
  /** Values for `{name}` placeholders in the message — a saved text's title,
   * which is the reader's own text and the same in either language. */
  vars?: Record<string, string>;
}

export interface StatusLine {
  /** Shows `key`, or empties the line when `key` is null. */
  set: (key: StringKey | null, options?: StatusOptions) => void;
  /** Whether the line is showing `key` right now — for a caller that wants
   * to take down its own message without taking down someone else's. */
  shows: (key: StringKey) => boolean;
}

function fill(message: string, vars?: Record<string, string>): string {
  if (!vars) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

export function createStatusLine(el: HTMLElement): StatusLine {
  el.setAttribute("role", "status");
  let current: { key: StringKey; options: StatusOptions } | null = null;

  function render(): void {
    el.replaceChildren();
    el.dataset.state = current?.options.state ?? "idle";
    if (!current) return;
    const { key, options } = current;
    el.append(fill(t(key), options.vars));
    if (options.action) {
      const { label, run } = options.action;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "status-action";
      button.textContent = t(label);
      button.addEventListener("click", () => {
        // Cleared before it runs, so an action that sets a status of its own
        // ("Ready", once a text is back) is the one left standing.
        set(null);
        run();
      });
      // No space character before it: Japanese sets none between a sentence
      // and what follows, and English needs one. The gap is the button's own
      // margin instead, which is the same in either language.
      el.append(button);
    }
  }

  function set(key: StringKey | null, options: StatusOptions = {}): void {
    current = key ? { key, options } : null;
    render();
  }

  onLangChange(render);
  return { set, shows: (key) => current?.key === key };
}
