#!/usr/bin/env node
// Dev-time asset build: turns a *variable* Noto Serif CJK family (one `wght`
// axis, 200-900) into the same per-unicode-range woff2 subsets that
// scripts/fetch-fonts.mjs produces for the static families, and rewrites
// that family's half of src/render/fonts.css to point at them.
//
// Usage: `node scripts/build-variable-cjk.mjs [jp|tc]` (default: both).
//
// Why not just fetch it from Google Fonts like the others: their CSS2 API
// refuses a `wght@200..900` range request for Noto Serif JP/TC ("400:
// Invalid selector") — it only serves discrete static instances for these
// families. A static instance has no axis, so `font-weight` can only snap
// between the weights on offer, never interpolate. The variable build lives
// in the google/fonts repo instead, as a single 17MB TTF.
//
// Why both families need it, not just the TC one this script started as:
// the type scale in typography.css assigns each tier a weight off a
// continuous curve (720 for the annotation tiers, 440 for the kakikudashi),
// and against a static ladder of 300/400/500/600/700/900 those land nowhere
// near themselves. CSS weight matching above 500 takes the nearest face
// *upwards*, so every annotation weight from 701 to 900 collapsed onto the
// 900 face: the curve was real in the stylesheet and flat on the screen,
// and a selected reading asking for more weight than an unselected one got
// exactly the same glyph. Measured, before this: ink coverage of ま at
// 720/800/900 was identical to three figures.
//
// Why subset it rather than ship that one file: the whole point of the
// existing setup is that a page downloads only the few KB of glyph ranges it
// actually uses. Serving one monolithic variable font would trade ~10MB of
// eager download for the animation. Subsetting keeps both — pyftsubset
// preserves the `fvar` axis in each subset, so every range is still
// variable.
//
// Requires fonttools + brotli (dev-only). Invoked as `python3 -m
// fontTools.subset` rather than the `pyftsubset` console script, which
// isn't on PATH under a PEP 668 "externally managed" Python even when
// fonttools itself is importable.
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

const CSS_PATH = path.resolve("src/render/fonts.css");

const VARIABLE_FAMILIES = {
  jp: {
    family: "Noto Serif JP",
    slug: "noto-serif-jp",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifjp/NotoSerifJP%5Bwght%5D.ttf",
  },
  tc: {
    family: "Noto Serif TC",
    slug: "noto-serif-tc",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf",
  },
};

/** The unicode-ranges Google already split this family into — reused rather
 * than invented, so the subsets line up with how the font was designed to be
 * chunked. Read back out of the generated CSS, taking each range once (it
 * repeats per static weight there). */
async function rangesFromCss(css, family) {
  const ranges = [];
  const seen = new Set();
  const blockRe = /@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = blockRe.exec(css))) {
    const block = m[1];
    if (!block.includes(`font-family: "${family}"`)) continue;
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]?.trim();
    if (range && !seen.has(range)) {
      seen.add(range);
      ranges.push(range);
    }
  }
  return ranges;
}

/** `pyftsubset` wants bare codepoints/ranges (`4E00-9FFF`), not the CSS
 * `U+` spelling, and treats `,` as a separator. */
function toSubsetArg(cssRange) {
  return cssRange
    .split(",")
    .map((part) => part.trim().replace(/^U\+/i, ""))
    .join(",");
}

async function buildFamily({ family, slug, url }) {
  const OUT_FONT_DIR = path.resolve(`public/fonts/${slug}`);
  const TMP_VF = path.resolve(`node_modules/.cache/${slug}-VF.ttf`);
  console.log(`\n=== ${family} ===`);
  await mkdir(OUT_FONT_DIR, { recursive: true });
  await mkdir(path.dirname(TMP_VF), { recursive: true });

  const css = await readFile(CSS_PATH, "utf8");
  const ranges = await rangesFromCss(css, family);
  if (ranges.length === 0) throw new Error(`No "${family}" @font-face blocks found in ${CSS_PATH}`);
  console.log(`${ranges.length} unicode ranges to subset.`);

  console.log("Downloading the variable font…");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Variable font fetch failed: ${res.status}`);
  await writeFile(TMP_VF, Buffer.from(await res.arrayBuffer()));

  // Drop the old static per-weight files for this family; the variable
  // subsets replace all of them.
  for (const stale of (await import("node:fs")).readdirSync(OUT_FONT_DIR)) {
    await rm(path.join(OUT_FONT_DIR, stale));
  }

  const faces = [];
  for (const [i, range] of ranges.entries()) {
    const filename = `${slug}-vf-${i + 1}.woff2`;
    await run("python3", [
      "-m",
      "fontTools.subset",
      TMP_VF,
      `--unicodes=${toSubsetArg(range)}`,
      "--flavor=woff2",
      `--output-file=${path.join(OUT_FONT_DIR, filename)}`,
      // Keep the axis: without this pyftsubset would instantiate a static
      // default instance and the whole exercise would be pointless.
      "--layout-features=*",
      "--no-hinting",
      "--desubroutinize",
      "--drop-tables+=DSIG",
    ]);
    faces.push({ filename, range });
    if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${ranges.length}`);
  }

  // Swap this family's blocks in the generated CSS for the variable ones,
  // leaving the other family's blocks untouched.
  const kept = css.replace(/@font-face\s*{[^}]*}\n?\n?/g, (block) =>
    block.includes(`font-family: "${family}"`) ? "" : block,
  );
  const added = faces
    .map(({ filename, range }) =>
      [
        "@font-face {",
        `  font-family: "${family}";`,
        "  font-style: normal;",
        // A *range*, which is what tells the browser this face is variable
        // and that any weight in between is reachable by interpolation.
        "  font-weight: 200 900;",
        "  font-display: swap;",
        `  src: url("/fonts/${slug}/${filename}") format("woff2-variations");`,
        `  unicode-range: ${range};`,
        "}",
        "",
      ].join("\n"),
    )
    .join("\n");

  await writeFile(CSS_PATH, `${kept.trimEnd()}\n\n${added}`);
  console.log(`Wrote ${faces.length} variable subsets and updated ${CSS_PATH}`);
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const keys = requested.length > 0 ? requested : Object.keys(VARIABLE_FAMILIES);
  for (const key of keys) {
    const spec = VARIABLE_FAMILIES[key];
    if (!spec) throw new Error(`Unknown family "${key}" — expected one of: ${Object.keys(VARIABLE_FAMILIES).join(", ")}`);
    await buildFamily(spec);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
