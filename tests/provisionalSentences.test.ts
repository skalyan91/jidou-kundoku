import { describe, expect, it } from "vitest";
import {
  CHAR_REVEAL_MAX_CHARS,
  CHAR_REVEAL_MS,
  charCount,
  charsDrawnBy,
  nextBatch,
  showableChars,
  partitionByRegion,
  regionsDrawnBy,
  sentenceLength,
  shouldRevealProgressively,
  splitProvisional,
} from "../src/parse/provisionalSentences.ts";
import { MAX_CHUNK_CHARS } from "../src/parse/chunkText.ts";
import { annotateSourceLayout, sourceLayoutOf } from "../src/parse/sourceLayout.ts";
import { mergeAtMedialPunctuation, splitIntoSentences } from "../src/parse/splitSentences.ts";
import type { Sentence, Token, TokenTree } from "../src/parse/types.ts";

/** A tree standing in for what the parser returns: one sentence per string,
 * one token per character, everything hanging off the first token. Enough for
 * the two passes this file is really testing — `annotateSourceLayout` walks
 * token texts against the source, and `splitIntoSentences` reads `dep`,
 * `text` and the layout. */
function treeOf(sentenceTexts: readonly string[]): TokenTree {
  return {
    source: "pyodide",
    sentences: sentenceTexts.map((text) => ({
      tokens: [...text].map((ch, i): Token => ({
        id: i,
        text: ch,
        lemma: ch,
        pos: /[。．？！，、：；「」]/.test(ch) ? "PUNCT" : "NOUN",
        xpos: "n",
        dep: /[。．？！，、：；「」]/.test(ch) ? "punct" : i === 0 ? "ROOT" : "mod",
        head: 0,
      })),
    })),
  };
}

const textOf = (sentence: Sentence): string => sentence.tokens.map((t) => t.text).join("");

describe("splitProvisional", () => {
  it("cuts after every sentence-final mark", () => {
    const regions = splitProvisional("學而時習之，不亦說乎？有朋自遠方來。");
    expect(regions.map((r) => r.body)).toEqual(["學而時習之，", "不亦說乎？", "有朋自遠方來。"]);
  });

  it("does not cut at a medial mark", () => {
    // ： introduces reported speech inside the sentence that reports it, and
    // 、 divides one — neither ends anything.
    const regions = splitProvisional("子曰：學而時習之、不亦說乎。");
    expect(regions.map((r) => r.body)).toEqual(["子曰：學而時習之、不亦說乎。"]);
  });

  it("leaves a closing bracket after a full stop as a region of its own", () => {
    // Which is exactly what the parser's own segmenter does with it.
    const regions = splitProvisional("子曰：「學而時習之。」");
    expect(regions.map((r) => r.body)).toEqual(["子曰：「學而時習之。", "」"]);
  });

  it("cuts at a line break and records what kind it was", () => {
    const regions = splitProvisional("春眠不覺曉\n處處聞啼鳥\n\n夜來風雨聲");
    expect(regions.map((r) => r.body)).toEqual(["春眠不覺曉", "處處聞啼鳥", "夜來風雨聲"]);
    expect(regions.map((r) => r.breakBefore)).toEqual([undefined, "line", "para"]);
  });

  it("gives the document's first region no break, however the text begins", () => {
    const regions = splitProvisional("\n\n  春眠不覺曉");
    expect(regions[0].breakBefore).toBeUndefined();
    expect(regions[0].indent).toBe(2);
  });

  it("counts the indent from after the last newline only", () => {
    const regions = splitProvisional("甲。\n   乙。");
    expect(regions[1].indent).toBe(3);
    expect(regions[1].breakBefore).toBe("line");
  });

  it("indents without opening a line where there is no newline", () => {
    const regions = splitProvisional("甲。  乙。");
    expect(regions[1].breakBefore).toBeUndefined();
    expect(regions[1].indent).toBe(2);
  });

  it("keeps whitespace inside a region but never at either end of one", () => {
    const [region] = splitProvisional("  甲 乙 丙。  ");
    expect(region.body).toBe("甲 乙 丙。");
    expect(region.indent).toBe(2);
    expect(region.length).toBe(4);
  });

  it("loses no characters and reorders none", () => {
    const text = "子曰：「學而時習之，不亦說乎？」\n有朋自遠方來。\n\n人不知而不慍。";
    const regions = splitProvisional(text);
    const rebuilt = regions.map((r) => r.body).join("");
    expect(rebuilt).toBe(text.replace(/\s+/g, ""));
    for (let i = 1; i < regions.length; i++) {
      expect(regions[i].start).toBeGreaterThanOrEqual(regions[i - 1].end);
    }
  });

  it("offsets slice back to the body they describe", () => {
    const text = "甲。\n乙丙。";
    for (const region of splitProvisional(text)) {
      expect(text.slice(region.start, region.end)).toBe(region.body);
    }
  });

  it("returns nothing for a text with no characters in it", () => {
    expect(splitProvisional("   \n\n  ")).toEqual([]);
  });

  it("divides a run of sentence-final marks at each of them", () => {
    expect(splitProvisional("甲！？").map((r) => r.body)).toEqual(["甲！", "？"]);
  });

  it("counts length in characters and not in code units", () => {
    // 𠀀 is outside the BMP: two code units, one character, and one cell.
    const [region] = splitProvisional("𠀀甲。");
    expect(region.length).toBe(3);
    expect(charCount(region.body)).toBe(3);
  });
});

