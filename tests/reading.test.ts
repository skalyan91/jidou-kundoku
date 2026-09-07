import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { findOverride } from "../src/reading/overridesLookup.ts";
import {
  candidateReadings,
  dictionaryRetainedAdverbOkurigana,
  type KanjidicIndex,
  lookupKanji,
  retainedAdverbOkurigana,
  seriesAmbiguousReading,
} from "../src/reading/kanjidicLookup.ts";
import {
  attestedClassicalParadigm,
  findCompoundSpans,
  isModernIchidanLemma,
  type JmdictIndex,
  lookupLemma,
} from "../src/reading/jmdictLookup.ts";
import {
  classicalConjClass,
  KANJI_RETAINED_ADVERBS,
  kunWordClass,
  retainedAdverbApplies,
  retainedAdverbParts,
  splitKunWordClass,
} from "../src/reading/classicalEnding.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { attestedSenseByModernSpelling, LEXICON_SENSES, VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { createReadingResolver, unresolvedLog } from "../src/reading/readingResolver.ts";
import { compoundFurigana } from "../src/reading/compoundFurigana.ts";
import { chosenReadingParts, setChosenReading } from "../src/reading/chosenReading.ts";
import { caseParticleFor } from "../src/kakikudashi/conjugationContext.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");

function loadRealIndex<T>(filename: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, filename), "utf-8")) as T;
}

const kanjidic = loadRealIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadRealIndex<JmdictIndex>("jmdict-index.json");

function makeToken(overrides: Partial<Token>): Token {
  return { id: 0, text: "", lemma: "", pos: "", xpos: "", dep: "", head: 0, ...overrides };
}

describe("findOverride (specificity ordering)", () => {
  it("prefers a char+dep+pos match over a char-only fallback", () => {
    const specific = findOverride("之", "PRON", "comp:obj");
    expect(specific?.reading).toBe("これ");

    // `subj` now names an entry of its own — the subject genitive, 人**の**己を
    // 知らざる — so the char-only fallback is asked for on a relation no entry
    // claims.
    expect(findOverride("之", "NOUN", "subj")?.reading).toBe("の");
    const fallback = findOverride("之", "NOUN", "parataxis");
    expect(fallback?.reading).toBe("これ"); // char-only fallback entry
  });

  it("excludes an entry whose contextDep doesn't match, even if contextPos matches nothing better", () => {
    // 爲 has a contextPos=[VERB] + contextDep=[comp:pred,ROOT] entry (たり), an
    // ADP entry (ため) and a bare fallback (なす). A VERB 爲 on `comp:obj`
    // matches the first entry's POS and not its dep, and a context-*restricted*
    // entry is excluded outright rather than merely outranked — so the fallback
    // answers, not たり.
    expect(findOverride("爲", "VERB", "comp:pred")?.reading).toBe("たり");
    expect(findOverride("爲", "VERB", "comp:obj")?.reading).toBe("なす");
  });

  it("has no answer for a nominal 使, the character's only entry being the causative", () => {
    // This used to assert つか — `overrides.json` held a second 使 entry (つか +
    // ふ, "to use, to employ") with no context at all, so it answered for a NOUN
    // as readily as for a verb. Every entry in that table is written out in kana
    // with the kanji dropped, and 漢使 came out 漢の**つかふ**: a finite verb where
    // "an envoy" belongs. The entry is gone and the noun's reading is a
    // supplementary kun instead (使 つかひ — see `SUPPLEMENTARY_KUN` in
    // `kanjidicLookup.ts`, which is the only table that can give a content word
    // a default and leave its character on the page).
    expect(findOverride("使", "NOUN", "subj")).toBeNull();
    expect(findOverride("使", "VERB", "ROOT")?.reading).toBe("しむ");
  });

  it("returns null for a character with no override entry", () => {
    expect(findOverride("犬")).toBeNull();
  });
});

/** A function-word gloss on a character that is also an ordinary content
 * word has to stand down where the content word is what's being used, or it
 * fires on every occurrence of the character — 獨's ひとり turning 獨酌 into
 * ひとり酌 is the case that surfaced this. Each entry below was conditioned
 * on the POS (and, where the POS alone doesn't separate them, the relation)
 * that the live lzh_sud_kyoto parse actually assigns to the two senses; the
 * sentences named in each test are the ones that evidence was read off.
 *
 * Both directions are asserted throughout. A condition that only silenced
 * the content use would be just as wrong as no condition at all if it also
 * silenced the function word it exists to gloss. */
describe("findOverride (function word vs. content word)", () => {
  it.each([
    // char, function-word (pos, dep), content-word (pos, dep), gloss reading
    ["抑", ["ADV", "mod"], ["VERB", "ROOT"], "そもそも"], // 抑亦可以為次矣 / 抑其心
    ["嘗", ["ADV", "mod"], ["VERB", "ROOT"], "かつて"], // 吾嘗終日不食 / 嘗其肉而知其味
    // あら, not あらず: the entry states an okurigana of its own (ず), the
    // same split 遂/則 below are already asserted on. That is what puts
    // 非[あら|ズ] on the page — see the entry's own gloss.
    ["非", ["ADV", "mod"], ["NOUN", "conj:coord"], "あら"], // 人非生而知之者 / 是非之心
    ["遂", ["ADV", "mod"], ["VERB", "ROOT"], "つひ"], // 遂去不復與言 / 其事遂矣
    ["惟", ["ADV", "mod"], ["VERB", "mod"], "ただ"], // 惟仁者能好人 / 思惟其事
    ["則", ["ADV", "mod"], ["NOUN", "comp:obj"], "すなは"], // 學而不思則罔 / 有物有則
    ["罔", ["ADV", "mod"], ["VERB", "ROOT"], "なし"], // 罔有不服 / 是罔民也
    ["竟", ["ADV", "mod"], ["VERB", "ROOT"], "つひ"], // 竟不能就 / 竟其業
    ["蓋", ["PART", "discourse"], ["NOUN", "subj"], "けだし"], // 蓋有之矣 / 車蓋
    ["由", ["ADV", "mod"], ["NOUN", "subj"], "なほ"], // 王由足用為善 / 由 as the noun よし
  ])("%s glosses the function word but not the content word", (char, fn, content, reading) => {
    expect(findOverride(char, fn[0], fn[1])?.reading).toBe(reading);
    expect(findOverride(char, content[0], content[1])).toBeNull();
  });

  it("由 stands down for the verb 'to follow' as well as the adposition", () => {
    // 必由之 / 言不由衷 — the 猶-loan なほ is the rarer of 由's senses, so it
    // gives way to both of the commoner ones rather than only to the ADP.
    expect(findOverride("由", "VERB", "ROOT")).toBeNull();
    // …and standing down is not the same as leaving the adposition unglossed.
    // 由此觀之's 由 is より, which KANJIDIC2 does not list for the character at
    // all (よし and よ.る are its whole kun list), so the ADP now has an entry of
    // its own rather than falling through to the noun よし.
    expect(findOverride("由", "ADP", "mod")?.reading).toBe("より");
  });

  it("抑 keeps its gloss when it opens the sentence outright, not only before a clause", () => {
    // 抑王興甲兵 — tagged ADV/ROOT rather than ADV/mod, which is why 抑 is
    // conditioned on the POS alone and carries no contextDep.
    expect(findOverride("抑", "ADV", "ROOT")?.reading).toBe("そもそも");
  });

  it.each([
    // 益/悉 need the relation as well as the POS: this parser tags their
    // content sense ADV as readily as VERB, so ADV alone would not separate
    // them. 損益 has 益 as ADV/comp:obj; 書不能悉意 has 悉 as ADV/comp:aux.
    ["益", "comp:obj", "ますます"], // 如水益深, 秦益輕趙 / 損益可知也
    ["悉", "comp:aux", "ことごとく"], // 悉如外人, 悉知其情 / 書不能悉意
  ])("%s is conditioned on the relation as well as the POS", (char, contentDep, reading) => {
    expect(findOverride(char, "ADV", "mod")?.reading).toBe(reading);
    expect(findOverride(char, "ADV", contentDep)).toBeNull();
    expect(findOverride(char, "VERB", "ROOT")).toBeNull();
  });
});

describe("kanjidicLookup against the real built index", () => {
  it("resolves 之 with kun'yomi これ available", () => {
    const entry = kanjidic["之"];
    expect(entry).toBeDefined();
    expect(entry.kun).toContain("これ");
  });

  it("prefers kun'yomi for a plain noun/verb", () => {
    const hit = lookupKanji(kanjidic, "有", "VERB");
    expect(hit).not.toBeNull();
    expect(hit!.reading).toBe("あ");
    expect(hit!.okurigana).toBe("る");
  });

  it("prefers on'yomi for a proper noun, converted to hiragana (every furigana reading in this app is hiragana)", () => {
    const hit = lookupKanji(kanjidic, "有", "PROPN");
    expect(hit).not.toBeNull();
    expect(hit!.reading).not.toMatch(/[ァ-ヶー]/);
    expect(hit!.reading).toMatch(/[ぁ-ゖ]/);
  });

  it("returns null for a character absent from the index", () => {
    expect(lookupKanji(kanjidic, "", "NOUN")).toBeNull();
  });
});

