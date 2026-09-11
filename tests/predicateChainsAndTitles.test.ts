import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { decideConjForm, nextMeaningfulToken } from "../src/kakikudashi/conjugationContext.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";

// ---------------------------------------------------------------------------
// Four of the reader's session rules, all about what a **coordination chain**
// owes the things standing at its ends:
//
//  1. *If a sentence ends in an on'yomi compound but not a punctuation mark,
//     then don't add any morphology to it — it's likely to be a title.*
//  2. *If a noun compound is conjoined with a predicate, then it must be a
//     predicate as well, and should take the 連用形 of なり.*
//  3. *If a coordinated chain of predicates is a dependent of 者, then the last
//     one in the chain should be in 連体形.*
//  4. *If a verb in a coordination/parataxis chain has a sentence-final
//     particle, the conjugation selected by that particle should override the
//     usual 連用形 of coordination.*
//
// Every count quoted below is measured over
// `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
// — the recoding parser 0.3.2 trains on, and the only variant with a native ADJ
// category. Trees are written out as CoNLL-U rows and read through the real
// parser, resolver and reorder engine, so what is asserted is what the panel
// prints.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const historicalKana = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

function sentenceOf(rows: string): Sentence {
  const tree = parseConllu(rows);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

const prose = (sentence: Sentence): string =>
  generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), resolve);

const named = (sentence: Sentence, text: string) => sentence.tokens.find((t) => t.text === text)!;

// ---------------------------------------------------------------------------
// 1. The title rule.
// ---------------------------------------------------------------------------
describe("a fused span that is the whole of an unpunctuated sentence", () => {
  /** 蠕動 as the parser returns it inside a sentence — a `compound` span with a
   * VERB carrier, which is what `spanSuruReading` reads on'yomi and sends
   * through サ変. `。` optional, and it is the whole of what this rule turns on. */
  const span = (a: string, b: string, punct: boolean) =>
    sentenceOf(
      `1\t${a}\t${a}\tVERB\tv,動詞,行為,動作\t_\t2\tcompound\t_\t_
2\t${b}\t${b}\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
` + (punct ? `3\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_\n` : ""),
    );

  it.each([
    ["蠕", "動"],
    ["俯", "臥"],
    ["醫", "療"],
  ])("writes no ending on a bare %s%s", (a, b) => {
    // The rule's target: a line that is nothing but an on'yomi compound and
    // carries no mark. The サ変 す is the only morphology reaching one of these
    // — the synthesized copula is already withheld from an unpunctuated
    // sentence by `isPredicationLicensed` — and it was turning every such title
    // into a verb.
    expect(prose(span(a, b, false))).toBe(a + b);
  });

  it("writes the サ変 す again the moment the source closes the sentence", () => {
    // The mark is the whole test, and the app's own anchors for the span ending
    // (俯臥す, 蠕動す) are this shape with a 。 added to say so.
    expect(prose(span("蠕", "動", true))).toBe("蠕動す");
  });

  it("leaves a span with anything else in the sentence alone", () => {
    // 木蕭蕭 is a reduplicated descriptive with 木 as its **subject** — a
    // sentence whose author wrote no 。, not a title. Testing the mark alone
    // would have made a title of it and deleted the たり this app's own anchor
    // asserts, which is why the rule is bounded to a span that is the whole
    // sentence.
    const withSubject = sentenceOf(`1\t木\t木\tNOUN\tn,名詞,固定物,植物\t_\t2\tsubj\t_\t_
2\t蕭\t蕭\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
3\t蕭\t蕭\tADJ\tv,動詞,描写,形質\tDegree=Pos\t2\tcompound@redup\t_\t_
`);
    expect(prose(withSubject)).toBe("木蕭蕭たり");
  });
});

