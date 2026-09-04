import { describe, expect, it } from "vitest";
import { planHangingMarks } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// ぶら下げ in the 書き下し文 panel: which marks hang, and where the columns
// then break.
//
// A 、 or 。 that will not fit at the foot of a column hangs into the margin
// below it rather than taking the character before it down to the next column
// (追い出し). CSS has a property for exactly that and it is Safari's alone, so
// the panel works it out instead — which it can, because the panel has a
// **fixed advance**: `fittedTracking` chooses a tracking that makes a whole
// number of characters fill the column's measure exactly, every glyph in the
// prose is one em, and nothing in the flow is proportional. Where a column
// breaks is therefore arithmetic on the character sequence, and that is what
// `planHangingMarks` is.
//
// This file is the whole of the verification available without a browser, and
// it is deliberately not only a set of examples: the last two blocks assert
// the *invariants* — 禁則 holds, no column is overfull, the walk terminates —
// over a corpus of generated prose at every column length the panel uses.
//
// What cannot be checked here is the other half of the mechanism: that a
// browser, handed a mark whose `margin-inline-end` gives back exactly its own
// advance, breaks the line after it and paints its glyph into the padding.
// That is `.text-kakikudashi .hanging-mark` in typography.css, and it needs a
// browser.
// ---------------------------------------------------------------------------

/** The prose as the model says it will be set: one string per column, the
 * hanging mark included at the end of the column it hangs from — which is
 * where it is on the page, overhanging the margin. */
const setIn = (text: string, slots: number): string[] => {
  const plan = planHangingMarks(text, slots);
  const characters = [...text];
  return plan.columns.map((from, i) => {
    const to = i + 1 < plan.columns.length ? plan.columns[i + 1] : characters.length;
    return characters.slice(from, to).join("").replace(/\n/g, "");
  });
};

const hangsIn = (text: string, slots: number) => planHangingMarks(text, slots).hangs.map((at) => [...text][at]);

describe("what hangs", () => {
  it("hangs the mark that would otherwise have been pushed down", () => {
    // Six characters and a 。. Without hanging the 。 cannot begin the second
    // column (行頭禁則) and takes 六 with it, so the passage is two columns and
    // the first is a character short. Hanging, it is one column of six with
    // the mark in the margin below.
    expect(setIn("一二三四五六。", 6)).toEqual(["一二三四五六。"]);
    expect(hangsIn("一二三四五六。", 6)).toEqual(["。"]);
  });

  it("leaves a mark with room in the column alone", () => {
    // The mark is the sixth character, not the seventh: it fits, so there is
    // nothing to hang and it takes its full advance like anything else.
    expect(hangsIn("一二三四五。六", 6)).toEqual([]);
    expect(setIn("一二三四五。六", 6)).toEqual(["一二三四五。", "六"]);
  });

  it("hangs a mark at the end of the text, and at the end of a source line", () => {
    expect(setIn("一二三四五六。", 6)).toEqual(["一二三四五六。"]);
    expect(setIn("一二三四五六。\n七八", 6)).toEqual(["一二三四五六。", "七八"]);
  });

  it("hangs 句点 and 読点 and nothing else", () => {
    for (const mark of ["、", "。", "，", "．"]) {
      expect(hangsIn(`一二三四五六${mark}七`, 6)).toEqual([mark]);
    }
    // A closing bracket is set by 詰め rather than hung (JIS X 4051 gives
    // ぶら下げ to 句読点 alone), so it goes down by 追い出し and takes 六 with
    // it — the column is a character short, which is what hanging exists to
    // prevent and what this deliberately does not do.
    expect(hangsIn("一二三四五六」七", 6)).toEqual([]);
    expect(setIn("一二三四五六」七", 6)).toEqual(["一二三四五", "六」七"]);
  });

  it("declines to hang where the mark's successor could not begin a column", () => {
    // 。」 at the boundary. Hanging only the 。 would put the 」 at the head of
    // the next column, which is the rule ぶら下げ is the partner to rather than
    // a licence against — so the pair goes down together instead.
    expect(hangsIn("一二三四五六。」七", 6)).toEqual([]);
    expect(setIn("一二三四五六。」七", 6)).toEqual(["一二三四五", "六。」七"]);
  });
});

