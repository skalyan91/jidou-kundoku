import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../src/i18n/en.json";
import ja from "../src/i18n/ja.json";
import { attachVerdict, cellName, type Extent, kuntenName, menuStep } from "../src/render/tokenInspector.ts";

/** The keyboard's way into the correction surface, in the parts of it that
 * are arithmetic or strings rather than focus and events — see "Keyboard and
 * screen reader" in tokenInspector.ts for the key map and the argument.
 *
 * What cannot be checked here is the focus itself (that Tab lands on a
 * character, that focus comes back after a pick): there is no browser in this
 * suite. That part was walked with real key presses on the page. */

/** A box `w` wide and `h` tall with its top-left at `left, top`. */
function box(left: number, top: number, w = 30, h = 60): Extent {
  return { left, top, right: left + w, bottom: top + h };
}

/** A vertical-rl table as the menus lay one out: `columns[i]` entries in the
 * i-th column from the right, each column 40px left of the one before, and
 * entries stacked down from the top. Document order is reading order — down
 * each column, then on to the next column leftward. */
function table(columns: number[]): Extent[] {
  const boxes: Extent[] = [];
  columns.forEach((count, c) => {
    for (let r = 0; r < count; r++) boxes.push(box(400 - c * 40, r * 70));
  });
  return boxes;
}

describe("menuStep: the arrow keys inside a menu", () => {
  const menu = table([4, 4, 2]);

  it("goes down and up in reading order, over into the next column", () => {
    expect(menuStep(menu, 0, "ArrowDown")).toBe(1);
    expect(menuStep(menu, 3, "ArrowDown")).toBe(4); // foot of column 1 → head of column 2
    expect(menuStep(menu, 4, "ArrowUp")).toBe(3);
  });

  it("wraps at both ends of the menu", () => {
    expect(menuStep(menu, menu.length - 1, "ArrowDown")).toBe(0);
    expect(menuStep(menu, 0, "ArrowUp")).toBe(menu.length - 1);
  });

  it("starts at the top when nothing in the menu has focus", () => {
    expect(menuStep(menu, -1, "ArrowDown")).toBe(0);
    expect(menuStep(menu, -1, "ArrowUp")).toBe(menu.length - 1);
  });

  it("goes across to the same height in the next column left, and back", () => {
    expect(menuStep(menu, 2, "ArrowLeft")).toBe(6); // row 3 of column 1 → row 3 of column 2
    expect(menuStep(menu, 6, "ArrowRight")).toBe(2);
  });

  it("takes the nearest entry by height where the next column is shorter", () => {
    expect(menuStep(menu, 7, "ArrowLeft")).toBe(9); // row 4 of column 2 → the last of column 3
  });

  it("stays put past either side, rather than wrapping across the table", () => {
    expect(menuStep(menu, 9, "ArrowLeft")).toBe(9);
    expect(menuStep(menu, 0, "ArrowRight")).toBe(0);
  });

  it("goes to the first and last entry on Home and End", () => {
    expect(menuStep(menu, 5, "Home")).toBe(0);
    expect(menuStep(menu, 5, "End")).toBe(menu.length - 1);
  });

  it("leaves every other key alone — Enter and Space belong to the entry", () => {
    for (const key of ["Enter", " ", "a", "Escape", "Tab"]) expect(menuStep(menu, 1, key)).toBeNull();
    expect(menuStep([], 0, "ArrowDown")).toBeNull();
  });
});

describe("what a screen reader calls a character", () => {
  it("is the character, its reading and its kaeriten, in the UI's list comma", () => {
    expect(cellName("習", "ならヒ", "㆑")).toBe("習, ならヒ, レ点");
    expect(cellName("時", "ときニ")).toBe("時, ときニ");
  });

  it("drops a part the cell does not have, separator and all", () => {
    expect(cellName("而", "")).toBe("而");
    expect(cellName("而", "", "㆒")).toBe("而, 一点");
  });

  it("names kaeriten as a reader says them", () => {
    expect(kuntenName("㆑")).toBe("レ点");
    expect(kuntenName("㆒㆑")).toBe("一レ点");
    expect(kuntenName("㆓")).toBe("二点");
    expect(kuntenName("㆖")).toBe("上点");
    expect(kuntenName("㆝")).toBe("天点");
    // The plain-numeral fallback past the Kanbun block's four is already the
    // character it stands for (`glyphsForGroup`).
    expect(kuntenName("五")).toBe("五点");
    expect(kuntenName("")).toBe("");
  });
});

describe("attachVerdict: what attach mode says about a candidate head", () => {
  // 而 (token 2 of sentence 0) hangs under 學 (token 1).
  const source = { sentence: 0, tokenId: 2, head: 1 };

  it("offers any other character of the same sentence", () => {
    expect(attachVerdict(source, { sentence: 0, tokenId: 3 })).toBe("ok");
  });

  it("says when the candidate is already the head, so Enter would change nothing", () => {
    expect(attachVerdict(source, { sentence: 0, tokenId: 1 })).toBe("current");
  });

  it("refuses the character itself, any cell of it", () => {
    expect(attachVerdict(source, { sentence: 0, tokenId: 2 })).toBe("self");
  });

  it("refuses a character in another sentence, even one with the head's id", () => {
    expect(attachVerdict(source, { sentence: 1, tokenId: 1 })).toBe("otherSentence");
    expect(attachVerdict(source, { sentence: 1, tokenId: 2 })).toBe("otherSentence");
  });

  it("offers every character to a root, whose head is itself", () => {
    const root = { sentence: 0, tokenId: 5, head: 5 };
    expect(attachVerdict(root, { sentence: 0, tokenId: 1 })).toBe("ok");
    expect(attachVerdict(root, { sentence: 0, tokenId: 5 })).toBe("self");
  });
});

describe("every string the keyboard path says is in both languages", () => {
  const keys = Object.keys(en).filter((key) => /^(inspector|field|announce)\./.test(key));

  it("has the strings it uses", () => {
    const source = readFileSync(new URL("../src/render/tokenInspector.ts", import.meta.url), "utf8");
    const used = [...source.matchAll(/"((?:inspector|field|announce)\.[A-Za-z.]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const key of used) expect(keys, key).toContain(key);
  });

  it("has every one of them in Japanese too, with the same placeholders", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of keys) {
      const jaValue = (ja as Record<string, string>)[key];
      expect(jaValue, key).toBeTruthy();
      expect(placeholders(jaValue), key).toEqual(placeholders((en as Record<string, string>)[key]));
    }
  });
});
