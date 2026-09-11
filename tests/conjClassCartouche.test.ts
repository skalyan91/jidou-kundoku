import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { candidateReadings, type KanjidicIndex, type ReadingCandidate } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { conjClassCartouches } from "../src/render/tokenInspector.ts";
import {
  CONJ_CLASS_CARTOUCHE,
  CONJ_CLASS_UNKNOWN_CARTOUCHE,
  type ConjClass,
  conjugate,
} from "../src/kakikudashi/classicalConjugation.ts";
import { derivedConjClass } from "../src/reading/chosenReading.ts";

/** The readings menu's conjugation-class cartouche, and the census that
 * decided its design.
 *
 * **There is no browser in this suite and no layout in it**, so nothing here
 * looks at a menu. What is checked is the two pure functions the drawing is
 * made out of — `conjClassCartouches`, which decides where a label goes and
 * what it says, and `CONJ_CLASS_CARTOUCHE`, which is the label — over the
 * whole shipped index rather than over the two characters the design was first
 * argued from. Only the reader's eyes can settle what the frame looks like
 * beside a reading — and one of the things it could not settle has now been
 * settled *by* him: 二分 of phase between the label and the reading is visible
 * at 0.65em, and the arithmetic at the foot of this file is the round that
 * bought it back. `.token-menu-conj` in kunten.css says so in its own terms.
 *
 * Every figure asserted below is one this file computes. */
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const historical = JSON.parse(readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8")) as HistoricalKanaIndex;

/** The menu's own list for one character, built exactly as `readingOfferFor`
 * builds it — the same four arguments, in the same order.
 *
 * **Memoised, and the memo is what keeps this file inside the runner's own
 * timeout.** Six of the tests below sweep all 12,356 characters of the shipped
 * index, and each sweep asks this for every one of them; unmemoised, the
 * longest of them measured 5,345ms against vitest's 5,000ms default and failed
 * intermittently — passing alone, timing out when the suite ran under load
 * beside other agents' work. Raising the limit would have hidden that; the
 * repeated work is the actual fault, since `candidateReadings` is pure in these
 * five arguments and every sweep after the first was recomputing an answer the
 * previous one had already had.
 *
 * Keyed on the two arguments that vary. The other three are module constants
 * loaded once from `public/data`, so they cannot make two calls differ. */
const menuCache = new Map<string, ReadingCandidate[]>();
const menuFor = (char: string, pos = "VERB") => {
  const key = `${char}\u0000${pos}`;
  const hit = menuCache.get(key);
  if (hit) return hit;
  const built = candidateReadings(kanjidic, char, pos, historical, jmdict);
  menuCache.set(key, built);
  return built;
};

/** The string an item renders, which is what a collision *is*. */
const rendered = (c: ReadingCandidate) => `${c.reading}|${c.okurigana ?? ""}`;

/** Every character of the index whose menu at `pos` offers two entries that
 * render alike.
 *
 * The whole menu travels with each collision, and the colliding entries are
 * named by their *position* in it — `conjClassCartouches` answers about a list
 * in that list's own order, and a candidate rebuilt from a second call to
 * `candidateReadings` is a different object that no `indexOf` will find. */
interface Collision {
  char: string;
  candidates: ReadingCandidate[];
  at: number[];
}

function collisions(pos: string): Collision[] {
  const found: Collision[] = [];
  for (const char of Object.keys(kanjidic)) {
    const candidates = menuFor(char, pos);
    const groups = new Map<string, number[]>();
    candidates.forEach((candidate, i) => {
      const key = rendered(candidate);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    for (const at of groups.values()) if (at.length > 1) found.push({ char, candidates, at });
  }
  return found;
}

/** The colliding candidates themselves. */
const pairOf = ({ candidates, at }: Collision) => at.map((i) => candidates[i]);

/** Their cartouches, taken from one call over the menu they came out of. */
const labelsOf = ({ char, candidates, at }: Collision) => {
  const labels = conjClassCartouches(char, candidates);
  return at.map((i) => labels[i]);
};

const VERB_COLLISIONS = collisions("VERB");

describe("the collision population, over the whole shipped index", () => {
  it("is 12,356 characters, of which 158 offer a reading twice", () => {
    // The index the app actually ships and the menu actually reads. Written
    // out so that a re-generated index that moved the population announces
    // itself here rather than silently changing what the menu draws.
    expect(Object.keys(kanjidic).length).toBe(12356);
    expect(new Set(VERB_COLLISIONS.map((c) => c.char)).size).toBe(158);
  });

  it("is 173 pairs, and never a group of three", () => {
    expect(VERB_COLLISIONS.length).toBe(173);
    // So 173 entries stand behind an identical twin — one per group, every
    // group being a pair. A group of three is impossible rather than merely
    // absent: `candidateReadings` keys its de-duplication on
    // reading|okurigana|conjClass, so two survivors that render alike differ
    // in the class, and at most one of them can be the one carrying none.
    expect(VERB_COLLISIONS.map((c) => c.at.length)).toEqual(new Array(173).fill(2));
    expect(VERB_COLLISIONS.reduce((n, c) => n + c.at.length - 1, 0)).toBe(173);
  });

  it("is kun against kun throughout — no on'yomi is ever half of one", () => {
    for (const collision of VERB_COLLISIONS) expect(pairOf(collision).map((c) => c.kind)).toEqual(["kun", "kun"]);
  });

  it("is 161 pairs of a class against no class, and 12 of two classes", () => {
    const named = VERB_COLLISIONS.filter((c) => pairOf(c).every((candidate) => candidate.conjClass !== undefined));
    expect(named.length).toBe(12);
    expect(VERB_COLLISIONS.length - named.length).toBe(161);
    // The shape the design turned on: 延's の+ぶ is one of the twelve, and it
    // is 上二段バ行 against 下二段バ行.
    expect(named.map(({ char }) => char)).toContain("延");
  });

  // 30s, not the runner's 5s default, and the memo on `menuFor` does not reach
  // this one: it sweeps the whole index once per *tag*, and each tag is a cold
  // key. Six full sweeps of 12,356 characters is seconds of real work by
  // design, so the default was a budget this test could meet alone and miss
  // when the suite ran loaded — which is a fact about the runner's default and
  // not about the claim being made. The other sweeps here are VERB and are
  // served from the memo after the first.
  it("stands at 158/173 for every inflecting tag, and at 5 for the nominal ones", () => {
    // `candidateReadings`'s inflecting arm does not vary with the tag — it
    // asks `kunWordClass`, which divides dotted kun'yomi from undotted ones —
    // so ADJ, PART and ADV see exactly what VERB sees. The nominal tags see a
    // different list (the nominalisations), and three collisions in it.
    //
    // **Three, not two, since 毋 was given its なし.** `verbLexicon.ts` now
    // holds 毋 as ク活用 な, beside the 无 that was already there, so the
    // character offers the same word from two arms exactly as 无 does and lands
    // in this census for the same reason. See the pair test below, which names
    // both, and `POSTPOSE_PREDICATE_NEGATION_LEMMAS` for why the entry exists.
    //
    // **Five, not three, since 罔 and 靡 were given theirs.** The same entry
    // for the same reason — both are negative existentials the app already
    // moves to where kundoku reads them, and each printed as a bare character
    // until it had a paradigm — so each now offers なし twice and joins 无 and
    // 毋 here. The reader's ruling that alignment with the received text
    // decides is what settled them; the measurement is on their entries.
    for (const pos of ["ADJ", "PART", "ADV"]) {
      const at = collisions(pos);
      expect([new Set(at.map((c) => c.char)).size, at.length]).toEqual([158, 173]);
    }
    for (const pos of ["NOUN", "PRON", "PROPN"]) expect(collisions(pos).length).toBe(5);
  }, 30_000);
});

/** The class each member of a pair will actually be inflected by — the
 * candidate's own where it carries one, and `derivedConjClass`'s answer where
 * it does not, which is the same question `chosenConjClass` asks of the pick
 * once it is stored. */
const effective = (char: string, c: ReadingCandidate): ConjClass | undefined =>
  c.conjClass ?? (c.okurigana === undefined ? undefined : derivedConjClass(char, c.reading, c.okurigana));

describe("why the cartouche and not the 連用形", () => {
  it("gives a paradigm to every one of the classless twins", () => {
    // The premise the design had to test: "a candidate with no `conjClass` has
    // no 連用形 to compute". It is false, and the reason is what
    // `classicalVerbKun` is careful about — a candidate carries a class only
    // where its ending can no longer state one, so the candidate carrying none
    // is precisely the one whose modern ending still states it. 引's classless
    // ひ+く reads 四段カ行 off く unaided.
    const classless = VERB_COLLISIONS.flatMap((collision) =>
      pairOf(collision)
        .filter((c) => c.conjClass === undefined)
        .map((c) => effective(collision.char, c)),
    );
    expect(classless.length).toBe(161);
    expect(classless.filter((c) => c === undefined).length).toBe(0);
    expect(effective("引", menuFor("引").find((c) => rendered(c) === "ひ|く" && !c.conjClass)!)).toBe("yodan-ka");
  });

  it("reaches the three hardest of them by the lexicon, and reaches them right", () => {
    // わす, らむ, しむ — endings with a stem mora inside them, which
    // `classicalConjClass` declines to read at all. `derivedConjClass`'s second
    // route matches the lexicon's own modern spelling instead, and the three
    // classless twins come back 四段 against their converted 下二段 partners.
    for (const [char, reading, okurigana, expected] of [
      ["合", "あ", "わす", "yodan-sa"],
      ["赤", "あか", "らむ", "yodan-ma"],
      ["卑", "いや", "しむ", "yodan-ma"],
    ] as const) {
      expect(derivedConjClass(char, reading, okurigana)).toBe(expected);
      expect(menuFor(char).filter((c) => rendered(c) === `${reading}|${okurigana}`).length).toBe(2);
    }
  });

  it("separates all 173 pairs by class and only 165 by 連用形", () => {
    let byClass = 0;
    let byRenyou = 0;
    for (const collision of VERB_COLLISIONS) {
      const pair = pairOf(collision);
      const classes = pair.map((c) => effective(collision.char, c));
      if (classes.every((c) => c !== undefined) && classes[0] !== classes[1]) byClass++;
      const renyou = pair.map((c, i) => {
        const cls = classes[i];
        return cls === undefined ? undefined : c.reading + conjugate(cls, "renyou");
      });
      if (renyou.every((r) => r !== undefined) && renyou[0] !== renyou[1]) byRenyou++;
    }
    expect(byClass).toBe(173);
    expect(byRenyou).toBe(165);
  });

  it("cannot separate 四段 from 上二段 of one row by 連用形, ever", () => {
    // The eight the class separates and the 連用形 does not, and they are a
    // fact about the paradigms rather than about this data: ラ四 and ラ上二 both
    // give り, so 足's た+る is たり whichever word it is. An index keyed on the
    // 連用形 cannot tell them apart however honestly it is built.
    expect(conjugate("yodan-ra", "renyou")).toBe(conjugate("kami-nidan-ra", "renyou"));
    expect(conjugate("yodan-ka", "renyou")).toBe(conjugate("kami-nidan-ka", "renyou"));
    const shared = VERB_COLLISIONS.filter((collision) => {
      const pair = pairOf(collision);
      const classes = pair.map((c) => effective(collision.char, c));
      if (classes.some((c) => c === undefined) || classes[0] === classes[1]) return false;
      const renyou = pair.map((c, i) => c.reading + conjugate(classes[i]!, "renyou"));
      return renyou[0] === renyou[1];
    });
    expect(shared.map(({ char }) => char).sort()).toEqual(["亡", "兦", "墜", "満", "滅", "滿", "足", "飽"]);
  });

  it("leaves one entry in the whole index with no paradigm at all", () => {
    // 黑's くろ+し, under a nominal tag: the nominalisation arm's unclassed 終止形
    // standing beside the ク活用 one the adjective rule built, and no route
    // reads ク off a bare し. The one place `CONJ_CLASS_UNKNOWN_CARTOUCHE` is
    // reached — and the one place a reader can be told, before picking, that
    // this entry is the one the app will not inflect.
    const stuck: string[] = [];
    for (const pos of ["VERB", "ADJ", "NOUN", "PRON", "PROPN", "PART", "ADV"])
      for (const collision of collisions(pos))
        for (const candidate of pairOf(collision))
          if (effective(collision.char, candidate) === undefined)
            stuck.push(`${pos} ${collision.char} ${rendered(candidate)}`);
    expect([...new Set(stuck.map((s) => s.split(" ").slice(1).join(" ")))]).toEqual(["黑 くろ|し"]);
  });
});

describe("the cartouches themselves", () => {
  // 30s, not the runner's 5s default: this sweeps all 12,356 characters of the
  // shipped index and is seconds of real work by design. It passes alone and
  // times out only when the whole suite runs beside it, which is a fact about
  // the runner's default and not about the claim being made.
  it("labels both members of every pair and nothing else", () => {
    let labelled = 0;
    for (const char of Object.keys(kanjidic)) {
      const candidates = menuFor(char);
      const labels = conjClassCartouches(char, candidates);
      expect(labels.length).toBe(candidates.length);
      const counts = new Map<string, number>();
      for (const c of candidates) counts.set(rendered(c), (counts.get(rendered(c)) ?? 0) + 1);
      candidates.forEach((c, i) => {
        // Both members, or neither: an unlabelled entry beside a labelled one
        // would read as the ordinary reading against an oddity, where the
        // truth is that they are two words.
        if ((counts.get(rendered(c)) ?? 0) > 1) {
          expect(labels[i]).toBeTypeOf("string");
          labelled++;
        } else expect(labels[i]).toBeUndefined();
      });
    }
    expect(labelled).toBe(346); // 173 pairs, both members of each
  }, 30_000);

  it("prints the paradigm the pick will actually be inflected by", () => {
    // The whole of what makes the label honest: it is `derivedConjClass`'s
    // answer, and `chosenConjClass` asks that same function of the stored pick.
    for (const collision of VERB_COLLISIONS) {
      const labels = labelsOf(collision);
      pairOf(collision).forEach((candidate, i) => {
        const cls = effective(collision.char, candidate);
        expect(labels[i]).toBe(cls === undefined ? CONJ_CLASS_UNKNOWN_CARTOUCHE : CONJ_CLASS_CARTOUCHE[cls]);
      });
    }
  });

  it("tells 立ツ from 立ツ, and 破ル from 破ル", () => {
    // The two the de-duplication key's own doc names — 四段タ行 against
    // 下二段タ行, and 四段ラ行 against 下二段ラ行.
    for (const [char, string, expected] of [
      ["立", "た|つ", ["タ四", "タ下二"]],
      ["破", "やぶ|る", ["ラ四", "ラ下二"]],
    ] as const) {
      const candidates = menuFor(char);
      const labels = conjClassCartouches(char, candidates);
      const found = candidates.flatMap((c, i) => (rendered(c) === string ? [labels[i]!] : []));
      expect(found.sort()).toEqual([...expected].sort());
    }
  });

  it("draws no two entries of a pair alike, at any tag but one", () => {
    // Every collision in the index, inflecting tags and nominal ones alike.
    const alike: string[] = [];
    for (const pos of ["VERB", "ADJ", "NOUN", "PRON", "PROPN", "PART", "ADV"])
      for (const collision of collisions(pos)) {
        const labels = labelsOf(collision);
        if (labels[0] === labels[1])
          alike.push(`${collision.char} ${rendered(pairOf(collision)[0])} ${labels[0]}`);
      }
    // 无's な+し is the same word twice — ク活用 なし from both arms — so both
    // entries are labelled ク. The cartouche never invents a distinction it
    // cannot find; what is left there is a duplicate in the list, which is
    // `candidateReadings`'s business.
    //
    // **毋 joins it, and for the same reason 无 is here.** Its ク活用 な entry
    // is new — the character is a negative existential this app now moves to
    // where kundoku reads it, and with no entry it printed bare (知る莫 for
    // 知る莫し) — so it too offers なし from two arms and labels both ク.
    //
    // **罔 and 靡 join them on the same entry**, added when the reader ruled
    // that alignment with the received text decides rather than the linguistic
    // grounds they had been held out on. Four characters, one word, one label:
    // the list is a duplicate and the cartouche is right to draw it twice.
    expect([...new Set(alike)]).toEqual(["无 な|し ク", "毋 な|し ク", "罔 な|し ク", "靡 な|し ク"]);
  });

  it("marks the one entry with no paradigm 未詳, and only that one", () => {
    let unknown = 0;
    for (const pos of ["VERB", "ADJ", "NOUN", "PRON", "PROPN", "PART", "ADV"])
      for (const char of new Set(collisions(pos).map((c) => c.char)))
        unknown += conjClassCartouches(char, menuFor(char, pos)).filter(
          (l) => l === CONJ_CLASS_UNKNOWN_CARTOUCHE,
        ).length;
    // 黑's くろ+し, once under each of the three nominal tags.
    expect(unknown).toBe(3);
    const nominal = menuFor("黑", "NOUN");
    expect(
      nominal
        .map((c, i) => [rendered(c), conjClassCartouches("黑", nominal)[i]] as const)
        .filter(([, label]) => label !== undefined),
    ).toEqual([
      ["くろ|し", "ク"],
      ["くろ|し", CONJ_CLASS_UNKNOWN_CARTOUCHE],
    ]);
  });

  it("is silent for a reread candidate and for a bare reading", () => {
    // Neither is a word with a paradigm: いまだ…ズ is a construction, and an
    // on'yomi or a compound member's bare stem carries no ending to read one
    // off. Both are held out by `conjClassCartouches` before it asks.
    const reread: ReadingCandidate = { kind: "reread", reading: "いまだ…", okurigana: "ず" };
    const twin: ReadingCandidate = { kind: "reread", reading: "いまだ…", okurigana: "ず" };
    expect(conjClassCartouches("未", [reread, twin])).toEqual([undefined, undefined]);
    const on: ReadingCandidate = { kind: "on", reading: "りつ" };
    expect(conjClassCartouches("立", [on, { ...on }])).toEqual([undefined, undefined]);
  });
});

describe("the label table", () => {
  it("names every paradigm the app can inflect", () => {
    // A `Record<ConjClass, string>` is the guarantee — the compiler asks for a
    // new class's abbreviation at the same time it asks for its paradigm — and
    // this is the count behind it.
    //
    // **42 since ザ行変格活用 was added** for 投ず/封ず/案ず, which had been
    // standing on `shimo-nidan-za` (混ず) — exact in five cells and writing
    // 投**ぜ**て where the received text has 投**じ**て. The two rows are
    // genuinely different words' paradigms and both are kept.
    expect(Object.keys(CONJ_CLASS_CARTOUCHE).length).toBe(42);
    for (const label of Object.values(CONJ_CLASS_CARTOUCHE)) expect(label.length).toBeGreaterThan(0);
  });

  it("writes the row then the grade, for every 四段 and 二段 paradigm", () => {
    // The class name in this file carries the row as its last segment, so the
    // label can be checked against it character by character rather than
    // against a second list that could drift from it.
    const ROW_KANA: Record<string, string> = {
      a: "ア", ka: "カ", ga: "ガ", sa: "サ", za: "ザ", ta: "タ", da: "ダ",
      na: "ナ", ha: "ハ", ba: "バ", ma: "マ", ya: "ヤ", ra: "ラ", wa: "ワ",
    };
    const GRADES: Record<string, string> = { yodan: "四", "kami-nidan": "上二", "shimo-nidan": "下二" };
    let checked = 0;
    for (const [name, label] of Object.entries(CONJ_CLASS_CARTOUCHE)) {
      const match = /^(yodan|kami-nidan|shimo-nidan)-([a-z]+)$/.exec(name);
      if (!match) continue;
      expect(label).toBe(ROW_KANA[match[2]] + GRADES[match[1]]);
      checked++;
    }
    expect(checked).toBe(32);
  });

  it("writes no row for the ten classes that record none", () => {
    // 上一 has no row in this app's model (the consonant never surfaces in the
    // suffix); the five 変格 name their own inside the abbreviation, and
    // writing it twice would be a stutter; the four adjectival paradigms are
    // not 行-organised at all.
    //
    // ザ変 joins the 変格 group and names its row the same way サ変 does — the
    // ザ of ザ変 *is* the row, so `ザ変` and not `ザ変ザ`. That it shares a row
    // name with `shimo-nidan-za`'s ザ下二 is the point of keeping both labels
    // distinct: a reader choosing between them in a menu is choosing between
    // 混ぜて and 投じて.
    expect(
      Object.fromEntries(
        Object.entries(CONJ_CLASS_CARTOUCHE).filter(([name]) => !/^(yodan|kami-nidan|shimo-nidan)-/.test(name)),
      ),
    ).toEqual({
      "kami-ichidan": "上一",
      "ka-hen": "カ変",
      "sa-hen": "サ変",
      "za-hen": "ザ変",
      "na-hen": "ナ変",
      "ra-hen": "ラ変",
      "ku-keiyoushi": "ク",
      "shiku-keiyoushi": "シク",
      "nari-keiyoudoushi": "ナリ",
      "tari-keiyoudoushi": "タリ",
    });
  });

  it("is at most three characters, so the longest entry it can make is eight cells", () => {
    // A label of n characters is n + 2 cells of run (`.token-menu-conj`) — one
    // of them the cell that puts its glyphs on the grid — and an entry of k
    // characters carrying one comes to k + n + 3. The longest labels are the
    // 二段 families' three characters; 立ツ with タ下二 is 8 cells, 160px at
    // the default scale.
    const longest = Math.max(...Object.values(CONJ_CLASS_CARTOUCHE).map((l) => [...l].length));
    expect(longest).toBe(3);
    expect([...CONJ_CLASS_UNKNOWN_CARTOUCHE].length).toBe(2);
  });

  it("gives no two paradigms the same label", () => {
    const labels = Object.values(CONJ_CLASS_CARTOUCHE);
    expect(new Set(labels).size).toBe(labels.length);
    // And none of them collides with the 未詳 an unreachable paradigm prints,
    // which would make a real class read as an abstention.
    expect(labels).not.toContain(CONJ_CLASS_UNKNOWN_CARTOUCHE);
  });
});

// ---------------------------------------------------------------------------
// **The box the cartouche stands in, said as arithmetic.**
//
// The menu is `writing-mode: vertical-rl`, so the inline axis runs *down* a
// column and the block axis runs across it: a label's `height` is its extent
// along the run, its `width` is what it takes of the lane, `margin: Y 0` is at
// the two ends of the run and `padding: 0 X` is inside the two long rules.
// Every figure below is on that axis convention, and getting it backwards is
// the one way to read this file wrong.
//
// There is no browser in this suite, so nothing here can be measured. What it
// can be is *computed off the stylesheet the browser reads* — the declarations
// are parsed out of kunten.css rather than copied here, so an agreement is an
// agreement with the page and not with a stale transcription of it. The model
// is the same one `panelMargins.test.ts` uses on the two panels' margins, cut
// down to the vocabulary these two rules are written in.
//
// Two rounds are checked here, on the two axes, and they must not be confused
// with each other. *Across the lane* (the round of 2026-09-06): the frame is
// 25px in a 30px lane and it is centred there by the layout rather than by a
// figure — `line-height: 1` and `align-self: center`, both confirmed by the
// reader and neither touched since. *Along the run* (this round): the label's
// glyphs stand on the same cells the reading's glyphs do, which cost it a cell
// of its own, and the entry is still a whole number of cells long.
//
// What is *not* checkable here, and is the reader's: whether the frame reads
// as centred, whether 2.5px of clear beside it is enough air, whether the cell
// of white between a reading and its label reads as belonging rather than
// drifting, and whether the lit pill's longer tail is a nuisance.
// ---------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const kunten = readFileSync(join(SRC, "render", "kunten.css"), "utf-8");

/** The root font size every `rem` in this file resolves against: nothing in
 * the app sets one, so it is the UA's 16. */
const REM = 16;

const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first top-level rule with exactly this selector, optionally
 * the first one whose body contains `contains` — `.token-context-menu` is
 * declared three times over (a positioned box, a dark-theme override, and the
 * grid), and only one of them is the grid. */
function ruleBody(css: string, selector: string, contains?: string): string {
  const text = withoutComments(css);
  const head = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`, "gm");
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    const open = text.indexOf("{", m.index);
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        const body = text.slice(open + 1, i);
        if (contains === undefined || body.includes(contains)) return body;
        break;
      }
    }
  }
  throw new Error(`no rule for ${selector}${contains ? ` containing ${contains}` : ""}`);
}

/** Every declaration in a rule body, last one winning, as the cascade has it. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--?[a-z-]+|[a-z-]+)\s*:\s*([^;]+);/g)) {
    out.set(name.trim(), value.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** One CSS length in pixels, in the vocabulary these rules use: `calc()`,
 * `var(--menu-cell)`, and lengths in `px`, `em` and `rem`.
 *
 * `em` is the caller's to supply, and which font size it is differs by
 * property: on `font-size` it is the *parent's*, on everything else the
 * element's own. That distinction is the whole of why the heading's note
 * divides its figures into cells and em, so the model keeps it explicit rather
 * than guessing. */
function lengthOf(expr: string, { em, cell = 0 }: { em: number; cell?: number }): number {
  const text = expr
    .replace(/var\(--menu-cell\)/g, `(${cell})`)
    .replace(/\bcalc\(/g, "(")
    .replace(/(\d*\.?\d+)rem\b/g, (_, n: string) => `(${Number(n) * REM})`)
    .replace(/(\d*\.?\d+)em\b/g, (_, n: string) => `(${Number(n) * em})`)
    .replace(/(\d*\.?\d+)px\b/g, "$1");
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${text});`)() as number;
  if (!Number.isFinite(value)) throw new Error(`${expr} came to ${value}`);
  return value;
}

/** A two-value shorthand as this menu writes it, in the axes the writing mode
 * gives it: `margin: Y 0` and `padding: 0 X` are along the run and across the
 * lane respectively, never top-and-bottom and left-and-right. */
function shorthand(value: string): { along: string; across: string } {
  const parts: string[] = [];
  let depth = 0;
  let word = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (word) parts.push(word);
      word = "";
    } else word += ch;
  }
  if (word) parts.push(word);
  if (parts.length !== 2) throw new Error(`not a two-value shorthand: ${value}`);
  return { along: parts[0], across: parts[1] };
}

