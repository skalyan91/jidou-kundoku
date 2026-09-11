import { positionCompoundLines } from "./KundokuView.ts";
import {
  applyHangingMarks,
  clearHangingMarks,
  lineWidths,
  MAX_VERSE_GAP_REDUCTION_RATIO,
  planHangingMarks,
  planLineCentering,
  proseFlow,
  RIME_FLOOR_ATTRIBUTE,
  shiftLineRun,
  VERSE_ATTRIBUTE,
} from "./KakikudashiView.ts";

/** Builds the paginated, print-only view of the two panels.
 *
 * The screen layout can't be printed directly. Its panels are fixed-height
 * scrollers whose vertical-rl text overflows *sideways*, and page
 * fragmentation runs down the page — so a long passage simply runs off the
 * left edge instead of continuing overleaf. Worse, two sibling vertical-rl
 * blocks are pushed onto separate pages by Chromium regardless of size
 * (measured), which is why the panels can't just be turned loose in the
 * page flow either.
 *
 * So the pages are laid out here instead: the text is dealt into pages, each
 * page holding a kundoku band above its own kakikudashi band, both carrying
 * *the same* text. That is what keeps the two in step across a page break —
 * page 2 continues both, rather than the panels drifting apart at different
 * rates.
 *
 * Sizes are in millimetres deliberately: they're absolute, so a band
 * measured here on screen wraps its columns exactly as it will on paper,
 * and the fit test below is therefore meaningful before anything is
 * printed. They must stay in step with `@page` in print.css.
 *
 * ── The band's box is written from script, in both media ─────────────────
 * The mm sizes only make the measurement meaningful if the *rest* of the box
 * is the same on screen as on paper, and it was not. `#print-root` is built
 * and measured while the document is still in screen media (app.css parks it
 * off-canvas; print.css brings it back into the flow), so a band — which is a
 * `.tategaki` — was measured wearing that class's own padding: 55px at the
 * head of every column and 44px at each side (tategaki.css). The band printed
 * had `padding: 0` from print.css instead. The two boxes differ by a whole
 * kundoku character down the column (334px of measure against 389px, three
 * characters against four) and by a column across it, so every measurement
 * taken here — the fit test, and `heldSlots`' count for the hang — was a
 * measurement of a box that never reaches paper.
 *
 * `makeBand` therefore writes padding and overflow as inline styles, which
 * beat both stylesheets and apply in both media. It is the one way the box
 * measured and the box printed can be the same box by construction rather
 * than by two stylesheets agreeing. */
const PAGE_CONTENT_WIDTH_MM = 269; // A4 landscape (297mm) less 2x14mm margin
const PAGE_CONTENT_HEIGHT_MM = 182; // A4 landscape (210mm) less the same

/** CSS's own definition: 96px to the inch, 25.4mm to the inch. Every band
 * height here is chosen in pixels — an advance is a pixel quantity — and
 * written in millimetres, because millimetres are what `@page` is in. */
const MM_PER_PX = 25.4 / 96;

/** What the two bands may spend of the 182mm between the margins.
 *
 * Four millimetres are left over, which is what the pair have always left
 * (they were 103 + 75). They are not slack for the text: two inline-level
 * bands sit in two line boxes, and a line box is at least the strut of the
 * page's own font tall, so a millimetre or two of the sheet is spoken for by
 * something no band declares. Left as a margin of error rather than measured,
 * because the thing it protects against is a page that silently breaks in
 * three instead of two, and there is no browser here to watch it not happen.
 *
 * **And it is now the only margin there is.** The pair used to stop well short
 * of even this budget — 13.73mm short at np=6 — so the 4mm was the last of two
 * cushions rather than the only one. `filledKundokuAdvancePx` spends the other,
 * and at np=7 and np=8 the two bands come to 178.000mm exactly, which leaves
 * this and nothing else between the page and a third fragment. Kept rather than
 * trimmed for precisely that reason: it was already the answer to something
 * nobody has measured, and it is answering it alone now. What would let it
 * shrink is a `line-height: 0` on `.print-page`, which would take the strut out
 * of both line boxes and make the reserve provable rather than prudent — not
 * taken this round, because it is a change to how the page fragments and that
 * is the part of this layout a print preview has already confirmed works. */
const BAND_BUDGET_MM = PAGE_CONTENT_HEIGHT_MM - 4;

/** Added to each band on top of the whole number of characters it is sized
 * for — half a millimetre, 1.89px.
 *
 * A band is sized at exactly `slots x advance`, and a band a hair short of
 * that holds one character fewer, since a line breaker floors. Three things
 * can take that hair: the millimetre value is rounded (this writes three
 * decimals, so under 0.002px); a snapped `letter-spacing` can cost up to a
 * layout unit — a 64th of a pixel — per slot, which is 0.125px over the eight
 * slots the widest prose band holds (`FIT_GUARD_PER_SLOT_PX` in
 * KakikudashiView.ts is the same guard, drawn against the same snapping); and
 * the browser's own sub-pixel rounding of a used height.
 *
 * 1.89px is fifteen times the largest of those and 7% of one prose slot, so it
 * cannot buy a character that has not been earned. */
const BAND_CUSHION_MM = 0.5;

/** ── How tall the two bands are, and why the two numbers are not written
 * down here ──────────────────────────────────────────────────────────────
 *
 * **The two bands carry the same text at different sizes, so at freely chosen
 * heights they run to different lengths and one reaches the page edge long
 * before the other.** Under vertical-rl a band's *height* is the inline size —
 * the length of one column — and its *width* is the block size, how far the
 * columns march. So a taller band holds more characters per column, needs
 * fewer columns, and comes to a **shorter** horizontal length for the same
 * text. The heights are the only free variable; everything else is fixed by
 * the type scale.
 *
 * The quantities, at the shipped scale (typography.css):
 *
 *   kundoku   advance 88px down the column (`--kanji-advance`: a 44px
 *             character and the 44px gap that follows it), pitch 88px across
 *             (`--column-pitch`)
 *   prose     advance 25.3px down the column (22px at the drawn 0.15em
 *             tracking — a band goes through no fit, so the tracking is the
 *             fallback in `.text-kakikudashi`), pitch 44px across
 *             (`--column-pitch-kakikudashi`, two prose columns to one kundoku
 *             column by construction)
 *
 * Write `nk` and `np` for the characters a kundoku and a prose column hold,
 * and `r` for how many characters of prose a kanbun character comes to. A
 * passage of `C` kanbun cells then runs `88C/nk` across in the kundoku band
 * and `44rC/np` in the prose band, and the two are equal exactly when
 *
 *     np = nk x r / 2
 *
 * `r` is a property of the text — the repository's own measurement is two to
 * three (`matchedSlots`, KakikudashiView.ts; on 酒蟲 it is 652 characters of
 * prose to 271 kundoku cells, so 2.41). So there is no pair of numbers that
 * serves every text, and `np` is **chosen by measuring this text**, below.
 *
 * ── Why `nk` is five, and fixed ──────────────────────────────────────────
 * A band of `nk` characters is `88nk` px; a prose band of `np` is `25.3(np+1)`
 * px, the extra advance being the room a hanging mark needs at the foot of
 * every column (see `makeBand`). Against the 672.76px that 178mm comes to:
 *
 *   nk=4   352.0px  93.63mm   leaves 84.37mm — np up to 11, and 44 characters
 *                             to the page against the 55 five holds
 *   nk=5   440.0px 116.92mm   leaves 61.08mm — np up to 8
 *   nk=6   528.0px 140.20mm   leaves 37.80mm — np up to 4, which answers to
 *                             r = 1.33: below anything a kanbun text comes to
 *
 * (Heights with the cushion; the bare columns are 93.13, 116.42 and 139.70mm.)
 * Five is the largest kundoku column the sheet can carry while the prose band
 * beside it can still be set long enough to match. Six leaves room only for a
 * prose column suited to a text whose reading is a third longer than its
 * original — no kanbun text is that short in Japanese, so a six-character
 * kundoku column would mean a prose band that ran off the sheet before the
 * kundoku band was half way. Four would carry r up to 5.5 and costs a fifth of
 * every page to do it. So `nk` is five and `np` is what moves.
 *
 * ── The five heights ─────────────────────────────────────────────────────
 * The kundoku band is 5 x 88 + cushion = 116.92mm at every one of them —
 * which is the height the *match* is made at, and not the height the band is
 * finally set to; see `filledKundokuAdvancePx` below.
 *
 *   np  prose band            pair      ideal r    prose to the page
 *    4   126.5px  33.97mm   150.89mm      1.6       23 x 4 =  92
 *    5   151.8px  40.66mm   157.58mm      2.0       23 x 5 = 115
 *    6   177.1px  47.36mm   164.27mm      2.4       23 x 6 = 138
 *    7   202.4px  54.05mm   170.97mm      2.8       23 x 7 = 161
 *    8   227.7px  60.75mm   177.66mm      3.2       23 x 8 = 184
 *
 * (23 prose columns and 11 kundoku columns to a page: 269mm is 1016.69px,
 * which is 23.1 pitches of 44 and 11.6 of 88. So a page carries 55 kanbun
 * characters, and at np=6 the 138 prose characters that answer to 57 of them —
 * the kundoku band fills four per cent sooner, which is the quantisation and
 * not the match.)
 *
 * The widest pair comes to 177.66mm, so every one of them is inside the 178mm
 * budget and leaves the sheet the same 4mm the old pair did. The narrower
 * pairs leave more — 13.73mm at np=6, on top of the 14mm margin — and that
 * leftover is now spent rather than left standing below the prose band.
 *
 * ── Spending what the match leaves, and on which band ────────────────────
 * This file used to argue that the leftover had nowhere to go: that the only
 * way to spend it is a band taller than the whole number of characters it
 * holds, which moves the same emptiness *inside* the text block, to the foot
 * of every column, rather than leaving it once at the bottom of the sheet.
 *
 * That is a false choice, and the answer to it is one file over.
 * `fittedTracking` (KakikudashiView.ts) divides a measure by the **nearest
 * whole number** of characters and spends the remainder on the *tracking*, so
 * the column holds a whole number of characters with the slack distributed
 * between them instead of dumped at the foot. A print band goes through no fit
 * at all — it keeps the drawn 0.15em — which is exactly why its own remainder
 * had nowhere to go. `filledKundokuAdvancePx` below is that same arithmetic,
 * asked for the print band.
 *
 * All of it goes to the **kundoku** band, and the prose band is not touched.
 * Three reasons, in the order that settles it:
 *
 *  - **The prose band's white is 0.15em and the kundoku band's is a whole
 *    character.** The same millimetres are therefore a far larger change
 *    below than above. At np=6 the 13.73mm is 51.87px: over the kundoku
 *    band's five slots that is +10.37px on an 88px advance — a gap of 1.236
 *    characters against the drawn 1.0 — while over the prose band's seven it
 *    is +7.41px on a 25.3px advance, a tracking of **0.487em** against the
 *    drawn 0.15. That is outside the 0.05-0.3em band the screen fit will set
 *    prose in at all (`FIT_MIN/MAX_TRACKING_EM`), so the prose band cannot
 *    legally take it even if it should.
 *  - **The gap above is not read as spacing.** It is the annotation lane: the
 *    kaeriten and the okurigana are drawn into it out of flow, which is
 *    kunten.css's rule 1 and `.kanji-cell`'s whole reason for spacing by
 *    margin rather than by tracking. A reader has no yardstick for how wide
 *    that lane ought to be. The band below is running Japanese, where the
 *    tracking *is* the colour of the line and a reader has every yardstick.
 *  - **The prose band is the half of the page already confirmed on paper.**
 *    Its geometry is what `heldSlots` and `applyHangingMarks` are handed, and
 *    leaving it alone leaves the hang, and the deal, identical to the sheet
 *    the reader approved.
 *
 * The alternative worth writing down is a split in proportion to the two
 * heights, which is the one split that grows both bands by the same fraction:
 * at np=6, +8.4% each, a 1.168 gap above and a 0.247em tracking below. It
 * fills the sheet exactly where this does not, and it pays for the last 2mm
 * with a 64% loosening of the running prose — which is the one change on the
 * page a reader would certainly see. A split in proportion to the *counts*
 * (equal millimetres per slot, 4.32px each) is not available at all: it asks
 * the prose for 0.347em, over the fit's own ceiling.
 *
 * ── The worked example, in the repository's own numbers ──────────────────
 * `tests/kakikudashiColumnFit.test.ts` counts 酒蟲 column by column at every
 * column length, through the text pipeline: 55 kundoku columns at five
 * characters, 110 prose columns at six. 55 x 88 = 4840px and 110 x 44 =
 * 4840px — the same length to the pixel, which is the same coincidence the
 * screen fit lands on at the shipped viewport (`matchedDivision`'s first
 * test: one step, six characters to the prose column). So the print bands are
 * set to the division the panels already choose on screen, arrived at from the
 * other end. Six is therefore also the fallback where there is no prose to
 * measure. */
/** ── The print type scale, and why it is written from script ─────────────
 *
 * The reader asked for the printed characters at **33/60 of the screen size**.
 * Print only: the panels he reads on screen are untouched.
 *
 * ── Where the scale lives, and what does *not* follow it on its own ──────
 * Every length in typography.css hangs off `--size-main` — the gap, the
 * advance, both column pitches, the prose size, the two ruby sizes. So a
 * reader of that file would expect one override to carry the lot.
 *
 * **It does not, and the reason is the one `makeBand` already records for
 * `--kanji-gap`.** A custom property is substituted at the element that
 * *declares* it, so `--kanji-gap: calc(var(--size-main) * var(--kanji-gap-ratio))`
 * has already resolved against `:root`'s 44px by the time anything inherits it.
 * Overriding `--size-main` further down changes only the properties that name
 * it *directly at the using element* — `.text-main`'s `font-size`, and the two
 * `calc()`s in kunten.css. Every derived length keeps its old value, silently,
 * which would give a print band half-size characters at full-size pitch: two
 * columns of kanbun where eleven belong.
 *
 * So all of them are rewritten here, together, at `#print-root`. Ten
 * properties, and the list is exhaustive over the lengths in typography.css
 * that derive from the scale:
 *
 *   --size-main               the scale itself
 *   --kanji-gap               size x --kanji-gap-ratio (the ratio is scale-free)
 *   --kanji-advance           size + gap
 *   --column-pitch            size x --line-height-main (also scale-free)
 *   --column-pitch-kakikudashi  pitch / 2 — **the pitch lock, kept by
 *                             construction, so `WIDOW_ORPHAN_COLUMNS`'
 *                             derivation survives the rescale untouched**
 *   --size-kakikudashi        size / 2
 *   --line-height-kakikudashi = the prose pitch
 *   --size-kakikudashi-ruby   prose size / 2 (two kana to a character)
 *   --size-furigana           size / 3 (three kana to a character)
 *   --size-kunten             **the one that derives from nothing**
 *
 * `--size-kunten` is `--type-min-size`, the floor of the scale, deliberately
 * not a function of `--size-main`. Left alone it would print a 16px kaeriten
 * against a 24.2px character — two thirds of the character's height, where on
 * screen it is a third — so the apparatus would swamp the text it annotates.
 * It is scaled with the rest, which puts it at 8.8px: about 6.6pt on paper.
 *
 * ── The first build of this printed at a sixteenth of the size ───────────
 * Recorded because the fault was invisible from the code and cost the reader
 * two prints. `applyPrintTypeScale` read `--size-main` with `parseFloat` on
 * `getComputedStyle`, and an unregistered custom property computes to its own
 * token sequence — so `2.75rem` came back as the string "2.75rem" and parsed
 * as **2.75**. Every length was a sixteenth of what it should have been and a
 * page asked for at 33/60 was set in 1.5px characters, about one point. He
 * reported it as "microscopic", which it was, and as a consequence of asking
 * for a smaller size, which it was not. **33/60 has never yet reached paper**;
 * what reached paper was 33/960. See the note in `applyPrintTypeScale` for the
 * fix and why registering the two properties is the wrong one. */
