import { describe, expect, it } from "vitest";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { exportConllu } from "../src/parse/conlluExporter.ts";
import type { TokenTree } from "../src/parse/types.ts";

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

describe("exportConllu", () => {
  it("round-trips a parsed tree back through parseConllu to an identical Sentence[]", () => {
    const original = parseConllu(SAMPLE);
    const reparsed = parseConllu(exportConllu(original));
    expect(reparsed.sentences).toEqual(original.sentences);
  });

  it("writes the root's HEAD field as 0, not a self-loop", () => {
    const tree = parseConllu(SAMPLE);
    const text = exportConllu(tree);
    const rootLine = text.split("\n").find((l) => l.startsWith("1\t學"));
    expect(rootLine?.split("\t")[6]).toBe("0");
  });

  it("lowercases the root DEPREL back to 'root'", () => {
    const tree = parseConllu(SAMPLE);
    const text = exportConllu(tree);
    const rootLine = text.split("\n").find((l) => l.startsWith("1\t學"));
    expect(rootLine?.split("\t")[7]).toBe("root");
  });

  it("serializes morph features back into the FEATS column", () => {
    const tree = parseConllu(SAMPLE);
    const text = exportConllu(tree);
    const tokiLine = text.split("\n").find((l) => l.startsWith("3\t時"));
    expect(tokiLine?.split("\t")[5]).toBe("Case=Tem");
  });

  it("separates sentences with a blank line", () => {
    const tree: TokenTree = {
      source: "conllu",
      sentences: [
        { tokens: [{ id: 0, text: "曰", lemma: "曰", pos: "VERB", xpos: "v", dep: "ROOT", head: 0 }] },
        { tokens: [{ id: 0, text: "云", lemma: "云", pos: "VERB", xpos: "v", dep: "ROOT", head: 0 }] },
      ],
    };
    const text = exportConllu(tree);
    expect(text).toContain("\n\n");
    expect(text.split("\n\n")).toHaveLength(2);
  });
});
