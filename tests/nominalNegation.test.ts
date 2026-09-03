import { describe, expect, it } from "vitest";
import type { Sentence, Token } from "../src/parse/types.ts";
import { classifyToken, isNominalNegationPostpose } from "../src/kundoku/depClassification.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

/** 非/匪 negate a nominal predicate and are read *after* it — 非劉之病 is
 * 劉の病にあらず — the same pre-to-post flip `depClassification.ts` already
 * makes for 不, and written with the same kaeriten (非㆓劉ノ病㆒).
 *
 * The tests below check the reading order and the marks. 非's own reading
 * (あら + ズ) and the に its head takes belong to `src/reading/` and
 * `src/kakikudashi/conjugationContext.ts` and are asserted there. */

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });

/** A 非 in its nominal-negation use, as the treebank writes it. */
const hi = (id: number, head: number, text = "非"): Token =>
  tok({ id, text, lemma: text, pos: "ADV", xpos: "v,副詞,否定,体言否定", dep: "mod", head, morph: "Polarity=Neg" });

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

/** The annotated text a reader actually sees: every token with its plain
 * kaeriten written after it in brackets. */
function annotate(sentence: Sentence): string {
  const plan = computeReadingOrder(sentence);
  assignKundokuTen(plan);
  const marks = buildPlainKuntenMarks(plan);
  return sentence.tokens.map((t) => `${t.text}${marks.get(t.id) ? `[${marks.get(t.id)}]` : ""}`).join("");
}

/** What a reader following *only* the marks reads, content tokens only.
 * `kuntenExecutor` is the inverse of the assigner, so this is the trace that
 * says a set of marks really states the reading the tree computed. */
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

describe("isNominalNegationPostpose", () => {
  it("fires on the treebank's 体言否定 use of 非 and 匪", () => {
    expect(isNominalNegationPostpose(hi(0, 1), { id: 1 })).toBe(true);
    expect(isNominalNegationPostpose(hi(0, 1, "匪"), { id: 1 })).toBe(true);
  });

  it("declines the noun 非 ('a wrong') and the verb 非 ('to blame'), which the same lemma spells", () => {
    // Both really occur as plain `mod` in the corpus — 10 times between them —
    // so the relation alone does not separate them from the negation. Neither
    // ever carries 体言否定, and neither is an ADV.
    const noun = tok({ id: 0, text: "非", lemma: "非", pos: "NOUN", xpos: "n,名詞,描写,態度", dep: "mod", head: 1 });
    const verb = tok({ id: 0, text: "非", lemma: "非", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "mod", head: 1 });
    expect(isNominalNegationPostpose(noun, { id: 1 })).toBe(false);
    expect(isNominalNegationPostpose(verb, { id: 1 })).toBe(false);
  });

  it("declines a 非 heading its own coordinate predicate", () => {
    expect(isNominalNegationPostpose({ ...hi(0, 1), dep: "conj:coord" }, { id: 1 })).toBe(false);
  });

  it("declines a 非 whose head already stands before it", () => {
    // 為非住 ("to be a non-abiding"), where the parse hangs 非 on the copula to
    // its left while its real scope is the noun to its right. Eight tokens in
    // the corpus, all of this one shape; postposing a token that already
    // follows its governor states a jump nothing makes.
    expect(isNominalNegationPostpose(hi(1, 0), { id: 0 })).toBe(false);
  });

  it("is suspended by a reading picked by hand, like every other postpose class", () => {
    const chosen = { ...hi(0, 1), misc: { Reading: "ひ" } };
    expect(isNominalNegationPostpose(chosen, { id: 1 })).toBe(false);
  });

  it("answers the standing behaviour when the caller has no position in hand", () => {
    expect(isNominalNegationPostpose(hi(0, 1))).toBe(true);
  });

  it("makes classifyToken postpose it", () => {
    expect(classifyToken(hi(0, 1), { id: 1, lemma: "病", dep: "ROOT" })).toBe("postpose");
    expect(classifyToken(hi(1, 0), { id: 0, lemma: "為", dep: "ROOT" })).not.toBe("postpose");
  });
});

