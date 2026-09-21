import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import {
  auxiliaryFormFor,
  caseParticleFor,
  conjugatedOkurigana,
  conjugationSubject,
  decideConjForm,
  isNominalizedObjectPredicate,
  isUnquotedSpeechComplement,
  lexiconEntryFor,
  nextMeaningfulToken,
  readsAsCausative,
} from "../src/kakikudashi/conjugationContext.ts";
import { CAUSATIVE } from "../src/kakikudashi/bungoConjugation.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
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
/** The panels' own call shape; see `adverbialCopulaPrefix.test.ts` for why the
 * one-argument `findCompoundSpans` is not it. */
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve);

/** What the 訓読文 draws over the character and beside it, assembled from the
 * functions `KundokuView.ts`'s own lexicon branch calls — the same helper
 * `adverbialCopulaPrefix.test.ts` uses, and here for the same reason: a 敎 the
 * gate has stood down must be one word in both panels, 教(をし)へ, and not a
 * dropped kanji in the prose beside a reading in the ruby. */
function kundoku(s: Sentence, id: number): { furigana: string | undefined; okurigana: string } {
  const plan = planFor(s);
  const token = s.tokens.find((t) => t.id === id)!;
  const lex = lexiconEntryFor(token, resolve(token, s), s)!;
  const form = decideConjForm(conjugationSubject(token, s), nextMeaningfulToken(plan, token.id), s, lex.conjClass, resolve);
  return { furigana: furiganaFor(token, s, resolve, historicalKana, kanjidic), okurigana: conjugatedOkurigana(lex, form) };
}

// ---------------------------------------------------------------------------
// A 使役 auxiliary with nothing to cause is not one.
//
// 使/令/敎/遣 stand in `AUXILIARY_LEMMAS` keyed on the lemma alone, so every
// token of each rendered as しむ with its kanji dropped — a NOUN as readily as
// a VERB, nothing on that path having ever gated on POS. Over
// `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
// the four are 2,848 tokens and **1,381** of them govern no caused predicate at
// all: 使 617 of 1,541, 令 288 of 637, 敎 273 of 338, 遣 107 of 332.
//
// `readsAsCausative` is the gate, and the をして asks it too — the causee's
// particle marks *the one made to act*, so it cannot survive the stand-down of
// the auxiliary that would have made anyone act. Measured against a baseline
// re-rendered immediately before: **1,046** tokens change in **1,048** of the
// 68,893 sentences.
// ---------------------------------------------------------------------------

/** 子曰：「不教而殺 — gold sent_id KR1h0004_020_par2_156-157#0, verbatim, and the
 * reader's own example. Note the lemma: the form is 教 (U+6559) and the lemma is
 * **敎 (U+654E)**, which is what every table on this path is keyed by. The
 * treebank lemmatizes all 338 occurrences of the character to 敎 and none to 教,
 * so a rule or a scan written against U+6559 matches nothing and looks clean. */
const BU_JIAO_ER_SHA = `# sent_id = KR1h0004_020_par2_156-157#0
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
5\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t6\tmod\t_\t_
6\t教\t敎\tVERB\tv,動詞,行為,伝達\t_\t2\tcomp:obj\t_\t_
7\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t8\tcc\t_\t_
8\t殺\t殺\tVERB\tv,動詞,行為,動作\t_\t6\tconj:coord\t_\t_

`;

/** 教不倦，仁也。 — gold sent_id KR1h0001_003_par2_727-729#1, verbatim. The 敎
 * heads a clause and its only child is a `conj:coord` conjunct, which is no
 * more a caused predicate than the 殺 above is. */
const JIAO_BU_JUAN = `# sent_id = KR1h0001_003_par2_727-729#1
1\t教\t敎\tVERB\tv,動詞,行為,伝達\t_\t5\tsubj\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t倦\t倦\tVERB\tv,動詞,描写,態度\t_\t1\tconj:coord\t_\t_
4\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
5\t仁\t仁\tNOUN\tn,名詞,描写,態度\t_\t0\troot\t_\t_
6\t也\t也\tPART\tp,助詞,句末,*\t_\t5\tdiscourse@sp\t_\t_

`;

