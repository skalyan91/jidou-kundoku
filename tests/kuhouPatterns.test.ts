import { describe, expect, it } from "vitest";
import {
  CAUSATIVE_LEMMAS,
  caseParticleFor,
  decideConjForm,
  isCausedOrPassivePredicate,
  auxiliaryFormFor,
  isMistaggedLocativeVerb,
  negationEnding,
  passiveComplement,
  passiveForm,
  preposedComplement,
  selectForm,
  usesLexiconEntry,
  yuParts,
} from "../src/kakikudashi/conjugationContext.ts";
import { AUXILIARY_LEMMAS, CAUSATIVE, COPULA, EXISTENCE, NECESSITY } from "../src/kakikudashi/bungoConjugation.ts";
import { chosenAuxiliary, chosenReading, chosenReadingParts, clearChosenReading, setChosenReading, storedReadingText } from "../src/reading/chosenReading.ts";
import { isRereadUse } from "../src/kakikudashi/rereadCharacters.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sentence, Token } from "../src/parse/types.ts";

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });

/** 使民戰 as the parser returns it: the causative heads the clause, with
 * the causee as `comp:obj` and the caused predicate as `comp:obl`. */
const causative = (lemma = "使"): Sentence => ({
  tokens: [
    tok({ id: 0, text: lemma, lemma, pos: "VERB", dep: "ROOT", head: 0 }),
    tok({ id: 1, text: "民", lemma: "民", pos: "NOUN", dep: "comp:obj", head: 0 }),
    tok({ id: 2, text: "戰", lemma: "戰", pos: "VERB", dep: "comp:obl", head: 0 }),
  ],
});

/** 被笑 / 見笑 — the two relations the parser uses for the same thing. */
const passive = (lemma: string, dep: string): Sentence => ({
  tokens: [
    tok({ id: 0, text: lemma, lemma, pos: "AUX", dep: "ROOT", head: 0 }),
    tok({ id: 1, text: "笑", lemma: "笑", pos: "VERB", dep, head: 0 }),
  ],
});

describe("使役", () => {
  it("marks the causee をして, not を — it is made to act, not acted on", () => {
    const s = causative();
    expect(caseParticleFor(s.tokens[1], s)).toBe("をして");
  });

  it("puts the caused predicate in 未然形 for the しむ that follows", () => {
    const s = causative();
    expect(isCausedOrPassivePredicate(s.tokens[2], s)).toBe(true);
  });

  it("covers all four causative characters", () => {
    for (const lemma of ["使", "令", "教", "遣"]) {
      expect(CAUSATIVE_LEMMAS.has(lemma)).toBe(true);
      expect(AUXILIARY_LEMMAS[lemma]?.primary).toBe("しむ");
    }
  });

  it("leaves an ordinary object alone", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "飲", lemma: "飲", pos: "VERB", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "酒", lemma: "酒", pos: "NOUN", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).not.toBe("をして");
  });

  it("marks a nominal causee only — never a predicate under the same relation", () => {
    // A causee is a person or a thing made to act; a predicate under the same
    // governor is what it is made to *do*. The relation cannot tell them
    // apart — this parser puts a caused predicate on `comp:obj` too, and
    // 酒蟲's 但令於日中俯臥 (sent_id 20) comes back with 俯 exactly that way —
    // so the particle was written onto the act: 俯臥をして, causee marking on a
    // verb. The POS is what separates them.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "令", lemma: "令", pos: "VERB", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "俯", lemma: "俯", pos: "VERB", dep: "comp:obj", head: 0 }),
        tok({ id: 2, text: "臥", lemma: "臥", pos: "VERB", dep: "flat@vv", head: 1 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).not.toBe("をして");
    // …and 民, a NOUN on the very same relation under the very same governor,
    // still takes it. The two differ in nothing else.
    expect(caseParticleFor(causative("令").tokens[1], causative("令"))).toBe("をして");
  });
});

describe("受身", () => {
  it("recognises both relations the parser uses", () => {
    expect(passiveComplement(passive("被", "comp:aux").tokens[0], passive("被", "comp:aux"))?.text).toBe("笑");
    expect(passiveComplement(passive("見", "comp:obj").tokens[0], passive("見", "comp:obj"))?.text).toBe("笑");
  });

  it("does not turn every 見 into a passive", () => {
    // 見 is "to see" everywhere except where the parser tags it AUX over a
    // predicate; a bare lemma test would rewrite the language.
    const seeing = passive("見", "comp:obj");
    seeing.tokens[0].pos = "VERB";
    expect(passiveComplement(seeing.tokens[0], seeing)).toBeNull();
  });

  it("picks る after an -a mizenkei and らる after any other", () => {
    // 笑ふ is 四段ハ, so 笑は + る.
    expect(passiveForm(tok({ lemma: "笑" })).primary).toBe("る");
    // 見る is 上一段 — no -a row, so らる.
    expect(passiveForm(tok({ lemma: "見" })).primary).toBe("らる");
    expect(passiveForm(null).primary).toBe("らる");
  });
});

describe("比較", () => {
  it("marks a positive 如/若's object with の — never を, and no longer に", () => {
    // This asserted に, on the old rule that a 如 tagged VERB is the 〜に如かず
    // comparative. The corpus overturns that: 如 is VERB 2,526 of 2,920 times
    // and `v,動詞,行為,分類` ("resemble") 2,594, so tagged VERB is what an
    // *ordinary* comparison looks like. 如見 is 見るがごとし.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "如", lemma: "如", pos: "VERB", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "見", lemma: "見", pos: "VERB", dep: "comp:obj", head: 0 }),
      ],
    };
    // **が and not の**, which is what this test's own comment has said all
    // along: 見 is a clause, and a clause standing in a nominal slot is read on
    // its 連体形 with the classical 連体格 が after it. の is for a nominal
    // standard — 游魚の如し. The received text writes が如 90 times and の如 105,
    // and every one of the が follows a 連体形.
    expect(caseParticleFor(s.tokens[1], s)).toBe("が");
  });

  it("keeps に for the negated one — 不如見, 見るに如かず", () => {
    // Negation is what marks 〜に如かず, and it reaches a VERB object as readily
    // as a nominal: 知之者不如好之者.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "如", lemma: "如", pos: "VERB", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "見", lemma: "見", pos: "VERB", dep: "comp:obj", head: 1 }),
      ],
    };
    expect(caseParticleFor(s.tokens[2], s)).toBe("に");
  });

  it("leaves the conditional もし alone — it is neither Degree=Equ nor 分類", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "如", lemma: "如", pos: "ADV", xpos: "v,副詞,判断,推定", dep: "mod", head: 1 }),
        tok({ id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[2], s)).not.toBe("の");
  });
});

