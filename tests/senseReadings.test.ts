import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import {
  conjugatedOkurigana,
  conjugationSubject,
  decideConjForm,
  lexiconEntryFor,
  nextMeaningfulToken,
} from "../src/kakikudashi/conjugationContext.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { KANJI_RETAINED_ADVERBS, retainedAdverbApplies, retainedAdverbParts } from "../src/reading/classicalEnding.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
/** The panels' own call shape; the one-argument `findCompoundSpans` renders a
 * different app — see `adverbialCopulaPrefix.test.ts`. */
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve);
const tokenOf = (s: Sentence, text: string): { token: import("../src/parse/types.ts").Token; id: number } => {
  const token = s.tokens.find((t) => t.text === text)!;
  return { token, id: token.id };
};

/** What the 訓読文 draws over an *inflecting* word and beside it, assembled from
 * the functions `KundokuView.ts`'s own lexicon branch calls — the same helper
 * `causativeGate.test.ts` uses, and here for the same reason: a reading this
 * app writes into the prose must be the one the ruby shows. */
function kundokuVerb(s: Sentence, id: number): { furigana: string | undefined; okurigana: string } {
  const plan = planFor(s);
  const token = s.tokens.find((t) => t.id === id)!;
  const lex = lexiconEntryFor(token, resolve(token, s), s)!;
  const form = decideConjForm(conjugationSubject(token, s), nextMeaningfulToken(plan, token.id), s, lex.conjClass, resolve);
  return { furigana: furiganaFor(token, s, resolve, historicalKana, kanjidic), okurigana: conjugatedOkurigana(lex, form) };
}

// ---------------------------------------------------------------------------
// Four characters whose *word* the app had wrong, three of them exposed by the
// 使役 gate standing しむ down (`readsAsCausative`) and putting the character's
// own reading on the page for the first time.
//
// The thread they share is that a table was answering for a character in a role
// it does not hold: `overrides.json` — every entry of which is written out in
// kana with the kanji dropped — answering for a content noun (使), the build
// script's one derived sense answering with a paradigm that spells no word
// (遣), a transitivity vote answering with whichever of two transitive words
// KANJIDIC2 lists first (調), and a per-lemma adverb rule answering for a
// character with four roles (與).
// ---------------------------------------------------------------------------

/** 武帝遣使。 — gold sent_id KR2b0041_009_par7_57-60, verbatim, and the one
 * sentence that carries both halves of the pair: a 遣 with no caused predicate
 * under it, and its object a NOUN 使. The treebank glosses them `send` and
 * `envoy` in its own MISC column. It printed 武帝は**つかふ**を**遣す** — a finite
 * verb where "envoy" belongs and a word that is neither 遣る nor 遣はす. */
const WUDI_QIAN_SHI = `# sent_id = KR2b0041_009_par7_57-60
1\t武\t武\tPROPN\tn,名詞,人,その他の人名\tNameType=Prs\t2\tcompound\t_\tGloss=Wu|SpaceAfter=No
2\t帝\t帝\tNOUN\tn,名詞,人,役割\t_\t3\tsubj\t_\tGloss=emperor|SpaceAfter=No
3\t遣\t遣\tVERB\tv,動詞,行為,使役\t_\t0\troot\t_\tGloss=send|SpaceAfter=No
4\t使\t使\tNOUN\tn,名詞,人,役割\t_\t3\tcomp:obj\t_\tGloss=envoy|SpaceAfter=No
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No

`;

/** 匈奴使來。 — gold sent_id KR2b0041_010_par2_450-453, verbatim. A nominal 使
 * as the *subject*, so nothing but the character's own reading is at stake. */
const XIONGNU_SHI_LAI = `# sent_id = KR2b0041_010_par2_450-453
1\t匈奴\t匈奴\tNOUN\tn,名詞,主体,集団\t_\t2\tmod\t_\tGloss=Xiongnu|SpaceAfter=No
2\t使\t使\tNOUN\tn,名詞,人,役割\t_\t3\tsubj\t_\tGloss=envoy|SpaceAfter=No
3\t來\t來\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\tGloss=come|SpaceAfter=No
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No

`;

