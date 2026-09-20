import type { Token, TokenTree } from "../parse/types.ts";
import { sourceLayoutOf } from "../parse/sourceLayout.ts";
import { rimeForPos, rimeFullName, rimesOf, type RimeIndex } from "../reading/rimeIndex.ts";

/** Regulated verse, found in a text by its own shape, and the 韻 its lines end
 * in — the whole of what the 訓読文 panel needs to print a rime beside a line.
 *
 * **Why the app has to work this out rather than be told.** Nothing in a
 * CoNLL-U tree says "this is a poem": the format has no genre field, the
 * parser has no notion of one, and a reader who pastes 國破山河在… into the box
 * has typed the same kind of thing as one who pastes 子曰學而時習之. So the
 * evidence has to be the text's own shape, and 近體詩 has a very particular
 * one — equal lines of five or seven characters, an even number of them, and a
 * rhyme on the even lines. Three facts, all checkable, and the third is the
 * one that does the work.
 *
 * ── The rule, and what each clause is keeping out ────────────────────────────
 *
 * The oracle for "must not fire on prose" is the kanbun.info corpus —
 * **3,419 passages** of 論語, 孫子, 六韜, 史記, 大学, 老子 and the rest, with no
 * verse in it at all (the corpus builder excludes the 集部 entire). Measured
 * over it by `tests/rimeDetector.test.ts`, which runs the count rather than
 * quoting it:
 *
 *   whole passages                    3,419    **0**
 *   contiguous 4/6/8-clause windows  19,377    **2**
 *
 * The windows are the harder test and the one worth reporting: a reader who
 * pastes four clauses out of the middle of the 孫子 has handed the app exactly
 * such a window, and 19,377 of them is a far wider net than 3,419 passages.
 * The two that survive are **one passage seen twice** — 呉子 治兵's 短者持矛戟／
 * 長者持弓弩／強者持旌旗／勇者持金鼓, once on its own and once inside the
 * six-clause window that contains it. It is four five-character lines rhyming
 * 弩 and 鼓 in 姥韻 with the third line staying out of the rhyme, which is to
 * say it is *rhymed mnemonic verse embedded in a prose book*, and nothing about
 * its shape distinguishes it from a 五言絶句 because in every respect this
 * index can see, it is one. That is the floor, not a defect to be tuned away.
 *
 * So the rhyme is not a refinement, it is the detector. The shape conditions
 * are cheap and are there to keep the rime index out of the hot path for the
 * texts that cannot be verse; the claim that this *is* verse rests on the even
 * lines rhyming, the odd lines not rhyming, and no character rhyming twice.
 *
 * **Three conditions were added in the order the measurement asked for them**,
 * and each is a real rule of 近體詩 rather than a threshold:
 *
 *   even lines share one 韻       the rhyme itself
 *   + no 重韻                     16 window hits -> 2
 *   + maximal runs (for a title)  0 -> 1 whole, 2 -> 3 windows
 *   + 出韻: odd lines stay out    1 -> **0** whole, 3 -> **2** windows
 *
 * The third row is the one to read carefully, because it went the wrong way.
 * Maximal runs were introduced so that a poem could carry a title (see
 * `detectVerse`), and they were expected to tighten the count as well — a
 * four-line window cut out of a longer run of same-length clauses is no longer
 * asked about on its own. They did not: what they did instead was let a
 * *passage* qualify on a run inside it, and 孫子 作戰's 賞其先得者… promptly did.
 * The 出韻 rule is what actually paid for the title, and it removed that hit at
 * both levels.
 *
 * ── 重韻: the rhyme words have to be different words ──────────────────────────
 *
 * Repeating a rhyme character is 重韻 and is a fault in 近體詩 — a poem uses
 * each 韻字 once. It is also, as it turns out, the single thing that separates
 * a poem from Chinese parallel prose: 必死可殺也／必生可虜也／忿速可侮也／
 * 廉潔可辱也 is four five-character lines whose even ends rhyme perfectly,
 * because they are the *same character*, 也 and 也. Requiring the even lines'
 * finals to be distinct took the window count from **16 to 2** — every one of
 * the fourteen it removed was a run of 之／之, 也／也 or 者／者 — and it costs a
 * real poem nothing, because a real poem does not do it either.
 *
 * ── What counts as a line ────────────────────────────────────────────────────
 *
 * A poem is written one line to a line, and this app already records that:
 * `annotateSourceLayout` measures the source's own newlines onto the tokens as
 * `LineBreak`, and a `.conllu` round trip preserves it. That is the primary
 * reading, and it is the one the shipped 春望 sample uses.
 *
 * **Falling back to punctuation is what makes the prose measurement mean
 * anything.** A text typed as one unbroken run has no `LineBreak` at all — and
 * that is exactly the state every one of the 3,419 prose passages is in, since
 * the corpus stores 白文 as a single string. Split at punctuation instead and
 * those passages become sequences of four- to six-character clauses, which is
 * the closest thing to verse that prose gets and therefore the honest thing to
 * test against. It is also right on its own account: a reader who pastes a
 * poem in with 、 between the lines and no newlines should still get the
 * annotation.
 *
 * ── 平仄 is deliberately not consulted ───────────────────────────────────────
 *
 * The other half of what makes verse *regulated* is its tone pattern, and this
 * index could check it — every 韻目 carries its 聲. It is not checked, for two
 * reasons. It would refuse 古體詩 written in five-character lines, which is
 * verse and wants the annotation as much as a 律詩 does; and it buys nothing,
 * since the rhyme condition already takes the prose false-positive count to
 * zero and there is nothing left for a second condition to remove. A test
 * that cannot fail is a test that will start failing for the wrong reason.
 */
