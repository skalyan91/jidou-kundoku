import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { conjugatedOkurigana, lexiconEntryFor } from "../src/kakikudashi/conjugationContext.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";

// ---------------------------------------------------------------------------
// 同 has a paradigm (同じく, 同じからず), and an adjective with a direct object
// is its 連用形 plus す: 世を同じくして, 其の塵を同じくす. See
// `factitiveAdjectiveLexiconEntry` in `conjugationContext.ts` and 同's entry in
// `verbLexicon.ts`.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
const prose = (s: Sentence): string => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

/** 夫不可陷之楯、與無不陷之矛、不可同世而立。 — 韓非子 難一 (矛盾), as
 * lzh_sud_kyoto 0.3.3 parses it. **世 comes back VERB with a nominal xpos**
 * (`n,名詞,制度,場`), which is why the rule reads the xpos as well as the POS:
 * the case the fault was reported on is the case a POS-only gate misses. */
const MUJUN_SAME_WORLD = `# text = 夫不可陷之楯、與無不陷之矛、不可同世而立。
1\t夫\t夫\tPART\tp,助詞,句頭,*\t_\t3\tdiscourse\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t6\tudep\t_\t_
4\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t5\tcomp:obj\t_\t_
5\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:aux\t_\t_
6\t楯\t楯\tNOUN\tn,名詞,可搬,道具\t_\t0\troot\t_\t_
7\t、\t、\tPUNCT\ts,記号,読点,*\t_\t6\tpunct\t_\t_
8\t與\t與\tADP\tv,前置詞,関係,*\t_\t6\tconj:coord\t_\t_
9\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t8\tcomp:obj\t_\t_
10\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t11\tmod\t_\t_
11\t陷\t陷\tVERB\tv,動詞,行為,動作\t_\t12\tcomp:obj\t_\t_
12\t之\t之\tPART\tp,助詞,接続,属格\t_\t13\tmod\t_\t_
13\t矛\t矛\tNOUN\tn,名詞,可搬,道具\t_\t9\tcomp:obj\t_\t_
14\t、\t、\tPUNCT\ts,記号,読点,*\t_\t8\tpunct\t_\t_
15\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t16\tmod\t_\t_
16\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t8\tconj:coord\t_\t_
17\t同\t同\tADJ\tv,動詞,描写,形質\tDegree=Pos\t16\tcomp:aux\t_\t_
18\t世\t世\tVERB\tn,名詞,制度,場\t_\t17\tcomp:obj\t_\t_
19\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t20\tcc\t_\t_
20\t立\t立\tVERB\tv,動詞,行為,姿勢\t_\t17\tconj:coord\t_\t_
21\t。\t。\tPUNCT\ts,記号,句点,*\t_\t16\tpunct\t_\t_

`;

/** 此兩者同出而異名。 — 老子 1, roushi01#2 in the corpus parses, verbatim. The
 * control: 同 has no object here (the parser tags it an ADV converb), and 異
 * has one but a verb sense of its own leads its entry, so neither may become
 * a サ変 verb. */
const SAME_ORIGIN = `# text = 此兩者同出而異名。
1\t此\t此\tPRON\tn,代名詞,指示,*\tPronType=Dem\t3\tdet\t_\t_
2\t兩\t兩\tNOUN\tn,名詞,数量,*\t_\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t5\tsubj\t_\t_
4\t同\t同\tADV\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Conv\t5\tmod\t_\t_
5\t出\t出\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
6\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t7\tcc\t_\t_
7\t異\t異\tADJ\tv,動詞,描写,形質\tDegree=Pos\t5\tconj:coord\t_\t_
8\t名\t名\tNOUN\tn,名詞,不可譲,属性\t_\t7\tcomp:obj\t_\t_
9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_

`;

describe("同 conjugates as おなじ", () => {
  it("writes the シク cells on a voiced じ and the irregular 終止形 whole", () => {
    const same = VERB_LEXICON["同"];
    expect(same?.reading).toBe("おな");
    expect(conjugatedOkurigana(same, "renyou")).toBe("じく");
    expect(conjugatedOkurigana(same, "rentai")).toBe("じき");
    expect(conjugatedOkurigana(same, "mizenKar")).toBe("じから");
    expect(conjugatedOkurigana(same, "izen")).toBe("じけれ");
    // おなじ, not おなじし: the one cell the ク paradigm under the prefix gets wrong.
    expect(conjugatedOkurigana(same, "shuushi")).toBe("じ");
  });

  it("makes nothing of a 同 without an object, or of an adjective with a verb of its own", () => {
    const sentence = parsed(SAME_ORIGIN);
    const same = sentence.tokens.find((t) => t.text === "同")!;
    expect(lexiconEntryFor(same, resolve(same, sentence), sentence)?.conjClass).not.toBe("sa-hen");
    const differ = sentence.tokens.find((t) => t.text === "異")!;
    expect(lexiconEntryFor(differ, resolve(differ, sentence), sentence)?.conjClass).not.toBe("sa-hen");
    expect(prose(sentence)).not.toContain("同じくす");
  });
});

