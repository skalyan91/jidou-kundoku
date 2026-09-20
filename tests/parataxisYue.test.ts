import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { isSpeechQuoteComplement, quoteFramingYue } from "../src/kundoku/depClassification.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import {
  conjugatedOkurigana,
  conjugationSubject,
  converbSuffix,
  decideConjForm,
  isNamingUse,
  lexiconEntryFor,
  nextMeaningfulToken,
} from "../src/kakikudashi/conjugationContext.ts";
import { renyouTeSuffix, setRenyouTe } from "../src/kakikudashi/renyouTe.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { type JmdictIndex } from "../src/reading/jmdictLookup.ts";

// ---------------------------------------------------------------------------
// 曰 on `parataxis` of the verb before it — V之曰, the treebank's shape for
// "did V to him and said". Three faults met in that one shape, and each block
// below is one of them:
//
//  1. A short nominal quotation set off by a mark (曰、善) was read as a name,
//     so 曰 lost 曰く and the quote inverted and took を.
//  2. A quotation hung on the *verb* rather than on 曰 got no closing と.
//  3. The verb took the bare 連用形 of a coordination chain (笑ひ、曰く) where
//     kundoku writes the て (笑ひて曰く).
//
// The trees are written out token by token, in the treebank's own relation
// spelling and through `parseConllu`, which is what renumbers ids from zero
// and turns `root` into `ROOT`; a hand-built literal would hide either.
// ---------------------------------------------------------------------------

afterEach(() => setRenyouTe(false));

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** `text/UPOS/deprel>head` per token, 1-based heads as in CoNLL-U. */
function tree(spec: string): Sentence {
  const rows = spec
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      const [text, pos, rel] = word.split("/");
      const [dep, head] = rel.includes(">") ? rel.split(">") : [rel, "0"];
      const xpos = text === "曰" ? "v,動詞,行為,伝達" : "_";
      return [i + 1, text, text, pos, xpos, "_", dep === "root" ? "0" : head, dep, "_", "_"].join("\t");
    });
  const parsed = parseConllu(rows.join("\n") + "\n");
  expect(parsed.sentences).toHaveLength(1);
  return parsed.sentences[0];
}

const prose = (s: Sentence) => generateKakikudashi(computeReadingOrder(s), resolve);
const byText = (s: Sentence, text: string, nth = 0) => s.tokens.filter((t) => t.text === text)[nth];

/** What the 訓読文 panel writes beside a lexicon verb: the paradigm cell, the
 * converb て and the 連用形-て switch, assembled from the functions
 * `KundokuView.ts`'s lexicon branch calls, with the sentence it passes. */
function panelOkurigana(s: Sentence, id: number): string {
  const plan = computeReadingOrder(s);
  const token = s.tokens.find((t) => t.id === id)!;
  const lex = lexiconEntryFor(token, resolve(token, s), s)!;
  expect(lex.conjClass).toBeDefined();
  const next = nextMeaningfulToken(plan, token.id);
  const form = decideConjForm(conjugationSubject(token, s), next, s, lex.conjClass, resolve);
  const okurigana = conjugatedOkurigana(lex, form);
  const converbTe = converbSuffix(token, next, lex.conjClass, form, s);
  return okurigana + converbTe + renyouTeSuffix({ form, conjClass: lex.conjClass, okurigana, converbTe, nextToken: next });
}

// 王笑之曰、善。 — the sentence this was written for.
const WANG_XIAO = "王/NOUN/subj>2 笑/VERB/root 之/PRON/comp:obj>2 曰/VERB/parataxis>2 、/PUNCT/punct>4 善/NOUN/comp:obj>4 。/PUNCT/punct>2";

// 夫子矢之曰：「予所否者，天厭之！」 — the quotation is 厭, on `parataxis` of 矢.
const SHI_ZHI =
  "夫子/NOUN/subj>2 矢/VERB/root 之/PRON/comp:obj>2 曰/VERB/parataxis>2 ：/PUNCT/punct>4 予/PRON/subj>8 所/PART/mod>8 否/VERB/comp:obj>9 者/PART/dislocated>11 天/NOUN/subj>11 厭/VERB/parataxis>2 之/PRON/comp:obj>11 。/PUNCT/punct>11";