/** 惠則足以使人。」 — gold sent_id KR1h0004_017_par6_30-33#4, verbatim: 論語 陽貨,
 * and the control for the 使 pair. A **VERB** 使 with a bare nominal object and
 * no act anywhere, which the causative gate already reads 人を使ふ — the
 * character kept, the reading from `VERB_LEXICON`'s derived 四段ハ行 つか. It
 * must be untouched by anything done for the noun. */
const HUI_ZE_ZU_YI_SHI_REN = `# sent_id = KR1h0004_017_par6_30-33#4
1\t惠\t惠\tADV\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Conv\t3\tmod\t_\tGloss=benevolent|SpaceAfter=No
2\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t3\tmod\t_\tGloss=then|SpaceAfter=No
3\t足\t足\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\tGloss=enough|SpaceAfter=No
4\t以\t以\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t3\tmod\t_\tGloss=use|SpaceAfter=No
5\t使\t使\tVERB\tv,動詞,行為,使役\t_\t3\tcomp:aux\t_\tGloss=[make-to-do]|SpaceAfter=No
6\t人\t人\tNOUN\tn,名詞,人,人\t_\t5\tcomp:obj\t_\tGloss=person|SpacesAfter=\\n
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No
8\t」\t」\tPUNCT\ts,記号,括弧閉,*\t_\t6\tpunct\t_\tSpaceAfter=No

`;

/** 轉漕調兵。 — gold sent_id KR2b0041_009_par1_2213-2216, verbatim. 調 with an
 * object, and the object is men: mustering troops, which is ととのふ. It read
 * 兵を調**ぶ** — しらぶ, "to tune" — because `pickByTransitivity`, asked about a
 * 調 that governs an object, answers with the first *transitive* kun KANJIDIC2
 * lists, and both しら.べる and ととの.える are transitive. */
const ZHUAN_CAO_DIAO_BING = `# sent_id = KR2b0041_009_par1_2213-2216
1\t轉\t轉\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t3\tmod\t_\tGloss=turn|SpaceAfter=No
2\t漕\t漕\tVERB\tv,動詞,行為,動作\t_\t1\tflat@vv\t_\tSpaceAfter=No
3\t調\t調\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\tGloss=tune|SpaceAfter=No
4\t兵\t兵\tNOUN\tn,名詞,人,役割\t_\t3\tcomp:obj\t_\tGloss=soldier|SpaceAfter=No
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No

`;

/** 有戶則有調。 — gold sent_id KR2b0041_016_par9_190-194, verbatim, and the
 * control for 調: the 租庸調 tax, a NOUN, read on'yomi てう. A nominal takes only
 * a character's *bare* kun and the supplement's ととの.ふ is dotted, so this must
 * not move. */
const YOU_HU_ZE_YOU_DIAO = `# sent_id = KR2b0041_016_par9_190-194
1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t4\tmod\t_\tGloss=have|SpaceAfter=No
2\t戶\t戶\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t1\tcomp:obj\t_\tGloss=door|SpaceAfter=No
3\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t4\tmod\t_\tGloss=then|SpaceAfter=No
4\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\tGloss=have|SpaceAfter=No
5\t調\t調\tNOUN\tn,名詞,制度,儀礼\t_\t4\tcomp:obj\t_\tSpaceAfter=No
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\tSpaceAfter=No

`;

/** 未可與適道； — gold sent_id KR1h0004_009_par30_1-2#1, verbatim: 論語 子罕,
 * 「未だ與に道に適くべからず」. The adverbial 與, tagged ADV with `VerbForm=Conv`
 * exactly as all 61 of its gold tokens are. */
