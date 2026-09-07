import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sentence } from "../src/parse/types.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import {
  conjugatedOkurigana,
  conjugationSubject,
  converbSuffix,
  decideConjForm,
  lexiconEntryFor,
  nextMeaningfulToken,
  writesStatedForm,
} from "../src/kakikudashi/conjugationContext.ts";
import { renyouTeSuffix, setRenyouTe } from "../src/kakikudashi/renyouTe.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { furiganaFor } from "../src/render/KundokuView.ts";
import { type KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import { type JmdictIndex } from "../src/reading/jmdictLookup.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** **Built through `parseConllu` on purpose, and every test below goes through
 * it.** The rule is keyed on the deprel, and `conlluParser.ts` rewrites exactly
 * one of them — a lowercase `root` becomes `"ROOT"` and nothing else changes —
 * so a set written in the treebank's own spelling matches nothing at all on the
 * relation carrying 669 of the 727 predicate 以. Hand-built token literals would
 * have hidden that: they are written in whichever spelling the test author
 * believed, which is the same belief the rule was written from. */
function sentence(conllu: string): Sentence {
  const tree = parseConllu(conllu);
  expect(tree.sentences).toHaveLength(1);
  return tree.sentences[0];
}

function prose(s: Sentence): string {
  return generateKakikudashi(computeReadingOrder(s), resolve);
}

/** What the 訓読文 draws beside and over the character — the two slots the
 * reader's ruling divides もつ/てす between. Assembled from the very functions
 * `KundokuView.ts`'s own lexicon branch calls (`furiganaFor`, `lexiconEntryFor`,
 * `decideConjForm`, `conjugatedOkurigana`), so a test that passes here and a
 * panel that disagrees with it are not both possible. */
function kundoku(s: Sentence, id: number): { furigana: string | undefined; okurigana: string | undefined } {
  const plan = computeReadingOrder(s);
  const token = s.tokens.find((t) => t.id === id)!;
  const resolved = resolve(token, s);
  const lex = lexiconEntryFor(token, resolved, s);
  // The two branches the panel itself has, in its own order: a lexicon entry
  // writes the conjugated ending beside the character and takes the furigana
  // from `furiganaFor`, while a curated *split* entry — which is what every
  // other 以 still is — writes its own two halves into the two slots.
  if (lex?.conjClass) {
    const next = nextMeaningfulToken(plan, token.id);
    const form = decideConjForm(conjugationSubject(token, s), next, s, lex.conjClass, resolve);
    // **All three parts the panel concatenates**, in its own order and off the
    // same entry: the paradigm's cell, `converbSuffix`'s て, and the 連用形-て
    // switch's. Asserting only the first would have missed the whole of the
    // reader's 連用形 ruling — 以てし and 以てして differ in nothing but the parts
    // this helper used to drop. `writesStatedForm` is the gate both panels ask,
    // so a cell stated whole takes neither connective here either.
    const conjugated = conjugatedOkurigana(lex, form);
    const stated = writesStatedForm(lex, form);
    const converbTe = stated ? "" : converbSuffix(token, next, lex.conjClass, form);
    const renyouTe = stated
      ? ""
      : renyouTeSuffix({ form, conjClass: lex.conjClass, okurigana: conjugated, converbTe, nextToken: next });
    return {
      furigana: furiganaFor(token, s, resolve, null, kanjidic),
      okurigana: conjugated + converbTe + renyouTe,
    };
  }
  if (resolved.spellOutInProse && resolved.okurigana !== undefined) {
    return { furigana: resolved.reading, okurigana: resolved.okurigana };
  }
  return { furigana: furiganaFor(token, s, resolve, null, kanjidic), okurigana: resolved.okurigana };
}

// 論語 子罕 博我以文，約我以禮 — gold makes 以 the ROOT of each clause, with the
// first verb its `subj` and that verb's own object hanging off it.
const BO_WO_YI_WEN = `1\t博\t博\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t我\t我\tPRON\tn,代名詞,人称,起格\tPerson=1|PronType=Prs\t1\tcomp:obj\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t文\t文\tNOUN\tn,名詞,可搬,成果物\t_\t3\tcomp:obj\t_\t_
`;

// **The two readings are told apart by their ending and not by their
// character.** Until the reader's ruling on the received text the modifier
// wrote もつて in kana and the predicate wrote 以てす, so a test could separate
// them by asking which of the two strings the prose held. Both now keep the
// character (`OverrideEntry.spellOutInProse`, and 以 stands in kanbun.info's own
// 書き下し文 on 217 of the 217 occurrences in its 白文 across the gold passages),
// so the whole of the difference is the てす against the て — which is what the
// ruling was always about, and is what the assertions below now ask.
describe("以 as a predicate reads 以てす, もつ over the character and てす beside it", () => {
  it("reads a ROOT 以 もつ + てす, over the character and beside it", () => {
    // The reader's ruling, verbatim: *"If 以 is a main predicate (not a
    // modifier), it should be read as もつてす, with てす as okurigana."*
    // 博我以文 is 我を博むるに文を以てす.
    //
    // **This is the test that fails if the entry is unreachable.** The gold
    // file writes `root`, `parseConllu` writes `ROOT`, and
    // `PREDICATE_YI_DEPS` has to be written in the second spelling — keyed on
    // the first it matches nothing, silently, and 以 falls back to the
    // `overrides.json` もつて this asserts against.
    const s = sentence(BO_WO_YI_WEN);
    expect(s.tokens[2].dep).toBe("ROOT");
    expect(prose(s)).toContain("以てす");
    expect(kundoku(s, 2)).toEqual({ furigana: "もつ", okurigana: "てす" });
  });

  it("inflects the ending rather than fixing it — 終止形/連用形/未然形/連体形", () => {
    // **The crux of the whole change.** An `overrides.json` okurigana is a
    // fixed spelling and this ending is not fixed: サ変 goes through every form
    // the sentence asks of it. That is why the paradigm is written as a
    // `LexiconEntry` (see `PREDICATE_YI`) — reading もつ, `okuriganaPrefix` て
    // for the invariant half, `sa-hen` for the rest — and not as a third entry
    // in the curated table beside the two that already speak for 以.
    //
    // 不以日月 is 日月を以てせず — the 未然形 the ず in front of it asks for, and
    // the one a frozen てす could never have produced.
    const negated = sentence(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t日\t日\tNOUN\tn,名詞,時,*\t_\t2\tcomp:obj\t_\t_
`);
    expect(prose(negated)).toContain("以てせず");
    expect(kundoku(negated, 1).okurigana).toBe("てせ");

    // 繼之以規矩準繩，以為方員平直 — a non-final conjunct, so the 連用形. It is
    // **以て** and not サ変's 以てし: see the 連用形 test below, which is the
    // reader's second ruling on this word, and `PREDICATE_YI`'s `statedForms`.
    const conjunct = sentence(`1\t繼\t繼\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,直接\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t繩\t繩\tNOUN\tn,名詞,可搬,道具\t_\t3\tcomp:obj\t_\t_
5\t然\t然\tVERB\tv,動詞,描写,態度\t_\t3\tconj:coord\t_\t_
`);
    expect(kundoku(conjunct, 2).okurigana).toBe("て");

    // 以其外之也 — a 也 closing the clause takes the 連体形 before its なり:
    // それこれを外すを以てするなり.
    const nominalized = sentence(`1\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t3\tsubj\t_\t_
3\t外\t外\tVERB\tv,動詞,行為,設置\t_\t1\tcomp:obj\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t也\t也\tPART\tp,助詞,句末,*\t_\t1\tdiscourse@sp\t_\t_
`);
    expect(prose(nominalized)).toContain("以てする");
  });

  it("writes the 連用形 以て, in both panels and in both 連用形-て states", () => {
    // **The reader's second ruling on this word, verbatim:** *"以 in a 連用形
    // context is just もつて, not もつてして."* 以てす is 以て with す on it, and
    // 連用中止法 does not write the す — the て already hands the clause on. So
    // this one cell falls together with the modifier 以て that the same sentence
    // prints beside it, while 終止形/未然形/連体形 keep the サ変 the first ruling
    // gave them (asserted just above).
    //
    // **Two routes wrote もつてして and both are closed here.** The paradigm's
    // 連用形 し is an い-sound, so `converbSuffix` writes a て after it wherever
    // the tree marks the token a converb, and the 連用形-て switch
    // (`renyouTeSuffix`) writes one unconditionally. Measured over the 727
    // admitted tokens in
    // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
    // 61 are 連用形, and with the switch on they printed 以てして **60 times over
    // 36 sentences** (the 61st stands before a 而, which writes its own
    // connective and stood the switch down). All 61 now print 以て.
    //
    // 繼之以規矩準繩，以為方員平直 (禮記 經解) — 以 is the ROOT with a further
    // predicate coordinated onto it, so `isNonFinalCoordinand` puts it in the
    // 連用形: 之を繼ぐに規矩準繩を以て、以て方員平直を為す.
    const conjunct = sentence(`1\t繼\t繼\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,直接\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t繩\t繩\tNOUN\tn,名詞,可搬,道具\t_\t3\tcomp:obj\t_\t_
5\t然\t然\tVERB\tv,動詞,描写,態度\t_\t3\tconj:coord\t_\t_
`);
    expect(prose(conjunct)).toContain("以て");
    expect(prose(conjunct)).not.toContain("以てし");
    expect(kundoku(conjunct, 2).okurigana).toBe("て");

    // **The same token carrying the parser's own `VerbForm=Conv`**, which is
    // `converbSuffix`'s gate and the route a hand-corrected tree takes. None of
    // the 727 admitted gold tokens carries the feature — all 3,400 Conv 以 in
    // the treebank are on `mod`/`comp:obj`, the modifier — so this is the shape
    // the reader's own annotation supplies and the corpus cannot.
    const conv = sentence(`1\t繼\t繼\tVERB\tv,動詞,行為,動作\t_\t3\tsubj\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,直接\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\tVerbForm=Conv\t0\troot\t_\t_
4\t繩\t繩\tNOUN\tn,名詞,可搬,道具\t_\t3\tcomp:obj\t_\t_
5\t然\t然\tVERB\tv,動詞,描写,態度\t_\t3\tconj:coord\t_\t_
`);
    expect(prose(conv)).not.toContain("以てして");
    expect(kundoku(conv, 2).okurigana).toBe("て");

    // **And under the 連用形-て switch**, which is where もつてして was actually
    // being read. The switch is module state in `renyouTe.ts`, so it is put back
    // in a `finally` — a leaked `true` would change every other 連用形 in the
    // suite.
    try {
      setRenyouTe(true);
      expect(prose(conjunct)).toContain("以て");
      expect(prose(conjunct)).not.toContain("以てして");
      expect(kundoku(conjunct, 2).okurigana).toBe("て");
      // The other three cells are untouched by the switch and by this change:
      // 以てす closes, 以てせ takes the ず, 以てする meets the 也.
      const negated = sentence(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t2\tmod\t_\t_
2\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
3\t日\t日\tNOUN\tn,名詞,時,*\t_\t2\tcomp:obj\t_\t_
`);
      expect(prose(negated)).toContain("以てせず");
      expect(kundoku(negated, 1).okurigana).toBe("てせ");
    } finally {
      setRenyouTe(false);
    }
  });

  it("reads a coordinated and a parataxis 以 the same way — they head clauses too", () => {
    // 約之以禮 (禮記) is これを約むるに禮を以てす and 行之以忠 (論語) は
    // これを行ふに忠を以てす. `conj:coord` (25 in the gold) and `parataxis`
    // (16) are a clause coordinated with or set beside another, which is the
    // same claim `ROOT` makes about the 669.
    const coord = sentence(`1\t約\t約\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,直接\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t1\tconj:coord\t_\t_
4\t禮\t禮\tNOUN\tn,名詞,制度,儀礼\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(coord)).toContain("以てす");

    const para = sentence(`1\t行\t行\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\t_
2\t之\t之\tPRON\tn,代名詞,人称,直接\tPerson=3|PronType=Prs\t1\tcomp:obj\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t1\tparataxis\t_\t_
4\t忠\t忠\tNOUN\tn,名詞,描写,態度\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(para)).toContain("以てす");
  });

  it("reads the head of a *quoted* clause the same way — 曰：「以皮冠」", () => {
    // The reader's second ruling: *"yes, it should also have this reading as the
    // head of a speech complement."* A quoted clause's head arrives on
    // `comp:obj` — the quote is the speech verb's object — which is the one
    // relation `PREDICATE_YI_DEPS` cannot admit flat, 423 of its 545 tokens
    // being 所以. So the governor decides it, through the same
    // `isSpeechQuoteComplement` the rest of this file already asks about a
    // speech verb's complement. 受命於君前則進、以皮冠 is 皮冠を以てす.
    const s = sentence(`1\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t：\t：\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\t_
3\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t4\tpunct\t_\t_
4\t以\t以\tVERB\tv,動詞,行為,動作\t_\t1\tcomp:obj\t_\t_
5\t皮\t皮\tNOUN\tn,名詞,可搬,道具\t_\t6\tmod\t_\t_
6\t冠\t冠\tNOUN\tn,名詞,可搬,道具\t_\t4\tcomp:obj\t_\t_
`);
    expect(prose(s)).toContain("以てす");
    expect(kundoku(s, 3)).toEqual({ furigana: "もつ", okurigana: "てす" });
  });

  it("reads it through a *nested* frame too — 秦封君以陶, whose 封 is its subj", () => {
    // The reader's own example. 秦君を封ずるに陶を以てす: 封 hangs off 以 by
    // `subj`, exactly as 博 does in 博我以文 above, which is why no test on the
    // shape of 以's own subtree can separate this from the eleven cases where
    // the annotation has lifted a modifier into the head slot — "以 governs a
    // predicate" refuses this one. See `headsAQuotedClause` for that split.
    const s = sentence(`1\t曰\t曰\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
2\t「\t「\tPUNCT\ts,記号,括弧開,*\t_\t6\tpunct\t_\t_
3\t秦\t秦\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t4\tsubj\t_\t_
4\t封\t封\tVERB\tv,動詞,行為,役割\t_\t6\tsubj\t_\t_
5\t君\t君\tNOUN\tn,名詞,人,役割\t_\t4\tcomp:obj\t_\t_
6\t以\t以\tVERB\tv,動詞,行為,動作\t_\t1\tcomp:obj\t_\t_
7\t陶\t陶\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t6\tcomp:obj\t_\t_
`);
    expect(prose(s)).toContain("以てす");
  });

  it("refuses a speech complement the source does not bracket — 未聞以割烹也", () => {
    // 9 of the 45 `comp:obj`/`comp:pred` 以 under a 伝達 governor carry no
    // opening bracket in their own subtree, and `isSpeechQuoteComplement`
    // refuses every one: without a bracket nothing in the tree distinguishes a
    // quotation from an ordinary object, and this file declines to guess it
    // everywhere else too. Six of the nine read as predicates all the same
    // (教以右手 · 魏許寡人以地 · 翦今楚王資之以地 among them) — the price of not
    // asking this rule to answer a question the corpus has not been punctuated
    // to answer. This test is what would notice if that gate were dropped.
    const s = sentence(`1\t未\t未\tADV\tv,副詞,否定,有界\tPolarity=Neg\t2\tmod\t_\t_
2\t聞\t聞\tVERB\tv,動詞,行為,伝達\t_\t0\troot\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
4\t割\t割\tVERB\tv,動詞,行為,動作\t_\t3\tcomp:obj\t_\t_
5\t也\t也\tPART\tp,助詞,句末,*\t_\t2\tdiscourse@sp\t_\t_
`);
    expect(prose(s)).not.toContain("以てす");
    expect(kundoku(s, 2)).toEqual({ furigana: "もつ", okurigana: "て" });
  });

  it("leaves 所以 alone, on the very relation the quoted clause arrives on", () => {
    // 423 of the 545 `comp:obj` 以 hang off 所 — 所以, ordinarily ゆゑん
    // (不患無位、患所以立 is 立つ所以を患ふ). They are the whole reason the
    // relation could not be admitted flat once the speech complements were, and
    // 所 is not a speech verb, so `headsAQuotedClause` refuses them.
    const s = sentence(`1\t患\t患\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
2\t所\t所\tPART\tp,助詞,接続,体言化\t_\t1\tcomp:obj\t_\t_
3\t以\t以\tADV\tv,副詞,態度,*\t_\t2\tcomp:obj\t_\t_
4\t立\t立\tVERB\tv,動詞,行為,動作\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(s)).not.toContain("以てす");
    expect(kundoku(s, 2)).toEqual({ furigana: "もつ", okurigana: "て" });
  });

  it("leaves the 5,615 modifier 以 on the modifier's own ending — 以て, not 以てす", () => {
    // **The line the ruling itself draws**, and the one measurement that had to
    // come out at nothing. Over
    // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
    // 以 is `mod` **5,615** times (ADV 3,048 + VERB 2,567) — 無以尚之,
    // 不仁者不可以久處約 — and every one of them is the adverbial もつて that
    // `overrides.json` has always written. Rendering the 6,946 gold sentences
    // that hold a 以 both ways moves **722** of them and **729** tokens, which
    // is the predicate population exactly — 695 on the five relations and 34 as
    // the head of a bracketed quote: the count of もつて in the rendered corpus
    // falls 7,193 -> 6,464, one for each, and 以 on `mod` is not among them.
    const s = sentence(`1\t無\t無\tVERB\tv,動詞,存在,存在\tPolarity=Neg\t0\troot\t_\t_
2\t以\t以\tVERB\tv,動詞,行為,動作\t_\t1\tmod\t_\t_
3\t尚\t尚\tVERB\tv,動詞,行為,動作\t_\t2\tcomp:obj\t_\t_
`);
    expect(prose(s)).toContain("以て");
    expect(prose(s)).not.toContain("以てす");
    expect(kundoku(s, 1)).toEqual({ furigana: "もつ", okurigana: "て" });
  });

  it("leaves 以下/以上/以來 alone — 以 there is half of one word", () => {
    // 中人以下 is 中人以下, not 中人下を以てす. 32 of the 727 are this shape (26
    // `ROOT`, 6 `subj`), and the reader has been asked about 以來/以下/以遠
    // separately and has not yet ruled — so they go on reading exactly as they
    // did. See `YI_BOUND_SECOND_MEMBERS`, and note the guard is the gold's own
    // annotation: the second member stands next to 以 and hangs off it.
    const s = sentence(`1\t中\t中\tNOUN\tn,名詞,固定物,関係\t_\t2\tmod\t_\t_
2\t人\t人\tNOUN\tn,名詞,主体,人\t_\t3\tsubj\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t下\t下\tNOUN\tn,名詞,固定物,関係\t_\t3\tcomp:obj\t_\t_
`);
    expect(prose(s)).toContain("以て");
    expect(prose(s)).not.toContain("以てす");
  });

  it("leaves 以 under a modal alone — 可以 is the fused modal, already ruled on", () => {
    // 不可以久處約 is 久しく約に處るべからず with 以 read もつて and placed
    // immediately before the modal's own complement — `isYiOfAuxiliary` in
    // `depClassification.ts`, this app's settled answer for 可以/足以/得以. All
    // **398** of the `unk` (380) and `comp:aux` (18) 以 hang off a modal (可 297,
    // 足 69, 能 9, 欲 9, 有 6, 敢 5, 無 2, 得 1), so the two relations are held
    // out whole rather than by a second test on the governor.
    const s = sentence(`1\t不\t不\tADV\tv,副詞,否定,無界\tPolarity=Neg\t4\tmod\t_\t_
2\t可\t可\tAUX\tv,助動詞,可能,*\t_\t4\tmod\t_\t_
3\t以\t以\tVERB\tv,動詞,行為,動作\t_\t2\tunk\t_\t_
4\t處\t處\tVERB\tv,動詞,行為,態度\t_\t0\troot\t_\t_
`);
    expect(prose(s)).toContain("以て");
    expect(prose(s)).not.toContain("以てす");
  });
});
