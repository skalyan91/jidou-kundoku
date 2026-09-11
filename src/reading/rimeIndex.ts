import { loadJsonIndex } from "./jsonIndex.ts";

/** The 廣韻's rime categories, per character — what a line of verse is
 * annotated with in the 訓読文 panel.
 *
 * Built by `scripts/build-rime-index.py` out of nk2028's `qieyun` package, the
 * same source `scripts/derive-onyomi-kana.py` takes its 音韻地位 from; see that
 * script's docstring for what a character's entry is and why it is the 韻目
 * (侵, 沁, 德) rather than the tone-normalised 韻 (侵, 侵, 登). Licence:
 * `public/data/LICENSE-Qieyun.txt`.
 *
 * **Shipped rather than computed**, for `historical-kana-index.json`'s reason:
 * there is no server, and a reader who has never installed a Python package
 * still gets the annotation.
 *
 * The shape is three tables and not one map of objects, and the reason for
 * the first two is size. A 韻目 fixes its own 聲 and its own 卷 — 侵 is 平聲
 * and 卷二, always, which the build asserts over all 206 of them rather than
 * assuming — so those two facts are stated 206 times in `rimes` instead of
 * 25,320 times beside every character, and a character's own entry is the
 * bare string of its 韻目 characters. ~256 KiB for 19,499 characters.
 *
 * The third, `posRime`, is smaller for a different reason: it is not derived
 * from the 廣韻 wholesale, it is copied out of `scripts/build-rime-index.py`'s
 * own `POS_RESOLVED_RIME`, a hand-curated table of 21 characters whose two
 * 音韻地位 divide along a real part-of-speech line — see that table's own
 * docstring for what admits an entry and what was checked and refused. */
export interface RimeIndex {
  /** 韻目 -> its 聲 and the 卷 of the 廣韻 it stands in. 206 entries, in the
   * book's own order (卷, then page of the page-image the build read). */
  rimes: Record<string, { tone: string; volume: string }>;
  /** Character -> its 韻目, concatenated, in the book's order. One character
   * per 韻目; 深 is `"侵沁"`, 心 is `"侵"`. **Every** 音韻地位 the 廣韻 gives is
   * here and none is preferred — see `rimesOf`. */
  chars: Record<string, string>;
  /** Character -> UPOS -> the 韻目 that part of speech resolves it to, for
   * the 21 characters `POS_RESOLVED_RIME` curates. Consulted by `rimeForPos`
   * below, and by nothing else — see that function for how a caller uses it
   * and `rimeAnnotation.ts`'s own note for where in a line it applies. */
  posRime: Record<string, Record<string, string>>;
}

/** The 韻目 the 廣韻 gives this character, in the book's order — empty for a
 * character it does not hold (which includes every kana, every 踊り字 and a
 * good many 異体字).
 *
 * **A list and not a value, deliberately.** 4,044 of the index's 19,499
 * characters have more than one, and which one a character has in a particular
 * line is a fact about the line rather than about the character: 深 is 侵 in
 * 城春草木深 and 沁 in a line that rhymes 去聲. A caller that wants one has to
 * say what evidence picks it — `poemRhyme` below is the only thing in this app
 * that can. */
export function rimesOf(index: RimeIndex, char: string): string[] {
  const entry = index.chars[char];
  return entry ? [...entry] : [];
}

/** The 韻目 a character's own part of speech resolves it to, where
 * `POS_RESOLVED_RIME` curates one — `undefined` for every other character,
 * and for a UPOS the table does not name even where the character is in it
 * (在 tagged `PROPN`, say, which is not a reading anyone gave it).
 *
 * **Answers a 韻目 and not a filtered list**, unlike `rimesOf`, because a
 * curated entry is by construction a single decision: `POS_RESOLVED_RIME`'s
 * own build-time check requires its two values to be exactly the character's
 * two 音韻地位, so there is never a third candidate left over to represent. A
 * caller with a list to narrow — `rimeGlossForLine` — narrows it to this one
 * value; nothing here decides what "narrow" means for the caller's own data,
 * only what the table says for this character and this UPOS. */
export function rimeForPos(index: RimeIndex, char: string, upos: string | undefined): string | undefined {
  if (upos === undefined) return undefined;
  return index.posRime[char]?.[upos];
}

/** How a 韻目 is named in full: 下平聲侵韻, 去聲代韻, 入聲德韻. The form
 * kanbun.info's own rime notes use (「五言律詩。深・心・金・簪（下平声侵韻）。」).
 *
 * **This is the annotation's `title` and never its page label.** A 割注 holds
 * four half-size glyphs and these names are 4 or 5, so `rimeLabel` in
 * `rimeAnnotation.ts` builds a 2- or 4-character label for the page out of the
 * 韻目 alone and leaves the 聲 here — where a hover, a screen reader and anything
 * else reading the page out can still reach it, and where a label that counts
 * rimes rather than naming them (三韻) still names every one of them. That file's
 * own note has the reasoning and the measurements.
 *
 * Returns the bare 韻目 for one the table does not hold, rather than nothing: a
 * name is better than a blank. */
export function rimeFullName(index: RimeIndex, rime: string): string {
  const row = index.rimes[rime];
  return row ? `${row.volume}${rime}韻` : rime;
}

let cached: Promise<RimeIndex> | null = null;

export function loadRimeIndex(url = "/data/rime-index.json"): Promise<RimeIndex> {
  if (!cached) cached = loadJsonIndex<RimeIndex>(url);
  return cached;
}

/** Dropped so a test can load a second one. Beside `resetReadingTable` in
 * `historicalKana.ts`, and there for the same reason. */
export function resetRimeIndex(): void {
  cached = null;
}