describe("jmdictLookup against the real built index", () => {
  it("resolves a real multi-character headword", () => {
    const hit = lookupLemma(jmdict, "君子");
    expect(hit).not.toBeNull();
    expect(hit!.reading).toBe("くんし");
  });

  it("returns null for a lemma not present as a headword", () => {
    expect(lookupLemma(jmdict, "不亦")).toBeNull();
  });

  it("findCompoundSpans groups a flat/compound run and leaves singletons out", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "不", dep: "mod", head: 2 }),
        makeToken({ id: 1, text: "亦", dep: "mod", head: 2 }),
        makeToken({ id: 2, text: "君", dep: "ROOT", head: 2 }),
        makeToken({ id: 3, text: "子", dep: "flat", head: 2 }),
      ],
    };
    const spans = findCompoundSpans(sentence);
    expect(spans).toHaveLength(1);
    expect(spans[0].tokenIds).toEqual([2, 3]);
    expect(spans[0].text).toBe("君子");
  });

  it("findCompoundSpans never groups tokens that share no compound/flat relation at all, even when adjacent", () => {
    // 遠/方 share no dependency edge in this treebank's real parses (see
    // spanCarrier.test.ts) — compound detection is driven only by relations
    // the parser assigns, never guessed from a dictionary.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "遠", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "方", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans groups a plain mod attributive modifier directly attached to its noun head", () => {
    // Adjective-noun modification keeps the resulting noun phrase intact,
    // same as a real compound — a descriptive word (often tagged VERB/ADJ
    // in this treebank, not a dedicated adjective class) modifying a noun
    // head via plain `mod` is part of that NP.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "遠", pos: "VERB", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "方", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    const spans = findCompoundSpans(sentence);
    expect(spans).toHaveLength(1);
    expect(spans[0].tokenIds).toEqual([0, 1]);
    expect(spans[0].text).toBe("遠方");
  });

  it("findCompoundSpans excludes mod@tmod/mod@lmod from NP grouping — those are clause-level adverbials, not NP-internal", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "時", pos: "NOUN", dep: "mod@tmod", head: 1 }),
        makeToken({ id: 1, text: "習", pos: "VERB", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans excludes an adverb attached to a nominal *predicate* root, even though the head is a noun", () => {
    // Real bug this regression-tests: caught live with 亦君子乎 ("is it not
    // ALSO a gentleman?") — 亦 (ADV) is a clause-level adverb over the whole
    // predicate, landing as `mod` of the nominal root 君子 only because 君子
    // *is* the predicate, not because 亦 attributively modifies the noun
    // phrase. Grouping them wrongly fused "亦君子" into one display unit.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "亦", pos: "ADV", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "君子", pos: "NOUN", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans excludes a plain mod whose head isn't nominal (e.g. an adverb modifying a verb)", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "亦", pos: "ADV", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "說", pos: "VERB", dep: "ROOT", head: 1 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans excludes a non-adjacent mod edge even to a noun head — display fusion needs contiguous tokens", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "遠", pos: "VERB", dep: "mod", head: 2 }),
        makeToken({ id: 1, text: "之", pos: "PRON", dep: "comp:obj", head: 2 }),
        makeToken({ id: 2, text: "方", pos: "NOUN", dep: "ROOT", head: 2 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans never fuses a distributive 毎, which is read after its head rather than beside it", () => {
    // Live parse of 子入太廟、毎事問: 毎 is tagged VERB/Degree=Pos with the
    // adjacent NOUN 事 as its head, which is exactly the attributive-mod
    // shape this function fuses — and the group then went through JMdict as
    // a jukugo, reading まいぢ instead of 事ごとに. `lemma` is 每 where
    // `text` is 毎, which is what the shared predicate keys on.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "毎", lemma: "每", pos: "ADJ", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Part" }),
        makeToken({ id: 1, text: "事", lemma: "事", pos: "NOUN", dep: "subj", head: 2 }),
        makeToken({ id: 2, text: "問", lemma: "問", pos: "VERB", dep: "ROOT", head: 2 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans leaves a state name compounded onto a common noun unfused — 秦王 is 秦ノ王", () => {
    // Verified against live parses: 秦/楚/齊/趙 over 王 all come back
    // `compound` with NameType=Nat, and fusing them left no place for the
    // genitive の the generator wants between the two.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "秦", pos: "PROPN", dep: "compound", head: 1, morph: "Case=Loc|NameType=Nat" }),
        makeToken({ id: 1, text: "王", pos: "NOUN", dep: "subj", head: 2 }),
        makeToken({ id: 2, text: "使", pos: "VERB", dep: "ROOT", head: 2 }),
      ],
    };
    expect(findCompoundSpans(sentence)).toHaveLength(0);
  });

  it("findCompoundSpans still fuses a personal-name element, which the NameType test is meant to spare", () => {
    // 黃帝 (Giv), 惠王 (Prs) and 安陵君 (Geo) are each one name and stay
    // fused — only Nat, a state, is the genitive case.
    for (const nameType of ["Giv", "Prs", "Geo"]) {
      const sentence: Sentence = {
        tokens: [
          makeToken({ id: 0, text: "黃", pos: "PROPN", dep: "compound", head: 1, morph: `NameType=${nameType}` }),
          makeToken({ id: 1, text: "帝", pos: "NOUN", dep: "ROOT", head: 1 }),
        ],
      };
      expect(findCompoundSpans(sentence)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Context-conditioned reading selection: the four rules that read the
// sentence rather than the character. Each is asserted against the real
// shipped indices and a token shape taken from a live parse, since what
// makes them work at all is the specific dep/pos/morph the parser assigns.
// ---------------------------------------------------------------------------

describe("transitive vs. intransitive kun'yomi (comp:obj decides)", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  /** One verb, with or without an object — the live shape of 王遷都 vs 都遷. */
  const verb = (text: string, withObject: boolean) => {
    const tokens = [makeToken({ id: 0, text, lemma: text, pos: "VERB", dep: "ROOT", head: 0 })];
    if (withObject) tokens.push(makeToken({ id: 1, text: "之", lemma: "之", pos: "PRON", dep: "comp:obj", head: 0 }));
    const sentence: Sentence = { tokens };
    return resolve(tokens[0], sentence);
  };

  it("reads 遷 as 遷す with an object and 遷る without one", () => {
    expect(verb("遷", true)).toMatchObject({ reading: "うつ", okurigana: "す" });
    expect(verb("遷", false)).toMatchObject({ reading: "うつ", okurigana: "る" });
  });

  it("reads 別 as 別く with an object and 別る without one", () => {
    // 別ける is 下二段カ行 in classical (別く), which is why the ending comes
    // back as く rather than kanjidic's modern ける.
    expect(verb("別", true)).toMatchObject({ reading: "わ", okurigana: "く" });
    expect(verb("別", false)).toMatchObject({ reading: "わか", okurigana: "る" });
  });

  it("marks the reading it selected as outranking the per-lemma verb lexicon", () => {
    expect(verb("遷", true).beatsLexicon).toBe(true);
    // Also where the answer agrees with the entry's own ordering: the flag
    // says the syntax decided, not that it disagreed. 肥 with no object
    // resolves to こ.える, kanjidic's first dotted reading, and without the
    // flag `VERB_LEXICON`'s transitive こ+やす overruled it — 馬肥 read 馬肥やす.
    expect(verb("別", false).beatsLexicon).toBe(true);
    expect(verb("肥", false)).toMatchObject({ reading: "こ", beatsLexicon: true });
    // And nothing where transitivity separates no candidate: 去's さ.る and
    // い.ぬ are both intransitive, so the lexicon's 去ぬ stands.
    expect(verb("去", false).beatsLexicon).toBeUndefined();
  });

  it("leaves a character whose only inflecting reading is one word alone", () => {
    // 學 has just まな.ぶ, transitive or not — there is nothing to choose.
    expect(verb("學", true)).toMatchObject({ reading: "まな", okurigana: "ぶ" });
    expect(verb("學", false)).toMatchObject({ reading: "まな", okurigana: "ぶ" });
  });

  it("puts the modern 一段 ending it reaches back into classical 二段 shape", () => {
    // 別ける is 下二段カ行 in classical, so the ending is く and not
    // kanjidic's modern ける — and 顧みる, whose み row is deliberately not
    // converted, keeps its る because 顧みる is 上一段 in classical too.
    expect(verb("別", true).okurigana).toBe("く");
    expect(verb("顧", false).okurigana).toBe("みる");
  });

  it("takes 開 as ひらく either way, since JMdict calls that one verb both", () => {
    expect(verb("開", true)).toMatchObject({ reading: "ひら", okurigana: "く" });
    expect(verb("開", false)).toMatchObject({ reading: "ひら", okurigana: "く" });
  });

  it("still answers for a stative predicate that has an object — an adjective governs none", () => {
    // The parser tags 現 Degree=Pos in both 君子現其德 and 其德現; only the
    // object separates 現す from 現る, so Degree=Pos alone must not
    // suppress the question. The reading is あらは, not kanjidic's modern
    // あらわ: the kun'yomi pass in `build-historical-kana-index.mjs` attests
    // that stem out of 現す/現れる, which is what this whole panel is for —
    // the okurigana す is what the transitivity question decided, and it is
    // unchanged.
    const tokens = [
      makeToken({ id: 0, text: "現", lemma: "現", pos: "ADJ", dep: "ROOT", head: 0, morph: "Degree=Pos" }),
      makeToken({ id: 1, text: "德", lemma: "德", pos: "NOUN", dep: "comp:obj", head: 0 }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "あらは", okurigana: "す" });
  });

  it("does not put the question to a stative predicate with no object", () => {
    // 深 (VERB, Degree=Pos) in 竹林深し is the adjective 深し, not the
    // intransitive verb 深まる the transitivity check would otherwise reach.
    const tokens = [makeToken({ id: 0, text: "深", lemma: "深", pos: "ADJ", dep: "ROOT", head: 0, morph: "Degree=Pos" })];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ okurigana: "し" });
  });

  // -------------------------------------------------------------------------
  // The conjugation class travelling with the reading. `beatsLexicon` stands
  // VERB_LEXICON down, and the entry it stands down was carrying a class as
  // well as a reading — without a replacement the panels can only print the
  // citation form (廟を立つて, where 下二段 立て is wanted). Asserted through
  // the resolver rather than against the derivation directly, since what has
  // to be right is the class attached to the reading the sentence chose.
  // -------------------------------------------------------------------------

  it("derives 下二段 from an e-row -eru okurigana (立てる -> 下二段タ行)", () => {
    // The transitive 立: kanjidic's て+る is the modern reflex of 立つ 下二段
    // タ行, whose renyoukei 立て is what 廟を立てて needs. The intransitive
    // one shares the 終止形 立つ and is 四段, so the ending alone cannot tell
    // the two apart — only the class can.
    expect(verb("立", true)).toMatchObject({ okurigana: "つ", conjClass: "shimo-nidan-ta" });
    expect(verb("別", true)).toMatchObject({ okurigana: "く", conjClass: "shimo-nidan-ka" });
    expect(verb("破", false)).toMatchObject({ okurigana: "る", conjClass: "shimo-nidan-ra" });
  });

  it("derives 上二段 from an i-row -iru okurigana (亡びる -> 上二段バ行)", () => {
    // 亡 has ほろ.ぼす (transitive) and ほろ.びる (intransitive); with no
    // object the check moves onto the second, whose modern び+る is the
    // reflex of 亡ぶ 上二段バ行 — mizen and renyou 亡び, not the 亡ば a 四段
    // reading of the same 終止形 would give.
    expect(verb("亡", false)).toMatchObject({ okurigana: "ぶ", conjClass: "kami-nidan-ba" });
  });

  it("derives 四段 from a one-kana u-row okurigana (遷す -> 四段サ行)", () => {
    expect(verb("遷", true)).toMatchObject({ okurigana: "す", conjClass: "yodan-sa" });
  });

  it("takes 上一段 from the lexicon where a bare る can only guess 四段ラ行", () => {
    // 見 with an object resolves to み+る, and a one-kana る is 四段ラ行 by
    // the derivation's own default — which is not a wrong ending on the right
    // verb but a different verb altogether: 連用形 見り, where 上一段's is the
    // bare stem み (見て). Wiktionary attests 見る 上一段 for this very
    // reading, and it is the one sense of 見's three whose modern spelling is
    // みる — 見す is みす and 見ゆ is みえる.
    expect(verb("見", true)).toMatchObject({ reading: "み", okurigana: "る", conjClass: "kami-ichidan" });
    // The other 上一段 verbs the transitivity check reaches, all with the same
    // shape and the same fix.
    expect(verb("着", true).conjClass).toBe("kami-ichidan");
    expect(verb("煮", true).conjClass).toBe("kami-ichidan");
    expect(verb("干", false).conjClass).toBe("kami-ichidan");
  });

  it("leaves a 四段 whose 終止形 an attested 二段 sense shares exactly as it was", () => {
    // Why the lexicon is matched on the *modern* spelling and not on the
    // classical 終止形. 空 read あ has one attested sense, 下二段カ行 空く —
    // whose 終止形 is く, the very ending 四段カ行 空く has. A 終止形 match
    // would therefore have read 室空 as the transitive 空ける; the modern
    // spelling separates them, because the 二段 families gained a る (空ける)
    // and 四段 did not (空く).
    expect(verb("空", false)).toMatchObject({ okurigana: "く", conjClass: "yodan-ka" });
    // The same collision with both halves attested: 破 has 四段ラ行 破る and
    // 下二段ラ行 破る, and an object picks the transitive 四段 one.
    expect(verb("破", true).conjClass).toBe("yodan-ra");
  });

  it("reads a verb with no kun'yomi at all as サ変 on'yomi", () => {
    // KANJIDIC2 lists 封/謁/療 no kun'yomi whatever, so `pickKun` has nothing
    // to choose from and the lookup falls through to the on'yomi. A verb read
    // on'yomi is read サ変 in kundoku — the same supplement `onyomiPairReading`
    // makes for 大破 and `chosenOkurigana` for a hand-picked on'yomi — and
    // without it the reading reached the page as a bare stem with no ending.
    expect(verb("封", true)).toMatchObject({
      reading: "ふう",
      okurigana: "す",
      conjClass: "sa-hen",
      beatsLexicon: true,
    });
    expect(verb("謁", true)).toMatchObject({ okurigana: "す", conjClass: "sa-hen" });
  });

  it("supplies no す where the on'yomi is not a verb's", () => {
    // A nominal read on'yomi takes no ending at all, and an adjectival token
    // wants なり rather than す — 佳 in 佳釀 is a kun-less character this
    // parser tags Degree=Pos, and 佳す is not a word. Both exclusions are the
    // ones `chosenOkurigana` already makes for a hand-picked on'yomi.
    const noun = makeToken({ id: 0, text: "封", lemma: "封", pos: "NOUN", dep: "ROOT", head: 0 });
    expect(resolve(noun, { tokens: [noun] }).okurigana).toBeUndefined();

    const adjectival = makeToken({ id: 0, text: "佳", lemma: "佳", pos: "ADJ", dep: "ROOT", head: 0, morph: "Degree=Pos" });
    expect(resolve(adjectival, { tokens: [adjectival] }).okurigana).toBeUndefined();
  });

  it("claims nothing where two attested senses share one modern spelling", () => {
    // 射 read い is attested 上一段 *and* 四段ラ行, and both write 射る today,
    // so the evidence does not identify the word. The derivation's own answer
    // stands rather than one of the two being picked at random — the same
    // abstention `attestedSense` makes on a tie.
    expect(verb("射", true).conjClass).toBe("yodan-ra");
  });

  it("takes the paradigm a dictionary attests where the row tables exclude the shape", () => {
    // 見える could be ア行/ヤ行/ワ行下二段 for all its bare え says, which is
    // why `classicalVerbEnding` refuses to guess — and JMdict does not have to
    // guess, because it holds the classical word itself: 見ゆ, listed as
    // 下二段ヤ行 outright. See `attestedClassicalParadigm`. Before that route
    // existed this reading reached the page as the modern 見える with no class
    // at all.
    expect(verb("見", false)).toMatchObject({ okurigana: "ゆ", conjClass: "shimo-nidan-ya", beatsLexicon: true });
    const tokens = [
      makeToken({ id: 0, text: "起", lemma: "起", pos: "VERB", dep: "ROOT", head: 0 }),
      makeToken({ id: 1, text: "兵", lemma: "兵", pos: "NOUN", dep: "comp:obj", head: 0 }),
    ];
    // 起こす is not a -eru/-iru verb at all, and no dictionary entry answers
    // for it either: it keeps the behaviour it had before any of this, which
    // is the right outcome for a word whose paradigm nothing states.
    expect(resolve(tokens[0], { tokens })).toMatchObject({ okurigana: "こす", beatsLexicon: true });
    expect(resolve(tokens[0], { tokens }).conjClass).toBeUndefined();
  });

  it("attaches no class to a reading the syntax never moved", () => {
    // Nothing stood the lexicon down, so its own class still applies and a
    // second one travelling alongside would be a competing answer.
    expect(verb("去", false).beatsLexicon).toBeUndefined();
    expect(verb("去", false).conjClass).toBeUndefined();
    expect(verb("學", true).conjClass).toBeUndefined();
  });
});

describe("on'yomi in adverb+verb and numeral+noun contexts", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  /** The live shape of 大破楚軍 / 三人行: modifier `mod`, head immediately
   * after it. */
  const pair = (modText: string, modPos: string, headText: string, headPos: string): [string, string] => {
    const tokens = [
      makeToken({ id: 0, text: modText, lemma: modText, pos: modPos, dep: "mod", head: 1 }),
      makeToken({ id: 1, text: headText, lemma: headText, pos: headPos, dep: "ROOT", head: 1 }),
    ];
    const sentence: Sentence = { tokens };
    return [resolve(tokens[0], sentence).reading, resolve(tokens[1], sentence).reading];
  };

  it("reads a numeral and the noun it counts on'yomi (三人 -> サンニン)", () => {
    expect(pair("三", "NUM", "人", "NOUN")).toEqual(["さん", "にん"]);
  });

  it("reads an adverb and the verb directly after it on'yomi (大破 -> タイハ)", () => {
    // タイ, not 大's first on'yomi ダイ — 大破's own JMdict reading たいは is
    // what says which one this word takes.
    expect(pair("大", "ADV", "破", "VERB")).toEqual(["たい", "は"]);
  });

  it("gives the on'yomi verb its サ変 ending, since a bare stem is no verb", () => {
    const tokens = [
      makeToken({ id: 0, text: "大", lemma: "大", pos: "ADV", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "破", lemma: "破", pos: "VERB", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[1], { tokens })).toMatchObject({ okurigana: "す", beatsLexicon: true });
  });

  it("lets no morph-driven ending onto the modifier half of the pair", () => {
    // This parser tags the 大 of 大破 `VerbForm=Conv` — true of 大 read
    // おほいに, false of the たい that is half of たいはす — and that morph put
    // a converb て on it downstream: 大破敵軍 came out 大て敵軍を破す. The
    // modifier is half of one word, so it takes no ending of its own; the
    // pair's ending is the サ変 す on the head, asserted above.
    const tokens = [
      makeToken({ id: 0, text: "大", lemma: "大", pos: "ADV", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Conv" }),
      makeToken({ id: 1, text: "破", lemma: "破", pos: "VERB", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "たい", endingComplete: true });
    expect(resolve(tokens[0], { tokens }).okurigana).toBeUndefined();
    // The head keeps the ordinary ending machinery, so a negation or copula
    // over 大破す can still attach.
    expect(resolve(tokens[1], { tokens }).endingComplete).toBeUndefined();
  });

  it("leaves an adverb+verb pair that is not one word alone (必問 is 必ず問ふ)", () => {
    const [must, ask] = pair("必", "ADV", "問", "VERB");
    expect(must).not.toBe("ひつ");
    expect(ask).not.toBe("もん");
  });

  it("refuses a JMdict pair whose reading is kun'yomi, which makes it two words", () => {
    // 大喜 is listed, as おおよろこび — 大いに喜ぶ, not a Sino-Japanese
    // compound. The all-on'yomi check is what tells it from 大破.
    expect(pair("大", "ADV", "喜", "VERB")[0]).not.toBe("たい");
  });

  it("refuses a negation, which is read as a postposed ず rather than compounded", () => {
    // 不知 *is* a JMdict headword (ふち), so only the Polarity=Neg check
    // keeps 不 out of this rule.
    const tokens = [
      makeToken({ id: 0, text: "不", lemma: "不", pos: "ADV", dep: "mod", head: 1, morph: "Polarity=Neg" }),
      makeToken({ id: 1, text: "知", lemma: "知", pos: "VERB", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[1], { tokens }).reading).not.toBe("ち");
  });

  it("requires the modifier to stand immediately before its head", () => {
    // Same relation, one token further away — a `mod` edge reaching across
    // an intervening token is not a compound.
    const tokens = [
      makeToken({ id: 0, text: "三", lemma: "三", pos: "NUM", dep: "mod", head: 2 }),
      makeToken({ id: 1, text: "之", lemma: "之", pos: "PRON", dep: "comp:obj", head: 2 }),
      makeToken({ id: 2, text: "人", lemma: "人", pos: "NOUN", dep: "ROOT", head: 2 }),
    ];
    expect(resolve(tokens[2], { tokens }).reading).toBe("ひと");
  });

  it("writes the on'yomi it picks in historical kana, like every other on'yomi on the page", () => {
    // 三十 is one NUM token in the live parse of 三十而立; じゅう -> じふ is
    // the same index the rest of the app goes through.
    expect(pair("三十", "NUM", "人", "NOUN")[0]).toBe("さんじふ");
  });

  // -------------------------------------------------------------------------
  // Any modifier, not only an adverb. The rule is that a verb takes kun'yomi
  // unless something stands immediately before it, and this treebank tags a
  // descriptive modifier VERB (佳 in 佳釀, 良 in 良醞, 半 in 半種 — all `mod`,
  // all Degree=Pos) rather than ADV, so an ADV-only condition could never see
  // them. The dictionary gate is unchanged and is what carries the weight.
  // -------------------------------------------------------------------------

  it("reads a VERB-tagged modifier and its verb on'yomi where the pair is one word", () => {
    // 佳醸 かじょう is a JMdict headword read on'yomi throughout. Before, 佳
    // reached the page as a bare か with no ending beside 釀 read かもす — two
    // words where the text has one.
    expect(pair("佳", "VERB", "釀", "VERB")).toEqual(["か", "ぢやう"]);
  });

  it("still refuses a modifier+verb pair no dictionary lists as a word", () => {
    // 良醞 and 半種 are not words, and the gate that keeps 則利 out keeps them
    // out too — widening the modifier's POS widened what is *asked*, not what
    // is accepted.
    expect(pair("良", "VERB", "醞", "VERB")[1]).not.toBe("うん");
    expect(pair("半", "VERB", "種", "VERB")[1]).not.toBe("しゆ");
  });

  it("puts the pair's ending on its head and nothing on its modifier", () => {
    // The ending belongs to the pair, and the head carries it. Asked of the
    // head's POS rather than each token's own: with an ADV modifier the two
    // came to the same thing, and the moment a VERB could be the modifier
    // 佳釀 printed 佳す釀す — サ変 written twice over one word.
    const tokens = [
      makeToken({ id: 0, text: "佳", lemma: "佳", pos: "ADJ", dep: "mod", head: 1, morph: "Degree=Pos" }),
      makeToken({ id: 1, text: "釀", lemma: "釀", pos: "VERB", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "か", endingComplete: true });
    expect(resolve(tokens[0], { tokens }).okurigana).toBeUndefined();
    expect(resolve(tokens[1], { tokens })).toMatchObject({ okurigana: "す", conjClass: "sa-hen" });
  });

  // -------------------------------------------------------------------------
  // Pairs JMdict lists that kanbun nonetheless reads kun throughout. Both
  // rows below are live in 酒蟲, both parse as the shape this rule claims, and
  // both were read as Sino-Japanese words before `curatedInRole` stood the
  // rule down for them.
  // -------------------------------------------------------------------------

  it("reads 果然 はたして然り, not the かぜん JMdict lists", () => {
    // The live rows: 果 comes back VERB/mod with ExtPos=VERB, 然 VERB/ROOT
    // with Degree=Pos. 果然 is a JMdict headword (かぜん, "as was expected")
    // that splits cleanly into two attested on'yomi, so every check the pair
    // rule makes passed and the panels printed 果然す.
    const tokens = [
      makeToken({ id: 0, text: "果", lemma: "果", pos: "VERB", dep: "mod", head: 1, morph: "ExtPos=VERB" }),
      makeToken({ id: 1, text: "然", lemma: "然", pos: "ADJ", dep: "ROOT", head: 1, morph: "Degree=Pos" }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "は", okurigana: "たして", spellOutInProse: false });
    expect(resolve(tokens[1], { tokens })).toMatchObject({ reading: "しかり", source: "override" });
  });

  it("stands down for a conditioned curated entry on either member", () => {
    // 豈飲啄固有數乎: 固 ADV/mod before 有 VERB, and 固有 is JMdict's こゆう.
    // The veto comes from 有's `contextPos: ["VERB"]` entry — the *head's* —
    // and 固 then reaches its own (char-only) entry normally.
    const tokens = [
      makeToken({ id: 0, text: "固", lemma: "固", pos: "ADV", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: "有", lemma: "有", pos: "VERB", dep: "ROOT", head: 1 }),
    ];
    expect(resolve(tokens[0], { tokens }).reading).toBe("もとより");
    expect(resolve(tokens[1], { tokens }).reading).toBe("あり");
  });

  it("is not stood down by a curated entry that names no context", () => {
    // The distinction the veto turns on, and the reason the pair rule sits
    // ahead of `findOverride` at all: 獨's ひとり is the character standing on
    // its own, says nothing about it as half of a word, and must not claim
    // the 獨 of 獨酌 (どくしゃく).
    expect(pair("獨", "ADV", "酌", "VERB")).toEqual(["どく", "しやく"]);
  });
});

describe("a character with no kun'yomi is read on'yomi", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  // A rule the reader settled outright, not an inference from there being
  // nothing else for `lookupKanji` to return. It holds for every part of
  // speech; only what follows the reading differs.

  it("gives a kun-less VERB the on'yomi and サ変 (封して, 謁す)", () => {
    const token = makeToken({ id: 0, text: "封", lemma: "封", pos: "VERB", dep: "ROOT", head: 0 });
    expect(resolve(token, { tokens: [token] })).toMatchObject({
      reading: "ふう",
      okurigana: "す",
      conjClass: "sa-hen",
      beatsLexicon: true,
    });
  });

  it("gives a kun-less nominal the same on'yomi and no ending at all", () => {
    // 累/僧/寸/史 in 酒蟲, all kun-less, all nominal. A noun read on'yomi is a
    // noun: it takes the reading and nothing after it. Nothing in the code
    // branches on this — it is what falling past the VERB condition already
    // does — so the rule is asserted rather than left to be assumed.
    for (const [char, reading] of [["累", "るゐ"], ["僧", "そう"], ["寸", "すん"]] as const) {
      const token = makeToken({ id: 0, text: char, lemma: char, pos: "NOUN", dep: "ROOT", head: 0 });
      const resolved = resolve(token, { tokens: [token] });
      expect(resolved.reading).toBe(reading);
      expect(resolved.okurigana).toBeUndefined();
    }
  });
});

describe("a fused span read on'yomi and standing as a verb", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  /** The live 蠕動如游魚 rows: 蠕 VERB heads the span and hangs off 如, 動
   * VERB is its `flat@vv`; 游 VERB modifies the NOUN 魚, which hangs off 如. */
  const span = (aText: string, aPos: string, aDep: string, bText: string, bPos: string, bDep: string) => {
    const tokens = [
      makeToken({ id: 0, text: aText, lemma: aText, pos: aPos, dep: aDep, head: bDep === "flat@vv" ? 2 : 1 }),
      makeToken({ id: 1, text: bText, lemma: bText, pos: bPos, dep: bDep, head: bDep === "flat@vv" ? 0 : 2 }),
      makeToken({ id: 2, text: "如", lemma: "如", pos: "VERB", dep: "ROOT", head: 2 }),
    ];
    return { tokens, carrier: bDep === "flat@vv" ? tokens[0] : tokens[1] };
  };

  it("reads it サ変, so it is written 蠕動す rather than as two bare characters", () => {
    const { tokens, carrier } = span("蠕", "VERB", "subj", "動", "VERB", "flat@vv");
    expect(resolve(carrier, { tokens })).toMatchObject({
      reading: "ぜん",
      okurigana: "す",
      conjClass: "sa-hen",
      suruCompound: true,
    });
  });

  it("keys on the carrier's POS, not on the tokens being a span", () => {
    // 游魚 ゆうぎょ is a JMdict headword too, and an identically-shaped span
    // read on'yomi throughout — but a plain noun ("fish swimming about in
    // water"), and its carrier is the NOUN 魚. Being fused is not evidence of
    // anything, and being on'yomi is not either: only the carrier's tag says
    // the span is predicating.
    const { tokens, carrier } = span("游", "VERB", "mod", "魚", "NOUN", "comp:obj");
    expect(resolve(carrier, { tokens }).suruCompound).toBeUndefined();
    expect(resolve(carrier, { tokens }).okurigana).toBeUndefined();
  });

  it("claims it for a span no dictionary lists (俯臥, 飲啄)", () => {
    // The reader's rule is that a verb read on'yomi ends in a form of す, and
    // JMdict's `vs` tag was narrower than the rule: 蠕動 is listed while 俯臥
    // and 飲啄 — the same shape, the same register, in the same text — are
    // not, so both came out as two bare characters. The reading is what is
    // keyed on now, and both of these are on'yomi throughout.
    for (const [a, b, reading] of [["俯", "臥", "ふ"], ["飲", "啄", "いん"]] as const) {
      const { tokens, carrier } = span(a, "VERB", "subj", b, "VERB", "flat@vv");
      expect(resolve(carrier, { tokens })).toMatchObject({
        reading,
        okurigana: "す",
        conjClass: "sa-hen",
        suruCompound: true,
      });
    }
  });

  it("refuses a span whose reading is not on'yomi throughout", () => {
    // 手足 is て+あし — JMdict's own reading of the whole word, dividing
    // cleanly across the two characters and kun on both sides. It is two
    // Japanese words, not one Sino-Japanese one, and 手足す is not a form.
    // The same discrimination `onyomiCompound` makes for a modifier+head
    // pair, where it is what tells 大破 from 大喜; over the shipped index it
    // refuses 10,849 of the 58,258 two-kanji headwords (手足, 草木 くさ+き,
    // 花見 はな+み), so the on'yomi condition is doing real work and not
    // merely restating the POS one.
    const { tokens, carrier } = span("手", "VERB", "subj", "足", "VERB", "flat@vv");
    expect(resolve(carrier, { tokens }).suruCompound).toBeUndefined();
  });

  it("marks the span's carrier and only the carrier", () => {
    // One member answers for the span, so the two panels cannot pick
    // different ones — and a member's own `beatsLexicon` (俯 resolves to
    // ふ+す, 四段サ行) must never be mistaken for the span's own class.
    const { tokens } = span("蠕", "VERB", "subj", "動", "VERB", "flat@vv");
    expect(resolve(tokens[1], { tokens }).suruCompound).toBeUndefined();
  });
});


describe("種 as the verb 植う", () => {
  const resolve = createReadingResolver(kanjidic, jmdict);
  const sentence: Sentence = { tokens: [] };

  it("reads a VERB-tagged 種 as う (種樹, 'to plant trees')", () => {
    const token = makeToken({ text: "種", lemma: "種", pos: "VERB", dep: "ROOT" });
    // ワ行下二段 終止形 is the bare stem mora, carried by the kanji itself
    // with nothing written after it — the same shape 得 takes.
    expect(resolve(token, sentence)).toMatchObject({ reading: "う", okurigana: "" });
  });

  it("leaves the noun alone, which is what 種 overwhelmingly is", () => {
    const token = makeToken({ text: "種", lemma: "種", pos: "NOUN", dep: "subj" });
    expect(resolve(token, sentence).reading).toBe("たね");
  });
});

describe("首 as かうべ", () => {
  const resolve = createReadingResolver(kanjidic, jmdict);
  const sentence: Sentence = { tokens: [] };

  it("reads a NOUN-tagged 首 かうべ, ahead of KANJIDIC2's modern くび", () => {
    // 去首半尺 (酒蟲 sent_id 20) measures from the man's head. KANJIDIC2's
    // entry for 首 lists くび alone — the *neck* — so the reading comes from
    // `SUPPLEMENTARY_KUN`, which leads the character's kun list.
    expect(kanjidic["首"].kun).toEqual(["くび"]);
    const token = makeToken({ text: "首", lemma: "首", pos: "NOUN", dep: "comp:obj" });
    expect(resolve(token, sentence).reading).toBe("かうべ");
  });

  it("keeps the kanji on the page, which `overrides.json` could not have done", () => {
    // The whole reason this reading is not in the override table: every entry
    // there comes back `spellOutInProse`, which would print かうべ in the
    // 書き下し文 in place of the character and move the reading out of the
    // 訓読文's furigana slot. 首 is a content noun and wants neither.
    const token = makeToken({ text: "首", lemma: "首", pos: "NOUN", dep: "comp:obj" });
    const resolved = resolve(token, sentence);
    expect(resolved.spellOutInProse).toBeUndefined();
    expect(resolved.source).toBe("kanjidic");
  });
});

describe("縶 as しばる", () => {
  it("takes the 四段ラ行 縶る over KANJIDIC2's つな.ぐ", () => {
    // 縶手足 ("binds his hands and feet"). KANJIDIC2 gives the character only
    // つな.ぐ; しばる comes from `RESIDUAL` in verbLexicon.ts, which both
    // panels consult ahead of the resolver for a VERB, with the paradigm the
    // reading has to inflect through.
    expect(kanjidic["縶"].kun).toEqual(["つな.ぐ"]);
    expect(VERB_LEXICON["縶"]).toMatchObject({ conjClass: "yodan-ra", reading: "しば" });
  });

  it("also offers しば.る as a kun candidate, so the furigana menu has it", () => {
    // `RESIDUAL` alone would leave the menu listing つなグ and nothing else —
    // the menu reads KANJIDIC2's list, not the lexicon. Same pairing 需 needs.
    const offered = candidateReadings(kanjidic, "縶", "VERB").map((c) => c.reading + (c.okurigana ?? ""));
    expect(offered).toContain("しばる");
    expect(offered).toContain("つなぐ");
  });
});

describe("許 as ばかり", () => {
  const resolve = createReadingResolver(kanjidic, jmdict);
  const sentence: Sentence = { tokens: [] };

  it("reads the approximative particle, as furigana over the character", () => {
    // 長三寸許 (sent_id 25) -> 長さ三寸許. The entry moved from `overrides.json`
    // to `SUPPLEMENTARY_KUN`, and the move is what the reader asked for: an
    // override is returned `spellOutInProse`, which puts its reading in the
    // 訓読文's okurigana slot beside the character (許[|バカリ]) and writes
    // ばかり in kana in the prose. A supplementary kun is a reading of the
    // character like any other, so ばかり goes *over* 許 and the kanji stays in
    // both panels — the same treatment 首's かうべ gets above.
    const token = makeToken({ text: "許", lemma: "許", pos: "NOUN", dep: "comp:obj" });
    const resolved = resolve(token, sentence);
    expect(resolved).toMatchObject({ reading: "ばかり", source: "kanjidic" });
    expect(resolved.spellOutInProse).toBeUndefined();
  });

  it("leaves the verb 許す alone, since the entry does not beat the lexicon", () => {
    // The unconditioned entry is safe for a VERB-tagged 許 because both panels
    // consult `VERB_LEXICON` first for one, and an entry with no
    // `beatsLexicon` does not stand that lookup down.
    expect(VERB_LEXICON["許"]).toMatchObject({ conjClass: "yodan-sa", reading: "ゆる" });
    expect(findOverride("許", "NOUN", "comp:obj")?.beatsLexicon).toBeUndefined();
  });
});

describe("但 gains たダ without losing ただし", () => {
  const resolve = createReadingResolver(kanjidic, jmdict);
  const sentence: Sentence = { tokens: [] };

  it("offers た.だ as a kun candidate beside KANJIDIC2's ただ.し", () => {
    // 但令於日中俯臥 is "just have him lie face down", not "however". The dot
    // after the first mora is the split `KANJI_RETAINED_ADVERBS` uses for
    // every adverb of this shape (甚 はなは+だ, 必 かなら+ず).
    const offered = candidateReadings(kanjidic, "但", "ADV").map((c) => c.reading + (c.okurigana ?? ""));
    expect(offered).toContain("ただ");
    expect(offered).toContain("ただし");
    expect(candidateReadings(kanjidic, "但", "ADV").find((c) => c.reading === "た")).toMatchObject({ okurigana: "だ" });
  });

  it("joins ただし rather than replacing it — the default is unchanged", () => {
    // 但 has its own override entry, and it is consulted long before any
    // kanjidic lookup, so this addition reaches the reader through the
    // furigana menu alone. Making 但ダ the default is a change to that entry
    // and to `KANJI_RETAINED_ADVERBS`, not to `SUPPLEMENTARY_KUN`.
    const token = makeToken({ text: "但", lemma: "但", pos: "ADV", dep: "mod" });
    expect(resolve(token, sentence).reading).toBe("ただし");
  });
});

describe("於 as a locative modifier", () => {
  it("is keyed on the locative-modifier deps, and splits お + いて", () => {
    // The split follows KANJIDIC2's own お.ける for the same character rather
    // than its おい.て (= 於て): 於いて and 於ける share the stem お-, and it is
    // also the ordinary spelling of the phrase.
    expect(findOverride("於", "ADP", "mod@lmod")).toMatchObject({ reading: "お", okurigana: "いて" });
    expect(findOverride("於", "ADP", "comp:obl@lmod")).toMatchObject({ reading: "お", okurigana: "いて" });
  });

  /** The two entries that used to stand beside it — an ADP-keyed に and a
   * char-only において — are gone. No parse can reach any 於 entry: `yuParts`
   * answers for every token whose lemma is 於 and both panels ask it ahead of
   * the override lookup, so the character never arrives at this table. What
   * those two claimed is also what the app decided against — 於 reads either
   * より or お + いて, and に is what its *object* takes (`caseParticleFor`),
   * not what the character reads.
   *
   * 乎's parallel entry is deliberately still there and is asserted here so
   * the two cannot be tidied together by mistake: nothing short-circuits 乎,
   * so that one is live and does real work. */
  it("has no other 於 entry left, and has not touched 乎's", () => {
    expect(findOverride("於", "ADP", "mod")).toBeNull();
    expect(findOverride("於", "ADP")).toBeNull();
    expect(findOverride("乎", "ADP")?.reading).toBe("に");
  });
});

describe("毎/每 divides into a reading and an ending", () => {
  it("carries ごと as the character's reading and に as its okurigana", () => {
    // Not one run of kana: ごと is a reading of 毎, which belongs over it as
    // furigana, and only に is an ending.
    expect(findOverride("毎")).toMatchObject({ reading: "ごと", okurigana: "に" });
    expect(findOverride("每")).toMatchObject({ reading: "ごと", okurigana: "に" });
  });
});

describe("createReadingResolver fallback chain", () => {
  const resolve = createReadingResolver(kanjidic, jmdict);
  const sentence: Sentence = { tokens: [] };

  it("hits the override table first", () => {
    const token = makeToken({ text: "之", pos: "PRON", dep: "comp:obj", lemma: "之" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("override");
    expect(result.reading).toBe("これ");
  });

  it("falls back to kanjidic when there's no override", () => {
    const token = makeToken({ text: "習", pos: "VERB", dep: "conj:coord", lemma: "習" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("kanjidic");
    expect(result.reading.length).toBeGreaterThan(0);
  });

  it("falls back to jmdict for a flat-span member absent from kanjidic-by-itself logic", () => {
    // 子, as a flat continuation of 君子, should still resolve via kanjidic
    // (single-char lookup) before jmdict is even tried, since kanjidic has
    // an entry for 子 itself — so instead exercise the jmdict path directly
    // with a lemma-bearing token whose character isn't in kanjidic at all.
    const token = makeToken({ text: "", pos: "NOUN", dep: "flat", lemma: "君子" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("jmdict");
    expect(result.reading).toBe("くんし");
  });

  it("logs and returns unresolved for a token with no data anywhere", () => {
    unresolvedLog.clear();
    const token = makeToken({ text: "", pos: "NOUN", dep: "obj", lemma: "" });
    const result = resolve(token, sentence);
    expect(result.source).toBe("unresolved");
    expect(result.reading).toBe("");
    expect(unresolvedLog.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 歴史的仮名遣い for on'yomi. The index behind this is built in two stages:
// what Wiktionary attests (`build-historical-kana-index.mjs`, including the
// per-character corrections aligned out of compounds), then what the 切韻
// rime data lets `derive-onyomi-kana.py` derive for the rest. Both stages are
// asserted here against the shipped index, since a rebuild that quietly lost
// either would otherwise only show up as modern kana on the page.
// ---------------------------------------------------------------------------

describe("on'yomi in 歴史的仮名遣い", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const derived = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-derived.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);
  const sentence: Sentence = { tokens: [] };
  const readingOf = (text: string, pos = "PROPN"): string =>
    resolve({ id: 0, text, lemma: text, pos, xpos: "x", dep: "ROOT", head: 0 }, sentence).reading;

  // The pairs that make the point: each is spelled identically to its partner
  // in modern kana and differently in historical, so no rule over the modern
  // form could tell them apart — only the character can.
  it.each([
    ["京", "きやう"],
    ["教", "けう"],
    ["相", "しやう"],
    ["消", "せう"],
    ["王", "わう"],
    ["央", "あう"],
  ])("distinguishes %s, which no rule over the modern kana could", (char, expected) => {
    expect(historicalKana[char]).toBeDefined();
    expect(Object.values(historicalKana[char])).toContain(expected);
  });

  it("has the readings the 廣韻 derivation supplies and Wiktionary does not", () => {
    // 生's own affix entry for しょう carries no `hist`, and 敬 and 名 have no
    // reading entry at all — these three come from the rime data.
    expect(derived["生"]?.["しょう"]).toBe("しやう");
    expect(derived["敬"]?.["きょう"]).toBe("きやう");
    expect(derived["名"]?.["みょう"]).toBe("みやう");
  });

  it("has the readings aligned out of compounds", () => {
    // 少 しょう->せう comes from 少年 せうねん, split against its own ruby.
    expect(historicalKana["少"]?.["しょう"]).toBe("せう");
    expect(historicalKana["習"]?.["しゅう"]).toBe("しふ");
  });

  // 四つ仮名 — じ/ぢ and ず/づ — is settled by the Middle Chinese *initial* and
  // by nothing the rime records: 知/徹/澄/孃母 give ぢ/づ, 日母 and 精組 and 章組
  // give じ/ず. A vote table keyed on the rime alone therefore answered for a
  // whole mixed bucket at once and wrote 149 spurious ぢ into the index (仁
  // ぢん, 人 ぢん, 二 ぢ, 字 ぢ) to buy a handful of right ones. 母 is in
  // `keys_for` for exactly this, and these are both sides of the distinction it
  // draws. Read through `?? modern` because the two sides are reached
  // differently: a ぢ has to be derived and stored, whereas じ is already the
  // modern spelling, so the derivation abstaining is what puts it on the page.
  it.each([
    ["仁", "じん", "じん"], // 日母
    ["人", "じん", "じん"], // 日母
    ["二", "じ", "じ"], // 日母
    ["事", "じ", "じ"], // 莊/崇母
    ["字", "じ", "じ"], // 從母
    ["寺", "じ", "じ"], // 邪母
    // 常母 (= 禪母), which is a 章組 initial and not the 澄母 its 峙/庤 rime-mates
    // have — the pair that most invites the rime-only guess, and gets it wrong.
    ["恃", "じ", "じ"],
    ["墀", "じ", "ぢ"], // 澄母
    ["峙", "じ", "ぢ"], // 澄母
    ["庤", "じ", "ぢ"], // 澄母
    ["釀", "じょう", "ぢやう"], // 孃母
    ["逗", "ず", "づ"], // 澄母
  ])("spells %s's 四つ仮名 from its 中古音 initial, which its rime cannot supply", (char, modern, expected) => {
    expect(historicalKana[char]?.[modern] ?? modern).toBe(expected);
  });

  it("writes no small ゃゅょ anywhere, which 歴史的仮名遣い never uses", () => {
    // 301 values arrived from Wiktionary written with the modern small kana;
    // `derive-onyomi-kana.py` folds them, so none should survive a rebuild.
    const offenders = Object.entries(historicalKana)
      .flatMap(([char, readings]) => Object.entries(readings).map(([, hist]) => [char, hist] as const))
      .filter(([, hist]) => /[ゃゅょ]/.test(hist));
    expect(offenders).toEqual([]);
  });

  it("puts a resolved on'yomi on the page in historical kana", () => {
    // PROPN takes the on'yomi (see `lookupKanji`), which is the path a
    // character reaches the panel by when it has no kun'yomi to prefer. Both
    // of these take their *first* on'yomi, which is the one that gets there.
    expect(readingOf("京")).toBe("きやう");
    expect(readingOf("少")).toBe("せう");
  });
});

// ---------------------------------------------------------------------------
// 歴史的仮名遣い for kun'yomi, which is a different problem from the on'yomi
// above and needed a third pass in the index build to reach at all: a kanbun
// token is one character, a native word written with one kanji is written
// with okurigana after it, and KANJIDIC2 gives the character only the *stem*.
// `kunPairsOf` divides an entry's historical form across its own ruby and its
// okurigana, which is what turns a word-level attestation into the per-
// character one this app can look up.
// ---------------------------------------------------------------------------

describe("kun'yomi in 歴史的仮名遣い", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);
  const sentence: Sentence = { tokens: [] };
  const readingOf = (text: string, pos: string): string =>
    resolve({ id: 0, text, lemma: text, pos, xpos: "x", dep: "ROOT", head: 0 }, sentence).reading;

  it.each([
    ["終", "お", "を"], // 終わり -> をはり
    ["曰", "いわ", "いは"], // 曰く -> いはく
    ["雖", "いえど", "いへど"], // 雖も -> いへども
    ["現", "あらわ", "あらは"], // 現す -> あらはす
    ["自", "みずか", "みづか"], // 自ら -> みづから
    ["尊", "たっと", "たつと"], // 尊ぶ -> たつとぶ, Wiktionary's own hist2
  ])("divides %s's stem out of the word that attests it", (char, modern, expected) => {
    expect(historicalKana[char]?.[modern]).toBe(expected);
  });

  it("keys a stem to a stem and never to the whole word it came out of", () => {
    // 幸い's historical form is さいはひ, and pairing that whole word with the
    // *stem* さいわ its own ruby carries put a word where a reading belongs —
    // under a key one character reaches, so 幸 was one parse away from
    // printing さいはひ with its own okurigana い after it. Same shape for 僅
    // (わづか under わず) and 柔 (やはら under やわ).
    expect(historicalKana["幸"]?.["さいわ"]).toBe("さいは");
    expect(historicalKana["僅"]?.["わず"]).toBe("わづ");
    expect(historicalKana["柔"]?.["やわ"]).toBe("やは");
  });

  it("writes an unattested 促音 full-size rather than leaving it modern", () => {
    // 則る is not attested historically anywhere in the dump, so nothing keys
    // 則 のっと — and the fold is what still gets it onto the page as のつと.
    expect(historicalKana["則"]?.["のっと"]).toBeUndefined();
    expect(readingOf("則", "VERB")).toBe("のつと");
  });

  it("leaves a fused long vowel exactly as it stands", () => {
    // どじょう is historically どぢやう and nothing here attests it, so it is
    // an abstention: 36 of KANJIDIC2's kun'yomi stems are left this way.
    expect(readingOf("鰍", "NOUN")).toBe("かじか");
    expect(historicalKana["鰍"]?.["どじょう"]).toBeUndefined();
  });
});

describe("a compound's members keep their historical readings", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");

  // The compound path resolves a whole span at once — either from JMdict's
  // reading for the word, or by reading every member on'yomi — and both of
  // those are modern kana. It used to hand them to the page uncorrected while
  // the per-token path corrected everything around them, so a character
  // inside a compound and the same character outside one disagreed.
  it("corrects 黃帝, which is this project's own opening line", () => {
    const got = compoundFurigana(["黃", "帝"], "黃帝", jmdict, kanjidic, historicalKana, () => undefined);
    expect(got).toEqual(["くわう", "てい"]);
  });

  it("corrects 少典, whose reading comes through the same path", () => {
    const got = compoundFurigana(["少", "典"], "少典", jmdict, kanjidic, historicalKana, () => undefined);
    expect(got).toEqual(["せう", "てん"]);
  });

  it("leaves a member alone when its reading needs no correction", () => {
    // てい and てん are their own historical spellings; only 黃 and 少 move.
    expect(historicalKana["帝"]?.["てい"]).toBeUndefined();
    expect(historicalKana["典"]?.["てん"]).toBeUndefined();
  });

  it("still falls back where a character is unknown", () => {
    const got = compoundFurigana(["黃", "帝"], "黃帝", null, null, historicalKana, (i) => `fb${i}`);
    expect(got).toEqual(["fb0", "fb1"]);
  });
});

/** A multi-character token is one CoNLL-U row, so a reading picked over one
 * of its characters is stored as the whole word's — and has to be divided
 * back across the characters, or the choice would be stored correctly and
 * never appear. Both panels ask `compoundFurigana` for that division (the
 * 訓読文 for its ruby, the 書き下し文 for the gloss over the same word), so
 * this is where it is checked. */
describe("a compound's hand-picked reading is divided across its characters", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const divide = (chars: string[], text: string, chosen?: string) =>
    compoundFurigana(chars, text, jmdict, kanjidic, historicalKana, () => undefined, chosen);

  it("divides つがそう over 番僧, the reading 番's own menu composes", () => {
    expect(divide(["番", "僧"], "番僧")).toEqual(["ばん", "そう"]);
    expect(divide(["番", "僧"], "番僧", "つがそう")).toEqual(["つが", "そう"]);
  });

  it("outranks JMdict's own reading for the word", () => {
    // 三百 is in JMdict (さんびゃく) and the automatic reading comes from
    // there; the choice has to beat it rather than lose to a dictionary hit.
    expect(divide(["三", "百"], "三百")).toEqual(["さん", "びやく"]);
    expect(divide(["三", "百"], "三百", "さんもも")).toEqual(["さん", "もも"]);
  });

  it("puts a reading it cannot divide over the first character alone", () => {
    // Nothing the menu offers lands here — it offers only readings the
    // splitter recognises — but a `Reading=` written by hand into the MISC
    // column can, and it has to appear rather than be dropped in favour of
    // the dictionary reading it was written to correct.
    expect(divide(["番", "僧"], "番僧", "あいうえお")).toEqual(["あいうえお", undefined]);
  });
});

/** A reading picked off the furigana's right-click menu arrives with
 * KANJIDIC's own okurigana, which is a *modern* dictionary ending — so the
 * ending has to be recomputed for the reading that was picked, not carried
 * across verbatim. Both panels ask `chosenReading.ts` for it (the 訓読文 and
 * the generator through `chosenReadingParts`, the resolver through
 * `chosenReading`), so both are checked here against the same token. */
describe("a hand-picked reading's ending is put into classical shape", () => {
  const resolve = createReadingResolver(kanjidic, jmdict);
  const sentence = (token: Token): Sentence => ({ tokens: [token] });

  /** What the two entry points make of one token, which must agree: they
   * feed the 書き下し文 and the 訓読文 respectively, and two panels showing
   * two endings for one choice is the divergence they exist to prevent. */
  const endings = (token: Token) => {
    const viaResolver = resolve(token, sentence(token)).okurigana;
    const viaParts = chosenReadingParts(token)?.okurigana;
    expect(viaResolver).toBe(viaParts);
    return viaResolver;
  };

  it("converts a modern 一段 ending to its classical 二段 終止形", () => {
    // 立's た.てる is the transitive 下二段 verb, whose classical 終止形 is
    // 立つ. Left as kanjidic writes it, picking this reading printed
    // 王太子を立てるて去ぬ.
    const token = makeToken({ text: "立", lemma: "立", pos: "VERB" });
    setChosenReading(token, "た", "てる");
    expect(endings(token)).toBe("つ");
  });

  it("converts the 上二段 rows too", () => {
    // 過's す.ぎる is 過ぐ, 起's お.きる is 起く — the i-grade half of the
    // same table.
    const sugi = makeToken({ text: "過", lemma: "過", pos: "VERB" });
    setChosenReading(sugi, "す", "ぎる");
    expect(endings(sugi)).toBe("ぐ");

    const oki = makeToken({ text: "起", lemma: "起", pos: "VERB" });
    setChosenReading(oki, "お", "きる");
    expect(endings(oki)).toBe("く");
  });

  it("leaves a 四段 ending alone, which is already classical", () => {
    const token = makeToken({ text: "立", lemma: "立", pos: "VERB" });
    setChosenReading(token, "た", "つ");
    expect(endings(token)).toBe("つ");
  });

  it("names 上一段 for a picked み.る, where the ending alone would say 四段ラ行", () => {
    // Both panels take this branch ahead of the lexicon, so a class has to
    // arrive with the choice or nothing downstream corrects it: picking 見's
    // み.る off the menu printed 見り. The ending is already classical and
    // stays る; what changes is the paradigm it inflects by, taken from the
    // one sense of 見 read み that spells itself みる today.
    const token = makeToken({ text: "見", lemma: "見", pos: "VERB" });
    setChosenReading(token, "み", "る");
    expect(endings(token)).toBe("る");
    expect(chosenReadingParts(token)?.conjClass).toBe("kami-ichidan");
    expect(resolve(token, sentence(token)).conjClass).toBe("kami-ichidan");
  });

  it("keeps the 二段/四段 split a two-kana ending already carries", () => {
    // The lexicon is consulted for a one-kana ending only. 立's attested
    // senses are both 四段, and letting them speak for た.てる would undo the
    // very distinction the conversion above exists for — 廟を立てて.
    const teru = makeToken({ text: "立", lemma: "立", pos: "VERB" });
    setChosenReading(teru, "た", "てる");
    expect(chosenReadingParts(teru)?.conjClass).toBe("shimo-nidan-ta");

    const tsu = makeToken({ text: "立", lemma: "立", pos: "VERB" });
    setChosenReading(tsu, "た", "つ");
    expect(chosenReadingParts(tsu)?.conjClass).toBe("yodan-ta");
  });

  it("leaves an あ-row -eru alone rather than guessing its 行", () => {
    // 見える is 見ゆ, not *見う — the surface form cannot tell ア行 from
    // ヤ行 from ワ行, so the ending keeps its modern shape rather than
    // being given a confidently wrong classical one.
    const token = makeToken({ text: "見", lemma: "見", pos: "VERB" });
    setChosenReading(token, "み", "える");
    expect(endings(token)).toBe("える");
  });

  it("gives an adjective its 終止形 し, not a modern い", () => {
    // 遠's とほ.い is the reading the page was *already* showing as とほシ,
    // so picking it out of the menu used to change 道遠し into 道遠い —
    // a choice that flipped the text into modern Japanese while claiming
    // to leave the reading where it was.
    const token = makeToken({ text: "遠", lemma: "遠", pos: "ADJ", morph: "Degree=Pos" });
    setChosenReading(token, "とほ", "い");
    expect(endings(token)).toBe("し");
  });

  it("folds a しく-type ending onto its own し", () => {
    // 樂しい is 樂し, one し and not two.
    const token = makeToken({ text: "樂", lemma: "樂", pos: "ADJ" });
    setChosenReading(token, "たの", "しい");
    expect(endings(token)).toBe("し");
  });

  it("leaves a 連用形 nominal's い alone, since it is no adjective", () => {
    // kanjidic writes 扱's あつか.い ("handling") and 向's む.かい ("facing")
    // with the same final い an adjective takes, and those are nouns: 扱し
    // and 向かし are not words. The adjectival gate is what separates them.
    const token = makeToken({ text: "扱", lemma: "扱", pos: "NOUN" });
    setChosenReading(token, "あつか", "い");
    expect(endings(token)).toBe("い");
  });

  it("still supplies サ変 す for a verb read on'yomi", () => {
    // The on'yomi candidates carry no ending of their own, and a verb read
    // on'yomi is read サ変 in kundoku — unchanged by the conversion above,
    // which only ever acts on an ending that is actually stored.
    const token = makeToken({ text: "立", lemma: "立", pos: "VERB" });
    setChosenReading(token, "りつ");
    expect(endings(token)).toBe("す");
  });

  it("is idempotent, so a choice read back off a saved text is untouched", () => {
    // A choice survives into `misc`, and so into a saved text and a
    // `.conllu` file's MISC column. Whichever shape it was written in, the
    // conversion has to leave an already-classical ending exactly as it is.
    const token = makeToken({ text: "遠", lemma: "遠", pos: "ADJ", morph: "Degree=Pos" });
    setChosenReading(token, "とほ", "し");
    expect(endings(token)).toBe("し");
  });

  it("writes a picked もちいる as もちゐる, and names its ワ行上一段", () => {
    // KANJIDIC's kun for 用 is the modern もち.いる, and い is not a row
    // `classicalVerbEnding` converts or `classicalConjClass` reads a class
    // off — so a picked 用 used to print the modern 用いる, frozen at that
    // one shape in every position (用いるず, 用いるて, これを用いるもの).
    // See `LEXICAL_KUN`.
    const token = makeToken({ text: "用", lemma: "用", pos: "VERB" });
    setChosenReading(token, "もち", "いる");
    expect(endings(token)).toBe("ゐる");
    expect(chosenReadingParts(token)?.conjClass).toBe("kami-ichidan");
    expect(resolve(token, sentence(token)).conjClass).toBe("kami-ichidan");
  });

  it("takes もちゐる back as it stands, so a picked 用 survives a round trip", () => {
    // What the menu now stores is the converted ending and the class beside
    // it, which is what a `.conllu` export writes and an import reads back.
    // The ending must survive that unchanged, and the class must be reached
    // from the ending alone as well — an older file carries no ConjClass at
    // all, and neither does a `Reading=`/`Okurigana=` pair written by hand.
    const stored = makeToken({ text: "用", lemma: "用", pos: "VERB" });
    setChosenReading(stored, "もち", "ゐる", "kami-ichidan");
    expect(stored.misc).toEqual({ Reading: "もち", Okurigana: "ゐる", ConjClass: "kami-ichidan" });
    expect(endings(stored)).toBe("ゐる");
    expect(chosenReadingParts(stored)?.conjClass).toBe("kami-ichidan");

    const noClass = makeToken({ text: "用", lemma: "用", pos: "VERB" });
    setChosenReading(noClass, "もち", "ゐる");
    expect(endings(noClass)).toBe("ゐる");
    expect(chosenReadingParts(noClass)?.conjClass).toBe("kami-ichidan");
  });

  it("gives a pin whose ending is an inflected form the paradigm of the word", () => {
    // **The reader's own file, and the case that prompted this.** 覺 is pinned
    // `Reading=おぼ|Okurigana=ゆる`, and ゆる is the 連体形 of ヤ行下二段 覚ゆ — a
    // form, not a citation — so the pin froze the inflection and printed
    // 覺おぼゆる in a clause the syntax wants the 連用中止法 for. No
    // ending-shaped rule can see it: `classicalConjClass` has no ゆ row, and the
    // modern spelling of that sense is える, which ゆる is not. What settles it
    // is the character plus the stem the reader chose — see `soleAttestedClass`.
    const token = makeToken({ text: "覺", lemma: "覺", pos: "VERB" });
    setChosenReading(token, "おぼ", "ゆる");
    expect(chosenReadingParts(token)?.conjClass).toBe("shimo-nidan-ya");
    // Nothing in `misc` is rewritten, so the tree round-trips through CoNLL-U
    // byte for byte and a file opened by an older build behaves as it did. The
    // stored ending is simply no longer the last word — `pickedEnding`
    // conjugates from the class and never reads it.
    expect(token.misc).toEqual({ Reading: "おぼ", Okurigana: "ゆる" });
  });

  it("keeps the stem mora a prefixed sense states inside its ending", () => {
    // 試's pin is こころ + みる and 果's は + たす, both from the same file and
    // both a `VERB_LEXICON` sense's own modern spelling, prefix and all. The
    // class comes from `attestedSenseByModernSpelling`, which matches that
    // spelling exactly; the prefix is then recovered by `attestedSense` from the
    // stored ending, so the 連用形 is 試み and not the 試 a bare class would give.
    const kokoromi = makeToken({ text: "試", lemma: "試", pos: "VERB" });
    setChosenReading(kokoromi, "こころ", "みる");
    expect(chosenReadingParts(kokoromi)?.conjClass).toBe("kami-ichidan");
    const hatasu = makeToken({ text: "果", lemma: "果", pos: "VERB" });
    setChosenReading(hatasu, "は", "たす");
    expect(chosenReadingParts(hatasu)?.conjClass).toBe("yodan-sa");
  });

  it("abstains where the word is not identified, rather than guessing a paradigm", () => {
    // 苦's くる is both シク活用 苦し and 四段マ行 苦しむ in `LEXICON_SENSES`, and
    // the reader's pin (くる + しむ) names the second in a division the lexicon
    // does not share — its 四段マ行 sense carries no し prefix, so its modern
    // spelling is む. Two paradigms under one stem is not a thing this file
    // should choose between, so the pin stays exactly as frozen as it was.
    const kurushimu = makeToken({ text: "苦", lemma: "苦", pos: "VERB" });
    setChosenReading(kurushimu, "くる", "しむ");
    expect(chosenReadingParts(kurushimu)?.conjClass).toBeUndefined();
    expect(endings(kurushimu)).toBe("しむ");
  });

  it("refuses to conjugate a fixed reading — 曰はく is not 曰いふ", () => {
    // 曰's はく is an -aku nominalisation, and its `RESIDUAL` sense carries
    // 四段ハ行 beside it for the *other* use of the character. Naming that class
    // for this pin would print 曰いふ / 曰いひ, which is the one thing
    // `fixedReading` exists to prevent.
    const token = makeToken({ text: "曰", lemma: "曰", pos: "VERB" });
    setChosenReading(token, "い", "はく");
    expect(chosenReadingParts(token)?.conjClass).toBeUndefined();
    expect(endings(token)).toBe("はく");
  });

  it("gives the other -いる verbs their ヤ行上二段 from the word, not from the ending", () => {
    // The narrow scope the *ending* rule is kept to, asserted rather than
    // described: 老いる, 悔いる and 報いる are 老ゆ, 悔ゆ, 報ゆ — a 終止形 in ゆ
    // with no ゐ anywhere in the paradigm — so a rule over the ending shape
    // would corrupt three words to correct one, and `LEXICAL_KUN` is a word
    // list for that reason. The stored ending is left exactly as it was.
    //
    // **The paradigm is a different question and is now answered**, by
    // `soleAttestedClass`: `LEXICON_SENSES` holds each of these characters'
    // stem as ヤ行上二段 and holds nothing else under it. So a pin that stores
    // the modern いる no longer stands frozen at 老いる — `pickedEnding`
    // conjugates from the class, and the stored ending is never read. That the
    // two disagree is the point rather than a defect: `misc` keeps what the
    // reader stored, byte for byte, so the tree still round-trips, while the
    // page shows the classical form the class states.
    for (const [char, reading] of [
      ["老", "お"],
      ["悔", "く"],
      ["報", "むく"],
    ] as const) {
      const token = makeToken({ text: char, lemma: char, pos: "VERB" });
      setChosenReading(token, reading, "いる");
      expect(endings(token)).toBe("いる");
      expect(chosenReadingParts(token)?.conjClass).toBe("kami-nidan-ya");
    }
  });
});

describe("謂 reads いふ, not ゐふ", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  // 一番僧見之、謂其身有異疾。 — 酒蟲 sent_id 5, the parse the bug was found in.
  const sentence: Sentence = {
    tokens: [
      makeToken({ id: 3, text: "見", lemma: "見", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "root", head: 0 }),
      makeToken({ id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 3 }),
      makeToken({ id: 6, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "parataxis", head: 3 }),
      makeToken({ id: 7, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,起格", morph: "Person=3|PronType=Prs", dep: "det", head: 8 }),
      makeToken({ id: 8, text: "身", lemma: "身", pos: "NOUN", xpos: "n,名詞,不可譲,身体", dep: "comp:obj", head: 6 }),
    ],
  };
  const wei = sentence.tokens[2];

  it("refuses the historical-kana index for a reading the character has in both series", () => {
    // 謂's on'yomi イ and its kun'yomi い.ふ are one key in an index that
    // records no series, and the entry there is the on'yomi's — ゐ.
    expect(historicalKana["謂"]?.["い"]).toBe("ゐ");
    expect(seriesAmbiguousReading(kanjidic, "謂", "い")).toBe(true);
  });

  it("goes on trusting the index for a Sino-Japanese reading that is no kun stem", () => {
    // The ten `VERB_LEXICON` readings a bare "is it an on'yomi?" test would
    // also have caught: every one is the character's on'yomi and none is one
    // of its kun stems, so the derivation that is right for them stands.
    expect(seriesAmbiguousReading(kanjidic, "香", "こう")).toBe(false);
    expect(seriesAmbiguousReading(kanjidic, "課", "か")).toBe(false);
    expect(seriesAmbiguousReading(kanjidic, "評", "ひょう")).toBe(false);
  });

  it("draws い over 謂, the reading its lexicon entry holds", () => {
    // The lexicon is what supplies 謂's reading (四段ハ行 い + ふ), and the
    // correction it goes through on the way to the page is the one place the
    // on'yomi's ゐ was reaching it.
    expect(furiganaFor(wei, sentence, resolve, historicalKana, kanjidic)).toBe("い");
  });
});

describe("之 read これ is written 之れ, unless a case particle follows", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  it("keeps これ whole where the ending slot is already spoken for", () => {
    // 一番僧見之 — 之 is 見's `comp:obj` and takes を, so これヲ.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 3, text: "見", lemma: "見", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "root", head: 0 }),
        makeToken({ id: 4, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 3 }),
      ],
    };
    const resolved = resolve(sentence.tokens[1], sentence);
    expect(caseParticleFor(sentence.tokens[1], sentence)).toBe("を");
    expect(resolved.reading).toBe("これ");
    expect(resolved.okurigana).toBeUndefined();
  });

  it("splits こ + れ where nothing follows", () => {
    // 曰：「有之。」 — 酒蟲 sent_id 10. An existential 有's own complement takes
    // no particle, so the れ is written as the okurigana it is.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "root", head: 0 }),
        makeToken({ id: 4, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "comp:obj", head: 1 }),
        makeToken({ id: 5, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 4 }),
      ],
    };
    const resolved = resolve(sentence.tokens[2], sentence);
    expect(caseParticleFor(sentence.tokens[2], sentence)).toBeUndefined();
    expect(resolved.reading).toBe("こ");
    expect(resolved.okurigana).toBe("れ");
    // And the prose writes 之れ, the character with the れ beside it, which is
    // this same division read in the other panel — 之れ stands 18 times in the
    // received text of the gold passages and 之を 239. The entry says so for
    // itself now (`OverrideEntry.spellOutInProse`); before the reader's ruling
    // both halves were written out and the split moved the annotation slot
    // alone.
    expect(resolved.spellOutInProse).toBe(false);
  });

  it("leaves the genitive 之 alone, which is の and no pronoun", () => {
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 1, text: "劉", lemma: "劉", pos: "PROPN", xpos: "n,名詞,主体,人", dep: "mod", head: 3 }),
        makeToken({ id: 2, text: "之", lemma: "之", pos: "SCONJ", xpos: "p,助詞,構造,*", dep: "mod", head: 1 }),
        makeToken({ id: 3, text: "福", lemma: "福", pos: "NOUN", xpos: "n,名詞,描写,量", dep: "root", head: 0 }),
      ],
    };
    const resolved = resolve(sentence.tokens[1], sentence);
    expect(resolved.reading).toBe("の");
    // Empty, not absent, and the difference is what puts の over the character
    // rather than beside it: KundokuView.ts reads an entry stating an okurigana
    // of its own as a split (furigana + ending), and an entry stating none as a
    // gloss belonging in the okurigana slot entire. See the entry's own note in
    // overrides.json. The pronoun split above is untouched by it.
    expect(resolved.okurigana).toBe("");
  });
});

describe("焉 reads three ways, and the particle is not one of them", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  it("gives the interrogative adverb いづ + くんぞ, as 安 and 惡 have it", () => {
    // 擇不處仁，焉得知 -> 焉んぞ知を得ん. **96** gold tokens, ADV on `mod` 95 and
    // on `subj` 1 (夫焉有所倚). The split is not decoration: `isInterrogativeBinder`
    // reads furigana *plus* okurigana, and 安/惡 carry the ぞ in the okurigana
    // slot, so an undivided いづくんぞ here would be a different string from its
    // two synonyms.
    const entry = findOverride("焉", "ADV", "mod");
    expect(entry?.reading).toBe("いづ");
    expect(entry?.okurigana).toBe("くんぞ");
    expect(findOverride("安", "ADV", "mod")?.reading).toBe(entry?.reading);
    expect(findOverride("惡", "ADV", "mod")?.okurigana).toBe(entry?.okurigana);
  });

  it("gives the fused 於之 pronoun ここ + に, and no second particle after it", () => {
    // 二女女焉 — 焉 is 女's `comp:obj` in the gold, which would take を from
    // `caseParticleFor` and print ここにヲ. It does not: the reading has already
    // written the particle that marks the slot, and `ownReadingSuppliesCaseParticle`
    // stands the case particle down for a closed-class token whose curated,
    // role-conditioned entry ends in one. That is the right answer and not
    // merely a tidy one — 焉 *is* 於之, so its slot is locative and never
    // accusative. 8 of the gold's 21 `comp:obj` 焉 drew that を before the split.
    const sentence: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "二", lemma: "二", pos: "NUM", xpos: "n,数詞,数,*", dep: "mod", head: 1 }),
        makeToken({ id: 1, text: "女", lemma: "女", pos: "NOUN", xpos: "n,名詞,主体,人", dep: "comp:obj", head: 2 }),
        makeToken({ id: 2, text: "女", lemma: "女", pos: "VERB", xpos: "v,動詞,行為,得失", dep: "ROOT", head: 2 }),
        makeToken({ id: 3, text: "焉", lemma: "焉", pos: "PRON", xpos: "n,代名詞,人称,止格", dep: "comp:obj", head: 2 }),
      ],
    };
    const resolved = resolve(sentence.tokens[3], sentence);
    expect(resolved.reading).toBe("ここ");
    expect(resolved.okurigana).toBe("に");
    expect(caseParticleFor(sentence.tokens[3], sentence)).toBeUndefined();
  });

  it("leaves the sentence-final 助字 unread, which is what it was reading り instead of", () => {
    // 561 of the gold's 764 焉 are this one, and the entry has said "" for them
    // all along. A reading of nothing is not a reading in another slot: the
    // り it had been taking from KANJIDIC2 is the 完了の助動詞, which attaches to
    // a 四段已然形 and to nothing else, and it was being written after a 終止形,
    // a negation and a 連体形 alike.
    expect(findOverride("焉", "PART", "discourse@sp")?.reading).toBe("");
    // The relation outranks the POS here — `findOverride` scores a `contextDep`
    // above a `contextPos` — so a PART 焉 closing its sentence keeps the empty
    // reading and never reaches the pronoun entry beside it.
    expect(findOverride("焉", "PRON", "discourse")?.reading).toBe("");
  });
});

