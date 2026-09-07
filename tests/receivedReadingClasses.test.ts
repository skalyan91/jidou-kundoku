import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { caseParticleFor, yuParts } from "../src/kakikudashi/conjugationContext.ts";
import { findOverride } from "../src/reading/overridesLookup.ts";
import { clearChosenReading, setChosenReading } from "../src/reading/chosenReading.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import type { Sentence, Token } from "../src/parse/types.ts";

// ---------------------------------------------------------------------------
// **The classes the received reading moved**, one describe each.
//
// `tests/kanbunInfoCorpus.test.ts` measures this app against kanbun.info's own
// 書き下し文 over 3,419 passages and holds the total to a ratchet. A ratchet
// records that a number went down; it does not say *what* went down, and a
// number cannot be read back as a rule. So every class of difference that was
// closed against that corpus is written here as the sentence that showed it,
// with the count that justified the change beside it — 論語 學而's own lines
// wherever the class occurs in them, since that is the passage the census was
// read from.
//
// The counts quoted are occurrences in kanbun.info's 書き下し文 (178,468
// characters) or edits over the corpus, and each is repeated in the doc comment
// of the rule it belongs to. Here they are the reason the expectation reads as
// it does; there they are the reason the code does.
// ---------------------------------------------------------------------------

const DATA = join(process.cwd(), "public", "data");
const load = <T,>(f: string): T => JSON.parse(readFileSync(join(DATA, f), "utf-8")) as T;
const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
const jmdict = load<JmdictIndex>("jmdict-index.json");
const historical = load<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historical);

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });
const sentenceOf = (tokens: Token[]): Sentence => ({ tokens });
const prose = (s: Sentence): string => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })), resolve);

/** A one-adverb clause: the adverb, then a predicate for it to modify. */
const adverbial = (lemma: string, pos: string, xpos: string, verb: string, verbXpos: string): Sentence =>
  sentenceOf([
    tok({ id: 0, text: lemma, lemma, pos, xpos, dep: "mod", head: 1 }),
    tok({ id: 1, text: verb, lemma: verb, pos: "VERB", xpos: verbXpos, dep: "ROOT", head: 1 }),
  ]);

describe("an adverb the received text writes with its kanji keeps it, and its ending", () => {
  // Each pair is the count in kanbun.info's own 書き下し文 of the character
  // followed by that okurigana, against the kana spelling: the site writes
  // 亦た 121 times and また 0, 凡そ 146 and およそ 0, 既に 60 and すでに 0,
  // 或いは 75, 敢えて 77, 復た 36, 猶ほ 36. The app wrote a bare 亦 and a bare
  // 復, and spelled the other four out in kana.
  it.each([
    ["亦", "ADV", "v,副詞,頻度,重複", "亦た"],
    ["凡", "ADV", "v,副詞,範囲,総括", "凡そ"],
    ["既", "ADV", "v,副詞,時相,完了", "既に"],
    ["或", "ADV", "v,副詞,判断,推定", "或いは"],
    ["敢", "ADV", "v,副詞,態度,*", "敢へて"],
  ])("writes %s as %s", (char, pos, xpos, written) => {
    expect(prose(adverbial(char, pos, xpos, "學", "v,動詞,行為,動作"))).toContain(written);
  });

  it("writes 猶 as 猶ほ where it is the adverb", () => {
    // 猶's two words share a character: なほ ("still") keeps its kanji with ほ
    // beside it, and ごとし is a different word this ending must not reach —
    // `retainedAdverbApplies` is the gate, and it asks the resolved reading.
    // See `reading.test.ts` for the gate's own tests.
    expect(prose(adverbial("猶", "ADV", "v,副詞,時相,継続", "學", "v,動詞,行為,動作"))).toContain("猶ほ");
  });

  it("states 復's ending in the table, which is where that one is reached from", () => {
    // 復た 36 in the received reading against no bare 復 in this sense, and
    // KANJIDIC2 files the character as an undotted また — the same residue 亦
    // is. Asserted on the table rather than through the prose because the
    // reading 復 resolves to depends on the parse it stands in (a bare ADV in
    // isolation is claimed by the on'yomi ふく first); over the kanbun.info
    // corpus the entry reaches **64** occurrences.
    expect(findOverride("復")?.okurigana).toBe("た");
    expect(findOverride("復")?.spellOutInProse).toBe(false);
  });
});

