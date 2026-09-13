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
const tagShape = (tree: TokenTree) => tree.sentences[0].tokens.map((t) => `${t.text}:${t.pos}:${t.xpos}`);

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
    // What `promoteToRoot` does: the old root becomes a dependent of the new
    // one (with a placeholder relation of its own), and the new one takes
    // the self-link — two tokens change in the one edit. The old root's own
    // dependent (人, left out of this callback entirely) is untouched, which
    // is exactly why the two changes that do happen must undo together.
    withUndo(() => {
      const [, bu, chi] = tree.sentences[0].tokens;
      chi.head = 1;
      chi.dep = "mod";
      bu.head = 1;
      bu.dep = "ROOT";
    });
    expect(undo()).toBe(true);
    expect(shape(tree)).toEqual(before);
    expect(undo()).toBe(false); // one step, not two
  });

  it("folds a mutation made outside withUndo into whichever step comes next", () => {
    // What `relabelArcsUnder` already relies on for its own after-the-fact
    // label, and what `relabelOldRootArc` relies on for `promoteToRoot`'s:
    // each lands its parser-scored answer as a direct field write — no
    // `withUndo` of its own — once the round trip to the worker resolves,
    // specifically so that a structural edit and the label that completes it
    // undo as one press rather than two.
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
    // A second untracked write landing the same way, on a different token —
    // proof this isn't limited to one field on one token: `relabelArcsUnder`'s
    // own loop writes however many ids it was given, all outside `withUndo`,
    // and this must all still undo together with the first.
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

  it("records an xpos edit even where the UPOS it implies is unchanged", () => {
    // What the three POS category menus in tokenInspector.ts actually do:
    // `retag` always writes `xpos` and writes `pos` only when `uposForXpos`
    // says the tag now implies a different one — moving between two domains
    // under the same 品詞 (行為 -> 描写, say) leaves `pos` untouched. A history
    // that compared only `pos` would see no change at all here and never
    // push the step, so this edit would be silently unrecorded — not
    // undoable to a wrong state, but not undoable at all.
    const before = tagShape(tree);
    withUndo(() => void (tree.sentences[0].tokens[2].xpos = "v,動詞,描写,形質"));
    expect(tagShape(tree)).not.toEqual(before);
    expect(undo()).toBe(true);
    expect(tagShape(tree)).toEqual(before);
  });

  it("restores pos and xpos together, so the two tag fields never disagree", () => {
    // The other half of the same gap: an edit that *does* change `pos`
    // (crossing a 品詞 boundary) must not restore `pos` while leaving `xpos`
    // at its new value — a token whose UPOS and treebank tag then describe
    // two different words.
    const token = tree.sentences[0].tokens[2];
    token.xpos = "v,動詞,行為,動作";
    const before = tagShape(tree);
    withUndo(() => {
      token.xpos = "n,名詞,人,役割";
      token.pos = "NOUN";
    });
    expect(undo()).toBe(true);
    expect(tagShape(tree)).toEqual(before);
    expect(token.pos).toBe("VERB");
    expect(token.xpos).toBe("v,動詞,行為,動作");
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
