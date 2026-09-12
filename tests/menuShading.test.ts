import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  opacityForLikelihood,
  xposDomainPrior,
  xposPosterior,
  xposPrefixPrior,
  xposPrior,
  deprelPrior,
  DEPREL_INVENTORY,
  rootDemotionLabel,
} from "../src/render/tokenInspector.ts";
import {
  XPOS_INVENTORY,
  domainsUnder,
  sensesUnder,
  xposFrequency,
  xposPrefixes,
  xposesUnder,
} from "../src/parse/xpos.ts";

/** The floor `opacityForLikelihood` never goes below — kept here as a
 * literal rather than imported, so that lowering it in the source has to be
 * a deliberate change to these expectations too. It is a legibility
 * decision made by looking at the menu in both themes (see the constant's
 * own doc), and the point of these tests is that nothing quietly erodes it. */
const FLOOR = 0.46;

describe("opacityForLikelihood", () => {
  it("draws a certainty solid", () => {
    expect(opacityForLikelihood(1)).toBe(1);
  });

  it("never draws anything below the legibility floor", () => {
    for (const p of [0, 1e-12, 1e-3, -1, Number.NaN]) {
      expect(opacityForLikelihood(p)).toBe(FLOOR);
    }
  });

  it("stays inside [floor, 1] across the whole range", () => {
    for (let e = 0; e >= -12; e -= 0.25) {
      const opacity = opacityForLikelihood(10 ** e);
      expect(opacity).toBeGreaterThanOrEqual(FLOOR);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });

  it("rises with likelihood", () => {
    const probabilities = [1e-4, 1e-3, 0.005, 0.02, 0.1, 0.3, 0.7, 1];
    const opacities = probabilities.map(opacityForLikelihood);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeGreaterThanOrEqual(opacities[i - 1]);
    }
    // …and not merely by a hair: the range that matters has to be spread
    // out, or the shading says nothing. A linear map would have put every
    // one of the first five within 0.05 of the floor.
    expect(opacities.at(-1)! - opacities[0]).toBeGreaterThan(0.5);
  });

  it("puts the two arcs of 負郭田三百畝、輒半種黍 visibly apart", () => {
    // The parser's own numbers, measured live: the relation it likes best
    // for 三百→田 (an arc it barely wants at all, 0.022 in total) against
    // the one it likes best for 黍→種 (0.997). Both menus are shaded from
    // the same distribution, so the difference between the arcs shows up as
    // the difference between their best options.
    const sanbyakuBest = opacityForLikelihood(0.0131);
    const shoBest = opacityForLikelihood(0.985);
    expect(sanbyakuBest).toBeCloseTo(0.661, 3);
    expect(shoBest).toBeCloseTo(0.999, 3);
    expect(shoBest - sanbyakuBest).toBeGreaterThan(0.3);
  });

  it("shades a genuinely ambiguous tag as a gradient", () => {
    // 半 out of the morphologizer: VERB .786, ADV .204, NOUN .0076, AUX
    // .0023 — four options a reader might actually weigh, and they must not
    // collapse onto one another or onto the floor.
    const [verb, adv, noun, aux] = [0.786, 0.204, 0.00757, 0.00235].map(opacityForLikelihood);
    expect(verb).toBeCloseTo(0.981, 3);
    expect(adv).toBeCloseTo(0.876, 3);
    expect(noun).toBeCloseTo(0.618, 3);
    expect(aux).toBeCloseTo(0.527, 3);
    for (const [lighter, darker] of [
      [adv, verb],
      [noun, adv],
      [aux, noun],
    ]) {
      expect(darker - lighter).toBeGreaterThan(0.05);
    }
  });

  it("gives a value the source cannot answer for the same floor as a vanishing one", () => {
    // A tag the distribution has no key for arrives absent and the caller
    // passes 0. That is a probability, not a gap — and it must land where
    // 1e-9 lands, not above it. It used to be ADJ, DET and X, which were not
    // in the morphologizer's label set; it is now a tag the treebank has
    // never written, which `xposFrequency` counts at 0.
    expect(opacityForLikelihood(0)).toBe(opacityForLikelihood(1e-9));
    expect(xposPrior("v,動詞,行為,どこにもない")).toBe(0);
  });
});