const MENU = declarations(ruleBody(kunten, ".token-context-menu", "--menu-cell"));
const HEADING = declarations(ruleBody(kunten, ".token-menu-heading"));
const CONJ = declarations(ruleBody(kunten, ".token-menu-conj"));
const ENTRY = declarations(ruleBody(kunten, ".token-menu-item", "padding"));
const CARRIER = declarations(ruleBody(kunten, ".token-menu-item:has(> .token-menu-conj)"));

/** The cell: one character's advance down a column, which is the menu's own
 * font size (`--menu-cell: 1em`, registered as a length so it inherits as the
 * 20px and not as the factor). */
const CELL = lengthOf(MENU.get("font-size")!, { em: REM });
/** The lane: `line-height x font-size` is the line box's *across* size under
 * vertical-rl, so the declared 1.5 is 1.5 cells. */
const LANE = Number(MENU.get("line-height")) * CELL;
/** The glyph — the cartouche's own em, and the unit its non-font figures are
 * written in. Its `font-size` resolves against the entry, which is set at the
 * cell. */
const GLYPH = lengthOf(CONJ.get("font-size")!, { em: CELL });
/** The rule of the 匡郭, off the `border` shorthand's first term. */
const RULE = lengthOf(CONJ.get("border")!.split(" ")[0], { em: GLYPH });

