import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { HistoricalKanaIndex } from "../src/reading/historicalKana.ts";
import { compoundMemberCandidates, splitCompoundReading } from "../src/reading/compoundReading.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { findCompoundSpans } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { compoundSpanMembers } from "../src/render/KundokuView.ts";
import { generateKakikudashi } from "../src/kakikudashi/generator.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const historicalKana = JSON.parse(
  readFileSync(join(DATA_DIR, "historical-kana-index.json"), "utf-8"),
) as HistoricalKanaIndex;

describe("splitCompoundReading (real KANJIDIC2 data)", () => {
  it("splits 君子(くんし) into 君=くん (on'yomi), 子=し (on'yomi)", () => {
    expect(splitCompoundReading(["君", "子"], "くんし", kanjidic)).toEqual(["くん", "し"]);
  });

  it("splits 大事(だいじ) into 大=だい, 事=じ (both on'yomi)", () => {
    expect(splitCompoundReading(["大", "事"], "だいじ", kanjidic)).toEqual(["だい", "じ"]);
  });

  it("splits 花火(はなび) into 花=はな (kun'yomi), 火=び (rendaku-voiced kun'yomi ひ)", () => {
    expect(splitCompoundReading(["花", "火"], "はなび", kanjidic)).toEqual(["はな", "び"]);
  });

  it("prefers a longer candidate over a shorter one that would leave the rest unmatched", () => {
    // 君 alone: on くん(2 mora) is correct here; a hypothetical greedy
    // shortest-first matcher could grab a 1-character candidate and fail
    // to complete the second character's match.
    const result = splitCompoundReading(["君", "子"], "くんし", kanjidic);
    expect(result?.[0]).toBe("くん");
  });

  it("returns null when the combined reading can't be assigned across the characters at all", () => {
    expect(splitCompoundReading(["君", "子"], "ぜんぜん", kanjidic)).toBeNull();
  });

  it("returns null for a character absent from KANJIDIC", () => {
    expect(splitCompoundReading(["君", "＃"], "くんし", kanjidic)).toBeNull();
  });
});

describe("compoundMemberCandidates (what one character of a compound may be read as)", () => {
  it("offers a kun'yomi as a bare stem, since a jukugo member carries no okurigana", () => {
    // KANJIDIC writes 番's kun'yomi つが.い; inside 番僧 the reading it could
    // contribute is つが, and an entry offering つがい would be a reading the
    // splitter could not divide back out of the word.
    const readings = compoundMemberCandidates(kanjidic, "番").map((c) => c.reading);
    expect(readings).toContain("つが");
    expect(readings).not.toContain("つがい");
  });

  it("voices a non-initial member's readings, and leaves an initial one alone", () => {
    expect(compoundMemberCandidates(kanjidic, "僧", { nonInitial: true }).map((c) => c.reading)).toEqual(["そう", "ぞう"]);
    expect(compoundMemberCandidates(kanjidic, "僧").map((c) => c.reading)).toEqual(["そう"]);
  });

  it("spells the candidates historically when asked, as the annotation is spelled", () => {
    // 百's ヒャク and ビャク reach the page as ひやく and びやく — the second is
    // the share 三百 shows in the real text — so those are what the menu has
    // to list, or it would not recognise the reading already displayed.
    const readings = compoundMemberCandidates(kanjidic, "百", { nonInitial: true, historicalKana }).map(
      (c) => c.reading,
    );
    expect(readings).toContain("ひやく");
    expect(readings).toContain("びやく");
    expect(readings).not.toContain("ひゃく");
  });
});