/** Three properties are deliberately *not* rewritten. `--panel-margin-top`,
 * `--panel-margin-bottom` and `--prose-margin-top` are `.tategaki`'s own
 * padding, and `makeBand` writes `padding: 0` inline over all three — see its
 * note on why a band's box has to be written from script in both media.
 *
 * Written on `#print-root` rather than per band so that it is said once, and
 * as an inline style because `#print-root` is built and *measured* while the
 * document is still in screen media: a print-media rule would rescale the band
 * that printed and not the band that was measured, which is the exact fault
 * the head of this file is about. */
const PRINT_TYPE_SCALE = 33 / 60;

/** **The ten lengths, from the two the scale is built on.** Pure, so that
 * "does this reduce to the stylesheet at scale 1" is a question with an answer
 * rather than a hope — see the test of that name.
 *
 * `sizePx` and `kuntenPx` are `--size-main` and `--size-kunten` **resolved to
 * pixels**, which is the one hard part and is `applyPrintTypeScale`'s job. The
 * two ratios are `--kanji-gap-ratio` and `--line-height-main`, which are bare
 * numbers and so may simply be read. */
export function printTypeScaleLengths(
  sizePx: number,
  kuntenPx: number,
  gapRatio: number,
  lineHeightMain: number,
  scale: number,
): Record<string, number> {
  const size = sizePx * scale;
  const gap = size * gapRatio;
  const pitch = size * lineHeightMain;
  return {
    "--size-main": size,
    "--kanji-gap": gap,
    "--kanji-advance": size + gap,
    "--column-pitch": pitch,
    "--column-pitch-kakikudashi": pitch / 2,
    "--size-kakikudashi": size / 2,
    "--line-height-kakikudashi": pitch / 2,
    "--size-kakikudashi-ruby": size / 4,
    "--size-furigana": size / 3,
    "--size-kunten": kuntenPx * scale,
  };
}

function applyPrintTypeScale(root: HTMLElement, scale: number): void {
  const style = getComputedStyle(document.documentElement);
  // Declared at all? The value is not parsed — see below for why it must not
  // be — so this asks only whether there is a stylesheet to scale.
  if (style.getPropertyValue("--size-main").trim() === "") return;

  // ── The two lengths are *measured*, not read ───────────────────────────
  // **This is the bug that printed a page the reader called microscopic, and
  // typography.css documents it two hundred lines from where the scale is
  // declared.** An unregistered custom property computes to its own token
  // sequence with `var()`s substituted "and nothing else done" — so
  // `--size-main: var(--type-max-size)` over `--type-max-size: 2.75rem` comes
  // back from `getComputedStyle` as the **string "2.75rem"**, and
  // `parseFloat` of that is 2.75. Not 44. Every length below was a sixteenth
  // of what it should have been, so a print band asked for at 33/60 was set at
  // 2.75 x 0.55 = 1.5125px — a character of about one point. The same trap
  // took `annotationCapacity`'s lane capacity to its fallback once, which is
  // why `--size-furigana` carries an `@property` registration and a paragraph
  // saying so.
  //
  // Registering these two would fix it as well, and is the wrong fix here:
  // `--size-main` is the whole type scale's root and `--size-kunten` is
  // `--type-min-size`, so registering them would change how they compute for
  // every reader of the stylesheet in order to serve one caller in print.
  //
  // So the units are left to the engine that owns them. A probe inside
  // `#print-root` is given `font-size: var(--property)` and its **computed**
  // font-size read back, which is an absolute pixel length however the
  // property was written — rem, em, calc or px. It is the same device
  // `advanceDown` uses below, and for the same reason.
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  root.append(probe);
  const measured = (property: string): number => {
    probe.style.fontSize = `var(${property})`;
    return parseFloat(getComputedStyle(probe).fontSize);
  };
  const sizePx = measured("--size-main");
  const kuntenPx = measured("--size-kunten");
  probe.remove();
  if (!(sizePx > 0) || !(kuntenPx > 0)) return;

  // The two ratios, which *may* be parsed: they are bare numbers, so their
  // token sequence is the number — which is the reason `--kanji-gap-ratio`
  // exists as a ratio at all (typography.css says so where it declares it).
  const gapRatio = parseFloat(style.getPropertyValue("--kanji-gap-ratio"));
  const lineHeightMain = parseFloat(style.getPropertyValue("--line-height-main"));
  const lengths = printTypeScaleLengths(
    sizePx,
    kuntenPx,
    Number.isFinite(gapRatio) ? gapRatio : 1,
    Number.isFinite(lineHeightMain) ? lineHeightMain : 2,
    scale,
  );
  for (const [name, value] of Object.entries(lengths)) root.style.setProperty(name, `${value.toFixed(4)}px`);

}

/** **How many characters a kundoku column holds**, which was the constant `5`
 * and is the same answer written as the arithmetic that produced it.
 *
 * The head of this file argues five as "the largest kundoku column the sheet
 * can carry while the prose band beside it can still be set long enough to
 * match", and rules six out because it "answers to r = 1.33: below anything a
 * kanbun text comes to". Written down: the match wants `np = nk x r / 2`, and
 * the smallest `r` a kanbun text comes to is 2 (the repository's own
 * measurement is two to three), so a usable prose band needs `np >= nk`. The
 * pair must fit the budget, both cushions included:
 *
 *     nk x a_k + (nk + 1) x a_p + 2c <= B
 *
 * which is this. At the drawn scale it answers **5.68 -> 5**, which is the
 * constant it replaces, to the character; at 33/60 it answers 10.51 -> 10.
 * That agreement is the whole reason to trust it: it is not a new choice, it
 * is the old choice with the numbers left in.
 *
 * **Frozen, it would have been the worst outcome of the rescale.** Five
 * characters at a 48.4px advance is a 64.53mm band, and the match beside it —
 * `np = nk x r / 2` at the 2.0 these texts come to — asks for a prose column of
 * five or six, which is 26.27mm. The pair would have stood at 90.8mm of the
 * 178mm the sheet offers and left **87mm of every page blank**, with nothing
 * in the fit test to complain of it: 90.8mm fits.
 *
 * Pure, and handed its measurements, for the reason `bandHeightsMm` is. */
export function kundokuSlotsFor(
  kundokuAdvancePx: number,
  proseAdvancePx: number,
  budgetMm = BAND_BUDGET_MM,
): number {
  if (!(kundokuAdvancePx > 0) || !(proseAdvancePx > 0)) return 1;
  const measurePx = (budgetMm - 2 * BAND_CUSHION_MM) / MM_PER_PX;
  return Math.max(1, Math.floor((measurePx - proseAdvancePx) / (kundokuAdvancePx + proseAdvancePx)));
}

/** The longest prose column the sheet can carry beside a kundoku column of
 * `kundokuSlots` — the ceiling that was the constant `8`.
 *
 * `(np + 1)` advances of prose, the hanging room included, in whatever the
 * kundoku band leaves of the budget. At the drawn scale, five kundoku
 * characters leave 229px, which is 9.05 prose advances and so **8** — the
 * constant it replaces. At 33/60, ten leave 13.29 and so 12. */
export function proseSlotCeiling(
  kundokuSlots: number,
  kundokuAdvancePx: number,
  proseAdvancePx: number,
  budgetMm = BAND_BUDGET_MM,
): number {
  if (!(proseAdvancePx > 0)) return PROSE_SLOTS_MIN;
  const measurePx = (budgetMm - 2 * BAND_CUSHION_MM) / MM_PER_PX - kundokuSlots * kundokuAdvancePx;
  return Math.max(PROSE_SLOTS_MIN, Math.floor(measurePx / proseAdvancePx) - 1);
}

/** The prose column the deal falls back to where there is no prose to measure
 * — the constant `6`, written as what chose it.
 *
 * Six is `np = nk x r / 2` at the five kundoku characters of the drawn scale
 * and the 2.4 characters of prose 酒蟲 comes to per kanbun cell, which is what
 * the head of this file records having measured. So it is `1.2 x nk`, and it
 * answers 6 at five slots and 12 at ten. */
export function defaultProseSlots(kundokuSlots: number): number {
  return Math.max(PROSE_SLOTS_MIN, Math.round(1.2 * kundokuSlots));
}

const PROSE_SLOTS_MIN = 4;

/** How many prose columns of a block must stand on a page for it not to read
 * as a widow or an orphan. Two, and `widowOrphanFree`'s note derives it from
 * the two bands' locked pitches rather than from typographic tradition: two
 * prose columns is exactly one kundoku column, and one prose column is half of
 * one — a fragment in the band above rather than a short line. */
const WIDOW_ORPHAN_COLUMNS = 2;

const ROOT_ID = "print-root";

/** The two band heights, in millimetres, for a column of `kundokuSlots`
 * characters above one of `proseSlots`.
 *
 * The prose band is sized for one slot more than it sets, and the extra one is
 * the hanging room `makeBand` spends as `padding-bottom` — so what its columns
 * are set in really is `proseSlots` advances.
 *
 * Pure, and given the advances rather than reading them, for the reason
 * `fittedTracking` is (KakikudashiView.ts): the arithmetic is the whole of the
 * decision and it can be checked with no layout engine anywhere near it. The
 * advances themselves are measured off a live band — see `advanceDown`. */
export function bandHeightsMm(
  kundokuSlots: number,
  proseSlots: number,
  kundokuAdvancePx: number,
  proseAdvancePx: number,
): { kundoku: number; kakikudashi: number } {
  return {
    kundoku: kundokuSlots * kundokuAdvancePx * MM_PER_PX + BAND_CUSHION_MM,
    kakikudashi: (proseSlots + 1) * proseAdvancePx * MM_PER_PX + BAND_CUSHION_MM,
  };
}

/** The prose column lengths this sheet can carry beside a kundoku column of
 * `kundokuSlots`: the ones whose pair of bands still fits the budget.
 *
 * The floor is a judgement and the ceiling is arithmetic. Below four
 * characters a column of Japanese prose has stopped being prose —
 * `MIN_PROSE_SLOTS` in KakikudashiView.ts draws the same line at three, for a
 * panel a reader can drag, and a printed page is not being dragged — and four
 * already answers to a text whose translation is only 1.6 times its original,
 * which is under anything measured. */
export function proseSlotChoices(
  kundokuSlots: number,
  kundokuAdvancePx: number,
  proseAdvancePx: number,
  budgetMm = BAND_BUDGET_MM,
): number[] {
  const choices: number[] = [];
  const ceiling = proseSlotCeiling(kundokuSlots, kundokuAdvancePx, proseAdvancePx, budgetMm);
  for (let slots = PROSE_SLOTS_MIN; slots <= ceiling; slots++) {
    const heights = bandHeightsMm(kundokuSlots, slots, kundokuAdvancePx, proseAdvancePx);
    if (heights.kundoku + heights.kakikudashi <= budgetMm) choices.push(slots);
  }
  return choices;
}

/** **The match.** Which of the offered prose column lengths brings this text's
 * prose to the same horizontal length as its kundoku.
 *
 * `target` is how far the kundoku passage runs at `kundokuSlotsFor`'s answer, and
 * `extentAt` how far the prose runs at a given column length — both measured
 * off a real band, because the number of columns a passage comes to is the
 * browser's own line breaking (禁則 keeps a mark off the head of a column, a
 * tied compound may not break at all) and `kundokuColumn`'s note in
 * KakikudashiView.ts says why there is nothing to be gained by predicting a
 * number the layout is standing there holding.
 *
 * Every candidate is walked rather than the first one to reach the target
 * taken: there are five of them, the extents are already measured, and unlike
 * `matchedSlots` this walk has no monotone direction it starts from.
 *
 * A tie keeps the *longer* column, which is `matchedSlots`' own convention —
 * the fuller band, and the setting nearest the one the type is drawn at.
 *
 * `null` where nothing is measurable: no prose, or a passage with no extent.
 * The caller falls back to `defaultProseSlots` rather than choosing from
 * nothing. */
export function matchedProseSlots(
  target: number,
  choices: readonly number[],
  extentAt: (slots: number) => number,
): number | null {
  if (!(target > 0) || choices.length === 0) return null;
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const slots of choices) {
    const extent = extentAt(slots);
    if (!(extent > 0)) continue;
    const gap = Math.abs(extent - target);
    if (best === null || gap < bestGap || (gap === bestGap && slots > best)) {
      best = slots;
      bestGap = gap;
    }
  }
  return best;
}

/** **The advance the kundoku band is finally set at**, having spent whatever
 * the match left of the sheet on the gap between its characters.
 *
 * The band holds `kundokuSlots` characters before and after: what grows is the
 * gap, exactly as `fittedTracking` grows the prose panel's tracking on screen.
 * The count is the one thing here that may not move, and nothing here moves
 * it — which is what makes this safe to add to a layout the reader has already
 * seen work:
 *
 *  - **The equal-length property survives untouched.** Two bands run to the
 *    same length when `np = nk x r / 2` (see the head of this file), which is
 *    a statement about the two *counts* and the two column *pitches*. A pitch
 *    is measured across the columns and this changes nothing across them; the
 *    counts are the match's own answer and are passed in.
 *  - **So does the deal.** A page holds `floor(measure / advance)` characters
 *    per column and `269mm / pitch` columns, and both are what they were, so
 *    every page breaks exactly where it broke before. The band is simply
 *    taller, and the sheet under it emptier by that much.
 *
 * ── Where the stretch stops ──────────────────────────────────────────────
 * At the point where the text would rather be another character. The band's
 * text is `slots x advance`, and `fittedTracking` divides a measure by the
 * *nearest* whole number — so once the stretch has added half a drawn advance
 * to the whole band, `slots x advance` is nearer to `slots + 1` characters of
 * the drawn type than to `slots`, and stretching further is stretching away
 * from the count the room wants. (The cushion is not in that reckoning: it is
 * the guard `BAND_CUSHION_MM` describes, sized so it cannot buy a character,
 * and it sits on top of the text at every setting.)
 *
 * Past that boundary the honest change is to the **count** — and the count is
 * not this function's to change. It is what decides how much text a page
 * holds, the pages are dealt against it, and above it stands a length match
 * that chose `nk = 5` for reasons (the head of this file) that have nothing to
 * do with how full the sheet is.
 *
 * So the ceiling is half an advance spread over the whole band, which at five
 * slots is a tenth of one: 96.8px against the drawn 88, a gap of 1.2
 * characters against 1. At the shipped scale, over the five prose columns the
 * match can choose between:
 *
 *   np   prose band   kundoku band    pair       left of the 178
 *    4     33.97mm     128.56mm      162.53mm      15.47mm   at the ceiling
 *    5     40.66mm     128.56mm      169.22mm       8.78mm   at the ceiling
 *    6     47.36mm     128.56mm      175.92mm       2.08mm   at the ceiling
 *    7     54.05mm     123.95mm      178.00mm       0        gap 1.121
 *    8     60.75mm     117.25mm      178.00mm       0        gap 1.006
 *
 * 酒蟲 is np=6, so the sheet that came back with 13.73mm of blank below the
 * prose band comes back with 2.08mm — 1.1% of the page between the margins,
 * and under a third of one prose character. The two long prose columns fill
 * the sheet to the millimetre. The three short ones stop at the ceiling and
 * leave what is left standing where it always stood, which is the old
 * behaviour kept for exactly the case where the new one would overreach.
 *
 * Every number above is arithmetic on the type scale and is checked in
 * tests/printLayout.test.ts. **That a browser lays a 128.56mm band out as five
 * characters at a 52.8px gap, and that the page then reads as full rather than
 * as airy, is not checkable here and wants the reader's own preview.**
 *
 * Pure, and handed its measurements, for the reason `bandHeightsMm` is. */
export function filledKundokuAdvancePx(
  kundokuSlots: number,
  proseHeightMm: number,
  kundokuAdvancePx: number,
  budgetMm = BAND_BUDGET_MM,
): number {
  if (!(kundokuSlots >= 1) || !(kundokuAdvancePx > 0)) return kundokuAdvancePx;
  // The band's own cushion comes off first: it is guarding the floor the
  // browser does, and a stretch that ate it would buy a character it has not
  // earned — the very thing `BAND_CUSHION_MM` exists to refuse.
  const measurePx = (budgetMm - proseHeightMm - BAND_CUSHION_MM) / MM_PER_PX;
  const ceiling = kundokuAdvancePx * (1 + 1 / (2 * kundokuSlots));
  // Never *below* the drawn advance: a prose band wide enough to leave the
  // kundoku band less than the characters it was matched at is a plan the
  // match should not have produced, and tightening the kanbun to make room
  // would be answering it in the wrong place.
  return Math.max(kundokuAdvancePx, Math.min(measurePx / kundokuSlots, ceiling));
}

