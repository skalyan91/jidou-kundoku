import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** **Why the relation menu stopped dimming, and the two guards against it
 * happening again quietly.**
 *
 * The 係り受け menu is shaded from the parser's own distribution over the
 * relations it could give this arc (`scoreArc` in pyodideClient.ts, and the
 * `dep` branch of `shadeRetagMenu` in tokenInspector.ts). The reader reported
 * that the shading had gone, and it had — for a reason that no type-checker
 * and no existing test could have seen, and that a bare `catch {}` had been
 * hiding for three rounds of work:
 *
 *   - the shipped sample texts are **CoNLL-U trees** and open by the upload
 *     route, which deliberately never starts Pyodide (`SAMPLE_TEXTS` in
 *     Sidebar.ts argues it, and `parserStarted` in pyodideClient.ts argues the
 *     other half);
 *   - `scoreArc` begins with `await initParser()`, so opening the relation
 *     menu in such a session *started a 46MB download* from a right click, and
 *     by the time it could have answered the menu was long gone
 *     (`openMenu !== menu`);
 *   - meanwhile the three category menus went on dimming, because they draw
 *     the treebank's own frequencies synchronously and do not need a model at
 *     all. So the one menu with no prior was the one that went flat, beside
 *     three that did not, which is exactly what was reported.
 *
 * Nothing in this repo can run the far side — there is no Pyodide in vitest,
 * and inventing the probabilities would be inventing the whole point. What is
 * testable is the near side of the wire and the shape of the caller, and both
 * are here: the request the worker will have to answer, and a source ratchet
 * on the two decisions that failed silently. The ratchet is worth its keep for
 * the reason the one in inspectorLayout.test.ts is: the failure it guards
 * against leaves no trace at all. */

interface WireMessage {
  id: number;
  type: string;
  [key: string]: unknown;
}

let answer: (msg: WireMessage) => unknown = () => null;
let sent: WireMessage[] = [];
/** Whether the fake should refuse to come up at all — a session with no
 * wheels behind it, which is what a `catch` in the caller is really for. */
let initFails = false;

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(_url: unknown, _options?: unknown) {}

  postMessage(msg: WireMessage): void {
    sent.push(msg);
    queueMicrotask(() => {
      if (msg.type === "init") {
        if (initFails) this.onmessage?.({ data: { id: msg.id, ok: false, error: "no wheels" } });
        else this.onmessage?.({ data: { id: msg.id, ok: true } });
        return;
      }
      this.onmessage?.({ data: { id: msg.id, ok: true, result: answer(msg) } });
    });
  }

  terminate(): void {}
}

type Client = typeof import("../src/parse/pyodideClient.ts");

async function freshClient(): Promise<Client> {
  vi.resetModules();
  return (await import("../src/parse/pyodideClient.ts")) as Client;
}

/** A well-formed answer, in the shape `scoreArc`'s doc records for 黍→種: an
 * arc the parser is sure of. Used only as a shape — which relations are right
 * is the worker's doc's business, and it measured them. */
const ARC = {
  label: "comp:obj",
  confidence: 0.985,
  labels: { "comp:obj": 0.97, "comp:obl": 0.01, mod: 0.005, subj: 0.0001 },
};

beforeEach(() => {
  sent = [];
  answer = () => null;
  initFails = false;
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  delete (globalThis as unknown as { Worker?: unknown }).Worker;
});

