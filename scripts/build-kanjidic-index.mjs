#!/usr/bin/env node
// Downloads EDRDG's KANJIDIC2 and builds a compact JSON index of
// { char: { on: string[], kun: string[], meanings: string[] } } at
// public/data/kanjidic-index.json. Dev-time only; not shipped as source.
// Ships uncompressed deliberately — see src/reading/jsonIndex.ts for why.
import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL = "http://ftp.edrdg.org/pub/Nihongo/kanjidic2.xml.gz";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "kanjidic-index.json");

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const xml = gunzipSync(gz).toString("utf-8");
  console.log(`Decompressed: ${(xml.length / 1e6).toFixed(1)} MB`);

  const index = {};
  const charBlockRe = /<character>([\s\S]*?)<\/character>/g;
  let m;
  let count = 0;
  while ((m = charBlockRe.exec(xml))) {
    const block = m[1];
    const literal = /<literal>([^<]+)<\/literal>/.exec(block)?.[1];
    if (!literal) continue;
    const on = [...block.matchAll(/<reading r_type="ja_on">([^<]+)<\/reading>/g)].map((x) => x[1]);
    const kun = [...block.matchAll(/<reading r_type="ja_kun">([^<]+)<\/reading>/g)].map((x) => x[1]);
    // Plain <meaning>...</meaning> (no m_lang attribute) is the English default.
    const meanings = [...block.matchAll(/<meaning>([^<]+)<\/meaning>/g)].map((x) => x[1]).slice(0, 3);
    if (on.length === 0 && kun.length === 0) continue;
    index[literal] = { on, kun, meanings };
    count++;
  }
  console.log(`Indexed ${count} characters.`);

  const json = JSON.stringify(index);
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
