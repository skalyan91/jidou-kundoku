import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Sentence, Token, TokenTree } from "../src/parse/types.ts";
import type { ReadingPlan } from "../src/kundoku/types.ts";
import type { ReadingResolver, ResolvedReading } from "../src/reading/types.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi, generateKakikudashiForTree, generateKakikudashiPieces } from "../src/kakikudashi/generator.ts";
import { COPULA, EXISTENCE, CAUSATIVE } from "../src/kakikudashi/bungoConjugation.ts";
import {
  adverbialRenyouTe,
  renyouTeOn,
  renyouTeSuffix,
  setRenyouTe,
  synthesizedRenyouTe,
} from "../src/kakikudashi/renyouTe.ts";

// ---------------------------------------------------------------------------
// The 連用形-て display switch.
//
// **A display option, not a change to the grammar.** The default is
// 連用中止法 — a bare 連用形 linking one clause to the next — and that is the
// reader's own settled decision (see `converbSuffix`'s closing note and
// `tests/coordinationChain.test.ts`). This switch turns on the other printing
// convention, where every such link is written out as a converb. So the first
// thing every block here asserts is that *off* is exactly what the app did
// before the switch existed.
//
// The module holds one flag, so every test that turns it on has to put it
// back — `afterEach` below, rather than each test remembering.
// ---------------------------------------------------------------------------

afterEach(() => setRenyouTe(false));

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);
const run = (s: Sentence) => generateKakikudashi(computeReadingOrder(s, findCompoundSpans(s)), resolve);

/** Both states of one sentence, so an assertion can say what changed and what
 * did not in a single line rather than by turning the switch on and off by
 * hand in every test. */
function bothStates(sentence: Sentence): { off: string; on: string } {
  setRenyouTe(false);
  const off = run(sentence);
  setRenyouTe(true);
  const on = run(sentence);
  setRenyouTe(false);
  return { off, on };
}

describe("the switch itself", () => {
  it("is off to begin with — the default is 連用中止法", () => {
    expect(renyouTeOn()).toBe(false);
  });

  it("writes nothing at all while it is off, whatever it is asked", () => {
    expect(renyouTeSuffix({ form: "renyou", conjClass: "yodan-ha", okurigana: "ひ", converbTe: "", nextToken: undefined })).toBe("");
    expect(synthesizedRenyouTe({ text: CAUSATIVE.renyou!, which: "renyou" }, undefined)).toBe("");
    expect(adverbialRenyouTe({ id: 0, text: "暴", lemma: "暴", pos: "ADV", xpos: "x", dep: "mod", head: 1 }, { conjClass: "nari-keiyoudoushi", okurigana: "に" }, undefined)).toBe("");
  });
});

