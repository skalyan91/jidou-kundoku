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
import { generateKakikudashi, generateKakikudashiForTree, sentenceSeparator } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { dirname, join } from "node:path";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
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
    //
    // The closing 。 is what licenses the copula at all (see
    // `isPredicationLicensed`) — without a mark this reads as the bare noun
    // phrase 君子 and takes no copula, which is a different rule, tested on
    // its own below.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "亦", lemma: "亦", pos: "ADV", xpos: "x", dep: "mod", head: 1 },
        { id: 1, text: "君", lemma: "君", pos: "NOUN", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "flat", head: 1 },
        { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
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

// ---------------------------------------------------------------------------
// A span whose members attach to different heads, through the real reading
// path: `findCompoundSpans` -> `computeReadingOrder(sentence, spans)`, which
// is how `KakikudashiView` calls it. The rest of this file passes no spans,
// so nothing here exercised the carrier rule end to end.
// ---------------------------------------------------------------------------

describe("史記五帝本紀 opening (real parse tree, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  it("黃帝者、少典之子也 -> 黃帝は、少典の子なり", () => {
    // 黃帝 is one span across two heads (黃 `compound` of 帝, 帝 `mod` of 者),
    // and 帝 is the only member attached outside it. Carrying the span on 黃
    // instead hung it off a token the walk removes, and the whole name went
    // missing: は、少典の子なり.
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "黃", lemma: "黃", pos: "PROPN", xpos: "x", dep: "compound", head: 1, morph: "NameType=Giv" },
        { id: 1, text: "帝", lemma: "帝", pos: "NOUN", xpos: "x", dep: "mod", head: 2 },
        { id: 2, text: "者", lemma: "者", pos: "PART", xpos: "x", dep: "subj", head: 6 },
        { id: 3, text: "、", lemma: "、", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        { id: 4, text: "少典", lemma: "少典", pos: "PROPN", xpos: "x", dep: "comp:obj", head: 5, morph: "NameType=Giv" },
        { id: 5, text: "之", lemma: "之", pos: "SCONJ", xpos: "x", dep: "mod", head: 6 },
        { id: 6, text: "子", lemma: "子", pos: "NOUN", xpos: "x", dep: "ROOT", head: 6 },
        { id: 7, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 6 },
        { id: 8, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 6 },
      ],
    };
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(plan.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(generateKakikudashi(plan, resolve)).toBe("黃帝は、少典の子なり");
  });
});

// ---------------------------------------------------------------------------
// A 再読文字 over a predicate that carries a coordinate clause — the scope
// question, end to end through the real resolver.
// ---------------------------------------------------------------------------