describe("preposed complement (賓語前置)", () => {
  /** 唯利是視 — 利 stands before its verb and is resumed by 是. `dep` is
   * the label the treebank gives the preposed element; a hand-corrected
   * parse would carry comp:obj instead. */
  const preposed = (dep: string): Sentence => ({
    tokens: [
      tok({ id: 0, text: "唯", lemma: "唯", pos: "ADV", dep: "mod", head: 3 }),
      tok({ id: 1, text: "利", lemma: "利", pos: "NOUN", dep, head: 3 }),
      tok({ id: 2, text: "是", lemma: "是", pos: "PRON", dep: "comp@expl", head: 3 }),
      tok({ id: 3, text: "視", lemma: "視", pos: "VERB", dep: "ROOT", head: 3 }),
    ],
  });

  it("finds the complement the treebank tags subj", () => {
    const s = preposed("subj");
    expect(preposedComplement(s.tokens[3], s)?.text).toBe("利");
  });

  it("finds it just the same once corrected to comp:obj", () => {
    // The whole point: the label is not the evidence. Keying on subj alone
    // would make the reading get worse the moment someone fixed the tree.
    const s = preposed("comp:obj");
    expect(preposedComplement(s.tokens[3], s)?.text).toBe("利");
  });

  it("marks it をのみ under either label, the 唯 being present", () => {
    for (const dep of ["subj", "comp:obj"]) {
      const s = preposed(dep);
      expect(caseParticleFor(s.tokens[1], s)).toBe("をのみ");
    }
  });

  it("marks it plain を with no exclusive particle", () => {
    // 父母是望 — a resumptive, but nothing opening a focus domain.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "父", lemma: "父", pos: "NOUN", dep: "subj", head: 2 }),
        tok({ id: 1, text: "是", lemma: "是", pos: "PRON", dep: "comp@expl", head: 2 }),
        tok({ id: 2, text: "望", lemma: "望", pos: "VERB", dep: "ROOT", head: 2 }),
      ],
    };
    expect(caseParticleFor(s.tokens[0], s)).toBe("を");
  });

  it("adds no のみ to a 唯 with no resumptive — scope is undetermined there", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "唯", lemma: "唯", pos: "ADV", dep: "mod", head: 2 }),
        tok({ id: 1, text: "利", lemma: "利", pos: "NOUN", dep: "comp:obj", head: 2 }),
        tok({ id: 2, text: "視", lemma: "視", pos: "VERB", dep: "ROOT", head: 2 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).not.toBe("をのみ");
  });

  it("finds nothing without a resumptive", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "人", lemma: "人", pos: "NOUN", dep: "subj", head: 1 }),
        tok({ id: 1, text: "視", lemma: "視", pos: "VERB", dep: "ROOT", head: 1 }),
      ],
    };
    expect(preposedComplement(s.tokens[1], s)).toBeNull();
    // ...and an ordinary subject keeps whatever particle it had.
    expect(caseParticleFor(s.tokens[0], s)).not.toBe("を");
  });

  it("takes the child closest before the resumptive when several precede", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "君", lemma: "君", pos: "NOUN", dep: "subj", head: 3 }),
        tok({ id: 1, text: "利", lemma: "利", pos: "NOUN", dep: "comp:obj", head: 3 }),
        tok({ id: 2, text: "是", lemma: "是", pos: "PRON", dep: "comp@expl", head: 3 }),
        tok({ id: 3, text: "視", lemma: "視", pos: "VERB", dep: "ROOT", head: 3 }),
      ],
    };
    expect(preposedComplement(s.tokens[3], s)?.text).toBe("利");
  });
});

// ---------------------------------------------------------------------------
// Four句法 the reader asked for, each rendered from the tree alone:
//   * a 使役 that is a non-final link in a chain takes 連用形 (しめ);
//   * what a verb of thinking or intention governs takes 未然形 + んと;
//   * a predicate standing in a subject slot takes 連体形 + こと;
//   * a nominal predicate standing before a 而して closes with なり.
// The end-to-end assertions run the real resolver over real parses, so the
// prose asserted is the prose the panel prints.
// ---------------------------------------------------------------------------

const kuhouDataDir = join(process.cwd(), "public", "data");
const kuhouKanjidic = JSON.parse(readFileSync(join(kuhouDataDir, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const kuhouJmdict = JSON.parse(readFileSync(join(kuhouDataDir, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const kuhouHistorical = JSON.parse(readFileSync(join(kuhouDataDir, "historical-kana-index.json"), "utf-8")) as Record<
  string,
  Record<string, string>
>;
const kuhouResolve = createReadingResolver(kuhouKanjidic, kuhouJmdict, kuhouHistorical);
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s));
const prose = (s: Sentence) => generateKakikudashi(planFor(s), kuhouResolve);
const formOf = (s: Sentence, id: number, form = CAUSATIVE) => selectForm(form, planFor(s), id);

describe("使役 — the form the auxiliary itself takes", () => {
  it("states しむ's 連用形, which 下二段 spells the same as its 未然形", () => {
    // The two are しめ and しめ because 下二段's mizen and renyou coincide on
    // the row's e-sound. Both are stated so that a rule wanting one of them
    // can fire; a paradigm whose forms happen to be spelled alike must not be
    // the reason `selectForm` cannot select.
    expect(CAUSATIVE.renyou).toBe("しめ");
    expect(CAUSATIVE.mizen).toBe("しめ");
    expect(CAUSATIVE.primary).toBe("しむ");
  });

  it("takes 連用形 when a further clause is coordinated onto the causation", () => {
    // 王令民戰、而歸 — 歸 is a `conj:coord` of 令, so the causative clause is
    // not the one that ends the sentence: 民をして戰はしめ、而して歸る.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }),
        tok({ id: 1, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 1 }),
        tok({ id: 3, text: "戰", lemma: "戰", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "comp:obl", head: 1 }),
        tok({ id: 4, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 1 }),
        tok({ id: 5, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 6 }),
        tok({ id: 6, text: "歸", lemma: "歸", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "conj:coord", head: 1 }),
      ],
    };
    expect(formOf(s, 1)).toBe("しめ");
  });

  it("keeps 終止形 where the only thing after the 使役 is its own complement", () => {
    // 但令於日中俯臥 (酒蟲 sent_id 20). 俯 hangs off 令 by `parataxis`, which
    // is both the relation this parser falls back to for a caused predicate
    // and the one `COORDINATION_DEPS` reads as an asyndetic conjunct. It is
    // the complement here, so the causation is not handing on to anything and
    // the auxiliary closes: しむ, not しめ.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "但", lemma: "但", pos: "ADV", xpos: "v,副詞,範囲,限定", dep: "mod", head: 1 }),
        tok({ id: 1, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "俯", lemma: "俯", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "parataxis", head: 1 }),
      ],
    };
    expect(isCausedOrPassivePredicate(s.tokens[2], s)).toBe(true);
    expect(formOf(s, 1)).toBe("しむ");
  });

  it("still puts a `comp:obl` complement in 未然形 — the rule that was already right", () => {
    const s = causative("令");
    expect(isCausedOrPassivePredicate(s.tokens[2], s)).toBe(true);
    expect(decideConjForm(s.tokens[2], undefined, s)).toBe("mizen");
  });

  it("refuses a nominal `parataxis` child, which is no caused predicate", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "parataxis", head: 0 }),
      ],
    };
    expect(isCausedOrPassivePredicate(s.tokens[1], s)).toBe(false);
  });
});

/** 思飲酒 as the parser returns it — the intention verb heads the clause and
 * the intended action is its `comp:obj`. */
const intention = (lemma: string): Sentence => ({
  tokens: [
    tok({ id: 0, text: lemma, lemma, pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 }),
    tok({ id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 0 }),
    tok({ id: 2, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 1 }),
  ],
});