// ---------------------------------------------------------------------------
// **Verse, on paper.** Everything above is the general case — `nk` chosen for
// sheet efficiency, `np` matched to bring the prose to the *same length* as
// the kanbun. `detectVerse`/`rimeColumnFloor` (rimeAnnotation.ts, read once on
// screen and left on `.text-kakikudashi`'s own dataset — `VERSE_ATTRIBUTE`,
// `RIME_FLOOR_ATTRIBUTE`, both exported from KakikudashiView.ts for exactly
// this reader) say when that is the wrong question, for the reason
// `verseFloorDivision`'s own note gives on screen: a poem's two panels are
// read *across*, line by line, and an extent match has no notion of a line.
//
// The three things a poem needs on paper, in the order they are decided:
//
//  1. **The rime's cell, and nothing past it.** `kundokuSlotsFor`'s answer is
//     chosen for a *different* question — the largest column an
//     extent-matched prose band can still be set long enough beside — and a
//     poem asks neither that question nor wants that answer:
//     `verseKundokuSlots` holds the column to `rimeFloor` itself, not to
//     whichever of the two is larger. The other order was tried and cost a
//     real page a visible band of blank sheet before the prose ever began —
//     see that function's own note.
//  2. **The prose column, given everything the sheet leaves once the floor is
//     held.** Not matched to an extent — a poem's prose is held to its
//     kanbun by the *padding* below, not by ending at the same length — so
//     `verseProseSlots` simply takes the widest the sheet offers, the same
//     "everything else" `verseFloorDivision` gives the screen's prose panel.
//  3. **The correspondence itself**: no prose line printed earlier on the
//     page than the kundoku line it translates. `verseLinePadding` is
//     `lineStartColumns`/`planLinePadding` (KakikudashiView.ts), unchanged,
//     asked of the print band's own counts — the same functions, because the
//     claim is the same claim, only the geometry it is measured against has
//     changed.
//
// **Why every kundoku line is one column, without measuring it.** The
// screen's `kanbunLineColumns` reads the position off the page because a
// kundoku column might hold less than one source line — 禁則 can spend a
// column the naive arithmetic does not expect. On paper that question has a
// closed-form answer: `verseKundokuSlots` never returns less than
// `rimeFloor`, and `rimeFloor` is `rimeColumnFloor`'s own `lineLength + 1`
// (rime.css) — one more than the poem's own longest line — so every kundoku
// column this file ever draws for verse already holds the whole of its
// line, with a cell to spare. `kanbunLineColumns` measuring a live DOM is
// therefore not needed here; line `n`'s kundoku column is column `n`, always,
// by construction and not by observation. `verseKanbunLineStarts` states
// that identity as its own function so a reader checking this file's claims
// does not have to re-derive it from `verseKundokuSlots`'s own definition.
// ---------------------------------------------------------------------------

/** **The rime's floor — and, for verse, the whole of the column height, not a
 * floor under some larger number.**
 *
 * **A ruling this file shipped once already and is restating here, against
 * evidence found after the fact.** The first draft answered
 * `Math.max(defaultSlots, rimeFloor)` — `defaultSlots` being
 * `kundokuSlotsFor`'s general, prose-shaped answer — on the reasoning that a
 * floor should never be *lowered* by an explicit bound. That reasoning is
 * `verseFloorDivision`'s own shape on screen, and it does not carry over: on
 * screen, `defaultSlots`-worth of step is a fact about how many characters
 * `.main` itself holds, a bound the panel has regardless of what is asked of
 * it, so raising a step to meet the floor never costs anything the panel was
 * going to keep for itself either way. `kundokuSlotsFor` is a different kind
 * of number — it is not what the sheet allows, it is what a *prose-matched*
 * band is chosen at for reasons that are about matching an extent
 * (`kundokuSlotsFor`'s own note), a question `verseProseSlots` explicitly
 * does not ask. Taking the larger of the two bought nothing on paper and
 * spent real height: at the shipped scale `defaultSlots` is 10 against a
 * 五言's own floor of 6, and every column this file drew for 春望 was
 * therefore sized to ten characters that no line of a 五言 ever reaches —
 * four cells of dead space at the foot of every column, the whole width of
 * the band, because no line in the poem is longer than the others. On paper
 * that is not a corner rounded the way the screen's could be scrolled past;
 * it is a visible band of blank sheet sitting between the kanbun and the
 * prose that is supposed to sit under it. **Found by generating a real PDF
 * and looking at it, not by the column-index arithmetic, which cannot see a
 * height at all** — see tests/printLayout.test.ts's own account of the
 * figures this reversal moves.
 *
 * So: `rimeFloor` alone wherever there is one, and `defaultSlots` only in the
 * one case that has no floor to hold to — `VERSE_ATTRIBUTE` set with
 * `rimeFloor` still `0`, `detectVerse` having found a poem
 * `rimeColumnFloor` has no rhyme to hang a 割注 under (see `planBands`'s own
 * parameter note on why the two are read and kept apart). There this
 * function has nothing of its own to answer with and falls back to the
 * general choice rather than a column of zero height. */
export function verseKundokuSlots(defaultSlots: number, rimeFloor: number): number {
  return rimeFloor > 0 ? rimeFloor : defaultSlots;
}

/** Line `n` of a verse text's own source is kundoku column `n` — see the
 * describe block above this section for why that is exact and not merely
 * usual once `verseKundokuSlots` has run. */
export function verseKanbunLineStarts(lineCount: number): number[] {
  return Array.from({ length: Math.max(0, lineCount) }, (_, i) => i);
}

/** **The prose column, given everything the sheet leaves.** The widest
 * column `proseSlotChoices` offers beside a kundoku held to `kundokuSlots` —
 * not matched to any extent, because a poem's prose is held to its kanbun by
 * `verseLinePadding` below and not by ending at the same length.
 * `defaultProseSlots` is the fallback `proseSlotChoices` already falls back
 * to elsewhere in this file, for the same reason: a sheet so short nothing
 * of the ordinary budget fits is a sheet with nothing to choose from. */
export function verseProseSlots(
  kundokuSlots: number,
  kundokuAdvancePx: number,
  proseAdvancePx: number,
  budgetMm = BAND_BUDGET_MM,
): number {
  const choices = proseSlotChoices(kundokuSlots, kundokuAdvancePx, proseAdvancePx, budgetMm);
  return choices.length > 0 ? choices[choices.length - 1] : defaultProseSlots(kundokuSlots);
}

/** **The correspondence — centred, not merely held out.** The reader's own
 * correction, read here exactly as `applyLinePadding` (KakikudashiView.ts)
 * reads it on screen: *"I meant horizontal centreing of each line's prose
 * with the line!"*, not the one-sided "never begins later" rule an earlier
 * draft of this file built on `planLinePadding`. `planLineCentering`
 * (KakikudashiView.ts) is the shared arithmetic both panels now ask —
 * `lineWidths` in place of `lineStartColumns` (a line's own width, not
 * merely where it starts, is what centring needs), `verseKanbunLineStarts`'
 * own closed-form kanbun starts unchanged, and the ratio a prose column is
 * *always* held at on paper, `--column-pitch-kakikudashi` being half of
 * `--column-pitch` by construction (`printTypeScaleLengths`'s own note on
 * the pitch lock) — `2`, unconditionally, because a print band goes through
 * no line-per-column mode: see the head of this section on why only the
 * floor-and-pad path was built for paper.
 *
 * **No `lineCount` parameter, on purpose, and not by the oversight an earlier
 * draft of this function shipped it as.** 春望's own sample is the proof a
 * caller cannot be trusted with that count: its seven `.sentence-gap`s are
 * not its ten lines — sentences 6 through 8 are each a couplet, two lines
 * joined by an internal `LineBreak` with no sentence boundary between them
 * (`tests/rimeDetector.test.ts`'s own "finds the lines by `LineBreak`,
 * across the couplets that are one sentence" is this exact fact, read off
 * the same file). `lineWidths`' own return length — one entry per
 * `"\n"`-delimited run exactly as `proseFlow` builds it, sentence boundary
 * or not — is the one count that already agrees with the kundoku side,
 * because both panels broke on the same `LineBreak` metadata to begin with.
 *
 * Returns what `buildPrintLayout` needs to realise the shift: `padColumns`,
 * the whole blank prose columns before each line, exactly the shape the old
 * padding-only draft returned; and `shiftHalfColumn`, whether that line's
 * own run still wants the half column no blank column can express — see
 * `planLineCentering`'s own note on why that split exists at all. */
export function verseLineCentering(
  proseText: string,
  proseSlots: number,
): { padColumns: number[]; shiftHalfColumn: boolean[] } {
  const widths = lineWidths(proseText, proseSlots);
  return planLineCentering(verseKanbunLineStarts(widths.length), widths, 2);
}

/** **The other lever, on paper — and considerably simpler than the screen's.**
 * `KakikudashiView.ts`'s `verseFloorDivisionAtReducedAdvance` has to remeasure
 * a real box at every candidate because `.main`'s row is a CSS `round(down,
 * …)` over a `@property`-registered `--kanji-advance` that does not derive
 * itself from an overridden `--kanji-gap` — both traps that function's own
 * note describes finding the hard way. A print band has neither: its height
 * is `bandHeightsMm`, `slots x advance` and nothing else, so the effect of a
 * reduced gap is a closed form and this is arithmetic, not a search over a
 * live layout.
 *
 * `kundokuGapPx - reductionPx` and never negative: `Math.max(0, …)` is the
 * same floor `setVerseGapReduction`'s own zero-or-nothing rule states on
 * screen, reached here by construction instead of by a caller's own branch. */
export function verseKundokuAdvanceAtReducedGap(kundokuSizePx: number, kundokuGapPx: number, reductionPx: number): number {
  return kundokuSizePx + Math.max(0, kundokuGapPx - reductionPx);
}

/** **The least whole-pixel reduction of `--kanji-gap` at which the sheet can
 * still carry a prose band of at least `PROSE_SLOTS_MIN` characters beside a
 * kundoku band held to `rimeFloor`** — `0` wherever the unreduced gap already
 * can, which is every case this file's own tests reach at the shipped print
 * scale (`kundokuSlotsFor` already answers more than either shipped form's
 * floor, so the sheet the floor leaves for prose is the generous one that
 * function's own note describes, not the cramped one the screen's 802px
 * viewport gave `verseFloorDivisionAtReducedAdvance` real work to do).
 *
 * **The fit itself, not `proseSlotCeiling`'s answer** — `bandHeightsMm` of the
 * two bands at `PROSE_SLOTS_MIN`, compared against `budgetMm` directly. A
 * first draft of this function asked `proseSlotCeiling(...) >= PROSE_SLOTS_MIN`
 * instead, which is `tests/printLayout.test.ts`'s own "always true, and so a
 * search that never searches" catch: `proseSlotCeiling` is written `Math.max(
 * PROSE_SLOTS_MIN, …)` (its own note explains why — a sheet with nothing to
 * choose from still owes a caller *a* number) and so can never answer less
 * than the floor this function was comparing it to, whatever `rimeFloor` or
 * the sheet's width were. That draft returned `0` unconditionally, on every
 * input, and every test it would have been checked against was still unwritten
 * — the "green and wrong" shape the reader's own caution named in advance.
 *
 * Bounded by `maxReductionPx`, the same `MAX_VERSE_GAP_REDUCTION_RATIO` the
 * screen is bounded by (imported, not restated, so the two cannot drift) —
 * and where no reduction inside that bound brings the pair under budget, this
 * answers `maxReductionPx` itself: the deepest cut the bound allows, on the
 * reasoning `verseFloorDivisionAtReducedAdvance`'s own fallback states — the
 * rime still wins, and what padding then cannot fully hold together is the
 * honest cost of a page too narrow for both promises, not a shortfall this
 * search left on the table. */
export function verseGapReductionForPrint(
  rimeFloor: number,
  kundokuSizePx: number,
  kundokuGapPx: number,
  proseAdvancePx: number,
  maxReductionPx: number,
  budgetMm = BAND_BUDGET_MM,
): number {
  for (let reduction = 0; reduction <= maxReductionPx; reduction++) {
    const advance = verseKundokuAdvanceAtReducedGap(kundokuSizePx, kundokuGapPx, reduction);
    const heights = bandHeightsMm(rimeFloor, PROSE_SLOTS_MIN, advance, proseAdvancePx);
    if (heights.kundoku + heights.kakikudashi <= budgetMm) return reduction;
  }
  return maxReductionPx;
}

/** A character that may stand at either end of a column: not a mark that
 * hangs, not one 行頭禁則 keeps off a column's head, not an opening bracket
 * 行末禁則 keeps off its foot. An ordinary ideograph is all three, and this is
 * one — it is only ever asked to be a character with no opinions.
 *
 * `endsColumnFlush` appends it to a passage and asks the model whether the
 * passage grew a column. Nothing is ever rendered. */
const COLUMN_PROBE = "字";

/** **Does this passage end at the foot of a column** — is its last prose
 * column full, or is it a part-column with the rest of its length standing
 * empty?
 *
 * ── What this is for, and that it is wired to nothing ────────────────────
 * The reader's page comes back with the prose band ending part way down a
 * column, and the arithmetic says why. A page is dealt to a **paired cut**
 * (`pairedCuts`), which is a boundary between two of a sentence's top-level
 * children, and nothing whatever makes such a boundary coincide with the foot
 * of a prose column. Worse, it is not even a coin toss: at the shipped scale a
 * sheet carries 11 kundoku columns of 5 (55 cells) against 23 prose columns of
 * 6 (138 characters), and 酒蟲's 652 characters to 271 cells put 55 cells at
 * 132.3 characters of prose — 96% of what the prose band could hold. **So the
 * kundoku band is the binding one on every page**, and the prose band stops
 * around 21.75 of its 23 columns: a last column holding about four and a half
 * of its six characters, with the 23rd never reached at all.
 *
 * The fix that follows from that is to deal a page only to a cut whose prose
 * *is* flush, and this is the test it would ask. It is **not called from
 * anywhere yet, deliberately**: constraining the cut costs a measured 10.4% of
 * the characters on a page (55 cells becoming 49.3, 酒蟲 going from five sheets
 * to six), and it buys the complete last line with *more* blank width rather
 * than less — two empty columns at the band's left edge where there was one and
 * a quarter. That is a trade for the reader to make and not for this file, so
 * the arithmetic is landed and checked while the decision is open. Delete it if
 * the decision goes the other way; it is not an oversight that nothing calls
 * it.
 *
 * ── Why it asks the question this way ────────────────────────────────────
 * `planHangingMarks` (KakikudashiView.ts) is the repository's model of where a
 * prose column breaks — 禁則 at both ends, ぶら下げ, and the 追い出し pull-back —
 * and it is the model the page's own hang is drawn from, so a second opinion
 * here would be a second thing to keep in step. It answers with `columns`, the
 * first character of each column, which is *nearly* what is wanted and not
 * quite: a hung mark belongs to the column it hangs off but is not in it, so
 * counting characters back from the last entry over-counts exactly where it
 * matters most.
 *
 * So the question is put to the model instead of read off it: **append one
 * ordinary character and see whether the passage grew a column.** It grew one
 * exactly when there was no room in the last column — which is what a full
 * column means. Every edge the counting version gets wrong, this gets right by
 * construction:
 *
 *  - a passage ending in a **hung mark** has a full column behind it and the
 *    probe opens a new one, so it is flush, which it is;
 *  - a passage ending at the source's own **line break** closed its column
 *    deliberately (`planHangingMarks` closes on a newline "however short"), and
 *    the probe opens a new one — so a short column the *author* asked for
 *    counts as flush, which is right: it is a break the reader sees on screen
 *    too, and not one the pagination introduced;
 *  - a passage ending on an **opening bracket** at a full column's foot is
 *    flush as it stands — nothing follows to pull the bracket down — and the
 *    probe's own 追い出し moves the bracket forward and still opens a column.
 *
 * An empty passage answers `true`, having no partial line to be faulted for,
 * and a column length below one answers `false` — the model declines to walk
 * at all, and the safe reading of "no answer" is the one that leaves the deal
 * alone.
 *
 * Two walks of the passage per call, which is why a caller should ask it about
 * a candidate cut and not about every character.
 *
 * Pure, and checked in tests/printLayout.test.ts. **Arithmetic on the model,
 * not observation**: that the browser breaks its columns where the model says
 * is the standing claim `planHangingMarks` makes and does not verify, and
 * there is still no browser here to put it to. */
