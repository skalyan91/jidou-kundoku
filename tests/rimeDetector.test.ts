import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Token, TokenTree } from "../src/parse/types.ts";
import { rimesOf, type RimeIndex } from "../src/reading/rimeIndex.ts";
import {
  detectVerse,
  rimeAnchors,
  rimeGlossForLine,
  rimeLabel,
  verseLinesOf,
  warichuColumns,
} from "../src/render/rimeAnnotation.ts";

// ---------------------------------------------------------------------------
// The poetry detector, and the one number that says whether it works.
//
// A detector that fires on prose is wrong, and this project has an oracle for
// prose: `tests/fixtures/kanbun-info-parses.conllu`, thousands of passages of
// 論語, 孫子, 六韜, 史記, 大学, 老子 and the rest, with no verse in it at all —
// the corpus builder excludes the 集部 entire, so every hit is a false one by
// construction. That is measured below rather than quoted, because a number in
// a comment is a number that will go stale.
//
// The corpus is gitignored and the suite skips where it is absent (see
// `tests/kanbunInfoCorpus.test.ts`, which is where the build command lives).
// Everything above that block runs everywhere.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(readFileSync(join(ROOT, "public", "data", "rime-index.json"), "utf-8")) as RimeIndex;
const sample = (name: string) => parseConllu(readFileSync(join(ROOT, "public", "data", "samples", name), "utf-8"));

/** A tree from bare text, with the layout a reader's own newlines would give
 * it — `annotateSourceLayout`'s `LineBreak=line` on the first token of every
 * line after the first. Written out here rather than run through the parser,
 * as `tests/adverbialClauseParticles.test.ts` writes its trees out: what is
 * being tested is the shape, and a live parse is free not to return it. */
function versified(lines: string[], pos = "NOUN"): TokenTree {
  const tokens: Token[] = [];
  let id = 0;
  lines.forEach((line, li) => {
    [...line].forEach((ch, ci) => {
      const token: Token = { id, text: ch, lemma: ch, pos, xpos: "n,名詞,可搬,道具", dep: id === 0 ? "ROOT" : "mod", head: 0 };
      if (li > 0 && ci === 0) token.misc = { LineBreak: "line" };
      tokens.push(token);
      id++;
    });
  });
  return { sentences: [{ tokens }], source: "conllu" };
}

