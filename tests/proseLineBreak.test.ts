import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";

// ---------------------------------------------------------------------------
// **Where a line break falls in the prose panel, when the line is not read in
// the order it is written.**
//
// `annotateSourceLayout` records `breakBefore` on the token a line begins with
// *on the page*, and for the 訓読文 panel that is the whole story: that panel
// prints the characters in source order, so a break hung on the line's first
// character falls exactly where the source put it.
//
// The prose panel walks reading order, and the two orders disagree about which
// character of a line comes first far more often than not — a transitive verb
// opening a line has its object read before it, and Literary Chinese puts the
// object after. A break left on the source-first token then fires *after* the
// tokens that were pulled ahead of it, and they are printed at the end of the
// line above.
//
// This was shipped and visible in 春望, on two of its six lines at once. The
// panel wrote 城春にして草木深し**時を** / 感じ花に淚を濺ぎ**別るるを** /
// 恨み鳥に心を驚かす, where the received reading has 時に感じては花にも涙を濺ぎ /
// 別れを恨んでは鳥にも心を驚かす — every line short by its own opening word and
// carrying the next line's instead. It is the kind of fault that no
// reading-quality measure can see (the ratchets fold the prose to one run, so
// the characters are all present and all in order) and that a reader sees
// immediately, which is why it has a test of its own.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** The prose the two panels are generated from, split into its lines. */
function proseLines(conllu: string): string[] {
  const tree = parseConllu(conllu);
  const out = generateKakikudashiForTree(
    tree,
    (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
    resolve,
  );
  return out.split("\n");
}

describe("a line break falls before the first token of its line that is read", () => {
  it("opens the line with its object, where the verb is written first", () => {
    // 深 closes one line; 感時 opens the next, and 時 is read before 感. The
    // break is recorded on 感 and has to be printed before 時.
    const lines = proseLines(
      [
        "# text = 深感時",
        "1\t深\t深\tVERB\tv,動詞,描写,形質\t_\t0\troot\t_\t_",
        "2\t感\t感\tVERB\tv,動詞,行為,態度\t_\t1\tparataxis\t_\tLineBreak=line",
        "3\t時\t時\tNOUN\tn,名詞,時,時間\t_\t2\tcomp:obj\t_\t_",
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("時");
    expect(lines[1].startsWith("時")).toBe(true);
  });

  it("leaves a line alone whose first character is also read first", () => {
    // The ordinary case, and the one that was never wrong: an intransitive
    // predicate opening a line is both written and read first, so the carrier
    // does not move and the output is what it always was.
    const lines = proseLines(
      [
        "# text = 深破",
        "1\t深\t深\tVERB\tv,動詞,描写,形質\t_\t0\troot\t_\t_",
        "2\t破\t破\tVERB\tv,動詞,行為,動作\t_\t1\tparataxis\t_\tLineBreak=line",
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("破")).toBe(true);
  });

  it("breaks 春望 where the received reading breaks it", () => {
    // The shipped sample, and the passage the fault was seen on. Asserted as
    // "each line opens with the word the received reading opens it with"
    // rather than on the whole prose, so that the two defects this poem still
    // has — 白の頭 for 白頭, and the まほし of 渾欲不勝簪 — do not make this
    // test fail for something it is not about. Both are recorded where they
    // belong: `compoundReading.ts`'s 白頭 note and the 欲 entry.
    const lines = proseLines(readFileSync(join(DATA_DIR, "samples", "shunbou.conllu"), "utf-8"));
    // 春望 / 杜甫 / then the eight lines of the 五言律詩.
    expect(lines).toHaveLength(10);
    expect(lines.map((line) => [...line][0])).toEqual([
      "春", "杜", "國", "城", "時", "別", "烽", "家", "白", "渾",
    ]);
  });
});

// ---------------------------------------------------------------------------
// **And it falls at a coordination, where reading order leaves the choice
// open.**
//
// "The line's first token in reading order" is a rule about where the reorder
// engine happened to put a character, and a line break is a cut between
// clauses. The two agree on every line this repository ships — all 27 of them,
// across 春望, 論語學而 and 蜀相 — and come apart as soon as reading order
// interleaves one source line with the next, which the prose of the corpus does
// on 2,686 of its 9,912 punctuation-delimited lines. `breakCarriersFor` scores
// each candidate cut by the characters it prints on a line other than the one
// they were written on and settles ties on the coordination; the three cases
// below are the three outcomes that scoring has.
// ---------------------------------------------------------------------------

describe("a line break falls at a coordination, where the cut is open", () => {
  it("gives back the characters reading order dragged onto the line below", () => {
    // Modelled on 萬物作焉而不辭、生而不有 as the corpus parses it, where 生 —
    // the first character of the second line — is an argument of the first
    // line's verb and so is read in the middle of that line. Hanging the break
    // on 生 printed 作・不・辭 on the second line, three characters out of
    // place; hanging it on the coordination 生 does not belong to leaves only
    // 生 out of place. Would have caught a rule that stopped at the first token
    // read: that token is 生.
    const lines = proseLines(
      [
        "# text = 民作不辭生有",
        "1\t民\t民\tNOUN\tn,名詞,主体,集団\t_\t2\tsubj\t_\t_",
        "2\t作\t作\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_",
        "3\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_",
        "4\t辭\t辭\tVERB\tv,動詞,行為,伝達\t_\t2\tconj:coord\t_\t_",
        "5\t生\t生\tNOUN\tn,名詞,抽象物,道徳\t_\t2\tcomp:obj\t_\tLineBreak=line",
        "6\t有\t有\tVERB\tv,動詞,存在,存在\t_\t2\tconj:coord\t_\t_",
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("生");
    expect(lines[1].startsWith("有")).toBe(true);
  });

  it("puts the break on the clause edge where the two cuts cost the same", () => {
    // 城 opens the second line but is the first line's object, so it is read
    // before 破 whatever the break does: cut before 城 and 破 falls on the
    // second line, cut before 時 and 城 falls on the first. One character is
    // out of place either way, and the tie goes to 時, which opens the
    // coordinate clause 時深 — 城を破り / 時は深し rather than an empty first
    // line and 城を破り時は深し under it. Would have caught a rule that broke
    // such a tie by taking the earliest cut, which is the first token read.
    const lines = proseLines(
      [
        "# text = 破城時深",
        "1\t破\t破\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_",
        "2\t城\t城\tNOUN\tn,名詞,固定物,建造物\t_\t1\tcomp:obj\t_\tLineBreak=line",
        "3\t時\t時\tNOUN\tn,名詞,時,*\tCase=Tem\t4\tsubj\t_\t_",
        "4\t深\t深\tADJ\tv,動詞,描写,量\tDegree=Pos\t1\tconj:coord\t_\t_",
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("城");
    expect(lines[1].startsWith("時")).toBe(true);
  });

  it("leaves the break alone where the coordination would cost a character", () => {
    // The guard, and the reason the coordination is only a tie-break. 貧而無諂
    // has its coordination on 無, whose clause 而無諂 begins one character into
    // the line; a rule that moved every break onto the nearest clause edge
    // would break before 而 and print 貧 at the end of the line above. It is
    // not a rule that can be waved through on the strength of the two cases
    // above: snapping every break to its nearest clause edge moves 3,898 of
    // the corpus's 9,912 punctuated breaks and makes 3,601 of them worse.
    // Here the cut before 貧 already puts every character on its own line, so
    // nothing can tie with it and the break does not move.
    const lines = proseLines(
      [
        "# text = 破貧而無諂",
        "1\t破\t破\tVERB\tv,動詞,行為,交流\t_\t0\troot\t_\t_",
        "2\t貧\t貧\tVERB\tv,動詞,描写,態度\tDegree=Pos\t1\tconj:coord\t_\tLineBreak=line",
        "3\t而\t而\tCCONJ\tp,助詞,接続,並列\t_\t4\tcc\t_\t_",
        "4\t無\t無\tVERB\tv,動詞,存在,存在\t_\t2\tconj:coord\t_\t_",
        "5\t諂\t諂\tNOUN\tn,名詞,抽象物,態度\t_\t4\tcomp:obj\t_\t_",
        "",
      ].join("\n"),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("貧")).toBe(true);
  });
});
