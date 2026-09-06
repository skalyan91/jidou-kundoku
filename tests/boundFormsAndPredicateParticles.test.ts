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
import { conjugate, shuushiConnectiveForm } from "../src/kakikudashi/classicalConjugation.ts";
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
// 1. 係り結び — ぞ / なむ / か bind a 連体形, and the 終助詞 や does not.
//
// **や left the binding set this round.** A 終助詞 や takes the 終止形 — the
// received 不亦說乎 is 亦說ばしから*ず*や, and 「ありやなしや」/「あはれなりや」
// show a ラ変型 word taking its plain 終止形 in front of the particle. See
// `BINDING_PARTICLE_READINGS` and `TERMINAL_PARTICLE_READINGS`. か (邪/耶, and
// 乎/與 inside a 豈 frame) is unaffected and still binds; so does the 終助詞 かな,
// by its own rule two blocks down.
// ---------------------------------------------------------------------------

describe("a predicate closed by a ぞ/なむ/か takes 連体形", () => {
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

  it("leaves the 終止形 before a や — a 終助詞, not a 係助詞", () => {
    // The same 乎 with no 豈 in the sentence reads や, and **that is where the
    // two particles part**. This asserted `rentai` — 數有*る*や — on the analysis
    // that a sentence-final や is the 係助詞 used 文末. The 接続 of the 終助詞 や
    // is the 終止形, and 有 is ラ変, whose 終止形 is 有り: 「ありやなしや」,
    // 「然りや否や」, 「あはれなりや」 are the attested shape, and the received
    // 亦說ばしから*ず*や would be 〜ざるや if the particle bound one. So 數有**り**や,
    // and the ラ変 exception (`shuushiConnectiveForm`) belongs to べし and not
    // here. See `TERMINAL_PARTICLE_READINGS`.
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t乎\t乎\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "乎"), sentence, undefined, resolve)).toBe("shuushi");
    expect(prose(sentence)).toContain("有りや");
    expect(prose(sentence)).not.toContain("有るや");
  });

  it("still binds a 邪, which reads か — the reading is the trigger, not the character", () => {
    // 邪 and 耶 read か through `overrides.json` (69 and 38 gold tokens on
    // `discourse@sp`), so they keep the 連体形 the 乎 above gave up. That pair is
    // the whole shape of this round's correction: a division between two
    // particles, not a retreat from 係り結び.
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t邪\t邪\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "邪"), sentence, undefined, resolve)).toBe("rentai");
    expect(prose(sentence)).toContain("有るか");
  });

  it("不亦說乎 is 亦說ばしからずや — the negation is asked first, and keeps its 終止形", () => {
    // The ordering this test was written for is unchanged and is what it still
    // checks: what stands between 說 and the 乎 is ず, so it is ず the particle
    // lands on; 說 owes the negation a 未然形, which the negation rule answers
    // before this one is reached, and `negationForm` decides ず's own form.
    //
    // **The expected form has been ず, then ざる, and is ず again — and the round
    // trip is not drift.** It was ず on a lexical carve-out in
    // `boundByBindingParticle` refusing the 連体形 wherever a 亦 stood in the
    // frame; the reader struck the carve-out out — *"Don't carve out 不亦"* —
    // and it became ざる. What was actually wrong was the 接続 of や, which the
    // carve-out had been compensating for one formula at a time: a 終助詞 や
    // takes the 終止形, so 〜ずや falls out here with no carve-out anywhere and
    // the reader's instruction stands. 亦說ばしから**ず**や is what every printed
    // kundoku of 論語 學而 has.
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
2\t亦\t亦\tADV\tv,副詞,頻度,重複\t_\t3\tmod\t_\t_
3\t說\t說\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
4\t乎\t乎\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "說"), named(sentence, "不"), sentence, undefined, resolve)).toBe("mizen");
    expect(prose(sentence)).toContain("ずや");
    expect(prose(sentence)).not.toContain("ざるや");
  });

  it("gives a 也 its 連体形 by the other rule — なり is not a 係助詞", () => {
    // The set is exact strings, so 也's なり and 哉's かな (which merely *starts*
    // with か) are both outside it. 哉 below is what shows that now: this 也 does
    // take a 連体形, but as the 断定 助動詞 an auxiliary attaches to
    // (`isAssertiveParticleAhead`, one branch further down `decideConjForm`),
    // and not as 係り結び. The two rules ask for the same form on the same token
    // here, so the form alone can no longer tell them apart — which is why the
    // 提示 也 cases below, where a 也 reads や and binds nothing, are where the
    // 係助詞 set is held to its own.
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "也"), sentence, undefined, resolve)).toBe("rentai");
  });

  it("gives a 哉 its 連体形 by its own rule — かな is not か, and takes one anyway", () => {
    // This asserted `not.toBe("rentai")`, on the reasoning that the set is exact
    // strings and かな merely *starts* with か. The set is still exact strings and
    // かな is still not in it — but かな **is** か + な and inherits its 接続, so
    // 唯我與爾有是夫 is 是れ有**る**かな and 賢哉囘也 賢なるかな. The rule is
    // `EXCLAMATORY_PARTICLE_READINGS`, one branch further down `decideConjForm`,
    // and the 334 gold 哉 took a 終止形 until it was written.
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t數\t數\tNOUN\tn,名詞,可搬,数量\t_\t1\tcomp:obj\t_\t_
3\t哉\t哉\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(decideConjForm(named(sentence, "有"), named(sentence, "哉"), sentence, undefined, resolve)).toBe("rentai");
    expect(prose(sentence)).toContain("有るかな");
  });

  it("writes no て on a bound form — the 連体形 rules and `converbSuffix` do not collide", () => {
    // 酒蟲 sent_id 38. The parser marks 然 `VerbForm=Conv`, which `converbSuffix`
    // would otherwise read as a converb and glue a て onto — the same collision
    // `isConditionalTemporalClause` already has with it (酌めてば), and now
    // refused for every 連体形 rather than only for the 已然形.
    const sentence = sentenceOf(`1\t然\t然\tADV\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Conv\t3\tsubj\t_\t_
2\t歟\t歟\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t否\t否\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
4\t歟\t歟\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`);
    // 然 now stands in front of a 終助詞 や and so keeps its ラ変 終止形 然り;
    // what this test is for is the *て*, and neither form may carry one.
    expect(prose(sentence)).toContain("然り");
    expect(prose(sentence)).not.toContain("然りて");
    expect(prose(sentence)).not.toContain("然るて");
  });
});

