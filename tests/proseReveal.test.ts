import { describe, expect, it } from "vitest";
import {
  CHAR_FADE_MS,
  CHAR_REVEAL_MAX_MS,
  CHAR_REVEAL_MS,
  charStepMs,
  charsDrawnBy,
  proseShownBy,
} from "../src/parse/provisionalSentences.ts";
import { proseRevealUnits, type FlowNode, type ProseUnit } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// The 書き下し文 panel coming up beside the 訓読文 column, and the fade both
// of them come up with.
//
// There is no browser in this suite (the vitest environment is `node`), so
// what is checked here is the two halves of the reveal that are not a layout:
//
//  - **the schedule**, `proseShownBy`, which is arithmetic and is where the
//    whole of the synchronisation lives. The claim it has to make good is one
//    sentence: *sentence i of the prose starts when sentence i of the kundoku
//    column starts and finishes when it finishes* — and since the two panels
//    hold different numbers of characters for the same sentence, that is a
//    claim about two clocks agreeing at their ends rather than about a shared
//    rate. In between they do not agree and must not: the prose runs at its
//    own step, which is the sentence's span divided by its own count. It is exactly the kind of thing that can be off by one for months
//    without anybody noticing, and exactly the kind of thing a browser is the
//    worst place to check.
//
//  - **the units**, `proseRevealUnits`, which decides what a character of the
//    prose *is*. Two failures are possible and both are silent: a character
//    the walk misses is hidden by nothing and appears before its turn (or,
//    worse, is left visible while its sentence is still dark), and a character
//    counted twice puts its sentence's step out and desynchronises it from the
//    column. The nodes below are plain objects, `proseRevealUnits` being
//    written against `FlowNode` for that reason — the same device
//    `tests/kakikudashiHangWiring.test.ts` uses for `proseFlow`, and the same
//    reason: the correspondence is a fact about a tree.
//
// What is *not* checked here, and cannot be from this environment: that the
// per-character `<span>`s `markProseForReveal` writes leave the column's line
// breaking exactly as it was. See the note there for the argument and for the
// measurement that would settle it.
// ---------------------------------------------------------------------------

const text = (data: string): FlowNode => ({ nodeType: 3, nodeName: "#text", childNodes: [], data });
const el = (nodeName: string, ...childNodes: FlowNode[]): FlowNode => ({
  nodeType: 1,
  nodeName,
  childNodes,
});
/** One character of a glossed word, as `renderKakikudashiView` writes it:
 * `<ruby>` holding the character and an `<rt>` holding that one character's
 * kana. */
const ruby = (character: string, kana: string): FlowNode => el("RUBY", text(character), el("RT", text(kana)));

/** The characters `proseRevealUnits` picked out, as a string — which is only
 * readable because every unit is one character. A `<ruby>` reports the
 * character it glosses. */
function written(units: readonly ProseUnit[]): string {
  return units
    .map((unit) => {
      if (unit.kind === "character") return (unit.node.data ?? "").substr(unit.offset, unit.length);
      // The base of a gloss: its first text child, the `<rt>` being a sibling
      // of that text and not a wrapper round it.
      const children = unit.node.childNodes;
      for (let at = 0; at < children.length; at++) {
        if (children[at].nodeType === 3) return children[at].data ?? "";
      }
      return "";
    })
    .join("");
}

