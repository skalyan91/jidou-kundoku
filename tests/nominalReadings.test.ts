import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { candidateReadings, type KanjidicIndex, lookupKanji } from "../src/reading/kanjidicLookup.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { findOverride } from "../src/reading/overridesLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { attestedSenseByModernSpelling, LEXICON_SENSES, VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { conjugate } from "../src/kakikudashi/classicalConjugation.ts";
import { classicalConjClass } from "../src/reading/classicalEnding.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");

function loadRealIndex<T>(filename: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, filename), "utf-8")) as T;
}

const kanjidic = loadRealIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadRealIndex<JmdictIndex>("jmdict-index.json");
// No historical-kana index: these tests are about which reading is chosen, not
// about how it is spelled, and leaving it out keeps every expectation in
// KANJIDIC2's own modern kana (るい, おさ) rather than in 歴史的仮名遣い.
const resolve = createReadingResolver(kanjidic, jmdict);

function makeToken(overrides: Partial<Token>): Token {
  return { id: 1, text: "", lemma: "", pos: "", xpos: "", dep: "", head: 0, ...overrides };
}

function sentenceOf(tokens: Token[]): Sentence {
  return { tokens } as Sentence;
}

/** 解縛視之、赤肉長三寸許 (sent_id 25) — the two nominal-slot predicates the
 * reader named, in the shape the treebank gives them: NOUN in the UPOS column,
 * 動詞 in the xpos. */
const chunEnough = () =>
  sentenceOf([
    makeToken({ id: 1, text: "長", lemma: "長", pos: "NOUN", xpos: "v,動詞,描写,量", dep: "subj", head: 2 }),
    makeToken({ id: 2, text: "三", lemma: "三", pos: "NUM", xpos: "n,数詞,数字,*", dep: "conj:coord", head: 0 }),
    makeToken({ id: 3, text: "寸", lemma: "寸", pos: "NOUN", xpos: "n,名詞,度量衡,*", dep: "clf", head: 2 }),
    makeToken({ id: 4, text: "許", lemma: "許", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "mod", head: 2 }),
  ]);

/** 哇有物出 (sent_id 24) — the retching verb, and the emergence 出 standing as
 * 有's `subj`. */
const somethingCameOut = () =>
  sentenceOf([
    makeToken({ id: 1, text: "哇", lemma: "哇", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "mod", head: 2 }),
    makeToken({ id: 2, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "root", head: 0 }),
    makeToken({ id: 3, text: "物", lemma: "物", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "mod", head: 4 }),
    makeToken({ id: 4, text: "出", lemma: "出", pos: "NOUN", xpos: "v,動詞,行為,移動", dep: "subj", head: 2 }),
  ]);

