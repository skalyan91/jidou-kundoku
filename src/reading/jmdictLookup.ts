import { loadJsonIndex } from "./jsonIndex.ts";
import shinjitaiData from "./shinjitai-index.json";
import { isRereadUse } from "../kakikudashi/rereadCharacters.ts";
import { parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import { isDistributivePostpose } from "../kundoku/depClassification.ts";
import type { Sentence, Token } from "../parse/types.ts";

export interface JmdictEntry {
  reading: string;
  gloss: string[];
  pos: string[];
  common: boolean;
}
export type JmdictIndex = Record<string, JmdictEntry>;

let cached: Promise<JmdictIndex> | null = null;

export function loadJmdictIndex(url = "/data/jmdict-index.json"): Promise<JmdictIndex> {
  if (!cached) cached = loadJsonIndex<JmdictIndex>(url);
  return cached;
}

export interface JmdictLookupResult {
  reading: string;
  gloss?: string;
}

/** `spelling` with every 旧字体 character replaced by its 新字体 — 獨酌 to
 * 独酌, 大亂 to 大乱 — or the spelling unchanged when it has none.
 *
 * Kanbun is written in 旧字体 and JMdict is keyed on modern spellings, so
 * without this the two never meet: every lookup here was quietly failing on
 * the orthography rather than on the word. 獨酌 is absent from JMdict and
 * 独酌 is in it (どくしゃく); so are 大乱, 独立 and hundreds more. The gap was
 * invisible because a miss and a genuine "not a word" are the same `null`.
 *
 * The map is `scripts/build-verb-lexicon.mjs`'s own, read off Wiktionary's
 * `pos: "character"` entries — the same derivation that already gives 學 the
 * conjugation it builds for 学 — rather than a hand-kept variant list. 500
 * characters, so it is imported directly rather than fetched: `lookupLemma`
 * is synchronous at every one of its call sites, and threading another
 * async-loaded index through all of them to carry 6KB would be the wrong
 * trade (the same call `verbLexicon.ts` makes about its own index).
 *
 * One-way and lossy on purpose. Several kyūjitai can share a shinjitai
 * (藝/芸), so this direction is many-to-one and safe, while the reverse is
 * not, and nothing here ever runs it backwards. */
export function shinjitaiSpelling(spelling: string): string {
  let normalised = "";
  let changed = false;
  for (const char of spelling) {
    const modern = SHINJITAI_OF[char];
    if (modern) changed = true;
    normalised += modern ?? char;
  }
  return changed ? normalised : spelling;
}

const SHINJITAI_OF = shinjitaiData as Record<string, string>;

/** Looks up a multi-character (or single-character) lemma. Returns null if
 * the lemma isn't in the index.
 *
 * Deliberately *not* 新字体-normalising: see `lookupModernisedLemma`, and the
 * measurement recorded there for why the normalisation is scoped to one
 * caller rather than applied to every lookup here. */
export function lookupLemma(index: JmdictIndex, lemma: string): JmdictLookupResult | null {
  const entry = index[lemma];
  if (!entry) return null;
  return { reading: entry.reading, gloss: entry.gloss[0] };
}

/** `lookupLemma`, retrying under the modern spelling when the spelling as
 * written misses — 獨酌 answered by 独酌's own entry (どくしゃく).
 *
 * The spelling as written is tried first, so a headword JMdict genuinely
 * lists under its old spelling still answers for itself; normalising up
 * front would throw that away for no gain.
 *
 * Scoped to `onyomiCompound` in readingResolver.ts, and it took a
 * measurement to decide that. Applying it inside `lookupLemma` and
 * `lemmaTransitivity` instead — so that every caller benefited — was tried
 * and reverted: enumerated over every kanji KANJIDIC2 holds, it moved 139
 * transitivity answers and 135 per-token resolutions, and made 182 single
 * kyūjitai characters resolve in JMdict where they had not. Much of that is
 * the transitivity machinery finally working for characters it could never
 * answer for (亂 with an object becomes みだす, 傳 つたえる, 殘 のこす, 變
 * かえる — all right). But it is not uniformly right, and the wrong ones are
 * not near-misses: 發 with an object became あばく ("to expose") where kanbun
 * wants はっす/たつ, 墮 became くずす where it means "to fall", 讚 moved from
 * たたえる to ほむ, 將 — normally a 再読文字 — became ひきいる, and 榮 acquired
 * the mahjong term ロン as a single-character reading available to the
 * compound-span path. 66,077 JMdict headwords become reachable in total once
 * every kyūjitai spelling is enumerated, which is far more surface than the
 * three words this change is for.
 *
 * The pair rule is where the normalisation is *needed* and where it is also
 * safe, because two independent checks stand behind it: the split reading
 * has to divide cleanly across the characters, and every piece has to be one
 * of its own character's attested on'yomi. A wrong dictionary hit does not
 * survive both. Widening it further is a decision about hundreds of
 * individual words and wants a person, not a lookup. */
export function lookupModernisedLemma(index: JmdictIndex, lemma: string): JmdictLookupResult | null {
  return lookupLemma(index, lemma) ?? lookupLemma(index, shinjitaiSpelling(lemma));
}

/** Whether a word takes a direct object. "both" is a real answer, not a
 * hedge: JMdict genuinely lists 開く (ひらく) as *both* transitive and
 * intransitive, which is why 開 reads ひらく whether or not it has an object
 * — the character has no separate intransitive partner to switch to.
 * "unknown" means the index has nothing to say (the headword isn't listed,
 * or the entry it holds is a noun), which callers must treat as "no
 * evidence" rather than as either answer. */
export type Transitivity = "transitive" | "intransitive" | "both" | "unknown";

/** JMdict's own part-of-speech strings for the two properties, verbatim —
 * the index stores the expanded English labels the JMdict distribution
 * writes out ("transitive verb"), not the abbreviated `vt`/`vi` entity
 * codes, so these match on the long forms. */
const TRANSITIVE_POS = "transitive verb";
const INTRANSITIVE_POS = "intransitive verb";

/** The transitivity JMdict records for `headword` (a kanji spelling with
 * its modern okurigana, e.g. 立つ / 立てる).
 *
 * This is the evidence `kanjidicLookup.ts` ranks a character's kun'yomi by
 * when the sentence says whether the verb has an object: KANJIDIC2 lists
 * 立's readings as た.つ/た.てる with nothing to say about which of them is
 * the transitive one, while JMdict tags 立つ intransitive and 立てる
 * transitive outright. Deriving it from the reading's *shape* instead was
 * considered and rejected — the -eru member of a pair is transitive for
 * 立つ/立てる but intransitive for 見る/見える, so the ending alone cannot
 * decide it and only the dictionary can. */
export function lemmaTransitivity(index: JmdictIndex, headword: string): Transitivity {
  // Not 新字体-normalised, though a kyūjitai verb asked 學ぶ of a dictionary
  // holding 学ぶ does get "unknown" here and leaves the transitivity question
  // unanswered. Closing that gap moves 139 of these answers at once, in both
  // directions — see `lookupModernisedLemma` for the measurement and for why
  // that is a decision to take deliberately rather than as a side effect.
  const entry = index[headword];
  if (!entry) return "unknown";
  const transitive = entry.pos.includes(TRANSITIVE_POS);
  const intransitive = entry.pos.includes(INTRANSITIVE_POS);
  if (transitive && intransitive) return "both";
  if (transitive) return "transitive";
  if (intransitive) return "intransitive";
  return "unknown";
}

/** Relations that mark a token as fused with its head into one
 * multi-character reading/furigana span (jukugo-style compounds, reduplication,
 * and flat multi-token names), per the plan's reading-resolution order.
 * Deliberately driven *only* by relations the parser itself assigns —
 * spans are never guessed from a dictionary lookup, which risks fusing
 * tokens the tree says are unrelated (tried once, reverted: it silently
 * broke negation on a false-positive match). */
const SPAN_FUSING_DEPS = new Set(["compound", "compound@redup", "flat", "flat@vv", "flat@foreign"]);

export interface CompoundSpan {
  /** Token ids in the span, in source (left-to-right) order. */
  tokenIds: number[];
  /** Concatenated surface text of the span, in source order — the lemma to
   * look up in the JMdict index. */
  text: string;
}

/** Identifies contiguous multi-character spans in a sentence by walking
 * `SPAN_FUSING_DEPS` attachments back to their governor (a maximal run of
 * tokens where each non-initial token is attached to the previous token, or
 * to another member of the same span, via one of the fusing relations — the
 * governor token is included).
 *
 * This only *detects* spans; resolving one via JMdict is the caller's job
 * (via `lookupLemma(index, span.text)`) — span-aware furigana rendering
 * happens in the render layer, and `computeReadingOrder` (via `carrierOf`)
 * is what keeps a span's members contiguous in reading order even when they
 * don't share a governor. */
export function findCompoundSpans(sentence: Sentence): CompoundSpan[] {
  const byId = new Map<number, Token>(sentence.tokens.map((t) => [t.id, t]));
  // Union-find over token ids so a span's members can be attached to any
  // other member (not necessarily to a single fixed governor token).
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const t of sentence.tokens) parent.set(t.id, t.id);
  for (const t of sentence.tokens) {
    // A 再読文字 is never part of a fused span. It is read twice, in two
    // separate places, so it cannot share one reading with a neighbour —
    // and being absorbed into a span hides it from the reorder engine
    // entirely, since span-mates are excluded from a node's children.
    // (盍學 was being fused, which is why 盍 came out as a bare kanji with
    // no なんぞ anywhere.)
    if (isRereadUse(t, sentence)) continue;
    // Nor is a distributive 毎/每 ("every X", "each time that…"), for the
    // same structural reason: it is postposed past its head (see
    // `isDistributivePostpose`, which is what decides that movement), and a
    // token that will be read *after* its neighbour cannot also be drawn
    // fused to it as one unbroken word. Caught live with 毎事問: 毎事 was
    // being grouped — 毎 is tagged VERB/Degree=Pos and its head 事 is an
    // adjacent NOUN, which is exactly the attributive-`mod` shape the
    // branch below fuses — and the group then went through JMdict as a
    // jukugo, reading まいぢ instead of 事ごとに. 毎 is a grammatical
    // quantifier, not half of a compound noun. Keyed off the shared
    // predicate rather than a second lemma list of this module's own, so
    // "which 毎 is the distributive one" is decided in one place.
    if (isDistributivePostpose(t)) continue;
    // flat@vv ("flat verb-verb") is meant for genuine serial-verb chains —
    // two VERBs sharing a subject (槁暴, both "to dry/wither" and "to be
    // exposed"). It can also land on a stative predicate attached directly
    // to the NOUN it describes (木直, "wood [that is] straight") instead of
    // to a verb — there the two tokens aren't one fused word at all: 直 is
    // its own predicate that still needs its own conjugated ending, which
    // fusing into one display span would silently swallow (a span shows
    // bare kanji per member with no per-member conjugation). Excluded by
    // requiring the flat@vv governor itself be verb-like.
    const isNominalHeadedFlatVV =
      t.dep === "flat@vv" && byId.has(t.head) && ["NOUN", "PROPN", "PRON"].includes(byId.get(t.head)!.pos);
    // A state name compounded onto a common noun is a genitive, not a fused
    // name: 秦王 is "the king OF Qin" (秦ノ王), where 黃帝 and 惠王 are one
    // name apiece. The parser labels all three `compound`; NameType is what
    // separates them, and a live parse of each confirms it — 秦/楚/齊/趙 over
    // 王 all come back `NameType=Nat`, while 黃 (Giv), 惠 (Prs) and 安陵
    // (Geo) do not, so those three keep fusing. Left unfused so
    // `conjugationContext.ts`'s `genitiveNoParticle` can put の between the
    // two: a fused span's members are drawn as bare kanji with one shared
    // group ending, which has no room for a particle between them, so the
    // の rule was never even asked about 秦王.
    if (t.dep === "compound" && t.pos === "PROPN" && parseMorphFeatures(t.morph ?? "").NameType === "Nat") continue;
    if (SPAN_FUSING_DEPS.has(t.dep) && !isNominalHeadedFlatVV && byId.has(t.head) && t.head !== t.id) {
      const a = find(t.id);
      const b = find(t.head);
      if (a !== b) parent.set(a, b);
      continue;
    }
    // Attributive modification of a noun (plain `mod`, never `mod@tmod`/
    // `mod@lmod` — those are clause-level adverbials, not NP-internal) keeps
    // the resulting noun phrase intact as one unit, same as a real compound
    // — a descriptive word directly modifying a noun (this treebank tags
    // many such modifiers VERB/ADJ, not a dedicated adjective class) is part
    // of that NP, not a separate word. Restricted to: source-adjacent pairs
    // (a genuine attributive modifier always sits directly next to its
    // noun, so a non-adjacent `mod` edge is some other, looser attachment
    // display-fusion — which requires contiguous token ids — can't
    // represent as one unit anyway); and the modifier itself being
    // adjective-like (VERB/ADJ — a descriptive word, the only kind that can
    // attributively modify a noun) rather than ADV — an adverb (亦/皆/甚
    // etc.) can also land as `mod` of a nominal *predicate* root (e.g.
    // 亦君子乎, "is it not ALSO a gentleman?"), which is a clause-level
    // adverb over the whole predicate, not part of the noun phrase itself,
    // even though its head happens to be a noun.
    if (
      t.dep === "mod" &&
      (t.pos === "VERB" || t.pos === "ADJ") &&
      byId.has(t.head) &&
      t.head !== t.id &&
      Math.abs(t.id - t.head) === 1
    ) {
      const head = byId.get(t.head)!;
      if (head.pos === "NOUN" || head.pos === "PROPN") {
        const a = find(t.id);
        const b = find(t.head);
        if (a !== b) parent.set(a, b);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const t of sentence.tokens) {
    const root = find(t.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(t.id);
  }

  const spans: CompoundSpan[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    ids.sort((a, b) => a - b);
    // Display fusion requires a contiguous run of token ids (the renderer
    // draws one unbroken cell group) — should a chain of union-find edges
    // ever bridge a gap, skip rather than silently scrambling reading
    // order around the missing id.
    if (ids[ids.length - 1] - ids[0] !== ids.length - 1) continue;
    spans.push({ tokenIds: ids, text: ids.map((id) => byId.get(id)!.text).join("") });
  }
  return spans;
}