describe("the parser's division refines the provisional one", () => {
  /** Runs the two passes `main.ts` runs over a wave, and returns the sentence
   * texts they leave. */
  function finalSentences(source: string, parserSentences: readonly string[]): string[] {
    const tree = treeOf(parserSentences);
    annotateSourceLayout(tree, source);
    return splitIntoSentences(mergeAtMedialPunctuation(tree)).sentences.map(textOf);
  }

  it("severs a parser sentence that runs past a provisional boundary", () => {
    const source = "青、取之於藍，而青於藍。";
    // The parser hands back the whole thing as one sentence — measured
    // behaviour, and the case `splitIntoSentences` exists for.
    const final = finalSentences(source, [source]);
    expect(final).toEqual(splitProvisional(source).map((r) => r.body));
  });

  it("severs one that runs past a line break", () => {
    const source = "春眠不覺曉\n處處聞啼鳥";
    const final = finalSentences(source, ["春眠不覺曉處處聞啼鳥"]);
    expect(final).toEqual(["春眠不覺曉", "處處聞啼鳥"]);
  });

  it("lets a division the parser makes inside a region simply stand", () => {
    // Unpunctuated input: nothing here can be read off the text, so the whole
    // line is one region and whatever the parser segments inside it is the
    // answer.
    const source = "學而時習之不亦說乎";
    expect(splitProvisional(source).map((r) => r.body)).toEqual([source]);
    expect(finalSentences(source, ["學而時習之", "不亦說乎"])).toEqual(["學而時習之", "不亦說乎"]);
  });

  it("never merges across a provisional boundary, the parser having split at one", () => {
    // The merge only joins a sentence to one ending in a *medial* mark, and a
    // region never ends in one.
    const source = "青於藍。寒於水。";
    expect(finalSentences(source, ["青於藍。", "寒於水。"])).toEqual(["青於藍。", "寒於水。"]);
  });

  it("nor across a line break, whatever mark precedes it", () => {
    const source = "青於藍、\n寒於水。";
    expect(finalSentences(source, ["青於藍、", "寒於水。"])).toEqual(["青於藍、", "寒於水。"]);
  });

  it("does merge at a medial mark, which lies inside a region", () => {
    const source = "子曰：學而時習之。";
    expect(finalSentences(source, ["子曰：", "學而時習之。"])).toEqual([source]);
    expect(splitProvisional(source).map((r) => r.body)).toEqual([source]);
  });
});

