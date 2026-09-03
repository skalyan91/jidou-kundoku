import { describe, expect, it } from "vitest";
import {
  deprojectivizeSentence,
  deprojectivizeSentences,
  isDecorated,
} from "../src/parse/deprojectivize.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { exportConllu } from "../src/parse/conlluExporter.ts";
import type { Token } from "../src/parse/types.ts";

/** Shorthand for a token: id, text, relation, head. Nothing downstream of
 * the deprojectivizer reads the other fields. */
function tok(id: number, text: string, dep: string, head: number): Token {
  return { id, text, lemma: text, pos: "X", xpos: "x", dep, head };
}

/** The tree as `(id, dep, head)` triples, which is what these tests are
 * about. */
function shape(tokens: Token[]): [number, string, number][] {
  return tokens.map((t) => [t.id, t.dep, t.head]);
}

/** Every token reaches the root by walking up `head`, within n steps. */
function isConnectedTree(tokens: Token[]): boolean {
  const roots = tokens.filter((t) => t.head === t.id);
  if (roots.length !== 1) return false;
  const root = roots[0].id;
  for (const t of tokens) {
    let cur = t.id;
    let steps = 0;
    while (cur !== root && steps <= tokens.length) {
      cur = tokens[cur].head;
      steps++;
    }
    if (cur !== root) return false;
  }
  return true;
}

describe("isDecorated", () => {
  it("recognizes a pseudo-label and nothing else", () => {
    expect(isDecorated("subj||comp:obj")).toBe(true);
    expect(isDecorated("punct||mod")).toBe(true);
    expect(isDecorated("comp:obj")).toBe(false);
    expect(isDecorated("mod@tmod")).toBe(false);
    expect(isDecorated("ROOT")).toBe(false);
  });
});

describe("deprojectivizeSentence — the HEAD scheme", () => {
  /* 惡在其為民父母也？ as the parser builds it before the postprocess. 其 (2)
   * is labelled `subj||comp:obj` on 為 (3): its relation is `subj` and its
   * real head is the first `comp:obj` below 為 — which is 父 (5), where
   * spaCy's own `deprojectivize` also puts it. Verified against the shipped
   * lzh_sud_kyoto 0.2.0 wheel, whose raw parse of this sentence is exactly
   * the tree below. */
  const LIFTED: Token[] = [
    tok(0, "惡", "subj", 1),
    tok(1, "在", "ROOT", 1),
    tok(2, "其", "subj||comp:obj", 3),
    tok(3, "為", "comp:obj", 1),
    tok(4, "民", "mod", 5),
    tok(5, "父", "comp:obj", 7),
    tok(6, "母", "flat", 5),
    tok(7, "也", "comp:pred", 3),
    tok(8, "？", "comp:pred", 3),
  ];

  it("lowers the lifted arc onto the head its label records", () => {
    const { tokens, stats } = deprojectivizeSentence(LIFTED);
    expect(tokens[2].dep).toBe("subj");
    expect(tokens[2].head).toBe(5);
    expect(stats).toEqual({ decorated: 1, reattached: 1, failedClosed: 0, reverted: false });
  });

  it("leaves every other arc exactly as it was", () => {
    const { tokens } = deprojectivizeSentence(LIFTED);
    for (const t of tokens) {
      if (t.id === 2) continue;
      expect([t.dep, t.head]).toEqual([LIFTED[t.id].dep, LIFTED[t.id].head]);
    }
  });

  it("does not mutate its input", () => {
    const before = shape(LIFTED);
    deprojectivizeSentence(LIFTED);
    expect(shape(LIFTED)).toEqual(before);
  });

  it("returns the same array when nothing is decorated", () => {
    const plain = [tok(0, "學", "ROOT", 0), tok(1, "之", "comp:obj", 0)];
    const result = deprojectivizeSentence(plain);
    expect(result.tokens).toBe(plain);
    expect(result.stats.decorated).toBe(0);
  });

  it("takes the nearest candidate, breadth-first before depth-first", () => {
    // 0 root; 1 is the lifted head; both 2 (a child of 1) and 4 (a
    // grandchild via 3) bear `mod`. The child wins, at depth 1.
    const t: Token[] = [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "comp:obj", 0),
      tok(2, "c", "mod", 1),
      tok(3, "d", "udep", 1),
      tok(4, "e", "mod", 3),
      tok(5, "f", "subj||mod", 1),
    ];
    const { tokens } = deprojectivizeSentence(t);
    expect(tokens[5].head).toBe(2);
  });

  it("breaks a tie within one level by source order, left to right", () => {
    const t: Token[] = [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "mod", 3),
      tok(2, "c", "mod", 3),
      tok(3, "d", "comp:obj", 0),
      tok(4, "e", "subj||mod", 3),
    ];
    const { tokens } = deprojectivizeSentence(t);
    expect(tokens[4].head).toBe(1);
  });

  it("searches below the lifted head, never above it", () => {
    // The only `mod` in the sentence is 1, a *sibling* of the lifted head 2
    // rather than a descendant. Nothing to lower onto: fail closed.
    const t: Token[] = [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "mod", 0),
      tok(2, "c", "comp:obj", 0),
      tok(3, "d", "subj||mod", 2),
    ];
    const { tokens, stats } = deprojectivizeSentence(t);
    expect(tokens[3].head).toBe(2);
    expect(stats).toEqual({ decorated: 1, reattached: 0, failedClosed: 1, reverted: false });
  });
});

