import overridesData from "./overrides.json";

export interface OverrideEntry {
  char: string;
  contextDep?: string[];
  contextPos?: string[];
  reading: string;
  okurigana?: string;
  gloss?: string;
  /** Set on an entry that must outrank `verbLexicon.ts` for the same
   * character (it becomes the resolved reading's `beatsLexicon` — see
   * `ResolvedReading`).
   *
   * Both panels consult the lexicon ahead of the resolver for any token
   * tagged VERB/AUX, so an entry conditioned on a POS the lexicon does not
   * claim needs nothing here — that is how 遂 reads つひに as an adverb while
   * a VERB-tagged 遂 goes on conjugating as とぐ, and it is why almost every
   * adverb in this table is written `contextPos: ["ADV"]`. The flag is for
   * the entry whose word *is* tagged VERB in the role it is claiming: 果 in
   * 果然 comes back VERB/mod, and the lexicon's 果たす — the right word in the
   * wrong form — beat the adverb はたして to it.
   *
   * Opt-in per entry rather than inferred from the entry having a
   * `contextDep`, which would fit 果 and would also silently move 使 and 為 —
   * two entries whose lexicon senses are live in real parses and which
   * nothing here has measured. */
  beatsLexicon?: boolean;
}

const overrides = overridesData as OverrideEntry[];

const byChar = new Map<string, OverrideEntry[]>();
for (const entry of overrides) {
  if (!byChar.has(entry.char)) byChar.set(entry.char, []);
  byChar.get(entry.char)!.push(entry);
}

/** Finds the curated kundoku-specific reading for `text` (a token's surface
 * text, or a fused compound span's concatenated text), given its POS/dep
 * context. An entry whose `contextDep`/`contextPos` is present but doesn't
 * include the given value is excluded outright (it's context-*restricted*,
 * not just a preference); among the remaining candidates, the most specific
 * one wins: char+dep+pos > char+pos-or-dep > char-only. */
export function findOverride(text: string, pos?: string, dep?: string): OverrideEntry | null {
  const candidates = byChar.get(text);
  if (!candidates) return null;

  let best: OverrideEntry | null = null;
  let bestScore = -1;
  for (const entry of candidates) {
    if (entry.contextDep && (!dep || !entry.contextDep.includes(dep))) continue;
    if (entry.contextPos && (!pos || !entry.contextPos.includes(pos))) continue;
    const score = (entry.contextDep ? 2 : 0) + (entry.contextPos ? 1 : 0);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}