describe("hanging does not buy the column a character", () => {
  // The convergence question, and the whole of it. A hanging mark takes the
  // position it would have had — the head of the next column — and overhangs
  // the margin from there; the column does *not* gain room, so the character
  // after the mark is not drawn up into it. Which is why the walk is one
  // forward pass with nothing to settle: at every boundary the decision is
  // made from characters already placed, and making it cannot move the
  // boundary that produced it.
  it("starts the next column at the character after the mark, not at the mark", () => {
    expect(setIn("一二三四五六。七八九十百千", 6)).toEqual(["一二三四五六。", "七八九十百千"]);
  });

  it("gives every column its full complement and no more", () => {
    // Twelve characters and two marks, at six to the column. Both marks fall
    // at a foot and both hang, and the passage is exactly two columns — the
    // same two columns the marks would have had if they were not there at all.
    const text = "一二三四五六、七八九十百千。";
    expect(setIn(text, 6)).toEqual(["一二三四五六、", "七八九十百千。"]);
    expect(planHangingMarks(text, 6).columns.length).toBe(2);
    expect(planHangingMarks("一二三四五六七八九十百千", 6).columns.length).toBe(2);
  });

  it("saves one column for every `slots` marks that hang, and not one per mark", () => {
    // A mark every seventh character at six to the column: every mark lands at
    // a foot and hangs, so the passage carries its marks for nothing. Against
    // the same text with the marks taking their advance — which is what the
    // panel does today in Chrome and Firefox — that is a sixth of a column
    // saved per mark.
    const marked = Array.from({ length: 12 }, () => "一二三四五六、").join("");
    expect(planHangingMarks(marked, 6).hangs.length).toBe(12);
    expect(planHangingMarks(marked, 6).columns.length).toBe(12);
    // 84 characters at six to the column is fourteen columns if the marks are
    // set in the text.
    expect(Math.ceil(marked.length / 6)).toBe(14);
  });
});

describe("禁則, which the model now has to predict rather than merely leave alone", () => {
  it("never lets a mark begin a column", () => {
    // Nothing here hangs — the mark is not at a foot when the walk reaches the
    // boundary in the first case, and is a bracket in the second — so 追い出し
    // is what keeps the rule, exactly as the browser's own line breaker does.
    // A closing bracket, and a 。 the model has declined to hang because a 」
    // follows it. A 。 on its own would have hung instead, which is the whole
    // point of the exercise — 追い出し is what is left for the marks hanging
    // cannot help.
    expect(setIn("一二三四五）六", 5)).toEqual(["一二三四", "五）六"]);
    expect(setIn("一二三四五。」六", 5)).toEqual(["一二三四", "五。」六"]);
  });

  it("never lets a small kana or a 長音符 begin a column", () => {
    // `line-break: normal` (declared on `.text-kakikudashi`) keeps the class
    // NS non-starters non-starting, and the panel writes them: もって is in the
    // readings.
    expect(setIn("一二三四もって", 5)).toEqual(["一二三四", "もって"]);
    expect(setIn("一二三四五ー六", 5)).toEqual(["一二三四", "五ー六"]);
  });

  it("never leaves an opening bracket at a column's foot", () => {
    // 行末禁則: the bracket belongs to what follows it, so it goes down with
    // the quotation it opens.
    expect(setIn("一二三四「五六", 5)).toEqual(["一二三四", "「五六"]);
  });

  it("pulls back as far as it has to and no further", () => {
    // A mark behind a bracket behind a mark: three characters that may not
    // begin a column, so the boundary moves back past all of them.
    expect(setIn("一二三四五六。」。七", 6)).toEqual(["一二三四五", "六。」。七"]);
  });

  it("refuses to empty a column, however unbreakable the run", () => {
    // Pathological and not producible by this generator — a whole column of
    // non-starters — and the guard is that the walk leaves a character behind
    // rather than looping or handing the next column more than it holds.
    const columns = setIn("一。。。。。。。。", 4);
    expect(columns[0].length).toBeGreaterThan(0);
    expect(columns.join("")).toBe("一。。。。。。。。");
  });
});