/** **The 品詞 menu's shading, which is no longer a model's opinion.**
 *
 * Nothing in this pipeline predicts an xpos distribution — the wheel's tagger
 * emits a tag rather than a scored inventory, and `posScores`, the pipe that
 * used to shade this menu, can only speak about the fifteen UPOS. So the
 * number changed its source: it is the treebank's own frequency for each tag,
 * over the commonest tag in the treebank. `xposPrior` in tokenInspector.ts is
 * where that is argued and where the alternatives (mapping `posScores` through
 * `uposForXpos`; leaving the menu unshaded) are refused.
 *
 * What these check is that the substitution is *well-shaped* — a number in
 * [0, 1], monotone in the corpus count, spread across the range rather than
 * heaped at one end — because that is what makes it usable by the same
 * `opacityForLikelihood` the model's probabilities go through. Whether a
 * frequency prior is the *right* thing to shade with is a judgement, not an
 * assertion, and it is made in that function's doc.
 *
 * Figures are the shipped `src/parse/xpos-inventory.json`: 533 362 tokens, 121
 * tags, the commonest being `v,動詞,行為,動作` at 46 329. */
describe("xposPrior", () => {
  it("is a probability, over the whole inventory", () => {
    for (const xpos of XPOS_INVENTORY) {
      const prior = xposPrior(xpos);
      expect(prior, xpos).toBeGreaterThan(0);
      expect(prior, xpos).toBeLessThanOrEqual(1);
    }
    expect(XPOS_INVENTORY).toHaveLength(121);
  });

  it("draws the treebank's commonest tag solid", () => {
    // The point of dividing by the commonest tag rather than by the token
    // count. `v,動詞,行為,動作` is 46 329 of 533 362 tokens — 8.7% — so a
    // corpus-normalised prior would top out at 0.809 and leave the menu with
    // no solid entry anywhere in it, which reads as a model unsure of
    // everything rather than as a frequency table.
    expect(xposFrequency("v,動詞,行為,動作")).toBe(46329);
    expect(xposPrior("v,動詞,行為,動作")).toBe(1);
    expect(opacityForLikelihood(xposPrior("v,動詞,行為,動作"))).toBe(1);
    expect(opacityForLikelihood(46329 / 533362)).toBeCloseTo(0.809, 3);
  });

  it("orders the rows exactly as the corpus does", () => {
    // The property that makes the shading readable as one thing: opacity is
    // monotone in the count, so a darker row is a commoner row and never
    // anything else. Checked pairwise down the whole inventory rather than on
    // examples.
    const sorted = [...XPOS_INVENTORY].sort((a, b) => xposFrequency(b) - xposFrequency(a));
    for (let i = 1; i < sorted.length; i++) {
      expect(xposPrior(sorted[i - 1]), sorted[i]).toBeGreaterThanOrEqual(xposPrior(sorted[i]));
      expect(
        opacityForLikelihood(xposPrior(sorted[i - 1])),
        sorted[i],
      ).toBeGreaterThanOrEqual(opacityForLikelihood(xposPrior(sorted[i])));
    }
  });

  it("puts the 名詞 group's own extremes visibly apart", () => {
    // The place the shading has to earn: 名詞 spreads over 40 tags, which is
    // where
    // an unshaded menu leaves a reader with nothing to start from. 人・役割 is
    // 22 494 and 外観・人 is 10, and they must not come out looking alike.
    const common = opacityForLikelihood(xposPrior("n,名詞,人,役割"));
    const rare = opacityForLikelihood(xposPrior("n,名詞,外観,人"));
    expect(xposFrequency("n,名詞,人,役割")).toBe(22494);
    expect(xposFrequency("n,名詞,外観,人")).toBe(10);
    expect(common).toBeCloseTo(0.944, 3);
    expect(rare).toBe(FLOOR);
    expect(common - rare).toBeGreaterThan(0.4);
  });

  it("leaves only the genuinely vanishing rows at the floor", () => {
    // The other half of "spread rather than heaped". `MENU_FAINT_BELOW` is a
    // thousandth, so a row falls to the floor when the treebank writes it
    // fewer than 46.3 times — six of the 121 do (down to 名詞〖思考〗 at 6).
    // Against the token count it would have been 27, better than a fifth of
    // the menu drawn as "never".
    const atFloor = XPOS_INVENTORY.filter((xpos) => opacityForLikelihood(xposPrior(xpos)) === FLOOR);
    expect(atFloor).toHaveLength(6);
    for (const xpos of atFloor) expect(xposFrequency(xpos), xpos).toBeLessThan(46.4);
    const againstCorpus = XPOS_INVENTORY.filter(
      (xpos) => opacityForLikelihood(xposFrequency(xpos) / 533362) === FLOOR,
    );
    expect(againstCorpus).toHaveLength(27);
  });

  it("gives a tag the treebank has never written the floor", () => {
    // The token's own tag, where a CoNLL-U upload or the tagger's own four
    // field heads have composed something the corpus does not attest.
    // `offeredUnder` appends it so the reader can see what they have; the
    // floor is what it deserves, being a tag no annotator has ever written.
    for (const unattested of ["v,文字,行為,動作", "n,名詞,思考,存在", "", "_"]) {
      expect(xposPrior(unattested), unattested).toBe(0);
      expect(opacityForLikelihood(xposPrior(unattested)), unattested).toBe(FLOOR);
    }
  });
});

