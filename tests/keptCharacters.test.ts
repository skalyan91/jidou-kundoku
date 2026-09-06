import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { auxiliaryFormFor, isNamingUse, selectedForm } from "../src/kakikudashi/conjugationContext.ts";
import { retainedAuxiliaryParts } from "../src/kakikudashi/bungoConjugation.ts";
import { rereadCharacter, rereadFirstParts } from "../src/kakikudashi/rereadCharacters.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findOverride } from "../src/reading/overridesLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";

// ---------------------------------------------------------------------------
// **Which characters survive into the 書き下し文, and where each word's kanji
// ends.** Two rulings of the reader's, measured against kanbun.info's own
// 書き下し文 over the 624 gold passages of `tests/fixtures` — the tier whose
// parses come from the Kyoto treebank, so that a difference there is this app's
// and not a parser's.
//
//  1. **曰く, not 曰はく.** The whole of いは goes over the character and only
//     the く is written beside it.
//  2. **Keep the character where the received text keeps it**, decided per
//     curated entry rather than per character or per table.
//
// The instrument for the second is a count, and the distribution it produced is
// what makes the criterion a criterion rather than a cutoff chosen to fit: over
// those passages, counting each character in the 白文 against its survivals into
// the received reading, 以 is 217/217, 其 282/282, 則 119/119, 可 143/143, 吾
// 108/108, 所 77/77, 未 56/56, 無 126/126 — against 也 0/480, 矣 0/156, 乎
// 3/133, 而 28/329, 不 42/543. There is no middle: the only two entries near it
// are 何 99/100 and 諸 46/47, and both fall on the keep side. The line the two
// halves fall on is the word — **a particle is a morpheme the Japanese sentence
// supplies and its character has no place in the prose, while a word the
// character names keeps its character with only the ending beside it** — and it
// is the same line `chosenSpellsOutInProse` draws for a pinned reading and
// `KANJI_RETAINED_ADVERBS` for the adverbs.
//
// Everything here goes through `parseConllu` on verbatim gold, and asserts
// **both panels** on every claim: an okurigana boundary that moves in the prose
// and not in the ruby is one character of one text saying two things.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const historicalKana = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

function sentence(conllu: string): Sentence {
  const tree = parseConllu(conllu);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

function prose(s: Sentence): string {
  return generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })), resolve);
}

function at(s: Sentence, text: string) {
  return s.tokens.find((t) => t.text === text)!;
}

/** 子曰：「里仁爲美。 — 論語 里仁, gold, verbatim. */
const MASTER_SAID = `1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\tGloss=master|SpaceAfter=No
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\tGloss=say|SpaceAfter=No
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\tSpaceAfter=No
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\tSpaceAfter=No
5\t里\t里\tVERB\tv,動詞,行為,設置\t_\t7\tsubj\t_\tGloss=place|SpaceAfter=No
6\t仁\t仁\tNOUN\tn,名詞,描写,態度\t_\t5\tcomp:obj\t_\tGloss=benevolence|SpaceAfter=No
7\t為\t爲\tAUX\tv,動詞,存在,存在\tVerbType=Cop\t2\tcomp:obj\t_\tGloss=be|SpaceAfter=No
8\t美\t美\tNOUN\tn,名詞,描写,形質\t_\t7\tcomp:pred\t_\tGloss=beauty|SpaceAfter=No
9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t7\tpunct\t_\tSpaceAfter=No
`;

/** 名曰淫祀。 — the *naming* use, gold, verbatim. Not a quotation: 曰 here is
 * the plain verb いふ and conjugates, which is why one lexicon entry has to
 * hold two boundaries. */
const NAMED = `1\t名\t名\tNOUN\tn,名詞,不可譲,属性\t_\t2\tsubj\t_\tGloss=name|SpaceAfter=No
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\tGloss=say|SpaceAfter=No
3\t淫\t淫\tADJ\tv,動詞,描写,態度\tDegree=Pos|VerbForm=Part\t4\tmod\t_\tGloss=excessive|SpaceAfter=No
4\t祀\t祀\tNOUN\tn,名詞,制度,儀礼\t_\t2\tcomp:obj\t_\tGloss=sacrifice|SpaceAfter=No
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\tSpaceAfter=No
`;