describe("春望, the shipped verse sample", () => {
  const tree = sample("shunbou.conllu");

  it("is found to be verse: eight lines of five, rhyming 侵", () => {
    const verse = detectVerse(tree, index)!;
    expect(verse).not.toBeNull();
    expect(verse.lines).toHaveLength(8);
    expect(verse.lineLength).toBe(5);
    // One 韻目 and not two: 深 and 簪 are each ambiguous, but 心 and 金 are not,
    // and the intersection over all four even-line finals is 侵 alone. That is
    // kanbun.info's own 「深・心・金・簪（下平声侵韻）」, arrived at from the poem.
    expect(verse.rhyme).toEqual(["侵"]);
    expect(verse.lines.map((l) => l.map((t) => t.text).join(""))).toEqual([
      "國破山河在",
      "城春草木深",
      "感時花濺淚",
      "恨別鳥驚心",
      "烽火連三月",
      "家書抵萬金",
      "白頭搔更短",
      "渾欲不勝簪",
    ]);
  });

  it("finds the lines by `LineBreak`, across the couplets that are one sentence", () => {
    // The sample's sentences are couplets, not lines — seven sentences for ten
    // lines. So the line partition cannot be the sentence partition and has to
    // be the layout, which is the whole reason `LineBreak` is on the tokens
    // rather than being inferred from where a sentence ends.
    expect(tree.sentences).toHaveLength(7);
    expect(verseLinesOf(tree).map((l) => l.map((t) => t.text).join(""))).toEqual([
      "春望",
      "杜甫",
      "國破山河在",
      "城春草木深",
      "感時花濺淚",
      "恨別鳥驚心",
      "烽火連三月",
      "家書抵萬金",
      "白頭搔更短",
      "渾欲不勝簪",
    ]);
  });

  it("steps over the title and the poet, and says where the poem starts", () => {
    // **The case the run rule exists for.** 春望 is two characters and 杜甫 is
    // two; a rule that asked the whole document to be five-character lines
    // would have switched the annotation off the moment the sample got its
    // title. The heading is its own maximal run, of two lines, and fails the
    // four-line minimum; the poem is the next run and is the only one that
    // qualifies.
    const verse = detectVerse(tree, index)!;
    expect(verse.startLine).toBe(2);
    expect(verse.offset).toBe(4); // 春望杜甫
    expect(verse.lines).toHaveLength(8);
    expect(verse.lines[0].map((t) => t.text).join("")).toBe("國破山河在");
  });

  it("resolves 深 to 侵韻 on the line that rhymes, and 在 to 海韻 from its own part of speech", () => {
    // **This is the whole of what the app does about a 多音字**, and both halves
    // matter. 深 is 侵 or 沁 in the 廣韻; the second line rhymes, the poem's
    // rhyme is 侵, so 侵 is what is printed and the claim is one the poem
    // supports. 在 ends the *first* line, which does not rhyme, so the poem
    // says nothing about which of 海 and 代 it is — but the sample's own tag on
    // this token is `v,動詞,存在,存在`, which derives UPOS `VERB`, and
    // `POS_RESOLVED_RIME` names 海 for 在's verb sense (居也存也, "to dwell,
    // to exist" — the sample's own 山河在, an intransitive verb, and not 代's
    // nominal 所在, "the place where"). 海韻 is what prints, on evidence the
    // rhyme scheme cannot give and the 廣韻's own glosses do.
    const verse = detectVerse(tree, index)!;
    expect(rimesOf(index, "深")).toEqual(["侵", "沁"]);
    expect(rimeGlossForLine(index, verse, 1)).toEqual({ text: "侵韻", title: "下平聲侵韻" });
    expect(verse.lines[0][verse.lines[0].length - 1].xpos).toBe("v,動詞,存在,存在");
    expect(rimeGlossForLine(index, verse, 0)).toEqual({ text: "海韻", title: "上聲海韻" });
    // The other three rhyme words, each resolved to the one the poem picks.
    expect(rimeGlossForLine(index, verse, 3)!.text).toBe("侵韻"); // 心
    expect(rimeGlossForLine(index, verse, 5)!.text).toBe("侵韻"); // 金
    expect(rimeGlossForLine(index, verse, 7)!.text).toBe("侵韻"); // 簪, whose other rime is 覃
  });

  it("retags 在 to a noun and prints 代韻 instead — and back again", () => {
    // **The reactivity the token inspector relies on, exercised directly and
    // without a DOM.** `rimeGlossForLine` reads `final.pos` fresh on every
    // call; nothing it computes is kept from the call before. So retagging the
    // token — exactly what `tokenInspector.ts`'s 品詞 menu does to `token.pos`
    // before the next redraw — changes the answer on the very next call, and
    // restoring the original tag restores the original answer, with no third
    // state reachable in between and nothing to reset by hand.
    const verse = detectVerse(tree, index)!;
    const final = verse.lines[0][verse.lines[0].length - 1];
    expect(final.text).toBe("在");
    const original = final.pos;
    try {
      final.pos = "NOUN";
      expect(rimeGlossForLine(index, verse, 0)).toEqual({ text: "代韻", title: "去聲代韻" });
      // A UPOS the table names nothing for this character under (在's table
      // entry is VERB/NOUN only) falls back to both, the same as before the
      // table existed — never a silent third pick.
      final.pos = "ADV";
      expect(rimeGlossForLine(index, verse, 0)).toEqual({ text: "海代二韻", title: "上聲海韻・去聲代韻" });
      final.pos = original;
      expect(rimeGlossForLine(index, verse, 0)).toEqual({ text: "海韻", title: "上聲海韻" });
    } finally {
      final.pos = original;
    }
  });

  it("resolves any of the curated table's characters, not only 在, and stops at a part of speech it does not name", () => {
    // 在 is one of 21 — the fault a table with one entry could not show is a
    // second entry read wrong, so this asks the same question of 雨.
    const tree = versified(["孤舟聽夜雨", "江上聽秋深", "遙山隔煙短", "獨客夢邊心"]);
    const verse = detectVerse(tree, index)!;
    expect(verse).not.toBeNull();
    const final = verse.lines[0][verse.lines[0].length - 1];
    expect(final.text).toBe("雨");
    expect(rimesOf(index, "雨")).toEqual(["麌", "遇"]);
    final.pos = "NOUN";
    expect(rimeGlossForLine(index, verse, 0)).toEqual({ text: "麌韻", title: "上聲麌韻" });
    final.pos = "VERB";
    expect(rimeGlossForLine(index, verse, 0)).toEqual({ text: "遇韻", title: "去聲遇韻" });
    // 雨's own entry is NOUN/VERB and nothing else — a third tag resolves
    // nothing, the same as a character the table does not curate at all.
    final.pos = "ADJ";
    expect(rimeGlossForLine(index, verse, 0)).toEqual({ text: "麌遇二韻", title: "上聲麌韻・去聲遇韻" });
  });

  it("never consults the table for a character it does not curate", () => {
    // 深 has two rimes and ends a line that does not rhyme here, which is
    // exactly the shape 在 and 雨 are resolved in above — the difference is
    // that `POS_RESOLVED_RIME` has no entry for 深, and none of its own two
    // 廣韻 witnesses were checked and admitted, so both print whatever the
    // token's own tag says.
    const tree = versified(["孤舟聽夜深", "江上聽秋心", "遙山隔煙短", "獨客夢邊金"]);
    const verse = detectVerse(tree, index)!;
    expect(verse).not.toBeNull();
    const final = verse.lines[0][verse.lines[0].length - 1];
    expect(final.text).toBe("深");
    for (const pos of ["NOUN", "VERB", "ADJ"]) {
      final.pos = pos;
      expect(rimeGlossForLine(index, verse, 0), pos).toEqual({ text: "侵沁二韻", title: "下平聲侵韻・去聲沁韻" });
    }
  });

  it("does not let a curated character's part of speech override the line it rhymes on", () => {
    // 處 is in the table (VERB -> 語, NOUN -> 御), but its own rime, 御, is not
    // the poem's own rhyme, and a rhyming line is resolved by the poem and
    // never by the table — `rimeGlossForLine` only reaches `rimeForPos` in the
    // branch where `rhymes` is false. Wearing 處 as an even-line rhyme word
    // where the poem's rhyme is 御 checks that the table is not consulted
    // there at all, whatever part of speech the token carries.
    const tree = versified(["孤舟聽夜語", "江上聽秋處", "遙山隔煙短", "獨客夢邊據"], "NOUN");
    const verse = detectVerse(tree, index)!;
    expect(verse).not.toBeNull();
    expect(verse!.rhyme).toEqual(["御"]);
    const final = verse!.lines[1][verse!.lines[1].length - 1];
    expect(final.text).toBe("處");
    final.pos = "VERB"; // 處's own table entry would print 語韻 on a line it did not rhyme on
    expect(rimeGlossForLine(index, verse!, 1)).toEqual({ text: "御韻", title: "去聲御韻" });
  });

  it("prints eight labels and every one of them is 2 characters or 4", () => {
    // **The whole poem, pinned as the page sets it**, because the label scheme
    // is a claim about every line and not about the two interesting ones. The
    // four even lines carry the rhyme, resolved to 侵 by the poem; the four odd
    // ones carry whatever the book gives their final character, which is one
    // rime for 淚 至, 月 月 and 短 緩, and 在's own 品詞 for 在.
    //
    // The fault this would have caught: the label used to be the bare 韻目 with
    // 韻 appended in the DOM writer, so the first line read 海・代韻 and a reader
    // asked what 海 was doing there. Nothing in the suite could see that string,
    // because the only function that built it was the one with a DOM in it.
    const verse = detectVerse(tree, index)!;
    const labels = verse.lines.map((_, i) => rimeGlossForLine(index, verse, i)!.text);
    expect(labels).toEqual(["海韻", "侵韻", "至韻", "侵韻", "月韻", "侵韻", "緩韻", "侵韻"]);
    for (const label of labels) expect([2, 4], label).toContain([...label].length);
    // And the full names stay in the `title`, where a hover and a screen reader
    // reach them — the short label is for the page and only for the page.
    const titles = verse.lines.map((_, i) => rimeGlossForLine(index, verse, i)!.title);
    expect(titles).toEqual([
      "上聲海韻",
      "下平聲侵韻",
      "去聲至韻",
      "下平聲侵韻",
      "入聲月韻",
      "下平聲侵韻",
      "上聲緩韻",
      "下平聲侵韻",
    ]);
  });

  it("hangs each gloss on the fifth cell of its line, counting from the title", () => {
    // The anchors are positions in the panel's list of non-punctuation cells,
    // which is what `annotateVerseRimes` walks — and the panel draws the
    // heading's four cells too, so the first line's end is the *ninth* cell and
    // not the fifth. Getting this wrong by the width of the heading is the one
    // way this feature can put every gloss on the wrong character while
    // looking entirely healthy, which is why it is pinned as a list.
    const verse = detectVerse(tree, index)!;
    expect(rimeAnchors(verse)).toEqual([8, 13, 18, 23, 28, 33, 38, 43]);
    const cells = tree.sentences.flatMap((s) => s.tokens).filter((t) => t.pos !== "PUNCT");
    expect(cells).toHaveLength(44);
    expect(rimeAnchors(verse).map((i) => cells[i].text)).toEqual([..."在深淚心月金短簪"]);
  });
});

