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
});
