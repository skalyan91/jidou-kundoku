import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Sentence, Token } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { compoundFurigana } from "../src/reading/compoundFurigana.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import {
  caseParticleFor,
  isPresentativeCopula,
  isPresentativeCopulaTopic,
  readsAsSentenceFinalWord,
  sentenceFinalParticleFor,
} from "../src/kakikudashi/conjugationContext.ts";

// ---------------------------------------------------------------------------
// **AB也者** — the topic-presenting frame, where 也 is the **copula standing
// attributively before the nominalizer 者** and not the sentence-final
// particle: 孝弟也者 is 孝弟なる者は, the reader's かうていなるものは.
//
// The reader's ruling is 孝悌也者 → **かうていなるものは**, and it has three
// separate parts, each of which was wrong for its own reason:
//
//  1. 孝弟 is the on'yomi **nominal** かうてい, not the サ変 verb 孝弟す. A
//     copula attaches to a 体言, and the parse says as much on its own account
//     — 孝 arrives `VerbForm=Part`.
//  2. 也 is the copula's **連体形 なる**, not the sentence-final なり and not
//     the 提示 や `overrides.json` gives a 也 on any other relation.
//  3. 者 reads **ものは** — the nominalizer with its topic は — which it only
//     did where the parse happened to hang the 也 off it by `mod`.
//
// **The corpus, which is what licenses the key.** Over
// `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
// 也 carries `p,助詞,句末,*` **7,197** times and `p,助詞,提示,*` **564**. Of the
// 564 presentative ones **80** stand immediately before a 者 (the rest are
// followed by 、229 times, then a scatter of 如/不/何/為/以…), and **all 80** of
// the 也 that stand before a 者 are presentative — no 句末 也 anywhere in the
// gold is followed by 者. So (XPOS, next token) separates the two uses cleanly
// and the tree is not needed, which is just as well: the tree does not separate
// them. The 80 wear `discourse@sp` 65, `mod` 8, `comp:obj` 4 and one each of
// `conj:coord`/`comp:pred`/`comp:aux`, and `discourse@sp` is the relation that
// everywhere *else* means the assertive なり.
//
// See `isPresentativeCopula` in `conjugationContext.ts` for the rule and for
// what the four call sites spend it on.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const historicalKana = JSON.parse(
  readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8"),
) as HistoricalKanaIndex;
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

/** The prose panel's own call shape — the two-argument `findCompoundSpans`,
 * without which 孝弟 is not a span at all and a different app is measured. */
function prose(sentence: Sentence): string {
  return generateKakikudashiForTree(
    { sentences: [sentence], source: "conllu" },
    (s) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })),
    resolve,
  );
}

const tok = (o: Partial<Token>): Token => ({ id: 0, text: "", lemma: "", pos: "VERB", xpos: "", dep: "", head: 0, ...o });

const PRESENTATIVE = "p,助詞,提示,*";
const SENTENCE_FINAL = "p,助詞,句末,*";

const at = (sentence: Sentence, text: string): Token => {
  const found = sentence.tokens.filter((t) => t.text === text);
  expect(found).toHaveLength(1);
  return found[0];
};

/** 孝弟也者、其爲人之本與！ — 論語 學而 2, the reader's own sentence, with the
 * tree the shipped sample carries (`public/data/samples/rongo-gakuji.conllu`,
 * `KR1h0004_001_par2_sj1`), lifted out of its 曰 frame. The 也 is `mod` of 者
 * here, which is the minority arrangement of the two. */
const kouteiYaSha: Sentence = {
  tokens: [
    tok({ id: 0, text: "孝", lemma: "孝", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "comp:obj", head: 2, morph: "VerbForm=Part" }),
    tok({ id: 1, text: "弟", lemma: "弟", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "flat@vv", head: 0 }),
    tok({ id: 2, text: "也", lemma: "也", pos: "PART", xpos: PRESENTATIVE, dep: "mod", head: 3 }),
    tok({ id: 3, text: "者", lemma: "者", pos: "PART", xpos: PRESENTATIVE, dep: "subj", head: 6 }),
    tok({ id: 4, text: "，", lemma: "，", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 3 }),
    tok({ id: 5, text: "其", lemma: "其", pos: "PART", xpos: "p,助詞,句頭,*", dep: "discourse", head: 6 }),
    tok({ id: 6, text: "爲", lemma: "爲", pos: "AUX", xpos: "v,動詞,存在,存在", dep: "ROOT", head: 6, morph: "VerbType=Cop" }),
    tok({ id: 7, text: "人", lemma: "人", pos: "NOUN", xpos: "n,名詞,人,人", dep: "comp:obj", head: 8 }),
    tok({ id: 8, text: "之", lemma: "之", pos: "SCONJ", xpos: "p,助詞,接続,属格", dep: "mod", head: 9 }),
    tok({ id: 9, text: "本", lemma: "本", pos: "NOUN", xpos: "n,名詞,描写,形質", dep: "comp:pred", head: 6 }),
    tok({ id: 10, text: "與", lemma: "與", pos: "PART", xpos: SENTENCE_FINAL, dep: "discourse@sp", head: 9 }),
    tok({ id: 11, text: "！", lemma: "！", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 10 }),
  ],
};

