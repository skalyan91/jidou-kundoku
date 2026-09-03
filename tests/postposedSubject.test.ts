import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import { classifyToken, isPostposedSubject } from "../src/kundoku/depClassification.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { findCompoundSpans } from "../src/reading/jmdictLookup.ts";

const fixturesPath = fileURLToPath(new URL("./fixtures/analects-raw-parses.json", import.meta.url));
const raw: Record<string, Token[][]> = JSON.parse(readFileSync(fixturesPath, "utf-8"));

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });

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
  return textOf(sentence, computeReadingOrder(sentence, findCompoundSpans(sentence)).order);
}

/** The annotated text a reader actually sees: every token with the plain
 * kaeriten written after it. */
function annotate(sentence: Sentence): string {
  const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
  assignKundokuTen(plan);
  const marks = buildPlainKuntenMarks(plan);
  return sentence.tokens.map((t) => `${t.text}${marks.get(t.id) ? `[${marks.get(t.id)}]` : ""}`).join("");
}

/** What a reader following *only* the marks reads, content tokens only —
 * `kuntenExecutor` is the inverse of the assigner, so this is the trace that
 * says a set of marks really states the reading the tree computed. */
function traceMarks(sentence: Sentence): string {
  const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
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

describe("isPostposedSubject", () => {
  const pair = (governorId: number, subjectId: number, dep = "subj"): [Token, Token] => [
    tok({ id: governorId, text: "有", lemma: "有", xpos: "v,動詞,存在,存在", dep: "ROOT", head: governorId }),
    tok({ id: subjectId, text: "出", lemma: "出", dep, head: governorId }),
  ];

  it("fires only when the subject stands to the right of its governor", () => {
    const [after, before] = [pair(0, 1), pair(1, 0)];
    expect(isPostposedSubject(after[1], after[0])).toBe(true);
    expect(isPostposedSubject(before[1], before[0])).toBe(false);
  });

  it("covers the subtyped subject relations too", () => {
    for (const dep of ["subj", "subj@pass"]) {
      const [governor, subject] = pair(0, 1, dep);
      expect(isPostposedSubject(subject, governor)).toBe(true);
    }
    const [governor, other] = pair(0, 1, "comp:obj");
    expect(isPostposedSubject(other, governor)).toBe(false);
  });

  it("asks nothing of a token whose governor — or whose governor's position — it has not been given", () => {
    // `spanCarrier.ts` and `resolveEffectiveHead` both call the one-argument
    // form of `classifyToken`, and a `GovernorContext` assembled by hand need
    // not carry an id.
    const [governor, subject] = pair(0, 1);
    expect(isPostposedSubject(subject, undefined)).toBe(false);
    expect(isPostposedSubject(subject, { lemma: governor.lemma, dep: governor.dep })).toBe(false);
    expect(classifyToken({ dep: "subj", lemma: "出", pos: "NOUN" })).toBe("no-invert");
  });

  it("leaves a fronted descriptive predicate's subject where the exclamative put it", () => {
    // 美哉水 is 美なるかな水 — Literary Chinese puts a stative predicate before
    // its subject to exclaim, and kundoku keeps that order rather than undoing
    // it. Both signals are required: the treebank's descriptive class in the
    // xpos, and `Degree=Pos` in the morph.
    const bi = tok({
      id: 0,
      text: "美",
      lemma: "美",
      xpos: "v,動詞,描写,形質",
      morph: "Degree=Pos",
      dep: "ROOT",
      head: 0,
    });
    const sui = tok({ id: 2, text: "水", lemma: "水", pos: "NOUN", dep: "subj", head: 0 });
    expect(isPostposedSubject(sui, bi)).toBe(false);
    // Either signal alone is not the construction: 未若曾子之母也 gives 若 a
    // `Degree=Equ` comparison whose standard Japanese does read first.
    expect(isPostposedSubject(sui, { ...bi, morph: "Degree=Equ" })).toBe(true);
    expect(isPostposedSubject(sui, { ...bi, xpos: "v,動詞,行為,分類" })).toBe(true);
  });

  it("does not reach back across a stop", () => {
    // A kaeriten returns within a 句. A `subj` on the far side of a 、 is a
    // fresh clause the parse has mis-attached — see the 解縛視之、赤肉… case
    // below, where the subtree on the far side is the rest of the sentence.
    const sentence: Sentence = {
      tokens: [
        tok({ id: 0, text: "視", lemma: "視", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "、", lemma: "、", pos: "PUNCT", dep: "punct", head: 0 }),
        tok({ id: 2, text: "肉", lemma: "肉", pos: "NOUN", dep: "subj", head: 0 }),
      ],
    };
    expect(isPostposedSubject(sentence.tokens[2], sentence.tokens[0], sentence)).toBe(false);
    // Without a sentence the stop cannot be seen, and the majority answer —
    // 155 of the corpus's 160 postposed subjects have no stop between — is
    // what a caller with no tree in hand gets. See the parameter's own doc.
    expect(isPostposedSubject(sentence.tokens[2], sentence.tokens[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The reader's own 酒蟲 (聊齋志異) file, arcs untouched. 哇有物出 came back with
// no kaeriten at all — 有 read before the subject it takes, which is the one
// thing kundoku never does — and the sentence failed its own marks-only round
// trip as a result.
// ---------------------------------------------------------------------------

const JIU_CHONG_24 = `# sent_id = 24
# text = 忽覺咽中暴癢哇有物出直墮酒中
1\t忽\t忽\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t2\tmod\t_\t_
2\t覺\t覺\tVERB\tv,動詞,行為,動作\tNameType=Giv\t0\troot\t_\tReading=おぼ|Okurigana=える
3\t咽\t咽\tVERB\tn,名詞,不可譲,身体\t_\t4\tmod\t_\t_
4\t中\t中\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t5\tsubj\t_\t_
5\t暴\t暴\tADV\tv,動詞,描写,態度\tDegree=Pos\t2\tmod\t_\t_
6\t癢\t癢\tNOUN\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
7\t、\t、\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
8\t哇\t哇\tVERB\tv,動詞,行為,動作\t_\t9\tmod\t_\t_
9\t有\t有\tVERB\tv,動詞,存在,存在\t_\t2\tparataxis\t_\t_
10\t物\t物\tNOUN\tn,名詞,可搬,道具\t_\t11\tmod\t_\t_
11\t出\t出\tNOUN\tv,動詞,行為,移動\t_\t9\tsubj\t_\t_
12\t、\t、\tPUNCT\ts,記号,読点,*\t_\t9\tpunct\t_\t_
13\t直\t直\tADV\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Conv\t14\tmod\t_\tReading=ただ|Okurigana=ちに
14\t墮\t墮\tVERB\tv,動詞,行為,動作\t_\t9\tconj:coord\t_\t_
15\t酒\t酒\tNOUN\tn,名詞,可搬,糧食\t_\t16\tmod\t_\t_
16\t中\t中\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t14\tcomp:obl\t_\t_
17\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
`;

describe("哇有物出 (酒蟲 sent. 24, the reader's own arcs)", () => {
  const sentence = realSentence(JIU_CHONG_24);

  it("reads the existential's subject before it, and marks the jump", () => {
    // 有 hangs 出 off itself by `subj` at a position to its right. Left there,
    // the clause read 哇有物出 — the verb before its own subject — with no mark
    // anywhere to say so.
    expect(readingOrder(sentence)).toContain("哇物出有");
    expect(annotate(sentence)).toContain("哇有[二]物出[一]");
  });

  it("the marks on that clause trace the prose", () => {
    // 哇 (unmarked, read), 有 二 (deferred), 物 (unmarked, read), 出 一 (read,
    // then return) — 哇きて物の出づる有り.
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    assignKundokuTen(plan);
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([10, 8]); // 出, then 有
    expect(traceMarks(sentence)).toContain("哇物出有");
  });

  it("leaves 暴, which is a `mod`, exactly where the source put it", () => {
    // Deliberately unchanged, and not the same fault. 暴 is an adverb the parse
    // has hung on 覺 (with the locative 咽中 under it as its own `subj`) instead
    // of on 癢, which is where it belongs; under the tree as given it is a
    // postposed `mod`, and a postposed `mod` is a class kundoku mostly reads in
    // place — postverbal 然/否/以來, a measure phrase after its noun (馬十乘), an
    // ordinal after 篇第, reduplicative descriptives (君子坦蕩蕩). In the exact
    // cell this one falls into — an ADV `mod` after a VERB governor — the gold
    // treebank has 24 instances and every one of them stays. So the movement
    // rules leave it alone and the mis-attachment is reported instead. See
    // `isPostposedSubject`'s own note on why `subj` and `mod` part company.
    expect(classifyToken(sentence.tokens[4], sentence.tokens[1], sentence)).toBe("no-invert");
    expect(readingOrder(sentence)).toContain("忽癢覺咽中暴");
  });
});

describe("what the rule must not move", () => {
  it("有朋自遠方來 is untouched — its postverbal argument is a `comp:obj` already", () => {
    // The anchor this rule has to be told apart from. The parse makes 來 a
    // `comp:obj` of 有 and 朋 a `subj` of **來**, standing before it, so the
    // whole clause inverts as one INVERT subtree and nothing here fires.
    const sentence: Sentence = { tokens: raw["有朋自遠方來，不亦樂乎？"][0] };
    const peng = sentence.tokens.find((t) => t.text === "朋")!;
    const lai = sentence.tokens.find((t) => t.text === "來")!;
    expect(peng.dep).toBe("subj");
    expect(peng.head).toBe(lai.id);
    expect(isPostposedSubject(peng, lai)).toBe(false);
    expect(readingOrder(sentence)).toBe("朋遠自方來有，");
  });

  it("學而時習之 is untouched", () => {
    const sentence: Sentence = { tokens: raw["學而時習之，不亦說乎？"][0] };
    expect(readingOrder(sentence)).toBe("學而時之習，");
  });

  it("解縛視之、赤肉長三寸許… keeps its clauses in place (酒蟲 sent. 25)", () => {
    // The parse hangs 肉 off 視 by `subj` across the 、, and 肉's subtree is
    // every remaining clause of the sentence. Inverting it read
    // 縛を解き之を赤肉…口眼悉く備はる視 — three clauses hauled in front of the
    // verb that governs none of them. The stop is what stops it.
    const sentence = realSentence(`# sent_id = 25
# text = 解縛視之赤肉長三寸許蠕動如游魚口眼悉備
1\t解\t解\tVERB\tv,動詞,行為,動作\tNameType=Sur\t0\troot\t_\t_
2\t縛\t縛\tPROPN\tv,動詞,行為,動作\tNameType=Giv\t1\tcomp:obj\t_\t_
3\t視\t視\tVERB\tv,動詞,行為,動作\t_\t1\tparataxis\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
6\t赤\t赤\tADJ\tn,名詞,描写,形質\t_\t7\tmod\t_\t_
7\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t3\tsubj\t_\t_
8\t長\t長\tNOUN\tv,動詞,描写,量\t_\t9\tsubj\t_\t_
9\t三\t三\tNUM\tn,数詞,数字,*\t_\t7\tconj:coord\t_\tReading=さん
10\t寸\t寸\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t9\tclf\t_\t_
11\t許\t許\tNOUN\tn,名詞,可搬,道具\t_\t9\tmod\t_\t_
`);
    expect(readingOrder(sentence)).toBe("縛解之視、赤肉長三寸許");
  });
});