/** **The same shading one and two levels up**, for the menus whose rows are
 * 品詞 and domains rather than whole tags.
 *
 * The chip split in three and took the menu with it: one menu per level of the
 * tag. Three vocabularies, and the shading has to speak all three — a sense
 * row is a whole tag in context and takes `xposPrior`, a domain row is a
 * (prefix, domain) and takes `xposDomainPrior`, a 品詞 row is a prefix and
 * takes this. Each is the same quantity summed over the rows below it and put
 * over the commonest thing of its own kind.
 *
 * Everything `xposPrior`'s own block says about *what the number is* holds
 * unchanged and is not restated: a corpus prior, unconditioned on the token,
 * standing where a model's probability used to. What is checked here is that
 * the sum is well-shaped over eleven rows the way the other is over 121. */
describe("xposPrefixPrior", () => {
  const PREFIXES = xposPrefixes();

  it("is a probability, over all eleven 品詞", () => {
    expect(PREFIXES).toHaveLength(11);
    for (const prefix of PREFIXES) {
      const prior = xposPrefixPrior(prefix);
      expect(prior, prefix).toBeGreaterThan(0);
      expect(prior, prefix).toBeLessThanOrEqual(1);
    }
    // Nothing at all for a 品詞 the treebank does not have — 文字 is one of
    // the tagger's twelve and heads no attested tag, and a token wearing it
    // gets its own entry in the menu. The floor is right for it.
    expect(xposPrefixPrior("v,文字")).toBe(0);
    expect(opacityForLikelihood(xposPrefixPrior("v,文字"))).toBe(FLOOR);
  });

  it("draws the commonest 品詞 solid and spreads the rest", () => {
    // 名詞 is 168 830 of the treebank's 533 362 tokens — 31.7% — so it is the
    // denominator and comes out solid, and 動詞's 153 696 all but ties it.
    // The far end is 感嘆詞 at 131 occurrences, which is the one row of the
    // eleven that lands on the floor.
    expect(xposPrefixPrior("n,名詞")).toBe(1);
    expect(opacityForLikelihood(xposPrefixPrior("n,名詞"))).toBe(1);
    expect(opacityForLikelihood(xposPrefixPrior("v,動詞"))).toBeCloseTo(0.993, 3);
    expect(opacityForLikelihood(xposPrefixPrior("p,感嘆詞"))).toBe(FLOOR);
    const atFloor = PREFIXES.filter((p) => opacityForLikelihood(xposPrefixPrior(p)) === FLOOR);
    expect(atFloor).toEqual(["p,感嘆詞"]);
  });

  it("orders the eleven exactly as the corpus does", () => {
    // The same monotonicity the tag-level shading has, and for the same
    // reason: a darker row is a commoner 品詞 and never anything else. It is
    // also the order the menu itself is in (`xposPrefixes` is commonest
    // first), so position and weight say one thing rather than two.
    for (let i = 1; i < PREFIXES.length; i++) {
      expect(xposPrefixPrior(PREFIXES[i - 1]), PREFIXES[i]).toBeGreaterThanOrEqual(
        xposPrefixPrior(PREFIXES[i]),
      );
    }
  });

  it("sums its rows, and so shades 記号 by mass the menu will not give you", () => {
    // The one wrinkle, asserted rather than left in prose. A prefix's prior is
    // the sum of its rows' counts — checked here against the rows themselves,
    // so the two definitions cannot drift — and for 記号 five of those six
    // rows are the marks `UNEDITABLE_UPOS` hides. So 記号 is drawn at 0.960 on
    // the strength of 101 556 occurrences, while the one domain it will let a
    // reader reach, 一般, has 1 358.
    //
    // The alternative, summing only the offered rows, would put 記号 at 0.623
    // — and was rejected because it makes the number answer a different
    // question from the row it is drawn on: the row says 記号, and how usual
    // 記号 is in Literary Chinese is a fact about 記号 rather than about what
    // this menu will let a reader do with it.
    for (const prefix of PREFIXES) {
      const summed = xposesUnder(prefix).reduce((n, xpos) => n + xposFrequency(xpos), 0);
      expect(xposPrefixPrior(prefix), prefix).toBeCloseTo(summed / 168830, 12);
    }
    expect(xposesUnder("s,記号").reduce((n, x) => n + xposFrequency(x), 0)).toBe(101556);
    expect(xposFrequency("s,記号,一般,*")).toBe(1358);
    expect(opacityForLikelihood(xposPrefixPrior("s,記号"))).toBeCloseTo(0.960, 3);
    expect(opacityForLikelihood(1358 / 168830)).toBeCloseTo(0.623, 3);
  });
});

