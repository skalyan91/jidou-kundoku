import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rimeForPos, rimeFullName, rimesOf, type RimeIndex } from "../src/reading/rimeIndex.ts";

// ---------------------------------------------------------------------------
// The shipped rime index — `public/data/rime-index.json`, built by
// `scripts/build-rime-index.py` out of nk2028's `qieyun` package.
//
// **This is shipped data and nothing else in the suite reads it**, which is
// `tests/sampleTexts.test.ts`'s own reason for existing said about a different
// file: a botched rebuild would reach the reader as a poem with no rime beside
// it and no message. What is checked here is the *shape* — that the two tables
// agree with each other, that every 韻目 a character names is one the table
// holds, and that the 206 rimes of the 廣韻 are 206.
//
// The one thing it does not check is the phonology, because the suite has no
// second source to check it against. What it can do instead is pin the handful
// of characters whose values are independently attested: kanbun.info prints
// 「五言律詩。深・心・金・簪（下平声侵韻）。」 at the head of the 春望 page, which
// is four characters and one rime stated by an editor who is not this project.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(readFileSync(join(ROOT, "public", "data", "rime-index.json"), "utf-8")) as RimeIndex;

describe("the 韻目 table", () => {
  it("is the 廣韻's 206, in the book's own order", () => {
    // 206 is the 廣韻's own count and is the strongest single check available
    // here: the build derives the table from the data rather than tabulating
    // it, so a source change that dropped or split a rime would show up as a
    // number that is not 206 and as nothing else.
    const rimes = Object.keys(index.rimes);
    expect(rimes).toHaveLength(206);
    // 卷一 opens 東冬鍾江支脂之微 and 卷五 closes 合盍葉怗洽狎業乏, which is the
    // order the book prints and the order the build sorts into (卷, then the
    // page of the page-image each 韻目 was first seen on).
    expect(rimes.slice(0, 8).join("")).toBe("東冬鍾江支脂之微");
    expect(rimes.slice(-8).join("")).toBe("合盍葉怗洽狎業乏");
  });

  it("names each of them with one character, which is what the 割注 is sized on", () => {
    // **Load-bearing for the page and not merely tidy.** `rimeLabel` prints
    // 侵韻 at 2 characters and 海代二韻 at 4, and a 割注 holds exactly four
    // half-size glyphs; a 韻目 written with two characters would make those 3
    // and 6, which is a lopsided column and a clipped one. The keys are also
    // *split* by code point wherever a character's entry is read, so a 韻目
    // outside the BMP would be mis-split as well as mis-measured.
    for (const rime of Object.keys(index.rimes)) {
      expect([...rime], `${rime} is not one code point`).toHaveLength(1);
    }
  });

  it("gives every 韻目 one 聲 and one 卷, and they agree", () => {
    // The build asserts both before writing the file; this asserts them again
    // on the file, because it is the file the browser reads. A 韻目 whose 聲
    // and 卷 disagreed — 平 in 入聲, say — would print a name no rime
    // dictionary has.
    const VOLUME_OF_TONE: Record<string, string[]> = {
      平: ["上平聲", "下平聲"],
      上: ["上聲"],
      去: ["去聲"],
      入: ["入聲"],
    };
    for (const [rime, row] of Object.entries(index.rimes)) {
      expect(VOLUME_OF_TONE, `${rime} has an unknown 聲 ${row.tone}`).toHaveProperty(row.tone);
      expect(VOLUME_OF_TONE[row.tone], `${rime} is ${row.tone} but stands in ${row.volume}`).toContain(row.volume);
    }
  });

  it("names a rime the way an editor does", () => {
    // 下平聲侵韻 is kanbun.info's own 「下平声侵韻」 in traditional graphs, which
    // is what this app sets everything else in.
    expect(rimeFullName(index, "侵")).toBe("下平聲侵韻");
    expect(rimeFullName(index, "德")).toBe("入聲德韻");
    expect(rimeFullName(index, "海")).toBe("上聲海韻");
    // A 韻目 the table does not hold is named by itself rather than by nothing:
    // a blank in a 割注 is worse than a bare character.
    expect(rimeFullName(index, "〇")).toBe("〇");
  });
});