describe("annotateSourceLayout over a slice", () => {
  it("carries the break the caller says opened the slice", () => {
    const tree = treeOf(["處處聞啼鳥"]);
    annotateSourceLayout(tree, "處處聞啼鳥", "line");
    expect(sourceLayoutOf(tree.sentences[0].tokens[0])?.breakBefore).toBe("line");
  });

  it("still gives a whole document's first token no break", () => {
    const tree = treeOf(["處處聞啼鳥"]);
    annotateSourceLayout(tree, "處處聞啼鳥");
    expect(sourceLayoutOf(tree.sentences[0].tokens[0])?.breakBefore).toBeUndefined();
  });

  it("measures a wave's internal line breaks as it always did", () => {
    const source = "春眠不覺曉\n處處聞啼鳥";
    const tree = treeOf(["春眠不覺曉處處聞啼鳥"]);
    annotateSourceLayout(tree, source, "para");
    const tokens = tree.sentences[0].tokens;
    expect(sourceLayoutOf(tokens[0])?.breakBefore).toBe("para");
    expect(sourceLayoutOf(tokens[5])?.breakBefore).toBe("line");
  });
});

describe("the character reveal", () => {
  it("shows nothing before the first character's own moment", () => {
    expect(charsDrawnBy(0, 10)).toBe(0);
    expect(charsDrawnBy(CHAR_REVEAL_MS - 1, 10)).toBe(0);
    expect(charsDrawnBy(CHAR_REVEAL_MS, 10)).toBe(1);
  });

  it("keeps to its rate, and stops at the end of the text", () => {
    expect(charsDrawnBy(CHAR_REVEAL_MS * 7 + 3, 100)).toBe(7);
    expect(charsDrawnBy(CHAR_REVEAL_MS * 1000, 10)).toBe(10);
  });

  it("brings up every character a late frame was due for", () => {
    // A frame that arrives 100ms after the last one does not fall behind:
    // the schedule is elapsed time, not a count of frames.
    expect(charsDrawnBy(100, 1000)).toBe(Math.floor(100 / CHAR_REVEAL_MS));
  });

  it("treats a negative or absent elapsed time as nothing drawn", () => {
    expect(charsDrawnBy(-5, 10)).toBe(0);
    expect(charsDrawnBy(Number.NaN, 10)).toBe(0);
  });

  it("counts a region only once its last character is up", () => {
    const lengths = [3, 2, 4];
    expect(regionsDrawnBy(lengths, 0)).toBe(0);
    expect(regionsDrawnBy(lengths, 2)).toBe(0);
    expect(regionsDrawnBy(lengths, 3)).toBe(1);
    expect(regionsDrawnBy(lengths, 4)).toBe(1);
    expect(regionsDrawnBy(lengths, 5)).toBe(2);
    expect(regionsDrawnBy(lengths, 9)).toBe(3);
    expect(regionsDrawnBy(lengths, 99)).toBe(3);
  });

  it("never draws an opening bracket alone", () => {
    // 行頭禁則 is a rule about a settled column; during the reveal the bracket
    // is last because nothing follows it *yet*, so the only fix in time is
    // not to draw it. See `showableChars`.
    const chars = [..."子曰「學而"];
    expect(showableChars(chars, 2)).toBe(2);
    expect(showableChars(chars, 3)).toBe(2); // 「 held back
    expect(showableChars(chars, 4)).toBe(4); // and released with 學
  });

  it("buffers a run of them as a unit", () => {
    const chars = [..."甲『「乙"];
    expect(showableChars(chars, 1)).toBe(1);
    expect(showableChars(chars, 2)).toBe(1);
    expect(showableChars(chars, 3)).toBe(1);
    expect(showableChars(chars, 4)).toBe(4);
  });

  it("takes the brackets from the shared set rather than a list of its own", () => {
    // Every opening bracket `punctuation.ts` knows, so this cannot drift from
    // the set the settled layout uses.
    for (const open of ["「", "『", "（", "(", "〈", "《", "【", "〔", "［", "["]) {
      expect(showableChars([...`甲${open}乙`], 2)).toBe(1);
    }
    // And a closing bracket is not one of them: it follows its character and
    // has nothing to wait for.
    expect(showableChars([..."甲」乙"], 2)).toBe(2);
  });

  it("flushes the buffer at the end of the text", () => {
    // Malformed, but possible — and a character held back for a successor
    // that will never come would simply never be drawn.
    const chars = [..."子曰「"];
    expect(showableChars(chars, 2)).toBe(2);
    expect(showableChars(chars, 3)).toBe(3);
    expect(showableChars(chars, 99)).toBe(3);
  });

  it("never takes back a character it has shown", () => {
    const chars = [..."子「『曰「而「「時"];
    let previous = 0;
    for (let drawn = 0; drawn <= chars.length + 2; drawn++) {
      const shown = showableChars(chars, drawn);
      expect(shown).toBeGreaterThanOrEqual(previous);
      expect(shown).toBeLessThanOrEqual(Math.min(drawn, chars.length));
      previous = shown;
    }
  });

  it("holds a region back while its last character is still buffered", () => {
    // A region *can* end in an opening bracket: `splitProvisional` cuts
    // before a line break as well as after a full stop. Such a region is not
    // complete — and so is not dispatched — until the bracket is on the page,
    // which here takes the first character of the next line.
    const regions = splitProvisional("子曰「\n學而時習之。");
    expect(regions.map((r) => r.body)).toEqual(["子曰「", "學而時習之。"]);
    const chars = [...regions.map((r) => r.body).join("")];
    const lengths = regions.map((r) => r.length);
    // Three characters due: the 「 is held, so only two are up and no region
    // is complete.
    expect(regionsDrawnBy(lengths, showableChars(chars, 3))).toBe(0);
    // The fourth releases it, and the first region completes with it.
    expect(regionsDrawnBy(lengths, showableChars(chars, 4))).toBe(1);
  });

  it("animates a short text and draws a long one at once", () => {
    // The three lengths the threshold was chosen against — see
    // `CHAR_REVEAL_MAX_CHARS`, which has the arithmetic.
    expect(shouldRevealProgressively(20, false)).toBe(true); // a couplet
    expect(shouldRevealProgressively(359, false)).toBe(true); // 酒蟲
    expect(shouldRevealProgressively(1500, false)).toBe(false); // a parser chunk
    expect(shouldRevealProgressively(10_000, false)).toBe(false); // a chapter
  });

  it("keeps the animation inside its stated budget of 2.4 seconds", () => {
    expect(CHAR_REVEAL_MAX_CHARS * CHAR_REVEAL_MS).toBe(2400);
    // And the threshold is exactly where the budget runs out, rather than a
    // number that has drifted from it.
    expect(shouldRevealProgressively(CHAR_REVEAL_MAX_CHARS, false)).toBe(true);
    expect(shouldRevealProgressively(CHAR_REVEAL_MAX_CHARS + 1, false)).toBe(false);
  });

  it("skips the animation entirely under prefers-reduced-motion", () => {
    expect(shouldRevealProgressively(20, true)).toBe(false);
    expect(shouldRevealProgressively(1, true)).toBe(false);
  });

  it("has nothing to animate in an empty text", () => {
    expect(shouldRevealProgressively(0, false)).toBe(false);
  });
});

