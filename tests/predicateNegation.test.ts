import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import { classifyToken, isPredicateNegationPostpose } from "../src/kundoku/depClassification.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

/** 無/无/罔/靡 (the negative existential) and 莫/毋 (the prohibitive) stand
 * before the predicate they deny in Chinese source order and are read *after*
 * it — 無友不如己者 is 己に如かざる者を友とすること無かれ, 莫知其極 is
 * 其の極を知る莫し — the same pre-to-post flip `depClassification.ts` already
 * makes for 不 and for 非, and written with the same kaeriten (無㆑友㆓不㆑如
 * ㆑己者㆒).
 *
 * What separates this class from 不's is the ず: a postposed 不 inflects the
 * verb it moves past, and these realise a predicate of their own instead. The
 * tests below check the movement and the marks; the readings belong to
 * `src/reading/` and `src/kakikudashi/` and are asserted there. */

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });

/** A 無 in its existential use, as the treebank writes it — ADV on `mod`,
 * `v,動詞,存在,存在`, and carrying `VerbForm=Conv` (all 489 ADV tokens of that
 * class do). */
const mu = (id: number, head: number, text = "無"): Token =>
  tok({ id, text, lemma: text, pos: "ADV", xpos: "v,動詞,存在,存在", dep: "mod", head, morph: "Polarity=Neg|VerbForm=Conv" });

/** A 莫 in its prohibitive use — the class the treebank puts 勿 in too. */
const maku = (id: number, head: number, text = "莫"): Token =>
  tok({ id, text, lemma: text, pos: "ADV", xpos: "v,副詞,否定,禁止", dep: "mod", head, morph: "Polarity=Neg" });

function realSentence(conllu: string): Sentence {
  const tree = parseConllu(conllu);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

function textOf(sentence: Sentence, ids: number[]): string {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t.text]));
  return ids.map((id) => byId.get(id)).join("");
}

function readingOrder(sentence: Sentence): string {
  return textOf(sentence, computeReadingOrder(sentence).order);
}

/** Every token with its plain kaeriten written after it in brackets. */
function annotate(sentence: Sentence): string {
  const plan = computeReadingOrder(sentence);
  assignKundokuTen(plan);
  const marks = buildPlainKuntenMarks(plan);
  return sentence.tokens.map((t) => `${t.text}${marks.get(t.id) ? `[${marks.get(t.id)}]` : ""}`).join("");
}

/** What a reader following *only* the marks reads — the round trip that says
 * the marks really state the order the tree computed. */
function traceMarks(sentence: Sentence): string {
  const plan = computeReadingOrder(sentence);
  assignKundokuTen(plan);
  const marks = buildPlainKuntenMarks(plan);
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const isPunct = (id: number) => byId.get(id)?.dep === "punct";
  const maxId = Math.max(...sentence.tokens.map((t) => t.id));
  const kuntens = Array.from({ length: maxId + 1 }, (_, id) => marks.get(id));
  return textOf(
    sentence,
    executeKunten(kuntens, isPunct).filter((id) => !isPunct(id)),
  );
}

describe("isPredicateNegationPostpose", () => {
  it("fires on the existential 無/无/罔/靡 and on the prohibitive 莫/毋", () => {
    expect(isPredicateNegationPostpose(mu(0, 1), { id: 1 })).toBe(true);
    expect(isPredicateNegationPostpose(mu(0, 1, "无"), { id: 1 })).toBe(true);
    expect(isPredicateNegationPostpose(mu(0, 1, "罔"), { id: 1 })).toBe(true);
    expect(isPredicateNegationPostpose(mu(0, 1, "靡"), { id: 1 })).toBe(true);
    expect(isPredicateNegationPostpose(maku(0, 1), { id: 1 })).toBe(true);
    expect(isPredicateNegationPostpose(maku(0, 1, "毋"), { id: 1 })).toBe(true);
  });

  it("declines 微, which carries the same tag and the same features and is not an existential", () => {
    // 微服, 微行, 微諫 — ひそかに, read straight through in front of its verb.
    // 22 tokens in the gold, every one `Polarity=Neg|VerbForm=Conv` on
    // `v,動詞,存在,存在`, exactly as 無 is: nothing but the lemma tells them
    // apart.
    const bi = tok({ id: 0, text: "微", lemma: "微", pos: "ADV", xpos: "v,動詞,存在,存在", dep: "mod", head: 1, morph: "Polarity=Neg|VerbForm=Conv" });
    expect(isPredicateNegationPostpose(bi, { id: 1 })).toBe(false);
  });

  it("declines 莫 the noun (莫 for 暮) and 莫 the place name", () => {
    const noun = tok({ id: 0, text: "莫", lemma: "莫", pos: "NOUN", xpos: "n,名詞,時,*", dep: "mod", head: 1 });
    expect(isPredicateNegationPostpose(noun, { id: 1 })).toBe(false);
  });

  it("declines one heading its own coordinate predicate", () => {
    expect(isPredicateNegationPostpose({ ...mu(0, 1), dep: "conj:coord" }, { id: 1 })).toBe(false);
  });

  it("declines one whose head already stands before it", () => {
    // 可以無飢矣 — all 17 such tokens in the gold hang off a modal to their
    // left, where the reading runs straight through.
    expect(isPredicateNegationPostpose(mu(1, 0), { id: 0 })).toBe(false);
  });

  it("declines a genitive 之 governor, which makes 無 half of a compound", () => {
    // 無妄之福 — 「無妄の福」, not 妄の福無し. All 16 of the gold's 之-headed
    // existentials are this shape.
    expect(isPredicateNegationPostpose(mu(0, 2), { id: 2, xpos: "p,助詞,接続,属格" })).toBe(false);
  });

  it("is suspended by a reading picked by hand, like every other postpose class", () => {
    expect(isPredicateNegationPostpose({ ...mu(0, 1), misc: { Reading: "な" } }, { id: 1 })).toBe(false);
  });

  it("answers the standing behaviour when the caller has no position in hand", () => {
    expect(isPredicateNegationPostpose(mu(0, 1))).toBe(true);
  });

  it("makes classifyToken postpose it", () => {
    expect(classifyToken(mu(0, 1), { id: 1, lemma: "友", dep: "root" })).toBe("postpose");
    expect(classifyToken(maku(0, 1), { id: 1, lemma: "知", dep: "root" })).toBe("postpose");
  });
});