describe("the character table", () => {
  it("holds 19,499 characters, every one of them a single code point", () => {
    const chars = Object.keys(index.chars);
    expect(chars).toHaveLength(19499);
    // The encoding is one 韻目 per *character* of the value string, so a key or
    // a value made of more than one code point per rime would be silently
    // mis-split. 4,035 of these are outside the BMP and are two UTF-16 code
    // units apiece, which is exactly the trap `[...s]` avoids and `s.length`
    // does not.
    for (const ch of chars) expect([...ch], `${ch} is not one code point`).toHaveLength(1);
    expect(chars.filter((c) => c.codePointAt(0)! > 0xffff)).toHaveLength(4035);
  });

  it("names only 韻目 the table holds, and never an empty entry", () => {
    for (const [ch, entry] of Object.entries(index.chars)) {
      expect(entry.length, `${ch} has no 韻目`).toBeGreaterThan(0);
      for (const rime of entry) expect(index.rimes, `${ch} names ${rime}, which is not a 韻目`).toHaveProperty(rime);
    }
  });

  it("keeps every 音韻地位 the book gives, and 4,044 characters have more than one", () => {
    // **The count is the statement that nothing was thrown away.** A build
    // that silently preferred one reading per character would come out with
    // this at 0 and every other test in this file would still pass. See
    // `scripts/build-rime-index.py`'s own note on why none is preferred.
    const multi = Object.values(index.chars).filter((e) => [...e].length > 1);
    expect(multi).toHaveLength(4044);
    // 深 is 侵 (式針切, 平聲) and 沁 (式禁切, 去聲) — the same character in two
    // tones, which is the commonest shape of the ambiguity and the one the
    // 春望 sample turns on.
    expect(rimesOf(index, "深")).toEqual(["侵", "沁"]);
    // 簪 is two 平聲 rimes rather than two tones, 侵 (側吟切) and 覃 (作含切),
    // so tone alone would not have separated them either.
    expect(rimesOf(index, "簪")).toEqual(["侵", "覃"]);
    // 在 is 上聲 海 or 去聲 代, and no poem in this app picks between them.
    expect(rimesOf(index, "在")).toEqual(["海", "代"]);
  });

  it("gives no character more than seven 韻目, which is what the label forms assume", () => {
    // **The distribution, because `rimeLabel` is written against it.** 15,455
    // characters have one rime, 3,378 have two, and 666 have more — 585 three,
    // 75 four, 5 five and 哆 seven, which is the most the book gives anything.
    // The label names both where there are two (海代二韻) and counts where there
    // are more (三韻, 七韻), and the count is a single numeral only up to 十; a
    // rebuild that produced an eleven-rime character would fall back to 數韻
    // rather than printing a three-character label, and this is the assertion
    // that would say so first.
    const counts: Record<number, number> = {};
    for (const entry of Object.values(index.chars)) {
      const n = [...entry].length;
      counts[n] = (counts[n] ?? 0) + 1;
    }
    expect(counts).toEqual({ 1: 15455, 2: 3378, 3: 585, 4: 75, 5: 5, 7: 1 });
    expect(rimesOf(index, "哆")).toEqual(["麻", "紙", "哿", "馬", "志", "箇", "禡"]);
  });

  it("agrees with kanbun.info about 春望's four rhyme words", () => {
    // 「五言律詩。深・心・金・簪（下平声侵韻）。」 — the site's own note, and the
    // only outside statement of these values this suite has. 深 and 簪 have a
    // second rime each; what the site asserts is that 侵 is among them and is
    // the one this poem uses.
    for (const ch of "深心金簪") expect(rimesOf(index, ch), `${ch}`).toContain("侵");
    expect(rimesOf(index, "心")).toEqual(["侵"]);
    expect(rimesOf(index, "金")).toEqual(["侵"]);
    expect(index.rimes["侵"]).toEqual({ tone: "平", volume: "下平聲" });
  });

  it("answers nothing for a character the 廣韻 does not hold", () => {
    // Kana, punctuation and the 踊り字 all reach `rimesOf` on a text the
    // detector is walking, and the empty answer is what refuses that text
    // rather than throwing on it.
    expect(rimesOf(index, "あ")).toEqual([]);
    expect(rimesOf(index, "〻")).toEqual([]);
    expect(rimesOf(index, "、")).toEqual([]);
  });
});

describe("the curated part-of-speech table", () => {
  // **The reach, stated as a number rather than left to be counted by hand.**
  // 4,044 characters have more than one 音韻地位 and 3,378 of those have
  // exactly two — the scope `scripts/build-rime-index.py`'s own docstring
  // gives for `POS_RESOLVED_RIME` — and this table resolves 21 of them. A
  // rule that reaches two characters (在 and, in a poem that happens to use
  // it, one more) is worth exactly what it says it reaches and no more.
  it("names exactly the characters admitted on stated evidence, 21 of them", () => {
    expect(Object.keys(index.posRime).sort()).toEqual(
      [
        "在",
        "雨",
        "衣",
        "冠",
        "分",
        "傳",
        "乘",
        "騎",
        "好",
        "量",
        "藏",
        "遠",
        "近",
        "聞",
        "和",
        "難",
        "易",
        "度",
        "處",
        "觀",
        "妻",
      ].sort(),
    );
  });

  it("maps every entry onto exactly the character's own two 音韻地位, never a third value", () => {
    // The build asserts this before it will write the file at all (a mapped
    // 韻目 the 廣韻 does not give the character, or a character the table
    // names that the book does not hold, is a build failure and not a
    // shipped one) — this is the same check run again on what actually
    // shipped, the way `rimeIndex.test.ts`'s other describe blocks re-check
    // the build's own assertions on the file the browser reads.
    for (const [ch, mapping] of Object.entries(index.posRime)) {
      const book = rimesOf(index, ch);
      expect(book, ch).toHaveLength(2);
      expect(Object.values(mapping).sort(), ch).toEqual([...book].sort());
      // Two different 品詞 always name two different 韻目 — an entry that
      // mapped both to the same rime would not be a disambiguation.
      expect(new Set(Object.values(mapping)).size, ch).toBe(2);
    }
  });

  it("resolves a curated character's own part of speech, and nothing else", () => {
    expect(rimeForPos(index, "在", "VERB")).toBe("海");
    expect(rimeForPos(index, "在", "NOUN")).toBe("代");
    // A part of speech 在's own entry does not name, an uncurated character,
    // and no part of speech at all (the shape a token with no xpos gives
    // `uposForXpos`) all answer the same way: nothing to resolve.
    expect(rimeForPos(index, "在", "ADV")).toBeUndefined();
    expect(rimeForPos(index, "深", "VERB")).toBeUndefined();
    expect(rimeForPos(index, "在", undefined)).toBeUndefined();
  });
});
