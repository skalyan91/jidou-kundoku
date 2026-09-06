import { describe, expect, it } from "vitest";
import { planBracketGlue, planHangingMarks, proseFlow, type BracketGlue, type FlowNode } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// 行末禁則 in the 書き下し文 panel: **the opening bracket that must not be left
// at a column's foot.**
//
// `planHangingMarks` has always known the rule — `MAY_NOT_END_COLUMN` is the
// set, and the model pulls a boundary back rather than end a column on 「. But
// the model does not break the lines; it predicts the browser's breaks so that
// the marks it hangs are the ones the browser leaves at a foot. Every other
// 禁則 in this panel is a rule the line breaker is already keeping over a run
// of text (`line-break: normal`, typography.css), which is a thing a model may
// reasonably anticipate.
//
// 行末禁則 is not, because a glossed character in this panel is a `<ruby>` at
// `display: inline-block` — an atomic inline, a box and not a character — so
// 「 followed by a gloss is text, then a box, and the break opportunity is at
// the seam. `planBracketGlue` finds those pairs and the DOM half puts each in
// a `.no-break-unit`, which is where the rule stops being a prediction. See
// the long note above `planBracketGlue` in KakikudashiView.ts.
//
// What is checked here is the plan, and its agreement with the model: the two
// walk the same tree and must divide it the same way. What is not checked here
// — there being no browser in this environment — is that `white-space: nowrap`
// on the wrapper actually forbids the engine the break, and that the DOM half
// moves the nodes the plan names. Those need eyes on a page.
// ---------------------------------------------------------------------------

const text = (data: string): FlowNode => ({ nodeType: 3, nodeName: "#text", data, childNodes: [] });
const el = (nodeName: string, ...childNodes: FlowNode[]): FlowNode => ({ nodeType: 1, nodeName, childNodes });
const br = (): FlowNode => el("BR");
/** One character and its kana, as `renderKakikudashiView` writes a gloss:
 * `<ruby>` per character, mono-ruby by construction. */
const ruby = (character: string, kana: string): FlowNode => el("RUBY", text(character), el("RT", text(kana)));
/** One piece, as the renderer writes it: a `.kaki-token` span of its own. */
const token = (...childNodes: FlowNode[]): FlowNode => el("SPAN", ...childNodes);
/** One sentence's wrapper. The pass runs per `.sentence-gap`, so this is the
 * unit the plan is asked about. */
const gap = (...childNodes: FlowNode[]): FlowNode => el("SPAN", ...childNodes);

/** Which character of the flow a unit names, so that a plan of *nodes* can be
 * checked against the sequence the model reads.
 *
 * A `<ruby>` is the character, and the flow's cell for it is the text node
 * inside the box — which is the whole difference between the two walks, and
 * the reason this has to be resolved rather than compared directly. */
function flowIndexOf(root: FlowNode, unit: { node: FlowNode; offset: number; atomic: boolean }): number {
  const flow = proseFlow(root);
  const inside = (node: FlowNode): FlowNode[] =>
    node.nodeType === 3 ? [node] : [...Array.from({ length: node.childNodes.length }, (_, i) => node.childNodes[i])].flatMap(inside);
  const wanted = unit.atomic ? inside(unit.node) : [unit.node];
  return flow.cells.findIndex(
    (cell) => cell !== null && wanted.includes(cell.node) && (unit.atomic || cell.offset === unit.offset),
  );
}

/** The plan as a pair of characters, which is what it is claiming. */
const glued = (root: FlowNode, glues: BracketGlue[]): string[] => {
  const characters = [...proseFlow(root).text];
  return glues.map((glue) => characters[flowIndexOf(root, glue.bracket)] + characters[flowIndexOf(root, glue.held)]);
};

