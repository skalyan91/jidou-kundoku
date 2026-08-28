import { describe, expect, it } from "vitest";
import { isRereadUse, rereadCharacter, rereadGovernedForm, REREAD_CHARACTERS } from "../src/kakikudashi/rereadCharacters.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { conjugatedOkurigana, negationForm } from "../src/kakikudashi/conjugationContext.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { findCompoundSpans } from "../src/reading/jmdictLookup.ts";
import type { Sentence, Token } from "../src/parse/types.ts";
import type { ReadingResolver } from "../src/reading/types.ts";
import { generateKakikudashiPieces } from "../src/kakikudashi/generator.ts";

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

describe("the 再読文字 table", () => {
  it("pairs each character's two readings with the form the predicate takes", () => {
    expect(rereadCharacter("未")).toEqual({ first: "いまだ", second: "ず", form: "mizen" });
    expect(rereadCharacter("須")).toEqual({ first: "すべからく", second: "べし", form: "shuushi" });
    expect(rereadCharacter("猶")).toEqual({ first: "なほ", second: "がごとし", form: "rentai" });
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
    expect(isRereadUse({ text: "未", dep: "mod", pos: "ADV" })).toBe(true);
    expect(isRereadUse({ text: "将", dep: "comp:aux", pos: "AUX" })).toBe(true);
  });

  it("rejects the same characters in their ordinary senses", () => {
    // 且 coordinating two clauses is "moreover", not "on the point of".
    expect(isRereadUse({ text: "且", dep: "cc", pos: "CCONJ" })).toBe(false);
    // 猶 heading its own clause is the plain verb "to resemble".
    expect(isRereadUse({ text: "猶", dep: "ROOT", pos: "VERB" })).toBe(false);
    // 當 as a noun (當時) is not read twice however it attaches.
    expect(isRereadUse({ text: "當", dep: "mod", pos: "NOUN" })).toBe(false);
  });

  it("rejects characters that are not 再読文字 at all", () => {
    expect(isRereadUse({ text: "不", dep: "mod", pos: "ADV" })).toBe(false);
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
   * the kakikudashibun read 來たらず and the ruby read きタル, because only the
   * generator consulted this. The second reading is no token of its own, so
   * `decideConjForm` sees nothing following the predicate and leaves it in
   * 終止形. */
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
    // is たら, against the たる 終止形 the ruby was showing as きタル.
    expect(conjugatedOkurigana(VERB_LEXICON["來"], "mizen")).toBe("たら");
    expect(conjugatedOkurigana(VERB_LEXICON["來"], "shuushi")).toBe("たる");
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
    expect(pieces.filter((p) => p.tokenId === 0).map((p) => p.text)).toEqual(["いまだ", "ず"]);
    // Case particles ride on their own piece field, so the prose is the two
    // joined — the check that splitting the ず off changed nothing readers see.
    expect(pieces.map((p) => p.text + (p.caseParticle ?? "")).join("")).toBe("いまだ禮を學ばず");
  });
});

describe("negation under a re-read character", () => {
  it("takes the ざり-paradigm rentaikei before ごとし, not ぬ", () => {
    expect(negationForm(undefined, "rentai")).toBe("ざる");
  });

  it("is unaffected where no re-read governs it", () => {
    expect(negationForm(undefined)).toBe("ず");
    expect(negationForm(tok({ pos: "NOUN" }))).toBe("ぬ");
  });
});

describe("compound spans", () => {
  it("never absorb a re-read character", () => {
    // Fused into a span, the character is hidden from the reorder engine
    // entirely — span-mates are excluded from a node's children — and comes
    // out as a bare kanji with neither reading.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "盍", lemma: "盍", pos: "VERB", dep: "mod", head: 1 }),
        tok({ id: 1, text: "學", lemma: "學", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(s).some((sp) => sp.tokenIds.includes(0))).toBe(false);
  });
});