describe("於/于/乎 — に is the default and より is the comparison", () => {
  /** X 於 Y, with 於 hanging off the predicate exactly as the treebank hangs it. */
  const yu = (adp: string, verb: string, verbXpos: string, verbPos = "VERB", verbMorph?: string): Sentence =>
    sentenceOf([
      tok({ id: 0, text: verb, lemma: verb, pos: verbPos, xpos: verbXpos, dep: "ROOT", head: 0, ...(verbMorph ? { morph: verbMorph } : {}) }),
      tok({ id: 1, text: adp, lemma: adp, pos: "ADP", xpos: "v,前置詞,基盤,*", dep: "mod@lmod", head: 0 }),
      tok({ id: 2, text: "事", lemma: "事", pos: "NOUN", xpos: "n,名詞,可搬,成果物", dep: "comp:obj", head: 1, morph: "Case=Loc" }),
    ]);

  it("writes に for a plain verb's 於, which is 736 of the corpus's 821", () => {
    // The app defaulted to より and the received reading says に **200** times
    // against no class the other way — 49 edits on gold parses and 151 on
    // parsed ones. 敏於事 is 事**に**敏, never 事より敏.
    const s = yu("於", "問", "v,動詞,行為,伝達");
    expect(yuParts(s.tokens[1], s)).toEqual({ okurigana: "に" });
    expect(prose(s)).toBe("事に問ふ");
  });

  it("keeps より for a descriptive predicate, which is the comparison", () => {
    // The treebank's own 描写 class, and its `Degree=Pos` feature: 82 of the
    // 821 於 in the corpus's parses are governed by one and 0 of the 599 plain
    // VERB governors carry it. 賢於生也 is 生**より**賢なり.
    const s = yu("於", "賢", "v,動詞,描写,態度", "ADJ", "Degree=Pos");
    expect(yuParts(s.tokens[1], s)).toEqual({ okurigana: "より" });
  });

  it("keeps より for a source verb — 勸學's own line", () => {
    const s = yu("於", "取", "v,動詞,行為,得失");
    expect(yuParts(s.tokens[1], s)).toEqual({ okurigana: "より" });
  });

  it("reads 于 as に, the third spelling of the one postposition", () => {
    // 乎 has carried an ADP -> に entry all along and 於 is answered by
    // `yuParts`; 于 reached neither and printed as a bare character, where the
    // received reading has に **19** times.
    const s = yu("于", "至", "v,動詞,行為,移動");
    expect(prose(s)).toBe("事に至る");
    expect(prose(yu("乎", "至", "v,動詞,行為,移動"))).toBe("事に至る");
  });
});

