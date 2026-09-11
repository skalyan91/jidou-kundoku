import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence, Token } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver, oneLexicalWordPair } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
/** The panels' own call shape; see `causativeGate.test.ts` for why the
 * one-argument `findCompoundSpans` is not it. */
const spansOf = (s: Sentence) => findCompoundSpans(s, { kanjidic, jmdict });
const planFor = (s: Sentence) => computeReadingOrder(s, spansOf(s));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve);

const at = (s: Sentence, text: string): Token => s.tokens.find((t) => t.text === text)!;
/** Whether the two panels have been handed one fused word here — the question
 * both of them put to `findCompoundSpans`, asked of the pair rather than of a
 * token, since the failure this file is about is a span that should not exist. */
const spansTogether = (s: Sentence, a: string, b: string): boolean =>
  spansOf(s).some((sp) => sp.tokenIds.includes(at(s, a).id) && sp.tokenIds.includes(at(s, b).id));

// ---------------------------------------------------------------------------
// 以 and 而 are never half of a word.
//
// The lexical-word branch at the foot of `findCompoundSpans` fuses an adjacent
// `mod` pair wherever the reading layer says JMdict reads the two as one
// on'yomi word, and that was claiming the two workhorse particles of Literary
// Chinese: over
// `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
// it formed **126** pairs with one of them standing first — **93** 以 and **33**
// 而 — and the head of the pair is tagged VERB in **112** of them, so
// `onyomiPairReading`'s サ変 turned a particle and the verb after it into a
// coined verb: 以來す, 以降す, 而立す. The verb was swallowed whole.
//
// `NEVER_HALF_OF_A_WORD` (readingResolver.ts) excludes both characters in
// `classify`, one line below the negation exclusion it argues from. Measured
// against a baseline re-rendered immediately before: **123** of the 68,893
// sentences change, and every one is among the 125 carrying such a pair.
// ---------------------------------------------------------------------------

/** 脩其祝、嘏，以降上神與其先祖。 — gold sent_id KR1d0052_009_par7_18-21#3,
 * verbatim, and the reader's own example. 以 is `ADV`/`mod` on a 降 that is
 * `VERB`/`parataxis` and governs 神 as its `comp:obj` — the verb of the clause,
 * with an object, fused away into いこう. */
const XIU_QI_ZHU_JIA = `# sent_id = KR1d0052_009_par7_18-21#3
1\t脩\t脩\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t3\tdet\t_\t_
3\t祝\t祝\tNOUN\tn,名詞,可搬,伝達\t_\t1\tcomp:obj\t_\t_
4\t、\t、\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
5\t嘏\t嘏\tNOUN\tn,名詞,可搬,伝達\t_\t3\tconj:coord\t_\t_
6\t，\t，\tPUNCT\ts,記号,読点,*\t_\t5\tpunct\t_\t_
7\t以\t以\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t8\tmod\t_\t_
8\t降\t降\tVERB\tv,動詞,行為,移動\t_\t1\tparataxis\t_\t_
9\t上\t上\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t10\tmod\t_\t_
10\t神\t神\tNOUN\tn,名詞,人,役割\t_\t8\tcomp:obj\t_\t_
11\t與\t與\tADP\tv,前置詞,関係,*\t_\t14\tcc\t_\t_
12\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t14\tdet\t_\t_
13\t先\t先\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t14\tmod\t_\t_
14\t祖\t祖\tNOUN\tn,名詞,人,関係\t_\t10\tconj:coord\t_\t_
15\t。\t。\tPUNCT\ts,記号,句点,*\t_\t8\tpunct\t_\t_

`;

/** 賞諫者以來之。 — gold sent_id KR2b0041_016_par2_3231-3233, verbatim. The
 * 來 governs 之, so 之を來す is the whole point of the clause and 之を以來
 * loses it. One of the 3 以來 of the 46 that really are the verb 來る; the other
 * 43 are the postposition of 自唐以來, and they were printing 唐より以來す, which
 * is not the postposition either. */
