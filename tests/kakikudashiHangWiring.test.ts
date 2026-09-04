import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import {
  generateKakikudashiForTree,
  generateKakikudashiPiecesForTree,
  sentenceSeparator,
  type Piece,
} from "../src/kakikudashi/generator.ts";
import { planHangingMarks, proseFlow, type FlowNode } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// ぶら下げ, the half of it that is not `planHangingMarks`: **the mapping from
// one of the model's indices to a character on the page.**
//
// The model is exhaustively tested (tests/kakikudashiHang.test.ts, 488,280
// passages) and the class it decides is written by `applyHangingMarks`, which
// resolves an index through `proseFlow`. That resolution was tested nowhere,
// which is the shape of the gap: a pure function verified to death, and the
// wiring that feeds it verified not at all. A model index that lands on the
// wrong character puts the negative margin on a mark that is not at a column's
// foot — and leaves the mark that *is* at one to 追い出し, which is the reader
// seeing the punctuation pushed to the next column exactly as before.
//
// What `proseFlow` has to get right is one correspondence, and it is a fact
// about a tree rather than about a layout, so it is checkable here:
//
//   **one flow character for every character the browser lays out, in order.**
//
//  - an `<rt>`'s kana are `position: absolute` (`.text-kakikudashi rt`,
//    typography.css) and are laid out in no column, so they must count for
//    nothing — and a gloss is three kana over one character, so counting them
//    would move every boundary after the first gloss by two;
//  - a `<ruby>` is one character of prose and must count as one;
//  - a `<br>` is the source's own column break and must count as exactly one
//    newline, which is what the model reads as a forced break;
//  - the nesting is arbitrary — `.sentence-gap` over `.kaki-token` over
//    `.renyou-te` — and none of it may add or drop a character.
//
// The nodes below are plain objects, `proseFlow` being written against
// `FlowNode` for that reason (there is no DOM in this environment). They are
// the shapes `renderKakikudashiView` writes, assembled here by `panelFor` from
// the real generator's real pieces; that builder mirrors the renderer rather
// than being it, which is the one join this file cannot weld shut without a
// browser.
// ---------------------------------------------------------------------------

const text = (data: string): FlowNode => ({ nodeType: 3, nodeName: "#text", data, childNodes: [] });
const el = (nodeName: string, ...childNodes: FlowNode[]): FlowNode => ({
  nodeType: 1,
  nodeName,
  childNodes,
});
const br = (): FlowNode => el("BR");
/** One character and its kana, as `renderKakikudashiView` writes a gloss:
 * `<ruby>` per character, mono-ruby by construction. */
const ruby = (character: string, kana: string): FlowNode =>
  el("RUBY", text(character), el("RT", text(kana)));

describe("what counts as a character of the flow", () => {
  it("counts a glossed character once and its kana not at all", () => {
    const column = el("DIV", el("SPAN", ruby("黃", "くわう"), ruby("帝", "てい")), text("の"));
    const flow = proseFlow(column);
    expect(flow.text).toBe("黃帝の");
    // Three kana over 黃 and two over 帝: five characters that must be in no
    // column. Counted, every boundary after this gloss would be five out.
    expect(flow.cells.map((cell) => cell && cell.node.data)).toEqual(["黃", "帝", "の"]);
  });

  it("is the same flow with the glosses as without them", () => {
    const glossed = el("DIV", el("SPAN", ruby("學", "がく")), text("びて"));
    const plain = el("DIV", el("SPAN", text("學")), text("びて"));
    expect(proseFlow(glossed).text).toBe(proseFlow(plain).text);
  });

  it("counts a <br> as exactly one newline and gives it no cell", () => {
    const column = el("DIV", el("SPAN", text("一"), br(), text("　二")));
    const flow = proseFlow(column);
    expect(flow.text).toBe("一\n　二");
    expect(flow.cells[1]).toBeNull();
    expect(flow.cells.filter((cell) => cell === null)).toHaveLength(1);
  });

  it("is indifferent to how deeply a character is wrapped", () => {
    // `.sentence-gap` > `.kaki-token` > `.renyou-te` is the deepest the panel
    // nests plain prose, and the connective is a span of its own so the reflow
    // has something to fade — it must not be a character more or less.
    const nested = el(
      "DIV",
      el("SPAN", el("SPAN", text("習"), el("SPAN", text("ひて")))),
      el("SPAN", text("、")),
    );
    expect(proseFlow(nested).text).toBe("習ひて、");
    expect(proseFlow(el("DIV", text("習ひて、"))).text).toBe("習ひて、");
  });

  it("gives every cell the offset and length that slice its own character out", () => {
    const column = el("DIV", el("SPAN", text("學びて")), text("時に"));
    const flow = proseFlow(column);
    const characters = [...flow.text];
    flow.cells.forEach((cell, at) => {
      if (cell === null) return;
      // This is what `applyHangingMarks` splits the node on. Wrong by one and
      // the class is written round the character beside the mark.
      expect((cell.node.data ?? "").substr(cell.offset, cell.length)).toBe(characters[at]);
    });
  });
});

// ---------------------------------------------------------------------------
// And the same correspondence over the real pipeline: the flow a rendered
// panel comes to must be the prose the generator emits, character for
// character. `generateKakikudashiForTree` is what every other test in this
// repository reads the prose off, so an agreement here is an agreement with
// the text the reader is looking at.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);
const planFor = (sentence: Sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence));

