import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sentence, Token } from "../src/parse/types.ts";
import { isContentPredicatePos } from "../src/parse/types.ts";
import { isDescriptiveToken } from "../src/kakikudashi/bungoConjugation.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { usesLexiconEntry } from "../src/kakikudashi/conjugationContext.ts";
import { isCausedPredicateParataxis } from "../src/kundoku/depClassification.ts";
import { findOverride } from "../src/reading/overridesLookup.ts";
import { chosenReadingParts } from "../src/reading/chosenReading.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

// ---------------------------------------------------------------------------
// **Parser 0.3.2's native ADJ category.** The release recodes the Classical
// Chinese stative predicates — the whole `v,動詞,描写,*` xpos class — off VERB:
// its morphologizer holds 8 ADJ bundles where 0.3.1 held none in use, `VERB` no
// longer carries `Degree=Pos` at all (it keeps its five `Degree=Equ` ones), and
// over the recoded gold (`lzh_kyoto-sud-*.relabeled_ext.udep_ruled.punct.
// rulemerged.adjfix.conllu`) that xpos is **ADJ 22,368 / ADV 4,511 / NOUN 1 and
// VERB 0**.
//
// The danger the recoding creates is silent, which is why these tests exist: a
// rule written `pos === "VERB"` to mean *"a predicate"* goes on compiling, goes
// on running, and simply stops seeing one token in seven. Every case below is a
// rule that was right under 0.3.1, would have gone quietly wrong under 0.3.2,
// and is asserted here against the shape the parser now actually returns.
//
// Every tree is written out. The relations are the ones a live 0.3.2 parse
// returns for these sentences (checked against the page, and quoted in each
// case), and the UPOS/xpos/FEATS triples are the parser's own.
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

const prose = (sentence: Sentence): string => generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), resolve);

const tok = (partial: Partial<Token>): Token =>
  ({ id: 0, text: "", lemma: "", pos: "ADJ", xpos: "v,動詞,描写,形質", dep: "ROOT", head: 0, ...partial }) as Token;

describe("the two questions a stative tag answers, and which test asks which", () => {
  it("counts ADJ as a predicate beside VERB, and AUX as neither", () => {
    expect(isContentPredicatePos("VERB")).toBe(true);
    expect(isContentPredicatePos("ADJ")).toBe(true);
    expect(isContentPredicatePos("AUX")).toBe(false);
    expect(isContentPredicatePos("NOUN")).toBe(false);
    expect(isContentPredicatePos(undefined)).toBe(false);
  });

  it("counts every tag the parser puts `Degree=Pos` on as descriptive", () => {
    // The three that carry it in the wheel's own inventory: 8 ADJ bundles, 5
    // ADV, 1 NOUN. The ADV is what a 形容動詞 used adverbially arrives as (暴 as
    // にはかに), and it is the reason `isDescriptiveToken` is not just a tag test.
    expect(isDescriptiveToken(tok({ pos: "ADJ", morph: "Degree=Pos" }))).toBe(true);
    expect(isDescriptiveToken(tok({ pos: "ADV", morph: "Degree=Pos|VerbForm=Conv" }))).toBe(true);
    expect(isDescriptiveToken(tok({ pos: "NOUN", morph: "Degree=Pos" }))).toBe(true);
  });

  it("counts a bare ADJ descriptive, for the tree that carries no morphology", () => {
    // A hand-written CoNLL-U, or another tool's output. Every ADJ the parser
    // itself emits carries `Degree=Pos`, so on live output the two agree.
    expect(isDescriptiveToken(tok({ pos: "ADJ" }))).toBe(true);
  });

  it("refuses a legacy VERB that still carries the feature", () => {
    // The one shape 0.3.2 will never emit and the app can still be handed: a
    // saved text written earlier in the session, or the canonical treebank
    // files uploaded as `.conllu`. The annotation editor shows it as 動詞 and
    // offers 形容詞 as a one-click correction, so reading it adjectivally here
    // would put the page and the chip at odds. It reads as the verb its chip
    // says it is instead.
    expect(isDescriptiveToken(tok({ pos: "VERB", morph: "Degree=Pos" }))).toBe(false);
    expect(isDescriptiveToken(tok({ pos: "VERB", morph: "Degree=Pos|VerbForm=Part" }))).toBe(false);
  });

  it("refuses the comparison 如/若, whose feature is Equ and not Pos", () => {
    // And `Degree` on a VERB is not extinct — only `Degree=Pos` left it, so the
    // value and never the bare key is what may be read.
    expect(isDescriptiveToken(tok({ pos: "ADJ", morph: "Degree=Equ" }))).toBe(false);
    expect(isDescriptiveToken(tok({ pos: "VERB", morph: "Degree=Equ" }))).toBe(false);
  });
});