const SHANG_JIAN_ZHE = `# sent_id = KR2b0041_016_par2_3231-3233
1\t賞\t賞\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_
2\t諫\t諫\tVERB\tv,動詞,行為,伝達\tVerbForm=Part\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t1\tcomp:obj\t_\t_
4\t以\t以\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t5\tmod\t_\t_
5\t來\t來\tVERB\tv,動詞,行為,移動\t_\t1\tparataxis\t_\t_
6\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t5\tcomp:obj\t_\t_
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_

`;

/** 三十而立， — 論語 爲政, gold sent_id KR1h0004_002_par4_1-2#1, verbatim.
 * じりつ is a Japanese word meaning "the age of thirty", coined *from* this very
 * line, and reading the line with it is circular: 三十にして立つ is the line, and
 * 立 is its verb. */
const SAN_SHI_ER_LI = `# sent_id = KR1h0004_002_par4_1-2#1
1\t三十\t三十\tNUM\tn,数詞,数,*\t_\t3\tmod\t_\t_
2\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t3\tmod\t_\t_
3\t立\t立\tVERB\tv,動詞,行為,姿勢\t_\t0\troot\t_\t_
4\t，\t，\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_

`;

/** 奮擊大破之。 — gold sent_id KR2b0041_017_par12_622-626, verbatim, and the
 * control that shows the seam is the character and nothing else. Its tree is
 * 以降上神's tree exactly: an `ADV`/`mod` modifier carrying `VerbForm=Conv`,
 * standing immediately before a `VERB`/`parataxis` head that governs a
 * `comp:obj`. Only 大 is a word's first half and 以 is not, so this pair must
 * go on fusing — 之を大破す — while the other comes apart. */
const FEN_JI_DA_PO = `# sent_id = KR2b0041_017_par12_622-626
1\t奮\t奮\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t2\tmod\t_\t_
2\t擊\t擊\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t大\t大\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t4\tmod\t_\t_
4\t破\t破\tVERB\tv,動詞,行為,交流\t_\t2\tparataxis\t_\t_
5\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t4\tcomp:obj\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_

`;

/** 累世以前，坐此者多矣。』 — gold sent_id KR2e0003_254_par1_92-100, verbatim,
 * and the other boundary. Here 以 stands `mod` on a `NOUN` 前, which
 * `findCompoundSpans` fuses on its own account — its adjacent VERB/ADJ-`mod`-onto-
 * a-nominal branch, which this exclusion does not touch — so 以前 keeps its span
 * and its reading with the pair rule out of the way. It is the shape where 以
 * really does close a nominal, and it is why the exclusion is not carried into
 * that branch as well. */
const LEI_SHI_YI_QIAN = `# sent_id = KR2e0003_254_par1_92-100
1\t累\t累\tVERB\tv,動詞,行為,動作\tVerbForm=Part\t2\tmod\t_\t_
2\t世\t世\tNOUN\tn,名詞,時,*\tCase=Tem\t4\tmod\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\tVerbForm=Part\t4\tmod\t_\t_
4\t前\t前\tNOUN\tn,名詞,時,*\tCase=Tem\t9\tmod@tmod\t_\t_
5\t，\t，\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_
6\t坐\t坐\tVERB\tv,動詞,行為,動作\t_\t8\tmod\t_\t_
7\t此\t此\tPRON\tn,代名詞,指示,*\tPronType=Dem\t6\tcomp:obj\t_\t_
8\t者\t者\tPART\tp,助詞,提示,*\t_\t9\tsubj\t_\t_
9\t多\t多\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
10\t矣\t矣\tPART\tp,助詞,句末,*\t_\t9\tdiscourse@sp\t_\t_
11\t。\t。\tPUNCT\ts,記号,句点,*\t_\t9\tpunct\t_\t_
12\t』\t』\tPUNCT\ts,記号,括弧閉,*\t_\t10\tpunct\t_\t_

`;