describe("deprojectivizeSentence — failing closed", () => {
  it("keeps the lifted head and collapses the label when no candidate exists", () => {
    const t: Token[] = [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "comp:obj", 0),
      tok(2, "c", "subj||vocative", 1),
    ];
    const { tokens, stats } = deprojectivizeSentence(t);
    expect(tokens[2].dep).toBe("subj");
    expect(tokens[2].head).toBe(1);
    expect(stats).toEqual({ decorated: 1, reattached: 0, failedClosed: 1, reverted: false });
  });

  it("still collapses the label when the input is not a well-formed tree", () => {
    // Two self-loop roots: nothing to search, but the relation is still
    // recoverable and the attachment is left untouched.
    const t: Token[] = [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "ROOT", 1),
      tok(2, "c", "subj||mod", 1),
    ];
    const { tokens, stats } = deprojectivizeSentence(t);
    expect(tokens[2].dep).toBe("subj");
    expect(tokens[2].head).toBe(1);
    expect(stats).toEqual({ decorated: 1, reattached: 0, failedClosed: 1, reverted: false });
  });

  it("never lowers an arc onto the dependent itself", () => {
    // The lifted head 1 has the dependent 2 as its only child, and 2's own
    // relation is what is being looked for. spaCy skips the dependent
    // explicitly; so does this.
    const t: Token[] = [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "comp:obj", 0),
      tok(2, "c", "subj||subj", 1),
    ];
    const { tokens, stats } = deprojectivizeSentence(t);
    expect(tokens[2].head).toBe(1);
    expect(stats.reattached).toBe(0);
  });

  it("never lowers an arc into the dependent's own subtree", () => {
    // 3 is a child of the dependent 2 and bears the relation sought. Taking
    // it would make 2 its own grandchild.
    const t: Token[] = [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "comp:obj", 0),
      tok(2, "c", "subj||mod", 1),
      tok(3, "d", "mod", 2),
    ];
    const { tokens, stats } = deprojectivizeSentence(t);
    expect(tokens[2].head).toBe(1);
    expect(stats.reattached).toBe(0);
    expect(isConnectedTree(tokens)).toBe(true);
  });
});

