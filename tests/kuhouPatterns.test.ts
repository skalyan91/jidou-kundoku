import { describe, expect, it } from "vitest";
import {
  AUXILIARY_LEMMAS,
  CAUSATIVE_LEMMAS,
  caseParticleFor,
  decideConjForm,
  isCausedOrPassivePredicate,
  isMistaggedLocativeVerb,
  passiveComplement,
  passiveForm,
  preposedComplement,
  selectForm,
  usesLexiconEntry,
  yuParts,
  yuReading,
} from "../src/kakikudashi/conjugationContext.ts";
import { CAUSATIVE, COPULA, EXISTENCE } from "../src/kakikudashi/bungoConjugation.ts";
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
  it("marks 如/若's standard of comparison with に", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "如", lemma: "如", pos: "VERB", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "見", lemma: "見", pos: "VERB", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(caseParticleFor(s.tokens[1], s)).toBe("に");
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
//   * a nominal predicate standing before a しかも closes with なり.
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
    // not the one that ends the sentence: 民をして戰はしめ、しかも歸る.
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

  it("keeps 欲 on its own まほし route — its complement is `comp:aux`, not `comp:obj`", () => {
    expect(AUXILIARY_LEMMAS["欲"]?.primary).toBe("まほし");
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "欲", lemma: "欲", pos: "AUX", xpos: "v,助動詞,願望,*", dep: "ROOT", head: 0 }),
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
      tok({ id: 2, text: "半", lemma: "半", pos: "VERB", xpos: "v,動詞,描写,量", dep: "ROOT", head: 2, morph: "Degree=Pos" }),
      tok({ id: 3, text: "尺", lemma: "尺", pos: "NOUN", xpos: "n,名詞,度量衡,*", dep: "comp:obj", head: 2, morph: "NounType=Clf" }),
    ],
  };

  it("nominalizes the subject clause — 首を去ること, not 首を去ぬ", () => {
    expect(decideConjForm(removedFromHead.tokens[0], undefined, removedFromHead)).toBe("rentai");
    expect(caseParticleFor(removedFromHead.tokens[0], removedFromHead)).toBe("こと");
    expect(prose(removedFromHead)).toContain("去ぬること");
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
        tok({ id: 1, text: "然", lemma: "然", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 1, morph: "Degree=Pos" }),
      ],
    };
    expect(caseParticleFor(s.tokens[0], s)).not.toBe("こと");
  });

  it("leaves an existential subject alone — 有 heads a predication, not a thing done", () => {
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "subj", head: 1 }),
        tok({ id: 1, text: "難", lemma: "難", pos: "VERB", xpos: "v,動詞,描写,形質", dep: "ROOT", head: 1, morph: "Degree=Pos" }),
      ],
    };
    expect(caseParticleFor(s.tokens[0], s)).not.toBe("こと");
  });
});

describe("しかも — a nominal predicate before it closes with なり", () => {
  /** 臣、而君明 as the parser returns it: the nominal is the ROOT, the second
   * clause is coordinated onto it, and the 、 before 而 makes it しかも. */
  const vassal: Sentence = {
    tokens: [
      tok({ id: 0, text: "臣", lemma: "臣", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 }),
      tok({ id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 4 }),
      tok({ id: 3, text: "君", lemma: "君", pos: "NOUN", xpos: "n,名詞,人,役割", dep: "subj", head: 4 }),
      tok({ id: 4, text: "明", lemma: "明", pos: "VERB", xpos: "v,動詞,描写,形質", dep: "conj:coord", head: 0, morph: "Degree=Pos" }),
    ],
  };

  it("writes なり and not にして — しかも is the connective, so the copula closes", () => {
    expect(formOf(vassal, 0, COPULA)).toBe("なり");
    expect(prose(vassal)).toBe("臣なり、しかも君は明し");
  });

  it("keeps にして where the 而 is a plain て and no mark precedes it", () => {
    // The same tree with the comma taken out: 而 reads て, which is an ending
    // on what precedes, so the copula hands on with its own にして instead.
    const noMark: Sentence = { tokens: vassal.tokens.filter((t) => t.dep !== "punct").map((t) => ({ ...t })) };
    expect(formOf(noMark, 0, COPULA)).toBe("にして");
  });

  it("leaves the 使役's own しめ alone — its 連用形 carries no connective to double", () => {
    // The bound is `renyou.endsWith("して")`: にして contains the connective,
    // しめ is bare 連用中止法, and only the first can be doubled by a しかも.
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
    expect(prose(s)).toContain("日の中");
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
    // `yuReading` still answers with the whole string, which is what the
    // 訓読文 panel prints in its okurigana slot.
    expect(yuReading(s.tokens[1], s)).toBe("おいて");
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
    expect(prose(s)).toBe("これを藍より取る");
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
    expect(prose(s)).toContain("日の中に於いて");
  });

  it("leaves 自's object alone — 有朋自遠方來", () => {
    // The same adposition branch, and the suppression there is deliberate:
    // より is complete on its own.
    const s: Sentence = {
      tokens: [
        tok({ id: 0, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "朋", lemma: "朋", pos: "NOUN", xpos: "n,名詞,人,関係", dep: "subj", head: 5 }),
        tok({ id: 2, text: "自", lemma: "自", pos: "ADP", xpos: "v,前置詞,経由,*", dep: "mod", head: 5 }),
        tok({ id: 3, text: "遠", lemma: "遠", pos: "VERB", xpos: "v,動詞,描写,量", dep: "comp:obj", head: 2, morph: "Degree=Pos" }),
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