/** 中也者、天下之大本也。 — 中庸, and the *majority* arrangement: the 也 wears
 * `discourse@sp` off the 者, which is the same relation the assertive なり
 * wears, and there is a genuine assertive 也 closing the same sentence to read
 * it against. */
const chuuYaSha: Sentence = {
  tokens: [
    tok({ id: 0, text: "中", lemma: "中", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "comp:obj", head: 1 }),
    tok({ id: 1, text: "也", lemma: "也", pos: "PART", xpos: PRESENTATIVE, dep: "discourse@sp", head: 2 }),
    tok({ id: 2, text: "者", lemma: "者", pos: "PART", xpos: PRESENTATIVE, dep: "subj", head: 8 }),
    tok({ id: 3, text: "，", lemma: "，", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 2 }),
    tok({ id: 4, text: "天", lemma: "天", pos: "NOUN", xpos: "n,名詞,制度,場", dep: "compound", head: 5 }),
    tok({ id: 5, text: "下", lemma: "下", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "comp:obj", head: 6 }),
    tok({ id: 6, text: "之", lemma: "之", pos: "SCONJ", xpos: "p,助詞,接続,属格", dep: "mod", head: 8 }),
    tok({ id: 7, text: "大", lemma: "大", pos: "ADJ", xpos: "v,動詞,描写,量", dep: "mod", head: 8, morph: "Degree=Pos" }),
    tok({ id: 8, text: "本", lemma: "本", pos: "NOUN", xpos: "n,名詞,描写,形質", dep: "ROOT", head: 8 }),
    tok({ id: 9, text: "也", lemma: "也", pos: "PART", xpos: SENTENCE_FINAL, dep: "discourse@sp", head: 8 }),
    tok({ id: 10, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 8 }),
  ],
};

/** 由也好勇 — the 提示 也 the app already read correctly, and the one this rule
 * must not touch: the topic stands bare, with no 者 after it, and 由**や**勇を
 * 好む is the received reading. */
const yuuYa: Sentence = {
  tokens: [
    tok({ id: 0, text: "由", lemma: "由", pos: "PROPN", xpos: "n,名詞,人,名", dep: "comp:obj", head: 1 }),
    tok({ id: 1, text: "也", lemma: "也", pos: "PART", xpos: PRESENTATIVE, dep: "subj", head: 2 }),
    tok({ id: 2, text: "好", lemma: "好", pos: "VERB", xpos: "v,動詞,行為,交流", dep: "ROOT", head: 2 }),
    tok({ id: 3, text: "勇", lemma: "勇", pos: "NOUN", xpos: "n,名詞,描写,態度", dep: "comp:obj", head: 2 }),
  ],
};

