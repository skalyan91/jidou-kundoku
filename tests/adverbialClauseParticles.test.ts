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
import { caseParticleFor, decideConjForm, sentenceFinalParticleFor } from "../src/kakikudashi/conjugationContext.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

// ---------------------------------------------------------------------------
// The particles an *adverbial* clause and a *coordination chain* take, and
// where each of them is written.
//
// Four rules meet here, and each is about a particle landing on the token the
// construction actually ends on rather than on the one that carries the
// relation:
//
//  - a `@tmod` temporal clause reads 已然形 + ば, on the last link of its chain;
//  - a negated `mod` clause reads 連体形 ざる + に, on the negation;
//  - a coordination chain with a *core* relation at its head writes that
//    relation's particle after the last member;
//  - a quantity phrase with a post-modifier writes its ending after the
//    modifier.
//
// Trees are written out rather than parsed live, as `coordinatedProtasis.test.ts`
// does and for the same reason: the shape is what is being tested, and the live
// parser does not always return it. Where a case comes from the reader's own
// 酒蟲 tree the sentence id is named.
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
// 1. A `@tmod` clause is its own trigger.
// ---------------------------------------------------------------------------

describe("a verbal `mod@tmod` is an annotation fault, and the right labels need no rule", () => {
  // A rule was written to make a verbal `mod@tmod` read 已然形+ば and then taken
  // out again: the label does not occur over a verb anywhere in
  // `lzh-{train,dev,test}.sud.conllu` (137,786 sentences), and the two things
  // the reader's tree uses it for are two different SUD relations. These tests
  // fix what the correct labels are, by asserting what the *already shipped*
  // rules do with them. See `TEMPORAL_CLAUSE_DEPS`' note in conjugationContext.ts.

  it("苦不得飲: `comp:obj` is the label, and the を lands on the ざる", () => {
    // **`comp:obj`, and this test's own earlier answer of `comp:obl` is
    // withdrawn.** Measured over `lzh_kyoto-sud-{train,dev,test}`: a governor
    // tagged `v,動詞,描写,態度` — 苦's class — takes a VERB/AUX dependent on
    // `comp:obj` 170 times and on `comp:obl` **once** in the whole corpus
    // (吾羞爲之下), and 苦 itself governs a predicate 13 times with **none** of
    // them oblique. Two of the 170 are this very construction, a negated
    // predicate under 苦 — 俗士苦不知變 and 李斯稅駕苦不早 — with 爾輩苦無恃 and
    // 三徑苦無資 beside them. 苦 is a transitive psych verb and what it suffers
    // is its object; the reader's own tree already carries `comp:obj`.
    //
    // What the label costs is the particle: the relation says を. Japanese
    // 苦しむ is intransitive and marks its stimulus に (百姓苦秦苛法 is
    // 秦の苛法に苦しむ), but that is a fact about the Japanese verb rather than
    // about the tree — the same `comp:obj` under 樂 or 恥 wants を — and
    // `caseParticleFor` has no reading resolver in hand to ask JMdict with.
    const sentence = sentenceOf(`1\t苦\t苦\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t得\t得\tVERB\tv,動詞,行為,得失\t_\t1\tcomp:obj\t_\t_
4\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t3\tcomp:obj\t_\t_
`);
    // The を is the negation's, not 得's: 得 is read before the postposed 不, so
    // a particle written on 得 itself lands inside the negation and printed
    // 飲むを得**を**ず, which is what this fixes.
    expect(caseParticleFor(named(sentence, "得"), sentence)).toBeUndefined();
    expect(prose(sentence)).toBe("飲むを得ざるを苦しむ");
  });

  it("…and `comp:obl` still reads 飲むを得ざるに, for the trees that carry it", () => {
    // `comp:obl` is in `OBLIQUE_DEPS` and is unchanged by the object arm: the
    // two relations are disjoint and the oblique one answers first.
    const sentence = sentenceOf(`1\t苦\t苦\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t得\t得\tVERB\tv,動詞,行為,得失\t_\t1\tcomp:obl\t_\t_
4\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("得ざるに");
    expect(prose(sentence)).not.toContain("ざれば");
  });

  it("甕中貯水…即成佳釀: `mod` is the label, and the ば falls out of the shipped rule", () => {
    // 貯 is a free adverbial adjunct, which is plain `mod`. Labelled that way,
    // `headsConditionalProtasis` fires on the 即 already standing on 成 — the
    // trigger it has always keyed on — and puts the ば on the chain's last link.
    // No new rule was needed for this at all; the label was the whole problem.
    const sentence = sentenceOf(`1\t貯\t貯\tVERB\tv,動詞,行為,動作\t_\t5\tmod\t_\t_
2\t水\t水\tNOUN\tn,名詞,可搬,道具\t_\t1\tcomp:obj\t_\t_
3\t攪\t攪\tVERB\tv,動詞,変化,生物\t_\t1\tconj:coord\t_\t_
4\t即\t即\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t5\tmod\t_\t_
5\t成\t成\tVERB\tv,動詞,行為,生産\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "攪"), undefined, sentence)).toBe("izen");
    expect(caseParticleFor(named(sentence, "攪"), sentence)).toBe("ば");
    expect(caseParticleFor(named(sentence, "貯"), sentence)).toBeUndefined();
  });

  it("解縛視之: `mod` too, and it does *not* read ば — nothing in the sentence says so", () => {
    // The remaining case, and the honest answer about it. 之を視れば is a real
    // reading, but its evidence is the discovery semantics of the passage and
    // not anything a dependency label carries: the clause has no すなはち-class
    // connective and no 既. Routing every connective-less adverbial clause to ば
    // would move 11,822 corpus edges. This asserts the current behaviour so that
    // a change to it is a deliberate one.
    const sentence = sentenceOf(`1\t解\t解\tVERB\tv,動詞,行為,動作\t_\t6\tmod\t_\t_
2\t縛\t縛\tNOUN\tv,動詞,行為,動作\t_\t1\tcomp:obj\t_\t_
3\t視\t視\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t赤\t赤\tADJ\tn,名詞,描写,形質\t_\t6\tmod\t_\t_
6\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t0\troot\t_\t_
`);
    expect(caseParticleFor(named(sentence, "視"), sentence)).toBeUndefined();
    expect(prose(sentence)).not.toContain("視れば");
  });

  it("…and 'a clause adjunct on a nominal predicate' is not the narrower trigger either", () => {
    // The one candidate that looked like it might reach 視れば without widening
    // the ば bucket: 解's governor is the *nominal* root 肉, so "a verbal `mod`
    // whose governor is a nominal predicate" might have been a small,
    // well-defined class. Measured over `lzh-{train,dev,test}.sud.conllu`
    // (137,786 sentences) it is not:
    //
    //   verbal `mod` of any governor                      47,216
    //     …of a non-verbal governor                       31,268  (NOUN 22,990)
    //       …of a NOUN that is the sentence root           1,926
    //         …and carrying a core argument of its own       560
    //
    // and the class is the wrong one at every size. Its members are attributive
    // adjectives and relatives *inside* a nominal predicate, not clause
    // adjuncts standing in front of one: 里仁篇第四, 皆賢人也, 人之大倫也,
    // 何事非君 — and, in the 560 that carry an argument, 文勝質則史 and
    // 是社稷之臣也. A ば keyed on that shape reads 里の篇 as 里れば.
    //
    // So there is no narrow trigger, and the finding is about the annotation.
    // This fixes the negative for the shape, at the smallest size measured.
    const sentence = sentenceOf(`1\t賢\t賢\tADJ\tv,動詞,描写,態度\tDegree=Pos\t3\tmod\t_\t_
2\t人\t人\tNOUN\tn,名詞,主体,人物\t_\t3\tsubj\t_\t_
3\t徒\t徒\tNOUN\tn,名詞,主体,人物\t_\t0\troot\t_\t_
`);
    expect(caseParticleFor(named(sentence, "賢"), sentence)).toBeUndefined();
    expect(prose(sentence)).not.toContain("ば");
  });

  it("視 has a paradigm now, whatever the label — 上一段, so 未然形 is the bare stem", () => {
    // Independent of all of the above, and a genuine app gap the ば experiment
    // exposed: `derivedData` has no 視 at all, so the character had a reading
    // (み.る) and no conjugation class, and printed its citation form for every
    // form asked of it. `RESIDUAL` in verbLexicon.ts now names the class.
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t視\t視\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).toBe("視ず");
  });
});