const WEI_KE_YU_SHI_DAO = `# sent_id = KR1h0004_009_par30_1-2#1
1\t未\t未\tADV\tv,副詞,否定,有界\tPolarity=Neg\t2\tmod\t_\tGloss=not-yet|SpaceAfter=No
2\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\tGloss=possible|SpaceAfter=No
3\t與\t與\tADV\tv,動詞,行為,交流\tVerbForm=Conv\t2\tmod\t_\tGloss=participate|SpaceAfter=No
4\t適\t適\tVERB\tv,動詞,行為,移動\t_\t2\tcomp:aux\t_\tGloss=go-to|SpaceAfter=No
5\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t4\tcomp:obj\t_\tGloss=doctrine|SpaceAfter=No
6\t；\t；\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\tSpaceAfter=No

`;

/** 子罕言利與命與仁。 — gold sent_id KR1h0004_009_title#1, verbatim, and the
 * control that matters most for 與: the **prepositional** 與, ADP on `cc`, read
 * と with the character dropped. It is 1,406 of the character's tokens against
 * 61 adverbial ones, and putting 與 in `KANJI_RETAINED_ADVERBS` printed 利與に命
 * on every one of them until the rule was gated on the word rather than on the
 * character. */
const LI_YU_MING = `# sent_id = KR1h0004_009_title#1
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t3\tsubj\t_\tGloss=master|SpaceAfter=No
2\t罕\t罕\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t3\tmod\t_\tGloss=rare|SpaceAfter=No
3\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\tGloss=speak|SpaceAfter=No
4\t利\t利\tNOUN\tn,名詞,描写,形質\t_\t3\tcomp:obj\t_\tGloss=profit|SpaceAfter=No
5\t與\t與\tADP\tv,前置詞,関係,*\t_\t6\tcc\t_\tGloss=associate-with|SpaceAfter=No
6\t命\t命\tNOUN\tn,名詞,不可譲,身体\t_\t4\tconj:coord\t_\tGloss=life|SpaceAfter=No
7\t與\t與\tADP\tv,前置詞,関係,*\t_\t8\tcc\t_\tGloss=associate-with|SpaceAfter=No
8\t仁\t仁\tNOUN\tn,名詞,描写,態度\t_\t6\tconj:coord\t_\tGloss=benevolence|SpacesAfter=\\n
9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No

`;

describe("a nominal 使 is an envoy, and keeps its character", () => {
  it("reads 匈奴使來 as 匈奴の使來る, with つかひ over the character", () => {
    const sentence = parsed(XIONGNU_SHI_LAI);
    expect(prose(sentence)).toBe("匈奴の使來る");
    expect(prose(sentence)).not.toContain("つかふ");
    // The kanji is in the prose, so the reading has to be *over* it in the
    // 訓読文 and not beside it in the okurigana lane — which is the whole reason
    // the reading is a supplementary kun and not an `overrides.json` entry.
    const { token } = tokenOf(sentence, "使");
    expect(furiganaFor(token, sentence, resolve, historicalKana, kanjidic)).toBe("つかひ");
  });

  it("leaves the verb 使ふ alone — 惠則足以使人 is still 人を使ふ", () => {
    const sentence = parsed(HUI_ZE_ZU_YI_SHI_REN);
    expect(prose(sentence)).toContain("人を使ふ");
    const { id } = tokenOf(sentence, "使");
    expect(kundokuVerb(sentence, id)).toEqual({ furigana: "つか", okurigana: "ふ" });
  });
});

describe("a bare 遣 is 遣はす — 遣る's stem on 遣はす's paradigm was neither word", () => {
  it("holds 遣 as 四段サ行 つか + は", () => {
    expect(VERB_LEXICON["遣"]).toEqual({ conjClass: "yodan-sa", okuriganaPrefix: "は", reading: "つか" });
  });

  it("reads 武帝遣使 as 武帝は使を遣はす, both halves of it", () => {
    const sentence = parsed(WUDI_QIAN_SHI);
    expect(prose(sentence)).toBe("武帝は使を遣はす");
    expect(prose(sentence)).not.toContain("遣す");
    // つか over 遣 as over 使, which is the point of the split: the two
    // characters share the stem, and this app's convention shows the は beside
    // the kanji (遣はす) as it shows 来たる.
    const { id: qian } = tokenOf(sentence, "遣");
    expect(kundokuVerb(sentence, qian)).toEqual({ furigana: "つか", okurigana: "はす" });
    const { token: shi } = tokenOf(sentence, "使");
    expect(furiganaFor(shi, sentence, resolve, historicalKana, kanjidic)).toBe("つかひ");
  });
});