/** 惠則足以使人。 — 論語 陽貨, in the shape gold gives it: 使 is the ROOT with a
 * bare nominal object and no act anywhere. It is the sentence that shows why the
 * をして has to move with the しむ — read by relation alone, 人 is the `comp:obj`
 * of a causative and takes をして, so standing only the auxiliary down would have
 * printed 人**をして**使ふ, a causee marking with no causative in the sentence. */
const HUI_ZE_ZU_YI_SHI_REN = `1\t惠\t惠\tVERB\tv,動詞,描写,態度\t_\t4\tsubj\t_\t_
2\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t4\tmod\t_\t_
3\t足\t足\tAUX\tv,動詞,描写,量\tMood=Pot\t4\tmod\t_\t_
4\t使\t使\tVERB\tv,動詞,行為,使役\t_\t0\troot\t_\t_
5\t人\t人\tNOUN\tn,名詞,人,人\t_\t4\tcomp:obj\t_\t_

`;

/** 「后稷教民稼穡， — gold sent_id KR1h0001_005_par4_530-535#0, verbatim. The
 * control, and the one the reader will want to look at: 稼 is a VERB on
 * `comp:obj` under the 敎, so this **is** a caused predicate by the only
 * evidence the tree carries, and the gate leaves the しむ standing. */
const HOUJI_JIAO_MIN = `# sent_id = KR1h0001_005_par4_530-535#0
1\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t3\tpunct\t_\t_
2\t后稷\t后稷\tPROPN\tn,名詞,人,複合的人名\tNameType=Prs\t3\tsubj\t_\t_
3\t教\t敎\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
4\t民\t民\tNOUN\tn,名詞,人,人\t_\t3\tcomp:obl\t_\t_
5\t稼\t稼\tVERB\tv,動詞,行為,動作\t_\t3\tcomp:obj\t_\t_
6\t穡\t穡\tVERB\tv,動詞,行為,動作\t_\t5\tflat@vv\t_\t_

`;