const ROWS = `# text = 子曰：「學而時習之，不亦說乎？
1\t子\t子\tNOUN\tn,名詞,人,人\t_\t2\tsubj\t_\t_
2\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t：\t：\tPUNCT\ts,記号,読点,*\t_\t2\tpunct\t_\t_
4\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t5\tpunct\t_\t_
5\t學\t學\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
6\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t8\tcc\t_\t_
7\t時\t時\tNOUN\tn,名詞,時,*\t_\t8\tmod@tmod\t_\t_
8\t習\t習\tVERB\tv,動詞,行為,動作\t_\t5\tconj:coord\t_\t_
9\t之\t之\tPRON\tn,代名詞,人称,止格\t_\t8\tcomp:obj\t_\t_
10\t，\t，\tPUNCT\ts,記号,読点,*\t_\t5\tpunct\t_\t_

# text = 有朋自遠方來，不亦樂乎？
1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
2\t朋\t朋\tNOUN\tn,名詞,人,関係\t_\t1\tcomp:obj\t_\t_
3\t自\t自\tADP\tp,前置詞,基本,*\t_\t4\tcase\t_\t_
4\t遠\t遠\tADJ\tv,動詞,描写,形質\t_\t6\tmod\t_\t_
5\t方\t方\tNOUN\tn,名詞,可搬,道具\t_\t4\tobj\t_\t_
6\t來\t來\tVERB\tv,動詞,変化,移動\t_\t1\tconj:coord\t_\t_
7\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_

# text = 人不知而不慍，不亦君子乎？
1\t人\t人\tNOUN\tn,名詞,人,人\t_\t3\tsubj\t_\t_
2\t不\t不\tADV\tv,副詞,否定,無界\t_\t3\tadvmod\t_\t_
3\t知\t知\tVERB\tv,動詞,心理,判断\t_\t0\troot\t_\t_
4\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t6\tcc\t_\t_
5\t不\t不\tADV\tv,副詞,否定,無界\t_\t6\tadvmod\t_\t_
6\t慍\t慍\tVERB\tv,動詞,心理,感情\t_\t3\tconj:coord\t_\t_
7\t，\t，\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
`;

/** The panel `renderKakikudashiView` builds for this tree, as far as the flow
 * is concerned: one `.sentence-gap` per sentence, one `.kaki-token` per piece,
 * a `<br>` and its indent cells for a `layout` piece, and the separator
 * written straight onto the wrapper. A gloss is added on the first character
 * of the first sentence whether or not the dictionaries would earn one there,
 * so that the `<rt>` path is exercised on the real text rather than only on a
 * fixture. */
function panelFor(rows: string, glossFirst: boolean): { column: FlowNode; prose: string } {
  const tree = parseConllu(rows);
  const bySentence: Piece[][] = generateKakikudashiPiecesForTree(tree, planFor, resolve);
  const sentences = tree.sentences.map((_sentence, i) => {
    const children: FlowNode[] = [];
    bySentence[i].forEach((piece, at) => {
      if (piece.kind === "layout") {
        children.push(br());
        const indent = piece.text.slice(1);
        if (indent) children.push(text(indent));
        return;
      }
      const written = piece.text + (piece.caseParticle ?? "");
      if (glossFirst && i === 0 && at === 0 && written.length > 0) {
        // The gloss branch: one <ruby> per character of the base, the rest of
        // the piece in a tail span of the same token's.
        const base = [...written][0];
        children.push(el("SPAN", ruby(base, "しいい")));
        const tail = written.slice(base.length);
        if (tail) children.push(el("SPAN", text(tail)));
        return;
      }
      children.push(el("SPAN", text(written)));
    });
    children.push(text(sentenceSeparator(tree.sentences, i)));
    return el("SPAN", ...children);
  });
  return {
    column: el("DIV", ...sentences),
    prose: generateKakikudashiForTree(tree, planFor, resolve),
  };
}

describe("the flow a rendered panel comes to", () => {
  it("is the prose the generator emits, character for character", () => {
    const { column, prose } = panelFor(ROWS, false);
    expect(proseFlow(column).text).toBe(prose);
  });

  it("is that same prose when a word is glossed", () => {
    // The three kana of the <rt> are the whole of the risk here: counted, the
    // flow would be three characters long where the column is one, and every
    // hang after the gloss would land on the wrong character.
    const { column, prose } = panelFor(ROWS, true);
    expect(proseFlow(column).text).toBe(prose);
  });

  it("resolves every index the model hands back to the mark it chose", () => {
    // The end-to-end claim, and the one the page depends on: what
    // `applyHangingMarks` writes the class onto is a 句点 or a 読点, at a
    // column's foot, and not the character beside it.
    for (const glossed of [false, true]) {
      const { column } = panelFor(ROWS, glossed);
      const flow = proseFlow(column);
      const characters = [...flow.text];
      for (const slots of [3, 4, 5, 6, 7, 8, 10]) {
        const plan = planHangingMarks(flow.text, slots);
        const feet = new Set(plan.columns.map((from) => from - 1));
        for (const at of plan.hangs) {
          const cell = flow.cells[at];
          expect(cell).not.toBeNull();
          // The character the class is written round is the mark itself.
          expect((cell!.node.data ?? "").substr(cell!.offset, cell!.length)).toBe(characters[at]);
          expect(["、", "。"]).toContain(characters[at]);
          // And it stands at a column's foot — the last index before the next
          // column begins, or the end of the passage.
          expect(feet.has(at) || at === characters.length - 1).toBe(true);
        }
      }
    }
  });
});