describe("deprojectivizeSentence — tree invariants", () => {
  /** Every sentence below must come out a single-rooted, acyclic, connected
   * tree whatever the deprojectivizer decided, which is the property the
   * reorder engine walks off and the one a wrong re-attachment would break. */
  const CASES: Record<string, Token[]> = {
    "the lifted 其": [
      tok(0, "惡", "subj", 1),
      tok(1, "在", "ROOT", 1),
      tok(2, "其", "subj||comp:obj", 3),
      tok(3, "為", "comp:obj", 1),
      tok(4, "民", "mod", 5),
      tok(5, "父", "comp:obj", 7),
      tok(6, "母", "flat", 5),
      tok(7, "也", "comp:pred", 3),
      tok(8, "？", "comp:pred", 3),
    ],
    "two decorated arcs pointing at each other's subtrees": [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "mod||subj", 0),
      tok(2, "c", "subj", 1),
      tok(3, "d", "subj||mod", 0),
      tok(4, "e", "mod", 3),
    ],
    "a decorated label on the root itself": [
      tok(0, "a", "ROOT||mod", 0),
      tok(1, "b", "mod", 0),
    ],
    "a decorated arc whose head half names the root relation": [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "comp:obj", 0),
      tok(2, "c", "subj||ROOT", 1),
    ],
    "a chain of decorated arcs": [
      tok(0, "a", "ROOT", 0),
      tok(1, "b", "mod", 0),
      tok(2, "c", "subj||mod", 0),
      tok(3, "d", "comp:obj||subj", 0),
      tok(4, "e", "udep||comp:obj", 0),
    ],
    "a single token": [tok(0, "a", "ROOT", 0)],
  };

  for (const [name, tokens] of Object.entries(CASES)) {
    it(`keeps one root, no cycle and full connectivity: ${name}`, () => {
      const { tokens: out, stats } = deprojectivizeSentence(tokens);
      expect(out.filter((t) => t.head === t.id)).toHaveLength(1);
      expect(isConnectedTree(out)).toBe(true);
      expect(stats.reattached + stats.failedClosed).toBe(stats.decorated);
      expect(stats.reverted).toBe(false);
    });

    it(`leaves no decorated label behind: ${name}`, () => {
      const { tokens: out } = deprojectivizeSentence(tokens);
      expect(out.filter((t) => isDecorated(t.dep))).toEqual([]);
    });
  }

  it("keeps the root a self-loop even when its own label is decorated", () => {
    const { tokens } = deprojectivizeSentence(CASES["a decorated label on the root itself"]);
    expect([tokens[0].dep, tokens[0].head]).toEqual(["ROOT", 0]);
  });

  it("holds all four invariants over every re-attachment a random tree admits", () => {
    // A crude fuzz: random projective-ish trees with random decorated
    // labels, checked for the properties rather than for a particular
    // answer. Seeded by hand so a failure is reproducible.
    let seed = 20050101;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const rels = ["subj", "mod", "comp:obj", "punct", "flat"];
    for (let trial = 0; trial < 400; trial++) {
      const n = 2 + rand(8);
      const tokens: Token[] = [tok(0, "r", "ROOT", 0)];
      for (let i = 1; i < n; i++) {
        // Head strictly below i keeps the input acyclic and single-rooted.
        const head = rand(i);
        const rel = rels[rand(rels.length)];
        const dep = rand(3) === 0 ? `${rel}||${rels[rand(rels.length)]}` : rel;
        tokens.push(tok(i, `t${i}`, dep, head));
      }
      const { tokens: out, stats } = deprojectivizeSentence(tokens);
      expect(out.filter((t) => t.head === t.id).map((t) => t.id)).toEqual([0]);
      expect(isConnectedTree(out)).toBe(true);
      expect(out.some((t) => isDecorated(t.dep))).toBe(false);
      expect(stats.reattached + stats.failedClosed).toBe(stats.decorated);
      expect(stats.reverted).toBe(false);
    }
  });
});

/* ── Fidelity to spaCy ────────────────────────────────────────────────────
 *
 * Recorded output of `spacy.pipeline._parser_internals.nonproj.deprojectivize`
 * itself, run on random decorated trees under spaCy 3.8: `[heads in, deps in,
 * heads out]`. The whole point of this module is to be that function, so the
 * check is against that function and not against a reading of it.
 *
 * These 48 are a sample of a 20,000-case run in which every case matched
 * exactly — the first 24 chosen for the most arcs moved at once (which is
 * what exercises the live-parenthood-in-a-frozen-window reading of
 * `Token.children`), the rest at random. */
