import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { findOverride } from "../src/reading/overridesLookup.ts";
import { type KanjidicIndex, lookupKanji, seriesAmbiguousReading } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex, lookupLemma } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver, unresolvedLog } from "../src/reading/readingResolver.ts";
import { compoundFurigana } from "../src/reading/compoundFurigana.ts";
import { chosenReadingParts, setChosenReading } from "../src/reading/chosenReading.ts";
import { caseParticleFor } from "../src/kakikudashi/conjugationContext.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
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

    const fallback = findOverride("之", "NOUN", "subj");
    expect(fallback?.reading).toBe("これ"); // char-only fallback entry
  });

  it("excludes an entry whose contextDep doesn't match, even if contextPos matches nothing better", () => {
    // 使 has a contextPos=[VERB,AUX] entry (しむ) and a bare fallback (つか + ふ).
    const withoutContext = findOverride("使", "NOUN", "subj");
    expect(withoutContext?.reading).toBe("つか");
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
    ["非", ["ADV", "mod"], ["NOUN", "conj:coord"], "あらず"], // 人非生而知之者 / 是非之心
    ["遂", ["ADV", "mod"], ["VERB", "ROOT"], "つひ"], // 遂去不復與言 / 其事遂矣
    ["惟", ["ADV", "mod"], ["VERB", "mod"], "ただ"], // 惟仁者能好人 / 思惟其事
    ["則", ["ADV", "mod"], ["NOUN", "comp:obj"], "すなは"], // 學而不思則罔 / 有物有則
    ["罔", ["ADV", "mod"], ["VERB", "ROOT"], "なし"], // 罔有不服 / 是罔民也
    ["竟", ["ADV", "mod"], ["VERB", "ROOT"], "つひ"], // 竟不能就 / 竟其業
    ["蓋", ["PART", "discourse"], ["NOUN", "subj"], "けだし"], // 蓋有之矣 / 車蓋
    ["由", ["ADV", "mod"], ["ADP", "mod"], "なほ"], // 王由足用為善 / 由此觀之
  ])("%s glosses the function word but not the content word", (char, fn, content, reading) => {
    expect(findOverride(char, fn[0], fn[1])?.reading).toBe(reading);
    expect(findOverride(char, content[0], content[1])).toBeNull();
  });

  it("由 stands down for the verb 'to follow' as well as the adposition", () => {
    // 必由之 / 言不由衷 — the 猶-loan なほ is the rarer of 由's senses, so it
    // gives way to both of the commoner ones rather than only to the ADP.
    expect(findOverride("由", "VERB", "ROOT")).toBeNull();
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
        makeToken({ id: 0, text: "毎", lemma: "每", pos: "VERB", dep: "mod", head: 1, morph: "Degree=Pos|VerbForm=Part" }),
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
      makeToken({ id: 0, text: "現", lemma: "現", pos: "VERB", dep: "ROOT", head: 0, morph: "Degree=Pos" }),
      makeToken({ id: 1, text: "德", lemma: "德", pos: "NOUN", dep: "comp:obj", head: 0 }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "あらは", okurigana: "す" });
  });

  it("does not put the question to a stative predicate with no object", () => {
    // 深 (VERB, Degree=Pos) in 竹林深し is the adjective 深し, not the
    // intransitive verb 深まる the transitivity check would otherwise reach.
    const tokens = [makeToken({ id: 0, text: "深", lemma: "深", pos: "VERB", dep: "ROOT", head: 0, morph: "Degree=Pos" })];
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

    const adjectival = makeToken({ id: 0, text: "佳", lemma: "佳", pos: "VERB", dep: "ROOT", head: 0, morph: "Degree=Pos" });
    expect(resolve(adjectival, { tokens: [adjectival] }).okurigana).toBeUndefined();
  });

  it("claims nothing where two attested senses share one modern spelling", () => {
    // 射 read い is attested 上一段 *and* 四段ラ行, and both write 射る today,
    // so the evidence does not identify the word. The derivation's own answer
    // stands rather than one of the two being picked at random — the same
    // abstention `attestedSense` makes on a tie.
    expect(verb("射", true).conjClass).toBe("yodan-ra");
  });

  it("derives nothing for an okurigana shape the row tables exclude", () => {
    // The same exclusions `classicalVerbEnding` documents, and for the same
    // reason: 見える could be ア行/ヤ行/ワ行下二段 and its bare え cannot say
    // which (見ゆ, in fact — not *見う), while 起こす is not a -eru/-iru verb
    // at all. Both keep the behaviour they had before the class existed
    // rather than being given a paradigm on a guess.
    expect(verb("見", false)).toMatchObject({ okurigana: "える", beatsLexicon: true });
    expect(verb("見", false).conjClass).toBeUndefined();
    const tokens = [
      makeToken({ id: 0, text: "起", lemma: "起", pos: "VERB", dep: "ROOT", head: 0 }),
      makeToken({ id: 1, text: "兵", lemma: "兵", pos: "NOUN", dep: "comp:obj", head: 0 }),
    ];
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
      makeToken({ id: 0, text: "佳", lemma: "佳", pos: "VERB", dep: "mod", head: 1, morph: "Degree=Pos" }),
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
      makeToken({ id: 1, text: "然", lemma: "然", pos: "VERB", dep: "ROOT", head: 1, morph: "Degree=Pos" }),
    ];
    expect(resolve(tokens[0], { tokens })).toMatchObject({ reading: "は", okurigana: "たして", spellOutInProse: true });
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

describe("a fused span JMdict lists as a する-verb", () => {
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

  it("keys on JMdict's part of speech, not on the tokens being a span", () => {
    // 游魚 ゆうぎょ is a JMdict headword too, and an identically-shaped span —
    // but a plain noun ("fish swimming about in water"), so it takes no ending
    // whatever. Being fused is not evidence of anything.
    const { tokens, carrier } = span("游", "VERB", "mod", "魚", "NOUN", "comp:obj");
    expect(resolve(carrier, { tokens }).suruCompound).toBeUndefined();
    expect(resolve(carrier, { tokens }).okurigana).toBeUndefined();
  });

  it("claims nothing for a span no dictionary lists (俯臥, 飲啄)", () => {
    for (const [a, b] of [["俯", "臥"], ["飲", "啄"]] as const) {
      const { tokens, carrier } = span(a, "VERB", "subj", b, "VERB", "flat@vv");
      expect(resolve(carrier, { tokens }).suruCompound).toBeUndefined();
    }
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
    const token = makeToken({ text: "遠", lemma: "遠", pos: "VERB", morph: "Degree=Pos" });
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
    const token = makeToken({ text: "遠", lemma: "遠", pos: "VERB", morph: "Degree=Pos" });
    setChosenReading(token, "とほ", "し");
    expect(endings(token)).toBe("し");
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
    // The prose still reads これ — both halves are written out there (see
    // `spellOutInProse`), so the split moves nothing but the annotation slot.
    expect(resolved.spellOutInProse).toBe(true);
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
    expect(resolved.okurigana).toBeUndefined();
  });
});

describe("其 as an attributive determiner is そ + ノ", () => {
  it("splits the reading at the particle, the way 以 splits at もつ + て", () => {
    const entry = findOverride("其", "PRON", "det");
    expect(entry?.reading).toBe("そ");
    expect(entry?.okurigana).toBe("の");
  });

  it("leaves the stand-alone pronoun それ undivided", () => {
    // 其 read それ is a pronoun and not a determiner+particle pair, so there
    // is no ending in it to write beside the character.
    const entry = findOverride("其", "PRON", "subj");
    expect(entry?.reading).toBe("それ");
    expect(entry?.okurigana).toBeUndefined();
  });
});