describe("the verbs whose complement is marked に and never を", () => {
  const governs = (verb: string, verbXpos: string, object: string): Sentence =>
    sentenceOf([
      tok({ id: 0, text: verb, lemma: verb, pos: "VERB", xpos: verbXpos, dep: "ROOT", head: 0 }),
      tok({ id: 1, text: object, lemma: object, pos: "NOUN", xpos: "n,名詞,人,関係", dep: "comp:obj", head: 0 }),
    ]);

  it("marks 事's complement に — 事父母 is 父母に事ふ", () => {
    // 論語 學而 7. The particle written before 事 in kanbun.info's 書き下し文
    // is に 72 times against を 7, and the 7 are the noun 「事」.
    const s = governs("事", "v,動詞,行為,役割", "父");
    expect(caseParticleFor(s.tokens[1], s)).toBe("に");
    expect(prose(s)).toBe("父に事ふ");
  });

  it("does the same for the rest of the list", () => {
    for (const [verb, xpos] of [["從", "v,動詞,行為,移動"], ["及", "v,動詞,行為,移動"], ["臨", "v,動詞,行為,姿勢"], ["歸", "v,動詞,行為,移動"], ["在", "v,動詞,存在,存在"]] as const) {
      const s = governs(verb, xpos, "民");
      expect(caseParticleFor(s.tokens[1], s), verb).toBe("に");
    }
  });

  it("leaves an ordinary transitive verb its を", () => {
    const s = governs("愛", "v,動詞,行為,態度", "民");
    expect(caseParticleFor(s.tokens[1], s)).toBe("を");
  });

  it("marks 謂's nominal complement と — 可謂孝矣 is 孝と謂ふ可し", () => {
    // 論語 學而 11. The particle before 謂 is と **200** times against を 35,
    // and the 35 are the other slot in the same frame (是**を**過ちと謂ふ),
    // which is a pronoun and which this rule stands down for.
    const s = governs("謂", "v,動詞,行為,伝達", "孝");
    expect(caseParticleFor(s.tokens[1], s)).toBe("と");
    const pronoun = sentenceOf([
      tok({ id: 0, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", dep: "comp:obj", head: 0, morph: "Person=3|PronType=Prs" }),
    ]);
    expect(caseParticleFor(pronoun.tokens[1], pronoun)).toBe("を");
  });
});

describe("之 between a subject and its predicate is the subject genitive", () => {
  /** 人之不己知 — 之 hangs off the predicate, so the relation is `subj`. */
  const subjectGenitive = (): Sentence =>
    sentenceOf([
      tok({ id: 0, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 1 }),
      tok({ id: 1, text: "之", lemma: "之", pos: "SCONJ", xpos: "p,助詞,接続,属格", dep: "subj", head: 3 }),
      tok({ id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" }),
      tok({ id: 3, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 3 }),
    ]);

  it("reads it の and leaves its object unmarked", () => {
    // 論語 學而 16, and 12's 禮之用. **451** tokens over the corpus's own
    // parses (SCONJ 332, PART 99, PRON 20) against 56 genuinely resumptive
    // `comp@expl`; without the entry every one of them read 人**を之れ**知らず.
    // Worth 203 gold edits and 642 parsed ones.
    const s = subjectGenitive();
    expect(caseParticleFor(s.tokens[0], s)).toBeUndefined();
    expect(prose(s)).toBe("人の知らず");
  });

  it("leaves the resumptive 之 alone — that one is これ and takes its own slot", () => {
    // 其斯之謂與's 之, which the treebank marks `comp@expl`.
    const s = sentenceOf([
      tok({ id: 0, text: "斯", lemma: "斯", pos: "PRON", xpos: "n,代名詞,指示,*", dep: "comp:obj", head: 2 }),
      tok({ id: 1, text: "之", lemma: "之", pos: "PRON", xpos: "n,代名詞,人称,止格", dep: "comp@expl", head: 2 }),
      tok({ id: 2, text: "謂", lemma: "謂", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 2 }),
    ]);
    expect(prose(s)).toBe("斯を之れ謂ふ");
  });
});

describe("其 heading a clause is 其の, except in the 「其れ…か」 frame", () => {
  /** 其爲人也 / 其爲仁之本與 — 其 as the clause's `subj`, with or without the
   * conjectural particle that marks the 推量 frame. */
  const heading = (final?: string): Sentence =>
    sentenceOf([
      tok({ id: 0, text: "其", lemma: "其", pos: "PRON", xpos: "n,代名詞,人称,標準", dep: "subj", head: 1 }),
      tok({ id: 1, text: "學", lemma: "學", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 1 }),
      ...(final ? [tok({ id: 2, text: final, lemma: final, pos: "PART", xpos: "p,助詞,句末,*", dep: "discourse@sp", head: 1 })] : []),
    ]);

  it("reads a bare clause-heading 其 as 其の", () => {
    // 其の 1,412 against 其れ 104 over kanbun.info's whole 書き下し文, and
    // 其爲人也 is 其**の**人と爲りや. Worth 25 gold edits and 173 parsed ones.
    expect(prose(heading())).toContain("其の");
  });

  it("reads it 其れ where a conjectural particle closes the clause", () => {
    // 其爲仁之本與 is 其**れ**仁の本なりや and 其斯之謂與 其**れ**斯を之れ謂ふか:
    // the 104 are this frame, and the particle is what marks it — both frames
    // wear `subj`. See `presentativeDemonstrativeReading`.
    for (const particle of ["與", "歟", "邪"]) {
      expect(prose(heading(particle)), particle).toContain("其れ");
    }
  });
});

describe("a clause under 曰/云 is a quote whether the edition brackets it or not", () => {
  /** 子曰、學而時習之 as kanbun.info prints it: no quotation marks anywhere. */
  const unbracketed: Sentence = {
    tokens: [
      tok({ id: 0, text: "子", lemma: "子", pos: "NOUN", xpos: "n,名詞,人,人", dep: "subj", head: 1 }),
      tok({ id: 1, text: "曰", lemma: "曰", pos: "VERB", xpos: "v,動詞,行為,伝達", dep: "ROOT", head: 1 }),
      tok({ id: 2, text: "學", lemma: "學", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:obj", head: 1 }),
    ],
  };

  it("reads 曰く first and closes the clause with と", () => {
    // The largest class in the whole comparison: **2,950 edits** over
    // kanbun.info's 2,795 parsed passages, where every 子曰 read 〜を曰ふ with
    // the frame stranded after the clause it introduces. 曰/云's clausal
    // complements are 96.3% bracketed in lzh-{train,dev,test} against 56.5%
    // for the rest of the 伝達 class, so the bracket is that corpus's
    // typographic convention and its absence is a fact about the edition. See
    // `isSpeechQuoteComplement` in `depClassification.ts`.
    // No 、 after the 曰く: the comma the received text writes there is the
    // source's own ： or 、, which this tree has not got.
    expect(prose(unbracketed)).toBe("子曰く學ぶと");
  });

  it("leaves the wider 伝達 class reading its complement as an object", () => {
    const asked: Sentence = { tokens: unbracketed.tokens.map((t) => (t.id === 1 ? { ...t, text: "謂", lemma: "謂" } : t)) };
    expect(prose(asked)).toBe("子學ぶを謂ふ");
  });
});

describe("而 set off behind a mark is 而して, and keeps its character", () => {
  /** 甲、而乙 — a 而 with a mark before it, which is what makes it a word
   * rather than an ending on the verb in front of it. */
  const bridged: Sentence = {
    tokens: [
      tok({ id: 0, text: "學", lemma: "學", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 }),
      tok({ id: 1, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 }),
      tok({ id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "mod", head: 3 }),
      tok({ id: 3, text: "習", lemma: "習", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "conj:coord", head: 0 }),
    ],
  };

  it("writes 而して and not しかも", () => {
    // The reader's earlier ruling was しかも and is withdrawn: follow the site.
    // Over kanbun.info's 書き下し文 而 stands 122 times of the 1,677 in its 白文
    // — a 置き字 92.7% of the time — and every one of the 122 keeps the
    // character: 而して 59, 而も 19, 而る… 18, 而ち 6, against しかも and しかして
    // in kana **zero**. See `SHIKASHITE` in `conjugationContext.ts`.
    // 學**び** and not 學ぶ: the tree still coordinates the two clauses, so the
    // first hands on in 連用中止法. What this test is about is the word after
    // the comma.
    expect(prose(bridged)).toBe("學び、而して習ふ");
  });

  it("leaves the plain て/して endings alone, which carry no 而 at all", () => {
    // No mark, so 而 is an ending on the word before it and the character is
    // not written — which is the 92.7% case and is unchanged.
    const plain: Sentence = { tokens: bridged.tokens.filter((t) => t.dep !== "punct") };
    expect(prose(plain)).toBe("學びて習ふ");
  });
});

describe("能 is the adverb 能く and the verb 能はず, not the auxiliary べし", () => {
  /** 能竭 / 不能竭 — 能 heads the clause with the predicate as its `comp:aux`,
   * which is how the treebank attaches it (338 of 404 in the corpus). */
  const able = (negated: boolean): Sentence => ({
    tokens: [
      ...(negated ? [tok({ id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" })] : []),
      tok({ id: 1, text: "能", lemma: "能", pos: "AUX", xpos: "v,助動詞,可能,*", dep: "ROOT", head: 1, morph: "Mood=Pot" }),
      tok({ id: 2, text: "竭", lemma: "竭", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "comp:aux", head: 1 }),
    ],
  });

  it("reads a positive 能 as 能く, in front of the predicate", () => {
    // 事父母能竭其力 (論語 學而 7) is 父母に事へ、**能く**其の力を竭くし. The
    // character is kept on all 407 of its occurrences in kanbun.info's prose
    // and よく in kana appears none; the app read 其の力を竭す**べし**.
    expect(prose(able(false))).toBe("能く竭す");
  });

  it("reads a negated 能 as 〜こと能はず, with the predicate in front of it", () => {
    // 「こと能わ」 stands 72 times in the received reading and no bare 能わ
    // follows a 終止形. See `isNegatedNengComplement`.
    expect(prose(able(true))).toBe("竭すこと能はず");
  });

  it("gives the auxiliary back where the reader pins べし on it", () => {
    // 能's entry in `AUXILIARY_LEMMAS` is kept for exactly this: a pin is
    // resolved through that table (`chosenAuxiliary`), and all three of the new
    // rules stand down on a stored reading — the reading, the position and the
    // こと.
    const pinned = able(true);
    setChosenReading(pinned.tokens[1], "べし");
    expect(prose(pinned)).toBe("竭すべからず");
    clearChosenReading(pinned.tokens[1]);
  });
});

describe("奈何 / 何如 is one word and reads in source order", () => {
  const idiom = (first: string, second: string, firstPos: string): Sentence => ({
    tokens: [
      tok({ id: 0, text: first, lemma: first, pos: firstPos, xpos: firstPos === "PRON" ? "n,代名詞,疑問,*" : "v,動詞,行為,分類", dep: firstPos === "PRON" ? "comp:obj" : "ROOT", head: firstPos === "PRON" ? 1 : 0, morph: firstPos === "PRON" ? "PronType=Int" : "Degree=Equ" }),
      tok({ id: 1, text: second, lemma: second, pos: second === "何" ? "PRON" : "VERB", xpos: second === "何" ? "n,代名詞,疑問,*" : "v,動詞,行為,分類", dep: second === "何" ? "comp:obj" : "ROOT", head: second === "何" ? 0 : 1, morph: second === "何" ? "PronType=Int" : "Degree=Equ" }),
    ],
  });

  it("leaves 奈何 in source order with nothing between the two characters", () => {
    // **43 occurrences** over the kanbun.info corpus read 何**を**奈 — the
    // interrogative made an object, jumped in front of its verb and marked
    // accusative. The received text writes 奈何 83 times, 何如 22 and 如何 37,
    // never with a particle in it. See `isIkanIdiom`.
    expect(prose(idiom("奈", "何", "VERB"))).toBe("奈何");
    expect(prose(idiom("如", "何", "VERB"))).toBe("如何");
  });

  it("gives the 如 of the idiom no adjectival ending", () => {
    // `COMPARATIVE_GOTOSHI` would otherwise inflect it as the comparison and
    // print 如**し**; 如 carries no kana at all on 72 of its 398 occurrences in
    // the received prose, and those 72 are this idiom and the 突如 suffix.
    expect(prose(idiom("如", "何", "VERB"))).not.toContain("し");
  });

  it("does the same for the preposed order, 何如", () => {
    expect(prose(idiom("何", "如", "PRON"))).toBe("何如");
  });
});

describe("a comparison's standard takes が where it is a clause", () => {
  const like = (standardPos: string): Sentence => ({
    tokens: [
      tok({ id: 0, text: "如", lemma: "如", pos: "VERB", xpos: "v,動詞,行為,分類", dep: "ROOT", head: 0, morph: "Degree=Equ" }),
      tok({ id: 1, text: "見", lemma: "見", pos: standardPos, xpos: standardPos === "VERB" ? "v,動詞,行為,動作" : "n,名詞,可搬,成果物", dep: "comp:obj", head: 0 }),
    ],
  });

  it("writes が after a predicate and の after a nominal", () => {
    // ごとし takes a 連体形 and the classical 連体格 after one is が: 如見 is
    // 見る**が**如し, 游魚**の**如し keeps its の. Over kanbun.info's prose 如 is
    // preceded by が 90 times and by の 105, and every one of the が follows a
    // 連体形 ending.
    expect(caseParticleFor(like("VERB").tokens[1], like("VERB"))).toBe("が");
    expect(caseParticleFor(like("NOUN").tokens[1], like("NOUN"))).toBe("の");
  });
});