describe("the verb lexicon speaks for a stative, and the POS gate has to let it", () => {
  // The largest single exposure of the recoding. `VERB_LEXICON` holds an
  // adjective sense for 198 of its 1,285 lemmas (痛 いたし, 重 おもし, 易 やすし),
  // and every token they are for is a stative — the exact class that moved.
  // Over the recoded gold **13,859 of 22,368** ADJ tokens have an entry in that
  // table and **10,163** have an adjective sense in it. A VERB/AUX-only gate
  // would have refused all 13,859 *silently*: a refused gate reads as "no
  // entry", not as an error, and both panels would simply have fallen through
  // to the resolver for words the lexicon speaks for.
  it("admits ADJ beside VERB and AUX", () => {
    expect(usesLexiconEntry(tok({ lemma: "寒", pos: "ADJ", morph: "Degree=Pos" }))).toBe(true);
    expect(usesLexiconEntry(tok({ lemma: "寒", pos: "VERB", xpos: "v,動詞,行為,動作" }))).toBe(true);
  });

  it("goes on refusing the nominal use the gate was written for", () => {
    // 青 is also a plain NOUN (the colour as a substance, 取之於藍's 青), where
    // conjugating it would be wrong — 青 bare, never 青し.
    expect(usesLexiconEntry(tok({ lemma: "青", pos: "NOUN", xpos: "n,名詞,描写,形質" }))).toBe(false);
  });
});

describe("a stative predicate the parser now tags ADJ", () => {
  it("takes its kun'yomi's classical verb ending — 馬肥 is 馬肥ゆ", () => {
    // 肥's kun'yomi are verbs throughout (こ.える, こ.やす) and its classical
    // ending is 下二段ヤ行 肥ゆ, which `classicalVerbEnding` writes off the
    // *modern* える. Gated on VERB alone that conversion never ran and the page
    // printed kanjidic's 馬肥える. 肥 is ADJ 34 / PROPN 2 over the recoded gold —
    // there is no VERB use of it left to fall back on.
    expect(
      prose(
        sentenceOf(`# text = 馬肥
1\t馬\t馬\tNOUN\tn,名詞,主体,動物\t_\t2\tsubj\t_\t_
2\t肥\t肥\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
`),
      ),
    ).toBe("馬肥ゆ");
  });

  it("still answers the transitivity question when it governs an object — 君子現其德", () => {
    // The suppression an adjectival sense earns is overridden by an object,
    // because an adjective governs none: a `Degree=Pos` token with a `comp:obj`
    // is being used as a transitive verb whatever the feature says. Asked of a
    // VERB-only gate the object evidence was simply dropped.
    expect(
      prose(
        sentenceOf(`# text = 君子現其德
1\t君子\t君子\tNOUN\tn,名詞,人,役割\t_\t2\tsubj\t_\t_
2\t現\t現\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
3\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t4\tdet\t_\t_
4\t德\t德\tNOUN\tn,名詞,描写,態度\t_\t2\tcomp:obj\t_\t_
`),
      ),
    ).toBe("君子その德を現す");
  });

  it("takes its own classical adjective ending where the word is one — 天高", () => {
    expect(
      prose(
        sentenceOf(`# text = 天高
1\t天\t天\tNOUN\tn,名詞,制度,場\tCase=Loc\t2\tsubj\t_\t_
2\t高\t高\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
`),
      ),
    ).toBe("天高し");
  });
});