// ---------------------------------------------------------------------------
// 2. A noun compound conjoined with a predicate.
// ---------------------------------------------------------------------------
describe("a noun compound conjoined with a predicate is a predicate too", () => {
  /** 飲食 (a `compound` pair of nominals) and 肥, joined by `dep`, with the
   * compound standing first — so it is the *non-final* conjunct and the copula
   * it earns goes into its 連用形. */
  const conjoined = (dep: string) =>
    sentenceOf(`1\t飲\t飲\tNOUN\tv,動詞,行為,飲食\t_\t3\t${dep}\t_\t_
2\t食\t食\tNOUN\tn,名詞,可搬,糧食\t_\t1\tcompound\t_\t_
3\t肥\t肥\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_
`);

  it("takes にして across a parataxis, which the chain walk could not see", () => {
    // The gap the rule closes. `predicateCoordinationChain` admits a bare
    // nominal only across an explicit coordinator, on the ground that
    // `parataxis` also links a quotative frame to what it introduces — so 飲食
    // was not a link at all, the chain was one member long, and the compound
    // closed a clause it is only half of (飲食肥ゆ).
    expect(prose(conjoined("parataxis"))).toBe("飲食にして肥ゆ");
  });

  it("takes the same にして across an explicit coordinator, as it already did", () => {
    // The reader's own 而家豪富 is this shape and was already right; asserted so
    // that the widening cannot be mistaken for the whole of the rule.
    expect(prose(conjoined("conj:coord"))).toBe("飲食にして肥ゆ");
  });

  it("does not widen what parataxis may reach for a bare nominal", () => {
    // The restriction the rule is threaded through rather than around. Of the
    // 64 nominals hanging off a predicate by `parataxis` in the recoded gold,
    // 61 are a single character and only **1** is a compound the parse fuses —
    // so the compound is what the mixed uses of that relation do not have at
    // their far end, and a bare one goes on being no conjunct at all.
    const bare = sentenceOf(`1\t禮\t禮\tNOUN\tn,名詞,主体,関係\t_\t2\tparataxis\t_\t_
2\t肥\t肥\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
3\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
`);
    expect(prose(bare)).toBe("禮肥ゆ");
  });

  it("does not widen it for a multi-character token either", () => {
    // 王學君子 with 君子 arriving as one NOUN token, which is the app's own
    // anchor for the restriction (see `tests/kakikudashi-generator.test.ts`).
    // Its stated reason is a quotation or an appositive at the far end of the
    // relation — and that is a multi-character nominal and nothing else, so the
    // fusing relation and not the character count is what may be read.
    const oneToken = sentenceOf(`1\t王\t王\tNOUN\tn,名詞,人,役割\t_\t2\tsubj\t_\t_
2\t學\t學\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t君子\t君子\tNOUN\tn,名詞,人,役割\t_\t2\tparataxis\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
`);
    expect(prose(oneToken)).toBe("王學ぶ君子");
  });
});