describe("無 is read after the predicate it denies", () => {
  // 論語 學而 8 — 無友不如己者, 己に如かざる者を友とすること無かれ. The received
  // marking is 無㆑友㆓不㆑如㆑己者㆒: one レ点 for the single jump from 無 back
  // over 友, and a 一二 pair for the four characters 友…者 the reader returns
  // across.
  const sentence = realSentence(`
1\t無\t無\tADV\tv,動詞,存在,存在\tPolarity=Neg|VerbForm=Conv\t2\tmod\t_\t_
2\t友\t友\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_
3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
4\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t6\tmod\t_\t_
5\t己\t己\tPRON\tn,代名詞,人称,他\tPronType=Prs|Reflex=Yes\t4\tcomp:obj\t_\t_
6\t者\t者\tPART\tp,助詞,提示,*\t_\t2\tcomp:obj\t_\t_
`);

  it("reads the 無 last", () => {
    expect(readingOrder(sentence)).toBe("己如不者友無");
  });

  it("writes the marks an edition prints", () => {
    expect(annotate(sentence)).toBe("無[レ]友[二]不[レ]如[レ]己者[一]");
  });

  it("states that order in marks a reader can follow", () => {
    expect(traceMarks(sentence)).toBe(readingOrder(sentence));
  });
});

describe("a predicate negation scopes over a 不 postposed off the same head", () => {
  // 莫不知 — 知らざる莫し. Both negations hang off 知 as `mod` and nothing in
  // the tree ranks them, so source order would have read 知る莫ず.
  const sentence = realSentence(`
1\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t3\tmod\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);

  it("reads the verbal negation first and the predicate negation last", () => {
    expect(readingOrder(sentence)).toBe("知不莫");
  });

  it("states that order in marks a reader can follow", () => {
    expect(traceMarks(sentence)).toBe(readingOrder(sentence));
  });
});

describe("a predicate negation over 能 is read after the complement of 能", () => {
  // 吳子 圖國 — 羣臣莫能及, 羣臣能く及ぶ莫し, as the shipped parser returns it:
  // 莫 and 及 both hang off 能, the 莫 as a postposed `mod` and the 及 as a
  // `comp:aux` read straight on. Spliced onto 能 alone, the 莫 was read between
  // the two (能く莫及ぶ); what the 莫 denies is the whole 能及 clause.
  const sentence = realSentence(`
1\t羣\t羣\tNOUN\tn,名詞,描写,形質\t_\t2\tmod\t_\t_
2\t臣\t臣\tNOUN\tn,名詞,人,役割\t_\t4\tsubj\t_\t_
3\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t4\tmod\t_\t_
4\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
5\t及\t及\tVERB\tv,動詞,行為,移動\t_\t4\tcomp:aux\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
`);

  it("reads the 莫 after the complement", () => {
    expect(readingOrder(sentence)).toBe("羣臣能及莫。");
  });

  it("writes the marks an edition prints", () => {
    expect(annotate(sentence)).toBe("羣臣莫[二]能及[一]。");
  });

  it("states that order in marks a reader can follow", () => {
    // The trace skips punctuation, which carries no mark.
    expect(traceMarks(sentence)).toBe("羣臣能及莫");
  });

  it("leaves an object the source fronts before 能 where it stands", () => {
    // 莫之能禦 — 之を能く禦ぐ莫し. The 之 is the object of 禦 but already stands
    // in front of 能, so folding it into the run of 能 would move it past 能
    // with no mark to say so.
    const fronted = realSentence(`
1\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t3\tmod\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t4\tcomp:obj\t_\t_
3\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
4\t禦\t禦\tVERB\tv,動詞,行為,動作\t_\t3\tcomp:aux\t_\t_
`);
    expect(readingOrder(fronted)).toBe("之能禦莫");
    expect(traceMarks(fronted)).toBe(readingOrder(fronted));
  });

  it("reads a 也 the parse hangs off the complement after the 莫", () => {
    // The 也 closes the whole clause wherever the parser attaches it, so it
    // is not folded in with the complement: 能く及ぶ莫きなり, not 能く及ぶなり莫し.
    const particleOnComplement = realSentence(`
1\t莫\t莫\tADV\tv,副詞,否定,禁止\tPolarity=Neg\t2\tmod\t_\t_
2\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
3\t及\t及\tVERB\tv,動詞,行為,移動\t_\t2\tcomp:aux\t_\t_
4\t也\t也\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
`);
    expect(readingOrder(particleOnComplement)).toBe("能及莫也。");
  });
});
