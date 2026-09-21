import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { distance, folded, runsOf } from "./receivedReadingMeasure.ts";

// ---------------------------------------------------------------------------
// 趙爽's preface to the 周髀算經, read against a verified 書き下し文.
//
// **Provenance, and why this file may hold what the file next door may not.**
// `tests/kanbunInfoCorpus.test.ts` measures the same app against kanbun.info's
// 3,419 passages and keeps every one of them out of the repository, because the
// 書き下し文 in that corpus is the site's own editorial rendering and is that
// editor's work to publish rather than ours. **This passage is the opposite
// case**, and the four fixtures beside this file are committed on purpose. The
// 白文 is 趙爽's and is ancient and out of copyright; the 書き下し文 is the verified
// work of the owner of this repository. Four files, all committed, none
// gitignored, none built by a script:
//
//   tests/fixtures/shuuhi-preface-hakubun.txt      the 白文 — 3 paragraphs,
//                                                  274 tokens, 7 sentences
//   tests/fixtures/shuuhi-preface-gold-reading.txt the verified reading
//   tests/fixtures/shuuhi-preface-parser.conllu    lzh_sud_kyoto 0.3.5, run
//                                                  through the two-stage
//                                                  pipeline this app uses
//   tests/fixtures/shuuhi-preface-gold-tree.conllu the same passage hand-
//                                                  corrected to Kyoto SUD
//
// So this suite never skips. The corpus suite cannot run on a fresh checkout or
// on anyone else's machine; this one runs everywhere, which is most of why the
// passage was worth turning into a fixture at all.
//
// **What it caught.** 3,419 passages of running kanbun did not surface the four
// faults listed under *Still wrong* below; one 274-token preface did. A treatise
// preface is denser in nominalised predicates, bare two-character binomes and
// 可以-frames than the narrative and dialogue the corpus is mostly made of, so
// it exercises classes the corpus barely contains.
//
// **Both trees, and two numbers, kept apart.** The parser tree is what a reader
// of this passage gets today; the hand-corrected tree is what the app should
// write given a correct parse. Measured separately, the two numbers say which
// faults belong to this app and which belong to the parser — which is the whole
// reason the passage was useful. Adding them together, or measuring only one,
// would let a parse error hide behind an app fault and the other way round. The
// corpus suite splits its gold and parser tiers for the same reason and never
// sums them either.
//
//     parser 0.3.5 tree      226 edits over 506 received characters   44.7%
//     hand-corrected tree    108 edits over 506 received characters   21.3%
//
// Half the distance a reader sees today is the parser, and half is this app.
//
// **A ratchet, not an equality.** The verified reading takes liberties that no
// rule can reproduce, and they are listed here so that nobody reads the residue
// as a work queue and tries to close them:
//
//  1. **其の in 其の宏遠なること.** The 白文 is 然而宏遠不可指掌也 and carries no
//     其. The reading supplies the possessive from the sentence before it. The
//     app writes 宏遠なること and is right to.
//  2. **知る in 其の進退を知るべし.** The 白文 is 可以玄象課其進退; the verb in it
//     is 課, and 知る is the gloss the reading puts on what 課す amounts to
//     here.
//  3. **以 read twice in 以て晷儀をもって.** One 以 stands in 可以晷儀驗其長短
//     and the reading writes it twice, once as the 可以 frame and once as the
//     instrumental on 晷儀.
//  4. **『靈憲』 and 『周髀』.** The reading brackets two titles; the 白文
//     brackets only 《周髀》. This one costs nothing, because the fold strikes
//     「」『』： out of both strings before anything is measured — see
//     `QUOTATION_MARKS` in `receivedReadingMeasure.ts`.
//  5. **重ねて in 誠に頹毀せる重仞の墻を重ねて.** The 白文 is 誠冀頹毀重仞之墻,
//     in which 頹毀 is what the writer hopes to do to the wall. 重ねて does not
//     construe with that and is probably a slip. It stays in the gold as the
//     reader verified it, and it is named here so that nobody chases it.
//
// **And one difference that runs the other way, where the app is right and the
// gold is not to be followed.** The reading writes べし and べからず where this
// app writes 可し and 可からず — four times between 可以玄象課其進退,
// 不可指掌也, 可以晷儀驗其長短 and 不可度量也. kanbun.info's corpus backs the
// app 155:29 for 可し over べし and 204:1 for 可からず over べからず, so the
// convention this app follows is the majority one by a wide margin and these
// four edits are not a fault. Left in the ratchet rather than folded away: a
// number that quietly forgives one convention is a number nobody can audit.
//
// **What the fold has to do here, which is very nearly nothing.** The corpus
// fold exists to normalise 現代仮名遣い and 新字体 away, because kanbun.info
// writes both and this app writes neither. This gold is **already written in
// 歴史的仮名遣い and 舊字體**, so the four orthographic tables have almost
// nothing to bite on, and the measurement says so:
//
//                          no fold   punctuation only   full fold
//     parser tree            238           227             226
//     hand-corrected tree    120           109             108
//
// Eleven of the twelve edits the fold removes from each tier are punctuation —
// ，against 、, 。against 、, and the struck brackets of liberty 4 above. The
// twelfth, and the *only* edit any orthographic table removes, is 鄰/隣: both
// trees annotate the character as 鄰 while `shuuhi-preface-hakubun.txt` prints
// 隣, the reading follows the 白文, and `SHINJITAI` forgives the pair. The kana
// tables — `SMALL_TO_LARGE`, `MEDIAL_MERGERS` and the -u fusions — change the
// distance by zero on both tiers.
//
// The full fold is used anyway, and deliberately. It is applied to both strings,
// so on a passage whose axes it does not touch it cannot invent agreement; and
// the two suites have to measure on one scale if their numbers are ever to be
// quoted beside each other. Hence `receivedReadingMeasure.ts`, which holds the
// fold and the distance the corpus suite itself measures with, moved out into a
// module both suites import.
//
// **Still wrong, which is what makes the fixture worth keeping.** Named here
// and pinned by assertions below, so that closing any of them is a failing test
// and not a silent drift:
//
//  - **The bare-binome class.** 體恢洪而廓落 and 形脩廣而幽清 end on a two-
//    character descriptive binome standing as the predicate. The app writes
//    廓落にして and 幽清にして, continuing the clause where the reading closes
//    it — 廓落 bare and 幽清なり. A binome in predicate position gets the
//    converb the coordination would give it, and nothing yet asks whether it is
//    the last predicate in its sentence.
//  - **大いなる for 大なる.** 大 read as an adjective takes 大いなり in this app
//    and 大なり in the reading, in both 高而大者 and 莫大於天. Two edits per
//    occurrence and four in the passage.
//  - **The は on a nominalised comparative.** 莫大於天 is read 天より大なるは莫
//    し: the comparative is nominalised and carries a topic は before 莫し. The
//    app writes 天より大いなる莫し, with no particle at all. Same again for
//    莫廣於地.
//  - **The tokenisation of 誠冀頹毀重仞之墻.** Both trees carry 冀頹 as one
//    token, which is neither a word nor a compound: the 冀 belongs to the hope
//    and 頹毀 to the wall. Both tiers are charged for it, so it is *not* a
//    parser fault the hand-corrected tree clears, and it is the largest single
//    run of edits in the gold-tree diff. A tokenisation this suite inherits
//    rather than one it can fix from here.
//
// **What is asserted, and what is not.** Two ratchets, one per tree, on the
// whole passage rendered as one string; one guard that the two trees really are
// annotations of one text; and `toContain` pins on the first three faults above
// and on the 可し convention. The 冀頹 tokenisation is named but not pinned,
// having no substring this app could be held to.
// Nothing asserts that the app matches the reading, and nothing should:
// the liberties above make equality unreachable by construction. As in the
// corpus suite, **better also fails** — an improvement that is silently
// absorbed is an improvement nobody can point at later — and the constants
// below are the only place either number lives.
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(import.meta.dirname, "fixtures");

