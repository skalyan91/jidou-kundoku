import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConllu, validateConlluForLzh } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { assignKundokuTen } from "../src/kundoku/kundokuTenAssigner.ts";
import { buildKundokuGlyphMap } from "../src/render/kundokuGlyphs.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { SAMPLE_TEXTS } from "../src/render/Sidebar.ts";
import { storedSignature } from "../src/parse/savedTexts.ts";
import { setChosenReading } from "../src/reading/chosenReading.ts";
import { KAKIKUDASHI_SAMPLE, SAMPLE } from "../src/render/HelpModal.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import en from "../src/i18n/en.json" with { type: "json" };
import ja from "../src/i18n/ja.json" with { type: "json" };

// ---------------------------------------------------------------------------
// The two texts the sidebar's sample buttons load.
//
// **There is no browser here, so what this pins is everything up to the
// markup**: that each file is on disk where the button asks for it, that it
// survives the very gate the app puts an upload through, and that every
// sentence in it goes through the reading order, the kaeriten and the prose
// generator without throwing and with something to show for it. What it cannot
// see is the page — that the buttons are where they should be and that the two
// columns look right is the reader's to confirm.
//
// It matters more here than for a hand-typed fixture, because these two files
// are *shipped data*: nothing else in the suite reads them, so a botched
// rebuild of the 論語 sample or a stray edit to the 酒蟲 one would otherwise
// reach the reader as a blank panel and no message.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** The file the button's URL names, read off disk. `public/` is served at the
 * site root, so a path of `/data/samples/x` is `public/data/samples/x` — which
 * is the one thing standing between a button and a 404, and is therefore
 * resolved here the same way the dev server resolves it rather than written
 * out a second time. */
