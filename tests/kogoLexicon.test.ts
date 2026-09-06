import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// The build script is imported for its tables, not run — importing it must not
// start a 186MB download, which is why its `main()` is guarded on argv.
import { CITATION_OKURIGANA_OF, buildIndex, conjClassOf } from "../scripts/build-kogo-lexicon.mjs";
import { CONJ_CLASS_CARTOUCHE, conjugate, isConjClass } from "../src/kakikudashi/classicalConjugation.ts";

type Sense = { conjClass: string; reading: string; okuriganaPrefix?: string };

const INDEX: Record<string, Sense[]> = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "public", "data", "kogo-lexicon-index.json"), "utf-8"),
);

const senses = Object.values(INDEX).flat();

describe("kogo-lexicon-index (中古和文UniDic-derived)", () => {
  it("keys every entry on a single character", () => {
    const multi = Object.keys(INDEX).filter((k) => [...k].length !== 1);
    expect(multi).toEqual([]);
  });

  it("names only conjugation classes classicalConjugation.ts actually has", () => {
    const unknown = [...new Set(senses.map((s) => s.conjClass))].filter((c) => !isConjClass(c));
    expect(unknown).toEqual([]);
  });

  it("gives every sense a hiragana reading and at most one kana of okurigana prefix", () => {
    const bad = senses.filter(
      (s) => !/^[ぁ-ゟ]+$/u.test(s.reading) || (s.okuriganaPrefix ?? "").length > 1,
    );
    expect(bad).toEqual([]);
  });

  /** The subtraction this index is built by, run forwards again: appending the
   * class's own 終止形 to the reading plus prefix has to reproduce a citation
   * form, which is only true if the reading really is the stem. */
  it("reproduces a citation form from every sense", () => {
    const bad = senses.filter((s) => {
      const cited = s.reading + (s.okuriganaPrefix ?? "") + conjugate(s.conjClass as never, "shuushi");
      return !cited.startsWith(s.reading) || cited.length < s.reading.length;
    });
    expect(bad).toEqual([]);
  });

  /** The eight verbs `verbLexicon.ts`'s own doc names as Wiktionary's measured
   * hole: a modern え-row verb with no bungo table at all, so no 下二段 sense.
   * This index is worth having only if it fills them, so it is asserted rather
   * than described. */
  it("supplies the 下二段 senses Wiktionary has no table for", () => {
    for (const [kanji, reading] of [
      ["伝", "つた"],
      ["構", "かま"],
      ["仕", "つか"],
      ["添", "そ"],
      ["揃", "そろ"],
      ["震", "ふる"],
      ["教", "をし"],
      ["考", "かんが"],
    ] as const) {
      expect(INDEX[kanji]).toContainEqual({ conjClass: "shimo-nidan-ha", reading });
    }
  });

  /** Aggregation, not adaptation: the CC BY-NC-SA data may sit beside the
   * CC BY-SA index but never inside it. A merge would be silent, so it is
   * caught here — the Wiktionary index must not have grown any of the senses
   * that are this file's alone. */
  it("stays out of the CC BY-SA verb-lexicon-index", () => {
    const wiktionary: Record<string, Sense[]> = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "src", "kakikudashi", "verb-lexicon-index.json"), "utf-8"),
    );
    for (const kanji of ["震", "考"]) {
      expect(wiktionary[kanji]).toBeUndefined();
    }
    expect(Object.keys(wiktionary).length).toBeLessThan(Object.keys(INDEX).length);
  });
});