// 譽之曰、吾楯之堅、莫能陷也。 — 矛盾, with the quotation on 譽 as well.
const YU_DUN =
  "譽/VERB/root 之/PRON/comp:obj>1 曰/VERB/parataxis>1 、/PUNCT/punct>3 吾/PRON/det>6 楯/NOUN/subj>8 之/SCONJ/mod>6 堅/NOUN/dislocated>10 、/PUNCT/punct>8 莫/VERB/parataxis>1 能/AUX/comp:obj>10 陷/VERB/comp:aux>11 也/PART/discourse@sp>10 。/PUNCT/punct>10";

describe("a nominal set off from 曰 by a mark is a quotation, not a name", () => {
  it("reads 王笑之曰、善 with 曰く and a closing と, not 善を曰ふ", () => {
    const s = tree(WANG_XIAO);
    const shan = byText(s, "善");
    expect(isSpeechQuoteComplement(shan, byText(s, "曰"), s)).toBe(true);
    expect(isNamingUse(byText(s, "曰"), s)).toBe(false);
    const out = prose(s);
    expect(out.startsWith("王之を笑ひて曰く、")).toBe(true);
    expect(out).not.toContain("を曰ふ");
    expect(computeReadingOrder(s).quoteEndIds).toEqual(new Set([shan.id]));
  });

  it("leaves a name that runs straight on from 曰 a name — 名曰軒轅", () => {
    // No mark stands between 曰 and 軒轅, which is the whole of the difference
    // from the sentence above: a name is 曰's second object and nothing
    // separates a verb from its object.
    const s = tree("名/NOUN/subj>2 曰/VERB/root 軒轅/PROPN/comp:obj>2 。/PUNCT/punct>2");
    expect(isNamingUse(byText(s, "曰"), s)).toBe(true);
    expect(prose(s)).toContain("軒轅と曰ふ");
  });

  it("reads a mark glued onto the next word the same way — 曰 + 、安", () => {
    // The parser sometimes returns the mark fused to the word after it.
    const s = tree("曰/VERB/root 、安/NOUN/comp:obj>1 。/PUNCT/punct>1");
    expect(isNamingUse(byText(s, "曰"), s)).toBe(false);
  });
});

describe("a quotation hung on the verb before 曰 closes with と", () => {
  it("closes 夫子矢之曰：予所否者天厭之 after 厭, the parataxis of 矢", () => {
    const s = tree(SHI_ZHI);
    const yan = byText(s, "厭");
    expect(quoteFramingYue(yan, s)).toBe(byText(s, "曰").id);
    expect(computeReadingOrder(s).quoteEndIds).toEqual(new Set([yan.id]));
    const out = prose(s);
    expect(out).toContain("曰く、");
    expect(out.endsWith("厭ふと")).toBe(true);
  });

  it("closes once, after the last sibling, when 曰 frames two — 子曰、舉直錯諸枉、能使枉者直", () => {
    // 舉 on `conj:coord` and 使 on `parataxis`, both of the verb before 曰 (達 in
    // the passage, 問 in this shortened tree). A と after each
    // would close the quotation in the middle of it.
    const s = tree(
      "樊遲/PROPN/subj>2 問/VERB/root 曰/VERB/parataxis>2 、/PUNCT/punct>3 舉/VERB/conj:coord>2 直/NOUN/comp:obj>5 錯/VERB/conj:coord>5 諸/PRON/comp:obj>7 枉/VERB/comp:obj>7 、/PUNCT/punct>5 能/AUX/mod>12 使/VERB/parataxis>2 枉/VERB/subj>14 者/PART/comp:obj>12 直/VERB/comp:pred>12 。/PUNCT/punct>12",
    );
    const shi = byText(s, "使");
    expect(computeReadingOrder(s).quoteEndIds.size).toBe(1);
    expect(quoteFramingYue(byText(s, "舉"), s)).toBe(byText(s, "曰").id);
    expect(quoteFramingYue(shi, s)).toBe(byText(s, "曰").id);
    expect(prose(s).endsWith("と")).toBe(true);
  });

  it("does not invert a comp:obj of the verb that stands after 曰", () => {
    // 大宰問於子貢曰、夫子聖者與 — 者 is `comp:obj` of 問 and is what was asked;
    // inverted, it read in front of 問 with を.
    const s = tree(
      "大宰/NOUN/subj>2 問/VERB/root 於/ADP/mod>2 子貢/PROPN/comp:obj>3 曰/VERB/parataxis>2 、/PUNCT/punct>5 夫子/NOUN/subj>9 聖/NOUN/mod>9 者/PART/comp:obj>2 與/PART/discourse@sp>9 。/PUNCT/punct>2",
    );
    const zhe = byText(s, "者");
    expect(isSpeechQuoteComplement(zhe, byText(s, "問"), s)).toBe(true);
    const order = computeReadingOrder(s).order;
    expect(order.indexOf(zhe.id)).toBeGreaterThan(order.indexOf(byText(s, "曰").id));
  });

  it("frames nothing when 曰 has a complement of its own", () => {
    const s = tree(
      "子/NOUN/subj>2 聞/VERB/root 之/PRON/comp:obj>2 曰/VERB/parataxis>2 、/PUNCT/punct>4 是/PRON/subj>7 禮/NOUN/comp:obj>4 也/PART/discourse@sp>7 。/PUNCT/punct>7",
    );
    expect(quoteFramingYue(byText(s, "禮"), s)).toBeUndefined();
    expect(computeReadingOrder(s).quoteEndIds).toEqual(new Set([byText(s, "也").id]));
  });
});

