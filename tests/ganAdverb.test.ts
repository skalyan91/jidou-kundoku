import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";
import { executeKunten } from "../src/kanbun/kuntenExecutor.ts";
import { classifyToken, isGanComplement } from "../src/kundoku/depClassification.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { ganAdverbReading } from "../src/kakikudashi/conjugationContext.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";

// ---------------------------------------------------------------------------
// 敢 over a predicate is the adverb 敢へて, read where it stands. The app read
// it as the verb あふ with its complement inverted in front of it, which put
// every 不敢V in the corpus the wrong way round: 臣不敢生還 came out
// 臣生還す敢へず, 莫敢當其前 came out 其の前に當たる敢ふる莫し.
//
// kanbun.info writes 敢えて on 81 of the 86 敢 in its 白文 (the other five are
// 果敢 and paraphrase) and never 敢え with anything else after it; the negation
// closes the predicate after 敢えて on all 36 of its 敢えて…ず and all 9 of its
// 敢えて…莫し. See `isGanComplement` in depClassification.ts for the counts,
// and the 敢 fold in reorderEngine.ts for where the negation is read.
//
// The trees are the corpus parses (tests/fixtures/kanbun-info-parses.conllu),
// cut down to the clause with 敢 in it and written `text/UPOS/deprel>head`
// with 1-based heads, through `parseConllu`.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** The treebank tags the characters these trees turn on carry, so that the
 * negation and modal tests see what the parser gives them. */
const XPOS: Record<string, [string, string]> = {
  敢: ["v,助動詞,願望,*", "Mood=Des"],
  不: ["v,副詞,否定,無界", "Polarity=Neg"],
  未: ["v,副詞,否定,有界", "Polarity=Neg"],
  莫: ["v,副詞,否定,禁止", "Polarity=Neg"],
  非: ["v,副詞,否定,体言否定", "Polarity=Neg"],
  也: ["p,助詞,句末,*", "_"],
  豈: ["v,副詞,疑問,反語", "_"],
  乎: ["p,助詞,句末,*", "_"],
  問: ["v,動詞,行為,伝達", "_"],
};

function tree(spec: string, misc: Record<string, string> = {}): Sentence {
  const rows = spec
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      const [text, pos, rel] = word.split("/");
      const [dep, head] = rel.includes(">") ? rel.split(">") : [rel, "0"];
      const [xpos, feats] = XPOS[text] ?? ["_", "_"];
      return [i + 1, text, text, pos, xpos, feats, dep === "root" ? "0" : head, dep, "_", misc[text] ?? "_"].join("\t");
    });
  const parsed = parseConllu(rows.join("\n") + "\n");
  expect(parsed.sentences).toHaveLength(1);
  return parsed.sentences[0];
}

/** With the compound spans the app finds, as both panels are given them — 生還
 * is one word, and read without its span it is two. */
const prose = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict })), resolve);
const byText = (s: Sentence, text: string, nth = 0) => s.tokens.filter((t) => t.text === text)[nth];

function textOf(s: Sentence, ids: number[]): string {
  const byId = new Map(s.tokens.map((t) => [t.id, t]));
  return ids
    .map((id) => byId.get(id)!)
    .filter((t) => t.dep !== "punct")
    .map((t) => t.text)
    .join("");
}

const readingOrder = (s: Sentence) => textOf(s, computeReadingOrder(s).order);

/** Every token with its plain kaeriten after it in brackets. */
function annotate(s: Sentence): string {
  const plan = computeReadingOrder(s);
  assignKundokuTen(plan);
  const marks = buildPlainKuntenMarks(plan);
  return s.tokens.map((t) => `${t.text}${marks.get(t.id) ? `[${marks.get(t.id)}]` : ""}`).join("");
}

/** What a reader following only the marks reads. */
function traceMarks(s: Sentence): string {
  const plan = computeReadingOrder(s);
  assignKundokuTen(plan);
  const marks = buildPlainKuntenMarks(plan);
  const isPunct = (id: number) => s.tokens.find((t) => t.id === id)?.dep === "punct";
  const maxId = Math.max(...s.tokens.map((t) => t.id));
  const kuntens = Array.from({ length: maxId + 1 }, (_, id) => marks.get(id));
  return textOf(s, executeKunten(kuntens, isPunct));
}

