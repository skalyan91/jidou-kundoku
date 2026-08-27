import { describe, expect, it } from "vitest";
import { isRereadUse, rereadCharacter, REREAD_CHARACTERS } from "../src/kakikudashi/rereadCharacters.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

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