/** 不可以長處樂。 — 論語 里仁, gold, verbatim. Holds the negated modal and a
 * modifier 以 in one sentence. */
const CANNOT_DWELL = `1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\tGloss=not|SpaceAfter=No
2\t可\t可\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\tGloss=possible|SpaceAfter=No
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t2\tmod\t_\tGloss=use|SpaceAfter=No
4\t長\t長\tADJ\tv,動詞,描写,量\tDegree=Pos\t3\tcomp:obj\t_\tGloss=long|SpaceAfter=No
5\t處\t處\tVERB\tv,動詞,行為,設置\t_\t2\tcomp:aux\t_\tGloss=place|SpaceAfter=No
6\t樂\t樂\tNOUN\tn,名詞,描写,態度\t_\t5\tcomp:obj\t_\tGloss=joy|SpaceAfter=No
7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\tSpaceAfter=No
`;

/** 夕死可矣。」 — 論語 里仁, gold, verbatim. The unnegated 終止形, so that the
 * split is asserted on more than one form of the same paradigm. */
const MAY_DIE = `1\t夕\t夕\tNOUN\tn,名詞,時,*\tCase=Tem\t2\tmod@tmod\t_\tGloss=evening|SpaceAfter=No
2\t死\t死\tVERB\tv,動詞,変化,生物\t_\t3\tsubj\t_\tGloss=die|SpaceAfter=No
3\t可\t可\tADJ\tv,動詞,描写,態度\tDegree=Pos\t0\troot\t_\tGloss=permissible|SpaceAfter=No
4\t矣\t矣\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\tGloss=[PFV]
5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No
`;

/** 父母之年 — the genitive 之, gold, verbatim (the 子曰：「父母之年，不可不知也。
 * of 論語 里仁, cut at its comma). The one entry in the table's own 之 family
 * that stays in kana. */
const PARENTS_YEARS = `1\t父\t父\tNOUN\tn,名詞,人,関係\t_\t3\tcomp:obj\t_\tGloss=father|SpaceAfter=No
2\t母\t母\tNOUN\tn,名詞,人,関係\t_\t1\tflat\t_\tGloss=mother|SpaceAfter=No
3\t之\t之\tSCONJ\tp,助詞,接続,属格\t_\t4\tmod\t_\tGloss='s|SpaceAfter=No
4\t年\t年\tNOUN\tn,名詞,時,*\tCase=Tem\t0\troot\t_\tGloss=year|SpaceAfter=No
`;

describe("曰く, and where the fixed reading's kanji ends", () => {
  it("writes 曰く in the prose and 曰(いは)ク in the 訓読文", () => {
    // The reader's ruling, following the received text: 曰(いわ)く on
    // kanbun.info and the same division in 新釈漢文大系. It was the largest
    // single disagreement anywhere in the gold tier — **615 occurrences across
    // 419 of the 624 passages** — and moving it is one substitution and nothing
    // else: over the 68,893 treebank sentences, 6,006 change and every one of
    // them is 曰はく -> 曰く.
    const s = sentence(MASTER_SAID);
    expect(prose(s)).toContain("子曰く");
    expect(prose(s)).not.toContain("曰はく");
    // Both panels, on the same token. The okurigana is the entry's
    // `fixedReading` — the string `KundokuView.ts`'s lexicon branch writes
    // beside the character under this very gate — and the furigana is
    // `furiganaFor`'s, which is what that branch draws above it.
    const said = at(s, "曰");
    expect(isNamingUse(said, s)).toBe(false);
    expect(VERB_LEXICON["曰"].fixedReading).toBe("く");
    expect(furiganaFor(said, s, resolve, historicalKana, kanjidic)).toBe("いは");
  });

  it("leaves the naming 曰 conjugating on its own stem — 名曰淫祀 is 曰ふ", () => {
    // Why the entry needs two fields and not one. 名曰淫祀 is not a quotation:
    // 曰 is the plain 四段ハ行 verb and its stem is い, so a `reading` moved to
    // いは to serve the quotative would print 曰(いは)ふ here. `fixedFurigana`
    // is stated separately for exactly this token.
    const s = sentence(NAMED);
    const named = at(s, "曰");
    expect(isNamingUse(named, s)).toBe(true);
    expect(prose(s)).toContain("曰ふ");
    expect(furiganaFor(named, s, resolve, historicalKana, kanjidic)).toBe("い");
  });
});