const sampleFile = (path: string) => readFileSync(join(ROOT, "public", path.replace(/^\//, "")), "utf-8");

const HAN = /[㐀-䶿一-鿿豈-﫿]|[\u{20000}-\u{2ffff}]/u;

describe("shipped samples", () => {
  it("declares two, and each names a file that is there", () => {
    expect(SAMPLE_TEXTS.map((s) => s.path)).toEqual([
      "/data/samples/rongo-gakuji.conllu",
      "/data/samples/shuchu.conllu",
    ]);
    for (const sample of SAMPLE_TEXTS) expect(sampleFile(sample.path).length).toBeGreaterThan(0);
  });

  for (const sample of SAMPLE_TEXTS) {
    describe(sample.path, () => {
      const tree = parseConllu(sampleFile(sample.path));

      it("passes the plausibility gate the upload route applies", () => {
        // The same call, on the same value: `openConlluText` in `main.ts` turns
        // a file away here rather than half-rendering it, and a sample is put
        // through it exactly as a stranger's file is. A sample that failed this
        // would reach the reader as an error message and nothing else.
        expect(validateConlluForLzh(tree).warnings).toEqual([]);
      });

      it("gives every sentence a reading order and a set of marks", () => {
        for (const sentence of tree.sentences) {
          const plan = computeReadingOrder(sentence, findCompoundSpans(sentence));
          assignKundokuTen(plan);
          // Not "some marks": a sentence may legitimately need none. What is
          // asserted is that the whole apparatus runs over it and that the
          // order accounts for every token that is read — a token missing from
          // it is a character that would be drawn and never spoken, and a
          // token twice in it is one that would be spoken twice. Punctuation
          // is outside the order by design and so outside this.
          expect(buildKundokuGlyphMap(plan)).toBeInstanceOf(Map);
          expect(new Set(plan.order).size).toBe(plan.order.length);
          const read = new Set(plan.order);
          for (const token of sentence.tokens) {
            if (token.pos !== "PUNCT") expect(read.has(token.id), `${token.text} is never read`).toBe(true);
          }
        }
      });

      it("writes prose for the whole text", () => {
        const prose = generateKakikudashiForTree(
          tree,
          (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence)),
          resolve,
        );
        expect(prose.trim().length).toBeGreaterThan(0);
        // No character of the source is left standing in the prose unread.
        // Kanji do survive into the 書き下し文 — that is the point of it — so
        // what this catches is the empty reading that would leave a stretch of
        // it blank instead.
        expect(prose).not.toMatch(/\s{4,}/);
      });
    });
  }
});

describe("論語・學而 sample", () => {
  const text = sampleFile("/data/samples/rongo-gakuji.conllu");
  const tree = parseConllu(text);

  it("is the whole of 學而第一 — 82 sentences, 499 Han characters", () => {
    // Counted, and both numbers are the build script's own report. 504 in the
    // treebank, less the five characters of the next 篇's heading that its
    // merge left inside this one's last sentence — see `drop_trailing_heading`
    // in `scripts/build-analects-sample.py`.
    expect(tree.sentences).toHaveLength(82);
    const han = tree.sentences
      .flatMap((s) => s.tokens)
      .filter((t) => HAN.test(t.text))
      .reduce((n, t) => n + [...t.text].length, 0);
    expect(han).toBe(499);
  });

  it("keeps the treebank's own sentence ids, so the extract can be traced back", () => {
    const ids = [...text.matchAll(/^# sent_id = (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(82);
    expect(ids[0]).toBe("KR1h0004_001_title#0");
    // KR1h0004 is the Kanseki Repository identifier for the 論語 and `_001` its
    // first 卷, which is 學而第一 entire — sixteen chapters and nothing outside
    // them.
    for (const id of ids) expect(id).toMatch(/^KR1h0004_001_(title|par([1-9]|1[0-6])_)/);
  });

  it("writes the marks in the received order, not the treebank's", () => {
    // The five corrections `build-analects-sample.py` makes, asserted as the
    // absence of what it corrected: a closing 」 never stands before the 。？！
    // that ends its own sentence, and a 「 never stands before the ： that
    // introduces its quotation. Both orderings are in the treebank as
    // published; see that script for why they are there and why swapping the
    // two rows is the whole of the fix.
    const forms = tree.sentences.flatMap((s) => s.tokens.map((t) => t.text));
    for (let i = 0; i < forms.length - 1; i++) {
      const pair = `${forms[i]}${forms[i + 1]}`;
      expect(pair).not.toMatch(/^」[。？！]$/);
      // The two crossed opening pairs: a ：that opened after its own 「, and a
      // book title 《 that opened outside the speech 「 containing it.
      expect(pair).not.toBe("「：");
      expect(pair).not.toBe("《「");
    }
    // And what should be there is: twenty quotations, opened and closed.
    expect(forms.filter((f) => f === "「")).toHaveLength(20);
    expect(forms.filter((f) => f === "」")).toHaveLength(20);
  });

  it("opens each chapter as a paragraph", () => {
    // Sixteen chapters, sixteen breaks — the heading is not given one, having
    // nothing above it to be separated from. `parse/sourceLayout.ts` reads this
    // key, and the 酒蟲 sample uses it the same way.
    const breaks = tree.sentences.flatMap((s) => s.tokens).filter((t) => t.misc?.LineBreak === "para");
    expect(breaks).toHaveLength(16);
  });

  it("leaves the 篇 heading standing alone as a paragraph", () => {
    // **The heading is set apart by chapter 1's break and not by one of its
    // own**, there being nothing above it. So what this asserts is that the
    // heading carries none and that the sentence *after* it does — the treebank
    // files that sentence under the heading's own id (its merge kept the first
    // member's), which is exactly the trap: sorted naively the break lands
    // three sentences late and cuts chapter 1 in half.
    const [heading, opening] = tree.sentences;
    expect(heading.tokens.map((t) => t.text).join("")).toBe("學而篇第一");
    expect(heading.tokens.some((t) => t.misc?.LineBreak)).toBe(false);
    expect(opening.tokens[0].misc?.LineBreak).toBe("para");
  });

  it("reads the heading as a title, in on'yomi", () => {
    // Left to the ordinary rules 學而篇第一 comes out 學びて篇第一 — 學 taken
    // for the verb it usually is and 而 for the て that follows it, which is a
    // fair reading of those two characters anywhere but in the name of the
    // chapter they open. So the five are pinned, under the same MISC key a
    // reader's own choice is stored under.
    const heading = tree.sentences[0];
    expect(heading.tokens.map((t) => t.misc?.Reading)).toEqual(["がく", "じ", "へん", "だい", "いち"]);
    // And the retag that has to come with them: a VERB goes on being
    // conjugated however it is read, so `Reading=がく` alone still yields 學し.
    expect(heading.tokens[0].pos).toBe("NOUN");
    const prose = generateKakikudashi(
      computeReadingOrder(heading, findCompoundSpans(heading)),
      resolve,
    );
    expect(prose).toBe("學而篇第一");
  });

  it("stops where 學而 stops", () => {
    // 為政篇第二 is the next 卷's heading, and the treebank's merge left it
    // inside this one's closing sentence — as its *root*, with 患 hanging off
    // it. Cutting it is a truncation and not a correction, and what it leaves
    // has to be given a root of its own.
    expect(text).not.toContain("為政");
    const last = tree.sentences[tree.sentences.length - 1];
    expect(last.tokens.map((t) => t.text).join("")).toBe("患不知人也。」");
    const root = last.tokens.find((t) => t.dep === "ROOT")!;
    expect(root.text).toBe("患");
    // Every mark the dropped heading used to carry now hangs off that root
    // rather than off a token that is no longer there.
    for (const token of last.tokens) expect(token.head).toBeLessThan(last.tokens.length);
  });

  it("numbers every block from 1 without a gap", () => {
    // `parseConllu` renumbers by position and would not notice a gap, but the
    // file is CoNLL-U before it is this app's input and the cut above is what
    // could leave one. See `renumber` in the build script.
    for (const block of text.split("\n\n")) {
      const ids = block.split("\n").filter((l) => /^\d/.test(l)).map((l) => Number(l.split("\t")[0]));
      expect(ids).toEqual(ids.map((_, i) => i + 1));
    }
  });

  it("ships the attribution its licence requires", () => {
    // CC BY-SA 4.0, so the notice is a condition and not a courtesy — and it
    // says in the same breath why no Kanripo/CHANT text is in the extract.
    const notice = readFileSync(join(DATA_DIR, "samples", "LICENSE-Kyoto.txt"), "utf-8");
    expect(notice).toContain("CC BY-SA 4.0");
    expect(notice).toContain("rongo-gakuji.conllu");
  });
});

describe("sample button strings", () => {
  it("has every key the panel asks for, in both languages", () => {
    const keys = ["sidebar.sampleLabel", ...SAMPLE_TEXTS.map((s) => s.label)];
    for (const key of keys) {
      expect(en, `en.json is missing ${key}`).toHaveProperty(key);
      expect(ja, `ja.json is missing ${key}`).toHaveProperty(key);
    }
  });

  it("leaves the two files with the same key set", () => {
    // The panel is drawn from whichever file is current, so a key in one and
    // not the other is a blank label for half the readers — and an orphan in
    // either is a string nothing shows. Cheap to check here, and this is the
    // first thing in the suite that does.
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });
});

describe("the tutorial's line is the sample's own", () => {
  // `HelpModal.ts` writes its four rows out rather than fetching the sample to
  // draw them — the modal is opened on demand and must not become a second way
  // of loading a document, and the argument is at `SAMPLE` there. This is the
  // other half of that bargain: a copy that cannot silently diverge, because
  // the file it was copied from is read here and compared.
  const text = sampleFile("/data/samples/rongo-gakuji.conllu");
  const block = text.split("\n\n").find((b) => b.includes("# sent_id = KR1h0004_001_par5_1-2#1"))!;
  const rows = block.split("\n").filter((l) => /^\d/.test(l)).map((l) => l.split("\t"));

  it("copies 敬事而信 out of the sample, row for row", () => {
    // The trailing ， is left behind: the tutorial draws a fragment and not a
    // sentence, and a comma is nothing to select, retag or re-attach.
    const content = rows.filter((r) => r[3] !== "PUNCT");
    expect(content.map((r) => r[1])).toEqual(["敬", "事", "而", "信"]);
    expect(SAMPLE.map((s) => s.base)).toEqual(content.map((r) => r[1]));
    // 0-based ids against the file's 1-based ones, and a root self-looped onto
    // itself rather than left pointing at 0 — the same two shifts `parseConllu`
    // applies, so what is compared is the tree the modal draws against the tree
    // the app would draw from the file. The subtraction is sound because the
    // one row dropped above, the comma, is the last of them.
    expect(SAMPLE.map((s) => s.token.pos)).toEqual(content.map((r) => r[3]));
    expect(SAMPLE.map((s) => s.token.head)).toEqual(
      content.map((r, i) => (r[6] === "0" ? i : Number(r[6]) - 1)),
    );
    expect(SAMPLE.map((s) => s.token.dep)).toEqual(["ROOT", "comp:obj", "cc", "conj:coord"]);
    expect(content.map((r) => r[7])).toEqual(["root", "comp:obj", "cc", "conj:coord"]);
  });

  it("shows the prose the generator actually writes for it", () => {
    // The figure beside the 書き下し文 step is a hand-written run of words, and
    // the file's own comment calls it "the one thing here that could go stale
    // without anything breaking". This is what breaks instead.
    const plan = computeReadingOrder(
      { tokens: SAMPLE.map((s) => s.token) },
      findCompoundSpans({ tokens: SAMPLE.map((s) => s.token) }),
    );
    expect(generateKakikudashi(plan, resolve)).toBe(KAKIKUDASHI_SAMPLE.join(""));
  });

  it("puts a kaeriten on the line, and a different one once the drag has landed", () => {
    // The whole subject of two of the figures. 事 is read before 敬, so 敬 takes
    // a レ; re-attach 信 to 事 and that レ has nothing to invert, and a 一二点
    // spanning 信 and 敬 stands in its place. Both are computed by the modal
    // through this same engine, so what is pinned here is that the line still
    // has something for those figures to show.
    const marksFor = (tokens: typeof SAMPLE[number]["token"][]) => {
      const plan = computeReadingOrder({ tokens }, findCompoundSpans({ tokens }));
      assignKundokuTen(plan);
      return [...buildKundokuGlyphMap(plan).entries()].sort((a, b) => a[0] - b[0]);
    };
    const tokens = SAMPLE.map((s) => s.token);
    expect(marksFor(tokens)).toEqual([[0, "㆑"]]);
    const dragged = tokens.map((t) => (t.id === 3 ? { ...t, head: 1 } : t));
    expect(marksFor(dragged)).toEqual([[0, "㆓"], [3, "㆒"]]);
  });
});

describe("a sample that is only read leaves nothing in the saved list", () => {
  // The autosave writes the open document unasked once a minute, and its
  // argument for doing so is that a text never saved is the text whose loss
  // costs the most. A sample is not such a text — it is one click from being
  // back — so `SavedPanel.setTree` seeds its comparison with the document's own
  // signature instead of clearing it, and the first tick then finds nothing to
  // do. There is no browser here, so what is pinned is the comparison that
  // decision rests on rather than the panel that makes it.

  const tree = parseConllu(sampleFile("/data/samples/rongo-gakuji.conllu"));
  const source = tree.sentences.flatMap((s) => s.tokens.map((t) => t.text)).join("");

  it("is byte-identical to itself, so the seeded tick has nothing to write", () => {
    // The seed is taken after the render (`openCompleteTree` draws first and
    // calls `setTree` second), so whatever the render puts on the tree is
    // already inside it. What must not happen is the signature moving on its
    // own between two readings of an untouched tree.
    expect(storedSignature(source, tree)).toBe(storedSignature(source, tree));
  });

  it("moves the moment the reader picks a reading", () => {
    // Which is what turns the sample back into a document like any other: the
    // bytes differ from the seed, the ordinary autosave writes, and an entry
    // appears. A hand-picked reading is the smallest edit the app offers —
    // retagging and re-attaching change the tree more visibly still.
    const before = storedSignature(source, tree);
    setChosenReading(tree.sentences[1].tokens[1], "のたま", "ハク");
    expect(storedSignature(source, tree)).not.toBe(before);
  });

  it("only the sample route claims to be shipped", () => {
    // The upload shares every other step with it (`openConlluText`), and is
    // deliberately left alone: a file the reader chose off their own disk is
    // not one the app can hand back at a click, and nobody has asked for that
    // to change. This is the line between the two, written down.
    expect(SAMPLE_TEXTS.every((s) => s.path.startsWith("/data/samples/"))).toBe(true);
  });
});
