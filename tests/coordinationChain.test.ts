import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import { decideConjForm, isNonFinalCoordinand } from "../src/kakikudashi/conjugationContext.ts";

function makeToken(overrides: Partial<Token>): Token {
  return { id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...overrides };
}

/** 飲酒食肉 as the parser actually returns it: 飲 root, 食 attached to it by
 * `parataxis` (the label it uses for an asyndetic chain), each with its own
 * object. */
function chain(secondDep = "parataxis"): { sentence: Sentence; first: Token; second: Token } {
  const first = makeToken({ id: 0, text: "飲", dep: "ROOT", head: 0 });
  const obj1 = makeToken({ id: 1, text: "酒", pos: "NOUN", dep: "comp:obj", head: 0 });
  const second = makeToken({ id: 2, text: "食", dep: secondDep, head: 0 });
  const obj2 = makeToken({ id: 3, text: "肉", pos: "NOUN", dep: "comp:obj", head: 2 });
  return { sentence: { tokens: [first, obj1, second, obj2] }, first, second };
}

describe("isNonFinalCoordinand", () => {
  it("marks the head of a chain non-final", () => {
    const { sentence, first } = chain();
    expect(isNonFinalCoordinand(first, sentence)).toBe(true);
  });

  it("leaves the last conjunct final — it carries the finite predicate", () => {
    const { sentence, second } = chain();
    expect(isNonFinalCoordinand(second, sentence)).toBe(false);
  });

  it("treats conj:coord the same as parataxis", () => {
    const { sentence, first, second } = chain("conj:coord");
    expect(isNonFinalCoordinand(first, sentence)).toBe(true);
    expect(isNonFinalCoordinand(second, sentence)).toBe(false);
  });

  it("marks every member but the last in a three-verb chain", () => {
    const a = makeToken({ id: 0, text: "修", dep: "ROOT", head: 0 });
    const b = makeToken({ id: 1, text: "齊", dep: "conj:coord", head: 0 });
    const c = makeToken({ id: 2, text: "治", dep: "conj:coord", head: 0 });
    const sentence: Sentence = { tokens: [a, b, c] };
    expect([a, b, c].map((t) => isNonFinalCoordinand(t, sentence))).toEqual([true, true, false]);
  });

  it("ignores a lone predicate with no chain at all", () => {
    const only = makeToken({ id: 0, text: "學", dep: "ROOT", head: 0 });
    expect(isNonFinalCoordinand(only, { tokens: [only] })).toBe(false);
  });

  it("requires a verb at both ends, so a quotative/appositive parataxis is untouched", () => {
    const head = makeToken({ id: 0, text: "子", pos: "NOUN", dep: "ROOT", head: 0 });
    const verb = makeToken({ id: 1, text: "習", dep: "parataxis", head: 0 });
    const sentence: Sentence = { tokens: [head, verb] };
    expect(isNonFinalCoordinand(head, sentence)).toBe(false);
    expect(isNonFinalCoordinand(verb, sentence)).toBe(false);
  });

  it("applies to verbs only — an adjective conjunct is left alone", () => {
    const { sentence, first } = chain();
    expect(isNonFinalCoordinand(first, sentence, "yodan-ma")).toBe(true);
    expect(isNonFinalCoordinand(first, sentence, "shiku-keiyoushi")).toBe(false);
    expect(isNonFinalCoordinand(first, sentence, "nari-keiyoudoushi")).toBe(false);
  });
});

describe("decideConjForm in a coordination chain", () => {
  it("puts a non-final conjunct in renyoukei", () => {
    const { sentence, first, second } = chain();
    expect(decideConjForm(first, second, sentence)).toBe("renyou");
  });

  it("leaves the final conjunct in shuushikei", () => {
    const { sentence, second } = chain();
    expect(decideConjForm(second, undefined, sentence)).toBe("shuushi");
  });

  it("still gives negation the form it governs, chain or not", () => {
    // 學不厭教不倦: 厭 is non-final, but the ず that follows wants 未然形.
    const yan = makeToken({ id: 0, text: "厭", dep: "ROOT", head: 0 });
    const bu = makeToken({ id: 1, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 2 });
    const juan = makeToken({ id: 2, text: "倦", dep: "conj:coord", head: 0 });
    const sentence: Sentence = { tokens: [yan, bu, juan] };
    expect(isNonFinalCoordinand(yan, sentence)).toBe(true);
    expect(decideConjForm(yan, bu, sentence)).toBe("mizen");
  });
});
