import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gluedPunctuationTokens, splitGluedPunctuation } from "../src/parse/splitGluedPunctuation.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Token } from "../src/parse/types.ts";

/** Shorthand for a token, in the style `deprojectivize.test.ts` already
 * uses — id, text, relation, head, and whatever else a particular case
 * needs to check (`misc`, a non-default `pos`/`xpos`). */
function tok(id: number, text: string, dep: string, head: number, extra?: Partial<Token>): Token {
  return { id, text, lemma: text, pos: "NOUN", xpos: "n,名詞,可搬,道具", dep, head, ...extra };
}

/** Every token reaches exactly one self-loop root by walking `head`, within
 * `n` steps — the same connectedness check `deprojectivize.test.ts` runs,
 * copied rather than imported since it is three lines and this file has no
 * other reason to depend on that one. */
function isConnectedTree(tokens: Token[]): boolean {
  const roots = tokens.filter((t) => t.head === t.id);
  if (roots.length !== 1) return false;
  const root = roots[0].id;
  for (const t of tokens) {
    let cur = t.id;
    let steps = 0;
    while (cur !== root && steps <= tokens.length) {
      cur = tokens[cur].head;
      steps++;
    }
    if (cur !== root) return false;
  }
  return true;
}

/** ids run 0..n-1 with no gaps and no repeats, and every token's own
 * position in the array agrees with its `id` — the shape every consumer of
 * `Sentence.tokens` is written against. */
function idsAreContiguous(tokens: Token[]): boolean {
  return tokens.every((t, i) => t.id === i);
}

describe("gluedPunctuationTokens — the guard", () => {
  it("catches a punctuation mark fused to the character it has nothing to do with", () => {
    // The report's own example, reproduced as a token: a full stop that
    // should have closed the sentence before it, glued instead to the
    // 干 that opens the next one.
    const tokens = [tok(0, "。干", "root", 0)];
    expect(gluedPunctuationTokens(tokens)).toEqual(tokens);
  });

  it("does not flag an ordinary multi-character word", () => {
    // 君子, 孔子, 三百 and the like — 1,725 occurrences across this app's own
    // fixtures, none of them a fault. A multi-character token is not by
    // itself the defect; mixing a mark into one is.
    const tokens = [tok(0, "君子", "subj", 1), tok(1, "疾", "root", 1)];
    expect(gluedPunctuationTokens(tokens)).toEqual([]);
  });

  it("does not flag a bare punctuation token, single- or multi-character", () => {
    const tokens = [tok(0, "。", "punct", 0, { pos: "PUNCT" }), tok(1, "、", "punct", 0, { pos: "PUNCT" })];
    expect(gluedPunctuationTokens(tokens)).toEqual([]);
  });

  it("fails against the raw tree the parser actually produces, before this module runs", () => {
    // 樊遲未達。子曰、… — one of `kanbun-info-parses.conllu`'s twelve measured
    // cases, the full stop closing 達's clause fused onto the 子 that opens
    // the next. This is what a reader would have hit before this module
    // existed; the guard has to say so.
    const raw = [
      tok(0, "樊", "subj", 3, { pos: "PROPN", xpos: "n,名詞,人,姓氏" }),
      tok(1, "遲", "flat", 0, { pos: "PROPN", xpos: "n,名詞,人,名" }),
      tok(2, "未", "mod", 3, { pos: "ADV", xpos: "v,副詞,否定,有界" }),
      tok(3, "達", "ROOT", 3, { pos: "VERB", xpos: "v,動詞,行為,動作" }),
      tok(4, "。子", "comp:obj", 3, { pos: "NOUN", xpos: "n,名詞,可搬,道具" }),
      tok(5, "曰", "parataxis", 3, { pos: "VERB", xpos: "v,動詞,行為,伝達" }),
    ];
    expect(gluedPunctuationTokens(raw)).toEqual([raw[4]]);
    // And the fix removes exactly the thing the guard was complaining about.
    const [fixed] = splitGluedPunctuation([raw]);
    expect(gluedPunctuationTokens(fixed)).toEqual([]);
  });
});