describe("a 使役 character reads しむ only where it governs a caused predicate", () => {
  it("holds 敎 as the ordinary verb 教ふ, 下二段ハ行", () => {
    // The entry the gate made reachable. Wiktionary derives only 教はる
    // (`yodan-ra` をそ + prefix は — "to *be* taught") for 教 and nothing at all
    // for 敎, so the transitive word had no sense under either spelling.
    for (const lemma of ["敎", "教"]) {
      expect(VERB_LEXICON[lemma]).toEqual({ conjClass: "shimo-nidan-ha", reading: "をし" });
    }
  });

  it("reads 不教而殺 as 教へずして殺す, not しめずして殺す", () => {
    const sentence = parsed(BU_JIAO_ER_SHA);
    const jiao = sentence.tokens.find((t) => t.lemma === "敎")!;
    expect(readsAsCausative(jiao, sentence)).toBe(false);
    expect(auxiliaryFormFor(jiao, sentence)).toBeUndefined();
    expect(prose(sentence)).toContain("教へずして殺す");
    expect(prose(sentence)).not.toContain("しめ");
    // …and the same word in the other panel: をし over the character, へ beside
    // it. A dropped kanji in the prose beside a reading in the ruby is the
    // failure both panels sharing `lexiconEntryFor` exists to prevent.
    expect(kundoku(sentence, jiao.id)).toEqual({ furigana: "をし", okurigana: "へ" });
  });

  it("reads 教不倦 as 教へ倦まず — a conjunct is not a caused predicate", () => {
    const sentence = parsed(JIAO_BU_JUAN);
    expect(prose(sentence)).toContain("教へ倦まざる");
    expect(prose(sentence)).not.toContain("しめ");
  });

  it("takes the をして away with the しむ, so 使人 is 人を使ふ", () => {
    const sentence = parsed(HUI_ZE_ZU_YI_SHI_REN);
    const shi = sentence.tokens.find((t) => t.lemma === "使")!;
    const ren = sentence.tokens.find((t) => t.lemma === "人")!;
    expect(readsAsCausative(shi, sentence)).toBe(false);
    // The particle and the auxiliary are one decision, asked of one predicate.
    expect(caseParticleFor(ren, sentence)).toBe("を");
    expect(prose(sentence)).toContain("人を使ふ");
    expect(prose(sentence)).not.toContain("をして");
  });

  it("leaves a genuine causative alone — 后稷教民稼穡 keeps its しむ", () => {
    // **The split, and the part of it that is the reader's.** 稼 is a VERB on
    // `comp:obj` under the 敎, which is exactly the relation 敎民戰's caused
    // predicate arrives on, so nothing in the tree separates "teach the people
    // to sow" from "make the people sow" — the annotation is identical. The
    // gate therefore keeps this among the **65** of 敎's 202 VERB tokens that
    // stay causative, and 民 keeps its をして. Whether a 敎 that governs an act
    // should nevertheless read 民に稼穡を教ふ is a question about the character
    // and not about the tree, and it is the reader's.
    const sentence = parsed(HOUJI_JIAO_MIN);
    const jiao = sentence.tokens.find((t) => t.lemma === "敎")!;
    expect(readsAsCausative(jiao, sentence)).toBe(true);
    expect(auxiliaryFormFor(jiao, sentence)).toBe(CAUSATIVE);
    expect(prose(sentence)).toContain("をして");
  });

  it("still writes しむ for a pinned auxiliary the tree does not support", () => {
    // A pin outranks every rule here, and this one has to: a reader who has
    // chosen しむ on a character has said it *is* the auxiliary. The same
    // exception `auxiliaryFormFor` already makes for a 再読文字, one line above.
    const sentence = parsed(BU_JIAO_ER_SHA);
    const jiao = sentence.tokens.find((t) => t.lemma === "敎")!;
    const pinned = { ...jiao, misc: { Reading: "しむ" } };
    const withPin: Sentence = { tokens: sentence.tokens.map((t) => (t.id === jiao.id ? pinned : t)) };
    expect(readsAsCausative(pinned, withPin)).toBe(true);
    expect(auxiliaryFormFor(pinned, withPin)).toBe(CAUSATIVE);
  });
});

// ---------------------------------------------------------------------------
// …and what a causative governs is not a reported proposition.
//
// 敎 is the character where the two classes meet: the treebank writes
// `v,動詞,行為,伝達` on 188 of its 202 VERB tokens — "to teach" is transmission,
// and the class is right — while `CAUSATIVE_LEMMAS` holds the same lemma. So a
// caused predicate under 敎 satisfied `isSpeechComplement` outright and was read
// with the を a speech verb's unquoted complement takes: 后稷教民稼穡 came out
// 民をして稼穡せ**を**しむ, an object marker wedged between the act and the
// auxiliary that causes it.
//
// `isNominalizedObjectPredicate` carries that guard already and never reached
// these tokens — it excludes a communication verb outright, which is what sent
// every complement of 敎 down this path instead.
//
// Over the same gold, **38** tokens match the shape, every one under 敎 and
// every one on `comp:obj` (VERB 33, ADJ 4, AUX 1); **35** were printing the を.
// Rendered both ways against a baseline taken immediately before, **34** of the
// 68,893 sentences change and every change is that one を deleted.
// ---------------------------------------------------------------------------

/** 教之樹畜， — gold sent_id KR1h0001_013_par22_128-135#2, verbatim. Same shape
 * as 后稷教民稼穡 above, span and all: 樹 is the caused predicate on `comp:obj`
 * and 畜 hangs off it by `flat@vv`, so the two fuse into 樹畜 じゅちく. */