describe("a stative is a predicate wherever a verb would be one", () => {
  it("is the predicate a 使役 makes happen — 使民富 is 民をして富ましむ", () => {
    // Over the recoded gold the five causatives take **56** ADJ dependents on
    // `comp:obl` and **28** on `comp:obj`, and those 85 are statives: 使民富,
    // "make the people rich". A VERB/AUX gate refused every one, and with the
    // predicate refused the しむ has nothing to attach to.
    expect(
      prose(
        sentenceOf(`# text = 使民富
1\t使\t使\tVERB\tv,動詞,行為,使役\t_\t0\troot\t_\t_
2\t民\t民\tNOUN\tn,名詞,人,人\t_\t1\tcomp:obj\t_\t_
3\t富\t富\tADJ\tv,動詞,描写,境遇\tDegree=Pos\t1\tcomp:obl\t_\t_
`),
      ),
    ).toBe("民をして富ましむ");
  });

  it("is nominalized and takes を in an object slot — 見不賢 is 賢しからざるを見る", () => {
    // **3,188** ADJ tokens stand `comp:obj` under a verbal governor over the
    // recoded gold, every one with a `v,動詞,描写,…` xpos, and under 0.3.1 every
    // one of them was a VERB this rule already claimed.
    expect(
      prose(
        sentenceOf(`# text = 見不賢
1\t見\t見\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t賢\t賢\tADJ\tv,動詞,描写,態度\tDegree=Pos\t1\tcomp:obj\t_\t_
`),
      ),
    ).toBe("賢しからざるを見る");
  });

  it("heads a conditional protasis and takes 已然形 + ば — 名不正則言不順", () => {
    // The sentence `isConditionalTemporalClause`'s own doc names as the case it
    // exists for, and 正 is exactly the token the recoding moved: a VERB/AUX
    // gate would have refused the rule's worked example. Protasis heads over
    // the recoded gold are VERB 1,549 / **ADJ 197** / AUX 91.
    //
    // The tree is gold's shape — 正 `mod` on the apodosis predicate 順, with 則
    // marking that apodosis — and not the live parse's, which makes 言 the root
    // and leaves 正 hanging off a nominal. That is a parse error and is left to
    // be one; the annotation to correct is 順's headship, not this rule.
    expect(
      prose(
        sentenceOf(`# text = 名不正則言不順
1\t名\t名\tNOUN\tn,名詞,不可譲,属性\t_\t3\tsubj\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t正\t正\tADJ\tv,動詞,描写,形質\tDegree=Pos\t7\tmod\t_\t_
4\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t7\tmod\t_\t_
5\t言\t言\tNOUN\tn,名詞,可搬,伝達\t_\t7\tsubj\t_\t_
6\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t7\tmod\t_\t_
7\t順\t順\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
`),
      ),
    ).toContain("ば");
  });

  it("is a link in a predicate coordination chain across `parataxis`", () => {
    // `predicateCoordinationChain` counted ADJ only across an explicit
    // coordinator, from when the tag was the rare exception. Under 0.3.2 an ADJ
    // stands on `parataxis` **642** times and on `conj:coord` **1,099** — as a
    // VERB, every one of the 642 was a link — so kept on the nominal arm the
    // verb before each would have closed a clause it is only half of. Here the
    // first conjunct hands on in 連用形 instead of closing in 終止形.
    const out = prose(
      sentenceOf(`# text = 山高水深
1\t山\t山\tNOUN\tn,名詞,固定物,地形\t_\t2\tsubj\t_\t_
2\t高\t高\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
3\t水\t水\tNOUN\tn,名詞,固定物,地形\t_\t4\tsubj\t_\t_
4\t深\t深\tADJ\tv,動詞,描写,量\tDegree=Pos\t2\tparataxis\t_\t_
`),
    );
    expect(out).toContain("高く");
    expect(out).not.toContain("高し水");
  });

  it("is the caused predicate both layers must agree on", () => {
    // `depClassification.ts`'s half of `isCausedPredicateOf`. The two name one
    // token by construction — a caused predicate one of them refused would have
    // its しむ stranded in front of the clause instead of after it.
    const gov = { lemma: "使", dep: "ROOT", xpos: "v,動詞,行為,使役" };
    expect(isCausedPredicateParataxis({ dep: "parataxis", pos: "ADJ" }, gov)).toBe(true);
    expect(isCausedPredicateParataxis({ dep: "parataxis", pos: "VERB" }, gov)).toBe(true);
    expect(isCausedPredicateParataxis({ dep: "parataxis", pos: "NOUN" }, gov)).toBe(false);
  });
});

describe("a curated reading conditioned on the tag follows the tag", () => {
  it("gives a predicative 然 its しかり under either tag", () => {
    // 然 is ADV 442 / **ADJ 303** / PART 215 and VERB **0** over the recoded
    // gold, so an entry conditioned on VERB alone would have matched nothing
    // the parser can now produce, and every predicative 然 would have lost its
    // しかり in silence. Both tags are named, because a hand-corrected tree may
    // still say VERB.
    expect(findOverride("然", "ADJ")?.reading).toBe("しかり");
    expect(findOverride("然", "VERB")?.reading).toBe("しかり");
    // …and the entry stays context-restricted: the conjunctive 然 is しかれども
    // and the タリ suffix reaches neither.
    expect(findOverride("然", "SCONJ")?.reading).toBe("しかれども");
  });

  it("reads 果然 as はたして然り with both halves recoded", () => {
    // 果 in this use carries `v,動詞,描写,態度` and moves with the class (ADJ 2 /
    // VERB 30 in gold, and ADJ in the live parse); 然 moves outright. Both
    // entries name the new tag.
    expect(findOverride("果", "ADJ", "mod")?.okurigana).toBe("たして");
  });
});