export function endsColumnFlush(prose: string, slots: number): boolean {
  if (!(slots >= 1)) return false;
  return planHangingMarks(prose + COLUMN_PROBE, slots).columns.length > planHangingMarks(prose, slots).columns.length;
}

/** ── History: the block-end stop, tried and withdrawn ────────────────────
 *
 * `endsColumnFlush` above accepts a passage that ends **at** a source line
 * break — "a short column the author asked for counts as flush". For one round
 * this file accepted the mirror case as well: a page ending immediately
 * *before* a break, where the block ends at the page's foot and the `<br>` has
 * gone overleaf with the line it starts (`settledCut`). The reasoning was that
 * such a column is short because the 章 ended, which is the same short column
 * the band shows at every other 章 end on the sheet.
 *
 * The reasoning was sound and the effect was not what the reader wants. On a
 * text with one 章 to a line it made the block end the *cheapest* place to
 * stop, so the deal took it almost every time: 15 page breaks in 19 landed on a
 * 章 boundary. His ruling: **"I don't want a page to necessarily end at a 章! A
 * 章 should be able to wrap across pages."** So it is gone, not gated — and
 * what it was answering (a walk that gave back a 章 and a half hunting a column
 * foot) is answered instead by the page's ledger, which had already taken the
 * worst of that cost out.
 *
 * What it cost to withdraw it, measured on 學而 through real parses (`the deal,
 * on the parses in the fixtures`): 20 sheets become 22 and the fullness floor
 * falls from 42 cells to 32, and 4 wraps in 19 become 9 in 21. The two texts
 * whose blocks run to a page and a half do not move at all — they have three
 * source breaks between them, so the stop was never firing on either.
 *
 * **The 12 breaks in 21 that still land on a 章 boundary are not this rule and
 * not the widow rule**: dealt with widow control switched off the count is
 * identical. They are the kundoku band's own column arithmetic —
 * `appendSourceBreak` (KundokuView.ts) writes a `<br>` for every source line
 * break, and a `<br>` in a vertical-rl inline flow opens a column, so a 章
 * occupies a whole number of columns starting at a fresh one and a page of
 * eleven columns holds a whole number of 章. Moving those would mean a 章 that
 * does not claim its own column, which is a change to how the 訓読文 panel
 * reads on screen as well as on paper. */

/** **The cut the page is actually dealt to**, once a complete last prose
 * column is asked for: the last piece at or below `through` whose prose ends
 * at the foot of a column, or `through` itself where no piece does.
 *
 * `through` is what `pageThrough` found — the fullest the page can be — and
 * this only ever gives text back, never takes more. That is what keeps every
 * guarantee the deal already had: the answer is still one of the paired cuts
 * `pairedCuts` offered, so the two panels still hold the same tokens; it is
 * still at or above `from`, so the page still holds at least the piece it was
 * opened for and the walk still makes progress.
 *
 * ── Walked backwards, one piece at a time, and not bisected ──────────────
 * `pageThrough` bisects because "does this fit" is monotone in `last`. "Does
 * this end flush" is not monotone in anything: it is the character count modulo
 * the column, which goes in and out of true as pieces are added. So the only
 * way to the *largest* flush cut is to try them, and the walk starts at the
 * fullest page and gives up characters until it finds one.
 *
 * That is affordable because it stops early. Measured over 4,000 modelled
 * pages against this implementation (`the cost of a complete last column`,
 * tests/printLayout.test.ts): **4.1 pieces tried on average, 4 at the median
 * and 10 at the worst.** `pageThrough`'s bisection over a thirty-piece
 * sentence is about five probes, so this walk is the same order and not a new
 * cost of a different kind — and each probe is the same forced layout of the
 * page that a bisection's probe is.
 *
 * **Those figures are measured over a page modelled as one stream of pieces,
 * and for one round they were figures about a walk the caller could not make.**
 * The deal used to hold one sentence at a time and passed `from` = the first
 * piece of the *sentence* straddling the page's foot, so this walk had one to
 * three candidates to try where the model had thirty-three, and both rules
 * layered on it were starved. The reader printed that twice and reported the
 * fault both times. The page's ledger (see `buildPrintLayout`) is what closed
 * the gap: `from` is now the head of the page, and the model above and the walk
 * here are once again the same walk. `the deal, on the parses in the fixtures`
 * measures both, on real parses dealt into real pages.
 *
 * ── The fallback, and why it can never empty a page ──────────────────────
 * `through` where nothing is flush. A page then ends mid-column exactly as it
 * does today, which is the behaviour this is a refinement of and so is never
 * worse than it. The modelled rate is nil — 4,000 pages driven through this
 * very function did not produce one — but the fallback is not there for the
 * ordinary case. It is there so that "the page holds at least one piece" is a
 * property of the code rather than of the text: a sentence of one enormous
 * unbreakable piece has no flush cut and must still be dealt.
 *
 * Pure, in the way `pageThrough` is: `endsFlush` is the measurement and what
 * is left is the decision. The caller is left to settle the page on the answer,
 * since only it knows what the last probe placed. */
export function flushThrough(from: number, through: number, endsFlush: (last: number) => boolean): number {
  for (let last = through; last >= from; last--) if (endsFlush(last)) return last;
  return through;
}

/** ── Widows and orphans, in a layout whose lines are columns ─────────────
 *
 * **What a "paragraph" is here had to be established before any of this could
 * be written, and it is not what it looks like.** A `.sentence-gap` is *not*
 * one: tategaki.css says so where it declares it — "No margin: both panels
 * read as one continuous solid passage, broken only by the text's own
 * punctuation, not an artificial per-sentence gap" — and a span with no margin
 * that flows inline begins no column of its own. A sentence therefore has no
 * first column and no last column, and a widow or an orphan cannot even be
 * *stated* about one.
 *
 * What does begin a column is the source's own line break: `appendSourceBreak`
 * (KundokuView.ts) writes a `<br>` for a `LineBreakKind`, `proseFlow` renders
 * that `<br>` as a newline, and `planHangingMarks` closes a column on a
 * newline "however short". So the block that can be widowed or orphaned is the
 * run between two source line breaks — the paragraph where the kind is "para"
 * (which also earns the 一字下げ indent), the verse line where it is "line".
 * Both are protected here and by the same arithmetic, since an orphaned line
 * of verse is if anything the worse of the two.
 *
 * Where a text puts one 章 to a line the block and the 章 coincide, which is
 * the case the request was written from. 酒蟲 is the case it does not: 652
 * characters of prose over **three** source lines, so a block there is some
 * 36 prose columns — a page and a half — and the sentences inside it run on.
 *
 * ── The two faults ───────────────────────────────────────────────────────
 *   orphan   a block's *first* column stands alone at the foot of a page,
 *            the rest of the block going overleaf
 *   widow    a block's *last* column stands alone at the head of a page,
 *            the rest of it having been on the page before
 *
 * ── The threshold is two prose columns, and the geometry chooses it ──────
 * Not tradition, which would leave the question open — one column of vertical
 * Japanese is not one line of horizontal text, and practice differs on whether
 * a two-line remnant is refused as well. The answer here is forced by the two
 * bands instead.
 *
 * The pitches are locked: `--column-pitch-kakikudashi` is `--column-pitch / 2`,
 * two prose columns to one kundoku column **by construction** (typography.css).
 * So a remnant two prose columns wide is exactly one kundoku column wide, and a
 * remnant of one prose column is *half* a kundoku column — which in the band
 * above is not a short column but a column with a fragment in it, a couple of
 * kanbun characters at the head of an otherwise empty column. That is worse
 * than the widow it would be answering, and it is the reason the threshold
 * cannot be one.
 *
 * At two, both bands are satisfied by a single number: the prose band gets the
 * two columns convention asks for and the kundoku band gets one whole one. So
 * the question of *which band governs* — which the request left open, noting
 * only that the reader raised the short column about the prose — does not have
 * to be answered. At this threshold the two agree.
 *
 * (First-order, and worth saying so: two prose columns is one kundoku column in
 * *width*, which is exact, and about five kanbun cells in *content*, which is
 * the 2.406 characters-to-a-cell ratio and holds on average rather than
 * remnant by remnant.)
 *
 * ── It was right, and for one round it was never acted on ────────────────
 * Everything above survived the reader's two reports; what did not was the
 * wiring. The caller could only offer this a cut it was able to *reach*, and
 * it reached one to three — the pieces of the sentence straddling the page's
 * foot. Over three documents of real parses dealt into real pages the answer
 * this gave changed no cut at all, and a widow printed on a page whose cut it
 * had judged. The block that defines a widow was sound; the walk that would
 * move one was not, and `buildPrintLayout`'s ledger is that walk fixed.
 *
 * What it does now, measured the same way: on a periodic document — one whose
 * page breaks land at the same point in the 章 every time, so the fullest flush
 * cut is a widow on every page — this refuses that cut 29 times over 30 sheets
 * and takes the document's widows from 29 to nil, **at no cost in sheets and
 * none in flush cuts**. On the three ordinary documents the fullest flush cut
 * is already tidy and this changes nothing, which is the shape of a guarantee
 * rather than of a fix. */
export function widowOrphanFree(head: number | null, tail: number | null, minimum: number): boolean {
  // The threshold was never derived to say that. `WIDOW_ORPHAN_COLUMNS` is
  // argued above from the pitch lock as the smallest *remnant* that reads as a
  // column rather than as a fragment in the band beside it — a statement about
  // what a remnant may be, not about which blocks may be broken. So where the
  // block cannot afford the remnant the rule asks for, the rule asks for the
  // most it can afford instead of refusing the break.
  //
  // At `C >= 2 x minimum` nothing here changes, which is every block on a text
  // whose paragraphs run to a page and a half. It bites on the one shape the
  // reader is printing: 學而 sets one 章 to a line, and its 章 come to 2, 3 and
  // 5 prose columns (50, 100 and 50 of the 200 in the fixtures) — so **three
  // 章 in four are shorter than the four columns an even division would need**,
  // and at an uncapped threshold every one of them was being held whole. That
  // cost six sheets in forty-four and every wrapped 章 on the document.
  //
  // **The cap re-admits the fault it cannot prevent**, and that is the honest
  // description: a 3-column 章 divided 1-2 does leave a single column at a page
  // foot. What it does not do is spend a sheet pretending otherwise.
  //
  // ── The reader has ruled, and this is the ruling ───────────────────────
  // At the print type scale the exclusivity is total, not partial. A prose
  // column holds ten characters there and 學而's 章 run 11 to 28, so they come
  // to **one, two and three prose columns** — a quarter of them a single
  // column, which cannot be divided at all, and every division of the rest
  // leaving one column standing alone. Put to him in those terms, his answer
  // was **"wrapping is more important"**.
  //
  // So the priority is settled and it is his: where a block cannot be divided
  // without a one-column remnant, the remnant is accepted and the block is
  // divided. On 學而 that is 20 wrapped 章 and 30 remnants — 10 widows and 20
  // orphans — which is what the arithmetic requires of 20 divisions and not a
  // rule failing to find a better cut. **It is a priced consequence.**
  //
  // Where a block *can* be divided cleanly the rule is untouched and still
  // earns its keep: on a text of 22-column blocks it moves three cuts and takes
  // three widows and an orphan off the document at no cost in sheets, and on
  // 5-column blocks it clears 28 orphans, likewise free.
  //
  // Only where the whole block is known, which is where both ends are: a block
  // too short to divide evenly cannot span three pages, so whenever the cap
  // could bite the block both begins and ends within reach of this cut and
  // `head + tail` is its whole length.
  // ── A block that ends where it began is not divided at all ─────────────
  // `tail` is null when the block ends exactly at the cut, so the block begun
  // on this page also *finishes* on it. Nothing of it goes overleaf, so there
  // is no remnant anywhere and neither fault can be stated — a complete short
  // block sitting whole on a page is a short block, not an orphan.
  //
  // This read `head >= minimum` even then, and answered "orphan" for a block
  // that had not been divided. It cost nothing while a block was three columns
  // and more; at the print scale, where 學而's 章 come to one, two and three
  // prose columns and a quarter of them are a single column, it fires on every
  // page that ends just after a short 章 and sends the walk hunting a cut to
  // avoid a fault that was never there.
  if (tail === null) return true;
  // ── The threshold is capped at half the block ──────────────────────────
  // A block of `C` columns divided across a page break leaves `h` on one page
  // and `C - h` on the other, each at least one. Both sides reach `minimum`
  // only where `C >= 2 x minimum` — so for a shorter block **no division
  // satisfies the rule at all**, and refusing every one of them is not widow
  // control. It is a prohibition on the block being divided, which is a
  // different thing and one the reader has ruled against: "I don't want a page
  // to necessarily end at a 章! A 章 should be able to wrap across pages."
  const whole = head !== null ? head + tail : null;
  const floor = whole === null ? minimum : Math.min(minimum, Math.floor(whole / 2));
  return (head === null || head >= floor) && tail >= floor;
}

/** The block a page *begins* — everything after the last source line break in
 * its flow — or `null` where no block begins on it and there is therefore
 * nothing that could be orphaned.
 *
 * A newline is the break, which is what `proseFlow` renders a `<br>` as. The
 * text after the last one starts at a column head by construction, since
 * `planHangingMarks` closes a column on the newline before it — which is what
 * makes counting its columns exact rather than approximate. */
export function blockBegunIn(text: string): string | null {
  const at = text.lastIndexOf("\n");
  return at < 0 ? null : text.slice(at + 1);
}

/** The block a page *hands on* — everything up to the first source line break
 * in what follows the cut.
 *
 * `ends` says whether a break was actually found. Where it was not, the caller
 * has either reached the end of the document (the block ends there, and its
 * columns are what this counted) or stopped gathering early because it had
 * already seen enough characters to know the block is longer than the
 * threshold. Either way the count is a lower bound, which is all a threshold
 * test needs. */
export function blockHandedOn(text: string): { text: string; ends: boolean } {
  const at = text.indexOf("\n");
  return at < 0 ? { text, ends: false } : { text: text.slice(0, at), ends: true };
}

/** ── Dealing the text into pages ─────────────────────────────────────────
 *
 * **The unit dealt is not the sentence.** It was, and the two failures that
 * came of it are the reason this section exists.
 *
 * The old loop appended a sentence and asked `overflows(band)` — whether the
 * band is overflowing *at all*, not whether this sentence is what made it
 * overflow. A sentence too long for a band on its own was kept and allowed to
 * spill (there is nowhere better for it to go), and from that moment the band
 * was permanently overflowing: every later sentence found it so and was pushed
 * to a fresh page, where it spilled in turn and pushed the next. One sentence
 * per page for the rest of the document. `pageThrough` below is the shape that
 * cannot do that — it asks how much of the text a page holds, so a page that
 * is already full is a page that answers "none of it", not a page that
 * condemns everything after it.
 *
 * And the spilled text was not merely spilling. A band carries
 * `overflow: hidden` (it has to: a long sentence would otherwise paint over
 * the band below), so the columns that marched past 269mm were clipped and
 * never printed. A reader printing a long chapter was losing the end of it,
 * silently. Two things answer that: the deal breaks a sentence between pages
 * now, so an over-long one is rare rather than routine; and `spreadSpill`
 * carries whatever still overflows onto continuation pages, so nothing is
 * dropped even then.
 *
 * ── What may be cut, and where ───────────────────────────────────────────
 * The two panels write the same sentence in **different orders**: the kundoku
 * column is the kanbun in source order with its kaeriten, and the prose is
 * that sentence read — 不読書 is three cells in that order above 書を読まず.
 * So a page may only end where the two orders have caught up with each other:
 * where the tokens written so far in one panel are exactly the tokens written
 * so far in the other. `pairedCuts` finds those places and nothing else, which
 * is what makes "page n shows the same text in both bands" a fact that is
 * *checked* rather than assumed. Between two kaeriten groups the orders agree
 * constantly, so an ordinary sentence has a cut every few characters.
 *
 * The cuts fall between top-level children of a `.sentence-gap`, so every
 * invariant inside one survives untouched: a `.no-break-unit`
 * (`glueOpeningPunctForward`'s 行末禁則 wrapper) and a `.compound-group` are
 * single children and are never opened, and a `<br>` carrying a source line
 * break goes to the page that continues the text, with its `.indent-cell`
 * 一字下げ behind it. */