describe("意志 — 未然形 + んと under a verb of thinking or intention", () => {
  it("gives the intended action 未然形 and んと, in place of 連体形 and を", () => {
    const s = intention("思");
    expect(decideConjForm(s.tokens[1], undefined, s)).toBe("mizen");
    expect(caseParticleFor(s.tokens[1], s)).toBe("んと");
    expect(prose(s)).toBe("酒を飲まんと思ふ");
  });

  it("covers the hand-listed class, each of which governs a verbal object in the corpus", () => {
    for (const [lemma, expected] of [
      ["思", "酒を飲まんと思ふ"],
      ["願", "酒を飲まんと願ふ"],
      ["謀", "酒を飲まんと謀る"],
      ["念", "酒を飲まんと念す"],
    ] as const) {
      expect(prose(intention(lemma))).toBe(expected);
    }
  });

  it("leaves an ordinary governor's verbal object on 連体形 + を", () => {
    // 不得飲 -> 飲むを得ず. 得 is not a verb of intention, so the standing
    // nominalized-object rule keeps it.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("を");
    expect(decideConjForm(s.tokens[1], undefined, s)).toBe("rentai");
  });

  it("writes no second んと where a 將 is already writing one", () => {
    // 思將歸. 將 is a 再読文字 hanging off 歸 and reads んとす after the clause
    // it governs; `readsLastInItsSubtree` sees it and this rule stands down,
    // so the sentence keeps one まさに…んとす rather than gaining a 思-borne
    // んと on top of it.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "思", lemma: "思", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "將", lemma: "將", pos: "ADV", xpos: "v,副詞,時相,将来", dep: "mod", head: 2, morph: "AdvType=Tim|Tense=Fut" }),
        tok({ id: 2, text: "歸", lemma: "歸", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[2], s)).not.toBe("んと");
    expect(prose(s).match(/んと/g)?.length).toBe(1);
  });

  it("reaches 欲 too, on the `comp:aux` its complement arrives on", () => {
    // **This assertion is the reverse of what it was**, and the reversal is the
    // whole of the 欲 change. 欲 rendered まほし out of `AUXILIARY_LEMMAS` and its
    // complement comes back `comp:aux` rather than the `comp:obj`
    // `INTENTION_VERB_LEMMAS` keys on, so the two constructions could not meet
    // and this test pinned that they did not. `PINNED_ONLY_AUXILIARY_LEMMAS` now
    // reads an unpinned 欲 as the verb 欲す, and what a verb of volition governs
    // is the quoted volition this file is about: 欲飲 is 飲まんと欲す, which is
    // what **122 of the 198** 欲 in kanbun.info's own 書き下し文 write.
    //
    // The table entry stays, and is asserted, because it is what a reader who
    // pins まほし on a particular 欲 gets back.
    expect(AUXILIARY_LEMMAS["欲"]?.primary).toBe("まほし");
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "欲", lemma: "欲", pos: "AUX", xpos: "v,助動詞,願望,*", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:aux", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("んと");
    expect(prose(s)).toContain("飲まんと");
  });

  it("does not reach a 欲 the reader has pinned as まほし", () => {
    // The three arms of `PINNED_ONLY_AUXILIARY_LEMMAS` stand down together: a
    // pinned 欲 *is* the auxiliary, so it governs no quoted volition, writes its
    // own ending and takes its は back.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "欲", lemma: "欲", pos: "AUX", xpos: "v,助動詞,願望,*", dep: "ROOT", head: 0, misc: { Reading: "まほし" } }),
        tok({ id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:aux", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).not.toBe("んと");
  });
});

describe("主語 — 連体形 + こと for a predicate standing in a subject slot", () => {
  /** 去首半尺 — 酒蟲 sent_id 20's closing clause, and the reader's own case:
   * 去 is the `subj` of 半, with its object 首 inverting before it. */
  const removedFromHead: Sentence = {
    tokens: [
      tok({ id: 0, text: "去", lemma: "去", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "subj", head: 2 }),
      tok({ id: 1, text: "首", lemma: "首", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 0 }),
      tok({ id: 2, text: "半", lemma: "半", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "ROOT", head: 2, morph: "Degree=Pos" }),
      tok({ id: 3, text: "尺", lemma: "尺", pos: "NOUN", xpos: "n,名詞,度量衡,*", dep: "comp:obj", head: 2, morph: "NounType=Clf" }),
    ],
  };

  it("nominalizes the subject clause — 首を去ること, not 首を去ぬ", () => {
    expect(decideConjForm(removedFromHead.tokens[0], undefined, removedFromHead)).toBe("rentai");
    expect(caseParticleFor(removedFromHead.tokens[0], removedFromHead)).toBe("こと");
    expect(prose(removedFromHead)).toContain("去ぬること");
  });

  it("carries the こと on the ざる when a negation closes the clause — 不知難", () => {
    // The reader's ruling: *if a negated verb is used as an argument, the
    // negation should be read as ざる.* The object slot already obeyed it
    // (患不知 -> 知らざるを患ふ) and so did the oblique (苦不得飲 ->
    // 飲むを得ざるに苦しむ); the **subject** slot did not, and printed
    // 知ら**ず**難し.
    //
    // Two halves, fixed together because a form with no particle after it is
    // what the pairing exists to prevent: `isNominalizedSubjectPredicate` now
    // skips the postposed negation in its subtree test (a 不 is read *after* its
    // verb, so it was always last and the rule answered no for every negated
    // clause), and `negationEndingParts` grew the `subject` arm that writes the
    // 連体形 ざる and the こと on it. `caseParticleFor` withholds the こと here for
    // the reason the oblique and object branches withhold theirs — written on
    // the verb it would land inside the negation, 知らことず.
    //
    // **113** gold tokens (a 不/未/弗/勿 on `mod` whose head is a VERB or ADJ
    // standing on `subj`), against 1,413 in the object slot and 36 in the
    // oblique; rendering the whole gold both ways moves **88** sentences, every
    // one of them ず/ぬ -> ざること — 君子之不教子 君子のこれ子を教へ**ざること**
    // 何ぞや, 賓弗舉 賓舉げ**ざること**、禮なり.
    const hardNotToKnow: Sentence = {
      tokens: [
        tok({ id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "subj", head: 2 }),
        tok({ id: 2, text: "難", lemma: "難", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 2, morph: "Degree=Pos" }),
      ],
    };
    // Withheld from the verb, because the ず is what stands at the clause's end.
    expect(caseParticleFor(hardNotToKnow.tokens[1], hardNotToKnow)).toBeUndefined();
    const plan = computeReadingOrder(hardNotToKnow, findCompoundSpans(hardNotToKnow));
    expect(negationEnding(hardNotToKnow.tokens[0], plan, kuhouResolve)).toBe("ざること");
    expect(prose(hardNotToKnow)).toBe("知らざること難し");
  });

  it("leaves the *root* and coordinate slots on ず — the ruling is about arguments", () => {
    // 5,376 negations stand on a `root` and 994 on a `conj:coord`, and neither
    // is an argument of anything. Resist widening: 不知 alone is 知らず.
    const justNotKnow: Sentence = {
      tokens: [
        tok({ id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 }),
      ],
    };
    expect(prose(justNotKnow)).toBe("知らず");
  });

  it("gives an *attributive* negation ざる — 不仁者 is 仁ならざる者", () => {
    // The 716 negations whose head stands on `mod` are a different construction
    // from the argument ruling above, and are settled by a different arm: a
    // suffixal 不 modifying a noun or a nominalizer takes the 連体形 **ざる**
    // (`negationForm`'s `modifiesNominal` arm), the same form the 再読文字 未
    // takes there — 挺かざる者 beside いまだ見ざる者. That arm wrote the
    // ず-series ぬ until kanbun.info was counted: its received 書き下し文 have
    // 704 attributive ざる and not one attributive ぬ.
    const notBenevolent: Sentence = {
      tokens: [
        tok({ id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "仁", lemma: "仁", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "mod", head: 2, morph: "Degree=Pos" }),
        tok({ id: 2, text: "者", lemma: "者", pos: "PART", xpos: "p,助詞,接続体言化,*", dep: "ROOT", head: 2 }),
      ],
    };
    // **者 and no は, reversing this file's earlier ruling.** 不仁者 here is a
    // ROOT 者 with nothing after it, and a 者 that closes its clause is a
    // predicate, not a topic — a topic with no comment after it is not a topic.
    // The reader has overridden his own committed anchor to say so; see
    // `isSentenceFinalZhe` in `conjugationContext.ts` and `zheParticleReading`
    // in `readingResolver.ts`. Measured against kanbun.info the change is
    // **−4** (4 passages closer, 3 further, both of the regressions a
    // mis-parse). No なり here because the tree carries no punctuation, and an
    // unpunctuated string asserts nothing (`isPredicationLicensed`) — a
    // punctuated 不仁者。 reads 仁ならざる者なり. What this test is actually for
    // is the ざる of the attributive negation.
    expect(prose(notBenevolent)).toBe("仁ならざる者");
  });

  it("leaves a nominal subject alone", () => {
    // 人不知 — 人 is a NOUN in the same slot and takes no こと.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "subj", head: 2 }),
        tok({ id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" }),
        tok({ id: 2, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 2 }),
      ],
    };
    expect(caseParticleFor(s.tokens[0], s)).not.toBe("こと");
  });

  it("leaves a noun the parser tagged VERB alone — 劉使試之's 使 is an envoy", () => {
    // UPOS VERB, dep `subj`, xpos `n,名詞,人,役割`. `isVerbalXpos` is what
    // keeps a name in a subject slot from being read as a nominalized clause.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "使", lemma: "使", pos: "VERB", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }),
        tok({ id: 1, text: "然", lemma: "然", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 1, morph: "Degree=Pos" }),
      ],
    };
    expect(caseParticleFor(s.tokens[0], s)).not.toBe("こと");
  });

  it("leaves an existential subject alone — 有 heads a predication, not a thing done", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "subj", head: 1 }),
        tok({ id: 1, text: "難", lemma: "難", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "ROOT", head: 1, morph: "Degree=Pos" }),
      ],
    };
    expect(caseParticleFor(s.tokens[0], s)).not.toBe("こと");
  });
});

