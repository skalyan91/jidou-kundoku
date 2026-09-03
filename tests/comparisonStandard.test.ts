import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Sentence, Token } from "../src/parse/types.ts";
import { classifyToken, isPostposedComparisonStandard } from "../src/kundoku/depClassification.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { findCompoundSpans } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";

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

/** Every token with its plain kaeriten written after it — what a reader sees. */
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
  const isPunct = (id: number) => byId.get(id)?.dep === "punct" || byId.get(id)?.pos === "PUNCT";
  const maxId = Math.max(...sentence.tokens.map((t) => t.id));
  const kuntens = Array.from({ length: maxId + 1 }, (_, id) => marks.get(id));
  return textOf(
    sentence,
    executeKunten(kuntens, isPunct).filter((id) => !isPunct(id)),
  );
}

describe("isPostposedComparisonStandard", () => {
  /** 如(0) + a dependent at 2, the 蠕動如游魚 shape reduced to its two words. */
  const pair = (dependent: Partial<Token>, governor: Partial<Token> = {}): [Token, Token] => [
    tok({ id: 0, text: "如", lemma: "如", pos: "ADJ", xpos: "v,動詞,行為,分類", morph: "Degree=Equ", dep: "ROOT", head: 0, ...governor }),
    tok({ id: 2, text: "魚", lemma: "魚", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "mod", head: 0, ...dependent }),
  ];

  it("fires only when the standard stands to the right of its comparative", () => {
    const [after, before] = [pair({}), pair({ id: -1 })];
    expect(isPostposedComparisonStandard(after[1], after[0])).toBe(true);
    expect(isPostposedComparisonStandard(before[1], before[0])).toBe(false);
  });

  it("wants `Degree=Equ` on the governor, and nothing else does the job", () => {
    const [governor, fish] = pair({});
    expect(isPostposedComparisonStandard(fish, { ...governor, morph: undefined })).toBe(false);
    expect(isPostposedComparisonStandard(fish, { ...governor, morph: "Degree=Pos" })).toBe(false);
    expect(isPostposedComparisonStandard(fish, governor)).toBe(true);
  });

  it("is plain `mod` only — every other relation is already settled elsewhere", () => {
    const [governor] = pair({});
    // `comp:obj` is what the gold treebank writes for this standard, and it is
    // in `INVERT_DEPS` already; the oblique subtypes invert already too.
    for (const dep of ["comp:obj", "mod@lmod", "mod@tmod", "subj", "conj:coord"]) {
      const [, dependent] = pair({ dep });
      expect(isPostposedComparisonStandard(dependent, governor)).toBe(false);
    }
    expect(classifyToken(pair({ dep: "comp:obj" })[1], governor)).toBe("invert");
  });

  it("moves a nominal standard and nothing else — 如見其肺肝然 and 區以別矣 stay put", () => {
    const [governor] = pair({});
    for (const pos of ["NOUN", "PROPN", "PRON", "NUM"]) {
      expect(isPostposedComparisonStandard(pair({ pos })[1], governor)).toBe(true);
    }
    // The only postposed plain `mod`s the gold corpus has under a comparative:
    // 然 (ADV — 其の肺肝を見るが如く然り), 以 (VERB — 區ちて以て別つ), 於/于 (ADP,
    // a bare preposition whose object is `mod@lmod`'s business, not this one's).
    for (const [text, pos] of [["然", "ADV"], ["以", "VERB"], ["於", "ADP"]]) {
      expect(isPostposedComparisonStandard(pair({ text, lemma: text, pos })[1], governor)).toBe(false);
    }
  });

  it("does not reach back across a stop", () => {
    const sentence: Sentence = {
      tokens: [
        tok({ id: 0, text: "如", lemma: "如", pos: "ADJ", morph: "Degree=Equ", dep: "ROOT", head: 0 }),
        tok({ id: 1, text: "、", lemma: "、", pos: "PUNCT", dep: "punct", head: 0 }),
        tok({ id: 2, text: "魚", lemma: "魚", pos: "NOUN", dep: "mod", head: 0 }),
      ],
    };
    expect(isPostposedComparisonStandard(sentence.tokens[2], sentence.tokens[0], sentence)).toBe(false);
    // Without a sentence the stop cannot be seen — the same standing answer
    // `isPostposedSubject` gives a caller with no tree in hand.
    expect(isPostposedComparisonStandard(sentence.tokens[2], sentence.tokens[0])).toBe(true);
  });

  it("asks nothing of a token whose governor — or whose governor's position — it has not been given", () => {
    const [governor, fish] = pair({});
    expect(isPostposedComparisonStandard(fish, undefined)).toBe(false);
    expect(isPostposedComparisonStandard(fish, { lemma: governor.lemma, dep: governor.dep, morph: governor.morph })).toBe(false);
    expect(classifyToken({ dep: "mod", lemma: "魚", pos: "NOUN" })).toBe("no-invert");
  });
});