describe("the verb before 曰 takes 連用形 + て", () => {
  it("writes 譽 as 譽りて曰く, in the prose and beside the character", () => {
    // The 矛盾 story. The quotation is 莫, a parataxis of 譽 (see above), so
    // this sentence exercises all three faults at once.
    const s = tree(YU_DUN);
    const out = prose(s);
    expect(out).toMatch(/^之を譽[^曰]*て曰く、/);
    expect(out.endsWith("と")).toBe(true);
    expect(panelOkurigana(s, byText(s, "譽").id).endsWith("て")).toBe(true);
  });

  it("writes it with the 連用形-て switch off, and does not double it with the switch on", () => {
    // て曰く is the fixed form of the phrase, not one of the two printing
    // conventions the switch chooses between — see `takesTeBeforeYue`.
    const s = tree(WANG_XIAO);
    const xiao = byText(s, "笑").id;
    setRenyouTe(false);
    expect(prose(s)).toContain("笑ひて曰く");
    expect(panelOkurigana(s, xiao)).toBe("ひて");
    setRenyouTe(true);
    expect(prose(s)).toContain("笑ひて曰く");
    expect(panelOkurigana(s, xiao)).toBe("ひて");
  });

  it("writes it on a 下二段 verb, which the Conv-て rule would refuse — 避けて曰く", () => {
    const s = tree(
      "曾子/PROPN/subj>2 避/VERB/root 席/NOUN/comp:obj>2 曰/VERB/parataxis>2 、/PUNCT/punct>4 參/PROPN/subj>8 不/ADV/mod>8 敏/ADJ/comp:obj>4 。/PUNCT/punct>8",
    );
    expect(prose(s)).toContain("避けて曰く");
  });

  it("writes it before a verb of naming, whose name runs straight on — 命之曰大紀", () => {
    // kanbun.info: 之を命けて大紀と曰う. The name inverts in front of 曰, so the
    // token read after 命 is 大紀, not 曰.
    const s = tree("命/VERB/root 之/PRON/comp:obj>1 曰/VERB/parataxis>1 大紀/NOUN/comp:obj>3 。/PUNCT/punct>1");
    expect(prose(s)).toMatch(/^之を命[^大]*て大紀/);
  });

  it("does not write it where the verb heads a clause the parser hung 曰 off — 以一擊十曰走", () => {
    // kanbun.info: 一を以て十を撃つを走と曰う. No mark after 曰 and 擊 is not a
    // verb of naming.
    const s = tree("以/ADV/mod>3 一/NUM/obl>1 擊/VERB/root 十/NUM/comp:obj>3 曰/VERB/parataxis>3 走/VERB/comp:obj>5 。/PUNCT/punct>3");
    expect(prose(s)).not.toContain("擊ちて");
  });

  it("does not write it when 曰 has its own speaker — 南宮适出，子曰", () => {
    const s = tree(
      "南宮适/PROPN/subj>2 出/VERB/root ，/PUNCT/punct>2 子/NOUN/subj>5 曰/VERB/parataxis>2 ：/PUNCT/punct>5 君子/NOUN/comp:obj>5 哉/PART/discourse@sp>7 。/PUNCT/punct>5",
    );
    expect(prose(s)).not.toMatch(/出でて/);
  });
});
