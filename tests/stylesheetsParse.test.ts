import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// **Every stylesheet this app ships has to parse.**
//
// This file exists because the suite was entirely green — 102 files, 2,739
// tests — while `src/app.css` could not be parsed at all, and the reader found
// out by opening the app and getting a Vite build failure:
//
//     [plugin:vite:css] [postcss] src/app.css:2471:15: Unknown word the
//
// A block comment had been closed by a stray `*/` in the middle of its own
// prose, so the paragraph after it was read as declarations. Nothing in the
// suite could see that, and the reason is worth writing down: **every CSS test
// in this repo reads the stylesheets as text.** `customProperties.test.ts`
// matches declarations with a regex, `rimeLayout.test.ts` pulls a block out
// with another, `helpFigureFit.test.ts` reads numbers back out of the source.
// A regex over a broken stylesheet matches exactly as well as over a sound one
// — the text of a rule is still there, it is simply no longer inside a comment
// — so all of them went on passing and reporting numbers about a file the
// browser rejects.
//
// So the check here is the one thing none of those do: hand the file to the
// same parser the build uses and see whether it comes back. It is deliberately
// the *only* thing this file asserts. What a rule means is every other CSS
// test's business; whether the file is a stylesheet at all is this one's.
// ---------------------------------------------------------------------------

const SRC = join(import.meta.dirname, "..", "src");

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

const sheets = stylesheets(SRC);

describe("every stylesheet parses", () => {
  it("finds the stylesheets it is meant to be guarding", () => {
    // The guard's own guard, as in `customProperties.test.ts`: a walk that
    // stopped finding files would make the loop below vacuous, and a vacuous
    // pass looks exactly like a real one — which is the shape of the bug this
    // file exists for in the first place.
    expect(sheets.length).toBeGreaterThan(3);
    expect(sheets.some((path) => path.endsWith("app.css"))).toBe(true);
  });

  for (const path of sheets) {
    it(`parses ${path.slice(SRC.length + 1)}`, () => {
      const css = readFileSync(path, "utf-8");
      // `from` so that a failure names the file and the line, the way the Vite
      // error did — the message is the whole value of this test.
      expect(() => postcss.parse(css, { from: path })).not.toThrow();
    });
  }
});
