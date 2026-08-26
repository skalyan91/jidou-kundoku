import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import { ziReading } from "../src/kakikudashi/conjugationContext.ts";

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