describe("build-kogo-lexicon table guards", () => {
  /** The citation table is the app's own 終止形 for every inflecting class, and
   * this walks the union cell by cell to keep it that way — a paradigm edited
   * in `classicalConjugation.ts` without this table following it would silently
   * subtract the wrong ending and emit stems that are off by a mora.
   *
   * The two 形容動詞 are exempt, and the exemption is the point rather than an
   * escape: UniDic makes なり/たり a separate 断定の助動詞 and leaves the 形状詞
   * uninflecting, so what its 書字形基本形 ends in is nothing at all, while this
   * app's paradigm inflects the copula as part of the word. Asserted as an
   * explicit disagreement so that neither side can drift into the other. */
  it("carries the app's own 終止形 for every class but the two 形容動詞", () => {
    const copula = new Set(["nari-keiyoudoushi", "tari-keiyoudoushi"]);
    for (const [conjClass, okurigana] of Object.entries(CITATION_OKURIGANA_OF)) {
      expect(isConjClass(conjClass)).toBe(true);
      if (copula.has(conjClass)) {
        expect(okurigana).toBe("");
        expect(conjugate(conjClass as never, "shuushi")).not.toBe("");
      } else {
        expect(conjugate(conjClass as never, "shuushi")).toBe(okurigana);
      }
    }
  });

  /** Total over the union, not merely consistent with it. `CONJ_CLASS_CARTOUCHE`
   * is a `Record<ConjClass, string>`, so the compiler already forces it to name
   * every class — which makes its key set the one runtime enumeration of the
   * union there is. A `ConjClass` added to `classicalConjugation.ts` and not to
   * the citation table would leave `buildIndex` looking up `undefined` for a
   * class `conjClassOf` had just returned; this is what catches that. */
  it("covers every ConjClass the app has", () => {
    expect(Object.keys(CITATION_OKURIGANA_OF).sort()).toEqual(Object.keys(CONJ_CLASS_CARTOUCHE).sort());
  });

  it("maps UniDic's 活用型 onto ConjClass, and refuses what has none", () => {
    expect(conjClassOf("文語下二段-ハ行", "動詞", "一般")).toBe("shimo-nidan-ha");
    expect(conjClassOf("文語四段-ラ行-一般", "動詞", "一般")).toBe("yodan-ra");
    expect(conjClassOf("文語上一段-ワ行", "動詞", "一般")).toBe("kami-ichidan");
    expect(conjClassOf("文語ラ行変格", "動詞", "一般")).toBe("ra-hen");
    expect(conjClassOf("文語形容詞-シク", "形容詞", "一般")).toBe("shiku-keiyoushi");
    // 形容動詞 have no 活用型: UniDic splits them into an uninflecting 形状詞
    // plus a 断定の助動詞, and pos2 is what tells ナリ from タリ.
    expect(conjClassOf("*", "形状詞", "一般")).toBe("nari-keiyoudoushi");
    expect(conjClassOf("*", "形状詞", "タリ")).toBe("tari-keiyoudoushi");
    // The three classical 活用型 `ConjClass` genuinely lacks.
    expect(conjClassOf("文語下一段-カ行", "動詞", "一般")).toBeNull();
    expect(conjClassOf("文語上二段-ザ行", "動詞", "一般")).toBeNull();
    expect(conjClassOf("文語上二段-ワ行", "動詞", "一般")).toBeNull();
    // Auxiliaries are bungoConjugation.ts's, and modern classes are nobody's.
    expect(conjClassOf("文語助動詞-ベシ", "助動詞", "*")).toBeNull();
    expect(conjClassOf("五段-ラ行", "動詞", "一般")).toBeNull();
    expect(conjClassOf("下一段-ア行", "動詞", "一般")).toBeNull();
  });

  it("refuses compounds, modernised spellings, bare irregulars and 連濁 shadows", () => {
    const row = (feature: string, wcost = 100) => ({ wcost, feature });
    const pad = (fields: string[]) => {
      const f = [...fields];
      while (f.length < 29) f.push("*");
      return f.join(",");
    };
    // pos1,pos2,pos3,pos4,cType,cForm,lForm,lemma,orth,pron,orthBase,pron,goshu,
    // ...through to index 21, 仮名形基本形.
    const verb = (cType: string, orthBase: string, kanaBase: string) =>
      pad([
        "動詞", "一般", "*", "*", cType, "終止形-一般", "*", "*", "*", "*",
        orthBase, "*", "和", "*", "*", "*", "*", "*", "*", "用", "*", kanaBase,
      ]);

    const { index, stats } = buildIndex([
      // Kept: the historical spelling, its okurigana ending in the ハ行 終止形.
      row(verb("文語下二段-ハ行", "教ふ", "ヲシフ"), 5),
      // Refused: the modernised spelling of the very same lexeme.
      row(verb("文語下二段-ハ行", "教う", "オシウ")),
      // Refused: a compound whose leading kanji is not the word.
      row(verb("文語四段-ラ行", "教え労わる", "オシエイタワル")),
      // Refused: single-kanji-plus-kana by shape, compound by fact.
      row(verb("文語四段-ラ行", "出しゃばる", "デシャバル")),
      // Refused: カ変 来, whose paradigm is okurigana all the way down.
      row(verb("文語カ行変格", "来", "ク")),
      // Kept, then dropped as a 連濁 shadow of the 伝ふ beside it.
      row(verb("文語四段-ハ行", "伝ふ", "ツタフ"), 7),
      row(verb("文語四段-ハ行", "伝ふ", "ヅタフ"), 9),
    ]);

    expect(index).toEqual({ 教: [{ conjClass: "shimo-nidan-ha", reading: "をし" }], 伝: [{ conjClass: "yodan-ha", reading: "つた" }] });
    expect(stats.notOneKanji).toBe(1);
    expect(stats.orthographyDisagreesWithClass).toBe(2);
    expect(stats.prefixTooLong).toBe(1);
    expect(stats.rendakuShadow).toBe(1);
  });

  it("orders a kanji's senses by MeCab's own word cost, cheapest first", () => {
    const pad = (fields: string[]) => {
      const f = [...fields];
      while (f.length < 29) f.push("*");
      return f.join(",");
    };
    const verb = (cType: string, orthBase: string, kanaBase: string) =>
      pad([
        "動詞", "一般", "*", "*", cType, "終止形-一般", "*", "*", "*", "*",
        orthBase, "*", "和", "*", "*", "*", "*", "*", "*", "用", "*", kanaBase,
      ]);
    const { index } = buildIndex([
      { wcost: 900, feature: verb("文語四段-タ行", "立つ", "タツ") },
      { wcost: 100, feature: verb("文語下二段-タ行", "立つ", "タツ") },
    ]);
    expect((index as Record<string, Sense[]>)["立"]?.[0]?.conjClass).toBe("shimo-nidan-ta");
  });
});
