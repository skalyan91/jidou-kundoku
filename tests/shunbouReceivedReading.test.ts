import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { setRenyouTe } from "../src/kakikudashi/renyouTe.ts";

// ---------------------------------------------------------------------------
// 春望 against the received reading, whole, and under both states of the
// 連用形-て switch.
//
// **Why this is a file of its own and not three more `it`s in
// `sampleTexts.test.ts`.** It sets module state — `setRenyouTe` — and vitest
// isolates that per file; a switch left on by one test would change what every
// other test in the same file renders, which is exactly the kind of failure a
// suite should not be able to produce.
//
// **What is asserted, and what is not.** The reader's instruction for this
// text is to follow kanbun.info as far as possible, and six of the eight lines
// now do so exactly. The two that do not are named below with the measurement
// that refuses each; they are asserted **as they are**, so that closing either
// gap is a failing test and not a silent drift. Nothing of the site's prose is
// copied here beyond what a test has to quote to be a test — the received
// reading of 春望 is centuries older than any website, and the file's own
// header sets out the licence position at length.
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "public", "data");
const load = <T,>(f: string): T => JSON.parse(readFileSync(join(DATA, f), "utf-8")) as T;
const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
const jmdict = load<JmdictIndex>("jmdict-index.json");
const historicalKana = load<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

/** Re-parsed for each render: the app writes into `token.misc` while
 * rendering, so one parsed tree rendered twice is not one text measured
 * twice. */
function prose(): string[] {
  const tree = parseConllu(readFileSync(join(ROOT, "public/data/samples/shunbou.conllu"), "utf-8"));
  return generateKakikudashiForTree(
    tree,
    (s) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })),
    resolve,
  )
    .split("\n")
    .filter((line) => line.length > 0);
}

/** The ten lines the panel writes — the title, the poet, and the poem's eight.
 * `連用形`-て off, which is the app's default. */
const RECEIVED_WITH_THE_SWITCH_OFF = [
  "春望",
  "杜甫",
  // 國破れ**て** under the switch; the received text writes the て and this app
  // writes it only when asked. A display convention, not a defect — see
  // `renyouTe.ts` and the assertion below.
  "國破れ山河在り",
  "城春にして草木深し",
  "時に感じては花にも淚を濺ぎ",
  // 別るるを, where the site reads 別れを: gold tags 別 VERB 141 times and NOUN
  // never, so this is the treebank's reading of the character. 恨みて, where
  // the site reads 恨んで: that んで is the 撥音便 of 連用形+て, which belongs to
  // 口語 and not 文語, so the pin holds the uncontracted 連用形+て 恨みて instead
  // — the reader's standing rule that 文語 morphology outranks the site, the
  // way pure 歴史的仮名遣い already does. See the sample's own sentence-6 note.
  "別るるを恨みては鳥にも心を驚かす",
  "烽火三月に連なり",
  "家書萬金に抵たる",
  // 搔き, where the site reads 掻けば: the protasis needs a 則-class connective
  // this line does not carry, and recognising one from the relation and the POS
  // alone measures +1,597 edits over kanbun.info (gold +112, parser +1,485).
  // See `isConditionalTemporalClause`, whose own note names this line.
  "白頭搔き更に短く",
  // The 。 is `generateKakikudashiForTree`'s own sentence terminator, written
  // where the whole text is rendered at once; the 白文 of the poem carries no
  // punctuation and neither does the received reading.
  "渾て簪に勝へざらんと欲す。",
];

describe("杜甫・春望 against the received reading", () => {
  it("writes all ten lines, six of the poem's eight exactly as received", () => {
    setRenyouTe(false);
    expect(prose()).toEqual(RECEIVED_WITH_THE_SWITCH_OFF);
  });

  it("changes only where the switch is entitled to — and never doubles a pinned て", () => {
    // **The bug this exists to catch.** 感じては and 恨みては are hand-written
    // particle slots on a hand-written 連用形, and the first draft of them put
    // the て in the particle (`Topic=ては`). With the switch *on* the app writes
    // its own て first and the line came out 感じ**てて**は. Pinning the て with
    // the stem instead (`Okurigana=じて`/`Okurigana=みて`) freezes the form
    // before the switch is consulted, so both states print one て. Asserted
    // rather than remembered.
    setRenyouTe(true);
    const on = prose();
    setRenyouTe(false);
    const off = prose();
    for (const line of on) expect(line).not.toContain("てて");
    // The two pinned converbs are byte-identical in both states…
    expect(on.join("|")).toContain("感じては");
    expect(off.join("|")).toContain("感じては");
    expect(on.join("|")).toContain("恨みては");
    expect(off.join("|")).toContain("恨みては");
    // …while the switch does do its job on everything it is entitled to: 破れ,
    // 濺ぎ and 連なり are the app's own 連用形 and take the て.
    expect(on[2]).toBe("國破れて山河在り");
    expect(off[2]).toBe("國破れ山河在り");
    expect(on[4]).toContain("淚を濺ぎて");
  });
});
