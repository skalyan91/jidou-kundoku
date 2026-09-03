import { describe, expect, it } from "vitest";
import { parseConllu, validateConlluForLzh } from "../src/parse/conlluParser.ts";

const SAMPLE = `# text = 學而時習之
1\t學\t學\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_
3\t時\t時\tNOUN\tn,名詞,時,*\tCase=Tem\t4\tmod@tmod\t_\t_
4\t習\t習\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
5\t之\t之\tPRON\tn,代名詞,人称,止格\t_\t4\tcomp:obj\t_\tSpaceAfter=No

# text = second sentence
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
`;

describe("parseConllu", () => {
  it("parses two sentences with 0-based renumbered ids", () => {
    const tree = parseConllu(SAMPLE);
    expect(tree.source).toBe("conllu");
    expect(tree.sentences).toHaveLength(2);
    expect(tree.sentences[0].tokens).toHaveLength(5);
    expect(tree.sentences[1].tokens).toHaveLength(2);
  });

  it("normalizes lowercase root deprel to ROOT and self-loops its head", () => {
    const tree = parseConllu(SAMPLE);
    const root = tree.sentences[0].tokens[0];
    expect(root.dep).toBe("ROOT");
    expect(root.head).toBe(root.id);
  });

  it("resolves head references via the renumbered id map", () => {
    const tree = parseConllu(SAMPLE);
    const [gaku, ji_, toki, shuu, kore] = tree.sentences[0].tokens;
    expect(shuu.head).toBe(gaku.id); // 習 --conj:coord--> 學
    expect(ji_.head).toBe(shuu.id); // 而 --cc--> 習
    expect(toki.head).toBe(shuu.id); // 時 --mod@tmod--> 習
    expect(kore.head).toBe(shuu.id); // 之 --comp:obj--> 習
  });

  it("captures FEATS as morph and MISC as the misc bag", () => {
    const tree = parseConllu(SAMPLE);
    const toki = tree.sentences[0].tokens[2];
    expect(toki.morph).toBe("Case=Tem");
    const kore = tree.sentences[0].tokens[4];
    expect(kore.misc).toEqual({ SpaceAfter: "No" });
  });

  it("skips multiword-token ranges and empty nodes", () => {
    const withMwt = `1-2\t之乎\t_\t_\t_\t_\t_\t_\t_\t_
1\t之\t之\t_\t_\t_\t0\troot\t_\t_
1.1\tX\t_\t_\t_\t_\t_\t_\t_\t_
2\t乎\t乎\t_\t_\t_\t1\tdiscourse@sp\t_\t_
`;
    const tree = parseConllu(withMwt);
    expect(tree.sentences[0].tokens).toHaveLength(2);
    expect(tree.sentences[0].tokens.map((t) => t.text)).toEqual(["之", "乎"]);
  });
});

describe("validateConlluForLzh", () => {
  it("accepts a plausible lzh SUD tree", () => {
    const tree = parseConllu(SAMPLE);
    const result = validateConlluForLzh(tree);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on a non-CJK, non-lzh-relation file", () => {
    const englishLike = `1\tI\tI\tPRON\t_\t_\t2\tnsubj\t_\t_
2\tgave\tgive\tVERB\t_\t_\t0\troot\t_\t_
`;
    const tree = parseConllu(englishLike);
    const result = validateConlluForLzh(tree);
    expect(result.valid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reports no tokens for an empty file", () => {
    const result = validateConlluForLzh(parseConllu(""));
    expect(result.valid).toBe(false);
    expect(result.warnings[0]).toMatch(/no tokens/i);
  });
});

describe("deprojectivization pseudo-labels", () => {
  it("collapses a `a||b` deprel to its first member", () => {
    // spaCy lifts a non-projective arc onto an ancestor and records both
    // halves in the label. The first is the dependent's own relation, which
    // is the half that describes this token; the arc stays lifted.
    const tree = parseConllu(
      `1\t哇\t哇\tVERB\tv,動詞,行為,動作\t_\t2\tmod||punct\t_\t_
2\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
`,
    );
    expect(tree.sentences[0].tokens[0].dep).toBe("mod");
  });

  it("still recognises a lifted root as ROOT", () => {
    const tree = parseConllu(`1\t有\t有\tVERB\t_\t_\t0\troot||mod\t_\t_\n`);
    expect(tree.sentences[0].tokens[0].dep).toBe("ROOT");
  });

  it("leaves an ordinary relation untouched, subtypes included", () => {
    const tree = parseConllu(
      `1\t日\t日\tNOUN\t_\t_\t2\tudep@tmod\t_\t_
2\t坐\t坐\tVERB\t_\t_\t0\troot\t_\t_
`,
    );
    expect(tree.sentences[0].tokens[0].dep).toBe("udep@tmod");
  });

  it("does not let a pseudo-label defeat the relation-inventory check", () => {
    const tree = parseConllu(
      `1\t哇\t哇\tVERB\t_\t_\t2\tmod||punct\t_\t_
2\t有\t有\tVERB\t_\t_\t0\troot\t_\t_
`,
    );
    expect(validateConlluForLzh(tree).warnings.some((w) => /relation inventory/.test(w))).toBe(false);
  });
});