/** What the frame takes of the lane: two rules, two 四分 of padding, and the
 * line box round the glyph — which is the em box only because `line-height: 1`
 * says so, the menu's own 1.5 being what would otherwise inherit. */
function acrossTheLane(lineHeight: number): number {
  const pad = lengthOf(shorthand(CONJ.get("padding")!).across, { em: GLYPH, cell: CELL });
  return 2 * RULE + 2 * pad + lineHeight * GLYPH;
}

/** The lit pill's inset along the run — 四分 at each end of the entry, taken
 * off the `::after` that paints it rather than off any box. The rule is a
 * group of two selectors and this is the second of them, which is the one that
 * ends in the brace `ruleBody` looks for. */
const PILL = declarations(ruleBody(kunten, ".token-menu-seg:is(:hover, :focus-visible)::after"));
const PILL_INSET = lengthOf(shorthand(PILL.get("inset")!).along, { em: CELL, cell: CELL });

/** A type scale: the cell one character advances, and the cartouche's own
 * glyph at that cell. Every figure below is computed at two of them, because
 * what the rule claims is an *identity* — the glyph cancels out of both the
 * extent and the phase — and an identity checked at one size is a coincidence
 * checked at one size. */
interface Scale {
  cell: number;
  glyph: number;
}
const DEFAULT_SCALE: Scale = { cell: CELL, glyph: GLYPH };
/** The same menu at 1.5rem rather than 1.25: a 24px cell and a 15.6px glyph,
 * neither of which divides the other into anything convenient. */