describe("proseRevealUnits", () => {
  it("gives one unit per character of a plain run", () => {
    const gap = el("SPAN", el("SPAN", text("これを")));
    expect(written(proseRevealUnits(gap))).toBe("これを");
    expect(proseRevealUnits(gap)).toHaveLength(3);
  });

  it("counts a gloss as one unit — the ruby, base and kana together", () => {
    // 長山, one `<ruby>` per character since the mono-ruby change. Three units
    // and not six: the kana are the character's own annotation and appear with
    // it, and the four kana of ちやう must not be four characters of the
    // schedule.
    const gap = el("SPAN", el("SPAN", ruby("長", "ちやう"), ruby("山", "さん")), el("SPAN", text("の")));
    const units = proseRevealUnits(gap);
    expect(units).toHaveLength(3);
    expect(units[0]).toEqual({ kind: "node", node: expect.objectContaining({ nodeName: "RUBY" }) });
    expect(written(units)).toBe("長山の");
  });

  it("takes the sentence separator written straight onto the gap", () => {
    // `sentenceSeparator`'s mark is a text node of the `.sentence-gap` itself
    // and is inside no `.kaki-token`. A walk that only visited the tokens
    // would leave every full stop in the passage permanently invisible.
    const gap = el("SPAN", el("SPAN", text("學ぶ")), text("。"));
    expect(written(proseRevealUnits(gap))).toBe("學ぶ。");
  });

  it("takes a connective and the text on either side of it, once each", () => {
    // The 連用形-て switch writes its connective in a wrapper inside the
    // token's own span, so the span holds three nodes and the characters must
    // come out in reading order with nothing repeated.
    const gap = el("SPAN", el("SPAN", text("學び"), el("SPAN", text("て")), text("は")));
    expect(written(proseRevealUnits(gap))).toBe("學びては");
  });

  it("takes a mark the fit has hung, through the span it wrapped it in", () => {
    // `applyHangingMarks` wraps a mark at a column's foot in a bare span. It
    // is not special-cased here: the walk simply enters it, and the mark comes
    // out once.
    const gap = el("SPAN", el("SPAN", text("之")), el("SPAN", text("、")), el("SPAN", text("不")));
    expect(written(proseRevealUnits(gap))).toBe("之、不");
  });

  it("counts a column break and its indent for nothing", () => {
    // A `<br>` has no ink, and the indent after it is whitespace — whose
    // counterpart in the kundoku column is an `indent-cell`, which is not a
    // `.kanji-cell` and so is neither hidden nor counted there either.
    const gap = el("SPAN", el("SPAN", text("甲")), el("BR"), text("　"), el("SPAN", text("乙")));
    expect(written(proseRevealUnits(gap))).toBe("甲乙");
  });

  it("keeps an astral character whole", () => {
    const gap = el("SPAN", el("SPAN", text("\u{20000}\u{20001}")));
    const units = proseRevealUnits(gap);
    expect(units).toHaveLength(2);
    expect(written(units)).toBe("\u{20000}\u{20001}");
  });

  it("reports every unit in reading order", () => {
    const gap = el(
      "SPAN",
      el("SPAN", text("子")),
      el("SPAN", ruby("曰", "いは")),
      el("SPAN", text("く、「")),
      el("SPAN", text("學ぶ")),
      text("。"),
    );
    expect(written(proseRevealUnits(gap))).toBe("子曰く、「學ぶ。");
  });
});

// ---------------------------------------------------------------------------

/** When kundoku character `at` (0-based) is on the screen, in milliseconds
 * from the start of the reveal — the inverse of `charsDrawnBy`, which floors,
 * so character `at` appears the instant the count first exceeds it. */
const kundokuAt = (at: number): number => (at + 1) * CHAR_REVEAL_MS;

/** When prose unit `at` of a sentence spanning kundoku `[from, to)` is on the
 * screen, found by asking rather than by re-deriving: the smallest whole
 * millisecond at which `proseShownBy` has passed it. Whole milliseconds are
 * finer than any frame, and the schedule is a step function, so this is the
 * moment to within the resolution anything can act on. */
function proseAt(at: number, from: number, to: number, units: number): number {
  for (let ms = 0; ms <= (to + 1) * CHAR_REVEAL_MS + 1; ms++) {
    if (proseShownBy(ms, from, to, units) > at) return ms;
  }
  return Number.POSITIVE_INFINITY;
}

