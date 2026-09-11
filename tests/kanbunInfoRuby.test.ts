import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseConllu } from "../src/parse/conlluParser.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";

// ---------------------------------------------------------------------------
// **The reading ratchet: what the site prints *over* its characters.**
//
// `kanbunInfoCorpus.test.ts` compares the two 書き下し文 as strings, and a string
// comparison of two texts that both keep their kanji is blind to the reading
// underneath: 之を得 is byte-identical whether the character is read え or う,
// and 志 read シリング and 志 read こころざし are the same three characters on the
// page. Every reading defect the reader found by eye — くりて for きたり, ことる
// for ことなり, 斯 read か — scored as a perfect match there.
//
// kanbun.info publishes the answer. It marks every reading it glosses as
// `<ruby>子<rp>（</rp><rt>し</rt><rp>）</rp></ruby>` — **68,398 runs over 3,407
// passages**, 62,712 of them a single character — and the corpus builder's
// `detag` strips the `<rt>` by design, because the *prose* comparison wants the
// base text. The `ruby` stage keeps it instead, in a file of its own, so this
// measurement is added and no existing number moves.
//
// **Two things have to be folded away before a difference means anything**, and
// both were got wrong on the first pass:
//
//  1. **Orthography.** This app writes 歴史的仮名遣い and the site writes modern
//     kana. 堯 げう and ぎょう are one word; so are 官 くわん / かん and 孝 かう /
//     こう. `modern` below converts ours to the site's spelling.
//  2. **Division.** The site's ruby is the *stem* wherever okurigana follows —
//     可(べ)き, 亦(ま)た, 莫(な)し, 苟(いやし)くも — so its reading being a prefix
//     of ours is agreement. Which side of the character a kana falls on is a
//     question for the prose comparison, not this one.
//
// What is left is exactly one question: **which word is this character.**
//
// Like the prose corpus this rests on fixtures that are not in the repository —
// the readings are that editor's editorial work — so it skips where they are
// absent. The baseline it ratchets against *is* committed: one integer per
// character, carrying none of the fetched text.
//
//     KANBUN_INFO_RUBY_BASELINE=write npx vitest run tests/kanbunInfoRuby.test.ts
//
// rewrites it. As with the prose ratchet, **an improvement fails too** — a
// character that starts agreeing has to be banked by hand, or the number stops
// meaning anything.
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dirname, "fixtures");
const RUBY_PATH = join(FIXTURES, "kanbun-info-ruby.json");
const PASSAGES_PATH = join(FIXTURES, "kanbun-info-passages.json");
const PARSES_PATH = join(FIXTURES, "kanbun-info-parses.conllu");
const BASELINE_PATH = join(FIXTURES, "kanbun-info-ruby-baseline.json");

const BUILD = "python3 scripts/build-kanbun-info-corpus.py ruby";

/** 歴史的仮名遣い converted to the spelling the site prints. */
const E_ROW = "けせてねへめれげぜでべぺゑ";
const I_ROW = "きしちにひみりぎじぢびぴゐ";
const A_ROW = "かさたなはまやらわがざだばぱ";
const O_ROW = "こそとのほもよろをごぞどぼぽ";
const YOU_ON = "きしちにひみりぎじぢびぴ";
const SMALL: Record<string, string> = {
  っ: "つ", ゃ: "や", ゅ: "ゆ", ょ: "よ",
  ぁ: "あ", ぃ: "い", ぅ: "う", ぇ: "え", ぉ: "お", ゎ: "わ",
};

export function modern(src: string): string {
  let s = [...src].map((c) => SMALL[c] ?? c).join("");
  s = s.replace(/くわ/g, "か").replace(/ぐわ/g, "が");
  // ハ行転呼: word-medial は行 is わ行.
  s = s
    .replace(/(?<=.)は/g, "わ").replace(/(?<=.)ひ/g, "い").replace(/(?<=.)ふ/g, "う")
    .replace(/(?<=.)へ/g, "え").replace(/(?<=.)ほ/g, "お");
  // Long vowels, left to right. Built onto a new string rather than by mutating
  // the source in place, which is the bug this was first written with: the
  // rewrite of one kana depends on the one before it, and a `map` that assigns
  // back into its own array has already emitted that element.
  let out = "";
  for (const c of s) {
    if (c === "う" && out.length) {
      const prev = out[out.length - 1];
      const e = E_ROW.indexOf(prev);
      if (e >= 0) {
        out = out.slice(0, -1) + I_ROW[e] + "よう";
        continue;
      }
      const a = A_ROW.indexOf(prev);
      if (a >= 0) {
        out = out.slice(0, -1) + O_ROW[a] + "う";
        continue;
      }
      // い-row + う is the ゅう long vowel — しう is しゅう, ちう ちゅう. Held to a
      // *consonant* い-row kana: a bare いう is 言ふ and stays two morae.
      if (YOU_ON.includes(prev)) {
        out += "ゆう";
        continue;
      }
    }
    out += c;
  }
  return out
    .replace(/ゐ/g, "い").replace(/ゑ/g, "え").replace(/を/g, "お")
    .replace(/ぢ/g, "じ").replace(/づ/g, "ず");
}

