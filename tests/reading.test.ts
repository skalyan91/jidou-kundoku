import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { findOverride } from "../src/reading/overridesLookup.ts";
import { type KanjidicIndex, lookupKanji } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex, lookupLemma } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver, unresolvedLog } from "../src/reading/readingResolver.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");

function loadRealIndex<T>(filename: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, filename), "utf-8")) as T;
}

const kanjidic = loadRealIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadRealIndex<JmdictIndex>("jmdict-index.json");

function makeToken(overrides: Partial<Token>): Token {
  return { id: 0, text: "", lemma: "", pos: "", xpos: "", dep: "", head: 0, ...overrides };
}

describe("findOverride (specificity ordering)", () => {
  it("prefers a char+dep+pos match over a char-only fallback", () => {
    const specific = findOverride("之", "PRON", "comp:obj");
    expect(specific?.reading).toBe("これ");

    const fallback = findOverride("之", "NOUN", "subj");
    expect(fallback?.reading).toBe("これ"); // char-only fallback entry
  });

  it("excludes an entry whose contextDep doesn't match, even if contextPos matches nothing better", () => {
    // 使 has a contextPos=[VERB,AUX] entry (しむ) and a bare fallback (つかう).
    const withoutContext = findOverride("使", "NOUN", "subj");
    expect(withoutContext?.reading).toBe("つかう");
  });

  it("returns null for a character with no override entry", () => {
    expect(findOverride("犬")).toBeNull();
  });
});

describe("kanjidicLookup against the real built index", () => {
  it("resolves 之 with kun'yomi これ available", () => {
    const entry = kanjidic["之"];
    expect(entry).toBeDefined();
    expect(entry.kun).toContain("これ");
  });

  it("prefers kun'yomi for a plain noun/verb", () => {
    const hit = lookupKanji(kanjidic, "有", "VERB");
    expect(hit).not.toBeNull();
    expect(hit!.reading).toBe("あ");
    expect(hit!.okurigana).toBe("る");
  });

  it("prefers on'yomi for a proper noun, converted to hiragana (every furigana reading in this app is hiragana)", () => {
    const hit = lookupKanji(kanjidic, "有", "PROPN");
    expect(hit).not.toBeNull();
    expect(hit!.reading).not.toMatch(/[ァ-ヶー]/);
    expect(hit!.reading).toMatch(/[ぁ-ゖ]/);
  });

  it("returns null for a character absent from the index", () => {
    expect(lookupKanji(kanjidic, "", "NOUN")).toBeNull();
  });
});

describe("jmdictLookup against the real built index", () => {
  it("resolves a real multi-character headword", () => {
    const hit = lookupLemma(jmdict, "君子");
    expect(hit).not.toBeNull();
    expect(hit!.reading).toBe("くんし");
  });

  it("returns null for a lemma not present as a headword", () => {
    expect(lookupLemma(jmdict, "不亦")).toBeNull();
  });

  it("findCompoundSpans groups a flat/compound run and leaves singletons out", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "不", dep: "mod", head: 2 }),
        makeToken({ id: 1, text: "亦", dep: "mod", head: 2 }),
        makeToken({ id: 2, text: "君", dep: "ROOT", head: 2 }),
        makeToken({ id: 3, text: "子", dep: "flat", head: 2 }),
      ],
    };
    const spans = findCompoundSpans(sentence);
    expect(spans).toHaveLength(1);
    expect(spans[0].tokenIds).toEqual([2, 3]);
    expect(spans[0].text).toBe("君子");
  });

  it("findCompoundSpans never groups tokens that share no compound/flat relation at all, even when adjacent", () => {
    // 遠/方 share no dependency edge in this treebank's real parses (see
    // spanCarrier.test.ts) — compound detection is driven only by relations
    // the parser assigns, never guessed from a dictionary.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "遠", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "方", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans groups a plain mod attributive modifier directly attached to its noun head", () => {
    // Adjective-noun modification keeps the resulting noun phrase intact,
    // same as a real compound — a descriptive word (often tagged VERB/ADJ
    // in this treebank, not a dedicated adjective class) modifying a noun
    // head via plain `mod` is part of that NP.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "遠", pos: "VERB", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "方", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    const spans = findCompoundSpans(sentence);
    expect(spans).toHaveLength(1);
    expect(spans[0].tokenIds).toEqual([0, 1]);
    expect(spans[0].text).toBe("遠方");
  });

  it("findCompoundSpans excludes mod@tmod/mod@lmod from NP grouping — those are clause-level adverbials, not NP-internal", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "時", pos: "NOUN", dep: "mod@tmod", head: 1 }),
        makeToken({ id: 1, text: "習", pos: "VERB", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans excludes an adverb attached to a nominal *predicate* root, even though the head is a noun", () => {
    // Real bug this regression-tests: caught live with 亦君子乎 ("is it not
    // ALSO a gentleman?") — 亦 (ADV) is a clause-level adverb over the whole
    // predicate, landing as `mod` of the nominal root 君子 only because 君子
    // *is* the predicate, not because 亦 attributively modifies the noun
    // phrase. Grouping them wrongly fused "亦君子" into one display unit.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "亦", pos: "ADV", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "君子", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans excludes a plain mod whose head isn't nominal (e.g. an adverb modifying a verb)", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "亦", pos: "ADV", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "說", pos: "VERB", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans excludes a non-adjacent mod edge even to a noun head — display fusion needs contiguous tokens", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "遠", pos: "VERB", dep: "mod", head: 2 }),
        makeToken({ id: 1, text: "之", pos: "PRON", dep: "comp:obj", head: 2 }),
        makeToken({ id: 2, text: "方", pos: "NOUN", dep: "ROOT", head: 2 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });
});

describe("createReadingResolver fallback chain", () => {
  const resolve = createReadingResolver(kanjidic, jmdict);
  const sentence: Sentence = { tokens: [] };

  it("hits the override table first", () => {
    const token = makeToken({ text: "之", pos: "PRON", dep: "comp:obj", lemma: "之" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("override");
    expect(result.reading).toBe("これ");
  });

  it("falls back to kanjidic when there's no override", () => {
    const token = makeToken({ text: "習", pos: "VERB", dep: "conj:coord", lemma: "習" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("kanjidic");
    expect(result.reading.length).toBeGreaterThan(0);
  });

  it("falls back to jmdict for a flat-span member absent from kanjidic-by-itself logic", () => {
    // 子, as a flat continuation of 君子, should still resolve via kanjidic
    // (single-char lookup) before jmdict is even tried, since kanjidic has
    // an entry for 子 itself — so instead exercise the jmdict path directly
    // with a lemma-bearing token whose character isn't in kanjidic at all.
    const token = makeToken({ text: "", pos: "NOUN", dep: "flat", lemma: "君子" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("jmdict");
    expect(result.reading).toBe("くんし");
  });

  it("logs and returns unresolved for a token with no data anywhere", () => {
    unresolvedLog.clear();
    const token = makeToken({ text: "", pos: "NOUN", dep: "obj", lemma: "" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("unresolved");
    expect(result.reading).toBe("");
    expect(unresolvedLog.size).toBe(1);
  });
});
