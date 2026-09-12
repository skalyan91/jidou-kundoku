import { describe, expect, it } from "vitest";
import { chunkText, MAX_CHUNK_CHARS } from "../src/parse/chunkText.ts";

describe("chunkText", () => {
  it("returns the whole text as one chunk when under the size cap", () => {
    expect(chunkText("學而時習之，不亦說乎？")).toEqual(["學而時習之，不亦說乎？"]);
  });

  it("only ever cuts right after sentence-final punctuation", () => {
    const clause = "學而時習之不亦說乎"; // no punctuation at all inside the clause
    const text = clause.repeat(200) + "。" + clause.repeat(200) + "。";
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text); // no characters lost or duplicated
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith("。")).toBe(true);
    }
  });

  it("force-breaks a run with no sentence-final punctuation at 2x the cap", () => {
    const text = "之".repeat(MAX_CHUNK_CHARS * 5);
    const chunks = chunkText(text);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS * 2);
    }
  });

  it("never drops or reorders characters across a boundary-heavy document", () => {
    const text = "學而時習之。".repeat(1000);
    const chunks = chunkText(text);
    expect(chunks.join("")).toBe(text);
  });

  describe("paragraph boundaries", () => {
    it("gives each of several short paragraphs its own chunk, even though all fit under the cap together", () => {
      const paragraphs = ["學而時習之。", "不亦說乎。", "有朋自遠方來，不亦樂乎。"];
      const text = paragraphs.join("\n\n");
      const chunks = chunkText(text);
      expect(chunks).toEqual(["學而時習之。\n\n", "不亦說乎。\n\n", "有朋自遠方來，不亦樂乎。"]);
      expect(chunks.join("")).toBe(text);
    });

    it("does not cut on a single newline — only two or more separate paragraphs", () => {
      const text = "學而時習之。\n不亦說乎。"; // one line break, not a paragraph break
      expect(chunkText(text)).toEqual([text]);
    });

    it("does not open with an empty chunk when the text starts with blank lines", () => {
      const text = "\n\n學而時習之。";
      const chunks = chunkText(text);
      expect(chunks).toEqual([text]);
      expect(chunks.every((c) => c.length > 0)).toBe(true);
    });

    it("falls back to the size tiers only inside a paragraph too large for one call", () => {
      const clause = "學而時習之不亦說乎"; // no punctuation at all inside the clause
      const longParagraph = clause.repeat(200) + "。" + clause.repeat(200) + "。";
      const text = longParagraph;
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(1); // the paragraph itself had to be subdivided
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks.slice(0, -1)) {
        expect(chunk.endsWith("。")).toBe(true);
      }
    });

    it("subdivides only the oversized paragraph in a mixed document, leaving short ones whole", () => {
      const clause = "學而時習之不亦說乎";
      const shortBefore = "子曰。";
      const longParagraph = clause.repeat(200) + "。" + clause.repeat(200) + "。";
      const shortAfter = "有朋自遠方來。";
      const text = [shortBefore, longParagraph, shortAfter].join("\n\n");
      const chunks = chunkText(text);

      expect(chunks.join("")).toBe(text);
      // The first chunk is the short paragraph whole, with its trailing break.
      expect(chunks[0]).toBe(shortBefore + "\n\n");
      // The last chunk is the short trailing paragraph whole, with no break after it.
      expect(chunks[chunks.length - 1]).toBe(shortAfter);
      // Everything in between came from subdividing the one long paragraph, so
      // there must be more than the three paragraphs' worth of chunks.
      expect(chunks.length).toBeGreaterThan(3);
    });

    it("keeps a punctuation-free paragraph whole up to the hard cap, and force-breaks one character past it", () => {
      const atHardCap = "之".repeat(MAX_CHUNK_CHARS * 2);
      expect(chunkText(atHardCap)).toEqual([atHardCap]);

      const overHardCap = "之".repeat(MAX_CHUNK_CHARS * 2 + 1);
      const chunks = chunkText(overHardCap);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join("")).toBe(overHardCap);
    });
  });
});
