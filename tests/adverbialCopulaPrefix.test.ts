import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Sentence } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import {
  conjugatedOkurigana,
  conjugationSubject,
  decideConjForm,
  lexiconEntryFor,
  nextMeaningfulToken,
} from "../src/kakikudashi/conjugationContext.ts";
import { VERB_LEXICON } from "../src/kakikudashi/verbLexicon.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

const parsed = (text: string): Sentence => parseConllu(text).sentences[0];
/** The panels' own call shape — `findCompoundSpans(sentence, { kanjidic, jmdict })`,
 * never the one-argument form. A harness that drops the indices renders a
 * different app from the one on screen, silently. */
const planFor = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence): string => generateKakikudashi(planFor(s), resolve);

/** What the 訓読文 draws over the character and beside it, assembled from the
 * very functions `KundokuView.ts`'s own lexicon branch calls (`furiganaFor`,
 * `lexiconEntryFor`, `decideConjForm`, `conjugatedOkurigana`) — so a test that
 * passes here and a panel that disagrees with it are not both possible. The
 * whole point of the `okuriganaPrefix` on 大 is that the two slots divide
 * おほ・いに between them, and that division is exactly what could come apart. */
function kundoku(s: Sentence, id: number): { furigana: string | undefined; okurigana: string } {
  const plan = planFor(s);
  const token = s.tokens.find((t) => t.id === id)!;
  const resolved = resolve(token, s);
  const lex = lexiconEntryFor(token, resolved, s)!;
  const form = decideConjForm(conjugationSubject(token, s), nextMeaningfulToken(plan, token.id), s, lex.conjClass, resolve);
  return { furigana: furiganaFor(token, s, resolve, historicalKana, kanjidic), okurigana: conjugatedOkurigana(lex, form) };
}

// ---------------------------------------------------------------------------
// 大 is おほ + い, and the prefix survives the resolver's 連用形.
//
// A ナリ活用形容動詞 whose conventional okurigana boundary starts before the
// class's own suffix carries the difference as an `okuriganaPrefix` — 大 is
// おほ + い + なり, which is KANJIDIC2's own division of the character (it lists
// `-おお.いに` among 大's kun). Every other rule in `readingResolver.ts` writes a
// *citation* form, so `attestedSense` matched a lexicon sense by comparing
// `conjugatedOkurigana(sense, "shuushi")` against whatever the resolver wrote.
// `adverbialCopulaEnding` is the one rule that writes an inflected form — an
// ADV-tagged 形容動詞 is in its 連用形 whatever the predicate turns out to be —
// so its いに was compared against いなり, matched no sense at all, and fell
// through to an entry synthesized from the *reading*, which carries no prefix
// by design. The い was dropped and 大 printed 大(おほ)に.
//
// The resolver now reports which form it wrote (`okuriganaForm`) and the match
// is made in it. Measured over
// `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
// against a baseline re-rendered immediately before: with the entry at だい the
// report changes **nothing at all** — 0 of 68,893 sentences move, the five
// ナリ/タリ senses in the lexicon being 仁, 賢, 大, 暴, 熾 and only 大 and 熾
// carrying a prefix — and 熾's ADV reading arrives with a kanjidic okurigana
// (さか + ん), which `adverbialCopulaEnding` declines outright. With the entry at
// おほ + い, **691** sentences change and every one of the 706 changes is the
// same inserted い: 402 大いに, 205 大いなり, 91 大いなる, 8 大いなら.
// ---------------------------------------------------------------------------

/** 無乃大簡乎」？ — gold sent_id KR1h0004_006_par2_29-33#1, verbatim. The
 * adverbial case: 大 is ADV with `VerbForm=Conv`, which is how all **616** of
 * the gold ADV 大 are tagged, and is what `isConverbUse` admits to the lexicon
 * dispatch — the very admission that put the token on the path where the prefix
 * was lost. */
const WU_NAI_DA_JIAN = `# sent_id = KR1h0004_006_par2_29-33#1
1\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t0\troot\t_\t_
2\t乃\t乃\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t4\tmod\t_\t_
3\t大\t大\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t4\tmod\t_\t_
4\t簡\t簡\tADJ\tv,動詞,描写,形質\tDegree=Pos\t1\tcomp:obj\t_\t_
5\t乎\t乎\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_

`;

/** 大哉居乎！ — gold sent_id KR1h0001_013_par36_1-6#4, verbatim. The attributive
 * case, and the control on the other side of the same entry: 大 is ADJ here,
 * reaches the lexicon by the ordinary `usesLexiconEntry` arm rather than by
 * `isConverbUse`, and never went through `adverbialCopulaEnding` at all. The
 * 終助詞 かな binds a 連体形 (see `EXCLAMATORY_PARTICLE_READINGS`), so what it
 * binds is なる and the whole ending is いなる. */
const DA_ZAI_JU_HU = `# sent_id = KR1h0001_013_par36_1-6#4
1\t大\t大\tADJ\tv,動詞,描写,量\tDegree=Pos\t0\troot\t_\t_
2\t哉\t哉\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
3\t居\t居\tNOUN\tn,名詞,固定物,建造物\tCase=Loc\t1\tdislocated\t_\t_
4\t乎\t乎\tPART\tp,助詞,句末,*\t_\t3\tdiscourse@sp\t_\t_

`;

/** The same adverbial frame on 熾, the lexicon's other prefixed ナリ sense
 * (さか + ん — 熾んなり). Not a gold sentence: 熾 is 6 gold tokens (ADJ 2,
 * PROPN 3, VERB 1) and none of them is ADV, so the frame is 無乃大簡乎's own
 * with the character swapped, which is what makes the two rows comparable. */
