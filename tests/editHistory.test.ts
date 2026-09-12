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

  it("folds a mutation made outside withUndo into whichever step comes next", () => {
    // What `relabelArcsUnder` already relies on for its own after-the-fact
    // label, and what the new dependent-cascade feature relies on for a
    // structural move decided the same way (`cascadeDependents` in
    // tokenInspector.ts, which lands its decision as a direct field write —
    // no `withUndo` of its own — once the parser's arc scores are in hand,
    // specifically so that a head change and every dependent it settles undo
    // as one press rather than a cascade of separate ones).
    //
    // `undo` only ever compares the live tree against the *last pushed*
    // snapshot, and nothing here pushes a second one: a write that happens
    // between one `withUndo` call and the next is not tracked on its own, so
    // the first `undo` after it reverts both the tracked edit and the
    // untracked write together, and there is nothing left for a second `undo`
    // to do.
    const before = shape(tree);
    // The structural edit itself — 人 moves from 知 to 不 — tracked.
    withUndo(() => void (tree.sentences[0].tokens[0].head = 1));
    // The parser's after-the-fact answer for that arc's own relation, landing
    // a moment later the way `relabelArcsUnder` always has — not tracked.
    tree.sentences[0].tokens[0].dep = "comp:obj";
    // And a second token the dependent cascade decided to carry along to the
    // same new head, with the relation the parser gave *that* arc — also not
    // tracked, and this is the property under test: a second structural move,
    // landed the same untracked way, must undo with the first rather than
    // needing a press of its own.
    tree.sentences[0].tokens[1].head = 1;
    tree.sentences[0].tokens[1].dep = "mod";
    const afterBoth = shape(tree);
    expect(afterBoth).not.toEqual(before);

    expect(undo()).toBe(true);
    expect(shape(tree)).toEqual(before); // both writes gone, in the one press
    expect(undo()).toBe(false); // nothing left to undo a second time

    expect(redo()).toBe(true);
    expect(shape(tree)).toEqual(afterBoth); // and redo brings both straight back
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