const JIAO_ZHI_SHU_XU = `# sent_id = KR1h0001_013_par22_128-135#2
1\t教\t敎\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t1\tcomp:obl\t_\t_
3\t樹\t樹\tVERB\tv,動詞,行為,設置\t_\t1\tcomp:obj\t_\t_
4\t畜\t畜\tVERB\tv,動詞,行為,交流\t_\t3\tflat@vv\t_\t_
5\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_

`;

/** 教民相愛， — gold sent_id KR1d0052_025_par29_52-55#0, verbatim. **The control
 * that names the cause.** The fault was reported as a span case, and it is not:
 * 愛 is a bare `comp:obj` VERB with an adverb over it, no `flat@vv` anywhere,
 * and it took the same stray を. What the two sentences share is not a span but
 * a 敎 that `isCommunicationVerb` admits. */
const JIAO_MIN_XIANG_AI = `# sent_id = KR1d0052_025_par29_52-55#0
1\t教\t敎\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t民\t民\tNOUN\tn,名詞,人,人\t_\t1\tcomp:obl\t_\t_
3\t相\t相\tADV\tv,副詞,範囲,共同\t_\t4\tmod\t_\t_
4\t愛\t愛\tVERB\tv,動詞,行為,交流\t_\t1\tcomp:obj\t_\t_
5\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_

`;

/** 始教之讓。 — gold sent_id KR1d0052_012_par52_39-44#3, verbatim. The caused
 * predicate is one unfused token here, which is what lets both panels be asked
 * about it: 讓 has an okurigana slot of its own, where a fused 稼穡/樹畜 takes
 * one shared サ変 ending for the whole group and has none. */
const SHI_JIAO_ZHI_RANG = `# sent_id = KR1d0052_012_par52_39-44#3
1\t始\t始\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t2\tmod\t_\t_
2\t教\t敎\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t2\tcomp:obl\t_\t_
4\t讓\t讓\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_

`;

/** 子路問事君。 — gold sent_id KR1h0004_014_par22_1-5, verbatim. The other side
 * of the guard: 問 carries the same `v,動詞,行為,伝達` class as 敎 and stands in
 * no causative table, so its unquoted complement is a reported proposition and
 * keeps its を. */
const ZILU_WEN_SHI_JUN = `# sent_id = KR1h0004_014_par22_1-5
1\t子路\t子路\tPROPN\tn,名詞,人,名\tNameType=Giv\t2\tsubj\t_\t_
2\t問\t問\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t事\t事\tVERB\tv,動詞,行為,交流\t_\t2\tcomp:obj\t_\t_
4\t君\t君\tNOUN\tn,名詞,人,役割\t_\t3\tcomp:obj\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_

`;