describe("splitGluedPunctuation — leaves clean sentences alone", () => {
  it("does not touch a sentence with nothing glued in it", () => {
    const sentence = [tok(0, "君子", "subj", 1), tok(1, "疾", "ROOT", 1), tok(2, "。", "punct", 1, { pos: "PUNCT" })];
    const [out] = splitGluedPunctuation([sentence]);
    expect(out).toEqual(sentence);
  });

  it("passes an empty sentence through unchanged", () => {
    expect(splitGluedPunctuation([[]])).toEqual([[]]);
  });
});

describe("splitGluedPunctuation — a leading mark immediately after a verb of saying", () => {
  // 舜曰、皋陶、蠻夷猾夏、寇賊姦軌。 (`、皋陶` measured in kanbun-info-parses.conllu):
  // the quotative comma right after 曰 fused onto the two-character name that
  // opens the quotation. 曰 already has rightward children of its own (its
  // whole quotation), so the climb from the preceding token stops on its
  // first step and the mark attaches directly to 曰 — the same place a bare
  // `、` between 曰 and a quotation always attaches elsewhere in this corpus.
  const sentence = [
    tok(0, "舜", "subj", 1, { pos: "PROPN", xpos: "n,名詞,人,名" }),
    tok(1, "曰", "ROOT", 1, { pos: "VERB", xpos: "v,動詞,行為,伝達" }),
    tok(2, "、皋陶", "comp:obj", 1, { pos: "PROPN", xpos: "n,名詞,人,名", misc: { NameType: "Giv" } }),
    tok(3, "猾", "conj:coord", 1, { pos: "ADJ", xpos: "v,動詞,描写,態度" }),
  ];

  it("splits the mark off and keeps the name whole", () => {
    const [out] = splitGluedPunctuation([sentence]);
    expect(out.map((t) => t.text)).toEqual(["舜", "曰", "、", "皋陶", "猾"]);
  });

  it("attaches the mark to 曰, not to the name it introduces", () => {
    const [out] = splitGluedPunctuation([sentence]);
    const mark = out.find((t) => t.text === "、")!;
    expect(mark.pos).toBe("PUNCT");
    expect(mark.xpos).toBe("s,記号,読点,*");
    expect(mark.dep).toBe("punct");
    expect(mark.head).toBe(out.find((t) => t.text === "曰")!.id);
  });

  it("keeps the name's own relation, tag and pin, unmoved onto the mark", () => {
    const [out] = splitGluedPunctuation([sentence]);
    const name = out.find((t) => t.text === "皋陶")!;
    expect(name.pos).toBe("PROPN");
    expect(name.xpos).toBe("n,名詞,人,名");
    expect(name.dep).toBe("comp:obj");
    expect(name.head).toBe(out.find((t) => t.text === "曰")!.id);
    expect(name.misc).toEqual({ NameType: "Giv" });
    const mark = out.find((t) => t.text === "、")!;
    expect(mark.misc).toBeUndefined();
  });

  it("leaves a well-formed, contiguously-numbered tree behind", () => {
    const [out] = splitGluedPunctuation([sentence]);
    expect(idsAreContiguous(out)).toBe(true);
    expect(isConnectedTree(out)).toBe(true);
  });
});

