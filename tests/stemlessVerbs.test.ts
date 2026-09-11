import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import type { Sentence, Token } from "../src/parse/types.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { inflectedReading } from "../src/kakikudashi/classicalConjugation.ts";

// ---------------------------------------------------------------------------
// **Verbs whose modern okurigana hides the classical paradigm**, which are one
// fault seen from two sides.
//
// KANJIDIC2 divides a verb at the modern okurigana boundary, and for a
// one-syllable classical verb that boundary is in the wrong place twice over.
// 得's classical paradigm is ア行下二段 え・え・**う**・**うる**・**うれ**・えよ,
// a word that is *all* ending and has no stem at all; KANJIDIC2 writes it
// え.る, the modern 下一段 得る, and puts a stem where classical Japanese has
// none. 觀's is 上一段 見る, whose whole stem is the one mora み; KANJIDIC2
// writes it み.る, which is the same shape a 四段ラ行 verb's division has, and
// the shape rule read it as one.
//
// The two go wrong in different places and are fixed in different places, and
// that is why they are one file rather than two. 得's *okurigana* was already
// right — ア行下二段 writes nothing in 未然/連用/終止 because the kanji covers
// the whole mora — and what was wrong was the **furigana**, frozen at the
// citation え where the 終止形 is 得(う). 觀's *both* were wrong: 四段ラ行 gave
// it a 連用形 觀り, and where the guard against that guess did fire it left the
// word with no paradigm at all and the panels printed 觀るて.
// ---------------------------------------------------------------------------

const DATA = join(process.cwd(), "public", "data");
const load = <T,>(f: string): T => JSON.parse(readFileSync(join(DATA, f), "utf-8")) as T;
const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
const jmdict = load<JmdictIndex>("jmdict-index.json");
const historical = load<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historical);

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "", head: 0, ...o });
const sentenceOf = (tokens: Token[]): Sentence => ({ tokens });
const planOf = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planOf(s), resolve);
const furigana = (s: Sentence, id: number): string | undefined =>
  furiganaFor(s.tokens.find((t) => t.id === id)!, s, resolve, historical, kanjidic, planOf(s));

/** `verb` with a 之 object, the verb closing the sentence. */
const closing = (lemma: string): Sentence =>
  sentenceOf([
    tok({ id: 0, text: lemma, lemma, dep: "ROOT", head: 0 }),
    tok({ id: 1, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 0 }),
  ]);

/** `verb` with a 之 object and a second predicate after it, so the verb is a
 * 連用形 rather than the sentence's close. */
const converb = (lemma: string): Sentence =>
  sentenceOf([
    tok({ id: 0, text: lemma, lemma, dep: "ROOT", head: 0, morph: "VerbForm=Conv" }),
    tok({ id: 1, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", morph: "Person=3|PronType=Prs", dep: "comp:obj", head: 0 }),
    tok({ id: 2, text: "樂", lemma: "樂", dep: "parataxis", head: 0, xpos: "v,動詞,描写,態度" }),
  ]);

describe("得 — ア行下二段, the paradigm with no stem", () => {
  // 論語 學而 10: 夫子溫、良、恭、儉、讓以得之。 The verb closes the sentence, so
  // it is a 終止形, and the 終止形 of 得 is う — 之を得(う)。 The app wrote the
  // 連用形 reading え over it, because a reading is one string per word here
  // and this is the one paradigm where the reading itself inflects.
  it("writes う over the character in the 終止形 and え in the 連用形", () => {
    expect(furigana(closing("得"), 0)).toBe("う");
    expect(furigana(converb("得"), 0)).toBe("え");
  });

  // The okurigana was never the problem and must not become one: ア行 has no
  // consonant of its own, so 未然/連用/終止 write nothing beside the character
  // (得ず, 得, 得), and only 連体/已然/命令 write る/れ/よ.
  it("keeps writing nothing beside the character", () => {
    expect(prose(closing("得"))).toBe("之を得");
  });

  // The substitution is on the reading's last mora, so a compound reading on
  // the same verb inflects with it (心得 is こころ + the cell), and a reading
  // that ends in neither of the two kana the paradigm ever spells is left
  // exactly as it stands.
  it("inflects the last mora and abstains on any other reading", () => {
    expect(inflectedReading("shimo-nidan-a", "こころえ", "rentai")).toBe("こころう");
    expect(inflectedReading("shimo-nidan-a", "こころえ", "renyou")).toBe("こころえ");
    expect(inflectedReading("shimo-nidan-a", "とく", "shuushi")).toBe("とく");
    expect(inflectedReading("yodan-ra", "ゆづ", "shuushi")).toBe("ゆづ");
  });
});

describe("觀 — 上一段, whose whole stem is the reading", () => {
  // 論語 011（01-11）父在觀其志: the received reading is 其の志を觀, a bare
  // 上一段 連用形. The shape rule read み.る as a 四段ラ行 stem and wrote 觀り;
  // `isModernIchidanLemma` is what rules that out, and `modernIchidanClass`
  // what it leaves standing.
  it("reads a bare 連用形, not the 四段's り", () => {
    expect(prose(converb("觀"))).toBe("之を觀て樂し");
    expect(prose(converb("觀"))).not.toContain("觀り");
  });

  // **The 旧字体 was half the fault and only half.** JMdict holds 観る and not
  // 觀る, and the guard was keyed on the spelling as written, so the kyūjitai
  // the source actually prints reached it not at all — 觀 took the 四段 guess
  // where the identical 観 was caught. But being caught was not being right:
  // ruling the 四段 out left 観 with no paradigm, and a converb then printed
  // 観るて. The two variants agree now because both are answered, not because
  // the fold alone was the fix.
  it("reads the 旧字体 and the 新字体 alike", () => {
    expect(prose(converb("観"))).toBe(prose(converb("觀")).replace("觀", "観"));
    expect(prose(converb("観"))).not.toContain("観るて");
  });

  // The other characters the same division reaches, all of them 上一段 verbs
  // whose stem is one い-row mora: 看/覽/覧/診 are みる and 烹 is にる.
  it.each([
    ["看", "之を看て樂し"],
    ["覽", "之を覽て樂し"],
    ["覧", "之を覧て樂し"],
    ["診", "之を診て樂し"],
    ["烹", "之を烹て樂し"],
  ])("reads %s as 上一段", (lemma, expected) => {
    expect(prose(converb(lemma))).toBe(expected);
  });
});