// 臣不敢生還。 — 六韜 立將, parsed.
const CHEN = "臣/NOUN/subj>3 不/ADV/mod>3 敢/AUX/root 生/VERB/comp:aux>3 還/VERB/flat@vv>4 。/PUNCT/punct>3";
// 吾陳不敢當。 — 六韜 敵強, parsed, cut down to its last clause.
const DANG = "吾/PRON/det>2 陳/VERB/subj>4 不/ADV/mod>4 敢/AUX/root 當/VERB/comp:aux>4 。/PUNCT/punct>4";
// 莫敢當其前。 — 尉繚子 兵令, parsed.
const MO_DANG = "莫/ADV/mod>2 敢/AUX/root 當/VERB/comp:aux>2 其/PRON/det>5 前/NOUN/comp:obj>3 。/PUNCT/punct>2";
// 民莫敢不敬。 — 論語 子路 4, gold.
const MO_JING = "民/NOUN/subj>3 莫/ADV/mod>3 敢/AUX/root 不/ADV/mod>3 敬/VERB/comp:aux>3 。/PUNCT/punct>3";
// 主人不敢當而陵之。 — 尉繚子 戰威, parsed.
const LING = "主/VERB/mod>2 人/NOUN/subj>4 不/ADV/mod>4 敢/AUX/root 當/VERB/comp:aux>4 而/CCONJ/cc>7 陵/VERB/conj:coord>5 之/PRON/comp:obj>7 。/PUNCT/punct>4";
// 非敢後也。 — 論語 雍也 15, gold.
const HOU = "非/ADV/mod>2 敢/AUX/root 後/VERB/comp:aux>2 也/PART/discourse@sp>3 。/PUNCT/punct>2";
// 欲去不敢。 — 吳子 料敵, parsed: a 敢 with no complement.
const BARE = "欲/AUX/root 去/VERB/comp:aux>1 不/ADV/mod>4 敢/AUX/conj:coord>1 。/PUNCT/punct>4";

describe("the predicate 敢 governs is read after it, not in front of it", () => {
  it("does not invert a comp:aux of 敢, negated or not", () => {
    for (const spec of [CHEN, DANG, MO_JING]) {
      const s = tree(spec);
      const gan = byText(s, "敢");
      const complement = s.tokens.find((t) => t.head === gan.id && t.dep === "comp:aux")!;
      expect(isGanComplement(complement, gan, s)).toBe(true);
      expect(classifyToken(complement, gan, s)).toBe("no-invert");
    }
  });

  it("gives the inversion back where the reader pinned a verb reading on 敢", () => {
    // A reader who pins あふ asks for the verb, and a verb takes its
    // complement in front of it — the discipline 能 follows.
    const s = tree(DANG, { 敢: "Reading=あ|Okurigana=ふ" });
    const gan = byText(s, "敢");
    expect(classifyToken(byText(s, "當"), gan, s)).toBe("invert");
    expect(ganAdverbReading(gan, s)).toBeUndefined();
  });

  it("reads 臣不敢生還 as 臣敢へて生還せず, marked 不㆓敢生還㆒", () => {
    const s = tree(CHEN);
    expect(readingOrder(s)).toBe("臣敢生還不");
    expect(annotate(s)).toBe("臣不[二]敢生還[一]。");
    expect(traceMarks(s)).toBe(readingOrder(s));
    expect(prose(s)).toBe("臣敢へて生還せず");
  });

  it("closes the complement with the ず — 吾陳不敢當 is 敢へて當たらず", () => {
    const s = tree(DANG);
    expect(readingOrder(s)).toBe("吾陳敢當不");
    expect(prose(s)).toContain("敢へて當たらず");
    expect(prose(s)).not.toContain("敢へず");
  });
});

describe("a negation on 敢 scopes over the predicate 敢へて introduces", () => {
  it("reads 莫敢當其前 as 敢へて其の前に當たる莫し, marked 莫㆔敢當㆓其前㆒", () => {
    const s = tree(MO_DANG);
    expect(readingOrder(s)).toBe("敢其前當莫");
    expect(annotate(s)).toBe("莫[三]敢當[二]其前[一]。");
    expect(traceMarks(s)).toBe(readingOrder(s));
    expect(prose(s)).toContain("敢へて其の前に當たる莫し");
  });

  it("reads the inner 不 of 莫敢不敬 first, and marks the chain 莫㆓敢不㆒レ敬", () => {
    // Both negations hang off 敢. The 莫 denies the whole and the 不 negates
    // 敬, which is kanbun.info's 敢えて敬せざる莫し; two chained groups, not one
    // three-member fan, so a reader of the marks alone gets the same order.
    const s = tree(MO_JING);
    expect(readingOrder(s)).toBe("民敢敬不莫");
    expect(annotate(s)).toBe("民莫[二]敢不[一レ]敬。");
    expect(traceMarks(s)).toBe(readingOrder(s));
    expect(prose(s)).toMatch(/^民敢へて敬.ざる莫し$/);
  });

  it("leaves a clause coordinated onto the complement outside the negation — 主人不敢當而陵之", () => {
    // kanbun.info: 主人敢えて当らずして之を陵ぐ. The 不 negates 當 alone.
    const s = tree(LING);
    expect(readingOrder(s)).toBe("主人敢當不而之陵");
    expect(prose(s)).toContain("敢へて當たらずして之を");
    expect(traceMarks(s)).toBe(readingOrder(s));
  });

  it("writes the に a 非 is owed on the complement, not on 敢へて — 非敢後也", () => {
    // kanbun.info: 敢えて後れたるに非ず. Before `ganClauseView` the に stood on
    // the word 敢 heads in the tree: 敢へてに後る非ず.
    const out = prose(tree(HOU));
    expect(out).toMatch(/^敢へて後.*に非ず/);
    expect(out).not.toContain("敢へてに");
  });

  it("reads a bare negated 敢 closing its clause as 敢へてせず", () => {
    // 欲去不敢, 擊之不敢, 進退不敢: kanbun.info writes 敢えてせ on all three.
    const s = tree(BARE);
    expect(ganAdverbReading(byText(s, "敢"), s)).toEqual({ reading: "あ", okurigana: "へてせ" });
    expect(prose(s)).toContain("敢へてせず");
  });
});