describe("a caused predicate takes no particle, under a 敎 the treebank calls a verb of speech", () => {
  it("reads 后稷教民稼穡 as 民をして稼穡せしむ, with no を before the auxiliary", () => {
    const sentence = parsed(HOUJI_JIAO_MIN);
    const jia = sentence.tokens.find((t) => t.lemma === "稼")!;
    // The guard is on the shape both the と rule and the を rule are built from,
    // so it is `isUnquotedSpeechComplement` — the one that was writing the を —
    // that has to have stood down.
    expect(isUnquotedSpeechComplement(jia, sentence)).toBe(false);
    expect(caseParticleFor(jia, sentence)).toBeUndefined();
    expect(prose(sentence)).toBe("「后稷は民をして稼穡せしむ");
  });

  it("reads 教之樹畜 as 之をして樹畜せしむ", () => {
    expect(prose(parsed(JIAO_ZHI_SHU_XU))).toBe("之をして樹畜せしむ");
  });

  it("reads 教民相愛 as 民をして相愛せしむ — no span, and the same stray を", () => {
    // The control. `isNominalizedObjectPredicate` was never the rule at fault
    // and the `flat@vv` span was never the condition: this sentence has neither
    // and had the same を.
    const sentence = parsed(JIAO_MIN_XIANG_AI);
    const ai = sentence.tokens.find((t) => t.lemma === "愛")!;
    expect(isNominalizedObjectPredicate(ai, sentence)).toBe(false);
    expect(findCompoundSpans(sentence, { kanjidic, jmdict }).some((s) => s.tokenIds.includes(ai.id) && s.tokenIds.length > 1)).toBe(
      true,
    );
    expect(prose(sentence)).toBe("民をして相愛せしむ");
  });

  it("says the same thing in both panels — 始教之讓 is 讓(ゆず)ラしむ", () => {
    // The 未然形 in the 訓読文's okurigana slot beside the 未然形 in the prose,
    // and nothing between it and the しむ in either. A particle written on one
    // side and not the other is what this whole guard is against — the two came
    // apart here in exactly that way, `decideConjForm` answering 未然形 off
    // `isCausedOrPassivePredicate` while `caseParticleFor` went on writing the を.
    //
    // **ゆず and not ゆづ, and that is a data gap named rather than papered
    // over.** `historical-kana-index.json` holds 讓 with `ゆずる -> ゆづる` and no
    // entry for the bare stem, while 譲 — the 新字体 the treebank never uses —
    // holds `ゆず -> ゆづ` as well. So the stem this path writes goes through the
    // index and comes back unconverted. It is the index that is short an entry,
    // not this rule that is wrong, and nothing in this file's ownership can
    // supply it; asserting what the app actually prints is what keeps the gap
    // visible instead of hiding it behind a hand-written expectation.
    const sentence = parsed(SHI_JIAO_ZHI_RANG);
    const rang = sentence.tokens.find((t) => t.lemma === "讓")!;
    expect(caseParticleFor(rang, sentence)).toBeUndefined();
    expect(kundoku(sentence, rang.id)).toEqual({ furigana: "ゆず", okurigana: "ら" });
    expect(prose(sentence)).toBe("始まりて之をして讓らしむ");
  });

  it("leaves an ordinary speech complement its を — 敎 is the only overlap", () => {
    // The rule the guard sits in front of is untouched where no causation is in
    // play. 問 is `v,動詞,行為,伝達` like 敎 and is in no causative table, so its
    // unquoted complement keeps the 連体形 and the を it always had.
    const sentence = parsed(ZILU_WEN_SHI_JUN);
    const shi = sentence.tokens.find((t) => t.lemma === "事")!;
    expect(isUnquotedSpeechComplement(shi, sentence)).toBe(true);
    expect(caseParticleFor(shi, sentence)).toBe("を");
  });
});

// ---------------------------------------------------------------------------
// The causee's をして reaches a 者, which this treebank tags `PART`.
//
// `NOMINAL_PREDICATE_POS` holds NOUN/PROPN/PRON, so a headless relative under a
// causative got no particle at all: 使談天者無所取則 came out 天を談する者取則
// する所無からしめ, where the received reading is 天を談ずる者**をして**取則する
// 所無からしめんとす. A 者 nominalizes the clause in front of it and in this slot
// it is a person.
//
// Counted over `lzh_kyoto-sud-{train,dev,test}…sjmerged`, a PART on
// `comp:obj`/`comp:obl` under one of the five causatives is 44 tokens and three
// lemmas — 者 **39**, 所 4, 也 1 — and only 者 is admitted. kanbun.info writes
// をして 164 times and the word before it is 人 31, **者 14**, 民 12, 軍 10.
// ---------------------------------------------------------------------------

/** 使談天者無所取則 — 趙爽's preface to the 周髀算經, the reader's hand-corrected
 * tree. 者 is 使's `comp:obj` and the act 無 its `comp:obl`. */