// ---------------------------------------------------------------------------
// The reader's own 酒蟲 (聊齋志異) file, arcs untouched. 蠕動如游魚 came back with
// no kaeriten at all — 如 read before the standard it compares to, which reads
// 蠕動し如く游魚 rather than 蠕動すること游魚の如し.
// ---------------------------------------------------------------------------

const JIU_CHONG_25 = `# sent_id = 25
# text = 解縛視之、赤肉長三寸許蠕動如游魚口眼悉備
1\t解\t解\tVERB\tv,動詞,行為,動作\tNameType=Sur\t7\tmod@tmod\t_\t_
2\t縛\t縛\tNOUN\tv,動詞,行為,動作\tNameType=Giv\t1\tcomp:obj\t_\tReading=ばく
3\t視\t視\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t7\tmod\t_\t_
6\t赤\t赤\tADJ\tn,名詞,描写,形質\t_\t7\tmod\t_\t_
7\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t0\troot\t_\t_
8\t長\t長\tNOUN\tv,動詞,描写,量\t_\t9\tsubj\t_\t_
9\t三\t三\tNUM\tn,数詞,数字,*\t_\t7\tparataxis\t_\tReading=さん
10\t寸\t寸\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t9\tclf\t_\t_
11\t許\t許\tNOUN\tn,名詞,可搬,道具\t_\t9\tmod\t_\t_
12\t、\t、\tPUNCT\ts,記号,読点,*\t_\t9\tpunct\t_\t_
13\t蠕\t蠕\tVERB\tn,名詞,可搬,道具\t_\t15\tsubj\t_\t_
14\t動\t動\tVERB\tv,動詞,行為,動作\t_\t13\tflat@vv\t_\t_
15\t如\t如\tADJ\tv,動詞,行為,分類\tDegree=Equ\t9\tconj:coord\t_\t_
16\t游\t游\tVERB\tv,動詞,行為,動作\tVerbForm=Part\t17\tmod\t_\t_
17\t魚\t魚\tNOUN\tn,名詞,主体,動物\t_\t15\tmod\t_\t_
18\t、\t、\tPUNCT\ts,記号,読点,*\t_\t15\tpunct\t_\t_
19\t口\t口\tNOUN\tn,名詞,不可譲,身体\t_\t20\tmod\t_\t_
20\t眼\t眼\tNOUN\tn,名詞,不可譲,身体\t_\t22\tsubj\t_\t_
21\t悉\t悉\tADV\tv,副詞,範囲,総括\t_\t22\tmod\t_\tReading=ことごと|Okurigana=く
22\t備\t備\tVERB\tv,動詞,行為,設置\t_\t15\tconj:coord\t_\t_
23\t。\t。\tPUNCT\ts,記号,句点,*\t_\t22\tpunct\t_\t_
`;