describe("而して — a nominal predicate before it closes with なり", () => {
  /** 臣、而君明 as the parser returns it: the nominal is the ROOT, the second
   * clause is coordinated onto it, and the 、 before 而 makes it 而して. */
  const vassal: Sentence = {
    tokens: [
      tok({ id: 0, text: "臣", lemma: "臣", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 }),
      tok({ id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 }),
      tok({ id: 3, text: "君", lemma: "君", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 4 }),
      tok({ id: 4, text: "明", lemma: "明", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "conj:coord", head: 0, morph: "Degree=Pos" }),
    ],
  };

  it("writes なり and not にして — 而して is the connective, so the copula closes", () => {
    expect(formOf(vassal, 0, COPULA)).toBe("なり");
    expect(prose(vassal)).toBe("臣なり、而して君は明し");
  });

  it("keeps にして where the 而 is a plain て and no mark precedes it", () => {
    // The same tree with the comma taken out: 而 reads て, which is an ending
    // on what precedes, so the copula hands on with its own にして instead.
    const noMark: Sentence = { tokens: vassal.tokens.filter((t) => t.dep !== "punct").map((t) => ({ ...t })) };
    expect(formOf(noMark, 0, COPULA)).toBe("にして");
  });

  it("leaves the 使役's own しめ alone — its 連用形 carries no connective to double", () => {
    // The bound is `renyou.endsWith("して")`: にして contains the connective,
    // しめ is bare 連用中止法, and only the first can be doubled by a 而して.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "戰", lemma: "戰", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "comp:obl", head: 0 }),
        tok({ id: 2, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 }),
        tok({ id: 3, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 }),
        tok({ id: 4, text: "歸", lemma: "歸", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "conj:coord", head: 0 }),
      ],
    };
    expect(formOf(s, 0)).toBe("しめ");
  });

  it("leaves a quantity predication's あり alone", () => {
    // ラ変's 連用形 and 終止形 are both あり, and neither carries a connective,
    // so `isNumeralPredication` still wins wherever it applies.
    expect(EXISTENCE.renyou).toBe("あり");
    expect(EXISTENCE.renyou?.endsWith("して")).toBe(false);
  });
});

describe("中 — the verb, told from the noun by the treebank's own tag", () => {
  it("conjugates where the fine-grained tag says verb — 其曲中規", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "曲", lemma: "曲", pos: "NOUN", xpos: "n,名詞,可搬,伝達", dep: "subj", head: 1 }),
        tok({ id: 1, text: "中", lemma: "中", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 3, morph: "Case=Loc" }),
        tok({ id: 2, text: "規", lemma: "規", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 1 }),
        tok({ id: 3, text: "爲", lemma: "爲", pos: "VERB", xpos: "v,動詞,行為,生産", dep: "ROOT", head: 3 }),
      ],
    };
    expect(isMistaggedLocativeVerb(s.tokens[1])).toBe(true);
    expect(usesLexiconEntry(s.tokens[1])).toBe(true);
  });

  it("stays the noun 中 where the tag says noun — 於日中's 'in the daytime'", () => {
    // 酒蟲 sent_id 20. Same dep and same `Case=Loc`, and an adposition's object
    // rather than a predicate's: 日中 is a place in time, and it was coming out
    // 日の中る — a verb inside a prepositional phrase.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "mod@lmod", head: 3 }),
        tok({ id: 1, text: "日", lemma: "日", pos: "NOUN", xpos: "n,名詞,時,*", dep: "mod", head: 2, morph: "Case=Tem" }),
        tok({ id: 2, text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "comp:obj", head: 0, morph: "Case=Loc" }),
        tok({ id: 3, text: "俯", lemma: "俯", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 3 }),
      ],
    };
    expect(isMistaggedLocativeVerb(s.tokens[2])).toBe(false);
    expect(usesLexiconEntry(s.tokens[2])).toBe(false);
    // 日中, not 日の中: the two stand side by side and kanbun.info writes the
    // pair bare 6 times in 6 (see `isJuxtaposedNominalTerm`). What this test
    // is about is the other half — that 中 stays the noun.
    expect(prose(s)).toContain("日中");
    expect(prose(s)).not.toContain("中る");
  });

  it("trusts the UPOS where a tree carries no xpos at all", () => {
    // A hand-written tree behaves as it did before the tag became the
    // tie-breaker — the same fallback `isVerbalXpos` makes everywhere else.
    expect(isMistaggedLocativeVerb(tok({ text: "中", lemma: "中", pos: "NOUN", dep: "comp:obj", head: 1, morph: "Case=Loc" }))).toBe(
      true,
    );
  });
});