/** **And the middle level**, for the menu whose rows are the domains of one
 * 品詞.
 *
 * The same quantity again, gathered one level lower: how often the treebank
 * writes anything under this 品詞 and this domain, over how often it writes the
 * commonest (品詞, domain) pair there is. That pair is 動詞・行為 at 111 912 —
 * a fifth of the whole corpus in one branch of one 品詞 — which is why the
 * denominator is worth stating: a domain menu's rows are measured against the
 * biggest branch in the treebank and not against the biggest branch in their
 * own menu.
 *
 * **Normalised globally rather than within the menu**, as the other two levels
 * are, and this is the level where that choice bites. Within-menu
 * normalisation would put a solid row at the head of every domain menu,
 * including the menus of a 品詞 the treebank barely writes, and so would say
 * "this is the usual answer" where the honest thing to say is "none of these
 * is usual". The cost is a menu that can come out grey throughout, which is
 * what being rare looks like. */
describe("xposDomainPrior", () => {
  const PAIRS = xposPrefixes().flatMap((prefix) =>
    domainsUnder(prefix).map((domain) => [prefix, domain] as const),
  );

  it("is a probability, over all 52 (品詞, domain) pairs the treebank has", () => {
    expect(PAIRS).toHaveLength(52);
    for (const [prefix, domain] of PAIRS) {
      const prior = xposDomainPrior(prefix, domain);
      expect(prior, `${prefix} ${domain}`).toBeGreaterThan(0);
      expect(prior, `${prefix} ${domain}`).toBeLessThanOrEqual(1);
    }
    // Nothing at all for a pair the treebank does not have — the token's own,
    // where an upload or the tagger's composition has invented one. The floor
    // is right for it: it is a domain no annotator has ever written.
    expect(xposDomainPrior("n,名詞", "行為だったもの")).toBe(0);
    expect(xposDomainPrior("v,文字", "行為")).toBe(0);
    expect(opacityForLikelihood(xposDomainPrior("n,名詞", "存在"))).toBe(FLOOR);
  });

  it("draws the treebank's commonest branch solid", () => {
    // 動詞・行為 is 111 912 tokens — the fourteen senses of doing, which is
    // what a Literary Chinese sentence is mostly made of. 名詞・人 is second
    // at 65 342, and the two are visibly apart rather than tied, which is the
    // difference between this and a within-menu normalisation.
    expect(xposDomainPrior("v,動詞", "行為")).toBe(1);
    expect(opacityForLikelihood(xposDomainPrior("v,動詞", "行為"))).toBe(1);
    expect(opacityForLikelihood(xposDomainPrior("n,名詞", "人"))).toBeCloseTo(0.958, 3);
    expect(opacityForLikelihood(xposDomainPrior("n,名詞", "外観"))).toBe(FLOOR);
  });

  it("sums the senses under it, which is what makes it a level and not a tag", () => {
    // A domain row stands for every tag beneath it, so its number has to be
    // their sum — otherwise 行為 would be shaded by whichever of its fourteen
    // senses happened to be commonest and would sit level with 描写, whose
    // four come to a quarter as much.
    for (const [prefix, domain] of PAIRS) {
      const summed = sensesUnder(prefix, domain).reduce(
        (n, sense) => n + xposFrequency(`${prefix},${domain},${sense}`),
        0,
      );
      expect(xposDomainPrior(prefix, domain), `${prefix} ${domain}`).toBeCloseTo(summed / 111912, 12);
    }
    expect(sensesUnder("v,動詞", "行為")).toHaveLength(14);
    // 描写 against 行為 is the case that makes the point: four senses against
    // fourteen, 26 880 tokens against 111 912, so summing puts them a quarter
    // apart where taking each domain's commonest sense would have put them
    // level (9 711 against 46 329 is the same quarter, by coincidence of this
    // pair, but 存在 has one sense and would then have outranked 描写).
    expect(xposDomainPrior("v,動詞", "描写")).toBeCloseTo(26880 / 111912, 12);
    expect(xposDomainPrior("v,動詞", "存在")).toBeLessThan(xposDomainPrior("v,動詞", "描写"));
  });

  it("orders one 品詞's domains exactly as the corpus does", () => {
    // The same monotonicity the other two levels have, checked down 名詞's
    // fourteen — the longest domain menu there is, and the one where an
    // ordering that disagreed with the shading would cost a reader the most.
    const domains = domainsUnder("n,名詞");
    expect(domains).toHaveLength(14);
    for (let i = 1; i < domains.length; i++) {
      expect(
        xposDomainPrior("n,名詞", domains[i - 1]),
        `${domains[i - 1]} / ${domains[i]}`,
      ).toBeGreaterThanOrEqual(xposDomainPrior("n,名詞", domains[i]));
    }
    expect(domains[0]).toBe("人");
  });

  it("leaves a rare 品詞's domains grey, which is what being rare looks like", () => {
    // The cost of normalising globally, stated as a figure rather than as a
    // worry. 助動詞 is 4 727 tokens over four domains of about 1 200 each, so
    // its whole menu sits between the floor and 0.72 — no solid row anywhere
    // in it. That is the honest rendering: none of those four is a usual tag
    // in Literary Chinese, and a menu that drew one of them solid would be
    // saying otherwise.
    const aux = domainsUnder("v,助動詞").map((d) => opacityForLikelihood(xposDomainPrior("v,助動詞", d)));
    expect(aux).toHaveLength(4);
    expect(aux[0]).toBeCloseTo(0.716, 3); // 可能, 2 949
    expect(Math.max(...aux)).toBeLessThan(0.75);
    // And its rarest, 受動 at 97 occurrences, is on the floor — inside a menu
    // of four, which is the shape a reader should be able to read as "these
    // are all uncommon, and one of them is very".
    expect(Math.min(...aux)).toBe(FLOOR);
  });
});

