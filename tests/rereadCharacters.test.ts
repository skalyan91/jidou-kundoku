import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { governedPredicate, isRereadUse, rereadCharacter, rereadCloseId, rereadGovernedForm, REREAD_CHARACTERS } from "../src/kakikudashi/rereadCharacters.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { conjugatedOkurigana, negationForm, rereadSecondReading } from "../src/kakikudashi/conjugationContext.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { toKatakana } from "../src/render/kana.ts";
import type { ReadingPlan } from "../src/kundoku/types.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { Sentence, Token } from "../src/parse/types.ts";
import type { ReadingResolver } from "../src/reading/types.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { generateKakikudashi, generateKakikudashiPieces } from "../src/kakikudashi/generator.ts";

function tok(overrides: Partial<Token>): Token {
  return { id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...overrides };
}

/** 未 + a verb: the character modifies the predicate it negates. */
function rereadOverVerb(text: string, dep = "mod", pos = "ADV"): Sentence {
  return {
    tokens: [
      tok({ id: 0, text, lemma: text, pos, dep, head: 1 }),
      tok({ id: 1, text: "行", lemma: "行", pos: "VERB", dep: "ROOT", head: 1 }),
    ],
  };
}

/** 未學禮而不知。 exactly as the wheel returns it: 未 modifies 學, and 知
 * hangs off 學 as a coordinate clause carrying its own negation. */