describe("a hand-picked reading follows the same one gate", () => {
  it("converts a stored い ending on an ADJ and leaves a legacy VERB's alone", () => {
    // `chosenOkurigana`'s adjective conversion, asked through the same
    // `isDescriptiveToken`. The ADJ takes the classical 終止形 し; the legacy
    // VERB — a 0.3.1-era tree, whose chip reads 動詞 — keeps the verb treatment,
    // where `classicalVerbEnding` finds nothing to convert in a bare い.
    const stored = { Reading: "たか", Okurigana: "い" };
    expect(chosenReadingParts(tok({ lemma: "高", pos: "ADJ", morph: "Degree=Pos", misc: stored }))?.okurigana).toBe("し");
    expect(chosenReadingParts(tok({ lemma: "高", pos: "VERB", morph: "Degree=Pos", misc: stored }))?.okurigana).toBe("い");
  });

  it("gives a pinned on'yomi サ変 on a verb and withholds it from an adjective", () => {
    // The other half of the same function, and the exclusion that only became
    // real under 0.3.2: a stative used to be tagged VERB and took this す, and
    // now falls to the 形容動詞 machinery instead.
    expect(chosenReadingParts(tok({ lemma: "破", pos: "VERB", xpos: "v,動詞,行為,動作", misc: { Reading: "は" } }))?.okurigana).toBe("す");
    expect(chosenReadingParts(tok({ lemma: "愚", pos: "ADJ", morph: "Degree=Pos", misc: { Reading: "ぐ" } }))?.okurigana).toBeUndefined();
  });

  it("declines a pinned descriptive that governs an object — 僧愚之 is 僧これを愚す", () => {
    // "The monk made a fool of him", not "the monk was foolish": an adjective
    // governs no object, so a descriptive that has one is a transitive use and
    // サ変 stands. The す used to arrive from `chosenOkurigana` because 愚 was
    // tagged VERB; `pinnedKeiyoudoushi` writes it now, since it is the only
    // place that can see the object.
    expect(
      prose(
        sentenceOf(`# text = 僧愚之
1\t僧\t僧\tNOUN\tn,名詞,人,役割\t_\t2\tsubj\t_\t_
2\t愚\t愚\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\tReading=ぐ
3\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t2\tcomp:obj\t_\t_
`),
      ),
    ).toBe("僧これを愚す");
  });
});

describe("what the recoding must **not** be allowed to change", () => {
  it("keeps the サ変 す off an adjectival on'yomi and on a verbal one", () => {
    // The other kind of `pos === "VERB"` test: "a genuine verb, as against an
    // adjective". Those sites stay VERB-only, and under 0.3.2 the exclusion is
    // real for the first time — 燥渴 is a *predicate* span (ADJ over the verbal
    // xpos `v,動詞,描写,*`) and takes サ変, while 豪富 is the Sino-Japanese
    // denominal (ADJ over the **nominal** xpos `n,名詞,描写,*`) and takes なり.
    // The xpos is what separates them; widening on the tag alone would have put
    // す where the なり belongs.
    expect(
      prose(
        sentenceOf(`# text = 燥渴
1\t燥\t燥\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_
2\t渴\t渴\tADJ\tv,動詞,描写,境遇\t_\t1\tflat@vv\t_\t_
`),
      ),
    ).toBe("燥渴す");
  });

  it("leaves 有/無 alone — the existentials did not move", () => {
    // `isExistentialPredicate` keys on the lemma plus a VERB tag, and it needed
    // no change: 有 is VERB 3,653 (and ADJ 0) over the recoded gold, 無 VERB
    // 1,919 against a single ADJ. Only the `v,動詞,描写,*` class moved, and the
    // existentials are `v,動詞,存在,存在`.
    expect(
      prose(
        sentenceOf(`# text = 山中有虎
1\t山\t山\tNOUN\tn,名詞,固定物,地形\t_\t3\tsubj\t_\t_
2\t中\t中\tNOUN\tn,名詞,固定物,関係\t_\t1\tflat\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
4\t虎\t虎\tNOUN\tn,名詞,主体,動物\t_\t3\tcomp:obj\t_\t_
`),
      ),
    ).toContain("有り");
  });
});