/** One top-level child of a `.sentence-gap`, as the cut finder has to see it:
 * which tokens it puts on the page, and whether it is the source's own line
 * break.
 *
 * A plain shape rather than a `ChildNode`, so the walk can be checked in a
 * test environment with no document in it — the same device `FlowNode` is in
 * KakikudashiView.ts, and for the same reason: what has to be true here is a
 * fact about two sequences and not about a rendering. */
export interface CutUnit {
  /** Every `data-token-id` this child puts on the page, itself or below it.
   * Ids are numbered within their own sentence, which is all this needs: a cut
   * is only ever sought inside one. */
  readonly ids: readonly number[];
  /** A `<br>`. Not a token, but a place a cut may not be pushed past — see
   * `settledCut`. */
  readonly breaks: boolean;
}

/** Where a cut actually lands, having been found at `at`.
 *
 * A cut is pushed forward over children that put nothing the *other* panel
 * answers to on the page, which keeps the marks of punctuation and the
 * sentence separator that trail a token on the page that token is on, where
 * they belong — a 。 at the head of a page is 行頭禁則 broken by the pagination
 * itself. It stops at a `<br>`: a source line break belongs to the line it
 * starts, and so does the 一字下げ behind it.
 *
 * `paired` is the tokens both panels write (see `pairedCuts`); a child holding
 * only ids outside it is a child the other panel has no counterpart for, so
 * pushing past it cannot change which tokens are on which side of the cut and
 * the cut is still the cut it was found to be. Undefined where there is no
 * other panel and every id counts. */
function settledCut(units: readonly CutUnit[], at: number, paired?: ReadonlySet<number>): number {
  const carries = (unit: CutUnit) => unit.ids.some((id) => paired === undefined || paired.has(id));
  let cut = at;
  while (cut < units.length && !carries(units[cut]) && !units[cut].breaks) cut += 1;
  return cut;
}

/** **The cuts a sentence may be broken at**, as pairs of positions among the
 * two panels' top-level children.
 *
 * A position is a cut when the tokens written before it in the kundoku column
 * are exactly the tokens written before it in the prose — which is the whole
 * of what "the same point in the text" can mean between two panels that write
 * the same sentence in different orders.
 *
 * Worked from the order the two panels *introduce* the tokens in. Write
 * `a1..aT` for the ids in the order the kundoku column first writes them and
 * `b1..bT` for the prose's order; the prefixes `{a1..ac}` and `{b1..bc}` are
 * the same set exactly when every one of `a1..ac` stands within the first `c`
 * of `b`, which is `max(position in b) === c`. One pass, tracking that
 * maximum. 不読書 gives a = 不読書 and b = 書読不, so the maximum stands at 2
 * (書's place in b) from the first character on, against a `c` that runs 0, 1 —
 * it never agrees, and only the whole sentence qualifies. Which is right:
 * there is no way to divide 不読書 across a page break that leaves both panels
 * saying the same thing.
 *
 * ── Only the tokens both panels write are asked about ────────────────────
 * A token can reach one panel and not the other, and neither of the two ways
 * that happens is a reason to refuse the sentence a cut:
 *
 *  - **A mark the prose drops.** The kundoku column writes a cell for every
 *    PUNCT token; the generator writes one only where `medialPunctuation`
 *    gives it something to write (generator.ts), so a mark it renders as
 *    nothing has an id above and no piece below.
 *  - **A cell borrowed from the next sentence.** `glueOpeningPunctForward`
 *    moves an opening bracket at the end of one sentence into a
 *    `.no-break-unit` with the first unit of the *next* one, and the wrapper
 *    stays in the first sentence's span — so a kundoku sentence can carry a
 *    cell whose id belongs to its neighbour, and ids are numbered per sentence.
 *
 * Such a token constrains nothing: it is a single child sitting between two
 * that *are* paired, so wherever the cuts around it fall it goes to the page
 * its neighbours are on. So the orders are taken over the tokens the two
 * panels have in common, and a token only one of them writes is left where it
 * stands. What is still refused is a sentence with nothing in common at all,
 * which answers with no cuts and is dealt whole — the behaviour the deal had
 * for every sentence before this function existed. Erring towards what cannot
 * put the panels out of step is the whole design here. */
export function pairedCuts(
  kundoku: readonly CutUnit[],
  prose: readonly CutUnit[],
): { kundoku: number; prose: number }[] {
  const introduce = (units: readonly CutUnit[], keep?: ReadonlySet<number>): { order: number[]; at: number[] } => {
    const order: number[] = [];
    const at: number[] = [];
    const seen = new Set<number>();
    units.forEach((unit, index) => {
      for (const id of unit.ids) {
        if (seen.has(id) || (keep !== undefined && !keep.has(id))) continue;
        seen.add(id);
        order.push(id);
        at.push(index);
      }
    });
    return { order, at };
  };
  const shared = (units: readonly CutUnit[]): Set<number> => {
    const ids = new Set<number>();
    for (const unit of units) for (const id of unit.ids) ids.add(id);
    return ids;
  };
  const inKundoku = shared(kundoku);
  const inProse = shared(prose);
  const both = new Set([...inKundoku].filter((id) => inProse.has(id)));
  const k = introduce(kundoku, both);
  const p = introduce(prose, both);
  const positionInProse = new Map(p.order.map((id, index) => [id, index]));
  const cuts: { kundoku: number; prose: number }[] = [];
  let reach = -1;
  // `c` runs to the second-to-last id: the whole sentence is a boundary the
  // deal already has, and offering it as a cut would make an empty piece of it.
  for (let c = 0; c < k.order.length - 1; c++) {
    // Present by construction: both orders were filtered to the ids the two
    // panels have in common.
    reach = Math.max(reach, positionInProse.get(k.order[c])!);
    if (reach !== c) continue;
    // The prefix has to be a *boundary between children*, and one child can
    // introduce several tokens: a `.compound-group` is one child holding a
    // whole compound, and `appendPunct` nests a mark inside the
    // `.no-break-unit` of the character before it. Where the next token is
    // written by the same child as this one, there is no boundary here to cut
    // at — the page would have to take the child in half — and the prefix on
    // the page is the child's whole contents, not the tokens counted so far.
    if (k.at[c + 1] === k.at[c] || p.at[c + 1] === p.at[c]) continue;
    cuts.push({
      kundoku: settledCut(kundoku, k.at[c] + 1, both),
      prose: settledCut(prose, p.at[c] + 1, both),
    });
  }
  return cuts;
}

/** The cuts for a kundoku band with no prose band to pair with — the reader
 * having shut the 書き下し文 panel, which is a state this layout prints as it
 * finds (see `showKakikudashi`).
 *
 * With nothing to keep in step, every character is a place the two orders
 * trivially agree, so the cuts are what `pairedCuts` would find if every token
 * were paired: after each child that writes one, settled forward over what
 * writes none. Which is not the same as "every boundary" — a `<br>` still
 * belongs to the line it starts and an indent to the line it indents, so a
 * page never ends between a break and the text it introduces. */
export function unpairedCuts(units: readonly CutUnit[]): { kundoku: number; prose: number }[] {
  const cuts: { kundoku: number; prose: number }[] = [];
  for (let at = 0; at < units.length; at++) {
    if (units[at].ids.length === 0) continue;
    const cut = settledCut(units, at + 1);
    // The sentence's own end is a boundary the deal already has; offering it
    // again would make a piece with nothing in it.
    if (cut < units.length) cuts.push({ kundoku: cut, prose: cut });
  }
  return cuts;
}

/** **How much of the text a page holds.** Answers with the last piece that
 * fits, given a page already holding whatever it holds.
 *
 * `fitsThrough(last)` is the only thing here that needs a layout engine: it
 * puts exactly the pieces `from..last` on the page and answers whether the
 * page still fits, `last < from` meaning none of them. Adding text can only
 * lengthen a band, so the answer is monotone in `last` and the search is a
 * bisection — one probe for the common case where the whole remainder fits,
 * and about `log2` of the sentence's pieces where it does not. That matters:
 * every probe is a write to the DOM followed by a read of it, which is a
 * forced synchronous layout of the page.
 *
 * On return the page holds exactly `from..through`, `fitsThrough` having been
 * called last with the answer.
 *
 * `spills` is the one case the deal cannot solve by breaking: a single piece
 * that does not fit an empty page. It is kept there — there is nowhere better
 * for it to go — and the page is finished, so the *next* piece opens a new one
 * rather than finding a band that is already over its width and being pushed
 * off it. That distinction is the whole of the bug this replaced: asking "is
 * this band overflowing" rather than "did this piece overflow it" turned one
 * over-long sentence into one sentence per page for the rest of the document.
 *
 * Pure, in the way `matchedDivision` (KakikudashiView.ts) is: the measurement
 * is a parameter, and what is left is the decision. */
export function pageThrough(
  from: number,
  total: number,
  pageIsEmpty: boolean,
  fitsThrough: (last: number) => boolean,
): { through: number; spills: boolean } {
  /** The last thing asked, so that leaving the page in the state the answer
   * describes costs nothing where the search ended there anyway — which is
   * about half the time, the bisection's last probe being the answer whenever
   * it ended by finding a fit. */
  let asked = Number.NaN;
  const probe = (last: number): boolean => {
    asked = last;
    return fitsThrough(last);
  };
  const settle = (last: number): void => {
    if (asked !== last) fitsThrough(last);
  };

  // The whole remainder, first: on all but the last page of a sentence this is
  // the only probe, and on a document of ordinary sentences it is the only
  // probe there is.
  if (from >= total || probe(total - 1)) return { through: total - 1, spills: false };
  // `from - 1` is the page as it already stands, which fits by induction —
  // the deal never leaves an overflowing page open. `total - 1` has just been
  // shown not to.
  let fits = from - 1;
  let over = total - 1;
  while (over - fits > 1) {
    const mid = fits + Math.floor((over - fits) / 2);
    if (probe(mid)) fits = mid;
    else over = mid;
  }
  if (fits < from && pageIsEmpty) {
    // Alone on a page of its own and still too long. It stays, and the page is
    // done with.
    settle(from);
    return { through: from, spills: true };
  }
  settle(fits);
  return { through: fits, spills: false };
}

/** True once a band's content has grown wider than the page allows — i.e.
 * the text in it no longer fits on one sheet. In vertical-rl the text
 * advances along the *horizontal* axis, so it is `scrollWidth` that reports
 * how far the columns have marched, not `scrollHeight`. */
function overflows(band: HTMLElement): boolean {
  return band.scrollWidth > band.clientWidth + 1;
}

/** How far one character advances *down* a column of this box — the quantity
 * a band's height is a whole number of.
 *
 * Two different sums, because the two panels space their characters by
 * different means and each has to be asked in its own terms. The prose sets a
 * `letter-spacing` on the column, so its advance is the character plus that
 * (`heldSlots` in KakikudashiView.ts divides by the same sum, and says why it
 * reads the layout rather than re-deriving the fit). The kundoku panel cannot:
 * spacing there is a `margin-bottom` on `.kanji-cell`, because an annotation
 * must never be able to widen the gap (kunten.css's rule 1), so `letter-spacing`
 * computes to `normal` and the gap has to come from `--kanji-gap-ratio` — a
 * bare number precisely so that script can read it, which typography.css says
 * where it declares it.
 *
 * Measured off the band rather than written down, so that the page follows the
 * type scale: today it comes to 88px and 25.3px, which is what the heights
 * above are worked out in.
 *
 * **The advance the type is drawn at**, which is the one the heights are
 * chosen from and the one the match is made in. `filledKundokuAdvancePx`
 * stretches the kundoku advance afterwards and `makeBand` writes the result
 * onto the band as `--kanji-gap`; this is not asked again after that, and
 * would not see it if it were — the ratio is read off `:root`, where the
 * stretch is deliberately not written (only the bands are stretched, and only
 * the ones on paper). The trial bands `planBands` measures carry no override,
 * so what they answer is `:root`'s own scale, which is what is wanted. */
function advanceDown(column: HTMLElement, spacedByMargin: boolean): number {
  const style = getComputedStyle(column);
  const size = parseFloat(style.fontSize);
  if (!(size > 0)) return 0;
  if (spacedByMargin) {
    const ratio = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kanji-gap-ratio"));
    return size * (1 + (Number.isFinite(ratio) ? ratio : 1));
  }
  const tracking = parseFloat(style.letterSpacing);
  return size + (Number.isFinite(tracking) ? tracking : 0);
}

/** The spacing a stretched kundoku band is set with, from
 * `filledKundokuAdvancePx`. Omitted on the trial bands `planBands` measures,
 * which are asked about the type as it is *drawn*. */
interface KundokuSpacing {
  gapPx: number;
  advancePx: number;
}

function makeBand(
  kind: "kundoku" | "kakikudashi",
  heightMm: number,
  proseAdvancePx: number,
  kundokuSpacing?: KundokuSpacing,
): {
  band: HTMLElement;
  column: HTMLElement;
} {
  const band = document.createElement("div");
  band.className = `print-band print-band-${kind} tategaki`;
  band.style.width = `${PAGE_CONTENT_WIDTH_MM}mm`;
  band.style.height = `${heightMm.toFixed(3)}mm`;
  // ── The box, pinned in both media ────────────────────────────────────
  // Inline rather than in print.css, so that the band measured here on screen
  // and the band printed are the same box — see the head of this file for what
  // it cost while they were not. `.tategaki`'s own padding is what is being
  // overridden: 55px at the head of a column and 44px at each side, which are
  // insets for a panel a reader scrolls, not for a band the page's own margin
  // already surrounds.
  band.style.padding = "0";
  // `overflow: hidden` and not `.tategaki`'s `overflow-x: auto`: a scroll
  // container would put a horizontal scrollbar under the band on a platform
  // that draws them, and a horizontal scrollbar takes its thickness out of the
  // band's *height* — which under vertical-rl is the length of every column,
  // so the band would be measured holding one character fewer than it prints.
  // Hidden is also what keeps a band that still overflows from painting over
  // the band below; `spreadSpill` is what stops that clipping losing text.
  band.style.overflow = "hidden";
  // Both finite, or neither written: the gap is `advance - fontSize`, and a
  // document with no stylesheet applied yet answers that with a NaN. A NaN in
  // an inline style is dropped by the parser and the band would inherit the
  // drawn gap under a stretched height — the old dead foot, quietly. Better to
  // be the old behaviour on purpose than by accident.
  if (kind === "kundoku" && kundokuSpacing && Number.isFinite(kundokuSpacing.gapPx)) {
    // ── The stretched gap, written where the whole subtree can see it ──────
    // `--kanji-gap` and not `--kanji-gap-ratio`, and the two of them and not
    // one. A custom property is substituted at the element that *declares* it,
    // so typography.css's `--kanji-gap: calc(var(--size-main) *
    // var(--kanji-gap-ratio))` has already resolved against `:root`'s ratio by
    // the time a band inherits it — overriding the ratio here would change
    // nothing at all. `--kanji-advance` is declared from the gap at `:root`
    // for the same reason and has to be rewritten alongside it, or the two
    // would disagree inside this band.
    //
    // What reads them below, and what each does with the larger number:
    //
    //  - `.kanji-cell`'s `margin-bottom` (kunten.css) — the advance itself,
    //    and the whole point of this. Under vertical-rl that margin is at the
    //    *inline* end, which is why the spacing lives there; nothing across
    //    the columns moves, so `--column-pitch` and the page's column count
    //    are untouched.
    //  - `.indent-cell`'s `margin-bottom` (kunten.css) — which reads the same
    //    declaration precisely so that an indent measures what a character
    //    measures. It follows this by construction.
    //  - `.punct-cell`'s two margins (kunten.css) — which sum to `-1/2em`
    //    with the gap cancelling out, so a mark still costs the line nothing
    //    and still hangs from the foot of the character before it, whatever
    //    the gap is.
    //  - the tie line's repeating gradient under a `.compound-group`
    //    (kunten.css) — ink for one gap, clear for one character, period one
    //    advance. Both terms are overridden here, so the bands still land on
    //    the gaps. Its `top`/`bottom` are written by `positionCompoundLines`
    //    from measured rects further down this file, so the `calc()` fallback
    //    beside them is not in play.
    //  - `.tategaki`'s own `padding` shorthand (tategaki.css), which the
    //    inline `padding: 0` above already beats.
    //
    // Nothing else in a band reads either property, and nothing that places an
    // annotation does: the kaeriten and the readings are out of flow and
    // positioned against `.kanji-glyph`'s own edges (kunten.css's rule 1), so
    // a wider lane is only ever more room for them. **Read off the stylesheets
    // rather than seen — there is no browser here.**
    band.style.setProperty("--kanji-gap", `${kundokuSpacing.gapPx.toFixed(3)}px`);
    band.style.setProperty("--kanji-advance", `${kundokuSpacing.advancePx.toFixed(3)}px`);
  }
  if (kind === "kakikudashi") {
    // Room for a 、 or 。 at a column's foot to hang into — ぶら下げ, the same
    // as on screen, where the room is the panel's own inset (see
    // `.kakikudashi-panel .tategaki` in tategaki.css, which is where the whole
    // decision is written down). A mark hung off a band with no padding is a
    // mark cut in half at the band's edge, `overflow: hidden` clipping at the
    // padding box. Under vertical-rl this is the inline end, which is the foot
    // of every column.
    //
    // Exactly one prose advance, which is the glyph plus the tracking — a
    // hanging mark is one advance long and no longer. It was
    // `calc(var(--size-kakikudashi) * 1.15)` in print.css, which is the same
    // number said as a multiplier of the glyph, the 0.15 being the tracking a
    // band falls back to (`--tracking-kakikudashi` is published as an inline
    // style on `#kakikudashi-view`, and a band is not inside it — no fit ever
    // runs on one). This is the advance the band's own column was *measured*
    // at, so it stays the right number if either half of that sum ever moves.
    //
    // `bandHeightsMm` has already counted it into the height, so what the
    // columns are set in is the whole number of characters the band was
    // chosen for.
    band.style.paddingBottom = `${proseAdvancePx}px`;
  }

  const column = document.createElement("div");
  column.className = `tategaki-column ${kind === "kundoku" ? "text-main" : "text-kakikudashi"}`;
  // The band's own height is the vertical-rl *inline* size, so the column
  // must inherit it rather than size to content, or the text would run in
  // one long line instead of wrapping into page-height columns.
  column.style.height = "100%";
  band.append(column);
  return { band, column };
}