describe("renyouTeSuffix", () => {
  const next = (lemma: string): Token => ({ id: 9, text: lemma, lemma, pos: "CCONJ", xpos: "x", dep: "cc", head: 9 });

  it("adds て to a bare い-sound 連用形 — the 連用中止法 link the switch is for", () => {
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "yodan-ha", okurigana: "ひ", converbTe: "", nextToken: undefined })).toBe("て");
  });

  it("adds て to a 連用形 of any other verb shape too — え", () => {
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "shimo-nidan-ya", okurigana: "え", converbTe: "", nextToken: undefined })).toBe("て");
  });

  it("gives an adjective して, not て — 貧しくして and 無くして, the 訓読 converb", () => {
    // 〜くて is the modern form; 漢文訓読体 writes 〜くして (貧而樂 → 貧しくして
    // 樂しみ). This app's register is 文語 throughout, and 貧しくて beside 飲みて
    // in one sentence would be two registers in one line. See
    // `NON_VERB_CONNECTIVE`.
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "ku-keiyoushi", okurigana: "く", converbTe: "", nextToken: undefined })).toBe("して");
    expect(renyouTeSuffix({ form: "renyou", conjClass: "shiku-keiyoushi", okurigana: "しく", converbTe: "", nextToken: undefined })).toBe("して");
  });

  it("adds て after a 下二段タ行 連用形 that is itself 立て — 立てて, not 立て", () => {
    // The one case a "does it already end in て?" test would get wrong: the
    // paradigm's own 連用形 ends in て and still wants the connective.
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "shimo-nidan-ta", okurigana: "て", converbTe: "", nextToken: undefined })).toBe("て");
  });

  it("stands down where `converbSuffix` has already written the て — never 參りてて", () => {
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "yodan-ra", okurigana: "り", converbTe: "て", nextToken: undefined })).toBe("");
  });

  it("stands down before a 而, which writes its own connective — never 學びてて", () => {
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "yodan-ba", okurigana: "び", converbTe: "", nextToken: next("而") })).toBe("");
  });

  it("stands down on a 連用形 that already carries its own して — never としてて", () => {
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "tari-keiyoudoushi", okurigana: "として", converbTe: "", nextToken: undefined })).toBe("");
  });

  it("writes して, not て, for a ナリ活用 — に becomes にして", () => {
    setRenyouTe(true);
    expect(renyouTeSuffix({ form: "renyou", conjClass: "nari-keiyoudoushi", okurigana: "に", converbTe: "", nextToken: undefined })).toBe("して");
  });

  it("touches no form but the 連用形", () => {
    setRenyouTe(true);
    for (const form of ["mizen", "shuushi", "rentai", "izen", "meirei"] as const) {
      expect(renyouTeSuffix({ form, conjClass: "yodan-ha", okurigana: "ふ", converbTe: "", nextToken: undefined })).toBe("");
    }
    expect(renyouTeSuffix({ form: undefined, conjClass: undefined, okurigana: "", converbTe: "", nextToken: undefined })).toBe("");
  });
});