describe("the source's own breaks", () => {
  it("starts a new column at a line break, however short the last one was", () => {
    expect(setIn("一二\n三四五六七八九", 6)).toEqual(["一二", "三四五六七八", "九"]);
  });

  it("counts the indent cells as the characters they are", () => {
    // A `layout` piece is a newline and its 　 indent (generator.ts), and an
    // ideographic space takes a full advance like anything else — CSS collapses
    // U+0020 and not U+3000.
    expect(setIn("一二三\n　四五六七八", 5)).toEqual(["一二三", "　四五六七", "八"]);
  });
});

describe("degenerate input", () => {
  it("answers nothing for a column that could not hold a character", () => {
    expect(planHangingMarks("一二三", 0)).toEqual({ hangs: [], columns: [] });
    expect(planHangingMarks("一二三", -1)).toEqual({ hangs: [], columns: [] });
    expect(planHangingMarks("一二三", Number.NaN)).toEqual({ hangs: [], columns: [] });
  });

  it("answers nothing for no text", () => {
    expect(planHangingMarks("", 6)).toEqual({ hangs: [], columns: [] });
    expect(planHangingMarks("\n\n", 6)).toEqual({ hangs: [], columns: [] });
  });

  it("counts by character and not by UTF-16 unit", () => {
    // An astral kanji is one character of the column and one cell of the
    // sequence; indexing it as two would put every mark after it in the wrong
    // place. 𠀋 is U+2000B, a surrogate pair.
    const text = "𠀋𠀋𠀋𠀋𠀋𠀋。𠀋";
    expect(hangsIn(text, 6)).toEqual(["。"]);
    expect(setIn(text, 6)).toEqual(["𠀋𠀋𠀋𠀋𠀋𠀋。", "𠀋"]);
  });
});

// ---------------------------------------------------------------------------
// The invariants, over generated prose.
//
// The examples above are the cases the text actually produces. These are the
// claim: whatever the sequence, the model's breaks are breaks a Japanese
// typesetter would make, no column is overfull, and the walk gets to the end.
// ---------------------------------------------------------------------------

/** The plain characters of the prose — kanji and kana, everything the line
 * breaker will put anywhere. */
const PLAIN = [..."學問思辨行あいうえおかきくけこさしすせそた"];

/** And the characters it will not: the two marks that hang, the brackets that
 * do not, a small kana and a 長音符. */
const DIFFICULT = ["、", "。", "」", "「", "っ", "ー"];

/** A deterministic pseudo-random passage — a seeded walk rather than
 * `Math.random`, so a failure is a failure someone else can reproduce.
 *
 * No two difficult characters stand together and none begins a line, which is
 * a fact about Japanese prose rather than a convenience: 。」 does occur, and
 * the walk handles it (see the example above), but a *run* of them long enough
 * to swallow a whole column is the pathological case the guard in the model is
 * for and not the case these invariants are about. */
function passage(seed: number, length: number): string {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  let out = "";
  let awkward = true;
  for (let i = 0; i < length; i++) {
    const roll = next();
    if (!awkward && roll < 0.14) {
      out += DIFFICULT[Math.floor(next() * DIFFICULT.length)];
      awkward = true;
    } else if (!awkward && roll < 0.17) {
      out += "\n";
      awkward = true;
    } else {
      out += PLAIN[Math.floor(next() * PLAIN.length)];
      awkward = false;
    }
  }
  return out;
}

const MAY_NOT_BEGIN = new Set(["、", "。", "」", "っ", "ー"]);

/** Where each of the source's own lines starts — the one place a character
 * that may not begin a column can be found at the head of one, because the
 * break is the source's and there is nothing before it to pull back. */