// ---------------------------------------------------------------------------
// 5. A negated adverbial clause reads ざるに.
// ---------------------------------------------------------------------------

describe("a negated verb modifying another verb reads ざるに", () => {
  /** 酒蟲 sent_id 35: 不飲一斗、適以益貧 — 飲 is a plain `mod` of 適 with 不 on
   * it, and the negation is what stands at the clause's end. */
  const BU_YIN_YI_DOU = `1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t4\tmod\t_\t_
3\t斗\t斗\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t2\tcomp:obj\t_\t_
4\t適\t適\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
`;

  it("writes 連体形 ざる and the に on the negation, not a bare ず", () => {
    const sentence = sentenceOf(BU_YIN_YI_DOU);
    expect(prose(sentence)).toContain("ざるに");
    expect(prose(sentence)).not.toMatch(/ず[^る]*適/u);
  });

  it("gives the verb itself the 未然形 the ず attaches to, and no particle", () => {
    const sentence = sentenceOf(BU_YIN_YI_DOU);
    expect(decideConjForm(named(sentence, "飲"), named(sentence, "不"), sentence)).toBe("mizen");
    expect(caseParticleFor(named(sentence, "飲"), sentence)).toBeUndefined();
  });

  it("stands down where a 而 already supplies the connective", () => {
    // 人不知而不慍 is 人知らずして慍らず. 而 writes its own して and two
    // connectives on one clause is one too many.
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t知\t知\tVERB\tv,動詞,行為,動作\t_\t5\tmod\t_\t_
3\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t2\tcc\t_\t_
4\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t5\tmod\t_\t_
5\t慍\t慍\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
`);
    expect(prose(sentence)).not.toContain("ざるに");
  });

  it("leaves a conditional protasis on its ざれば", () => {
    // 學而不思則罔. The conditional is asked before this rule, so a clause that
    // is both keeps the ば.
    const sentence = sentenceOf(`1\t學\t學\tVERB\tv,動詞,行為,動作\t_\t6\tmod\t_\t_
2\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_
3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
4\t思\t思\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
5\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t6\tmod\t_\t_
6\t罔\t罔\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
`);
    expect(prose(sentence)).toContain("ざれば");
    expect(prose(sentence)).not.toContain("ざるに");
  });

  it("leaves an unnegated adverbial clause exactly as it was", () => {
    // The other 12,482 verbal-`mod`-of-verbal edges. Nothing here is claimed:
    // a 連用形 needs no particle.
    const sentence = sentenceOf(`1\t學\t學\tVERB\tv,動詞,行為,動作\t_\t2\tmod\t_\t_
2\t罔\t罔\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
`);
    expect(caseParticleFor(named(sentence, "學"), sentence)).toBeUndefined();
  });

  // The 220 edges the gate refused when it was first written — the modals
  // 能/得/敢/欲, which this treebank tags AUX. See `isNegatedAdverbialPredicate`
  // for the re-measurement (766 accepted, 220 refused, 0 of them for ADJ).

  it("reaches a VERB clause under an AUX governor — 不以規矩、不能成方員", () => {
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t以\t以\tVERB\tv,動詞,行為,動作\t_\t5\tmod\t_\t_
3\t規\t規\tNOUN\tn,名詞,可搬,道具\t_\t2\tcomp:obj\t_\t_
4\t矩\t矩\tNOUN\tn,名詞,可搬,道具\t_\t3\tconj:coord\t_\t_
5\t能\t能\tAUX\tv,助動詞,可能,*\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).toContain("ざるに");
  });

  it("reaches an AUX clause under a VERB governor — 不欲變、故不受也", () => {
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t欲\t欲\tAUX\tv,助動詞,願望,*\t_\t4\tmod\t_\t_
3\t變\t變\tVERB\tv,動詞,変化,様態\t_\t2\tcomp:obj\t_\t_
4\t受\t受\tVERB\tv,動詞,行為,得失\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).toContain("ざるに");
  });

  it("still refuses a nominal the parser tagged VERB — the xpos half of the gate", () => {
    // Widening the UPOS test to VERB|AUX must not widen the xpos test with it:
    // `isVerbalXpos` is what keeps a noun out, and a noun is not a clause.
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t飲\t飲\tVERB\tn,名詞,可搬,糧食\t_\t3\tmod\t_\t_
3\t適\t適\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).not.toContain("ざるに");
  });
});

// ---------------------------------------------------------------------------
// 4. A core-dependency chain writes its particle after the last member.
// ---------------------------------------------------------------------------

describe("a coordination chain with a core relation at its head", () => {
  it("marks a subject chain after the last member — 飲食は, not 飲は食", () => {
    // 酒蟲 sent_id 34: 飲 is the `subj` of 至 and 食 is coordinated onto it.
    const sentence = sentenceOf(`1\t飲\t飲\tNOUN\tv,動詞,行為,飲食\t_\t3\tsubj\t_\t_
2\t食\t食\tNOUN\tn,名詞,可搬,糧食\t_\t1\tconj:coord\t_\t_
3\t至\t至\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).not.toContain("飲は");
    // Whether a は is written at all is the topicalization rules' question; what
    // this rule settles is that it cannot land inside the phrase — so the head
    // takes nothing and the last member is where any particle would go.
    expect(caseParticleFor(named(sentence, "飲"), sentence)).toBeUndefined();
    expect(caseParticleFor(named(sentence, "食"), sentence)).toBeUndefined();
  });

  it("keeps the object chain it already had — 手足を縶る", () => {
    const sentence = sentenceOf(`1\t縶\t縶\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t手\t手\tNOUN\tn,名詞,不可譲,身体\t_\t1\tcomp:obj\t_\t_
3\t足\t足\tNOUN\tn,名詞,不可譲,身体\t_\t2\tconj:coord\t_\t_
`);
    expect(caseParticleFor(named(sentence, "手"), sentence)).toBeUndefined();
    expect(caseParticleFor(named(sentence, "足"), sentence)).toBe("を");
  });

  it("writes the topic は after the last member where one is written at all", () => {
    // The `subj` branch that gives a は when the ROOT is a modal auxiliary —
    // asked about the chain head, written on the member said last.
    const sentence = sentenceOf(`1\t兄\t兄\tNOUN\tn,名詞,人,関係\t_\t3\tsubj\t_\t_
2\t弟\t弟\tNOUN\tn,名詞,人,関係\t_\t1\tconj:coord\t_\t_
3\t能\t能\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\t_
`);
    expect(caseParticleFor(named(sentence, "兄"), sentence)).toBeUndefined();
    expect(caseParticleFor(named(sentence, "弟"), sentence)).toBe("は");
  });

  it("leaves a chain of one exactly where it was", () => {
    const sentence = sentenceOf(`1\t手\t手\tNOUN\tn,名詞,不可譲,身体\t_\t2\tcomp:obj\t_\t_
2\t縶\t縶\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    expect(caseParticleFor(named(sentence, "手"), sentence)).toBe("を");
  });
});

// ---------------------------------------------------------------------------
// 2. A post-modifier on a coordinated quantity carries the ending.
// ---------------------------------------------------------------------------

describe("a quantity phrase with a post-modifier, standing as a non-final conjunct", () => {
  /** 酒蟲 sent_id 25 again, its second half: 三 is a NUM `parataxis` of the root
   * with 寸 as its classifier, 許 as a postposed `mod`, and 如 coordinated onto
   * it — so the measurement hands on rather than closing. */
  const CHANG_SAN_CUN_XU = `1\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t0\troot\t_\t_
2\t長\t長\tNOUN\tv,動詞,描写,量\t_\t3\tsubj\t_\t_
3\t三\t三\tNUM\tn,数詞,数字,*\t_\t1\tparataxis\t_\t_
4\t寸\t寸\tNOUN\tn,名詞,度量衡,*\tNounType=Clf\t3\tclf\t_\t_
5\t許\t許\tNOUN\tn,名詞,可搬,道具\t_\t3\tmod\t_\tReading=ばかり
6\t備\t備\tVERB\tv,動詞,行為,設置\t_\t3\tconj:coord\t_\t_
`;

  it("writes the ending after the post-modifier, not in front of it", () => {
    // 許's own ばかり reading is the reading layer's — this asserts only where
    // the ending lands relative to the character, which is this rule's half.
    const text = prose(sentenceOf(CHANG_SAN_CUN_XU));
    expect(text).toContain("三寸許にして");
    expect(text).not.toMatch(/寸に[^許]*許/u);
  });

  it("takes the 連用形, because the phrase's head is a non-final conjunct", () => {
    // The question is asked about 三, which has 備 coordinated onto it, and not
    // about the 許 the ending is written on — 許 is a chain of one and would
    // have closed the clause with なり.
    const text = prose(sentenceOf(CHANG_SAN_CUN_XU));
    expect(text).not.toContain("ばかりなり");
  });

  it("leaves a quantity that closes its sentence alone", () => {
    // 弟子三千人。 — a count, and the sentence's own predication: あり from
    // `isNumeralPredication`, which is asked first and is not touched.
    const sentence = sentenceOf(`1\t弟\t弟\tNOUN\tn,名詞,人,関係\t_\t3\tsubj\t_\t_
2\t子\t子\tNOUN\tn,名詞,人,関係\t_\t1\tflat\t_\t_
3\t三千\t三千\tNUM\tn,数詞,数字,*\t_\t0\troot\t_\t_
4\t人\t人\tNOUN\tn,名詞,人,*\tNounType=Clf\t3\tclf\t_\t_
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_
`);
    expect(prose(sentence)).toContain("あり");
    expect(prose(sentence)).not.toContain("にして");
  });
});

// ---------------------------------------------------------------------------
// 6. 豈…乎 closes on か.
// ---------------------------------------------------------------------------

describe("豈 makes a following 乎 a genuine question", () => {
  /** 酒蟲 sent_id 35: 豈飲啄固有數乎？ — 豈 and 乎 both hang off 有. */
  const QI_YOU_SHU_HU = `1\t豈\t豈\tADV\tv,副詞,疑問,反語\t_\t3\tmod\t_\t_
2\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t3\tsubj\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
4\t數\t數\tNOUN\tn,名詞,数量,*\t_\t3\tcomp:obj\t_\t_
5\t乎\t乎\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`;

  it("reads 乎 as か, not the default や", () => {
    const sentence = sentenceOf(QI_YOU_SHU_HU);
    expect(sentenceFinalParticleFor(named(sentence, "乎"), sentence)).toBe("か");
    expect(prose(sentence)).toContain("か");
    expect(prose(sentence)).not.toContain("や");
  });

  it("leaves a 乎 with no 豈 on its や — 不亦說乎", () => {
    const sentence = sentenceOf(`1\t說\t說\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
2\t乎\t乎\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(sentenceFinalParticleFor(named(sentence, "乎"), sentence)).toBe("や");
  });

  it("reaches a 豈 hung further down the same clause", () => {
    // The reader's earlier tree of the same sentence puts 豈 on 飲, which is
    // 有's own `subj`, where the later one puts it on 有. Same frame, same
    // reading — a test keyed on the one governor would have answered differently
    // for the two trees.
    const sentence = sentenceOf(`1\t豈\t豈\tADV\tv,副詞,疑問,反語\t_\t2\tmod\t_\t_
2\t飲\t飲\tVERB\tv,動詞,行為,飲食\t_\t3\tsubj\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
4\t乎\t乎\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`);
    expect(sentenceFinalParticleFor(named(sentence, "乎"), sentence)).toBe("か");
  });

  it("does not reach out of the clause the 乎 closes", () => {
    // 豈 marks 曰, the root, and the 乎 closes 有 — which is *inside* 曰's clause
    // rather than around it. The walk goes up from the 豈 and never reaches 有,
    // so an outer 反語 cannot claim an inner clause's particle.
    const sentence = sentenceOf(`1\t豈\t豈\tADV\tv,副詞,疑問,反語\t_\t2\tmod\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t2\tcomp:obj\t_\t_
4\t乎\t乎\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`);
    expect(sentenceFinalParticleFor(named(sentence, "乎"), sentence)).toBe("や");
  });
});

