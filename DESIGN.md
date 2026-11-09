---
name: Jidō Kundoku
description: Classical Chinese, read as Japanese — a draft kunten edition, set like print and corrected in place.
colors:
  shu-vermilion: "#94392e"
  shu-vermilion-soft: "#af5145"
  ai-indigo: "#002a5a"
  kinu-paper: "#faf1df"
  panel-white: "#fefbf7"
  sumi-ink: "#1e1914"
  usuzumi: "#6c6157"
  hairline: "#dbd0bb"
  leaf: "#fbf4e6"
  accent-grey: "#575757"
  shu-vermilion-dark: "#e38779"
  shu-vermilion-soft-dark: "#be665a"
  ai-indigo-dark: "#7fb2e6"
  kinu-paper-dark: "#17140f"
  panel-dark: "#201c15"
  sumi-ink-dark: "#eee5dc"
  usuzumi-dark: "#ac9c8d"
  hairline-dark: "#3c352a"
  leaf-dark: "#1b1711"
typography:
  kanbun:
    fontFamily: "Noto Serif JP, Hanamin, Noto Serif TC, Noto Serif SC, serif"
    fontSize: "2.75rem"
    fontWeight: 400
    lineHeight: 2
  kakikudashi:
    fontFamily: "Noto Serif JP, Hanamin, Noto Serif TC, Noto Serif SC, serif"
    fontSize: "1.375rem"
    fontWeight: 520
  furigana:
    fontFamily: "Noto Serif JP, Hanamin, Noto Serif TC, Noto Serif SC, serif"
    fontSize: "0.9167rem"
    fontWeight: 800
  kunten:
    fontFamily: "Noto Serif JP, Hanamin, Noto Serif TC, Noto Serif SC, serif"
    fontSize: "1rem"
    fontWeight: 800
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.35rem"
    lineHeight: 1.4
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.1rem"
    lineHeight: 1.4
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.95rem"
    lineHeight: 1.4
  prose:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.65
  prose-ja:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.8
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 600
    lineHeight: 1.4
  caption:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.8125rem"
    lineHeight: "1.2rem"
  eyebrow:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: "1.05rem"
    letterSpacing: "0.08em"
  menu:
    fontFamily: "Noto Serif JP, Hanamin, Noto Serif TC, Noto Serif SC, serif"
    fontSize: "1.25rem"
    lineHeight: 1.5
  menu-gloss:
    fontFamily: "system-ui, sans-serif"
    fontSize: "0.75rem"
    lineHeight: "1.05rem"
  chip:
    fontFamily: "Noto Serif JP, Hanamin, Noto Serif TC, Noto Serif SC, serif"
    fontWeight: 600
    lineHeight: 1.2
rounded:
  chip: "0.25rem"
  sm: "0.3rem"
  md: "0.4rem"
  lg: "0.6rem"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  panel: "1.25rem"
  dialog: "2rem"
  side-track: "20rem"
components:
  button-primary:
    backgroundColor: "{colors.ai-indigo}"
    textColor: "{colors.panel-white}"
    rounded: "{rounded.sm}"
    height: "2.5rem"
    padding: "0.25rem 1rem"
  button-secondary:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.sm}"
    height: "2.5rem"
    padding: "0.25rem 1rem"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.usuzumi}"
    rounded: "{rounded.sm}"
    height: "2rem"
    padding: "0.3rem 0.7rem"
  button-destructive-hover:
    backgroundColor: "transparent"
    textColor: "{colors.shu-vermilion}"
  input-text:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.sumi-ink}"
    typography: "{typography.title}"
    rounded: "{rounded.sm}"
    padding: "0.6rem"
  saved-row:
    backgroundColor: "transparent"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.sm}"
    padding: "0.25rem 0.35rem"
  saved-row-hover:
    backgroundColor: "{colors.ai-indigo}"
    textColor: "{colors.panel-white}"
  saved-delete-hover:
    backgroundColor: "{colors.shu-vermilion}"
    textColor: "{colors.panel-white}"
  chip-pos:
    backgroundColor: "{colors.ai-indigo}"
    textColor: "{colors.panel-white}"
    typography: "{typography.chip}"
    rounded: "{rounded.chip}"
    padding: "0.1rem 0.4rem"
  arrow-label:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.ai-indigo}"
    rounded: "{rounded.sm}"
  context-menu:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.md}"
  context-menu-item-hover:
    backgroundColor: "{colors.ai-indigo}"
    textColor: "{colors.panel-white}"
  dialog:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.lg}"
    padding: "0 2rem 2rem"
---

# Design System: Jidō Kundoku

## Overview

**Creative North Star: "The Annotated Edition"**

The screen is a printed *kanbun* edition with an editor's working layer laid over it. The source characters are set large in ink on warm paper, and the apparatus an edition supplies (*kaeriten*, readings, *okurigana*, punctuation) is set in vermilion, the 朱 an editor would have added it in. A third voice, blue, belongs only to the program: the dependency analysis, its labels, and whatever is answering the question the reader just asked. At rest, the page should read as an edition, not as an app.

The system is **quiet** and **exacting**. The chrome recedes: hairline borders, small type in a muted ink, no ornament, and panel headings that disappear once there is text to read. Every value is derived rather than picked: the type scale runs along one size-to-weight curve, the neutral greys are matched to the luminance of the colour they stand beside, and a baseline shift is measured off the em square of the face. A new value needs a reason that can be written down beside it, as the existing CSS does.

The edition outranks the screen. Typography is checked against printed editions, and the page must survive the print stylesheet, which drops colour.