describe("the auxiliary whose character the prose keeps", () => {
  it("writes 可からず in the prose and 可(べ)カラ in the 訓読文", () => {
    // 可 stands in the received 書き下し文 on **143 of the 143** occurrences in
    // the gold's own 白文, and it stands divided — 可きなり 20, 可からず 20,
    // 可からざ 17, 可し 10, 可きか 10. The modal branch used to drop its kanji
    // with the rest of them; see `KANJI_RETAINED_AUXILIARIES`.
    const s = sentence(CANNOT_DWELL);
    expect(prose(s)).toContain("可からず");
    expect(prose(s)).not.toContain("べからず");
    // The 訓読文 half, assembled from the functions that panel's own auxiliary
    // branch calls.
    const may = at(s, "可");
    const form = selectedForm(auxiliaryFormFor(may, s)!, computeReadingOrder(s), may.id);
    expect(form.text).toBe("べから");
    expect(retainedAuxiliaryParts(may.lemma, form.text)).toEqual({ reading: "べ", okurigana: "から" });
  });

  it("does the same for the 終止形 — 夕死可矣 is 可し", () => {
    const s = sentence(MAY_DIE);
    expect(prose(s)).toContain("可し");
    const may = at(s, "可");
    const form = selectedForm(auxiliaryFormFor(may, s)!, computeReadingOrder(s), may.id);
    expect(retainedAuxiliaryParts(may.lemma, form.text)).toEqual({ reading: "べ", okurigana: "し" });
  });

  it("keeps every other auxiliary in kana, which is what the received text does", () => {
    // **可 alone**, and the bound is measured rather than assumed. 能 is read
    // あたはず or よく by the received text and never べし (能わざる 10, 能く之を
    // 7, 能わず 6, of 75), so keeping its character under the same `POTENTIAL`
    // paradigm would print 能し. 欲 is read as the verb 欲す, not as まほし
    // (欲する 7, 欲す 6, 欲すれば 6, of 40). Neither is a division of the form
    // this table could state; both are different words, and belong to whatever
    // rule decides the word.
    expect(retainedAuxiliaryParts("能", "べし")).toBeUndefined();
    expect(retainedAuxiliaryParts("欲", "まほし")).toBeUndefined();
    expect(retainedAuxiliaryParts("使", "しむ")).toBeUndefined();
    // And the guard that is also the fallback: a form the stated reading does
    // not begin is left undivided, so a paradigm this table has not been
    // checked against writes itself out in kana rather than being cut in a
    // place nobody has looked at.
    expect(retainedAuxiliaryParts("可", "まほし")).toBeUndefined();
    expect(retainedAuxiliaryParts("可", "べ")).toBeUndefined();
  });
});

