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
// The three texts the sidebar's sample buttons load.
//
// **There is no browser here, so what this pins is everything up to the
// markup**: that each file is on disk where the button asks for it, that it
// survives the very gate the app puts an upload through, and that every
// sentence in it goes through the reading order, the kaeriten and the prose
// generator without throwing and with something to show for it. What it cannot
// see is the page — that the buttons are where they should be and that the two
// columns look right is the reader's to confirm.
//
// It matters more here than for a hand-typed fixture, because these files
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
  it("declares three, and each names a file that is there", () => {
    expect(SAMPLE_TEXTS.map((s) => s.path)).toEqual([
      "/data/samples/rongo-gakuji.conllu",
      "/data/samples/shuchu.conllu",
      "/data/samples/shunbou.conllu",
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
      // **A budget, because this one sweep is the slowest thing in the file.**
      // It renders every sentence of every shipped sample through the real
      // resolver — 2s alone, and vitest's default 5s is not a claim about this
      // test but about the runner's defaults: on a loaded machine it timed out
      // here and in `odoriji.test.ts` while passing in isolation, which is a
      // red that says nothing. The same budget the other whole-index sweeps
      // carry (`candidateReadings`, `conjClassCartouche`, `printLayout`).
      }, 30_000);
    });
  }
});

describe("論語・學而 sample", () => {
  const text = sampleFile("/data/samples/rongo-gakuji.conllu");
  const tree = parseConllu(text);

  it("is the whole of 學而第一 — 21 sentences, 499 Han characters", () => {
    // Counted, and both numbers are the build script's own report.
    //
    // **21 and not 82, because a quotation is one sentence.** The sample is
    // built off the treebank's sentence-joined branch (`punct.sjmerged`),
    // where the parser's own `SentJoin` rule has run over the gold and refuses
    // a boundary inside an open quoted span; the rule-merged branch it
    // replaced cut 子曰：「學而時習之， from 不亦說乎？ and left the 「 open across
    // three sentences. The character count is unchanged, which is the point:
    // the same 499 characters in the same order, grouped as the reader reads
    // them. See `TREEBANK_TAG` in `scripts/build-analects-sample.py`.
    expect(tree.sentences).toHaveLength(21);
    const han = tree.sentences
      .flatMap((s) => s.tokens)
      .filter((t) => HAN.test(t.text))
      .reduce((n, t) => n + [...t.text].length, 0);
    expect(han).toBe(499);
  });

  it("keeps the treebank's own sentence ids, so the extract can be traced back", () => {
    const ids = [...text.matchAll(/^# sent_id = (\S+)$/gm)].map((m) => m[1]);
    expect(ids).toHaveLength(21);
    expect(ids[0]).toBe("KR1h0004_001_title_sj1");
    // KR1h0004 is the Kanseki Repository identifier for the 論語 and `_001` its
    // first 卷, which is 學而第一 entire — sixteen chapters and nothing outside
    // them. The `_sjN` suffix counts the sentences the join left within one
    // kanripo paragraph: one for most chapters, four for 子貢問.
    for (const id of ids) expect(id).toMatch(/^KR1h0004_001_(title|par([1-9]|1[0-6]))_sj\d+$/);
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

  it("stops where 學而 stops, and closes the quotation it opened", () => {
    // **The join put the next 篇's heading where it belongs, and took this
    // 篇's closing marks with it.** 為政篇第二 opens 卷二 and is no longer
    // inside this extract's last sentence at all — but the gold writes 學而's
    // final 。」 *after* that heading, so both marks were filed under 卷二 and
    // chapter 16 was left with an opening 「 and nothing to close it. The
    // build script takes them back and hangs them on the chapter's own root;
    // see `reclaim_trailing_marks`.
    expect(text).not.toContain("為政");
    const last = tree.sentences[tree.sentences.length - 1];
    expect(last.tokens.map((t) => t.text).join("")).toBe("子曰：「不患人之不己知，患不知人也。」");
    const root = last.tokens.find((t) => t.dep === "ROOT")!;
    expect(root.text).toBe("曰");
    // The two reclaimed marks hang off a token of this sentence, not off one
    // in the block they came from.
    for (const token of last.tokens) expect(token.head).toBeLessThan(last.tokens.length);
    expect(last.tokens.at(-1)!.text).toBe("」");
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

describe("杜甫・春望 sample", () => {
  const text = sampleFile("/data/samples/shunbou.conllu");
  const tree = parseConllu(text);
  const proseOf = (i: number) =>
    generateKakikudashi(computeReadingOrder(tree.sentences[i], findCompoundSpans(tree.sentences[i], { kanjidic, jmdict })), resolve);

  // ── What this pins, and what it deliberately does not ─────────────────────
  //
  // **Clauses, with kanbun.info's own reading quoted beside each.** The reader's
  // instruction for this text is to follow that site as far as possible, and
  // six of the eight lines now read exactly as it gives them. Two do not, and
  // both are refusals with a number rather than work left undone:
  //
  //  - **搔き, where the site has 掻けば.** The protasis needs a 則-class
  //    connective the line does not contain, and recognising one from the
  //    relation and the POS alone measures **+1,597 edits** over the whole of
  //    kanbun.info (gold +112, parser +1,485). See `isConditionalTemporalClause`,
  //    whose own note names this line.
  //  - **別るるを, where the site has 別れを.** Gold tags 別 VERB 141 times and
  //    NOUN never, so the app's nominalization is the treebank's reading of the
  //    character.
  //
  // A third difference is not one: 國破れ against 國破れ**て** is the 連用形-て
  // switch (`renyouTe.ts`), a display option that is off by default.
  //
  // **Whole sentences are still not pinned**, for `tests/kanbunInfoCorpus.test.ts`'s
  // reason read the other way round — a sentence assertion would bank the two
  // defects above as though they were wanted. What is pinned is the stretches
  // that are *right*, so that a change which broke one of them would be seen.
  //
  // The annotation itself is argued in the file's own header comments, one
  // block per sentence, against the Kyoto SUD treebank's counts — and so are
  // the pins, of which this poem now carries nine: three `Reading=`/`ConjClass=`
  // and six `Topic=` particle slots.

  it("is a title, a poet, and eight lines of five characters, in seven sentences", () => {
    // Seven: 春望, 杜甫, and then five for the poem — a sentence there is a
    // couplet wherever the couplet's first line hands on to its second (濺ぎ,
    // 連なり, 短く are 連用中止 and mean nothing on their own), and a line
    // wherever it closes on a 終止形 (在り, 深し). The ten *lines* are marked
    // independently, by `LineBreak`, which is what the rime annotation hangs
    // off — see `rimeAnnotation.ts`.
    expect(tree.sentences).toHaveLength(7);
    const tokens = tree.sentences.flatMap((s) => s.tokens);
    expect(tokens.filter((t) => HAN.test(t.text))).toHaveLength(44); // 4 of heading + 40 of poem
    const breaks = tokens.filter((t) => t.misc?.LineBreak === "line");
    expect(breaks.map((t) => t.text)).toEqual(["杜", "國", "城", "感", "恨", "烽", "家", "白", "渾"]);
    // **No `para` anywhere, and that is deliberate.** The prose generator
    // indents a paragraph break by one cell (`layout.breakBefore === "para" ?
    // 1 : 0`), which is right for the 論語's chapters and wrong for verse: a
    // line of a 律詩 is flush. 國 opens the poem on a plain line break and the
    // panel gets 國破れて, not 　國破れて.
    expect(tokens.some((t) => t.misc?.LineBreak === "para")).toBe(false);
    expect(proseOf(2)).not.toContain("\u3000");
  });

  it("reads its title and its poet without a single pinned reading", () => {
    // **Checked rather than assumed, because `mod` between two nouns writes a
    // genitive.** 春 is a `mod` of 望 and the ordinary rule would give 春の望;
    // what stands it down is `findCompoundSpans`' lexical-word branch, JMdict
    // holding 春望 as しゅんぼう and the reading dividing into on'yomi. 杜甫
    // fuses on `flat`, the ordinary surname-plus-given-name span. So neither
    // line carries a `Reading=` and neither needs one — unlike the 論語
    // sample's 學而篇第一, which has five.
    expect(proseOf(0)).toBe("春望");
    expect(proseOf(1)).toBe("\n杜甫");
    const heading = tree.sentences.slice(0, 2).flatMap((s) => s.tokens);
    expect(heading.map((t) => t.text)).toEqual(["春", "望", "杜", "甫"]);
    for (const token of heading) expect(token.misc?.Reading, token.text).toBeUndefined();
    for (const sentence of tree.sentences.slice(0, 2)) {
      expect(findCompoundSpans(sentence, { kanjidic, jmdict }).map((s) => s.text)).toEqual([
        sentence.tokens.map((t) => t.text).join(""),
      ]);
    }
  });

  it("國破山河在 — 「山河在り」", () => {
    // The received reading is 国破れて山河在り, and 在り is the part this pins: 在 is
    // ラ変 and its 終止形 is あり, against the 四段ラ行 在る the app reached for it
    // when this sample was written. Asserted as the *reading*, not as the
    // mechanism — a `ConjClass` pin in MISC produced it when this was written
    // and a `verbLexicon.ts` entry produces it now (在 is `ra-hen` there, and
    // the pin has come out of the sample); either way this line is what has to
    // come out. Pinning the reading rather than the route is what let that
    // change land without touching this. The て of 破れて is the 連用形-て switch, off by
    // default; see `renyouTe.ts`, a display convention and not a defect.
    expect(proseOf(2)).toContain("山河在り");
    expect(proseOf(2)).toContain("破れ");
  });

  it("城春草木深 — 「城春にして草木深し」, the received line entire", () => {
    // The one line that comes out exactly as it is received, and it is the
    // line the annotation had most to fix: the parser made 春 a temporal `mod`
    // of 草 and left 深 an adverbial converb, so the line had no predicate.
    expect(proseOf(3)).toContain("城春にして草木深し");
  });

  it("感時花濺淚 — 「時に感じては花にも淚を濺ぎ」, the received line entire", () => {
    // The に on 花 is the annotation's own and is the whole point of it — the
    // parser read 花 as the subject of 濺 ("the flowers shed tears"), and the
    // received reading has the poet weeping *at* them. What the tree cannot
    // state is the rest: the も of 花にも is the editor's emphasis, the に of
    // 時に contradicts the relation (gold has 時 `comp:obj` under 感, twice),
    // and the は of 感じては has no source in a dependency at all. All three are
    // `Topic=` pins in the sample, argued there. 濺ぎ is 連用中止, which is what
    // makes the couplet one sentence.
    expect(proseOf(4)).toContain("時に感じては花にも淚を濺ぎ");
  });

  it("恨別鳥驚心 — 「恨みては鳥にも心を驚かす」", () => {
    // The same three pins on the couplet's second line, plus one more: the
    // site prints the 撥音便 恨んで, and 音便 is 口語, not 文語, so the pin holds
    // the uncontracted 連用形+て 恨みて instead — 文語 morphology outranks the
    // site here the way pure 歴史的仮名遣い already does. That one is a
    // `Reading=`/`Okurigana=` pin and is the one pin in the file that survives
    // only because no paradigm can be read off the ending it stores — see
    // `derivedConjClass`, and the sample's own note — so it is asserted here
    // rather than left to be noticed.
    //
    // 別るるを and not 別れを: gold tags 別 VERB 141 times and NOUN never, so
    // the app's nominalization is the gold's reading of it and is left standing.
    expect(proseOf(4)).toContain("別るるを恨みては鳥にも心を驚かす");
  });

  it("烽火連三月 — 「烽火三月に連なり」, the received line entire", () => {
    // 烽火 and not 烽の火: the gold hangs 火 off 烽 by `conj:coord` (5 against
    // 1 `mod`), and a coordination takes no genitive between its members. The
    // に is `comp:obl@tmod` on 月, and 連なり is again 連用中止.
    expect(proseOf(5)).toContain("烽火三月に連なり");
  });

  it("家書抵萬金 — 「家書」 fuses, because the dictionary reads it かしょ", () => {
    // The other 熟語 of the couplet, and it fuses by a different route: 家 is a
    // plain NOUN `mod` of 書, which would ordinarily take の, and what stands
    // that down is `findCompoundSpans`' lexical-word branch — JMdict has 家書
    // かしょ and the reading divides into on'yomi, so the two are one word.
    // Asserted with the lexicon passed, because without it the branch cannot
    // be asked and the line reads 家の書; both panels pass it, and this is the
    // call shape they use.
    expect(proseOf(5)).toContain("家書");
    expect(proseOf(5)).not.toContain("家の書");
  });

  it("白頭搔更短 — 「白頭」 is one word, and takes no particle", () => {
    // **白頭 はくとう and not 白の頭.** 白 is a NOUN `mod` of 頭, which writes a
    // genitive, and the gate that fuses such a pair asks JMdict — whose only
    // 白頭 is the native しろがしら, so the pair was refused as a native compound.
    // `LEXICALIZED_ONYOMI_COMPOUND` in `readingResolver.ts` names it, on the
    // test that admits a numeral compound: one word in every gold instance,
    // which 白頭 is, 7 of 7.
    //
    // **And no は after it.** The sentence's root has a `Degree=Pos` coordinate
    // (短), so `isTopicalizedAdjective` marked the subject of the embedded 搔
    // clause 白頭**は**; the received text writes it bare, and the sample empties
    // the slot with an empty `Topic=`. Asserted here because that convention is
    // used exactly once in the repository.
    //
    // 更 is ADV + `VerbForm=Conv`, gold's own tagging of it (90 of 90 adverbial
    // uses), and さらに is what the line needs — left to the xpos alone the app
    // conjugated it as a サ変 converb and wrote 更して. Asserted as the reading
    // and not as the mechanism. 短く is the 連用形 that hands on to the last
    // line, which is why the couplet is one sentence.
    expect(proseOf(6)).toContain("白頭搔き更に短く");
    expect(proseOf(6)).not.toContain("白の頭");
    expect(proseOf(6)).not.toContain("白頭は");
  });

  it("渾欲不勝簪 — 「渾て簪に勝へざらんと欲す」, the received line entire", () => {
    // 渾 is the adverb すべて and not the surname the parser read; 勝 is 堪ふ
    // (下二段ハ行), which KANJIDIC gives the character no kun for that the app
    // could reach on its own. **欲 is the verb 欲す and no longer the 助動詞
    // まほし** (`PINNED_ONLY_AUXILIARY_LEMMAS`), and what it governs is a quoted
    // volition — 未然形 + んと, the negation taking the ざり paradigm's ざら to
    // carry it. The line read 簪に勝へずまほし when this sample was written.
    expect(proseOf(6)).toContain("渾て簪に勝へざらんと欲す");
  });

  it("carries no punctuation, because the received text carries none", () => {
    // The 白文 of a poem is printed unpointed, one line to a line, and so is
    // this one. It is also what makes the sample a real test of the line
    // detector's primary reading: with no punctuation there is nothing but
    // `LineBreak` to find the lines by.
    expect(tree.sentences.flatMap((s) => s.tokens).some((t) => t.pos === "PUNCT")).toBe(false);
  });
});

describe("sample button strings", () => {
  it("has every key the panel asks for, in both languages", () => {
    const keys = [
      "sidebar.sampleLabel",
      ...SAMPLE_TEXTS.map((s) => s.label),
      ...SAMPLE_TEXTS.map((s) => s.hint),
    ];
    for (const key of keys) {
      expect(en, `en.json is missing ${key}`).toHaveProperty(key);
      expect(ja, `ja.json is missing ${key}`).toHaveProperty(key);
    }
  });

  it("keeps every title short enough for the row to hold on one line", () => {
    // ── The arithmetic this enforces ─────────────────────────────────────────
    // The sidebar's track is `--side-track-open`, 20rem = 320px; the panel
    // insets 1.25rem each side and keeps a 1px border, leaving the row 279px.
    // With three buttons and this row's 0.5rem gap a cell is (279 - 16)/3 =
    // 87.67px, of which each button spends 2 x 1px of border and 2 x 0.4rem of
    // padding-inline = 14.8px, leaving **72.87px** of text. A title is
    // full-width Han at `font-size: 0.95rem` = 15.2px a character, so a
    // three-button row holds **four**. See `.sample-row` in app.css, which
    // carries the table for two through six buttons.
    //
    // The rule this test states is the general one, so a fourth sample is
    // caught here rather than on the page: at N buttons the row holds
    // floor(((279 - 8(N-1))/N - 14.8) / 15.2) characters.
    const n = SAMPLE_TEXTS.length;
    const capacity = Math.floor(((279 - 8 * (n - 1)) / n - 14.8) / 15.2);
    expect(capacity).toBeGreaterThan(0); // six samples would need a rethink, not a longer title
    for (const sample of SAMPLE_TEXTS) {
      for (const [lang, strings] of [["en", en], ["ja", ja]] as const) {
        const title = (strings as Record<string, string>)[sample.label];
        expect([...title].length, `${lang}: ${title} is too long for a row of ${n}`).toBeLessThanOrEqual(capacity);
      }
    }
  });

  it("gives the same title in both languages, so the row cannot fit in one and wrap in the other", () => {
    // **The failure this rules out by construction.** A row sized for one
    // language's labels and overflowed by the other's is the classic version
    // of this bug, and it cannot happen here: these are Han titles of Chinese
    // texts and are the same string in both files (`SAMPLE_TEXTS`' own note
    // says so). The full names behind the tooltips are the same for the same
    // reason.
    for (const sample of SAMPLE_TEXTS) {
      expect((en as Record<string, string>)[sample.label]).toBe((ja as Record<string, string>)[sample.label]);
      expect((en as Record<string, string>)[sample.hint]).toBe((ja as Record<string, string>)[sample.hint]);
    }
  });

  it("keeps the work's name on the tooltip, since the button can no longer carry it", () => {
    // 聊齋志異・酒蟲 is seven characters, 106.4px: it fitted the 120.70px of a
    // two-button row and overflows a three-button one by 46%. The button says
    // 酒蟲; nothing is lost, because `data-i18n-attr="title:…"` puts the full
    // name back where a pointer finds it.
    expect((ja as Record<string, string>)["sidebar.sampleShuchu"]).toBe("酒蟲");
    expect((ja as Record<string, string>)["sidebar.sampleShuchuFull"]).toBe("聊齋志異・酒蟲");
    for (const sample of SAMPLE_TEXTS) {
      const short = (ja as Record<string, string>)[sample.label];
      const full = (ja as Record<string, string>)[sample.hint];
      expect(full, `${full} should name the text ${short} is short for`).toContain(short);
    }
  });

  it("draws the row as one track per sample, so a fourth would not wrap", () => {
    // The literal `1fr 1fr` this replaced is exactly why the third button went
    // onto a second row: a track list is a count, and the count was two.
    const css = readFileSync(join(ROOT, "src", "app.css"), "utf-8");
    const at = css.indexOf("\n.sample-row {");
    // Declarations only: the block's own comment names the `grid-template-columns`
    // it replaced, and a check that could not tell a rule from a note about a
    // rule would fail on the explanation of its own fix.
    const block = css.slice(at, css.indexOf("\n}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block).toContain("grid-auto-flow: column;");
    expect(block).toContain("grid-auto-columns: 1fr;");
    expect(block).not.toContain("grid-template-columns");
  });

  it("leaves the two language files with the same key set", () => {
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
  const block = text.split("\n\n").find((b) => b.includes("# sent_id = KR1h0004_001_par5_sj1"))!;
  const blockRows = block.split("\n").filter((l) => /^\d/.test(l)).map((l) => l.split("\t"));

  // **The line is a run inside its chapter, not a block of its own.** The
  // sample is built off the treebank's sentence-joined branch, where a whole 章
  // is one sentence — 子曰：「道千乘之國，敬事而信，… — so the four characters the
  // tutorial draws are four rows in the middle of twenty-seven rather than a
  // block to be read whole. Found by their forms and checked to be adjacent,
  // which is what makes "the sample's own" mean this line and not four
  // characters that happen to occur.
  const start = blockRows.findIndex(
    (_, i) => ["敬", "事", "而", "信"].every((c, k) => blockRows[i + k]?.[1] === c),
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const rows = blockRows.slice(start, start + 4);

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
    // **A fragment lifted out of a sentence is re-rooted, and that is the one
    // shift this comparison makes.** 敬 stands `parataxis` of 道 in the file,
    // its head three rows above the run; the tutorial draws the four
    // characters alone, where the head of the run is the run's own root. So a
    // head pointing outside the four is read as the root, exactly as
    // `parseConllu` reads a `0`, and every head inside them is compared as it
    // stands. Nothing else about the line moves: the three internal arcs are
    // the file's own, asserted below.
    const ids = content.map((r) => r[0]);
    expect(SAMPLE.map((s) => s.token.head)).toEqual(
      content.map((r, i) => (ids.includes(r[6]) ? ids.indexOf(r[6]) : i)),
    );
    expect(SAMPLE.map((s) => s.token.dep)).toEqual(["ROOT", "comp:obj", "cc", "conj:coord"]);
    // The file's own labels, with 敬's being the one the re-rooting replaces:
    // inside the chapter it is a `parataxis` of 道, and standing alone it is
    // the ROOT the tutorial calls it.
    expect(content.map((r) => r[7])).toEqual(["parataxis", "comp:obj", "cc", "conj:coord"]);
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