describe("非 is read after the predicate it negates", () => {
  // 非劉之病 — 劉の病にあらず. 之 is the genitive, which reads in place, so the
  // whole return is 非's: three characters, hence 一二点 rather than レ点, and
  // exactly the notation a printed text writes (非㆓劉ノ病㆒).
  const hiRyuuNoYamai = (): Sentence =>
    realSentence(
      [
        "1\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t4\tmod\t_\t_",
        "2\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t3\tcomp:obj\t_\t_",
        "3\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t4\tmod\t_\t_",
        "4\t病\t病\tNOUN\tn,名詞,不可譲,疾病\t_\t0\troot\t_\t_",
      ].join("\n"),
    );

  it("reads 劉之病 first and 非 last", () => {
    expect(readingOrder(hiRyuuNoYamai())).toBe("劉之病非");
  });

  it("writes the jump as 非㆓劉之病㆒", () => {
    expect(annotate(hiRyuuNoYamai())).toBe("非[二]劉之病[一]");
  });

  it("a reader following only those marks reproduces the prose", () => {
    expect(traceMarks(hiRyuuNoYamai())).toBe("劉之病非");
  });

  it("leaves 非 where it stands when the parse puts its head before it", () => {
    // 為非住 again, end to end: nothing is marked, and the text reads straight
    // through.
    const sentence = realSentence(
      [
        "1\t為\t為\tAUX\tv,動詞,行為,生産\tVerbType=Cop\t0\troot\t_\t_",
        "2\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t1\tmod\t_\t_",
        "3\t住\t住\tNOUN\tn,名詞,描写,態度\t_\t1\tcomp:pred\t_\t_",
      ].join("\n"),
    );
    expect(annotate(sentence)).toBe("為[二]非住[一]");
    expect(readingOrder(sentence)).toBe("住為非");
  });
});

describe("what 非 postposes past, when the head has other postposed children", () => {
  // Nothing in the tree separates 不, 非 and 雖: all three are `mod` children
  // of the one predicate. Their scope does, and reading order has to state it.
  it("reads a verbal negation before the nominal one — 城非不高也", () => {
    // 城高からざるに非ざるなり. Source order would have given 城高に非ず…ず.
    const sentence = realSentence(
      [
        "1\t城\t城\tNOUN\tn,名詞,固定物,建造物\t_\t4\tsubj\t_\t_",
        "2\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t4\tmod\t_\t_",
        "3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_",
        "4\t高\t高\tVERB\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_",
        "5\t也\t也\tPART\tp,助詞,句末,*\t_\t4\tdiscourse:sp\t_\t_",
      ].join("\n"),
    );
    expect(readingOrder(sentence)).toBe("城高不非也");
    expect(annotate(sentence)).toBe("城非[三]不[二]高[一]也");
    expect(traceMarks(sentence)).toBe("城高不非也");
  });

  it("reads the nominal negation before a concessive — 少小雖非投筆吏", () => {
    // 少小 投筆の吏に非ずと雖も: と…雖も closes the clause it concedes, so 雖
    // is outermost of the three and 非 is read before it.
    const sentence = realSentence(
      [
        "1\t少\t少\tVERB\tv,動詞,描写,量\tDegree=Pos\t7\tsubj\t_\t_",
        "2\t小\t小\tVERB\tv,動詞,描写,量\tDegree=Pos\t1\tflat@vv\t_\t_",
        "3\t雖\t雖\tADV\tv,副詞,判断,*\t_\t7\tmod\t_\t_",
        "4\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t7\tmod\t_\t_",
        "5\t投\t投\tVERB\tv,動詞,行為,動作\t_\t7\tmod\t_\t_",
        "6\t筆\t筆\tNOUN\tn,名詞,可搬,道具\t_\t5\tcomp:obj\t_\t_",
        "7\t吏\t吏\tNOUN\tn,名詞,人,役割\t_\t0\troot\t_\t_",
      ].join("\n"),
    );
    expect(readingOrder(sentence)).toBe("少小筆投吏非雖");
  });
});