describe("a 再読文字 with a coordinate clause beside it (real parse tree, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  /** 未學禮而不知。 as the wheel returns it. */
  const sentence: Sentence = {
    tokens: [
      { id: 0, text: "未", lemma: "未", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Polarity=Neg" },
      { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
      { id: 2, text: "禮", lemma: "禮", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
      { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 5 },
      { id: 4, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 5, morph: "Polarity=Neg" },
      { id: 5, text: "知", lemma: "知", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
      { id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
    ],
  };

  it("未學禮而不知 -> いまだ禮を學ばずして知らず", () => {
    // Three things at once, all of them consequences of where 未's ず lands.
    // It used to close at the end of the whole subtree, past the coordinate
    // clause, which put it after 不's own ず (知らずず), left 學 in the 連用形
    // (學びて) instead of the 未然形 未 governs, and left 而 reading て because
    // the negation in front of it was a re-read close rather than a token.
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(generateKakikudashi(plan, resolve)).toBe("いまだ禮を學ばずして知らず");
  });

  it("keeps closing at the end of the clause when nothing is coordinated onto it", () => {
    const alone: Sentence = { tokens: sentence.tokens.filter((t) => t.id <= 2 || t.id === 6) };
    const plan = computeReadingOrder(alone, findCompoundSpans(alone));
    expect(generateKakikudashi(plan, resolve)).toBe("いまだ禮を學ばず");
  });
});

// ---------------------------------------------------------------------------
// A reading picked by hand on a grammar word — the branches that render those
// used to claim the character before the choice was ever consulted.
// ---------------------------------------------------------------------------

describe("a hand-picked reading on a grammar word (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);

  /** 未學禮。 as the wheel returns it, optionally with a reading chosen on 未. */
  const weiXueLi = (reading?: string): Sentence => ({
    tokens: [
      { id: 0, text: "未", lemma: "未", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Polarity=Neg", ...(reading ? { misc: { Reading: reading } } : {}) },
      { id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
      { id: 2, text: "禮", lemma: "禮", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
    ],
  });

  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("未學禮 -> いまだ禮を學ばず with nothing picked", () => {
    expect(run(weiXueLi())).toBe("いまだ禮を學ばず");
  });

  it("未學禮 -> 未禮を學ぶ once 未 is read ひつじ", () => {
    // Three things follow from the choice, and all three used to be missed.
    // The reading itself has to appear at all — the negation branch claimed
    // the character first and emitted a bare ず, so the prose read 禮を學ばず
    // with no 未 in it. Nothing may go on conjugating against a negation that
    // is no longer there, or 學 keeps the 未然形 and dangles: 未禮を學ば. And
    // the character must stop being postposed, which is done to negations
    // because they are read after what they negate: 禮を學ぶ未.
    expect(run(weiXueLi("ひつじ"))).toBe("未禮を學ぶ");
  });

  it("also lets a sentence-final particle be overruled", () => {
    const withYe = (reading?: string): Sentence => ({
      tokens: [
        { id: 0, text: "習", lemma: "習", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "也", lemma: "也", pos: "PART", xpos: "x", dep: "discourse@sp", head: 0, ...(reading ? { misc: { Reading: reading } } : {}) },
      ],
    });
    expect(run(withYe())).toBe("習ふなり");
    expect(run(withYe("や"))).toBe("習ふ也");
  });
});

// ---------------------------------------------------------------------------
// What falls between one clause and the next. The parser segments at every
// mark, so `tree.sentences` is a list of clauses; the mark each clause was
// closed with is what decides whether 、 or 。 goes after it.
// ---------------------------------------------------------------------------

describe("sentenceSeparator", () => {
  const sentence = (...texts: string[]): Sentence => ({
    tokens: texts.map((text, id) => ({
      id,
      text,
      lemma: text,
      pos: /[、。，？！「」]/.test(text) ? "PUNCT" : "NOUN",
      xpos: "x",
      dep: /[、。，？！「」]/.test(text) ? "punct" : "ROOT",
      head: 0,
    })),
  });

  it("writes 、 after a clause a comma divided", () => {
    const list = [sentence("學", "，"), sentence("說")];
    expect(sentenceSeparator(list, 0)).toBe("、");
  });

  it("writes 。 after a clause a question mark closed", () => {
    // ？ closes a sentence even though the parser segments on ， as well —
    // 學而時習之，不亦說乎？有朋自遠方來 is three clauses and two sentences.
    const list = [sentence("說", "？"), sentence("有")];
    expect(sentenceSeparator(list, 0)).toBe("。");
  });

  it("writes 。 after the last clause of the text", () => {
    expect(sentenceSeparator([sentence("學", "，")], 0)).toBe("。");
  });

  it("writes nothing before a closing bracket, which belongs to what it closes", () => {
    const list = [sentence("說", "？"), sentence("」")];
    expect(sentenceSeparator(list, 0)).toBe("");
  });

  it("writes nothing after an opening bracket, which belongs to what it opens", () => {
    const list = [sentence("曰", "「"), sentence("學")];
    expect(sentenceSeparator(list, 0)).toBe("");
  });

  it("asks the last clause that had a mark, past a bracket standing alone", () => {
    // 子曰：「…罔。」思而… — the 」 comes back as a sentence of its own, the 。
    // inside the quote having ended the one before it. The quotation ends a
    // sentence, so what follows it opens a new one.
    const list = [sentence("罔", "。"), sentence("」"), sentence("思")];
    expect(sentenceSeparator(list, 1)).toBe("。");
  });

  it("falls back to 、 where the parser cut a clause the source left unmarked", () => {
    const list = [sentence("矣"), sentence("仁")];
    expect(sentenceSeparator(list, 0)).toBe("、");
  });
});

// ---------------------------------------------------------------------------
// Genitive の, the withheld copula, あり for a count, and a chain that isn't
// flat — each through the real resolver, on the tree the live parser returns
// for the text named. Verified end to end against the running app.
// ---------------------------------------------------------------------------

describe("nominal-modifier の and the sentence-final endings (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("楚人至。 -> 楚の人至る", () => {
    // 楚 was picking up the fronted-topic は instead: 楚は人至る.
    expect(
      run({
        tokens: [
          { id: 0, text: "楚", lemma: "楚", pos: "PROPN", xpos: "x", dep: "mod", head: 1, morph: "Case=Loc|NameType=Nat" },
          { id: 1, text: "人", lemma: "人", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
          { id: 2, text: "至", lemma: "至", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("楚の人至る");
  });

  it("梁惠王曰。 -> 梁の惠王曰はく — the の reaches past the name 惠王", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "梁", lemma: "梁", pos: "PROPN", xpos: "x", dep: "mod", head: 2, morph: "Case=Loc|NameType=Nat" },
          { id: 1, text: "惠", lemma: "惠", pos: "PROPN", xpos: "x", dep: "compound", head: 2, morph: "NameType=Prs" },
          { id: 2, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 3 },
          { id: 3, text: "曰", lemma: "曰", pos: "VERB", xpos: "x", dep: "ROOT", head: 3 },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 3 },
        ],
      }),
    ).toBe("梁の惠王曰はく");
  });

  /** 君子, with or without the mark that closes it. */
  const junzi = (punctuated: boolean): Sentence => ({
    tokens: [
      { id: 0, text: "君子", lemma: "君子", pos: "NOUN", xpos: "x", dep: "ROOT", head: 0 },
      ...(punctuated ? [{ id: 1, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 }] : []),
    ],
  });

  it("君子 with no punctuation stays a noun phrase", () => {
    expect(run(junzi(false))).toBe("君子");
  });

  it("君子。 is a predication and takes なり", () => {
    expect(run(junzi(true))).toBe("君子なり");
  });

  it("弟子三千人。 -> 弟子三千人あり — a count, not an identity", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "弟子", lemma: "弟子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "三千", lemma: "三千", pos: "NUM", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "人", lemma: "人", pos: "NOUN", xpos: "x", dep: "clf", head: 1, morph: "NounType=Clf" },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("弟子三千人あり");
  });

  it("食肉飲酒歌舞。 -> 肉を食ひ酒を飲み舞ふ歌ふ — only the last conjunct is finite", () => {
    // 歌 hangs off 飲 rather than off the chain's head 食, which used to make
    // 飲 look like the last member of its own two-verb chain: 酒を飲む.
    expect(
      run({
        tokens: [
          { id: 0, text: "食", lemma: "食", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
          { id: 1, text: "肉", lemma: "肉", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
          { id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "x", dep: "parataxis", head: 0 },
          { id: 3, text: "酒", lemma: "酒", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
          { id: 4, text: "歌", lemma: "歌", pos: "VERB", xpos: "x", dep: "parataxis", head: 2 },
          { id: 5, text: "舞", lemma: "舞", pos: "VERB", xpos: "x", dep: "comp:obj", head: 4 },
          { id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("肉を食ひ酒を飲み舞ふ歌ふ");
  });

  it("毎得書讀之。 -> 書を得るごとにこれを讀む — 毎 wants 連体形", () => {
    expect(
      run({
        tokens: [
          { id: 0, text: "毎", lemma: "每", pos: "ADV", xpos: "x", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Conv" },
          { id: 1, text: "得", lemma: "得", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "書", lemma: "書", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
          { id: 3, text: "讀", lemma: "讀", pos: "VERB", xpos: "x", dep: "parataxis", head: 1 },
          { id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "x", dep: "comp:obj", head: 3, morph: "Person=3|PronType=Prs" },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("書を得るごとにこれを讀む");
  });
});

// ---------------------------------------------------------------------------
// The transitive/intransitive split, conjugated. `beatsLexicon` stands
// VERB_LEXICON down so the syntax-chosen reading can reach the page, and with
// the entry went the conjugation class it was carrying — the reading arrived
// in citation form wherever an inflected one was called for (廟を立つて, which
// is not Japanese). Both trees below are the live parser's own, exported from
// the running app as CoNLL-U.
// ---------------------------------------------------------------------------

describe("a transitivity-selected reading conjugates (real parse trees, real resolver)", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  it("王立廟而去。 -> 王廟を立てて去ぬ — 立 with an object is 下二段タ行", () => {
    // 廟 is 立's comp:obj, so the reading is the transitive 立てる, whose
    // classical class is 下二段タ行: renyoukei 立て before 而's て. The
    // lexicon's own 立 entry (四段タ行 たつ) is the intransitive word and is
    // rightly stood down here — but its class went with it, and 立つて is
    // what came out instead.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "廟", lemma: "廟", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1, morph: "Case=Loc" },
          { id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王廟を立てて去ぬ");
  });

  it("廟立而王去。 -> 廟立ちて王去ぬ — the same character with no object is 四段タ行", () => {
    // The regression's control: nothing moves this reading, so it goes on
    // through the lexicon and its 四段 renyoukei 立ち, exactly as before.
    expect(
      run({
        tokens: [
          { id: 0, text: "廟", lemma: "廟", pos: "NOUN", xpos: "x", dep: "subj", head: 1, morph: "Case=Loc" },
          { id: 1, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 4 },
          { id: 3, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 4 },
          { id: 4, text: "去", lemma: "去", pos: "VERB", xpos: "x", dep: "conj:coord", head: 1 },
          { id: 5, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("廟立ちて王去ぬ");
  });

  it("王不立廟。 -> 王廟を立てず — the 下二段 mizenkei, through the ordinary negation rule", () => {
    // The point of rebuilding a lexicon entry rather than special-casing the
    // ending: every context rule downstream (here, postposed 不) keeps
    // working on the syntax-chosen reading unchanged.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 2 },
          { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "x", dep: "mod", head: 2, morph: "Polarity=Neg" },
          { id: 2, text: "立", lemma: "立", pos: "VERB", xpos: "x", dep: "ROOT", head: 2 },
          { id: 3, text: "廟", lemma: "廟", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2, morph: "Case=Loc" },
          { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 2 },
        ],
      }),
    ).toBe("王廟を立てず");
  });

  it("leaves an okurigana shape no class can be read off exactly as it was", () => {
    // 起 with an object resolves to お.こす — not a -eru/-iru verb, so no
    // class is derived and the reading reaches the page uninflected, which
    // is the behaviour it already had. Asserted so that a future derivation
    // widening this cannot do it silently.
    expect(
      run({
        tokens: [
          { id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
          { id: 1, text: "起", lemma: "起", pos: "VERB", xpos: "x", dep: "ROOT", head: 1 },
          { id: 2, text: "兵", lemma: "兵", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 1 },
          { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
        ],
      }),
    ).toBe("王兵を起こす");
  });
});
