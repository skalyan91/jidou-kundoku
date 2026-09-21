import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { caseParticleFor, isConditionalTemporalClause } from "../src/kakikudashi/conjugationContext.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";

// ---------------------------------------------------------------------------
// A clause answered by 則 is a protasis and reads 已然形 + ば **whichever way
// round the tree hangs the edge between it and the clause that answers it**.
//
// `isConditionalTemporalClause` was written for one of the two arrangements:
// the protasis hangs off the apodosis by `mod`, with the 則 an ADV child of the
// apodosis. The other arrangement makes the two clauses siblings in a narrative
// chain — the apodosis hangs off the protasis by `parataxis` — and it is the
// treebank's commonest: counted over `lzh_kyoto-sud-{train,dev,test}…sjmerged`,
// the governor of a すなはち-class ADV stands on `parataxis` 1,825 times against
// 1,059 roots and 502 `conj:coord`, and in 1,683 of them the token the apodosis
// hangs off is a verbal VERB.
//
// Against the received readings: kanbun.info writes ば則ち **335** times, 218 of
// them れば、則ち — so the ば is not optional decoration, it is how the pair is
// built. See `conditionalApodosisParataxis`.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve);
/** By character, not by id: `parseConllu` renumbers a sentence from 0. */
const at = (s: Sentence, text: string) => s.tokens.find((t) => t.text === text)!;

/** 詭異之說出，則兩端之理生 — 趙爽's preface to the 周髀算經, as the reader's own
 * hand-corrected tree has it. The apodosis 生 hangs off the protasis 出 by
 * `parataxis` and the 則 is 生's ADV child, standing between the two clauses. */
const SHUO_CHU_ZE_LI_SHENG = `1\t詭\t詭\tADJ\tv,動詞,描写,形質\tDegree=Pos\t3\tcomp:obj\t_\t_
2\t異\t異\tADJ\tv,動詞,描写,形質\tDegree=Pos\t1\tflat@vv\t_\t_
3\t之\t之\tPART\tp,助詞,接続,属格\t_\t4\tmod\t_\t_
4\t說\t說\tNOUN\tn,名詞,可搬,伝達\t_\t5\tsubj\t_\t_
5\t出\t出\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
6\t，\t，\tPUNCT\ts,記号,読点,*\t_\t5\tpunct\t_\t_
7\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t12\tmod\t_\t_
8\t兩\t兩\tNUM\tn,名詞,数量,*\t_\t9\tmod\t_\t_
9\t端\t端\tNOUN\tn,名詞,描写,形質\t_\t10\tcomp:obj\t_\t_
10\t之\t之\tPART\tp,助詞,接続,属格\t_\t11\tmod\t_\t_
11\t理\t理\tNOUN\tn,名詞,可搬,伝達\t_\t12\tsubj\t_\t_
12\t生\t生\tVERB\tv,動詞,変化,性質\t_\t5\tparataxis\t_\t_
`;

/** 忠告，不可則止 — the shape the `clauseEnd < 則 < apodosis` bound is for. 可
 * hangs off 告 by `parataxis` exactly as 生 hangs off 出 above, but the 則
 * stands **after** 可, because what it answers is 不可 and not 忠告. A rule that
 * only asked "is there a 則 on my `parataxis` child" would read 忠告すれば. */
const ZHONG_GAO_BU_KE_ZE_ZHI = `1\t忠\t忠\tADV\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Conv\t2\tmod\t_\t_
2\t告\t告\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t，\t，\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t5\tmod\t_\t_
5\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t2\tparataxis\t_\t_
6\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t5\tmod\t_\t_
7\t止\t止\tVERB\tv,動詞,行為,動作\t_\t5\tcomp:aux\t_\t_
`;

describe("an apodosis hanging off its protasis by parataxis still writes the ば", () => {
  it("詭異之說出，則兩端之理生 -> 詭異の說出づれば、則ち兩端の理生く", () => {
    const sentence = parsed(SHUO_CHU_ZE_LI_SHENG);
    const chu = at(sentence, "出");
    expect(isConditionalTemporalClause(chu, sentence)).toBe(true);
    expect(caseParticleFor(chu, sentence)).toBe("ば");
    expect(prose(sentence)).toContain("出づれば");
  });

  it("does not claim a clause whose 則 stands after the apodosis it marks", () => {
    // 忠告，不可則止. The 則 is a child of 可 as it is of 生 above, and the
    // `parataxis` edge is the same edge — the only thing separating the two is
    // where the connective is written, which is what the id bound reads.
    const sentence = parsed(ZHONG_GAO_BU_KE_ZE_ZHI);
    const gao = at(sentence, "告");
    expect(isConditionalTemporalClause(gao, sentence)).toBe(false);
    expect(caseParticleFor(gao, sentence)).toBeUndefined();
    expect(prose(sentence)).not.toContain("告ぐれば");
  });
});