describe("isPresentativeCopula — the 也 of AB也者", () => {
  it("fires on a 提示 也 standing immediately before 者, whichever relation it wears", () => {
    expect(isPresentativeCopula(at(kouteiYaSha, "也"), kouteiYaSha)).toBe(true);
    expect(isPresentativeCopula(chuuYaSha.tokens[1], chuuYaSha)).toBe(true);
  });

  it("declines the 句末 也 that closes the same sentence", () => {
    // 中也者、天下之大本也。 carries one of each, and this is the contrast the
    // rule is drawn on: same character, same `discourse@sp`, different XPOS and
    // nothing but a 。 after it. 大本**なり** is right and must stay.
    expect(isPresentativeCopula(chuuYaSha.tokens[9], chuuYaSha)).toBe(false);
    expect(sentenceFinalParticleFor(chuuYaSha.tokens[9], chuuYaSha)).toBe("なり");
  });

  it("declines a 提示 也 with no 者 after it — 由也好勇 keeps its や", () => {
    expect(isPresentativeCopula(at(yuuYa, "也"), yuuYa)).toBe(false);
    // Read off `overrides.json`'s 提示 entry, which this rule stands in front
    // of and must not swallow: every relation that is not `discourse` reads や
    // there, and 由也好勇 is one of that entry's own anchors.
    expect(resolve(at(yuuYa, "也"), yuuYa).reading).toBe("や");
    expect(prose(yuuYa)).toContain("や");
    expect(prose(yuuYa)).not.toContain("なる");
  });

  it("reads なる, and reads it over the character rather than beside it", () => {
    const ya = at(kouteiYaSha, "也");
    expect(sentenceFinalParticleFor(ya, kouteiYaSha)).toBe("なる");
    // The furigana slot, which is what `KundokuView.ts` asks: なる is a word of
    // the sentence standing where the character stands, like every other
    // particle the table reads as a word.
    expect(readsAsSentenceFinalWord(ya, kouteiYaSha)).toBe(true);
  });

  it("takes the case particle off the nominal it predicates of", () => {
    // The gold hangs the topic off the 也 as `comp:obj`, which is where the
    // blanket を came from — 中**を**なる者は says a copula's predicand is its
    // object.
    expect(isPresentativeCopulaTopic(chuuYaSha.tokens[0], chuuYaSha)).toBe(true);
    expect(caseParticleFor(chuuYaSha.tokens[0], chuuYaSha)).toBeUndefined();
  });
});

describe("the reading of the whole frame", () => {
  it("孝弟也者、其爲人之本與！ -> 孝弟なる者は… — the reader's かうていなるものは", () => {
    // **The tail moved, and the ruling this pins did not.** What the reader
    // ruled on is the front half — 孝弟 as the on'yomi nominal, 也 as なる, 者 as
    // ものは — and every character of it stands exactly as it did. The change is
    // the 與: it is `discourse@sp` on 本, an INVERT child of 爲, and a
    // sentence-final particle closes the clause the 返り点 returns *to*, so it is
    // now read after 爲す rather than inside 本's block. The ！ behind it is what
    // used to stop the rule reaching it (see the trailing-particle walk in
    // `reorderEngine.ts`).
    //
    // 其爲仁之本與 is read 其れ仁を爲すの本**か** — the 疑問 particle last — so
    // 本と爲す**や** is the nearer of the two to the received reading, and
    // 本と**や**爲す had the particle asserted before the predicate it questions.
    expect(prose(kouteiYaSha)).toBe("孝弟なる者は、其れ人の本と爲すや。");
  });

  it("reads 孝弟 as the on'yomi nominal かうてい, with no サ変 す after it", () => {
    // Part 1 of the ruling, and a defect of its own: 孝弟 is a JMdict する-verb
    // span, so `compoundSuruOkurigana` wrote す after it and made a verb of the
    // copula's predicand — 孝弟**す**や者は. The reading itself was already
    // right and is what the ruling names.
    const span = findCompoundSpans(kouteiYaSha, { kanjidic, jmdict }).find((s) => s.text === "孝弟");
    expect(span).toBeDefined();
    const chars = span!.tokenIds.map((id) => kouteiYaSha.tokens[id].text);
    expect(compoundFurigana(chars, span!.text, jmdict, kanjidic, historicalKana, () => undefined)).toEqual(["かう", "てい"]);
    expect(prose(kouteiYaSha)).not.toContain("孝弟す");
  });

  it("中也者、天下之大本也。 -> 中なる者は、天下の大本なり。 — the 者 keeps its は", () => {
    // Part 3, and the reason it is a separate defect: with the 也 on
    // `discourse@sp` the 者 has no `mod` child at all, so `zheParticleReading`
    // found no modifier, fell through to the catch-all もの and wrote no は —
    // and `hasSentenceFinalParticle` reported the 者's clause as already
    // asserted. Both had to be told about the frame.
    expect(prose(chuuYaSha)).toBe("中なる者は、天下の大本なり。");
  });

  it("reads 者 as もの with its topic は, not as a bare は", () => {
    const zhe = resolve(chuuYaSha.tokens[2], chuuYaSha);
    expect(zhe.reading).toBe("もの");
    expect(zhe.okurigana).toBe("は");
    // The character stays in the prose — kundoku writes 者は and not ものは —
    // which is what `spellOutInProse: false` says and what the received text
    // prints.
    expect(zhe.spellOutInProse).toBe(false);
  });
});