describe("nextBatch", () => {
  it("asks about one region first, so something is annotated as early as possible", () => {
    expect(nextBatch([3, 3, 3, 3], 0, 4)).toEqual([0, 1]);
  });

  it("goes straight to full throughput after that, rather than ramping", () => {
    expect(nextBatch([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 1, 10)).toEqual([1, 10]);
  });

  it("never runs ahead of the characters on the screen", () => {
    // The invariant the whole arrangement rests on: an annotation can only
    // ever arrive for characters the reader has already been shown.
    expect(nextBatch([2, 2, 2, 2], 0, 0)).toBe(null);
    expect(nextBatch([2, 2, 2, 2], 1, 1)).toBe(null);
    expect(nextBatch([2, 2, 2, 2], 1, 3)).toEqual([1, 3]);
  });

  it("hands over one region at a time while the characters are still arriving", () => {
    // Which is the user's rule holding of its own accord: the frontier is
    // what binds, not a batch size.
    const lengths = [4, 4, 4, 4];
    expect(nextBatch(lengths, 0, 1)).toEqual([0, 1]);
    expect(nextBatch(lengths, 1, 2)).toEqual([1, 2]);
    expect(nextBatch(lengths, 2, 3)).toEqual([2, 3]);
  });

  it("returns null once every region has been asked about", () => {
    expect(nextBatch([1, 1], 2, 2)).toBe(null);
    expect(nextBatch([], 0, 0)).toBe(null);
  });

  it("keeps a batch inside the character cap", () => {
    const lengths = Array.from({ length: 200 }, () => 100);
    const batch = nextBatch(lengths, 1, lengths.length);
    expect(batch).not.toBe(null);
    const chars = lengths.slice(batch![0], batch![1]).reduce((a, b) => a + b, 0);
    expect(chars).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it("takes an over-long region on its own rather than returning an empty range", () => {
    expect(nextBatch([MAX_CHUNK_CHARS * 4, 5], 0, 2)).toEqual([0, 1]);
    expect(nextBatch([5, MAX_CHUNK_CHARS * 4], 1, 2)).toEqual([1, 2]);
  });

  it("stops at the region cap even where the characters would allow more", () => {
    const lengths = Array.from({ length: 500 }, () => 1);
    expect(nextBatch(lengths, 1, lengths.length)).toEqual([1, 65]);
  });

  it("covers every region exactly once, in order, whatever the frontier does", () => {
    const lengths = Array.from({ length: 97 }, (_, i) => (i % 7) + 1);
    let dispatched = 0;
    let ready = 0;
    const batches: [number, number][] = [];
    // The frontier crawls forward a region at a time for the first half of
    // the text and then jumps to the end — the animation finishing while the
    // parser is still behind, which is the ordinary case on a short text.
    while (dispatched < lengths.length) {
      const batch = nextBatch(lengths, dispatched, ready);
      if (!batch) {
        ready = ready < 50 ? ready + 1 : lengths.length;
        continue;
      }
      expect(batch[0]).toBe(dispatched);
      expect(batch[1]).toBeGreaterThan(batch[0]);
      expect(batch[1]).toBeLessThanOrEqual(ready);
      batches.push(batch);
      dispatched = batch[1];
    }
    expect(dispatched).toBe(lengths.length);
    expect(batches[0]).toEqual([0, 1]);
  });

  it("goes at full width from the second batch when the whole text is up at once", () => {
    // A text past the animation threshold: every region is ready before the
    // first request, and nothing throttles but the caps.
    const lengths = Array.from({ length: 40 }, () => 100);
    expect(nextBatch(lengths, 0, 40)).toEqual([0, 1]);
    expect(nextBatch(lengths, 1, 40)).toEqual([1, 16]);
  });
});

describe("partitionByRegion", () => {
  it("gives one unit per region where the two agree", () => {
    expect(partitionByRegion([6, 5, 7], [6, 5, 7])).toEqual([
      { regions: [0, 1], sentences: [0, 1] },
      { regions: [1, 2], sentences: [1, 2] },
      { regions: [2, 3], sentences: [2, 3] },
    ]);
  });

  it("gathers several parsed sentences into the one region they came from", () => {
    // Unpunctuated input: one region, which the parser divides in three.
    expect(partitionByRegion([9], [3, 3, 3])).toEqual([{ regions: [0, 1], sentences: [0, 3] }]);
  });

  it("reveals two regions together when a sentence straddles their boundary", () => {
    // The mark that should have closed region 0 was fused into the word beside
    // it, so no sentence ends at 4. Both regions go at once rather than one of
    // them being guessed at.
    expect(partitionByRegion([4, 4], [6, 2])).toEqual([{ regions: [0, 2], sentences: [0, 2] }]);
  });

  it("cuts again as soon as the two totals coincide once more", () => {
    expect(partitionByRegion([4, 4, 5], [6, 2, 5])).toEqual([
      { regions: [0, 2], sentences: [0, 2] },
      { regions: [2, 3], sentences: [2, 3] },
    ]);
  });

  it("accounts for every region even when nothing ever coincides", () => {
    const units = partitionByRegion([4, 4, 4], [5, 5]);
    expect(units).toEqual([{ regions: [0, 3], sentences: [0, 2] }]);
  });

  it("accounts for every region when the parse comes back short", () => {
    // Whatever went wrong, no region is left with no unit to replace it.
    const units = partitionByRegion([4, 4, 4], [4]);
    expect(units).toEqual([
      { regions: [0, 1], sentences: [0, 1] },
      { regions: [1, 3], sentences: [1, 1] },
    ]);
    expect(units.at(-1)!.regions[1]).toBe(3);
  });

  it("covers the regions contiguously and in order, on random accounts", () => {
    // The invariant the reveal actually depends on: the units partition the
    // region range, so every bare span is replaced exactly once.
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n) + 1;
    for (let trial = 0; trial < 200; trial++) {
      const regions = Array.from({ length: rand(8) }, () => rand(9));
      const total = regions.reduce((a, b) => a + b, 0);
      const sentences: number[] = [];
      let left = total;
      while (left > 0) {
        const take = Math.min(left, rand(9));
        sentences.push(take);
        left -= take;
      }
      const units = partitionByRegion(regions, sentences);
      let next = 0;
      for (const unit of units) {
        expect(unit.regions[0]).toBe(next);
        next = unit.regions[1];
      }
      expect(next).toBe(regions.length);
      // And the sentences are used up in order, none twice and none dropped.
      let nextS = 0;
      for (const unit of units) {
        expect(unit.sentences[0]).toBe(nextS);
        nextS = unit.sentences[1];
      }
      expect(nextS).toBe(sentences.length);
    }
  });

  it("returns nothing for a wave with no regions and no sentences", () => {
    expect(partitionByRegion([], [])).toEqual([]);
  });
});

describe("sentenceLength", () => {
  it("counts a fused token's characters one by one, as the panel draws them", () => {
    const sentence: Sentence = {
      tokens: [
        { id: 0, text: "君子", lemma: "君子", pos: "NOUN", xpos: "n", dep: "ROOT", head: 0 },
        { id: 1, text: "。", lemma: "。", pos: "PUNCT", xpos: "n", dep: "punct", head: 0 },
      ],
    };
    expect(sentenceLength(sentence)).toBe(3);
  });
});

describe("the whole reckoning, end to end", () => {
  /** What `main.ts` does, minus the DOM: divide, plan, parse (here, stand in
   * for the parser with a division of its own), lay out, split, and match the
   * result back to the regions. */
  function reveal(
    source: string,
    parse: (batchSource: string) => string[],
    /** How the frontier advances between requests. `"atOnce"` is a text past
     * the animation threshold; `"perRegion"` is one being disclosed a
     * character at a time, the parser keeping up with it. */
    frontier: "atOnce" | "perRegion" = "atOnce",
  ): { regions: string[]; sentences: string[] }[] {
    const regions = splitProvisional(source);
    const lengths = regions.map((r) => r.length);
    const out: { regions: string[]; sentences: string[] }[] = [];
    let dispatched = 0;
    let ready = frontier === "atOnce" ? regions.length : 0;
    while (dispatched < regions.length) {
      const batch = nextBatch(lengths, dispatched, ready);
      if (!batch) {
        ready++;
        continue;
      }
      const [from, to] = batch;
      const batchSource = source.slice(regions[from].start, regions[to - 1].end);
      const tree = treeOf(parse(batchSource));
      annotateSourceLayout(tree, batchSource, regions[from].breakBefore);
      const split = splitIntoSentences(mergeAtMedialPunctuation(tree));
      const sentenceLengths = split.sentences.map(sentenceLength);
      for (const unit of partitionByRegion(lengths.slice(from, to), sentenceLengths)) {
        out.push({
          regions: regions.slice(from + unit.regions[0], from + unit.regions[1]).map((r) => r.body),
          sentences: split.sentences.slice(unit.sentences[0], unit.sentences[1]).map(textOf),
        });
      }
      dispatched = to;
    }
    return out;
  }

  it("replaces each region with exactly the characters it held", () => {
    const source = "子曰：「學而時習之，不亦說乎？」\n有朋自遠方來、不亦樂乎。";
    // A parser that hands the whole wave back as one sentence — the worst
    // case for the reconciliation, and the one measured on real input.
    const units = reveal(source, (wave) => [wave.replace(/\s+/g, "")]);
    for (const unit of units) {
      expect(unit.sentences.join("")).toBe(unit.regions.join(""));
    }
    expect(units.flatMap((u) => u.regions)).toEqual(splitProvisional(source).map((r) => r.body));
  });

  it("keeps the characters of the finished page identical to the source's", () => {
    const source = "春眠不覺曉\n處處聞啼鳥\n\n夜來風雨聲，花落知多少。";
    const units = reveal(source, (wave) => [wave.replace(/\s+/g, "")]);
    expect(units.flatMap((u) => u.sentences).join("")).toBe(source.replace(/\s+/g, ""));
  });

  it("survives a parser that segments where the punctuation does not", () => {
    const source = "學而時習之不亦說乎有朋自遠方來";
    const units = reveal(source, (wave) => [wave.slice(0, 5), wave.slice(5)]);
    expect(units).toEqual([
      { regions: [source], sentences: ["學而時習之", "不亦說乎有朋自遠方來"] },
    ]);
  });

  it("draws the same page whether the characters arrive at once or one at a time", () => {
    const source = "子曰：「學而時習之，不亦說乎？」\n有朋自遠方來、不亦樂乎。";
    const oneParse = (batch: string) => [batch.replace(/\s+/g, "")];
    // The batches differ — a frontier that crawls hands over one region at a
    // time — but every character of the source still ends up in exactly one
    // region, and in the same one.
    const atOnce = reveal(source, oneParse, "atOnce");
    const perRegion = reveal(source, oneParse, "perRegion");
    expect(perRegion).toEqual(atOnce);
    expect(perRegion.flatMap((u) => u.sentences).join("")).toBe(source.replace(/\s+/g, ""));
  });

  it("puts a batch's own opening line break back onto its first token", () => {
    const source = "甲。\n乙。\n丙。\n丁。";
    const regions = splitProvisional(source);
    // The second request opens at 乙, whose newline was consumed as the first
    // one's trailing whitespace.
    const second = nextBatch(regions.map((r) => r.length), 1, regions.length)!;
    const waveSource = source.slice(regions[second[0]].start, regions[second[1] - 1].end);
    const tree = treeOf([waveSource.replace(/\s+/g, "")]);
    annotateSourceLayout(tree, waveSource, regions[second[0]].breakBefore);
    const split = splitIntoSentences(mergeAtMedialPunctuation(tree));
    // Three, not two: with the whole text on the screen the second request
    // takes everything left rather than the two a doubling wave would have.
    expect(split.sentences.map(textOf)).toEqual(["乙。", "丙。", "丁。"]);
    expect(sourceLayoutOf(split.sentences[0].tokens[0])?.breakBefore).toBe("line");
  });
});