function lineHeads(characters: readonly string[]): Set<number> {
  const heads = new Set<number>();
  let fresh = true;
  characters.forEach((character, at) => {
    if (character === "\n") {
      fresh = true;
      return;
    }
    if (fresh) heads.add(at);
    fresh = false;
  });
  return heads;
}

// ── Why these two blocks carry a timeout of their own ──────────────────────
// They are the exhaustive ones: forty seeded passages of four hundred
// characters walked at every column length, and every arrangement of 文。」「っ
// up to eight characters at three column lengths. In isolation the slowest
// single test in the file runs in about three seconds against Vitest's default
// budget of five, which is comfortable — and stops being comfortable when
// several agents run their suites at once on the same machine, where the same
// tests have twice been seen to pass the five seconds and fail the run.
//
// The budget is raised rather than the work reduced, because the work is the
// point: what these assert is a property over every arrangement, and thinning
// the sweep to fit a stopwatch would trade the thing being checked for the
// speed of checking it. Twenty seconds is six times the isolated cost, which
// is load-sensitivity and not a slowdown; a genuine regression in
// `planHangingMarks` would blow through it just the same.
describe("the invariants", () => {
  it("never breaks where Japanese typesetting forbids a break", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const text = passage(seed, 400);
      const characters = [...text];
      const heads = lineHeads(characters);
      for (let slots = 3; slots <= 12; slots++) {
        const plan = planHangingMarks(text, slots);
        const hangs = new Set(plan.hangs);
        for (const from of plan.columns) {
          const head = characters[from];
          expect(head).not.toBe("\n");
          // 行頭禁則, and a hanging mark belongs to the column above rather
          // than heading the one below.
          if (!heads.has(from)) expect(MAY_NOT_BEGIN.has(head)).toBe(false);
          expect(hangs.has(from)).toBe(false);
        }
        for (let i = 1; i < plan.columns.length; i++) {
          // 行末禁則: the character a column ends on, the hanging mark set
          // aside, is never an opening bracket.
          let last = plan.columns[i] - 1;
          while (last >= 0 && (characters[last] === "\n" || hangs.has(last))) last--;
          if (last >= plan.columns[i - 1]) expect(characters[last]).not.toBe("「");
        }
      }
    }
  });

  it("never overfills a column, and never sets one longer than the panel holds", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const text = passage(seed, 400);
      const characters = [...text];
      for (let slots = 3; slots <= 12; slots++) {
        const plan = planHangingMarks(text, slots);
        const hangs = new Set(plan.hangs);
        for (let i = 0; i < plan.columns.length; i++) {
          const to = i + 1 < plan.columns.length ? plan.columns[i + 1] : characters.length;
          let held = 0;
          for (let at = plan.columns[i]; at < to; at++) {
            if (characters[at] === "\n" || hangs.has(at)) continue;
            held++;
          }
          expect(held).toBeGreaterThan(0);
          expect(held).toBeLessThanOrEqual(slots);
        }
      }
    }
  });

  it("hangs only at a column's foot, off a column that is full", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const text = passage(seed, 400);
      const characters = [...text];
      for (let slots = 3; slots <= 12; slots++) {
        const plan = planHangingMarks(text, slots);
        const starts = plan.columns;
        for (const at of plan.hangs) {
          // The mark belongs to the last column that began before it, and
          // every character between that column's start and the mark — the
          // whole of the column — is a full complement.
          let column = -1;
          for (let i = 0; i < starts.length; i++) if (starts[i] <= at) column = i;
          expect(column).toBeGreaterThanOrEqual(0);
          let held = 0;
          for (let i = starts[column]; i < at; i++) if (characters[i] !== "\n") held++;
          expect(held).toBe(slots);
          // And the column ends there: the next column starts at the character
          // after the mark, so the mark took no room in it either.
          if (column + 1 < starts.length) expect(starts[column + 1]).toBeGreaterThan(at);
        }
      }
    }
  });

  it("never pushes a character down for a mark that could have hung", () => {
    // **The property the whole ordering exists for.** 追い出し does not move
    // the mark alone — no break is allowed before a 、 or 。, so the mark takes
    // the character before it down as well and the column it leaves is a
    // character short. Hanging is what spares that character, so a column may
    // only come out short where the mark at its boundary genuinely could not
    // hang.
    for (let seed = 1; seed <= 40; seed++) {
      const text = passage(seed, 400);
      for (let slots = 3; slots <= 12; slots++) {
        expect(shortForAHangableMark(text, slots)).toEqual([]);
      }
    }
  });

  it("accounts for every character exactly once", () => {
    // The walk terminates and loses nothing — the columns partition the text.
    for (let seed = 1; seed <= 40; seed++) {
      const text = passage(seed, 400);
      const characters = [...text];
      for (let slots = 3; slots <= 12; slots++) {
        const plan = planHangingMarks(text, slots);
        expect(plan.columns[0]).toBe(characters.findIndex((c) => c !== "\n"));
        for (let i = 1; i < plan.columns.length; i++) {
          expect(plan.columns[i]).toBeGreaterThan(plan.columns[i - 1]);
        }
      }
    }
  });
}, { timeout: 20_000 });