/** **The posterior that now shades the three category menus, and the prior it
 * falls back to.**
 *
 * The menus used to be shaded by the treebank's frequencies alone, because
 * nothing in the pipeline predicted an xpos distribution. Something does now:
 * `xposScores` in pyodideClient.ts asks the tagger pipe for its whole softmax,
 * whose label set *is* the treebank's 121-tag inventory, so no marginalising
 * out of a joint morphological analysis is needed — the distribution is over
 * exactly the things the menus are made of. `xposPosterior` in
 * tokenInspector.ts turns one of those distributions into a weight per menu
 * row, and this is where that arithmetic is checked.
 *
 * **Only the arithmetic.** The pipe itself is Pyodide/WASM and there is no
 * harness in this repo that can run it; the distributions below are written by
 * hand. That is deliberate rather than a shortfall in the testing: the part
 * that decides what a reader sees is pure, and the part that cannot be run
 * here is a `runPythonAsync` whose failure mode is caught and degrades to the
 * prior. What has *not* been verified anywhere is that the worker returns
 * anything at all, which is why the caller treats null, a malformed answer and
 * a thrown error alike.
 *
 * The tags used are real ones from `src/parse/xpos-inventory.json`; the
 * probabilities on them are invented. */
describe("xposPosterior", () => {
  const verb = "v,動詞,行為,動作";

  /** A distribution over five real tags, three of them under 動詞 and two
   * under 名詞, with 行為 split across two senses. Small enough to do the
   * marginals by hand, which is the point: every expectation below is a sum
   * that can be checked by reading this object. */
  const dist = {
    "v,動詞,行為,動作": 0.5,
    "v,動詞,行為,伝達": 0.2,
    "v,動詞,描写,形質": 0.1,
    "n,名詞,人,役割": 0.15,
    "n,名詞,人,名": 0.05,
  };

  it("marginalises a 品詞 row over every tag under that prefix", () => {
    // 動詞 takes 0.5 + 0.2 + 0.1 = 0.8 and 名詞 takes 0.15 + 0.05 = 0.2, and
    // the menu is then normalised by its own largest — so 動詞 is solid and
    // 名詞 is a quarter of it. Normalising within the menu is what makes the
    // dimming *differential*: what a reader is doing with an open menu is
    // choosing between the rows in it.
    const weights = xposPosterior("pos", ["v,動詞", "n,名詞"], dist, verb)!;
    expect(weights.get("v,動詞")).toBeCloseTo(1, 12);
    expect(weights.get("n,名詞")).toBeCloseTo(0.25, 12);
  });

  it("marginalises a domain row within this token's own 品詞, and not across the tagset", () => {
    // 行為 is 0.7 and 描写 is 0.1 *under 動詞*. The 名詞 mass is not in either,
    // and must not be: this menu offers 動詞's domains, so a row that counted
    // nouns would be answering a question the row does not ask.
    const weights = xposPosterior("domain", ["行為", "描写"], dist, verb)!;
    expect(weights.get("行為")).toBeCloseTo(1, 12);
    expect(weights.get("描写")).toBeCloseTo(1 / 7, 12);
  });

  it("gives a sense row its own tag's probability, conditioned on both fields above", () => {
    // The bottom level, where a row names a whole tag. 動作 is 0.5 and 伝達
    // 0.2, both under 動詞・行為; 形質 is under a different domain and is not
    // in this menu at all.
    const weights = xposPosterior("sense", ["動作", "伝達"], dist, verb)!;
    expect(weights.get("動作")).toBeCloseTo(1, 12);
    expect(weights.get("伝達")).toBeCloseTo(0.4, 12);
    expect(weights.has("形質")).toBe(false);
  });

  it("answers about the rows it was given, and puts a row with no mass at zero", () => {
    // A menu row the distribution says nothing about is a probability of zero
    // and not a gap — which is exactly where `opacityForLikelihood` puts the
    // floor, and the same treatment a relation the parser has ruled out gets.
    const weights = xposPosterior("sense", ["動作", "伝達", "交流"], dist, verb)!;
    expect(weights.get("交流")).toBe(0);
    expect(opacityForLikelihood(weights.get("交流")!)).toBe(FLOOR);
    expect([...weights.keys()]).toEqual(["動作", "伝達", "交流"]);
  });

  it("normalises each menu by its own best, so every menu has a solid row", () => {
    // The property, over all three levels: the largest weight in a menu is
    // always 1. It is what separates this from the corpus prior, which is
    // normalised against the whole treebank and can leave a rare 品詞's menu
    // grey throughout (see the 助動詞 case above). Both are right about
    // different questions — "how usual is this tag" against "which of these
    // rows does the model want here" — and the menus are now asking the
    // second.
    for (const [kind, rows] of [
      ["pos", ["v,動詞", "n,名詞"]],
      ["domain", ["行為", "描写"]],
      ["sense", ["動作", "伝達"]],
    ] as const) {
      const weights = xposPosterior(kind, rows, dist, verb)!;
      expect(Math.max(...weights.values()), kind).toBe(1);
    }
  });

  it("refuses, rather than answering with zeros, when the model says nothing here", () => {
    // Null is the caller's signal to keep the corpus prior it has already
    // drawn. A map of zeros would instead redraw the whole menu at the floor,
    // which reads as "the model has ruled all of these out" — a much stronger
    // claim than "the model was not asked about any of them".
    expect(xposPosterior("sense", ["動作"], {}, verb)).toBeNull();
    expect(xposPosterior("sense", [], dist, verb)).toBeNull();
    // A menu none of whose rows the distribution touches, which is what a
    // distribution over a different 品詞 amounts to.
    expect(xposPosterior("sense", ["役割", "名"], dist, verb)).toBeNull();
    // And a token with no parsable tag at all: there is no prefix to condition
    // the lower two menus on, so there is nothing to answer.
    expect(xposPosterior("domain", ["行為"], dist, "_")).toBeNull();
  });

  it("survives a malformed answer rather than propagating it", () => {
    // The worker's `xposDistribution` has never been run — Pyodide/WASM, and
    // no harness here — so this function is written to be given nonsense. A
    // NaN reaching `opacityForLikelihood` comes out at the floor and looks
    // like a confident refusal, which is the failure worth refusing.
    const junk = {
      "v,動詞,行為,動作": Number.NaN,
      "v,動詞,行為,伝達": -1,
      "v,動詞,行為,交流": Number.POSITIVE_INFINITY,
      "not,a,tag": 0.9,
      "v,動詞": 0.9,
      "v,動詞,行為,移動": 0.25,
    } as unknown as Record<string, number>;
    const weights = xposPosterior("sense", ["動作", "伝達", "交流", "移動"], junk, verb)!;
    expect(weights.get("移動")).toBe(1);
    for (const sense of ["動作", "伝達", "交流"]) {
      expect(weights.get(sense), sense).toBe(0);
      expect(Number.isFinite(weights.get(sense)!), sense).toBe(true);
    }
    // Every weight, including the ones dropped, is a number
    // `opacityForLikelihood` can draw.
    for (const [row, weight] of weights) {
      expect(opacityForLikelihood(weight), row).toBeGreaterThanOrEqual(FLOOR);
      expect(opacityForLikelihood(weight), row).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the priors usable, since they are what a menu falls back to", () => {
    // The other half of the change, and the reason `xposPrior` and its two
    // siblings are not deleted: `xposScores` answers null where there is no
    // parser behind the tree — an uploaded CoNLL-U, or a session where Pyodide
    // has not loaded — and where the tokenization has moved under the caller.
    // A menu in those cases is shaded by the corpus, which is the whole of
    // what the corpus was adopted for.
    //
    // Checked as the pairing rather than restated: the two are the same shape
    // of quantity, so anything drawn by one can be drawn by the other.
    for (const xpos of XPOS_INVENTORY) {
      const prior = xposPrior(xpos);
      expect(prior, xpos).toBeGreaterThanOrEqual(0);
      expect(prior, xpos).toBeLessThanOrEqual(1);
    }
    expect(opacityForLikelihood(xposPrefixPrior("n,名詞"))).toBe(1);
  });
});

describe("deprelPrior", () => {
  /** The shipped counts, read from the file the app imports rather than
   * restated, so the test cannot drift from the table. */
  const shipped = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "src", "parse", "deprel-frequency.json"), "utf-8"),
  ) as { tokens: number; relations: Record<string, number> };

  it("is the whole treebank, and the same one the xpos prior is counted over", () => {
    // Commensurable by construction: a reader comparing a shaded relation menu
    // with a shaded 品詞 menu is comparing like with like only if both are
    // counted over the same corpus. 533,362 is train+dev+test of the adjfix
    // branch, which is what `build-xpos-inventory.py` reads.
    expect(shipped.tokens).toBe(533_362);
    expect(Object.keys(shipped.relations).length).toBeGreaterThan(30);
  });

  it("puts the commonest relation solid and the rarest at the floor", () => {
    // Normalised against the commonest relation rather than the token count —
    // see the function's own doc for why dividing by 533,362 would leave the
    // menu with no solid entry at all.
    expect(deprelPrior("mod")).toBe(1);
    expect(deprelPrior("comp:obj")).toBeCloseTo(95_307 / 108_006, 6);
    expect(opacityForLikelihood(deprelPrior("conj:appos"))).toBe(FLOOR);
  });

  it("weighs a subtype as itself, not as its base", () => {
    // A row's segments are picked separately and carry their own values, so
    // `mod` and `mod@tmod` are two answers a reader chooses between. Folding
    // the subtype into its base would shade every segment of a row alike and
    // say nothing about the choice on offer.
    expect(deprelPrior("mod@tmod")).toBeLessThan(deprelPrior("mod"));
    expect(deprelPrior("mod@tmod")).toBeCloseTo(4_007 / 108_006, 6);
  });

  it("floors a relation the treebank does not write", () => {
    // The same treatment `xposPrior` gives a tag no annotator has written.
    expect(deprelPrior("no:such:relation")).toBe(0);
    expect(opacityForLikelihood(deprelPrior("no:such:relation"))).toBe(FLOOR);
  });

  it("shades every relation the menu can offer", () => {
    // The point of the prior: a menu with nothing to fall back on is the flat
    // menu the reader reported twice. Every row must get *a* weight, and one
    // that is a number `opacityForLikelihood` can draw.
    for (const relation of DEPREL_INVENTORY) {
      const weight = deprelPrior(relation);
      expect(Number.isFinite(weight), relation).toBe(true);
      expect(opacityForLikelihood(weight), relation).toBeGreaterThanOrEqual(FLOOR);
      expect(opacityForLikelihood(weight), relation).toBeLessThanOrEqual(1);
    }
  });
});

