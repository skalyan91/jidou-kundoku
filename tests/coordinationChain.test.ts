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

  /** 食肉飲酒歌舞。 as the parser actually returns it — the chain is *not*
   * flat: 飲 hangs off 食, but 歌 hangs off 飲, one link further down. */
  function nestedChain(): { sentence: Sentence; shi: Token; yin: Token; ge: Token } {
    const shi = makeToken({ id: 0, text: "食", dep: "ROOT", head: 0 });
    const rou = makeToken({ id: 1, text: "肉", pos: "NOUN", dep: "comp:obj", head: 0 });
    const yin = makeToken({ id: 2, text: "飲", dep: "parataxis", head: 0 });
    const jiu = makeToken({ id: 3, text: "酒", pos: "NOUN", dep: "comp:obj", head: 2 });
    const ge = makeToken({ id: 4, text: "歌", dep: "parataxis", head: 2 });
    const wu = makeToken({ id: 5, text: "舞", dep: "comp:obj", head: 4 });
    return { sentence: { tokens: [shi, rou, yin, jiu, ge, wu] }, shi, yin, ge };
  }

  it("follows the chain transitively, so a middle conjunct stays non-final", () => {
    // Reading only one head's direct children saw {食,飲} and {飲,歌} as two
    // separate pairs, made 飲 the last member of the first, and gave it the
    // finite 飲む in mid-sentence: 肉を食ひ酒を飲む舞ふ歌ふ.
    const { sentence, shi, yin, ge } = nestedChain();
    expect([shi, yin, ge].map((t) => isNonFinalCoordinand(t, sentence))).toEqual([true, true, false]);
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

  /** This test used to assert the opposite — "applies to verbs only, an
   * adjective conjunct is left alone" — and passed a conjugation class in a
   * third argument that no longer exists. The exclusion it pinned was a
   * narrowing rather than a claim about the grammar (a non-final adjective
   * conjunct takes 連用形 in classical Japanese: 山高く水長し), and it has been
   * lifted; the answer is now a fact about the tree alone, whatever paradigm
   * the caller will go on to spell it with. See `decideConjForm in a
   * coordination chain` below for the three class shapes end to end. */
  it("does not depend on a conjugation class at all — the tree alone decides", () => {
    const { sentence, first, second } = chain();
    expect(isNonFinalCoordinand(first, sentence)).toBe(true);
    expect(isNonFinalCoordinand(second, sentence)).toBe(false);
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

  /** The four adjectival paradigms used to be refused outright, so a
   * non-final adjective conjunct closed the sentence it was only half of. All
   * four now demote like the verbs; what differs between them is only which
   * 連用形 the paradigm spells — く/しく for the adjectives, に for ナリ, として
   * for タリ. */
  it("demotes an adjectival conjunct too, whichever paradigm it inflects by", () => {
    const { sentence, first, second } = chain();
    for (const cls of ["ku-keiyoushi", "shiku-keiyoushi", "nari-keiyoudoushi", "tari-keiyoudoushi"] as const) {
      expect(decideConjForm(first, second, sentence, cls)).toBe("renyou");
      expect(decideConjForm(second, undefined, sentence, cls)).toBe("shuushi");
    }
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

// ---------------------------------------------------------------------------
// **A full stop ends a chain, and so — again — does a full-width ：.** Both
// ； and ： were held to end one under a rule that let an explicit 而 across;
// the reader withdrew both — *"semicolons should not stop a chain either"* —
// on the argument that neither divider closes a sentence (`punctuation.ts`
// calls both medial, and rightly) and neither closes a construction: a ：
// introduces what follows, reported speech or a list, and a ； joins clauses
// too closely bound to stand apart. The measurement behind the withdrawal was
// that of the 33 coordination chains spanning a ；/： over the recoded gold,
// **26** have 而 as the very next token, so the traffic was almost entirely
// chains the source itself marks as continuing and the 7 left did not pay for
// a rule.
//
// **The 7 pay against kanbun.info, and the reader has since ruled that
// alignment with the received text decides.** Restoring ： alone to
// `CLAUSE_CLOSING_MARKS` reads **21 edits better on that corpus's gold tier and
// level on its parser tier** — 23 passages move, 20 closer and 3 further — and
// every one of them is 論語, because the ： is the *treebank's* mark for a
// boundary kanbun.info's own 白文 writes as a 。. 吾黨之直者、異於是：父爲子隱 is
// the case: the received text closes on 是に異なり and the app was writing the
// 連用中止 異に, having walked the chain on into the next sentence. See that
// table's own doc, which carries the whole argument.
//
// **； is not restored, and neither is the half-width :.** The 而 argument
// above is about ； first of all, and the half-width form is not what any
// source this app measures against writes — the treebank uses ：. Both go on
// leaving the chain running, which is what the parameterised test below now
// asserts of three marks rather than four. 孝弟，而好犯上者，鮮矣 is what that
// still unblocks — 鮮 reads あざやかにして, coordinated across its ； with what
// follows.
// ---------------------------------------------------------------------------
describe("a ； between two conjuncts", () => {
  /** Two predicates coordinated across `mark`, optionally with a 而 after it. */
  function across(mark: string, coordinator?: string): { sentence: Sentence; first: Token } {
    const tokens: Token[] = [
      makeToken({ id: 0, text: "種", lemma: "種", dep: "ROOT", head: 0 }),
      makeToken({ id: 1, text: "黍", lemma: "黍", pos: "NOUN", dep: "comp:obj", head: 0 }),
      makeToken({ id: 2, text: mark, lemma: mark, pos: "PUNCT", dep: "punct", head: 0 }),
    ];
    if (coordinator) {
      tokens.push(makeToken({ id: 3, text: coordinator, lemma: coordinator, pos: "CCONJ", dep: "cc", head: 4 }));
    }
    const at = coordinator ? 4 : 3;
    tokens.push(makeToken({ id: at, text: "富", lemma: "富", pos: "ADJ", dep: "conj:coord", head: 0, morph: "Degree=Pos" }));
    return { sentence: { tokens }, first: tokens[0] };
  }

  it.each([["；"], [";"], [":"]])("leaves the chain running across a %s, with or without a 而", (mark) => {
    // The 而 makes no difference — it was the whole of the old exception, and
    // these marks stop nothing at all, so the two cases have collapsed into
    // one. **The full-width ： has left this list**: it is back in
    // `CLAUSE_CLOSING_MARKS` on the reader's alignment ruling, and the test
    // below is its own. The half-width : stays here, no source this app
    // measures against writing one.
    expect(isNonFinalCoordinand(across(mark).first, across(mark).sentence)).toBe(true);
    const withEr = across(mark, "而");
    expect(isNonFinalCoordinand(withEr.first, withEr.sentence)).toBe(true);
  });

  it("stops at a full-width ：, 而 or no 而", () => {
    // 異於是：父爲子隱 is the shape: the treebank's ： is where kanbun.info ends
    // the sentence, and a chain walked across it demoted a predicate that
    // closes its own. Restoring the mark reads 21 edits better on the gold tier
    // of that corpus and level on the parser tier; see the block comment above.
    expect(isNonFinalCoordinand(across("：").first, across("：").sentence)).toBe(false);
    const withEr = across("：", "而");
    expect(isNonFinalCoordinand(withEr.first, withEr.sentence)).toBe(false);
  });

  it("goes on stopping at a 。, 而 or no 而", () => {
    // The exception is deliberately not extended to a full stop: after one, a
    // 而 opens a new sentence rather than continuing a chain, which is the
    // whole subject of `precededBySourcePunctuation`'s 而して.
    expect(isNonFinalCoordinand(across("。").first, across("。").sentence)).toBe(false);
    const withEr = across("。", "而");
    expect(isNonFinalCoordinand(withEr.first, withEr.sentence)).toBe(false);
  });

  it("leaves a 、 and a ， alone, which divide a list rather than a clause", () => {
    // 490 gold nominal chains stand across a ，; every one is a genuine list.
    expect(isNonFinalCoordinand(across("、").first, across("、").sentence)).toBe(true);
    expect(isNonFinalCoordinand(across("，").first, across("，").sentence)).toBe(true);
  });
});
