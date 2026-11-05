# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who already read *kanbun* and would rather correct a machine draft than rule every mark by hand.

- **Primary: teachers and students.** A teacher makes reading materials and handouts. A student works through a passage, and because the analysis is still often wrong, correcting its output is itself an exercise in reading. When a design trade-off has to favour one audience, it favours this classroom use.
- **Also served: researchers.** They prepare or check a text for study or publication.

Japanese-speaking and English-speaking users carry equal weight. The interface ships in both languages (`src/i18n/ja.json`, `src/i18n/en.json`), and both versions must be first-class.

## Product Purpose

Jidō Kundoku takes a passage of Literary Chinese and produces a first draft of a *kunten* text: *kaeriten*, *okurigana* and *furigana* set over the original, with a *kakikudashibun* beside it. The user corrects the draft in place and exports it as a PDF, as LaTeX (LuaLaTeX with the `kanbun` package) or as CoNLL-U.

The tool does the first pass; the judgements stay with the user. It succeeds when correcting the draft takes less work than marking the text up from scratch, and when the corrected result stands up as a printed edition would.

## Positioning

- **The analysis drives everything.** A dependency parser gives each character a part of speech and attaches it to the character it depends on. Rules then derive the reading order, the *kaeriten*, the readings and the *kakikudashibun* from that one analysis, so correcting the analysis corrects all of them at once.
- **No LLM at run time.** The parser was trained from scratch on the Kyoto Classical Chinese UD treebank. It runs entirely in the browser through Pyodide, collects no user data, and keeps working offline once the page has loaded.
- **One deliberate convention.** The tool follows the modern standard reading as kanbun.info (Web漢文大系) sets it out, and its rules are measured against the 3,419 passages on that site.

## Operating Context

- Input comes as pasted text or an uploaded CoNLL-U file. Sample texts are built in: 論語・學而, 聊齋志異・酒蟲 and 杜甫・春望.
- Texts are set vertically (*tategaki*). Arrow keys step along a line and across to the next one, following the two axes of vertical text.
- Editing works in place on the rendered text. The user can:
  - select a character;
  - change its part of speech, semantic field or sense;
  - change its relation;
  - drag it onto a new head;
  - choose another reading;
  - undo or redo any change.
- Texts can be saved locally, with autosave.
- **Printed output is a primary deliverable.** Teachers print handouts and researchers print drafts, so the print stylesheet and the PDF export carry as much weight as the screen.
- **Large screens come first.** The tool is used mainly on desktops and laptops; mobile is secondary.

## Capabilities and Constraints

- The stack is Vite and TypeScript with no UI framework. Vitest covers the code, and the site deploys to Vercel.
- The analysis is right about three times in four, so most texts need some correction. The UI has to make correction fast and legible rather than hide the error rate.
- Japanese-style *kanbun* (和化漢文) works poorly, because the parser learned only from texts written in China.
- Noto Serif JP is self-hosted and subsetted by unicode range.

## Brand Commitments

- **The page reads like a printed 訓点本.** Every mark the edition supplies (*kaeriten*, readings, *okurigana*, punctuation) is in vermilion (朱), the colour an editor would have added it in. The source characters stay in ink. Blue belongs only to the program's own analysis: dependency arcs, part-of-speech and relation labels, the current entry in a menu, and the reading of the character being pointed at.
- **The reading follows the modern standard convention**, as present-day annotated editions print it and as kanbun.info sets it out. The user's own characters stay as they stand, 舊字體 included. Kana are historical (學びて, 習ふ), and the grammar is 文語 on the Heian paradigms.
- The marks are those of a printed edition: レ点, 一二点 and 上中下点, *okurigana* in katakana, and a 再読文字 shown as its two readings at once.
- The tool reproduces no single house or manuscript tradition (博士家点, 道春点, 一斎点). Where readings legitimately differ, the majority of the kanbun.info passages decides, and the user can change the result.
- The voice is scholarly, precise and plain. It does not oversell the tool: the About text calls it a convenience, not a replacement for printed editions.

## Evidence on Hand

- The About FAQ (`src/i18n/*.json`, `about.faq.*`) gives the audience, the convention, the accuracy, the data sources and the privacy stance.
- The help modal (`src/render/HelpModal.ts`) walks through every editing gesture.
- Data sources: the Kyoto UD treebank, Wiktionary via kaikki.org, NINJAL UniDic and the `qieyun` package.
- The source code is public at github.com/skalyan91/jidou-kundoku.
- No testimonials, user counts or institutional endorsements exist. Future work must not invent them.

## Product Principles

1. **A draft to correct, not an answer to trust.** Every output can be changed in place, and every change takes effect immediately.
2. **The edition is the reference.** Typography and marks are checked against printed *kanbun* editions; the screen serves the page, and the page must survive printing.
3. **One convention, chosen openly.** Where readings differ, the tool picks one convention and says so, and leaves the alternatives within reach.
4. **Learning happens through correction.** The interface should make the analysis visible enough that a student learns by fixing it.
5. **Everything stays on the device.** No accounts, no tracking and no server-side analysis.

## Accessibility & Inclusion

- **Colour-blind safety is required.** Meaning must never rest on the red/blue distinction alone. A selection, for example, also carries weight, which survives both monochrome printing and a reader who cannot tell the two hues apart.
- Every interaction must be reachable from the keyboard along the axes of vertical text.
- The English and Japanese interfaces must be equally complete.