**Key Characteristics:**
- Three hues, each with one meaning: ink for the source, vermilion for the edition, blue for the program.
- Vertical text (*tategaki*) is the primary layout; the interface wraps around it.
- One serif face (Noto Serif JP) for everything set as part of the edition; the system UI face for the chrome.
- Flat surfaces; a shadow means an element floats over the text.
- Warm paper and warm ink in both light and dark themes, measured from the books in the light one.

## Colors

A two-pigment page, vermilion and ink on warm paper, with a single indigo reserved for the program. The paper, the ink and the vermilion are measured from scans of Edo-period *kanbun* books (see Provenance, below). The indigo is the program's own colour, chosen rather than measured.

### Primary
- **Shu Vermilion** (`shu-vermilion`; dark theme `shu-vermilion-dark`): the 朱 of the 句点 brushed into a 貞觀政要 printed in movable type in 1600, at the lightness that gives 6.5:1 on the page (7.0:1 on the dark ground). It marks what a reader of a printed book brushes in: the punctuation, the title line (a 朱引) and the compound tie. The rest of the apparatus, the readings, *okurigana*, *kaeriten* and the 踊り字, is printed in the ink of the type (`--color-apparatus`, with the *okurigana* a step lighter in `--color-apparatus-soft`), as a printed 訓読本 cuts its kunten into the block with the text; it is told from the characters by its size and its place. It also marks **the selected character**, with added weight so that the selection survives monochrome printing. In the chrome it appears only where something is destroyed or has failed: the hover on a delete control and the error line of the status bar.

### Secondary
- **Ai Indigo** (`ai-indigo`; dark theme `ai-indigo-dark`): everything the program says. It colours the dependency arc and its arrowhead, the band drawn during a drag, the part-of-speech chips, the relation labels, the current entry in a menu, and the reading of the character under the pointer. In the chrome it marks the one primary button (Annotate), a checked checkbox, the focus ring and links; the other controls are ink on paper (see Components, Buttons).

### Neutral
- **Kinu Paper** (`kinu-paper`; dark `kinu-paper-dark`): the page ground: the hue of the median paper of five Edo NDL books, at the lightness and chroma of a letterpress sheet measured in a Shōwa edition (OKLCH 0.910, 0.029; see Provenance). On screen it carries a grain (see Paper and impression).
- **Panel White** (`panel-white`; dark `panel-dark`): the page hue at lightness 0.99, a fresh sheet rather than a pure white. Raised working surfaces such as the textarea, dialogs and labels. It is also the text colour on any indigo or vermilion fill.
- **Sumi Ink** (`sumi-ink`; dark `sumi-ink-dark`): the primary text of the chrome: labels, buttons, dialogs, the FAQ. The hue and chroma are the median sumi of the Edo books (a warm brown black, hue 67.6); the lightness is the old ink's, since a scan records the flare of the camera over black as well as the black.
- **Print Ink** (`print-ink`, `--color-print-ink`; the dark theme uses Sumi Ink): the text of the edition, the kanbun and the *kakikudashibun*, and its printed kunten. It is the woodblock sumi of 周易本義 (林道春点 和刻本, 鴎外文庫, University of Tokyo; Internet Archive `ogai-1fb321f5-a640-4592-9553-3d5a052e8130`), calibrated against the Kodak Color Control Patches in the scan (white 0.90, black 0.03) and measured on the cores of large strokes: a nearly neutral film passing 0.077, 0.082 and 0.094 of its paper (density 1.1). Over this page it comes to #484643, 7.24:1, drawn translucent (a near-black at 69.9% cover) so that the grain shows under each stroke. It replaced the Shōwa letterpress film (#6b6355, 4.54:1), which read as grey beside a printed 訓読本. The chrome keeps Sumi Ink, so that Usuzumi can stay paler than the ink and still legible. Opaque Sumi Ink under reduced transparency, increased contrast and forced colours.
- **Print Vermilion, Print Indigo and the gloss** (`--color-print-vermilion`, `--color-print-indigo`, `--color-print-gloss-flat`, each with a `-flat` alpha; the dark theme uses Shu Vermilion, Soft vermilion, Ai Indigo and Accent Grey). Vermilion is the 朱 of the head-notes in 周易本義, calibrated with the sumi: a film passing 0.641, 0.124 and 0.065 of its paper, laid on this page at the thickness it has in the book: #c15538, 3.47:1, 73.0% cover. As in the book it is much lighter than the sumi; the reader chose this over a red as dark as the type, which came out an opaque maroon. The thin film for the brackets and the title line is the same pigment thinner by the soft step (6.1 in J_HK): #cb6f50, 2.70:1. The red and blue of highlighting are films at the cover of the sumi (69.9%). At that cover nothing that still reads as red or blue looks as dark as the sumi, and the reader let the lightness give: a selected character is the 朱 laid 4.18 times as thick as the book has it (`--color-print-vermilion-deep`, ink #650000, #8d433d over the page, 5.32:1, J_HK 34.9), and the blue on the page (a selected reading, the drop target, the arcs) is the ink of Ai Indigo darkened to match it (`--color-print-indigo`, ink (0, 33, 72), #475a70, 5.40:1). The chrome keeps Ai Indigo opaque at #002a5a (10.9:1). The kana and *kaeriten* print in the sumi: the *okurigana* thinner by the same soft step (#595753, 5.50:1), and the gloss of the *kakikudashibun* thinner again, by the share of the way to the paper it had before the redesign (#6c6863, 4.22:1). Each cover has two alphas: `-flat` where nothing shows under the glyph but the page, and one solved with the ink spread under it. Opaque under reduced transparency, increased contrast and forced colours.
- **Usuzumi** (`usuzumi`; dark `usuzumi-dark`): pale ink for labels, panel headings, status text and captions. Running prose that the reader reads through, such as the FAQ answers, is in Sumi Ink, so that it is never quieter than the question over it.
- **Leaf** (`leaf`; dark `leaf-dark`, `--color-bg-leaf`): the ground of the two sidebars, which are drawn as sheets laid beside the page. The page mixed 30% toward Panel White (40% in the dark theme, where a step between two near-blacks is harder to see): a sheet a shade fresher than the page. Usuzumi keeps 5.78:1 on it (6.71:1 in the dark theme).
- **Hairline** (`hairline`; dark `hairline-dark`): the 1px borders on dialogs, inputs and menus, the rule between the kundoku panel and the *kakikudashibun*, and the edge of each sidebar wherever the lit leaf edge is off (see Paper and impression).
- **Accent Grey** (`accent-grey`): a grey of the same relative luminance as Shu Vermilion. It boxed the existing head of a character until the box line came down to the width of a horizontal stroke of the text, where the grey read as too faint; the head box is now drawn in the ink (see Existing head). The token is kept for any mark that must match the weight of the vermilion without its hue. The greys matched to the vermilion and to the indigo differ in both themes: #575757 and #4e4e4e on the light page, #a0a0a0 and #aeaeae on the dark one. They coincided on the light page until the vermilion was measured, and the measured 朱 is the lighter red.

