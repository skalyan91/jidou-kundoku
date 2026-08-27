import { describe, expect, it } from "vitest";
import {
  AUXILIARY_LEMMAS,
  CAUSATIVE_LEMMAS,
  caseParticleFor,
  isCausedOrPassivePredicate,
  passiveComplement,
  passiveForm,
  preposedComplement,
} from "../src/kakikudashi/conjugationContext.ts";
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
