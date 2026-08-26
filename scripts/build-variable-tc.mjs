#!/usr/bin/env node
// Dev-time asset build: turns the *variable* Noto Serif TC (one `wght` axis,
// 200-900) into the same per-unicode-range woff2 subsets that
// scripts/fetch-fonts.mjs produces for the static families, and rewrites the
// Noto Serif TC half of src/render/fonts.css to point at them.
//
// Why not just fetch it from Google Fonts like the others: their CSS2 API
// refuses a `wght@200..900` range request for Noto Serif JP/TC ("400:
// Invalid selector") — it only serves discrete static instances for these
// families. A static instance has no axis, so `font-weight` can only snap
// between the weights on offer, never interpolate. The variable build lives
// in the google/fonts repo instead, as a single 17MB TTF.
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

const FAMILY = "Noto Serif TC";
const SLUG = "noto-serif-tc";
const VF_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf";
const OUT_FONT_DIR = path.resolve(`public/fonts/${SLUG}`);
const CSS_PATH = path.resolve("src/render/fonts.css");
const TMP_VF = path.resolve("node_modules/.cache/NotoSerifTC-VF.ttf");

/** The unicode-ranges Google already split this family into — reused rather
 * than invented, so the subsets line up with how the font was designed to be
 * chunked. Read back out of the generated CSS, taking each range once (it
 * repeats per static weight there). */
async function rangesFromCss(css) {
  const ranges = [];
  const seen = new Set();
  const blockRe = /@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = blockRe.exec(css))) {
    const block = m[1];
    if (!block.includes(`font-family: "${FAMILY}"`)) continue;
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

async function main() {
  await mkdir(OUT_FONT_DIR, { recursive: true });
  await mkdir(path.dirname(TMP_VF), { recursive: true });

  const css = await readFile(CSS_PATH, "utf8");
  const ranges = await rangesFromCss(css);
  if (ranges.length === 0) throw new Error(`No "${FAMILY}" @font-face blocks found in ${CSS_PATH}`);
  console.log(`${ranges.length} unicode ranges to subset.`);

  console.log("Downloading the variable font…");
  const res = await fetch(VF_URL);
  if (!res.ok) throw new Error(`Variable font fetch failed: ${res.status}`);
  await writeFile(TMP_VF, Buffer.from(await res.arrayBuffer()));

  // Drop the old static per-weight files for this family; the variable
  // subsets replace all of them.
  for (const stale of (await import("node:fs")).readdirSync(OUT_FONT_DIR)) {
    await rm(path.join(OUT_FONT_DIR, stale));
  }

  const faces = [];
  for (const [i, range] of ranges.entries()) {
    const filename = `${SLUG}-vf-${i + 1}.woff2`;
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
    block.includes(`font-family: "${FAMILY}"`) ? "" : block,
  );
  const added = faces
    .map(({ filename, range }) =>
      [
        "@font-face {",
        `  font-family: "${FAMILY}";`,
        "  font-style: normal;",
        // A *range*, which is what tells the browser this face is variable
        // and that any weight in between is reachable by interpolation.
        "  font-weight: 200 900;",
        "  font-display: swap;",
        `  src: url("/fonts/${SLUG}/${filename}") format("woff2-variations");`,
        `  unicode-range: ${range};`,
        "}",
        "",
      ].join("\n"),
    )
    .join("\n");

  await writeFile(CSS_PATH, `${kept.trimEnd()}\n\n${added}`);
  console.log(`Wrote ${faces.length} variable subsets and updated ${CSS_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
