import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isRereadUse, rereadCharacter, rereadGovernedForm, REREAD_CHARACTERS } from "../src/kakikudashi/rereadCharacters.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { conjugatedOkurigana, negationForm } from "../src/kakikudashi/conjugationContext.ts";
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
    const notYet = rereadOverVerb("未");
    expect(isRereadUse(notYet.tokens[0], notYet)).toBe(true);
    const aboutTo = rereadOverVerb("将", "comp:aux", "AUX");
    expect(isRereadUse(aboutTo.tokens[0], aboutTo)).toBe(true);
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
    expect(pieces(negatedAlone("可"))).toContain("べから");
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
    expect(generateKakikudashi(computeReadingOrder(mustLearn, []), resolve)).toBe("すべからく學ぶべし");
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
