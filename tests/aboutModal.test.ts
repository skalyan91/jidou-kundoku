import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json" with { type: "json" };
import ja from "../src/i18n/ja.json" with { type: "json" };

type Dict = Record<string, string>;

/** Mirrors `AboutModal.ts`'s own `FAQ_IDS` rather than importing it: that
 * module builds DOM and can't be loaded outside a browser, and the id list
 * is short enough that keeping this copy honest is cheaper than giving the
 * module an export whose only consumer is a test. If the two drift, the
 * "every id has both keys, in both languages" test below is exactly what
 * would catch a renamed or dropped id — it fails on the id this file no
 * longer matches the module's, not silently passes. */
const SECTIONS = [
  { id: "purpose", ids: ["purpose", "variation", "accuracy", "wakan"] },
  { id: "howItWorks", ids: ["aiHelp", "llm", "rules", "readings", "kakikudashi"] },
  { id: "usingIt", ids: ["replace", "students", "privacy", "source"] },
] as const;

const FAQ_IDS = SECTIONS.flatMap((section) => section.ids);

/** Both languages of the app's UI copy, checked as a set rather than as a
 * list of keys — the general form of the parity check `sampleTexts.test.ts`
 * makes for its own buttons, run here over every key either file declares so
 * a key added to one and forgotten in the other fails loudly instead of
 * falling back to the English string mid-dialog (see `t` in i18n.ts, whose
 * `?? DICTS.en[key]` fallback is exactly what would otherwise hide this). */
describe("i18n key parity", () => {
  it("has every key of one language in the other", () => {
    const enKeys = new Set(Object.keys(en));
    const jaKeys = new Set(Object.keys(ja));
    const onlyEn = [...enKeys].filter((k) => !jaKeys.has(k));
    const onlyJa = [...jaKeys].filter((k) => !enKeys.has(k));
    expect(onlyEn, "keys in en.json but not ja.json").toEqual([]);
    expect(onlyJa, "keys in ja.json but not en.json").toEqual([]);
  });
});

describe("about modal FAQ copy", () => {
  it("has a question and an answer for every id, in both languages, non-empty", () => {
    for (const id of FAQ_IDS) {
      for (const [lang, dict] of [["en", en] as const, ["ja", ja] as const]) {
        for (const half of ["q", "a"] as const) {
          const key = `about.faq.${id}.${half}`;
          expect(dict as Dict, `${lang}.json is missing ${key}`).toHaveProperty(key);
          expect((dict as Dict)[key].length, `${lang}.${key} is empty`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("has a heading for every section, in both languages", () => {
    // The sections are what the dialog is built from (`SECTIONS` in
    // `AboutModal.ts`), so a group added there without its heading key would
    // render an empty `<h3>` above a perfectly good list of questions.
    for (const { id } of SECTIONS) {
      for (const [lang, dict] of [["en", en] as const, ["ja", ja] as const]) {
        const key = `about.section.${id}`;
        expect(dict as Dict, `${lang}.json is missing ${key}`).toHaveProperty(key);
        expect((dict as Dict)[key].length, `${lang}.${key} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("declares no about.section key outside the known section list", () => {
    const known = new Set(SECTIONS.map(({ id }) => `about.section.${id}`));
    for (const [lang, dict] of [["en", en] as const, ["ja", ja] as const]) {
      const stray = Object.keys(dict).filter((k) => k.startsWith("about.section.") && !known.has(k));
      expect(stray, `${lang}.json has about.section keys not in SECTIONS`).toEqual([]);
    }
  });

  it("declares no about.faq key outside the known id list", () => {
    // The mirror of the test above: catches an id renamed in the JSON but
    // not in `FAQ_IDS` (or vice versa) from the other direction — a key
    // present but never asked for, which the "has every id" test above
    // cannot see since it only ever looks up ids it already knows.
    const known = new Set(FAQ_IDS.flatMap((id) => [`about.faq.${id}.q`, `about.faq.${id}.a`]));
    for (const [lang, dict] of [["en", en] as const, ["ja", ja] as const]) {
      const stray = Object.keys(dict).filter((k) => k.startsWith("about.faq.") && !known.has(k));
      expect(stray, `${lang}.json has about.faq keys not in FAQ_IDS`).toEqual([]);
    }
  });

  it("names no LLM in the answer that says the tool runs without one", () => {
    // The one factual claim in this copy that a reader might come back to
    // check word for word — pinned so a future edit of the prose can't
    // soften or drop it by accident.
    expect(en["about.faq.llm.a"]).toMatch(/uses no LLM/);
    expect(ja["about.faq.llm.a"]).toMatch(/LLM を一切使っていません/);
  });

  it("balances every tag it opens, in both languages", () => {
    // `applyTranslations` writes these straight into `innerHTML` — see its
    // own comment on why that is safe for this app's own translation files —
    // but "safe to inject" is not "well-formed", and a dropped closing tag
    // would silently italicise (or link) the rest of the dialog rather than
    // erroring.
    const balanced = (tag: string, text: string) => {
      const opens = (text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g")) ?? []).length;
      const closes = (text.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
      return opens === closes;
    };
    for (const id of FAQ_IDS) {
      for (const [lang, dict] of [["en", en] as const, ["ja", ja] as const]) {
        const key = `about.faq.${id}.a`;
        const text = (dict as Dict)[key];
        expect(balanced("i", text), `${lang}.${key} has unbalanced <i> tags`).toBe(true);
        expect(balanced("a", text), `${lang}.${key} has unbalanced <a> tags`).toBe(true);
      }
    }
  });

  it("links every href as a real, secure, new-tab URL", () => {
    // Every anchor this dialog ships is app-authored (see the file-level
    // comment on why that's safe to write straight into innerHTML), which
    // cuts both ways: nothing sanitizes a typo'd href either. `https://`
    // rather than a bare domain or `http://`, and `target="_blank"` with
    // `rel="noopener noreferrer"` so a reader leaving the tool never loses
    // it and the opened page never gets a `window.opener` handle back.
    const hrefPattern = /<a href="(https:\/\/[^"]+)" target="_blank" rel="noopener noreferrer">/g;
    for (const id of FAQ_IDS) {
      for (const [lang, dict] of [["en", en] as const, ["ja", ja] as const]) {
        const key = `about.faq.${id}.a`;
        const text = (dict as Dict)[key];
        const anchorCount = (text.match(/<a /g) ?? []).length;
        const matches = [...text.matchAll(hrefPattern)];
        expect(matches.length, `${lang}.${key}: every <a> must match the expected shape`).toBe(anchorCount);
      }
    }
  });

  it("cites the same set of resources in both languages, in whichever order the sentence puts them", () => {
    // The two files describe one set of facts in two languages, and the same
    // fact belongs at a different point in the sentence in each — Japanese's
    // modifying clauses read left of their head, so `about.faq.llm.a` names
    // Kyoto University's institute before the treebank it annotated, where
    // the English names the treebank first and the institute in an
    // appositive after it. Same three links; the clause order is a fact
    // about the language, not about the claim. So this compares the *set*
    // each answer cites, not the sequence — the ordered sequence is exactly
    // what a straight equality would have wrongly failed on here.
    const hrefsOf = (text: string) => [...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const id of FAQ_IDS) {
      const enHrefs = hrefsOf(en[`about.faq.${id}.a` as keyof typeof en] as string);
      const jaHrefs = hrefsOf(ja[`about.faq.${id}.a` as keyof typeof ja] as string);
      expect(new Set(jaHrefs), `about.faq.${id}.a: ja cites different resources than en`).toEqual(new Set(enHrefs));
    }
  });
});