describe("an adjective with a direct object is its 連用形 plus す", () => {
  it("reads 不可同世而立 as 世を同じくして立つ可からず", () => {
    const sentence = parsed(MUJUN_SAME_WORLD);
    const same = sentence.tokens.find((t) => t.text === "同")!;
    const entry = lexiconEntryFor(same, resolve(same, sentence), sentence);
    expect(entry?.conjClass).toBe("sa-hen");
    expect(entry?.okuriganaPrefix).toBe("じく");
    // The furigana is still the adjective's: おな over 同, じくし beside it.
    expect(entry?.reading).toBe("おな");
    expect(prose(sentence)).toContain("同じくして立つ可からず");
    // The case particle is a separate layer and reads the POS, so the VERB
    // tag on 世 still costs the を. With the tag the fault was reported on
    // (NOUN) the whole phrase is the received one.
    const asNoun = parsed(MUJUN_SAME_WORLD.replace("\t世\t世\tVERB\t", "\t世\t世\tNOUN\t"));
    expect(prose(asNoun)).toContain("世を同じくして立つ可からず");
  });

  it("reads 趙見我走、必空壁逐我 as 壁を空しくして, a second adjective of the list", () => {
    // haisui#4 in the kanbun.info corpus parses, verbatim.
    const sentence = parsed(`# text = 誡曰、趙見我走、必空壁逐我。
1\t誡\t誡\tVERB\tv,動詞,行為,態度\t_\t2\tmod\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t、\t、\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t趙\t趙\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t5\tsubj\t_\t_
5\t見\t見\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
6\t我\t我\tPRON\tn,代名詞,人称,止格\tPerson=1|PronType=Prs\t7\tsubj\t_\t_
7\t走\t走\tVERB\tv,動詞,行為,移動\t_\t5\tcomp:obj\t_\t_
8\t、\t、\tPUNCT\ts,記号,読点,*\t_\t5\tpunct\t_\t_
9\t必\t必\tADV\tv,副詞,判断,確定\t_\t10\tmod\t_\t_
10\t空\t空\tADJ\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t2\tcomp:obj\t_\t_
11\t壁\t壁\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t10\tcomp:obj\t_\t_
12\t逐\t逐\tVERB\tv,動詞,行為,交流\t_\t10\tparataxis\t_\t_
13\t我\t我\tPRON\tn,代名詞,人称,止格\tPerson=1|PronType=Prs\t12\tcomp:obj\t_\t_
14\t。\t。\tPUNCT\ts,記号,句点,*\t_\t10\tpunct\t_\t_

`);
    const empty = sentence.tokens.find((t) => t.text === "空")!;
    expect(lexiconEntryFor(empty, resolve(empty, sentence), sentence)?.conjClass).toBe("sa-hen");
    expect(prose(sentence)).toContain("壁を空しくし");
  });

  it("leaves 多怨 alone, where the object is the adjective's subject", () => {
    // rongo0412#1, verbatim (the gold row, glosses dropped): 放於利而行、多怨 is
    // 利に放りて行へば、怨み多し. 多 is outside the list on the measurement in
    // `factitiveAdjectiveLexiconEntry` — twelve passages lost, most of them this
    // shape.
    const sentence = parsed(`# text = 子曰：「放於利而行，多怨。」
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t5\tpunct\t_\t_
5\t放\t放\tVERB\tv,動詞,行為,動作\t_\t2\tconj:coord\t_\t_
6\t於\t於\tADP\tv,前置詞,基盤,*\t_\t5\tcomp:obl\t_\t_
7\t利\t利\tNOUN\tn,名詞,描写,形質\t_\t6\tcomp:obj\t_\t_
8\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t9\tcc\t_\t_
9\t行\t行\tVERB\tv,動詞,行為,動作\t_\t5\tconj:coord\t_\t_
10\t，\t，\tPUNCT\ts,記号,読点,*\t_\t5\tpunct\t_\t_
11\t多\t多\tADJ\tv,動詞,描写,量\tDegree=Pos\t5\tparataxis\t_\t_
12\t怨\t怨\tNOUN\tn,名詞,思考,思考\t_\t11\tcomp:obj\t_\t_
13\t。\t。\tPUNCT\ts,記号,句点,*\t_\t11\tpunct\t_\t_
14\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t12\tpunct\t_\t_

`);
    const many = sentence.tokens.find((t) => t.text === "多")!;
    expect(lexiconEntryFor(many, resolve(many, sentence), sentence)?.conjClass).not.toBe("sa-hen");
    expect(prose(sentence)).not.toContain("多くす");
  });

  it("leaves an adjective whose complement is a clause alone", () => {
    // Built by hand, with 同 standing where 難 would: an ADJ of the list over a
    // VERB complement is a clause the adjective is said of, not an object, so
    // the complement's category keeps the rule off it.
    const sentence = parsed(`# text = 同養也。
1\t同\t同\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
2\t養\t養\tVERB\tv,動詞,行為,飲食\t_\t1\tcomp:obj\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_

`);
    const same = sentence.tokens.find((t) => t.text === "同")!;
    expect(lexiconEntryFor(same, resolve(same, sentence), sentence)?.conjClass).not.toBe("sa-hen");
  });
});
