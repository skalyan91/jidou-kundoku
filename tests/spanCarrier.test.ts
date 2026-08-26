import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import { carrierOf } from "../src/kundoku/spanCarrier.ts";

function makeToken(overrides: Partial<Token>): Token {
  return { id: 0, text: "", lemma: "", pos: "", xpos: "", dep: "", head: 0, ...overrides };
}

describe("carrierOf", () => {
  it("prefers the member with an INVERT-classified dep over a plain mod", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 3, text: "遠", dep: "comp:obj", head: 0 }),
        makeToken({ id: 4, text: "方", dep: "mod", head: 5 }),
      ],
    };
    const span = { tokenIds: [3, 4], text: "遠方" };
    expect(carrierOf(span, sentence).id).toBe(3);
  });

  it("breaks a tie (neither member INVERT) to the first token in source order", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 2, text: "君", dep: "ROOT", head: 2 }),
        makeToken({ id: 3, text: "子", dep: "flat", head: 2 }),
      ],
    };
    const span = { tokenIds: [2, 3], text: "君子" };
    expect(carrierOf(span, sentence).id).toBe(2);
  });

  it("picks the earliest INVERT member when both are INVERT-classified", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 5, text: "A", dep: "comp:obj", head: 9 }),
        makeToken({ id: 6, text: "B", dep: "comp:obl", head: 9 }),
      ],
    };
    const span = { tokenIds: [5, 6], text: "AB" };
    expect(carrierOf(span, sentence).id).toBe(5);
  });
});
