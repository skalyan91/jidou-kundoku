import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { caseParticleFor } from "../src/kakikudashi/conjugationContext.ts";

/** **A bare 今/昔/夜 takes no に** — `isBareTimeAdverbial`.
 *
 * `CASE_PARTICLE_FOR_DEP` gives every oblique relation に, `mod@tmod` and
 * `udep@tmod` among them, so 今天下大亂 came out 今に天下大いに亂る. kanbun.info
 * writes 今、 43 times against 今に 6, and none of the 6 is a time adverbial.
 * The に stays where the received readings write it: on 朝 and 夕, and on a
 * time phrase with a modifier of its own.
 *
 * 燕軍夜大驚 and 今君已戒 are lzh_sud_kyoto 0.3.3 parses from the kanbun.info
 * corpus, and 朝聞道，夕死可矣 is gold. */
describe("a bare time noun standing as a clause adverbial", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);
  const only = (rows: string[]): Sentence => {
    const tree = parseConllu(rows.join("\n") + "\n\n");
    expect(tree.sentences).toHaveLength(1);
    return tree.sentences[0];
  };
  const at = (s: Sentence, text: string): Sentence["tokens"][number] => s.tokens.filter((t) => t.text === text)[0];

  /** 今君已戒 (呉子 料敵). Received: 今、君已に戒む. */
  const jinJun = only([
    "1\t今\t今\tNOUN\tn,名詞,時,*\tCase=Tem\t4\tmod@tmod\t_\t_",
    "2\t君\t君\tNOUN\tn,名詞,人,役割\t_\t4\tsubj\t_\t_",
    "3\t已\t已\tADV\tv,副詞,時相,完了\tAdvType=Tim|Aspect=Perf\t4\tmod\t_\t_",
    "4\t戒\t戒\tVERB\tv,動詞,行為,態度\t_\t0\troot\t_\t_",
    "5\t。\t。\tPUNCT\ts,記号,句点,*\t_\t4\tpunct\t_\t_",
  ]);

  it("writes 今 bare — 今君已に戒む, not 今に", () => {
    expect(caseParticleFor(at(jinJun, "今"), jinJun)).toBeUndefined();
    expect(run(jinJun)).not.toContain("今に");
  });

  /** 燕軍夜大驚 (史記 田單列傳). Received: 燕の軍夜大いに驚く. 夜 is in the set on
   * the count (bare on 17 of its 19 tokens), not because it is deictic. The
   * の on 燕軍 stays: 軍 is not one of the nouns `isStateNameOnItsPeople`
   * takes a state name onto without one. */
  const yanJunYe = only([
    "1\t燕\t燕\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t2\tmod\t_\t_",
    "2\t軍\t軍\tNOUN\tn,名詞,主体,集団\t_\t5\tsubj\t_\t_",
    "3\t夜\t夜\tNOUN\tn,名詞,時,*\tCase=Tem\t5\tmod@tmod\t_\t_",
    "4\t大\t大\tADV\tv,動詞,描写,量\tDegree=Pos|VerbForm=Conv\t5\tmod\t_\t_",
    "5\t驚\t驚\tVERB\tv,動詞,行為,態度\t_\t0\troot\t_\t_",
    "6\t。\t。\tPUNCT\ts,記号,句点,*\t_\t5\tpunct\t_\t_",
  ]);

  it("writes 夜 bare — 燕の軍夜大いに驚く", () => {
    expect(run(yanJunYe)).toContain("燕の軍夜大いに驚く");
  });

  it("keeps に on a time noun with a modifier of its own — 夜半に", () => {
    // A minimal tree, not a quoted one: 半 standing on 夜 makes the phrase a
    // qualified point in time again, and the received text writes 夜半に傳發す.
    const s = only([
      "1\t夜\t夜\tNOUN\tn,名詞,時,*\tCase=Tem\t3\tmod@tmod\t_\t_",
      "2\t半\t半\tNOUN\tn,名詞,数量,*\t_\t1\tmod\t_\t_",
      "3\t發\t發\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_",
      "4\t。\t。\tPUNCT\ts,記号,句点,*\t_\t3\tpunct\t_\t_",
    ]);
    expect(caseParticleFor(at(s, "夜"), s)).toBe("に");
  });

  /** 朝聞道，夕死可矣 (論語 里仁 8) — the quotation from the gold tree, without
   * the 子曰 frame around it. Received: 朝に道を聞かば、夕べに死すとも可なり. */
  const zhaoWenDao = only([
    "1\t朝\t朝\tNOUN\tn,名詞,時,*\tCase=Tem\t2\tudep@tmod\t_\t_",
    "2\t聞\t聞\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_",
    "3\t道\t道\tNOUN\tn,名詞,制度,儀礼\t_\t2\tcomp:obj\t_\t_",
    "4\t，\t，\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_",
    "5\t夕\t夕\tNOUN\tn,名詞,時,*\tCase=Tem\t6\tudep@tmod\t_\t_",
    "6\t死\t死\tVERB\tv,動詞,変化,生物\t_\t7\tsubj\t_\t_",
    "7\t可\t可\tADJ\tv,動詞,描写,態度\tDegree=Pos\t2\tparataxis\t_\t_",
    "8\t矣\t矣\tPART\tp,助詞,句末,*\t_\t7\tdiscourse@sp\t_\t_",
    "9\t。\t。\tPUNCT\ts,記号,句点,*\t_\t7\tpunct\t_\t_",
  ]);

  it("keeps に on 朝 and 夕, which the received text marks", () => {
    expect(caseParticleFor(at(zhaoWenDao, "朝"), zhaoWenDao)).toBe("に");
    expect(caseParticleFor(at(zhaoWenDao, "夕"), zhaoWenDao)).toBe("に");
  });
});
