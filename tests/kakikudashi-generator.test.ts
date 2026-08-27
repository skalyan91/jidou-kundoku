import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sentence, Token, TokenTree } from "../src/parse/types.ts";
import type { ReadingPlan } from "../src/kundoku/types.ts";
import type { ReadingResolver, ResolvedReading } from "../src/reading/types.ts";
import {
  endingForMorph,
  parseMorphFeatures,
  sentenceFinalParticle,
} from "../src/kakikudashi/bungoConjugation.ts";
import { generateKakikudashi, generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { dirname, join } from "node:path";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";

// ---------------------------------------------------------------------------
// bungoConjugation.ts unit tests
// ---------------------------------------------------------------------------

describe("parseMorphFeatures", () => {
  it("parses a pipe-joined Key=Val string", () => {
    expect(parseMorphFeatures("Polarity=Neg|VerbForm=Conv")).toEqual({
      Polarity: "Neg",
      VerbForm: "Conv",
    });
  });
  it("returns {} for empty/undefined input", () => {
    expect(parseMorphFeatures("")).toEqual({});
  });
});

describe("endingForMorph", () => {
  it("maps VerbForm=Conv to て", () => {
    expect(endingForMorph({ VerbForm: "Conv" })?.primary).toBe("て");
  });
  it("maps Voice=Pass to る/らる", () => {
    const f = endingForMorph({ Voice: "Pass" });
    expect(f?.primary).toBe("る");
    expect(f?.alt).toBe("らる");
  });
  it("maps VerbType=Cop to なり with a なら mizenkei variant", () => {
    const f = endingForMorph({ "VerbType": "Cop" });
    expect(f?.primary).toBe("なり");
    expect(f?.mizen).toBe("なら");
  });
  it("returns null for a feature set with no mapped ending", () => {
    expect(endingForMorph({ POS: "NOUN" })).toBeNull();
  });
});

describe("sentenceFinalParticle", () => {
  it("maps 乎 to や", () => {
    expect(sentenceFinalParticle("乎")).toBe("や");
  });
  it("returns '' for an unmapped lemma", () => {
    expect(sentenceFinalParticle("未知")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// generator.ts: synthetic test exercising the morph-driven ending pathway
// directly (a token whose lemma isn't in verbLexicon.ts, so it falls back
// to resolve()+endingForMorph rather than the lexicon's own conjugation).
// ---------------------------------------------------------------------------

describe("generateKakikudashi — morph-driven ending (lexicon-miss fallback)", () => {
  it("appends the CONVERB ending (て) when a token's morph carries VerbForm=Conv", () => {
    const tok = (over: Partial<Token>): Token => ({
      id: 0,
      text: "x",
      lemma: "x",
      pos: "VERB",
      xpos: "v",
      dep: "ROOT",
      head: 0,
      ...over,
    });
    const sentence: Sentence = {
      tokens: [tok({ id: 0, text: "行き", lemma: "xyz", morph: "VerbForm=Conv" })],
    };
    const plan: ReadingPlan = { sentence, order: [0], spliceGroups: [], quoteEndIds: new Set(), rereadCloseIds: new Map() };
    // Non-"override" source — an override-sourced reading is already a
    // complete grammatical gloss (see generator.ts's own comment on this),
    // so a morph-driven ending only ever applies on top of a real
    // kanjidic/jmdict/unresolved reading.
    const resolve: ReadingResolver = () => ({ reading: "行き", source: "kanjidic" });
    expect(generateKakikudashi(plan, resolve)).toBe("行きて");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the four Analects 1:1 seed sentences, using the REAL
// reorderEngine.ts (no hand-idealized orders — that was a stand-in while
// reorderEngine.ts didn't exist yet; it's a real, tested dependency now) and
// the real fixture data captured from the shipped lzh_sud_kyoto-0.2.0 wheel.
//
// Content words with a verbLexicon.ts entry (學/習/曰/說/樂/知/慍/有/來) are
// conjugated by the real engine, not this test's fake resolver — the fake
// resolver below only covers what's left: genuine function words (而/自)
// and plain nouns without curated lexicon/override entries (子/朋/方/人/君子).
// Expected outputs were verified end-to-end against the live app (real
// Pyodide parse -> reorderEngine -> readingResolver -> generator).
// ---------------------------------------------------------------------------

const fixturesPath = fileURLToPath(new URL("./fixtures/analects-raw-parses.json", import.meta.url));
const raw: Record<string, Token[][]> = JSON.parse(readFileSync(fixturesPath, "utf-8"));

function clauses(text: string): Sentence[] {
  return raw[text].map((tokens) => ({ tokens }));
}

const fakeResolve: ReadingResolver = (token): ResolvedReading => {
  const functionWords: Record<string, string> = { 而: "て", 自: "より", 之: "これ" };
  if (token.lemma in functionWords) {
    return { reading: functionWords[token.lemma], source: "override" };
  }
  // Plain nouns with no curated entry: kanji-retained (non-"override" source),
  // matching what a real kanjidic/jmdict/unresolved hit does in generator.ts.
  return { reading: token.text, source: "unresolved" };
};

function planFor(sentence: Sentence): ReadingPlan {
  return computeReadingOrder(sentence);
}

describe("Analects seed sentences — end to end (real reorderEngine)", () => {
  it("學而時習之，不亦說乎？", () => {
    const [clauseA, clauseB] = clauses("學而時習之，不亦說乎？");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    expect(out).toBe("學びて時にこれを習ふ、亦說ばしからずや。");
  });

  it("子曰：學而時習之。", () => {
    const [clauseA, clauseB] = clauses("子曰：學而時習之。");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    expect(out).toBe("子曰はく、學びて時にこれを習ふ。");
  });

  it("有朋自遠方來，不亦樂乎？ (real, non-idealized tree — see kundoku.test.ts note)", () => {
    const [clauseA, clauseB] = clauses("有朋自遠方來，不亦樂乎？");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    // Faithfully reflects the real (non-idealized) parse tree: 自 attaches
    // as a plain `mod` of 來 with only 遠 as its own comp:obj, while 方 is a
    // separate `mod` of 來 — see kundoku.test.ts's note on this sentence.
    expect(out).toBe("朋遠しより方來たる有り、亦樂しからずや。");
  });

  it("有朋自遠方來，不亦樂乎？ with 遠方 detected as a shared span keeps it together", () => {
    const [clauseA, clauseB] = clauses("有朋自遠方來，不亦樂乎？");
    const spans = [{ tokenIds: [3, 4], text: "遠方" }]; // see kundoku.test.ts's span-aware describe block
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const planForWithSpans = (sentence: Sentence) => computeReadingOrder(sentence, sentence === clauseA ? spans : []);
    const out = generateKakikudashiForTree(tree, planForWithSpans, fakeResolve);
    expect(out).toBe("朋遠し方より來たる有り、亦樂しからずや。");
  });

  it("人不知而不慍，不亦君子乎？", () => {
    const [clauseA, clauseB] = clauses("人不知而不慍，不亦君子乎？");
    const tree: TokenTree = { sentences: [clauseA, clauseB], source: "conllu" };
    const out = generateKakikudashiForTree(tree, planFor, fakeResolve);
    expect(out).toBe("人知らずして慍みず、亦君子ならずや。");
  });

  it("a root-triggered copula attaches after a whole compound span, not spliced between its members", () => {
    // Real bug this regression-tests: when 君子 arrives as two separate
    // tokens joined by `flat` (rather than fused into one token by the
    // tokenizer, as in the fixture above), extraEndingFor(token, root)
    // checked per-individual-token used to fire on 君 alone (token.id ===
    // root.id), splicing なり between 君 and 子 -> "君なり子" instead of
    // the whole compound reading together as "君子なり".
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 1 },
        { id: 1, text: "君", lemma: "君", pos: "NOUN", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "flat", head: 1 },
      ],
    };
    const plan = computeReadingOrder(sentence, [{ tokenIds: [1, 2], text: "君子" }]);
    const out = generateKakikudashi(plan, fakeResolve);
    expect(out).toBe("亦君子なり");
  });

  it("a compound span's shared ending picks mizenkei from what follows the *last* member, not the carrier", () => {
    // Real bug this regression-tests: selectForm's "what comes next" check
    // used the carrier's own position in reading order (君, which sits
    // *before* 子), so a following negation was invisible to it and the
    // copula stayed shuushikei (なり) instead of mizenkei (なら) — 亦君子なりずや
    // instead of the correct 亦君子ならずや.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 1, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 2 },
        { id: 2, text: "君", lemma: "君", pos: "NOUN", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "flat", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence, [{ tokenIds: [2, 3], text: "君子" }]);
    const out = generateKakikudashi(plan, fakeResolve);
    expect(out).toBe("亦君子ならず");
  });

  it("子曰習之 — 曰 doesn't reorder its quote, and the quote ends with と", () => {
    // 曰's comp:obj complement (習之, "practices it") stays in place instead
    // of inverting before 曰 the way an ordinary object would — real kanbun
    // reads 子曰く、これを習ふと straight through, not と習ふ子曰これを.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "習", lemma: "習", pos: "VERB", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 3, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    const out = generateKakikudashi(plan, fakeResolve);
    expect(out).toBe("子曰はくこれを習ふと");
  });
});

// ---------------------------------------------------------------------------
// 勸學 opening — real parse trees (captured live against the actual 0.2.0
// wheel), real resolver (kanjidic + jmdict + overrides.json, not fakeResolve)
// end to end. Regression-anchors several fixes found translating this text:
// 可以 as a fused modal (もって repositioned before its complement, not
// stranded after べからず), は on a modal-root's subject and on a fronted
// mod+Case:Loc topic, は on a coord-root's subject when the coordinate
// sibling is itself stative (but never double-topicalizing a subject that
// already has its own pattern-b topic), を never appearing on an
// adposition's own object, 於 always inverting before its governor and
// reading より — a source/standard-of-comparison relation, not a location
// one (mod@lmod is unconditionally INVERT — see depClassification.ts —
// whether that governor is a stative predicate, 藍より青し "bluer than
// indigo", or a plain action verb, 藍より取り "takes it from indigo", not
// 取り藍において), しかして (not て) bridging into a stative conj:coord
// clause, and VERB_LEXICON
// conjugation gated to POS=VERB so a noun use of the same lemma (青 as "the
// color blue" vs. 青 "is blue") doesn't wrongly conjugate.
// ---------------------------------------------------------------------------

describe("勸學 opening (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  it("學不可以已 -> 學ぶはもって已むべからず", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "subj", head: 2 },
        { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
        { id: 2, text: "可", lemma: "可", pos: "AUX", xpos: "x", dep: "ROOT", head: 2, morph: "Mood=Pot" },
        { id: 3, text: "以", lemma: "以", pos: "VERB", xpos: "x", dep: "unk", head: 2 },
        { id: 4, text: "已", lemma: "已", pos: "PART", xpos: "x", dep: "comp:aux", head: 2 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(generateKakikudashi(plan, resolve)).toBe("學ぶはもって已むべからず");
  });

  it("青取之於藍，而青於藍 -> 青はこれを藍より取りしかして藍より青し", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "青", lemma: "青", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "取", lemma: "取", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 1 },
        { id: 3, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 1 },
        { id: 4, text: "藍", lemma: "藍", pos: "PROPN", xpos: "x", dep: "comp:obj", head: 3 },
        { id: 6, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 7 },
        { id: 7, text: "青", lemma: "青", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1, morph: "Degree=Pos" },
        { id: 8, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 7 },
        { id: 9, text: "藍", lemma: "藍", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 8 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(generateKakikudashi(plan, resolve)).toBe("青はこれを藍より取りしかして藍より青し");
  });

  it("冰水為之，而寒於水 -> 冰は水これを為ししかして水より寒し", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "冰", lemma: "冰", pos: "NOUN", xpos: "x", dep: "mod", head: 1, morph: "Case=Loc" },
        { id: 1, text: "水", lemma: "水", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
        { id: 2, text: "為", lemma: "爲", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
        { id: 3, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 5, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "mod", head: 6 },
        { id: 6, text: "寒", lemma: "寒", pos: "VERB", xpos: "x", dep: "conj:coord", head: 2, morph: "Degree=Pos" },
        { id: 7, text: "於", lemma: "於", pos: "ADP", xpos: "x", dep: "mod@lmod", head: 6 },
        { id: 8, text: "水", lemma: "水", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 7 },
      ],
    };
    const plan = computeReadingOrder(sentence);
    expect(generateKakikudashi(plan, resolve)).toBe("冰は水これを為ししかして水より寒し");
  });
});