describe("a pronoun under a prepositional 為 is a genitive — 我(わ)が爲に", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);
  const prose = (sentence: Sentence) => generateKakikudashi(computeReadingOrder(sentence, findCompoundSpans(sentence)), resolve);

  // 子盍為我言之 (Mencius) — gold, unaltered: 為 is the ADP `mod` of 言, 我 its
  // `comp:obj`, and 之 the ordinary object of 言 for a control in the same
  // sentence. The reader's reading is 子なんぞ**わ**がために之を言はざる.
  const heWeiWo = (pronoun: string, xpos = "n,代名詞,人称,止格", morph = "Person=1|PronType=Prs"): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: "子", lemma: "子", pos: "PRON", xpos: "n,代名詞,人称,他", morph: "Person=2|PronType=Prs", dep: "subj", head: 4 }),
      makeToken({ id: 1, text: "盍", lemma: "盍", pos: "ADV", xpos: "v,副詞,疑問,原因", morph: "AdvType=Cau", dep: "mod", head: 4 }),
      makeToken({ id: 2, text: "為", lemma: "爲", pos: "ADP", xpos: "v,前置詞,源泉,*", dep: "mod", head: 4 }),
      makeToken({ id: 3, text: pronoun, lemma: pronoun, pos: "PRON", xpos, morph, dep: "comp:obj", head: 2 }),
      makeToken({ id: 4, text: "言", lemma: "言", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 4 }),
      makeToken({ id: 5, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 4 }),
    ],
  });

  it("reads 我 わ, and both panels write the が exactly once", () => {
    // The reading is the `det` entry's — わ over the character — and the が
    // beside it is `caseParticleFor`'s, which was already right. Nothing here
    // writes a particle, so there is none to double: 我(わ)ガ, not 我(われ)ガ and
    // not 我(わガ)ガ.
    const sentence = heWeiWo("我");
    const resolved = resolve(sentence.tokens[3], sentence);
    expect(resolved.reading).toBe("わ");
    expect(resolved.okurigana).toBeUndefined();
    // …and the character is kept in the prose beside it: 我が, not わが. The
    // received text keeps 我 on 51 of the 51 occurrences in its 白文 across the
    // gold passages and 吾 on 108 of 108; this branch is not an `overrides.json`
    // entry and so states the flag itself — see `OverrideEntry.spellOutInProse`.
    expect(resolved.spellOutInProse).toBe(false);
    expect(caseParticleFor(sentence.tokens[3], sentence)).toBe("が");
    // The 訓読文's furigana half, asked of the panel that draws it: the two
    // panels must not disagree about one character.
    expect(furiganaFor(sentence.tokens[3], sentence, resolve, historicalKana, kanjidic)).toBe("わ");
    expect(prose(sentence)).toContain("我がために");
    expect(prose(sentence)).not.toContain("われが");
    expect(prose(sentence)).not.toContain("がが");
  });

  it("reads 吾/予/余/朕 the same way, on the same entry", () => {
    // Four of the five occur in this slot in the gold (我 19, 余 7, 吾 2, 朕 1;
    // 予 not at all), and the reading is one entry's, so the fifth follows the
    // four rather than waiting for a token to turn up.
    for (const [pronoun, xpos] of [["吾", "n,代名詞,人称,起格"], ["予", "n,代名詞,人称,止格"], ["余", "n,代名詞,人称,起格"], ["朕", "n,代名詞,人称,起格"]] as const) {
      const sentence = heWeiWo(pronoun, xpos);
      expect(resolve(sentence.tokens[3], sentence).reading).toBe("わ");
      // The character each of them keeps is its own — the reading is one
      // entry's and the graph is not (`OverrideEntry.spellOutInProse`).
      expect(prose(sentence)).toContain(`${pronoun}がために`);
    }
  });

  it("leaves an ordinary object 我 as われ, which is what the deprel alone cannot tell apart", () => {
    // 之 in the same sentence is 言's own `comp:obj` and stays これ + を; 我
    // standing in that slot would too. The rule is about the governor, and this
    // is the population a `contextDep: ["comp:obj"]` on the わ + が entry would
    // have claimed — 401 first-person pronouns over the gold.
    const sentence = heWeiWo("我");
    expect(resolve(sentence.tokens[5], sentence).reading).toBe("これ");
    const object: Sentence = {
      tokens: [
        makeToken({ id: 0, text: "愛", lemma: "愛", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "ROOT", head: 0 }),
        makeToken({ id: 1, text: "我", lemma: "我", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=1|PronType=Prs", dep: "comp:obj", head: 0 }),
      ],
    };
    expect(resolve(object.tokens[1], object).reading).toBe("われ");
    expect(caseParticleFor(object.tokens[1], object)).toBe("を");
  });

  it("leaves 之, 誰 and 何 alone — the が is already right for them in kana", () => {
    // これがために, たれがために, なにがために. 何 is the one with a `det` entry of
    // its own, and it is excluded by its particle rather than by a list: なに +
    // の is the determiner of 何の藥, a different construction from the one the
    // が marks, and 何が故に is the ordinary kundoku of this frame.
    // The prose column is stated rather than derived from the reading: 之 keeps
    // its character in the 書き下し文 and the other two do not, which is the
    // per-entry `spellOutInProse` line and nothing to do with the が.
    for (const [pronoun, reading, written, xpos, morph] of [
      ["之", "これ", "之", "n,代名詞,人称,止格", "Person=3|PronType=Prs"],
      ["誰", "たれ", "誰", "n,代名詞,疑問,*", "PronType=Int"],
      ["何", "なに", "何", "n,代名詞,疑問,*", "PronType=Int"],
    ] as const) {
      const sentence = heWeiWo(pronoun, xpos, morph);
      expect(resolve(sentence.tokens[3], sentence).reading).toBe(reading);
      expect(caseParticleFor(sentence.tokens[3], sentence)).toBe("が");
      expect(prose(sentence)).toContain(`${written}がために`);
    }
    expect(findOverride("何", "PRON", "det")?.okurigana).toBe("の");
  });

  it("is reached from a parsed CoNLL-U sentence, deprels spelled as the file spells them", () => {
    // The trap this is written against: `conlluParser.ts` normalises `root` to
    // `ROOT` and touches no other DEPREL, so a rule or an entry keyed on a
    // relation spelled any other way matches nothing at all and fails silently.
    // 爲吾披荊棘定關中 (gold, unaltered) goes in as the treebank writes it, and
    // both the `det` key this borrows the reading from and the ADP 為 it tests
    // the governor against have to be reachable for わ to come out.
    const tree = parseConllu(
      [
        "# text = 爲吾披荊棘定關中。",
        "1\t爲\t爲\tADP\tv,前置詞,源泉,*\t_\t3\tmod\t_\t_",
        "2\t吾\t吾\tPRON\tn,代名詞,人称,起格\tPerson=1|PronType=Prs\t1\tcomp:obj\t_\t_",
        "3\t披\t披\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_",
        "4\t荊\t荊\tNOUN\tn,名詞,固定物,地形\tCase=Loc\t3\tcomp:obj\t_\t_",
        "5\t棘\t棘\tNOUN\tn,名詞,固定物,樹木\t_\t4\tflat\t_\t_",
        "6\t定\t定\tVERB\tv,動詞,行為,動作\t_\t3\tparataxis\t_\t_",
        "7\t關中\t關中\tPROPN\tn,名詞,固定物,地名\tCase=Loc|NameType=Geo\t6\tcomp:obj\t_\t_",
        "8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_",
        "",
      ].join("\n"),
    );
    const sentence = tree.sentences[0];
    const wu = sentence.tokens.find((t) => t.text === "吾")!;
    expect(resolve(wu, sentence).reading).toBe("わ");
    expect(prose(sentence)).toContain("吾が爲に");
  });
});