describe("proseShownBy", () => {
  it("holds a sentence's prose back until the sentence begins", () => {
    // The kundoku sentence runs [10, 20); nothing of its prose is up at the
    // instant it opens, and something of it is up by the time the column has
    // drawn the sentence's own first character.
    expect(proseShownBy(10 * CHAR_REVEAL_MS, 10, 20, 17)).toBe(0);
    expect(proseShownBy(kundokuAt(10), 10, 20, 17)).toBeGreaterThan(0);
  });

  it("opens and closes a sentence's prose with the sentence itself", () => {
    // The claim in one test, over a sentence whose prose is longer than its
    // kanbun — which is every sentence, the prose writing the readings out.
    //
    // **The two ends coincide and the characters in between do not**, which
    // is what synchronising by sentence *means*: seventeen characters of
    // prose over ten of kanbun run at a shorter step, so the prose's first
    // character lands before the column's first does and every one after it
    // keeps its own pace. What has to be exact is the pair of endpoints —
    // nothing of the sentence up when it opens, all of it up when it closes —
    // and the last character of the two, which land together.
    const [from, to, units] = [10, 20, 17];
    const total = 30;
    expect(proseShownBy(from * CHAR_REVEAL_MS, from, to, units)).toBe(0);
    expect(charsDrawnBy(from * CHAR_REVEAL_MS, total)).toBe(from);
    expect(proseShownBy(to * CHAR_REVEAL_MS, from, to, units)).toBe(units);
    expect(charsDrawnBy(to * CHAR_REVEAL_MS, total)).toBe(to);
    expect(proseAt(units - 1, from, to, units)).toBe(kundokuAt(to - 1));
    // Its own step, and inside the sentence's own span.
    expect(proseAt(0, from, to, units)).toBeGreaterThan(from * CHAR_REVEAL_MS);
    expect(proseAt(0, from, to, units)).toBeLessThan(kundokuAt(from));
  });

  it("gives the whole of a sentence's prose by the end of its sentence and no sooner", () => {
    const [from, to, units] = [4, 9, 12];
    expect(proseShownBy(to * CHAR_REVEAL_MS - 1, from, to, units)).toBeLessThan(units);
    expect(proseShownBy(to * CHAR_REVEAL_MS, from, to, units)).toBe(units);
  });

  it("ends the two panels together, over a whole text", () => {
    // Five sentences, the kundoku counts of a short passage and prose counts
    // that run from a little longer to more than twice as long. What is
    // checked is the property the reveal is judged on: at the instant the
    // last kundoku character appears, every prose character has appeared, and
    // not one of them a frame earlier than the sentence it belongs to allows.
    const kundoku = [5, 8, 3, 11, 6];
    const prose = [9, 14, 4, 25, 7];
    let from = 0;
    const spans = kundoku.map((length) => {
      const span: [number, number] = [from, from + length];
      from += length;
      return span;
    });
    const total = from;

    for (let i = 0; i < spans.length; i++) {
      const [start, end] = spans[i];
      // Nothing of this sentence's prose before the column reaches it, all of
      // it by the time the column leaves it, and its last character with the
      // column's last.
      expect(proseShownBy(start * CHAR_REVEAL_MS, start, end, prose[i])).toBe(0);
      expect(proseShownBy(end * CHAR_REVEAL_MS, start, end, prose[i])).toBe(prose[i]);
      expect(proseAt(prose[i] - 1, start, end, prose[i])).toBe(kundokuAt(end - 1));
    }
    // The last of them is the last of the text.
    const [lastFrom, lastTo] = spans[spans.length - 1];
    expect(lastTo).toBe(total);
    expect(proseAt(prose[prose.length - 1] - 1, lastFrom, lastTo, prose[prose.length - 1])).toBe(
      kundokuAt(total - 1),
    );
    expect(charsDrawnBy(kundokuAt(total - 1), total)).toBe(total);
  });

  it("is monotonic", () => {
    // A character once shown is never taken back — the reveal counts up from
    // what it has already disclosed and would silently skip a character if
    // this ever went down.
    let last = 0;
    for (let ms = 0; ms <= 200; ms++) {
      const now = proseShownBy(ms, 3, 17, 23);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(23);
  });

  it("never exceeds the sentence's own count, however late it is asked", () => {
    expect(proseShownBy(1e9, 0, 4, 7)).toBe(7);
  });

  it("shows nothing for a sentence whose prose is empty", () => {
    expect(proseShownBy(0, 0, 5, 0)).toBe(0);
    expect(proseShownBy(1e6, 0, 5, 0)).toBe(0);
  });

  it("lands the whole of a sentence whose kundoku is empty, at its own moment", () => {
    // No span to spread across, so no division to make: the prose of a
    // sentence that takes no time is disclosed in no time, rather than being
    // left invisible for good.
    expect(proseShownBy(30 * CHAR_REVEAL_MS, 30, 30, 6)).toBe(0);
    expect(proseShownBy(30 * CHAR_REVEAL_MS + 1, 30, 30, 6)).toBe(6);
  });

  it("lands a prose sentence with no kundoku sentence to pair with at the very end", () => {
    // The fallback `animateCharacterReveal` uses when the two panels' gap
    // counts have come apart: the empty range at the end of the column, which
    // is the end of the text.
    const total = 40;
    expect(proseShownBy(total * CHAR_REVEAL_MS, total, total, 5)).toBe(0);
    expect(proseShownBy(total * CHAR_REVEAL_MS + 1, total, total, 5)).toBe(5);
  });

  it("runs a sentence at its own step and not at the column's", () => {
    // Ten kundoku characters, twenty of prose: two prose characters per
    // kundoku one, so the prose step is 3ms where the column's is 6.
    const step = ((10 - 0) * CHAR_REVEAL_MS) / 20;
    expect(step).toBe(CHAR_REVEAL_MS / 2);
    for (let at = 0; at < 20; at++) {
      expect(proseAt(at, 0, 10, 20)).toBe((at + 1) * step);
    }
  });
});

describe("the fade", () => {
  it("is the interval this app settles text over", () => {
    // `REFLOW_MS` in KundokuView.ts, `FADE_MS` in KakikudashiView.ts, the
    // visibility transition in kunten.css, and this. Four statements of one
    // number, and none of them can import any of the others; if one of them
    // moves and the others do not, one page will answer at two speeds. This
    // is the only one of the four a test can reach from here.
    expect(CHAR_FADE_MS).toBe(260);
  });

  it("leaves a leading edge dozens of characters deep, which is the effect", () => {
    // The gradient, as arithmetic: the frontier advances a character every
    // `CHAR_REVEAL_MS`, so a fade this long has forty-three of them between
    // nothing and full ink at any instant — some eight columns of a kundoku
    // panel that sets about five characters to a column.
    expect(Math.floor(CHAR_FADE_MS / CHAR_REVEAL_MS)).toBe(43);
  });

  it("is one fade long in *time* at every length, and wider only in characters", () => {
    // Past the knee the step shortens (`charStepMs`), so the edge takes in
    // more characters — 433 at ten thousand against 43 at the house rate. It
    // is tempting to read that as the gesture dissolving, and the arithmetic
    // here is the answer: what the edge measures is 260ms of *travel*, at
    // every length, because the extra characters are exactly the ones the
    // faster frontier crosses in the same 260ms.
    //
    // (This is why `CHAR_FADE_MS` was not shortened alongside the step. Held
    // at forty-three characters, the fade on a ten-thousand-character text
    // would be 26ms — under two frames, which is no fade — and it would break
    // the one-gesture-one-speed rule the constant is named for.)
    for (const total of [359, 1000, 10_000]) {
      const step = charStepMs(total);
      expect((CHAR_FADE_MS / step) * step).toBeCloseTo(CHAR_FADE_MS, 9);
    }
    expect(Math.floor(CHAR_FADE_MS / charStepMs(10_000))).toBe(433);
  });

  it("is a fade on any display", () => {
    // 15.6 frames at 60Hz, twice that at 120. It is also what hides the
    // frontier's own coarseness: the characters arrive three to a frame, and
    // at this depth each group comes in at its own alpha.
    expect(CHAR_FADE_MS / (1000 / 60)).toBeGreaterThan(15);
  });

  it("adds one fade to the end of the longest text it runs on", () => {
    // A character reaches full ink `CHAR_FADE_MS` after its own moment, so
    // the parse route's budget at `PARSE_REVEAL_MAX_CHARS` — 400 characters,
    // 2.40s of frontier — finishes at 2.66s. The tail is one fade long
    // whatever the length of the text, and whatever step it is travelling at:
    // the complete-tree route's six-second budget finishes at 6.26s on a text
    // of any length at all.
    expect(400 * CHAR_REVEAL_MS + CHAR_FADE_MS).toBe(2660);
    expect(CHAR_REVEAL_MAX_MS + CHAR_FADE_MS).toBe(6260);
  });
});
