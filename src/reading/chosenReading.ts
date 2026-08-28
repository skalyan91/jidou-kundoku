import type { Token } from "../parse/types.ts";
import type { ResolvedReading } from "./types.ts";

/** A reading the user picked by hand, from the furigana's right-click menu.
 *
 * Stored in the token's own `misc` map rather than in a side table keyed by
 * token, because `misc` is already part of the tree: it is serialized into
 * saved texts, written to the MISC column on CoNLL-U export, and read back
 * by the importer. A choice therefore survives saving, reopening, and a
 * round trip through a `.conllu` file with no extra plumbing — and travels
 * with the token it belongs to rather than to a position that a later edit
 * could invalidate.
 *
 * The keys are CoNLL-U MISC attributes, so they follow that column's
 * Key=Value convention and its initial-capital style. */
const READING_KEY = "Reading";
const OKURIGANA_KEY = "Okurigana";

/** The okurigana a hand-picked reading takes.
 *
 * A kun'yomi candidate brings its own, from kanjidic's okurigana-dot
 * notation. An on'yomi one has none — and a verb read on'yomi is read サ変
 * in kundoku (中 as ちゅうス, not the bare stem), so that is supplied here.
 * Without it the ending left on screen would be whatever the *previous*
 * reading inflected to, which is how choosing ちゅう over あたル first
 * produced the nonsense ちゅうル. Restricted to VERB: an on'yomi noun takes
 * no ending at all, and an adjective would need なり rather than す, which
 * the copula machinery already decides on its own evidence. */
function chosenOkurigana(token: Token): string | undefined {
  const stored = token.misc?.[OKURIGANA_KEY];
  if (stored) return stored;
  return token.pos === "VERB" ? "す" : undefined;
}

/** The hand-picked reading for `token`, or null if it has none. */
export function chosenReading(token: Token): ResolvedReading | null {
  const reading = token.misc?.[READING_KEY];
  if (reading === undefined) return null;
  return {
    reading,
    okurigana: chosenOkurigana(token),
    // Tagged "kanjidic" rather than "override": these come from the
    // kanjidic candidate list and are content-word readings that keep their
    // kanji in the kakikudashi, which is what that tag controls — not the
    // bare-kana treatment `source: "override"` gives function words.
    source: "kanjidic",
  };
}

/** Just the reading string, for the render paths that build furigana
 * directly instead of going through the resolver (the verb lexicon, and the
 * per-character fallback inside a compound). Those bypass
 * `createReadingResolver` altogether, so a hand-picked reading has to be
 * checked at each of them or it would appear to be ignored on exactly the
 * common words the lexicon exists to cover.
 *
 * Takes anything carrying a `misc` map rather than a whole `Token`, since
 * that is all it reads — `isRereadUse` asks this of the structural token
 * shape it is declared against. */
export function chosenReadingText(token: Pick<Token, "misc">): string | undefined {
  return token.misc?.[READING_KEY] || undefined;
}

/** The reading *and* its ending, for the same direct-render paths — they
 * build okurigana from the reading they picked, so a hand-picked one has to
 * bring its own or the old reading's inflection would be left behind. */
export function chosenReadingParts(token: Token): { reading: string; okurigana?: string } | null {
  const reading = chosenReadingText(token);
  return reading === undefined ? null : { reading, okurigana: chosenOkurigana(token) };
}

export function setChosenReading(token: Token, reading: string, okurigana?: string): void {
  token.misc = { ...token.misc, [READING_KEY]: reading };
  if (okurigana) token.misc[OKURIGANA_KEY] = okurigana;
  else delete token.misc[OKURIGANA_KEY];
}

/** Drops the hand-picked reading, returning the token to whatever the
 * resolver would work out on its own. */
export function clearChosenReading(token: Token): void {
  if (!token.misc) return;
  delete token.misc[READING_KEY];
  delete token.misc[OKURIGANA_KEY];
}

export function hasChosenReading(token: Token): boolean {
  return token.misc?.[READING_KEY] !== undefined;
}

/** The two keys, for the undo snapshot — which has to record them or a
 * reading choice would be the one edit Cmd+Z couldn't reach. */
export const READING_MISC_KEYS = [READING_KEY, OKURIGANA_KEY] as const;