/** **The イフ/イウ on'yomi, which `modern` above deliberately will not fold.**
 *
 * A historical イフ is a modern ユウ — 邑 is いふ and the site prints ゆう, 揖 and
 * 邑 and 悒 alike — but the same shape is also the native verb 言ふ, whose modern
 * spelling is いう and stays two morae. `modern` takes the second reading,
 * because it cannot tell them apart from the kana alone and a wrong ゆう would
 * be a fabricated disagreement.
 *
 * Here, where the question is only whether two readings are *the same word*,
 * both readings can be offered at once: nothing is lost by admitting a ゆう
 * against an いう, because the alternative is what this instrument reported for
 * 邑 — a character we read correctly, counted wrong 26 times, and every other
 * character whose on'yomi is historically イフ hidden behind the same gap. */
function variants(reading: string): string[] {
  const m = modern(reading);
  return m.startsWith("いう") ? [m, "ゆう" + m.slice(2)] : [m];
}

/** Whether the site's reading and ours are the same word — see the header for
 * why a prefix counts. */
export function agrees(site: string, ours: string): boolean {
  for (const a of variants(site)) {
    for (const b of variants(ours)) {
      if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
    }
  }
  return false;
}

if (existsSync(RUBY_PATH) && existsSync(PASSAGES_PATH) && existsSync(PARSES_PATH)) {
  measureAgainstTheReceivedReadings();
} else {
  describe("the kanbun.info readings", () => {
    it.skip(`are not built on this machine — build them with: ${BUILD}`, () => {});
  });
}

function measureAgainstTheReceivedReadings(): void {
  const DATA = join(import.meta.dirname, "..", "public", "data");
  const load = <T,>(f: string): T => JSON.parse(readFileSync(join(DATA, f), "utf-8")) as T;

  const kanjidic = load<KanjidicIndex>("kanjidic-index.json");
  const jmdict = load<JmdictIndex>("jmdict-index.json");
  const resolve = createReadingResolver(kanjidic, jmdict, load<HistoricalKanaIndex>("historical-kana-index.json"));

  const passages = JSON.parse(readFileSync(PASSAGES_PATH, "utf-8")).passages as { id: string }[];
  const ruby = JSON.parse(readFileSync(RUBY_PATH, "utf-8")) as Record<string, [string, string][]>;

  const parsesById = new Map<string, ReturnType<typeof parseConllu>["sentences"]>();
  for (const chunk of readFileSync(PARSES_PATH, "utf-8").split(/(?=^# passage = )/m)) {
    const id = /^# passage = (.+)$/m.exec(chunk)?.[1];
    if (id) parsesById.set(id, parseConllu(chunk).sentences);
  }

  // Per character: how many glossed occurrences we disagree with, counted only
  // where *nothing* we read for that character anywhere in the corpus is the
  // word the site prints. A character we sometimes get right is a question
  // about context, which this instrument cannot see and does not claim.
  const site = new Map<string, Set<string>>();
  const ours = new Map<string, Set<string>>();
  const glossed = new Map<string, number>();

  for (const p of passages) {
    const pairs = ruby[p.id];
    const sentences = parsesById.get(p.id);
    if (!pairs || !sentences) continue;

    for (const sentence of sentences) {
      findCompoundSpans(sentence, { kanjidic, jmdict });
      for (const token of sentence.tokens) {
        if ([...token.text].length !== 1) continue;
        const reading = resolve(token, sentence)?.reading;
        if (!reading) continue;
        (ours.get(token.text) ?? ours.set(token.text, new Set()).get(token.text)!).add(reading);
      }
    }
    for (const [base, rt] of pairs) {
      if ([...base].length !== 1 || !ours.has(base)) continue;
      (site.get(base) ?? site.set(base, new Set()).get(base)!).add(rt);
      glossed.set(base, (glossed.get(base) ?? 0) + 1);
    }
  }

  const disagree = new Map<string, number>();
  for (const [char, printed] of site) {
    const read = ours.get(char);
    if (!read) continue;
    const overlap = [...read].some((o) => [...printed].some((r) => agrees(r, o)));
    if (!overlap) disagree.set(char, glossed.get(char) ?? 0);
  }

  if (process.env.KANBUN_INFO_RUBY_BASELINE === "write") {
    writeFileSync(BASELINE_PATH, JSON.stringify(Object.fromEntries([...disagree].sort()), null, 1) + "\n");
  }

  const baseline: Record<string, number> = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf-8"))
    : {};

  describe("the readings kanbun.info prints over its own characters", () => {
    it("reads no character further from the received reading than it did", () => {
      const worse = [...disagree]
        .filter(([char, n]) => n > (baseline[char] ?? 0))
        .map(([char, n]) => `${char} ${baseline[char] ?? 0} → ${n}`);
      expect(worse.join("\n")).toBe("");
    });

    it("reads no character closer than the baseline records, unbanked", () => {
      // Better fails too, exactly as the prose ratchet's does: an improvement
      // absorbed in silence is one nobody can point at afterwards.
      const better = Object.entries(baseline)
        .filter(([char, n]) => (disagree.get(char) ?? 0) < n)
        .map(([char, n]) => `${char} ${n} → ${disagree.get(char) ?? 0}`);
      expect(better.join("\n")).toBe(
        "",
      );
    });

    it("still has something to measure", () => {
      // A guard on the instrument rather than on the app: if the fold or the
      // alignment ever silently stops matching characters up, every count goes
      // to zero and both assertions above pass vacuously.
      expect(glossed.size).toBeGreaterThan(1_000);
      expect([...glossed.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(20_000);
    });
  });
}