const SPACY_CASES: [number[], string[], number[]][] = [
  [[0, 0, 1, 2, 0, 3, 0, 2, 2, 2, 0, 1], ["ROOT", "subj", "comp:obj", "mod", "comp:obj||mod", "subj||comp:obj", "subj||subj", "subj||comp:obj", "mod||comp:obj", "subj||mod", "comp:obj||subj", "comp:obj||subj"], [0, 0, 1, 2, 3, 4, 1, 4, 4, 3, 1, 6]],
  [[0, 0, 1, 0, 3, 2, 1, 1, 2, 0, 1, 2], ["ROOT", "mod", "subj", "mod||subj", "comp:obj||mod", "subj||mod", "comp:obj||subj", "subj||subj", "comp:obj||subj", "subj||mod", "subj||mod", "subj"], [0, 0, 1, 2, 3, 3, 2, 2, 7, 1, 3, 2]],
  [[0, 0, 1, 0, 1, 2, 3, 0, 4, 1, 0], ["ROOT", "comp:obj", "mod", "subj||mod", "mod||subj", "comp:obj||subj", "mod||subj", "comp:obj||mod", "mod", "mod||subj", "subj||mod"], [0, 0, 1, 2, 3, 3, 3, 2, 4, 3, 2]],
  [[0, 0, 0, 1, 1, 1, 2, 5, 2, 5, 6], ["ROOT", "subj", "mod||subj", "subj||mod", "mod||comp:obj", "mod||subj", "comp:obj||subj", "mod||mod", "comp:obj||subj", "mod||subj", "comp:obj"], [0, 0, 1, 2, 10, 3, 3, 5, 3, 5, 6]],
  [[0, 0, 0, 1, 0, 0, 2, 5, 1, 3, 0], ["ROOT", "comp:obj||mod", "mod", "mod||comp:obj", "subj||mod", "subj||mod", "mod||mod", "mod", "comp:obj", "mod||subj", "mod||subj"], [0, 2, 0, 8, 2, 2, 7, 5, 1, 3, 4]],
  [[0, 0, 0, 0, 0, 2, 3, 1, 6, 2, 2, 6], ["ROOT", "comp:obj||subj", "comp:obj", "subj||comp:obj", "comp:obj||subj", "subj", "comp:obj", "subj", "mod", "subj||mod", "comp:obj||comp:obj", "comp:obj||mod"], [0, 5, 0, 2, 3, 2, 3, 1, 6, 8, 4, 8]],
  [[0, 0, 0, 0, 2, 4, 0, 4, 0, 4, 1], ["ROOT", "comp:obj||subj", "mod||comp:obj", "comp:obj||mod", "comp:obj", "subj||mod", "comp:obj||comp:obj", "mod", "mod||comp:obj", "subj||comp:obj", "comp:obj||mod"], [0, 0, 1, 2, 2, 7, 1, 4, 1, 4, 2]],
  [[0, 0, 0, 0, 0, 2, 4, 6, 4, 5], ["ROOT", "mod||mod", "mod", "comp:obj||comp:obj", "mod||mod", "subj||mod", "subj||subj", "mod", "mod||subj", "comp:obj"], [0, 2, 0, 9, 2, 4, 5, 6, 5, 5]],
  [[0, 0, 0, 2, 0, 1, 1, 0, 0, 3, 7], ["ROOT", "subj||comp:obj", "subj||subj", "subj||comp:obj", "comp:obj||subj", "mod||subj", "mod||subj", "mod||subj", "subj||subj", "subj", "mod||comp:obj"], [0, 0, 1, 2, 1, 2, 2, 1, 1, 3, 7]],
  [[0, 0, 0, 0, 0, 1, 1, 1, 0, 5], ["ROOT", "mod||comp:obj", "mod||subj", "mod||comp:obj", "subj", "mod||mod", "subj||mod", "comp:obj||subj", "comp:obj", "mod||subj"], [0, 8, 4, 8, 0, 1, 5, 6, 0, 6]],
  [[0, 0, 1, 0, 0, 3, 3, 3, 5, 3, 0, 0], ["ROOT", "comp:obj||mod", "subj||subj", "mod", "comp:obj||mod", "comp:obj", "subj||mod", "comp:obj||comp:obj", "mod", "comp:obj||comp:obj", "comp:obj", "comp:obj||mod"], [0, 3, 1, 0, 3, 3, 8, 4, 5, 4, 0, 3]],
  [[0, 0, 0, 0, 2, 0, 2, 3, 0], ["ROOT", "subj||comp:obj", "comp:obj", "comp:obj||comp:obj", "mod||mod", "subj||mod", "comp:obj||comp:obj", "mod||comp:obj", "comp:obj||mod"], [0, 2, 0, 2, 2, 4, 3, 6, 4]],
  [[0, 0, 1, 0, 3, 4, 3, 1, 6, 3, 6, 7], ["ROOT", "subj||comp:obj", "comp:obj||subj", "subj||subj", "subj", "comp:obj||subj", "mod||comp:obj", "comp:obj||subj", "mod||mod", "mod||comp:obj", "mod", "subj"], [0, 0, 11, 1, 3, 4, 5, 3, 10, 7, 6, 7]],
  [[0, 0, 1, 0, 1, 1, 3, 4, 0, 1, 0, 8], ["ROOT", "mod||subj", "subj||comp:obj", "mod", "comp:obj||subj", "comp:obj||subj", "subj", "comp:obj", "comp:obj||subj", "subj", "comp:obj||mod", "mod"], [0, 6, 7, 0, 9, 9, 3, 4, 6, 1, 3, 8]],
  [[0, 0, 0, 0, 2, 2, 0, 4, 0, 2, 2, 2], ["ROOT", "subj||comp:obj", "comp:obj||mod", "subj||comp:obj", "mod", "mod", "comp:obj||comp:obj", "comp:obj", "subj||subj", "comp:obj", "mod||mod", "subj||subj"], [0, 9, 0, 2, 2, 2, 2, 4, 3, 2, 4, 3]],
  [[0, 0, 1, 1, 2, 2, 1, 5, 1, 4, 0, 9], ["ROOT", "subj||subj", "mod||comp:obj", "comp:obj||mod", "comp:obj||subj", "comp:obj", "subj||subj", "subj", "subj||comp:obj", "mod", "subj", "comp:obj"], [0, 10, 1, 2, 7, 2, 7, 5, 3, 4, 0, 9]],
  [[0, 0, 1, 1, 3, 0, 2, 3, 4, 4, 6, 8], ["ROOT", "subj||comp:obj", "subj", "subj||subj", "comp:obj||mod", "comp:obj", "mod||mod", "mod", "comp:obj||mod", "mod", "mod", "mod||comp:obj"], [0, 5, 1, 2, 7, 0, 7, 3, 9, 4, 6, 8]],
  [[0, 0, 0, 2, 1, 0, 5, 2, 1, 7, 0, 0], ["ROOT", "subj||comp:obj", "mod||subj", "comp:obj||subj", "subj||mod", "mod||mod", "comp:obj||subj", "comp:obj||comp:obj", "mod", "comp:obj", "comp:obj||subj", "subj||mod"], [0, 9, 0, 2, 8, 2, 5, 3, 1, 7, 0, 2]],
  [[0, 0, 0, 0, 0, 2, 3, 3, 1, 1, 3, 3], ["ROOT", "comp:obj||subj", "subj||comp:obj", "subj||mod", "comp:obj||subj", "mod||comp:obj", "subj", "comp:obj||mod", "subj", "subj||subj", "mod||subj", "mod||mod"], [0, 6, 0, 0, 2, 4, 3, 3, 1, 8, 6, 3]],
  [[0, 0, 0, 0, 3, 3, 0, 2, 0, 0], ["ROOT", "comp:obj", "subj", "comp:obj||subj", "mod", "mod", "comp:obj||mod", "comp:obj||mod", "subj||comp:obj", "comp:obj||subj"], [0, 0, 0, 2, 3, 3, 4, 4, 1, 2]],
  [[0, 0, 0, 0, 2, 4, 4, 6, 1, 3, 0, 5], ["ROOT", "mod||mod", "subj||mod", "mod", "comp:obj||subj", "mod", "subj||mod", "mod", "subj", "comp:obj", "subj||comp:obj", "subj||subj"], [0, 3, 3, 0, 2, 4, 5, 6, 1, 3, 9, 6]],
  [[0, 0, 0, 0, 0, 0, 3, 0, 4, 3, 5, 0], ["ROOT", "mod||mod", "mod", "mod||comp:obj", "subj||comp:obj", "comp:obj||subj", "subj||comp:obj", "subj||mod", "mod||comp:obj", "comp:obj||mod", "comp:obj||comp:obj", "comp:obj||subj"], [0, 2, 0, 0, 0, 4, 3, 2, 5, 3, 5, 4]],
  [[0, 0, 0, 1, 3, 3, 3, 0, 2, 2, 5, 3], ["ROOT", "mod", "mod||mod", "subj||mod", "comp:obj||comp:obj", "comp:obj||comp:obj", "comp:obj||mod", "comp:obj||subj", "subj||mod", "subj", "subj", "comp:obj||comp:obj"], [0, 0, 1, 2, 3, 4, 3, 3, 2, 2, 5, 4]],
  [[0, 0, 0, 1, 0, 0, 2, 4, 4, 2, 4, 6], ["ROOT", "subj", "mod||subj", "mod||mod", "mod||comp:obj", "comp:obj||mod", "subj||subj", "subj||subj", "comp:obj||mod", "subj", "mod||comp:obj", "mod"], [0, 0, 1, 2, 0, 4, 9, 4, 4, 2, 5, 6]],
  [[0, 0, 0, 1, 3, 1, 3], ["ROOT", "comp:obj||comp:obj", "mod||mod", "comp:obj", "comp:obj||comp:obj", "mod", "comp:obj"], [0, 0, 5, 1, 6, 1, 3]],
  [[0, 0, 0, 0, 2, 4, 4, 6, 4], ["ROOT", "mod", "comp:obj", "mod", "subj||mod", "mod", "subj", "subj", "subj||subj"], [0, 0, 0, 0, 2, 4, 4, 6, 6]],
  [[0, 0, 1, 0], ["ROOT", "subj", "comp:obj||subj", "mod||subj"], [0, 0, 1, 1]],
  [[0, 0, 1, 2, 0, 3, 3, 1, 1, 5, 2], ["ROOT", "subj", "mod||comp:obj", "subj||mod", "subj||mod", "subj", "subj", "mod||mod", "subj||comp:obj", "mod||subj", "subj||mod"], [0, 0, 1, 2, 2, 3, 3, 2, 1, 5, 7]],
  [[0, 0, 0, 1, 3, 0, 2, 4, 1], ["ROOT", "subj", "comp:obj||comp:obj", "mod||comp:obj", "comp:obj||mod", "comp:obj||mod", "subj||subj", "mod", "mod"], [0, 0, 0, 1, 3, 3, 2, 4, 1]],
  [[0, 0, 1, 1, 3, 3, 5], ["ROOT", "subj||mod", "comp:obj||comp:obj", "mod||comp:obj", "comp:obj||mod", "comp:obj", "subj"], [0, 0, 5, 1, 3, 3, 5]],
  [[0, 0, 0, 1, 1, 0, 2, 3, 6, 2, 8], ["ROOT", "comp:obj||subj", "mod", "comp:obj", "mod||subj", "comp:obj", "comp:obj", "comp:obj", "comp:obj||comp:obj", "mod", "subj"], [0, 10, 0, 1, 1, 0, 2, 3, 6, 2, 8]],
  [[0, 0, 0, 2, 2], ["ROOT", "comp:obj", "comp:obj||comp:obj", "comp:obj||mod", "mod||subj"], [0, 0, 1, 2, 2]],
  [[0, 0, 0, 0, 2, 1, 3], ["ROOT", "mod", "mod||subj", "subj||subj", "comp:obj||mod", "mod||comp:obj", "subj"], [0, 0, 6, 0, 2, 1, 3]],
  [[0, 0, 0, 2, 1, 2, 2, 0, 6, 7, 4], ["ROOT", "mod||comp:obj", "subj", "subj||mod", "mod||subj", "mod", "comp:obj", "mod||subj", "mod||comp:obj", "comp:obj", "mod||subj"], [0, 6, 0, 5, 1, 2, 2, 2, 6, 7, 4]],
  [[0, 0, 0, 0, 1, 1, 5, 4], ["ROOT", "comp:obj", "subj||subj", "comp:obj||mod", "subj||mod", "comp:obj", "comp:obj||comp:obj", "mod"], [0, 0, 0, 7, 1, 1, 5, 4]],
  [[0, 0, 1, 2, 0, 0, 1, 4, 1, 7, 7, 1], ["ROOT", "mod||comp:obj", "subj||subj", "comp:obj||subj", "comp:obj", "mod||comp:obj", "comp:obj||comp:obj", "subj", "mod", "subj", "comp:obj||subj", "mod"], [0, 4, 1, 2, 0, 4, 3, 4, 1, 7, 9, 1]],
  [[0, 0, 0, 0, 2], ["ROOT", "subj", "comp:obj||subj", "subj||mod", "subj||mod"], [0, 0, 1, 0, 2]],
  [[0, 0, 1, 1, 2, 0, 1, 6, 0, 4, 1], ["ROOT", "subj||mod", "mod", "subj", "comp:obj||subj", "subj||subj", "subj", "subj", "comp:obj||subj", "mod||comp:obj", "mod"], [0, 0, 1, 1, 2, 1, 1, 6, 1, 4, 1]],
  [[0, 0, 0, 0, 3, 1], ["ROOT", "comp:obj||comp:obj", "mod", "comp:obj", "subj", "comp:obj||mod"], [0, 3, 0, 0, 3, 1]],
  [[0, 0, 1, 0, 0, 1, 0, 4, 2, 4, 5, 1], ["ROOT", "mod", "mod", "subj||comp:obj", "subj", "comp:obj||subj", "comp:obj||subj", "subj||subj", "mod||comp:obj", "subj", "mod||comp:obj", "comp:obj||subj"], [0, 0, 1, 0, 0, 1, 3, 9, 2, 4, 5, 1]],
  [[0, 0, 0, 1, 1, 2, 1, 6], ["ROOT", "subj||mod", "comp:obj||mod", "mod", "comp:obj", "subj", "mod||mod", "comp:obj"], [0, 0, 3, 1, 1, 2, 3, 6]],
  [[0, 0, 1, 1, 0, 1, 4, 0], ["ROOT", "comp:obj||mod", "comp:obj||comp:obj", "subj", "subj", "mod||mod", "subj||mod", "subj||subj"], [0, 0, 1, 1, 0, 1, 4, 4]],
  [[0, 0, 0, 1, 2, 2], ["ROOT", "subj||subj", "subj||mod", "mod||subj", "mod", "comp:obj||mod"], [0, 0, 0, 1, 2, 4]],
  [[0, 0, 0, 2, 0, 3], ["ROOT", "subj", "subj", "subj", "subj||subj", "subj"], [0, 0, 0, 2, 1, 3]],
  [[0, 0, 0, 1, 3, 3, 1, 1, 6, 4], ["ROOT", "comp:obj", "comp:obj", "comp:obj", "subj", "comp:obj||mod", "subj", "mod", "mod", "mod"], [0, 0, 0, 1, 3, 9, 1, 1, 6, 4]],
  [[0, 0, 1, 2, 2, 3, 4, 0, 5, 4, 7], ["ROOT", "comp:obj", "subj||subj", "mod||mod", "comp:obj", "mod||comp:obj", "comp:obj||comp:obj", "comp:obj", "subj", "mod", "comp:obj||subj"], [0, 0, 1, 9, 2, 3, 4, 0, 5, 4, 7]],
  [[0, 0, 1, 2, 3, 2, 1, 6, 4, 3, 3, 5], ["ROOT", "comp:obj", "subj", "subj", "subj||subj", "comp:obj||comp:obj", "subj", "mod||mod", "mod||mod", "mod", "mod||subj", "comp:obj||comp:obj"], [0, 0, 1, 2, 3, 2, 1, 6, 4, 3, 4, 5]],
  [[0, 0, 0, 1, 3, 0, 5, 5, 5, 8, 9], ["ROOT", "mod||mod", "mod||comp:obj", "mod||mod", "mod||subj", "mod||comp:obj", "comp:obj||mod", "comp:obj", "comp:obj", "subj||comp:obj", "comp:obj"], [0, 0, 7, 1, 3, 0, 5, 5, 5, 8, 9]],
];

