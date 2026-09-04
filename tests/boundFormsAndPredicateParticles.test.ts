import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sentence } from "../src/parse/types.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { caseParticleFor, decideConjForm } from "../src/kakikudashi/conjugationContext.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

// ---------------------------------------------------------------------------
// Three rules about what a *predicate* takes, all of them read off the
// treebank's own tags rather than off a hand-list:
//
//  - 係り結び — a predicate closed by ぞ/なむ/や/か is bound to the 連体形;
//  - `comp:pred` — と under the copula 爲, に under a verb of becoming;
//  - 非 — the nominal predicate it denies takes に.
//
// Trees are written out rather than parsed live, as `adverbialClauseParticles`
// and `coordinatedProtasis` do and for the same reason: the shape is what is
// being tested, and the live parser does not always return it. Where a case
// comes from the reader's own 酒蟲 tree the sentence id is named.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

function sentenceOf(rows: string): Sentence {
  const tree = parseConllu(rows);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

function prose(sentence: Sentence): string {
  return generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), resolve);
}

function named(sentence: Sentence, text: string) {
  const token = sentence.tokens.find((t) => t.text === text);
  if (!token) throw new Error(`no ${text} in the sentence`);
  return token;
}

// ---------------------------------------------------------------------------
// 1. 係り結び — ぞ / なむ / や / か bind a 連体形.
// ---------------------------------------------------------------------------

describe("a predicate closed by a ぞ/なむ/や/か takes 連体形", () => {
  /** 酒蟲 sent_id 35's tail: 豈飲啄固有數乎？ — the 豈…乎 frame, whose 乎 reads
   * か rather than the default や, and whose 有 is therefore bound. */
  const QI_YOU_SHU_HU = `1\t豈\t豈\tADV\tv,副詞,疑問,反語\t_\t3\tmod\t_\t_
2\t固\t固\tADV\tv,副詞,判断,確実\t_\t3\tmod\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
4\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t3\tcomp:obj\t_\t_
5\t乎\t乎\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`;

  it("binds 有 to 有る in front of the か — 數有るか, not 數有りか", () => {
    const sentence = sentenceOf(QI_YOU_SHU_HU);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "乎"), sentence, undefined, resolve)).toBe("rentai");
    expect(prose(sentence)).toContain("有るか");
    expect(prose(sentence)).not.toContain("有りか");
  });

  it("binds it before a や too — the particle's *reading* is the trigger, not the character", () => {
    // The same 乎 with no 豈 in the sentence reads や, which binds a 連体形 just
    // as か does. Both are in the set; only こそ (已然形) is not, and nothing in
    // the app reads こそ at all — see `BINDING_PARTICLE_READINGS`.
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t乎\t乎\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "乎"), sentence, undefined, resolve)).toBe("rentai");
  });

  it("不亦說乎 is 亦說ばしからざるや — the negation is asked first, and takes the 連体形 too", () => {
    // The ordering this test was written for is unchanged and is what it still
    // checks: what stands between 說 and the 乎 is ず, so it is ず the particle
    // lands on; 說 owes the negation a 未然形, which the negation rule answers
    // before this one is reached, and `negationForm` decides ず's own form.
    //
    // **The expected ず is now ざる, by the reader's decision and not by drift.**
    // This asserted 亦說ばしから*ず*や, on a lexical carve-out in
    // `boundByBindingParticle` that refused the 連体形 wherever a 亦 stood in the
    // frame. The reader has overruled it — *"Don't carve out 不亦"* — so the
    // 係り結び rule now applies to 不亦…乎 like every other negation before a
    // や/か. See `boundByBindingParticle`, which keeps the measurement the
    // carve-out was made on.
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
2\t亦\t亦\tADV\tv,副詞,頻度,重複\t_\t3\tmod\t_\t_
3\t說\t說\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
4\t乎\t乎\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "說"), named(sentence, "不"), sentence, undefined, resolve)).toBe("mizen");
    expect(prose(sentence)).toContain("ざるや");
  });

  it("leaves a 也 alone — なり is not a 係助詞", () => {
    // The set is exact strings, so 也's なり and 哉's かな (which merely *starts*
    // with か) are both outside it.
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "也"), sentence, undefined, resolve)).not.toBe(
      "rentai",
    );
  });

  it("leaves a 哉 alone too — かな is not か", () => {
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t哉\t哉\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "哉"), sentence, undefined, resolve)).not.toBe(
      "rentai",
    );
  });

  it("writes no て on the bound form — 然歟否歟 is 然るや, not 然るてや", () => {
    // 酒蟲 sent_id 38. The parser marks 然 `VerbForm=Conv`, which `converbSuffix`
    // would otherwise read as a converb and glue a て onto — the same collision
    // `isConditionalTemporalClause` already has with it (酌めてば), and now
    // refused for every 連体形 rather than only for the 已然形.
    const sentence = sentenceOf(`1\t然\t然\tADV\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Conv\t3\tsubj\t_\t_
2\t歟\t歟\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t否\t否\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
4\t歟\t歟\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`);
    expect(prose(sentence)).toContain("然る");
    expect(prose(sentence)).not.toContain("然るて");
  });
});