// 則吾豈敢？ — 論語 述而 33, gold, cut to the clause: a 敢 with nothing after it.
const QI_BARE = "則/ADV/mod>4 吾/PRON/subj>4 豈/ADV/mod>4 敢/AUX/root ？/PUNCT/punct>4";
// 吾豈敢愛之乎？ — the same frame over a complement, with a 乎 closing it.
const QI_AI = "吾/PRON/subj>3 豈/ADV/mod>3 敢/AUX/root 愛/VERB/comp:aux>3 之/PRON/comp:obj>4 乎/PART/discourse@sp>4 ？/PUNCT/punct>3";
// 回何敢死？ — 論語 先進 23, gold.
const HE_SI = "回/PROPN/subj>3 何/ADV/mod>3 敢/AUX/root 死/VERB/comp:aux>3 ？/PUNCT/punct>3";
// 孰敢不正？ — 論語 顏淵 17, gold.
const SHU_ZHENG = "孰/PRON/subj>2 敢/AUX/root 不/ADV/mod>2 正/ADJ/comp:aux>2 ？/PUNCT/punct>2";
// 敢不受天之詔命乎。 — 六韜 文師, parsed, cut to the clause.
const SHOU_MING = "敢/AUX/root 不/ADV/mod>3 受/VERB/comp:aux>1 天/NOUN/comp:obj>5 之/PART/mod>7 詔/VERB/mod>7 命/NOUN/comp:obj>3 乎/PART/discourse@sp>3 。/PUNCT/punct>1";
// 敢問其目乎 — a question asked, not a rhetorical one.
const WEN_MU = "敢/AUX/root 問/VERB/comp:aux>1 其/PRON/det>4 目/NOUN/comp:obj>2 乎/PART/discourse@sp>2 。/PUNCT/punct>1";

describe("敢へて in a rhetorical question closes on 未然形 + ん", () => {
  it("reads a bare 豈敢 as 豈に敢へてせんや", () => {
    // kanbun.info: 則ち吾豈に敢えてせんや. It read 豈に敢ふ, the verb あふ.
    const s = tree(QI_BARE);
    expect(ganAdverbReading(byText(s, "敢"), s)).toEqual({ reading: "あ", okurigana: "へてせんや" });
    expect(prose(s)).toBe("則ち吾豈に敢へてせんや");
  });

  it("reads 豈敢愛之乎 as 豈に敢へて之を愛せんや, the 乎 read as the や", () => {
    const out = prose(tree(QI_AI));
    expect(out).toBe("吾豈に敢へて之を愛せんや");
    expect(out).not.toContain("かな");
  });

  it("writes no や after a question word — 回何敢死 is 何ぞ敢へて死なん", () => {
    expect(prose(tree(HE_SI))).toBe("回何ぞ敢へて死なん");
  });

  it("writes ざらん on a negation closing the clause — 孰敢不正", () => {
    // kanbun.info: 孰か敢えて正しからざらん.
    expect(prose(tree(SHU_ZHENG))).toContain("敢へて正しからざらん");
  });

  it("takes a 乎 on the clause alone as the question — 敢不受天之詔命乎", () => {
    // kanbun.info: 敢えて天の詔命を受けざらんや.
    expect(prose(tree(SHOU_MING))).toMatch(/受けざらんや$/);
  });

  it("leaves 敢問…乎 a question asked — 敢へて其の目を問ふ", () => {
    expect(prose(tree(WEN_MU))).not.toContain("問はん");
  });
});
