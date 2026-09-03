import { describe, expect, it } from "vitest";
import { clearKakikudashiView } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// What closing a document takes off the page.
//
// The 書き下し文 panel is hidden whenever there is nothing to put in it — a
// cold load, a `clearAll`, a parse that came back with no sentences — and
// `main.ts` empties it through this function on the way. Emptying it is the
// small half of the job. The fit writes *outside* the panel as well as inside
// it: an inline height and a fitted tracking on the panel's own box, and
// `--kundoku-extra-slots` on the `.main` grid above, which is the division of
// one shared height between the two panels. That last one is the one that
// would still be doing something after the text was gone — lengthening the
// kundoku column by whole characters on account of prose no longer there.
//
// So what is checked here is that all three come off, and the numbers they
// were set to are irrelevant to the check: any survivor is a stale one.
//
// A hand-built stand-in rather than a DOM, in the manner of
// `scrollSync.test.ts` and for the same reason — the tests run in node, and
// this function touches exactly four things (`replaceChildren`, two style
// declarations, and `closest`). What cannot be checked here is that
// `.main` is really the box the split is written on, which is a claim about
// the markup `main.ts` builds.
// ---------------------------------------------------------------------------

/** The two calls this function makes on a style declaration, and the one
 * plain declaration it removes. `height` is a field rather than an entry in
 * the map because that is what it is on a real `CSSStyleDeclaration` — set as
 * `style.height = …` by `setColumnSlots` and taken off by name here, which is
 * why `removeProperty` has to reach it as well as the custom properties. */
function fakeStyle() {
  const props = new Map<string, string>();
  const style = {
    props,
    height: "",
    setProperty(name: string, value: string) {
      props.set(name, value);
    },
    removeProperty(name: string) {
      if (name === "height") style.height = "";
      props.delete(name);
    },
  };
  return style;
}

function fakePanel() {
  const main = { style: fakeStyle() };
  const container = {
    children: 3,
    style: fakeStyle(),
    replaceChildren() {
      container.children = 0;
    },
    closest(selector: string) {
      return selector === ".main" ? main : null;
    },
  };
  return { container, main };
}

describe("clearing the 書き下し文 panel", () => {
  it("takes the split off the grid the two panels share", () => {
    const { container, main } = fakePanel();
    main.style.setProperty("--kundoku-extra-slots", "1");

    clearKakikudashiView(container as unknown as HTMLElement);

    expect(main.style.props.has("--kundoku-extra-slots")).toBe(false);
  });

  it("takes the fitted column height and tracking off the panel's own box", () => {
    const { container } = fakePanel();
    container.style.height = "248.6px";
    container.style.setProperty("--tracking-kakikudashi", "2.81px");

    clearKakikudashiView(container as unknown as HTMLElement);

    expect(container.style.props.has("--tracking-kakikudashi")).toBe(false);
    expect(container.style.height).toBe("");
  });

  it("empties the panel", () => {
    const { container } = fakePanel();
    clearKakikudashiView(container as unknown as HTMLElement);
    expect(container.children).toBe(0);
  });

  it("is content with no grid above it — a print band, or a fixture", () => {
    const container = {
      style: fakeStyle(),
      replaceChildren() {},
      closest: () => null,
    };
    expect(() => clearKakikudashiView(container as unknown as HTMLElement)).not.toThrow();
  });
});