describe("which pairs are glued", () => {
  it("glues an opening bracket to the glossed character after it", () => {
    // The case the pass exists for: 「 is plain text in its own `.kaki-token`,
    // 學 is a box. The plan names the `<ruby>` itself and not the text inside
    // it — the `<rt>` is a sibling of the base, so a glue holding only the base
    // would leave the kana on the far side of the break.
    const learn = ruby("學", "がく");
    const root = gap(token(text("「")), token(learn, ruby("び", "")));
    const glues = planBracketGlue(root);
    expect(glues).toHaveLength(1);
    expect(glues[0].held.node).toBe(learn);
    expect(glues[0].held.atomic).toBe(true);
    expect(glued(root, glues)).toEqual(["「學"]);
  });

  it("glues it to a plain character in another token as well", () => {
    // Belt beside braces: no box is involved here and the engine's own line
    // breaker is very likely keeping LB14 across the two spans already. The
    // rule is absolute and there is no browser here to ask, so the pass does
    // not depend on the answer.
    const root = gap(token(text("「")), token(text("こころざし")));
    const glues = planBracketGlue(root);
    expect(glued(root, glues)).toEqual(["「こ"]);
    expect(glues[0].held.atomic).toBe(false);
    expect(glues[0].held.offset).toBe(0);
  });

  it("glues a bracket and its character written in one node", () => {
    // Nothing in this panel writes a bracket inside a longer piece today —
    // every bracket is a `punct` piece of its own (generator.ts) — and the plan
    // answers for it anyway, by offset, because a walk that only worked on the
    // arrangement it happens to meet is a walk that fails silently on the one
    // it does not.
    const root = gap(token(text("『こころざし")));
    const glues = planBracketGlue(root);
    expect(glued(root, glues)).toEqual(["『こ"]);
    expect(glues[0].bracket.offset).toBe(0);
    expect(glues[0].held.offset).toBe(1);
  });

  it("glues twice where two brackets open together", () => {
    // 「『 — vanishingly rare, and the pair still comes out unbreakable: the
    // second glue takes the first entire (see `movableFor`), which is the
    // transitive nesting `glueOpeningPunctForward` describes in the panel
    // above.
    const root = gap(token(text("「")), token(text("『")), token(ruby("甲", "かう")));
    expect(glued(root, planBracketGlue(root))).toEqual(["「『", "『甲"]);
  });

  it("leaves every other character alone", () => {
    const root = gap(token(text("學びて時に習ふ、")), token(ruby("亦", "また")));
    expect(planBracketGlue(root)).toEqual([]);
  });

  it("glues no closing bracket", () => {
    // A closing bracket may not *begin* a column, which is 行頭禁則 and the
    // model's own business (`MAY_NOT_BEGIN_COLUMN`); it is set by 詰め where it
    // will not fit, and it is not held to what follows it.
    const root = gap(token(text("」")), token(ruby("と", "")));
    expect(planBracketGlue(root)).toEqual([]);
  });
});

describe("what the glue may not reach across", () => {
  it("does not glue across the source's own column break", () => {
    // A `<br>` is a forced break, which `white-space: nowrap` does not suppress
    // and should not: where the source itself broke the line after an opening
    // bracket that is the source's line structure. The model reads the same
    // `\n` the same way — `planHangingMarks` closes the column at it whatever
    // stands either side.
    const root = gap(token(text("「")), br(), token(text("　學")));
    expect(planBracketGlue(root)).toEqual([]);
  });

  it("does not glue a bracket that ends the sentence it is in", () => {
    // The plan is asked per `.sentence-gap`, so there is nothing after the
    // bracket to hold. Deliberate: crossing the boundary would move a character
    // into a span whose token ids are numbered for another sentence. The parser
    // strands the *closing* bracket of a quotation, never the opening one, so
    // this panel does not meet the case.
    const root = gap(token(text("子曰く、")), token(text("「")));
    expect(planBracketGlue(root)).toEqual([]);
  });

  it("counts an <rt>'s kana as no character of the flow", () => {
    // A gloss's kana are `position: absolute` and are laid out in no column, so
    // they are not what follows a bracket even when they are the next text in
    // the tree. Counted, the glue would hold 「 to the first kana of a reading
    // and leave the character it is the reading of on the other side.
    const root = gap(token(text("「")), token(ruby("學", "がく")));
    const glues = planBracketGlue(root);
    expect(glues).toHaveLength(1);
    expect(glues[0].held.node.nodeName).toBe("RUBY");
    expect(glued(root, glues)).toEqual(["「學"]);
  });
});