describe("the two prose samples", () => {
  it("are not verse", () => {
    // 論語・學而 and 聊齋志異・酒蟲, the app's own shipped prose, through the same
    // call the panel makes.
    expect(detectVerse(sample("rongo-gakuji.conllu"), index)).toBeNull();
    expect(detectVerse(sample("shuchu.conllu"), index)).toBeNull();
  });
});

describe("what the rule refuses", () => {
  it("refuses four five-character lines whose ends do not rhyme", () => {
    // The shape is a 五言絶句's exactly; 道/名/母/妙 are 晧/清/厚/笑 and the even
    // ends (名 清, 妙 笑) share nothing. Shape alone would have taken it.
    expect(detectVerse(versified(["道可道非常", "名可名非常", "無名天地始", "有名萬物母"]), index)).toBeNull();
  });

  it("refuses 重韻 — the same character twice is not a rhyme scheme", () => {
    // 孫子・九變, four five-character lines of parallel prose whose even ends
    // are 也 and 也. A perfect rhyme by any test that only asks about 韻目, and
    // the single commonest way prose looks like verse: this is what took the
    // corpus window count from 16 to 2. See `rimeAnnotation.ts`'s note.
    const lines = ["必死可殺也", "必生可虜也", "忿速可侮也", "廉潔可辱也"];
    // The shape is right and the rime is shared — it is refused anyway.
    expect(verseLinesOf(versified(lines))).toHaveLength(4);
    expect(rimesOf(index, "也")).toContain("馬");
    expect(detectVerse(versified(lines), index)).toBeNull();
  });

  it("refuses 出韻 — a poem does not rhyme on the lines that are not supposed to", () => {
    // 孫子 作戰, four five-character clauses: 旗 and 之 end the second and
    // fourth and are both 之韻, distinct characters, a perfect rhyme by every
    // test above. What gives it away is the *third* line, which also ends 之 —
    // and in 近體詩 the 出句 end outside the rhyme. Rhymed parallel prose rhymes
    // wherever it can; a regulated poem rhymes only where it should.
    //
    // **This is what paid for the poem's title.** Finding the verse as a
    // maximal run (so that a two-character heading could stand above it) let a
    // qualifying run inside a longer passage count, and took the corpus's
    // whole-passage false positives from 0 to 1 — this passage. The 出韻 rule
    // took it back to 0. See `detectVerse`.
    const lines = ["賞其先得者", "而更其旌旗", "車雜而乘之", "卒善而養之"];
    expect(rimesOf(index, "旗")).toContain("之");
    expect(rimesOf(index, "之")).toEqual(["之"]);
    expect(detectVerse(versified(lines), index)).toBeNull();
  });

  it("exempts the first line, which a 七言 poem commonly does rhyme", () => {
    // The rule runs from the *third* line. 春望's own first line does not
    // rhyme, so the sample cannot show this; these two are **constructed**,
    // and say so — they are not lines of anybody's poem, only the two
    // arrangements the exemption has to tell apart. A first line inside the
    // rhyme leaves the poem standing; a third line inside it does not.
    const rhyming = ["春風侵客心", "江上月華深", "孤舟何處泊", "遙夜聽鳴金"];
    const verse = detectVerse(versified(rhyming), index);
    expect(verse?.rhyme).toEqual(["侵"]);
    // Move the same 侵 rhyme onto the third line instead and it is refused.
    const faulty = ["江上月華明", "孤舟泊遠心", "春風侵客金", "遙夜聽鳴深"];
    expect(detectVerse(versified(faulty), index)).toBeNull();
  });

  it("refuses an odd number of lines, and fewer than four", () => {
    // Nothing with an odd count has an even-line rhyme scheme to be checked
    // against; a 絶句 is the shortest regulated poem there is.
    expect(detectVerse(versified(["國破山河在", "城春草木深", "感時花濺淚"]), index)).toBeNull();
    expect(detectVerse(versified(["國破山河在", "城春草木深"]), index)).toBeNull();
  });

  it("refuses lines that are not all the same length, or not five or seven", () => {
    expect(detectVerse(versified(["國破山河在", "城春草木深深", "感時花濺淚", "恨別鳥驚心"]), index)).toBeNull();
    // Four four-character lines rhyming perfectly — 詩経's metre, not 近體詩's,
    // and outside what this annotation claims to know about.
    expect(detectVerse(versified(["關關雎鳩", "在河之洲", "窈窕淑女", "君子好逑"]), index)).toBeNull();
  });

  it("refuses a line with anything in it that is not one ideograph", () => {
    const lines = ["國破山河在", "城春草木ん", "感時花濺淚", "恨別鳥驚心"];
    expect(detectVerse(versified(lines), index)).toBeNull();
  });
});