describe("蠕動如游魚 (酒蟲 sent. 25, the reader's own arcs)", () => {
  const sentence = realSentence(JIU_CHONG_25);

  it("reads the standard before the comparative, and marks the jump", () => {
    // 如 hangs 游魚 off itself by plain `mod` at a position to its right. Left
    // there, the clause read 蠕動如游魚 — ごとし before what it compares to —
    // with no mark anywhere to say so.
    expect(readingOrder(sentence)).toContain("蠕動游魚如");
    expect(annotate(sentence)).toContain("蠕動如[二]游魚[一]");
  });

  it("the marks on that clause trace the prose", () => {
    // 蠕動 (unmarked, read), 如 二 (deferred), 游 (unmarked, read), 魚 一 (read,
    // then return) — 蠕動すること游魚の如く.
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    assignKundokuTen(plan);
    expect(plan.spliceGroups.map((g) => g.rankTokenIds)).toContainEqual([16, 14]); // 魚, then 如
    expect(traceMarks(sentence)).toContain("蠕動游魚如");
  });

  it("returns over two characters, so 一二点 and not レ点", () => {
    // 游 stands between 如 and the marked 魚, so the return passes over two
    // characters — `clauseLengthIn`'s one-character test fails and the pair is
    // a numeral group. A レ here would read 蠕動魚如游.
    const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
    assignKundokuTen(plan);
    const group = plan.spliceGroups.find((g) => g.rankTokenIds.includes(14))!;
    expect(group.isRe).toBe(false);
    expect(group.depth).toBe(0);
  });

  it("leaves 悉, which is an adverbial `mod`, exactly where the source put it", () => {
    // The bound that keeps this rule off the mixed plain-`mod` class: 悉 is an
    // ADV, and stands before its governor anyway. Neither half of the rule
    // touches it.
    const xi = sentence.tokens.find((t) => t.text === "悉")!;
    const bei = sentence.tokens.find((t) => t.text === "備")!;
    expect(classifyToken(xi, bei, sentence)).toBe("no-invert");
    expect(readingOrder(sentence)).toContain("口眼悉備");
  });
});