// ---------------------------------------------------------------------------
// 2. `comp:pred` — と under the copula, に under a verb of becoming.
// ---------------------------------------------------------------------------

describe("a predicative complement takes と under the copula and に otherwise", () => {
  it("keeps 不以飲爲累也 on its と — 累と爲さず", () => {
    // 酒蟲 sent_id 3, and the anchor for the 96% case: `comp:pred` in this
    // treebank is very nearly 爲's alone (5,580 of 5,814 edges under a
    // `VerbType=Cop` governor), and 爲 is 〜と爲す/〜と爲る.
    //
    // The FEATS column is deliberately empty here, exactly as the reader's own
    // tree has it: `v,動詞,存在,存在` carries the same fact and is what the rule
    // falls back to. A `VerbType=Cop` test alone read this as a becoming verb.
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
2\t以\t以\tVERB\tv,動詞,行為,動作\t_\t4\tmod\t_\t_
3\t飲\t飲\tNOUN\tv,動詞,行為,飲食\t_\t2\tcomp:obj\t_\t_
4\t爲\t爲\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
5\t累\t累\tNOUN\tn,名詞,可搬,成果物\t_\t4\tcomp:pred\t_\t_
`);
    expect(caseParticleFor(named(sentence, "累"), sentence)).toBe("と");
    expect(prose(sentence)).toContain("累と");
  });

  it("keeps a `VerbType=Cop` governor on と through the feature as well", () => {
    const sentence = sentenceOf(`1\t爲\t爲\tAUX\tv,動詞,存在,存在\tVerbType=Cop\t0\troot\t_\t_
2\t輪\t輪\tNOUN\tn,名詞,可搬,道具\t_\t1\tcomp:pred\t_\t_
`);
    expect(caseParticleFor(named(sentence, "輪"), sentence)).toBe("と");
  });

  it("keeps the 如/奈 comparison on と — 如何 is an idiom, not a case-marked complement", () => {
    // 210 of the 234 non-copular edges, and this branch declines to touch them:
    // `Degree=Equ` is the same feature `isComparativeYu` reads.
    const sentence = sentenceOf(`1\t如\t如\tVERB\tv,動詞,行為,分類\tDegree=Equ\t0\troot\t_\t_
2\t何\t何\tPRON\tn,代名詞,疑問,*\tPronType=Int\t1\tcomp:pred\t_\t_
`);
    expect(caseParticleFor(named(sentence, "何"), sentence)).toBe("と");
  });

  it("gives に to a `comp:pred` under a verb of becoming — 成佳釀 is 佳釀に成る", () => {
    // The reader's 酒蟲 sent_id 30 wants this, and the way to it is the label:
    // 釀 is a *predicative* complement of 成, which is SUD's `comp:pred`, not
    // the `comp:obj` it now carries. 成 carries `comp:pred` 0 times in the whole
    // treebank, so no rule could have found this from the tree as annotated.
    const sentence = sentenceOf(`1\t成\t成\tVERB\tv,動詞,行為,生産\t_\t0\troot\t_\t_
2\t佳\t佳\tADJ\tn,名詞,描写,形質\tDegree=Pos\t3\tmod\t_\t_
3\t釀\t釀\tNOUN\tn,名詞,可搬,糧食\t_\t1\tcomp:pred\t_\t_
`);
    expect(caseParticleFor(named(sentence, "釀"), sentence)).toBe("に");
    expect(prose(sentence)).toContain("釀に成る");
  });

  it("gives に to a verb of arriving too — 適齊 is 齊に適く", () => {
    const sentence = sentenceOf(`1\t適\t適\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
2\t齊\t齊\tPROPN\tn,名詞,固定物,地名\tNameType=Geo\t1\tcomp:pred\t_\t_
`);
    expect(caseParticleFor(named(sentence, "齊"), sentence)).toBe("に");
  });

  it("leaves the transitive 成 alone — 以成其術 keeps その術を成す", () => {
    // The reason the split cannot be keyed on the lemma: 成's two senses share
    // `comp:obj`, and 成其術 ("accomplishes his trick") is a real object.
    const sentence = sentenceOf(`1\t以\t以\tADV\tv,副詞,推量,推定\tVerbForm=Conv\t2\tmod\t_\t_
2\t成\t成\tVERB\tv,動詞,行為,生産\t_\t0\troot\t_\t_
3\t其\t其\tPRON\tn,代名詞,指示,基本\tPerson=3|PronType=Prs\t4\tdet\t_\t_
4\t術\t術\tNOUN\tn,名詞,可搬,成果物\t_\t2\tcomp:obj\t_\t_
`);
    expect(caseParticleFor(named(sentence, "術"), sentence)).toBe("を");
    expect(prose(sentence)).toContain("術を成す");
  });
});

// ---------------------------------------------------------------------------
// 3. 非 — the nominal predicate it denies takes に.
// ---------------------------------------------------------------------------

describe("the nominal predicate a 非 denies takes に", () => {
  /** 酒蟲 sent_id 36: 蟲是劉之福、非劉之病 — 非 hangs off 病 on `mod`, which is
   * how 1,584 of the corpus's 1,736 非 attach. */
  const FEI_LIU_ZHI_BING = `1\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t4\tmod\t_\t_
2\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t3\tcomp:obj\t_\t_
3\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t4\tmod\t_\t_
4\t病\t病\tNOUN\tn,名詞,可搬,状態\t_\t0\troot\t_\t_
`;

  it("marks 病 に — 劉の病にあらず", () => {
    const sentence = sentenceOf(FEI_LIU_ZHI_BING);
    expect(caseParticleFor(named(sentence, "病"), sentence)).toBe("に");
    expect(prose(sentence)).toContain("病に");
  });

  it("reads the tag, not the character — the noun 非 ('a fault') marks nothing", () => {
    // 92 of the 1,736 are NOUN (`n,名詞,描写,態度`, "a wrong") and 64 VERB
    // (`v,動詞,行為,交流`, "to blame"). Neither is the あらず negation, and the
    // xpos is what says so.
    const sentence = sentenceOf(`1\t非\t非\tNOUN\tn,名詞,描写,態度\t_\t2\tmod\t_\t_
2\t病\t病\tNOUN\tn,名詞,可搬,状態\t_\t0\troot\t_\t_
`);
    expect(caseParticleFor(named(sentence, "病"), sentence)).toBeUndefined();
  });

  it("suppresses the copula rather than stacking the に on it — 病になりあらず was the bug", () => {
    // 病 is the sentence's nominal root and the mark closes it, so
    // `extraEndingFor`'s ROOT branch granted it なり and the に landed on top:
    // 劉の病になりあらず, the affirmative copula and its own negation both
    // asserted of one noun. 非 *is* the copula — あり with ず on it — so the
    // nominal in front of it takes に and nothing else.
    const sentence = sentenceOf(`${FEI_LIU_ZHI_BING}5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
`);
    expect(prose(sentence)).toContain("病に");
    expect(prose(sentence)).not.toContain("なり");
  });

  it("leaves an unnegated nominal root on its なり — the suppression is the 非's, not the mark's", () => {
    const sentence = sentenceOf(`1\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t3\tcomp:obj\t_\t_
2\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t3\tmod\t_\t_
3\t病\t病\tNOUN\tn,名詞,可搬,状態\t_\t0\troot\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_
`);
    expect(prose(sentence)).toContain("なり");
  });

  it("outranks the naming rule — 非吾徒也 is 吾が徒にあらず, not 吾が徒を", () => {
    // 非 governs a `comp:obj` 300 times, and under a 曰 that relation is what
    // `namingComplementParticle` claims. A denied predicate is not a name.
    const sentence = sentenceOf(`1\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t4\tmod\t_\t_
3\t吾\t吾\tPRON\tn,代名詞,人称,起格\tPerson=1|PronType=Prs\t4\tdet\t_\t_
4\t徒\t徒\tNOUN\tn,名詞,主体,人物\t_\t1\tcomp:obj\t_\t_
`);
    expect(caseParticleFor(named(sentence, "徒"), sentence)).toBe("に");
  });

  it("reaches a verbal predicate too, on a 連体形 — 非道弘人 is 道人を弘むるにあらず", () => {
    // 非 governs a VERB 650 times against a NOUN 732, so the verbal case is very
    // nearly as common. There is no copula to suppress there; what it needs is
    // the 連体形, which `decideConjForm` writes off this same predicate.
    const sentence = sentenceOf(`1\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t3\tmod\t_\t_
2\t道\t道\tNOUN\tn,名詞,可搬,成果物\t_\t3\tsubj\t_\t_
3\t弘\t弘\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t人\t人\tNOUN\tn,名詞,主体,人物\t_\t3\tcomp:obj\t_\t_
`);
    expect(decideConjForm(named(sentence, "弘"), undefined, sentence, undefined, resolve)).toBe("rentai");
    expect(caseParticleFor(named(sentence, "弘"), sentence)).toBe("に");
  });

  it("puts the に after a further negation, not in front of it — 非不說子之道", () => {
    // 子の道を說ばざるにあらず. The ず closes the clause, so it takes the 連体形
    // ざる and carries the に, exactly as it does under 苦不得飲.
    const sentence = sentenceOf(`1\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t3\tmod\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t說\t說\tVERB\tv,動詞,行為,態度\t_\t0\troot\t_\t_
4\t道\t道\tNOUN\tn,名詞,可搬,成果物\t_\t3\tcomp:obj\t_\t_
`);
    expect(caseParticleFor(named(sentence, "說"), sentence)).toBeUndefined();
    expect(prose(sentence)).toContain("ざるに");
  });

  it("treats 匪 exactly as 非 — the same 体言否定 tag, 18 instances", () => {
    const sentence = sentenceOf(`1\t匪\t匪\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t4\tmod\t_\t_
2\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t3\tcomp:obj\t_\t_
3\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t4\tmod\t_\t_
4\t病\t病\tNOUN\tn,名詞,可搬,状態\t_\t0\troot\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
`);
    expect(caseParticleFor(named(sentence, "病"), sentence)).toBe("に");
    expect(prose(sentence)).not.toContain("なり");
  });
});