describe("splitGluedPunctuation — climbing past a leaf to the clause's own head", () => {
  // 太宗曰、卿爲我擇古陳法、悉圖以上 in full (太,宗 dropped below — subj/mod of 曰,
  // and immaterial to what this test checks). The trailing comma in
  // `法、` is *not* one of the twelve measured cases — this app's own
  // fixtures hold it as two tokens already, 法 and a separate `、`, both
  // correctly headed on 擇 in the gold tree. Fused here on purpose, to ask
  // whether the climb this module runs re-derives an attachment already
  // known correct rather than one merely plausible.
  //
  // 法 is a leaf (no rightward children), so the climb does not stop on
  // its own head 擇: 擇's subtree also happens to end exactly at 法, so it
  // climbs one step further — and stops there, because 曰's subtree runs
  // on past this point into 悉圖以上 (曰's own `parataxis`), which is
  // exactly why that clause is kept in the sentence at all rather than
  // trimmed for brevity: drop it and the climb would run all the way to
  // 曰 instead, testing the root case this module's other tests already
  // cover rather than the intermediate one this one is for.
  //
  //   曰(0,ROOT) - 卿(1,subj of 擇) - 爲(2,mod of 擇) - 我(3,comp:obj of 爲)
  //   - 擇(4,comp:obj of 曰) - 古(5,mod of 陳) - 陳(6,mod of 法) - 法、(7, glued)
  //   - 悉(8,mod of 圖) - 圖(9,subj of 以) - 以(10,parataxis of 曰)
  //   - 上(11,comp:obj of 以)
  const sentence = [
    tok(0, "曰", "ROOT", 0, { pos: "VERB", xpos: "v,動詞,行為,伝達" }),
    tok(1, "卿", "subj", 4, { pos: "PROPN", xpos: "n,名詞,人,名" }),
    tok(2, "爲", "mod", 4, { pos: "VERB", xpos: "v,前置詞,源泉,*" }),
    tok(3, "我", "comp:obj", 2, { pos: "PRON", xpos: "n,代名詞,人称,止格" }),
    tok(4, "擇", "comp:obj", 0, { pos: "VERB", xpos: "v,動詞,行為,動作" }),
    tok(5, "古", "mod", 6, { pos: "NOUN", xpos: "n,名詞,時,*" }),
    tok(6, "陳", "mod", 7, { pos: "VERB", xpos: "v,動詞,行為,伝達" }),
    tok(7, "法、", "comp:obj", 4, { pos: "NOUN", xpos: "n,名詞,制度,儀礼" }),
    tok(8, "悉", "mod", 9, { pos: "ADV", xpos: "v,副詞,範囲,総括" }),
    tok(9, "圖", "subj", 10, { pos: "VERB", xpos: "v,動詞,行為,動作" }),
    tok(10, "以", "parataxis", 0, { pos: "VERB", xpos: "v,動詞,行為,動作" }),
    tok(11, "上", "comp:obj", 10, { pos: "NOUN", xpos: "n,名詞,固定物,関係" }),
  ];

  it("attaches the trailing mark to 擇, one step above the leaf it is glued to", () => {
    const [out] = splitGluedPunctuation([sentence]);
    const mark = out.find((t) => t.text === "、")!;
    const content = out.find((t) => t.text === "法")!;
    const governing = out.find((t) => t.text === "擇")!;
    expect(mark.dep).toBe("punct");
    expect(mark.head).toBe(governing.id);
    // And the content keeps exactly the attachment it always had.
    expect(content.head).toBe(governing.id);
    expect(content.dep).toBe("comp:obj");
  });

  it("leaves a well-formed tree behind", () => {
    const [out] = splitGluedPunctuation([sentence]);
    expect(idsAreContiguous(out)).toBe(true);
    expect(isConnectedTree(out)).toBe(true);
  });
});

