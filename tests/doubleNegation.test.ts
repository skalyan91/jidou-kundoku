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
import { auxiliaryComplementNegated } from "../src/kundoku/depClassification.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { negationEnding } from "../src/kakikudashi/conjugationContext.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";

// ---------------------------------------------------------------------------
// Two verbal negations, one denying the other.
//
// 不敢不告 came out 敢へて告げずざる and 不可不知 知る可からずざる: the second ず
// suffixed straight onto the first, or both read after 可. kanbun.info reads
// the first 敢へて告げずんばあらざる — ず + は, nasalised, then あら for the outer
// ず to stand on — and the second 知らざる可からざる, the inner negation read with
// the verb it negates and before the auxiliary. See `auxiliaryComplementNegated`
// in depClassification.ts (the reading order and the slot) and the
// double-negation arms of `negationEndingParts` in conjugationContext.ts (the
// forms), which carry the counts.
//
// The trees are the corpus parses (tests/fixtures/kanbun-info-parses.conllu),
// cut down to the clause, written `text/UPOS/deprel>head` with 1-based heads.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** The treebank tags these trees carry, keyed by character. */
const XPOS: Record<string, [string, string]> = {
  敢: ["v,助動詞,願望,*", "Mood=Des"],
  可: ["v,助動詞,可能,*", "Mood=Pot"],
  得: ["v,助動詞,可能,*", "Mood=Pot"],
  能: ["v,助動詞,可能,*", "Mood=Pot"],
  不: ["v,副詞,否定,無界", "Polarity=Neg"],
  未: ["v,副詞,否定,有界", "Polarity=Neg"],
  非: ["v,副詞,否定,体言否定", "Polarity=Neg"],
  嘗: ["v,副詞,時相,過去", "AdvType=Tim|Tense=Past"],
  善: ["v,動詞,描写,態度", "_"],
  告: ["v,動詞,行為,伝達", "_"],
  勉: ["v,動詞,行為,動作", "_"],
  知: ["v,動詞,行為,動作", "_"],
  察: ["v,動詞,行為,動作", "_"],
  見: ["v,動詞,行為,動作", "_"],
  爭: ["v,動詞,行為,交流", "_"],
  戰: ["v,動詞,行為,交流", "_"],
  失: ["v,動詞,行為,得失", "_"],
  改: ["v,動詞,行為,動作", "_"],
  也: ["p,助詞,句末,*", "_"],
};

function tree(spec: string): Sentence {
  const rows = spec
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      const [text, pos, rel] = word.split("/");
      const [dep, head] = rel.includes(">") ? rel.split(">") : [rel, "0"];
      const [xpos, feats] = XPOS[text] ?? ["_", "_"];
      return [i + 1, text, text, pos, xpos, feats, dep === "root" ? "0" : head, dep, "_", "_"].join("\t");
    });
  const parsed = parseConllu(rows.join("\n") + "\n");
  expect(parsed.sentences).toHaveLength(1);
  return parsed.sentences[0];
}

const planOf = (s: Sentence) => computeReadingOrder(s, findCompoundSpans(s, { kanjidic, jmdict }));
const prose = (s: Sentence) => generateKakikudashi(planOf(s), resolve);
const nth = (s: Sentence, text: string, n = 0) => s.tokens.filter((t) => t.text === text)[n];

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

// 以吾從大夫之後，不敢不告也。 — 論語 憲問 22, gold, cut to its last clause.
const GAN_GAO = "吾/PRON/subj>3 不/ADV/mod>3 敢/AUX/root 不/ADV/mod>3 告/VERB/comp:aux>3 也/PART/discourse@sp>5 。/PUNCT/punct>3";
// 喪事不敢不勉， — 論語 子罕 16, gold.
const GAN_MIAN = "喪/NOUN/mod>2 事/NOUN/subj>4 不/ADV/mod>4 敢/AUX/root 不/ADV/mod>4 勉/VERB/comp:aux>4 。/PUNCT/punct>4";
// 父母之年，不可不知也。 — 論語 里仁 21, gold, from the comma.
const KE_ZHI = "年/NOUN/subj>3 不/ADV/mod>3 可/AUX/root 不/ADV/mod>3 知/VERB/comp:aux>3 也/PART/discourse@sp>5 。/PUNCT/punct>3";
// 臣不可以不爭於君。 — 孝經 諫爭, parsed.
const KE_ZHENG = "臣/NOUN/subj>3 不/ADV/mod>3 可/AUX/root 以/VERB/unk>3 不/ADV/mod>3 爭/VERB/comp:aux>3 於/ADP/comp:obl>6 君/NOUN/comp:obj>7 。/PUNCT/punct>3";
// 吾未嘗不得見也。 — 論語 八佾 24, gold, cut to the clause.
const CHANG_JIAN = "吾/PRON/subj>5 未/ADV/mod>5 嘗/ADV/mod>5 不/ADV/mod>5 得/AUX/root 見/VERB/comp:aux>5 也/PART/discourse@sp>6 。/PUNCT/punct>5";
// 不得不戰。 — the shape 不可不 takes under 得; kanbun.info reads ざるを得 on all
// three of its occurrences, none of which the parser gives this tree.
const DE_ZHAN = "不/ADV/mod>2 得/AUX/root 不/ADV/mod>2 戰/VERB/comp:aux>2 。/PUNCT/punct>2";
// 然後能不失天下。 — 六韜 文師, parsed.
const NENG_SHI = "然/ADV/mod>3 後/NOUN/mod@tmod>3 能/AUX/root 不/ADV/mod>3 失/VERB/comp:aux>3 天/NOUN/compound>7 下/NOUN/comp:obj>5 。/PUNCT/punct>3";
// 不善不能改， — 論語 述而 3, gold: two 不 side by side, and not one denying the other.
const SHAN_GAI = "不/ADV/mod>2 善/ADV/mod>4 不/ADV/mod>4 能/AUX/root 改/VERB/comp:aux>4 。/PUNCT/punct>4";