describe("a verbal 調 is ととのふ, and transitivity is not what separates it from しらぶ", () => {
  it("holds 調 as 下二段ハ行 ととの", () => {
    expect(VERB_LEXICON["調"]).toEqual({ conjClass: "shimo-nidan-ha", reading: "ととの" });
  });

  it("reads 轉漕調兵 as 兵を調ふ, not 兵を調ぶ", () => {
    // The token has an object, which is exactly the evidence that used to send
    // it to しら.べる: KANJIDIC2 lists 調べる before 調える and JMdict calls both
    // transitive, so the vote separated nothing and answered by list order.
    const sentence = parsed(ZHUAN_CAO_DIAO_BING);
    expect(prose(sentence)).toBe("轉漕て兵を調ふ");
    expect(prose(sentence)).not.toContain("調ぶ");
    const { id } = tokenOf(sentence, "調");
    expect(kundokuVerb(sentence, id)).toEqual({ furigana: "ととの", okurigana: "ふ" });
  });

  it("leaves the 租庸調 tax on its on'yomi — 有戶則有調 is 調有り, てう", () => {
    const sentence = parsed(YOU_HU_ZE_YOU_DIAO);
    expect(prose(sentence)).toBe("戶有れば則ち調有り");
    const { token } = tokenOf(sentence, "調");
    expect(furiganaFor(token, sentence, resolve, historicalKana, kanjidic)).toBe("てう");
  });
});

describe("the comitative 與 keeps its kanji — 與(とも)に, not ともに", () => {
  it("lists 與/与 as a kanji-retained adverb, divided とも + に", () => {
    // The division is asserted in the table, as 豈's あに + に is: KANJIDIC2
    // holds the reading ともに but holds it *undotted*, so the dictionary states
    // no boundary to read.
    for (const char of ["與", "与"]) {
      expect(KANJI_RETAINED_ADVERBS[char]).toEqual({ reading: "ともに", okurigana: "に" });
    }
  });

  it("reads 未可與適道 with 與に, and draws とも over the character", () => {
    const sentence = parsed(WEI_KE_YU_SHI_DAO);
    expect(prose(sentence)).toContain("與に");
    expect(prose(sentence)).not.toContain("ともに");
    // The 訓読文's own branch, and it must reach the same division: the panel
    // asks `retainedAdverbApplies` and then `retainedAdverbParts`, both of them
    // beside the table so the prose and the ruby divide the word once.
    const { token } = tokenOf(sentence, "與");
    const resolved = resolve(token, sentence);
    expect(retainedAdverbApplies(token.lemma, resolved)).toBe(true);
    expect(retainedAdverbParts(resolved.reading, resolved.retainedAdverbOkurigana)).toEqual({
      reading: "とも",
      okurigana: "に",
    });
  });

  it("leaves the prepositional 與 as と — 子罕言利與命與仁 keeps 利と命と仁", () => {
    // The character is ADP 1,406 times against 61 adverbial uses, and the
    // retained-adverb rule arrives per *lemma*. Without the word gate this
    // printed 利與に命. The 與 here resolves to と, which is not the word the
    // table names, so the rule stands down and the ordinary override branch
    // writes the particle.
    //
    // 仁**と**を, with the と that closes a 與 coordination after its last
    // conjunct (`coordinationClosingParticle`), which is how kanbun.info reads
    // this line: 子、罕に利と命と仁とを言う. This assertion is about the two 與,
    // which are unchanged.
    const sentence = parsed(LI_YU_MING);
    expect(prose(sentence)).toBe("子罕て利と命と仁とを言ふ");
    expect(prose(sentence)).not.toContain("與");
    const yu = sentence.tokens.filter((t) => t.text === "與");
    expect(yu).toHaveLength(2);
    for (const token of yu) {
      expect(retainedAdverbApplies(token.lemma, resolve(token, sentence))).toBe(false);
    }
  });
});
