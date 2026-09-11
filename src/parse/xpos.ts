import inventory from "./xpos-inventory.json" with { type: "json" };

// ---------------------------------------------------------------------------
// **The treebank's own part of speech, and UPOS derived from it.**
//
// Every token carries two statements of what it is. UPOS — NOUN, VERB, ADV —
// is the interoperable one, fifteen tags shared with every other UD treebank.
// The xpos is the Kyoto treebank's own, four comma-separated fields:
//
//     v,動詞,行為,動作        n,名詞,人,役割        p,助詞,句末,*
//     └─┬──┘ └──┬───┘
//   syntactic   semantic
//
// The first two fields are a one-letter class and the 品詞 — the same fact
// UPOS states, in a different vocabulary. The last two are a semantic domain
// and a sense inside it, which UPOS does not state at all, `*` where the
// scheme records none.
//
// **The xpos is what the reader is offered, and UPOS is computed from it.**
// That is the way round it has to be, because the correspondence is
// many-to-one in that direction and not in the other: NOUN and PROPN share
// `n,名詞`, PART and CCONJ and SCONJ share `p,助詞`, and VERB, ADJ, ADV and
// AUX all share `v,動詞`. A menu offering UPOS cannot say which 名詞 a noun is
// and cannot express the semantic pair at all; a menu offering the xpos says
// both, and UPOS falls out.
//
// **It falls out as a function of the xpos and two features**, which is what
// makes the derivation honest rather than a guess. The xpos alone is not one —
// a verb used adverbially and the copular 爲 wear the same tag as the plain
// verb — but `VerbForm` and `VerbType` settle it. Over the whole treebank:
//
//     xpos alone                          96.936%   (122 keys)
//     xpos + VerbForm                     99.463%   (166 keys)
//     xpos + VerbForm + VerbType          99.986%   (167 keys)
//     …+ Degree, NounType, Case, Polarity 99.986%   (189 keys)
//
// so two features are taken and no more. The table itself is legible, which is
// some evidence it is a real generalisation and not an overfit: `描写` is ADJ,
// `行為`/`変化`/`存在` are VERB, a `VerbForm=Conv` on any of them is ADV, and
// `VerbType=Cop` on `v,動詞,存在,存在` is AUX — the copular 爲 this app argues
// about at length in `verbLexicon.ts`.
//
// The inventory and the table are generated, not written: see
// `scripts/build-xpos-inventory.py`, which reads them off the treebank. What
// is written here is only how to use them.
// ---------------------------------------------------------------------------

type Inventory = {
  tokens: number;
  features: string[];
  prefixes: Record<string, { count: number; semantics: [string, string, number][] }>;
  derivation: Record<string, Record<string, string>>;
};

const XPOS = inventory as unknown as Inventory;

/** The one xpos every fallback lands on: a plain content verb, the treebank's
 * commonest tag. Used only where a caller has an xpos this app has never seen
 * and needs *some* well-formed answer — never to overwrite a real tag. */
const FALLBACK_XPOS = "v,動詞,行為,動作";

/** The four fields, named. `domain` and `sense` are `"*"` where the scheme
 * records none — kept as written rather than mapped to undefined, because the
 * `*` is what the treebank spells and what the exporter has to write back. */
export interface XposParts {
  /** `n`, `v`, `p`, `s` — the one-letter class. */
  letter: string;
  /** 名詞, 動詞, 助詞, 記号… — the 品詞, and the label the chip shows. */
  word: string;
  domain: string;
  sense: string;
}

/** The four fields of a well-formed xpos, or undefined for anything else —
 * `_`, an empty string, a tag with the wrong number of fields. Callers treat
 * undefined as "this token has no treebank tag", which is what an uploaded
 * CoNLL-U without an XPOS column gives. */
export function parseXpos(xpos: string | undefined): XposParts | undefined {
  if (!xpos || xpos === "_") return undefined;
  const fields = xpos.split(",");
  if (fields.length !== 4) return undefined;
  const [letter, word, domain, sense] = fields;
  if (!letter || !word || !domain || !sense) return undefined;
  return { letter, word, domain, sense };
}