/** One piece of a sentence: the children of its `.sentence-gap` in each panel
 * that go on a page together. A whole sentence where it has no cuts. */
interface Piece {
  kundoku: ChildNode[];
  prose: ChildNode[];
}

/** What a `.sentence-gap`'s top-level children put on the page, for the cut
 * finder. The DOM half of `CutUnit`. */
function cutUnitsOf(children: readonly ChildNode[]): CutUnit[] {
  return children.map((node) => {
    if (!(node instanceof HTMLElement)) return { ids: [], breaks: false };
    if (node.tagName === "BR") return { ids: [], breaks: true };
    const ids: number[] = [];
    const take = (el: HTMLElement) => {
      const id = el.dataset.tokenId;
      if (id !== undefined) ids.push(Number(id));
    };
    take(node);
    for (const inner of node.querySelectorAll<HTMLElement>("[data-token-id]")) take(inner);
    return { ids, breaks: false };
  });
}

/** A sentence divided into the pieces the deal may put on different pages. */
function piecesOf(kundoku: readonly ChildNode[], prose: readonly ChildNode[], paired: boolean): Piece[] {
  const cuts = paired ? pairedCuts(cutUnitsOf(kundoku), cutUnitsOf(prose)) : unpairedCuts(cutUnitsOf(kundoku));
  const pieces: Piece[] = [];
  let fromK = 0;
  let fromP = 0;
  for (const cut of cuts) {
    pieces.push({ kundoku: kundoku.slice(fromK, cut.kundoku), prose: prose.slice(fromP, cut.prose) });
    fromK = cut.kundoku;
    fromP = cut.prose;
  }
  pieces.push({ kundoku: kundoku.slice(fromK), prose: prose.slice(fromP) });
  return pieces;
}

/** Rebuilds `#print-root` from what the two panels currently show. Safe to
 * call repeatedly; each call replaces the previous layout.
 *
 * Driven off `beforeprint`, which covers every route to paper: the button
 * (`window.print()` fires it), a plain Ctrl+P, and headless export —
 * Chromium's `Page.printToPDF` dispatches it too (verified: exports with
 * and without a hand-fired `beforeprint` came out byte-identical). */