describe("the user's 酒蟲 sent_id 36", () => {
  // 蟲は是れ劉の福、劉の病に非ず — the sentence the whole rule was asked for.
  // Only the 非 clause is new: 愚㆑之 and 成㆓其術㆒ stood before it and stand
  // unchanged after.
  const sentId36 = (): Sentence =>
    realSentence(
      [
        "1\t或\t或\tPRON\tn,代名詞,人称,起格\tPronType=Prs\t2\tsubj\t_\t_",
        "2\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_",
        "3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_",
        "4\t『\t『\tPUNCT\ts,記号,括弧開,*\t_\t20\tpunct\t_\t_",
        "5\t蟲\t蟲\tNOUN\tn,名詞,主体,動物\t_\t20\tsubj\t_\t_",
        "6\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t20\tsubj\t_\t_",
        "7\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t8\tcomp:obj\t_\t_",
        "8\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t9\tmod\t_\t_",
        "9\t福\t福\tNOUN\tn,名詞,可搬,成果物\t_\t20\tsubj\t_\t_",
        "10\t、\t、\tPUNCT\ts,記号,読点,*\t_\t5\tpunct\t_\t_",
        "11\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t14\tmod\t_\t_",
        "12\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t13\tcomp:obj\t_\t_",
        "13\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t14\tmod\t_\t_",
        "14\t病\t病\tNOUN\tn,名詞,不可譲,疾病\t_\t20\tsubj\t_\t_",
        "15\t、\t、\tPUNCT\ts,記号,読点,*\t_\t14\tpunct\t_\t_",
        "16\t僧\t僧\tNOUN\tn,名詞,人,役割\t_\t14\tconj:coord\t_\t_",
        "17\t愚\t愚\tVERB\tv,動詞,描写,形質\tDegree=Pos\t16\tflat@vv\t_\t_",
        "18\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t17\tcomp:obj\t_\t_",
        "19\t以\t以\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t20\tmod\t_\t_",
        "20\t成\t成\tVERB\tv,動詞,行為,生産\t_\t2\tcomp:obj\t_\t_",
        "21\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t22\tdet\t_\t_",
        "22\t術\t術\tNOUN\tn,名詞,可搬,伝達\t_\t20\tcomp:obj\t_\t_",
        "23\t。\t。\tPUNCT\ts,記号,句点,*\t_\t20\tpunct\t_\t_",
      ].join("\n"),
    );

  it("marks the 非 clause 非㆓劉之病㆒ and leaves the rest of the sentence alone", () => {
    expect(annotate(sentId36())).toBe("或言：『蟲是劉之福、非[二]劉之病[一]、僧愚[レ]之以成[二]其術[一]。");
  });

  it("round-trips through its own marks", () => {
    expect(traceMarks(sentId36())).toBe("或言蟲是劉之福劉之病非僧之愚以其術成");
  });
});

describe("executeKunten reads a numeral series that is a chain rather than a fan", () => {
  // 非㆔不㆓高㆒也 above is the shape: the 一 is nested *inside* the 二's group,
  // not a second child of the 三 beside it. Resolving the 二 therefore reads
  // the 一 out along with it, and the search that had opened for the 一 has
  // already had its answer. Going on looking swept every remaining unmarked
  // position — the trailing 也 — into the middle of the group.
  it("does not sweep trailing material into a chain whose lower ranks are already read", () => {
    expect(executeKunten([undefined, "三", "二", "一", undefined])).toEqual([0, 3, 2, 1, 4]);
  });

  it("still reads a chain with unmarked material between its members", () => {
    expect(executeKunten(["三", undefined, "二", undefined, "一", undefined])).toEqual([1, 3, 4, 2, 0, 5]);
  });

  it("leaves an ordinary fan (one child per rank) alone", () => {
    // 三 at the head with 一 and 二 as separate children below it — the shape
    // the guard must not disturb.
    expect(executeKunten(["三", "一", "二"])).toEqual([1, 2, 0]);
    expect(executeKunten(["下", undefined, "上", undefined, "中", undefined])).toEqual([1, 2, 3, 4, 0, 5]);
  });
});
