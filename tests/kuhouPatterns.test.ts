import { describe, expect, it } from "vitest";
import {
  AUXILIARY_LEMMAS,
  CAUSATIVE_LEMMAS,
  caseParticleFor,
  isCausedOrPassivePredicate,
  passiveComplement,
  passiveForm,
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