describe("agreement with spaCy's own deprojectivize", () => {
  it("re-attaches every recorded case to the same head spaCy chose", () => {
    for (const [inHeads, inDeps, outHeads] of SPACY_CASES) {
      const tokens: Token[] = inHeads.map((h, i) => tok(i, `t${i}`, inDeps[i], h));
      const { tokens: out } = deprojectivizeSentence(tokens);
      expect(out.map((t) => t.head)).toEqual(outHeads);
      expect(isConnectedTree(out)).toBe(true);
    }
  });

  it("collapses every label, whether or not the arc was lowered", () => {
    for (const [inHeads, inDeps] of SPACY_CASES) {
      const tokens: Token[] = inHeads.map((h, i) => tok(i, `t${i}`, inDeps[i], h));
      const { tokens: out } = deprojectivizeSentence(tokens);
      expect(out.map((t) => t.dep)).toEqual(inDeps.map((d) => d.split("||")[0]));
    }
  });
});

describe("deprojectivizeSentences", () => {
  it("sums the counts across sentences", () => {
    const { stats } = deprojectivizeSentences([
      [
        tok(0, "a", "ROOT", 0),
        tok(1, "b", "mod", 0),
        tok(2, "c", "subj||comp:obj", 1),
        tok(3, "d", "comp:obj", 1),
      ],
      [tok(0, "a", "ROOT", 0), tok(1, "b", "comp:obj", 0), tok(2, "c", "subj||vocative", 1)],
      [tok(0, "a", "ROOT", 0)],
    ]);
    expect(stats).toEqual({ decorated: 2, reattached: 1, failedClosed: 1, reverted: false });
  });
});