describe("splitCompoundReading divides a reading already in historical kana", () => {
  // The furigana menu stores a compound's reading as it is written on the
  // page, which is historical; KANJIDIC's own kana are modern. Without the
  // index the two never meet, and a reading picked by hand could not be put
  // back over the characters it was picked for.
  it("divides 三百's own さんびやく, which does not divide against modern kana alone", () => {
    expect(splitCompoundReading(["三", "百"], "さんびやく", kanjidic)).toBeNull();
    expect(splitCompoundReading(["三", "百"], "さんびやく", kanjidic, historicalKana)).toEqual(["さん", "びやく"]);
  });

  it("divides 豪富's がうふ the same way", () => {
    expect(splitCompoundReading(["豪", "富"], "がうふ", kanjidic)).toBeNull();
    expect(splitCompoundReading(["豪", "富"], "がうふ", kanjidic, historicalKana)).toEqual(["がう", "ふ"]);
  });

  it("still divides a modern JMdict reading, which is what the automatic path hands it", () => {
    expect(splitCompoundReading(["三", "百"], "さんびゃく", kanjidic, historicalKana)).toEqual(["さん", "びゃく"]);
  });
});

describe("every reading the menu offers divides back out of the word", () => {
  // The invariant the two share `compoundMemberCandidates` for: picking a
  // reading over one character composes a whole-word reading, and that word
  // reading has to divide back into the shares it was composed from, or the
  // choice would store correctly and not appear.
  //
  // Swept over the first 4000 two-character JMdict headwords whose reading
  // divides at all: 26,879 substitutions, none undividable and one
  // reassigned (犇犇, where the same character stands twice and ひし|ひしひし
  // and ひしひし|ひし spell the same word). The cases below are this text's
  // own.
  // Each case is the shares the page shows with one of them replaced by a
  // reading its own character's menu offers.
  const cases: [string[], string[]][] = [
    [["番", "僧"], ["つが", "そう"]],
    [["番", "僧"], ["ばん", "ぞう"]],
    [["三", "百"], ["さん", "もも"]],
  ];
  for (const [chars, intended] of cases) {
    it(`recovers ${chars.join("")} read ${intended.join("")}`, () => {
      expect(splitCompoundReading(chars, intended.join(""), kanjidic, historicalKana)).toEqual(intended);
    });
  }
});


// ---------------------------------------------------------------------------
// The sound changes a compound member undergoes against its neighbours.
// ---------------------------------------------------------------------------

describe("連声 and 促音便: a member read as the compound reads it", () => {
  // The reader's case, and the shape of the whole fault: JMdict already says
  // 遠方 is えんぽう, so the *word's* reading was never in doubt — only the
  // assignment of it to the two characters was, because 方's on'yomi are ほう
  // and はう and no table offered the ぽう a member takes after a ん.
  it("divides 遠方 えんぽう, whose 方 is ほう read after a moraic ん", () => {
    expect(splitCompoundReading(["遠", "方"], "えんぽう", kanjidic)).toEqual(["えん", "ぽう"]);
  });

  // The environment is the gate, not the character. Nothing stands before 方
  // in 大方 but an open mora, and おおぽう is a word nobody says — so it does
  // not divide, and the ぽう share cannot be reached from here.
  it("refuses the same ぽう where nothing licenses it", () => {
    expect(splitCompoundReading(["大", "方"], "おおぽう", kanjidic)).toBeNull();
    expect(splitCompoundReading(["大", "方"], "おおかた", kanjidic)).toEqual(["おお", "かた"]);
  });

  it("divides the な行 half of 連声 too — 天皇 てんのう, 觀音 かんのん, 因縁 いんねん", () => {
    expect(splitCompoundReading(["天", "皇"], "てんのう", kanjidic)).toEqual(["てん", "のう"]);
    expect(splitCompoundReading(["観", "音"], "かんのん", kanjidic)).toEqual(["かん", "のん"]);
    expect(splitCompoundReading(["因", "縁"], "いんねん", kanjidic)).toEqual(["いん", "ねん"]);
  });

  // 促音便 is the other slot and the other direction: a member's own coda,
  // conditioned by the onset after it, and taken by an *initial* member as
  // readily as by any other.
  it("divides a geminate first member — 惡化 あっか, 恰幅 かっぷく", () => {
    expect(splitCompoundReading(["悪", "化"], "あっか", kanjidic)).toEqual(["あっ", "か"]);
    expect(splitCompoundReading(["恰", "幅"], "かっぷく", kanjidic)).toEqual(["かっ", "ぷく"]);
  });

  // Both changes at once, on the two characters `LEXICALIZED_NUMERAL_COMPOUND`
  // divides by hand: 一's イツ geminating before さ, and 片's ヘン read ぺん
  // after the sokuon that produces. That table's own note said "there is no
  // sokuon rule in the splitter"; there is one now, and the shares it produces
  // are the shares the table states.
  it("divides 一切 いっさい and 一片 いっぺん, which needed both changes", () => {
    expect(splitCompoundReading(["一", "切"], "いっさい", kanjidic)).toEqual(["いっ", "さい"]);
    expect(splitCompoundReading(["一", "片"], "いっぺん", kanjidic)).toEqual(["いっ", "ぺん"]);
  });

  // The two negatives that keep the coda rule honest. 発音 has a real つ that
  // is not a sokuon (nothing voiceless follows it), and 抜群's ぐん begins with
  // a voiced onset, against which a sokuon never assimilates — ばっぐん is not
  // a word. Both divided correctly before this change and still do.
  it("does not geminate where the following onset refuses it", () => {
    expect(splitCompoundReading(["発", "音"], "はつおん", kanjidic)).toEqual(["はつ", "おん"]);
    expect(splitCompoundReading(["抜", "群"], "ばつぐん", kanjidic)).toEqual(["ばつ", "ぐん"]);
  });
});

