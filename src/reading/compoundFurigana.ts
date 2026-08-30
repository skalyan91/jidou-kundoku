import { lookupLemma, type JmdictIndex } from "./jmdictLookup.ts";
import { lookupKanji, type KanjidicIndex } from "./kanjidicLookup.ts";
import { fullSizeKana, type HistoricalKanaIndex } from "./historicalKana.ts";
import { splitCompoundReading } from "./compoundReading.ts";

/** One character's reading in 歴史的仮名遣い.
 *
 * Every route out of `compoundFurigana` passes through here, which is the
 * whole point of that function taking the index at all. Both of the readings
 * it produces are modern: JMdict's compound reading is a modern Japanese
 * word's, and `lookupKanji` hands back KANJIDIC's own. The per-token path
 * applies the correction in `readingResolver.ts` and this one did not, so a
 * character inside a compound reached the page in modern kana while the same
 * character outside one did not — 黃帝者、少典之子也。 printed 黃 as こう and
 * 少 as しょう with くわう and せう sitting in the index for exactly those
 * readings. Applied per character against that character's own reading, which
 * is how the index is keyed. */
export function historical(char: string, reading: string | undefined, historicalKana: HistoricalKanaIndex | null): string | undefined {
  if (reading === undefined) return undefined;
  if (!historicalKana) return reading;
  // Falling back to the full-size fold where the index abstains, exactly as
  // the per-character paths in `kanjidicLookup.ts` do. This was left off when
  // the index lookup was added here, on the grounds that a compound's pieces
  // may be on'yomi and the fold was unsafe for those; the fold's own before-う
  // guard is what settles that, and it now applies to on'yomi throughout. So
  // 叔向 gives しゆく where it gave しゅく, while a fused long vowel (きよう
  // against きやう against けう) stays untouched in either series.
  return historicalKana[char]?.[reading] ?? fullSizeKana(reading);
}

/** A compound's furigana, one string per character: the whole compound's
 * own combined JMdict reading (e.g. くんし for 君子 — a real dictionary
 * word's actual pronunciation, not each character read in isolation, which
 * can differ; 子 alone defaults to し but so does 君子's own 子 here, and a
 * less predictable compound could easily diverge) split across its
 * characters via `splitCompoundReading`. Falls back to each character's own
 * independently-resolved reading (the caller's `fallback`) when there's no
 * JMdict entry for the whole compound, or the split can't fully account for
 * the reading — a forced/partial split would risk showing a wrong reading
 * with unwarranted confidence.
 *
 * Lives in the reading layer rather than in `KundokuView.ts`, where it was
 * written, because both panels answer to it now: the 書き下し文 panel glosses
 * a word's first mention with the same ruby the 訓読文 puts over the same
 * characters (see `rubyGloss.ts`), and two panels showing two different
 * readings of one word is exactly the divergence a shared function prevents. */
export function compoundFurigana(
  chars: string[],
  combinedText: string,
  jmdict: JmdictIndex | null,
  kanjidic: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
  fallback: (charIndex: number) => string | undefined,
): (string | undefined)[] {
  if (jmdict && kanjidic) {
    const hit = lookupLemma(jmdict, combinedText);
    if (hit) {
      const split = splitCompoundReading(chars, hit.reading, kanjidic);
      if (split) return split.map((r, i) => historical(chars[i], r, historicalKana));
    }
  }
  if (kanjidic) {
    // A fused compound (drawn with its own connecting line) that JMdict
    // doesn't list as a single entry is virtually always a jukugo —
    // a name, title, or technical term read on'yomi straight through, not
    // each member's own independently-chosen kun'yomi/on'yomi. Forced here
    // by passing "PROPN" to `lookupKanji` regardless of the member's own
    // (possibly wrong) POS tag — the same lever that already selects
    // on'yomi for a genuine proper noun — deliberately unconditional, not
    // limited to spans whose members happen to be tagged PROPN: 黄帝 ("the
    // Yellow Emperor") parses as VERB+NOUN in a mistagged comp:obj relation
    // (this app's compound-span detection also fuses attributive `mod`
    // pairs, not just genuine `compound`/`flat` relations — see
    // `findCompoundSpans`), and per-member kun'yomi there gave a nonsense
    // reading (きみかど) no real jukugo compound ever takes. Falls back to
    // the caller's own per-token resolution only if a character isn't in
    // kanjidic at all.
    return chars.map((ch, i) => historical(ch, lookupKanji(kanjidic, ch, "PROPN")?.reading, historicalKana) ?? fallback(i));
  }
  return chars.map((_, i) => fallback(i));
}