describe("the 割注's two columns", () => {
  it("splits every real label down the middle, 1+1 or 2+2", () => {
    // 割注 is read in the page's own direction, so the first column is the one
    // the eye reaches first. The split is made here rather than left to
    // wrapping because wrapping would be free to break 海代二韻 as 3 and 1 —
    // see `rime.css`.
    //
    // **The halves are equal because the labels are 2 or 4**, which is the
    // point of the scheme and is what this pins: a lopsided 割注 under a
    // symmetric glyph is what 3 characters buys, and 3 is the length the old
    // 海・代韻-style labels could not avoid once the nakaguro came out.
    expect(warichuColumns("侵韻")).toEqual(["侵", "韻"]);
    expect(warichuColumns("海代二韻")).toEqual(["海代", "二韻"]);
    expect(warichuColumns("三韻")).toEqual(["三", "韻"]);
    // Never reached, and kept honest anyway: an odd count rounds up rather than
    // dropping the last character.
    expect(warichuColumns("韻")).toEqual(["韻", ""]);
    expect(warichuColumns("海代韻")).toEqual(["海代", "韻"]);
  });
});

// ---------------------------------------------------------------------------
// The label, over the whole index rather than over the poem.
//
// **The fault is a class and not a case.** 春望's eight lines end in characters
// the 廣韻 gives one rime or two, so a scheme that is wrong for three rimes or
// for seven passes every assertion above. The index has 666 characters with
// three or more and any of them can end a line of a reader's own poem, so the
// property is asked of all 19,499.
// ---------------------------------------------------------------------------