describe("於 — より replaces the character, おいて is written on it", () => {
  /** 坐於堂 / 取之於藍 — the same `mod@lmod` on 於 in both, which is the whole
   * reason the sense cannot be read off the dep. */
  const yu = (verbLemma: string, verbXpos: string, placeLemma: string, placeXpos: string): Sentence => ({
    tokens: [
      tok({ id: 0, text: verbLemma, lemma: verbLemma, pos: "VERB", xpos: verbXpos, dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "mod@lmod", head: 0 }),
      tok({ id: 2, text: placeLemma, lemma: placeLemma, pos: "NOUN", xpos: placeXpos, dep: "comp:obj", head: 1, morph: "Case=Loc" }),
    ],
  });

  it("splits the locative reading お + いて and keeps the kanji", () => {
    const s = yu("坐", "v,動詞,行為,動作", "堂", "n,名詞,固定物,建造物");
    expect(yuParts(s.tokens[1], s)).toEqual({ reading: "お", okurigana: "いて" });
    expect(prose(s)).toContain("於いて");
  });

  it("marks the place に — the reading is a verb form and does not carry the case", () => {
    const s = yu("坐", "v,動詞,行為,動作", "堂", "n,名詞,固定物,建造物");
    expect(caseParticleFor(s.tokens[2], s)).toBe("に");
    expect(prose(s)).toBe("堂に於いて坐る");
  });

  it("leaves 取之於藍 alone — the identical dep, the source sense", () => {
    // 取 is not a locative governor, so 於 stays より, the character is not
    // written, and 藍 takes nothing. A rule keyed on `mod@lmod` read
    // 藍に於いて取る.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "取", lemma: "取", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", dep: "comp:obj", head: 0, morph: "Person=3|PronType=Prs" }),
        tok({ id: 2, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "mod@lmod", head: 0 }),
        tok({ id: 3, text: "藍", lemma: "藍", pos: "PROPN", xpos: "n,名詞,固定物,地名", dep: "comp:obj", head: 2, morph: "Case=Loc|NameType=Geo" }),
      ],
    };
    expect(yuParts(s.tokens[2], s)).toEqual({ okurigana: "より" });
    expect(caseParticleFor(s.tokens[3], s)).toBeUndefined();
    expect(prose(s)).toBe("之を藍より取る");
  });

  it("adds 俯/臥 to the locative governors — 但令於日中俯臥", () => {
    // 酒蟲 sent_id 20, on the reader's own corrected tree: 於 hangs off 俯.
    // Lying down happens *at* a place, so this is the 坐/居/處 criterion and
    // not a new one; the line read 日中より俯臥せしむ before.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "mod@lmod", head: 3 }),
        tok({ id: 1, text: "日", lemma: "日", pos: "NOUN", xpos: "n,名詞,時,*", dep: "mod", head: 2, morph: "Case=Tem" }),
        tok({ id: 2, text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "comp:obj", head: 0, morph: "Case=Loc" }),
        tok({ id: 3, text: "俯", lemma: "俯", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 3 }),
      ],
    };
    expect(yuParts(s.tokens[0], s)?.reading).toBe("お");
    expect(caseParticleFor(s.tokens[2], s)).toBe("に");
    expect(prose(s)).toContain("日中に於いて");
  });

  it("marks a benefactive 為's object の — 為人謀 is 人のために謀る", () => {
    // The second adposition read as a content word, and the second whose object
    // therefore has to be marked in front of it: ため is a noun, "the sake", so
    // what it is the sake *of* stands in the genitive exactly as 日中 does in
    // front of 於いて. The reader's rule; the line read 人ために謀る before it.
    //
    // ADP is the whole of the condition, because ADP is what keys the ために in
    // `overrides.json` — the same character is the copula たり at
    // `comp:pred`/ROOT and the verb なす everywhere else. **857** nominal
    // `comp:obj` of an ADP 為/爲 in the recoded gold (NOUN 430, PROPN 217,
    // PRON 210), and rendering the whole gold both ways moves **799** sentences,
    // every one of them Xために -> Xのために.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "為", lemma: "為", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "mod", head: 2 }),
        tok({ id: 1, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 0 }),
        tok({ id: 2, text: "謀", lemma: "謀", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 2 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("の");
    expect(prose(s)).toContain("人のために");
  });

  it("marks a *clausal* object of the same 為 が, on a 連体形 — 為無後也 is 後無きが爲なり", () => {
    // The reader's ruling, put to him as が against の: *"Use が."* A clause is
    // not a noun and の after a 連体形 is not a reading of 文語 — 後無**しの**爲
    // is what の would print — so the two halves are decided together by one
    // predicate (`isPurposiveWeiComplement`), the 連体形 in `decideConjForm` and
    // the が here, exactly as the object/subject/oblique nominalizations already
    // are. **155** predicate `comp:obj` of an ADP 為/爲 in the recoded gold
    // (VERB 132, ADJ 23), which is the population; rendering the 979 gold
    // sentences that hold an ADP 為 both ways moves **150** of them, every one
    // of them adding the が and the 連体形 in front of an existing ために.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "為", lemma: "為", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "mod", head: 2 }),
        tok({ id: 1, text: "無", lemma: "無", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 0, morph: "Polarity=Neg" }),
        tok({ id: 2, text: "然", lemma: "然", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 2 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("が");
    expect(decideConjForm(s.tokens[1], undefined, s)).toBe("rentai");
  });

  it("moves that が onto the ざる where a negation closes the clause", () => {
    // The fourth branch of `caseParticleFor` to stand down in front of a
    // postposed negation, and it stands down for their one reason: the 不 is
    // read *after* the predicate, so a が written on the predicate would land in
    // front of it (倦まがず). `negationEndingParts` writes it on the 連体形 ざる
    // instead — 王特為臣之右手不倦賞臣 is 王ただ臣の右の手倦ま**ざるが**ために臣を
    // 賞む. **3** of the gold's 155 complements are negated this way.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "為", lemma: "為", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "mod", head: 3 }),
        tok({ id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" }),
        tok({ id: 2, text: "倦", lemma: "倦", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "comp:obj", head: 0 }),
        tok({ id: 3, text: "賞", lemma: "賞", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "ROOT", head: 3 }),
      ],
    };
    expect(caseParticleFor(s.tokens[2], s)).toBeUndefined();
    const plan = computeReadingOrder(s, findCompoundSpans(s));
    expect(negationEnding(s.tokens[1], plan, kuhouResolve)).toBe("ざるが");
  });

  it("leaves the 為-phrase's *matrix* clause alone — the 43 `mod` predicates are not complements", () => {
    // 迎貓，為其食田鼠也: gold makes the ADP 為 the root, its `comp:obj` the
    // reason (其食田鼠) and its **`mod`** the thing done for it (迎貓). The two
    // were once counted together in the overrides table's note on 為/爲, which
    // now separates them; measured, they are a different edge — 43 VERB/ADJ
    // `mod` dependents, every one sampled a matrix clause. が there would read
    // 貓を迎ふる**が**爲に其れ田鼠を食らふ, which turns the sentence inside out.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "迎", lemma: "迎", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "mod", head: 2 }),
        tok({ id: 1, text: "貓", lemma: "貓", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "comp:obj", head: 0 }),
        tok({ id: 2, text: "為", lemma: "為", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "ROOT", head: 2 }),
        tok({ id: 3, text: "食", lemma: "食", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 2 }),
      ],
    };
    expect(caseParticleFor(s.tokens[3], s)).toBe("が");
    expect(caseParticleFor(s.tokens[0], s)).toBeUndefined();
  });

  it("marks a *pronoun* object of the same 為 が, not の — 我がために", () => {
    // The reader's ruling for the closed class, beside the clausal one: が is
    // the 文語 連体格 after a pronoun (我が, 誰が, 己が, 之が) where a noun takes
    // の, and 我**の**ために is not a reading. **210** PRON `comp:obj` of an ADP
    // 為/爲 in the recoded gold — 之 92, 何 46, 我 19, 己 9, 奚 8, 自 8, 余 7,
    // 子 7 and a tail — and 208 of the 979 gold sentences with an ADP 為 in them
    // move, every one Xのために -> Xがために. The interrogatives come with the
    // rest rather than being carved out: 何**が**故に is the ordinary kundoku of
    // exactly this frame.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "為", lemma: "為", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "mod", head: 2 }),
        tok({ id: 1, text: "我", lemma: "我", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "comp:obj", head: 0, morph: "Person=1|PronType=Prs" }),
        tok({ id: 2, text: "辭", lemma: "辭", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("が");
  });

  it("writes that が exactly once — the reading's own particle stands the rule down", () => {
    // The pronoun's が is the particle half only: 我 on `comp:obj` reads われ,
    // with nothing in its okurigana slot, so the が this function writes is the
    // only one on the page. Were the わ + が override ever widened past `det` to
    // reach this slot, `ownReadingSuppliesCaseParticle` is what would keep the
    // page from printing わが**が** — a conditioned entry, a closed-class tag,
    // and an okurigana that is a slot-marking particle whole. Asserted here with
    // the pin, which is the same evidence read the same way and the one route a
    // test can take without editing `overrides.json`.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "為", lemma: "為", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "mod", head: 2 }),
        tok({ id: 1, text: "我", lemma: "我", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "comp:obj", head: 0, morph: "Person=1|PronType=Prs" }),
        tok({ id: 2, text: "辭", lemma: "辭", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 }),
      ],
    };
    setChosenReading(s.tokens[1], "わ", "が");
    expect(caseParticleFor(s.tokens[1], s)).toBeUndefined();
    clearChosenReading(s.tokens[1]);
    expect(caseParticleFor(s.tokens[1], s)).toBe("が");
  });

  it("stands the case particle down where the reading has already written one — ためにに, わがに", () => {
    // The doubling both splits made visible and neither created. An ADP 為 reads
    // ため + に and 吾 on `det` わ + が, and a particle drawn from the token's own
    // relation lands after that reading: 非爲趙也 printed 趙のために**に**あらず
    // (the に from `negatedPredicate`) and 吾有司死者 わが**に**有司 (the に from
    // `isExistentialLocus`, which reads the determiner standing in front of 有 as
    // the place). **15** of the gold's 1,045 ADP 為/爲 and **1** of its 393 `det`
    // pronouns draw one; rendering every gold sentence that holds such a token
    // both ways moves exactly those 16 and nothing else.
    const denied: Sentence = {
      tokens: [
        tok({ id: 0, text: "非", lemma: "非", pos: "ADV", xpos: "v,副詞,否定,体言否定", dep: "mod", head: 1 }),
        tok({ id: 1, text: "爲", lemma: "爲", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "趙", lemma: "趙", pos: "PROPN", xpos: "n,名詞,固定物,国", dep: "comp:obj", head: 1, morph: "NameType=Nat" }),
      ],
    };
    expect(caseParticleFor(denied.tokens[1], denied)).toBeUndefined();
    expect(prose(denied)).toContain("爲に非ず");
    expect(prose(denied)).not.toContain("ためにに");

    // 吾有司死者 — 吾 is 司's `det`, 有 its sibling, and the two are adjacent in
    // that order, which is `isExistentialLocus`'s own signature.
    const locus: Sentence = {
      tokens: [
        tok({ id: 0, text: "吾", lemma: "吾", pos: "PRON", xpos: "n,代名詞,人称,起格", dep: "det", head: 2, morph: "Person=1|PronType=Prs" }),
        tok({ id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "mod", head: 2, morph: "VerbForm=Part" }),
        tok({ id: 2, text: "司", lemma: "司", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "ROOT", head: 2 }),
      ],
    };
    expect(caseParticleFor(locus.tokens[0], locus)).toBeUndefined();
    expect(prose(locus)).not.toContain("わがに");
  });

  it("keeps 於いて's own に, whose okurigana only looks like a particle", () => {
    // お + いて is a verb form and not a word plus a case particle, so the
    // stand-down must not see it: its object's に comes from the branch above
    // the adposition rule and 日中**に**於**いて** is what that combination is
    // written for. The distinction is exact match against the particle — `"に"`
    // is ために's whole okurigana and none of いて — rather than a suffix test,
    // which would have caught both.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "於", lemma: "於", pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "mod@lmod", head: 3 }),
        tok({ id: 1, text: "日", lemma: "日", pos: "NOUN", xpos: "n,名詞,時,*", dep: "mod", head: 2, morph: "Case=Tem" }),
        tok({ id: 2, text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "comp:obj", head: 0, morph: "Case=Loc" }),
        tok({ id: 3, text: "俯", lemma: "俯", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 3 }),
      ],
    };
    expect(caseParticleFor(s.tokens[2], s)).toBe("に");
    expect(prose(s)).toContain("日中に於いて");
  });

  it("leaves the copula 為 and the verb 為 alone — the tag is the whole condition", () => {
    // 為 at `comp:pred` over VERB is the copula たり and its complement takes と
    // (`predicativeComplementParticle`); a 為 that is a plain verb takes を on
    // its object. Neither is an ADP and neither reaches the の.
    const asVerb: Sentence = {
      tokens: [
        tok({ id: 0, text: "為", lemma: "為", pos: "VERB", xpos: "v,動詞,行為,生産", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(asVerb.tokens[1], asVerb)).toBe("を");
  });

  it("leaves 自's object alone — 有朋自遠方來", () => {
    // The same adposition branch, and the suppression there is deliberate:
    // より is complete on its own.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "朋", lemma: "朋", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "subj", head: 5 }),
        tok({ id: 2, text: "自", lemma: "自", pos: "ADP", xpos: "v,前置詞,経由,*", dep: "mod", head: 5 }),
        tok({ id: 3, text: "遠", lemma: "遠", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "comp:obj", head: 2, morph: "Degree=Pos" }),
        tok({ id: 4, text: "方", lemma: "方", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "mod", head: 5, morph: "Case=Loc" }),
        tok({ id: 5, text: "來", lemma: "來", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[3], s)).toBeUndefined();
    expect(prose(s)).not.toContain("により");
  });
});

describe("並列の目的語 — the case particle closes the phrase, not its head", () => {
  /** 縶手足 — 手 carries the object relation and 足 is coordinated onto it. */
  const boundHandAndFoot: Sentence = {
    tokens: [
      tok({ id: 0, text: "縶", lemma: "縶", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "手", lemma: "手", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 0 }),
      tok({ id: 2, text: "足", lemma: "足", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "conj:coord", head: 1 }),
    ],
  };

  it("writes を after the last conjunct, not after the head", () => {
    expect(caseParticleFor(boundHandAndFoot.tokens[1], boundHandAndFoot)).toBeUndefined();
    expect(caseParticleFor(boundHandAndFoot.tokens[2], boundHandAndFoot)).toBe("を");
    expect(prose(boundHandAndFoot)).toBe("手足を縶る");
  });

  it("leaves an uncoordinated object exactly where it was", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("を");
  });

  it("carries the relation down a chain of three", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "食", lemma: "食", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "魚", lemma: "魚", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "comp:obj", head: 0 }),
        tok({ id: 2, text: "肉", lemma: "肉", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "conj:coord", head: 1 }),
        tok({ id: 3, text: "菜", lemma: "菜", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "conj:coord", head: 2 }),
      ],
    };
    expect(s.tokens.slice(1).map((t) => caseParticleFor(t, s))).toEqual([undefined, undefined, "を"]);
  });

  it("does not drag a particle across a `parataxis` edge", () => {
    // The mixed relation `isNonFinalCoordinand` documents: only an explicit
    // coordinator makes two nominals one phrase, so the head keeps its own を.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "縶", lemma: "縶", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "手", lemma: "手", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 0 }),
        tok({ id: 2, text: "足", lemma: "足", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "parataxis", head: 1 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("を");
  });

  it("does not follow a *predicate* coordinated onto the object", () => {
    // A verb hanging off the object by `conj:coord` is a second clause, and a
    // second clause is not a second thing the first one's を marks.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 0 }),
        tok({ id: 2, text: "歌", lemma: "歌", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord", head: 1 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("を");
  });

  it("keeps 食肉飲酒歌舞 — a chain of predicates, not of objects", () => {
    expect(prose(intention("思")).length).toBeGreaterThan(0); // guard: the resolver is live
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "食", lemma: "食", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "肉", lemma: "肉", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 0 }),
        tok({ id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "parataxis", head: 0 }),
        tok({ id: 3, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 2 }),
        tok({ id: 4, text: "歌", lemma: "歌", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "parataxis", head: 2 }),
        tok({ id: 5, text: "舞", lemma: "舞", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "parataxis", head: 4 }),
      ],
    };
    expect(prose(s)).toBe("肉を食ひ酒を飲み歌ひ舞ふ");
  });
});