const LARGER: Scale = { cell: 24, glyph: lengthOf(CONJ.get("font-size")!, { em: 24 }) };

/** Everything in an entry of `k` characters carrying a label of `n`, in the
 * entry's own coordinates: 0 is the top of its box, which stands on a cell
 * boundary because every entry above it is a whole number of cells.
 *
 * `padding` along the run is nought inside the frame — the indent above the
 * first glyph and the last one's own trailing tracking are all the air there
 * is — so the label's extent is its two margins, its two rules, the indent and
 * `n` tracked characters. `margin` may be overridden to price an arrangement
 * the rule does *not* use; nothing else may.
 */
function entryOf(k: number, n: number, scale: Scale = DEFAULT_SCALE, margin?: number) {
  const { cell, glyph } = scale;
  const pad = lengthOf(shorthand(ENTRY.get("padding")!).along, { em: cell });
  const rule = lengthOf(CONJ.get("border")!.split(" ")[0], { em: glyph });
  const indent = lengthOf(CONJ.get("text-indent")!, { em: glyph, cell });
  const m = margin ?? lengthOf(shorthand(CONJ.get("margin")!).along, { em: glyph, cell });
  /** Where the label's margin box begins — and where the reading's last ink
   * ends, the two being flush (one `textContent` and one appended span, with
   * no text node between them). */
  const boxStart = pad + k * cell;
  const headRule = boxStart + m;
  return {
    margin: m,
    boxStart,
    headRule,
    footRule: headRule + 2 * rule + indent + n * cell,
    /** The label's margin box, which is what the entry pays for it. */
    label: 2 * m + 2 * rule + indent + n * cell,
    extent: 2 * pad + k * cell + 2 * m + 2 * rule + indent + n * cell,
    /** The centre of the reading's `j`th character, 1-based. */
    reading: (j: number) => pad + (j - 1) * cell + cell / 2,
    /** The centre of the label's `j`th character, 1-based. */
    centre: (j: number) => headRule + rule + indent + glyph / 2 + (j - 1) * cell,
  };
}