describe("the menu offers a sandhi form exactly where the word licenses it", () => {
  // The invariant `compoundMemberCandidates` exists for, asked of the new
  // forms: the menu knows every share of the word on the page, so it can put
  // the environment to the same enumeration the splitter puts it to — and a
  // reading it offers is one the splitter will divide back out.
  it("offers 方 the ぽう after an ん and withholds it after an open mora", () => {
    const after = (precededBy: string) =>
      compoundMemberCandidates(kanjidic, "方", { nonInitial: true, precededBy }).map((c) => c.reading);
    expect(after("ん")).toContain("ぽう");
    expect(after("た")).not.toContain("ぽう");
    // 連濁 is the positional rule beside it and is unaffected either way.
    expect(after("た")).toContain("ぼう");
  });

  it("offers 悪 the あっ only before a voiceless obstruent", () => {
    const before = (followedBy: string) =>
      compoundMemberCandidates(kanjidic, "悪", { nonFinal: true, followedBy }).map((c) => c.reading);
    expect(before("か")).toContain("あっ");
    expect(before("に")).not.toContain("あっ");
  });

  it("divides back every reading it offers, in the environment it offered it in", () => {
    for (const [chars, shares] of [
      [["遠", "方"], ["えん", "ぽう"]],
      [["悪", "化"], ["あっ", "か"]],
      [["天", "皇"], ["てん", "のう"]],
    ] as [string[], string[]][]) {
      for (const [i, share] of shares.entries()) {
        const offered = compoundMemberCandidates(kanjidic, chars[i], {
          nonInitial: i > 0,
          nonFinal: i < chars.length - 1,
          precededBy: i > 0 ? shares[i - 1].slice(-1) : undefined,
          followedBy: i < chars.length - 1 ? shares[i + 1][0] : undefined,
        }).map((c) => c.reading);
        expect(offered).toContain(share);
      }
      expect(splitCompoundReading(chars, shares.join(""), kanjidic)).toEqual(shares);
    }
  });
});

// ---------------------------------------------------------------------------
// Both panels, on verbatim gold.
// ---------------------------------------------------------------------------