describe("`spellOutInProse`, per entry and not per character", () => {
  it("keeps 以 and writes its ending beside it — 不可以長處樂 is 以て", () => {
    const s = sentence(CANNOT_DWELL);
    expect(prose(s)).toContain("以て");
    expect(prose(s)).not.toContain("もつて");
    const yi = at(s, "以");
    const resolved = resolve(yi, s);
    expect(resolved.spellOutInProse).toBe(false);
    // The two slots, unchanged by the flag and asserted so that they cannot be
    // confused with it: もつ has always gone over the character and て beside
    // it. What moved is only whether the character reaches the prose.
    expect(resolved.reading).toBe("もつ");
    expect(resolved.okurigana).toBe("て");
    expect(furiganaFor(yi, s, resolve, historicalKana, kanjidic)).toBe("もつ");
  });

  it("still writes the genitive 之 の in kana — 父母之年 is 父母の年", () => {
    // The entry-by-entry case in one character, and the reason the flag cannot
    // be per character. 之 stands in the received text on 333 of the 560
    // occurrences in the gold's own 白文: the pronoun keeps it (之れ 18, 之を
    // 239, 之に 53) and the genitive does not. The two are separate entries and
    // now say separate things.
    const s = sentence(PARENTS_YEARS);
    expect(prose(s)).toBe("父母の年");
    expect(resolve(at(s, "之"), s).spellOutInProse).toBe(true);
    expect(findOverride("之", "SCONJ", "mod")?.spellOutInProse).toBeUndefined();
  });

  it("is opt-out and defaults to spelling out, which is what the table did", () => {
    // Every entry the gold does not measure keeps the behaviour it had. The
    // flag is absent on those, and absent means kana — so an entry added later
    // and never counted cannot silently start keeping its character.
    expect(findOverride("也", "PART", "discourse@sp")?.spellOutInProse).toBeUndefined();
    expect(findOverride("乎", "PART", "discourse@sp")?.spellOutInProse).toBeUndefined();
    // The default in action is the genitive 之 above, which carries no flag and
    // comes back `spellOutInProse` all the same.
  });
});

/** 我未見力不足者。 — 論語 里仁, gold, verbatim. */
const NEVER_SEEN = `1\t我\t我\tPRON\tn,代名詞,人称,止格\tPerson=1|PronType=Prs\t3\tsubj\t_\tGloss=[1PRON]|SpaceAfter=No
2\t未\t未\tADV\tv,副詞,否定,有界\tPolarity=Neg\t3\tmod\t_\tGloss=not-yet|SpaceAfter=No
3\t見\t見\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\tGloss=see|SpaceAfter=No
4\t力\t力\tNOUN\tn,名詞,不可譲,身体\t_\t6\tsubj\t_\tGloss=strength|SpaceAfter=No
5\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t6\tmod\t_\tGloss=not|SpaceAfter=No
6\t足\t足\tADJ\tv,動詞,描写,量\tDegree=Pos\t7\tmod\t_\tGloss=sufficient|SpaceAfter=No
7\t者\t者\tPART\tp,助詞,提示,*\t_\t3\tcomp:obj\t_\tGloss=that-which|SpaceAfter=No
8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\tSpaceAfter=No
`;

/** 擇不處仁，焉得知 — 論語 里仁, gold, verbatim (its trailing 」？ dropped, which
 * touches nothing this asserts). */
const HOW_WISE = `1\t擇\t擇\tVERB\tv,動詞,行為,動作\t_\t7\tmod\t_\tGloss=pick-out|SpaceAfter=No
2\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t3\tmod\t_\tGloss=not|SpaceAfter=No
3\t處\t處\tVERB\tv,動詞,行為,設置\t_\t1\tconj:coord\t_\tGloss=place|SpaceAfter=No
4\t仁\t仁\tNOUN\tn,名詞,描写,態度\tShared=No\t3\tcomp:obj\t_\tGloss=benevolence|SpaceAfter=No
5\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\tSpaceAfter=No
6\t焉\t焉\tADV\tv,副詞,疑問,所在\t_\t7\tmod\t_\tGloss=where|SpaceAfter=No
7\t得\t得\tAUX\tv,助動詞,可能,*\tMood=Pot\t0\troot\t_\tGloss=must|SpaceAfter=No
8\t知\t知\tVERB\tv,動詞,行為,動作\t_\t7\tcomp:aux\t_\tGloss=know|SpaceAfter=No
`;

