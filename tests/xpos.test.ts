import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  XPOS_DERIVATION_FEATURES,
  XPOS_INVENTORY,
  formatXpos,
  isKnownXpos,
  parseXpos,
  syntacticPrefix,
  uposForXpos,
  xposFrequency,
  xposMenuGroups,
  xposMenuPrefixes,
  xposPartOfSpeech,
  xposPrefixes,
  xposSemanticLabel,
  xposesUnder,
  domainsUnder,
  sensesUnder,
  withDomain,
  withPrefix,
  withSense,
} from "../src/parse/xpos.ts";

// ---------------------------------------------------------------------------
// **The treebank's own tagset, and UPOS derived from it.**
//
// `src/parse/xpos-inventory.json` is generated — `scripts/build-xpos-inventory.py`
// reads it off the Kyoto treebank — so almost nothing here asserts a *value*.
// What it asserts is that the file is internally consistent and that the module
// reading it cannot quietly disagree with it, because a generated file's real
// failure mode is not a wrong number but a shape the consumer stopped matching
// after someone changed the generator.
//
// The one place figures are written down is the derivation, and they are
// written down because they are the argument for the whole design: UPOS is
// computed rather than chosen, and that is only honest while the computation is
// a function. See `xpos.ts`'s header for the accuracy table.
// ---------------------------------------------------------------------------

const raw = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "src", "parse", "xpos-inventory.json"), "utf-8"),
) as {
  tokens: number;
  features: string[];
  prefixes: Record<string, { count: number; semantics: [string, string, number][] }>;
  derivation: Record<string, Record<string, string>>;
};

describe("the generated inventory", () => {
  it("is the whole treebank and not a sample of it", () => {
    // The guard against a build run against one split, or against a filtered
    // corpus, which would silently drop rare tags out of the menu. 533,362 is
    // train+dev+test of the adjfix branch.
    expect(raw.tokens).toBeGreaterThan(500_000);
    expect(XPOS_INVENTORY.length).toBeGreaterThan(100);
  });

  it("files every tag under a prefix that is itself in the table", () => {
    for (const xpos of Object.keys(raw.derivation)) {
      const prefix = syntacticPrefix(xpos);
      expect(prefix, xpos).toBeDefined();
      expect(raw.prefixes[prefix!], xpos).toBeDefined();
    }
  });

  it("can derive a UPOS for every tag the menu offers", () => {
    // The two halves of the file have to cover each other: a row the menu can
    // offer but `uposForXpos` cannot answer for would let a reader pick a tag
    // that leaves `token.pos` stale, which is exactly the incoherence the whole
    // derive-don't-choose design exists to prevent.
    for (const xpos of XPOS_INVENTORY) {
      expect(isKnownXpos(xpos), xpos).toBe(true);
      expect(uposForXpos(xpos), xpos).toBeDefined();
    }
  });

  it("answers with no features at all, for every tag", () => {
    // A token the reader has just retagged keeps whatever features its *old*
    // tag carried, and those need not be a combination the new tag was ever
    // seen with. So every tag needs a featureless answer to fall back to —
    // `build-xpos-inventory.py` supplies one where the treebank never wrote
    // the tag bare, and this is what says it did.
    for (const xpos of Object.keys(raw.derivation)) {
      expect(raw.derivation[xpos][""], xpos).toBeDefined();
      expect(uposForXpos(xpos, "Wat=Zzz|VerbForm=Nonesuch"), xpos).toBe(raw.derivation[xpos][""]);
    }
  });

  it("keys the derivation on the two features the module reads, and no others", () => {
    // If the generator's feature list and the module's parser drift apart, every
    // key with a feature in it silently stops matching and the whole table
    // degrades to its featureless column — which would still *work*, and would
    // quietly lose ADV and AUX. Hence a test rather than a comment.
    expect([...XPOS_DERIVATION_FEATURES]).toEqual(["VerbForm", "VerbType"]);
    expect(raw.features).toEqual([...XPOS_DERIVATION_FEATURES]);
    for (const table of Object.values(raw.derivation)) {
      for (const key of Object.keys(table)) {
        if (key === "") continue;
        for (const pair of key.split("|")) {
          expect(XPOS_DERIVATION_FEATURES).toContain(pair.split("=")[0]);
        }
      }
    }
  });
});

