---
name: Jidō Kundoku
description: Classical Chinese, read as Japanese — a draft kunten edition, set like print and corrected in place.
colors:
  shu-vermilion: "#8a2f1f"
  ai-indigo: "#1f4f8a"
  kinu-paper: "#faf7f0"
  panel-white: "#ffffff"
  sumi-ink: "#1c1a16"
  usuzumi: "#6b6357"
  hairline: "#d9d0bf"
  accent-grey: "#4e4e4e"
  shu-vermilion-dark: "#e08a6f"
  ai-indigo-dark: "#7fb2e6"
  kinu-paper-dark: "#17140f"
  panel-dark: "#201c15"
  sumi-ink-dark: "#ece6d8"
  usuzumi-dark: "#a89e8c"
  hairline-dark: "#3c352a"
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
    rounded: "{rounded.md}"
    padding: "0.55rem 1rem"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ai-indigo}"
    rounded: "{rounded.md}"
    padding: "0.55rem 1rem"
  button-secondary-hover:
    backgroundColor: "{colors.ai-indigo}"
    textColor: "{colors.panel-white}"
  input-text:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.sumi-ink}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
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
- Warm paper and warm ink in both light and dark themes.

## Colors

A two-pigment page, vermilion and ink on warm paper, with a single indigo reserved for the program.

### Primary
- **Shu Vermilion** (`shu-vermilion`; dark theme `shu-vermilion-dark`): the whole apparatus of the edition: *kaeriten*, readings, *okurigana* (a step softer, see below), punctuation and the 踊り字. It also marks **the selected character**, with added weight so that the selection survives monochrome printing. In the chrome it appears only where something is destroyed or has failed: the hover on a delete control and the error line of the status bar.

### Secondary
- **Ai Indigo** (`ai-indigo`; dark theme `ai-indigo-dark`): everything the program says. It colours the dependency arc and its arrowhead, the band drawn during a drag, the part-of-speech chips, the relation labels, the current entry in a menu, and the reading of the character under the pointer. In the chrome it is also the colour of every control: filled primary buttons, outlined secondary ones, row hover, checkboxes and links.

