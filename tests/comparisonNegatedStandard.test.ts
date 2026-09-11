import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";

// ---------------------------------------------------------------------------
// **The standard of a positive 如/若 when a negation closes it** — 〜ざるが如し.
//
// The particle marking what a comparison is measured against is written by
// `caseParticleFor`'s comparison branch, on the standard itself. A postposed
// 不 is read *after* the predicate it denies, so on a negated standard that
// particle landed inside the word — 如不祭 came out 祭ら**が**ざる**を**如し,
// with the 連体格 wedged between the 未然形 and its own ず and the object arm's
// を on top of it, where 論語 八佾 12 reads 祭ら**ざるが**如し.
//
// The pairing is the one the purposive 為 is already in: `caseParticleFor`
// withholds the が wherever a negation closes the clause, and
// `negationEndingParts`' comparison arm writes it onto the 連体形 ざる. These
// tests pin both halves — the negated shape and the positive one it must not
// disturb.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);
const read = (s: Sentence): string => generateKakikudashi(computeReadingOrder(s), resolve);

const YU = "v,動詞,行為,分類";

describe("a negated standard of a positive comparison", () => {
  it("如不祭 -> 祭らざるが如し, with the が after the ず and no を", () => {
    expect(read({ tokens: [
      { id: 0, text: "如", lemma: "如", pos: "VERB", xpos: YU, dep: "ROOT", head: 0, morph: "Degree=Equ" },
      { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
      { id: 2, text: "祭", lemma: "祭", pos: "VERB", xpos: "v,動詞,行為,儀礼", dep: "comp:obj", head: 0 },
    ] })).toBe("祭らざるが如し");
  });

  it("leaves an unnegated standard alone — 如祭 -> 祭るが如し", () => {
    expect(read({ tokens: [
      { id: 0, text: "如", lemma: "如", pos: "VERB", xpos: YU, dep: "ROOT", head: 0, morph: "Degree=Equ" },
      { id: 1, text: "祭", lemma: "祭", pos: "VERB", xpos: "v,動詞,行為,儀礼", dep: "comp:obj", head: 0 },
    ] })).toBe("祭るが如し");
  });

  it("leaves a plain governor's negated object alone — 見不祭 -> 祭らざるを見る", () => {
    expect(read({ tokens: [
      { id: 0, text: "見", lemma: "見", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 0 },
      { id: 1, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 2, morph: "Polarity=Neg" },
      { id: 2, text: "祭", lemma: "祭", pos: "VERB", xpos: "v,動詞,行為,儀礼", dep: "comp:obj", head: 0 },
    ] })).toBe("祭らざるを見る");
  });

  it("leaves a *negated* comparison alone — 不如祭 keeps 〜に如かず", () => {
    expect(read({ tokens: [
      { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" },
      { id: 1, text: "如", lemma: "如", pos: "VERB", xpos: YU, dep: "ROOT", head: 1, morph: "Degree=Equ" },
      { id: 2, text: "山", lemma: "山", pos: "NOUN", xpos: "n,地形,地形,山", dep: "comp:obj", head: 1 },
    ] })).toBe("山に如かず");
  });
});