// ---------------------------------------------------------------------------
// 3. A coordinated chain under 者.
//
// **The deprel the reader asked about is `mod`, and only the chain's head
// carries it.** Over the recoded gold a predicate dependent of a 者 is `mod`
// — VERB 2,744, ADJ 610, AUX 260 — and nothing else; **443** of those head a
// coordination chain, whose later members hang off *that head* as `conj:coord`
// (337) or `parataxis` (106), never off the 者. 好謀而成者 is the shape.
// ---------------------------------------------------------------------------
describe("a coordinated chain of predicates under 者", () => {
  /** 好謀而得者 — 好 is `mod` of 者 and 得 is `conj:coord` of 好, which is the
   * gold's own shape. 得 is 下二段, so its 終止形 得 and 連体形 得る differ on the
   * page and the rule is visible. */
  const chainUnderZhe = sentenceOf(`1\t好\t好\tVERB\tv,動詞,行為,態度\t_\t4\tmod\t_\t_
2\t謀\t謀\tVERB\tv,動詞,行為,伝達\t_\t1\tcomp:obj\t_\t_
3\t得\t得\tVERB\tv,動詞,行為,得失\t_\t1\tconj:coord\t_\t_
4\t者\t者\tPART\tp,助詞,提示,*\t_\t0\troot\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_
`);

  it("puts the last link in 連体形", () => {
    expect(decideConjForm(named(chainUnderZhe, "得"), nextMeaningfulToken(computeReadingOrder(chainUnderZhe, []), 2), chainUnderZhe, undefined, resolve)).toBe(
      "rentai",
    );
    expect(prose(chainUnderZhe)).toContain("得る");
  });

  it("leaves every earlier link in 連用形 — the chain still hands on", () => {
    // 好 is not what the 者 lands against; 得 is. 謀るを好**み**得る者.
    //
    // **者なり, and this reverses the は this line used to assert.** The 者 ends
    // the sentence on the ROOT, so it is the predicate and takes the copula
    // rather than the topic marker; the reader has overridden his own committed
    // anchor to rule it so. See `isSentenceFinalZhe` in `conjugationContext.ts`
    // and `zheParticleReading` in `readingResolver.ts`, and note the measured
    // movement: **−4** against kanbun.info (4 passages closer, 3 further, both
    // regressions a mis-parse). The 連用形 this test is for is untouched — the
    // ending lands after 得る either way.
    expect(prose(chainUnderZhe)).toBe("謀るを好み得る者なり");
  });

  it("still refuses the topic 者, which nominalizes nothing", () => {
    // 黃帝者、少典之子也. The distinction is the resolver's and is not re-derived
    // here — a 者 modified by a bare noun or name is the topic marker は, and
    // what precedes it stays 終止形.
    const topic = sentenceOf(`1\t黃\t黃\tPROPN\tn,名詞,人,姓氏\t_\t2\tcompound\t_\t_
2\t帝\t帝\tNOUN\tn,名詞,人,役割\t_\t3\tmod\t_\t_
3\t者\t者\tPART\tp,助詞,提示,*\t_\t5\tsubj\t_\t_
4\t少\t少\tPROPN\tn,名詞,人,姓氏\t_\t5\tmod\t_\t_
5\t子\t子\tNOUN\tn,名詞,人,関係\t_\t0\troot\t_\t_
6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_
`);
    expect(prose(topic)).toContain("黃帝は");
  });

  it("keeps a single predicate under 者 attributive, as it always was", () => {
    // The direct case the chain rule widens, and the one that must not move.
    const single = sentenceOf(`1\t得\t得\tVERB\tv,動詞,行為,得失\t_\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t0\troot\t_\t_
3\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_
`);
    // 者なり, not 者は — the same reversal as the chain case two tests up, on
    // the reader's explicit instruction and for the same reason. What "must not
    // move" here is the 連体形 得る, and it has not.
    expect(prose(single)).toBe("得る者なり");
  });
});

// ---------------------------------------------------------------------------
// 4. A sentence-final particle on a non-final conjunct.
// ---------------------------------------------------------------------------
describe("a sentence-final particle overrides the 連用形 of coordination", () => {
  /** 飲X食 — the particle `mark` closes 飲, and 食 is coordinated onto it, so
   * the chain would otherwise demote 飲 to its 連用形. */
  const chainWithParticle = (mark: string) =>
    sentenceOf(`1\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t0\troot\t_\t_
2\t${mark}\t${mark}\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t食\t食\tVERB\tv,動詞,行為,飲食\t_\t1\tconj:coord\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_
`);

  it("writes 連体形 before an assertive 也, not the chain's 連用形", () => {
    // The gap. なり is the 断定 auxiliary and an auxiliary attaches to a 連体形,
    // and 飲**み**なり食ふ was a 連用形 with one standing on it. **137** of the
    // recoded gold's 7,317 assertive 也 sit on a predicate with a further
    // conjunct after it — 地未有過千里者也，而齊有其地矣 · 人有不為也，而後可以有為 —
    // counted with `isNonFinalCoordinand` itself over the same corpus.
    expect(prose(chainWithParticle("也"))).toBe("飲むなり食ふ");
  });

  it.each([
    ["乎", "や"],
    ["耳", "のみ"],
  ])("goes on writing 連体形 before %s, which already stood above the chain", (mark, kana) => {
    // 係り結び and the 限定 のみ were already ordered ahead of the coordination
    // rule; asserted so the three particles cannot come apart.
    expect(prose(chainWithParticle(mark))).toBe(`飲む${kana}食ふ`);
  });

  it("writes the same 連体形 for a 也 closing a sentence outright", () => {
    // No chain here, and none needed: なり is the 断定 auxiliary wherever it
    // stands, so the predicate under it is attributive whether a conjunct
    // follows or not. This case was pinned the other way — 有**り**なり — while
    // `decideConjForm` bounded the rule to a non-final conjunct, which was the
    // whole of what the reader had then asked for; the reader has since ruled
    // 有**る**なり and the bound came off. See `isAssertiveParticleAhead`.
    const closing = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t1\tpunct\t_\t_
`);
    expect(prose(closing)).toContain("有るなり");
  });
});