describe("以 and 而 are never half of a Sino-Japanese word", () => {
  it("reads 以降上神 as 以て…降す, not as a coined 以降す", () => {
    const sentence = parsed(XIU_QI_ZHU_JIA);
    // The pair is refused from **either end**, because being one word is a
    // property of the pair — the same discipline `curatedInRole` follows next
    // door, and the resolver asks about one token at a time.
    expect(oneLexicalWordPair(at(sentence, "以"), sentence, kanjidic, jmdict)).toBeNull();
    expect(oneLexicalWordPair(at(sentence, "降"), sentence, kanjidic, jmdict)).toBeNull();
    expect(spansTogether(sentence, "以", "降")).toBe(false);
    expect(prose(sentence)).toContain("以て");
    // **降す and not 降ろす**: the verb is くだす, "to bring down" — 以て上の神と
    // 其の先の祖を降す — and the character was reading KANJIDIC2's leading
    // お.ろす. kanbun.info glosses 降 くだ **31** times and never お; see 降's
    // entry in `verbLexicon.ts`. Which word it is has nothing to do with what
    // this test is about, and the test is unchanged in what it asserts: 以 and
    // 降 do not fuse, and each draws its own reading over its own character.
    expect(prose(sentence)).toContain("降す");
    expect(prose(sentence)).not.toContain("以降");
    // …and the same word in the 訓読文. A span draws one furigana run over both
    // characters (いこう), so the two panels agreeing here means the ruby has to
    // read 降 as the verb it is, on its own kun, and not as the second half of
    // an on'yomi word.
    expect(furiganaFor(at(sentence, "降"), sentence, resolve, historicalKana, kanjidic)).toBe("くだ");
    expect(furiganaFor(at(sentence, "以"), sentence, resolve, historicalKana, kanjidic)).toBe("もつ");
    // The 以 beside it draws **its own もつ over its own character**, which is
    // the argument for this exclusion put in the other panel's own terms: two
    // characters, two readings, two cells. A fused span would draw one いこう
    // run across both of them instead, and there is no reading here for such a
    // run to be made of. 以 has kept its character in the prose since the
    // reader's ruling on the received text (see `OverrideEntry.spellOutInProse`);
    // before it, the same argument was made the other way round, from 以 having
    // no furigana at all to be the first half of a run.
  });

  it("reads 賞諫者以來之 as 以て之を來る, not 之を以來す", () => {
    const sentence = parsed(SHANG_JIAN_ZHE);
    expect(spansTogether(sentence, "以", "來")).toBe(false);
    expect(prose(sentence)).toContain("以て之を來る");
    expect(prose(sentence)).not.toContain("以來");
  });

  it("reads 三十而立 with 立 as its verb, not as じりつ", () => {
    const sentence = parsed(SAN_SHI_ER_LI);
    expect(oneLexicalWordPair(at(sentence, "而"), sentence, kanjidic, jmdict)).toBeNull();
    expect(spansTogether(sentence, "而", "立")).toBe(false);
    expect(prose(sentence)).toContain("立つ");
    expect(prose(sentence)).not.toContain("而立");
    // た over the character in the other panel — 立 read as the verb by both.
    expect(furiganaFor(at(sentence, "立"), sentence, resolve, historicalKana, kanjidic)).toBe("た");
  });

  it("leaves 大破 fusing — the same tree, and only the character differs", () => {
    // 大 is `ADV`/`mod`, `VerbForm=Conv`, immediately before a `VERB`/`parataxis`
    // head with a `comp:obj`, which is 以降上神's shape to the feature. Nothing
    // in the tree separates them, which is why the exclusion is a list of two
    // characters and not a rule about shapes.
    const sentence = parsed(FEN_JI_DA_PO);
    expect(oneLexicalWordPair(at(sentence, "大"), sentence, kanjidic, jmdict)).not.toBeNull();
    expect(spansTogether(sentence, "大", "破")).toBe(true);
    expect(prose(sentence)).toContain("大破");
  });

  it("leaves 累世以前 alone — a different branch holds that span", () => {
    const sentence = parsed(LEI_SHI_YI_QIAN);
    // The pair rule declines it, as it declines every 以…
    expect(oneLexicalWordPair(at(sentence, "以"), sentence, kanjidic, jmdict)).toBeNull();
    // …and the span survives anyway, off `findCompoundSpans`' own attributive
    // branch, so the reading on the page does not move. Two of the three
    // noun-headed members of the 126 are held this way; the third,
    // 及所部軍使以上七十餘人, is the one token this exclusion costs.
    expect(spansTogether(sentence, "以", "前")).toBe(true);
    expect(prose(sentence)).toContain("以前");
  });
});
