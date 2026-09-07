import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import overrides from "../src/reading/overrides.json" with { type: "json" };
import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence, Token } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import {
  isSentenceFinalParticleUse,
  readsAsSentenceFinalWord,
  sentenceFinalParticleFor,
} from "../src/kakikudashi/conjugationContext.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
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
/** The panels' own call shape — `findCompoundSpans(sentence, { kanjidic, jmdict })`,
 * never the one-argument form, which sees no lexical span and renders a
 * different app. */
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve);
const at = (s: Sentence, id: number): Token => s.tokens.find((t) => t.id === id)!;

// ---------------------------------------------------------------------------
// **句頭 is not 句末: the sentence-initial discourse marker and the
// sentence-final particle are two relations, and both panels were reading them
// as one.**
//
// 夫 is two words on one character. Sentence-initially it is **それ**, the
// topic-introducer — 夫れ仁者は…, "now, the benevolent man…" — and
// sentence-finally it is **かな**, the exclamatory (命矣夫 命なるかな). Nothing
// about the character says which; the relation does, and says it cleanly. Over
// the recoded gold
// (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
// 夫 stands PART/`discourse` **499** times, 495 of them not last in their
// clause, and PART/`discourse@sp` **29** times, 27 of them last. The parser
// even names the distinction in the tag it hangs beside the relation:
// `p,助詞,句頭,*` for the first and `p,助詞,句末,*` for the second — 751 of the
// 826 bare-`discourse` tokens carry 句頭 and 12,876 of the 13,047
// `discourse@sp` carry 句末.
//
// Both panels routed *either* relation into the branch that reads
// `SENTENCE_FINAL_PARTICLES`, so all 499 of the first group were given the
// second group's word. The narrowing is one condition in three places —
// `isSentenceFinalParticleUse` and `hasSentenceFinalParticle` in
// conjugationContext.ts, and the dep test each panel asks beside the first —
// and the tests below are written on the shared predicate as well as on the
// prose, because a 夫 read それ in the 書き下し文 and かな in the 訓読文 is the
// split that arrangement exists to prevent.
//
// 夫 is not the only lemma bare `discourse` carries, only the one the table
// knew: its other 327 tokens are 其 (171), 蓋 (67) and a tail of INTJ, and
// those were **silenced** rather than mis-read — a lemma the table does not
// know renders as nothing from that branch — so 蓋有不知而作之者 lost its 蓋
// altogether. Every tree below is copied row for row out of the gold.
// ---------------------------------------------------------------------------

/** 夫仁者，己欲立而立人，己欲達而達人。 — gold sent_id KR1h0004_006_par30_36-44,
 * verbatim. 論語 雍也, and the received reading is 夫れ仁者は己立たんと欲して人を
 * 立て、己達せんと欲して人を達す. */
const FU_REN_ZHE = `# sent_id = KR1h0004_006_par30_36-44
1\t夫\t夫\tPART\tp,助詞,句頭,*\t_\t3\tdiscourse\t_\t_
2\t仁\t仁\tADJ\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Part\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t6\tsubj\t_\t_
4\t，\t，\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
5\t己\t己\tPRON\tn,代名詞,人称,他\tPronType=Prs|Reflex=Yes\t6\tsubj\t_\t_
6\t欲\t欲\tAUX\tv,助動詞,願望,*\tMood=Des\t0\troot\t_\t_
7\t立\t立\tVERB\tv,動詞,行為,姿勢\t_\t6\tcomp:aux\t_\t_
8\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t9\tcc\t_\t_
9\t立\t立\tVERB\tv,動詞,行為,姿勢\t_\t7\tconj:coord\t_\t_
10\t人\t人\tNOUN\tn,名詞,人,人\tShared=No\t9\tcomp:obj\t_\t_
11\t，\t，\tPUNCT\ts,記号,読点,*\t_\t6\tpunct\t_\t_
12\t己\t己\tPRON\tn,代名詞,人称,他\tPronType=Prs|Reflex=Yes\t13\tsubj\t_\t_
13\t欲\t欲\tAUX\tv,助動詞,願望,*\tMood=Des\t6\tcomp:obj\t_\t_
14\t達\t達\tVERB\tv,動詞,行為,動作\t_\t13\tcomp:aux\t_\t_
15\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t16\tcc\t_\t_
16\t達\t達\tVERB\tv,動詞,行為,動作\t_\t14\tconj:coord\t_\t_
17\t人\t人\tNOUN\tn,名詞,人,人\tShared=No\t16\tcomp:obj\t_\t_
18\t。\t。\tPUNCT\ts,記号,句点,*\t_\t13\tpunct\t_\t_
`;