/** 王不可飲酒 as the parser returns it: 可 heads the clause, 不 modifies it,
 * and the verb it governs hangs off it by `comp:aux`. The negation is what
 * makes this the discriminating sentence — the auxiliary has to reach its own
 * 未然形 べから, which is the one form a frozen べし cannot produce. */
const negatedPotential = (lemma = "可"): Sentence => ({
  tokens: [
    tok({ id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 2 }),
    tok({ id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", morph: "Polarity=Neg", dep: "mod", head: 2 }),
    tok({ id: 2, text: lemma, lemma, pos: "AUX", xpos: "v,助動詞,可能,*", morph: "Mood=Pot", dep: "ROOT", head: 2 }),
    tok({ id: 3, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:aux", head: 2 }),
    tok({ id: 4, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 3 }),
  ],
});

/** 王須飲酒 — a 再読文字 in the construction, where 須 is read twice
 * (すべからく…ベシ) unless the reader says otherwise. */
const necessity = (): Sentence => ({
  tokens: [
    tok({ id: 0, text: "王", lemma: "王", pos: "PROPN", xpos: "n,名詞,人,役割", morph: "NameType=Sur", dep: "subj", head: 1 }),
    tok({ id: 1, text: "須", lemma: "須", pos: "AUX", xpos: "v,動詞,行為,動作", morph: "Mood=Nec", dep: "ROOT", head: 1 }),
    tok({ id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:aux", head: 1 }),
    tok({ id: 3, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "comp:obj", head: 2 }),
  ],
});

describe("a hand-picked auxiliary inflects, because it goes back through the auxiliary", () => {
  it("recognises every one of the eleven characters' own auxiliary, and only as a whole word", () => {
    // The recognition is the whole mechanism, and it needs no stored field of
    // its own: `AUXILIARY_LEMMAS` is keyed on the lemma and each character has
    // exactly one auxiliary, so "the stored reading is this character's
    // auxiliary" is a question the stored reading already answers.
    for (const [lemma, form] of Object.entries(AUXILIARY_LEMMAS)) {
      expect(chosenAuxiliary({ lemma, misc: { Reading: form.primary } })).toBe(form);
      // …and not a stem-plus-ending pick that merely starts the same way.
      // KANJIDIC2 lists 可 as べ.し and べ.き, which are a different claim — a
      // 可 read as an adjective in its own right, kanji retained — and the
      // reader who picks one of those must still get it.
      expect(chosenAuxiliary({ lemma, misc: { Reading: form.primary.slice(0, 1), Okurigana: form.primary.slice(1) } })).toBeUndefined();
      expect(chosenAuxiliary({ lemma, misc: { Reading: "よく" } })).toBeUndefined();
    }
    // A character with no auxiliary of its own is never mistaken for one,
    // whatever it is read as.
    expect(chosenAuxiliary({ lemma: "飲", misc: { Reading: "べし" } })).toBeUndefined();
  });

  it("recognises the same choice made through `overrides.json`, which stores the identical string", () => {
    // 可's own override entry states べし and 使/令/教/敎's state しむ, with no
    // okurigana in either case — the same shape the auxiliary arm of the menu
    // produces, and frozen the same way until now. Read from the shipped table
    // rather than restated, so a later edit to it cannot quietly fall out of
    // this claim.
    //
    // **敎 joined the list**, and it is the reason this assertion is worth
    // making: the override table has carried both spellings of the character
    // all along, while `AUXILIARY_LEMMAS` held only 教 — so a しむ picked on 敎
    // was stored and never recognised, which is exactly the freezing this
    // whole `describe` is about. The treebank lemmatizes the character 敎 in
    // all 338 of its occurrences, so 敎 was the spelling the app actually met.
    const overrides = JSON.parse(
      readFileSync(join(process.cwd(), "src/reading/overrides.json"), "utf8"),
    ) as { char: string; reading: string; okurigana?: string }[];
    const recognised = overrides.filter(
      (o) => AUXILIARY_LEMMAS[o.char] && chosenAuxiliary({ lemma: o.char, misc: { Reading: o.reading, ...(o.okurigana ? { Okurigana: o.okurigana } : {}) } }),
    );
    expect(recognised.map((o) => `${o.char}${o.reading}`).sort()).toEqual(["令しむ", "使しむ", "可べし", "可べし", "敎しむ", "教しむ"]);
  });

  it("stands the hand-picked branch of both panels down, so the auxiliary branch behind it renders the cell", () => {
    const s = negatedPotential();
    const ka = s.tokens[2];
    setChosenReading(ka, "べし");
    expect(chosenReadingParts(ka)).toBeNull();
    expect(chosenReading(ka)).toBeNull();
    // …while what is stored is still there to be read, which is what the menu's
    // 自動 item and `isRereadUse` go on asking.
    expect(storedReadingText(ka)).toBe("べし");
  });

  it("reaches べからず before a following ず, where a frozen pick printed 可べしず", () => {
    const s = negatedPotential();
    expect(prose(s)).toBe("王は酒を飲む可からず");
    setChosenReading(s.tokens[2], "べし");
    expect(prose(s)).toBe("王は酒を飲む可からず");
  });

  it("does the same for 能, whose べし no override ever covered", () => {
    // べからず and not 可からず: 能 keeps the kana-only path the modal table has
    // always given it, and 可 no longer does. The received text is what divides
    // them — it writes 可からず and reads 能 as あたはず or よく, never as べし.
    // See `KANJI_RETAINED_AUXILIARIES`, which holds 可 alone for that reason.
    const s = negatedPotential("能");
    setChosenReading(s.tokens[2], "べし");
    expect(prose(s)).toBe("王は酒を飲むべからず");
  });

  it("takes the causative's 連用形 in a chain, exactly as an unpicked one does", () => {
    // 王令民戰、而歸 — the same sentence the 連用形 rule above is stated on.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "王", lemma: "王", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 1 }),
        tok({ id: 1, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 1 }),
        tok({ id: 2, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 1 }),
        tok({ id: 3, text: "戰", lemma: "戰", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "comp:obl", head: 1 }),
        tok({ id: 4, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 1 }),
        tok({ id: 5, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 6 }),
        tok({ id: 6, text: "歸", lemma: "歸", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "conj:coord", head: 1 }),
      ],
    };
    const unaided = prose(s);
    expect(unaided).toContain("しめ");
    setChosenReading(s.tokens[1], "しむ");
    expect(formOf(s, 1)).toBe("しめ");
    expect(prose(s)).toBe(unaided);
  });
});

describe("再読文字 — what picking べし on one of them means", () => {
  it("reads 須 twice while nothing is picked", () => {
    expect(prose(necessity())).toBe("王は須らく酒を飲むべし");
  });

  it("picking べし chooses the plain auxiliary over the double reading", () => {
    // The reader has the 再読 reading on the menu as すべからく…ベシ and picked
    // the other entry instead; that is a choice between the character's two
    // constructions, and this is the one it names. `isRereadUse` declines the
    // construction on the strength of the stored reading, and `auxiliaryFormFor`
    // — which would otherwise decline in turn, leaving 須 read as the verb
    // もちゐる — goes through with the auxiliary because the reader asked for it.
    const s = necessity();
    setChosenReading(s.tokens[1], "べし");
    expect(isRereadUse(s.tokens[1], s)).toBe(false);
    expect(auxiliaryFormFor(s.tokens[1], s)).toBe(NECESSITY);
    expect(prose(s)).toBe("王は酒を飲むべし");
  });

  it("leaves every other choice on 須 exactly where it was — a character used in its own right", () => {
    // 須 read もちゐる is the ordinary verb "to need", which is what the
    // 再読 gate has always been for; the auxiliary must not be forced onto it.
    const s = necessity();
    setChosenReading(s.tokens[1], "もち", "いる", "kami-ichidan");
    expect(isRereadUse(s.tokens[1], s)).toBe(false);
    expect(auxiliaryFormFor(s.tokens[1], s)).toBeUndefined();
    expect(chosenReadingParts(s.tokens[1])).not.toBeNull();
  });

  it("goes back to すべからく…ベシ when the choice is cleared", () => {
    const s = necessity();
    setChosenReading(s.tokens[1], "べし");
    clearChosenReading(s.tokens[1]);
    expect(prose(s)).toBe("王は須らく酒を飲むべし");
  });
});

// ---------------------------------------------------------------------------
// The reader's two questions about 使役, answered from the gold treebank:
// which relation a causative's *verbal* complement stands on (both, and the
// 未然形 has to follow either), and what a negation inside that complement
// does (未然形 ざら, not 終止形 ず).
// ---------------------------------------------------------------------------

describe("使役 — either relation puts the verbal complement in 未然形", () => {
  /** 使民戰 with the causee and the caused predicate on a chosen pair of
   * relations. Gold writes both arrangements — see `isCausedPredicateOf`. */
  const swap = (lemma: string, causeeDep: string, predicateDep: string): Sentence => ({
    tokens: [
      tok({ id: 0, text: lemma, lemma, pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: causeeDep, head: 0 }),
      tok({ id: 2, text: "戰", lemma: "戰", pos: "VERB", xpos: "v,動詞,行為,交流", dep: predicateDep, head: 0 }),
    ],
  });

  it("reads 使民戰 the same on `comp:obj` as on `comp:obl`", () => {
    // The defect the reader named. `comp:obj` is not a mis-annotation: gold
    // has 332 verbal complements of a causative on it against 1,138 on
    // `comp:obl`, and for 敎 it is the majority (35 against 19). On the
    // relation this rule did not admit, 戰 fell to
    // `isNominalizedObjectPredicate` and came out 民をして戰**ふを**しむ — a
    // 連体形 and an object marker between the act and the auxiliary that
    // causes it.
    expect(prose(swap("使", "comp:obj", "comp:obl"))).toBe("民をして戰はしむ");
    expect(prose(swap("使", "comp:obj", "comp:obj"))).toBe("民をして戰はしむ");
  });

  it("puts the causee をして on either relation too", () => {
    // The mirror image, and the same finding. 敎民戰's causee comes back on
    // `comp:obl` — 13 of gold's 敎 do, 后稷教民稼穡 and 教民睦也 among them —
    // and a rule keyed on `comp:obj` alone marked it with the oblique's に.
    expect(prose(swap("敎", "comp:obl", "comp:obj"))).toBe("民をして戰はしむ");
    expect(caseParticleFor(swap("敎", "comp:obl", "comp:obj").tokens[1], swap("敎", "comp:obl", "comp:obj"))).toBe("をして");
  });

  it("still refuses a nominal complement, whichever relation carries it", () => {
    // The bound on both halves. What a causative governs that is genuinely
    // *nominal* is not a caused predicate and takes no 未然形 — the POS is
    // what separates the causee from the act, and it does so on every edge.
    for (const dep of ["comp:obj", "comp:obl", "parataxis"]) {
      const s: Sentence = {
        tokens: [
          tok({ id: 0, text: "令", lemma: "令", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 }),
          tok({ id: 1, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep, head: 0 }),
        ],
      };
      expect(isCausedOrPassivePredicate(s.tokens[1], s), dep).toBe(false);
    }
  });

  it("leaves a nominalized object under a non-causative alone", () => {
    // The guard added to `isNominalizedObjectPredicate` is the causative's
    // claim on its own complement and nothing wider: 不得飲 is still 飲むを得ず.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "得", lemma: "得", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(decideConjForm(s.tokens[1], undefined, s)).toBe("rentai");
    expect(caseParticleFor(s.tokens[1], s)).toBe("を");
  });
});

describe("使役 over a negation — 未然形 ざら, not 終止形 ず", () => {
  /** 使民不飢 — the negation sits inside the caused predicate, so the ず is
   * what stands immediately in front of the しむ. */
  const negatedCause = (predicateDep: string): Sentence => ({
    tokens: [
      tok({ id: 0, text: "使", lemma: "使", pos: "VERB", xpos: "v,動詞,行為,使役", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 0 }),
      tok({ id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" }),
      tok({ id: 3, text: "飢", lemma: "飢", pos: "VERB", xpos: "v,動詞,変化,生理", dep: predicateDep, head: 0 }),
    ],
  });

  it("reads 使民不飢 as 民をして飢ゑざらしむ", () => {
    // The ず series has a 未然形 slot and it is the fossilised ずは/ずば; a
    // 助動詞 attaching after a negation takes the ざり series, which is what
    // ず+あり was contracted for. The page printed 飢ゑ**ず**しむ.
    for (const dep of ["comp:obl", "comp:obj"]) {
      expect(prose(negatedCause(dep)), dep).toBe("民をして飢ゑざらしむ");
    }
  });

  it("leaves an ordinary negation at ず", () => {
    // The bound: the ざら is the auxiliary's claim on the negation that stands
    // in front of it, not a change to what a negation is.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" }),
        tok({ id: 1, text: "飢", lemma: "飢", pos: "VERB", xpos: "v,動詞,変化,生理", dep: "ROOT", head: 1 }),
      ],
    };
    expect(prose(s)).toBe("飢ゑず");
  });
});