const SHI_JIAN = `1\t熾\t熾\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t2\tmod\t_\t_
2\t簡\t簡\tADJ\tv,動詞,描写,形質\tDegree=Pos\t0\troot\t_\t_

`;

describe("an adverbial ナリ活用形容動詞 keeps its okurigana prefix", () => {
  it("states 大 as おほ + い, the division KANJIDIC2 itself makes", () => {
    // The prefix is part of the *ending* and not of the reading, by this
    // table's own criterion for one: the conventional okurigana boundary
    // starts earlier than ナリ活用's own suffix. 少 (すく + な) and 說 (よろこ +
    // ば) are entered the same way.
    expect(VERB_LEXICON["大"]).toEqual({ conjClass: "nari-keiyoudoushi", okuriganaPrefix: "い", reading: "おほ" });
    expect(kanjidic["大"].kun).toContain("-おお.いに");
  });

  it("reports the 連用形 it wrote, so the sense can be matched in that form", () => {
    // The whole mechanism, at the one place it is visible. `adverbialCopulaEnding`
    // answers いに — prefix plus ナリ活用's own 連用形 — and says so; without the
    // report the ending is indistinguishable from a 終止形 seed, which is what
    // every other rule here writes and what the matcher assumes.
    const sentence = parsed(WU_NAI_DA_JIAN);
    const da = sentence.tokens.find((t) => t.text === "大")!;
    const resolved = resolve(da, sentence);
    expect(resolved.okurigana).toBe("いに");
    expect(resolved.okuriganaForm).toBe("renyou");
    expect(resolved.conjClass).toBe("nari-keiyoudoushi");
    // …and `beatsLexicon`, which is what routes the token through
    // `syntheticLexiconEntry` in the first place. Take this away and the plain
    // `VERB_LEXICON` path answers, which never lost the prefix.
    expect(resolved.beatsLexicon).toBe(true);
  });

  it("recovers the prefixed sense rather than synthesizing a bare one", () => {
    // `syntheticLexiconEntry` rebuilds an entry from the reading alone where
    // `attestedSense` finds nothing, and such an entry has no `okuriganaPrefix`
    // — that is deliberate and documented, a prefix being a typesetting fact no
    // per-character reading can reconstruct. So the entry coming back *with*
    // the prefix is the proof that the match succeeded.
    const sentence = parsed(WU_NAI_DA_JIAN);
    const da = sentence.tokens.find((t) => t.text === "大")!;
    expect(lexiconEntryFor(da, resolve(da, sentence), sentence)).toEqual({
      conjClass: "nari-keiyoudoushi",
      okuriganaPrefix: "い",
      reading: "おほ",
    });
  });

  it("prints 無乃大簡乎 as 大いに簡ぶ in both panels", () => {
    const sentence = parsed(WU_NAI_DA_JIAN);
    expect(prose(sentence)).toContain("大いに簡ぶ");
    expect(prose(sentence)).not.toContain("大に");
    // The 訓読文 divides the same string between its two slots: おほ over the
    // character, いに beside it. 大(おほ)に — the reading of nothing that this
    // work is about — would show up here as an okurigana of に.
    expect(kundoku(sentence, 2)).toEqual({ furigana: "おほ", okurigana: "いに" });
  });

  it("carries the prefix through the 連体形 too, where かな binds one", () => {
    // The attributive arm, which never touched the broken path — included so
    // that the two arms of one entry are pinned together and cannot drift into
    // spelling the same word two ways.
    const sentence = parsed(DA_ZAI_JU_HU);
    expect(prose(sentence)).toContain("大いなるかな");
    expect(kundoku(sentence, 0)).toEqual({ furigana: "おほ", okurigana: "いなる" });
  });

  it("leaves the four prefixless ナリ/タリ senses exactly as they were", () => {
    // The blast radius of the report, stated as the thing that bounds it: only
    // a *leading* ナリ/タリ sense can reach `adverbialCopulaEnding` at all, and
    // the lexicon holds five. For a sense with no prefix the match that now
    // succeeds returns an entry identical to the one synthesized when it
    // failed — same class, same reading — so nothing it touches can move, which
    // is why the report was measured at 0 changed sentences before the entry
    // was respelled.
    const nariOrTari = Object.entries(VERB_LEXICON).filter(
      ([, e]) => e.conjClass === "nari-keiyoudoushi" || e.conjClass === "tari-keiyoudoushi",
    );
    expect(new Set(nariOrTari.map(([k]) => k))).toEqual(new Set(["仁", "賢", "大", "暴", "熾"]));
    expect(new Set(nariOrTari.filter(([, e]) => e.okuriganaPrefix).map(([k]) => k))).toEqual(new Set(["大", "熾"]));
    // 熾 is the other prefixed one and is out of reach by a second door: its ADV
    // reading arrives with a kanjidic okurigana of its own (さか + ん), and
    // `adverbialCopulaEnding` declines any reading that came with one — a
    // 形容動詞 stem has none. So it reaches its prefix by the plain
    // `VERB_LEXICON` path and always did: 熾んに, never 熾に.
    const blazing = parsed(SHI_JIAN);
    expect(resolve(blazing.tokens[0], blazing).okuriganaForm).toBeUndefined();
    expect(kundoku(blazing, 0)).toEqual({ furigana: "さか", okurigana: "んに" });
  });
});