export function formatXpos(parts: XposParts): string {
  return `${parts.letter},${parts.word},${parts.domain},${parts.sense}`;
}

/** Fields 1-2, `v,動詞` — the key the inventory files semantic pairs under. */
export function syntacticPrefix(xpos: string | undefined): string | undefined {
  const parts = parseXpos(xpos);
  return parts && `${parts.letter},${parts.word}`;
}

/** The 品詞 alone (動詞, 名詞…), which is what the chip shows as its title.
 *
 * Already Japanese, and deliberately not translated or abbreviated: this is
 * the treebank's own word for the category, and a reader editing the treebank's
 * annotation should see the treebank's own vocabulary. */
export function xposPartOfSpeech(xpos: string | undefined): string | undefined {
  return parseXpos(xpos)?.word;
}

/** The semantic pair as one label — `行為・動作`, or `句末` where the sense is
 * `*`, or undefined where the tag carries no semantics at all (`p,接尾辞,*,*`).
 *
 * A `*` is dropped rather than shown. It means the scheme records nothing
 * there, and printing it would read as a value. */
export function xposSemanticLabel(xpos: string | undefined): string | undefined {
  const parts = parseXpos(xpos);
  if (!parts) return undefined;
  const written = [parts.domain, parts.sense].filter((field) => field !== "*");
  return written.length === 0 ? undefined : written.join("・");
}

/** The features the derivation reads, in the fixed order the table is keyed
 * by — so `VerbType=Cop|VerbForm=Conv` and the reverse are one key. */
