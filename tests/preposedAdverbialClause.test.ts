import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { Sentence, Token } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { caseParticleFor, decideConjForm, readsWithDativeObject } from "../src/kakikudashi/conjugationContext.ts";

// ---------------------------------------------------------------------------
// **A preposed verbal `mod` clause reads 連用形, and the ば is the trigger's.**
//
// Two rules share one slot — a VERB hanging off a predicate by `mod` and
// standing in front of it — and what divides them is a word in the sentence:
//
//  - with a すなはち-class connective on the apodosis (or a 既 on the clause),
//    `isConditionalTemporalClause` reads it 已然形 + ば;
//  - with nothing, `isPreposedAdverbialClause` reads it 連用形, the 連用中止法
//    that hands one clause on to the next.
//
// Before the second of those existed the slot had no branch at all and fell out
// of `decideConjForm` to 終止形 — a subordinate clause printed as though it
// closed the sentence, with the next one starting cold after it. 感時花濺淚 read
// 時を感**ず**花に淚を濺ぎ; 誡曰 read 誡**む**曰く.
//
// **What this file pins is the division**, in both directions: that the trigger
// still wins where it stands, that the converb is taken where it does not, and
// the four gates that keep the converb rule off everything else — the head must
// be a predicate, the dependent must be a VERB, it must stand *before* its head,
// and it must read last in its own subtree. Each of those was measured against
// kanbun.info's received reading; `isPreposedAdverbialClause`'s own doc holds
// the table and the counts, and this file holds the sentences.
//
// **The edit counts quoted below are the gate-selection ones** — every variant
// against every other in one process, on one tree — and that comparison is what
// they are for. The rule's *absolute* worth against the received text was
// re-measured on a later tree and came back much smaller; the closing paragraph
// of `isPreposedAdverbialClause`'s doc has both figures and why they differ.
//
// Trees are written out rather than parsed live, as `adverbialClauseParticles`
// and `coordinatedProtasis` do and for the same reason: the shape is what is
// being tested, and the live parser does not always return it. The 春望 lines
// are the reader's own annotation, copied from `public/data/samples/shunbou.conllu`.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

function sentenceOf(rows: string): Sentence {
  const tree = parseConllu(rows);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

const named = (sentence: Sentence, text: string): Token => {
  const token = sentence.tokens.find((t) => t.text === text);
  if (!token) throw new Error(`no ${text} in the sentence`);
  return token;
};

const prose = (sentence: Sentence): string =>
  generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })), resolve)
    .replace(/\s+/g, "");

describe("a preposed verbal `mod` clause hands on in 連用形", () => {
  it("感時花濺淚 — 感 is 連用形 感じ and not the 終止形 感ず", () => {
    // 杜甫・春望, the line this rule was found on. 感 governs its own object
    // (時) and so can never carry `VerbForm=Conv`: that feature stands on ADV
    // and only ADV in the gold treebank, 13,478 of 13,478, and not one of the
    // 13,478 governs a `comp:obj`. The relation is the only thing left to read
    // the shape off, which is what this rule does.
    //
    // The received reading is 時に感じては. The に is not this rule's (see
    // `DATIVE_OBJECT_LEMMAS`, which refuses 感 and says why) and the ては is a
    // て this app writes only under `renyouTe.ts`'s switch plus a は no relation
    // states. The 連用形 is what is being pinned.
    const sentence = sentenceOf(`1\t感\t感\tVERB\tv,動詞,行為,態度\t_\t4\tmod\t_\tReading=かん|ConjClass=za-hen
2\t時\t時\tNOUN\tn,名詞,時,*\tCase=Tem\t1\tcomp:obj\t_\t_
3\t花\t花\tNOUN\tn,名詞,固定物,樹木\tCase=Loc\t4\tmod@lmod\t_\t_
4\t濺\t濺\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
5\t淚\t淚\tNOUN\tn,名詞,不可譲,身体\t_\t4\tcomp:obj\t_\t_
`);
    expect(decideConjForm(named(sentence, "感"), undefined, sentence)).toBe("renyou");
    expect(prose(sentence)).toBe("時を感じ花に淚を濺ぐ");
    // 連用中止法 is a bare 連用形 by the reader's settled decision, so no
    // particle is written after it — see `converbSuffix`'s closing note.
    expect(caseParticleFor(named(sentence, "感"), sentence)).toBeUndefined();
  });

  it("誡曰 — a single-token adjunct too, and that is where the rule is surest", () => {
    // 誡めて曰く. Requiring the clause to *govern* something was measured and
    // makes the rule four times worse (-6 edits against -25 over kanbun.info),
    // because the bare adjunct in front of a verb of speech — 誡曰, 諫曰, 對曰 —
    // is the shape the received text writes the converb for as a matter of
    // course. A one-token `mod` is not an adverb the parser mistagged.
    //
    // The form and not the prose, because a *two-character* sentence is not a
    // test of the prose at all: `findCompoundSpans` reads 誡曰 as one lexical
    // word and both panels then write it as one (誡曰す), which is a different
    // rule answering a different question. The corpus ratchet holds the prose
    // for this shape — 舍人相與諫曰 is one of the passages that moved closer.
    const sentence = sentenceOf(`1\t誡\t誡\tVERB\tv,動詞,行為,伝達\t_\t2\tmod\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "誡"), undefined, sentence)).toBe("renyou");
  });

  it("…and an AUX head counts as a predicate, the same gate the protasis rule takes", () => {
    // `headsConditionalProtasis` accepts a governor that is `isContentPredicatePos`
    // *or* AUX, and this takes the identical gate so that the two adverbial
    // rules agree about what an apodosis is. 1,001 of the gold treebank's 6,372
    // edges in this slot have an AUX head, and admitting them is worth 7 edits
    // (−34 against −27).
    const sentence = sentenceOf(`1\t進\t進\tVERB\tv,動詞,行為,移動\t_\t3\tmod\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t能\t能\tAUX\tv,助動詞,可能,*\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "進"), undefined, sentence)).toBe("renyou");
  });
});