### Derived tones
- **Soft vermilion** (`shu-vermilion-soft`; dark `shu-vermilion-soft-dark`): for the parts of the apparatus subordinate to another part, such as *okurigana* under its reading and the brackets. The measured 朱 at its own hue and chroma, at the lightness that gives 4.6:1 on the page: OKLCH 0.550 against the measured 0.593, as close to the books as legibility allows. It was Shu Vermilion mixed 67% toward the page, which came to 3.7:1. Each theme declares its own value, solved against its own ground, so the tone still recedes in both: paler on the light page, darker on the dark one.

### Provenance
The light palette is measured from colour scans, in the National Diet Library Digital Collections, each photographed beside a grey scale and colour patches. The grey scale of each volume was read patch by patch, and a per-channel curve took every patch to the neutral of its own luminance; the samples were corrected through those curves. The patch values of the chart are not published, so the correction is a grey balance only, not a full colour calibration. Waseda University's 古典籍総合データベース refused automated access (HTTP 503) and is not used.

| Book | Frame (chart / page) | Paper, raw → corrected | Ink, raw → corrected | 朱, raw → corrected |
|---|---|---|---|---|
| 林點四書集註, 須原屋茂兵衞等刊 1808 (道春点), vol. 1 [dl.ndl.go.jp/pid/2583041](https://dl.ndl.go.jp/pid/2583041) | 1 / 5 | #d3ba9e → #c9bca3 | #374537 → #46413b | none |
| 孟子集註14卷, 1794, 後藤点 [dl.ndl.go.jp/pid/2583148](https://dl.ndl.go.jp/pid/2583148) | 1 / 5 | #dcc1a6 → #d3c3a7 | #374639 → #4a413b | none |
| 貞觀政要10卷 (WA7-268), 伏見版 古活字 1600, with 朱 句点 and 朱引 by hand [dl.ndl.go.jp/pid/2570049](https://dl.ndl.go.jp/pid/2570049) | 1 / 6 | #d8bc9a → #cdb297 | #444b39 → #474441 | #c6654c → #bd5e51 (dots, full resolution) |
| 禮記20卷 (WA7-260), 古活字 慶長・元和, with 朱 書入れ [dl.ndl.go.jp/pid/2544777](https://dl.ndl.go.jp/pid/2544777) | 1 / 12 | #d5bb9e → #ccbd9e | #394b3e → #4a4642 | #ab7971 → #a77674 (thin lines, mixed with paper) |
| 孔子家語 (WA7-270), 古活字 元和頃, with 朱 傍線 [dl.ndl.go.jp/pid/2544818](https://dl.ndl.go.jp/pid/2544818) | 1 / 12 | #cab299 → #c5b495 | #3a4a41 → #4b453f | #a86054 → #a65e52 |

Paper is the median of four margin areas a page; ink is the median of glyph interiors (the dark mask eroded by 3 px at 3000 px wide); 朱 is the median of the red mask, eroded. The grey card around each book corrects to within 2 levels of neutral, except in 貞觀政要, where the chart frame was lit differently from the page (the card differs by 14 levels); there the page was first brought to the chart frame by the ratio of the two cards. In OKLCH the medians are: paper L 0.80, C 0.045, h 82.5; ink L 0.39, C 0.012, h 67.6; 朱 (the dots) L 0.59, C 0.125, h 29.3. The raw scans have a green cast in the shadows, which the grey scale shows as well, and which the correction removes.

**What the screen takes from the Edo books.** The hues, all of them, and the chroma of the ink and of the 朱. Not the lightness of the paper, which at 0.80 is a brown card on a screen, nor of the ink, which at 0.39 is the flare of the camera. The chrome ink keeps its lightness of 0.22; the 朱 is set by contrast, as above.

**The letterpress reference: 昭和新纂國譯大藏經 摩訶止觀** (NDL, volume 583-26; a Shōwa movable-type edition of the reading, 國譯 with furigana, under a ruled register of 科文). The last frame of the scan holds a Kodak grey scale and colour patches. Read by its nominal printed densities (patch A 0.05, then 0.10 a step to 1.95), the scale turns the scan into true reflectance, not only a grey balance: patches A and 10 come back at exactly 0.891 and 0.0891, and the white board around the chart at C 0.003. This book sets what the Edo books cannot, the **lightness and chroma of the paper** and the **colour and transparency of the ink**:

| Sample | Where | OKLCH |
|---|---|---|
| Paper | the ground between glyphs, six spreads (frames 40–280) | L 0.910, C 0.029, h 77.5 |
| Ink, as printed | glyph cores of the half-title 摩訶止觀 (frame 5), eroded 2px and 4px at the scan's native 200 dpi; the two agree to 0.005 | L 0.50, C 0.027, h 79 |
| Ink, as a film | the same, divided by the paper beside it | density 0.77; transmits 0.177, 0.167, 0.151 (R, G, B); C 0.008 |
| Red | the title page, printed | L 0.70, C 0.18, h 48.7 (a display red; not used) |

The body type agrees (density 0.87), but its strokes are 3–5px wide at the scan's resolution and few pixels of them survive the erosion, so the half-title is the reading used. The film is nearly neutral: the warmth of the printed ink is the paper seen through it. So the page takes the measured lightness and chroma at the Edo hue (82.5), and the type of the edition is drawn as a translucent near-black that gives exactly the film's colour over the page, letting each level of grain through at 0.42 where the film lets through 0.47. The glyph itself is at 48.3%, since the ink spread is drawn beneath it in 40% of the same colour, and the two together cover 58.3%.

**Moving the page down changed no contrast.** Each token that is defined by its contrast on the page (Usuzumi, both vermilions, the indigo) was solved again at its own hue and chroma for the contrast it had; the hairline keeps its step below the page; the leaf is the new page mixed 30% toward Panel White; the two matched greys follow the vermilion and the indigo. Sumi Ink, unchanged, goes from 15.54 to 13.34:1.

**The dark theme is not historical.** No 訓点本 was printed light on dark. It keeps the measured hues and solves its own lightnesses: ground and panel as before, ink at 0.93, the vermilion at 7.0:1 and the soft tone at 4.6:1 on the ground.

| Token | Light, old → new | Contrast on the page | Dark, old → new | Contrast on the ground |
|---|---|---|---|---|
| `--color-bg` | #faf7f0 → #faf1df → #ebe0cc | | #17140f | |
| `--color-bg-panel` | #ffffff → #fefbf7 | | #201c15 | |
| `--color-ink` | #1c1a16 → #1e1914 | 16.24 → 15.54 → 13.34 | #ece6d8 → #eee5dc | 14.76 → 14.76 |
| `--color-print-ink` | rgb(15 9 0 / 0.483) → woodblock sumi rgb(1 3 8 / 0.603), #484643 over the page | 4.54 → 7.24 | `--color-ink` | 14.76 |
| `--color-print-vermilion` (full / thin) | the 周易本義 朱 at its book thickness, 73.0% / 61.0% cover, #c15538 / #cb6f50 over the page | 3.47 / 2.70 | `--color-accent` / `--color-accent-soft` | 7.00 / 4.58 |
| `--color-print-indigo` | rgb(0 33 72) at 69.9% cover, #475a70 over the page | 5.40 | `--color-highlight` | — |
| `--color-print-vermilion-deep` | rgb(101 0 0) at 69.9% cover, #8d433d over the page | 5.32 | `--color-accent` | — |
| `--color-print-gloss-flat` | the sumi thinner, #6c6863 over the page | 4.22 | `--color-highlight-neutral` | — |
| `--color-ink-soft` | #6b6357 → #6c6157 → #62574d | 5.53 → 5.37 | #a89e8c → #ac9c8d | 6.94 → 6.90 |
| `--color-border` | #d9d0bf → #dbd0bb → #cbc0ab | | #3c352a | |
| `--color-accent`, `--color-kunten` | #8a2f1f → #94392e → #882e24 | 7.83 → 6.49 | #e08a6f → #e38779 | 7.03 → 7.00 |
| `--color-accent-soft` | mix (#af7164) → #af5145 → #a3463b | 3.66 → 4.58 | mix (#9e634f) → #be665a | 3.81 → 4.58 |
| `--color-highlight` | #1f4f8a → #14457f → #1d6bc4 → #002a5a (as dark as the sumi) | 7.72 → 7.36 → 4.07 → 10.86 | #7fb2e6 | 8.23 |
| `--color-highlight-neutral` | #4e4e4e → #575757 → #4c4c4c | | #a0a0a0 | |

### Paper and impression
On screen, and only there, the page carries the grain of the sheet and the ink spreads into it a little.

- **Grain** (`paperGrain.ts`, `paper.css`): a formation of cloudy value noise at 61, 17 and 4px, a little per-pixel tooth, and short fibres lying on the surface, drawn once into a canvas the size of the screen and laid as a single image on a fixed layer behind the page. It never repeats and never scrolls. Each speck moves the ground by a set number of levels up or down, solved against `--color-bg`, so the mean of the page is the token itself and the text keeps its contrast: measured on a screenshot, the ground averages the token exactly, with a standard deviation of about one level, and the soft vermilion stays at 4.50:1 or better on the darkest 1% of the grain. The image is laid again over the blurred right edge of each panel and over the frosted pad under the undo stack, so neither shows as a smooth patch. The sidebars, dialogs and menus cover it. No 簾目 (laid lines) are drawn: the scans of these books do not show them at screen scale.
- **Ink spread**: a `text-shadow` of half a CSS pixel in the glyph's own colour at 40%, on the source characters, everything set in their cells, and the *kakikudashibun*, in the two panels only. It adds ink outside the edge and leaves the glyph as crisp as it was. Not on the analysis overlay, the chips, the labels, the menus or the chrome.
- **Leaf edges** (`paperEdge.css`; `paperEdge.ts` only switches them on): each sidebar is a leaf laid beside the page, cut straight. The 1px border on the side facing the text is the thickness of the sheet under the light. **One light lights everything, above and to the left**, so every piece of paper has two lit sides and two in shade: edges facing up or left are lit (`--leaf-edge-light`), edges facing down or right are in shade (`--leaf-edge-shade`), the two at **equal contrast** with the leaf (see Equal contrast below), and the leaves and tabs cast `--leaf-cast`, black at `--leaf-shade` (0.10 light, 0.35 dark), 2px down and 1px right, blurred over 4px. So the left sheet, whose edge faces right, has a shaded edge, and the right sheet, whose edge faces left, a lit one. Wide layout only, and not on a collapsed panel; a drawer keeps the menu-float shadow. The tab on each sidebar rail is cut from the same leaf: leaf ground, no edge on the side where it joins the sheet, the edge of the sheet carried round its free sides under the same light (the left tab lit along its top, in shade along its outer right side and its foot; the right tab lit along its top and outer left side, in shade along its foot), casting the same shadow, clipped at the joined side, so the edge of the sheet runs out round the tab; hover and focus lift the tab: the cast deepens to `--leaf-cast-lifted` (2px right, 4px down, 8px blur, at 1.5 times the shade) and the mark turns to the highlight ink, with no frame of ink round it; the edges stay the lit and shaded edges of the sheet. Shut, the tab is the part of the sheet still showing at the window edge. The tab of the *kakikudashibun* stays astride the rule between the two panels and is dressed as a slip of the same paper pasted over the join, with its own edge on all four sides under the same light (top and left lit, right and foot in shade), lifted on hover and focus as the side tabs are. The leaf takes the page grain from the far end of the image, so its formation is its own and moves with it. The rule between the kundoku panel and the *kakikudashibun* is not a leaf edge: the two are one text set twice on one page, and a page divides its registers with a printed rule (a 界線), not with a second sheet or a fold.
- **Equal contrast**: the reader asked that the lit edge and the shaded edge have the same contrast with the surface, or, for an inset, with the ground it is cut into. Every edge pair is solved for that in CSS (relative colour syntax in linear light, `--pe-*` in `paperControls.css`): the lit edge is the surface carried toward the light (white on the light page, Sumi Ink on the dark one), the shaded edge the surface scaled toward black, each to the same WCAG ratio. Targets: 1.25:1 for a neutral ground on the light page, 1.4:1 on the dark page, and 1.4:1 for a coloured ground in both. Where one side cannot reach the target, both stop where it can: white caps the light page, black the dark one. Measured in Chrome and WebKit:

  | Surface | Light | Dark |
  |---|---|---|
  | Leaf (sheet edges, tabs, quiet buttons; the field's recess) | 1.215 (white caps) | 1.177 (black caps) |
  | Page (history squares) | 1.25 | 1.14 (black caps) |
  | Button Paper (secondary buttons, dialog header buttons, menus, hints, relation label, open tab) | 1.13 (white caps) | 1.24 (black caps) |
  | Ai Indigo (Annotate, 品詞 chip) and its steps, Shu Vermilion (pressed Clear) | 1.40 | 1.40 |

  So on the light page a Panel White slip has almost no edge to show, and is told from its ground by its fill and its cast.
- **Slips, menus and the field**: the buttons, the analysis chips and the menus are cut from the same paper under the same light (`paperControls.css`; see Buttons, Analysis chips and Context menu): top and left edges lit, right and foot in shade, and a cast down and to the right, in place of their frames. The text field is the reverse, a recess cut into the leaf (see Inputs).
- **Off** in print, and under reduced transparency, increased contrast and forced colours. Without the leaf edges each sidebar falls back to its hairline, and each button to its frame.

### Named Rules
**The Three Voices Rule.** Ink is the source, vermilion is the edition, and indigo is the program. Never use a hue to mean something outside its voice; a new feature joins whichever voice it speaks in.

**The Luminance-Matched Grey Rule.** A neutral that stands in for a coloured mark is computed to that mark's relative luminance, not picked by eye, and is re-derived per theme.

**The Not-By-Hue-Alone Rule.** Every distinction carried by colour is also carried by weight, shape or position, because the print stylesheet drops colour and some readers cannot separate red from blue.

## Typography

**Edition Font:** Noto Serif JP, self-hosted as a variable face (200–900) and subsetted by unicode range, falling back to Hanamin, Noto Serif TC, Noto Serif SC and serif.
**Interface Font:** the system UI stack (system-ui, sans-serif). Buttons and selects inherit it explicitly, since the browser otherwise gives form controls a face of their own (Arial in Chrome on macOS). Japanese is never slanted: under a Japanese interface `font-synthesis-style: none` keeps an `<i>` from becoming a faux oblique.

**Character:** a Japanese printing serif for everything that belongs to the edition (source text, readings, *kakikudashibun*, chips and saved titles), and the platform face for the chrome around it. The base characters are set in the Japanese face on purpose, because a 訓読文 is a Japanese edition of a Chinese text.

### Hierarchy
- **Kanbun** (400, 2.75rem, column pitch 2× the size): the source characters in the kundoku panel.
- **Kakikudashi** (520, half the kanbun size): the *kakikudashibun* panel.
- **Furigana** (800, a third of the kanbun size): readings beside the characters.
- **Kunten** (800, 1rem): *kaeriten* numerals and レ点.
- **Headline** (1.35rem, line-height 1.4): dialog titles.
- **Title** (1.1rem, 1.4): the app name in the sidebar and the FAQ section headings in About (700, Sumi Ink, sentence case); also the textarea, which is set in the edition face.
- **Body** (0.95rem, 1.4): buttons and saved-text titles. The FAQ questions are at 1rem and 600.
- **Prose** (1rem; line height 1.65 to 1.7 in English and 1.8 in Japanese): FAQ answers, the help introduction, step captions and the empty-panel line. English prose is held to about 70 characters a line, which in the system UI face is about 52ch, since `ch` (the width of a 0) is wider than the average letter; the About dialog is sized to that measure. Prose wraps with `text-wrap: pretty`, and Japanese prose breaks between phrases (`word-break: auto-phrase`).
- **Label** (600, 0.85rem, Usuzumi): sidebar labels and group headings.
- **Caption** (0.8125rem, line box 1.2rem): the one size under the label. The edit hint and the note a refused drop leaves (both in Sumi Ink, being instructions to read), and the toggle notes, the empty saved-texts line and the language switch. It is 13px at the default root size, a whole pixel, and matches the 13px checkboxes it stands beside.
- **Eyebrow** (700, 0.75rem, line box 1.05rem, uppercase, 0.08em tracking): panel headings, shown only while a panel is empty. Uppercase and tracking do nothing to Japanese, so the eyebrow ranks by size and position alone, and is used only where that is enough.
- **Menu** (edition face, 1.25rem, line-height 1.5): the context menus. They list readings and categories in the edition face, so they are sized to the edition rather than to the chrome scale, and the current entry is marked at 700.
- **Menu gloss** (0.75rem, line box 1.05rem): the balloon that glosses the hovered menu entry, set small so that it does not cover the rows it explains.

Chrome emphasis takes two weights: 600 for labels (field labels, the FAQ questions, "Next" in the edit hint) and 700 for headings alone (the sidebar title, dialog titles, step headings, FAQ section headings and the eyebrow). Edition weights follow the One Curve Rule instead.

### Named Rules
**The One Curve Rule.** Edition type gets heavier as it gets smaller, along one linear curve from (2.75rem, 400) to (1rem, 800), so that small annotations stay legible next to the main text. The *kakikudashi* tier is the exception at 520. Weight above the curve is reserved for marking a selected reading.

**The Two Languages Rule.** Any element whose text switches language gets a fixed line box (`line-height` in rem or as a number, or a fixed height), never `normal`, because `normal` takes the line box from the face, the Japanese face is taller than the Latin one, and the layout must not jump when the user switches language. Where the two languages want different leading (prose), each gets its own fixed value.

## Layout

The app is a five-column grid: input sidebar, rail, text, rail, saved-texts panel. Each side panel takes a 20rem track (`side-track`) and collapses to a 1.75rem rail with a 260ms ease-out transition. The rails also serve as the divisions between regions; the text area keeps no border of its own. The main column splits into the kundoku panel and the *kakikudashibun* panel in a 3fr : 2fr ratio, divided by a collapsible horizontal rail.

Text runs in vertical columns, read right to left. Column pitch is the kanbun size times a line height of 2, and the *kakikudashibun* pitch is half that. The arrow keys move along a column and across to the next.

Panels pad by 1.25rem and stack their contents with a 0.75rem to 1rem gap. Dialogs pad by 2rem; the help dialog fits its two 20rem figure columns, and the About dialog is sized to a 52ch reading measure (about 70 characters of English, about 32 of Japanese). Below 52rem, help figures drop beneath their text. The app is designed for large screens, and mobile is secondary.

**Drawers below 48rem.** Under 48rem the side tracks stay at zero, so the text takes the whole width between the two rails, and a side panel opens as a drawer over the text instead of beside it. The drawer is min(20rem, 100vw − two rails) wide, the same leaf as beside the text, with its lit edge and the menu-float shadow, since it floats over the text (Kinu Paper with a hairline edge where the leaf edge is off). It slides in over the same 260ms, which reduced motion removes. The tab of the open drawer rides on the outer edge of the drawer and stays visible. Only one drawer is open at a time. Escape closes a drawer before it reaches the selection, but an open menu or attach mode keeps Escape first. A tap on the text closes a drawer and does nothing else. Focus moves onto the drawer when it opens, and back to its rail when it closes. The input drawer is open while no text is loaded, and both drawers close when a text arrives. The stored collapse preference belongs to the wide layout and is not changed below the breakpoint.

**The Heading Rhythm Rule.** The space above a heading is greater than the space below it, which is greater than the space between items: 2.6rem between FAQ sections, 0.9rem under a section heading, 1.4rem between questions.

## Elevation & Depth

Surfaces are flat at rest. Depth comes from tone (Panel White over Kinu Paper), the cut edges of paper and 1px hairlines. A shadow appears on something that floats over the text, and, more quietly, under paper lying on paper: the shade beyond the cut edge of a sidebar, and under the buttons and chips, which are slips laid on a sheet rather than things floating over it.

### Shadow Vocabulary
- **Menu float** (`box-shadow: 0 6px 24px rgb(0 0 0 / 18%)`): context menus that open over the text. Where the leaf edges are on, the context menu and the refused-drop note cast it down and to the right, `3px 6px 24px`, as everything under the top-left light does; the drawers, dialogs and the edit-hint balloon still cast straight down.
- **Mark lift** (`--mark-lift: 0 2px 8px rgb(0 0 0 / 18%)`): relation labels and category chips laid over the analysis; used as a `box-shadow` on boxes and as `drop-shadow()` on clipped shapes, so that the two read as one lift.
- **Leaf cast** (`--leaf-cast`, paperEdge.css): black at `--leaf-shade` (10% on the light page, 35% on the dark one), 2px down and 1px right, blurred over 4px, under the two sidebars and the three tabs, and under the primary and secondary buttons, the history squares, the chip row (as `drop-shadow(1px 2px 2px …)`) and the relation label. A contact shade from the one light, above and to the left, so the sheets read as lying flat.
- **Low cast** (`--paper-cast-low`, paperControls.css): the leaf cast at half its offsets and blur (0.5px right, 1px down, 2px), under the quiet and destructive buttons, thinner slips that stand lower than the 題簽. Pressed and disabled buttons cast nothing.
- **Dialog backdrop** (`rgb(0 0 0 / 45%)`): the dimmed backdrop behind the Help and About dialogs, which themselves carry no shadow.

**The Lift Means Floating Rule.** Only an element that sits over the text gets a lift. Panels, inputs and dialogs stay flat. The leaf cast is not a lift: it is at most 10% black on the light page and reaches 5px, against the 18% and 8px blur of the mark lift, and it marks the edge of a sheet or a slip, not something raised off it.

## Shapes

Corners are slightly softened and step up with the size of the surface: 0.25rem on chips, 0.2rem on the checkbox, 0.3rem on every control and small hit target (buttons, the textarea, the export select, saved rows, delete and close buttons, relation labels), 0.4rem on menus and 0.6rem on dialogs. Borders are a single 1px hairline. Analysis marks are drawn with an inset 1.5px edge (`--mark-edge`) rather than a border, so the edge adds nothing to the box.

The part-of-speech chip is a signature shape. It has a chevron cut whose depth comes from the 〈 glyph in the edition face, and its semantic-field and sense chips fold out from behind it.

## Components

The controls are **plain and deferential**: ink on slips of paper, with one block of indigo for the action every visit ends on, and never in competition with the vermilion of the text.

### Buttons
The button system has four ranks, told apart by ground and cast as well as by colour, so that the hierarchy survives a reader who cannot tell the hues apart. The tokens are derived in `src/app.css` ("The button system", on `body`) from the palette alone.

**Every button is a slip of paper** (`src/render/paperControls.css`), under the one light of the leaves, above and to the left (see Paper and impression): its 1px border keeps its width and takes the cut edge, lit along the top and the left side and in shade along the right side and the foot, the two solved from its own ground to equal contrast with it (see Equal contrast under Paper and impression): a neutral slip at the neutral target, a coloured one at 1.4:1 in a tint and a shade of its own fill. The edge is mixed from the ground the reader sees, so it steps with the ground under the pointer. **Pressed**, the slip is pushed into the sheet: the cast goes and the edges swap, the top and left now in shade and the right and foot lit, as the walls of a dent are under the same light. Off, with the leaf edges, under reduced transparency, more contrast and forced colours, where every rank keeps the plain 1px frame described below.

- **Primary** (`.primary`; Annotate only): a slip of Ai Indigo with Panel White text, edged in a tint and a shade of the indigo and casting the leaf cast. Hover mixes the indigo 15% toward Sumi Ink, and a press 30%; mixing toward the ink makes the button darker on the light theme and lighter on the dark one.
- **Secondary** (`.secondary`; the samples, the file button, Export, Save): a slip of Button Paper (`--color-bg-control`, #f6f0e6: Panel White stepped 40% toward the page, so that the lit edge has room above it: white is 1.13:1 above it where it was 1.03:1 above Panel White, and it still stands 1.07:1 above the leaf; the dark theme keeps Panel White) with the cut edge, casting the leaf cast, with the label in Sumi Ink. It is modelled on a 題簽, the paper slip pasted on a cover. The sample buttons name works, so they are set in the edition face at 1.05rem. Hover takes 6% of the ink into the ground; a press takes 12%. Where the edge is off, the slip is framed in the control rule (`--control-rule`, Usuzumi mixed 70% into Hairline, 3:1 or better against the page in both themes), which goes to the ink under the pointer.
- **Quiet** (`.quiet`; the language switches, About, How to edit, the dialog close, the undo, redo and help squares): no ground of its own, so a thinner slip of whatever it lies on (the leaf, Panel White in a dialog), with the cut edge and half the leaf cast (`--paper-cast-low`), and Usuzumi text. Hover lays the same 6% of ink over it and raises the label to Sumi Ink. The undo, redo and help squares stand over the margin of the text and are slips of the page with the full leaf cast. Where the edge is off: a hairline frame, raised to the control rule under the pointer.
- **Destructive** (`.destructive`; Clear, and the delete square on a saved row): quiet at rest; under the pointer the label turns Shu Vermilion over an 8% tint of it (and so does the frame where the edge is off), and a press fills it vermilion with Panel White text, a slip of vermilion paper pressed down. The delete square has no edge at rest; under the pointer it takes the cut edge, drawn inset, and casts nothing.
- **Export select:** a secondary slip with a small solid triangle at its end, drawn in Usuzumi from two gradients, which says the control opens a list. The list itself is the platform's.
- **Heights:** 2.5rem for a full control and 2rem for a small one beside a heading; the squares in a list or in the margin are 1.75rem. Below 48rem, in the drawers and dialogs, full and small controls and the saved rows go to 2.75rem (44px).
- **Shape:** `rounded.sm` (0.3rem) on every button, the select and the textarea.
- **Disabled:** 50% opacity with a not-allowed cursor, the select included, and no cast: a control that offers nothing lies flat.
- **Focus:** every control takes the house ring, a 2px Ai Indigo outline offset 2px, under `:focus-visible`. In the kundoku panel the ring is drawn round the stop itself (a character, a reading, a 品詞 pill, the relation label), and when keyboard focus moves from one stop to the next, one ring glides from the old box to the new one over 180ms, eased out, following the new box while it is still moving (`focusGlide.ts`; none under reduced motion). A focused reading steps out of its character's way by the ring's reach and casing, on the 160ms clock of the head box, so the ring never crosses the character. The ring round a pill is drawn in front of every pill in the row. A text panel takes the ring inset by 2px, and a dialog takes none, since its close button takes the focus when the dialog opens.
- **Paired buttons:** buttons that offer equal choices split the row evenly (the samples, About and How to edit); a primary action beside a minor one takes the remaining space.

### Inputs / Fields
- **Textarea:** a Panel White field with `rounded.sm` corners, cut into the leaf as a recess under the top-left light: its 1px border is in shade along the top and left and lit along the bottom and right, the two at equal contrast with the leaf it is cut into (1.215:1 light, 1.177:1 dark), with a soft inset shade from the top-left rim (`inset 1px 2px 3px`) and no outer cast (in the control rule where the leaf edges are off). It is the only text field in the app. It is set in the edition face at 1.1rem. It is 5rem tall at least (two lines of the edition face and a little over) and takes whatever height the column has spare, and resizes vertically.
- **Checkboxes:** native `<input type="checkbox">` elements drawn by the page (`appearance: none`): a 13px box at 0.2rem, filled Ai Indigo with a Panel White tick when checked. Where the leaf edges are on, each is a hollow cut into the leaf with no outline: its border takes the walls of the cut (the top and left in shade, the bottom and right lit, at equal contrast, from the leaf when empty and from the indigo when ticked), and nothing is shaded inside it. Where the edges are off, the box keeps the control rule as its frame. Under forced colours the platform draws the box again.

### Saved-text list
- **Row:** a title in the edition face, truncated with an ellipsis; on hover it takes the quiet tint of the button system. The delete control is a 1.75rem square of the destructive rank. A row being dragged drops to 45% opacity. The row of the text on screen is set at 600. Alt+ArrowUp and Alt+ArrowDown move a row, and a long list fades at an edge that has more rows beyond it.

### Analysis chips (signature)
- **Part-of-speech chip:** filled Ai Indigo with Panel White text at 600 weight and a chevron end, sitting under the character. On hover, the semantic-field and sense chips slide out from behind it (160ms per stage, staggered). Each chip is coloured paper: its `--mark-edge` ring (inset shadows, so no box changes) is lit in a tint of its own fill along the top and left and shaded, to the same contrast (1.4:1), along the right and the foot, and carried round the chevrons by which way each diagonal faces: both diagonals of a point face right and are shaded, both of a notch face left and are lit. The row casts the leaf cast as a `drop-shadow()`, which follows the chevrons where a `box-shadow` would be clipped. The tab whose menu is out is a slip of Button Paper, the paper of the menus, with the neutral edge, and it stands at the menu's height: it casts the menu's shadow, and the menu's shadow is cut away over it (`cutTriggerFromShadow`), as it is over the relation label. The page-colour casing round each chip is unchanged.
- **Relation label:** a slip of Button Paper, the paper of the menus, with the cut edge (in place of the indigo inset ring it had) and indigo text, casting the leaf cast, placed on the dependency arc; while its menu is out it stands at the menu's height, casting the menu's shadow, and the menu's shadow is cut away over it (`cutTriggerFromShadow`). Focused, it steps 6px further out along the arc's normal (`--label-focus-step`), so that its ring clears the arc. Its lit and shaded edges stand at 1.13:1 against its fill, equally. Where the leaf edges are off, the chips and the label keep the ring of kunten.css.

### Context menu
- **Style:** Button Paper (`--color-bg-control`, the ground of the lightest buttons in the sidebar; the first-run hints and the export options take it too), `rounded.md`, menu-float shadow, edition face at 1.25rem. Its 1px border is the cut edge of the sheet (top and left lit, right and foot in shade, equal-contrast edges solved from Button Paper) and the float falls down and to the right; a hairline where the leaf edges are off. The refused-drop note is dressed the same way. It fades in over 160ms.
- **States:** hover and focus fill indigo with Panel White text. The current value is indigo text at 700 weight.

### Dialogs (Help, About)
- **Style:** Panel White, hairline border, `rounded.lg`, 2rem padding and a sticky header ruled off by a hairline. They cap at 88vh and 92vw. The language button and the close square in the header are both of the quiet rank, at the small height, so the pair reads as one; where the edge is on, both are slips of Button Paper, a shade below the dialog, so that their lit edge shows. Links in the dialogs are indigo and underlined.

### Selection
- **Selected character:** Shu Vermilion at 600 weight. While a selection is up, everything except that character and its reading dims, so the reading is the only one left at full strength.
- **Existing head:** boxed in the ink of the text, at the apparatus stroke (`--head-box-stroke`, the width of a horizontal stroke of the text, 0.03 of its size) with a 2px halo.

## Do's and Don'ts

### Do:
- **Do** print the kunten the edition supplies (readings, *okurigana*, *kaeriten*, 踊り字) in the ink of the type, the *okurigana* a step lighter, and keep the 朱 for what a reader brushes in: the punctuation and the 朱引 lines. On screen in the light theme each is the film of its ink.
- **Do** keep indigo for what the program says and for the controls that act on it.
- **Do** pair every colour distinction with weight, shape or position, so that it survives the print stylesheet.
- **Do** derive new values (sizes, weights, greys, offsets) from existing ones and record the derivation beside them in the CSS.
- **Do** honour `prefers-reduced-motion` by giving each new animation or transition a reduced-motion override that removes it, as the existing ones have.
- **Do** keep the motion short and functional: 140 to 160ms for reveals and fades, 260ms for panels collapsing.
- **Do** give a fixed line box to any element whose text changes language.

### Don't:
- **Don't** use vermilion in the chrome except for destructive actions and errors.
- **Don't** add a shadow to anything that doesn't float over the text.
- **Don't** set the source characters in a Chinese face; the edition is Japanese type.
- **Don't** let a panel heading or other furniture compete with the annotated text once there is text to read.
- **Don't** introduce a fourth hue for a new meaning; it joins one of the three voices.