// ---------------------------------------------------------------------------
// A 描写 stative heading a conditional protasis.
//
// `isConditionalTemporalClause` refused the whole `v,動詞,描写,*` class outright,
// on the reading that such a token in an adverbial slot is a manner or degree
// adverb — 輒半種黍 is 輒ち半ば黍を種う, and 半ばば is nonsense. The class was the
// wrong unit: over `lzh_kyoto-sud-{train,dev,test}` a 描写 token on `mod`/`udep`
// is three disjoint things, and the *feature* says which — VERB+`VerbForm=Part`
// is the attributive (7,600), ADV+`VerbForm=Conv` is the manner adverb (4,491,
// and 半 is one of them), and a VERB with no `VerbForm` at all is the bare
// stative predicate (652), which is exactly what a protasis is made of.
//
// The refusal was costing 76 gold edges — 614 reached now against 538 before,
// +14% — and every one of them is textbook: 名不正則言不順, 君子不重則不威,
// 物盛則衰, 事煩則亂, 楚強則秦弱, 學而優則仕.
// ---------------------------------------------------------------------------

describe("a 描写 stative reads 已然形 + ば when it heads a protasis", () => {
  it("名不正則言不順 — 名正しからざれば則ち言順はず", () => {
    const sentence = sentenceOf(`1\t名\t名\tNOUN\tn,名詞,可搬,伝達\t_\t3\tsubj\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t正\t正\tADJ\tv,動詞,描写,形質\tDegree=Pos\t7\tmod\t_\t_
4\t則\t則\tADV\tv,副詞,判断,無界\t_\t7\tmod\t_\t_
5\t言\t言\tNOUN\tn,名詞,可搬,伝達\t_\t7\tsubj\t_\t_
6\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t7\tmod\t_\t_
7\t順\t順\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
`);
    // The negation is what stands at the end of the protasis, so it is the ず
    // that takes the 已然形 ざれ and carries the ば — the same division of labour
    // 學而不思則罔 already uses.
    expect(prose(sentence)).toContain("ざれば");
  });

  it("物盛則衰 — an unnegated stative protasis takes the ば itself", () => {
    const sentence = sentenceOf(`1\t物\t物\tNOUN\tn,名詞,可搬,その他\t_\t2\tsubj\t_\t_
2\t盛\t盛\tADJ\tv,動詞,描写,量\tDegree=Pos\t4\tmod\t_\t_
3\t則\t則\tADV\tv,副詞,判断,無界\t_\t4\tmod\t_\t_
4\t衰\t衰\tVERB\tv,動詞,変化,性質\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "盛"), undefined, sentence)).toBe("izen");
    expect(caseParticleFor(named(sentence, "盛"), sentence)).toBe("ば");
  });

  it("輒半種黍 keeps 半ば — the manner adverb is ADV, and refused by the POS gate", () => {
    // The reader's own tree (酒蟲 sent_id 4) tags 半 `ADV v,動詞,描写,量`, which
    // is what 14 of gold's 42 `mod`-attached 半 also carry. So the blanket 描写
    // refusal was never what kept 半ばば out.
    const sentence = sentenceOf(`1\t輒\t輒\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t3\tmod\t_\t_
2\t半\t半\tADV\tv,動詞,描写,量\tDegree=Pos\t3\tmod\t_\t_
3\t種\t種\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t黍\t黍\tNOUN\tn,名詞,可搬,糧食\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("半ば");
    expect(prose(sentence)).not.toContain("半ばば");
  });

  it("…and refuses the same 半 tagged VERB, on its own VerbForm=Conv", () => {
    // The guard a live parse needs: `VerbForm=Conv` is what says the stative is
    // being used as a manner adverb, whatever the coarse tag on top of it.
    const sentence = sentenceOf(`1\t輒\t輒\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t3\tmod\t_\t_
2\t半\t半\tADJ\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t3\tmod\t_\t_
3\t種\t種\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t黍\t黍\tNOUN\tn,名詞,可搬,糧食\t_\t3\tcomp:obj\t_\t_
`);
    expect(decideConjForm(named(sentence, "半"), undefined, sentence)).not.toBe("izen");
    expect(caseParticleFor(named(sentence, "半"), sentence)).not.toBe("ば");
  });
});