// ---------------------------------------------------------------------------
// 1b. 係り結び proper — the medial ぞ inside an interrogative word.
//
// This is where 係り結び actually happens in kanbun kundoku: the 係助詞 rides
// inside 何ぞ / 安くんぞ near the head of the clause and binds the predicate that
// *closes* it, several tokens later. See `INTERROGATIVE_BINDING_READINGS` for
// what binds and `interrogativeMusubi` for how the 結び is found. **314** gold
// sentences change with the rule on.
// ---------------------------------------------------------------------------

describe("a ぞ inside an interrogative word binds the predicate that closes its clause", () => {
  /** 何得X — 得 is 下二段ア行, whose 終止形 得 and 連体形 得る differ visibly, which
   * is why the fixtures here use it and not 有 (ラ変) or a 四段. */
  const whyGet = `1\t何\t何\tADV\tv,副詞,疑問,原因\t_\t2\tmod\t_\t_
2\t得\t得\tVERB\tv,動詞,行為,得失\t_\t0\troot\t_\t_
3\t仁\t仁\tNOUN\tn,名詞,描写,態度\t_\t2\tcomp:obj\t_\t_
`;

  it("binds 得 to 得る — 焉得仁 is 焉んぞ仁を得る, not 得", () => {
    const sentence = sentenceOf(whyGet);
    expect(decideConjForm(named(sentence, "得"), undefined, sentence, undefined, resolve)).toBe("rentai");
    expect(prose(sentence)).toContain("何");
    expect(prose(sentence)).toContain("得る");
  });

  it("needs the resolver, because what binds is the ぞ on the page and not the character", () => {
    // Asked without one — which is `selectedForm`'s position, deliberately, so
    // that the two panels cannot select forms from different evidence — the rule
    // answers no rather than guessing from the lemma. Both panels hand
    // `decideConjForm` a resolver at all four of its call sites.
    const sentence = sentenceOf(whyGet);
    expect(decideConjForm(named(sentence, "得"), undefined, sentence, undefined, undefined)).toBe("shuushi");
  });

  it("binds only forwards — a governor standing before the interrogative is a different clause", () => {
    // 係り結び binds what follows the particle. The guard is what keeps 如之何,
    // whose 何 this parser hangs on a 如 to its left, from binding backwards.
    const sentence = sentenceOf(`1\t得\t得\tVERB\tv,動詞,行為,得失\t_\t0\troot\t_\t_
2\t何\t何\tADV\tv,副詞,疑問,原因\t_\t1\tmod\t_\t_
`);
    expect(decideConjForm(named(sentence, "得"), named(sentence, "何"), sentence, undefined, resolve)).toBe("shuushi");
  });

  it("lands the 結び on the last link of a coordination chain, not on the first", () => {
    // A clause built out of coordinated predicates ends on a token the relation
    // is not on, so the 結び is the chain's last link and the earlier links keep
    // the 連用中止法 `isNonFinalCoordinand` gives them —
    // なんぞ…知り…得る. `predicateCoordinationChain` + `lastLinkOf` are reused
    // rather than reinvented, so the two answers cannot disagree.
    const sentence = sentenceOf(`1\t何\t何\tADV\tv,副詞,疑問,原因\t_\t2\tmod\t_\t_
2\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t得\t得\tVERB\tv,動詞,行為,得失\t_\t2\tconj:coord\t_\t_
`);
    expect(decideConjForm(named(sentence, "知"), undefined, sentence, undefined, resolve)).toBe("renyou");
    expect(decideConjForm(named(sentence, "得"), undefined, sentence, undefined, resolve)).toBe("rentai");
  });

  it("binds for an 安 tagged as the interrogative adverb — いづくんぞ", () => {
    // `v,副詞,疑問,所在` is 安's own interrogative tag (115 gold tokens), and
    // `overrides.json` reads it いづ + くんぞ, keeping the character — 安くんぞ,
    // as the received text writes 焉くんぞ (see `OverrideEntry.spellOutInProse`).
    // The ぞ is on the page either way, so it binds: `isInterrogativeBinder`
    // joins the two annotation slots, so where the boundary falls inside the
    // word makes no difference to it, and the 連体形 below is the proof.
    const sentence = sentenceOf(`1\t安\t安\tADV\tv,副詞,疑問,所在\t_\t2\tmod\t_\t_
2\t得\t得\tVERB\tv,動詞,行為,得失\t_\t0\troot\t_\t_
`);
    expect(prose(sentence)).toContain("安くんぞ");
    expect(decideConjForm(named(sentence, "得"), undefined, sentence, undefined, resolve)).toBe("rentai");
  });

  it("but not for the same 安 over a *verb* xpos, where the page prints 安く", () => {
    // 安 is ADV with `v,動詞,行為,態度` **31** times in the gold — 安無傾, 安居而
    // 天下熄 — carrying `VerbForm=Conv`, and there both panels take
    // `VERB_LEXICON`'s ク活用 やす ahead of the resolver: 安**く**傾く無し reaches
    // the page with no ぞ anywhere in it.
    // Binding a 結び on a particle the reader cannot see is the one thing this
    // rule must not do, and it did it for 10 gold sentences until
    // `isInterrogativeBinder` was made to ask `lexiconEntryFor` — the panels'
    // own precedence, rather than a second copy of it.
    //
    // Which reading those 31 should have is a data question for the reader, not
    // this rule's: either the lexicon entry should not be reached over that tag,
    // or the override should outrank it. Whichever way it is settled, the rule
    // follows what is printed.
    const sentence = sentenceOf(`1\t安\t安\tADV\tv,動詞,行為,態度\tVerbForm=Conv\t2\tmod\t_\t_
2\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t0\troot\t_\t_
3\t傾\t傾\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("安く");
    expect(prose(sentence)).not.toContain("いづくんぞ");
    expect(decideConjForm(named(sentence, "無"), undefined, sentence, undefined, resolve)).toBe("shuushi");
  });
});

// ---------------------------------------------------------------------------
// 1c. The ラ変 exception — a 終止形接続 助動詞 attaches to a ラ変型 連体形.
//
// `shuushiConnectiveForm` in `classicalConjugation.ts` names it and
// `decideConjForm`'s closing line is its one consumer. べし is the only
// 終止形接続 助動詞 this app writes (可/能 POTENTIAL, 須/當/応/應 NECESSITY); the
// rest take a 未然形 or a nominal. **23** gold sentences change.
// ---------------------------------------------------------------------------

describe("a べし standing on a ラ変型 predicate takes its 連体形", () => {
  it("可有 is 有るべし, not 有りべし", () => {
    // 可 heads its clause and the verb it licenses hangs off it as `comp:obj`,
    // which is the reverse of every particle rule in this file.
    const sentence = sentenceOf(`1\t可\t可\tAUX\tv,助動詞,可能,可能\t_\t0\troot\t_\t_
2\t有\t有\tVERB\tv,動詞,存在,存在\t_\t1\tcomp:obj\t_\t_
3\t事\t事\tNOUN\tn,名詞,可搬,成果物\t_\t2\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("有る可し");
    expect(prose(sentence)).not.toContain("有りべし");
  });

  it("leaves a ラ変 predicate that closes a sentence outright on its own 終止形", () => {
    // The exception is the *element*'s and not the slot's: 弟子三千人あり。 is
    // right and 弟子三千人ある。 is not, which is why the rule stands at the
    // closing line of `decideConjForm` and asks the tree first.
    const sentence = sentenceOf(`1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t事\t事\tNOUN\tn,名詞,可搬,成果物\t_\t1\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("有り");
    expect(prose(sentence)).not.toContain("有る");
  });

  it("leaves a paradigm that is not ラ変型 on its 終止形 — 可得 is 得べし", () => {
    const sentence = sentenceOf(`1\t可\t可\tAUX\tv,助動詞,可能,可能\t_\t0\troot\t_\t_
2\t得\t得\tVERB\tv,動詞,行為,得失\t_\t1\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("得可し");
    expect(prose(sentence)).not.toContain("得るべし");
  });

  it("requires the べし to be the very next thing read — 雖然 keeps 然り", () => {
    // Testing the edge alone caught every relation an auxiliary happens to head,
    // and the べし in those is written somewhere else entirely: 雖然，不可不審察也
    // came out 然**る**といへども where the received reading is 然**り**と雖も.
    // Reading-order adjacency is what says the べし is landing against this word.
    const sentence = sentenceOf(`1\t雖\t雖\tADV\tv,副詞,話題,逆接\t_\t2\tmod\t_\t_
2\t然\t然\tVERB\tv,動詞,描写,態度\t_\t3\tmod\t_\t_
3\t可\t可\tAUX\tv,助動詞,可能,可能\t_\t0\troot\t_\t_
4\t察\t察\tVERB\tv,動詞,行為,動作\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).not.toContain("然る");
  });
});

// ---------------------------------------------------------------------------
// 1d. The カリ活用 — the same 終止形接続 rule reached by a second route.
//
// An adjective under a べし switches paradigm rather than inflecting: く+あり
// contracted gives から・かり・○・**かる**・かれ・かれ, ラ変 throughout, and a
// 終止形接続 助動詞 takes that paradigm's 連体形. 淸不可 is 淸**かる**べからず.
// 淸**し**べからず, which is what the app wrote, is not a reading — a 助動詞
// cannot attach to an adjective's 終止形 at all, which is why the カリ series
// exists.
//
// `rentaiKar` in `classicalConjugation.ts` is the slot and
// `shuushiConnectiveForm`'s own arm selects it; the ク/シク classes are
// deliberately **not** in `RA_HEN_TYPE_CLASSES`, since their plain 連体形 き/しき
// is a real form doing a different job (賢しき者, 高き山) and a `"rentai"`
// returned for them would write 高きべし. **78** gold sentences change, 51 ク
// and 27 シク.
// ---------------------------------------------------------------------------

describe("a べし standing on a ク/シク adjective takes the カリ活用 連体形", () => {
  it("gives ク活用 かる — 不可長 is 長かるべからず, not 長しべからず", () => {
    const sentence = sentenceOf(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t可\t可\tAUX\tv,助動詞,可能,可能\t_\t0\troot\t_\t_
3\t長\t長\tADJ\tv,動詞,描写,量\tDegree=Pos\t2\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("長かる可からず");
    expect(prose(sentence)).not.toContain("長しべ");
  });

  it("gives シク活用 しかる — 未能正 is 正しかるべからず", () => {
    // The し of a シク adjective belongs to the stem's own ending (正しく,
    // 正しき), and く+あり contracts onto *that* く: 正しかる, not 正かる.
    const sentence = sentenceOf(`1\t未\t未\tADV\tv,副詞,否定,時相\tPolarity=Neg\t2\tmod\t_\t_
2\t能\t能\tAUX\tv,助動詞,可能,可能\t_\t0\troot\t_\t_
3\t正\t正\tADJ\tv,動詞,描写,態度\tDegree=Pos\t2\tcomp:obj\t_\t_
`);
    expect(prose(sentence)).toContain("正しかる");
    expect(prose(sentence)).not.toContain("正しべ");
  });

  it("leaves an adjective closing a sentence on its own 終止形", () => {
    // The exception belongs to the *element* and not to the slot, exactly as
    // the ラ変 block above tests for 弟子三千人あり。 — an adjective with no
    // 助動詞 on it is 長し, and かる is not a form anything else may select.
    const sentence = sentenceOf(`1\t道\t道\tNOUN\tn,名詞,固定物,関係\t_\t2\tsubj\t_\t_
2\t長\t長\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
`);
    expect(prose(sentence)).toContain("長し");
    expect(prose(sentence)).not.toContain("長かる");
  });

  it("keeps the plain 連体形 き where a 連体形 rule claims the adjective", () => {
    // き and かる are different slots, and every 連体形 rule in
    // `decideConjForm` wants the plain one: 長き者, never 長かる者. A ク/シク
    // class admitted to `RA_HEN_TYPE_CLASSES` instead of getting its own arm
    // would have written かる wherever those rules fired, since they and the
    // 終止形接続 arm would then have been asking for the same slot.
    const sentence = sentenceOf(`1\t長\t長\tADJ\tv,動詞,描写,量\tDegree=Pos\t2\tmod\t_\t_
2\t者\t者\tPART\tp,助詞,提示,*\t_\t0\troot\t_\t_
`);
    expect(decideConjForm(named(sentence, "長"), named(sentence, "者"), sentence, "ku-keiyoushi", resolve)).toBe(
      "rentai",
    );
    expect(prose(sentence)).toContain("長き");
    expect(prose(sentence)).not.toContain("長かる");
  });

  it("states both カリ cells, and states that they are different slots", () => {
    // から is the 未然形 (淸からず) and かる the 連体形 (淸かるべし). The mizen
    // fallback in `conjugate` exists because an adjective has no plain 未然形
    // at all; there is no such fallback for the 連体形, and there must not be —
    // き is a real form.
    expect(conjugate("ku-keiyoushi", "mizen")).toBe("から");
    expect(conjugate("ku-keiyoushi", "mizenKar")).toBe("から");
    expect(conjugate("ku-keiyoushi", "rentai")).toBe("き");
    expect(conjugate("ku-keiyoushi", "rentaiKar")).toBe("かる");
    expect(conjugate("shiku-keiyoushi", "rentai")).toBe("しき");
    expect(conjugate("shiku-keiyoushi", "rentaiKar")).toBe("しかる");
    expect(shuushiConnectiveForm("ku-keiyoushi")).toBe("rentaiKar");
    expect(shuushiConnectiveForm("shiku-keiyoushi")).toBe("rentaiKar");
    // Unchanged for everything else: ラ変型 takes its own 連体形, and an
    // ordinary paradigm its 終止形.
    expect(shuushiConnectiveForm("ra-hen")).toBe("rentai");
    expect(shuushiConnectiveForm("nari-keiyoudoushi")).toBe("rentai");
    expect(shuushiConnectiveForm("na-hen")).toBe("shuushi");
    expect(shuushiConnectiveForm("yodan-ka")).toBe("shuushi");
  });

  it("has no カリ 連体形 for a paradigm that has no カリ series, and throws instead", () => {
    // Nothing asks — `shuushiConnectiveForm` returns "rentaiKar" for the two
    // adjective classes and for no other — so this is the statement of an
    // invariant rather than a branch on live input. It must throw and not
    // quietly substitute the plain 連体形, which is the failure the mizen
    // fallback would suggest by analogy and which would put 得かるべし on a page.
    expect(() => conjugate("yodan-ka", "rentaiKar")).toThrow();
    expect(() => conjugate("ra-hen", "rentaiKar")).toThrow();
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

  it("suppresses it on a *conjunct* too, which reaches the copula by another route", () => {
    // 蟲是劉之福、非劉之病 whole: 病 is a `conj:coord` onto 福, so it is neither
    // the root nor the bearer of a subject (是 is 福's) and never passes the
    // guard the test above covers. It reached なり through
    // `isCoordinateClauseHead` instead and came out 劉の病に**なり**あらず — the
    // same bug by a second path, which is why the guard is now made twice.
    const sentence = sentenceOf(`1\t蟲\t蟲\tNOUN\tn,名詞,主体,動物\t_\t5\tdislocated\t_\t_
2\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t5\tsubj\t_\t_
3\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t4\tcomp:obj\t_\t_
4\t之\t之\tPART\tp,助詞,接続,属格\t_\t5\tmod\t_\t_
5\t福\t福\tNOUN\tn,名詞,可搬,成果物\t_\t0\troot\t_\t_
6\t、\t、\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
7\t非\t非\tADV\tv,副詞,否定,体言否定\tPolarity=Neg\t10\tmod\t_\t_
8\t劉\t劉\tPROPN\tn,名詞,人,姓氏\tNameType=Sur\t9\tcomp:obj\t_\t_
9\t之\t之\tPART\tp,助詞,接続,属格\t_\t10\tmod\t_\t_
10\t病\t病\tNOUN\tn,名詞,不可譲,疾病\t_\t5\tconj:coord\t_\t_
`);
    expect(prose(sentence)).toContain("病に非ず");
    expect(prose(sentence)).not.toContain("になりあらず");
    // The first conjunct keeps its own copula — the suppression is the 非's.
    expect(prose(sentence)).toContain("福にして");
  });

  it("gives a *suffix*-negated nominal its copula wherever it sits — 不亦君子乎", () => {
    // The other half of the same question, and the opposite answer. 不/未/弗/勿
    // are suffixes: the ず is written whatever else is decided, so a nominal
    // carrying one needs a copula to inflect or the suffix lands on a bare
    // noun. The live parse is what exposed it — it makes 君子 a `comp:obj` of
    // the 知 four characters earlier rather than a predication of its own, so
    // 君子 is neither root nor subject-bearing and reached no copula at all:
    // 亦君子**を**ざるや. `suffixNegated` now licenses the branch.
    const sentence = sentenceOf(`1\t人\t人\tNOUN\tn,名詞,人,人\t_\t3\tsubj\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\t_
3\t知\t知\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t6\tmod\t_\t_
5\t亦\t亦\tADV\tv,副詞,話題,累加\t_\t6\tmod\t_\t_
6\t君子\t君子\tNOUN\tn,名詞,人,役割\t_\t3\tcomp:obj\t_\t_
`);
    // The copula stem, which is the whole of the claim — whether it closes
    // ならず or inflects to ならざる is the following 乎's business, not this
    // rule's, and the fixture carries no 乎.
    expect(prose(sentence)).toContain("なら");
    expect(prose(sentence)).not.toContain("君子をざる");
    // The stray を is the annotation fault left visible: 君子 is not what 知
    // knows, and the two clauses are coordinate. Asserted so that correcting
    // the parse shows up here as a failing test rather than passing silently.
    expect(prose(sentence)).toContain("君子を");
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

// ---------------------------------------------------------------------------
// **The two 也, and only one of them binds.** 其為人也 is the 提示 也 — the one
// that marks a topic mid-sentence — and it reads や, not the なり of the 也 that
// closes a predicate. What separates them is the relation and not the position:
// over the recoded gold 也 is `discourse@sp` **7,317** times (the assertive one,
// 6,549 sentence-final and 768 closing a clause before a ； or a 」), while the
// 提示 use has its own deps entirely and is medial in every instance — subj 302,
// mod 31, mod@tmod 30, comp:obj 24, comp:pred 11, dislocated 8, vocative 3.
//
// **And the や it produces is declarative, so it writes no 連体形.** 係り結び
// belongs to the interrogative や of 乎/歟; a topic marker binds nothing. That
// falls out of where the reading comes from rather than being asserted twice:
// `closingParticleReading` consults the reading resolver — which is what this
// table answers — only for a `discourse`/`discourse@sp` particle, so a 提示 也
// never reaches `BINDING_PARTICLE_READINGS` at all.
// ---------------------------------------------------------------------------
describe("a 提示 也 reads や and binds nothing", () => {
  /** 有之X孝 — 有 is ラ変, so 終止形 あり and 連体形 ある differ visibly and a
   * 係り結び shows. `mark` closes 有; `dep` is the relation it carries. */
  const shape = (mark: string, dep: string) => `1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t4\tcomp:pred\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t${mark}\t${mark}\tPART\tp,助詞,句末,*\t_\t1\t${dep}\t_\t_
4\t孝\t孝\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
`;

  it.each([
    ["subj"], ["comp:obj"], ["comp:pred"], ["comp:obl"], ["comp:aux"], ["mod"], ["mod@tmod"],
    ["conj:coord"], ["conj:coord@emb"], ["dislocated"], ["vocative"], ["det"], ["udep"],
  ])("reads a 也 on %s as や", (dep) => {
    expect(prose(sentenceOf(shape("也", dep)))).toContain("や");
    expect(prose(sentenceOf(shape("也", dep)))).not.toContain("なり");
  });

  it("reads a 也 the parser made the sentence's own root as や, where it is medial", () => {
    // 15 gold tokens have 也 as ROOT — a parse oddity either way, but it
    // divides on position like everything else: the 8 that stand last are the
    // assertive 也 and reach なり through the positional fallback, the 7 that do
    // not (人之有道也、飽食煖衣…) are the 提示 one. Its own fixture because a
    // ROOT is its own head, which the shared shape above cannot express.
    const asRoot = `1\t人\t人\tNOUN\tn,名詞,人,人\t_\t2\tcomp:obj\t_\t_
2\t也\t也\tPART\tp,助詞,句末,*\t_\t2\troot\t_\t_
3\t孝\t孝\tADJ\tv,動詞,描写,態度\tDegree=Pos\t2\tconj:coord\t_\t_
`;
    expect(prose(sentenceOf(asRoot))).toContain("や");
  });

  it("takes every relation that is not a discourse one, because it heads its own phrase", () => {
    // The list above is long for a reason, and the reason is not a survey of
    // roles: this 也 *heads the phrase it marks*, so it wears whatever role
    // that phrase plays. Of the ~440 non-discourse 也 in the recoded gold, 246
    // govern one dependent, 141 two and 25 three, and only 4 govern nothing —
    // what they govern is the topic (416 `comp:obj`) and what they hang off is
    // the main predicate (VERB 254, ADJ 81, AUX 37). The assertive 也 is the
    // mirror: `discourse@sp` 7,317 times, **6,059 of them governing nothing**.
    // So the division is the relation, and a role-by-role list would be the
    // wrong shape for it.
    const topic = `1\t由\t由\tPROPN\tn,名詞,人,名\tNameType=Giv\t2\tcomp:obj\t_\t_
2\t也\t也\tPART\tp,助詞,句末,*\t_\t4\tsubj\t_\t_
3\t勇\t勇\tNOUN\tn,名詞,描写,態度\t_\t4\tcomp:obj\t_\t_
4\t好\t好\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
`;
    // 由也好勇 — 也 governs 由 and attaches to 好. 由や勇を好む.
    expect(prose(sentenceOf(topic))).toContain("や");
    expect(prose(sentenceOf(topic))).not.toContain("なり");
  });

  it("keeps なり where a topic relation happens to close the sentence", () => {
    // 9 gold tokens carry a topic relation *and* stand last — 丑見王之敬子也 —
    // and they are the assertive 也 after all. Position needs no clause in the
    // table: `isSentenceFinalParticleUse`'s positional fallback routes a 也
    // standing last to both panels' discourse branch, before the table is ever
    // consulted. Asserted so that the two mechanisms cannot drift apart.
    const closing = `1\t見\t見\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tcomp:obj\t_\t_
`;
    expect(prose(sentenceOf(closing))).toContain("なり");
    expect(prose(sentenceOf(closing))).not.toContain("や");
  });

  it("leaves the predicate in 終止形 — the declarative や binds nothing", () => {
    // 有**り**, never 有**る**. This is the whole of the rule: 連体形 before an
    // interrogative や, and before no other.
    expect(prose(sentenceOf(shape("也", "subj")))).toContain("有り");
    expect(prose(sentenceOf(shape("也", "subj")))).not.toContain("有る");
  });

  it("leaves the predicate in 終止形 for the interrogative や as well, and for another reason", () => {
    // 歟 reads the same kana and *is* a question, and the predicate is 有り all
    // the same — because the 終助詞 や takes a 終止形 whichever kind of question
    // it asks. This test used to assert 有る**や** and was the one place the
    // 係助詞 set was held to its own; the pair it was built on is gone, since
    // neither や binds now. What is left of the distinction is still real and is
    // asserted above: the 提示 也 never reaches `closingParticleReading` at all,
    // so it could not bind even if や did.
    expect(prose(sentenceOf(shape("歟", "discourse@sp")))).toContain("有りや");
    expect(prose(sentenceOf(shape("歟", "discourse@sp")))).not.toContain("有るや");
  });

  it("binds a 連体形 for the assertive 也 — 有るなり", () => {
    // `discourse@sp` is 7,317 of the corpus's 也 and is the one this table's
    // other entry reads. Both of the reader's own 酒蟲 也 are this one. It reads
    // なり, the 断定 助動詞, and an auxiliary attaches to a 連体形 — so this 也
    // binds one too, though for a reason the declarative や above has nothing
    // to do with. The pinned answer here was 有**り**なり while
    // `isAssertiveParticleAhead`'s call site was bounded to a chain; the reader
    // has ruled 有**る**なり and the bound is gone.
    const assertive = prose(sentenceOf(shape("也", "discourse@sp")));
    expect(assertive).toContain("有るなり");
    expect(assertive).not.toContain("有りなり");
  });

  it("reads a 也 standing on a **postposed** topic as や — 賢哉回也", () => {
    // The 〜哉…也 frame: the sentence exclaims first and names its subject
    // afterwards, and SUD marks the postposed subject `dislocated`. The 也 is
    // `discourse@sp` on that word, so what tells this 也 from the assertive one
    // is the **head's** relation and not its own. 賢なるかな回**や** is what 論語
    // prints; the app wrote 賢なるかな回**なり**.
    //
    // Over the recoded gold a 也 whose head bears `dislocated` is **8 tokens in
    // 8 sentences**, every one of them this frame — 賢哉回也 (twice), 君哉舜也,
    // 野哉由也, 善哉問也, 誠哉是言也, 不仁哉梁惠王也, 久矣哉，由之行詐也 — with no
    // false positive at all. Rendered both ways over the whole gold, those 8
    // sentences change and nothing else does.
    const worthyIndeed = `1\t賢\t賢\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
2\t哉\t哉\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t回\t回\tPROPN\tn,名詞,人,名\tNameType=Giv\t1\tdislocated\t_\t_
4\t也\t也\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`;
    // 賢 is ナリ活用 in `VERB_LEXICON` and かな takes a 連体形, so the first half
    // is 賢なるかな; this rule supplies the second.
    expect(prose(sentenceOf(worthyIndeed))).toBe("賢なるかな回や");
  });

  it("keeps なり for the same 也 where the head is not dislocated", () => {
    // The head's POS would have been the wrong key and this is the counter-case
    // it fails on: **121** gold 也 stand on a PROPN head that is not
    // dislocated — 61 of them on a PROPN `root` — and every one is the ordinary
    // assertive. 猶吾大夫崔子也 is 猶わが大夫崔子**なり**.
    const likeOurOfficer = `1\t猶\t猶\tADV\tv,副詞,判断,認知\t_\t3\tmod\t_\t_
2\t崔子\t崔子\tPROPN\tn,名詞,人,名\tNameType=Prs\t0\troot\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
`;
    expect(prose(sentenceOf(likeOurOfficer))).toContain("なり");
    expect(prose(sentenceOf(likeOurOfficer))).not.toContain("や");
  });

  it("leaves the predicate under a postposed 也 in 終止形, because the や is a 終助詞", () => {
    // The form follows the reading with no second rule, which is the point of
    // keying every particle rule in `conjugationContext.ts` on what the particle
    // is *read as*: 也 reading や goes to `TERMINAL_PARTICLE_READINGS` and asks
    // for a 終止形, where `isAssertiveParticleAhead` would have asked for the
    // 連体形 the copula なり needs. 有 is ラ変, so the two are visibly different.
    const withVerb = `1\t誠\t誠\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
2\t哉\t哉\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t有\t有\tVERB\tv,動詞,存在,存在\t_\t1\tdislocated\t_\t_
4\t也\t也\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_
`;
    const rendered = prose(sentenceOf(withVerb));
    expect(rendered).toContain("有りや");
    expect(rendered).not.toContain("有るや");
    expect(rendered).not.toContain("なり");
  });
});

// ---------------------------------------------------------------------------
// The 也 that writes no なり at all, and the form that has to agree with it.
//
// A ナリ活用形容動詞's own 終止形 *is* なり, so an assertive 也 closing one would
// write the copula twice — 君子仁**なりなり** — and `repeatsPredicateCopula`
// suppresses the particle's copy. `decideConjForm` went on selecting the 連体形
// the particle had asked for all the same, so the two together printed a bare
// attributive with no copula anywhere: 君子仁**なる**. Both halves now read the
// one predicate, so the form and the suppression cannot come apart.
// ---------------------------------------------------------------------------
describe("an assertive 也 on a ナリ活用 predicate leaves it in 終止形", () => {
  /** X也 with a ナリ活用 predicate — 仁, 賢 and 大 are all `nari-keiyoudoushi`
   * in `VERB_LEXICON`, which is the table `repeatsPredicateCopula` reads. */
  const asserted = (word: string) => `1\t${word}\t${word}\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
2\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`;

  it.each([
    ["仁", "仁なり"],
    ["賢", "賢なり"],
    // 大 spells its copula 大**い**なり — おほ + `okuriganaPrefix` い, which is
    // KANJIDIC2's own division of the character (`-おお.いに`). The prefix is
    // part of the ending and not of the reading, so it is `conjugatedOkurigana`
    // that writes it and this suppression that must leave exactly one copy of
    // なり standing after it.
    ["大", "大いなり"],
  ])("writes %s也 as one copula, not a bare 連体形", (word, expected) => {
    // 君子仁也 is 君子仁**なり**, which is what `repeatsPredicateCopula`'s own doc
    // has said it writes since it was written — and what it did not write.
    expect(prose(sentenceOf(asserted(word)))).toBe(expected);
    expect(prose(sentenceOf(asserted(word)))).not.toContain("なるなり");
  });

  it("still binds a 連体形 where the predicate does not supply the copula itself", () => {
    // The suppression is the whole of the exception, so a predicate that writes
    // no なり of its own is untouched: 有 is ラ変 and takes 有**る**なり. Both
    // arms of the same branch, asserted together, because what must not happen
    // is one of them moving on its own.
    const existential = `1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`;
    expect(prose(sentenceOf(existential))).toBe("有るなり");
  });

  it("selects the 終止形 outright rather than letting the predicate fall through to a chain", () => {
    // The reader's rule — *a sentence-final particle overrides the 連用形 of
    // coordination* — is what the explicit `shuushi` protects. A ナリ predicate
    // falling through the branches below would have met `isNonFinalCoordinand`
    // and taken にして, so a 也 closing the first of two conjuncts would print
    // 仁**にして** rather than 仁**なり**.
    const chained = `1\t仁\t仁\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\t_
2\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t知\t知\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
`;
    const rendered = prose(sentenceOf(chained));
    expect(rendered).toContain("仁なり");
    expect(rendered).not.toContain("仁にして");
  });
});

// ---------------------------------------------------------------------------
// **The synthesized copula inflects.** `COPULA` carried なら / にして / なり —
// three of ナリ活用's six — so the 終止形 stood in for every slot it lacked, and
// the two rules that would have asked for a 連体形 were already right with
// nothing to hand back: のみ takes one (`isLimitingParticleAhead`) and a 係助詞
// binds one (`isBindingParticleAhead`), and both got なり.
//
// The slot is selected in `selectedForm`, in the order `decideConjForm` puts
// the same rules in for a real verb: what attaches *onto* a predicate binds
// tighter than what it is coordinated with, and negation still wins over both.
// ---------------------------------------------------------------------------
describe("a synthesized copula takes 連体形 where something attaches onto it", () => {
  it("gives のみ a 連体形 — 君子耳 is 君子なるのみ", () => {
    expect(
      prose(sentenceOf(`1\t君子\t君子\tNOUN\tn,名詞,人,役割\t_\t0\troot\t_\t_
2\t耳\t耳\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`)),
    ).toBe("君子なるのみ");
  });

  it("gives a 係助詞 か one — 是知邪 is 是れ知なるか", () => {
    // 係り結び: か binds the predicate to 連体形, and the predicate here is a
    // copula the app synthesized rather than a word in the text.
    //
    // **This was written with a 乎 on it and asserted 是れ知な*る*や.** The 終助詞
    // や takes a 終止形 (see `TERMINAL_PARTICLE_READINGS`), so that sentence is
    // 是れ知な**り**や — asserted immediately below, since it is the case the
    // correction moved — and the 連体形 this block is about is shown with a 邪,
    // which reads か and does bind.
    expect(
      prose(sentenceOf(`1\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t2\tsubj\t_\t_
2\t知\t知\tNOUN\tn,名詞,描写,態度\t_\t0\troot\t_\t_
3\t邪\t邪\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
`)),
    ).toBe("是れ知なるか");
  });

  it("leaves the 終止形 before a 終助詞 や — 是知乎 is 是れ知なりや", () => {
    // ナリ活用 is ラ変型, and 「あはれなりや」 is the attested shape: a 終助詞
    // attaches to what the paradigm actually spells, and the ラ変 exception is
    // the 終止形接続 **助動詞**'s. `COPULA.rentai` is still selected by のみ, by
    // か, by かな and by a following 者.
    expect(
      prose(sentenceOf(`1\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t2\tsubj\t_\t_
2\t知\t知\tNOUN\tn,名詞,描写,態度\t_\t0\troot\t_\t_
3\t乎\t乎\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
`)),
    ).toBe("是れ知なりや");
  });

  it("gives a かな one too — 君子哉 is 君子なるかな", () => {
    // The 終助詞 かな takes 体言・連体形, so a synthesized copula standing in front
    // of one is attributive exactly as it is in front of のみ. Added with the
    // かな arm in `selectedForm`; 大哉堯之爲君 is 大なるかな in the received text.
    expect(
      prose(sentenceOf(`1\t君子\t君子\tNOUN\tn,名詞,人,役割\t_\t0\troot\t_\t_
2\t哉\t哉\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`)),
    ).toBe("君子なるかな");
  });

  it("leaves the 終止形 where nothing attaches — the assertive 也, and a bare predication", () => {
    // 也 reads なり and is not a 係助詞, and `selectedForm`'s attributive list is
    // のみ, the 係助詞 and the nominalizer — `isAssertiveParticleAhead` is
    // deliberately not in it, though it does bind a real verb's 連体形 one branch
    // below them in `decideConjForm`. The 断定 that 也 supplies *is* the copula
    // this ending already writes, so 是知也 is 是れ知なり with one なり; a 連体形
    // here would put a second auxiliary on the first (是れ知なるなり).
    expect(
      prose(sentenceOf(`1\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t2\tsubj\t_\t_
2\t知\t知\tNOUN\tn,名詞,描写,態度\t_\t0\troot\t_\t_
3\t也\t也\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
`)),
    ).toBe("是れ知なり");
    expect(
      prose(sentenceOf(`1\t王\t王\tNOUN\tn,名詞,人,役割\t_\t2\tsubj\t_\t_
2\t仁\t仁\tNOUN\tn,名詞,描写,態度\t_\t0\troot\t_\t_
`)),
    ).toBe("王仁なり");
  });
});