describe("…and the four gates that keep it off everything else", () => {
  it("a verbal `mod` of a *nominal* is not an adjunct clause — 解縛視之 keeps 視る", () => {
    // 解's governor is the nominal root 肉. The note above
    // `isConditionalTemporalClause` counts 31,268 verbal `mod` edges under a
    // non-verbal governor and finds them to be attributive relatives inside a
    // nominal predicate — 里仁篇第四, 皆賢人也, 是誰之過與 — not adjuncts at all,
    // so the head has to be a predicate. `adverbialClauseParticles.test.ts`
    // pins the other half of this sentence, that it takes no ば either.
    const sentence = sentenceOf(`1\t解\t解\tVERB\tv,動詞,行為,動作\t_\t6\tmod\t_\t_
2\t縛\t縛\tNOUN\tv,動詞,行為,動作\t_\t1\tcomp:obj\t_\t_
3\t視\t視\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t赤\t赤\tADJ\tn,名詞,描写,形質\t_\t6\tmod\t_\t_
6\t肉\t肉\tNOUN\tn,名詞,可搬,糧食\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "視"), undefined, sentence)).not.toBe("renyou");
    expect(prose(sentence)).toContain("視る");
  });

  it("a `mod` standing *after* its head is not preposed, and takes nothing from this", () => {
    // Postposed material is read where it stands; a 連用形 written on it would
    // hand a clause on to something already said.
    const sentence = sentenceOf(`1\t坐\t坐\tVERB\tv,動詞,行為,姿勢\t_\t0\troot\t_\t_
2\t食\t食\tVERB\tv,動詞,行為,飲食\t_\t1\tmod\t_\t_
`);
    expect(decideConjForm(named(sentence, "食"), undefined, sentence)).not.toBe("renyou");
  });

  it("an ADJ `mod` is not admitted — measured at 2 edits, and it is attributive", () => {
    // Admitting ADJ dependents beside VERB was measured over kanbun.info and
    // costs 2 edits (−25 against −27 on the same base). An ADJ in this slot is
    // overwhelmingly attributive, and `modifiesAdjacentNominal` above
    // `decideConjForm`'s coordination rules already claims the ones that are not.
    const sentence = sentenceOf(`1\t深\t深\tADJ\tv,動詞,描写,量\tDegree=Pos\t2\tmod\t_\t_
2\t入\t入\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "深"), undefined, sentence)).not.toBe("renyou");
  });
});