describe("the plan and the flow are the same sequence", () => {
  // The two walks read one tree, and a disagreement between them is the whole
  // failure this pass is for: the model counts characters and the glue moves
  // nodes, and if they divide the panel differently the glue would hold a pair
  // the model does not know it has.
  const panels: FlowNode[] = [
    gap(
      token(text("子")),
      token(text("曰")),
      token(text("はく、")),
      token(text("「")),
      token(ruby("學", "がく")),
      token(text("びて")),
      token(text("時に")),
      token(ruby("習", "なら")),
      token(text("ふ、")),
    ),
    gap(token(text("「")), token(ruby("甲", "かう")), br(), token(text("　「")), token(text("乙"))),
    gap(token(el("SPAN", text("習"), el("SPAN", text("ひて")))), token(text("『")), token(text("丙"))),
  ];

  it("names two characters that stand next to each other in the flow", () => {
    for (const root of panels) {
      const characters = [...proseFlow(root).text];
      for (const glue of planBracketGlue(root)) {
        const bracket = flowIndexOf(root, glue.bracket);
        const held = flowIndexOf(root, glue.held);
        expect(bracket).toBeGreaterThanOrEqual(0);
        expect(held).toBe(bracket + 1);
        expect(["「", "『", "（", "〔", "［", "｛", "〈", "《", "【"]).toContain(characters[bracket]);
      }
    }
  });

  it("finds every opening bracket the flow holds that has a character after it", () => {
    // The other direction, which is what makes the count a claim: the plan is
    // not merely correct where it fires, it fires everywhere it should. A
    // bracket at the end of the flow, or one a `<br>` follows, is the exception
    // and is counted out here rather than passed over.
    for (const root of panels) {
      const characters = [...proseFlow(root).text];
      const owed = characters.filter(
        (character, at) =>
          (character === "「" || character === "『") &&
          characters[at + 1] !== undefined &&
          characters[at + 1] !== "\n",
      ).length;
      expect(planBracketGlue(root)).toHaveLength(owed);
    }
  });
});

describe("the model and the glue agree", () => {
  // **The point of the exercise.** The glue makes a break between the two
  // characters impossible for the engine; the model has to be predicting the
  // same thing, or the hang it plans is planned against columns the page does
  // not have. `planHangingMarks` was already right — this is the assertion
  // that it is, stated in the glue's own terms.
  const panels: FlowNode[] = [
    gap(token(text("子曰はく、")), token(text("「")), token(ruby("學", "がく")), token(text("びて時に習ふ、"))),
    gap(token(text("いはく、")), token(text("「")), token(text("こころざしを")), token(text("うしなふ。"))),
    gap(token(text("あるひといはく、「")), token(ruby("酒", "さけ")), token(text("は身を害す。"))),
  ];

  it("never starts a column on the character a glue is holding", () => {
    for (const root of panels) {
      const flow = proseFlow(root);
      const held = new Set(planBracketGlue(root).map((glue) => flowIndexOf(root, glue.held)));
      for (let slots = 2; slots <= 12; slots++) {
        for (const from of planHangingMarks(flow.text, slots).columns) {
          expect(held.has(from)).toBe(false);
        }
      }
    }
  });

  it("moves the bracket down with what it holds, and no further", () => {
    // 追い出し, in the only form the glue leaves: a two-character unit that will
    // not fit at a foot goes down whole, so the column it leaves is one
    // character short and not two. Six characters, then 「學 at the boundary.
    const root = panels[0];
    const flow = proseFlow(root);
    const plan = planHangingMarks(flow.text, 6);
    const characters = [...flow.text];
    const columns = plan.columns.map((from, i) =>
      characters.slice(from, i + 1 < plan.columns.length ? plan.columns[i + 1] : characters.length).join(""),
    );
    expect(columns[0]).toBe("子曰はく、");
    expect(columns[1].startsWith("「學")).toBe(true);
  });
});
