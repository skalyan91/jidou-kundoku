import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import { extraEndingFor, ziReading } from "../src/kakikudashi/conjugationContext.ts";

function makeToken(overrides: Partial<Token>): Token {
  return { id: 0, text: "", lemma: "", pos: "", xpos: "", dep: "", head: 0, ...overrides };
}

describe("ziReading", () => {
  it("defaults to し (master/teacher) when 子 has no possessive modifier", () => {
    const token = makeToken({ id: 0, text: "子", dep: "ROOT", head: 0 });
    const sentence: Sentence = { tokens: [token] };
    expect(ziReading(token, sentence)).toBe("し");
  });

  it("reads こ (child) when 子 has a possessive/determiner modifier (its子, 吾子, etc.)", () => {
    const token = makeToken({ id: 1, text: "子", dep: "comp:obj", head: 2 });
    const possessive = makeToken({ id: 0, text: "其", dep: "det", head: 1 });
    const sentence: Sentence = { tokens: [possessive, token] };
    expect(ziReading(token, sentence)).toBe("こ");
  });

  it("returns undefined for any character other than 子", () => {
    const token = makeToken({ id: 0, text: "君", dep: "ROOT", head: 0 });
    const sentence: Sentence = { tokens: [token] };
    expect(ziReading(token, sentence)).toBeUndefined();
  });
});

describe("a clause headed by a particle", () => {
  /** 黃帝者、少典之子 as the parser returns it: 者 heads the clause and the
   * nominal predicate hangs off it as `conj:coord`. */
  const particleHeaded = (predicatePos = "NOUN"): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "帝", lemma: "帝", pos: "NOUN", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "者", lemma: "者", pos: "PART", dep: "ROOT", head: 1 }),
      makeToken({ id: 2, text: "子", lemma: "子", pos: predicatePos, dep: "conj:coord", head: 1 }),
    ],
  });

  it("gives the predicate なり, not the do-verb", () => {
    // 者 marks what the clause is about and predicates nothing itself, so
    // the nominal hanging off it is the predicate: 黃帝 *is* the son of
    // Shaodian, rather than doing anything.
    const s = particleHeaded();
    expect(extraEndingFor(s.tokens[2], s.tokens[1], s)?.primary).toBe("なり");
  });

  it("still reaches for the do-verb under a non-particle head", () => {
    const s: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "學", lemma: "學", pos: "VERB", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "禮", lemma: "禮", pos: "NOUN", dep: "conj:coord", head: 0 }),
      ],
    };
    expect(extraEndingFor(s.tokens[1], s.tokens[0], s)?.primary).toBe("す");
  });

  it("leaves a verbal predicate alone either way", () => {
    const s = particleHeaded("VERB");
    expect(extraEndingFor(s.tokens[2], s.tokens[1], s)).toBeNull();
  });
});