function featureKey(morph: string | undefined): string {
  if (!morph || morph === "_") return "";
  const present = new Map<string, string>();
  for (const pair of morph.split("|")) {
    const at = pair.indexOf("=");
    if (at > 0) present.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return XPOS.features
    .filter((name) => present.has(name))
    .map((name) => `${name}=${present.get(name)}`)
    .join("|");
}

/** **The UPOS this xpos and these features amount to.**
 *
 * Undefined where the xpos is not one the treebank writes, which leaves the
 * caller's existing UPOS alone rather than replacing it with a guess — an
 * uploaded CoNLL-U may carry a tagset this table knows nothing about, and
 * silently retagging every token of it would be worse than doing nothing.
 *
 * A feature combination the treebank never wrote falls back to the featureless
 * entry for the same xpos rather than to nothing, so a token the reader has
 * just retagged always resolves: it keeps whatever features its *old* tag
 * carried, and those need not be a combination the new tag was ever seen with. */
export function uposForXpos(xpos: string | undefined, morph?: string): string | undefined {
  const table = xpos === undefined ? undefined : XPOS.derivation[xpos];
  if (!table) return undefined;
  return table[featureKey(morph)] ?? table[""];
}

/** Every syntactic prefix the treebank uses, **commonest first**.
 *
 * This is the frequency order and only the frequency order. Three things read
 * it as such and none of them wants a different one: the shading
 * (`xposPrefixPrior` in `tokenInspector.ts` is a count over the commonest
 * count), `withPrefix`'s last fallback (which takes `xposesUnder(prefix)[0]`
 * and means *the commonest tag under this 品詞*), and `XPOS_INVENTORY`'s
 * layout. It is deliberately **not** what the 品詞 menu is offered in — that
 * is `xposMenuPrefixes`, and the block above it says why the two are separate
 * functions rather than one sort. */
export function xposPrefixes(): readonly string[] {
  return Object.keys(XPOS.prefixes).sort(
    (a, b) => XPOS.prefixes[b].count - XPOS.prefixes[a].count,
  );
}

// ---------------------------------------------------------------------------
// **The order to offer the 品詞 in, which is not the order they are commonest
// in.**
//
// `xposPrefixes` is the corpus's own order, and over 533,362 tokens it is:
//
//     名詞 168,830   動詞 153,696   記号 101,556   助詞 37,793   副詞 28,748
//     代名詞 20,797   前置詞 8,582   数詞 8,132   助動詞 4,727   接尾辞 364
//     感嘆詞 131
//
// A reader asked that the menu instead run in the order a grammar handbook
// lists the 品詞 in. That is a change to *one* of the three things which read
// the frequency order and not to the other two, so it is a second function and
// not a different sort: `xposPrefixes` still answers "commonest first", which
// is what `withPrefix`'s fallback and the shading both mean by it, and
// `xposMenuPrefixes` answers "the order to offer", which is what the menu
// means. Sorting `xposPrefixes` itself would have silently moved
// `withPrefix`'s blind fallback from 動詞・行為・動作 (46,329) to whatever the
// handbook happened to put first, and moved the shading's monotonicity — a
// darker row is a commoner 品詞 — off the list it is drawn on.
//
// **Which handbook, and how it was checked.** There is no copy of one in this
// checkout, so the convention was taken at one remove and cross-checked:
//
//   * ja.wikipedia 「漢文法」§品詞分類（詞類）, which gives the list as 実詞
//     {名詞, 代名詞, 動詞, 形容詞, 助動詞, 数量詞{数詞, 量詞}} then 虚詞
//     {副詞, 前置詞（介詞）, 接続詞（連詞）, 助詞, 感嘆詞（嘆詞）}, and
//     attributes it to 三省堂『全訳漢辞海 第四版』and 数研出版『体系漢文』.
//   * kambun.jp 「詞類（品詞）」, after 李佐豊『古代漢語語法学』(商務印書館):
//     実詞 {動詞, 名詞, 代詞, 数量詞} then 虚詞 {副詞, 介詞, 連詞, 助詞, 嘆詞}.
//
// The two agree on 実詞 before 虚詞 and on the whole 虚詞 run — 副詞 → 前置詞
// → 接続詞 → 助詞 → 感嘆詞, five for five, in that sequence — which is the
// part of the order this tagset actually needs. They differ inside 実詞 (李佐豊
// leads with 動詞), and 漢辞海's arrangement is the one taken, for a reason
// that is a fact about this treebank rather than a preference:
//
// **The tagset is already written in 漢辞海's vocabulary, and in places in its
// words.** It spells 代名詞, 前置詞, 感嘆詞, 助動詞 — 漢辞海's Japanese terms —
// where 李佐豊 spells 代詞, 介詞, 嘆詞. And the semantic fields under `v,副詞`
// are 漢辞海's own subclassification of the adverb, nearly verbatim: it files
// adverbs as 程度/範囲/時間/数量, and the treebank's domains under 副詞 are
// 程度, 範囲, 時相, 頻度. Down at the sense level, 14 of 漢辞海's 16 adverb
// senses appear as treebank senses under the matching domain, spelled the same
// way — 程度 3 of 3 (極度, 軽度, やや高度), 範囲 3 of 3 (総括, 限定, 共同),
// 時間→時相 7 of 8 (過去, 現在, 将来, 終局, 緊接, 恒常, 変化; 適時 is absent,
// and 完了/継起 are extra), 数量→頻度 1 of 2 (重複). Which of the two borrowed
// from the other is not something this checkout can settle; that they share a
// vocabulary is enough to say 漢辞海's is the convention this tagset is nearest
// to, and so the one whose 品詞 order to follow.
//
// **The arithmetic of the fit.** 漢辞海 names twelve leaf categories. Nine of
// them are 品詞 of this tagset. Three are not, and each is somewhere else in
// the tag rather than missing:
//
//     形容詞  →  v,動詞,描写,*   (26,880 tokens; ADJ falls out of the domain)
//     接続詞  →  p,助詞,接続,*   (18,674: 属格 9,151, 並列 7,623, 体言化 1,900)
//     量詞    →  no classifier 品詞 at all; `clf` is a relation here
//
// Two of the eleven 品詞 are the other way round — in the tagset and not in
// the handbook — and they go at the end in the order they already had, which
// is the frequency order: 記号 (101,556) then 接尾辞 (364). Neither is a word
// class the tradition has a place for: 接尾辞 is a bound morpheme and 記号 is
// punctuation, which is not language. 9 + 2 = 11.
//
// **Rejected.**
//
//   * 学校文法's order (名詞 動詞 形容詞 形容動詞 副詞 連体詞 接続詞 感動詞
//     助動詞 助詞). It is the order for *Japanese*, and this is a Chinese
//     tagset read in Japanese: 学校文法 has no 前置詞 at all and files 代名詞
//     and 数詞 as kinds of 名詞 rather than as 品詞, so it can order at most
//     six of the eleven and would have to invent the rest.
//   * 李佐豊's 実詞 order, which leads with 動詞. Same 虚詞 run, so it is
//     corroboration rather than a rival; rejected on the vocabulary argument
//     above, and because leading with 動詞 would put the corpus's *second*
//     commonest 品詞 first for a reason no reader of this app can see.
//   * 実詞 before 虚詞, then frequency inside each. Tidy, and invented — the
//     handbooks state a sequence, not a two-level sort, and the whole point of
//     the request is to follow one rather than compose one.
//
// The request came with a sketch — 名詞, 代名詞, 数詞, 動詞, 副詞, 助動詞,
// 助詞, 接尾辞, 感嘆詞, 前置詞, 記号 — and the handbook is followed instead
// where the two differ, which is in four places: 数詞 goes after 動詞・助動詞
// rather than before them (漢辞海 files 数量詞 last among 実詞), 助動詞 goes
// before 副詞 rather than after (it is 実詞 and 副詞 is 虚詞), 前置詞 goes
// straight after 副詞 rather than second-to-last (it is the second 虚詞), and
// 接尾辞 goes to the very end rather than between 助詞 and 感嘆詞 (the
// handbook does not name it, so it takes the tail with 記号).
//
// **Not verifiable here.** There is no browser in this checkout, so nothing
// below says the menu *draws* in this order; what it says is that the list the
// menu is built from is in it. The `tokenInspector.ts` call that consumes it
// is one line and is not this file's to change.
// ---------------------------------------------------------------------------

/** The 品詞 a 漢文 handbook names, in the order it names them: 実詞 first, then
 * 虚詞. 漢辞海's list, less the three categories it names that this tagset does
 * not have as 品詞 (形容詞, 量詞, 接続詞 — see the block above for where each
 * actually lives). A 品詞 not on this list is not ranked by it. */
const HANDBOOK_ORDER: readonly string[] = [
  // 実詞
  "名詞",
  "代名詞",
  "動詞",
  "助動詞",
  "数詞",
  // 虚詞
  "副詞",
  "前置詞",
  "助詞",
  "感嘆詞",
];

/** **Every syntactic prefix the treebank uses, in the order to offer them in** —
 * 漢辞海's 品詞 order, with anything it does not name kept at the end in the
 * frequency order it already had (記号, then 接尾辞).
 *
 * The counterpart of `xposPrefixes`, and the separation is the point: this one
 * answers "what order does a menu list the 品詞 in", `xposPrefixes` answers
 * "which 品詞 is commonest", and the second question still has the answer it
 * always had. Nothing that means *commonest* should call this.
 *
 * Written as a stable sort over `xposPrefixes` rather than as a written-out
 * list of eleven, so that a 品詞 appearing or vanishing in a rebuilt inventory
 * cannot make this list disagree with that one: an unranked newcomer lands in
 * the tail, in its own frequency position, instead of being dropped. `sort` is
 * stable by specification, which is what holds that tail in frequency order. */
export function xposMenuPrefixes(): readonly string[] {
  const rank = (prefix: string): number => {
    const at = HANDBOOK_ORDER.indexOf(prefix.split(",")[1] ?? "");
    return at === -1 ? HANDBOOK_ORDER.length : at;
  };
  return [...xposPrefixes()].sort((a, b) => rank(a) - rank(b));
}

/** The semantic pairs attested under a prefix, commonest first, as whole xpos
 * strings ready to be set on a token. */
export function xposesUnder(prefix: string): readonly string[] {
  const entry = XPOS.prefixes[prefix];
  if (!entry) return [];
  return entry.semantics.map(([domain, sense]) => `${prefix},${domain},${sense}`);
}

/** How often the treebank writes this exact xpos — the menu's shading, and the
 * ordering of the rows *inside* a 品詞. The 品詞 themselves are ordered by
 * `xposMenuPrefixes` and not by this. Zero for a tag the treebank does not
 * have. */
export function xposFrequency(xpos: string | undefined): number {
  const parts = parseXpos(xpos);
  if (!parts) return 0;
  const entry = XPOS.prefixes[`${parts.letter},${parts.word}`];
  return entry?.semantics.find(([d, s]) => d === parts.domain && s === parts.sense)?.[2] ?? 0;
}

/** Whether this is a tag the treebank actually writes, and so one the menu can
 * offer and `uposForXpos` can answer for. */
export function isKnownXpos(xpos: string | undefined): boolean {
  return xpos !== undefined && XPOS.derivation[xpos] !== undefined;
}

/** **The two semantic fields, taken apart.**
 *
 * The pair is a hierarchy and not a compound: `行為` is a domain and `動作` is
 * one of the fourteen senses inside it, so 行為・動作 and 行為・伝達 share a
 * level that 描写・形質 does not. Offering the 121 composed pairs as one flat
 * list threw that away and made the reader scroll past every verb's semantics
 * to find a noun's; offering the levels apart gives three short menus — 11
 * 品詞, at most 14 domains (under 名詞), at most 14 senses (under 動詞・行為).
 *
 * It also shortens every label the chip has to draw, which is what the reader
 * noticed first: the longest domain is 3 characters (括弧開) and the longest
 * sense 6 (その他の人名), against 12 for the composed form.
 *
 * `*` is in these lists where the treebank writes it, because it is a real
 * value of the field — `p,接尾辞,*,*` records no semantics at all — and a
 * caller that needs to *hide* it can ask; a caller that needs to round-trip
 * the tag cannot invent it back. */
export function domainsUnder(prefix: string): readonly string[] {
  const seen = new Map<string, number>();
  for (const [domain, , n] of XPOS.prefixes[prefix]?.semantics ?? []) {
    seen.set(domain, (seen.get(domain) ?? 0) + n);
  }
  return [...seen].sort((a, b) => b[1] - a[1]).map(([domain]) => domain);
}

/** The senses attested under one prefix and domain, commonest first. */
export function sensesUnder(prefix: string, domain: string): readonly string[] {
  return (XPOS.prefixes[prefix]?.semantics ?? [])
    .filter(([d]) => d === domain)
    .map(([, sense]) => sense);
}

// ---------------------------------------------------------------------------
// **Re-tagging one field at a time, and repairing the fields under it.**
//
// The three chips edit three levels of one tag, so a change at one level can
// leave the levels below it saying something the treebank never writes —
// picking 名詞 on a token tagged `v,動詞,行為,動作` would give `n,名詞,行為,動作`,
// which is not a tag. Each helper therefore repairs downward.
//
// **What it keeps is what still exists.** Several semantic pairs are shared
// across prefixes — 描写・形質 and 描写・態度 sit under both `n,名詞` and
// `v,動詞` — so retagging a noun as a verb keeps its semantics rather than
// silently resetting them, and only falls back where the old value has no
// meaning under the new parent. Falling back takes the *commonest* option,
// which is the one the reader most likely wants and the one the menu shows
// first.
//
// Returned as a whole xpos string rather than applied, so the caller stays the
// only thing that writes to a token.
// ---------------------------------------------------------------------------

/** The tag `xpos` becomes when the reader picks a different 品詞.
 *
 * **`accept` is how a caller says which tags it can live with**, and the
 * fallback consults it rather than taking the 品詞's commonest tag blind. The
 * case that forced it: 記号's commonest tag is `s,記号,句点,*`, a full stop —
 * 42,983 of its 101,556 — which derives to PUNCT, and a menu that will not
 * offer an uneditable result therefore could not offer 記号 at all. With
 * `accept` the same menu falls back to `s,記号,一般,*` (SYM, an ordinary
 * resolving token) and 記号 becomes reachable, along with the only tag under it
 * that a reader would ever want on a character.
 *
 * Defaulted to accepting everything, so a caller with no policy behaves exactly
 * as it did before this parameter existed; the policy is the caller's because
 * *which* tags are uneditable is a fact about the app's editing surface and not
 * about the treebank. Where nothing under the 品詞 is acceptable the first
 * candidate is returned anyway — refusing would mean returning something that
 * is not a tag, and the caller is the one holding a filter it can apply again. */
export function withPrefix(
  xpos: string | undefined,
  prefix: string,
  accept: (candidate: string) => boolean = () => true,
): string {
  const parts = parseXpos(xpos);
  const candidate = parts && `${prefix},${parts.domain},${parts.sense}`;
  if (candidate && isKnownXpos(candidate) && accept(candidate)) return candidate;
  if (parts) {
    const kept = sensesUnder(prefix, parts.domain)
      .map((sense) => `${prefix},${parts.domain},${sense}`)
      .find(accept);
    if (kept !== undefined) return kept;
  }
  const under = xposesUnder(prefix);
  return under.find(accept) ?? under[0] ?? FALLBACK_XPOS;
}

/** The tag `xpos` becomes when the reader picks a different domain. */
export function withDomain(xpos: string | undefined, domain: string): string {
  const parts = parseXpos(xpos);
  if (!parts) return FALLBACK_XPOS;
  const prefix = `${parts.letter},${parts.word}`;
  const senses = sensesUnder(prefix, domain);
  if (senses.includes(parts.sense)) return `${prefix},${domain},${parts.sense}`;
  return `${prefix},${domain},${senses[0] ?? parts.sense}`;
}

/** The tag `xpos` becomes when the reader picks a different sense. Nothing
 * sits below the sense, so there is nothing to repair. */
export function withSense(xpos: string | undefined, sense: string): string {
  const parts = parseXpos(xpos);
  if (!parts) return FALLBACK_XPOS;
  return `${parts.letter},${parts.word},${parts.domain},${sense}`;
}

/** The menu's rows: one group per syntactic prefix, headed by its 品詞, each
 * holding that prefix's whole semantic inventory.
 *
 * **The groups are in `xposMenuPrefixes`' order and the rows inside them are
 * in `xposesUnder`'s**, which is the two orders doing the two jobs they are
 * for: the reader finds the 品詞 where a handbook would file it, and once
 * inside it the commonest tag is at the top. The heading order is the
 * handbook's; the row order is the corpus's.
 *
 * `current` is always offered even where the treebank never writes it, on
 * `uposMenuGroups`' own principle — a menu that cannot show the tag the token
 * already bears is a menu the reader cannot read their way out of. It is
 * appended to its own prefix's group, or given a group of its own where even
 * the prefix is unknown. */
export function xposMenuGroups(currentTag: string | undefined): [heading: string, xposes: string[]][] {
  // A tag that does not parse is no tag: `""` and `"_"` are what an uploaded
  // CoNLL-U writes for "this column is empty", and giving *that* a group of its
  // own would head the menu's last group with an empty string.
  const current = parseXpos(currentTag) ? currentTag : undefined;
  const groups: [string, string[]][] = xposMenuPrefixes().map((prefix) => {
    const heading = prefix.split(",")[1] ?? prefix;
    const rows = [...xposesUnder(prefix)];
    if (current !== undefined && syntacticPrefix(current) === prefix && !rows.includes(current)) {
      rows.push(current);
    }
    return [heading, rows];
  });
  if (current !== undefined && !groups.some(([, rows]) => rows.includes(current))) {
    const parts = parseXpos(current);
    groups.push([parts?.word ?? current, [current]]);
  }
  return groups;
}

/** The whole inventory flattened, for the guards that check nothing has
 * drifted. Laid out in `xposPrefixes`' frequency order and left there when the
 * menu moved to `xposMenuPrefixes`: this is not a menu, it is the set the
 * guards walk, and callers that do care about its order care about the
 * commonest tag coming first (`tests/menuShading.test.ts`). */
export const XPOS_INVENTORY: readonly string[] = xposPrefixes().flatMap((prefix) =>
  xposesUnder(prefix),
);

/** The features the derivation reads — exported so a test can assert the
 * generated table and this module agree about them. */
export const XPOS_DERIVATION_FEATURES: readonly string[] = XPOS.features;

export { FALLBACK_XPOS };