describe("the CoNLL-U entry point", () => {
  const LIFTED_CONLLU = `# text = 惡在其為民父母也
1\t惡\t惡\tADV\ta,副詞,疑問,＊\t_\t2\tsubj\t_\t_
2\t在\t在\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\t_
3\t其\t其\tPRON\tn,代名詞,人称,起格\t_\t4\tsubj||comp:obj\t_\t_
4\t為\t為\tVERB\tv,動詞,行為,\t_\t2\tcomp:obj\t_\t_
5\t民\t民\tNOUN\tn,名詞,人,人\t_\t6\tmod\t_\t_
6\t父\t父\tNOUN\tn,名詞,人,関係\t_\t8\tcomp:obj\t_\t_
7\t母\t母\tNOUN\tn,名詞,人,関係\t_\t6\tflat\t_\t_
8\t也\t也\tPART\tp,助詞,句末,\t_\t4\tcomp:pred\t_\t_
`;

  it("lowers a lifted arc found in an uploaded file", () => {
    const tree = parseConllu(LIFTED_CONLLU);
    const t = tree.sentences[0].tokens[2];
    expect(t.text).toBe("其");
    expect(t.dep).toBe("subj");
    expect(t.head).toBe(5);
  });

  it("still recognizes a decorated root label as the root", () => {
    const tree = parseConllu(
      `1\ta\ta\tX\tx\t_\t0\troot||mod\t_\t_\n2\tb\tb\tX\tx\t_\t1\tmod\t_\t_\n`,
    );
    const root = tree.sentences[0].tokens[0];
    expect([root.dep, root.head]).toEqual(["ROOT", 0]);
  });

  it("survives a round trip back out to CoNLL-U and in again", () => {
    // The lowered arc is what gets written out, so the exported file is
    // projectively undecorated and re-imports to the identical tree — the
    // second pass has nothing left to do.
    const once = parseConllu(LIFTED_CONLLU);
    const text = exportConllu(once);
    expect(text).not.toContain("||");
    const twice = parseConllu(text);
    expect(twice.sentences).toEqual(once.sentences);
    expect(exportConllu(twice)).toBe(text);
  });

  it("leaves an ordinary file untouched", () => {
    const plain = `1\t學\t學\tVERB\tv\t_\t0\troot\t_\t_\n2\t之\t之\tPRON\tn\t_\t1\tcomp:obj\t_\t_\n`;
    const tree = parseConllu(plain);
    expect(shape(tree.sentences[0].tokens)).toEqual([
      [0, "ROOT", 0],
      [1, "comp:obj", 0],
    ]);
  });
});
