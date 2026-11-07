import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEPREL_INVENTORY, MENU_HEADINGS, uposJa } from "../src/render/tokenInspector.ts";
import { XPOS_INVENTORY, domainsUnder, parseXpos, xposPrefixes } from "../src/parse/xpos.ts";
import {
  EMPTY_FIELD_GLOSS,
  SUBTYPE_GLOSS,
  deprelGloss,
  domainGloss,
  headingGloss,
  senseGloss,
  wordGloss,
  READING_ACTION_GLOSS,
} from "../src/i18n/analysisGlosses.ts";

/** The English interface glosses every analysis term it draws in Japanese —
 * the relation names, the menu headings, and the treebank's category names
 * the three 品詞 menus offer. These tests walk the inventories rather than a
 * hand-picked list, so a term the treebank or the relation menu gains without
 * a gloss fails here instead of reaching an English reader bare. */

/** A gloss is English: something to read, with no Japanese left in it. */
function isEnglishGloss(gloss: string | undefined): boolean {
  return typeof gloss === "string" && gloss.trim() !== "" && !/[　-鿿]/.test(gloss);
}

describe("glosses for the 品詞 menus", () => {
  it("gloss every 品詞, domain and sense in the treebank inventory, under its parent", () => {
    const missing: string[] = [];
    for (const xpos of XPOS_INVENTORY) {
      const parts = parseXpos(xpos)!;
      if (!isEnglishGloss(wordGloss(parts.word))) missing.push(`品詞 ${parts.word}`);
      if (parts.domain !== "*" && !isEnglishGloss(domainGloss(parts.word, parts.domain))) {
        missing.push(`domain ${parts.word}・${parts.domain}`);
      }
      if (!isEnglishGloss(senseGloss(parts.word, parts.domain, parts.sense))) {
        missing.push(`sense ${parts.word}・${parts.domain}・${parts.sense}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("gloss the sense menu's 「なし」 row as none", () => {
    expect(senseGloss("名詞", "思考", "*")).toBe(EMPTY_FIELD_GLOSS);
    expect(EMPTY_FIELD_GLOSS).toBe("none");
  });

  it("gloss a name by its parent where the treebank reuses it", () => {
    // 関係 is three different things under three parents.
    expect(domainGloss("前置詞", "関係")).toBe("relation");
    expect(senseGloss("名詞", "人", "関係")).toBe("kinship term");
    expect(senseGloss("名詞", "固定物", "関係")).toBe("relative position");
  });

  it("gloss every UPOS name the first chip can fall back to", () => {
    const tags = ["NOUN", "PROPN", "PRON", "VERB", "AUX", "ADJ", "ADV", "ADP", "CCONJ", "SCONJ", "PART", "PUNCT", "DET", "NUM", "INTJ", "SYM", "X"];
    expect(tags.filter((tag) => !isEnglishGloss(wordGloss(uposJa(tag))))).toEqual([]);
  });

  it("leave a category the treebank does not have unglossed rather than guessed", () => {
    expect(wordGloss("未知")).toBeUndefined();
    expect(domainGloss("名詞", "未知")).toBeUndefined();
    expect(senseGloss("動詞", "行為", "未知")).toBeUndefined();
  });
});

describe("glosses for the relation menu", () => {
  it("gloss every relation the menu offers, subtypes included", () => {
    expect(DEPREL_INVENTORY.filter((rel) => !isEnglishGloss(deprelGloss(rel)))).toEqual([]);
  });

  it("gloss every subtype from the table rather than falling back to the SUD name", () => {
    const subtypes = DEPREL_INVENTORY.filter((rel) => rel.includes("@")).map((rel) => rel.split("@")[1]);
    expect(subtypes.filter((subtype) => !(subtype in SUBTYPE_GLOSS))).toEqual([]);
  });

  it("compose a subtyped relation from its base and its subtype", () => {
    expect(deprelGloss("comp:obj")).toBe("object");
    expect(deprelGloss("conj:coord")).toBe("conjunct");
    expect(deprelGloss("mod@tmod")).toBe("modifier: time");
  });

  it("leave a relation it does not know unglossed", () => {
    expect(deprelGloss("nonesuch")).toBeUndefined();
  });
});

describe("glosses for the menu headings", () => {
  it("gloss every heading the app can write", () => {
    const domainNames = new Set(xposPrefixes().flatMap((prefix) => domainsUnder(prefix)));
    const glossedSomewhere = (heading: string) =>
      isEnglishGloss(headingGloss(heading)) ||
      isEnglishGloss(wordGloss(heading)) ||
      (domainNames.has(heading) &&
        xposPrefixes().some((prefix) => isEnglishGloss(domainGloss(prefix.split(",")[1], heading))));
    expect(MENU_HEADINGS.filter((heading) => !glossedSomewhere(heading))).toEqual([]);
  });
});

describe("glosses for the readings menu actions", () => {
  // 自動 and the topic は are rows of the readings menu that are actions
  // rather than readings; they are written in Japanese in both interfaces,
  // so an English reader needs a gloss on each, as on every other row.
  it("gloss 自動 and the topic particle", () => {
    expect(isEnglishGloss(READING_ACTION_GLOSS["自動"])).toBe(true);
    expect(isEnglishGloss(READING_ACTION_GLOSS["は"])).toBe(true);
  });

  it("hang each gloss on its row", () => {
    const source = readFileSync(new URL("../src/render/tokenInspector.ts", import.meta.url), "utf8");
    expect(source).toContain('item.dataset.gloss = READING_ACTION_GLOSS["自動"];');
    expect(source).toContain("item.dataset.gloss = READING_ACTION_GLOSS[TOPIC_PARTICLE];");
  });
});