/** Every column that came out short of its complement while a mark that could
 * have hung stood at its boundary — which is the one thing the ordering of the
 * walk's branches is there to make impossible.
 *
 * "At its boundary" is read off the *text*, not off the answer: walk `slots`
 * characters forward from where the column began, and the next character is
 * the one the walk had in hand when it decided. A column cut short by the
 * source's own line break is not the walk's doing and is skipped. */
function shortForAHangableMark(text: string, slots: number): string[] {
  const characters = [...text];
  const plan = planHangingMarks(text, slots);
  const hangs = new Set(plan.hangs);
  const found: string[] = [];
  for (let i = 0; i < plan.columns.length; i++) {
    const to = i + 1 < plan.columns.length ? plan.columns[i + 1] : characters.length;
    let held = 0;
    for (let at = plan.columns[i]; at < to; at++) {
      if (characters[at] !== "\n" && !hangs.has(at)) held++;
    }
    if (held >= slots) continue;
    let seen = 0;
    let at = plan.columns[i];
    while (at < characters.length && seen < slots && characters[at] !== "\n") {
      seen++;
      at++;
    }
    if (seen < slots) continue;
    const boundary = characters[at];
    const after = characters[at + 1];
    const couldHang =
      (boundary === "、" || boundary === "。") &&
      (after === undefined || after === "\n" || !MAY_NOT_BEGIN.has(after));
    if (couldHang) found.push(`${text} at ${slots} to the column, column ${i}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Hanging takes precedence over 追い出し, exhaustively.
//
// The seeded corpus above is prose-shaped and says nothing about the corners.
// This says it for *every* arrangement: five characters — an ordinary one, a
// mark that hangs, a closing bracket, an opening bracket and a small kana —
// over every string up to eight long, at two, three and four to the column.
// 488,280 passages, and not one of them comes out with a column short of its
// complement while a mark that could have hung stood at its boundary.
//
// It is a test of the *order* of two branches, which is the kind of thing a
// comment claims and an example does not settle. Move the pull-back above the
// hang and this fails in the first hundred strings.
// ---------------------------------------------------------------------------

describe("hanging takes precedence over 追い出し", () => {
  it("holds for every arrangement of prose up to eight characters", () => {
    const alphabet = ["文", "。", "」", "「", "っ"];
    for (let length = 1; length <= 8; length++) {
      const arrangements = alphabet.length ** length;
      for (let code = 0; code < arrangements; code++) {
        let text = "";
        let rest = code;
        for (let i = 0; i < length; i++) {
          text += alphabet[rest % alphabet.length];
          rest = Math.floor(rest / alphabet.length);
        }
        for (const slots of [2, 3, 4]) {
          const short = shortForAHangableMark(text, slots);
          if (short.length > 0) expect(short).toEqual([]);
        }
      }
    }
  });
}, { timeout: 20_000 });

// ---------------------------------------------------------------------------
// What hanging does to the two panels ending in the same place.
//
// The prose panel's height is chosen from column counts: `matchedDivision`
// picks the split and the column length that run this passage as far across
// the page as the kundoku passage above it. Hanging changes column counts, so
// it changes that choice — which is a thing to know rather than a thing to do,
// since `fitPassageExtent` measures the laid-out passage at every candidate
// and so re-derives the division from whatever hanging has done to it.
//
// 酒蟲 itself cannot be run here: the source is not in this repository, and
// what the previous round left of it (`SHUCHU_PROSE` in
// kakikudashiColumnFit.test.ts) is column *counts*. Those counts do pin the
// three source lines' lengths — 159, 185 and 308 is one of the nine partitions
// of 652 consistent with every entry, and all nine give the same table by
// construction — but they say nothing about *where* the punctuation in them
// falls, which is the whole of what decides how many marks hang.
//
// So the passage below is that shape, punctuated at the density the repository
// does record: 359 source characters against 271 kundoku cells is 88 marks (a
// mark takes no advance in that panel — `.punct-cell` in kunten.css), split
// here as seventy 句読点, seven bracket pairs and fifteen small kana. That mix
// is not a guess left unchecked: at ten characters to the column it puts the
// **un-hung** passage at 66 to 69 columns, and `.text-kakikudashi` in
// typography.css records having measured 67 on the real text where the naive
// count is 66. The one number the repository holds, the model reproduces.
//
// Three regimes are compared, because the previous round compared the wrong
// two. `bare` is `ceil(line / slots)` — the old table, which is no browser's
// behaviour: it lets a mark begin a column. `today` is what Chrome and Firefox
// actually lay out, 追い出し and no hanging. `hung` is this walk.
// ---------------------------------------------------------------------------

/** 652 characters over three lines, with punctuation laid pseudo-randomly
 * rather than periodically: marks at a fixed period alias against columns at a
 * fixed length, and either all of them hang or none do, which is the one thing
 * real prose never does.
 *
 * Nothing awkward stands at a line's head or next to anything else awkward,
 * which is prose rather than a convenience — and it keeps the pull-back to the
 * two characters the walk ever needs. */
function shuchuShaped(seed: number, marks: number, brackets: number, awkward: number): string {
  const lines = [159, 185, 308];
  const total = lines.reduce((sum, line) => sum + line, 0);
  const heads = new Set<number>();
  let head = 0;
  for (const line of lines) {
    heads.add(head);
    head += line;
  }
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const put = new Map<number, string>();
  const place = (character: string, count: number) => {
    let placed = 0;
    let tries = 0;
    while (placed < count && tries++ < 200000) {
      const at = Math.floor(next() * total);
      if (heads.has(at) || put.has(at) || put.has(at - 1) || put.has(at + 1)) continue;
      put.set(at, character);
      placed++;
    }
  };
  place("。", marks);
  place("」", brackets);
  place("「", brackets);
  place("っ", awkward);
  let index = 0;
  return lines
    .map((line) => {
      let written = "";
      for (let i = 0; i < line; i++, index++) written += put.get(index) ?? "文";
      return written;
    })
    .join("\n");
}

/** 酒蟲's shape at the density above. */
const shuchu = (seed: number) => shuchuShaped(seed, 70, 7, 15);

/** How many columns the passage comes to under each of the three regimes. */
const bare = (slots: number) => planHangingMarks(shuchuShaped(1, 0, 0, 0), slots).columns.length;
/** 追い出し and no hanging — every 句読点 turned into a mark of the same line
 * break class that this walk will not hang, so what is compared is the hanging
 * and nothing else. */
const today = (seed: number, slots: number) =>
  planHangingMarks(shuchu(seed).replace(/。/g, "』"), slots).columns.length;
const hung = (seed: number, slots: number) => planHangingMarks(shuchu(seed), slots).columns.length;

/** The mean over the seeded layouts, since where the marks fall is the one
 * thing about 酒蟲 that cannot be recovered from this repository. */
const across = (of: (seed: number) => number) => {
  let sum = 0;
  for (let seed = 1; seed <= 24; seed++) sum += of(seed);
  return sum / 24;
};

/** How far the passage runs, in px: a column of this panel is 44px across
 * (`--column-pitch-kakikudashi`). */
const extent = (columns: number) => 44 * columns;

describe("the extent table", () => {
  it("reproduces the previous round's table on prose with no punctuation", () => {
    // `SHUCHU_PROSE` in kakikudashiColumnFit.test.ts, which is `ceil(line /
    // slots)` — this walk over a text with nothing in it that 禁則 touches.
    // That the two agree is what makes everything below a comparison.
    expect([3, 4, 5, 6, 10].map(bare)).toEqual([218, 164, 131, 110, 66]);
  });

  it("lands on the one column count this repository has measured", () => {
    // Ten to the column, un-hung, is what the panel was laid out at when
    // `.text-kakikudashi` (typography.css) recorded sixty-seven columns — one
    // more than the naive sixty-six, which is 追い出し spending a column.
    for (let seed = 1; seed <= 24; seed++) {
      expect(today(seed, 10)).toBeGreaterThanOrEqual(66);
      expect(today(seed, 10)).toBeLessThanOrEqual(69);
    }
    expect(across((seed) => today(seed, 10))).toBeGreaterThan(66.5);
    expect(across((seed) => today(seed, 10))).toBeLessThan(68.5);
  });

  it("buys back more than 追い出し costs, at every column length", () => {
    for (const slots of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const pushed = across((seed) => today(seed, slots));
      const hanging = across((seed) => hung(seed, slots));
      // Hanging is always the shorter passage — that is what it is for.
      expect(hanging).toBeLessThan(pushed);
      // And it more than pays for the 追い出し the brackets and small kana
      // still cost, so the passage comes out at or below the naive count
      // rather than above it.
      expect(hanging).toBeLessThanOrEqual(bare(slots) + 0.5);
      expect(pushed).toBeGreaterThan(bare(slots));
    }
  });

  it("costs under a column to leave the closing brackets to 追い出し", () => {
    // What the exclusion in `HANGING_MARKS` is worth, at the six characters to
    // the column the shipped page comes to: the same text with the brackets
    // made hangable — an upper bound, since it hangs a lone 」 as well as a
    // pair — is not one whole column shorter.
    const asShipped = across((seed) => hung(seed, 6));
    const ifBracketsHung = across(
      (seed) => planHangingMarks(shuchu(seed).replace(/」/g, "。"), 6).columns.length,
    );
    expect(asShipped - ifBracketsHung).toBeLessThan(1);
    expect(asShipped - ifBracketsHung).toBeGreaterThan(0);
  });

  it("leaves the split where it was, and improves the match it was chosen for", () => {
    // The choice at the shipped 792px viewport is between one step across the
    // rail — a kundoku passage of 55 columns, 4840px, against a prose panel
    // that holds six characters to the column — and no step, 69 columns and
    // 6072px against a panel that holds ten, whose best is five.
    //
    // The previous round measured the one-step candidate as landing on 4840
    // exactly. It did not: that was the naive count, and the browser was
    // spending columns on 追い出し and running *past* the target. Hanging takes
    // those back and lands just short of it instead — a better match than the
    // page has had, from the far side.
    const oneStepToday = Math.abs(4840 - extent(across((seed) => today(seed, 6))));
    const oneStepHung = Math.abs(4840 - extent(across((seed) => hung(seed, 6))));
    expect(oneStepHung).toBeLessThan(oneStepToday);
    expect(oneStepHung).toBeLessThan(2 * 44);

    // And the split does not move: no step, at its own best column length, is
    // still several columns further from its target than one step is from
    // its own.
    const noStepHung = Math.min(
      ...[4, 5, 6, 7, 8, 9, 10].map((slots) => Math.abs(6072 - extent(across((seed) => hung(seed, slots))))),
    );
    expect(oneStepHung).toBeLessThan(noStepHung);
    expect(noStepHung - oneStepHung).toBeGreaterThan(5 * 44);
  });
});