describe("the trigger still wins where the sentence has one", () => {
  it("邦有道則知 — 已然形 + ば, and the converb rule does not reach it", () => {
    // `isConditionalTemporalClause` is asked first in `decideConjForm`, and that
    // ordering is the whole division of labour between the two rules: the same
    // slot reads 已然形+ば where a すなはち-class connective says the clause is a
    // protasis and 連用形 where nothing does.
    const sentence = sentenceOf(`1\t邦\t邦\tNOUN\tn,名詞,主体,集団\t_\t3\tsubj\t_\t_
2\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t3\tcomp:obj\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t5\tmod\t_\t_
4\t則\t則\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t5\tmod\t_\t_
5\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), undefined, sentence)).toBe("izen");
    expect(caseParticleFor(named(sentence, "有"), sentence)).toBe("ば");
  });

  it("…and without the connective the same tree hands on in 連用形 instead", () => {
    // The identical sentence with the 則 struck out. This is the pair the
    // measurement turns on: dropping the trigger requirement altogether — so
    // that *every* clause in this slot took ば — reads kanbun.info **+1,597
    // edits worse** (gold +112, parser +1,485; 39 passages closer, 772
    // further), because the untriggered slot is headed by 以 5,478, 大 666,
    // 獨 223, 凡 160, 甚 157 — adverbs, which come out 以て**ば**. See the note
    // above `isConditionalTemporalClause`.
    const sentence = sentenceOf(`1\t邦\t邦\tNOUN\tn,名詞,主体,集団\t_\t3\tsubj\t_\t_
2\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t3\tcomp:obj\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t4\tmod\t_\t_
4\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), undefined, sentence)).toBe("renyou");
    expect(caseParticleFor(named(sentence, "有"), sentence)).toBeUndefined();
  });

  it("白頭搔更短 — 掻き, not 掻けば, and the ば is not recoverable from this tree", () => {
    // 杜甫・春望 again. The received reading is 白頭掻け**ば**更に短く and the
    // sentence contains no 則 and no 既, so the protasis cannot be recognised
    // without inventing a trigger — the measurement above says what inventing
    // one costs. What the line gets instead is the converb, which is a clause
    // handed on rather than a sentence closed: 搔**く** was what stood here.
    const sentence = sentenceOf(`1\t白\t白\tNOUN\tn,名詞,描写,形質\t_\t2\tmod\t_\t_
2\t頭\t頭\tNOUN\tn,名詞,不可譲,身体\t_\t3\tsubj\t_\t_
3\t搔\t搔\tVERB\tv,動詞,行為,動作\t_\t5\tmod\t_\t_
4\t更\t更\tADV\tv,動詞,行為,動作\tVerbForm=Conv\t5\tmod\t_\tReading=さら|Okurigana=に
5\t短\t短\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "搔"), undefined, sentence)).toBe("renyou");
    expect(prose(sentence)).toContain("搔き更に短し");
  });
});

describe("抵's complement is marked に, and 感's is not", () => {
  it("家書抵萬金 — 萬金に抵たる", () => {
    // 杜甫・春望, and the received reading entire: 家書万金に抵たる, where this
    // app wrote 萬金**を**抵る. 抵 is in `DATIVE_OBJECT_LEMMAS`, so the particle
    // and the transitivity of the reading are one decision — see
    // `readsWithDativeObject`, and `dativeObjectTransitivity.test.ts` for the
    // pairing.
    expect(readsWithDativeObject({ lemma: "抵" } as Token)).toBe(true);
    const sentence = sentenceOf(`1\t家\t家\tNOUN\tn,名詞,主体,集団\t_\t2\tmod\t_\t_
2\t書\t書\tNOUN\tn,名詞,主体,書物\t_\t3\tsubj\t_\t_
3\t抵\t抵\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\tReading=あた|ConjClass=yodan-ra
4\t萬\t萬\tNUM\tn,数詞,数字,*\t_\t5\tmod\t_\t_
5\t金\t金\tNOUN\tn,名詞,可搬,道具\t_\t3\tcomp:obj\t_\t_
`);
    expect(caseParticleFor(named(sentence, "金"), sentence)).toBe("に");
    // The particle, which is what this table decides. Which side of the
    // character the た falls on is `pickedEnding`'s: the sample's own line
    // writes 抵たる and a bare tree writes 抵る, and neither is this rule's.
    expect(prose(sentence)).toContain("萬金に抵");
    expect(prose(sentence)).not.toContain("萬金を");
  });

  it("姦聲感人 — 人を感ず, which is why 感 is not in that table", () => {
    // The lemma 感 has a live を-taking sense and the treebank's own counts are
    // led by it: of gold's 28 `comp:obj` under 感, 姦聲感人, 正聲感人, 其感人深
    // and 足以感動人之善心 are 感 *moving* someone. Marking that complement に
    // would say the sounds were moved by the people — the sentence backwards —
    // which is the ambiguity `DATIVE_OBJECT_LEMMAS` keeps 任 and 服 out for.
    // 感時花濺淚's 時**に** is given up on those grounds and the argument is at
    // that table.
    const sentence = sentenceOf(`1\t姦\t姦\tVERB\tv,動詞,描写,態度\tDegree=Pos\t2\tmod\t_\t_
2\t聲\t聲\tNOUN\tn,名詞,可搬,伝達\t_\t3\tsubj\t_\t_
3\t感\t感\tVERB\tv,動詞,行為,態度\t_\t0\troot\t_\tReading=かん|ConjClass=za-hen
4\t人\t人\tNOUN\tn,名詞,人,人\t_\t3\tcomp:obj\t_\t_
`);
    expect(caseParticleFor(named(sentence, "人"), sentence)).toBe("を");
  });
});