export interface VerseShape {
  /** The **verse** lines, as arrays of tokens in source order, punctuation
   * dropped — not every line of the text. See `detectVerse`'s run rule. */
  lines: Token[][];
  /** 5 or 7 — every verse line's length in characters. */
  lineLength: number;
  /** The 韻目 the even lines agree on, where they agree on exactly one. More
   * than one candidate survives only when every even-line final is ambiguous
   * in the same two ways, which no real poem has been seen to do; the field is
   * a set rather than a value so that the case is representable instead of
   * being resolved by a coin toss. */
  rhyme: string[];
  /** Which line of the whole text the verse starts on — 2 for the shipped
   * 春望, whose 春望 and 杜甫 stand above it. */
  startLine: number;
  /** How many non-punctuation cells stand before it, which is what the panel
   * counts from. 4 for 春望: 春望杜甫. */
  offset: number;
}

/** Punctuation is not part of a verse line and is not counted in its length —
 * an edition that prints 國破山河在，城春草木深。 is setting the same five
 * characters as one that prints neither mark. */
function isPunct(token: Token): boolean {
  return token.pos === "PUNCT";
}

/** One CJK ideograph. Verse is counted in characters, and a line whose tokens
 * are not all single ideographs (a stray Latin gloss, a kana the reader typed)
 * is not a verse line however long it is. Extension B is in the class because
 * 4,035 of the rime index's own 19,499 characters are outside the BMP, and a
 * poem is entitled to use one; this is the class `tests/sampleTexts.test.ts`
 * counts Han with. */
const HAN = /^(?:[㐀-䶿一-鿿豈-﫿]|[\u{20000}-\u{2ffff}])$/u;

/** The text's lines: its own, if it has any, else its clauses.
 *
 * Exported because the panel needs the same partition to know where to hang
 * the annotation, and two walks that could disagree about where a line ends
 * would put a rime beside the wrong character. */