export function buildPrintLayout(kundokuView: HTMLElement, kakikudashiView: HTMLElement): void {
  document.getElementById(ROOT_ID)?.remove();

  const kundokuSentences = [...kundokuView.querySelectorAll<HTMLElement>(".tategaki-column > .sentence-gap")];
  // A hidden kakikudashi panel stays hidden on paper: printing what the
  // reader has switched off would be a surprise, and pairing bands is the
  // only reason this layout exists at all.
  const showKakikudashi = !document.querySelector("#app")?.classList.contains("kakikudashi-collapsed");
  const kakiSentences = showKakikudashi
    ? [...kakikudashiView.querySelectorAll<HTMLElement>(".tategaki-column > .sentence-gap")]
    : [];
  if (kundokuSentences.length === 0) return;

  // **Verse, read once off the live panel.** The same dataset
  // `renderKakikudashiView` wrote — `VERSE_ATTRIBUTE`, `RIME_FLOOR_ATTRIBUTE`
  // — and the same two facts `applyLinePadding`/`fitPassageExtent` read them
  // for on screen, kept apart for the reason `planBands`' own parameter note
  // gives: a poem can carry the first without the second. Read before any
  // clone is made, so `planBands` and the padding pass after it agree about
  // which text this is without either re-deriving it from the tree.
  const kakiColumnLive = kakikudashiView.querySelector<HTMLElement>(":scope > .text-kakikudashi");
  const verse = kakiColumnLive?.dataset[VERSE_ATTRIBUTE] !== undefined;
  const verseRimeFloor = Number(kakiColumnLive?.dataset[RIME_FLOOR_ATTRIBUTE] ?? 0);

  const root = document.createElement("div");
  root.id = ROOT_ID;
  document.body.append(root);
  // **Before anything is measured.** `planBands` reads the advances off trial
  // bands inside this root, so the scale has to be standing before it looks.
  applyPrintTypeScale(root, PRINT_TYPE_SCALE);

  const plan = planBands(root, kundokuSentences, kakiSentences, showKakikudashi, verse, verseRimeFloor);

  let kundokuColumn: HTMLElement | null = null;
  let kakiColumn: HTMLElement | null = null;
  let kundokuBand: HTMLElement | null = null;
  let kakiBand: HTMLElement | null = null;

  const startPage = () => {
    const page = document.createElement("section");
    page.className = "print-page";
    const k = makeBand("kundoku", plan.kundokuHeightMm, plan.proseAdvancePx, plan.kundokuSpacing);
    kundokuBand = k.band;
    kundokuColumn = k.column;
    if (showKakikudashi) {
      const g = makeBand("kakikudashi", plan.proseHeightMm, plan.proseAdvancePx);
      kakiBand = g.band;
      kakiColumn = g.column;
      page.append(k.band, g.band);
    } else {
      kakiBand = null;
      kakiColumn = null;
      page.append(k.band);
    }
    root.append(page);
    onPage.length = 0;
    held = -1;
    shells.clear();
  };

  /** The prose a set of detached nodes would put on the page. `proseFlow`
   * is stated against `FlowNode` and not against the DOM's own types (see
   * its note), so a plain object standing for a span is a thing it will
   * walk — which is what lets a piece still in hand be read without being
   * placed. */
  const flowTextOf = (nodes: readonly ChildNode[]): string =>
    proseFlow({ nodeType: 1, nodeName: "SPAN", childNodes: nodes as unknown as ArrayLike<never> }).text;

  // ── Every sentence cloned and cleaned, before any piece is cut ───────────
  //
  // Cloned **up front** rather than one sentence at a time, which is what
  // makes the ledger below possible: a page that gives text back has to be
  // able to hand pieces of an *earlier* sentence to the next page, and the
  // old loop had thrown that sentence's clone away by then. The cost is one
  // clone of the document held while the pages are dealt, which is the same
  // thing `planBands` has just done twice over to measure the two extents.
  //
  // Cutting into pieces is now a second pass, below — the correspondence a
  // poem's prose needs (`verseLinePadding`) has to see a whole sentence's
  // flow intact, and a piece cut here would have already lost the boundary a
  // pad's `<br>` needs to land on.
  const cleaned = kundokuSentences.map((sentence, i) => {
    const kundokuClone = sentence.cloneNode(true) as HTMLElement;
    const kakiSentence = showKakikudashi ? kakiSentences[i] : undefined;
    const kakiClone = kakiSentence?.cloneNode(true) as HTMLElement | undefined;
    // The screen panel's hanging marks come across with the clone, and they
    // were chosen for the screen's column length. Stripped here rather than
    // after the pages are dealt, because a mark whose advance has been given
    // back shortens the band it is in, and the fit test below is a measurement
    // of exactly that. Before the children are read off, too: `clearHangingMarks`
    // normalises, which merges the text nodes a hang had split. It also takes
    // this panel's own `LINE_PAD_CLASS`/clause-break `<br>`s back off — a
    // verse clone otherwise carries the *screen's* padding, planned for a
    // `.main` this sheet knows nothing about, straight into the pass below
    // that is about to plan the sheet's own.
    if (kakiClone) clearHangingMarks(kakiClone);
    // ── No page is printed with a selection on it ────────────────────────
    // The reader wants every annotation on paper in the text's own ink (see
    // print.css), and the interaction states are where the apparatus keeps
    // its *other* colours: `.token-cell-selected rt` repaints a selected
    // reading in `--color-highlight` and at weight 900 (kunten.css), the
    // inspection head box paints in `--color-accent`, a drag source in the
    // same. print.css neutralises one of them — `.token-cell-selected
    // .kanji-glyph` — and reached none of the annotations, so a reader who
    // left a character selected on screen printed that character's reading
    // blue and bold on an otherwise one-ink page.
    //
    // Chased property by property this needs one print rule per thing a
    // selection touches, and a new one whenever the screen grows another.
    // Taken off the clone it needs none: these are transient interaction
    // state written by tokenInspector.ts, nothing structural reads them, and
    // a print clone has no interaction to be in the middle of. The
    // inspector's own arc needs nothing either — it lives in the overlay,
    // which print.css hides, and is not inside a `.sentence-gap` to be cloned.
    for (const clone of [kundokuClone, kakiClone]) {
      if (!clone) continue;
      for (const marked of [clone, ...clone.querySelectorAll<HTMLElement>("[class]")]) {
        marked.classList.remove(
          "token-cell-selected",
          "token-cell-head",
          "token-drop-target",
          "token-drag-source",
          "kaki-token-selected",
        );
      }
    }
    return { kundokuClone, kakiClone };
  });

  // ── The correspondence, for a poem — planned once, across the whole flow,
  // before any of it is cut into pieces ────────────────────────────────────
  //
  // `verseLineCentering` asks of the print band's own counts exactly what
  // `applyLinePadding` asks of the screen's — `planLineCentering`
  // (KakikudashiView.ts), unchanged — and needs the same thing that function
  // does: the *whole* prose flow, not one sentence's, because a line's own
  // block is measured against where the line before it actually ends, and
  // that end is not known until the whole flow has been walked.
  //
  // **A line is not a sentence, on paper any more than it is on screen.**
  // 春望's own couplets are the proof (see `verseLineCentering`'s own note): a
  // `.sentence-gap` can hold two of the poem's lines, joined by a `LineBreak`
  // with no sentence boundary at it, so the pad before line `n` cannot simply
  // be written at the head of clone `n`. It goes, instead, exactly where
  // `applyLinePadding` puts it on screen — immediately after the `<br>` that
  // begins line `n` — found the identical way that function finds it:
  // `clearHangingMarks` has already taken every panel-inserted `<br>` back
  // off each clone, so *every* `<br>` still standing in one is the source's
  // own, collected across all of them in document order.
  if (plan.verse && showKakikudashi) {
    const proseText = cleaned.map(({ kakiClone }) => (kakiClone ? flowTextOf([...kakiClone.childNodes]) : "")).join("");
    const { padColumns, shiftHalfColumn } = verseLineCentering(proseText, plan.proseSlots);
    const kakiClones = cleaned.map(({ kakiClone }) => kakiClone).filter((c): c is HTMLElement => c !== undefined);
    const breaks = kakiClones.flatMap((clone) => [...clone.querySelectorAll<HTMLElement>("br")]);
    // The prose *column* pitch — the block-axis spacing the half-column
    // nudge below is stated in — measured with the same probe
    // `applyPrintTypeScale` itself takes of this exact property, not read
    // back with `getPropertyValue("--column-pitch-kakikudashi")` directly.
    // Two reasons, not one. `customProperties.test.ts` is the guard the
    // direct read would have failed: typography.css declares the property
    // as `calc(var(--column-pitch) / 2)`, unregistered, so a plain
    // `getPropertyValue` of it computes to the literal text of the `calc()`
    // and `parseFloat` of that is `NaN` — true even where `applyPrintTypeScale`
    // has also written the property as a resolved inline style on `root`,
    // because that only wins the cascade for an element that inherits from
    // `root`, and a `kakiClone` at this point in the deal never has been
    // appended anywhere — it is still the detached tree `cleaned` built it
    // as, with no ancestor to inherit the override from at all. `font-size:
    // var(...)`, read back off a probe standing inside `root`, is what
    // `applyPrintTypeScale`'s own note gives for exactly this trap: `font-size`
    // is an ordinary, well-known CSS property the browser always resolves to
    // a pixel length, whatever unregistered custom property fed it.
    const pitchProbe = document.createElement("div");
    pitchProbe.style.position = "absolute";
    pitchProbe.style.visibility = "hidden";
    pitchProbe.style.fontSize = "var(--column-pitch-kakikudashi)";
    root.append(pitchProbe);
    const proseColumnPitchPx = parseFloat(getComputedStyle(pitchProbe).fontSize);
    pitchProbe.remove();
    // **Why a line's run can cross more than one clone, on paper in a way
    // screen's single live `column` never has to.** Each `cleaned` entry is
    // its own detached tree, and 春望's own shape uses exactly that: its
    // title and its poet are each a whole `.sentence-gap` to themselves, so
    // line 0's run is the *entire* first clone and line 1's the entire
    // second, with no partial boundary in either. `shiftLineAcrossClones`
    // walks whichever clones a line's own `[from, to)` touches — the plain
    // `shiftLineRun` case where both ends fall in one clone, that same
    // function asked of a whole clone's own root (`null` at both ends)
    // where a line owns it outright, and `shiftLineRun` again for a
    // partial clone at either edge of a run spanning several.
    const shiftLineAcrossClones = (from: ChildNode | null, to: ChildNode | null, shiftPx: number): void => {
      const indexOf = (node: ChildNode): number => kakiClones.findIndex((clone) => clone.contains(node));
      const fromIndex = from ? indexOf(from) : 0;
      const toIndex = to ? indexOf(to) : kakiClones.length - 1;
      if (fromIndex === -1 || toIndex === -1) return;
      if (fromIndex === toIndex) {
        shiftLineRun(kakiClones[fromIndex], from, to, shiftPx);
        return;
      }
      shiftLineRun(kakiClones[fromIndex], from, null, shiftPx);
      // A whole clone the line owns outright — 春望's own title and poet are
      // each one, a couplet's first line never is — walked start to end
      // through the same `shiftLineRun`, not set directly: `transform` has
      // no visual effect on the `display: inline` nodes a clone holds (see
      // that function's own note), and `shiftLineRun` is what already knows
      // to reach for `position: relative; left` instead.
      for (let i = fromIndex + 1; i < toIndex; i++) {
        shiftLineRun(kakiClones[i], null, null, shiftPx);
      }
      shiftLineRun(kakiClones[toIndex], null, to, shiftPx);
    };
    let cursor: ChildNode | null = null;
    // **Cumulative, not per-line** — see `applyLinePadding`'s own note
    // (KakikudashiView.ts) on why: a `transform` moves ink and nothing
    // else, so a line's own nudge leaves every line after it a half column
    // out of true unless each carries the running total rather than only
    // its own. Found as a real Chrome measurement of 春望 growing by a half
    // prose column at every line the reader's own eye would call centred.
    let halfColumns = 0;
    for (let line = 0; line < padColumns.length; line++) {
      const nextBreak: ChildNode | null = breaks[line] ?? null;
      let insertAfter: ChildNode | null = cursor;
      for (let n = 0; n < padColumns[line]; n++) {
        // Layout, never text — the same discipline `applyLinePadding`'s own
        // note states and for the same reason: a plain `<br>`, not a
        // full-width space in the flow, so nothing this reaches
        // (`generateKakikudashiForTree`'s string, either ratchet) can see it.
        const blank = document.createElement("br");
        if (insertAfter) insertAfter.parentNode?.insertBefore(blank, insertAfter.nextSibling);
        else kakiClones[0]?.insertBefore(blank, kakiClones[0].firstChild);
        insertAfter = blank;
      }
      if (shiftHalfColumn[line]) halfColumns++;
      if (halfColumns > 0 && proseColumnPitchPx > 0) {
        shiftLineAcrossClones(insertAfter, nextBreak, -halfColumns * (proseColumnPitchPx / 2));
      }
      cursor = nextBreak;
    }
  }

  // ── Every sentence cut into its pieces ────────────────────────────────────
  const dealt = cleaned.map(({ kundokuClone, kakiClone }) => {
    const pieces = piecesOf(
      [...kundokuClone.childNodes],
      kakiClone ? [...kakiClone.childNodes] : [],
      kakiClone !== undefined,
    );
    // Read once, while every piece is still whole and detached. A piece's text
    // never changes — the deal only moves its nodes between shells — so the
    // widow walk below can ask what a page would hand on without walking the
    // document again at every probe.
    const text = pieces.map((piece) => flowTextOf(piece.prose));
    return { kundokuClone, kakiClone, pieces, text, whole: text.join("") };
  });

  // ── The page's ledger ────────────────────────────────────────────────────
  //
  // **What the reader's second report came down to.** The deal used to hold
  // one sentence at a time, so `flushThrough` was bounded below by the first
  // piece of the sentence straddling the page's foot — one to three candidates,
  // measured — and the two rules layered on it had almost nothing to choose
  // between. Everything above that piece on the sheet had been placed by
  // earlier sentences whose shells the loop no longer held.
  //
  // `onPage` is those sentences, kept: every piece the page holds, in the order
  // it was placed, across every sentence it spans. A cut is an index into it,
  // so the walk may give back to the head of the page — about thirty-three
  // candidates on the shipped scale — and a page closed at a sentence boundary
  // is a page the rules now reach, which is the ~4% that had been priced and
  // declined.
  //
  // Nothing about *what* may be cut has moved. Every entry is a piece boundary
  // `pairedCuts` offered, and a boundary between two sentences is one both
  // panels agree on trivially, so the paired-cut invariant holds by
  // construction exactly as it did.
  interface Placed {
    /** Which sentence of `dealt`. */
    at: number;
    /** Which of its pieces. */
    piece: number;
  }
  const onPage: Placed[] = [];
  /** How far down `onPage` the DOM currently stands. Everything after it has
   * been taken back off the page and is waiting to be put down again or handed
   * to the next sheet. */
  let held = -1;
  /** The `.sentence-gap` shell each sentence has on *this* page — one per
   * panel. A sentence divided across a break gets a shell on each page it
   * reaches, which is what `.sentence-gap`'s rules in kunten.css and the two
   * panels' shared structure are written against. */
  const shells = new Map<number, { kundoku: HTMLElement; kaki: HTMLElement | null }>();

  const shellFor = (at: number) => {
    const known = shells.get(at);
    if (known) return known;
    // `cloneNode(false)` keeps its attributes and takes none of its children.
    const kundoku = dealt[at].kundokuClone.cloneNode(false) as HTMLElement;
    kundokuColumn!.append(kundoku);
    const kaki = dealt[at].kakiClone ? (dealt[at].kakiClone!.cloneNode(false) as HTMLElement) : null;
    if (kaki) kakiColumn!.append(kaki);
    const made = { kundoku, kaki };
    shells.set(at, made);
    return made;
  };
  const putDown = (entry: Placed) => {
    const shell = shellFor(entry.at);
    const piece = dealt[entry.at].pieces[entry.piece];
    shell.kundoku.append(...piece.kundoku);
    shell.kaki?.append(...piece.prose);
  };
  const takeBack = (entry: Placed) => {
    const piece = dealt[entry.at].pieces[entry.piece];
    for (const node of piece.kundoku) node.remove();
    for (const node of piece.prose) node.remove();
  };
  /** Leaves the page holding exactly `onPage[0..k]`. */
  const holdThrough = (k: number) => {
    while (held > k) {
      takeBack(onPage[held]);
      held -= 1;
    }
    while (held < k) {
      held += 1;
      putDown(onPage[held]);
    }
  };
  /** The shells a give-back emptied come off, so that a page carries a
   * `.sentence-gap` only for the sentences it actually shows. Both panels are
   * asked separately: a piece can be a mark the prose renders as nothing, so
   * one shell can be empty while its pair is not. */
  const dropEmptyShells = () => {
    for (const shell of shells.values()) {
      if (shell.kundoku.childNodes.length === 0) shell.kundoku.remove();
      if (shell.kaki && shell.kaki.childNodes.length === 0) shell.kaki.remove();
    }
  };

  /** **What the page would hand on**, cut after `onPage[k]`: the prose from
   * there to the end of the block, which is the quantity a widow is measured
   * in.
   *
   * Gathered from the pieces after the cut — those still standing on the page,
   * which are about to be given to the next sheet, and then the sentences after
   * them — because a block is a run between two source line breaks and a
   * `.sentence-gap` is not one. A block routinely spans several sentences, and
   * on 酒蟲 it spans most of them.
   *
   * **Stopped early, twice over.** At the first newline, which is the end of
   * the block; and once enough characters have been seen to know the block is
   * longer than the threshold, since past that point the exact count cannot
   * change the answer. So this reads a column or two of text and not the rest
   * of the document, however long the block runs. */
  const enough = (WIDOW_ORPHAN_COLUMNS + 1) * plan.proseSlots;
  const remnantAfter = (k: number): string => {
    const cut = onPage[k];
    let text = "";
    for (let piece = cut.piece + 1; piece < dealt[cut.at].pieces.length; piece++) {
      text += dealt[cut.at].text[piece];
      if (text.includes("\n") || text.length >= enough) return text;
    }
    for (let next = cut.at + 1; next < dealt.length; next++) {
      text += dealt[next].whole;
      if (text.includes("\n") || text.length >= enough) return text;
    }
    return text;
  };

  /** ── Where the page is actually cut, now that a break follows ────────────
   *
   * The page is as full as it can be, and that is exactly the trouble on two
   * counts.
   *
   * **A complete last column in the prose band.** A paired cut is a boundary
   * between two of a sentence's children and nothing makes one fall at the foot
   * of a prose column, so the band ends part way down its last one. Worse, the
   * quantisation makes it systematic rather than unlucky — a sheet carries 55
   * kundoku cells against 138 prose characters, and at 2.41 characters to the
   * cell those 55 cells are 132.3 characters, so the *kundoku* band is the
   * binding one on every page and the prose stops around 21.75 of its 23
   * columns. The reader was shown the trade — about a tenth of the characters
   * on a sheet, and a complete last line bought with a *wider* blank strip at
   * the band's left edge — and chose the complete line.
   *
   * **A widow or an orphan**, which is `widowOrphanFree`'s subject.
   *
   * ── The priority order, and why it runs this way round ───────────────────
   * Flushness is what the reader asked for and saw; widow and orphan control is
   * a refinement on top of it. So the first choice is a cut that is both, and
   * where there is none the fix is to give up the *widow* rule and keep the
   * flush one — never the other way round. A page that ends mid-column is the
   * fault he reported first; trading it for a one-column remnant would be
   * undoing confirmed work to satisfy a rule added after it.
   *
   * Both walks are `flushThrough`'s: give back, never take more. So whichever
   * level answers, the cut is still one `pairedCuts` offered and still at or
   * above the head of the page — the paired-cut invariant and the walk's own
   * progress survive by construction rather than by argument.
   *
   * `k = 0` is the floor and not `-1`: a page always keeps the piece it was
   * opened for, which is what makes the walk below make progress and the deal
   * terminate. Returns the page-local index the page is left holding. */
  const settledPage = (): number => {
    const ceiling = onPage.length - 1;
    if (kakiColumn === null || ceiling < 0) return ceiling;
    /** What a candidate cut does to the page, measured once each. Every answer
     * here costs a forced layout, and the two walks below ask about the same
     * candidates in the same order, so the second is free. */
    const judged = new Map<number, { flush: boolean; tidy: boolean }>();
    const judge = (k: number): { flush: boolean; tidy: boolean } => {
      const known = judged.get(k);
      if (known) return known;
      holdThrough(k);
      // The whole band's flow, not one sentence's share of it: a column
      // boundary is counted from the top of the page, so where the last one
      // falls depends on everything already standing above.
      const shown = proseFlow(kakiColumn!).text;
      // The block this page begins, if it begins one, and the block it hands
      // on. `null` on either side means that fault cannot arise: nothing starts
      // here, or nothing is carried over.
      const begun = blockBegunIn(shown);
      const head = begun === null ? null : planHangingMarks(begun, plan.proseSlots).columns.length;
      const handed = blockHandedOn(remnantAfter(k));
      const tail = handed.text.length === 0 ? null : planHangingMarks(handed.text, plan.proseSlots).columns.length;
      const answer = {
        flush: endsColumnFlush(shown, plan.proseSlots),
        tidy: widowOrphanFree(head, tail, WIDOW_ORPHAN_COLUMNS),
      };
      judged.set(k, answer);
      return answer;
    };
    const both = flushThrough(0, ceiling, (k) => judge(k).flush && judge(k).tidy);
    return judge(both).flush && judge(both).tidy ? both : flushThrough(0, ceiling, (k) => judge(k).flush);
  };

  /** Closes the page at `cut`, hands what is left of it to the next sheet, and
   * answers where the deal carries on from. */
  const closeAt = (cut: number): Placed => {
    holdThrough(cut);
    onPage.length = cut + 1;
    dropEmptyShells();
    const last = onPage[cut];
    return last.piece + 1 < dealt[last.at].pieces.length
      ? { at: last.at, piece: last.piece + 1 }
      : { at: last.at + 1, piece: 0 };
  };

  startPage();

  // ── Dealing, as a cursor over (sentence, piece) rather than a loop over
  // sentences ─────────────────────────────────────────────────────────────
  // The cursor is what lets a page give text back: `closeAt` sets it to
  // whatever the page did not keep, which may be a piece of a sentence dealt
  // several turns ago, and the next page picks up from exactly there.
  let at = 0;
  let piece = 0;
  while (at < dealt.length) {
    const pieces = dealt[at].pieces;
    if (piece >= pieces.length) {
      at += 1;
      piece = 0;
      continue;
    }

    /** The page as it stands before any of this sentence goes down. */
    const base = onPage.length;
    const fitsThrough = (last: number): boolean => {
      const want = base + Math.max(0, last - piece + 1);
      while (onPage.length > want) {
        takeBack(onPage[onPage.length - 1]);
        onPage.pop();
        held -= 1;
      }
      while (onPage.length < want) {
        const entry = { at, piece: piece + (onPage.length - base) };
        onPage.push(entry);
        held += 1;
        putDown(entry);
      }
      return !overflows(kundokuBand!) && !(kakiBand !== null && overflows(kakiBand));
    };

    const { through, spills } = pageThrough(piece, pieces.length, base === 0, fitsThrough);

    if (spills) {
      // The one case the deal cannot solve by breaking: a single piece that
      // does not fit a page of its own. It is kept there — there is nowhere
      // better for it to go, and `spreadSpill` carries what overflows onto
      // continuation pages — and the page is finished, with nothing to give
      // back because it holds only this.
      piece = through + 1;
      dropEmptyShells();
      startPage();
      continue;
    }

    if (through === pieces.length - 1) {
      // The whole rest of this sentence went down and the page may still have
      // room. No break follows *here*, so neither rule is asked: the page is
      // not being closed, it is being carried on with.
      at += 1;
      piece = 0;
      continue;
    }

    // The page is full — either part of this sentence went down, or (where
    // `through < piece`) none of it did and the page was already full when the
    // sentence arrived. **Both are page breaks and both are settled the same
    // way**, which is the whole of what the ledger bought: the second used to
    // be the branch that reached neither rule.
    const next = closeAt(settledPage());
    at = next.at;
    piece = next.piece;
    startPage();
  }

  // The last page keeps whatever the text leaves it, no rule having been asked
  // of it: a passage ending part way down its final column is how prose ends,
  // and forcing it flush would spend a whole sheet to do it. `startPage` above
  // may also have opened a page the cursor then ran out on, which is the empty
  // one taken off here.
  const lastPage = root.lastElementChild;
  if (lastPage && lastPage.querySelector(".sentence-gap") === null) lastPage.remove();

  // A source line break at the head of a band is a break that has already
  // happened: the page turn is itself the start of a new column, and the `<br>`
  // would spend an empty one before the text began. Both bands are trimmed
  // independently and come to the same thing, a cut being taken *before* a
  // `<br>` in both panels at once (see `settledCut`).
  for (const column of root.querySelectorAll<HTMLElement>(".tategaki-column")) {
    const first = column.firstElementChild;
    if (!first) continue;
    let lead = first.firstChild;
    while (lead instanceof HTMLElement && lead.tagName === "BR") {
      lead.remove();
      lead = first.firstChild;
    }
  }

  // The connecting line under a compound is positioned from measured glyph
  // centres, and the clones carry the offsets measured against the
  // *screen* columns. Print columns are a different length, so a compound
  // can wrap at a different point here — re-measure against this layout
  // rather than trusting the inherited inline values.
  for (const column of root.querySelectorAll<HTMLElement>(".print-band-kundoku .tategaki-column")) {
    positionCompoundLines(column);
  }

  // And the hanging marks. The screen panel's own were stripped from each
  // clone as it was dealt (see `clearHangingMarks` above); these are the ones
  // a *print* column comes to, which is a different column from the panel's:
  // a 47.36mm band is 178.99px of box less 25.3px of hanging room, which holds
  // six characters at 25.3px each — and a different number at each of the
  // other four divisions `planBands` can choose between.
  //
  // A band goes through **no fit at all**: `fitPassageExtent` and
  // `fitColumnTracking` (KakikudashiView.ts) run on the live panel and are
  // never called on anything built here, so a band keeps the drawn 0.15em
  // (the fallback in `.text-kakikudashi`) and holds `floor(measure /
  // advance)` characters, which `bandHeightsMm` has made a whole number by
  // choosing the height. What the two share is the thing the model needs — a
  // *fixed* advance, the same for every character of the column — so the same
  // walk answers both, and `applyHangingMarks` reads the measure and the
  // tracking off whichever box it is handed rather than being told which case
  // it is in.
  //
  // After the pages are dealt rather than during: hanging can only make a band
  // shorter, never longer, so it cannot push a piece off a page that the
  // fit test has already accepted.
  for (const band of root.querySelectorAll<HTMLElement>(".print-band-kakikudashi")) {
    const column = band.querySelector<HTMLElement>(":scope > .tategaki-column");
    if (column) applyHangingMarks(band, column);
  }

  // Last, so that what it measures is the page as it will print — the hang
  // above shortens a band, and a band shortened back inside the sheet needs no
  // continuation at all.
  spreadSpill(root);
}

