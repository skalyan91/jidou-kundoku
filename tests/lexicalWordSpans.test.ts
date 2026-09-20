import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import type { Sentence } from "../src/parse/types.ts";

/** The real indices, because the whole question this file is about is one only
 * a dictionary can answer: 大破 is たいは and 深知 is not a word, and nothing in
 * the tree separates them (see `findCompoundSpans`' lexical-word branch). */
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const lexicon = { kanjidic, jmdict };
const resolve = createReadingResolver(kanjidic, jmdict);

const sentenceOf = (conllu: string): Sentence => {
  const tree = parseConllu(conllu);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
};
const textOf = (s: Sentence, order: number[]): string => {
  const byId = new Map(s.tokens.map((t) => [t.id, t]));
  return order.map((id) => byId.get(id)?.text ?? "").join("");
};
const spanTexts = (s: Sentence, withLexicon: boolean) =>
  findCompoundSpans(s, withLexicon ? lexicon : undefined).map((sp) => sp.text);
const readingOrder = (s: Sentence, withLexicon: boolean) =>
  textOf(s, computeReadingOrder(s, findCompoundSpans(s, withLexicon ? lexicon : undefined)).order);

// 大破秦兵鉅鹿下。 — gold, verbatim.
const DA_PO = `1\t大\t大\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t2\tmod\t_\t_
2\t破\t破\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_
3\t秦\t秦\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t4\tmod\t_\t_
4\t兵\t兵\tNOUN\tn,名詞,人,役割\t_\t2\tcomp:obl\t_\t_
5\t鉅鹿\t鉅鹿\tPROPN\tn,名詞,固定物,地名\tCase=Loc|NameType=Geo\t6\tmod\t_\t_
6\t下\t下\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t2\tcomp:obj\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
`;

// 三分天下 — gold, verbatim.
const SAN_FEN = `1\t三\t三\tNUM\tn,数詞,数字,*\t_\t2\tmod\t_\t_
2\t分\t分\tVERB\tv,動詞,行為,設置\t_\t0\troot\t_\t_
3\t天\t天\tNOUN\tn,名詞,制度,場\tCase=Loc\t4\tcompound\t_\t_
4\t下\t下\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t2\tcomp:obj\t_\t_
`;

describe("a pair the reading layer calls one lexical word travels as one", () => {
  it("大破秦兵鉅鹿下 — the object moves in front of the whole word, not into the middle of it", () => {
    const s = sentenceOf(DA_PO);
    // The fault, still visible with no dictionary to ask: 大 is a dependent of
    // nothing that moves, so 破 goes behind its object and leaves it stranded.
    expect(spanTexts(s, false)).toEqual([]);
    expect(readingOrder(s, false)).toBe("大秦兵鉅鹿下破。");
    // …and the repair. 大破 is JMdict's たいは, so the two are one word and the
    // whole word follows the object.
    expect(spanTexts(s, true)).toContain("大破");
    expect(readingOrder(s, true)).toBe("秦兵鉅鹿下大破。");
  });

  it("三分天下 — 天下を三分, off the numeral table rather than the dictionary", () => {
    const s = sentenceOf(SAN_FEN);
    expect(readingOrder(s, false)).toBe("三天下分");
    expect(spanTexts(s, true)).toContain("三分");
    expect(readingOrder(s, true)).toBe("天下三分");
  });

  it("does not fuse a pair no dictionary holds — 深知其意 keeps the adverb in front of the object", () => {
    // The same tree as 大破秦兵: an adverbial `mod` over a transitive verb.
    // What separates them is only that 深知 is not a word, and 深く其の意を知る
    // is the reading — which is why this branch cannot be a rule about POS.
    const s = sentenceOf(
      `1\t深\t深\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t2\tmod\t_\t_
2\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t其\t其\tPRON\tn,代名詞,人称,inclusive\t_\t4\tdet\t_\t_
4\t意\t意\tNOUN\tn,名詞,思考,態度\t_\t2\tcomp:obj\t_\t_
`,
    );
    expect(spanTexts(s, true)).toEqual([]);
    expect(readingOrder(s, true)).toBe("深其意知");
  });

  it("asks nothing without the indices, which is the help figure's path", () => {
    // `HelpModal.ts` renders a fixed sample with no index fetched behind it.
    // Passing no lexicon must simply leave the tree-driven spans alone rather
    // than half-answering.
    const s = sentenceOf(DA_PO);
    expect(findCompoundSpans(s)).toEqual(findCompoundSpans(s, { kanjidic: null, jmdict: null }));
  });
});

describe("the stand-downs are asked of the pair, not of the token in hand", () => {
  it("若當來世 — 當來 is a JMdict headword and 當 is a 再読文字, so the pair is refused", () => {
    // Reached from 來, the `isRereadUse` guard at the top of the loop never
    // sees 當 at all. Fused, 當 is dropped from the walk as a non-carrier
    // member and the まさに…べし it is read with disappears from both panels —
    // which is what made this the one sentence outside the affected set to
    // move before the guard was asked of both members.
    const s = sentenceOf(
      `1\t若\t若\tADV\tv,副詞,判断,推定\t_\t6\tmod\t_\t_
2\t當\t當\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t3\tmod\t_\t_
3\t來\t來\tVERB\tv,動詞,行為,移動\tVerbForm=Part\t4\tmod\t_\t_
4\t世\t世\tNOUN\tn,名詞,制度,場\tCase=Loc\t6\tsubj\t_\t_
5\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
6\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
7\t眾\t衆\tNOUN\tn,名詞,人,役割\t_\t8\tmod\t_\t_
8\t生\t生\tNOUN\tn,名詞,行為,*\t_\t6\tcomp:obj\t_\t_
`,
    );
    expect(spanTexts(s, true)).not.toContain("當來");
    expect(generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, lexicon)), resolve)).toContain("べし");
  });
});

describe("a lexical word takes no genitive の between its halves", () => {
  it("門人問曰 — 門人, not 門の人, which is what the furigana was already saying", () => {
    // **The reader's ruling**: *anything treated as a span in kundoku should be
    // treated as one in kakikudashi.* The resolver reads this pair もん + じん
    // off `oneLexicalWordPair`, so both panels have been printing もんじん over
    // these two characters while the prose wrote 門の人 — a genitive inside a
    // word the furigana calls one word. Fusing settles it, and the same
    // settlement carries 天子 (not 天の子), 陛下, 社稷, 夫人 and 元年.
    //
    // This is the 秦王 exclusion above met from the other side: 秦王 stays
    // unfused because `NameType=Nat` says the two are a state and its king,
    // and 門人 fuses because the reading layer says the two are one word.
    // (秦王 takes no の either; `isStateNameOnItsPeople` withholds it on the
    // received readings, without fusing the pair.)
    const s = sentenceOf(
      `1\t門\t門\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t2\tmod\t_\t_
2\t人\t人\tNOUN\tn,名詞,人,人\t_\t4\tsubj\t_\t_
3\t問\t問\tADV\tv,動詞,行為,伝達\tVerbForm=Conv\t4\tmod\t_\t_
4\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
`,
    );
    const prose = (withLexicon: boolean) =>
      generateKakikudashi(
        computeReadingOrder(s, findCompoundSpans(s, withLexicon ? lexicon : undefined)),
        resolve,
      );
    expect(prose(false)).toContain("門の人");
    expect(spanTexts(s, true)).toContain("門人");
    expect(prose(true)).toContain("門人");
    expect(prose(true)).not.toContain("門の人");
  });
});