describe("synthesizedRenyouTe", () => {
  it("adds て to 使役's しめ, which is a bare 下二段 連用形", () => {
    setRenyouTe(true);
    expect(synthesizedRenyouTe({ text: CAUSATIVE.renyou!, which: "renyou" }, undefined)).toBe("て");
  });

  it("adds nothing to the copula's にして, which is the converb already", () => {
    setRenyouTe(true);
    expect(synthesizedRenyouTe({ text: COPULA.renyou!, which: "renyou" }, undefined)).toBe("");
  });

  it("adds nothing where the form chosen was not the 連用形", () => {
    setRenyouTe(true);
    expect(synthesizedRenyouTe({ text: CAUSATIVE.primary, which: "primary" }, undefined)).toBe("");
  });

  it("reads the slot and not the string — 使役's 未然形 is the same しめ", () => {
    // The defect this shape was chosen to close. しめ is both `CAUSATIVE.mizen`
    // and `CAUSATIVE.renyou` (下二段 coincides there), so the string cannot say
    // which question was answered, and the て this used to write landed in
    // front of the very ず that had asked for the 未然形 — 不使勝食氣 read
    // 食の氣を勝つをしめ**て**ず.
    setRenyouTe(true);
    expect(CAUSATIVE.mizen).toBe(CAUSATIVE.renyou);
    expect(synthesizedRenyouTe({ text: CAUSATIVE.mizen!, which: "mizen" }, undefined)).toBe("");
  });

  it("adds て to EXISTENCE's 連用形, which is spelled like its 終止形", () => {
    // ラ変 is あら/あり/あり/ある/あれ/あれ, so あり alone leaves no trace of the
    // choice and this declined outright while the form was being recovered
    // from the string. With the slot reported it is answerable, and the answer
    // is て: a 而 standing where a chain-medial あり hands on already makes this
    // app write ありて, and the switch is that same request unspelled.
    setRenyouTe(true);
    expect(EXISTENCE.renyou).toBe(EXISTENCE.primary);
    expect(synthesizedRenyouTe({ text: EXISTENCE.renyou!, which: "renyou" }, undefined)).toBe("て");
    expect(synthesizedRenyouTe({ text: EXISTENCE.primary, which: "primary" }, undefined)).toBe("");
  });

  it("stands down before a 而", () => {
    setRenyouTe(true);
    const er: Token = { id: 9, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 9 };
    expect(synthesizedRenyouTe({ text: CAUSATIVE.renyou!, which: "renyou" }, er)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The standing anchors, in both states. The `off` half of each is the
// expectation that already stands elsewhere in this suite, restated here so
// that a change to the switch that leaked into the default would fail *this*
// file rather than only a distant one.
// ---------------------------------------------------------------------------

const fixturesPath = fileURLToPath(new URL("./fixtures/analects-raw-parses.json", import.meta.url));
const rawParses: Record<string, Token[][]> = JSON.parse(readFileSync(fixturesPath, "utf-8"));

/** The stub resolver the Analects anchors are written against — see
 * `kakikudashi-generator.test.ts`, whose expectations these mirror. */
const fakeResolve: ReadingResolver = (token): ResolvedReading => {
  const functionWords: Record<string, string> = { 而: "て", 自: "より", 之: "これ" };
  if (token.lemma in functionWords) {
    return { reading: functionWords[token.lemma], source: "override", spellOutInProse: true, endingComplete: true };
  }
  return { reading: token.text, source: "unresolved" };
};

function planFor(sentence: Sentence): ReadingPlan {
  return computeReadingOrder(sentence);
}

function analects(text: string): { off: string; on: string } {
  const tree: TokenTree = { sentences: rawParses[text].map((tokens) => ({ tokens })), source: "conllu" };
  setRenyouTe(false);
  const off = generateKakikudashiForTree(tree, planFor, fakeResolve);
  setRenyouTe(true);
  const on = generateKakikudashiForTree(tree, planFor, fakeResolve);
  setRenyouTe(false);
  return { off, on };
}

/** The 不亦…乎 in three of these reads 〜ざるや and read 〜ずや until now: the
 * reader removed `boundByBindingParticle`'s lexical carve-out on the 亦
 * (*"Don't carve out 不亦"*), so the 係り結び reaches the frame like any other
 * negation before a や. **A decision, not drift** — and nothing to do with this
 * switch, which is why every `on === off` below is untouched. */
describe("the anchors, in both states", () => {
  it("學而時習之，不亦說乎？ — the 而 writes the て, and writes it exactly once", () => {
    // The anchor the switch must not double: 學 is 連用形 with a 而 standing
    // after it, so the て on the page is 而's own. Unchanged in both states —
    // 學びてて is what a switch that did not stand down before a 而 would give.
    const { off, on } = analects("學而時習之，不亦說乎？");
    expect(off).toBe("學びて時にこれを習ふ、亦說ばしからざるや。");
    expect(on).toBe(off);
  });

  it("子曰：學而時習之。 — the same, inside a quote frame", () => {
    const { off, on } = analects("子曰：學而時習之。");
    expect(off).toBe("子曰はく、學びて時にこれを習ふ。");
    expect(on).toBe(off);
  });

  it("人不知而不慍，不亦君子乎？ — 而 after a negation still writes して once", () => {
    const { off, on } = analects("人不知而不慍，不亦君子乎？");
    expect(off).toBe("人知らずして慍みず、亦君子ならざるや。");
    expect(on).toBe(off);
  });

  it("有朋自遠方來，不亦樂乎？ — nothing in it is a 連用形, so the switch says nothing", () => {
    // The exact reading is pinned in `kakikudashi-generator.test.ts`, which is
    // where this anchor lives; what belongs here is only the switch's own
    // claim about it, and re-pinning the string would make this file fail for
    // reasons that have nothing to do with the switch.
    const { off, on } = analects("有朋自遠方來，不亦樂乎？");
    expect(on).toBe(off);
    expect(on).toContain("來たる有り");
    expect(on).toContain("亦樂しからざるや");
  });

  it("食肉飲酒歌舞。 — the chain's links become converbs, and only under the switch", () => {
    // The anchor the reader's default is pinned to (see
    // `kakikudashi-generator.test.ts`, where the bare form is argued). This is
    // the other convention: the same chain with every link written out.
    //
    // The tail (舞ふ歌ふ) is wrong Japanese in both states, and is pinned that
    // way there for a reason that has nothing to do with this switch — the
    // parser makes 舞 the `comp:obj` of 歌 rather than a fourth conjunct. What
    // this test is about is 食ひ/食ひて and 飲み/飲みて.
    const { off, on } = bothStates({
      tokens: [
        { id: 0, text: "食", lemma: "食", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "肉", lemma: "肉", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "x", dep: "parataxis", head: 0 },
        { id: 3, text: "酒", lemma: "酒", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 4, text: "歌", lemma: "歌", pos: "VERB", xpos: "x", dep: "parataxis", head: 2 },
        { id: 5, text: "舞", lemma: "舞", pos: "VERB", xpos: "x", dep: "comp:obj", head: 4 },
        { id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      ],
    });
    expect(off).toBe("肉を食ひ酒を飲み舞ふ歌ふ");
    expect(on).toBe("肉を食ひて酒を飲みて舞ふ歌ふ");
  });

  it("不飲不食。 — a negated conjunct has a 連用形 now, and the switch reaches it", () => {
    // **The negation the switch could not see.** Classical negation is two
    // paradigms (see `ZU` and `ZARI`), and the app had no 連用形 of either: a
    // non-final negated conjunct fell through to `primary`, which is the same
    // string ず, so the page was right by accident and nothing could depend on
    // the form. `negationEnding`'s 連用中止法 arm gives it one, and this is what
    // that buys — the switch can now write the join out after a negation.
    //
    // **して, not て.** `teOrShite` already answers this question for a *source*
    // 而 and answers して (人不知而不慍 -> 人知らずして慍みず), so the two ways of
    // asking for the same thing agree. See `NEGATION_CONVERB` for the argument
    // and for the one line to change if 〜ざりて is wanted instead.
    const { off, on } = bothStates({
      tokens: [
        { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" },
        { id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "ROOT", head: 1 },
        { id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" },
        { id: 3, text: "食", lemma: "食", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "conj:coord", head: 1 },
        { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 1 },
      ],
    });
    // Off is byte-identical to what the app printed before the 連用形 existed —
    // the ず series' 連用形 *is* ず, so 連用中止法 writes the same characters.
    expect(off).toBe("飲まず食はず");
    expect(on).toBe("飲まずして食はず");
  });

  it("弟子三千人。 -> 弟子三千人あり in both states", () => {
    const { off, on } = bothStates({
      tokens: [
        { id: 0, text: "弟子", lemma: "弟子", pos: "NOUN", xpos: "x", dep: "subj", head: 1 },
        { id: 1, text: "三千", lemma: "三千", pos: "NUM", xpos: "x", dep: "ROOT", head: 1 },
        { id: 2, text: "人", lemma: "人", pos: "NOUN", xpos: "x", dep: "clf", head: 1, morph: "NounType=Clf" },
        { id: 3, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 1 },
      ],
    });
    expect(off).toBe("弟子三千人あり");
    expect(on).toBe(off);
  });

  it("愕然。 -> 愕然たり in both states — a 終止形 is not a 連用形", () => {
    const { off, on } = bothStates({
      tokens: [
        { id: 0, text: "愕", lemma: "愕", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "ROOT", head: 0, morph: "ExtPos=VERB" },
        { id: 1, text: "然", lemma: "然", pos: "PART", xpos: "p,接尾辞,*,*", dep: "unk", head: 0 },
        { id: 2, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
      ],
    });
    expect(off).toBe("愕然たり");
    expect(on).toBe(off);
  });

  it("莞爾而笑。 -> 莞爾として笑ふ in both states — として already carries its して", () => {
    // Two stand-downs at once: the 而 writes nothing (the タリ 連用形 supplied
    // the connective), and the switch writes nothing (the same). 莞爾としてて
    // is what either one failing would give.
    const { off, on } = bothStates({
      tokens: [
        { id: 0, text: "莞", lemma: "莞", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 0, morph: "Degree=Pos|ExtPos=VERB" },
        { id: 1, text: "爾", lemma: "爾", pos: "PART", xpos: "p,接尾辞,*,*", dep: "unk", head: 0 },
        { id: 2, text: "而", lemma: "而", pos: "CCONJ", xpos: "p,助詞,接続,並列", dep: "cc", head: 3 },
        { id: 3, text: "笑", lemma: "笑", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 0 },
        { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 0 },
      ],
    });
    expect(off).toBe("莞爾として笑ふ");
    expect(on).toBe(off);
  });

  it("生而神靈。 -> 生きて神靈なり in both states — the 而 writes the て", () => {
    const { off, on } = bothStates({
      tokens: [
        { id: 0, text: "生", lemma: "生", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 3 },
        { id: 2, text: "神", lemma: "神", pos: "NOUN", xpos: "x", dep: "subj", head: 3 },
        { id: 3, text: "靈", lemma: "靈", pos: "NOUN", xpos: "x", dep: "conj:coord", head: 0 },
        { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      ],
    });
    expect(off).toBe("生きて神靈なり");
    expect(on).toBe(off);
  });

  it("邦有道則知 -> 邦に道有ればすなはち知る in both states — a 已然形 takes ば, never て", () => {
    const { off, on } = bothStates({
      tokens: [
        { id: 0, text: "邦", lemma: "邦", pos: "NOUN", xpos: "n,名詞,固定物,関係", dep: "subj", head: 1, morph: "Case=Loc" },
        { id: 1, text: "有", lemma: "有", pos: "VERB", xpos: "v,動詞,存在,存在", dep: "mod", head: 4 },
        { id: 2, text: "道", lemma: "道", pos: "NOUN", xpos: "n,名詞,可搬,伝達", dep: "comp:obj", head: 1 },
        { id: 3, text: "則", lemma: "則", pos: "ADV", xpos: "v,副詞,時相,緊接", dep: "mod", head: 4, morph: "AdvType=Tim" },
        { id: 4, text: "知", lemma: "知", pos: "VERB", xpos: "v,動詞,行為,動作", dep: "ROOT", head: 4 },
      ],
    });
    expect(off).toBe("邦に道有ればすなはち知る");
    expect(on).toBe(off);
  });
});

// ---------------------------------------------------------------------------
// ナリ活用形容動詞 — the half of the switch the reader named outright.
//
// The paradigm's own 連用形 is the bare に (see `classicalConjugation.ts`),
// where the *synthesized* copula a bare nominal predicate is handed has にして
// (`COPULA.renyou`). That asymmetry is deliberate by default — に is what the
// ナリ table holds and 連用中止法 is what the default writes — and this switch
// is where the two are brought into line.
// ---------------------------------------------------------------------------

describe("ナリ活用形容動詞's 連用形", () => {
  /** 王仁、愛民 — 仁 is a ナリ活用形容動詞 (じんなり) heading the chain, with
   * 愛 coordinated onto it, so 仁 takes the 連用形. */
  const wangRen: Sentence = {
    tokens: [
      { id: 0, text: "王", lemma: "王", pos: "PROPN", xpos: "n,名詞,主体,人", dep: "subj", head: 1 },
      { id: 1, text: "仁", lemma: "仁", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 1, morph: "Degree=Pos" },
      { id: 2, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 1 },
      { id: 3, text: "愛", lemma: "愛", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 1 },
      { id: 4, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,主体,他", dep: "comp:obj", head: 3 },
    ],
  };

  it("王仁、愛民 — 仁に by default, 仁にして under the switch", () => {
    const { off, on } = bothStates(wangRen);
    expect(off).toContain("仁に、");
    expect(on).toContain("仁にして、");
    // …and して once, not twice.
    expect(on).not.toContain("にしてて");
    expect(on).not.toContain("にしてして");
  });

  /** 忽覺咽中暴癢 — 暴 comes back ADV with `Degree=Pos`, and the word is
   * にはかなり: a ナリ活用形容動詞 whose 連用形 the resolver writes directly
   * rather than through the conjugation pipeline (see `adverbialCopulaEnding`
   * in `readingResolver.ts`). The same に, reached by a different route, and
   * the live one in the reader's own 酒蟲. */
  const baoYang: Sentence = {
    tokens: [
      { id: 0, text: "暴", lemma: "暴", pos: "ADV", xpos: "v,副詞,程度,*", dep: "mod", head: 1, morph: "Degree=Pos" },
      { id: 1, text: "癢", lemma: "癢", pos: "VERB", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 1 },
    ],
  };

  it("暴癢 — 暴に by default, 暴にして under the switch", () => {
    const { off, on } = bothStates(baoYang);
    expect(off).toContain("暴に");
    expect(off).not.toContain("暴にして");
    expect(on).toContain("暴にして");
  });

  it("reaches the switch through a *pin* on the same 暴, on the same terms", () => {
    // The reader's own tree pins `Reading=にはか` on this token, and a pick is
    // consulted ahead of every resolver rule — so `adverbialCopulaEnding` never
    // runs and `adverbialRenyouTe` above has no class to act on. The pinned
    // route is `pinnedKeiyoudoushi` naming the paradigm *and the 連用形*, and
    // `pickedRenyouTe` reading both off the `PickedEnding`. Two routes, one
    // answer, in both switch states — which is the whole of what is being
    // asserted here.
    const pinned: Sentence = {
      tokens: baoYang.tokens.map((t) => (t.id === 0 ? { ...t, misc: { Reading: "にはか" } } : t)),
    };
    const bare = bothStates(baoYang);
    const pin = bothStates(pinned);
    expect(pin.off).toBe(bare.off);
    expect(pin.on).toBe(bare.on);
    expect(pin.off).toContain("暴に");
    expect(pin.off).not.toContain("暴なり");
    expect(pin.on).toContain("暴にして");
  });
});

describe("adverbialRenyouTe", () => {
  const adv = (over: Partial<Token> = {}): Token =>
    ({ id: 0, text: "暴", lemma: "暴", pos: "ADV", xpos: "x", dep: "mod", head: 1, ...over });

  it("turns a ナリ活用 adverb's に into にして", () => {
    setRenyouTe(true);
    expect(adverbialRenyouTe(adv(), { conjClass: "nari-keiyoudoushi", okurigana: "に" }, undefined)).toBe("して");
  });

  it("adds nothing to a タリ活用 adverb's として, which carries its own", () => {
    setRenyouTe(true);
    expect(adverbialRenyouTe(adv(), { conjClass: "tari-keiyoudoushi", okurigana: "として" }, undefined)).toBe("");
  });

  it("declines where the ending on the page is not that paradigm's 連用形", () => {
    // The check-your-work guard: an ending this does not recognise is not the
    // thing it describes, and nothing is written.
    setRenyouTe(true);
    expect(adverbialRenyouTe(adv(), { conjClass: "nari-keiyoudoushi", okurigana: "なり" }, undefined)).toBe("");
    expect(adverbialRenyouTe(adv(), { conjClass: "nari-keiyoudoushi", okurigana: undefined }, undefined)).toBe("");
  });

  it("declines for a token that is not tagged ADV — a form question is owed there", () => {
    setRenyouTe(true);
    expect(adverbialRenyouTe(adv({ pos: "VERB" }), { conjClass: "nari-keiyoudoushi", okurigana: "に" }, undefined)).toBe("");
  });

  it("stands down before a 而", () => {
    setRenyouTe(true);
    const er: Token = { id: 1, text: "而", lemma: "而", pos: "CCONJ", xpos: "x", dep: "cc", head: 1 };
    expect(adverbialRenyouTe(adv(), { conjClass: "nari-keiyoudoushi", okurigana: "に" }, er)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// `Piece.renyouTe` — the note in the margin that says where the connective is.
//
// The 書き下し文 panel fades the connective in when the switch writes one (see
// `animateRenyouTeArrival`), and a panel rebuilt wholesale from the tree has
// no earlier node to have compared against. So the generator records the
// offset, and these are the two claims the panel rests on: that the offset
// really does land on the connective, and that it lands on *every* one and on
// nothing else. The second is the one that would fail silently — a connective
// left unmarked simply would not fade, and a marker pointing one character
// early would fade the character in front of it.
// ---------------------------------------------------------------------------

describe("where the connective sits inside a piece", () => {
  const piecesOf = (s: Sentence) => generateKakikudashiPieces(computeReadingOrder(s, findCompoundSpans(s)), resolve);

  /** The chain and the negated pair pinned above, which are what actually earn
   * a connective, together with every Analects parse this file has — the
   * second group earns none under the real resolver and is here as the
   * denominator: the marker must stay away from all of it. */
  const sentences: Sentence[] = [
    {
      tokens: [
        { id: 0, text: "食", lemma: "食", pos: "VERB", xpos: "x", dep: "ROOT", head: 0 },
        { id: 1, text: "肉", lemma: "肉", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 0 },
        { id: 2, text: "飲", lemma: "飲", pos: "VERB", xpos: "x", dep: "parataxis", head: 0 },
        { id: 3, text: "酒", lemma: "酒", pos: "NOUN", xpos: "x", dep: "comp:obj", head: 2 },
        { id: 4, text: "歌", lemma: "歌", pos: "VERB", xpos: "x", dep: "parataxis", head: 2 },
        { id: 5, text: "舞", lemma: "舞", pos: "VERB", xpos: "x", dep: "comp:obj", head: 4 },
        { id: 6, text: "。", lemma: "。", pos: "PUNCT", xpos: "x", dep: "punct", head: 0 },
      ],
    },
    {
      tokens: [
        { id: 0, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 1, morph: "Polarity=Neg" },
        { id: 1, text: "飲", lemma: "飲", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "ROOT", head: 1 },
        { id: 2, text: "不", lemma: "不", pos: "ADV", xpos: "v,副詞,否定,無界", dep: "mod", head: 3, morph: "Polarity=Neg" },
        { id: 3, text: "食", lemma: "食", pos: "VERB", xpos: "v,動詞,行為,飲食", dep: "conj:coord", head: 1 },
        { id: 4, text: "。", lemma: "。", pos: "PUNCT", xpos: "s,記号,句点,*", dep: "punct", head: 1 },
      ],
    },
    ...Object.values(rawParses).flatMap((parses) => parses.map((tokens) => ({ tokens }) as Sentence)),
  ];

  it("marks nothing at all while the switch is off", () => {
    setRenyouTe(false);
    expect(sentences.flatMap(piecesOf).filter((piece) => piece.renyouTe !== undefined)).toEqual([]);
  });

  it("points at the connective itself, character for character", () => {
    setRenyouTe(true);
    const marked = sentences.flatMap(piecesOf).filter((piece) => piece.renyouTe !== undefined);
    // Not vacuous: the two hand-built sentences above earn one each.
    expect(marked.length).toBeGreaterThan(0);
    for (const piece of marked) {
      const { at, text } = piece.renyouTe!;
      expect(piece.text.slice(at, at + text.length)).toBe(text);
      expect(text === "て" || text === "して").toBe(true);
    }
  });

  it("accounts for every character the switch adds, and for no other", () => {
    // The claim the panel actually needs, said as arithmetic: the whole of the
    // difference between the two states is marked connectives. A connective
    // the generator forgot to mark, or a marker on something the switch did
    // not write, breaks this even where the string is right.
    for (const sentence of sentences) {
      setRenyouTe(false);
      const off = run(sentence);
      setRenyouTe(true);
      const on = run(sentence);
      const marked = piecesOf(sentence).reduce((sum, piece) => sum + (piece.renyouTe?.text.length ?? 0), 0);
      expect(marked).toBe(on.length - off.length);
    }
    setRenyouTe(false);
  });
});