describe("every rime label is 2 characters or 4", () => {
  const chars = Object.keys(index.chars);
  const rimes = Object.keys(index.rimes);

  it("holds for every character in the index, whatever the book gives it", () => {
    // The 割注 box is `--size-main` square with a half-character `font-size`, so
    // it holds exactly four half-size glyphs, two to a column: 2 sets as 1+1 and
    // 4 as 2+2, while 1, 3 and 5 are lopsided and 6 and up are clipped by
    // `.tategaki`'s `overflow-y: hidden`. See `rime.css`.
    const bad = chars.filter((ch) => ![2, 4].includes([...rimeLabel(rimesOf(index, ch))].length));
    expect(bad.map((ch) => `${ch} -> ${rimeLabel(rimesOf(index, ch))}`)).toEqual([]);
    expect(chars).toHaveLength(19499);
  });

  it("holds for every 韻目 standing alone, which is what a rhyming line prints", () => {
    // An even line's label is the poem's own rhyme, a subset of the character's
    // rimes and usually a single 韻目 — so the 206 singletons are reached by a
    // different path from the one above and are asked separately.
    expect(rimes).toHaveLength(206);
    for (const rime of rimes) expect([...rimeLabel([rime])], rime).toHaveLength(2);
  });

  it("names two and counts three or more, and the numeral says how many", () => {
    // The forms, one example each, drawn from the index rather than invented.
    // 樂 and 行 are the familiar 多音字 of the three- and four-rime classes; 差
    // has five and 哆 has seven, which is the most the 廣韻 gives anything.
    expect(rimesOf(index, "在")).toEqual(["海", "代"]);
    expect(rimeLabel(rimesOf(index, "在"))).toBe("海代二韻");
    expect(rimesOf(index, "樂")).toEqual(["效", "覺", "鐸"]);
    expect(rimeLabel(rimesOf(index, "樂"))).toBe("三韻");
    expect(rimesOf(index, "行")).toEqual(["唐", "庚", "宕", "映"]);
    expect(rimeLabel(rimesOf(index, "行"))).toBe("四韻");
    expect(rimeLabel(rimesOf(index, "差"))).toBe("五韻");
    expect(rimeLabel(rimesOf(index, "哆"))).toBe("七韻");
    // **Never a pick, which is the constraint the count word is there to keep.**
    // Every label for a character with more than one rime carries a numeral, so
    // no reader can take a label for the name of a single 韻目 the app chose;
    // and no label for a character with exactly one carries a numeral, so the
    // numeral itself is unambiguous.
    for (const ch of chars) {
      const n = rimesOf(index, ch).length;
      const label = rimeLabel(rimesOf(index, ch));
      expect([...label].some((c) => "二三四五六七八九十數".includes(c)), `${ch} -> ${label}`).toBe(n > 1);
    }
  });

  it("is what the old scheme could not do, at any length past two rimes", () => {
    // **What this block would have caught**, reproduced rather than described:
    // the label was `rimes.join("・") + "韻"`, which is 2n characters for n
    // rimes. It happened to be 2 and 4 for the one and two-rime characters that
    // end the lines of 春望 — so the sample never showed it — and 6, 8, 10 and 14
    // for the rest of the index, which is a box-and-a-half to three-and-a-half
    // boxes of ink in a box that clips.
    const old = (rs: string[]) => `${rs.join("・")}韻`;
    expect(old(rimesOf(index, "深"))).toHaveLength(4); // 侵・沁韻, and 2 once the poem resolves it
    expect(old(rimesOf(index, "樂"))).toHaveLength(6); // 效・覺・鐸韻
    expect(old(rimesOf(index, "哆"))).toHaveLength(14); // 麻・紙・哿・馬・志・箇・禡韻
    const bad = chars.filter((ch) => ![2, 4].includes([...old(rimesOf(index, ch))].length));
    expect(bad.length).toBe(666);
    // Dropping the nakaguro would not have saved it either: n + 1 characters is
    // 3 for two rimes, which sets as 2 + 1 under a symmetric glyph.
    expect(`${rimesOf(index, "在").join("")}韻`).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The measurement.
// ---------------------------------------------------------------------------

const PARSES_PATH = join(ROOT, "tests", "fixtures", "kanbun-info-parses.conllu");

if (existsSync(PARSES_PATH)) {
  describe("measured against the kanbun.info prose corpus", () => {
    const passages: TokenTree[] = [];
    {
      const raw = readFileSync(PARSES_PATH, "utf-8");
      let lines: string[] | null = null;
      for (const line of raw.split("\n")) {
        if (/^# passage = /.test(line)) {
          if (lines) passages.push(parseConllu(lines.join("\n")));
          lines = [];
          continue;
        }
        lines?.push(line);
      }
      if (lines) passages.push(parseConllu(lines.join("\n")));
    }

    it("has a corpus of prose and nothing else to measure against", () => {
      // The count is the corpus's, and it moves when the corpus is rebuilt;
      // what is asserted is the order of magnitude, so that a fixture that had
      // been truncated could not pass the measurement below by having nothing
      // in it.
      expect(passages.length).toBeGreaterThan(3000);
    });

    it("fires on none of them", () => {
      // **0, and 0 is the only acceptable number.** Every passage here is
      // prose, so every hit is a false positive.
      const hits = passages.filter((tree) => detectVerse(tree, index) !== null);
      expect(hits.map((t) => t.sentences.flatMap((s) => s.tokens).map((k) => k.text).join(""))).toEqual([]);
    }, 60_000);

    it("fires on 2 of the 19,377 four-, six- and eight-clause windows cut out of them", () => {
      // **The harder test, and the one the rule was tuned against.** A reader
      // who pastes four clauses out of the middle of the 孫子 has handed the app
      // exactly such a window, and there are five times as many windows as
      // passages.
      //
      // **The two are one passage seen twice.** 呉子 治兵's 短者持矛戟／長者持弓弩／
      // 強者持旌旗／勇者持金鼓 is caught on its own and again inside the
      // six-clause window that contains it (whose first two clauses are three
      // and four characters, so the maximal run inside it is the same four
      // lines). It rhymes 弩 and 鼓 in 姥韻, its third line stays out of the
      // rhyme, no character repeats, and it is four five-character lines: it is
      // rhymed mnemonic verse embedded in a prose book, and there is nothing
      // about its shape for this index to object to. That is the floor of what
      // shape can decide, not a threshold left untightened.
      //
      // Pinned as an exact list rather than as a ceiling, so that a change
      // which swapped one false positive for another would be seen rather than
      // averaged away.
      let windows = 0;
      const hits: string[] = [];
      for (const tree of passages) {
        const lines = verseLinesOf(tree);
        for (let start = 0; start < lines.length; start++) {
          for (const n of [4, 6, 8]) {
            if (start + n > lines.length) continue;
            windows++;
            const slice = lines.slice(start, start + n);
            // The window is rebuilt without `LineBreak`, so `verseLinesOf`
            // re-derives its lines the way it does for any unlaid-out text.
            // Punctuation was dropped when the partition was taken, so the
            // clauses are handed back with a 、 between them and the fallback
            // finds the same boundaries the corpus's own pointing gave it.
            const punctuated: TokenTree = {
              sentences: [
                {
                  tokens: slice.flatMap((line, li) => [
                    ...line.map((t) => ({ ...t, misc: undefined })),
                    ...(li === slice.length - 1
                      ? []
                      : [{ id: 0, text: "，", lemma: "，", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 0 }]),
                  ]).map((t, i) => ({ ...t, id: i, head: 0 })),
                },
              ],
              source: "conllu",
            };
            if (detectVerse(punctuated, index)) {
              hits.push(slice.map((l) => l.map((t) => t.text).join("")).join("／"));
            }
          }
        }
      }
      expect(windows).toBe(19377);
      expect(hits).toEqual([
        "呉子曰／教戰之令／短者持矛戟／長者持弓弩／強者持旌旗／勇者持金鼓",
        "短者持矛戟／長者持弓弩／強者持旌旗／勇者持金鼓",
      ]);
    }, 120_000);
  });
} else {
  describe("measured against the kanbun.info prose corpus", () => {
    it.skip("is not built on this machine — see tests/kanbunInfoCorpus.test.ts for the build command", () => {});
  });
}