const SHI_TAN_TIAN_ZHE = `1\t使\t使\tVERB\tv,動詞,行為,使役\t_\t0\troot\t_\t_
2\t談\t談\tVERB\tv,動詞,行為,伝達\tVerbForm=Part\t4\tmod\t_\t_
3\t天\t天\tNOUN\tn,名詞,制度,場\tCase=Loc\t2\tcomp:obj\t_\t_
4\t者\t者\tPART\tp,助詞,提示,*\t_\t1\tcomp:obj\t_\t_
5\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t1\tcomp:obl\t_\t_
6\t所\t所\tPART\tp,助詞,接続,体言化\t_\t5\tcomp:obj\t_\t_
7\t取\t取\tVERB\tv,動詞,行為,得失\t_\t6\tcomp:obj\t_\t_
`;

/** 使賢者 — the same 者 under the same character with nothing being caused. 使
 * here is the plain verb "employ", and the 者 is what is employed. */
const SHI_XIAN_ZHE = `1\t使\t使\tVERB\tv,動詞,行為,使役\t_\t0\troot\t_\t_
2\t賢\t賢\tADJ\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Part\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t1\tcomp:obj\t_\t_
`;

/** 能使敵人自至者 (孫子・虚實) — the 者 that nominalizes the whole causative
 * clause instead of standing as its causee. 敵人 is the one made to act and
 * already has its をして; the 者 stands last, after the act. */
const NENG_SHI_DI_REN = `1\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
2\t使\t使\tVERB\tv,動詞,行為,使役\t_\t1\tcomp:aux\t_\t_
3\t敵\t敵\tNOUN\tn,名詞,人,役割\t_\t4\tmod\t_\t_
4\t人\t人\tNOUN\tn,名詞,人,人\t_\t2\tcomp:obj\t_\t_
5\t自\t自\tADV\tv,副詞,態度,*\t_\t6\tmod\t_\t_
6\t至\t至\tVERB\tv,動詞,行為,移動\t_\t2\tcomp:obl\t_\t_
7\t者\t者\tPART\tp,助詞,提示,*\t_\t2\tcomp:obj\t_\t_
`;

describe("a 者 standing as the causee takes をして", () => {
  it("使談天者無所取則 -> 天を談する者をして…無からしむ", () => {
    const sentence = parsed(SHI_TAN_TIAN_ZHE);
    const zhe = sentence.tokens.find((t) => t.lemma === "者")!;
    expect(caseParticleFor(zhe, sentence)).toBe("をして");
    expect(prose(sentence)).toContain("者をして");
  });

  it("leaves a 者 that closes the causative clause alone — 能使敵人自至者", () => {
    // The causee is 敵人 and it keeps its をして; the 者 stands after the act,
    // so it is nominalizing the whole clause and a second をして there would
    // mark two causees in one predication.
    const sentence = parsed(NENG_SHI_DI_REN);
    expect(caseParticleFor(sentence.tokens.find((t) => t.lemma === "人")!, sentence)).toBe("をして");
    expect(caseParticleFor(sentence.tokens.find((t) => t.lemma === "者")!, sentence)).toBeUndefined();
  });

  it("still writes nothing on a 者 with no causative over it", () => {
    // The bound is `readsAsCausative`'s, shared with the しむ: a 使 that causes
    // nothing is the plain verb 使ふ, and 賢者をして使ふ would mark a causee in a
    // sentence with no causative in it. It is the same bound the NOUN arm has
    // carried since 惠則足以使人, and the 者 arm inherits it rather than
    // restating it.
    const sentence = parsed(SHI_XIAN_ZHE);
    const zhe = sentence.tokens.find((t) => t.lemma === "者")!;
    expect(readsAsCausative(sentence.tokens.find((t) => t.lemma === "使")!, sentence)).toBe(false);
    // Nothing, not を: the catch-all 者 branch in `readingResolver.ts` keeps the
    // character and puts もの over it, and its topic は is bounded to a subject
    // slot. What this asserts is that the をして is gone with the causation.
    expect(caseParticleFor(zhe, sentence)).toBeUndefined();
  });
});
