import { beforeEach, describe, expect, it } from "vitest";
import { redo, setHistoryTree, undo, withUndo } from "../src/render/editHistory.ts";
import type { Token, TokenTree } from "../src/parse/types.ts";

function token(id: number, text: string, head: number, dep: string, pos = "VERB"): Token {
  return { id, text, lemma: text, pos, xpos: "", dep, head };
}

/** 人不知 — a subject, a negation, and the verb they hang off. */
function makeTree(): TokenTree {
  return {
    source: "conllu",
    sentences: [
      {
        tokens: [token(0, "人", 2, "subj", "NOUN"), token(1, "不", 2, "mod", "ADV"), token(2, "知", 2, "ROOT")],
      },
    ],
  };
}

const shape = (tree: TokenTree) => tree.sentences[0].tokens.map((t) => `${t.text}:${t.pos}:${t.dep}:${t.head}`);

describe("editHistory", () => {
  let tree: TokenTree;
  beforeEach(() => {
    tree = makeTree();
    setHistoryTree(null); // drop anything a previous test left behind
    setHistoryTree(tree);
  });

  it("reverts a single-field edit", () => {
    const before = shape(tree);
    withUndo(() => void (tree.sentences[0].tokens[0].dep = "comp:obj"));
    expect(shape(tree)).not.toEqual(before);
    expect(undo()).toBe(true);
    expect(shape(tree)).toEqual(before);
  });

  it("treats a multi-token edit as one step", () => {
    const before = shape(tree);
    // What `promoteToRoot` does: re-root, and bring the old root's
    // dependents across in the same edit.
    withUndo(() => {
      const [ren, bu, chi] = tree.sentences[0].tokens;
      ren.head = 1;
      chi.head = 1;
      chi.dep = "mod";
      bu.head = 1;
      bu.dep = "ROOT";
    });
    expect(undo()).toBe(true);
    expect(shape(tree)).toEqual(before);
    expect(undo()).toBe(false); // one step, not four
  });

  it("restores in place, so references held elsewhere stay valid", () => {
    const held = tree.sentences[0].tokens[0];
    withUndo(() => void (held.head = 1));
    undo();
    // The very same object, carrying the reverted value — not a replacement.
    expect(tree.sentences[0].tokens[0]).toBe(held);
    expect(held.head).toBe(2);
  });

  it("redoes what it undid, and stops at each end", () => {
    withUndo(() => void (tree.sentences[0].tokens[0].dep = "comp:obj"));
    const edited = shape(tree);
    undo();
    expect(redo()).toBe(true);
    expect(shape(tree)).toEqual(edited);
    expect(redo()).toBe(false);
  });

  it("walks back through several edits in order", () => {
    const states = [shape(tree)];
    for (const dep of ["comp:obj", "comp:obl", "mod"]) {
      withUndo(() => void (tree.sentences[0].tokens[0].dep = dep));
      states.push(shape(tree));
    }
    for (let i = states.length - 1; i > 0; i--) {
      expect(shape(tree)).toEqual(states[i]);
      expect(undo()).toBe(true);
    }
    expect(shape(tree)).toEqual(states[0]);
    expect(undo()).toBe(false);
  });

  it("ignores an edit that changed nothing", () => {
    withUndo(() => void (tree.sentences[0].tokens[0].dep = "subj")); // already subj
    expect(undo()).toBe(false);
  });

  it("drops the redo branch once a new edit is made", () => {
    withUndo(() => void (tree.sentences[0].tokens[0].dep = "comp:obj"));
    undo();
    withUndo(() => void (tree.sentences[0].tokens[1].dep = "det"));
    expect(redo()).toBe(false);
  });

  it("clears history when a different tree is loaded", () => {
    withUndo(() => void (tree.sentences[0].tokens[0].dep = "comp:obj"));
    setHistoryTree(makeTree());
    expect(undo()).toBe(false);
  });

  it("keeps history when the same tree is re-rendered", () => {
    withUndo(() => void (tree.sentences[0].tokens[0].dep = "comp:obj"));
    setHistoryTree(tree); // what every post-edit re-render does
    expect(undo()).toBe(true);
  });
});
