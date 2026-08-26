#!/usr/bin/env node
// Downloads EDRDG's JMdict and builds a compact JSON index of
// { lemma: { reading: string, gloss: string[], pos: string[], common: bool } }
// at public/data/jmdict-index.json, keyed by kanji headword (keb).
// Only the most-common entry per headword is kept. Dev-time only; not shipped
// as source. Ships uncompressed deliberately — see src/reading/jsonIndex.ts.
import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE_URL = "http://ftp.edrdg.org/pub/Nihongo/JMdict.gz";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data", "jmdict-index.json");

const PRIORITY_RE = /^(news1|ichi1|spec1|spec2|gai1)$/;

function isCommon(block) {
  const tags = [...block.matchAll(/<(?:ke_pri|re_pri)>([^<]+)<\/(?:ke_pri|re_pri)>/g)].map((x) => x[1]);
  return tags.some((t) => PRIORITY_RE.test(t));
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const xml = gunzipSync(gz).toString("utf-8");
  console.log(`Decompressed: ${(xml.length / 1e6).toFixed(1)} MB`);

  // Resolve JMdict's DTD-defined entities (&n; &v5r; &prt; ...) to short
  // human-readable POS labels.
  const entityMap = new Map();
  for (const em of xml.matchAll(/<!ENTITY\s+(\S+)\s+"([^"]*)">/g)) {
    entityMap.set(em[1], em[2]);
  }
  const resolveTag = (raw) => {
    const code = raw.replace(/^&|;$/g, "");
    return entityMap.get(code) ?? code;
  };

  const index = {};
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  let entryCount = 0;
  let headwordCount = 0;
  while ((m = entryRe.exec(xml))) {
    const block = m[1];
    const kebs = [...block.matchAll(/<keb>([^<]+)<\/keb>/g)].map((x) => x[1]);
    if (kebs.length === 0) continue; // reading-only entry, not usable for kanji-span lookup
    entryCount++;

    const rebMatch = /<reb>([^<]+)<\/reb>/.exec(block);
    const reading = rebMatch ? rebMatch[1] : "";

    const firstSenseMatch = /<sense>([\s\S]*?)<\/sense>/.exec(block);
    const senseBlock = firstSenseMatch ? firstSenseMatch[1] : "";
    const pos = [...senseBlock.matchAll(/<pos>([^<]+)<\/pos>/g)].map((x) => resolveTag(x[1]));
    // Default (English) glosses have no xml:lang attribute.
    const gloss = [...senseBlock.matchAll(/<gloss(?![^>]*xml:lang)[^>]*>([^<]*)<\/gloss>/g)]
      .map((x) => x[1])
      .slice(0, 3);

    const common = isCommon(block);
    const entry = { reading, gloss, pos, common };

    for (const keb of kebs) {
      const existing = index[keb];
      if (!existing || (!existing.common && common)) {
        index[keb] = entry;
        headwordCount++;
      }
    }
  }
  console.log(`Scanned ${entryCount} entries, indexed ${headwordCount} unique kanji headwords.`);

  const json = JSON.stringify(index);
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
