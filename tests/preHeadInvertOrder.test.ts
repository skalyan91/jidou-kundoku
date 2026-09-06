import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";

/** **An INVERT child the source already put in front of its governor keeps its
 * own place in the text, and does not travel with the governor.**
 *
 * `reorderEngine.ts` gathers a governor and everything spliced onto it into one
 * run that moves as a unit — that is the whole of what a kaeriten can state.
 * An inverted child whose subtree finishes *before* the governor's own word is
 * not spliced onto anything: the reader reaches it by reading straight on, and
 * `returningOrders` has always known that, since it drops exactly these
 * children from the splice group rather than writing a "return" that returns
 * forwards. What it could not do from there was stop the child being carried
 * inside the governor's run anyway — and a run that travels drags such a child
 * **across its own siblings**.
 *
 * 曾子's 吾日三省吾身 is the case, and it is the received reading that names it:
 * kanbun.info prints 吾(われ)日(ひ)に三(み)たび吾(わ)が身を省みる. 日 is 省's
 * `mod@tmod` and inverts; 三 is a plain `mod` of the same 省 and does not; both
 * stand in front of it in the source. 日 was carried into 省's atom at 省's
 * position while 三 stayed at its own, so the two adverbs came out swapped —
 * われ**三たび日に**わが身を省く — with nothing on the page to account for it,
 * since the marks (correctly) name neither.
 *
 * **Measured** over `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`,
 * 68,893 sentences, against a baseline re-rendered immediately before and again
 * immediately after: see the accompanying report for the table. The shape is
 * uniform — a temporal or locative adverbial goes back in front of the sibling
 * the source put it in front of (內自省 → 內に自ら省みる, 今也則亡 →
 * 今をやすなはち亡ぶ, 明日遂行 → 明日につひに行く, 少之時血氣未定 →
 * 少なきの時に血氣いまだ定まらず).
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
/** The panels' own call shape — `findCompoundSpans(sentence, { kanjidic, jmdict })`,
 * never the one-argument form, which renders a different app. */
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve).replace(/\s+/g, "");
const orderText = (s: Sentence): string => {
  const byId = new Map(s.tokens.map((t) => [t.id, t.text]));
  return planFor(s)
    .order.map((id) => byId.get(id))
    .join("");
};

/** 吾日三省吾身 — 學而 4, tokens 5-10 of the reader's own annotated file,
 * verbatim but for the ids being renumbered from 1. */
const THRICE_DAILY = `# text = 吾日三省吾身
1	吾	吾	PRON	n,代名詞,人称,起格	Person=1|PronType=Prs	4	subj	_	_
2	日	日	NOUN	n,名詞,時,*	Case=Tem	4	mod@tmod	_	_
3	三	三	NUM	n,数詞,数字,*	_	4	mod	_	_
4	省	省	VERB	v,動詞,行為,動作	_	4	root	_	_
5	吾	吾	PRON	n,代名詞,人称,起格	Person=1|PronType=Prs	6	det	_	_
6	身	身	NOUN	n,名詞,不可譲,身体	_	4	comp:obj	_	_
`;

describe("吾日三省吾身 — the pre-verbal adverbial that was overtaking its sibling", () => {
  it("reads 日 and 三 in the order the source has them", () => {
    // 日's own subtree is the single token 日, which finishes at source position
    // 2, in front of 省's word at 4. Nothing returns to 省 from it.
    expect(orderText(parsed(THRICE_DAILY))).toBe("吾日三吾身省");
  });

  it("…so the 書き下し文 is 日に三たび, which is the received reading", () => {
    expect(prose(parsed(THRICE_DAILY))).toBe("吾日に三たび吾が身を省みる");
  });

  it("marks the one genuine return and no other", () => {
    // 吾身 is the only child that has to be brought back over 省 — 省㆓…身㆒,
    // a numeral group rather than a レ点 because the returned-over clause is
    // two characters. 日 gets no mark at all, which is the point: a mark there
    // would say "return" about a stretch the reader has already read.
    // (Ids are `parseConllu`'s own 0-based ones: 3 is 省 and 5 is 身.)
    const s = parsed(THRICE_DAILY);
    const plan = planFor(s);
    assignKundokuTen(plan);
    const marks = buildPlainKuntenMarks(plan);
    expect([...marks.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [3, "二"],
      [5, "一"],
    ]);
  });

  it("and the marks alone recover that same order", () => {
    // The executor works from the kaeriten and nothing else, so this is where
    // the two panels are held to one answer: what the 訓読文 draws has to trace
    // the order the 書き下し文 was written from.
    const s = parsed(THRICE_DAILY);
    const plan = planFor(s);
    assignKundokuTen(plan);
    const marks = buildPlainKuntenMarks(plan);
    const maxId = Math.max(...s.tokens.map((t) => t.id));
    const kuntens = Array.from({ length: maxId + 1 }, (_, id) => marks.get(id));
    const byId = new Map(s.tokens.map((t) => [t.id, t]));
    const isPunct = (id: number) => byId.get(id)?.dep === "punct";
    expect(executeKunten(kuntens, isPunct).filter((id) => byId.has(id))).toEqual(plan.order);
  });
});

/** 見不賢而內自省也 — 里仁, gold. 內 is `mod@tmod`/`Case=Loc` on 省 and みづから
 * is a plain `mod` of it; both precede. The received reading is 內に自ら省みる,
 * and the swap put the reflexive first. Kept beside the sentence above because
 * it is the *locative* half of the same shape, and because it is a gold tree
 * rather than a reconstruction. */
const INWARD = `# text = 內自省
1	內	內	NOUN	n,名詞,固定物,関係	Case=Loc	3	mod@tmod	_	_
2	自	自	PRON	n,代名詞,人称,他	PronType=Prs|Reflex=Yes	3	mod	_	_
3	省	省	VERB	v,動詞,行為,動作	_	3	root	_	_
`;

describe("內自省 — the same shape with a locative", () => {
  it("keeps 內 in front of みづから", () => {
    expect(prose(parsed(INWARD))).toBe("內に自ら省みる");
  });
});
