import en from "./en.json";
import ja from "./ja.json";

export type UiLang = "en" | "ja";
export type StringKey = keyof typeof en;

const DICTS: Record<UiLang, Record<string, string>> = { en, ja };
const STORAGE_KEY = "jidou-kundoku:ui-lang";

let current: UiLang = readStoredLang() ?? "en";
const listeners = new Set<(lang: UiLang) => void>();

function readStoredLang(): UiLang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "en" || v === "ja" ? v : null;
  } catch {
    return null;
  }
}

export function t(key: StringKey): string {
  return DICTS[current][key] ?? DICTS.en[key] ?? key;
}

export function getUiLang(): UiLang {
  return current;
}

export function setUiLang(lang: UiLang): void {
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // localStorage unavailable (private mode etc.); language choice just
    // won't persist across reloads.
  }
  document.documentElement.lang = lang;
  for (const listener of listeners) listener(lang);
}

export function onLangChange(listener: (lang: UiLang) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Walks the DOM under `root` applying translations to every
 * `data-i18n="key"` element (textContent), `data-i18n-html="key"` element
 * (inner markup) and `data-i18n-attr="attr:key"` element (attribute
 * value). Call again after `setUiLang` or whenever new translatable DOM is
 * inserted. */
export function applyTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as StringKey | undefined;
    if (key) el.textContent = t(key);
  });
  // A few strings carry inline markup — English prose italicises the
  // Japanese terms it uses (`<i>kakikudashibun</i>`), which plain text
  // can't express. These are this app's own translation files, authored
  // here and bundled at build time; no user input reaches them, so there
  // is nothing to sanitize against.
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml as StringKey | undefined;
    if (key) el.innerHTML = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-attr]").forEach((el) => {
    const spec = el.dataset.i18nAttr;
    if (!spec) return;
    for (const pair of spec.split(";")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key as StringKey));
    }
  });
}