const jmdict = JSON.parse(readFileSync(join(DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict, historicalKana);

/** The 訓読文's cells and furigana for every span of `sentence` and the
 * 書き下し文 the same plan produces — asked in the panels' own call shape,
 * spans first and the plan built on them, so that one measurement cannot be of
 * a different app from the other.
 *
 * `compoundSpanMembers` itself and not a reproduction of it: what it answers is
 * one cell per character, and a copy here that divided the span some other way
 * would measure the copy. `cells` is that division written out — the characters
 * the panel actually draws, in the cells it draws them in — and `ruby` the
 * reading it sets over each. An empty glyph map because no span below carries a
 * kunten mark; where one does, the members hold it and the test names it. */
function panels(block: string): { spans: string[]; cells: string[]; ruby: string[]; prose: string } {
  const sentence = parseConllu(block).sentences[0];
  const spans = findCompoundSpans(sentence, { kanjidic, jmdict });
  const members = spans.map((span) => compoundSpanMembers(span, sentence, new Map(), resolve, jmdict, kanjidic, historicalKana));
  return {
    spans: spans.map((s) => s.text),
    cells: spans.map((span, i) => `${span.text}:${members[i].map((m) => m.text).join("|")}`),
    ruby: spans.map((span, i) => `${span.text}:${members[i].map((m) => m.furigana).join("|")}`),
    prose: generateKakikudashi(computeReadingOrder(sentence, spans), resolve),
  };
}

/** 有朋自遠方來， — KR1h0004_001_par1_12-17#0, verbatim from
 * `lzh_kyoto-sud-test.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`. */
const YOU_HOU = `1\t有\t有\tVERB\tv,動詞,存在,存在\t_\t0\troot\t_\tGloss=have|SpaceAfter=No
2\t朋\t朋\tNOUN\tn,名詞,人,関係\t_\t1\tcomp:obj\t_\tGloss=friend|SpaceAfter=No
3\t自\t自\tADP\tv,前置詞,経由,*\t_\t6\tcomp:obl@lmod\t_\tGloss=from|SpaceAfter=No
4\t遠\t遠\tADJ\tv,動詞,描写,量\tDegree=Pos|VerbForm=Part\t5\tmod\t_\tGloss=distant|SpaceAfter=No
5\t方\t方\tNOUN\tn,名詞,固定物,関係\tCase=Loc\t3\tcomp:obj\t_\tGloss=direction|SpaceAfter=No
6\t來\t來\tVERB\tv,動詞,行為,移動\t_\t1\tparataxis\t_\tGloss=come|SpaceAfter=No
7\t，\t，\tPUNCT\ts,記号,読点,*\t_\t1\tpunct\t_\tSpaceAfter=No`;

/** 衛獻公出奔， — KR1d0052_004_par36_1-5#0, from the train split, verbatim. */
const CHU_HON = `1\t衛\t衞\tPROPN\tn,名詞,主体,国名\tCase=Loc|NameType=Nat\t3\tmod\t_\tGloss=[country-name]|SpaceAfter=No
2\t獻\t獻\tPROPN\tn,名詞,人,その他の人名\tNameType=Prs\t3\tcompound\t_\tGloss=Xian|SpaceAfter=No
3\t公\t公\tNOUN\tn,名詞,人,役割\t_\t4\tsubj\t_\tGloss=duke|SpaceAfter=No
4\t出\t出\tVERB\tv,動詞,行為,移動\t_\t0\troot\t_\tGloss=go-out|SpaceAfter=No
5\t奔\t奔\tVERB\tv,動詞,行為,移動\t_\t4\tflat@vv\t_\tGloss=run|SpaceAfter=No
6\t，\t，\tPUNCT\ts,記号,読点,*\t_\t4\tpunct\t_\tSpaceAfter=No`;

describe("both panels, on the gold sentences the sound changes reach", () => {
  it("有朋自遠方來 writes 遠方 ゑんぱう over the characters and 遠方 in the prose", () => {
    const { spans, ruby, prose } = panels(YOU_HOU);
    expect(spans).toEqual(["遠方"]);
    // ゑん**ぱ**う, where it was ゑん**は**う: the ぱう is 方's はう read after
    // the ん of ゑん, and the page's own historical spelling of the ぽう
    // JMdict's えんぽう puts there. The prose is unchanged — the word was
    // already held together as one span in both panels, which is exactly why
    // a failed division showed on the page rather than nowhere.
    expect(ruby).toEqual(["遠方:ゑん|ぱう"]);
    expect(prose).toBe("朋有り遠方より來る");
  });

  it("衛獻公出奔 keeps its サ変 ending while 出奔 gains its ぽん", () => {
    const { ruby, prose } = panels(CHU_HON);
    // The pair this change had to be measured against rather than guessed at.
    // The ruby is new — しゆつ**ぽ**ん, the whole word's しゅっぽん divided at
    // last, where each character's own on'yomi had been standing in for it —
    // and the す must survive it: `isOnyomiSpan` asks whether a span's shares
    // are on'yomi throughout, and ぽん is not in KANJIDIC2's list for 奔. It
    // is 奔's ホン all the same, read where a sokuon precedes it, and
    // `onyomiThroughout` is what says so for both of the gates that ask.
    // Without that, 96 gold sentences lost an ending they had.
    expect(ruby).toContain("出奔:しゆつ|ぽん");
    expect(prose).toBe("衛の獻公出奔す");
  });
});

/** 一番僧見之、謂其身有異疾。 — from the reader's own 酒蟲 file, verbatim, and
 * the sentence the report was made on. 番僧 is one CoNLL-U row two characters
 * wide, 一 is the row before it, and the lexical-word branch of
 * `findCompoundSpans` fuses the two into a span three characters long across
 * two rows. */
const YI_FAN_SENG = `1\t一\t一\tNUM\tn,数詞,数字,*\t_\t2\tmod\t_\t_
2\t番僧\t番僧\tNOUN\tn,名詞,度量衡,*\t_\t3\tsubj\t_\t_
3\t見\t見\tVERB\tv,動詞,行為,動作\t_\t0\troot\t_\t_
4\t之\t之\tPRON\tn,代名詞,人称,止格\tPerson=3|PronType=Prs\t3\tcomp:obj\t_\t_
5\t、\t、\tPUNCT\ts,記号,読点,*\t_\t3\tpunct\t_\t_
6\t謂\t謂\tVERB\tv,動詞,行為,伝達\t_\t3\tparataxis\t_\t_
7\t其\t其\tPRON\tn,代名詞,人称,起格\tPerson=3|PronType=Prs\t8\tdet\t_\t_
8\t身\t身\tNOUN\tn,名詞,不可譲,身体\t_\t6\tcomp:obj\t_\t_
9\t有\t有\tVERB\tv,動詞,存在,存在\t_\t6\tcomp:obj\t_\t_
10\t異\t異\tVERB\tv,動詞,描写,形質\tDegree=Pos|VerbForm=Part\t11\tmod\t_\t_
11\t疾\t疾\tNOUN\tn,名詞,不可譲,疾病\t_\t9\tcomp:obj\t_\t_
12\t。\t。\tPUNCT\ts,記号,句点,*\t_\t6\tpunct\t_\t_`;

describe("a span is cut into characters, not into the parser's rows", () => {
  it("draws 一番僧 as three cells with a reading each, not two with ばんそう over both", () => {
    const { spans, cells, ruby } = panels(YI_FAN_SENG);
    expect(spans).toContain("一番僧");
    // The report, and the whole of it: 番僧 is one row, and cutting the span by
    // row put both of its characters in one cell under one ばんそう while every
    // other compound on the page had a cell and a reading per character.
    expect(cells).toContain("一番僧:一|番|僧");
    expect(ruby).toContain("一番僧:いち|ばん|そう");
  });

  it("gives every character of a row that row's own id, and the row's mark to its last character", () => {
    const sentence = parseConllu(YI_FAN_SENG).sentences[0];
    const span = findCompoundSpans(sentence, { kanjidic, jmdict }).find((s) => s.text === "一番僧")!;
    const fanSeng = sentence.tokens.find((t) => t.text === "番僧")!;
    const members = compoundSpanMembers(span, sentence, new Map([[fanSeng.id, "㆓"]]), resolve, jmdict, kanjidic, historicalKana);
    // A click anywhere in 番僧 inspects the one token 番僧 is — there is no
    // other id to give either character.
    expect(members.map((m) => `${m.text}=${m.id === fanSeng.id}`)).toEqual(["一=false", "番=true", "僧=true"]);
    // And the one mark that row can carry is written below the last of its
    // characters, which is where the reader leaves the row from (rule 6).
    expect(members.map((m) => m.kunten)).toEqual([undefined, undefined, "㆓"]);
  });
});
