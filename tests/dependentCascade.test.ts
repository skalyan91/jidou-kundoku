import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DependentCascadeCandidate, planDependentCascade } from "../src/render/tokenInspector.ts";

/** **Reassigning a token's head must settle its dependents, and the reader
 * said how: "this will be determined by the parser's assigned arc
 * likelihoods."**
 *
 * `planDependentCascade` is the whole of that decision, kept pure and
 * exported for exactly the reason every other decision in tokenInspector.ts
 * is (`planCycleBreak`, `cyclePath`…): there is no Pyodide in this suite, so
 * the only way to check a rule stated over *arc likelihoods* is to hand it
 * likelihoods directly and read back what it does with them, rather than
 * trusting the prose beside it.
 *
 * `cascadeDependents` — the function that actually gathers those likelihoods
 * from `scoreArc` and applies what this one decides — cannot be called the
 * same way: it is not exported, it drives a real round trip to a worker this
 * checkout cannot start, and it mutates a live `Sentence` under an `await`.
 * What it can be checked against is its own source, stripped of comment and
 * string noise, the same discipline tests/arcShading.test.ts already keeps on
 * `shadeRetagMenu` for the identical reason — a mistake in *that* function's
 * own parser guard is exactly what shipped once already (see this file's
 * second describe block, and `shadeRetagMenu`'s own doc). */

function candidate(
  id: number,
  stayConfidence: number | null,
  move: { label: string; confidence: number } | null,
): DependentCascadeCandidate {
  return { id, stayConfidence, move };
}

describe("planDependentCascade", () => {
  it("moves a dependent to the new head when the parser prefers that arc", () => {
    const [decision] = planDependentCascade([candidate(1, 0.4, { label: "mod", confidence: 0.9 })]);
    expect(decision).toEqual({ id: 1, moved: true, dep: "mod" });
  });

  it("keeps a dependent on the old head when the parser prefers that arc", () => {
    const [decision] = planDependentCascade([candidate(1, 0.9, { label: "mod", confidence: 0.4 })]);
    expect(decision).toEqual({ id: 1, moved: false });
  });

  it("keeps a dependent on a tie — equal likelihoods have decided nothing", () => {
    // The reader's own phrase for the alternative: "a silent coin-toss that
    // rewires a reader's tree". A tie is not evidence for either answer, and
    // this function's rule is to leave the dependent exactly where it was
    // rather than break the tie by any means of its own.
    const [decision] = planDependentCascade([candidate(1, 0.5, { label: "mod", confidence: 0.5 })]);
    expect(decision).toEqual({ id: 1, moved: false });
  });

  it("never moves a dependent whose new arc the parser could not score, however weak the old one was", () => {
    // The old arc at 0.01 — about as unconfident as a scored arc gets — set
    // against no measurement at all for the new one. An unscoreable arc is a
    // question the parser was not asked, not a probability of zero, and
    // doubt about a *different* arc is not evidence for granting this one.
    const [decision] = planDependentCascade([candidate(1, 0.01, null)]);
    expect(decision).toEqual({ id: 1, moved: false });
  });

  it("never moves a dependent whose old arc the parser could not score, however strong the new one was", () => {
    // The mirror case: the arc that already exists is the one the transition
    // oracle happened not to reach (rarer, since moving the token above it can
    // change which arcs in the sentence cross which — see `scoreArc`'s own
    // doc on projectivity being a fact about the whole tree). Staying needs no
    // justification; only a measured comparison can move it, and there is
    // none here.
    const [decision] = planDependentCascade([candidate(1, null, { label: "mod", confidence: 0.99 })]);
    expect(decision).toEqual({ id: 1, moved: false });
  });

  it("keeps every dependent in place when nothing at all could be scored — the no-parser session", () => {
    // What a session with no parser behind the tree can honestly report about
    // any arc, having asked nothing at all: two nulls. This is not a special
    // branch anywhere in `planDependentCascade`'s own code — it is the same
    // "never moves on an unscoreable new arc" rule as the two tests above,
    // exercised on every candidate in the batch at once, which is exactly why
    // `cascadeDependents` can skip the round trip entirely in that session and
    // still reach the identical answer (see the second describe block below).
    const candidates = [candidate(1, null, null), candidate(2, null, null), candidate(3, null, null)];
    expect(planDependentCascade(candidates)).toEqual([
      { id: 1, moved: false },
      { id: 2, moved: false },
      { id: 3, moved: false },
    ]);
  });

  it("decides every dependent in a batch independently of the others", () => {
    const candidates = [
      candidate(1, 0.2, { label: "mod", confidence: 0.8 }), // moves
      candidate(2, 0.8, { label: "comp:obj", confidence: 0.2 }), // stays
      candidate(3, 0.5, null), // stays — unscoreable new arc
      candidate(4, null, { label: "cc", confidence: 0.5 }), // stays — unscoreable old arc
    ];
    expect(planDependentCascade(candidates)).toEqual([
      { id: 1, moved: true, dep: "mod" },
      { id: 2, moved: false },
      { id: 3, moved: false },
      { id: 4, moved: false },
    ]);
  });

  it("writes the label the winning arc score gave, never the dependent's old relation", () => {
    // The instruction's second half: "as will the deprels of any arcs thus
    // created" — not a default, and not whatever the dependent used to carry
    // to its *old* head, which described a different arc entirely.
    const [decision] = planDependentCascade([candidate(1, 0.1, { label: "comp:obl", confidence: 0.95 })]);
    expect(decision.dep).toBe("comp:obl");
    expect(decision.dep).not.toBe("mod"); // whatever the fixture's "old" relation might have been
  });

  it("returns nothing for an empty batch and does not choke on it", () => {
    expect(planDependentCascade([])).toEqual([]);
  });
});