describe("不敢不V reads 敢へてVずんばあらず", () => {
  it("reads 不敢不告也 as 敢へて告げずんばあらざるなり", () => {
    const s = tree(GAN_GAO);
    expect(readingOrder(s)).toBe("吾敢告不不也");
    expect(traceMarks(s)).toBe(readingOrder(s));
    // 吿 is the treebank lemma of 告, and this tree writes the form, so the
    // verb stem is not what is asserted.
    expect(prose(s)).toMatch(/^吾敢へて告.ずんばあらざるなり$/);
    // One helper writes both panels' negation: the inner 不 carries the
    // ずんばあら, the outer one its own ざる.
    const plan = planOf(s);
    expect(negationEnding(nth(s, "不", 1), plan, resolve)).toBe("ずんばあら");
    expect(negationEnding(nth(s, "不", 0), plan, resolve)).toBe("ざる");
  });

  it("closes on the 終止形 where nothing follows — 喪事不敢不勉", () => {
    const s = tree(GAN_MIAN);
    expect(prose(s)).toContain("敢へて勉めずんばあらず");
    expect(prose(s)).not.toContain("ずず");
  });

  it("leaves two 不 that do not share a head apart — 不善不能改", () => {
    // The first 不 hangs on 善, an adverb of 能; walking that chain reads it
    // beside the second, and neither denies the other.
    expect(prose(tree(SHAN_GAI))).not.toContain("ずんば");
  });
});

describe("the inner negation of 不可不V is read with V, before 可", () => {
  it("reads 不可不知也 as 知らざる可からざるなり, marked 不レ可レ不レ知", () => {
    const s = tree(KE_ZHI);
    const inner = nth(s, "不", 1);
    expect(auxiliaryComplementNegated(inner, s)?.text).toBe("知");
    expect(auxiliaryComplementNegated(nth(s, "不", 0), s)).toBeUndefined();
    expect(readingOrder(s)).toBe("年知不可不也");
    expect(annotate(s)).toBe("年不[レ]可[レ]不[レ]知也。");
    expect(traceMarks(s)).toBe(readingOrder(s));
    expect(prose(s)).toContain("知らざる可からざるなり");
  });

  it("reads 不可以不爭於君 as 以て君に爭はざる可からず", () => {
    const s = tree(KE_ZHENG);
    expect(traceMarks(s)).toBe(readingOrder(s));
    expect(prose(s)).toContain("以て君に爭はざる可からず");
  });

  it("writes ざるを before a 得 — 不得不戰 is 戰はざるを得ず", () => {
    const s = tree(DE_ZHAN);
    expect(readingOrder(s)).toBe("戰不得不");
    expect(prose(s)).toBe("戰はざるを得ず");
  });

  it("leaves 能 the adverb over a negated complement — 能不失天下 is 能く天下を失はず", () => {
    const s = tree(NENG_SHI);
    expect(prose(s)).toContain("能く天下を失はず");
    expect(prose(s)).not.toContain("能はず");
  });
});

describe("未嘗不V reads 未だ嘗てVずんばあらず", () => {
  it("writes ずんばあら on the 不 and ざる for 未 before なり — 吾未嘗不得見也", () => {
    // kanbun.info: 吾未だ嘗て見ゆることを得ずんばあらざるなり. The こと and を
    // belong to the complement of 得, which this change does not touch.
    const s = tree(CHANG_JIAN);
    expect(prose(s)).toMatch(/^吾未だ嘗て.*得ずんばあらざるなり$/);
  });
});