describe("the arc score, over the worker protocol", () => {
  it("asks under the type the worker switches on, and asks it after init", async () => {
    const { scoreArc } = await freshClient();
    answer = () => ARC;
    await scoreArc({ text: "輒半種黍", heads: [3, 3, 3, 3], deps: ["mod", "mod", "comp:obj", "ROOT"], headIndex: 3, childIndex: 2 });
    expect(sent.map((m) => m.type)).toEqual(["init", "arcScore"]);
  });

  it("carries the whole sentence's tree and the two ends of the arc", async () => {
    const { scoreArc } = await freshClient();
    answer = () => ARC;
    await scoreArc({ text: "輒半種黍", heads: [3, 3, 3, 3], deps: ["mod", "mod", "comp:obj", "ROOT"], headIndex: 3, childIndex: 2 });
    // All five, because the far side drives the parser's own transition system
    // to the state where *this* arc gets made, inside *this* tree: the text is
    // re-tokenized and checked against `heads.length`, and the two indices are
    // positions in that same array. A client that dropped `deps` would still
    // type-check and would ask about a different tree.
    expect(sent[1]).toMatchObject({
      type: "arcScore",
      text: "輒半種黍",
      heads: [3, 3, 3, 3],
      deps: ["mod", "mod", "comp:obj", "ROOT"],
      headIndex: 3,
      childIndex: 2,
    });
    expect(typeof sent[1].id).toBe("number");
  });

  it("passes the oracle's refusal through as a refusal, not as an empty menu", async () => {
    const { scoreArc } = await freshClient();
    answer = () => null;
    // An arc the arc-eager oracle cannot reach — a non-projective attachment —
    // comes back null, which is not the same as a distribution of zeros. The
    // caller leaves the menu unshaded rather than drawing every row at the
    // floor, which would read as "the model rejects all of these".
    expect(await scoreArc({ text: "黍", heads: [0], deps: ["ROOT"], headIndex: 0, childIndex: 0 })).toBeNull();
  });

  it("rejects rather than resolving when the session has no parser to start", async () => {
    const { scoreArc } = await freshClient();
    initFails = true;
    await expect(
      scoreArc({ text: "黍", heads: [0], deps: ["ROOT"], headIndex: 0, childIndex: 0 }),
    ).rejects.toThrow("no wheels");
    // And it never got as far as asking about the arc.
    expect(sent.map((m) => m.type)).toEqual(["init"]);
  });

  it("says whether this session has a parser at all, before starting one", async () => {
    const { parserStarted, scoreArc } = await freshClient();
    // The predicate the relation menu now consults. False in a session that
    // has never asked — which is every CoNLL-U session, samples included —
    // and, crucially, asking it costs nothing and starts nothing.
    expect(parserStarted()).toBe(false);
    expect(sent).toEqual([]);
    answer = () => ARC;
    await scoreArc({ text: "黍", heads: [0], deps: ["ROOT"], headIndex: 0, childIndex: 0 });
    expect(parserStarted()).toBe(true);
  });
});

describe("what the relation menu does with it", () => {
  /** The source, comments stripped — the same ratchet
   * tests/inspectorLayout.test.ts keeps on the semantics hold, and for the
   * same reason: there is no browser here, the failure is silent, and the
   * shape of the fix is the thing worth holding. */
  const inspector = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "tokenInspector.ts"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const shader = inspector.slice(
    inspector.indexOf("async function shadeRetagMenu"),
    inspector.indexOf("\n}", inspector.indexOf("async function shadeRetagMenu")),
  );

  it("does not start a 46MB parser from a menu opening", () => {
    expect(shader).toContain("if (!parserStarted()) return;");
    // Before the ask, and before the sentence is even looked up: the point is
    // that nothing at all happens in a session that has no parser.
    expect(shader.indexOf("parserStarted()")).toBeLessThan(shader.indexOf("scoreArc("));
    expect(inspector).toContain('import { parserStarted, scoreArc } from "../parse/pyodideClient.ts";');
  });

  it("no longer swallows the failure that hid this", () => {
    // **The bare `catch {}` is the defect being ratcheted.** It is what turned
    // a broken round trip into an unshaded menu with nothing in the console,
    // and it carried a comment naming the one failure that is now handled
    // before the try — so it was both silent and wrong about what it was
    // silencing.
    expect(shader).not.toMatch(/catch\s*\{\s*\}/);
    expect(shader).toMatch(/catch\s*\(err\)/);
    expect(shader).toContain("console.warn(");
    // And the quiet outcomes stay quiet: an unreachable arc and a menu the
    // reader has already replaced are both ordinary, and neither is a warning.
    // They are two conditions rather than one so that a reader of the code can
    // see which is which.
    expect(shader).toContain("if (!arc) return;");
    expect(shader).toContain("if (openMenu !== menu) return;");
  });
});