describe("what the rule must not move", () => {
  it("劉自是惡酒如仇 is untouched — its standard is a `comp:obj` already", () => {
    // The same comparative, one sentence along in the same file, with the
    // relation the gold treebank actually writes. It was already レ点 and stays
    // レ点: 仇 is a single character, so the return is a one-character return.
    const sentence = realSentence(`# sent_id = 33
# text = 劉自是惡酒如仇
1\t劉\t劉\tPROPN\tn,名詞,人,名\tNameType=Giv\t6\tsubj\t_\t_
2\t自\t自\tADP\tv,前置詞,経由,*\tPronType=Prs|Reflex=Yes\t6\tmod\t_\t_
3\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t2\tcomp:obj\t_\t_
4\t惡\t惡\tVERB\tv,動詞,行為,動作\t_\t6\tsubj\t_\tReading=にく|Okurigana=む
5\t酒\t酒\tNOUN\tn,名詞,可搬,糧食\t_\t4\tcomp:obj\t_\t_
6\t如\t如\tADJ\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_
7\t仇\t仇\tNOUN\tv,動詞,行為,交流\t_\t6\tcomp:obj\t_\tReading=あだ
8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_
`);
    expect(annotate(sentence)).toBe("劉自[レ]是惡[レ]酒如[レ]仇。");
    expect(traceMarks(sentence)).toBe("劉是自酒惡仇如");
  });

  it("leaves the pinned anchors exactly as they were", () => {
    // None of them has a comparative in it; this is the standing check that a
    // new movement rule reaches only the construction it names.
    const marks: Record<string, string> = {
      "學而時習之，不亦說乎？": "學而時習[レ]之，",
      "有朋自遠方來，不亦樂乎？": "有[二]朋自[レ]遠方來[一]，",
      "人不知而不慍，不亦君子乎？": "人不[レ]知而不[レ]慍，",
    };
    for (const [text, expected] of Object.entries(marks)) {
      expect(annotate({ tokens: raw[text][0] })).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Which 如 it is, and therefore which paradigm.
//
// 如 is two verbs and `VERB_LEXICON` holds only one of them — `yodan-ka` + し,
// which is 如**く** "to come up to", the verb of 不如/莫如. It was being applied
// to the comparison as well, and the two paradigms are very nearly each other's
// mirror (四段 連用形 き / 終止形 く against ク活用 連用形 く / 終止形 し), so every
// comparison printed the other's form: 蠕動如游魚 came out 游魚の如**き** where
// `decideConjForm` had already answered 連用形, and 劉自是惡酒如仇 came out
// 仇の如**く** where it answers 終止形.
//
// Measured over `lzh_kyoto-sud-{train,dev,test}`: 如/若 used as a comparison is
// 1,671 tokens, 1,296 of them positive and 375 negated — so the lexicon's single
// 四段 entry spoke for 22% of them and was applied to all. The split is the
// negation, and it is the split `caseParticleFor` already makes for the standard
// (の for a positive comparison, に for 〜に如かず).
// ---------------------------------------------------------------------------

describe("a positive comparison 如 inflects as ごとし, a negated one as 如く", () => {
  const dataDir = fileURLToPath(new URL("../public/data/", import.meta.url));
  const gotoshiResolve = createReadingResolver(
    JSON.parse(readFileSync(`${dataDir}kanjidic-index.json`, "utf-8")),
    JSON.parse(readFileSync(`${dataDir}jmdict-index.json`, "utf-8")),
  );
  const prose = (sentence: Sentence): string =>
    generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), gotoshiResolve);

  it("蠕動如游魚、口眼悉備 — 連用形, and the standard keeps の", () => {
    // 如 has 備 coordinated onto it, so it is a non-final conjunct and
    // `decideConjForm` answers 連用形. ク活用's 連用形 is く: 游魚の如く.
    const sentence = realSentence(`# text = 蠕動如游魚口眼悉備
1\t蠕\t蠕\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t動\t動\tVERB\tv,動詞,行為,動作\t_\t1\tflat@vv\t_\t_
3\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_
4\t游\t游\tVERB\tv,動詞,行為,動作\tVerbForm=Part\t5\tmod\t_\t_
5\t魚\t魚\tNOUN\tn,名詞,主体,動物\t_\t3\tcomp:obj\t_\t_
6\t口\t口\tNOUN\tn,名詞,不可譲,身体\t_\t7\tmod\t_\t_
7\t眼\t眼\tNOUN\tn,名詞,不可譲,身体\t_\t9\tsubj\t_\t_
8\t悉\t悉\tADV\tv,副詞,範囲,総括\t_\t9\tmod\t_\t_
9\t備\t備\tVERB\tv,動詞,行為,設置\t_\t3\tconj:coord\t_\t_
`);
    expect(prose(sentence)).toContain("游魚の如く");
    // The standing rule about the standard: の, never を.
    expect(prose(sentence)).not.toContain("魚を");
  });

  it("蠕動如游魚 standing alone — 終止形, so 如し", () => {
    const sentence = realSentence(`# text = 蠕動如游魚
1\t蠕\t蠕\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t動\t動\tVERB\tv,動詞,行為,動作\t_\t1\tflat@vv\t_\t_
3\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_
4\t游\t游\tVERB\tv,動詞,行為,動作\tVerbForm=Part\t5\tmod\t_\t_
5\t魚\t魚\tNOUN\tn,名詞,主体,動物\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("游魚の如し");
  });

  it("知之者不如好之者 — the negated comparison is the *other* verb, に如かず", () => {
    const sentence = realSentence(`# text = 知之者不如好之者
1\t知\t知\tVERB\tv,動詞,行為,動作\t_\t3\tmod\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t5\tsubj\t_\t_
4\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t5\tmod\t_\t_
5\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_
6\t好\t好\tVERB\tv,動詞,行為,態度\t_\t8\tmod\t_\t_
7\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t6\tcomp:obj\t_\t_
8\t者\t者\tPART\tp,助詞,提示,*\t_\t5\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("に如かず");
  });

  it("a reader's own pin of ごと+し still inflects — it no longer freezes at 終止形", () => {
    // The menu offers ごと + し off `overrides.json`, and a pick stores exactly
    // that; a bare し states no paradigm `chosenConjClass` can read back, so the
    // ending used to stand wherever the character did. 酒蟲 sent_id 25 carries
    // this pin on its 如.
    const sentence = realSentence(`# text = 蠕動如游魚口眼悉備
1\t蠕\t蠕\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t動\t動\tVERB\tv,動詞,行為,動作\t_\t1\tflat@vv\t_\t_
3\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\tReading=ごと|Okurigana=し
4\t游\t游\tVERB\tv,動詞,行為,動作\tVerbForm=Part\t5\tmod\t_\t_
5\t魚\t魚\tNOUN\tn,名詞,主体,動物\t_\t3\tcomp:obj\t_\t_
6\t口\t口\tNOUN\tn,名詞,不可譲,身体\t_\t7\tmod\t_\t_
7\t眼\t眼\tNOUN\tn,名詞,不可譲,身体\t_\t9\tsubj\t_\t_
8\t悉\t悉\tADV\tv,副詞,範囲,総括\t_\t9\tmod\t_\t_
9\t備\t備\tVERB\tv,動詞,行為,設置\t_\t3\tconj:coord\t_\t_
`);
    expect(prose(sentence)).toContain("游魚の如く");
  });
});
