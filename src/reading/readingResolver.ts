import type { Sentence, Token } from "../parse/types.ts";
import type { ReadingResolver, ResolvedReading } from "./types.ts";
import { findOverride } from "./overridesLookup.ts";
import { type KanjidicIndex, lookupKanji } from "./kanjidicLookup.ts";
import { type JmdictIndex, lookupLemma } from "./jmdictLookup.ts";
import type { HistoricalKanaIndex } from "./historicalKana.ts";
import { parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import { classicalAdjectiveRootReading, isNominalizedFaultNoun, isTopicalizedAdjective } from "../kakikudashi/conjugationContext.ts";

/** KANJIDIC2's kun'yomi are modern dictionary readings verbatim (e.g.
 * "たか.い", okurigana "い") — this project's whole scope is classical
 * (bungo), not modern, Japanese, and a modern い-adjective needs a real
 * classical ending instead: 終止形 (shuushikei) し (高い -> 高し, 楽しい ->
 * 楽し — both the く and しく katsuyō shuushikei end in し, never い), or
 * 連体形 (rentaikei) き/しき for a topicalized adjective (敦い -> 敦き — see
 * `isTopicalizedAdjective`). Only called once `isAdjective` (Degree=Pos on
 * the token itself, or `isTopicalizedAdjective`) has already confirmed this
 * word is being used adjectivally — that's what makes it safe to also
 * handle kanjidic entries that omit the usual okurigana dot for an
 * inflecting reading (敏's kun is bare "さとい", not "さと.い" the way 聰's
 * "さと.い" is): with no dot to trust, splitting off a trailing い is only
 * reliable because the morph feature, not the string shape, is what
 * identifies this as an adjective in the first place.
 *
 * Only converts the mechanically unambiguous cases — an "い"/no-dot okurigana
 * ending the reading, or one ending "しい" — and otherwise leaves the
 * reading/okurigana untouched: some modern い-adjectives (大きい, "big")
 * descend from a classical なり-adjective instead (大きなり, not a
 * く/しく-adjective 大きし at all), and the surface form alone can't tell
 * those apart, so guessing there would trade one wrong ending for another
 * rather than fix it. */
function classicalAdjectiveReading(
  reading: string,
  okurigana: string | undefined,
  form: "shuushi" | "rentai" = "shuushi",
): { reading: string; okurigana: string | undefined } {
  if (okurigana) {
    if (!okurigana.endsWith("い")) return { reading, okurigana };
    if (form === "rentai") return { reading, okurigana: okurigana.slice(0, -1) + "き" };
    return { reading, okurigana: okurigana.endsWith("しい") ? okurigana.slice(0, -1) : "し" };
  }
  if (!reading.endsWith("い") || reading.length < 2) return { reading, okurigana };
  const trimmed = reading.slice(0, -1); // drop the trailing い
  if (form === "rentai") {
    // Rentaikei always just tacks き on after the stem, whether しく-type
    // (あつ+き=あつき) or く-type (たのし+き=たのしき) — unlike shuushikei
    // below, no further care is needed here.
    return { reading: trimmed, okurigana: "き" };
  }
  // Shuushikei: a しく-type stem (たのし) already *is* the complete
  // shuushikei ending with nothing left to append; a く-type stem (あつ)
  // still needs its own し appended.
  return trimmed.endsWith("し") ? { reading: trimmed.slice(0, -1), okurigana: "し" } : { reading: trimmed, okurigana: "し" };
}

/** Relations marking a token as part of a multi-character fused span (see
 * `findCompoundSpans` in jmdictLookup.ts for full span detection). This
 * per-token resolver only attempts a jmdict lookup on the token's own
 * (possibly already multi-character) lemma when it carries one of these
 * relations — resolving a whole span as a single fused reading/furigana
 * unit spanning several *tokens* is the render layer's job, done by calling
 * `findCompoundSpans` + `lookupLemma(index, span.text)` directly, not
 * through this per-token resolver. */
const SPAN_DEPS = new Set(["compound", "compound@redup", "flat", "flat@vv", "flat@foreign"]);

/** Tokens resolved to nothing, keyed by "text:pos:dep", with an occurrence
 * count — a running "gaps" report for prioritizing future override-table
 * additions. Exported directly rather than via a callback since callers
 * (dev tooling, a console warning list) just want to inspect it after a
 * batch of resolutions. */
export const unresolvedLog = new Map<string, number>();

function logUnresolved(token: Token): void {
  const key = `${token.text}:${token.pos}:${token.dep}`;
  unresolvedLog.set(key, (unresolvedLog.get(key) ?? 0) + 1);
}

/** 者 reads は (topic marker) when it follows — is modified (`mod`) by — a
 * bare noun or name (孔子者 -> 孔子は, "as for Confucius..."), but もの
 * (nominalizer, "the one who...") when modified by a verb (知者 -> 知る者,
 * "one who knows"; 仁者 -> 仁なる者, since this parser tags a stative
 * predicate like 仁/賢 VERB with Degree=Pos, not NOUN, when it's used
 * predicatively like this). 者's own (pos, dep) can't distinguish these —
 * it's always tagged PART/subj or PART/comp:obj either way — so this reads
 * its *modifier's* POS instead, the one token in the sentence with
 * `head === token.id && dep === "mod"`. Returns undefined (falls through to
 * the catch-all もの override) for anything else modifying 者, or for 者
 * with no modifier at all (bare 者 as a stand-alone pronoun-like "someone"). */
function zheTopicReading(token: Token, sentence: Sentence | { tokens: Token[] }): "は" | undefined {
  if (token.text !== "者") return undefined;
  const modifier = sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && t.dep === "mod");
  if (modifier && (modifier.pos === "NOUN" || modifier.pos === "PROPN")) return "は";
  return undefined;
}

