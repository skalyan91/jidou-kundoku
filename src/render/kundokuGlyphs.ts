import type { KundokuTier, ReadingPlan } from "../kundoku/types.ts";
import { returnPoints } from "../kundoku/kundokuTenAssigner.ts";

// Unicode's dedicated "Kanbun" block (U+3190-319F) — purpose-built
// annotation-mark glyphs, distinct from (and preferred over) the plain CJK
// ideographs/katakana they visually resemble.
const REVERSE_MARK = "㆑"; // ㆑ IDEOGRAPHIC ANNOTATION REVERSE MARK (レ点)
const ONE_MARK = "㆒"; // ㆒
const TWO_MARK = "㆓"; // ㆓
const THREE_MARK = "㆔"; // ㆔
const FOUR_MARK = "㆕"; // ㆕
const TOP_MARK = "㆖"; // ㆖
const MIDDLE_MARK = "㆗"; // ㆗
const BOTTOM_MARK = "㆘"; // ㆘
const FIRST_MARK = "㆙"; // ㆙ (甲)
const SECOND_MARK = "㆚"; // ㆚ (乙)
const THIRD_MARK = "㆛"; // ㆛ (丙)
const HEAVEN_MARK = "㆝"; // ㆝ (天)
const EARTH_MARK = "㆞"; // ㆞ (地)
const MAN_MARK = "㆟"; // ㆟ (人)

const TIER_GLYPHS: Record<Exclude<KundokuTier, "re">, Record<number, string[]>> = {
  "ichi-ni": {
    2: [ONE_MARK, TWO_MARK],
    3: [ONE_MARK, TWO_MARK, THREE_MARK],
    4: [ONE_MARK, TWO_MARK, THREE_MARK, FOUR_MARK],
  },
  "jou-ge": {
    2: [TOP_MARK, BOTTOM_MARK],
    3: [TOP_MARK, MIDDLE_MARK, BOTTOM_MARK],
  },
  "kou-otsu": {
    2: [FIRST_MARK, SECOND_MARK],
    3: [FIRST_MARK, SECOND_MARK, THIRD_MARK],
  },
  "ten-chi": {
    2: [HEAVEN_MARK, EARTH_MARK],
    3: [HEAVEN_MARK, EARTH_MARK, MAN_MARK],
  },
};

// The Kanbun block itself only defines numerals up to FOUR_MARK — a group
// larger than that is already beyond what the traditional notation charts,
// so this rare fallback uses plain CJK ideographs rather than inventing
// nonstandard annotation glyphs.
const NUMERAL_FALLBACK = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** Ordered display glyphs for a splice group's tier and member count.
 * Traditional kundoku-ten notation caps most tiers at 2-3 members; a larger
 * group (rare — deeper coordination than the notation was designed for)
 * falls back to plain numerals rather than inventing new symbols. */
export function glyphsForGroup(tier: KundokuTier, count: number): string[] {
  if (tier === "re") return [REVERSE_MARK];
  const byCount = TIER_GLYPHS[tier][count];
  if (byCount) return byCount;
  return NUMERAL_FALLBACK.slice(0, count);
}

const TIER_BY_DEPTH: Exclude<KundokuTier, "re">[] = ["ichi-ni", "jou-ge", "kou-otsu", "ten-chi"];

/** Shared per-token mark-stacking logic behind both `buildKundokuGlyphMap`
 * (Unicode Kanbun-block display glyphs) and `kanbun/texAnnotation.ts`'s
 * plain-character marks (一二三.../レ, for the editable .tex annotation and
 * `kanbun/kuntenExecutor.ts`'s reading-order reconstruction) — the two must
 * always agree on which marks a token carries and in what order, or the
 * panel and the downloaded/editable annotation could silently diverge.
 *
 * A token can belong to two splice groups at once — e.g. a negated verb
 * that also governs a genuine comp:obl/comp:pred complement — real kanbun
 * typesetting stacks both marks on such a character. This collects both,
 * then always orders numeral-tier marks (一二点/上下点/etc.) *before* レ点
 * in the stack — real kanbun convention always nests レ点 below/inside a
 * numeral tier, never the other way — rather than whatever order the two
 * splice groups happened to be pushed in during the tree walk. */
export function buildMarkMap(plan: ReadingPlan, glyphsForTier: (tier: KundokuTier, count: number) => string[]): Map<number, string> {
  const perToken = new Map<number, { glyph: string; isRe: boolean }[]>();
  const add = (id: number, glyph: string, isRe: boolean) => {
    const list = perToken.get(id) ?? [];
    list.push({ glyph, isRe });
    perToken.set(id, list);
  };
  for (const group of plan.spliceGroups) {
    if (group.isRe) {
      const last = group.rankTokenIds[group.rankTokenIds.length - 1];
      add(last, glyphsForTier("re", 1)[0], true);
      continue;
    }
    const tier = TIER_BY_DEPTH[Math.min(group.depth, TIER_BY_DEPTH.length - 1)];
    // Only the members the reader has to return to or from carry a rank — see
    // `kundokuTenAssigner.ts`'s `returnPoints`, which is where the rule and
    // the edition evidence for it are written down. Asking it here rather than
    // numbering `rankTokenIds` straight through is what keeps the panel's
    // glyphs and `assignKundokuTen`'s marks the same answer.
    const points = returnPoints(group);
    const glyphList = glyphsForTier(tier, points.length);
    points.forEach((id, i) => add(id, glyphList[i], false));
  }

  const glyphs = new Map<number, string>();
  for (const [id, marks] of perToken) {
    const ordered = [...marks].sort((a, b) => Number(a.isRe) - Number(b.isRe));
    glyphs.set(id, ordered.map((m) => m.glyph).join(""));
  }
  return glyphs;
}

/** Per-token display glyph for every marked token in a sentence's reading
 * plan. Call after `assignKundokuTen(plan)` — that call fills in each
 * group's real `depth`/`isRe` in place, which this reads directly rather
 * than re-deriving. レ点 groups mark only their source-earlier member, and a
 * numeral tier marks only the members a return lands on or leaves from (see
 * `kundokuTenAssigner.ts`'s `returnPoints`). */
export function buildKundokuGlyphMap(plan: ReadingPlan): Map<number, string> {
  return buildMarkMap(plan, glyphsForGroup);
}
