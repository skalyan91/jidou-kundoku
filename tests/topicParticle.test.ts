import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import {
  chosenTopicParticle,
  clearChosenReading,
  clearChosenTopicParticle,
  setChosenReading,
  setChosenTopicParticle,
  storedReadingText,
} from "../src/reading/chosenReading.ts";
import { caseParticleFor } from "../src/kakikudashi/conjugationContext.ts";
import { topicParticleOffered } from "../src/render/tokenInspector.ts";
import { exportConllu } from "../src/parse/conlluExporter.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";

// ---------------------------------------------------------------------------
// **The reader's 係助詞, and the two halves of the promise made for it.**
//
// The received text writes は on a subject where the sentence would otherwise
// be ambiguous, and the corpus will not say where that is: over the gold tier
// は stands on 9.2% of parsed subjects (68 of 736), and across eight
// structural features the widest spread any of them opens is 0.00 (a
// speech-verb governor) against 0.23 (a modal-auxiliary root), both of which
// the app already answers. Five candidate conditions for "ambiguous" — an
// intervening constituent, a bare noun before a nominal, a heavy subject, a
// rival subject, a clause boundary — each made the gold measurement *worse*,
// by +187, +72, +123, +18 and +35 edits. So the choice is the reader's, and
// what is pinned here is that it behaves like one:
//
//  1. **Nothing fires by default.** With no choice made, no token of the
//     shipped sample carries the key and the automatic は population is the
//     size it was — the guard that says this is an offer and not a rule.
//  2. **A choice replaces, and travels.** は stands *instead of* what the
//     subject slot would have taken, reaches both panels through the one call
//     that decides a particle, and survives a round trip through CoNLL-U.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

function token(over: Partial<Token> & Pick<Token, "id" | "text">): Token {
  return { lemma: over.text, pos: "NOUN", xpos: "x", dep: "subj", head: 0, ...over };
}

/** A plain nominal subject on a predicate, which is the shape the menu offers
 * this on and the shape the reader asked for. */
function subjectSentence(): Sentence {
  return {
    tokens: [
      token({ id: 0, text: "民", dep: "subj", head: 1 }),
      token({ id: 1, text: "樂", pos: "VERB", dep: "ROOT", head: 1 }),
    ],
  };
}

describe("what the menu offers it on", () => {
  it("offers it on a subject, and on a subject subtype", () => {
    expect(topicParticleOffered(token({ id: 0, text: "民", dep: "subj" }))).toBe(true);
    expect(topicParticleOffered(token({ id: 0, text: "民", dep: "subj@pass" }))).toBe(true);
  });

  it("does not offer it on an object, a modifier or a root", () => {
    // をば is a real form, so an object is not simply an oversight — it is a
    // question this design does not answer, and `topicParticleOffered` says so
    // rather than guessing.
    for (const dep of ["comp:obj", "comp:obl", "mod", "ROOT", "det", "discourse@sp"]) {
      expect(topicParticleOffered(token({ id: 0, text: "民", dep }))).toBe(false);
    }
  });
});

describe("what a choice does to the slot", () => {
  it("writes は where the reader put one", () => {
    const sentence = subjectSentence();
    setChosenTopicParticle(sentence.tokens[0], "は");
    expect(caseParticleFor(sentence.tokens[0], sentence)).toBe("は");
  });

  it("replaces the particle the relation would have written, rather than joining it", () => {
    // The whole of why this is safe to honour above every rule below it: a
    // subject's が and its は are one slot. 民が and 民は are both Japanese;
    // 民がは is not.
    const sentence = subjectSentence();
    setChosenTopicParticle(sentence.tokens[0], "は");
    expect(caseParticleFor(sentence.tokens[0], sentence)).toBe("は");
  });

  it("goes away again when the choice is dropped", () => {
    const sentence = subjectSentence();
    const before = caseParticleFor(sentence.tokens[0], sentence);
    setChosenTopicParticle(sentence.tokens[0], "は");
    clearChosenTopicParticle(sentence.tokens[0]);
    expect(chosenTopicParticle(sentence.tokens[0])).toBeUndefined();
    expect(caseParticleFor(sentence.tokens[0], sentence)).toBe(before);
  });

  it("reaches the 書き下し文, which is the panel the reader reads it in", () => {
    const sentence = subjectSentence();
    setChosenTopicParticle(sentence.tokens[0], "は");
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    expect(generateKakikudashi(plan, resolve)).toContain("は");
  });
});