/** 命矣夫！ — gold sent_id KR1h0004_006_par10_1-4#3, verbatim. 論語 雍也, the
 * received 命なるかな, and the other of 夫's two words: both particles here are
 * `discourse@sp`, and neither this sentence nor this entry is touched by the
 * narrowing. */
const MING_YI_FU = `# sent_id = KR1h0004_006_par10_1-4#3
1\t命\t命\tNOUN\tn,名詞,可搬,伝達\t_\t0\troot\t_\t_
2\t矣\t矣\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t夫\t夫\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
4\t！\t！\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_
`;

/** 子曰：「蓋有不知而作之者，我無是也。 — gold sent_id KR1h0004_007_par28_1-2,
 * verbatim. 論語 述而, received 子曰く、蓋し知らずして之を作る者有らん、我は是れ
 * 無きなり. The 蓋 is bare `discourse` and was rendering as nothing at all. */
const GAI_YOU = `# sent_id = KR1h0004_007_par28_1-2
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
5\t蓋\t蓋\tPART\tp,助詞,句頭,*\t_\t6\tdiscourse\t_\t_
6\t有\t有\tVERB\tv,動詞,存在,存在\t_\t2\tcomp:obj\t_\t_
7\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t8\tmod\t_\t_
8\t知\t知\tVERB\tv,動詞,行為,動作\t_\t12\tmod\t_\t_
9\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t10\tcc\t_\t_
10\t作\t作\tVERB\tv,動詞,行為,生産\t_\t8\tconj:coord\t_\t_
11\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs|Shared=No\t10\tcomp:obj\t_\t_
12\t者\t者\tPART\tp,助詞,提示,*\t_\t6\tcomp:obj\t_\t_
13\t，\t，\tPUNCT\ts,記号,読点,*\t_\t6\tpunct\t_\t_
14\t我\t我\tPRON\tn,代名詞,人称,止格\tPerson=1|PronType=Prs\t15\tsubj\t_\t_
15\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t6\tcomp:obj\t_\t_
16\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t15\tcomp:obj\t_\t_
17\t也\t也\tPART\tp,助詞,句末,*\t_\t15\tdiscourse@sp\t_\t_
18\t。\t。\tPUNCT\ts,記号,句点,*\t_\t15\tpunct\t_\t_
`;