/** **`cascadeDependents`, as the source states it.**
 *
 * The comment stripped out, the same way tests/arcShading.test.ts reads
 * `shadeRetagMenu`: what is checked is the shape of the fix, because there is
 * no browser or Pyodide here to run the function and observe its effect
 * directly. This exists specifically because the parser-guard mistake this
 * pattern was built to catch has already shipped once, in the sibling
 * function this file's own doc names — a session with no live parser (every
 * shipped sample, every CoNLL-U upload) must never have a plain drag start a
 * 46MB download on its behalf. */
describe("cascadeDependents, as the source states it", () => {
  const inspector = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "tokenInspector.ts"),
    "utf-8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  const cascade = inspector.slice(
    inspector.indexOf("function cascadeDependents"),
    inspector.indexOf("\nfunction ", inspector.indexOf("function cascadeDependents") + 1),
  );

  it("exists and is not accidentally exported", () => {
    expect(cascade.length).toBeGreaterThan(0);
    expect(inspector).not.toContain("export function cascadeDependents");
  });

  it("never starts the parser download in a session that has none", () => {
    // Before either candidate's collection is built and before any
    // `scoreArc(` call — the same ordering `shadeRetagMenu` was fixed to keep,
    // asked here the same way: an index comparison rather than a string
    // search for "somewhere before", so a guard moved *after* the first
    // network call would fail this even if the text still contained it.
    expect(cascade).toContain("if (dependents.length === 0 || !parserStarted()) return;");
    expect(cascade.indexOf("parserStarted()")).toBeLessThan(cascade.indexOf("scoreArc("));
  });

  it("scores the hypothetical move as a real arc in a synthetic tree, not a bare index pair", () => {
    // `scoreArc`'s own contract (pyodideClient.ts): the head/child indices
    // asked about have to be the tree's own, or the transition oracle never
    // reaches a state that answers about them. A dependent's arc to its
    // *current* head is already real in the live, already-edited tree — but
    // the arc to the *candidate* new head is not, so it has to be made real
    // in a copy before it can be asked about at all.
    expect(cascade).toContain("const movedHeads = heads.slice();");
    expect(cascade).toContain("movedHeads[sentence.tokens.findIndex((t) => t.id === dep.id)] = newHeadId;");
    expect(cascade).toMatch(/headIndex:\s*newHeadId,\s*childIndex:\s*dep\.id/);
  });

  it("routes the decision through planDependentCascade rather than reimplementing the rule", () => {
    expect(cascade).toContain("planDependentCascade(candidates)");
  });

  it("re-checks the whole edit, and then each dependent, against the live tree before writing", () => {
    // Two separate guards for two separate ways the round trip can go stale:
    // the reparent itself can have been undone (checked once, against `t`),
    // and a dependent already caught up in some other edit in the meantime
    // (checked per dependent, against its own current head).
    expect(cascade).toContain("if (!t || t.head !== newHeadId) return;");
    expect(cascade).toContain("if (!token || token.head !== tId) continue;");
  });

  it("writes no history entry of its own — no withUndo anywhere in it", () => {
    // The single-undo-step requirement rests on this: a write made between
    // two `withUndo` calls folds into whichever comes next rather than
    // pushing a snapshot of its own (see editHistory.test.ts's own test of
    // that property, and editHistory.ts's note on `withUndo`). A stray
    // `withUndo` in here would turn a head change and its cascade back into
    // the separate presses the reader asked not to have.
    expect(cascade).not.toContain("withUndo");
  });

  it("redraws through the same rerenderPreservingSelection every other edit uses", () => {
    expect(cascade).toContain("rerenderPreservingSelection()");
  });

  for (const caller of ["applySimpleReparent", "reparentBreakingCycle"]) {
    it(`is called from ${caller}, after its own structural edit has landed`, () => {
      const body = inspector.slice(
        inspector.indexOf(`function ${caller}`),
        inspector.indexOf("\n}", inspector.indexOf(`function ${caller}`)),
      );
      expect(body.length).toBeGreaterThan(0);
      expect(body).toContain("cascadeDependents(sentence, childId, newHeadId");
      // After, not before: the cascade's own hypothetical scoring needs a
      // heads array with the reparent already in it (see `cascadeDependents`'s
      // doc on why it runs where `relabelArcsUnder` does).
      expect(body.indexOf("cascadeDependents(")).toBeGreaterThan(body.indexOf("relabelArcsUnder("));
    });
  }

  it("excludes the cycle machinery's own dependent, and only in the cycle-breaking path", () => {
    const simple = inspector.slice(
      inspector.indexOf("function applySimpleReparent"),
      inspector.indexOf("\n}", inspector.indexOf("function applySimpleReparent")),
    );
    const cyclic = inspector.slice(
      inspector.indexOf("async function reparentBreakingCycle"),
      inspector.indexOf("\n}", inspector.indexOf("async function reparentBreakingCycle")),
    );
    // The plain reparent has no cycle and so nothing of its own to exclude.
    expect(simple).toContain("cascadeDependents(sentence, childId, newHeadId);");
    // The cycle-breaking path passes the one dependent `cycleChildOfDraggedToken`
    // names — see that function's own doc for why offering it a second
    // "move to the new head" option would reopen the very cycle just closed.
    expect(cyclic).toContain("cascadeDependents(sentence, childId, newHeadId, cycleChildOfDraggedToken(cycle));");
  });
});