### Neutral
- **Kinu Paper** (`kinu-paper`; dark `kinu-paper-dark`): the page ground.
- **Panel White** (`panel-white`; dark `panel-dark`): raised working surfaces such as the textarea, dialogs, menus and labels. It is also the text colour on any indigo or vermilion fill.
- **Sumi Ink** (`sumi-ink`; dark `sumi-ink-dark`): the source characters and primary text.
- **Usuzumi** (`usuzumi`; dark `usuzumi-dark`): pale ink for labels, panel headings, status text and captions. Running prose that the reader reads through, such as the FAQ answers, is in Sumi Ink, so that it is never quieter than the question over it.
- **Hairline** (`hairline`; dark `hairline-dark`): the 1px borders on the sidebars, dialogs, inputs and menus.
- **Accent Grey** (`accent-grey`): a grey of the same relative luminance as Shu Vermilion. It boxes the existing head of a character, which is a fact about the parse rather than a choice, and must carry the same weight as the selection without reading as one. In the dark theme the greys matched to the vermilion (#a0a0a0) and the indigo (#aeaeae) differ; in the light theme they coincide.

### Derived tones
- **Soft vermilion**: Shu Vermilion mixed 67% toward the page (`color-mix(in srgb, accent 67%, bg)`), for the parts of the apparatus subordinate to another part, such as *okurigana* under its reading. Mixing toward the page makes the tone recede in both themes.

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

**The Heading Rhythm Rule.** The space above a heading is greater than the space below it, which is greater than the space between items: 2.6rem between FAQ sections, 0.9rem under a section heading, 1.4rem between questions.

## Elevation & Depth

Surfaces are flat at rest. Depth comes from tone (Panel White over Kinu Paper) and 1px hairlines. A shadow appears only on something that floats over the text.

### Shadow Vocabulary
- **Menu float** (`box-shadow: 0 6px 24px rgb(0 0 0 / 18%)`): context menus that open over the text.
- **Mark lift** (`--mark-lift: 0 2px 8px rgb(0 0 0 / 18%)`): relation labels and category chips laid over the analysis; used as a `box-shadow` on boxes and as `drop-shadow()` on clipped shapes, so that the two read as one lift.
- **Dialog backdrop** (`rgb(0 0 0 / 45%)`): the dimmed backdrop behind the Help and About dialogs, which themselves carry no shadow.

**The Lift Means Floating Rule.** Only an element that sits over the text gets a shadow. Panels, buttons, inputs and dialogs stay flat.

## Shapes

Corners are slightly softened and step up with the size of the surface: 0.25rem on chips, 0.3rem on small hit targets (saved rows, delete and close buttons, relation labels), 0.4rem on controls (buttons, the textarea, the export select, menus) and 0.6rem on dialogs. Borders are a single 1px hairline. Analysis marks are drawn with an inset 1.5px edge (`--mark-edge`) rather than a border, so the edge adds nothing to the box.

The part-of-speech chip is a signature shape. It has a chevron cut whose depth comes from the 〈 glyph in the edition face, and its semantic-field and sense chips fold out from behind it.

## Components

The controls are **plain and deferential**: small, quiet, outlined or filled in indigo, and never in competition with the vermilion of the text.

### Buttons
- **Shape:** softened corners (`rounded.md`).
- **Primary:** filled Ai Indigo with Panel White text and 0.55rem × 1rem padding (Annotate, Save).
- **Secondary:** transparent with an indigo 1px outline and indigo text; on hover it fills indigo. The export select copies this style, so it reads as one of the secondary buttons.
- **Disabled:** 50% opacity with a not-allowed cursor; the export select falls back to Usuzumi text on a hairline border instead.
- **Paired buttons:** buttons that offer equal choices split the row evenly (the samples, About and How to edit); a primary action beside a minor one takes the remaining space (Annotate beside Clear).

### Inputs / Fields
- **Textarea:** a Panel White field with a hairline border and `rounded.md` corners, set in the edition face at 1.1rem. It is 5rem tall (two lines of the edition face and a little over), so the input sidebar fits a laptop screen without scrolling, and resizes vertically.
- **Checkboxes:** native, with indigo as the accent colour.

### Saved-text list
- **Row:** a title in the edition face, truncated with an ellipsis; on hover it fills indigo. The delete control is a 1.75rem square that fills vermilion on hover. A row being dragged drops to 45% opacity.

### Analysis chips (signature)
- **Part-of-speech chip:** filled Ai Indigo with Panel White text at 600 weight and a chevron end, sitting under the character. On hover, the semantic-field and sense chips slide out from behind it (160ms per stage, staggered).
- **Relation label:** a Panel White box with an indigo inset edge and indigo text, lifted with the mark-lift shadow, placed on the dependency arc.

### Context menu
- **Style:** Panel White, hairline border, `rounded.md`, menu-float shadow, edition face at 1.25rem. It fades in over 160ms.
- **States:** hover and focus fill indigo with Panel White text. The current value is indigo text at 700 weight.

### Dialogs (Help, About)
- **Style:** Panel White, hairline border, `rounded.lg`, 2rem padding and a sticky header ruled off by a hairline. They cap at 88vh and 92vw. The close button is a 2rem square with a hairline border that darkens on hover. Links in the dialogs are indigo and underlined.

### Selection
- **Selected character:** Shu Vermilion at 600 weight. While a selection is up, everything except that character and its reading dims, so the reading is the only one left at full strength.
- **Existing head:** boxed in Accent Grey, a 2px stroke with a 2px halo.

## Do's and Don'ts

### Do:
- **Do** set every mark the edition supplies in Shu Vermilion, and soften the subordinate marks by mixing 67% toward the page.
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