const coordinatedUnderReread: Sentence = {
  tokens: [
    tok({ id: 0, text: "未", lemma: "未", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
    tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 1 }),
    tok({ id: 2, text: "禮", lemma: "禮", pos: "NOUN", dep: "comp:obj", head: 1 }),
    tok({ id: 3, text: "而", lemma: "而", pos: "CCONJ", dep: "cc", head: 5 }),
    tok({ id: 4, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 5, morph: "Polarity=Neg" }),
    tok({ id: 5, text: "知", lemma: "知", pos: "VERB", dep: "conj:coord", head: 1 }),
    tok({ id: 6, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
  ],
};

describe("the 再読文字 table", () => {
  it("pairs each character's two readings with the form the predicate takes", () => {
    // `firstOkurigana` beside them: where the first reading's kanji ends, so
    // that the character survives into the 書き下し文 the way this panel has
    // always kept it in the 訓読文. See its own doc, and the counts there.
    expect(rereadCharacter("未")).toEqual({ first: "いまだ", firstOkurigana: "だ", second: "ず", form: "mizen" });
    expect(rereadCharacter("須")).toEqual({ first: "すべからく", firstOkurigana: "らく", second: "べし", form: "shuushi" });
    expect(rereadCharacter("猶")).toEqual({ first: "なほ", firstOkurigana: "ほ", second: "がごとし", form: "rentai" });
  });

  it("gives the kyūjitai spellings the same entry as their shinjitai", () => {
    expect(rereadCharacter("將")).toEqual(rereadCharacter("将"));
    expect(rereadCharacter("當")).toEqual(rereadCharacter("当"));
    expect(rereadCharacter("應")).toEqual(rereadCharacter("応"));
  });

  it("reads every entry in historical kana, as the rest of the app does", () => {
    // なほ not なお, いまだ not いまだ… — no modern-only spellings.
    expect(Object.values(REREAD_CHARACTERS).every((e) => !e.first.includes("お"))).toBe(true);
  });

  it("knows nothing of characters outside the set", () => {
    expect(rereadCharacter("学")).toBeNull();
    expect(rereadCharacter("不")).toBeNull(); // plain negation, read once
  });
});

describe("isRereadUse", () => {
  it("accepts a character modifying a predicate", () => {
    const notYet = rereadOverVerb("未");
    expect(isRereadUse(notYet.tokens[0], notYet)).toBe(true);
    const aboutTo = rereadOverVerb("将");
    expect(isRereadUse(aboutTo.tokens[0], aboutTo)).toBe(true);
  });

  it("rejects a character attached as the complement of an auxiliary", () => {
    // `comp:aux` runs from the auxiliary down to the verb it governs, so the
    // dependent is never a modifier — this shape used to be accepted, with 将
    // tagged AUX as `comp:aux` of 行, a tree no parse in the corpus produces.
    const governed = rereadOverVerb("将", "comp:aux", "AUX");
    expect(isRereadUse(governed.tokens[0], governed)).toBe(false);
  });

  it("rejects the same characters in their ordinary senses", () => {
    // 且 coordinating two clauses is "moreover", not "on the point of".
    const moreover = rereadOverVerb("且", "cc", "CCONJ");
    expect(isRereadUse(moreover.tokens[0], moreover)).toBe(false);
    // 猶 heading its own clause is the plain verb "to resemble".
    const resembles = rereadOverVerb("猶", "ROOT", "VERB");
    expect(isRereadUse(resembles.tokens[0], resembles)).toBe(false);
    // 當 as a noun (當時) is not read twice however it attaches.
    const atThatTime = rereadOverVerb("當", "mod", "NOUN");
    expect(isRereadUse(atThatTime.tokens[0], atThatTime)).toBe(false);
  });

  it("rejects characters that are not 再読文字 at all", () => {
    const notNegation = rereadOverVerb("不", "mod", "ADV");
    expect(isRereadUse(notNegation.tokens[0], notNegation)).toBe(false);
  });

  it("cannot answer without the sentence, on either path", () => {
    // The question is whether a predicate exists for the character to be read
    // twice around, and neither the head it hangs off nor the child it holds
    // can be found in a token on its own. The child path always answered false
    // here; the modifier path used to answer true off the relation alone.
    expect(isRereadUse({ id: 0, text: "未", dep: "mod", head: 1, pos: "ADV" })).toBe(false);
    expect(isRereadUse({ id: 0, text: "須", dep: "ROOT", head: 0, pos: "VERB" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A 再読文字 announces a predicate, and is the construction only where the
// sentence supplies one. 不須 was reading べからず and 須 alone べし — the
// second half of a construction whose first half nothing had opened, because
// the character was reaching `AUXILIARY_LEMMAS` (which is keyed on the lemma
// alone) after the re-read branch had already declined it.
// ---------------------------------------------------------------------------

describe("a 再読文字 with no predicate to govern", () => {
  /** 不X。 — X standing as a VERB with nothing under it. */
  const negatedAlone = (text: string): Sentence => ({
    tokens: [
      tok({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
      tok({ id: 1, text, lemma: text, pos: "VERB", dep: "ROOT", head: 1 }),
    ],
  });

  it("is not the construction, for any character in the set", () => {
    for (const text of Object.keys(REREAD_CHARACTERS)) {
      const s = negatedAlone(text);
      expect(isRereadUse(s.tokens[1], s), text).toBe(false);
      expect(computeReadingOrder(s, []).rereadCloseIds.size, text).toBe(0);
    }
  });

  it("is the construction for every one of them once a predicate is there", () => {
    for (const text of Object.keys(REREAD_CHARACTERS)) {
      // Both shapes these characters arrive on: heading the clause with the
      // predicate as a child, and modifying the predicate as its head.
      const heads: Sentence = {
        tokens: [
          tok({ id: 0, text, lemma: text, pos: "VERB", dep: "ROOT", head: 0 }),
          tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "comp:aux", head: 0 }),
        ],
      };
      const modifies: Sentence = {
        tokens: [
          tok({ id: 0, text, lemma: text, pos: "ADV", dep: "mod", head: 1 }),
          tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 1 }),
        ],
      };
      expect(isRereadUse(heads.tokens[0], heads), `${text} heads`).toBe(true);
      expect(isRereadUse(modifies.tokens[0], modifies), `${text} modifies`).toBe(true);
    }
  });

  it("declines where the head a modifier hangs off is not verbal", () => {
    // The modifier path's predicate is the character's own *head*, and
    // `REREAD_DEPS.has(dep)` alone said only that the character modifies
    // something. 當 over the noun 時 is 當時, "at that time".
    const atThatTime: Sentence = {
      tokens: [
        tok({ id: 0, text: "當", lemma: "當", pos: "ADV", dep: "mod", head: 1 }),
        tok({ id: 1, text: "時", lemma: "時", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(isRereadUse(atThatTime.tokens[0], atThatTime)).toBe(false);
  });

  it("writes べし only where something is enjoined", () => {
    const resolve: ReadingResolver = () => ({ reading: "", source: "kanjidic" });
    const mustLearn: Sentence = {
      tokens: [
        tok({ id: 0, text: "須", lemma: "須", pos: "AUX", dep: "ROOT", head: 0, morph: "Mood=Nec" }),
        tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "comp:aux", head: 0 }),
      ],
    };
    const pieces = (s: Sentence) => generateKakikudashiPieces(computeReadingOrder(s, []), resolve).map((p) => p.text).join("");
    expect(pieces(mustLearn)).toContain("べし");
    // 不須 and 須 alone supply no 學, so neither half of the construction is
    // written: the character takes the ordinary lookup instead.
    expect(pieces(negatedAlone("須"))).not.toContain("べ");
    expect(pieces({ tokens: [tok({ id: 0, text: "須", lemma: "須", pos: "VERB", dep: "ROOT", head: 0 })] })).not.toContain("べ");
    // 當/応/應 are in the same table and take the same gate.
    expect(pieces(negatedAlone("當"))).not.toContain("べ");
    expect(pieces(negatedAlone("応"))).not.toContain("べ");
    expect(pieces(negatedAlone("應"))).not.toContain("べ");
    // 可 is not read twice and is untouched: 不可 is still べからず.
    expect(pieces(negatedAlone("可"))).toContain("可から");
  });
});

describe("the ordinary reading a declined 再読文字 falls back to", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const historicalKana = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  it("reads 須 as the verb もちゐる, not as the adverb of the construction it just declined", () => {
    // KANJIDIC2's kun list for 須 leads with すべから.く — the re-read's own
    // adverb — so the ordinary lookup handed the declined character the very
    // half that had been ruled out, and 不須 read 須くず. See VERB_LEXICON's
    // entry for 須.
    const notNeeded: Sentence = {
      tokens: [
        tok({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "須", lemma: "須", pos: "VERB", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
      ],
    };
    expect(generateKakikudashi(computeReadingOrder(notNeeded, []), resolve)).toBe("須ゐず");
  });

  it("leaves the construction itself alone", () => {
    const mustLearn: Sentence = {
      tokens: [
        tok({ id: 0, text: "須", lemma: "須", pos: "AUX", dep: "ROOT", head: 0, morph: "Mood=Nec" }),
        tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "comp:aux", head: 0 }),
        tok({ id: 2, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 0 }),
      ],
    };
    expect(generateKakikudashi(computeReadingOrder(mustLearn, []), resolve)).toBe("須らく學ぶべし");
  });
});

describe("reading order for a 再読文字", () => {
  it("reads the character before the predicate, not after it", () => {
    // Without this the classifier postposes it, as it does any negation or
    // auxiliary, and the adverbial half lands after the verb it modifies.
    const plan = computeReadingOrder(rereadOverVerb("未"), []);
    expect(plan.order).toEqual([0, 1]);
  });

  it("records the second reading against the end of the governed clause", () => {
    const plan = computeReadingOrder(rereadOverVerb("未"), []);
    expect(plan.rereadCloseIds.get(1)).toEqual([0]);
  });

  it("records nothing for a character used in its ordinary sense", () => {
    const plan = computeReadingOrder(rereadOverVerb("且", "cc", "CCONJ"), []);
    expect(plan.rereadCloseIds.size).toBe(0);
  });

  it("closes on the governed predicate, not past a clause coordinated onto it", () => {
    // 未學禮而不知 as the parser returns it. 未 negates 學禮; 而不知 is a
    // parallel predication with a negation of its own. Closing at the end of
    // the whole subtree landed 未's ず on 不's, giving 知らずず — and left 學
    // in the 連用形 the coordination asked for instead of the 未然形 未 does.
    const plan = computeReadingOrder(coordinatedUnderReread, []);
    expect(plan.rereadCloseIds.get(1)).toEqual([0]);
    expect(plan.rereadCloseIds.has(4)).toBe(false);
  });

  it("leaves an ordinary negation postposed, as before", () => {
    const plan = computeReadingOrder(rereadOverVerb("不", "mod", "ADV"), []);
    expect(plan.rereadCloseIds.size).toBe(0);
  });
});

describe("a re-read character that heads its own clause", () => {
  /** 須 as the parser returns it: the character is the ROOT and the
   * predicate hangs off it as `comp:aux`. */
  const modalOverVerb = (text: string, childDep = "comp:aux"): Sentence => ({
    tokens: [
      tok({ id: 0, text, lemma: text, pos: "VERB", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: childDep, head: 0 }),
    ],
  });

  it("is recognised from the other end of the relation", () => {
    const s = modalOverVerb("須");
    expect(isRereadUse(s.tokens[0], s)).toBe(true);
    // Without the sentence there is nothing to recognise it by.
    expect(isRereadUse(s.tokens[0])).toBe(false);
  });

  it("also recognises the comp:obj shape the parser uses for 當", () => {
    const s = modalOverVerb("當", "comp:obj");
    expect(isRereadUse(s.tokens[0], s)).toBe(true);
  });

  it("is read before the predicate it governs, not after it", () => {
    const plan = computeReadingOrder(modalOverVerb("須"), []);
    expect(plan.order).toEqual([0, 1]);
    expect(plan.rereadCloseIds.get(1)).toEqual([0]);
  });

  it("is not triggered by a character that governs nothing", () => {
    const alone: Sentence = { tokens: [tok({ id: 0, text: "須", lemma: "須", pos: "VERB", dep: "ROOT", head: 0 })] };
    expect(isRereadUse(alone.tokens[0], alone)).toBe(false);
  });
});

describe("the form a re-read character imposes on its predicate", () => {
  /** 未來 as the parser returns it — the case where the two panels disagreed:
   * the kakikudashibun read 來らず and the ruby read きたル, because only the
   * generator consulted this. The second reading is no token of its own, so
   * `decideConjForm` sees nothing following the predicate and leaves it in
   * 終止形.
   *
   * **The endings lost their た when the reader ruled the stem folded.** This
   * pinned たら/たる while `VERB_LEXICON`'s 來 stood as き + an `okuriganaPrefix`
   * of た, showing the stem's second kana beside the character (來たる). The
   * received text writes 来る and 来らんとす, folding it into the furigana, and
   * the reader has settled it that way — so the entry is きた + 四段ラ行 and the
   * ending is the paradigm's alone. The reading is unchanged: きたら, きたる. */
  const notYetCome: Sentence = {
    tokens: [
      tok({ id: 0, text: "未", lemma: "未", pos: "ADV", dep: "mod", head: 1 }),
      tok({ id: 1, text: "來", lemma: "來", pos: "VERB", dep: "ROOT", head: 1 }),
    ],
  };

  it("hands the predicate the form its second reading wants", () => {
    const plan = computeReadingOrder(notYetCome, []);
    expect(rereadGovernedForm(1, plan)).toBe("mizen");
    // Which is what both panels then conjugate with: the ending they render
    // is ら, against the る 終止形 the ruby was showing as きたル.
    expect(conjugatedOkurigana(VERB_LEXICON["來"], "mizen")).toBe("ら");
    expect(conjugatedOkurigana(VERB_LEXICON["來"], "shuushi")).toBe("る");
  });

  it("leaves a token no re-read governs to the ordinary rules", () => {
    const plan = computeReadingOrder(notYetCome, []);
    expect(rereadGovernedForm(0, plan)).toBeNull();
  });

  it("asks 須 for 終止形 where 未 asks for 未然形", () => {
    const mustLearn: Sentence = {
      tokens: [
        tok({ id: 0, text: "須", lemma: "須", pos: "VERB", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "comp:aux", head: 0 }),
      ],
    };
    expect(rereadGovernedForm(1, computeReadingOrder(mustLearn, []))).toBe("shuushi");
  });
});

describe("a reading picked by hand", () => {
  it("takes the character out of the construction when it is not the 再読 one", () => {
    const s = rereadOverVerb("未");
    expect(isRereadUse(s.tokens[0], s)).toBe(true);
    s.tokens[0].misc = { Reading: "ひつじ" };
    expect(isRereadUse(s.tokens[0], s)).toBe(false);
  });

  it("leaves it in when the choice is the 再読 reading itself", () => {
    const s = rereadOverVerb("未");
    s.tokens[0].misc = { Reading: "いまだ" };
    expect(isRereadUse(s.tokens[0], s)).toBe(true);
  });

  it("reaches the reading order, not just the rendering", () => {
    // The second reading is emitted after a whole clause, so a choice the
    // order did not know about would leave a ず at the end of a sentence no
    // longer beginning with an いまだ.
    const s = rereadOverVerb("未");
    expect(computeReadingOrder(s, []).rereadCloseIds.size).toBe(1);
    s.tokens[0].misc = { Reading: "ひつじ" };
    expect(computeReadingOrder(s, []).rereadCloseIds.size).toBe(0);
  });

  it("reaches it on the clause-heading path too, not only the modifier one", () => {
    // The order asked this question two ways: `isRereadUse` for a modifier,
    // and the bare relation for a character that heads its clause. So a
    // hand-picked reading took 須 out of the construction in both panels while
    // the order went on reading it first and recording a べし after 學 —
    // 須[もちゐる] 學ぶべし, a second reading with no first one anywhere.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "須", lemma: "須", pos: "AUX", dep: "ROOT", head: 0, morph: "Mood=Nec" }),
        tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "comp:aux", head: 0 }),
      ],
    };
    expect(computeReadingOrder(s, []).order).toEqual([0, 1]);
    expect(computeReadingOrder(s, []).rereadCloseIds.size).toBe(1);
    s.tokens[0].misc = { Reading: "もち", Okurigana: "ゐる" };
    expect(computeReadingOrder(s, []).rereadCloseIds.size).toBe(0);
    // …and the character goes back to being read where its relation puts it.
    expect(computeReadingOrder(s, []).order).toEqual([1, 0]);
  });
});

describe("a re-read character's two halves in the kakikudashibun", () => {
  /** 未學禮 — 未 negating a clause whose predicate takes an object, so the two
   * halves of its reading end up at opposite ends of the prose. */
  const notYetStudiedRites: Sentence = {
    tokens: [
      tok({ id: 0, text: "未", lemma: "未", pos: "ADV", dep: "mod", head: 1 }),
      tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 1 }),
      tok({ id: 2, text: "禮", lemma: "禮", pos: "NOUN", dep: "comp:obj", head: 1 }),
    ],
  };
  const resolve: ReadingResolver = () => ({ reading: "", source: "kanjidic" });

  it("answers for both of them, though only one is where the character is", () => {
    const plan = computeReadingOrder(notYetStudiedRites, []);
    const pieces = generateKakikudashiPieces(plan, resolve);
    // Which is what lets the panel mark both halves when 未 is picked out:
    // the ず is emitted from the predicate's position and belongs to 未.
    expect(pieces.filter((p) => p.tokenId === 0).map((p) => p.text)).toEqual(["未だ", "ず"]);
    // Case particles ride on their own piece field, so the prose is the two
    // joined — the check that splitting the ず off changed nothing readers see.
    expect(pieces.map((p) => p.text + (p.caseParticle ?? "")).join("")).toBe("未だ禮を學ばず");
  });
});

describe("negation under a re-read character", () => {
  it("takes the ざり-paradigm rentaikei before ごとし, not ぬ", () => {
    expect(negationForm(undefined, "rentai")).toBe("ざる");
  });

  it("is unaffected where no re-read governs it", () => {
    expect(negationForm(undefined)).toBe("ず");
    // A noun after the negation takes ざる as well; the ず-series ぬ is not what
    // 訓読 writes as an attributive (see `negationForm`).
    expect(negationForm(tok({ pos: "NOUN" }))).toBe("ざる");
  });
});

describe("compound spans", () => {
  it("never absorb a re-read character", () => {
    // Fused into a span, the character is hidden from the reorder engine
    // entirely — span-mates are excluded from a node's children — and comes
    // out as a bare kanji with neither reading.
    // 學 tagged VERB, not NOUN: the character is a re-read only where the
    // predicate it governs exists, and for a `mod` that predicate is its head.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "盍", lemma: "盍", pos: "VERB", dep: "mod", head: 1 }),
        tok({ id: 1, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(s).some((sp) => sp.tokenIds.includes(0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A nominal predicate is a predicate. 未十年 is "it is not yet ten years", and
// the 未 fell to its plain-negation branch because the head was a NUM — which
// wrote the ず *inside* the phrase it negates, 十ぬ年.
// ---------------------------------------------------------------------------

describe("a 再読文字 over a nominal predicate", () => {
  const nominalRoot = (text: string, pos: string): Sentence => ({
    tokens: [
      tok({ id: 0, text, lemma: text, pos: "ADV", dep: "mod", head: 1 }),
      tok({ id: 1, text: "年", lemma: "年", pos, dep: "ROOT", head: 1 }),
      tok({ id: 2, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
    ],
  });

  it("is the construction over a NUM/NOUN/PROPN/PRON root", () => {
    for (const pos of ["NUM", "NOUN", "PROPN", "PRON"]) {
      const s = nominalRoot("未", pos);
      expect(isRereadUse(s.tokens[0], s), pos).toBe(true);
      // …and the ず is written after the whole phrase, not inside it.
      expect([...computeReadingOrder(s, []).rereadCloseIds.keys()], pos).toEqual([1]);
    }
  });

  it("asks the governed nominal for 未然形, which is the copula's なら", () => {
    const s = nominalRoot("未", "NOUN");
    expect(rereadGovernedForm(1, computeReadingOrder(s, []))).toBe("mizen");
  });

  it("still declines over a noun that is not a predicate — 當時", () => {
    // 當 tagged ADV over the noun 時 modifies a noun, and 當時 is "at that
    // time". The character does not negate, so it supplies no licence for a
    // copula and there is no predication for it to be read around.
    const atThatTime: Sentence = {
      tokens: [
        tok({ id: 0, text: "當", lemma: "當", pos: "ADV", dep: "mod", head: 1 }),
        tok({ id: 1, text: "時", lemma: "時", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(isRereadUse(atThatTime.tokens[0], atThatTime)).toBe(false);
    // Not even with the sentence closed, which is what would otherwise license
    // the copula: it is the character, not the mark, that decides here.
    const closed: Sentence = { tokens: [...atThatTime.tokens, tok({ id: 2, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 })] };
    expect(isRereadUse(closed.tokens[0], closed)).toBe(false);
  });

  it("admits only the characters whose second reading negates", () => {
    for (const text of Object.keys(REREAD_CHARACTERS)) {
      const s = nominalRoot(text, "NUM");
      expect(isRereadUse(s.tokens[0], s), text).toBe(text === "未" || text === "盍");
    }
  });

  it("still requires a nominal head to be the sentence's own predicate", () => {
    // A nominal that is not the root is a noun inside somebody else's clause —
    // the 時 of 當時 wherever it sits — and nothing predicates it.
    const inside: Sentence = {
      tokens: [
        tok({ id: 0, text: "未", lemma: "未", pos: "ADV", dep: "mod", head: 1 }),
        tok({ id: 1, text: "年", lemma: "年", pos: "NOUN", dep: "comp:obj", head: 2 }),
        tok({ id: 2, text: "有", lemma: "有", pos: "VERB", dep: "ROOT", head: 2 }),
      ],
    };
    expect(isRereadUse(inside.tokens[0], inside)).toBe(false);
  });

  it("does not weaken the check that made 不須 work", () => {
    // A 再読文字 heading its own clause with nothing under it supplies no
    // predicate of either kind, nominal or verbal, and is read as the ordinary
    // verb it also is.
    const alone: Sentence = {
      tokens: [
        tok({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "須", lemma: "須", pos: "VERB", dep: "ROOT", head: 1 }),
      ],
    };
    expect(isRereadUse(alone.tokens[1], alone)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// **いまだ…ず, and what stands after it.** The reader: *いまだ…ず should put its
// head in mizenkei; also, if there is a following rentaikei particle, it should
// end in ざる.* The first half is `rereadGovernedForm`'s and is asserted above.
// This is the second, and it takes two mechanisms working together — the ざる
// is `rereadSecondReading`'s and its *position* is `rereadCloseIn`'s, since a
// negation written after the なり it is attributive for would be inflecting for
// a particle standing on the wrong side of it.
//
// 未 is the only 再読文字 this reaches. 盍 already closes with ざる outright and
// the べし/んとす group asserts rather than negates, so there is nothing in
// either to inflect for what follows.
// ---------------------------------------------------------------------------
describe("a 再読文字's ず before a 連体形-taking particle", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const historicalKana = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;
  const realResolver = createReadingResolver(kanjidic, jmdict, historicalKana);
  const prose = (sentence: Sentence): string =>
    generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), realResolver);

  /** 未果 + whatever closes it. 果 is 下二段, so 未然形 果て is visible, and the
   * particle hangs off 果 the way every sentence-final particle attaches. */
  const closedBy = (mark: string, dep = "discourse@sp"): Sentence => ({
    tokens: [
      tok({ id: 0, text: "未", lemma: "未", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
      tok({ id: 1, text: "果", lemma: "果", pos: "VERB", dep: "ROOT", head: 1 }),
      tok({ id: 2, text: mark, lemma: mark, pos: "PART", dep, head: 1 }),
      tok({ id: 3, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
    ],
  });

  it("writes ざる before an assertive 也, and writes it before the なり", () => {
    // Both halves at once. The ず came out *after* the particle — いまだ果つなりず,
    // a negation asserted of an assertion — because the 也 counted as the last
    // token of the clause 未 closes on. なり is the 断定 auxiliary and stands on a
    // finished predicate, so it is outside that clause.
    expect(prose(closedBy("也"))).toBe("未だ果てざるなり");
  });

  it("writes ざる before a 限定 耳, read のみ", () => {
    // のみ is a 副助詞 and attaches to a 連体形 — the same claim
    // `isLimitingParticleAhead` makes for an unnegated predicate. いまだ果つのみず
    // before this.
    expect(prose(closedBy("耳"))).toBe("未だ果てざるのみ");
  });

  it("leaves ず before an interrogative 乎, read や — a 終助詞 takes the 終止形", () => {
    // This asserted 未だ果て**ざる**や, on 乎's や binding a 連体形. It does not:
    // a 終助詞 や is 終止形接続 (「ありやなしや」, and the received 不亦說乎 is
    // 亦說ばしから**ず**や), so the ず standing in front of it is the plain
    // ず-paradigm 終止形 and `rereadSecondReading` writes the entry's own second
    // reading unchanged. See `TERMINAL_PARTICLE_READINGS`.
    expect(prose(closedBy("乎"))).toBe("未だ果てずや");
  });

  it("…and writes ざる before a 詠嘆 哉, read かな", () => {
    // かな is か + な and takes 体言・連体形, so it is carried by the ざり paradigm
    // exactly as なり and のみ are — the arm added to `attributiveParticleAhead`
    // when 哉 was corrected from 終止形 to 連体形.
    expect(prose(closedBy("哉"))).toBe("未だ果てざるかな");
  });

  it("…and before a 邪, read か", () => {
    // The particle that still binds after や left the set. 邪 reads か through
    // `SENTENCE_FINAL_PARTICLES` (and `overrides.json`, which agrees), and か is
    // 連体形接続.
    expect(prose(closedBy("邪"))).toBe("未だ果てざるか");
  });

  it("writes ざる before a nominalizing 者", () => {
    // The reader's own instruction, and now the same form the suffixal 不 takes
    // in the same slot: 未知者 is いまだ知らざる者, which is what kanbun kundoku
    // conventionally writes for this character, and 不知者 is 知らざる者
    // (`negationForm`'s `modifiesNominal` arm, which wrote ぬ until kanbun.info
    // was counted: 704 attributive ざる, no attributive ぬ). 見 resolves 下二段ヤ行 here, so the 未然形 is 見え.
    const withNominalizer: Sentence = {
      tokens: [
        tok({ id: 0, text: "未", lemma: "未", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "見", lemma: "見", pos: "VERB", dep: "mod", head: 2 }),
        tok({ id: 2, text: "者", lemma: "者", pos: "PART", dep: "ROOT", head: 2 }),
        tok({ id: 3, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 2 }),
      ],
    };
    expect(prose(withNominalizer)).toContain("ざる");
  });

  it("leaves the bare ず alone where nothing attaches to it", () => {
    // The rule only fires for something *carried*. A 未 closing a sentence on
    // its own keeps the 終止形 ず the table states, which is the whole of what
    // 未果 has always been.
    const bare: Sentence = {
      tokens: [
        tok({ id: 0, text: "未", lemma: "未", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "果", lemma: "果", pos: "VERB", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "。", lemma: "。", pos: "PUNCT", dep: "punct", head: 1 }),
      ],
    };
    expect(prose(bare)).toBe("未だ果てず");
  });

  it("keeps 未學禮而不知 exactly as it was — a coordinate clause is still outside", () => {
    // `rereadCloseIn` now drops two kinds of token from the clause, and the
    // older of them must go on being dropped: 未's ず closes on 學 and not on
    // the 知 of the clause coordinated onto it.
    expect(prose(coordinatedUnderReread)).toBe("未だ禮を學ばずして知らず");
  });
});

// ---------------------------------------------------------------------------
// The same second reading in both panels.
//
// The reader's report: *the reading of 未…也 is inconsistent between kundoku and
// kakikudashi.* It was. The 書き下し文 asked `rereadSecondReading` — 未's ず
// inflects for what stands after the clause it closes on, and before an
// assertive 也 that is the ざり paradigm's 連体形 ざる — while the 訓読文 drew
// `REREAD_CHARACTERS`'s own `second` down the character's left-hand side, which
// is the uninflected ず the prose only starts from. Over the recoded gold
// (68,893 sentences, 2,457 characters read twice) the two panels wrote
// different strings for **175** of them, every one a 未, and 未之有也 came out
// いまだ之れ有ら**ザル**なり in the prose against a bare **ズ** in the ruby.
//
// The fix is the codebase's own rule rather than a second copy of the
// inflection: one function, asked by both panels with the same arguments. What
// stood in the way was that they write the reading in different places — the
// prose as an ending at the token the clause closes on, the 訓読文 beside the
// 再読文字 itself — so the closing token is now the function's own to find
// (`rereadCloseId`, the inverse of the map `reorderEngine.ts` builds) instead
// of an argument only one caller could supply.
//
// Asserted on both sides here, from verbatim gold: the string the 訓読文 puts
// in `.reread-second` is the string the 書き下し文 emits as its ending piece.
// ---------------------------------------------------------------------------
describe("a 再読文字's second reading, as both panels write it", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const historicalKana = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;
  const resolver = createReadingResolver(kanjidic, jmdict, historicalKana);

  /** 未之有也。 — KR2e0003_224_par1_174-177#4, copied out of the gold whole.
   * The reader's own anchor for this report. */
  const NOT_YET_HAD = [
    "1\t未\t未\tADV\tv,副詞,否定,有界\tPolarity=Neg\t3\tmod\t_\tGloss=not-yet|SpaceAfter=No",
    "2\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp@expl\t_\tGloss=[3PRON]|SpaceAfter=No",
    "3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\tGloss=have|SpaceAfter=No",
    "4\t也\t也\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\tGloss=[final-particle]|SpaceAfter=No",
    "5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No",
  ].join("\n");

  /** 將入門，— KR1h0004_006_par15_1-2#2, likewise verbatim. The other half of
   * the set: 將 asserts rather than negates, so its んとす has nothing to
   * inflect for and both panels must go on writing the table's own string. */
  const ABOUT_TO_ENTER = [
    "1\t將\t將\tADV\tv,副詞,時相,将来\tAdvType=Tim|Tense=Fut\t2\tmod\t_\tGloss=about-to|SpaceAfter=No",
    "2\t入\t入\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\tGloss=enter|SpaceAfter=No",
    "3\t門\t門\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t2\tcomp:obj\t_\tGloss=gate|SpaceAfter=No",
    "4\t，\t，\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\tSpaceAfter=No",
  ].join("\n");

  /** The gold block as the app itself receives it — through the parser, not as
   * token literals — and planned with the panels' own call shape: both of them
   * pass the indexes to `findCompoundSpans`, and the one-argument form spans a
   * different text. */
  const planOf = (conllu: string): ReadingPlan => {
    const sentence = parseConllu(`${conllu}\n`).sentences[0];
    return computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict }));
  };

  /** What the 訓読文 draws down the 再読文字's own side (`.reread-second`), and
   * what the 書き下し文 emits as an ending answering to that same character.
   * The panel katakanizes what it is given (`cellFor`), which is the one thing
   * that differs between the two, and it differs for every reading the ruby
   * carries. */
  const bothPanels = (plan: ReadingPlan, rereadText: string) => {
    const reread = plan.sentence.tokens.find((t) => t.text === rereadText)!;
    return {
      kundoku: rereadSecondReading(reread, plan, resolver),
      prose: generateKakikudashiPieces(plan, resolver)
        .filter((p) => p.kind === "ending" && p.tokenId === reread.id)
        .map((p) => p.text),
    };
  };

  it("writes ざる in both panels for 未之有也", () => {
    const plan = planOf(NOT_YET_HAD);
    expect(generateKakikudashi(plan, resolver)).toBe("未だ之れ有らざるなり");
    const { kundoku, prose } = bothPanels(plan, "未");
    // The bug, stated as the assertion it needed: the ruby's ズ against the
    // prose's ざる, one character of one text saying two things.
    expect(kundoku).toBe("ざる");
    expect(prose).toEqual(["ざる"]);
    expect(toKatakana(kundoku)).toBe("ザル");
  });

  it("writes んとす in both panels for 將入門", () => {
    const plan = planOf(ABOUT_TO_ENTER);
    // The two ends of the double reading and not the whole line: what 入 takes
    // of 門 is a lexical question this rule has no part in, and pinning the
    // sentence here would make this test answer for it.
    const line = generateKakikudashi(plan, resolver);
    expect(line.startsWith("將に")).toBe(true);
    expect(line.endsWith("んとす")).toBe(true);
    const { kundoku, prose } = bothPanels(plan, "將");
    expect(kundoku).toBe("んとす");
    expect(prose).toEqual(["んとす"]);
  });

  it("finds the closing token from the 再読文字 alone", () => {
    // The lookup the 訓読文 needs and the prose never did: `rereadCloseIds` is
    // keyed closing-token -> re-reads, and this panel holds the other end. 未's
    // clause closes on 有, the last real token of what it negates — not on the
    // 也, which is outside that clause (`rereadCloseIn`) and is why the ざる is
    // written before the なり rather than after it.
    const plan = planOf(NOT_YET_HAD);
    const byText = (text: string) => plan.sentence.tokens.find((t) => t.text === text)!.id;
    expect(rereadCloseId(byText("未"), plan)).toBe(byText("有"));
    expect(rereadCloseId(byText("有"), plan)).toBeNull(); // not a 再読文字 at all
  });

  it("keeps the table's own ず where the plan closed the clause nowhere", () => {
    // The stated decision behind the null branch. A re-read the plan recorded
    // no closing token for is one whose clause ends nowhere — the prose then
    // emits nothing for it, since it writes only from that map — and there is
    // no "what follows the clause" for the ず to inflect for. The 終止形 the
    // table states is what the ruby shows alone, exactly as it did before this
    // function was reachable from that panel.
    const plan = planOf(NOT_YET_HAD);
    const unclosed: ReadingPlan = { ...plan, rereadCloseIds: new Map() };
    const mi = plan.sentence.tokens.find((t) => t.text === "未")!;
    expect(rereadSecondReading(mi, unclosed, resolver)).toBe("ず");
  });
});

// ---------------------------------------------------------------------------
// **The verb an auxiliary governs is not a 再読文字.** Under SUD, `comp:aux`
// hangs the governed predicate below 能/可/敢, so a 應 or 當 attached that way
// is the plain verb "to respond" or "to withstand". Read as the construction,
// the verb was moved to the front of its clause as まさに…べし, and 能 then lost
// the complement it is read after: 其人不能應也 came out 其の人能はず應にべしなり
// against the received 其の人應ふる能はざるなり. See `COMPLEMENT_OF_AUXILIARY`.
// ---------------------------------------------------------------------------
describe("a 再読文字 governed by an auxiliary", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const historicalKana = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;
  const resolver = createReadingResolver(kanjidic, jmdict, historicalKana);
  const planOf = (conllu: string): ReadingPlan => {
    const sentence = parseConllu(`${conllu}\n`).sentences[0];
    return computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict }));
  };

  /** 其人不能應也。 — 能 AUX root, 應 VERB `comp:aux` of 能: the tree the
   * parser returns for this shape. `negation` swaps in 弗, which the parser
   * attaches the same way. */
  const cannotRespond = (negation: string) =>
    [
      "1\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t2\tdet\t_\t_",
      "2\t人\t人\tNOUN\tn,名詞,人,人\t_\t4\tsubj\t_\t_",
      `3\t${negation}\t${negation}\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_`,
      "4\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_",
      "5\t應\t應\tVERB\tv,動詞,行為,動作\t_\t4\tcomp:aux\t_\t_",
      "6\t也\t也\tPART\tp,助詞,句末,*\t_\t4\tdiscourse@sp\t_\t_",
      "7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_",
    ].join("\n");

  /** 天下莫能當其戰矣。 — utsuryo03#1, verbatim from the parsed corpus. 當 is
   * `comp:aux` of 能 and also holds the verb 戰 as `comp:obj`, which is the
   * clause-heading shape `governedPredicate` accepts; the relation on 當 itself
   * is what has to decline the construction. */
  const NONE_CAN_WITHSTAND = [
    "1\t天\t天\tNOUN\tn,名詞,制度,場\tCase=Loc\t2\tcompound\t_\t_",
    "2\t下\t下\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t4\tsubj\t_\t_",
    "3\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t4\tmod\t_\t_",
    "4\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_",
    "5\t當\t當\tVERB\tv,動詞,行為,動作\t_\t4\tcomp:aux\t_\t_",
    "6\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t7\tsubj\t_\t_",
    "7\t戰\t戰\tVERB\tv,動詞,行為,交流\t_\t5\tcomp:obj\t_\t_",
    "8\t矣\t矣\tPART\tp,助詞,句末,*\t_\t5\tdiscourse@sp\t_\t_",
    "9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_",
  ].join("\n");

  const tokenOf = (plan: ReadingPlan, text: string) => plan.sentence.tokens.find((t) => t.text === text)!;

  for (const negation of ["不", "弗"]) {
    it(`reads 應 once, before the 能 that governs it, under ${negation}`, () => {
      const plan = planOf(cannotRespond(negation));
      expect(isRereadUse(tokenOf(plan, "應"), plan.sentence)).toBe(false);
      expect(plan.rereadCloseIds.size).toBe(0);
      expect(plan.order.indexOf(tokenOf(plan, "應").id)).toBeLessThan(plan.order.indexOf(tokenOf(plan, "能").id));
      // The two ends of the line and not the middle: which reading the lexicon
      // gives 應, and whether 能 takes a こと, are not this rule to settle.
      const line = generateKakikudashi(plan, resolver);
      expect(line.startsWith("其の人應")).toBe(true);
      expect(line.endsWith("能はざるなり")).toBe(true);
      expect(line).not.toContain("べし");
    });
  }

  it("declines 當 even where it holds a verbal object of its own", () => {
    const plan = planOf(NONE_CAN_WITHSTAND);
    const dang = tokenOf(plan, "當");
    expect(governedPredicate(dang, plan.sentence)?.text).toBe("戰");
    expect(isRereadUse(dang, plan.sentence)).toBe(false);
    expect(plan.rereadCloseIds.size).toBe(0);
    const line = generateKakikudashi(plan, resolver);
    expect(line).not.toContain("當に");
    expect(line).not.toContain("べし");
  });
});