export function verseLinesOf(tree: TokenTree): Token[][] {
  const all = tree.sentences.flatMap((s) => s.tokens);
  const marked = all.some((t) => sourceLayoutOf(t)?.breakBefore);
  const lines: Token[][] = [];
  let current: Token[] = [];
  for (const token of all) {
    if (marked) {
      if (sourceLayoutOf(token)?.breakBefore && current.length > 0) {
        lines.push(current);
        current = [];
      }
      if (!isPunct(token)) current.push(token);
    } else {
      // No layout to read: a clause ends where its punctuation does, and the
      // punctuation belongs to the clause it closes rather than to the next.
      if (isPunct(token)) {
        if (current.length > 0) lines.push(current);
        current = [];
      } else {
        current.push(token);
      }
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** The 韻目 every even line's final character could be in — the intersection,
 * which is empty for a text whose even lines do not rhyme.
 *
 * **The intersection and not a majority**, because a majority would let one
 * line out of eight fail to rhyme and still call the text a poem, and that is
 * the licence a prose passage needs to slip through. A regulated poem rhymes
 * on every even line without exception; a text that does not is not one. */
function evenLineRhyme(index: RimeIndex, lines: Token[][]): string[] {
  const finals: string[] = [];
  for (let i = 1; i < lines.length; i += 2) finals.push(lines[i][lines[i].length - 1].text);
  // 重韻 — see the note at the head of this file. The same character twice is
  // a perfect rhyme and is what parallel prose does; a poem does not.
  if (new Set(finals).size !== finals.length) return [];
  let candidates: string[] | null = null;
  for (const final of finals) {
    const rimes = rimesOf(index, final);
    if (rimes.length === 0) return [];
    candidates = candidates === null ? rimes : candidates.filter((r) => rimes.includes(r));
    if (candidates.length === 0) return [];
  }
  return candidates ?? [];
}

/** The text's verse shape, or `null` for a text that is not verse.
 *
 * ── The run rule, and why the whole text is no longer asked ──────────────────
 *
 * A poem as anyone prints it has a title over it and a poet's name under that,
 * and the shipped 春望 sample now does too (see its own header for why the
 * title is text in the tree rather than chrome around it). Requiring *every*
 * line of the document to be five characters would have switched the whole
 * annotation off the moment the title arrived — 春望 is two.
 *
 * So the verse is a **maximal run of consecutive equal-length lines**: the run
 * is grown as far as it will go at both ends first, and only then tested. Two
 * things follow, and the second is the one worth having.
 *
 *  - A heading of a different length falls outside the run and is simply not
 *    part of the poem, which is what it is not.
 *  - **It loosens the rule at the whole-text level, and that was paid for
 *    elsewhere.** A run inside a passage can now qualify where the passage as a
 *    whole could not, and measured against the prose corpus that turned 0 false
 *    positives into 1 (孫子 作戰, 賞其先得者／而更其旌旗／車雜而乘之／卒善而養之).
 *    It was expected to do the opposite — a four-line window cut out of a
 *    longer run of clauses is no longer asked about on its own — and the
 *    expectation was simply wrong, which the measurement said and this note
 *    records rather than quietly dropping. What restored the 0 is `outLinesStayOut`
 *    below: that 孫子 run rhymes on its third line as well as its second and
 *    fourth, and no 絶句 does.
 *
 * **Exactly one run may qualify.** A document with two poems in it would leave
 * the app with no way to say which rhyme belongs to which line without a second
 * mechanism, and a second mechanism for a case nobody has is a place for a bug
 * to live. Two qualifying runs is answered `null` — no annotation — rather than
 * by picking one. */
export function detectVerse(tree: TokenTree, index: RimeIndex): VerseShape | null {
  const lines = verseLinesOf(tree);
  const found: VerseShape[] = [];
  let cellsBefore = 0;
  for (let start = 0; start < lines.length; ) {
    const lineLength = lines[start].length;
    let end = start;
    while (end < lines.length && lines[end].length === lineLength) end++;
    const run = lines.slice(start, end);
    const shape = qualifies(index, run, lineLength);
    if (shape) found.push({ ...shape, startLine: start, offset: cellsBefore });
    for (const line of run) cellsBefore += line.length;
    start = end;
  }
  return found.length === 1 ? found[0] : null;
}

/** The conditions, asked of one maximal run. Four lines is a 絶句 and is the
 * shortest thing this can be about; an odd number of lines has no even-line
 * rhyme scheme to check and is not regulated verse whatever else it is. */
function qualifies(
  index: RimeIndex,
  run: Token[][],
  lineLength: number,
): Pick<VerseShape, "lines" | "lineLength" | "rhyme"> | null {
  if (run.length < 4 || run.length % 2 !== 0) return null;
  if (lineLength !== 5 && lineLength !== 7) return null;
  if (run.some((line) => line.some((t) => !HAN.test(t.text)))) return null;
  const rhyme = evenLineRhyme(index, run);
  if (rhyme.length === 0) return null;
  if (!outLinesStayOut(index, run, rhyme)) return null;
  return { lines: run, lineLength, rhyme };
}

/** 出韻: the lines that are **not** supposed to rhyme must not rhyme.
 *
 * In 近體詩 the 出句 — the odd lines — end outside the rhyme, and an odd line
 * that falls in it anyway is a named fault. The first line is exempt, because
 * a 七言 poem's opening line commonly does rhyme (春望's does not; 早發白帝城's
 * does), so the rule runs from the third.
 *
 * **This is what the last of the prose false positives cost.** 賞其先得者／
 * 而更其旌旗／車雜而乘之／卒善而養之, four five-character clauses of the 孫子,
 * rhymes 旗 and 之 in 之韻 perfectly — and its *third* line ends 之 as well,
 * which no 絶句 would do. Rhymed parallel prose rhymes everywhere it can; a
 * regulated poem rhymes only where it is supposed to, and the difference is
 * visible in the same index that finds the rhyme in the first place.
 *
 * **Asked leniently, with `every` rather than `some`.** A 多音字 at the end of
 * an odd line is rejected only when the 廣韻 leaves it no reading outside the
 * poem's rhyme: 深 is 侵 or 沁, so a line ending 深 under a 侵 rhyme is read as
 * 沁 and allowed to stand. Rejecting on `some` would have thrown out a poem for
 * an ambiguity the poem itself resolves the other way. */
function outLinesStayOut(index: RimeIndex, run: Token[][], rhyme: string[]): boolean {
  for (let i = 2; i < run.length; i += 2) {
    const line = run[i];
    const rimes = rimesOf(index, line[line.length - 1].text);
    if (rimes.length > 0 && rimes.every((r) => rhyme.includes(r))) return false;
  }
  return true;
}

/** The numerals a count of rimes can be written with, 一 through 十. Indexed
 * from 0, so `NUMERAL[n - 1]` is the numeral for n. */
const NUMERAL = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** The label a 割注 prints for one line — a 韻目 named, or a count of them.
 *
 * ── Why the length is the design and not a detail ────────────────────────────
 *
 * A 割注 is two half-size columns set in one character's footprint, and
 * rime.css has that arithmetic: the box is `--size-main` across and
 * `--size-main` down, `font-size` is half a character and `line-height` is 1,
 * so it holds **exactly four half-size glyphs, two to a column**. A label of 2
 * comes out 1+1 and a label of 4 comes out 2+2 — both balanced, both centred on
 * the ink by the same `translateX(-50%)`. A label of 1, 3 or 5 comes out
 * lopsided, one column longer than the other beside a character that is
 * symmetric; and anything past 4 does not come out at all, because the box's
 * `height` is fixed and `.tategaki` is `overflow-y: hidden`.
 *
 * So every label this builds is 2 characters or 4, and these are the forms that
 * fit that while still saying what they are:
 *
 *   one 韻目        侵韻        2    what an editor writes
 *   two            海代二韻    4    「支脂二韻」, the 韻書's own idiom
 *   three or more  三韻        2    the count alone; the names go in the title
 *
 * **The full name would also have fitted, and is not used.** `rimeFullName`
 * gives 下平聲侵韻 and 上聲海韻, 5 characters and 4; the 5 could be brought to 4
 * by dropping the 聲 from the two 平 volumes (上平聲 -> 上平, 下平聲 -> 下平), the
 * other three volumes being two characters already, so a uniform 4 is reachable
 * from the fields the index actually holds. It is not taken, for two reasons.
 * It says nothing about the 多音字 case — 上聲海韻 and 去聲代韻 are 8 characters
 * together and still need a count word, so the family would need this form *and*
 * the ones below rather than instead of them. And the 聲 is not what the reader
 * of a poem is looking up: the rhyme's tone class is one fact about the whole
 * poem, stated once, and repeating it at the end of all eight lines spends half
 * of a 44px box on it. It stays in the `title`, in full and unabbreviated.
 *
 * ── The bare 韻目 was the old label, and it did not read as one ──────────────
 *
 * The reader: **"not sure what 海 is doing there."** 海 standing by itself
 * beside 國破山河在 is a stray character rather than a claim, and the 韻 after it
 * is the whole of what turns it into one. The 韻 was in fact being appended by
 * `annotateVerseRimes`, in the DOM writer — which put a decision about what the
 * page says in the one function this checkout cannot test, there being no
 * browser in it. It is built here now, where `tests/rimeDetector.test.ts` can
 * ask for it directly.
 *
 * ── The count word is what keeps the page from appearing to choose ───────────
 *
 * Where the 廣韻 gives a character two rimes and the poem gives no reason to
 * prefer one, both are shown, and the 二 states how many are meant: 海代二韻
 * reads "the two rimes 海 and 代" and cannot be read as a pick. The old form
 * joined them with a nakaguro — 海・代韻 — and at 22px against the character's
 * 44px that dot is very nearly not there: what the eye gets is 海, then 代韻,
 * which is a pick wearing a list's punctuation. This is the same complaint as
 * the one above and it has the same cause.
 *
 * ── Three and more are counted rather than named ─────────────────────────────
 *
 * Three names plus a count word is 5 characters, so it cannot be had. Three
 * names *without* one, 海代泰韻, is 4 and was rejected for two reasons. It would
 * be the only label in the family a reader has to count characters to parse —
 * every other multi-rime form ends in `<numeral>韻`, which says "this many, and
 * none of them chosen", and one exception to that costs more than the three
 * names are worth. And three unseparated 韻目 at half size is precisely the
 * illegibility the nakaguro was there to relieve and did not.
 *
 * **The case is real and it is uncommon.** 666 of the index's 19,499 characters
 * have three rimes or more — 585 have three, 75 four, 5 five, and 哆 has seven —
 * which is 3.4% of the book, and it reaches the page only on a line that ends in
 * one of them. The full names are always in the `title`, so nothing is lost that
 * a hover or a screen reader cannot recover. */
export function rimeLabel(rimes: string[]): string {
  if (rimes.length === 0) return "";
  if (rimes.length === 1) return `${rimes[0]}韻`;
  if (rimes.length === 2) return `${rimes[0]}${rimes[1]}二韻`;
  // Past 十 the numeral is itself two characters and 十一韻 would be 3, so the
  // label falls back to 數 — "several". The 廣韻 stops at 7, so this is a bound
  // being stated rather than a case being handled: `tests/rimeIndex.test.ts`
  // pins the multiplicities the shipped index actually has.
  return `${NUMERAL[rimes.length - 1] ?? "數"}韻`;
}

/** What to print beside the end of one line, and what to call it.
 *
 * `text` is the label `rimeLabel` builds — 侵韻, or 海代二韻 where the book gives
 * two and nothing chooses between them — 2 characters or 4, because that is what
 * a 割注 holds. `title` is the full name, 下平聲侵韻, for the tooltip and for
 * anything reading the page out; it lists **every** rime the label stands for,
 * including the ones a counted label does not name.
 *
 * **The poem's own rhyme is what resolves a 多音字, and only on the lines that
 * rhyme.** 深 is 侵 or 沁; 心 and 金, which end the fourth and sixth lines of
 * 春望, are 侵 and nothing else; so on the second line 深 prints 侵. That is an
 * inference from the poem and it is sound for a line the poem rhymes on. It is
 * *not* sound for an odd line, which does not rhyme and whose final character
 * the rhyme says nothing about.
 *
 * **On an odd line, a curated part-of-speech table gets the next attempt, and
 * only where it names an entry for this exact character and this exact UPOS.**
 * 在, ending 國破山河在, is 海 or 代 in the 廣韻; the rhyme scheme says nothing
 * about a line it does not rhyme on, but the two 音韻地位 are not a coin toss
 * either — 海's own witness glosses 在 「居也存也」, "to dwell, to exist", and
 * 代's glosses it 「所在」, "the place where", a verb sense against a nominal
 * one. The tree's own tag on this token, `v,動詞,存在,存在`, derives UPOS
 * `VERB`, `POS_RESOLVED_RIME` (`scripts/build-rime-index.py`) names 海 for
 * `在`+`VERB`, and 海韻 is what prints. Retag the token 名詞 and `rimeForPos`
 * answers 代 on the very next render, because nothing here is cached against
 * the token — see `annotateVerseRimes`'s own note on where the redraw comes
 * from.
 *
 * **A character or a UPOS the table does not name resolves nothing, on
 * purpose.** `rimeForPos` returns `undefined` for those and this function
 * falls through to `all`, printing every 韻目 exactly as it did before this
 * table existed. 平仄 is not consulted here either, for the reason
 * `detectVerse`'s own note gives against consulting it for *detection*: a
 * 古體詩 this annotation is just as entitled to as a 律詩 does not hold every
 * non-rhyming line to a 仄 final, so a rule that assumed it would resolve some
 * odd lines correctly and others by accident. A confidently wrong 韻目 is
 * worse than an honest 海代二韻, and this function would rather print the
 * second than guess at the first.
 *
 * So a label with no numeral in it means one of three things: the 廣韻 gives
 * the character only one 韻目, the poem's own rhyme picked one out, or the
 * token's own part of speech did — and a character the book gives several
 * never reaches the page as a silent pick among them. */
export function rimeGlossForLine(
  index: RimeIndex,
  verse: VerseShape,
  lineIndex: number,
): { text: string; title: string } | null {
  const line = verse.lines[lineIndex];
  const final = line[line.length - 1];
  const all = rimesOf(index, final.text);
  if (all.length === 0) return null;
  const rhymes = lineIndex % 2 === 1;
  let shown: string[];
  if (rhymes) {
    shown = all.filter((r) => verse.rhyme.includes(r));
  } else {
    const byPos = rimeForPos(index, final.text, final.pos);
    shown = byPos !== undefined && all.includes(byPos) ? [byPos] : all;
  }
  const chosen = shown.length > 0 ? shown : all;
  return {
    text: rimeLabel(chosen),
    title: chosen.map((r) => rimeFullName(index, r)).join("・"),
  };
}

/** **The least a kundoku column may hold for this text's rime to be visible**,
 * or 0 where the text carries no rime at all.
 *
 * rime.css states the bound and this is that statement, said once, in the
 * module the bound belongs to: *"The gloss ends (lineLength + 1) x
 * `--kanji-advance` from the top of its column, so a column has to hold one
 * character more than the poem's line length: six for a 五言, eight for a 七言.
 * Below that `.tategaki`'s `overflow-y: hidden` clips it."*
 *
 * **Exported because the fit has to know, and could not.** The 割注 is drawn
 * inside the last glyph's box and offset a whole cell below it — out of flow,
 * so it takes the column no advance, which is the whole reason to draw it that
 * way (see rime.css). The consequence is that nothing measurable changes when
 * it is clipped: the passage does not get longer, the extent does not move, and
 * `fitPassageExtent`'s search, which chooses the division of the page by
 * measuring those two things, took a cell out of the kundoku column for a
 * 五言 poem and clipped every warichū in it without a number anywhere moving.
 * A bound invisible to measurement has to be stated, and this states it.
 *
 * `+ 1` and not `+ 2`: the cell the gloss ends in is the one *after* the line's
 * last character, and a verse line closes on a `<br>`, so that cell holds
 * nothing of the line's own.
 *
 * Asked of the glosses and not merely of the shape, because a poem whose
 * every line-final character is outside the 廣韻 has no annotation to clip —
 * `annotateVerseRimes` hangs a box only where `rimeGlossForLine` answers. */
export function rimeColumnFloor(tree: TokenTree, index: RimeIndex): number {
  const verse = detectVerse(tree, index);
  if (!verse) return 0;
  const hung = verse.lines.some((_, at) => rimeGlossForLine(index, verse, at) !== null);
  return hung ? verse.lineLength + 1 : 0;
}

/** Where each line's gloss hangs, as an index into the panel's
 * non-punctuation cells in document order — the last character of the line.
 *
 * Pure and exported so that it can be checked without a DOM. There is no
 * browser in this checkout and no test renders the real panel (see
 * `tests/sampleTexts.test.ts`'s own note on what it can and cannot see), so
 * everything this feature decides is decided here and `annotateVerseRimes`
 * below is left with nothing but the insertion. */
export function rimeAnchors(verse: VerseShape): number[] {
  const anchors: number[] = [];
  // `offset` is what the heading costs: the panel's cells are the whole text's
  // and the verse is a run inside it, so the first verse line's last character
  // is not the fifth cell on the page but the ninth.
  let seen = verse.offset;
  for (const line of verse.lines) {
    seen += line.length;
    anchors.push(seen - 1);
  }
  return anchors;
}

/** The gloss's two columns. 割注 is set as two half-size columns reading in
 * the page's own direction, so the first column is the right-hand one under
 * `vertical-rl` — which is what two block children of a vertical box already
 * are, and why the split is made here in script rather than left to wrapping.
 * Wrapping would have to be given an inline size to wrap *at*, and would then
 * be free to put 3 glyphs in one column and 1 in the other.
 *
 * **The halves are always equal, and that is `rimeLabel`'s doing rather than
 * this function's.** Every label is 2 characters or 4, so the split is 1+1 or
 * 2+2 and the `ceil` never has an odd count to round. It is kept as a `ceil`
 * anyway — a split that silently dropped the last character of an odd string
 * would be a worse answer to a case that should not arise than a slightly
 * longer first column is. */
export function warichuColumns(text: string): [string, string] {
  const chars = [...text];
  const first = Math.ceil(chars.length / 2);
  return [chars.slice(0, first).join(""), chars.slice(first).join("")];
}

/** Hangs a rime on the end of every line of a text that is verse, and answers
 * how many it hung — 0 for a text that is not.
 *
 * **Inside the last `.kanji-glyph` of the line, not beside its cell.** That is
 * where every other mark this panel makes about a character lives —
 * `.kunten-glyph`'s own note in kunten.css says it in as many words ("written
 * inside the glyph so they can hang off its side") — and it is the only anchor
 * that can be centred on the character. `.kanji-cell` is *wider* than the
 * glyph, because the reading's lane is inside it; `.token-subtitle-row` places
 * itself from "the glyph's own horizontal centre (not the wider ruby-inclusive
 * `.kanji-cell`)" for exactly this reason, and a gloss centred on the cell
 * would sit half a reading's width off the character it belongs to. The glyph
 * is `position: relative` already, so it is a containing block without this
 * having to make one.
 *
 * **Inside that glyph's box, but drawn a whole cell below it.** rime.css offsets
 * the gloss by `100% + var(--kanji-gap)` so that it stands where the *next*
 * character would, and not in the gap immediately under the last one — that gap
 * is the kaeriten's and the 踊り字's, and the gloss was taking all of it. The
 * anchor and the position are two different questions and this is the file that
 * answers the first; see rime.css for the second, and for the measurement.
 *
 * **Run after `settleKundokuColumn`, not before.** `glueOpeningPunctForward`
 * moves cells between sentences and reads `.sentence-gap > *`, and cells stop
 * moving once it has run. Nothing this adds is a `.kanji-cell`, which is the
 * other half of staying out of the way: `animateCharacterReveal`,
 * `bareCellCount` and `keyedCells` all count or key on that class.
 *
 * **Where the redraw a retag needs comes from, and why nothing here has to ask
 * for one.** `rimeGlossForLine`'s part-of-speech resolution reads `final.pos`
 * off the tree's own token, live, every time it is called — it holds nothing
 * from a previous call and nothing keyed on the token's identity. So the
 * *only* thing retagging a line-final has to do to change its rime label is
 * cause this function to run again over the same tree, and that already
 * happens: `tokenInspector.ts`'s `applyTokenEdit` mutates the token in place
 * and calls `onTreeEdit` (`main.ts`'s `redrawInPlace`, wired through
 * `setTokenEditHandler`), which runs the full `renderKundokuView` — this
 * function included — over the tree exactly as a fresh parse does. There is
 * no second path a retag takes and none is added here: this module reacts to
 * an edit only in the sense that the answer it computes over a mutated tree
 * differs from the answer it computed over the tree before the mutation.
 * Retagging back to the original 品詞 restores the original label the same
 * way, on the next redraw, because the computation has no memory to clear.
 * Retagging a token that is not a line final changes nothing this function
 * draws, because `rimeAnchors` never names its position — see that function.
 *
 * The count of cells is checked against the tree before anything is inserted.
 * The anchors are positions in a list, so a panel whose cells and whose tree
 * had come apart — a 再読文字 drawn twice, a graph the renderer split — would
 * hang every gloss one character out with nothing to say it had. Bailing is
 * the only safe answer to that, and it is silent because a text that is not
 * verse takes the same exit. */
export function annotateVerseRimes(column: HTMLElement, tree: TokenTree, index: RimeIndex): number {
  const verse = detectVerse(tree, index);
  if (!verse) return 0;
  const cells = [...column.querySelectorAll<HTMLElement>(".kanji-cell")].filter(
    (el) => !el.classList.contains("punct-cell"),
  );
  // Every non-punctuation cell of the whole text, heading included — the
  // anchors are indexes into this list and `verse.offset` is what carries the
  // heading. Checked against the tree rather than against the run.
  const expected = verseLinesOf(tree).reduce((n, line) => n + line.length, 0);
  if (cells.length !== expected) return 0;

  const anchors = rimeAnchors(verse);
  let hung = 0;
  for (let i = 0; i < anchors.length; i++) {
    const gloss = rimeGlossForLine(index, verse, i);
    if (!gloss) continue;
    // The character's own box, inside the cell. A cell always has one; a cell
    // that somehow did not would put the gloss nowhere in particular, so it is
    // skipped rather than guessed at.
    const anchor = cells[anchors[i]].querySelector<HTMLElement>(".kanji-glyph");
    if (!anchor) continue;
    const box = document.createElement("span");
    box.className = "rime-warichu";
    box.dataset.rime = gloss.text;
    box.title = gloss.title;
    // The label is taken as it comes. It used to be built here — the 韻 was
    // appended at this line — and that put a decision about what the page says
    // in the one function with a DOM in it, which is the one function this
    // checkout cannot test. See `rimeLabel`.
    for (const part of warichuColumns(gloss.text)) {
      const col = document.createElement("span");
      col.className = "rime-warichu-line";
      col.textContent = part;
      box.append(col);
    }
    anchor.append(box);
    hung++;
  }
  return hung;
}