/** What the sheet is being divided into, chosen once for the document.
 *
 * ── Once, and not per page ───────────────────────────────────────────────
 * `r` — how many characters of prose a kanbun character comes to — is a
 * property of the text, and it barely moves within one: it is a fact about how
 * Literary Chinese is read into Japanese, not about which sentences happen to
 * land on page 4. A per-page split would therefore choose the same numbers on
 * almost every page and buy, on the few where it did not, a few characters of
 * fill — against a book whose frame changed height from page to page, which is
 * the one thing a reader would certainly notice.
 *
 * It is also not what keeps the two bands in step. The deal does that: a page
 * ends at a cut, and a cut is a place both panels have written the same
 * tokens. The heights decide how *full* each band is when the page ends — get
 * them wrong and one band is half empty on every page, which is what 103/75
 * was doing (the prose band came to less than half the kundoku band's length,
 * so every page was set by the kundoku band with the prose band running out
 * half way).
 *
 * ── Measured, not modelled ───────────────────────────────────────────────
 * The extents are read off real bands holding the whole text, for the reason
 * `passageExtent`'s callers give: the number of columns a passage comes to is
 * the browser's line breaking, and an arithmetic model of it runs about two
 * per cent short (`.text-kakikudashi` in typography.css records sixty-seven
 * columns measured against a modelled sixty-six). Six layouts: one kundoku
 * band and one prose band per candidate column length. */
interface BandPlan {
  kundokuHeightMm: number;
  /** Zero where there is no prose band on the page at all. */
  proseHeightMm: number;
  /** The hanging room a prose band is given, which `makeBand` spends as
   * `padding-bottom` and `bandHeightsMm` has already counted into the height
   * above. */
  proseAdvancePx: number;
  /** The characters a prose column holds — the count the match chose, which
   * `bandHeightsMm` turned into `proseHeightMm` above. Carried on the plan
   * because the deal needs it as a *number*: `endsColumnFlush` asks whether a
   * page's prose ends at the foot of a column, and a column is this many
   * characters long. Zero where there is no prose band at all. */
  proseSlots: number;
  /** The gap and advance a kundoku band's characters are set with, which is
   * the drawn pair stretched by whatever the sheet had left over — see
   * `filledKundokuAdvancePx`. `kundokuHeightMm` is this advance times the
   * slots the match chose, so the two are one decision and cannot drift. */
  kundokuSpacing: KundokuSpacing;
  /** Whether this plan took the verse branch — `verseRimeFloor > 0`, carried
   * back rather than re-derived, so `buildPrintLayout` gates
   * `verseLinePadding` on the same fact this function gated `kundokuSlots`
   * and `verseProseSlots` on, and the two cannot disagree about which text
   * this is. */
  verse: boolean;
}

function planBands(
  root: HTMLElement,
  kundokuSentences: readonly HTMLElement[],
  kakiSentences: readonly HTMLElement[],
  showKakikudashi: boolean,
  /** `VERSE_ATTRIBUTE`'s own presence, read off the live `.text-kakikudashi`
   * before any of this runs — the identical gate `fitPassageExtent`'s own
   * verse branch is kept behind on screen (`column.dataset[VERSE_ATTRIBUTE]
   * !== undefined`), and not `verseRimeFloor > 0`: `detectVerse` can find a
   * poem `rimeColumnFloor` has no rhyme to hang a 割注 under, and the screen
   * still runs its verse branch for one — `verseFloorDivisionAtReducedAdvance`
   * asked with a rime floor of zero, which binds nothing. */
  verse: boolean,
  /** `rimeColumnFloor`'s own answer, read the same moment `verse` above is —
   * `0` wherever there is no rime to protect, verse or not, which every lever
   * below already treats as "nothing to hold this floor to". */
  verseRimeFloor: number,
): BandPlan {
  // A page to measure in, thrown away before any real one is built. It is
  // inside `#print-root`, which app.css parks off-canvas, so nothing of this
  // is ever on screen.
  const trial = document.createElement("section");
  trial.className = "print-page";
  root.append(trial);

  // Any height at all: nothing is read off these two until the advances are
  // known, and an advance is a fact about the type and not about the box.
  const kundokuTrial = makeBand("kundoku", PAGE_CONTENT_HEIGHT_MM / 2, 0);
  trial.append(kundokuTrial.band);
  const proseTrial = makeBand("kakikudashi", PAGE_CONTENT_HEIGHT_MM / 2, 0);
  trial.append(proseTrial.band);

  const kundokuAdvancePx = advanceDown(kundokuTrial.column, true);
  const proseAdvancePx = advanceDown(proseTrial.column, false);
  /** The character itself, which is the half of the kundoku advance that does
   * not move: a stretch is spent entirely on the gap after it, and the gap is
   * what `--kanji-gap` has to be written as. Read off the same box the advance
   * is, so the two cannot come from different scales. */
  const kundokuSizePx = parseFloat(getComputedStyle(kundokuTrial.column).fontSize);
  const spacingFor = (advancePx: number): KundokuSpacing => ({
    gapPx: advancePx - kundokuSizePx,
    advancePx,
  });
  // The hanging room, now that there is a number for it. `heldSlots`
  // (KakikudashiView.ts) takes the padding off the band before dividing, so a
  // trial band with the wrong padding would count its own column wrong and
  // hang the wrong marks.
  proseTrial.band.style.paddingBottom = `${proseAdvancePx}px`;

  // **The kundoku column length, derived rather than written down** — see
  // `kundokuSlotsFor`. At the drawn scale it is the 5 this used to be spelt as
  // a constant; under the print rescale it is 10, and a constant would have
  // left the pair using little more than half the sheet.
  const defaultKundokuSlots = kundokuSlotsFor(kundokuAdvancePx, proseAdvancePx);
  // Lever 1 — the rime's cell: never fewer than `verseRimeFloor` (no-op for
  // prose, and a no-op today for verse too — see `verseKundokuSlots`'s own
  // note on why `kundokuSlotsFor`'s answer already clears both shipped
  // floors at this scale).
  const kundokuSlots = verse ? verseKundokuSlots(defaultKundokuSlots, verseRimeFloor) : defaultKundokuSlots;
  // Lever 2 — the gap, reduced only if holding the floor above pushed the
  // prose ceiling under `PROSE_SLOTS_MIN`. `drawnKundokuAdvancePx` stands in
  // for `kundokuAdvancePx` everywhere below a real box would be measured at
  // the *set* type, exactly as `kundokuAdvancePx` did before this branch
  // existed — so a prose document (`verse` false) takes the identical path
  // it always has, `drawnKundokuAdvancePx === kundokuAdvancePx` by
  // construction and never evaluated any other way.
  let drawnKundokuAdvancePx = kundokuAdvancePx;
  if (verse) {
    const kundokuGapPx = kundokuAdvancePx - kundokuSizePx;
    const maxReductionPx = Math.floor(kundokuGapPx * MAX_VERSE_GAP_REDUCTION_RATIO);
    const reductionPx = verseGapReductionForPrint(
      kundokuSlots,
      kundokuSizePx,
      kundokuGapPx,
      proseAdvancePx,
      maxReductionPx,
    );
    if (reductionPx > 0) {
      drawnKundokuAdvancePx = verseKundokuAdvanceAtReducedGap(kundokuSizePx, kundokuGapPx, reductionPx);
    }
  }
  // The kundoku band's height is `kundokuSlots` advances whatever the prose
  // comes to — the prose count is the only thing the choice below moves — so
  // the second argument here is not a number this band depends on.
  const kundokuHeightMm = bandHeightsMm(kundokuSlots, 0, drawnKundokuAdvancePx, proseAdvancePx).kundoku;

  if (!showKakikudashi) {
    trial.remove();
    // With no prose to pair, the kundoku band has the whole budget — and takes
    // it a whole character at a time, never a part of one, which is the rule
    // `.kundoku-panel .tategaki` (tategaki.css) keeps on screen for the same
    // reason: what is left over is dead height under the last character.
    // 177.5mm — the budget less the cushion — is 670.87px, which over an 88px
    // advance is seven characters and 54.9px that no character can use.
    //
    // **The rime floor still binds here, and only that far — `rimeFloor`
    // itself, not a floor under the whole-budget count.** The same reversal
    // `verseKundokuSlots`'s own note gives applies here for the identical
    // reason: `naturalSlots` is not a bound the sheet imposes regardless of
    // what is asked of it, it is "however many characters this budget would
    // carry with nothing else on the page" — a number with nothing to do
    // with any particular poem's own lines, which is exactly the trap
    // `Math.max` fell into the first time this was written. A verse column
    // held to `naturalSlots` (13 at the shipped scale) is a column with the
    // same seven-cell foot of blank sheet under every line of a five-line
    // 五言 that `verseKundokuSlots`'s own note found in the paired band —
    // there is simply no prose band beside it to make the waste look like a
    // gap.
    //
    // No gap-reduction search for this branch either: with no prose band to
    // protect, `verseGapReductionForPrint` has nothing to ask about, and at
    // `rimeFloor` rather than `naturalSlots` the column is smaller than the
    // budget already comfortably carries, so there is nothing for a
    // reduction to buy here that `rimeFloor` alone has not already bought.
    const naturalSlots = Math.max(
      1,
      Math.floor((BAND_BUDGET_MM - BAND_CUSHION_MM) / (kundokuAdvancePx * MM_PER_PX)),
    );
    const slots = verse ? verseKundokuSlots(naturalSlots, verseRimeFloor) : naturalSlots;
    // And those 54.9px are 14.52mm of the sheet, which is where this page's
    // whole leftover sits — so the same stretch answers it. Seven characters
    // at 94.29px (the ceiling; the bare measure wants 95.84) is a 175.13mm
    // band and 2.88mm left, against 163.48mm and 14.52mm before.
    //
    // The ceiling binds here for a reason worth naming, because it is the one
    // place `fittedTracking`'s round would go the *other* way: 670.87px over
    // an 88px advance is 7.62 characters, so the nearest whole number is eight
    // and the fitted answer is eight characters at a 83.86px advance — a gap
    // *tighter* than the drawn one. That is very likely the better page, and
    // it is not taken here: it changes how many characters a column holds,
    // which changes where every page of this mode breaks, and the deal is what
    // this round is under instructions not to disturb.
    const advancePx = filledKundokuAdvancePx(slots, 0, kundokuAdvancePx);
    return {
      kundokuHeightMm: bandHeightsMm(slots, 0, advancePx, proseAdvancePx).kundoku,
      proseHeightMm: 0,
      proseSlots: 0,
      proseAdvancePx,
      kundokuSpacing: spacingFor(advancePx),
      verse,
    };
  }

  // The whole text in each band, which is what an extent is a measurement of.
  // The kundoku band is sized once — its column length is fixed — and the
  // prose band is re-sized per candidate.
  kundokuTrial.band.style.height = `${kundokuHeightMm.toFixed(3)}mm`;
  for (const sentence of kundokuSentences) kundokuTrial.column.append(sentence.cloneNode(true));
  for (const sentence of kakiSentences) {
    const clone = sentence.cloneNode(true) as HTMLElement;
    clearHangingMarks(clone);
    proseTrial.column.append(clone);
  }

  // Lever 3 — the prose column itself. A poem is not matched to an extent —
  // `verseProseSlots` takes the widest the sheet leaves once the floor above
  // is held, "everything else" in the same sense `verseFloorDivision` gives
  // the screen's prose panel — so the measuring loop below, built for the
  // extent match, is not run for verse at all: there is no candidate to
  // choose among, only the one answer `proseSlotChoices` already ends on.
  let proseSlots: number;
  if (verse) {
    proseSlots = verseProseSlots(kundokuSlots, drawnKundokuAdvancePx, proseAdvancePx);
  } else {
    const target = kundokuTrial.column.getBoundingClientRect().width;
    const choices = proseSlotChoices(kundokuSlots, drawnKundokuAdvancePx, proseAdvancePx);
    proseSlots =
      matchedProseSlots(target, choices, (slots) => {
        const heights = bandHeightsMm(kundokuSlots, slots, drawnKundokuAdvancePx, proseAdvancePx);
        proseTrial.band.style.height = `${heights.kakikudashi.toFixed(3)}mm`;
        // With the marks hanging, as every candidate the screen fit measures is
        // (`setColumnSlots`'s own note): hanging takes columns back, and a
        // passage measured without it is a passage a per cent or so longer than
        // the one that will be printed.
        applyHangingMarks(proseTrial.band, proseTrial.column);
        return proseTrial.column.getBoundingClientRect().width;
      }) ?? defaultProseSlots(kundokuSlots);
  }

  trial.remove();

  // The match is made; the sheet's leftover is now a number, and it goes into
  // the gap above. The prose band keeps the height it was matched at and the
  // tracking it is drawn at — see the head of this file for why all of it goes
  // to one band, and to that one.
  //
  // After the match and not before it: the candidates are compared on how far
  // each runs *across* the page, which the stretch does not touch, and
  // stretching first would only have moved the same millimetres through the
  // same arithmetic. This way the choice of `np` is exactly the choice the
  // reader has already seen made.
  //
  // `drawnKundokuAdvancePx` and not `kundokuAdvancePx` here too — a verse
  // page's own drawn advance is the reduced one where lever 2 cut it, and
  // stretching from anywhere else would spend the sheet's leftover on top of
  // a gap the page is not actually set at.
  const proseHeightMm = bandHeightsMm(kundokuSlots, proseSlots, drawnKundokuAdvancePx, proseAdvancePx).kakikudashi;
  const filledAdvancePx = filledKundokuAdvancePx(kundokuSlots, proseHeightMm, drawnKundokuAdvancePx);
  return {
    kundokuHeightMm: bandHeightsMm(kundokuSlots, 0, filledAdvancePx, proseAdvancePx).kundoku,
    proseHeightMm,
    proseSlots,
    proseAdvancePx,
    kundokuSpacing: spacingFor(filledAdvancePx),
    verse,
  };
}

/** **Nothing is dropped.** Carries a band that still runs past the sheet onto
 * as many further pages as it needs.
 *
 * A page can only overflow one way now: a piece that does not fit a page of
 * its own, which is a run of text with no cut in it longer than the 55 kanbun
 * characters a sheet holds. `pairedCuts` finds a cut wherever the two panels'
 * orders have caught up, which on ordinary text is every few characters, so
 * this is a rare state — but it used to be a silent one. `overflow: hidden` on
 * the band cut the tail off and it was never printed at all: a reader printing
 * a long chapter lost the end of it and had nothing on the page to say so.
 *
 * The continuation is the same page again with the columns slid one sheet's
 * width to the right. Under vertical-rl the first column stands at the band's
 * right edge and the passage runs leftwards, past the band's left edge and
 * under the clip; translating the column right by one page width brings the
 * next sheet's worth into view. A `transform`, not a margin: it takes no part
 * in layout, so the clone lays out identically to the page it came from and
 * the two bands stay in step down the continuations exactly as they were on
 * the first sheet.
 *
 * Cloned after the hanging marks and the compound lines are settled, so a
 * continuation carries the same measurements as its original rather than being
 * re-measured into a different page.
 *
 * **Arithmetic, not observation.** That vertical-rl overflow runs leftwards
 * and that a positive `translateX` therefore reveals it is what the writing
 * mode says; nobody has watched it happen on paper. What would settle it is a
 * print preview of a text with one unbroken run longer than a sheet. */
function spreadSpill(root: HTMLElement): void {
  const pageWidth = PAGE_CONTENT_WIDTH_MM / MM_PER_PX;
  for (const page of [...root.querySelectorAll<HTMLElement>(".print-page")]) {
    let sheets = 1;
    for (const band of page.querySelectorAll<HTMLElement>(".print-band")) {
      sheets = Math.max(sheets, Math.ceil((band.scrollWidth - 1) / pageWidth));
    }
    if (sheets < 2) continue;
    let after: HTMLElement = page;
    for (let sheet = 1; sheet < sheets; sheet++) {
      const carried = page.cloneNode(true) as HTMLElement;
      for (const column of carried.querySelectorAll<HTMLElement>(".tategaki-column")) {
        column.style.transform = `translateX(${(sheet * pageWidth).toFixed(2)}px)`;
      }
      after.after(carried);
      after = carried;
    }
  }
}

export function teardownPrintLayout(): void {
  document.getElementById(ROOT_ID)?.remove();
}

/** Wires the automatic rebuild for users who print via Ctrl+P rather than
 * the button, and clears the (large) cloned DOM again afterwards so it
 * isn't left sitting in the document. */
export function setupPrintLayout(kundokuView: HTMLElement, kakikudashiView: HTMLElement): void {
  window.addEventListener("beforeprint", () => buildPrintLayout(kundokuView, kakikudashiView));
  window.addEventListener("afterprint", teardownPrintLayout);
}