describe("其 as an attributive determiner is そ + ノ", () => {
  it("splits the reading at the particle, the way 以 splits at もつ + て", () => {
    const entry = findOverride("其", "PRON", "det");
    expect(entry?.reading).toBe("そ");
    expect(entry?.okurigana).toBe("の");
  });

  it("reads a clause-heading 其 as the same determiner", () => {
    // `subj` joined `det` on that entry: a 其 heading a clause is its
    // possessor — 其爲人也 is 其**の**人と爲りや — and over kanbun.info's
    // 178,468 characters of 書き下し文 其の stands 1,412 times against 其れ 104.
    const entry = findOverride("其", "PRON", "subj");
    expect(entry?.reading).toBe("そ");
    expect(entry?.okurigana).toBe("の");
  });

  it("leaves the stand-alone pronoun それ undivided", () => {
    // 其 read それ is a pronoun and not a determiner+particle pair, so there
    // is no ending in it to write beside the character. Asked on a relation no
    // entry names, which is what the char-only entry is for; the 104 real
    // occurrences of the word reach it through
    // `presentativeDemonstrativeReading`, on the 與/歟 that marks the frame.
    const entry = findOverride("其", "PRON", "discourse");
    expect(entry?.reading).toBe("それ");
    expect(entry?.okurigana).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The word class a KANJIDIC2 kun'yomi states in its own shape — the general
// form of a rule this codebase had been rediscovering one case at a time.
// ---------------------------------------------------------------------------

describe("kunWordClass", () => {
  it("calls an undotted reading nominal — a noun or an adverb", () => {
    expect(kunWordClass("なか")).toBe("nominal"); // 中
    expect(kunWordClass("まさに")).toBe("nominal"); // 応
    expect(kunWordClass("ひつじ")).toBe("nominal"); // 未
  });

  it("calls a 終止形 u-sound ending a verb, every row of it", () => {
    for (const kun of ["あた.る", "ま.つ", "もと.める", "こた.える", "まな.ぶ", "なら.う", "は.づ", "ま.ず"]) {
      expect(kunWordClass(kun), kun).toBe("verb");
    }
  });

  it("strips the affix hyphen before reading the dot — a bound form is still a word", () => {
    expect(kunWordClass("-ごと.に")).toBe("unstated");
    expect(kunWordClass("し.に-")).toBe("unstated");
    expect(kunWordClass("こ-")).toBe("nominal");
  });

  it("calls a dot at the very end a verb — 種's supplementary う.", () => {
    // ワ行下二段 種う: the 終止形 is the bare stem mora, so the okurigana after
    // the dot is empty and the dot is the whole of what marks the word
    // inflecting. See `SUPPLEMENTARY_KUN`.
    expect(kunWordClass("う.")).toBe("verb");
  });

  it("stops at 'i-final' rather than claiming an adjective, which is the trap", () => {
    // Both of these are い-final dotted kun'yomi, and only one is an
    // adjective: KANJIDIC2 writes a 連用形 nominal the same way. Nothing in the
    // shape separates 深's ふか.い from 扱's あつか.い, so nothing here does.
    expect(kunWordClass("ふか.い")).toBe("i-final");
    expect(kunWordClass("あつか.い")).toBe("i-final");
    expect(kunWordClass("む.かい")).toBe("i-final");
    expect(kunWordClass("たの.しい")).toBe("i-final");
  });

  it("says nothing about the endings that state nothing", () => {
    // 連用形 nominals, adverbs, ナリ活用 stems, and the classical adjectives and
    // auxiliaries KANJIDIC2 spells out in full.
    for (const kun of ["の.み", "ひら.き", "もっ.て", "まこと.に", "やす.らか", "あ.し", "べ.し"]) {
      expect(kunWordClass(kun), kun).toBe("unstated");
    }
  });

  it("classes the whole shipped index, and the counts are the ones documented", () => {
    // The measurement the rule's own doc quotes, re-run here so the two cannot
    // drift: a fresher KANJIDIC2 that moves these numbers should move the doc
    // with them rather than pass silently.
    const counts: Record<string, number> = { nominal: 0, verb: 0, "i-final": 0, unstated: 0 };
    for (const entry of Object.values(kanjidic)) for (const kun of entry.kun) counts[kunWordClass(kun)]++;
    expect(counts).toEqual({ nominal: 7687, verb: 6447, "i-final": 1134, unstated: 768 });
  });

  it("agrees with the split-form answer everywhere, since one delegates to the other", () => {
    for (const entry of Object.values(kanjidic)) {
      for (const kun of entry.kun) {
        const bare = kun.replace(/^-|-$/g, "");
        const dot = bare.indexOf(".");
        expect(splitKunWordClass(dot === -1 ? undefined : bare.slice(dot + 1)), kun).toBe(kunWordClass(kun));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The paradigm a dictionary attests where the modern ending states none.
// ---------------------------------------------------------------------------

describe("attestedClassicalParadigm", () => {
  it("answers for the あ-row -eru endings the row tables refuse", () => {
    // JMdict holds 答ふ under its classical headword and labels it
    // 下二段ハ行 outright, so こた + える is answered without any derivation
    // from the modern え at all.
    expect(attestedClassicalParadigm(jmdict, "こた", "える")).toBe("shimo-nidan-ha");
    expect(attestedClassicalParadigm(jmdict, "き", "える")).toBe("shimo-nidan-ya"); // 消ゆ
    expect(attestedClassicalParadigm(jmdict, "う", "える")).toBe("shimo-nidan-wa"); // 植う / 飢う
    expect(attestedClassicalParadigm(jmdict, "むく", "いる")).toBe("kami-nidan-ya"); // 報ゆ / 酬ゆ
  });

  it("abstains where two classical words share one modern spelling", () => {
    // 老ゆ (ヤ行上二段, おゆ) and 生ふ (ハ行上二段, おう) both surface as おいる
    // today — the very -iru ambiguity `LEXICAL_KUN` documents, arriving from
    // the other side. Two paradigms, so no answer; 老's own comes from the verb
    // lexicon, which is asked first.
    expect(attestedClassicalParadigm(jmdict, "お", "いる")).toBeUndefined();
  });

  it("abstains where the two sources divide the word in different places", () => {
    // 肥's こ.やす and JMdict's 肥やす are the same string joined and the same
    // word, split as こ + やす and こや + す — the や is an `okuriganaPrefix`,
    // which this answer has no room to carry, and a class returned on that
    // evidence would have written 肥す for 肥やす.
    expect(attestedClassicalParadigm(jmdict, "こ", "やす")).toBeUndefined();
  });

  it("abstains where the dictionary holds no classical entry for the word", () => {
    expect(attestedClassicalParadigm(jmdict, "ふる", "える")).toBeUndefined(); // 顫
    expect(attestedClassicalParadigm(jmdict, "し", "いる")).toBeUndefined(); // 強ふ, unlisted
    expect(attestedClassicalParadigm(jmdict, "もち", "いる")).toBeUndefined(); // 用ゐる, unlisted
  });

  it("answers 覺's おぼ.える, whose paradigm neither the shape rule nor JMdict states", () => {
    // The character this whole fallback was built for and could not reach. A
    // bare える states no row (ア行/ヤ行/ワ行 下二段 all spell themselves that way
    // today), so the shape rule abstains; JMdict holds only the modern 一段
    // 覚える and no classical headword, so it abstains too. 覺ゆ is ヤ行下二段, and
    // it is the verb lexicon that now says so.
    expect(classicalConjClass("える", { lemma: "覺", reading: "おぼ" })).toBeUndefined();
    expect(attestedClassicalParadigm(jmdict, "おぼ", "える")).toBeUndefined();
    expect(attestedSenseByModernSpelling("覺", "おぼ", "える")?.conjClass).toBe("shimo-nidan-ya");
    expect(attestedSenseByModernSpelling("覚", "おぼ", "える")?.conjClass).toBe("shimo-nidan-ya");
  });

  it("keeps 覚ます behind 覺ゆ rather than in place of it", () => {
    // RESIDUAL is prepended to a kanji's derived senses, never substituted for
    // them, so adding the 覺ゆ this app needs must not cost the さます the build
    // script derived — a real word, and the one a 覺 that actually reads さ
    // wants. Both are in the list; 覺ゆ is merely the one that leads.
    expect(LEXICON_SENSES["覺"]?.map((sense) => sense.reading)).toEqual(["おぼ", "さ"]);
    expect(VERB_LEXICON["覺"]?.conjClass).toBe("shimo-nidan-ya");
    // さ + ます, not さ + さます: the ま is that sense's own `okuriganaPrefix`,
    // so the kanji covers さ alone and 覚ます is what the two halves join to.
    expect(attestedSenseByModernSpelling("覺", "さ", "ます")?.conjClass).toBe("yodan-sa");
  });

  it("reaches the coverage its own doc claims, over the whole shipped index", () => {
    // Where every verb kun'yomi in KANJIDIC2 gets its paradigm from, in the
    // order the resolver asks: the ending's own shape, then the project's
    // `verb-lexicon-index.json`, then JMdict's classical entries, then nowhere.
    // Pinned so a fresher index moves the docs with it rather than silently.
    const counts = { shape: 0, verbLexicon: 0, jmdictArchaic: 0, uncovered: 0 };
    for (const [char, entry] of Object.entries(kanjidic)) {
      for (const raw of entry.kun) {
        if (kunWordClass(raw) !== "verb") continue;
        const bare = raw.replace(/^-|-$/g, "");
        const dot = bare.indexOf(".");
        const reading = bare.slice(0, dot);
        const okurigana = bare.slice(dot + 1);
        if (classicalConjClass(okurigana, { lemma: char, reading })) counts.shape++;
        else if (attestedSenseByModernSpelling(char, reading, okurigana)?.conjClass) counts.verbLexicon++;
        else if (attestedClassicalParadigm(jmdict, reading, okurigana)) counts.jmdictArchaic++;
        else counts.uncovered++;
      }
    }
    // 170, not 168: 覺 and 覚's おぼ.える are the two the ヤ行下二段 覺ゆ sense
    // added to `RESIDUAL` moved out of `uncovered` and into this column.
    //
    // 181, not 170: `attestedSenseByModernSpelling` now compares the *reading*
    // modernly too, not only the okurigana, and eleven KANJIDIC2 verb kun'yomi
    // reach a lexicon sense that was there all along under its 歴史的仮名遣い
    // spelling — 加's くわ.える to くは 下二段ハ行, 携's たずさ.える to たづさ,
    // 顧's かえり.みる to かへり 上一段, 静/靜's しず.まる to しづ, and 貯's
    // たくわ.える to the たくは this table was extended for. Every one of the
    // eleven is the same word under two spellings; none is a new claim.
    //
    // 189, not 181: the six 下二段 senses added to `RESIDUAL` for the words a
    // modern -eru spelling hides (傳ふ, 事ふ, 構ふ, 添ふ, 與ふ, 絶ゆ) account for
    // **exactly eight** KANJIDIC2 verb kun'yomi, each of which moved out of
    // `uncovered` and into this column — 伝/傳 つた.える, 与/與 あた.える,
    // 事 つか.える, 構 かま.える, 添 そ.える and 絶 た.える, both spellings of the
    // two characters this treebank writes in 旧字体 counting separately. The
    // eight are enumerated rather than merely counted so that the next person
    // to see this number move can tell a deliberate addition from a drift:
    // nothing else in those senses reaches this census, because
    // `modernOkurigana` of ハ行下二段 is える exactly and of ヤ行下二段 likewise,
    // so 事's own つか.う and 絶's た.やす/た.つ match no sense of theirs.
    //
    // 191, not 189: the two `RESIDUAL` entries added for the words the causative
    // gate exposed — 遣 (四段サ行 つか + `okuriganaPrefix` は, 遣はす) and 調
    // (下二段ハ行 ととの, 調ふ) — account for **exactly two** KANJIDIC2 verb
    // kun'yomi, 遣 つか.わす and 調 ととの.える, and both moved out of `uncovered`
    // (1,005 -> 1,003) rather than off any other column. Enumerated for the same
    // reason the eight above are: nothing else in those two senses reaches this
    // census. 遣's other kun (つか.う, や.る) belong to 使ふ and 遣る and match no
    // sense of this one, and 調's しら.べる/ととの.う likewise — `modernOkurigana`
    // of 四段サ行 with a は prefix is わす exactly, and of ハ行下二段 is える.
    //
    // 192, not 191: the 上一段 省みる added to `RESIDUAL` for 論語 學而 4
    // (かへり + `okuriganaPrefix` み) accounts for **exactly one** KANJIDIC2 verb
    // kun'yomi — 省's own かえり.みる — which moved out of `uncovered`
    // (1,003 -> 1,002) rather than off any other column, and moved for the same
    // reason 顧's identical かえり.みる already sat here. Enumerated for the
    // reason the ten above are: nothing else in that sense reaches this census,
    // 省's other kun はぶ.く being 省く's word and matching no sense of this one.
    // The two other senses corrected alongside it reach the census not at all —
    // 慍's いきどほる is a reading KANJIDIC2 does not list for the character
    // (its kun are いか.る/いか.り/うら.む), and 愛's サ変 あいする is on'yomi,
    // which this census does not walk.
    expect(counts).toEqual({ shape: 5196, verbLexicon: 192, jmdictArchaic: 57, uncovered: 1002 });
  });

  it("reads no paradigm off a modern label, which states none", () => {
    // 答える is an "Ichidan verb" in JMdict, and 一段 today was 上一段 or 二段
    // classically with nothing in the label to say which. Only the archaic
    // entries are read.
    expect(attestedClassicalParadigm(jmdict, "こた", "えるる")).toBeUndefined();
    expect(attestedClassicalParadigm(jmdict, undefined, "える")).toBeUndefined();
    expect(attestedClassicalParadigm(null, "こた", "える")).toBeUndefined();
  });
});

describe("isModernIchidanLemma", () => {
  it("rules out the 四段 a one-kana ending would otherwise be guessed to be", () => {
    expect(isModernIchidanLemma(jmdict, "視る", "みる")).toBe(true);
    expect(isModernIchidanLemma(jmdict, "煮る", "にる")).toBe(true);
  });

  it("says nothing about a word that really is 四段", () => {
    expect(isModernIchidanLemma(jmdict, "習う", "ならう")).toBe(false);
    expect(isModernIchidanLemma(jmdict, "有る", "ある")).toBe(false);
  });

  it("requires the entry to be the entry for that reading", () => {
    expect(isModernIchidanLemma(jmdict, "視る", "しる")).toBe(false);
    expect(isModernIchidanLemma(jmdict, "見ない候補", "みない")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A kanji-retained adverb's okurigana is KANJIDIC2's own dot
// ---------------------------------------------------------------------------
//
// `KANJI_RETAINED_ADVERBS` names a character and the word it is when it keeps
// its kanji; where that word divides between the furigana slot and the
// okurigana slot is read out of the dictionary by `retainedAdverbOkurigana`.
// This is what stops the two from drifting apart. The failure it exists for
// happened once already: the division was hand-copied from the dictionary's dot
// notation, 嘗's て was lost on the way in, and the character rendered カツテ
// beside a bare 嘗 with no furigana over it at all, on a reading KANJIDIC2
// divides perfectly well.
//
// Walked over the table itself rather than over a written-out list of
// characters, so that a further entry cannot be added without being measured
// — and asked of the dictionary directly (`dictionaryRetainedAdverbOkurigana`)
// for the residue, so that a KANJIDIC2 rebuild that *gains* an entry for 固 or
// 益 is reported as the residue shrinking rather than passing unnoticed.
describe("a kanji-retained adverb divides where KANJIDIC2 divides it", () => {
  const historicalKana = loadRealIndex<HistoricalKanaIndex>("historical-kana-index.json");

  /** What the two panels and the furigana menu write beside each character —
   * the whole of what this arrangement must keep producing, and the same
   * eighteen values the table itself used to hold, plus 與/与's asserted に and
   * 蓋's dictionary-derived し. */
  const WRITTEN: Record<string, string> = {
    亦: "た", 皆: "", 尚: "ほ", 猶: "ほ", 且: "つ", 甚: "だ", 必: "ず", 更: "に", 悉: "く",
    但: "し", 獨: "り", 独: "り", 豈: "に", 固: "より", 益: "", 嘗: "て", 曾: "て", 曽: "て",
    與: "に", 与: "に", 蓋: "し",
  };

  it("measures every entry of the table and no others", () => {
    expect(Object.keys(WRITTEN).sort()).toEqual(Object.keys(KANJI_RETAINED_ADVERBS).sort());
  });

  it("writes the same okurigana beside each of them as before the dictionary was asked", () => {
    for (const char of Object.keys(KANJI_RETAINED_ADVERBS)) {
      expect(retainedAdverbOkurigana(kanjidic, char, historicalKana), char).toBe(WRITTEN[char]);
    }
  });

  it("takes twelve of the twenty-one from the dictionary, which agrees with all twelve", () => {
    // Not a list of characters: an entry that stops asserting an okurigana
    // joins this set on its own, and an entry that starts asserting one leaves
    // it, and either way the count below says so out loud.
    const derived = Object.entries(KANJI_RETAINED_ADVERBS)
      .filter(([, adverb]) => adverb.okurigana === undefined)
      .map(([char]) => char);
    expect(derived).toHaveLength(12);
    for (const char of derived) {
      expect(dictionaryRetainedAdverbOkurigana(kanjidic, char, historicalKana), char).toBe(WRITTEN[char]);
    }
  });

  it("asserts the residue, and the dictionary really cannot supply it", () => {
    const residue = Object.entries(KANJI_RETAINED_ADVERBS)
      .filter(([, adverb]) => adverb.okurigana !== undefined)
      .map(([char, adverb]) => [char, adverb.okurigana, dictionaryRetainedAdverbOkurigana(kanjidic, char, historicalKana)])
      .sort();
    expect(residue).toEqual([
      // 豈 and 曽 are the *undotted* kind: KANJIDIC2 spells the word — あに,
      // かつて — but writes no dot in it, so its division is the whole reading
      // over the character and this app's 豈ニ / 曽テ is its own claim. (曽's
      // traditional twin 曾 is filed かつ.て and derives; the simplified form
      // was indexed less carefully, which is a fact about the data file.)
      ["豈", "に", ""],
      ["曽", "て", ""],
      // 亦, 尚 and 猶 are the same undotted kind, and are the three the received
      // reading moved: KANJIDIC2 files 亦 as また and 尚/猶 as なお, all three
      // whole, so the dictionary's division puts the word over the character
      // and nothing beside it. kanbun.info writes 亦た on **121** of 121 and
      // 猶ほ on 36 of 43, so 亦タ / 猶ホ is this app's own claim exactly as 豈ニ
      // is.
      ["亦", "た", ""],
      ["尚", "ほ", ""],
      ["猶", "ほ", ""],
      // 與/与 are the undotted kind too, and the commonest of it: KANJIDIC2
      // files 與's kun as あた.える / あずか.る / くみ.する / **ともに**, the last
      // undivided, so the dictionary spells the comitative adverb and states no
      // boundary in it. 與(とも)ニ is this app's own claim, exactly as 豈ニ is.
      ["與", "に", ""],
      ["与", "に", ""],
      // 固 and 益 are the *absent* kind: KANJIDIC2's 固 is かた.める/かた.まる/
      // かた.まり/かた.い and its 益 is ま.す, so もとより and ますます are not in
      // it at all and there is no entry to read a dot off.
      ["固", "より", undefined],
      ["益", "", undefined],
    ].sort());
  });

  it("needs the historical-kana fold to recognise なほ at all", () => {
    // KANJIDIC2 files 尚 and 猶 as なお and this app writes なほ, so the
    // comparison is made after `historicalKun` and would match nothing before
    // it. The one place in this derivation where the orthographies have to be
    // brought together.
    expect(dictionaryRetainedAdverbOkurigana(kanjidic, "尚", historicalKana)).toBe("");
    expect(dictionaryRetainedAdverbOkurigana(kanjidic, "猶", historicalKana)).toBe("");
    expect(dictionaryRetainedAdverbOkurigana(kanjidic, "尚")).toBeUndefined();
    expect(dictionaryRetainedAdverbOkurigana(kanjidic, "猶")).toBeUndefined();
  });

  it("settles a character with two candidate kun by the dot", () => {
    // 更 is filed both さら and さら.に and 悉 both ことごと and ことごと.く. Only
    // one of each joins to the word the table names, and it is the dotted one.
    expect(kanjidic["更"].kun).toEqual(expect.arrayContaining(["さら", "さら.に"]));
    expect(kanjidic["悉"].kun).toEqual(expect.arrayContaining(["ことごと", "ことごと.く"]));
    expect(dictionaryRetainedAdverbOkurigana(kanjidic, "更", historicalKana)).toBe("に");
    expect(dictionaryRetainedAdverbOkurigana(kanjidic, "悉", historicalKana)).toBe("く");
  });

  it("names each word in the spelling overrides.json prints, where there is an entry", () => {
    // The reading is the one piece of hand data left, and it is not free-hand:
    // for sixteen of the nineteen it is the very string the override table
    // states, which is what the page shows. 必 and 更 have no override entry at
    // all — their readings come straight from KANJIDIC2 by the ordinary
    // kanjidic path, which is also why they are two of the three the table
    // cannot borrow.
    //
    // 蓋 is the third and is a different case: it *has* an entry (けだし, the
    // same string) and this lookup cannot see it, because the entry is keyed
    // `contextPos: ["PART"]` while this asks as ADV/`mod`. That keying is the
    // parser's doing rather than a claim about the word — the sentence-initial
    // 推量 adverb arrives PART/`discourse` in all 67 of its gold tokens, never
    // ADV — and the entry's own gloss records bounding it away from the noun
    // ふた and the verb おほふ on exactly that tag. So the reading agrees; only
    // the role this test asks under does not.
    const noOverride: string[] = [];
    for (const [char, adverb] of Object.entries(KANJI_RETAINED_ADVERBS)) {
      const override = findOverride(char, "ADV", "mod");
      if (!override) noOverride.push(char);
      else expect(override.reading, char).toBe(adverb.reading);
    }
    expect(noOverride).toEqual(["必", "更", "蓋"]);
  });

  it("attaches the division to every token of a listed character, not only to the adverb", () => {
    // Deliberate, and unchanged: the answer is a property of the word the table
    // names, so a 猶 the parser tagged VERB (reading ごとし, a different word)
    // carries なほ's division exactly as it carried the table's value before.
    const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);
    const asVerb = makeToken({ text: "猶", lemma: "猶", pos: "VERB", dep: "ROOT" });
    expect(resolve(asVerb, { tokens: [asVerb] }).reading).toBe("ごとし");
    expect(resolve(asVerb, { tokens: [asVerb] }).retainedAdverbOkurigana).toBe("ほ");
    const notListed = makeToken({ text: "學", lemma: "學", pos: "VERB", dep: "ROOT" });
    expect(resolve(notListed, { tokens: [notListed] }).retainedAdverbOkurigana).toBeUndefined();
  });

  it("is refused on that token by the gate, which is what the panels ask", () => {
    // This paragraph used to say the branches refuse it "on their own evidence —
    // `retainedAdverbParts` because ごとし does not end in ''". They did not, and
    // the sentence was wrong on its own terms: an empty okurigana is
    // `retainedAdverbParts`' first case and returns the whole reading, so a 猶
    // read ごとし was drawn as a retained adverb with nothing beside it — the
    // bare character, the word nowhere on the page. 待猶君也 printed 君を**猶**.
    // Measured over the gold, 37 sentences did that.
    //
    // `retainedAdverbApplies` is the test that was missing, and it is one test
    // rather than each panel's own: this token is a retained adverb only if it
    // resolved to the *word* the table names, and ごとし is not なほ.
    const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);
    const asVerb = makeToken({ text: "猶", lemma: "猶", pos: "VERB", dep: "ROOT" });
    const resolved = resolve(asVerb, { tokens: [asVerb] });
    expect(retainedAdverbApplies("猶", resolved)).toBe(false);
    // …and the division it *would* have made, had nothing asked, is now no
    // division at all: 猶's ending is ほ since the received reading was
    // counted, and ごとし does not end in ほ, so `retainedAdverbParts` refuses
    // it on its own evidence as well. (It used to return the whole reading
    // with an empty ending, which is what drew the bare character.)
    expect(retainedAdverbParts(resolved.reading, resolved.retainedAdverbOkurigana)).toBeUndefined();
    // The adverb itself still passes, on the same call.
    const asAdverb = makeToken({ text: "猶", lemma: "猶", pos: "ADV", dep: "mod" });
    expect(retainedAdverbApplies("猶", resolve(asAdverb, { tokens: [asAdverb] }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classifier modification: a quantity and the classifier counting it are one
// 音読み熟語, the first character bare and the ending on the second.
// ---------------------------------------------------------------------------

describe("a classifier and what it counts are read as one on'yomi word", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  /** 行千里 as the parser returns it: the quantity heads the clause and the
   * classifier hangs off it by `clf` — the reverse of the `mod` direction
   * every other pair in this file runs. */
  const counted = (
    quantity: string,
    quantityPos: string,
    classifier: string,
    opts: { dep?: string; gap?: boolean } = {},
  ): Sentence => ({
    tokens: [
      makeToken({ id: 0, text: quantity, lemma: quantity, pos: quantityPos, dep: "ROOT", head: 0 }),
      ...(opts.gap ? [makeToken({ id: 1, text: "之", lemma: "之", pos: "SCONJ", dep: "mod", head: 0 })] : []),
      makeToken({
        id: opts.gap ? 2 : 1,
        text: classifier,
        lemma: classifier,
        pos: "NOUN",
        dep: opts.dep ?? "clf",
        head: 0,
        morph: "NounType=Clf",
      }),
    ],
  });
  const readings = (s: Sentence) => s.tokens.map((t) => resolve(t, s).reading);

  it("reads 千里 せんり, where it read ちさと", () => {
    // The reader's headline case, and the reason it failed is the direction of
    // the edge: `modifierHeadPair` reads modifier -> head and a `clf` runs
    // head -> classifier, so neither of its two searches ever saw the pair.
    // 三年, which this parser labels `mod` rather than `clf`, was already
    // さんねん — one relation reached the rule and the other could not.
    expect(readings(counted("千", "NUM", "里"))).toEqual(["せん", "り"]);
  });

  it("moves the okurigana off the first character and onto the second", () => {
    // The user's own words for what a 熟語 does. The quantity is half of one
    // word and carries `endingComplete`, so nothing its own morph says can put
    // an ending inside the compound; the classifier keeps the ordinary ending
    // machinery, so あり / を / the copula still attach after the pair.
    const s = counted("千", "NUM", "里");
    expect(resolve(s.tokens[0], s)).toMatchObject({ reading: "せん", endingComplete: true });
    expect(resolve(s.tokens[0], s).okurigana).toBeUndefined();
    expect(resolve(s.tokens[1], s).endingComplete).toBeUndefined();
  });

  it("puts no POS condition on the quantity — the relation is the claim", () => {
    // 1,392 of gold's 1,472 `clf` heads are NUM and 73 are NOUN, and the NOUN
    // ones are as much Sino-Japanese words as the numerals: 數仞 すうじん,
    // 餘歲 よさい. Admitting only NUM would drop exactly the pairs a reader
    // would notice.
    expect(readings(counted("數", "NOUN", "仞"))).toEqual(["すう", "じん"]);
  });

  it("requires the classifier to stand immediately after what it counts", () => {
    // 1,439 of the 1,472 do. A pair the reader does not see as contiguous
    // kanji is not one to fuse a reading across — the same condition the `mod`
    // pairs and `findCompoundSpans` both make.
    expect(readings(counted("千", "NUM", "里", { gap: true }))[2]).toBe("さと");
  });

  it("reads no pair off a relation that is not the classifier's", () => {
    // The bound. `comp:obj` under a quantity is what this parser wrongly gives
    // 厚半寸 and 去首半尺 (see the `NounType=Clf` case below), and it must not
    // be admitted here — that would be reading a compound off an edge that
    // does not claim one.
    expect(readings(counted("千", "NUM", "里", { dep: "comp:obj" }))[1]).toBe("さと");
  });
});

describe("the counting on'yomi is not always KANJIDIC2's first", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);
  const numeral = (num: string, noun: string): string[] => {
    const tokens = [
      makeToken({ id: 0, text: num, lemma: num, pos: "NUM", dep: "mod", head: 1 }),
      makeToken({ id: 1, text: noun, lemma: noun, pos: "NOUN", dep: "ROOT", head: 1 }),
    ];
    return tokens.map((t) => resolve(t, { tokens }).reading);
  };

  it("agrees with itself about 人 — 三人 さんにん and 一人 いちにん", () => {
    // The inconsistency `CLASSIFIER_ONYOMI` closes, and it was visible in the
    // app: 三人 is a JMdict headword read さんにん and came out right through
    // the dictionary, while 一人 — whose JMdict entry is the kun ひとり and is
    // correctly refused — fell to the per-character fallback and took 人's
    // *first* on'yomi, printing いちじん. One counter, two spellings, decided
    // by whether the numeral happened to be lexicalized.
    expect(numeral("三", "人")).toEqual(["さん", "にん"]);
    expect(numeral("一", "人")).toEqual(["いち", "にん"]);
  });

  it("takes the measure reading of 畝 and 石", () => {
    // 畝's list is ボウ/ホ/モ/ム and the area measure is ホ (百畝 ひゃっぽ);
    // 石's is セキ/シャク/コク and the volume measure is コク (一石 いっこく).
    expect(numeral("百", "畝")).toEqual(["ひやく", "ほ"]);
    expect(numeral("一", "石")).toEqual(["いち", "こく"]);
  });

  it("leaves a classifier whose first on'yomi is already the counter alone", () => {
    // 915 of the 1,472 have exactly one on'yomi and nothing to choose; of the
    // rest the first is usually right, which is why the table has three
    // entries and not thirty-eight.
    expect(numeral("三", "年")).toEqual(["さん", "ねん"]);
    expect(numeral("三", "日")).toEqual(["さん", "にち"]);
  });
});

describe("a quantifier that is not a numeral still makes one word of a classifier", () => {
  const historicalKana = loadRealIndex<Record<string, Record<string, string>>>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);
  const quantified = (q: string, qPos: string, clf: string, clfMorph = "NounType=Clf"): string[] => {
    const tokens = [
      makeToken({ id: 0, text: q, lemma: q, pos: qPos, dep: "mod", head: 1, morph: "Degree=Pos" }),
      makeToken({ id: 1, text: clf, lemma: clf, pos: "NOUN", dep: "ROOT", head: 1, morph: clfMorph }),
    ];
    return tokens.map((t) => resolve(t, { tokens }).reading);
  };

  it("reads 半寸 はんすん, off the head's own NounType=Clf", () => {
    // 厚半寸 in gold: 半 is VERB `v,動詞,描写,量` standing `mod` on 寸, and 寸
    // carries `NounType=Clf`. As an ordinary `modifier` pair it needed a
    // dictionary that has no 半寸, so 半 fell through to its kun'yomi and was
    // read as a *predicate* — なかば, with its own okurigana — which is what
    // split the measure phrase in two.
    expect(quantified("半", "VERB", "寸")).toEqual(["はん", "すん"]);
  });

  it("gives the quantifier no okurigana of its own", () => {
    // The half of the reader's request that 半 was failing: なかば carried a
    // バ, and half of one word carries nothing.
    const tokens = [
      makeToken({ id: 0, text: "半", lemma: "半", pos: "ADJ", dep: "mod", head: 1, morph: "Degree=Pos" }),
      makeToken({ id: 1, text: "尺", lemma: "尺", pos: "NOUN", dep: "ROOT", head: 1, morph: "NounType=Clf" }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "はん", endingComplete: true });
    expect(resolve(tokens[0], { tokens }).okurigana).toBeUndefined();
    expect(resolve(tokens[1], { tokens }).reading).toBe("しやく");
  });

  it("needs the feature — a plain noun head still needs the dictionary", () => {
    // Without `NounType=Clf` the pair is an ordinary `modifier` and the gate
    // stands: 半種 is not a word and 半 keeps its own reading.
    expect(quantified("半", "VERB", "種", "_")[0]).not.toBe("はん");
  });

  it("refuses a nominal modifier, which is a genitive and not a count", () => {
    // Of the 13 non-NUM modifiers standing `mod` before a `NounType=Clf` head
    // in gold, 10 are NOUN or PROPN and none of them is counting anything —
    // 城方八里 is 城の方, 周尺 is 周の尺. The admission is restricted to a
    // quantifier-like modifier for exactly that reason.
    expect(quantified("城", "NOUN", "方")[0]).not.toBe("じやう");
  });
});