describe("splitGluedPunctuation — a leading mark with a previous sentence to close", () => {
  // 謂接連前矛、馬冒其目也。 split by the parser into two `doc.sents` groups at
  // exactly the wrong place (`、馬` measured): the first ends with no
  // trailing mark of its own, and the comma that should have closed it
  // opens the second instead, fused to 馬. `provisionalSentences.ts`
  // documents the same `sent_join` habit of re-heading a clause onto
  // whatever the previous unit happened to end at; this is that habit
  // reaching a token's own text instead of an arc.
  const previous = [
    tok(0, "謂", "ROOT", 0, { pos: "VERB", xpos: "v,動詞,行為,伝達" }),
    tok(1, "接", "comp:obj", 0, { pos: "VERB", xpos: "v,動詞,行為,設置" }),
    tok(2, "連", "flat@vv", 1, { pos: "VERB", xpos: "v,動詞,行為,動作" }),
    tok(3, "前", "mod", 4, { pos: "NOUN", xpos: "n,名詞,固定物,関係" }),
    tok(4, "矛", "comp:obj", 1, { pos: "NOUN", xpos: "n,名詞,可搬,道具" }),
  ];
  const next = [
    tok(0, "、馬", "ROOT", 0, { pos: "NOUN", xpos: "v,動詞,行為,動作" }),
    tok(1, "冒", "flat@vv", 0, { pos: "VERB", xpos: "v,動詞,行為,動作" }),
    tok(2, "其", "det", 3, { pos: "PRON", xpos: "n,代名詞,人称,起格" }),
    tok(3, "目", "comp:obj", 0, { pos: "NOUN", xpos: "n,名詞,不可譲,身体" }),
  ];

  it("moves the mark onto the previous sentence rather than leaving it in this one", () => {
    const [prevOut, nextOut] = splitGluedPunctuation([previous, next]);
    expect(nextOut.map((t) => t.text)).toEqual(["馬", "冒", "其", "目"]);
    expect(prevOut.map((t) => t.text)).toEqual(["謂", "接", "連", "前", "矛", "、"]);
  });

  it("attaches the moved mark to 謂, the same root a genuine trailing 。 would climb to", () => {
    const [prevOut] = splitGluedPunctuation([previous, next]);
    const mark = prevOut.find((t) => t.text === "、")!;
    const root = prevOut.find((t) => t.text === "謂")!;
    expect(mark.dep).toBe("punct");
    expect(mark.pos).toBe("PUNCT");
    expect(mark.head).toBe(root.id);
  });

  it("keeps 馬's own analysis, root included, once the mark is gone", () => {
    const [, nextOut] = splitGluedPunctuation([previous, next]);
    const horse = nextOut.find((t) => t.text === "馬")!;
    expect(horse.pos).toBe("NOUN");
    expect(horse.dep).toBe("ROOT");
    expect(horse.head).toBe(horse.id);
  });

  it("leaves both sentences well-formed and contiguously numbered", () => {
    const [prevOut, nextOut] = splitGluedPunctuation([previous, next]);
    expect(idsAreContiguous(prevOut)).toBe(true);
    expect(isConnectedTree(prevOut)).toBe(true);
    expect(idsAreContiguous(nextOut)).toBe(true);
    expect(isConnectedTree(nextOut)).toBe(true);
  });
});

describe("splitGluedPunctuation — a leading mark with nothing before it at all", () => {
  it("falls back to attaching the mark as if it followed its own content", () => {
    // The document's very first sentence opening on a fused mark: measured
    // nowhere in this app's fixtures, but not a shape the algorithm may
    // simply refuse. There is no previous sentence to have closed, so the
    // least wrong reading is the ordinary trailing rule applied to the
    // token's own content.
    const sentence = [tok(0, "、卿", "ROOT", 0, { pos: "PROPN", xpos: "n,名詞,人,名" })];
    const [out] = splitGluedPunctuation([sentence]);
    expect(out.map((t) => t.text)).toEqual(["、", "卿"]);
    const mark = out.find((t) => t.text === "、")!;
    const content = out.find((t) => t.text === "卿")!;
    expect(mark.head).toBe(content.id);
    expect(content.head).toBe(content.id); // still the sentence's root
    expect(idsAreContiguous(out)).toBe(true);
    expect(isConnectedTree(out)).toBe(true);
  });
});