describe("where a kept character's kanji ends", () => {
  // Keeping a character does not by itself divide its reading, and nine entries
  // came out of the first pass one kana short of the received text — 未 against
  // 未だ, 何 against 何ぞ, 焉んぞ against 焉くんぞ. Each division below was
  // measured on its own, by rendering the 624 gold passages with that one entry
  // divided against a baseline re-rendered immediately before.

  it("writes 未だ in both panels — the panels used to disagree about this one", () => {
    // **The disagreement came first and the distance second.** `KundokuView.ts`
    // has always drawn a 再読文字's first reading *over* the character and kept
    // the character; `generator.ts` wrote the same reading as bare kana and
    // dropped it, so 未 was 未[いまだ] in the 訓読文 against a bare いまだ in the
    // 書き下し文. The received text agrees with the panel: 未 stands on **56 of
    // the 56** occurrences in the gold's own 白文, written 未だ. −96 edits over
    // the gold, 41 passages closer and none further.
    const s = sentence(NEVER_SEEN);
    expect(prose(s)).toBe("我未だ力足りぬ者見ず");
    expect(rereadFirstParts(rereadCharacter("未")!)).toEqual({ reading: "いま", okurigana: "だ" });
  });

  it("writes 焉くんぞ, correcting a division rather than adding one", () => {
    // The odd one of the nine: 焉 already had an okurigana and split it a kana
    // early. The received text writes 焉くんぞ 18 times in the gold and 焉くにか
    // 3, and no 焉んぞ at all. −21 edits, 16 passages closer and none further.
    const s = sentence(HOW_WISE);
    expect(prose(s)).toContain("焉くんぞ");
    const yan = resolve(at(s, "焉"), s);
    expect(yan.reading).toBe("いづ");
    expect(yan.okurigana).toBe("くんぞ");
    expect(furiganaFor(at(s, "焉"), s, resolve, historicalKana, kanjidic)).toBe("いづ");
    // 安 and 惡 are the same word and take the same division, which is what
    // `isInterrogativeBinder` compares against — it joins the two slots, so
    // moving the boundary inside the word leaves the 係り結び untouched.
    expect(findOverride("安", "ADV", "mod")?.okurigana).toBe("くんぞ");
    expect(findOverride("惡", "ADV", "mod")?.okurigana).toBe("くんぞ");
  });

  it("leaves the three the measurement refused, and for reasons that are not spelling", () => {
    // **毋 +20 and 莫 +12.** Both are correct as spellings — the received text
    // writes 毋かれ and 莫し — and both make the gold *worse*, because the app
    // reads these characters in front of the clause they negate where the
    // received text postposes them (毋己に如かぬ者 against 己に如かざる者を友と
    // する毋かれ). An okurigana added there lengthens a word that is in the
    // wrong place. The fix is the reading order, not the division.
    expect(findOverride("毋", undefined, undefined)?.okurigana).toBeUndefined();
    expect(findOverride("莫", "ADV", "mod")?.okurigana).toBeUndefined();
    // **諸 もろもろの +12**, and this one must not be divided at all: the の is
    // already written, by `caseParticleFor` on the token's own `det`/`mod`
    // relation, and `ownReadingSuppliesCaseParticle` cannot withhold it because
    // that stand-down declines a content-word POS and this entry is tagged
    // NOUN/DET. Dividing the reading printed 諸のの侯.
    expect(findOverride("諸", "NOUN", "det")?.okurigana).toBeUndefined();
  });

  it("divides the six the measurement took", () => {
    // Stated as a table so that the list is one thing and not six: 諸 −15,
    // 何 −12, 唯 −11, 寧 −3, 若 −1, beside 焉's −21 above.
    expect(findOverride("諸", "ADP", "comp:obj")).toMatchObject({ reading: "これ", okurigana: "を" });
    expect(findOverride("何", "ADV", "mod")).toMatchObject({ reading: "なん", okurigana: "ぞ" });
    expect(findOverride("唯", undefined, undefined)).toMatchObject({ reading: "た", okurigana: "だ" });
    expect(findOverride("寧", undefined, undefined)).toMatchObject({ reading: "むし", okurigana: "ろ" });
    expect(findOverride("若", undefined, undefined)).toMatchObject({ reading: "ごと", okurigana: "し" });
  });
});