/** Every label the menu can draw, by its length in characters. */
const LABEL_LENGTHS = [
  ...new Set(
    [...Object.values(CONJ_CLASS_CARTOUCHE), CONJ_CLASS_UNKNOWN_CARTOUCHE].map((l) => [...l].length),
  ),
];

describe("the cartouche in its lane", () => {
  it("is the grid the whole menu is set on: a 20px cell in a 30px lane", () => {
    expect(CELL).toBe(20);
    expect(LANE).toBe(30);
    expect(GLYPH).toBe(13);
  });

  it("comes to 25px across the lane, with 2.5px of clear on each side", () => {
    // `2·1px + 2·(c/4) + g`, which is the heading's figure exactly.
    expect(acrossTheLane(Number(CONJ.get("line-height")))).toBe(25);
    expect((LANE - acrossTheLane(1)) / 2).toBe(2.5);
  });

  it("needs its own `line-height: 1`, and was 1.5px wider than the lane without it", () => {
    // What the reader saw. `line-height: 1.5` on the menu is a number, so it
    // inherits as a factor and applies at this element's own 13px: the line
    // box across the lane was 19.5px where the em box is 13, and the frame
    // 31.5px in a 30px lane — over it before any alignment at all.
    expect(CONJ.get("line-height")).toBe("1");
    expect(acrossTheLane(Number(MENU.get("line-height")))).toBe(31.5);
    expect(acrossTheLane(Number(MENU.get("line-height")))).toBeGreaterThan(LANE);
    // The bound is the lane and it is not negotiable: past it the column
    // pitch moves, and every column in the menu with it.
    expect(acrossTheLane(1)).toBeLessThanOrEqual(LANE);
  });

  it("is centred by the layout and not by a figure", () => {
    // `vertical-align: middle` stood here and did not centre it: it aligns the
    // box's midpoint with the parent's baseline plus half the parent's
    // x-height, some 5px at the entry's 20px against 2.5px of clear a side, so
    // the frame hung outside its own lane and took the line box with it. What
    // centres it now is `align-self: center` in a flex entry — the identical
    // declaration `.token-menu-heading` takes inside `.token-menu-group-lead`,
    // which is why the heading never had this to answer for.
    expect(CONJ.get("align-self")).toBe("center");
    expect(CONJ.has("vertical-align")).toBe(false);
    expect(CARRIER.get("display")).toBe("flex");
    // `row` is the inline axis, which is vertical here: the reading and its
    // label go on standing one after the other down the column.
    expect(CARRIER.get("flex-direction")).toBe("row");
  });

  it("is the heading's construction, save for the one figure the phase moved", () => {
    // Not a resemblance — the same declarations, which is what the rule's own
    // note claims and what nothing but this test would keep true.
    for (const property of [
      "align-self",
      "font-size",
      "line-height",
      "letter-spacing",
      "text-indent",
      "color",
      "border",
      "padding",
    ]) {
      expect([property, CONJ.get(property)]).toEqual([property, HEADING.get(property)]);
    }
    // The margin along the run is the exception, and it differs by exactly
    // 二分 — the 二分 the entry's own leading padding put in front of this box,
    // which is the whole of the phase correction. At either type scale: the
    // difference is a cell term and has no glyph in it.
    for (const scale of [DEFAULT_SCALE, LARGER]) {
      const args = { em: scale.glyph, cell: scale.cell };
      const conj = lengthOf(shorthand(CONJ.get("margin")!).along, args);
      const heading = lengthOf(shorthand(HEADING.get("margin")!).along, args);
      expect(conj - heading).toBeCloseTo(scale.cell / 2, 10);
    }
    // Across the lane the two are still identical, and nought — which is the
    // axis the reader settled a round ago, and the one this round did not
    // touch. `align-self: center` does that work, and an auto or a figure
    // here would be what took it back.
    expect(shorthand(CONJ.get("margin")!).across).toBe(shorthand(HEADING.get("margin")!).across);
    expect(shorthand(CONJ.get("margin")!).across).toBe("0");
  });

  it("stands every character of a labelled entry on a cell, at either type scale", () => {
    // The strong reading of on-the-grid, which is what the reader asked for:
    // not merely a whole number of cells long, but the label's glyphs on the
    // same cell centres the reading's glyphs stand on. The reading's `k`
    // characters are centred on cells 1…k and the label's `n` on cells
    // k+2…k+n+1 — one empty cell between them, which is the cell the label was
    // given and the whole of what the phase cost.
    for (const scale of [DEFAULT_SCALE, LARGER])
      for (const n of LABEL_LENGTHS)
        for (const k of [1, 2, 3, 4, 5]) {
          const e = entryOf(k, n, scale);
          for (let j = 1; j <= k; j++) expect(e.reading(j) / scale.cell).toBeCloseTo(j, 10);
          for (let j = 1; j <= n; j++) expect(e.centre(j) / scale.cell).toBeCloseTo(k + 1 + j, 10);
        }
  });

  it("was half a cell out of phase under the heading's own margin", () => {
    // What the reader looked at and overturned. With `0.5em - 1px` at each end
    // — the heading's figure, which is right for a box that starts at the top
    // of a column — every glyph of the label fell on a half-cell, because the
    // box itself starts 二分 past a boundary.
    const heading = lengthOf(shorthand(HEADING.get("margin")!).along, { em: GLYPH, cell: CELL });
    const was = entryOf(2, 3, DEFAULT_SCALE, heading);
    for (let j = 1; j <= 3; j++) expect(was.centre(j) / CELL).toBeCloseTo(j + 2.5, 10);
    // And it was a cell shorter for it: 立ツ with タ下二 was 7 cells and is 8.
    expect(was.extent).toBe(140);
    expect(entryOf(2, 3).extent).toBe(160);
  });

  it("leaves the entry a whole number of cells long, for every label it draws", () => {
    // `二分 + k cells + (n + 2) cells + 二分 = (k + n + 3) cells`, and the flex
    // does not touch it: the two items sit end to end with the margins the
    // inline flow gave them and there is no white between them to lose.
    for (const scale of [DEFAULT_SCALE, LARGER])
      for (const n of LABEL_LENGTHS)
        for (const k of [1, 2, 3, 4, 5]) {
          const e = entryOf(k, n, scale);
          expect(e.label / scale.cell).toBeCloseTo(n + 2, 10);
          expect(e.extent / scale.cell).toBeCloseTo(k + n + 3, 10);
        }
    // 立ツ with タ下二: 2 + 3 + 3 = 8 cells, 160px at the default scale.
    expect(entryOf(2, 3).extent).toBe(160);
  });

  it("keeps the frame out of the last kana's cell, where the refused arrangement put it", () => {
    // The phase-correct margins are one per cell, so the only symmetric
    // arrangement below this one is a whole cell lower — and it is the one the
    // rule's note priced and refused. It is on the grid, and its head rule
    // stands 4.5px inside the ink of the character it labels.
    const chosen = entryOf(2, 3);
    expect(chosen.headRule - chosen.boxStart).toBe(15.5);
    const refused = entryOf(2, 3, DEFAULT_SCALE, chosen.margin - CELL);
    expect(refused.margin).toBe(-4.5);
    expect(refused.boxStart - refused.headRule).toBe(4.5);
    expect(refused.centre(1) / CELL).toBeCloseTo(3, 10); // on the grid, and still refused
    // Two cells shorter, both ends having moved: which is why there is nothing
    // between the two — the extent goes 6, 8, 10 and never 7.
    expect(chosen.extent - refused.extent).toBe(2 * CELL);
  });

  it("clears the lit pill, which the free arrangement would not have", () => {
    // The third place the label could stand: the head at +15.5 and the foot at
    // −4.5, which is on the grid and costs no run at all, the entry staying
    // the 7 cells it was. The frame sits exactly where it sits now, but the
    // entry ends a cell sooner — so the pill, inset 四分 from the entry's own
    // ends, would stop 0.5px past the frame's foot rule and read as cut off by
    // it. That is the refused collision again with the pill in the kana's
    // place, and it is why the cell was paid for instead.
    expect(PILL_INSET).toBe(CELL / 4);
    const chosen = entryOf(2, 3);
    const free = chosen.extent - CELL; // same frame, one cell less entry
    expect(free - PILL_INSET - chosen.footRule).toBe(0.5);
    // What the pill does under the arrangement chosen, which is the price paid
    // in paint: a tail of 20.5px past the frame's foot rule where it was 10.5.
    expect(chosen.extent - PILL_INSET - chosen.footRule).toBe(20.5);
    const heading = lengthOf(shorthand(HEADING.get("margin")!).along, { em: GLYPH, cell: CELL });
    const was = entryOf(2, 3, DEFAULT_SCALE, heading);
    expect(was.extent - PILL_INSET - was.footRule).toBe(10.5);
  });
});