describe("a predicate standing in a nominal slot", () => {
  it("reads 出 as the 連体形 いづる, not as its bare kun で", () => {
    const sentence = somethingCameOut();
    const out = resolve(sentence.tokens[3], sentence);
    expect(out.reading).toBe("い");
    expect(out.okurigana).toBe("づる");
  });

  it("reads 長 as the さ nominalisation, not as the noun をさ", () => {
    const sentence = chunEnough();
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("なが");
    expect(out.okurigana).toBe("さ");
  });

  it("carries no conjugation class: a nominalisation is a finished form", () => {
    const sentence = somethingCameOut();
    const out = resolve(sentence.tokens[3], sentence);
    expect(out.conjClass).toBeUndefined();
    expect(out.beatsLexicon).toBeUndefined();
  });

  it("leaves a nominal the xpos also calls nominal alone (中 is なか, never あたる)", () => {
    const sentence = sentenceOf([makeToken({ text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "subj" })]);
    expect(resolve(sentence.tokens[0], sentence).reading).toBe("なか");
  });

  it("leaves a kun-less nominal on its on'yomi — there is nothing to nominalise", () => {
    // 累 in 以飲為累: KANJIDIC2 gives it no kun'yomi at all, so the verbal xpos
    // finds nothing and the on'yomi stands exactly as before.
    const sentence = sentenceOf([makeToken({ text: "累", lemma: "累", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:pred" })]);
    expect(resolve(sentence.tokens[0], sentence).reading).toBe("るい");
  });

  it("needs the xpos to say so: an absent xpos answers no", () => {
    const sentence = sentenceOf([makeToken({ text: "長", lemma: "長", pos: "NOUN", xpos: "", dep: "subj" })]);
    expect(resolve(sentence.tokens[0], sentence).reading).toBe("おさ");
  });
});

describe("nominalizations in the furigana menu", () => {
  const offered = (char: string, pos: string) =>
    candidateReadings(kanjidic, char, pos, undefined, jmdict).map((c) => c.reading + (c.okurigana ?? ""));

  it("offers 出's 連体形 beside its bare kun", () => {
    expect(offered("出", "NOUN")).toEqual(["しゅつ", "すい", "で", "いづる", "でる", "だす"]);
  });

  it("offers 長's さ and み nominalisations beside ながし", () => {
    const out = offered("長", "NOUN");
    expect(out).toContain("ながさ");
    expect(out).toContain("ながみ");
    expect(out).toContain("ながき");
    expect(out).toContain("ながし");
    expect(out).toContain("おさ");
  });

  it("puts the nominalisation the resolver takes first among them", () => {
    const out = offered("長", "NOUN");
    expect(out.indexOf("ながさ")).toBeLessThan(out.indexOf("ながし"));
  });

  it("offers a verb nothing of the kind — a finite reading is what a verb wants", () => {
    expect(offered("長", "VERB")).not.toContain("ながさ");
    expect(offered("出", "VERB")).not.toContain("いづる");
  });

  it("nominalises the lexicon's sense, not KANJIDIC2's leading kun", () => {
    // 出's kun list leads with で.る, whose bare る derives only 四段ラ行. The
    // word is 下二段ダ行 出づ, which is what `VERB_LEXICON` holds and what the
    // first nominalisation has to come from.
    expect(VERB_LEXICON["出"]).toMatchObject({ conjClass: "shimo-nidan-da", reading: "い" });
    expect(offered("出", "NOUN").indexOf("いづる")).toBeLessThan(offered("出", "NOUN").indexOf("でる"));
  });

  it("declines an い-final reading JMdict does not vouch for as an adjective", () => {
    // 扱's あつか.い is a 連用形 nominal ("handling"), not an adjective, so it
    // grows no あつかさ / あつかみ.
    const out = offered("扱", "NOUN");
    expect(out).not.toContain("あつかさ");
    expect(out).not.toContain("あつかみ");
  });
});

describe("readings the reader moved between tables", () => {
  it("許 reads ばかり as furigana, from the kun list rather than the override table", () => {
    expect(findOverride("許", "NOUN", "mod")).toBeNull();
    const hit = lookupKanji(kanjidic, "許", "NOUN");
    expect(hit).toMatchObject({ reading: "ばかり", series: "kun" });
    expect(hit?.okurigana).toBeUndefined();
  });

  it("keeps 許す reachable as a verb, and もと in the menu", () => {
    expect(lookupKanji(kanjidic, "許", "VERB")).toMatchObject({ reading: "ゆる", okurigana: "す" });
    expect(candidateReadings(kanjidic, "許", "NOUN").map((c) => c.reading)).toContain("もと");
  });

  it("如 is split ごと + し, so the reading goes over the character", () => {
    expect(findOverride("如", "ADJ", "conj:coord")).toMatchObject({ reading: "ごと", okurigana: "し" });
  });

  it("genitive 之 states an empty okurigana, which is what puts の in the furigana slot", () => {
    expect(findOverride("之", "ADP", "mod")).toMatchObject({ reading: "の", okurigana: "" });
    expect(findOverride("之", "SCONJ", "mod")).toMatchObject({ reading: "の", okurigana: "" });
  });

  it("leaves the pronoun 之 as これ", () => {
    expect(findOverride("之", "PRON", "comp:obj")).toMatchObject({ reading: "これ" });
  });
});

describe("此 read これ is written 此れ", () => {
  it("splits こ + れ where no case particle claims the slot", () => {
    const sentence = sentenceOf([
      makeToken({ id: 1, text: "此", lemma: "此", pos: "PRON", xpos: "n,代名詞,指示,*", morph: "PronType=Dem", dep: "subj", head: 3 }),
      makeToken({ id: 2, text: "酒", lemma: "酒", pos: "NOUN", xpos: "n,名詞,可搬,糧食", dep: "mod", head: 3 }),
      makeToken({ id: 3, text: "蟲", lemma: "蟲", pos: "NOUN", xpos: "n,名詞,主体,動物", dep: "root", head: 0 }),
    ]);
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("こ");
    expect(out.okurigana).toBe("れ");
    // A content-word reading, so the prose keeps the kanji: 此れ, not これ.
    expect(out.spellOutInProse).toBeUndefined();
  });

  // The split is keyed by the *reading* now, not by a set of characters — れ is
  // an ending of the word これ, and これ is the same word whichever character
  // writes it. See `READING_ENDING_SPLITS` in readingResolver.ts.
  it("is extended to 是, which writes the same word", () => {
    const sentence = sentenceOf([
      makeToken({ id: 1, text: "是", lemma: "是", pos: "PRON", xpos: "n,代名詞,指示,*", dep: "subj", head: 2 }),
      makeToken({ id: 2, text: "福", lemma: "福", pos: "NOUN", xpos: "n,名詞,抽象物,関係", dep: "root", head: 0 }),
    ]);
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("こ");
    expect(out.okurigana).toBe("れ");
  });
});

/** より as an adposition is written 自より — よ over the character, リ beside it
 * — by the same rule and through the same function that writes 之れ, and for
 * the same reason: り is an ending of the word より, and より is one word
 * whichever of 自 / 從 / 从 / 由 writes it. */
describe("より as an ADP is written よ + り", () => {
  const adp = (text: string) =>
    sentenceOf([
      makeToken({ id: 1, text, lemma: text, pos: "ADP", xpos: "v,前置詞,経由,*", dep: "mod", head: 3 }),
      makeToken({ id: 2, text: "藍", lemma: "藍", pos: "NOUN", xpos: "n,名詞,可搬,道具", dep: "comp:obj", head: 1 }),
      makeToken({ id: 3, text: "取", lemma: "取", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "root", head: 0 }),
    ]);

  it.each(["自", "從", "从", "由"])("splits %s into よ + り", (char) => {
    const sentence = adp(char);
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("よ");
    expect(out.okurigana).toBe("り");
    // Still a function word: the 書き下し文 writes より in kana and drops the
    // character, which it does by running the two halves together.
    expect(out.spellOutInProse).toBe(true);
  });

  it("leaves 由 read なほ where the parser calls it an adverb", () => {
    const sentence = sentenceOf([
      makeToken({ id: 1, text: "由", lemma: "由", pos: "ADV", xpos: "v,副詞,判断,推量", dep: "mod", head: 2 }),
      makeToken({ id: 2, text: "足", lemma: "足", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "root", head: 0 }),
    ]);
    expect(resolve(sentence.tokens[0], sentence).reading).toBe("なほ");
  });

  it("leaves 自 read みづか + ら where it is the reflexive pronoun", () => {
    const sentence = sentenceOf([
      makeToken({ id: 1, text: "自", lemma: "自", pos: "PRON", xpos: "n,代名詞,人称,*", dep: "subj", head: 2 }),
      makeToken({ id: 2, text: "行", lemma: "行", pos: "VERB", xpos: "v,動詞,行為,移動", dep: "root", head: 0 }),
    ]);
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("みづか");
    expect(out.okurigana).toBe("ら");
  });
});

describe("暴 as a ナリ活用形容動詞", () => {
  it("reads にはか with the 連用形 に where the parser tags it an adverb", () => {
    const sentence = sentenceOf([
      makeToken({ id: 1, text: "暴", lemma: "暴", pos: "ADV", xpos: "v,動詞,描写,態度", morph: "Degree=Pos", dep: "mod", head: 2 }),
      makeToken({ id: 2, text: "癢", lemma: "癢", pos: "NOUN", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 0 }),
    ]);
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("にはか");
    expect(out.okurigana).toBe("に");
    expect(out.conjClass).toBe("nari-keiyoudoushi");
    expect(out.beatsLexicon).toBe(true);
  });

  it("carries the paradigm in the lexicon, so a VERB-tagged 暴 inflects", () => {
    expect(VERB_LEXICON["暴"]).toMatchObject({ conjClass: "nari-keiyoudoushi", reading: "にはか" });
  });
});

describe("哇 as the verb 吐く", () => {
  it("reads は + く, 四段カ行, with the class derived from the ending", () => {
    const sentence = somethingCameOut();
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("は");
    expect(out.okurigana).toBe("く");
    expect(out.conjClass).toBe("yodan-ka");
  });

  it("keeps kanjidic's own かひ/けい in the menu", () => {
    const out = candidateReadings(kanjidic, "哇", "VERB").map((c) => c.reading);
    expect(out).toContain("は");
  });
});

/** 貯ふ, 瘦す, 適く — three characters whose kanbun word is not the one
 * KANJIDIC2's kun list leads with, or not one it lists at all. Each is a
 * `RESIDUAL` entry in `verbLexicon.ts`, which is the table that holds a
 * *reading and a paradigm together*: the other two tables can hold one or the
 * other and neither can hold both. */
describe("RESIDUAL senses the kun list does not lead with", () => {
  it("reads 貯 たくは + ふ, ハ行下二段, not the た + む kanjidic leads with", () => {
    // KANJIDIC2 gives 貯 た.める then たくわ.える, and `pickKun` takes the first
    // dotted reading for a VERB — 貯む, 下二段マ行. The word is 蓄ふ/貯ふ.
    expect(VERB_LEXICON["貯"]).toEqual({ conjClass: "shimo-nidan-ha", reading: "たくは" });
    // Historical, and this is the only place the spelling can come from: no
    // attestation covers 貯's たくわ and the orthographic fold touches neither
    // わ nor は, so the kanjidic path can only ever print the modern たくわ.
    expect(VERB_LEXICON["貯"]?.reading).not.toBe("たくわ");
  });

  it("reaches that sense from a hand-picked たくわ + える, which is modern throughout", () => {
    // The あ-row ending `classicalConjClass` refuses by design (a modern -eる
    // could be ア行, ヤ行, ワ行 or — through ハ行転呼 — ハ行 下二段), so a pick
    // carrying it had no paradigm and stood at the modern 貯える.
    expect(classicalConjClass("える", { lemma: "貯", reading: "たくわ" })).toBeUndefined();
    expect(attestedSenseByModernSpelling("貯", "たくわ", "える")?.conjClass).toBe("shimo-nidan-ha");
    // 終止形 貯ふ, 連用形 貯へ.
    expect(conjugate("shimo-nidan-ha", "shuushi")).toBe("ふ");
    expect(conjugate("shimo-nidan-ha", "renyou")).toBe("へ");
  });

  it("reads 瘦 や + せ, 下二段サ行 — the り came from a mis-divided modern kun", () => {
    // KANJIDIC2 writes 痩 as や.せる and 瘦 as やせ.る, the same word with the
    // dot in a different place. From やせ.る the okurigana is a bare る, which
    // `classicalConjClass` can only read as 四段ラ行 — and 體漸瘦 printed 瘦り,
    // the 連用形 of a verb that does not exist.
    expect(classicalConjClass("る", { lemma: "瘦", reading: "やせ" })).toBe("yodan-ra");
    expect(VERB_LEXICON["瘦"]).toEqual({ conjClass: "shimo-nidan-sa", reading: "や" });
    expect(VERB_LEXICON["痩"]).toEqual({ conjClass: "shimo-nidan-sa", reading: "や" });
    expect(conjugate("shimo-nidan-sa", "renyou")).toBe("せ");
  });

  it("reads 適 ゆ + く, 四段カ行, with かなふ kept behind it", () => {
    expect(VERB_LEXICON["適"]).toEqual({ conjClass: "yodan-ka", reading: "ゆ" });
    // RESIDUAL is prepended, never substituted: the derived 適ふ is still there
    // for a reader who picks かな, which is what the live tree's own 適 does.
    expect(LEXICON_SENSES["適"]?.map((s) => s.reading)).toEqual(["ゆ", "かな", "てき"]);
    expect(attestedSenseByModernSpelling("適", "かな", "う")?.conjClass).toBe("yodan-ha");
  });

  it("keeps ゆ.く out of SUPPLEMENTARY_KUN, where it would undo itself", () => {
    // A second *dotted* kun sends a VERB through `pickByTransitivity`, which
    // answers かな.う for a 適 with no object and reports the choice as the
    // syntax's — setting `beatsLexicon` and standing the entry above down. The
    // entry stays out of that table for that reason, and the cost it used to
    // carry — the menu offering テキ and かなフ but not ゆク, so the reading on
    // the page was not one of its own entries — is paid off elsewhere:
    // `curatedCandidates` offers the lexicon's own senses, so ゆク is in the
    // menu without being a candidate `pickKun` can choose. たまたま beside it
    // is 適's `overrides.json` entry, the ADV sense.
    const menu = candidateReadings(kanjidic, "適", "VERB", undefined, jmdict).map(
      (c) => c.reading + (c.okurigana ?? ""),
    );
    expect(menu).toEqual(["てき", "かなふ", "たまたま", "ゆく"]);
  });
});

/** 益 and 或 — two `overrides.json` entries, and two different reasons the
 * table is the right one for them. */
describe("益 and 或", () => {
  it("reads 益 ますます on every adverbial relation, not only mod", () => {
    expect(findOverride("益", "ADV", "mod")?.reading).toBe("ますます");
    // 適以益貧 hangs 益 off the preceding clause as parataxis; with mod alone
    // the entry did not match and 益 fell to KANJIDIC2's ま.す — 益すて.
    expect(findOverride("益", "ADV", "parataxis")?.reading).toBe("ますます");
    // What the dep is really excluding stays excluded: the 益 of the compound
    // 損益 is ADV too, but comp:obj.
    expect(findOverride("益", "ADV", "comp:obj")).toBeNull();
    expect(findOverride("益", "VERB", "ROOT")).toBeNull();
  });

  it("reads a PRON 或 as あ + るひと, split across the two slots", () => {
    const sentence = sentenceOf([
      makeToken({ id: 1, text: "或", lemma: "或", pos: "PRON", xpos: "n,代名詞,人称,起格", morph: "PronType=Prs", dep: "subj", head: 2 }),
      makeToken({ id: 2, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "root", head: 0 }),
    ]);
    const out = resolve(sentence.tokens[0], sentence);
    expect(out.reading).toBe("あ");
    expect(out.okurigana).toBe("るひと");
    // A PRON is the one POS whose override reading takes the furigana slot, so
    // the split reaches the page: あ over the character, ルヒト beside it.
    expect(out.spellOutInProse).toBe(true);
  });

  it("leaves the disjunctive あるいは for every other use of 或", () => {
    expect(findOverride("或", "ADV", "mod")?.reading).toBe("あるいは");
    expect(findOverride("或", "ADV", "mod")?.okurigana).toBeUndefined();
  });
});
