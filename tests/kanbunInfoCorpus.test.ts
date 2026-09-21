import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import type { Sentence } from "../src/parse/types.ts";
import { HAN, distance, edits, folded, runsOf } from "./receivedReadingMeasure.ts";

// ---------------------------------------------------------------------------
// The app read against kanbun.info's own 書き下し文, over the whole of that
// site's prose.
//
// **What is in it.** 3,419 passages over 9,085 sentences, taken from 831 pages
// — the 経部 (論語, 大学, 孝経), the 史部 (史記抄), the whole of the 子部 兵書
// (老子, 孫子, 呉子, 司馬法, 尉繚子, 李衛公問対, 六韜, 三略) and the 故事名言
// collection. The 集部 is excluded entire: 詩経, 楚辞, 二十四詩品, 唐詩選 and
// the poets are verse, and kundoku of verse is a different art this app is not
// aimed at. 624 of the passages carry a gold parse and 2,795 a parsed one.
//
// **Provenance, and why this suite measures against data that is not here.**
// The 白文 is ancient and out of copyright — 102,193 characters of it. The
// 書き下し文 beside it is *kanbun.info's own editorial rendering* (Web漢文大系),
// 178,468 characters, and that is one editor's work rather than anything this
// project may hand on. So the corpus is kept whole and kept **out of the
// repository**: `kanbun-info-passages.json` and `kanbun-info-parses.conllu`
// are in `.gitignore`, built locally by
// `scripts/build-kanbun-info-corpus.py`, and this suite **skips** where they
// are absent — which is what a fresh checkout, and anyone else's machine, will
// find. Skipped and not passed: a machine that measured nothing must not show
// a green tick as though it had.
//
// `kanbun-info-baseline.json` *is* committed, and is the exception on purpose.
// It holds our own measurements and nothing else — one integer per passage,
// keyed by the site's page slug — so it carries none of the fetched text, and
// without it a ratchet would start from whatever each checkout happened to
// measure, which is no ratchet at all.
//
// The parses come from two places: the Kyoto SUD treebank
// (`SUD_Classical_Chinese-Kyoto`, CC BY-SA) where it has the passage, and
// otherwise from the shipped `lzh_sud_kyoto` wheel.
//
// **This suite does not assert that the app matches the site, and must not.**
// Four separate reasons, and the design answers each one:
//
//  1. **Orthography.** The site prints 現代仮名遣い and 新字体 (いわく, 習う,
//     学びて); this app deliberately writes 歴史的仮名遣い on the characters the
//     source uses (いはく, 習ふ, 學びて). That is a difference of convention and
//     not of reading, so `folded` normalises the axis away before anything is
//     measured. See its own comment for what it folds and what it refuses to.
//
//  2. **The two 白文 are punctuated by different editors.** The gold parses
//     come from a treebank that marks reported speech 子曰：「…」; kanbun.info's
//     own 白文 has no quotation marks in it at all. The app prints the marks
//     its source gives it, and was being charged for characters the other
//     edition simply does not contain — 4.9% of the gold tier's whole distance.
//     `QUOTATION_MARKS` strikes 「」『』：from both strings and folds 。
//     into 、; the quotative と the app writes after a quotation is **not**
//     struck, being its own reading decision. Read that comment before quoting
//     the figure: this is not a like-for-like character comparison of the two
//     texts, and it says there what it excludes and what the number was before
//     the exclusion.
//
//  3. **The parser is wrong sometimes**, and the reader explicitly allows for
//     it. A difference caused by a bad parse is not this app's fault.
//
//  4. **The received reading is one editor's.** 慍らず/憤らず, 曰く/のたまはく,
//     and the choice of whether to read 而 at all are all legitimate variation,
//     and the site's own 語釈 says so in as many words for several of them.
//
// **So the measure is a ratchet, not an equality.** For each passage the
// baseline file records the distance measured when the passage was added, and
// the suite asserts the distance is exactly that. Worse fails, with the diff
// printed. **Better also fails**, with an instruction to lower the baseline —
// an improvement that is silently absorbed is an improvement nobody can point
// at later, and a ratchet that only tightens by hand is a ratchet whose
// numbers mean something.
//
//     KANBUN_INFO_BASELINE=write npx vitest run tests/kanbunInfoCorpus.test.ts
//
// rewrites the baseline. `KANBUN_INFO_CENSUS=1` additionally prints the count
// per work and tier and the ranked difference classes — the work queue — and
// the candidate variant pairs `SHINJITAI` was frozen from.
// `KANBUN_INFO_SHOW=<id prefix>` prints those passages in full with their
// diffs, which is how a class in the census is traced back to a passage.
//
// **The fold and the distance now live in `receivedReadingMeasure.ts`**, which
// is this file's own code moved out unchanged, not a rewrite of it.
// `tests/shuuhiPrefaceGoldReading.test.ts` ratchets one verified reading of
// 趙爽's preface to the 周髀算經 on the same scale, and two ratchets quoted
// beside each other have to be measured the same way. Neither suite may import
// the other — both register their suites at the top level — so the measure is a
// module both import instead.
//
// **Two tiers, kept apart, and the split is the point.** A passage whose 白文
// is in the Kyoto treebank is read from the treebank's own annotation. That
// annotation is right by construction, so reason 2 above does not apply to it:
// every remaining difference on a gold passage is either this app's fault or
// editorial variation, and there is no third excuse. A passage the treebank
// does not have is run through the shipped parser, and its differences carry
// the parser's error as well as the app's. Merging the two into one score
// would let a parse error hide behind an app fault and the other way round, so
// nothing here ever adds them together.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, "fixtures");
const PASSAGES_PATH = join(FIXTURES, "kanbun-info-passages.json");
const PARSES_PATH = join(FIXTURES, "kanbun-info-parses.conllu");
const BASELINE_PATH = join(FIXTURES, "kanbun-info-baseline.json");