describe("reading a tag apart", () => {
  it("takes four fields and refuses anything else", () => {
    expect(parseXpos("v,動詞,行為,動作")).toEqual({
      letter: "v",
      word: "動詞",
      domain: "行為",
      sense: "動作",
    });
    // The shapes an uploaded CoNLL-U actually produces.
    for (const bad of [undefined, "", "_", "v,動詞", "v,動詞,行為", "v,動詞,行為,動作,余"]) {
      expect(parseXpos(bad), String(bad)).toBeUndefined();
    }
  });

  it("round-trips", () => {
    for (const xpos of XPOS_INVENTORY) expect(formatXpos(parseXpos(xpos)!)).toBe(xpos);
  });

  it("drops a * rather than printing it", () => {
    // `*` means the scheme records nothing there. Printing it would read as a
    // value the app had found, which is the opposite of true.
    expect(xposSemanticLabel("v,動詞,行為,動作")).toBe("行為・動作");
    expect(xposSemanticLabel("p,助詞,句末,*")).toBe("句末");
    expect(xposSemanticLabel("p,接尾辞,*,*")).toBeUndefined();
    expect(xposPartOfSpeech("p,接尾辞,*,*")).toBe("接尾辞");
  });
});

describe("UPOS, derived", () => {
  it("reads 描写 as an adjective and 行為 as a verb", () => {
    // The core of the table, and the part that is legible enough to write down.
    // That it *is* legible is some evidence it is a generalisation rather than
    // an overfit to 533,362 tokens.
    expect(uposForXpos("v,動詞,描写,形質")).toBe("ADJ");
    expect(uposForXpos("v,動詞,描写,量")).toBe("ADJ");
    expect(uposForXpos("v,動詞,行為,動作")).toBe("VERB");
    expect(uposForXpos("v,動詞,存在,存在")).toBe("VERB");
    expect(uposForXpos("n,名詞,人,役割")).toBe("NOUN");
    expect(uposForXpos("p,助詞,接続,並列")).toBe("CCONJ");
  });

  it("reads a converb as an adverb, whatever it is a converb of", () => {
    // `VerbForm=Conv` is the 連用 use, and it makes an adverb of any of them —
    // which is the single largest thing the xpos alone cannot say (5,796 ADV
    // hiding under v,動詞,行為,動作 by itself).
    for (const xpos of ["v,動詞,行為,動作", "v,動詞,描写,形質", "v,動詞,存在,存在"]) {
      expect(uposForXpos(xpos, "VerbForm=Conv"), xpos).toBe("ADV");
    }
  });

  it("reads the copular 爲 as an auxiliary, and only with the feature", () => {
    // 其爲人也 and its like. Without `VerbType=Cop` the same tag is a plain
    // existential verb, which is why this cannot be done from the xpos alone.
    expect(uposForXpos("v,動詞,存在,存在", "VerbType=Cop")).toBe("AUX");
    expect(uposForXpos("v,動詞,存在,存在")).toBe("VERB");
    // Order-independent: the key is built in the table's own fixed order.
    expect(uposForXpos("v,動詞,存在,存在", "Degree=Pos|VerbType=Cop")).toBe("AUX");
    expect(uposForXpos("v,動詞,存在,存在", "VerbType=Cop|Degree=Pos")).toBe("AUX");
  });

  it("says nothing about a tag the treebank does not write", () => {
    // An uploaded CoNLL-U may carry a tagset this table knows nothing about,
    // and retagging every token of it would be worse than doing nothing. The
    // caller's contract is "undefined means leave `pos` alone".
    expect(uposForXpos(undefined)).toBeUndefined();
    expect(uposForXpos("_")).toBeUndefined();
    expect(uposForXpos("NN")).toBeUndefined();
    expect(uposForXpos("v,動詞,無い,無い")).toBeUndefined();
    expect(isKnownXpos("v,動詞,無い,無い")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// **Two orders, asserted apart.**
//
// `xposPrefixes` is the corpus's, commonest first, and three things depend on
// its being exactly that: the shading, `withPrefix`'s blind fallback, and
// `XPOS_INVENTORY`'s layout. `xposMenuPrefixes` is the handbook's, and only a
// menu depends on it. They were one function until a reader asked for the menu
// to run in handbook order, and the risk in granting that was never the new
// order but the old one quietly going with it — so both are written down here,
// separately, and the tests below say which fact each one is.
// ---------------------------------------------------------------------------

describe("the frequency order, which is what `commonest` means", () => {
  it("lists the eleven 品詞 commonest first", () => {
    // Written out because `withPrefix`'s last fallback is `xposesUnder(p)[0]`
    // and the shading is a count over the commonest count: both read this list
    // as a claim about the corpus, and a re-sort of it would be a silent
    // change to what "the commonest" means rather than a visible one.
    expect(xposPrefixes().map((prefix) => prefix.split(",")[1])).toEqual([
      "名詞", "動詞", "記号", "助詞", "副詞",
      "代名詞", "前置詞", "数詞", "助動詞", "接尾辞", "感嘆詞",
    ]);
    const counts = xposPrefixes().map((prefix) =>
      xposesUnder(prefix).reduce((n, xpos) => n + xposFrequency(xpos), 0),
    );
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    // 名詞 168,830 of 533,362, and 感嘆詞 131 — the two ends of the list.
    expect(counts[0]).toBe(168830);
    expect(counts.at(-1)).toBe(131);
  });

  it("still hands `withPrefix` the commonest tag when nothing else survives", () => {
    // The fallback this whole separation exists to protect. 人・役割 has no
    // meaning under 動詞, so the repair falls all the way through to
    // `xposesUnder("v,動詞")[0]` — which has to be the *commonest* verb tag
    // and not whatever a handbook would file first.
    expect(withPrefix("n,名詞,人,役割", "v,動詞")).toBe("v,動詞,行為,動作");
    expect(xposFrequency("v,動詞,行為,動作")).toBe(46329);
    for (const prefix of xposPrefixes()) {
      expect(xposFrequency(xposesUnder(prefix)[0]), prefix).toBe(
        Math.max(...xposesUnder(prefix).map((xpos) => xposFrequency(xpos))),
      );
    }
  });
});

describe("the menu order, which is the handbook's", () => {
  it("offers the eleven 品詞 as 全訳漢辞海 lists them", () => {
    // 実詞 {名詞, 代名詞, 動詞, (形容詞), 助動詞, 数量詞} then 虚詞 {副詞,
    // 前置詞, (接続詞), 助詞, 感嘆詞} — ja.wikipedia 「漢文法」§品詞分類, after
    // 三省堂『全訳漢辞海 第四版』and 数研出版『体系漢文』; the 虚詞 run
    // cross-checked against kambun.jp's table after 李佐豊『古代漢語語法学』.
    // The three the handbook names and this tagset has no 品詞 for (形容詞,
    // 接続詞, 量詞) simply drop out; the two it does not name go to the end in
    // frequency order. See `xpos.ts` for the whole argument.
    expect(xposMenuPrefixes().map((prefix) => prefix.split(",")[1])).toEqual([
      "名詞", "代名詞", "動詞", "助動詞", "数詞",
      "副詞", "前置詞", "助詞", "感嘆詞",
      "記号", "接尾辞",
    ]);
  });

  it("is the same eleven, only re-ordered", () => {
    // The one thing that could go wrong silently: a rank table that drops a
    // 品詞 it does not name, or duplicates one it does.
    expect([...xposMenuPrefixes()].sort()).toEqual([...xposPrefixes()].sort());
    expect(new Set(xposMenuPrefixes()).size).toBe(xposPrefixes().length);
  });

  it("keeps what the handbook does not name in the order it already had", () => {
    // 接尾辞 and 記号 are not word classes the tradition files — one is a bound
    // morpheme, the other is punctuation — so nothing is invented for them:
    // they keep their frequency positions relative to each other, 記号 (101,556)
    // above 接尾辞 (364), at the end.
    const unnamed = ["s,記号", "p,接尾辞"];
    const tail = xposMenuPrefixes().slice(-unnamed.length);
    expect([...tail]).toEqual(unnamed);
    expect([...tail]).toEqual(xposPrefixes().filter((prefix) => unnamed.includes(prefix)));
  });

  it("is not the frequency order, and does not disturb it", () => {
    // Both halves matter. The first says the reader's request took effect;
    // the second says it took effect in one place only.
    expect([...xposMenuPrefixes()]).not.toEqual([...xposPrefixes()]);
    expect(xposMenuPrefixes()[0]).toBe("n,名詞");
    expect(xposMenuPrefixes()[1]).toBe("n,代名詞");
    expect(xposPrefixes()[1]).toBe("v,動詞");
    // `XPOS_INVENTORY` is laid out by the frequency order and stays there.
    expect([...XPOS_INVENTORY]).toEqual(
      xposPrefixes().flatMap((prefix) => [...xposesUnder(prefix)]),
    );
  });
});

describe("the menu", () => {
  it("groups by 品詞, in the handbook's order", () => {
    const groups = xposMenuGroups("v,動詞,行為,動作");
    // 名詞 leads either way, but 代名詞 second is the handbook talking: the
    // corpus would put 動詞 there. Headings follow `xposMenuPrefixes`.
    expect(groups[0][0]).toBe("名詞");
    expect(groups[1][0]).toBe("代名詞");
    expect(groups.map(([heading]) => heading)).toEqual(
      xposMenuPrefixes().map((prefix) => prefix.split(",")[1]),
    );
    for (const [, rows] of groups) expect(rows.length).toBeGreaterThan(0);
  });

  it("orders each group by how often the treebank writes the tag", () => {
    for (const prefix of xposPrefixes()) {
      const counts = xposesUnder(prefix).map((xpos) => xposFrequency(xpos));
      expect([...counts].sort((a, b) => b - a), prefix).toEqual(counts);
    }
  });

  it("always offers the tag the token already bears", () => {
    // `uposMenuGroups`' own principle, kept: a menu that cannot show what the
    // token is is a menu the reader cannot read their way out of. Both the
    // unattested-pair case and the unattested-prefix case.
    const strange = "v,動詞,無い,無い";
    expect(xposMenuGroups(strange).find(([heading]) => heading === "動詞")![1]).toContain(strange);

    const alien = "x,文字,甲,乙";
    const groups = xposMenuGroups(alien);
    expect(groups.flatMap(([, rows]) => rows)).toContain(alien);
    expect(groups.at(-1)).toEqual(["文字", [alien]]);
  });

  it("adds no group for a token with no tag at all", () => {
    // `""` and `"_"` are what an uploaded CoNLL-U writes for an empty column,
    // and they are not tags. Offering them a group of their own headed by the
    // empty string is what this catches — see `xposMenuGroups`.
    for (const none of [undefined, "", "_"]) {
      expect(xposMenuGroups(none).length, String(none)).toBe(xposPrefixes().length);
      expect(xposMenuGroups(none).map(([heading]) => heading), String(none)).not.toContain("");
    }
  });
});

describe("the two semantic fields, taken apart", () => {
  it("lists a 品詞's domains and a domain's senses, commonest first", () => {
    // The three menus are short because the tag is a hierarchy: 11 品詞, at
    // most 14 domains, at most 14 senses. That is the whole reason for
    // splitting the pair rather than offering 121 composed rows.
    expect(domainsUnder("v,動詞")).toEqual(["行為", "描写", "存在", "変化"]);
    expect(sensesUnder("v,動詞", "行為")).toContain("動作");
    expect(sensesUnder("v,動詞", "行為")[0]).toBe("動作");
    expect(domainsUnder("n,名詞").length).toBe(14);
    expect(sensesUnder("v,動詞", "行為").length).toBe(14);
    // Every domain and sense the lists give composes a tag the table knows.
    for (const prefix of xposPrefixes()) {
      for (const domain of domainsUnder(prefix)) {
        for (const sense of sensesUnder(prefix, domain)) {
          expect(isKnownXpos(`${prefix},${domain},${sense}`)).toBe(true);
        }
      }
    }
  });

  it("keeps a * that the treebank writes, because a round-trip needs it", () => {
    // `*` is a real value of the field — it means the scheme records nothing
    // there — and a caller that has to write the tag back cannot invent it. It
    // is the *chip* that hides it, not this list.
    expect(domainsUnder("p,接尾辞")).toEqual(["*"]);
    expect(sensesUnder("p,助詞", "句末")).toEqual(["*"]);
  });
});

describe("re-tagging one field, and repairing the ones below it", () => {
  it("keeps semantics that still mean something under the new 品詞", () => {
    // 描写・形質 sits under both n,名詞 and v,動詞, so retagging between them
    // must not silently reset the semantics the reader already chose.
    expect(withPrefix("v,動詞,描写,形質", "n,名詞")).toBe("n,名詞,描写,形質");
    expect(withPrefix("n,名詞,描写,形質", "v,動詞")).toBe("v,動詞,描写,形質");
  });

  it("falls back one level at a time, not straight to the top", () => {
    // 行為 exists under v,動詞 but 飲食 is not a sense of any 名詞 domain, so
    // the domain should survive a change of 品詞 even where the sense cannot.
    // Written as a property rather than a literal because which pairs are
    // shared is the treebank's business and may change under a rebuild.
    for (const prefix of xposPrefixes()) {
      for (const xpos of XPOS_INVENTORY) {
        const moved = withPrefix(xpos, prefix);
        expect(isKnownXpos(moved), `${xpos} -> ${prefix}`).toBe(true);
        expect(syntacticPrefix(moved), `${xpos} -> ${prefix}`).toBe(prefix);
        const before = parseXpos(xpos)!;
        const after = parseXpos(moved)!;
        // The domain is kept whenever the new 品詞 has it at all.
        if (domainsUnder(prefix).includes(before.domain)) {
          expect(after.domain, `${xpos} -> ${prefix}`).toBe(before.domain);
        }
      }
    }
  });

  it("keeps the sense when the new domain has it, and repairs it when not", () => {
    // 描写 and 行為 share no sense under v,動詞, so this one has to repair;
    // the property below is what says it repairs to something real.
    expect(withDomain("v,動詞,行為,動作", "描写")).toBe("v,動詞,描写,形質");
    for (const xpos of XPOS_INVENTORY) {
      const prefix = syntacticPrefix(xpos)!;
      for (const domain of domainsUnder(prefix)) {
        const moved = withDomain(xpos, domain);
        expect(isKnownXpos(moved), `${xpos} -> ${domain}`).toBe(true);
        expect(parseXpos(moved)!.domain, `${xpos} -> ${domain}`).toBe(domain);
      }
    }
  });

  it("changes the sense and nothing else, there being nothing below it", () => {
    expect(withSense("v,動詞,行為,動作", "伝達")).toBe("v,動詞,行為,伝達");
    for (const xpos of XPOS_INVENTORY) {
      const parts = parseXpos(xpos)!;
      const prefix = syntacticPrefix(xpos)!;
      for (const sense of sensesUnder(prefix, parts.domain)) {
        expect(withSense(xpos, sense)).toBe(`${prefix},${parts.domain},${sense}`);
        expect(isKnownXpos(withSense(xpos, sense))).toBe(true);
      }
    }
  });

  it("lets a caller refuse a landing tag, and lands somewhere else", () => {
    // The 記号 case. Its commonest tag is a full stop, so a caller that will
    // not accept a PUNCT result could not offer 記号 at all until the repair
    // itself consulted the filter — see `withPrefix`.
    expect(withPrefix("v,動詞,行為,動作", "s,記号")).toBe("s,記号,句点,*");
    expect(uposForXpos("s,記号,句点,*")).toBe("PUNCT");

    const notPunct = (xpos: string) => uposForXpos(xpos) !== "PUNCT";
    const landed = withPrefix("v,動詞,行為,動作", "s,記号", notPunct);
    expect(landed).toBe("s,記号,一般,*");
    expect(uposForXpos(landed)).toBe("SYM");

    // The filter is consulted at every step of the repair, not only the last:
    // a kept pair and a kept domain are both candidates and both refusable.
    for (const prefix of xposPrefixes()) {
      for (const xpos of XPOS_INVENTORY) {
        const out = withPrefix(xpos, prefix, notPunct);
        if (xposesUnder(prefix).some(notPunct)) {
          expect(notPunct(out), `${xpos} -> ${prefix}`).toBe(true);
        }
        expect(isKnownXpos(out), `${xpos} -> ${prefix}`).toBe(true);
      }
    }
  });

  it("accepts everything when the caller states no policy", () => {
    // The default has to leave every existing caller exactly as it was.
    for (const xpos of XPOS_INVENTORY) {
      for (const prefix of xposPrefixes()) {
        expect(withPrefix(xpos, prefix)).toBe(withPrefix(xpos, prefix, () => true));
      }
    }
  });

  it("always yields a tag a UPOS can be derived from", () => {
    // The whole point of repairing downward: a chip must not be able to leave
    // the token holding a tag `uposForXpos` cannot answer for, because then
    // `pos` would silently keep its old value and the two would disagree.
    for (const xpos of [undefined, "", "_", "junk", ...XPOS_INVENTORY]) {
      for (const prefix of xposPrefixes()) {
        expect(uposForXpos(withPrefix(xpos, prefix)), `${xpos} -> ${prefix}`).toBeDefined();
      }
    }
  });
});