/** Builds a `ReadingResolver` (see `./types.ts`) implementing the plan's
 * resolution order: curated overrides -> KANJIDIC2 (+ historical-kana
 * substitution) -> JMdict -> unresolved.
 *
 * `historicalKana` (optional — omit for a resolver that leaves every
 * kanjidic reading at its modern spelling) is the general, data-driven
 * index built by `scripts/build-historical-kana-index.mjs` from Wiktionary
 * data, keyed by *kanji spelling* (`token.text`) rather than by whatever
 * reading kanjidic happens to produce: two unrelated words can share one
 * modern kun'yomi while having different (or no) attested historical
 * spellings, so looking this up by the resolved kana string instead of by
 * the actual character would risk "correcting" a homonym's reading using a
 * different word's historical spelling entirely. Deliberately the *only*
 * mechanism for this — no small hand-curated table sits in front of it (one
 * existed briefly and was removed): a per-word correction table is exactly
 * the word-by-word patching this index exists to replace, and letting it
 * win case-by-case would silently mask whatever the general index actually
 * produces instead of surfacing it for the index (or the extraction script)
 * to be fixed. */
export function createReadingResolver(kanjidic: KanjidicIndex, jmdict: JmdictIndex, historicalKana?: HistoricalKanaIndex): ReadingResolver {
  return (token: Token, sentence: Sentence | { tokens: Token[] }): ResolvedReading => {
    const zheTopic = zheTopicReading(token, sentence);
    if (zheTopic) {
      return { reading: zheTopic, gloss: "topic marker (following a noun/name)", source: "override" };
    }

    // Both checked before kanjidic/override lookup, and tagged source
    // "kanjidic" (not "override") — these are content words that keep
    // their kanji in kakikudashi (see cellFor's kanaOnly doc), unlike the
    // override table's function-word glosses, which are shown as bare kana.
    if (isNominalizedFaultNoun(token)) {
      return { reading: "あやま", okurigana: "ち", gloss: "fault, error", source: "kanjidic" };
    }
    const adjectiveRoot = classicalAdjectiveRootReading(token);
    if (adjectiveRoot) {
      return { reading: adjectiveRoot.reading, okurigana: adjectiveRoot.okurigana, gloss: "sharp, advantageous", source: "kanjidic" };
    }

    const override = findOverride(token.text, token.pos, token.dep);
    if (override) {
      return {
        reading: override.reading,
        okurigana: override.okurigana,
        gloss: override.gloss,
        source: "override",
      };
    }

    const kanjidicHit = lookupKanji(kanjidic, token.text, token.pos);
    if (kanjidicHit) {
      // historicalKana is keyed by kanjidic's own (modern) reading string,
      // so it's looked up *before* classicalAdjectiveReading's stem-trimming
      // below — not after — or an undotted adjective entry (the one case
      // that actually changes `reading`, not just `okurigana`) would look
      // itself up under a key the index never used.
      const baseReading = historicalKana?.[token.text]?.[kanjidicHit.reading] ?? kanjidicHit.reading;
      const topicalized = isTopicalizedAdjective(token, sentence);
      const isAdjective = topicalized || parseMorphFeatures(token.morph ?? "").Degree === "Pos";
      const { reading, okurigana } = isAdjective
        ? classicalAdjectiveReading(baseReading, kanjidicHit.okurigana, topicalized ? "rentai" : "shuushi")
        : { reading: baseReading, okurigana: kanjidicHit.okurigana };
      return { reading, okurigana, gloss: kanjidicHit.gloss, source: "kanjidic" };
    }

    if (SPAN_DEPS.has(token.dep)) {
      const jmdictHit = lookupLemma(jmdict, token.lemma);
      if (jmdictHit) {
        return { reading: jmdictHit.reading, gloss: jmdictHit.gloss, source: "jmdict" };
      }
    }

    logUnresolved(token);
    return { reading: "", source: "unresolved", gloss: token.lemma };
  };
}