/** Printed by the skip when the corpus is not on this machine. */
const BUILD_COMMAND =
  "python3 scripts/build-kanbun-info-corpus.py fetch && " +
  "python3 scripts/build-kanbun-info-corpus.py extract && " +
  "python3 scripts/build-kanbun-info-corpus.py parse";

interface Passage {
  id: string;
  work: string;
  title: string;
  page: string;
  han: string;
  yomi: string;
  tier: "gold" | "parser";
  source: string;
  sentences: number;
}

interface Measured extends Passage {
  /** What the app actually wrote, in its own orthography. */
  raw: string;
  /** The two texts as the distance sees them — `folded` applied to `yomi` and
   * to `raw`. */
  received: string;
  produced: string;
  distance: number;
}

/** What a passage's disagreement looks like, so a failure says what moved
 * rather than only by how much.
 *
 * Both texts are printed as they are actually written — the received one in
 * 現代仮名遣い and the app's in 歴史的仮名遣い — because that is what a reader
 * can check against the page. The runs beneath are in the *normalised*
 * orthography the distance is measured in, which is why they read oddly (を
 * folds to お and 學 to 学 there); they are positions in the measurement, not
 * quotations of either text. */
function showDiff(m: Measured): string {
  const shown = runsOf(m.received, m.produced).map((r) => {
    const before = m.received.slice(Math.max(0, r.at - 4), r.at);
    return `…${before}[受 ${r.site || "∅"} / 本 ${r.app || "∅"}]…`;
  });
  return [
    `\n      受: ${m.yomi}`,
    `      本: ${m.raw}`,
    `      ${shown.join("\n      ")}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The corpus is built locally and is not in the repository. See the header.
// ---------------------------------------------------------------------------

if (existsSync(PASSAGES_PATH) && existsSync(PARSES_PATH)) {
  measureAgainstTheReceivedReading();
} else {
  describe("the kanbun.info corpus", () => {
    // Skipped, not passed and not failed. A machine without the corpus has
    // measured nothing, and a green tick would say it had.
    it.skip(`is not built on this machine — build it with: ${BUILD_COMMAND}`, () => {});
  });
}

/** Everything that touches a fixture. Declared rather than inlined so that the
 * guard above can decline to call it, and so that a checkout without the
 * corpus loads no index and reads no file. */
function measureAgainstTheReceivedReading(): void {
  const DATA = join(import.meta.dirname, "..", "public", "data");
  const loadIndex = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA, file), "utf-8")) as T;

  const kanjidic = loadIndex<KanjidicIndex>("kanjidic-index.json");
  const jmdict = loadIndex<JmdictIndex>("jmdict-index.json");
  const historicalKana = loadIndex<HistoricalKanaIndex>("historical-kana-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

  const passages: Passage[] = JSON.parse(
    readFileSync(join(FIXTURES, "kanbun-info-passages.json"), "utf-8"),
  ).passages;

  /** The parses, split back into passages. `parseConllu` drops comment lines, so
   * the `# passage =` markers have to be honoured here rather than by it. */
  const parsesById = new Map<string, Sentence[]>();
  {
    const raw = readFileSync(join(FIXTURES, "kanbun-info-parses.conllu"), "utf-8");
    for (const chunk of raw.split(/(?=^# passage = )/m)) {
      const id = /^# passage = (.+)$/m.exec(chunk)?.[1];
      if (!id) continue;
      parsesById.set(id, parseConllu(chunk).sentences);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering, through the panels' own call shape.
  // ---------------------------------------------------------------------------

  function render(id: string): string {
    const sentences = parsesById.get(id);
    if (!sentences) throw new Error(`no parse fixture for ${id}`);
    return generateKakikudashiForTree(
      { sentences, source: "conllu" },
      // The two-argument `findCompoundSpans`. The one-argument form sees no
      // lexical-word span at all and renders a different app.
      (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
      resolve,
    );
  }

  const measured: Measured[] = passages.map((p) => {
    const raw = render(p.id);
    const received = folded(p.yomi);
    const produced = folded(raw);
    return { ...p, raw, received, produced, distance: distance(received, produced) };
  });

  // ---------------------------------------------------------------------------
  // The ratchet.
  // ---------------------------------------------------------------------------


  if (process.env.KANBUN_INFO_BASELINE === "write") {
    const out: Record<string, number> = {};
    for (const m of measured) out[m.id] = m.distance;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 1)}\n`);
  }

  const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

  const works = [...new Set(measured.map((m) => `${m.tier} ${m.work}`))].sort();

  for (const key of works) {
    const [tier, work] = key.split(" ");
    const group = measured.filter((m) => m.tier === tier && m.work === work);
    const total = group.reduce((n, m) => n + m.distance, 0);
    const chars = group.reduce((n, m) => n + [...m.received].length, 0);

    describe(`${work} — ${tier} parses (${group.length} passages, ${chars} received characters, ${total} edits)`, () => {
      it("is no further from the received reading than it was", () => {
        const worse: string[] = [];
        const better: string[] = [];
        for (const m of group) {
          const was = baseline[m.id];
          expect(was, `${m.id} has no baseline — run with KANBUN_INFO_BASELINE=write`).toBeTypeOf("number");
          if (m.distance > was) {
            worse.push(`  ${m.id} (${m.title}) ${was} → ${m.distance}${showDiff(m)}`);
          } else if (m.distance < was) {
            better.push(`  ${m.id} (${m.title}) ${was} → ${m.distance}`);
          }
        }
        const report: string[] = [];
        if (worse.length > 0) {
          report.push(`${worse.length} passage(s) read further from the received text than before:`, ...worse);
        }
        if (better.length > 0) {
          report.push(
            `${better.length} passage(s) read closer than the baseline records — this is an improvement,`,
            "and the baseline has to be lowered so that it stays one:",
            "  KANBUN_INFO_BASELINE=write npx vitest run tests/kanbunInfoCorpus.test.ts",
            ...better,
          );
        }
        expect(report.join("\n")).toBe("");
      });
    });
  }

  // ---------------------------------------------------------------------------
  // The census. Not an assertion — a standing count of what the two texts
  // disagree about, ranked, which is the work queue the ratchet exists to
  // protect. Printed under KANBUN_INFO_CENSUS=1.
  // ---------------------------------------------------------------------------

  describe("the corpus itself", () => {
    it("shows the passages KANBUN_INFO_SHOW names", () => {
      const want = process.env.KANBUN_INFO_SHOW;
      if (!want) return;
      for (const m of measured.filter((x) => x.id.startsWith(want)).slice(0, 12)) {
        console.log(`\n${m.id} ${m.work} ${m.title} [${m.tier}] ${m.distance}\n  白: ${m.han}${showDiff(m)}`);
      }
    });

    it("has a parse for every passage and a passage for every parse", () => {
      expect(passages.map((p) => p.id).sort()).toEqual([...parsesById.keys()].sort());
    });

    it("counts its two tiers", () => {
      const gold = measured.filter((m) => m.tier === "gold");
      const parser = measured.filter((m) => m.tier === "parser");
      expect(gold.length + parser.length).toBe(measured.length);
      if (process.env.KANBUN_INFO_CENSUS) {
        const rate = (g: Measured[]): string => {
          const d = g.reduce((n, m) => n + m.distance, 0);
          const c = g.reduce((n, m) => n + [...m.received].length, 0);
          return `${String(g.length).padStart(5)}p ${String(c).padStart(7)}ch ${String(d).padStart(6)}ed  ${(100 * d / c).toFixed(1)}%`;
        };
        const rows: string[] = [];
        for (const tier of ["gold", "parser"] as const) {
          const t = measured.filter((m) => m.tier === tier);
          rows.push(`${tier.padEnd(8)} ALL          ${rate(t)}`);
          for (const work of [...new Set(t.map((m) => m.work))].sort()) {
            rows.push(`${tier.padEnd(8)} ${work.padEnd(12)} ${rate(t.filter((m) => m.work === work))}`);
          }
        }
        console.log(`\nper work and tier (passages, received characters, edits, edit rate):\n${rows.join("\n")}`);

        const classes = new Map<string, { n: number; where: Set<string> }>();
        for (const m of measured) {
          for (const r of runsOf(m.received, m.produced)) {
            const key = `${m.tier.padEnd(6)} 受「${r.site || "∅"}」 本「${r.app || "∅"}」`;
            const seen = classes.get(key) ?? { n: 0, where: new Set<string>() };
            seen.n++;
            seen.where.add(m.id);
            classes.set(key, seen);
          }
        }
        const ranked = [...classes].sort((a, b) => b[1].n - a[1].n).slice(0, 150);
        console.log(
          `\nranked difference classes (occurrences, passages):\n` +
          [...ranked.map(([k, v]) => `${String(v.n).padStart(5)}  ${v.where.size.toString().padStart(4)}p  ${k}`)].join("\n"),
        );

        // The mining rule `SHINJITAI` is kept by. A substitution qualifies as a
        // candidate graphic variant when the character this app printed stands
        // in the passage's own 白文 and the one the site printed does not — the
        // app never *chooses* a character, so a pair meeting that test is the
        // site rewriting the source's graph rather than the two disagreeing
        // about a word. Reported, never applied: the table is frozen by eye.
        const variants = new Map<string, Set<string>>();
        for (const m of measured) {
          for (const e of edits(m.received, m.produced)) {
            if (e.kind !== "sub") continue;
            if (!HAN.test(e.site) || !HAN.test(e.app)) continue;
            if (!m.han.includes(e.app) || m.han.includes(e.site)) continue;
            const key = `${e.app} → ${e.site}`;
            variants.set(key, (variants.get(key) ?? new Set()).add(m.id));
          }
        }
        console.log(
          "\ncandidate 新字体 pairs (本 → 受), passages:\n" +
            [...variants]
              .filter(([, w]) => w.size >= 3)
              .sort((a, b) => b[1].size - a[1].size)
              .map(([k, w]) => `  ${k}  ${w.size}`)
              .join("\n"),
        );
      }
    });
  });

}