describe("splitGluedPunctuation — a trailing mark on the last word of a fragment", () => {
  // 一曰慈、 (measured): three tokens, the comma trailing the last one with
  // nothing after it in this sentence at all. 慈 has no rightward children
  // of its own, so the climb continues past it to 曰 (ROOT) and stops there
  // — the ordinary sentence-final attachment, reached here by a medial mark
  // only because chunking cut the document off mid-list.
  const sentence = [
    tok(0, "一", "subj", 1, { pos: "NUM", xpos: "n,数詞,数字,*" }),
    tok(1, "曰", "ROOT", 1, { pos: "VERB", xpos: "v,動詞,行為,伝達" }),
    tok(2, "慈、", "comp:obj", 1, { pos: "ADP", xpos: "s,記号,括弧開,*" }),
  ];

  it("climbs past the leaf content all the way to the sentence's root", () => {
    const [out] = splitGluedPunctuation([sentence]);
    expect(out.map((t) => t.text)).toEqual(["一", "曰", "慈", "、"]);
    const mark = out.find((t) => t.text === "、")!;
    const root = out.find((t) => t.text === "曰")!;
    expect(mark.head).toBe(root.id);
    expect(mark.dep).toBe("punct");
  });

  it("keeps the content's own (here, oddly-tagged) analysis rather than repairing it", () => {
    // The parser's own POS/DEPREL for 慈 here are already wrong in a way
    // this module has no business fixing — splitting the token is not the
    // same project as correcting the model's syntax, and the instruction is
    // to keep the content half's original relation and tag exactly as
    // given, however little sense either makes on its own.
    const [out] = splitGluedPunctuation([sentence]);
    const content = out.find((t) => t.text === "慈")!;
    expect(content.pos).toBe("ADP");
    expect(content.xpos).toBe("s,記号,括弧開,*");
    expect(content.dep).toBe("comp:obj");
  });
});

// ---------------------------------------------------------------------------
// The measurement this module's own header comment quotes — run against the
// real fixture rather than asserted from memory, wherever this machine has
// it. `kanbun-info-parses.conllu` is gitignored (`kanbunInfoCorpus.test.ts`
// explains why) and built locally by `scripts/build-kanbun-info-corpus.py`,
// so this skips on a fresh checkout exactly as that suite does, and is not
// itself part of either ratchet: it reads the same file but writes no
// baseline and asserts no distance, only the token count this module exists
// to drive to zero.
// ---------------------------------------------------------------------------

const PARSES_PATH = join(import.meta.dirname, "fixtures", "kanbun-info-parses.conllu");

if (existsSync(PARSES_PATH)) {
  describe("splitGluedPunctuation — measured against the real corpus", () => {
    const tree = parseConllu(readFileSync(PARSES_PATH, "utf-8"));
    const raw = tree.sentences.map((s) => s.tokens);
    const rawGlued = raw.flatMap(gluedPunctuationTokens);

    it("finds glued tokens in the untouched parse — the guard failing on an unfixed tree", () => {
      // The number the header comment above quotes. A change here is a real
      // change in what the shipped wheel's tokenizer does and is worth
      // re-reading that comment over; it is not expected to move on its own.
      expect(rawGlued.length).toBe(12);
    });

    it("removes every one of them once split", () => {
      const fixed = splitGluedPunctuation(raw);
      expect(fixed.flatMap(gluedPunctuationTokens)).toEqual([]);
    });

    it("keeps every sentence a well-formed, contiguously-numbered tree", () => {
      const fixed = splitGluedPunctuation(raw);
      for (const sentence of fixed) {
        expect(idsAreContiguous(sentence)).toBe(true);
        expect(isConnectedTree(sentence)).toBe(true);
      }
    });

    it("changes the token count by exactly one new token per glued mark", () => {
      const fixed = splitGluedPunctuation(raw);
      const before = raw.reduce((n, s) => n + s.length, 0);
      const after = fixed.reduce((n, s) => n + s.length, 0);
      // Every measured case peels off exactly one mark (see this module's
      // header on the shapes), so splitting a glued token always adds
      // exactly one token — never zero, never two.
      expect(after - before).toBe(rawGlued.length);
    });
  });
} else {
  describe("splitGluedPunctuation — measured against the real corpus", () => {
    it.skip("kanbun-info-parses.conllu is not built on this machine", () => {});
  });
}
