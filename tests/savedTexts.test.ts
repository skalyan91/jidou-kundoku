import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteSavedText, getSavedText, listSavedTexts, saveText } from "../src/parse/savedTexts.ts";
import type { TokenTree } from "../src/parse/types.ts";

/** These tests run under vitest's default node environment, which has no
 * `localStorage` — a minimal in-memory stand-in is enough, since the module
 * only ever uses getItem/setItem. */
function installStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
}

function makeTree(dep: string): TokenTree {
  return {
    source: "conllu",
    sentences: [{ tokens: [{ id: 0, text: "知", lemma: "知", pos: "VERB", xpos: "", dep, head: 0 }] }],
  };
}

describe("savedTexts", () => {
  beforeEach(installStorage);

  it("adds a new entry when given no id", () => {
    saveText("學而時習之", makeTree("ROOT"));
    saveText("有朋自遠方來", makeTree("ROOT"));
    expect(listSavedTexts()).toHaveLength(2);
  });

  it("updates in place when given an existing id", () => {
    const id = saveText("學而時習之", makeTree("ROOT"))!;
    const updated = saveText("學而時習之", makeTree("comp:obj"), id);

    expect(updated).toBe(id);
    expect(listSavedTexts()).toHaveLength(1);
    expect(getSavedText(id)!.tree.sentences[0].tokens[0].dep).toBe("comp:obj");
  });

  it("keeps the entry's own id and picks up a retitled source", () => {
    const id = saveText("學而時習之", makeTree("ROOT"))!;
    saveText("有朋自遠方來", makeTree("ROOT"), id);

    const entries = listSavedTexts();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].title).toBe("有朋自遠方來");
  });

  it("falls back to a fresh save when the id is gone", () => {
    const id = saveText("學而時習之", makeTree("ROOT"))!;
    deleteSavedText(id);

    const newId = saveText("學而時習之", makeTree("ROOT"), id);
    expect(newId).not.toBe(id);
    expect(listSavedTexts()).toHaveLength(1);
  });

  it("reports failure rather than throwing when storage refuses the write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(saveText("學而時習之", makeTree("ROOT"))).toBeNull();
  });
});
