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

/** A nominal that is going to be given a **case particle** is filling a slot in
 * some other predicate's clause, and must not also assert a copula — the fourth
 * of the guards on `extraEndingFor`'s synthesized なり.
 *
 * The rule the guard exists for is the one above it: a nominal with a `subj` of
 * its own is a predication wherever it sits (王仁人而智者). 咽中暴癢 satisfies
 * that and is still not a predication — 中 is the `subj` of 癢 and 癢 is 覺's
 * `comp:obj`, so it is a nominalised clause standing in the object slot, "that
 * the throat suddenly itched", and 癢さ**を** is the whole of what it wants.
 *
 * The four cases the branch exists for are asserted in
 * `kakikudashi-generator.test.ts` (王仁人而智者, 弟子三千人, 少典之子也) and in
 * `boundFormsAndPredicateParticles.test.ts` (非劉之病); what is asserted here is
 * that the guard keys on **a particle being written** rather than on a
 * relation. */
describe("a nominal filling an argument slot takes its particle and no copula", () => {
  const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
  const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
  const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
  const resolve = createReadingResolver(kanjidic, jmdict);
  const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);
  const only = (conllu: string): Sentence => {
    const tree = parseConllu(conllu);
    expect(tree.sentences).toHaveLength(1);
    return tree.sentences[0];
  };

  /** 酒蟲 sent_id 24, as the reader's own tree has it: 中 is the `subj` of 癢
   * and 癢 is the `comp:obj` of the root 覺. Trimmed to the first clause; the
   * rest of the sentence is a `parataxis` that has no bearing on this. */
  const yang = only(
    [
      "1\t忽\t忽\tADV\tv,副詞,時相,緊接\tAdvType=Tim\t2\tmod\t_\t_",
      "2\t覺\t覺\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_",
      "3\t咽\t咽\tNOUN\tn,名詞,不可譲,身体\t_\t4\tcompound\t_\t_",
      "4\t中\t中\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t6\tsubj\t_\t_",
      "5\t暴\t暴\tADV\tv,動詞,描写,態度\tDegree=Pos\t2\tmod\t_\tReading=にはか",
      "6\t癢\t癢\tNOUN\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_",
      "7\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_",
      "",
      "",
    ].join("\n"),
  );

  it("writes 癢さを and no なり — the object slot is not a predication", () => {
    const line = run(yang);
    expect(line).toContain("癢さを");
    expect(line).not.toContain("癢さをなり");
    expect(line).not.toContain("癢さなり");
  });

  it("keeps the を it stood the copula down for", () => {
    const yangToken = yang.tokens.find((t) => t.text === "癢")!;
    expect(caseParticleFor(yangToken, yang)).toBe("を");
  });

  /** 或言：『蟲是劉之福、…』 — 福 has 是 as its own `subj` and is a `comp:obj`,
   * and `caseParticleFor` stands its を down because the source brackets the
   * whole complement as a quote. Nothing is written, so the copula stays: this
   * is the case a guard keyed on the *relation* would have suppressed. */
  it("leaves the copula alone where the particle is itself withheld", () => {
    const quoted = only(
      [
        "1\t或\t或\tPRON\tn,代名詞,不定,人\t_\t2\tsubj\t_\t_",
        "2\t言\t言\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_",
        "3\t『\t『\tPUNCT\ts,記号,括弧,始\t_\t7\tpunct\t_\t_",
        "4\t蟲\t蟲\tNOUN\tn,名詞,可搬,生物\t_\t7\tdislocated\t_\t_",
        "5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\t_",
        "6\t是\t是\tPRON\tn,代名詞,指示,*\tPronType=Dem\t7\tsubj\t_\t_",
        "7\t福\t福\tNOUN\tn,名詞,描写,態度\t_\t2\tcomp:obj\t_\t_",
        "8\t。\t。\tPUNCT\ts,記号,句点,*\t_\t2\tpunct\t_\t_",
        "",
        "",
      ].join("\n"),
    );
    const fu = quoted.tokens.find((t) => t.text === "福")!;
    expect(caseParticleFor(fu, quoted)).toBeUndefined();
    expect(run(quoted)).toContain("福なり");
  });
});
