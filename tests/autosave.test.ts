import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSavedTexts, saveText, storedSignature } from "../src/parse/savedTexts.ts";
import type { Token, TokenTree } from "../src/parse/types.ts";

// ---------------------------------------------------------------------------
// **Auto-save: what a tick decides, and what a run of them leaves behind.**
//
// The panel writes the open document back once a minute (see `SavedPanel.ts`).
// The wiring — the timer, the status line, the `pagehide` teardown — needs a
// document to test and there is none here, so what is pinned instead are the
// two claims the feature actually rests on, both of which live below the DOM:
//
//  1. **A tick can tell an edited document from an untouched one**, and can do
//     it when the edit *mutated the tree in place*. This is the whole reason
//     the comparison is a serialisation rather than a flag: nothing sets a
//     flag when a head or a reading changes, and object identity deliberately
//     survives editing so that `openEntry` keeps matching. If `storedSignature`
//     ever stops seeing through to the tokens, auto-save silently stops saving
//     edits — the worst failure this feature could have, and a silent one.
//
//  2. **A run of ticks leaves one entry per document, not one per minute.**
//     The first tick of a document adds it; every later tick updates it in
//     place. This is what keeps a feature that runs sixty times an hour from
//     filling a fifty-entry list in under an hour and evicting texts the
//     reader chose to keep.
//
// The stand-in storage is the one from `savedTexts.test.ts`, for the same
// reason: these tests run in node, and the module only ever uses
// getItem/setItem.

function installStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

function token(over: Partial<Token> = {}): Token {
  return { id: 0, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,*", dep: "ROOT", head: 0, ...over };
}

function makeTree(): TokenTree {
  return { source: "conllu", sentences: [{ tokens: [token(), token({ id: 1, text: "之", dep: "comp:obj", head: 0 })] }] };
}

/** One auto-save tick, written exactly as `SavedPanel`'s own `autosave` is:
 * compare, and write only on a difference, updating in place when the tree on
 * screen is still the one the entry was stored as. */
function tick(state: { signature: string | null; openId?: string }, source: string, tree: TokenTree): boolean {
  const signature = storedSignature(source, tree);
  if (signature === state.signature) return false;
  const id = saveText(source, tree, state.openId);
  if (id === null) return false;
  state.openId = id;
  state.signature = signature;
  return true;
}

describe("what an auto-save tick can see", () => {
  beforeEach(installStorage);

  it("sees an edit that mutated the tree in place", () => {
    const tree = makeTree();
    const before = storedSignature("知之", tree);
    // Exactly what an annotation edit does: the same object, a changed field.
    tree.sentences[0].tokens[1].dep = "comp:obl";
    expect(storedSignature("知之", tree)).not.toBe(before);
  });

  it("sees a reading pinned onto a token, and a changed head", () => {
    const tree = makeTree();
    const before = storedSignature("知之", tree);
    tree.sentences[0].tokens[0].head = 1;
    const moved = storedSignature("知之", tree);
    expect(moved).not.toBe(before);
    tree.sentences[0].tokens[1].lemma = "これ";
    expect(storedSignature("知之", tree)).not.toBe(moved);
  });

  it("sees a change to the source text alone", () => {
    const tree = makeTree();
    expect(storedSignature("知之", tree)).not.toBe(storedSignature("知之。", tree));
  });

  it("reports no change when nothing has been touched", () => {
    const tree = makeTree();
    expect(storedSignature("知之", tree)).toBe(storedSignature("知之", tree));
  });

  it("is not fooled by two documents that merely look alike", () => {
    // Distinct objects with identical content *should* compare equal: what is
    // being asked is whether a save would write different bytes, not whether
    // this is the same object.
    expect(storedSignature("知之", makeTree())).toBe(storedSignature("知之", makeTree()));
  });
});

describe("what a run of ticks leaves in storage", () => {
  beforeEach(installStorage);

  it("writes on the first tick of a document and skips while it is untouched", () => {
    const tree = makeTree();
    const state = { signature: null as string | null };
    expect(tick(state, "知之", tree)).toBe(true);
    expect(tick(state, "知之", tree)).toBe(false);
    expect(tick(state, "知之", tree)).toBe(false);
    expect(listSavedTexts()).toHaveLength(1);
  });

  it("keeps one entry across an hour of ticks and edits, updating it in place", () => {
    const tree = makeTree();
    const state = { signature: null as string | null };
    let written = 0;
    for (let minute = 0; minute < 60; minute++) {
      // An edit every tenth minute; the rest of the ticks have nothing to do.
      if (minute % 10 === 0) tree.sentences[0].tokens[1].dep = `mod@${minute}`;
      if (tick(state, "知之", tree)) written++;
    }
    expect(written).toBe(6);
    expect(listSavedTexts()).toHaveLength(1);
    // And the entry holds the *last* edit, not the first.
    expect(listSavedTexts()[0].tree.sentences[0].tokens[1].dep).toBe("mod@50");
  });

  it("gives a second document its own entry rather than overwriting the first", () => {
    const first = makeTree();
    const state = { signature: null as string | null };
    tick(state, "知之", first);
    // What `setTree` does when a new document is opened: the comparison and
    // the entry it was updating are both cleared.
    const fresh = { signature: null as string | null };
    const second = makeTree();
    second.sentences[0].tokens[0].text = "見";
    tick(fresh, "見之", second);
    expect(listSavedTexts()).toHaveLength(2);
  });

  it("does not mark the document stored when the write was refused", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    });
    const tree = makeTree();
    const state = { signature: null as string | null };
    expect(tick(state, "知之", tree)).toBe(false);
    // Still null, so the next tick tries again rather than treating the
    // unwritten state as stored.
    expect(state.signature).toBeNull();
  });
});