describe("a 句頭 discourse marker is not a sentence-final particle", () => {
  it("refuses a bare-`discourse` 夫, which is the gate both panels share", () => {
    // The whole of the fix, stated where both panels read it. Before this the
    // relation test in each panel answered yes on `discourse` as well, and this
    // predicate answered yes on its own second line.
    const s = parsed(FU_REN_ZHE);
    expect(isSentenceFinalParticleUse(at(s, 0), s)).toBe(false);
  });

  it("still admits a `discourse@sp` 夫, and still reads it かな", () => {
    // Nothing about the exclamatory half moved. The 矣 beside it stays silent,
    // which is the reader's own ruling and what the received 命なるかな shows.
    const s = parsed(MING_YI_FU);
    const fu = at(s, 2);
    expect(isSentenceFinalParticleUse(fu, s)).toBe(true);
    expect(sentenceFinalParticleFor(fu, s)).toBe("かな");
    // …in the furigana slot, over the character, as every particle this table
    // reads is set — see `SENTENCE_FINAL_WORD_LEMMAS`.
    expect(readsAsSentenceFinalWord(fu, s)).toBe(true);
    expect(sentenceFinalParticleFor(at(s, 1), s)).toBe("");
    expect(prose(s)).toContain("かな");
  });

  it("writes 夫れ into the 書き下し文, where it wrote かな仁なる者は", () => {
    // The received 夫れ仁者は…. What the app makes of 欲's two clauses is not
    // this rule's business; that the sentence opens on 夫れ and not on a かな
    // belonging to the other end of a sentence is.
    expect(prose(parsed(FU_REN_ZHE))).toMatch(/^夫れ/);
  });

  it("draws そ over the character in the 訓読文, where it drew カナ", () => {
    // The other panel, asserted as that panel decides it: KundokuView.ts asks
    // the gate *first* and, when it answers yes, sets `sentenceFinalParticleFor`
    // over the character and never reaches `furiganaFor` at all. So both halves
    // are the claim — the gate declines the token, and what is drawn over it is
    // then それ's own furigana. `furiganaFor` was never the thing that was
    // wrong; the branch in front of it was taking the token away.
    //
    // そ and not それ because `READING_ENDING_SPLITS` divides it — the same
    // division 其れ takes, which is the whole of what "make それ and これ
    // consistent" asked for, and the reason 夫 needed no rule of its own.
    const s = parsed(FU_REN_ZHE);
    const fu = at(s, 0);
    expect(fu.dep === "discourse@sp" || isSentenceFinalParticleUse(fu, s)).toBe(false);
    expect(furiganaFor(fu, s, resolve, historicalKana, kanjidic)).toBe("そ");
  });

  it("keeps 蓋し, which the branch was silencing outright", () => {
    // 蓋 is bare `discourse` in all 67 of its gold tokens and is not in
    // `SENTENCE_FINAL_PARTICLES` at all, so the branch gave it the empty string
    // and the character vanished: 蓋有不知而作之者 read 知らずして之を作る者有り.
    // 蓋し is what the received text writes — 21 times over the whole
    // kanbun.info corpus, against no けだし at all — and the kanji is kept by
    // `KANJI_RETAINED_ADVERBS`, so the kana beside it is just the し.
    const written = prose(parsed(GAI_YOU));
    expect(written).toContain("蓋し");
    expect(written).not.toContain("けだし");
  });
});

// ---------------------------------------------------------------------------
// **The それ/これ family, and the one flag that decides whether a character
// survives into the prose.**
//
// The received text never spells these words out. Over the whole of
// kanbun.info's 書き下し文 — 178,468 characters — the kana それ and これ occur
// **zero** times between them, while the characters stand throughout: 其の
// 1,412, 夫れ 147, 是れ 130, 此れ 129, 其れ 104. So every entry in this family
// wants `spellOutInProse: false`, and five of the six had it; 夫 was the one
// that did not, and printed それ in kana wherever it was reached at all.
//
// Written over the table rather than over a list of characters, so that a
// seventh entry cannot join the family without answering the same question.
// ---------------------------------------------------------------------------

describe("every それ/これ entry keeps its character in the prose", () => {
  it("holds for all six, 夫 included", () => {
    const family = overrides.filter((entry) => {
      const reading = (entry as { reading?: string }).reading ?? "";
      return reading === "これ" || reading === "それ" || (reading === "そ" && (entry as { okurigana?: string }).okurigana === "の");
    });
    // 是/之(comp@expl)/之(comp:obj)/之(bare)/諸/其(det)/其(bare)/夫 — the whole
    // family, named here so that the filter above cannot quietly stop matching.
    expect(family.map((entry) => (entry as { char: string }).char)).toEqual(
      ["是", "之", "之", "之", "其", "其", "諸", "夫"],
    );
    for (const entry of family) {
      expect((entry as { spellOutInProse?: boolean; char: string }).spellOutInProse, (entry as { char: string }).char).toBe(false);
    }
  });
});