/** The distance measured when each tier was last banked. Two integers, and they
 * live here rather than in a JSON baseline: the corpus suite needs a file
 * because it carries 3,419 of these, and this suite carries two. Change either
 * only together with the header, which says what the number is made of. */
const RATCHET = { parser: 226, goldTree: 108 } as const;

const loadIndex = <T,>(file: string): T =>
  JSON.parse(readFileSync(join(ROOT, "public", "data", file), "utf-8")) as T;
const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

/** The `#` lines at the head of the two .txt fixtures carry their provenance
 * and are not part of either text. The .conllu fixtures need no such help:
 * `parseConllu` drops comment lines itself. */
function fixtureText(file: string): string {
  return readFileSync(join(FIXTURES, file), "utf-8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
}

/** Every line break out, so that one passage is one string. The line breaks in
 * the gold set the passage out for a reader, and the line breaks the app writes
 * are where `generateKakikudashiForTree` ends a sentence. Neither set is a
 * reading, and a measure that counted them would be measuring layout. */
const oneString = (s: string) => s.replace(/\s+/gu, "");

const hakubun = oneString(fixtureText("shuuhi-preface-hakubun.txt"));
const gold = oneString(fixtureText("shuuhi-preface-gold-reading.txt"));

/** Rendered through the call shape the panels themselves use — the two-argument
 * `findCompoundSpans`, since the one-argument form sees no lexical-word span at
 * all and renders a different app. The tree is parsed inside this function and
 * nowhere else, because the app writes into `token.misc` while rendering and a
 * tree handed to the generator twice is not one text rendered twice.
 *
 * **The finished string is cached**, which is the safe half of that: one render
 * of one freshly parsed tree, and every assertion below reads the same result.
 * Each render costs two to four seconds, and four of them put this file within
 * a second of Vitest's default budget. */
const rendered = new Map<string, string>();
function render(file: string): string {
  const cached = rendered.get(file);
  if (cached !== undefined) return cached;
  const tree = parseConllu(readFileSync(join(FIXTURES, file), "utf-8"));
  const out = oneString(
    generateKakikudashiForTree(
      tree,
      (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
      resolve,
    ),
  );
  rendered.set(file, out);
  return out;
}

/** The token forms of a tree, run together. Both trees should reconstruct the
 * 白文 exactly; see the guard below for the one character where they do not. */
function tokensOf(file: string): string {
  const tree = parseConllu(readFileSync(join(FIXTURES, file), "utf-8"));
  return tree.sentences.flatMap((s) => s.tokens.map((t) => t.text)).join("");
}

/** What moved, in the orthography the distance is measured in — which is why
 * the runs read oddly (を folds to お there, and 鄰 to 隣). They are positions in
 * the measurement, not quotations of either text. */
function showDiff(received: string, produced: string): string {
  const runs = runsOf(folded(received), folded(produced)).map((r) => {
    const before = folded(received).slice(Math.max(0, r.at - 5), r.at);
    return `        …${before}[金 ${r.site || "∅"} / 本 ${r.app || "∅"}]…`;
  });
  return ["", `      金: ${received}`, `      本: ${produced}`, ...runs].join("\n");
}

function ratchet(label: string, file: string, was: number): void {
  const produced = render(file);
  const now = distance(folded(gold), folded(produced));
  if (now === was) return;
  const verdict =
    now > was
      ? `reads ${now - was} edit(s) further from the verified reading than it did`
      : `reads ${was - now} edit(s) closer than the ratchet records — an improvement, ` +
        "and the ratchet has to be re-banked so that it stays one";
  expect(`${label}: ${was} → ${now}, ${verdict}${showDiff(gold, produced)}`).toBe("");
}

describe("趙爽・周髀算經序 against the verified reading", () => {
  it("is one text under both annotations", () => {
    // **A guard, not a measurement.** The two trees have to be annotations of
    // the same 274 tokens, or the two distances below are measuring two
    // different passages and the split between app fault and parser fault means
    // nothing.
    expect(tokensOf("shuuhi-preface-parser.conllu"))
      .toBe(tokensOf("shuuhi-preface-gold-tree.conllu"));
    // And that text is the 白文 fixture — **under the fold**, because the two
    // trees write 鄰 where `shuuhi-preface-hakubun.txt` writes 隣 and that is
    // the only character anywhere in the four fixtures where the supplied
    // materials disagree. `SHINJITAI` forgives the pair; see the header.
    expect(folded(tokensOf("shuuhi-preface-parser.conllu"))).toBe(folded(hakubun));
  });

  it(`reads the parser 0.3.5 tree ${RATCHET.parser} edits from the verified reading`, () => {
    ratchet("parser 0.3.5", "shuuhi-preface-parser.conllu", RATCHET.parser);
  });

  it(`reads the hand-corrected tree ${RATCHET.goldTree} edits from the verified reading`, () => {
    // Less than half the parser number, on the same text and the same measure.
    // Everything between the two is the parser and not this app.
    ratchet("hand-corrected", "shuuhi-preface-gold-tree.conllu", RATCHET.goldTree);
  });

  it("still writes a converb on a bare predicate binome, and a 大い where the reading has 大", () => {
    // Pinned on the hand-corrected tree, because these three faults belong to
    // *this app* and not to the parser: that tree already carries 恢洪, 廓落,
    // 脩廣 and 幽清 as `flat@vv` binomes with the right heads, and the app still
    // writes them this way. See the header for the class each one belongs to.
    const produced = render("shuuhi-preface-gold-tree.conllu");
    // 體恢洪而廓落 — 廓落 bare in the reading, 廓落にして here.
    expect(produced).toContain("恢洪にして廓落にして");
    // 形脩廣而幽清 — 幽清なり in the reading, and the sentence ends there.
    expect(produced).toContain("脩廣にして幽清にして");
    // 高而大者 and 莫大於天 — 大なる in the reading, 大いなる here.
    expect(produced).toContain("大いなる者は");
    // 莫大於天 — 天より大なるは莫し in the reading: the nominalised comparative
    // takes a topic は, and the app writes no particle at all.
    expect(produced).toContain("天より大いなる莫し");
    expect(produced).not.toContain("大いなるは莫");
  });

  it("writes 可し and 可からず, which is this app's convention and not a fault", () => {
    // The four edits the header names as running the other way. Asserted so
    // that a future change to べし is a deliberate one, made against the corpus
    // counts (155:29 and 204:1) rather than against this one passage.
    const produced = render("shuuhi-preface-gold-tree.conllu");
    expect(produced).toContain("課す可し");
    expect(produced).toContain("指掌す可からざるなり");
    expect(produced).toContain("驗す可し");
    expect(produced).toContain("度量す可からざるなり");
    expect(produced).not.toContain("べからず");
  });

  // **Why this block carries a budget of its own**, the same reason
  // `kakikudashiHang.test.ts` gives for its two: rendering 274 tokens through
  // the reading resolver costs two to four seconds against Vitest's default
  // five, which is comfortable alone and stops being comfortable when several
  // suites run at once on one machine — this file was seen to pass 5s and fail
  // the run before the render cache above went in. Twenty seconds is load
  // tolerance and not a slowdown; a real regression in the generator would blow
  // through it just the same.
}, { timeout: 20_000 });