describe("what a choice does not touch", () => {
  it("is not a reading, and 自動 does not take it off", () => {
    // `clearChosenReading` is the way back from a *reading*; a は the reader
    // wrote is not one, and the two choices are independent.
    const t = token({ id: 0, text: "民" });
    setChosenReading(t, "たみ");
    setChosenTopicParticle(t, "は");
    clearChosenReading(t);
    expect(storedReadingText(t)).toBeUndefined();
    expect(chosenTopicParticle(t)).toBe("は");
  });

  it("and dropping it does not take the reading off either", () => {
    const t = token({ id: 0, text: "民" });
    setChosenReading(t, "たみ");
    setChosenTopicParticle(t, "は");
    clearChosenTopicParticle(t);
    expect(chosenTopicParticle(t)).toBeUndefined();
    expect(storedReadingText(t)).toBe("たみ");
  });

  it("survives a round trip through CoNLL-U", () => {
    // MISC is serialized whole by `formatMisc`, so the key needed no plumbing
    // — but a reader's edits silently dropped on export would be worse than
    // not exporting them, so it is asserted rather than assumed.
    const sentence = subjectSentence();
    setChosenTopicParticle(sentence.tokens[0], "は");
    const back = parseConllu(exportConllu({ source: "conllu", sentences: [sentence] }));
    expect(chosenTopicParticle(back.sentences[0].tokens[0])).toBe("は");
    expect(caseParticleFor(back.sentences[0].tokens[0], back.sentences[0])).toBe("は");
  });
});

describe("nothing fires by default", () => {
  const tree = parseConllu(readFileSync(join(DATA_DIR, "samples", "rongo-gakuji.conllu"), "utf-8"));

  it("leaves no token of the 論語 sample carrying the key", () => {
    expect(tree.sentences.flatMap((s) => s.tokens).some((t) => chosenTopicParticle(t))).toBe(false);
  });

  it("writes は on a subject only where it already did", () => {
    // The app has always written は on some subjects — a modal root's, a
    // fronted locative topic's, a coordinate root's where the sibling is
    // stative — and this feature adds to that population rather than
    // replacing it. Counted, so that a rule quietly widening the automatic
    // case shows up here as a number and not as a silence.
    const subjects = tree.sentences.flatMap((s) =>
      s.tokens.filter((t) => topicParticleOffered(t)).map((t) => caseParticleFor(t, s)),
    );
    expect(subjects).toHaveLength(AUTOMATIC_SUBJECTS);
    expect(subjects.filter((p) => p === "は")).toHaveLength(AUTOMATIC_HA);
  });
});

/** Subjects in the sample, and how many of them the app writes は on with no
 * reader choice anywhere. Fixed numbers rather than a relation between them,
 * so that a change to either is a failure someone has to look at.
 *
 * **The automatic は is now 0 over this sample, and that is the point of the
 * number rather than a loss of coverage.** All four it used to write were the
 * subject of a 曰 — 子夏は曰く, 子貢は曰く, 子は曰く — from
 * `isTopicalizedAdjective` firing on a `Degree=Pos` `conj:coord` child of the
 * root, which for a quotation frame *is the quotation*: the stative at the
 * front of what was said, read as a coordinate of the frame. The same name
 * fell on both sides of it according to how the treebank had attached the
 * quotation (子貢 took は in 學而 15 on a `conj:coord` and none in 學而 10 on a
 * `parataxis`), which is what showed it was an accident.
 *
 * Over kanbun.info's prose a subject standing before 曰く is written bare
 * **959** times and with は **once**, so the rule now stands down for a verb of
 * communication — worth 37 passages and 57 edits. What is left in this file is
 * the guard that matters: with no reader choice made, the reader's は is the
 * only は on a subject anywhere in the sample.
 *
 * **54 and not 52 since the two 提示 也 in the sample were re-related.** 其爲人
 * 也孝弟 (學而 2) and 夫子至於是邦也 (學而 10) both carried a topic-marking 也 on
 * `discourse@sp`, the relation that means the *assertive* なり, and both read
 * 〜なり in the middle of their own topic. Re-related on the pattern the file
 * already uses for 夫子之求之也 (學而 10) — the 也 heads the topic and takes the
 * comment clause's `subj` — they read や, which is the received reading. Two
 * more `subj` tokens in the sample is the arithmetic of that, and neither takes
 * a は. */
const AUTOMATIC_SUBJECTS = 54;
const AUTOMATIC_HA = 0;