/** `rootDemotionLabel` is what `promoteToRoot` uses to decide the relation
 * on the arc from the *old* root to the *new* one, once the reader has
 * retracted the broader "reassigning any head cascades its dependents" rule
 * and narrowed it to this one sentence: "the deprel from the old root to the
 * new one should be assigned based on what the parser scores most highly
 * (and it *cannot* remain as `root`)." */
describe("rootDemotionLabel", () => {
  /** The shipped counts, read from the same file `deprelPrior`'s own tests
   * read — independent of `tokenInspector.ts`'s internal constant, so the
   * expectation cannot drift along with a bug in that constant's own
   * computation. */
  const shipped = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "src", "parse", "deprel-frequency.json"), "utf-8"),
  ) as { tokens: number; relations: Record<string, number> };

  /** The corpus's own best answer once ROOT is set aside — computed here by
   * a plain argmax over the shipped table, the most naive way to ask the
   * same question `BEST_DEPREL_EXCLUDING_ROOT` answers internally, so the
   * test is not just restating that constant's own arithmetic back at it. */
  const bestExcludingRoot = Object.entries(shipped.relations)
    .filter(([relation]) => relation !== "ROOT")
    .reduce((best, [relation, count]) => (count > best.count ? { relation, count } : best), {
      relation: "",
      count: -1,
    }).relation;

  it("is mod, 108,006 of 533,362 tokens — ahead of ROOT itself at 68,893", () => {
    // Named so a change to the shipped table that moves this answer is
    // caught by a test that says what moved and why, not by a silent change
    // in what every future root-promotion gets labelled.
    expect(bestExcludingRoot).toBe("mod");
    expect(shipped.relations.mod).toBe(108_006);
    expect(shipped.relations.ROOT).toBe(68_893);
    expect(shipped.relations.mod).toBeGreaterThan(shipped.relations.ROOT);
  });

  it("passes through the parser's own top label unchanged, whatever it is", () => {
    // Not a default and not the corpus's own answer — a real parser opinion
    // must win over the prior, or there is no point asking the parser at all.
    expect(rootDemotionLabel("comp:obj")).toBe("comp:obj");
    expect(rootDemotionLabel("mod")).toBe("mod");
    expect(rootDemotionLabel("subj")).toBe("subj");
  });

  it("falls back to the corpus prior's own best when there is no parser label at all", () => {
    // `null` is what a session with no parser running honestly reports,
    // having asked nothing (see `promoteToRoot` and `relabelOldRootArc`,
    // neither of which starts a parser download to get an answer).
    expect(rootDemotionLabel(null)).toBe(bestExcludingRoot);
  });

  it("never returns ROOT, even when that is what the parser's top label was", () => {
    // The rule's second half, stated unconditionally: "it *cannot* remain as
    // root." The parser's transition system has no `L-ROOT`/`R-ROOT` move
    // (see `shadeRetagMenu`'s own doc) so this can't arise from a real
    // `scoreArc` answer in practice — but the exclusion is written as
    // unconditional and is tested as unconditional.
    expect(rootDemotionLabel("ROOT")).not.toBe("ROOT");
    expect(rootDemotionLabel("ROOT")).toBe(bestExcludingRoot);
  });

  it("excludes ROOT from the prior fallback too, not only from a parser answer", () => {
    // Both branches the doc calls out: "If the highest-scoring label is
    // ROOT, take the next; if the only thing available is a prior, exclude
    // ROOT from it too." Checked directly against the shipped counts: ROOT
    // (68,893) sits below mod, punct and comp:obj, so a fallback that forgot
    // to exclude it would still have to answer something other than ROOT
    // *unless* it were choosing the single largest count including ROOT and
    // ROOT happened to win — which is exactly the failure mode this pins
    // down by asserting the fallback is never ROOT regardless of ranking.
    expect(rootDemotionLabel(null)).not.toBe("ROOT");
  });

  it("treats an empty label the same as no label, rather than writing an empty relation", () => {
    // `scoreArc`'s own contract never actually returns an empty string — a
    // label is always a real relation name or the call fails outright — but
    // `topLabel` is plain user-facing input to this function and an empty
    // string is exactly as much "nothing to say" as `null` is.
    expect(rootDemotionLabel("")).toBe(bestExcludingRoot);
  });
});
