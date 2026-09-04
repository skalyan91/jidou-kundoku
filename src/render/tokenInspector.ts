import type { Sentence, Token } from "../parse/types.ts";
import { redo, undo, withUndo } from "./editHistory.ts";
import { candidateReadings, type KanjidicIndex, type ReadingCandidate } from "../reading/kanjidicLookup.ts";
import { compoundMemberCandidates } from "../reading/compoundReading.ts";
import type { ConjClass } from "../kakikudashi/classicalConjugation.ts";
import type { HistoricalKanaIndex } from "../reading/historicalKana.ts";
import type { JmdictIndex } from "../reading/jmdictLookup.ts";
import { isRereadUse, rereadCharacter } from "../kakikudashi/rereadCharacters.ts";
import { clearChosenReading, setChosenReading, storedReadingText } from "../reading/chosenReading.ts";
import { toKatakana } from "./kana.ts";
import { posScores, scoreArc } from "../parse/pyodideClient.ts";

/** UPOS (Universal POS) tags this parser actually emits (see the plan's own
 * reference to the shipped lzh_sud_kyoto wheel), translated to the standard
 * Japanese terms for these categories — not a kanbun-specific gloss, since
 * UPOS itself is a general cross-linguistic tagset, not a kanbun grammar
 * concept. Unlisted tags (there shouldn't be any, in practice) fall back to
 * the raw tag itself — see `uposJa`. */
const UPOS_JA: Record<string, string> = {
  NOUN: "名詞",
  PROPN: "固有名詞",
  PRON: "代名詞",
  VERB: "動詞",
  AUX: "助動詞",
  ADJ: "形容詞",
  ADV: "副詞",
  ADP: "接置詞",
  CCONJ: "等位接続詞",
  SCONJ: "従属接続詞",
  PART: "助詞",
  PUNCT: "句読点",
  DET: "限定詞",
  NUM: "数詞",
  INTJ: "感動詞",
  SYM: "記号",
  X: "その他",
};

/** SUD (Surface-Syntactic Universal Dependencies) relations — the *base*
 * relations of the 34-label inventory documented in this project's own plan
 * (`depClassification.ts`'s `INVERT_DEPS`/postpose sets are the
 * *kundoku-behavior* side of this same label set; this is just the label
 * itself, translated for display) — given Japanese syntactic terminology.
 *
 * Base relations only. SUD writes a subtyped relation as `base@subtype`
 * (`mod@tmod`, `comp:obl@lmod`, `flat@vv`), and those are *composed* rather
 * than listed: see `DEPREL_SUBTYPE_JA` and `deprelJa`. `comp` is here even
 * though nothing in this treebank is ever labelled bare `comp` — SUD always
 * subtypes it — because `comp@expl` needs its base name to build from. So
 * this table is not the menu's inventory; `DEPREL_GROUPS` is (see
 * `DEPREL_INVENTORY`). */
const DEPREL_JA: Record<string, string> = {
  ROOT: "文の主辞",
  subj: "主語",
  comp: "補語",
  "comp:obj": "目的語",
  "comp:obl": "斜格補語",
  "comp:pred": "述語補語",
  "comp:aux": "助動詞補語",
  mod: "修飾語",
  compound: "複合語構成要素",
  flat: "並列構成要素",
  clf: "類別詞",
  cc: "等位接続語",
  "conj:coord": "並列語",
  punct: "句読点",
  det: "限定詞",
  discourse: "談話標識",
  vocative: "呼格語",
  dislocated: "転位語",
  parataxis: "並置語",
  list: "列挙語",
  dep: "未分類の依存語",
  udep: "未分類の依存語",
  unk: "不明な依存語",
};

/** What a relation's subtype — the part after `@` — narrows it *to*.
 *
 * Short categorial glosses, not sentences: the bracket says which kind of
 * `mod` (or `flat`, or `comp`) this is, and the base name beside it has
 * already said the rest. `場所`/`時間` serve three relations each
 * (`comp:obl@lmod`, `mod@lmod`, `udep@lmod`; and the `@tmod` three), which
 * is the whole reason for factoring them out: the same distinction drawn in
 * three places is now visibly the same distinction.
 *
 * These were previously folded into one flat label apiece — `mod@tmod` was
 * 時間修飾語, `comp@expl` was 形式補語, `flat@vv` was 動詞連続構成要素 — which
 * read as thirty-four unrelated names rather than twenty-three relations,
 * eight of them narrowed. Nothing is lost in the move: every old label's
 * content is still there, just split at the join. */
const DEPREL_SUBTYPE_JA: Record<string, string> = {
  tmod: "時間",
  lmod: "場所",
  emb: "埋め込み",
  redup: "畳語",
  vv: "動詞連続",
  foreign: "外来語",
  sp: "文末",
  expl: "形式",
};

/** The bracket a subtype is written in — 白抜き隅付き括弧, U+3016/U+3017.
 *
 * **Which bracket, and why this one.** The ask was for 修飾語【時間・場所】
 * "or whichever style of bracket is appropriate", and 隅付き括弧 is indeed
 * the right *form*: in a Japanese dictionary or grammar table it is what
 * attaches a category to a headword, which is exactly the job here. But the
 * solid pair 【】 is one this app can be asked to *set as text*: it is in
 * `BRACKETS`/`OPENING_BRACKETS` in punctuation.ts, so a source text carrying
 * one has it carried through, line-broken under 行頭禁則, and drawn in the
 * same panel these labels are drawn over. The deprel label in particular
 * sits in the gutter beside a column of that text (`.token-arrow-label`), so
 * a 【 in a label and a 【 in the text would be the same mark, a few
 * millimetres apart, meaning two different things.
 *
 * 〖〗 is the hollow counterpart of 【】 — the same form, lighter on the page,
 * and used for the same purpose (a sub-heading or sense label under a
 * headword) — and it is *not* in `BRACKETS`, so it can never collide. It is
 * also inside the self-hosted Noto Serif JP subset's own unicode-ranges
 * (`U+3016-301b` in fonts.css), so it is drawn in the app's own face rather
 * than falling out to a system fallback. Of the pairs punctuation.ts does
 * not claim — 〖〗, 〘〙, 〚〛, ｛｝ — it is the only one with an established
 * Japanese convention behind it.
 *
 * **What was checked, and how.** No browser was available when this was
 * written, so the two things that could have made this choice a bad one were
 * checked against the shipped artefacts instead. Both codepoints are in the
 * cmap of `public/fonts/noto-serif-jp/noto-serif-jp-vf-56.woff2` (the subset
 * fonts.css declares `U+3016-301b` on), and that font carries real `vert`
 * and `vrt2` alternates for both — `uni3016 -> glyph00224`, `uni3017 ->
 * glyph00225` — which is what matters here, since every label these appear
 * in is set `writing-mode: vertical-rl`. UAX #50 gives U+3016/U+3017 a
 * vertical orientation of Tu (upright, but wanting a different glyph), and a
 * font without those alternates would have left the browser to rotate or
 * synthesize one. It doesn't have to. Neither codepoint is in `BRACKETS`
 * (asserted in the tests).
 *
 * What is *not* checked is how the pair looks beside a kanji at 1.25rem. */
const SUBTYPE_OPEN = "〖";
const SUBTYPE_CLOSE = "〗";

/** What separates two subtypes of the same base inside one bracket —
 * 修飾語〖時間・場所〗.
 *
 * `・` (U+30FB, 中黒) because that is the mark the request itself was written
 * with, and because it is what Japanese uses to conjoin coordinate items
 * inside a label rather than in a sentence: a 、 there would read as a clause
 * break in a place that has no clause. It is not in punctuation.ts's
 * `BRACKETS`, `COMMAS` or `FULL_STOPS` (`COMMAS` holds the Latin middle dot
 * `·`, U+00B7, not this one), so nothing in the pipeline classifies it and no
 * mark the app *sets* is spelled this way — the same collision test the
 * bracket above had to pass. A source text could still contain one of its
 * own, but unlike the deprel label in the gutter this mark only ever appears
 * inside a 〖〗 in a floating panel, so there is no place the two are drawn a
 * few millimetres apart. Present in the shipped font subset (U+30FB is in
 * `noto-serif-jp-vf-120.woff2`, the same file the kana come from); it has no
 * `vert`/`vrt2` alternate and needs none, being a centred dot that is the
 * same glyph in either orientation (UAX #50 Vertical_Orientation=U).
 *
 * This constant and the two above are the whole of the bracket decision: a
 * reader who wants 〔時間・場所〕 or （時間／場所） changes these three
 * strings and nothing else. Everything that composes a label — `deprelJa` for
 * the chip, `deprelMenuRows` for the menu — reads them from here. */
const SUBTYPE_SEP = "・";

/** Splits `base@subtype` into its two halves; `subtype` is `null` for a
 * plain relation. Only the *first* `@` divides — nothing in this inventory
 * carries two, and a hypothetical `a@b@c` is better shown with `b@c` in the
 * bracket than silently truncated. */
function splitDeprel(dep: string): [base: string, subtype: string | null] {
  const at = dep.indexOf("@");
  return at < 0 ? [dep, null] : [dep.slice(0, at), dep.slice(at + 1)];
}

/** The retag menus' own section structure, grouped under the headings a
 * printed grammar table would use, so a 17- or 34-entry list reads as a few
 * short scannable runs instead of one undifferentiated column. Grouping (not
 * gojūon order) is deliberate: the value you want is nearly always findable
 * by its *kind*, and neighbouring relations that differ only by subtype
 * (mod/mod@tmod/mod@lmod) belong side by side — which the bracketed labels
 * now say out loud as well as by position.
 *
 * `DEPREL_GROUPS` *is* the relation menu's inventory: `DEPREL_JA` holds
 * base names only, so the list of relations a reader can actually pick is
 * this one (flattened as `DEPREL_INVENTORY`). `UPOS_GROUPS` is still a
 * filing of `UPOS_JA`, which has no subtypes to compose.
 * `assertMenuLabelsComplete` below checks both at module load, so neither a
 * tag added to `UPOS_JA` without being filed nor a relation added here
 * without a base name or a subtype gloss can go unlabelled. */
const UPOS_GROUPS: [heading: string, tags: string[]][] = [
  ["体言", ["NOUN", "PROPN", "PRON", "NUM"]],
  ["用言", ["VERB", "AUX", "ADJ", "ADV"]],
  ["虚字", ["ADP", "CCONJ", "SCONJ", "PART", "DET"]],
  ["雑字", ["INTJ", "PUNCT", "SYM", "X"]],
];

const DEPREL_GROUPS: [heading: string, rels: string[]][] = [
  ["述語・項", ["ROOT", "subj", "comp:obj", "comp:obl", "comp:obl@lmod", "comp:pred", "comp:aux", "comp@expl"]],
  ["修飾", ["mod", "mod@tmod", "mod@lmod", "det", "clf"]],
  ["複合・並列", ["compound", "compound@redup", "flat", "flat@vv", "flat@foreign", "cc", "conj:coord", "conj:coord@emb"]],
  ["談話・その他", ["discourse", "discourse@sp", "punct", "vocative", "dislocated", "parataxis", "list"]],
  ["未分類", ["dep", "udep", "udep@lmod", "udep@tmod", "unk", "unk@expl"]],
];

/** Every tag the POS menu offers, and every relation the deprel menu offers,
 * in menu order — exported so a test can walk the whole inventory rather
 * than a hand-picked list of examples, which is what keeps a relation from
 * being added here and rendering as its raw SUD string. */

/** The morphologiser's own UPOS inventory: the fifteen tags the shipped model
 * can put on a token, read out of the wheel rather than out of the treebank.
 *
 * `public/wasm/wheels/lzh_sud_kyoto-0.3.2-py3-none-any.whl` →
 * `lzh_sud_kyoto/lzh_sud_kyoto-0.3.2/meta.json`, whose `labels.morphologizer`
 * holds 157 whole feature bundles; these are the distinct `POS=` values in
 * them. The canonical `lzh_kyoto-sud-*.conllu` files are **not** the
 * authority here and were not counted: the shipped model was trained on a
 * `relabeled_ext` variant, and the two disagree about live labels (the
 * canonical files have `udep@lmod` 4 472 and `mod@lmod` 0; the variant has
 * `mod@lmod` 3 030 and `udep@lmod` 74, and the model emits `mod@lmod`).
 *
 * **`ADJ` is new in 0.3.2 and is why this file no longer synthesises it.**
 * 0.3.1 had fourteen values and no adjective: Classical Chinese property
 * words were stative verbs, and the category survived only as `Degree=Pos` on
 * a `VERB`. This app therefore *made* 形容詞 out of that conjunction. 0.3.2
 * retags eight of the 157 bundles from `VERB` to `ADJ` — the count is
 * unchanged, the diff is exactly those eight — and **no `VERB` bundle carries
 * `Degree=Pos` any more**, so the conjunction is now always false and the
 * synthesis is not merely unnecessary but dead. All of it is deleted; 形容詞
 * is an ordinary tag now, named by `UPOS_JA` and filed in `UPOS_GROUPS` like
 * any other, and nothing in this file knows it is special.
 *
 * `Degree=Pos` itself stays on `ADV` (5 bundles) and `NOUN` (1), which is why
 * the old rule had to be a conjunction rather than the feature alone — an
 * adverbial 甚 was never a 形容詞. That reasoning is now the morphologiser's
 * to apply, not this file's.
 *
 * **The pipeline cannot widen it.** `lzh_upos_rules`, the last pipe, is a
 * post-morphologiser UPOS repair, and its source (`lzh_sud_kyoto/
 * lzh_upos_rules.py` in the same wheel) writes exactly three ways: a rule
 * table that sets `VERB` or `AUX`, the 之 rule that sets `SCONJ` or `PART`,
 * and a reduplication rule that copies a *sibling token's* tag — which the
 * morphologiser produced, so it is in this set by construction. All four
 * literals are members, so the closure is this set exactly. (0.3.2 widened
 * that rule's `ZHI_CLAUSAL` test to `{VERB, AUX, ADJ}`, which changes which
 * branch 之 takes and not what it can write.) Checked in the source rather
 * than taken from the release notes. */
const MORPHOLOGIZER_UPOS: ReadonlySet<string> = new Set([
  "ADJ", "ADP", "ADV", "AUX", "CCONJ", "INTJ", "NOUN", "NUM",
  "PART", "PRON", "PROPN", "PUNCT", "SCONJ", "SYM", "VERB",
]);

/** The tags the 品詞 menu offers: the fourteen the model can emit, plus the
 * adjective, which it cannot emit as a tag and can emit as a feature.
 *
 * `DET` and `X` are filed in `UPOS_GROUPS` and are *not* here, which is the
 * whole of the hiding. Both are real UPOS and both are glossed in `UPOS_JA`
 * — a menu that cannot offer a tag is a different thing from an app that
 * cannot name one, and the CoNLL-U upload path can still hand this app a
 * token bearing either (see `uposMenuTags`). What they are not is a choice
 * the parser could ever have made, and a menu of seventeen where three can
 * never occur is a menu that misdescribes the model. */
/** The tag that makes a token uneditable, and so the one tag the 品詞 menu
 * must not offer.
 *
 * `resolveEntry` returns `null` for `token.pos === "PUNCT"`: a mark draws no
 * chip, no arrow and no overlay, and clicking one selects nothing. Confirmed
 * on the page as well as in that function — inspecting a 。 leaves the panel
 * with no `.token-subtitle`, no `.token-arrow-label`, no
 * `.token-inspector-overlay` and no `.token-cell-selected`.
 *
 * So **neither menu can be opened on a mark**, and 句読点 in the 品詞 menu
 * could only ever have done one thing: turn some *other* character into one.
 * That is not a rare edit, it is a **one-way** edit — the moment it lands the
 * cell stops resolving, so the menu that made the change can never be opened
 * on it again to undo it. An entry whose only use is to remove a token from
 * the editing system is not an entry.
 *
 * The cost, stated plainly: a mark the model mis-tagged as something else can
 * no longer be corrected *to* punctuation from this menu. If that turns out
 * to be wanted, the answer is not to put this entry back — it would be the
 * same trapdoor — but to let `resolveEntry` admit PUNCT tokens so that the
 * edit has a way back. That is a change to what a mark *is* in this panel and
 * belongs with `resolveEntry`, not here. */
const UNEDITABLE_UPOS: ReadonlySet<string> = new Set(["PUNCT"]);

/** The relation the menu must not offer, for the reason `UNEDITABLE_UPOS`
 * gives about its part-of-speech twin.
 *
 * `punct` is the relation a mark bears, and a mark cannot be reached: a token
 * tagged `PUNCT` does not resolve, so it draws no arrow, and the relation
 * menu opens from the arrow. So this entry, like 句読点 in the 品詞 menu,
 * could only ever have been used on something that is *not* a mark — to say
 * that some ordinary character stands to its head as punctuation does.
 *
 * It is a milder thing than its twin: assigning `punct` does not make a token
 * unreachable, since resolution keys on the tag and not on the relation, so
 * this one is reversible. It goes for the plainer reason that it names a
 * relation for a class of token the reader can never be editing. */
const UNEDITABLE_DEPRELS: ReadonlySet<string> = new Set(["punct"]);

/** The tags the 品詞 menu offers, arrived at by subtraction rather than by a
 * list, so that it cannot come to disagree with the model.
 *
 *     15   `MORPHOLOGIZER_UPOS` — every tag the wheel can put on a token
 *    − 1   `UNEDITABLE_UPOS` — PUNCT, which no menu can be opened on
 *     ──
 *     14   offered
 *
 * `DET` and `X` need no subtracting: they are real UPOS, they are filed in
 * `UPOS_GROUPS` and glossed in `UPOS_JA`, and they are simply **not in the
 * morphologiser's fifteen** — this model cannot produce either. They fall out
 * of the menu because the set is built from what the model emits rather than
 * from the tagset, which is the whole point of deriving it. So the menu shows
 * 14 of the 17 tags this file can name: two the parser cannot emit, and one
 * it emits on tokens the reader can never reach.
 *
 * A menu that cannot offer a tag is a different thing from an app that cannot
 * name one, and the CoNLL-U upload path can still hand this app a token
 * bearing any of the three (see `uposMenuGroups`). */
const OFFERED_UPOS: ReadonlySet<string> = new Set(
  [...MORPHOLOGIZER_UPOS].filter((tag) => !UNEDITABLE_UPOS.has(tag)),
);

/** One token's 品詞 menu, group by group: the offered tags, plus this token's
 * own category if that is not among them.
 *
 * The exception is for the upload path. A user's CoNLL-U file may carry any
 * UPOS at all — `DET` and `X` included, and this app's own exporter will
 * write back whatever it read — so a token can arrive wearing a category the
 * parser could never have produced. Hiding it from that token's own menu
 * would be the one case where hiding does harm: the chip would name a
 * category the menu did not contain, nothing would be marked current, and the
 * first edit would silently discard it with no way back. (`uposJa` still
 * names all seventeen, so the chip reads 限定詞 either way — this is only
 * about what can be chosen.)
 *
 * So the tag is shown, in its own group, for exactly the token that has it.
 * The menu still says what the parser can do; it also says what this token
 * is.
 *
 * ── The shape 0.3.1 left behind, and why it gets no fallback ──────────
 * There is a second kind of token this app can be handed and the parser can
 * no longer make: a `VERB` carrying `Degree=Pos`, which is what an adjective
 * *was* until 0.3.2 retagged those bundles to `ADJ`. Auto-save has been
 * writing such trees, and a CoNLL-U file may hold one for ever.
 *
 * It gets nothing special. Its tag is `VERB`, so its chip reads 動詞, 動詞 is
 * marked current, and picking 形容詞 sets `ADJ` — which, since the token
 * already carries `Degree=Pos`, lands it on exactly the bundle 0.3.2 would
 * have produced. One click, and the correction is a *normalisation* rather
 * than a patch.
 *
 * The alternative was to keep reading the old conjunction so such a token
 * went on showing 形容詞. It was rejected because it cannot be made
 * consistent: `applyPosChoice` is gone and a POS edit now writes the tag and
 * nothing else, so a legacy token shown as 形容詞 could never be turned into
 * a verb — setting `VERB` would leave `Degree=Pos` in place and the
 * conjunction would light again. That is the trapdoor `UNEDITABLE_UPOS`
 * objects to, built for a shape that stops appearing the moment anything is
 * re-parsed. Showing the tag the token actually has is honest and has a way
 * back.
 *
 * A group emptied by the filtering is dropped rather than headed and blank —
 * which no inventory here comes close to (雑字, the smallest, keeps two), and
 * which `appendMenuGroup` would do anyway; it is stated here so that the
 * groups this returns are the groups the menu draws. */
export function uposMenuGroups(current: string): [heading: string, tags: string[]][] {
  return UPOS_GROUPS.map(
    ([heading, tags]): [string, string[]] => [heading, tags.filter((tag) => OFFERED_UPOS.has(tag) || tag === current)],
  ).filter(([, tags]) => tags.length > 0);
}

export const UPOS_INVENTORY: readonly string[] = UPOS_GROUPS.flatMap(([, tags]) => tags);
export const DEPREL_INVENTORY: readonly string[] = DEPREL_GROUPS.flatMap(([, rels]) => rels);

/** The readings menu's categories, in menu order. At module level so the
 * headings can be counted with the other two menus' — see `MENU_HEADINGS`. */
const READING_KIND_GROUPS: readonly [heading: string, kind: string][] = [
  ["再読", "reread"],
  ["音読み", "on"],
  ["訓読み", "kun"],
];

/** The way back to the parser's own answer, which is a category of one in the
 * readings menu. */
const READING_DEFAULT_HEADING = "既定";

/** Every category heading the app writes, across all three menus.
 *
 * Exported for the same reason the two inventories above are: what a heading
 * costs is a function of its characters, and it has to be right for every one
 * of them rather than for the two anyone thought to check. They run from two
 * characters (修飾, 体言, 虚字, 雑字, 再読, 既定) to six (談話・その他), and a
 * ・ is an ordinary character here — a heading is plain text, not the
 * segmented row a `.token-menu-punct` gets its half-width cell from, so a
 * 中黒 in a label costs a whole cell like any other character. Every one of
 * them is full-width, which is what lets a heading's extent be counted rather
 * than measured; `tests/menuRowPadding.test.ts` checks that over the
 * inventory rather than leaving it as an assumption.
 *
 * ── Length is a cost again, and two rewordings were reverted ───────────
 * Four labels were reworded a round ago to make a 割注 come out with two
 * lines of equal length. A heading is one tracked line now
 * (`.token-menu-heading`), a label of `n` characters takes `n` cells, and
 * that reason is void — while length, which a 割注 halved and so nearly gave
 * away, is a cost again. So the four were put back on trial. Two stand on
 * their own account and two did not:
 *
 *   機能語 → 虚字     **stands.** 体言 and 用言 divide the 実字; the
 *       characters filed here — 於, 而, 則, 也, 其 — are the 虚字, which is
 *       the term this tradition has for exactly that class and the one the
 *       other two headings are already speaking in. 機能語 was the only
 *       modern-linguistic word among the headings. The argument never
 *       depended on the count, and a cell shorter is now a second reason
 *       rather than the first.
 *   その他 → 雑字     **stands**, and would have to whatever the geometry:
 *       `X` is glossed その他 in `UPOS_JA` above, so the group was headed by
 *       the name of one of its own entries. 雑字 is what these are — 感動詞,
 *       句読点, 記号 and the unknown: characters of the text that are not
 *       words of the sentence.
 *
 *       **Re-argued at two members**, the hidings having taken `X` and then
 *       `PUNCT` out of it and left 感動詞 and 記号. It keeps the heading. The
 *       name states the group's *principle* — what is left when the 実字
 *       (体言, 用言) and the 虚字 are taken out — and a remainder does not
 *       stop being the remainder because the parser's tagset is narrower than
 *       UPOS; the group was the remainder at four members and is the
 *       remainder at two. The two that are left are exactly that: an
 *       interjection is a word but neither a 実字 nor a 虚字, and a symbol is
 *       not a word at all. Folding them into 虚字 was the alternative and it
 *       is wrong twice over — 虚字 means function *words*, which 記号 is not,
 *       and 感動詞 is not a function word either. Both remaining members are
 *       live: `INTJ` and `SYM` are in the morphologiser's fourteen and a
 *       token bearing either resolves, so this is not a vestigial group.
 *   述語とその項 → 述語・項   **reverted.** It was reworded because 禁則
 *       forced the 割注 to break 述語・ / 項, leaving 項 alone under three
 *       characters — the worst pair in the menu. There is no pair now. What
 *       is left is a six-character label where a four-character one says the
 *       same thing, and at seven cells against five it would have been the
 *       longest heading in the menu. 述語・項 is also the more ordinary form
 *       of a category name: a grammar coordinates with a 中黒, it does not
 *       write a sentence.
 *   分類不明 → 未分類        **reverted.** It was reworded because 未分 / 類
 *       split 分類 down the middle, which was a fault of the break and not
 *       of the name. Nothing breaks now. Both are ordinary Japanese for the
 *       relations the parser could not place (dep, udep, unk); 未分類 is the
 *       shorter and the more usual, and shorter is a cell.
 *
 * Two comments in HelpModal.ts name 述語・項 in prose and are not this file's
 * to change; the figure there reads `deprelMenuGroups()[0]` and follows on
 * its own. */
export const MENU_HEADINGS: readonly string[] = [
  ...DEPREL_GROUPS.map(([heading]) => heading),
  ...UPOS_GROUPS.map(([heading]) => heading),
  ...READING_KIND_GROUPS.map(([heading]) => heading),
  READING_DEFAULT_HEADING,
];

function assertMenuLabelsComplete(): void {
  // UPOS is a flat tagset — no subtypes to compose — so the check is the
  // old two-way one: everything filed is known, everything known is filed.
  const uposMissing = Object.keys(UPOS_JA).filter((tag) => !UPOS_INVENTORY.includes(tag));
  const uposUnknown = UPOS_INVENTORY.filter((tag) => !(tag in UPOS_JA));
  if (uposMissing.length || uposUnknown.length) {
    console.warn("tokenInspector: UPOS menu groups out of sync", { missing: uposMissing, unknown: uposUnknown });
  }

  // And the third way, which the hiding adds: a tag the menu offers has to be
  // one the menu can file and name. `OFFERED_UPOS` is written out by hand
  // from the wheel's own inventory, so a typo in it would otherwise show up
  // as an entry silently missing from a group rather than as anything anyone
  // could see.
  const offeredUnfiled = [...OFFERED_UPOS].filter((tag) => !UPOS_INVENTORY.includes(tag));
  if (offeredUnfiled.length) {
    console.warn("tokenInspector: offered UPOS not filed in a group", offeredUnfiled);
  }

  // And the two hidings, which are subtractions and so fail *silently* when
  // they are wrong: a misspelt member of either set removes nothing and the
  // menu goes on offering the thing it was meant to hide. Nothing else would
  // notice, so this does.
  const hiddenUnknown = [
    ...[...UNEDITABLE_UPOS].filter((tag) => !UPOS_INVENTORY.includes(tag)),
    ...[...UNEDITABLE_DEPRELS].filter((rel) => !DEPREL_INVENTORY.includes(rel)),
  ];
  if (hiddenUnknown.length) {
    console.warn("tokenInspector: hidden label is not in the inventory it hides from", hiddenUnknown);
  }

  // Relations are composed, so "known" means both halves are: a base with no
  // Japanese name, or a subtype with no gloss, would fall back to the raw
  // SUD string and put `flat@vv` in a menu of Japanese.
  const unnamedBase: string[] = [];
  const unglossedSubtype: string[] = [];
  for (const rel of DEPREL_INVENTORY) {
    const [base, subtype] = splitDeprel(rel);
    if (!(base in DEPREL_JA)) unnamedBase.push(rel);
    if (subtype !== null && !(subtype in DEPREL_SUBTYPE_JA)) unglossedSubtype.push(rel);
  }
  // And the other direction: a base name or a subtype gloss no relation in
  // the menu uses is dead weight, and usually the trace of a rename.
  const bases = new Set(DEPREL_INVENTORY.map((rel) => splitDeprel(rel)[0]));
  const subtypes = new Set(DEPREL_INVENTORY.flatMap((rel) => splitDeprel(rel)[1] ?? []));
  const unusedBase = Object.keys(DEPREL_JA).filter((base) => !bases.has(base));
  const unusedSubtype = Object.keys(DEPREL_SUBTYPE_JA).filter((subtype) => !subtypes.has(subtype));

  // A fifth way, and the one the nested menu adds: the menu draws one row per
  // base, built a group at a time (`deprelMenuGroups`), so a base whose
  // relations are filed under two different headings would come out as two
  // rows with the same name in two different columns — 修飾語〖時間〗 in 修飾
  // and 修飾語〖場所〗 in 未分類, with no way for a reader to tell that they
  // are one relation narrowed two ways. Filing is by hand and this is the
  // mistake it invites, so it is checked rather than assumed.
  const groupOfBase = new Map<string, string>();
  const splitAcrossGroups: string[] = [];
  for (const [heading, rels] of DEPREL_GROUPS) {
    for (const rel of rels) {
      const [base] = splitDeprel(rel);
      const seen = groupOfBase.get(base);
      if (seen === undefined) groupOfBase.set(base, heading);
      else if (seen !== heading && !splitAcrossGroups.includes(base)) splitAcrossGroups.push(base);
    }
  }

  if (unnamedBase.length || unglossedSubtype.length || unusedBase.length || unusedSubtype.length || splitAcrossGroups.length) {
    console.warn("tokenInspector: deprel labels out of sync", {
      unnamedBase,
      unglossedSubtype,
      unusedBase,
      unusedSubtype,
      splitAcrossGroups,
    });
  }
}
assertMenuLabelsComplete();

export function uposJa(pos: string): string {
  return UPOS_JA[pos] ?? pos;
}

/** A relation's Japanese name: the base relation's own name, and where the
 * relation is subtyped, that subtype's gloss after it in 〖〗.
 *
 * A relation with no subtype is untouched — `mod` is 修飾語 and gets no
 * empty bracket — which is the point of composing rather than listing: the
 * bracket appears exactly where SUD wrote an `@`.
 *
 * Pure, and the one place a relation becomes words: the menu entries, the
 * arrow label over the text, and anything else that names a relation all
 * come through here, so the entry a reader picks in the menu reads the same
 * as the label they picked it from. */
export function deprelJa(dep: string): string {
  const [base, subtype] = splitDeprel(dep);
  const baseName = DEPREL_JA[base];
  // An unknown base is shown raw rather than half-translated: `foo@lmod` as
  // 〖場所〗-something would claim to know what `foo` is.
  if (!baseName) return dep;
  if (subtype === null) return baseName;
  return `${baseName}${SUBTYPE_OPEN}${DEPREL_SUBTYPE_JA[subtype] ?? subtype}${SUBTYPE_CLOSE}`;
}

/** The class that recentres one of the two brackets in vertical setting, or
 * `""` for anything else (the ・, and any other punctuation a row picks up
 * later).
 *
 * The correction itself, and the font measurements behind it, are documented
 * at `.subtype-bracket-open` in kunten.css: both vertical alternates sit about
 * 0.29em off the centre of their own em cell, hugging the edge that faces the
 * text they enclose, which is right for running prose and reads as a hole in a
 * compound label. Keyed on the character rather than on the segment's position
 * in the row so that the one function serves the menu, where the brackets are
 * separate flex items, and the arrow label, where they are inline.
 *
 * Exported for the tests, which walk every punct segment of every row rather
 * than the three characters this happens to be written against: a bracket
 * that arrived in a row with no class would sit 0.29em off centre with
 * nothing to say so, which is precisely the failure being fixed. */
export function subtypeBracketClass(text: string): string {
  if (text === SUBTYPE_OPEN) return "subtype-bracket-open";
  if (text === SUBTYPE_CLOSE) return "subtype-bracket-close";
  return "";
}

/** Writes a relation's name into `el` as `deprelJa` spells it, but with the
 * brackets in `<span>`s of their own so the recentring above can reach them.
 *
 * `deprelJa` stays a pure string function — it is what the tests walk, what
 * fills a `title`, and what any future caller that wants the name without a
 * DOM should have — and this is the one place that needs the name as markup
 * outside the menu, which builds its own segments (`deprelRowElement`).
 * The two agree by construction: the text nodes here concatenate to exactly
 * what `deprelJa` returns. */
export function setDeprelLabel(el: HTMLElement, dep: string): void {
  const [base, subtype] = splitDeprel(dep);
  const baseName = DEPREL_JA[base];
  el.textContent = "";
  // An unknown base, or no subtype at all, has no bracket to recentre.
  if (!baseName || subtype === null) {
    el.textContent = deprelJa(dep);
    return;
  }
  const bracket = (text: string) => {
    const span = document.createElement("span");
    span.className = subtypeBracketClass(text);
    span.textContent = text;
    return span;
  };
  el.append(
    baseName,
    bracket(SUBTYPE_OPEN),
    DEPREL_SUBTYPE_JA[subtype] ?? subtype,
    bracket(SUBTYPE_CLOSE),
  );
}

/** One piece of a relation-menu row.
 *
 * `relation` is a piece that *is* a relation and can be picked: the base name
 * at the head of the row, and each subtype gloss inside the bracket. Its
 * `value` is the SUD string that picking it writes — `mod` for 修飾語,
 * `mod@tmod` for the 時間 beside it.
 *
 * `label` is the same thing minus the picking: a base name that has to be
 * drawn, because the subtypes after it are read as narrowing *it*, but that
 * SUD never writes bare so there is nothing for a click to mean. `comp` is
 * the only one in this inventory today (see `deprelMenuRows`), and it is
 * found rather than listed, so a second one gets the same treatment the day
 * it appears.
 *
 * `punct` is the 〖, the 〗 and the ・ between subtypes: the row's own
 * typography, belonging to no relation and carrying no value. */
export type DeprelSegment =
  | { readonly kind: "relation"; readonly value: string; readonly text: string }
  | { readonly kind: "label"; readonly value: string; readonly text: string }
  | { readonly kind: "punct"; readonly text: string };

/** One row of the relation menu: a base relation and everything written on
 * its line. */
export interface DeprelMenuRow {
  readonly base: string;
  readonly segments: readonly DeprelSegment[];
}

/** Breaks a list of SUD relations into one row per base, with that base's
 * subtypes inline and separately pickable.
 *
 * ```
 *   mod, mod@tmod, mod@lmod   ->   修飾語〖時間・場所〗
 *                                  ^^^^^^ ^^^^ ^^^^
 *                                  mod    @tmod @lmod
 * ```
 *
 * This is the whole of the change from a flat menu to a nested one, and it is
 * deliberately a *pure function over strings* rather than something that
 * builds DOM: the suite this project runs has no DOM in it, so the only way
 * the mapping from a click to a relation can be tested over the entire
 * inventory — rather than over two or three examples someone thought to write
 * down — is for it to be decided here and merely rendered later. See
 * `tests/deprelLabels.test.ts`, which walks every row of every group.
 *
 * **Order is the caller's.** Rows come out in order of each base's first
 * appearance, and a base's subtypes in the order they were given, so the
 * grammatical order `DEPREL_GROUPS` is written in survives intact — `mod`
 * before `det` before `clf`, and 時間 before 場所 within `mod` because that
 * is how the inventory lists them. Nothing here re-sorts.
 *
 * **Which bases can be picked.** A base is pickable exactly when it appears
 * in `rels` on its own. That is a property of the inventory, not a list kept
 * by hand: SUD never writes bare `comp` — every occurrence in this treebank
 * is `comp:obj`, `comp:obl`, `comp:pred`, `comp:aux` or `comp@expl`, which
 * are five different relations and not five uses of one — so `comp` is in
 * `DEPREL_JA` only to give 〖形式〗 something to narrow, and 補語 is drawn as
 * a `label`. `comp` is the only such base today; `comp:obl`, `compound`,
 * `flat`, `conj:coord`, `discourse`, `udep` and `unk` are all written bare as
 * well as subtyped, so all of them lead their rows as ordinary options.
 *
 * Note that `comp:obj` and `comp` are unrelated as far as this function is
 * concerned. SUD's `:` and `@` are different operators — `comp:obj` is a
 * relation in its own right, `comp@expl` is a subtype of `comp` — and only
 * the `@` is split on (`splitDeprel`), so 目的語 gets a row of its own rather
 * than being filed under 補語. */
export function deprelMenuRows(rels: readonly string[]): DeprelMenuRow[] {
  const order: string[] = [];
  const subtypesOf = new Map<string, string[]>();
  const written = new Set<string>();
  for (const rel of rels) {
    const [base, subtype] = splitDeprel(rel);
    if (!subtypesOf.has(base)) {
      subtypesOf.set(base, []);
      order.push(base);
    }
    if (subtype === null) written.add(base);
    else subtypesOf.get(base)!.push(subtype);
  }

  return order.map((base) => {
    const segments: DeprelSegment[] = [
      // The base name always leads, pickable or not: the subtypes after it
      // are glosses of *it*, and 〖時間〗 on its own would name nothing.
      { kind: written.has(base) ? "relation" : "label", value: base, text: DEPREL_JA[base] ?? base },
    ];
    const subtypes = subtypesOf.get(base)!;
    subtypes.forEach((subtype, index) => {
      segments.push({ kind: "punct", text: index === 0 ? SUBTYPE_OPEN : SUBTYPE_SEP });
      segments.push({
        kind: "relation",
        value: `${base}@${subtype}`,
        text: DEPREL_SUBTYPE_JA[subtype] ?? subtype,
      });
    });
    if (subtypes.length > 0) segments.push({ kind: "punct", text: SUBTYPE_CLOSE });
    return { base, segments };
  });
}

/** The relation menu as it is actually built: the same headings as before,
 * each now holding rows rather than entries.
 *
 * Rows are built per group, which is the same thing as building them over the
 * whole inventory only because no base is ever split across two groups —
 * asserted in `assertMenuLabelsComplete`, and checked again in the tests,
 * because if `mod` were filed under 修飾 and `mod@tmod` under 未分類 this
 * would silently produce two 修飾語 rows in different columns.
 *
 * `current` is the token's own relation, and does the same work here that it
 * does in `uposMenuGroups`: a relation the menu does not offer is still shown
 * for the one token that bears it. The upload path is why — a CoNLL-U file
 * can give an ordinary character the `punct` relation whatever this app
 * offers, and hiding it from that token's own menu would leave the arrow
 * labelled 句読点 over a menu with nothing marked and the first edit
 * discarding it. Callers with no token in hand (the help modal's figures, the
 * tests' inventory walks) pass nothing and get the offered menu. */
export function deprelMenuGroups(current = ""): [heading: string, rows: DeprelMenuRow[]][] {
  return DEPREL_GROUPS.map(([heading, rels]): [string, DeprelMenuRow[]] => [
    heading,
    deprelMenuRows(rels.filter((rel) => !UNEDITABLE_DEPRELS.has(rel) || rel === current)),
  ]).filter(([, rows]) => rows.length > 0);
}

/** The longest Japanese UPOS label (等位接続詞/従属接続詞, 5 characters) —
 * every UPOS/deprel label shown shares one font size, sized so that *even
 * this worst case* fits horizontally within the clicked token's own
 * kanji+ruby+kunten cell width (see `showInspector`), rather than a
 * per-label size that would make short labels bigger than long ones.
 * Computed from `UPOS_JA`'s own values rather than hardcoded, so adding a
 * longer translation later keeps this correct automatically. */
const MAX_UPOS_LABEL_LENGTH = Math.max(...Object.values(UPOS_JA).map((s) => s.length));

/** Which `Sentence` each rendered `.sentence-gap` corresponds to — the DOM
 * itself only carries token *ids* (`data-token-id`, unique within one
 * sentence but not across the whole tree), so resolving a click back to
 * that token's actual pos/dep/head needs this side table. Populated by
 * `KundokuView.ts`'s own render loop (`registerSentence`) each time it
 * builds a sentence's markup; a `WeakMap` so old sentences' entries are
 * dropped automatically once their (replaced) DOM is garbage-collected,
 * rather than accumulating across repeated re-renders of new text. */
const sentenceByGap = new WeakMap<Element, Sentence>();

export function registerSentence(gapEl: Element, sentence: Sentence): void {
  sentenceByGap.set(gapEl, sentence);
}

export interface Entry {
  cell: HTMLElement;
  glyph: HTMLElement;
  token: Token;
}

/** Resolves a `.kanji-cell[data-token-id]` back to its `Token`, via the
 * `.sentence-gap` ancestor `registerSentence` tagged — `null` if the cell
 * isn't one of these (background/whitespace), isn't yet registered, or
 * (per this app's UI, punctuation is excluded from click-to-inspect
 * entirely) is punctuation. */
function resolveEntry(cell: HTMLElement | null): Entry | null {
  if (!cell) return null;
  const glyph = cell.querySelector<HTMLElement>(".kanji-glyph");
  const gapEl = cell.closest(".sentence-gap");
  const sentence = gapEl && sentenceByGap.get(gapEl);
  const token = sentence?.tokens.find((t) => t.id === Number(cell.dataset.tokenId));
  if (!glyph || !sentence || !token || token.pos === "PUNCT") return null;
  return { cell, glyph, token };
}

/** Every cell that renders `entry`'s token, in source order.
 *
 * A multi-character token is drawn one cell per character — `KundokuView`'s
 * `compoundGroupCell` splits it so each character can carry its own furigana
 * — and every one of those cells is stamped with the *same* `data-token-id`,
 * because there is only one token there. Document order is source order for
 * this layout (the browser's own vertical-rl wrapping never reorders), so
 * the last entry is the last character: downward within a column, and on
 * into the next column to the left where the token wraps.
 *
 * A fused *span* is deliberately not this. Its members are separate tokens
 * with separate ids and separate arcs of their own, so each one's list here
 * is just itself, and selecting one member marks one member. The two look
 * identical on the page and this is the only thing that tells them apart —
 * which falls out of the ids rather than needing a test of its own. See
 * `findCompoundSpans` for what a span is.
 *
 * Scoped to the enclosing `.sentence-gap` because a token id is unique
 * within its sentence and repeats across sentences. */
function tokenCells(entry: Entry): HTMLElement[] {
  const gapEl = entry.cell.closest(".sentence-gap");
  if (!gapEl) return [entry.cell];
  const cells = [...gapEl.querySelectorAll<HTMLElement>(`.kanji-cell[data-token-id="${entry.token.id}"]`)];
  return cells.length > 0 ? cells : [entry.cell];
}

/** Every clickable, non-punctuation cell inside `container`, in document
 * order — which, for text laid out by the browser's own vertical-rl line
 * wrapping (never reordered relative to source), is exactly reading order:
 * down within one column, then continuing at the top of the next column to
 * the left. Used both to step to the next/previous kanji (`navigate`'s
 * up/down) and, grouped by column, to jump a whole line (`navigate`'s
 * left/right). */
function collectEntries(container: HTMLElement): Entry[] {
  const entries: Entry[] = [];
  for (const cell of container.querySelectorAll<HTMLElement>(".kanji-cell[data-token-id]")) {
    const entry = resolveEntry(cell);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Groups an already-document-order `Entry` list into columns, by clustering
 * consecutive entries whose cell shares the same `left` (a real kanji-cell
 * column is a fixed-width vertical strip, so every member's `left` matches
 * to within rounding) — safe to do by simple adjacency, without any
 * fancier clustering, since the browser's own wrapping already guarantees
 * one column's entries are contiguous in document order before the next
 * column's begin. */
function groupByColumn(entries: Entry[]): Entry[][] {
  const columns: Entry[][] = [];
  let lastLeft: number | null = null;
  for (const entry of entries) {
    const left = Math.round(entry.cell.getBoundingClientRect().left);
    if (lastLeft === null || Math.abs(left - lastLeft) > 4) {
      columns.push([]);
      lastLeft = left;
    }
    columns.at(-1)!.push(entry);
  }
  return columns;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Hobby's velocity function — the "rho" of METAFONT's choose-controls
 * step, which turns a pair of tangent *angles* into the control-point
 * *distance* that makes the resulting cubic as round as possible (the
 * mock-curvature-matching condition Hobby's algorithm solves). `sigma` is
 * just `rho` with its arguments swapped, so the symmetric arcs here need
 * only this one function. */
function hobbyRho(alpha: number, beta: number): number {
  const sqrt5 = Math.sqrt(5);
  const sa = Math.sin(alpha);
  const sb = Math.sin(beta);
  const ca = Math.cos(alpha);
  const cb = Math.cos(beta);
  const numerator = 2 + Math.SQRT2 * (sa - sb / 16) * (sb - sa / 16) * (ca - cb);
  const denominator = 1 + ((sqrt5 - 1) / 2) * ca + ((3 - sqrt5) / 2) * cb;
  return numerator / denominator;
}

/** The cubic Bézier `d` for a Hobby spline from (x1,y1) to (x2,y2) that
 * bows `peak` pixels off the straight chord, toward the unit normal
 * (nx,ny).
 *
 * Hobby's construction takes tangent *directions* as its input and derives
 * the handle lengths from them, so the bow height is set by choosing the
 * departure/arrival angle rather than by placing a control point directly.
 * Both endpoints get the same angle (a symmetric arc), and that angle is
 * solved for by bisection against the closed form for a symmetric cubic's
 * own midpoint offset, `d·rho(phi,phi)·sin(phi)/4` — monotonic in phi, and
 * bounded by `d/2` at phi = 90°, comfortably above any `peak` this caller
 * asks for.
 *
 * `peak` of 0 degenerates to phi = 0, where rho is exactly 1 and the
 * handles land on the chord's own third-points — i.e. a straight line,
 * still expressed as the same kind of spline, which is what the
 * cross-column arcs want. */
/** The arrowhead, as a `<defs>` holding the two markers that draw it: a
 * wider "casing" one behind and the real one in front, mirroring the
 * two-path casing technique the line itself uses, so the head reads as
 * clearly outlined as the line and label do — see `.token-arrow-path` and
 * `.token-arrow-path-casing`.
 *
 * `markerUnits="userSpaceOnUse"` on *both*. The SVG default, `strokeWidth`,
 * scales a marker's own markerWidth/markerHeight by the stroke-width of
 * whichever path references it, which silently re-couples the two markers'
 * relative sizes to those paths' own (deliberately different) stroke-widths
 * every time either changes — concretely, the casing marker ended up
 * rendering at ~9x the real one's size (their intended ~1.5x size ratio,
 * compounded by the paths' own 3x stroke-width ratio), a jagged, oversized
 * blob that swallowed the real arrowhead rather than a clean outlined point
 * (confirmed by rendering the arrow in isolation, scaled up).
 * `userSpaceOnUse` makes markerWidth/markerHeight absolute, in the same
 * coordinate space as the path's own `d`, so the sizes set here stay fixed
 * regardless of either path's stroke-width.
 *
 * The casing marker is the *same* triangle at the *same* reference point as
 * the real one — not a scaled-up copy, which never stays concentric: scaling
 * a triangle about a marker-viewport origin moves its tip away from the path
 * end, so the halo bunches on one side. It is widened instead by stroking
 * that identical shape in the casing colour with a round join, exactly the
 * outline-by-a-wider-underlay trick the line's casing uses, which expands it
 * uniformly in every direction by half the stroke width. `overflow: visible`
 * is required for that expansion to survive: a marker's viewport clips its
 * content to markerWidth/markerHeight by default, which would shave the halo
 * right back off.
 *
 * `orient="auto-start-reverse"` lets the same pair serve either end of a
 * path, which is what the drag line needs: it carries the head at its start
 * rather than its end (see `setupHeadDrag`).
 *
 * `prefix` distinguishes one set of ids from another. The analysis overlay
 * and the drag line each need their own, since ids must be unique and both
 * can be on the screen at once — a character can be dragged while another is
 * inspected. Shared as a function rather than copied into the two places,
 * because everything above is one worked-out technique and a copy of it
 * would be a copy that stops matching. */
function arrowheadDefs(prefix: string): SVGDefsElement {
  const ARROWHEAD = { size: 8, d: "M0,0 L8,4 L0,8 Z", refX: "6", refY: "4" };
  const defs = document.createElementNS(SVG_NS, "defs");
  for (const casing of [true, false]) {
    const marker = document.createElementNS(SVG_NS, "marker");
    marker.setAttribute("id", `${prefix}token-arrowhead${casing ? "-casing" : ""}`);
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("markerWidth", String(ARROWHEAD.size));
    marker.setAttribute("markerHeight", String(ARROWHEAD.size));
    marker.setAttribute("refX", ARROWHEAD.refX);
    marker.setAttribute("refY", ARROWHEAD.refY);
    marker.setAttribute("orient", "auto-start-reverse");
    marker.setAttribute("class", `token-arrowhead${casing ? "-casing" : ""}-marker`);
    if (casing) marker.setAttribute("overflow", "visible");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ARROWHEAD.d);
    marker.append(path);
    defs.append(marker);
  }
  return defs;
}

function hobbySplinePath(x1: number, y1: number, x2: number, y2: number, nx: number, ny: number, peak: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy) || 1;
  const tx = dx / chord;
  const ty = dy / chord;

  let phi = 0;
  if (peak > 0.01) {
    let lo = 0;
    let hi = Math.PI / 2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const midPeak = (chord * hobbyRho(mid, mid) * Math.sin(mid)) / 4;
      if (midPeak < peak) lo = mid;
      else hi = mid;
    }
    phi = (lo + hi) / 2;
  }

  const handle = (chord * hobbyRho(phi, phi)) / 3;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  // Departure direction at the start turns *toward* the bulge normal;
  // arrival direction at the end turns back off it by the same angle.
  const c1x = x1 + handle * (cos * tx + sin * nx);
  const c1y = y1 + handle * (cos * ty + sin * ny);
  const c2x = x2 - handle * (cos * tx - sin * nx);
  const c2y = y2 - handle * (cos * ty - sin * ny);
  return `M ${x1} ${y1} C ${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`;
}

/** How long the overlay and the menus take to arrive and to leave. Matches
 * the glyph highlight's own transition (see `.kanji-glyph` in kunten.css),
 * so a right click reads as one event rather than several. */
const FADE_MS = 160;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** Removes `node`, but lets it fade first.
 *
 * Arriving is CSS's own business (`token-fade-in`), since the element is in
 * the document by the time the rule applies. Leaving isn't: an element
 * removed from the document has nothing left to animate, so it has to be
 * kept until the fade is over and taken out at the end.
 *
 * A node on its way out is no longer an answer to anything — it stops taking
 * pointer events at once, so the click that dismissed a menu can't land on
 * the menu it dismissed, and whatever replaces it is what the reader
 * actually reaches. */
function fadeOutAndRemove(node: HTMLElement | null | undefined): void {
  if (!node) return;
  if (prefersReducedMotion() || typeof node.animate !== "function") {
    node.remove();
    return;
  }
  if (node.dataset.leaving === "true") return;
  node.dataset.leaving = "true";
  node.style.pointerEvents = "none";
  const fade = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-out" });
  // `cancel` as well as `finish`: an animation interrupted (the tab hidden,
  // the node reparented) must still take the node with it rather than
  // stranding it, mid-fade, on the screen.
  fade.addEventListener("finish", () => node.remove());
  fade.addEventListener("cancel", () => node.remove());
}

/** Takes down the analysis. `fade` where it is being dismissed — the reader
 * is done with it and watching it go says so — but not where it is being
 * replaced by the next one a moment later, which would leave two overlays
 * drawing two arrows over each other for the length of the fade. */
function clearInspector(column: HTMLElement, fade = false): void {
  for (const overlay of column.querySelectorAll<HTMLElement>(".token-inspector-overlay")) {
    // A replacement clears out whatever is already on its way out, too.
    if (fade) fadeOutAndRemove(overlay);
    else overlay.remove();
  }
  for (const el of column.querySelectorAll(".token-cell-selected")) el.classList.remove("token-cell-selected");
  for (const el of column.querySelectorAll(".token-cell-inspected")) el.classList.remove("token-cell-inspected");
  for (const el of column.querySelectorAll(".token-cell-head")) el.classList.remove("token-cell-head");
  // And the readings that lifted out of the analysis's way come back, by the
  // same transition that took them up — see `liftReadingsClear` below, and
  // `--reading-lift` in kunten.css, which is where the walk and its reversal
  // are argued.
  for (const el of column.querySelectorAll<HTMLElement>(".reading-steps-up")) {
    el.classList.remove("reading-steps-up");
    // And the number the class was reading, which is written inline on the
    // cell. The class alone would be enough to take the lift back — nothing
    // else declares `--reading-lift` — but a measurement left behind on a
    // cell that is no longer lifted is exactly the stale offset the whole
    // arrangement is built to not have, and the next gesture would find it
    // there and have to reason about it.
    el.style.removeProperty("--reading-lift-measured");
  }
}

/** The two runs in a character's reading lane: the reading itself and the
 * okurigana under it. What a reader would call the ruby, and the pair that
 * moves together when it steps aside — they are one apparatus and read as
 * one (the argument is `.reading-outside`'s, in kunten.css).
 *
 * Not the `<rt>` that holds them, which is the *reading's* box alone: the
 * okurigana inside it is out of flow and contributes nothing to it, so an
 * okurigana hanging below a short reading falls outside the box entirely.
 * Every collision measured on 酒蟲 is with that okurigana, so testing the
 * `<rt>` would have found none of them.
 *
 * Not `.reread-second` either, and that is a measurement rather than an
 * oversight: a 再読文字's second reading is written down the character's
 * *other* side (`right: 100%`), and across 269 selectable characters of 酒蟲
 * the chip never once reaches it. (The lift is along the column and would
 * serve that side unchanged; what is missing is a case to serve.)
 * The chip is centred on the glyph and overhangs it by the same amount on
 * both sides, so the two sides are not symmetric by accident: the second
 * reading is a single kana set against the character's foot on the left, and
 * the chip that would reach it is the one written *below*, which on a
 * 再読文字 is the side the arrow leaves free. A case that appears can be
 * added here with a mirrored rule; inventing one now would be a displacement
 * with nothing to displace. */
const READING_RUNS = ".furigana, .okurigana";

/** Which of the analysis's own marks a reading is asked to get out of the way
 * of. The part-of-speech chip, and nothing else — which is the conclusion of
 * measuring all five, not a shortlist chosen in advance.
 *
 * Every mark the overlay draws was walked against every full-strength reading
 * on 酒蟲, 269 selectable characters, and the smallest movement that would
 * clear each collision recorded — along the column, which is the axis the
 * readings move on (see `.reading-steps-up` in kunten.css):
 *
 *   - **the chip** (`.token-subtitle`): 49 collisions, needing a lift of
 *     10.66 to 25.34px. Each is lifted by what it asks for and a buffer —
 *     see `liftReadingsClear` below, and `.reading-steps-up` in kunten.css,
 *     which holds the answer under the lane's own ceiling.
 *   - **the deprel label** (`.token-arrow-label`): 49 collisions, needing 1.9
 *     to 159.2px of lift. That is up to nearly two whole characters, and a
 *     reading moved that far is not its own character's any more — which is
 *     exactly the defect the lift this overlay used to do was deleted for
 *     (see the note at the foot of `showInspector`). It is also the one mark
 *     a casing cannot help with: the label carries an opaque background of
 *     its own, so what it covers it covers completely, whatever the reading
 *     under it is wearing.
 *   - **the arc and its casing**: 132 collisions, needing 7.3 to 198px and
 *     sometimes not clearable at all — the arc runs *along* the lane rather
 *     than across it, so a reading moved out of its way meets it again a few
 *     pixels further on. This is the crossing the two casings are for: the
 *     arc carries 6px of page colour so it can cross a reading and stay
 *     legible, and every reading now carries a ring of the same colour so it
 *     can be crossed and stay legible (`.kanji-cell rt` in kunten.css). The
 *     crossing is the design and not a fault, and it is now legible from both
 *     sides rather than only from the arc's.
 *   - **the arrowhead**: no collision, on any character. It lands on the
 *     glyph's own centre, a whole half-character inside the lane.
 *   - **the head-join line**: no collision, on any character. It runs in the
 *     gap *between* two characters of one word, where nothing else is
 *     written — which is `markHeadCells`'s own argument for putting it there.
 *
 * Two marks that never collide, one that collides and can be cleared, two
 * that collide and are instead made legible where they cross. Only the third
 * is here. */
const READING_OBSTACLES = ".token-subtitle";

/** How much of a mark is really on the page: every `opacity` and every
 * `filter: opacity()` between it and the root, multiplied together.
 *
 * ── Why a measurement and not a list of selectors ──────────────────────
 * Standing back is said in two different properties by three different
 * rules, on two different clocks. The apparatus goes to `opacity: 0.4` while
 * a character is selected and again while one is dragged; a switched-off
 * layer goes to `filter: opacity(0)`; and the character being asked about
 * takes its own reading back to `filter: none` whatever the switch says
 * (`body.hide-furigana .token-cell-inspected .furigana`). The three compose
 * — a reading that is both switched off and stood back is 0.4 of nothing —
 * and kunten.css's own note on the switches says why they must be two
 * properties rather than one.
 *
 * A list of selectors here would be a fourth copy of those three rules,
 * kept in agreement with them by hand, and the first of them to change would
 * leave a reading stepping aside for something nobody can see. The product
 * of what the engine actually resolved is the same answer with nothing to
 * keep in agreement.
 *
 * ── Settled, not current ───────────────────────────────────────────────
 * The catch is *when* this is asked. It runs in the task that puts the
 * analysis up, so at that instant every one of those alphas is a transition
 * one frame old: the readings that are about to stand back still compute as
 * 1, and the chip that is about to arrive computes as 0 — the exact reverse
 * of the page a sixth of a second later, which would step every reading in
 * the column aside for a mark that is not there yet.
 *
 * So where a property is being animated, the value taken is the animation's
 * *last keyframe* — where the engine is going, which for a transition is the
 * value the cascade resolved and for the overlay's own `token-fade-in` is
 * the 1 it fades to. That is still the rendered state and not a re-reading
 * of the rules: it is read off the animations the engine itself created out
 * of them. Waiting the 160ms instead was the alternative, and it costs the
 * thing the box's own walk was built to get — the reading has to be leaving
 * as the mark arrives, not after it. */
function settledStrength(node: Element): number {
  let strength = 1;
  for (let el: Element | null = node; el && el !== document.documentElement; el = el.parentElement) {
    let opacity: string | null = null;
    let filter: string | null = null;
    for (const animation of el.getAnimations()) {
      const frames = animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [];
      const settled = frames[frames.length - 1] as Record<string, unknown> | undefined;
      if (typeof settled?.opacity === "string") opacity = settled.opacity;
      if (typeof settled?.filter === "string") filter = settled.filter;
    }
    const style = getComputedStyle(el);
    const alpha = Number(opacity ?? style.opacity);
    if (Number.isFinite(alpha)) strength *= alpha;
    strength *= filterAlpha(filter ?? style.filter);
  }
  return strength;
}

/** The alpha a `filter` value multiplies through, which is the product of its
 * `opacity()` functions and 1 for a filter that has none (`none` included).
 * The other filter functions do not fade anything and are not looked at. */
function filterAlpha(filter: string): number {
  let alpha = 1;
  for (const match of filter.matchAll(/opacity\(\s*([\d.]+)(%?)\s*\)/g)) {
    const value = parseFloat(match[1]);
    if (Number.isFinite(value)) alpha *= match[2] === "%" ? value / 100 : value;
  }
  return alpha;
}

/** Anything that is on the page at full strength. Below 1 the mark has stood
 * back — by a stand-down, by a switch, or by both — and a mark that has stood
 * back is not competing for the reader's attention, so nothing needs to get
 * out of its way and it needs nothing to get out of its own. The epsilon is
 * for the arithmetic of multiplying a chain of `1`s, not for a tolerance:
 * every alpha in play here is 1, 0.4 or 0. */
const FULL_STRENGTH = 0.999;

/** The gap to leave between a reading and the mark it is being lifted past,
 * which is the mark's own `margin-top`.
 *
 * A buffer taken from the page rather than chosen. The chip is written
 * 0.25rem off the foot of the glyph it belongs to (`.token-subtitle-below`
 * in kunten.css; the chip written above has the same margin, negative, which
 * is why this takes the magnitude) — that is the panel's own statement of
 * how much air this mark wants between itself and a run of type, and it is
 * the only number in play that is about *this mark's* distance from
 * anything. The box's 2px casing is a halo for a line crossing other ink;
 * `--head-box-full-reach`'s 6px is how far the box paints. Neither answers
 * the question.
 *
 * Lifted by the overlap plus this, a run ends as far above the chip as the
 * chip stands below the character it is written on: the same gap, mirrored
 * through the mark, which is a thing a reader can see is deliberate.
 *
 * Read off the mark and not copied here, so it cannot come to disagree with
 * the stylesheet. A mark in `READING_OBSTACLES` that declared no margin
 * would get no buffer and a reading would be lifted to just touching it;
 * today the chip is the only member and it has one, and a second member that
 * did not would want its own answer here rather than a constant borrowed
 * from the chip. */
function markBuffer(mark: HTMLElement): number {
  const margin = Math.abs(parseFloat(getComputedStyle(mark).marginTop));
  return Number.isFinite(margin) ? margin : 0;
}

/** The two chips the analysis writes: the part-of-speech pill (drawn on the
 * character) and the deprel label (drawn on the arc). Both are HTML, both
 * are opaque, and both are now cased in the same pass as the arc. */
const CHIPS = ".token-subtitle, .token-arrow-label";

/** A rectangle, in whatever coordinates the caller is working in. Structural
 * so a `DOMRect` is one, and so the arithmetic below can be exercised without
 * a browser to make one. */
export interface Extent {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Cases the whole apparatus in one pass, beneath all of its ink.
 *
 * ── What "jointly" has to mean ─────────────────────────────────────────
 * The arc already carries a casing (`.token-arrow-path-casing`, 6px of
 * `--color-bg` under a 2px line, so 2px of page colour per side) and its
 * arrowhead carries the same reach by the same trick (a 4px stroke on the
 * filled triangle — `.token-arrowhead-casing-marker`). The chips carried
 * none. Giving each chip one of its own is the obvious move and it is the
 * wrong one: the chips are painted *after* the SVG (they are absolutely
 * positioned siblings of it, and positioned boxes paint in document order),
 * so a ring drawn as part of a chip's own painting — a `box-shadow`, an
 * `outline` — would land on top of the arc's ink and rub 2px out of it
 * exactly where the arc meets the chip. A cross-line arc's label sits on
 * the arc's own midpoint (`peak` is 0 there, so `labelX`/`labelY` collapse
 * to the chord's middle), so the arc runs straight into it, and the reader
 * would see the arc stop 2px short of the box it points into. Two marks
 * cased against each other, which is the artefact rather than the fix.
 *
 * So the casing for the whole apparatus is painted once, first, and every
 * piece of ink goes on top of all of it: this layer, then the arc's own
 * casing and the arc, then the chips. Nothing that is casing is ever above
 * anything that is ink, and no casing edge can fall inside the union of arc
 * and chips — which is what a joint casing is.
 *
 * ── The chips' own backgrounds are not casing ─────────────────────────
 * They look like they might be. `.token-subtitle` is an opaque pill and
 * `.token-arrow-label` an opaque box, and `READING_OBSTACLES` above notes
 * that the label's background is why a casing on the *reading* cannot save
 * it. But that is fill, not casing: it is painted inside the chip's own
 * outline and is part of what the chip *is*, where a casing is page colour
 * painted outside a mark to hold other ink off it. A chip today abuts
 * whatever it lands on with nothing between them. So there is nothing to
 * double up — this adds separation the chips did not have, and does not
 * repeat anything they did.
 *
 * ── Shapes ────────────────────────────────────────────────────────────
 * One `<rect>` per chip, on the chip's own border box and with the chip's
 * own corner radius, filled and stroked in `--color-bg`. Stroked rather
 * than drawn inflated by hand, so the reach stays where the apparatus's
 * other two reaches are — in the stylesheet, on the rule this shares with
 * the arrowhead's casing marker — rather than becoming a third number in
 * this file. Filled as well as stroked for the same reason that marker is:
 * a solid halo has no interior seam for a sub-pixel to show through.
 *
 * Measured off the chips rather than recomputed from their inline `left`
 * and `top`, so this is right for a chip written above the character and
 * one written below (`.token-subtitle-above` translates by -100%, which no
 * arithmetic here would know about), for a label in the gutter and one on a
 * cross-line arc's midpoint, and for whatever width the text came out at.
 *
 * Against the overlay's own box and not `columnRect`: the SVG is `inset: 0`
 * inside the overlay, so the overlay's padding-box origin *is* this SVG's
 * coordinate origin, where the column's border box is only the same thing
 * as long as the column has no border or padding. The arrow's coordinates
 * are still taken against `columnRect` — they were measured before the
 * overlay existed — and the two agree today; this one has no reason to take
 * the longer way round.
 *
 * Every chip measured before any rect is inserted, for the reason at the
 * foot of `liftReadingsClear`: an insertion invalidates layout, and
 * measuring between insertions would reflow once per chip.
 *
 * Returns the casing's reach — half its stroke, which is how far past the
 * shape it widens it paints — because `liftReadingsClear` needs it and this
 * is the one place that has read it. 0 where nothing was drawn, or where
 * the engine has no computed stroke to give (jsdom, a print context), which
 * leaves every measurement below exactly as it was before this existed. */
function caseApparatus(overlay: HTMLElement): number {
  const chips = [...overlay.querySelectorAll<HTMLElement>(CHIPS)];
  if (chips.length === 0) return 0;
  const origin = overlay.getBoundingClientRect();
  const shapes = chips.map((chip) => ({
    box: chip.getBoundingClientRect(),
    // The *outer* radius, which is what `border-radius` names on a bordered
    // box — `.token-arrow-label` has a border and `.token-subtitle` does
    // not, and this is the corner both of them actually show.
    radius: parseFloat(getComputedStyle(chip).borderTopLeftRadius) || 0,
  }));

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "token-casing-layer");
  svg.setAttribute("width", String(origin.width));
  svg.setAttribute("height", String(origin.height));
  for (const { box, radius } of shapes) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("class", "token-chip-casing");
    rect.setAttribute("x", String(box.left - origin.left));
    rect.setAttribute("y", String(box.top - origin.top));
    rect.setAttribute("width", String(box.width));
    rect.setAttribute("height", String(box.height));
    rect.setAttribute("rx", String(radius));
    svg.append(rect);
  }
  // First child of the overlay, so it is under the arrow's SVG as well as
  // under the chips. The arc's own casing stays with the arc, where its
  // paint order against the head-join lines is argued; both are casing and
  // both are page colour, so which of the two goes down first is not a
  // question a reader can see the answer to.
  overlay.prepend(svg);

  const stroke = parseFloat(getComputedStyle(svg.firstElementChild as SVGElement).strokeWidth);
  return Number.isFinite(stroke) ? stroke / 2 : 0;
}

/** What a mark asks a reading to keep clear of it, once the mark is cased.
 *
 * The obstacle is the mark *as painted* — its box grown by the casing's
 * reach on every side, because a casing is opaque page colour and a run of
 * kana under one is as gone as a run under the pill itself.
 *
 * The buffer is the air the mark keeps on its other side, also as painted:
 * the chip is written its own `margin-top` off the glyph's foot, and the
 * casing spends `casing` of that margin, so what is left between the glyph
 * and anything the chip actually paints is `buffer - casing`.
 *
 * The two corrections are equal and opposite, and that is the finding rather
 * than a coincidence. `liftReadingsClear` lifts a run by `run.bottom -
 * box.top + buffer`, and substituting gives `run.bottom - (top - casing) +
 * (buffer - casing)` — the casing cancels, and every one of the 49 lifts
 * measured on 酒蟲 is the length it was before the chips were cased. Which
 * is what the mirroring argument at `markBuffer` predicts: a run ends as far
 * above the chip as the chip stands below its character, and casing the chip
 * moves both of those edges inward by the same 2px.
 *
 * What does change is the *net*. The collision test now runs against the
 * grown box, so a run that cleared the chip's border by a pixel — no
 * collision before, and 1px of it erased by the casing — is caught and
 * lifted, by 2 to 4px. That is the whole of the difference the joint casing
 * makes to the readings, and it is a difference in which runs move, not in
 * how far any of them goes. Unverified in a browser: measured only as
 * arithmetic here and in tests/chipCasing.test.ts. */
export function obstacleFor(box: Extent, buffer: number, casing: number): { box: Extent; buffer: number } {
  return {
    box: {
      top: box.top - casing,
      right: box.right + casing,
      bottom: box.bottom + casing,
      left: box.left - casing,
    },
    buffer: buffer - casing,
  };
}

/** Lifts a reading out of the analysis's way, up its own column, as far as
 * that reading has to go and no further, for as long as the analysis is up.
 *
 * The chip is drawn from the glyph's own centre and is wider than the glyph,
 * so the end of it overhangs the reading lane — 2 to 10.8px of it, measured
 * across 酒蟲 — and lands on the okurigana hanging there at the character's
 * foot. It is an opaque pill and the run underneath is simply gone.
 *
 * ── Why this is measured here rather than declared in CSS ──────────────
 * Because the chip's position is not a constant. The box a head character
 * gets is `--head-box-size` on `:root`, so a rule can say `100% + the box`
 * and be right on every character; the chip is placed by this function from
 * the glyph it is drawn on and the width of the word written in it, so how
 * far it reaches is a fact about the page rather than about the stylesheet.
 * There is nothing for a selector to test.
 *
 * What CSS gets is the answer and not the arithmetic: a class on the cells
 * that need it, and a length on each of them saying how far — one number per
 * cell rather than one number for all of them, since what the chip does to
 * one reading it does by a different amount to the next. The class is the
 * marker `clearInspector` finds them by and the home of the ceiling the
 * measurement is held under; the length is `--reading-lift-measured`, and
 * both are argued at `.reading-steps-up` in kunten.css. The walk, its
 * reversal and the reduced-motion case are all the same transition the head
 * box already runs on, and none of them is stated twice.
 *
 * ── As far as the collision, and no further ────────────────────────────
 * The measuring pass has always known the magnitude — it is testing whether
 * a run's foot reaches into a chip, so how far it reaches is the same
 * subtraction — and it used to throw that away and write one flat length,
 * two kana, for every cell it touched. Two kana is the deepest a lane can
 * hang below its character's foot, so it was a lift that always cleared;
 * it was not a lift anything had asked for. Against the 49 collisions on
 * 酒蟲, which need 10.66 to 25.34px, it moved most readings about twice as
 * far as they had to, and it moved 酌's しやくスル clear out of its
 * character, to sit between 獨 and 酌.
 *
 * So each cell is lifted by the deepest reach into it of any chip that meets
 * it, plus the buffer that chip itself declares: `markBuffer` below, which
 * is the chip's own margin against the glyph it is written on. Two kana is
 * still the ceiling, and it is applied in the stylesheet rather than here —
 * it is that file's arithmetic, out of `--size-furigana` and rule 5's
 * ceiling, and a copy of it here would be a constant in two places.
 *
 * Both of those — the reach and the buffer — are taken off the chip *as
 * painted*, which since the apparatus was cased jointly means the chip's
 * box grown by the casing and its margin spent by the same amount. The two
 * cancel and no lift changed length; what changed is which runs are caught.
 * `obstacleFor` above has the arithmetic and `caseApparatus` the reach.
 *
 * ── Along the column, not across the lanes ─────────────────────────────
 * The reading moves *up its own lane*, toward its character's top, and stays
 * in the lane it was in. It used to step sideways into the next lane
 * instead — one kana column out, which cleared the same 49 collisions — and
 * that is the wrong axis for this panel: the lane a reading stands in is how
 * a reader knows whose reading it is, and a reading standing a lane out is
 * standing where the character before it would put one. Moved along the
 * column it is where it always was, only higher, and its own character is
 * still the one it is beside.
 *
 * Up rather than down because the chip is never beside a reading — it is
 * past one *end* of the token, below its last character or above its first —
 * so what it lands on is always a run hanging down into it. Measured across
 * the 269 selectable characters: all 49 collisions clear on a lift of 11.2
 * to 28px, where getting past the chip downward would take 26.7 to 72.3px
 * and carry the reading most of the way to the next character.
 *
 * Which is also why one subtraction covers every case. The run's foot is
 * inside the chip and its head is above it, so what has to happen is that
 * the foot ends up above the chip's top: the lift is `run.bottom -
 * chip.top`, and there is no arrangement in which the run has to come *down*
 * instead. A run that had somehow got entirely below the chip would ask for
 * a lift the size of both of them, which is what the ceiling in
 * `.reading-steps-up` is written against.
 *
 * ── A reading still walking home is measured where it is going ─────────
 * `clearInspector` has just taken the class off whatever the last gesture
 * lifted, so a reading that was lifted a moment ago is somewhere between its
 * resting place and two kana above it while this measures. Read as it
 * stands, it is up to two kana clear of the chip that is about to land on
 * it, and the answer comes back "no collision" — so letting a character go
 * and asking about it again inside the 160ms left the chip sitting on the
 * okurigana with nothing to move it. Measured (on the lateral step this
 * replaces, the same failure either way) at 60ms into the walk home: 8.18px
 * out, against a chip that overhangs by 2.
 *
 * So each run is measured at its resting place: where it is now, plus
 * whatever is left of the lift it is walking off — plus, because the lift is
 * upward and a run mid-walk is above where it belongs. The target is 0 for
 * every cell — the class is gone from all of them — so the correction is the
 * length itself and needs nothing read off the transition. The head box's
 * own walk drifts a run by the same kind of amount and is deliberately not
 * corrected for: it moves the *head's* annotations, and the chip is drawn on
 * the character being asked about, which measurement (see
 * `READING_OBSTACLES`) puts on the other side of every arc on 酒蟲.
 *
 * ── Every measurement first, then every class ──────────────────────────
 * Adding the class invalidates layout, so a class added inside the loop
 * would make the next `getBoundingClientRect` reflow the whole column, once
 * per stepped reading. The same discipline, and the same reason, as
 * `animateAnnotationShift` (KundokuView.ts). */
function liftReadingsClear(column: HTMLElement, overlay: HTMLElement, casing: number): void {
  const obstacles = [...overlay.querySelectorAll<HTMLElement>(READING_OBSTACLES)]
    .filter((mark) => settledStrength(mark) > FULL_STRENGTH)
    // The mark as painted, casing included — see `obstacleFor`, which is
    // also where the arithmetic that leaves every lift the length it was is
    // set out.
    .map((mark) => obstacleFor(mark.getBoundingClientRect(), markBuffer(mark), casing));
  if (obstacles.length === 0) return;

  // How far up this run has to go to be clear of every mark it meets, and 0
  // for a run that meets none. The two `continue`s are the old intersection
  // test unchanged, written out rather than as one boolean because the third
  // line needs the mark it matched: what a run owes a mark is the depth its
  // own foot reaches past that mark's top, plus the mark's buffer. `max`,
  // not the last one found — a run can be under two chips at once (two
  // tokens' analyses never overlap, but a chip is drawn per token and this
  // says nothing about how many the overlay holds), and clearing the
  // shallower says nothing about the deeper.
  const clearance = (run: DOMRect, drift: number): number => {
    let lift = 0;
    for (const { box, buffer } of obstacles) {
      if (run.left >= box.right || box.left >= run.right) continue;
      if (run.top + drift >= box.bottom || box.top >= run.bottom + drift) continue;
      lift = Math.max(lift, run.bottom + drift - box.top + buffer);
    }
    return lift;
  };

  // Snapped up to the device pixel, and to the device pixel rather than to
  // anything of the text's own. The reader was explicit that a reading need
  // not move by a whole kana, and it should not: a kana is the unit the run
  // is built out of, not the unit the collision is measured in (the argument
  // is `.reading-steps-up`'s, in kunten.css). What a fractional length costs
  // is a run rasterised at a fractional origin, which at this size is a
  // faint vertical smear on the kana rather than a wrong position — and the
  // column is full of fractional lengths already, `--size-furigana` itself
  // being 14.666px. So this buys tidiness rather than fixing a defect, and
  // it is `ceil` rather than `round` so that the snap can only ever add
  // clearance: rounding down would put a run back by up to half a device
  // pixel into the mark it was measured against.
  //
  // Unverified: that a half-pixel `top` is invisible at this size is a
  // judgement from the numbers, not something anyone has looked at.
  const device = window.devicePixelRatio || 1;

  const lifting: [cell: HTMLElement, lift: number][] = [];
  for (const cell of column.querySelectorAll<HTMLElement>(".kanji-cell")) {
    const drift = parseFloat(getComputedStyle(cell).getPropertyValue("--reading-lift")) || 0;
    // One number for the cell, not one per run: the class is on the cell and
    // the lift moves the whole `<rt>`, reading and okurigana together, which
    // is the arrangement `.reading-outside` argues for. So the two runs in a
    // lane are measured separately and the deeper of the two answers.
    let lift = 0;
    for (const run of cell.querySelectorAll<HTMLElement>(READING_RUNS)) {
      const needed = clearance(run.getBoundingClientRect(), drift);
      if (needed <= 0) continue;
      if (settledStrength(run) <= FULL_STRENGTH) continue;
      lift = Math.max(lift, needed);
    }
    if (lift > 0) lifting.push([cell, Math.ceil(lift * device) / device]);
  }
  for (const [cell, lift] of lifting) {
    cell.style.setProperty("--reading-lift-measured", `${lift}px`);
    cell.classList.add("reading-steps-up");
  }
}

/** One line drawn between two consecutive boxes of a boxed token, in
 * viewport coordinates — the connectors `markHeadCells` finds and the
 * overlay draws. */
interface HeadJoin {
  x: number;
  top: number;
  bottom: number;
}

/** Boxes every character of the head token, and works out where a line goes
 * between consecutive boxes.
 *
 * A multi-character token is one word, and boxing its characters separately
 * says two things where the parse says one: the arrow arrives at a single
 * node, and the box is meant to name what it arrives at. The line closes
 * the boxes into the one unit the 朱点 tie already closes a broken-up
 * compound into (see `.compound-group[data-tied]` in kunten.css), and runs
 * in the same lane — the gap between the characters, where nothing else is
 * written. Nothing, on a fused token, includes that tie itself: it is drawn
 * only where the reading order or a kaeriten comes between two members, and
 * `compoundNeedsTie` can find neither inside a single token (one id, and
 * its one kunten mark on the last character), so the two lines cannot meet.
 *
 * Not drawn across a line break. In vertical-rl the characters of a word
 * are normally stacked downward in one column, but a word can wrap, and
 * then its next character is at the *top of the column to the left* — a
 * line between the two would run backwards across the page through every
 * column between them. Read off the measured rects rather than assumed:
 * two cells in one column share a `left` (the same test, and the same 4px
 * tolerance, that `groupByColumn` and the arc's `sameColumn` use), and a
 * wrapped pair does not.
 *
 * Every consecutive pair, not just the first two, so a three-character
 * token is joined twice and a token that wraps in the middle is joined on
 * the side of the break that stayed together.
 *
 * Measured off the *glyphs*, not the cells: a cell's box takes in its ruby
 * and its kunten, which reach past the character (this is
 * `positionCompoundLines`' own reason for measuring the same two edges).
 * Foot to top, so the line runs the whole gap and meets each box's own
 * border. */
function markHeadCells(cells: HTMLElement[]): HeadJoin[] {
  for (const cell of cells) cell.classList.add("token-cell-head");
  const joins: HeadJoin[] = [];
  for (let i = 0; i < cells.length - 1; i++) {
    const glyph = cells[i].querySelector<HTMLElement>(".kanji-glyph");
    const next = cells[i + 1].querySelector<HTMLElement>(".kanji-glyph");
    if (!glyph || !next) continue;
    const from = glyph.getBoundingClientRect();
    const to = next.getBoundingClientRect();
    if (Math.abs(from.left - to.left) > 4) continue; // wrapped into the next column
    if (to.top <= from.bottom) continue;
    joins.push({ x: from.left + from.width / 2, top: from.bottom, bottom: to.top });
  }
  return joins;
}

/** Renders the click-to-inspect overlay for `entry`: a subtitle (its UPOS,
 * translated) anchored just past its glyph — above it if the arrow to its
 * head points *upward* (head below it in the column), below otherwise,
 * so the subtitle never sits on the same side the arrow is approaching
 * from — and, unless `entry.token` is its own sentence's ROOT (no real head
 * to point to), an arrow from its head's glyph to its own, labeled with its
 * deprel. Arrow *endpoints* are measured off each `.kanji-glyph`
 * specifically — never the wider `.kanji-cell`, which also includes the
 * ruby annotation's own footprint and would throw the endpoints off the
 * kanji's true center — but the *font size* instead uses the full cell
 * width (kanji+ruby+kunten), per `MAX_UPOS_LABEL_LENGTH`'s own doc. Every
 * position is pixel coordinates relative to `column` (the same technique
 * `positionCompoundLines` uses); everything lives inside one
 * `.token-inspector-overlay` layer, a normal child of `column` (not
 * viewport-fixed), so it scrolls with the text for free inside the panel's
 * own `overflow-x: auto`. */
export function showInspector(column: HTMLElement, headEntry: Entry | null, entry: Entry): void {
  clearInspector(column);
  // Every character of the token, not just the one clicked: a multi-character
  // token is one word and one node of the parse, and marking a single
  // character of it said the selection was smaller than what the labels and
  // the arrow then describe. See `tokenCells` — and note that a fused span,
  // which looks the same on the page, is several tokens and still marks only
  // the member selected.
  const cells = tokenCells(entry);
  for (const cell of cells) {
    cell.classList.add("token-cell-selected");
    // Which of the two ways the cell is marked — see `.token-cell-inspected`
    // in kunten.css, where the reading answers in red rather than the
    // selection blue, and the kunten stand down. Spread with the selection:
    // a compound group's reading is divided across its characters, so
    // answering on one of them and not the rest would split one word's
    // reading between two colours.
    cell.classList.add("token-cell-inspected");
  }
  // And the character it attaches to, boxed the way a drop target is: the
  // arrow already points there, but following it back is work, and its far
  // end can be off the screen entirely. The whole of it, for the same reason
  // the selection marks the whole of its own token: the head is a word, and
  // boxing one character of 三百 while the arrow calls the pair a single node
  // said the relation attached to half a word.
  const headJoins = headEntry ? markHeadCells(tokenCells(headEntry)) : [];

  // The arrow lands on the token's *last* character. A relation arrives at a
  // word, and in vertical writing a word ends at its bottom edge, so an
  // arrowhead on the first character points into the middle of one.
  //
  // The part-of-speech chip does not follow it there, and that is deliberate:
  // it goes above the token or below it (see `placeSubtitle`), and above the
  // *last* character of a two-character word is *between* the two — inside
  // the word, on top of the first character's own furigana. So the chip takes
  // whichever end it is going to sit outside: the first character when it
  // goes above, the last when it goes below. For a single-character token the
  // two are the same cell and nothing changes.
  const firstGlyph = cells[0].querySelector<HTMLElement>(".kanji-glyph") ?? entry.glyph;
  const lastCell = cells[cells.length - 1];
  const lastGlyph = lastCell.querySelector<HTMLElement>(".kanji-glyph") ?? entry.glyph;

  const columnRect = column.getBoundingClientRect();
  const glyphRect = lastGlyph.getBoundingClientRect();
  const cellRect = lastCell.getBoundingClientRect();
  const fontSize = cellRect.width / MAX_UPOS_LABEL_LENGTH;

  const overlay = document.createElement("div");
  overlay.className = "token-inspector-overlay";

  let arrowPointsUp = false;

  if (headEntry) {
    const headRect = headEntry.glyph.getBoundingClientRect();
    const x1 = headRect.left + headRect.width / 2 - columnRect.left;
    const y1 = headRect.top + headRect.height / 2 - columnRect.top;
    const x2 = glyphRect.left + glyphRect.width / 2 - columnRect.left;
    const y2 = glyphRect.top + glyphRect.height / 2 - columnRect.top;
    arrowPointsUp = y1 > y2; // head sits below the token -> arrow runs upward

    // A quadratic bezier bulging perpendicular to the straight head->token
    // line, but *only* when head and token share a column (matching x) —
    // that's the one case the curve is needed at all, to stay visually
    // distinguishable from the kanji-cell grid lines it'd otherwise run
    // parallel to. An arc crossing from one column into another already
    // reads clearly on its own and is drawn as a plain straight line
    // instead (bulge 0, which also collapses the "true midpoint" formula
    // below to the ordinary segment midpoint).
    const sameColumn = Math.abs(x1 - x2) < 4;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    // Which side of the chord the arc bows to. Left to the normal, it
    // follows the direction the arc runs — left of the column for a head
    // above the token, right of it for a head below — and the right of a
    // column is where the ruby is, so half the arcs laid their apex and
    // their label across the reading. They go left always. The two normals
    // of a chord are one line in opposite directions, so negating both turns
    // the bow over and changes nothing else about it.
    if (sameColumn && nx > 0) {
      nx = -nx;
      ny = -ny;
    }
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    // How far the curve bows off the straight head->token chord: out to the
    // left border of the box drawn round the head, so that the apex and that
    // border are one line. The head is boxed for as long as the arc is on
    // the screen (`.token-cell-head .kanji-glyph`), and the two marks say the
    // same thing — this is the character at the far end — so the bow reaching
    // exactly as far out as the box does ties them together.
    //
    // Read off the box's own declared dimensions — `--head-box-size`, the
    // offset from the glyph to the outer edge of the border box, and
    // `--head-box-stroke`, the border drawn inward from there — so the line's
    // centre sits `size - stroke/2` beyond the glyph's edge. They are the
    // same two custom properties kunten.css draws the box from and steps
    // every annotation aside by, declared once on `:root`, so this stays true
    // if either changes and cannot drift out of step with the border.
    //
    // The *declared* dimensions and not the box as currently drawn, which is
    // the correction this line has now needed twice.
    //
    // It first read `outline-offset` and `outline-width` off the glyph, from
    // when the box was an outline, and went on reading them after the box
    // became a bordered pseudo-element (an outline cannot carry the halo the
    // box needs; see `.kanji-glyph::after` in kunten.css). Those properties
    // still resolve on an element that draws no outline at all: measured
    // live, `outline-style: none` with an `outline-width: 3px` left over from
    // the initial `medium`, which put the apex 1.5px past the glyph's edge.
    //
    // It then read `left` and `border-left-width` off the `::after` itself,
    // which was right until the box learned to grow. It is animated now — the
    // three lengths walk from 0 to their full size over 160ms as the
    // annotations step aside for them — and this runs in the same task that
    // adds `token-cell-head`, so the `::after` it measured was a box of
    // nothing: `|inset|` of 0, the `> 0` test below falling to its no-box
    // branch, and a peak of 22px where 25 was wanted. Measured on 長 -> 山:
    // the apex landed at 1079.1, the glyph's own left edge exactly, against a
    // border centre line at 1076.1 — three pixels short of the box it is
    // meant to meet, which is what the arc looked like before any box existed
    // at all.
    //
    // A declared value has no such moment: it is the size the box is going
    // to be, which is the size it has for all but the first sixth of a
    // second, and the arc is drawn once. The overlay fades in over that same
    // 160ms (`token-fade-in`), so the arc is not fully on the screen until
    // the box has finished arriving.
    //
    // The curve's own apex, not a control point: `hobbySplinePath` solves for
    // the departure angle whose *midpoint* offset is `peak` (a cubic passes
    // nowhere near its handles), so what is computed here is what appears.
    //
    // The head's box, not the token's: it is the head that is boxed, and a
    // cross-column arc has no bow at all.
    //
    // The `len` term keeps a short arc from bowing further than it is long.
    // At this geometry it never binds — the shortest same-column arc spans
    // one advance, 88px, and 0.4 of that is 35.2 against a peak of 25 — but
    // it would again if the advance fell below 63px, and a bow deeper than
    // its own chord is a loop rather than an arc.
    const headStyle = getComputedStyle(headEntry.glyph);
    const boxInset = parseFloat(headStyle.getPropertyValue("--head-box-size")) || 0;
    const boxStroke = parseFloat(headStyle.getPropertyValue("--head-box-stroke")) || 0;
    // No box declared at all (the properties are gone, or this is some future
    // caller drawing an arc to an unboxed character): the bow goes to the
    // glyph's own edge, which is where it went before any box existed.
    const boxBorder = boxInset > 0 ? boxInset - boxStroke / 2 : 0;
    const peak = sameColumn ? Math.min(headRect.width / 2 + boxBorder, len * 0.4) : 0;
    // A within-line (curved) arc's label is centred in the gutter between
    // this column of text and the next. Cells abut with no margin between
    // columns, so that gutter is exactly the run from one column's glyph
    // edge to the neighbouring column's — and its midpoint is the shared
    // cell boundary, half a cell width out from the glyph's own centre.
    // (Verified against a live two-column render: glyphs at x-centres 636
    // and 539 leave a 561..614 gutter centred on 587.5, which is 636 −
    // 96.8/2.) A cross-line (straight) arc has no "side" in that sense: it
    // runs between the columns rather than beside one, so it sits on the
    // arrow's own midpoint, which is what `peak` being 0 leaves here.
    const gutterOffset = cellRect.width / 2;
    const labelX = sameColumn ? midX + nx * gutterOffset : midX + nx * peak;
    // Down the page, both kinds sit on the arc's own middle. For the bowed
    // one that is the middle of the curve rather than of the chord it is
    // drawn across — `hobbySplinePath` solves its angle so the curve stands
    // exactly `peak` off the chord there, so the point wanted is the chord's
    // midpoint stepped that far along the same normal the bow uses. Where
    // the two columns line up exactly, as they do, `ny` is 0 and this is the
    // chord's midpoint; the term matters only for the few pixels of slack
    // `sameColumn` allows.
    const labelY = midY + ny * peak;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "token-arrow-svg");
    svg.setAttribute("width", String(columnRect.width));
    svg.setAttribute("height", String(columnRect.height));

    svg.append(arrowheadDefs(""));

    const d = hobbySplinePath(x1, y1, x2, y2, nx, ny, peak);
    // A wider white "casing" stroke directly under the real, narrower
    // accent-colored one — the same halo technique `.token-arrow-label`
    // uses (see its own doc) — is what keeps the arrow legible crossing
    // over body text or another arrow, since SVG has no stroke-outline
    // property equivalent to `-webkit-text-stroke`.
    const casingPath = document.createElementNS(SVG_NS, "path");
    casingPath.setAttribute("d", d);
    casingPath.setAttribute("class", "token-arrow-path-casing");
    casingPath.setAttribute("marker-end", "url(#token-arrowhead-casing)");
    svg.append(casingPath);

    // The lines joining the head's boxes, drawn here rather than in CSS
    // because this is where their paint order can be stated. They belong
    // *over* the arc's casing and *under* the arc itself: the casing is not a
    // mark but the clearance one mark keeps around itself, and it has no
    // business rubbing out another — while the arc is the thing the overlay
    // is for, so where the two cross it is the arc that runs on top and the
    // connector that passes beneath, which is how a crossing reads.
    //
    // Drawn between the two paths, since SVG paints in document order and
    // `z-index` does nothing between shapes in one `<svg>`. The arrowhead
    // rides on the arc's own path (a marker), so it is above the connector
    // too, which is the same judgement applied to the same mark.
    //
    // No casing of its own, deliberately. A connector runs in the gap between
    // two characters of one word, where this panel writes nothing else (see
    // `markHeadCells` on the compound tie), so the only thing it can meet is
    // the arc — and the arc's casing already separates the two, now from
    // above, where a halo does its work. A second halo would have nothing to
    // clear and would bite 2px out of the box borders it runs into.
    for (const join of headJoins) {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("class", "token-head-join");
      line.setAttribute("x1", String(join.x - columnRect.left));
      line.setAttribute("x2", String(join.x - columnRect.left));
      line.setAttribute("y1", String(join.top - columnRect.top));
      line.setAttribute("y2", String(join.bottom - columnRect.top));
      svg.append(line);
    }

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", "token-arrow-path");
    path.setAttribute("marker-end", "url(#token-arrowhead)");
    svg.append(path);
    overlay.append(svg);

    const label = document.createElement("div");
    label.className = "token-arrow-label";
    // The same string the retag menu will offer, brackets and all — the menu
    // opens *from* this label, and a reader who right-clicks 修飾語〖時間〗
    // must find 修飾語〖時間〗 marked as current in what opens. That makes
    // this label longer than it was: worst case 12 characters
    // (並列構成要素〖動詞連続〗) against the 9 it used to be, set vertically
    // and centred on the arc's midpoint, so it reaches about 1.5 characters
    // further above and below that point than before. Not measured on a
    // page — no browser was available — but the label already had no
    // avoidance behaviour of any kind (see the long note at the foot of this
    // function), so a longer one covers more and moves nothing, which is the
    // rule this overlay is built on rather than a regression in it.
    //
    // Through `setDeprelLabel` rather than `deprelJa` so the brackets get the
    // same recentring the menu's do — this label and the menu it opens are
    // the two places a 〖 is set, and a bracket that sat differently in the
    // two would read as two different marks.
    setDeprelLabel(label, entry.token.dep);
    label.style.left = `${labelX}px`;
    label.style.top = `${labelY}px`;
    label.style.fontSize = `${fontSize}px`;
    overlay.append(label);
  }

  const subtitle = document.createElement("div");
  subtitle.className = "token-subtitle";
  subtitle.textContent = uposJa(entry.token.pos);
  subtitle.style.left = `${glyphRect.left - columnRect.left + glyphRect.width / 2}px`;
  subtitle.style.fontSize = `${fontSize}px`;
  const placeSubtitle = (above: boolean) => {
    // Measured fresh off whichever end the chip is going to, so it clears the
    // whole token rather than one character of it — see the anchor note above.
    const edge = (above ? firstGlyph : lastGlyph).getBoundingClientRect();
    subtitle.classList.toggle("token-subtitle-above", above);
    subtitle.classList.toggle("token-subtitle-below", !above);
    subtitle.style.top = `${(above ? edge.top : edge.bottom) - columnRect.top}px`;
  };
  placeSubtitle(arrowPointsUp);
  overlay.append(subtitle);

  column.append(overlay);

  // Everything below needs real measured geometry, so it runs only now that
  // the overlay is actually in the document.

  // The casing for the whole apparatus, painted once and under all of it —
  // the arc's own, the arrowhead's, and now the two chips'. Drawn from the
  // chips as they came out, so it has to be here rather than beside them;
  // see `caseApparatus`, which is also where the paint order is argued and
  // where the reach the lift below needs is read.
  const casing = caseApparatus(overlay);

  // The readings the chip has landed on lift two kana up their own column out
  // of its way, and walk back when the analysis goes (`clearInspector`). See
  // `liftReadingsClear`, which is also where the other four marks are
  // accounted for.
  liftReadingsClear(column, overlay, casing);

  // The chip's side is the arrow's direction, and nothing else: an arrow
  // running up gets its chip above the character, one running down gets it
  // below. Placed at `placeSubtitle(arrowPointsUp)` above, and left there.
  //
  // It used to score both sides — kaeriten covered, in square pixels, with
  // clipping by the panel's top edge disqualifying — and take the cheaper
  // one, so a chip whose preferred side was occupied moved across. That is
  // deleted rather than tuned. The direction is the whole point of the
  // chip's position: it says which way the character's head lies, so the
  // pair of them read as one gesture. A chip that moves to the free side
  // says the opposite thing on a character whose sides happen to be busy,
  // and it is not recoverable by looking harder — nothing on the chip
  // records that it was displaced.
  //
  // The same judgement as the deprel label below, and for the same reason:
  // overlapping a kaeriten is what the rule costs, not a fault to work
  // around. A chip over a mark still reads, and moving the selection off
  // shows the mark; a chip on the wrong side is quietly wrong.

  // Nothing moves the label off that midpoint. There used to be a great deal
  // of machinery that did, and of machinery that moved readings out from
  // under it.
  //
  // The label was bounded to a band about the arc, scored over candidate
  // positions against a union of everything it might cover, re-measured over
  // four passes, and stepped sideways across the columns when none of that
  // worked. All of it went to keep it off the readings in a gutter with no
  // room to spare, and all of it is gone. Overlapping a reading is what the
  // rule costs, not a fault to be worked around: a label half over a reading
  // still says which relation it names, and a label anywhere but the arc's
  // midpoint has stopped naming it.
  //
  // The readings themselves were lifted out from under the part-of-speech
  // chip, and that is gone too, for a reason worth keeping: a reading
  // belongs to its character, and the lift moved it far enough to belong to
  // the next one. Measured on 學而時習之，不亦說乎？有朋自遠方來, it shifted
  // readings by 33 to 64px against a 44px character — 1.45 characters at
  // worst — and four of the five it touched ended up nearer a neighbouring
  // character than their own: 來's きタル 25px from 方 and 63px from 來, 時's
  // ときニ 17px from 而 and 71px from 時. By its own measure it succeeded,
  // the overlap being nought afterwards; what it had done was hand each
  // reading to the wrong character.
  //
  // Nor could a bound have saved it. The least it ever moved anything was
  // 33.37px, and that already put 而's テ nearer 學 — so a bound that kept a
  // reading with its character would have refused every lift it ever makes,
  // which is this same deletion with the machinery left in.
  //
  // The chip no longer chooses its own side either (see above) — it follows
  // the arrow. The overlay says where the parse puts things, and it says it
  // in the same place every time.
  //
  // What has come back is the *reading* moving, and only on the one thing
  // that argument does not cover: the chip, which is drawn on the character
  // being asked about and lands on that character's own okurigana. It steps
  // a lane — 15.2px, a fifth of what the deleted lift moved — so the
  // objection above does not reach it: the reading is still nearer its own
  // character than any other, which is the test the old lift failed at its
  // very smallest move. `liftReadingsClear` has the measurements, for that
  // mark and for the four this paragraph still covers.
}

/** The currently inspected entry, plus which panel it belongs to — kept so
 * arrow-key navigation (`navigate`) knows where to look and what to move
 * from without re-deriving it from a click event. Module-level rather than
 * threaded through `setupTokenInspector`'s closure since there's only ever
 * one kundoku panel using this module in the app. */
let selected: { container: HTMLElement; column: HTMLElement; entry: Entry; overlay: boolean } | null = null;

/** Marks, in the kakikudashi panel, whatever this token became there.
 *
 * Matched by token id within its sentence, which is what the pieces the
 * panel is built from carry (see `generateKakikudashiPieces`). One token
 * can own several runs — a word and its ending, a compound's members —
 * so every match is marked, not just the first. Cleared across the whole
 * document rather than within a container, since the two panels are
 * siblings and the selection lives in the other one.
 *
 * `null` clears without marking anything. */
function highlightKakikudashi(sentenceIndex: number, tokenId: number | null): void {
  for (const el of document.querySelectorAll(".kaki-token-selected")) el.classList.remove("kaki-token-selected");
  if (tokenId === null || sentenceIndex < 0) return;
  const match = `.kaki-token[data-sentence="${sentenceIndex}"][data-token-id="${tokenId}"]`;
  for (const el of document.querySelectorAll(match)) el.classList.add("kaki-token-selected");
}

/** Selects `entry`, optionally showing the analysis with it.
 *
 * The two are separate gestures: a left click picks a character out — the
 * highlight, here and in the kakikudashi — while a right click asks what
 * the parse makes of it, and only that draws the overlay. Reading the text
 * and interrogating it are different activities, and the labels and arrow
 * are a lot to put on the screen for someone doing the first. */
function selectEntry(container: HTMLElement, entry: Entry, showOverlay = false): void {
  const column = entry.cell.closest<HTMLElement>(".tategaki-column");
  if (!column) return;

  // Asking the same thing of the same character again changes nothing, so
  // nothing is redrawn. `showInspector` builds the overlay from scratch every
  // time — it has to, since it measures — and rebuilding it in place tore the
  // labels and the arrow off the screen and faded an identical set back in.
  // That is the flicker on a right click on the furigana: the gesture opens
  // the readings while the analysis is already up, and the analysis it left
  // standing was a new copy of itself.
  //
  // Both halves of the state have to match. A left click after a right click
  // is the same character at a different depth, and must still put the
  // analysis away. `isConnected` is what keeps a re-render from matching: it
  // re-selects through here, and its cells are new nodes, so the comparison
  // fails on identity as it should.
  if (selected && selected.entry.cell === entry.cell && selected.overlay === showOverlay && entry.cell.isConnected) {
    return;
  }
  if (showOverlay) {
    const gapEl = entry.cell.closest(".sentence-gap")!;
    const headEntry =
      entry.token.head !== entry.token.id
        ? resolveEntry(gapEl.querySelector<HTMLElement>(`.kanji-cell[data-token-id="${entry.token.head}"]`))
        : null;
    showInspector(column, headEntry, entry);
  } else {
    // `showInspector` would have marked the cell on its way; without it,
    // this does, after clearing whatever was marked before. Fading, since
    // nothing is replacing it: this is a plain selection, and any analysis
    // that was up is being put away.
    clearInspector(column, true);
    // The whole token, exactly as the overlay path marks it — see `tokenCells`.
    for (const cell of tokenCells(entry)) cell.classList.add("token-cell-selected");
  }
  highlightKakikudashi(sentenceIndexOf(entry.cell), entry.token.id);
  selected = { container, column, entry, overlay: showOverlay };
  entry.cell.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Puts down whatever was picked up — the whole of it, in both panels.
 *
 * `clearInspector` takes the three cell classes and the overlay the
 * analysis is drawn in (which is where the arc, its arrowhead and its
 * labels live, so removing the layer removes all three at once), and
 * `highlightKakikudashi(-1, null)` takes the matching highlight in the
 * prose. Every caller that lets a selection go comes through here — the
 * click on the character itself, Escape, and the click outside — so there
 * is one list of what a selection consists of rather than one per way of
 * ending it. */
function deselect(column: HTMLElement): void {
  clearInspector(column, true);
  highlightKakikudashi(-1, null);
  selected = null;
}

/** Re-renders both panels after this module edits the parse tree in place
 * (`applyTokenEdit`) — supplied by `main.ts`, which owns the current tree
 * and the resolver/index bundle a render needs. Without one set, edits
 * still mutate the tree but nothing redraws. */
let onTreeEdit: (() => void) | null = null;

export function setTokenEditHandler(handler: () => void): void {
  onTreeEdit = handler;
}

/** Which `.sentence-gap` (by position among its siblings) a cell belongs to
 * — token ids are unique only *within* a sentence, so restoring a selection
 * across a re-render needs both this and the id. */
function sentenceIndexOf(cell: HTMLElement): number {
  const gapEl = cell.closest(".sentence-gap");
  const column = gapEl?.parentElement;
  if (!gapEl || !column) return -1;
  return Array.prototype.indexOf.call(column.children, gapEl);
}

/** Mutates the selected token via `mutate`, re-renders through
 * `onTreeEdit`, then re-selects the same token in the freshly built DOM so
 * the inspector overlay stays put across the edit. The tokens reachable
 * from `sentenceByGap` are the very same objects inside `main.ts`'s
 * `TokenTree`, so mutating one here *is* editing that tree — no separate
 * write-back step. */
function applyTokenEdit(mutate: (token: Token) => void): void {
  if (!selected) return;
  const { token } = selected.entry;
  // Where a hand edit *to the selected token* passes through — the retag
  // menus and `promoteToRoot`'s multi-token rewrite — so one `withUndo`
  // covers the lot, and a multi-token edit is correctly one step rather
  // than several. The head drag calls `withUndo` itself instead, for the
  // reason `applySimpleReparent` gives.
  withUndo(() => mutate(token));
  rerenderPreservingSelection();
}

/** The redraw half of `applyTokenEdit`, on its own so an edit that touches
 * more than the selected token — or lands later, from an async relabel —
 * can reuse it instead of going through a token-shaped mutation it doesn't
 * fit. */
function rerenderPreservingSelection(): void {
  // Nothing selected (the user dismissed the inspector while an async
  // relabel was in flight) — still redraw, or the edit would sit in the
  // tree unshown until something else happened to trigger a render.
  if (!selected) {
    onTreeEdit?.();
    return;
  }
  const { container, entry } = selected;
  const wasShowingOverlay = selected.overlay;
  const sentenceIndex = sentenceIndexOf(entry.cell);
  const tokenId = entry.token.id;

  onTreeEdit?.();

  const gap = container.querySelectorAll<HTMLElement>(".sentence-gap")[sentenceIndex];
  const cell = gap?.querySelector<HTMLElement>(`.kanji-cell[data-token-id="${tokenId}"]`);
  const restored = resolveEntry(cell ?? null);
  if (restored) selectEntry(container, restored, wasShowingOverlay);
}

/** The `Sentence` a rendered cell belongs to, or null if the render it came
 * from has since been replaced. */
function sentenceOf(cell: HTMLElement): Sentence | null {
  const gapEl = cell.closest(".sentence-gap");
  return (gapEl && sentenceByGap.get(gapEl)) ?? null;
}

/** Asks the parser what it would call each of `childIds`'s arc to `headId`
 * and adopts the answers, redrawing once at the end.
 *
 * Deliberately after the fact: this round-trips to the Pyodide worker, so
 * the structural edit renders immediately and the labels catch up a moment
 * later. An arc the oracle can't reach comes back null and keeps whatever
 * label it had — see `scoreArc`. Each result is re-checked against
 * the live tree before being applied, since the user may have moved on. */
function relabelArcsUnder(sentence: Sentence, headId: number, childIds: number[]): void {
  if (childIds.length === 0) return;
  const text = sentence.tokens.map((t) => t.text).join("");
  const heads = sentence.tokens.map((t) => t.head);
  const deps = sentence.tokens.map((t) => t.dep);

  Promise.all(
    childIds.map((childId) =>
      scoreArc({ text, heads, deps, headIndex: headId, childIndex: childId })
        .then((arc) => ({ childId, label: arc?.label ?? null }))
        // Parser unavailable (e.g. a CoNLL-U-only session) — keep the
        // existing label for this arc rather than failing the whole batch.
        .catch(() => ({ childId, label: null as string | null })),
    ),
  ).then((results) => {
    let changed = false;
    for (const { childId, label } of results) {
      if (!label) continue;
      const token = sentence.tokens.find((t) => t.id === childId);
      if (!token || token.head !== headId || token.dep === label) continue;
      token.dep = label;
      changed = true;
    }
    if (changed) rerenderPreservingSelection();
  });
}

/** Asks the parser how sure it is of each of `edges`, keyed by the arc's
 * dependent.
 *
 * Measured against the sentence as it stands, which is where these arcs
 * live — so this must run before the edit that will break one of them. An
 * arc the transition oracle can't reach, or a session with no parser in it
 * at all (a CoNLL-U upload), comes back null: unknown, which
 * `planCycleBreak` is careful not to mistake for unconfident. */
async function arcConfidences(sentence: Sentence, edges: CycleEdge[]): Promise<Map<number, number | null>> {
  const text = sentence.tokens.map((t) => t.text).join("");
  const heads = sentence.tokens.map((t) => t.head);
  const deps = sentence.tokens.map((t) => t.dep);
  const scored = await Promise.all(
    edges.map((edge) =>
      scoreArc({ text, heads, deps, headIndex: edge.head, childIndex: edge.child })
        .then((arc) => [edge.child, arc?.confidence ?? null] as const)
        .catch(() => [edge.child, null] as const),
    ),
  );
  return new Map(scored);
}

/** Makes `entry`'s token the ROOT of its sentence.
 *
 * Rooting a token isn't the one-arc relabel the rest of the deprel menu
 * performs. A sentence has exactly one root — `computeReadingOrder` finds
 * it by its `head === id` self-link and throws when there isn't one — so
 * simply writing ROOT onto a second token would leave two, and the old
 * root's own dependents still hanging off a token that is no longer the
 * head of anything.
 *
 * So the old root's dependents come across to the new root, and the old
 * root joins them (its self-link is what the filter below matches it by).
 * Every other arc in the sentence is left alone: this re-hangs the top of
 * the tree, it doesn't reanalyse it.
 *
 * No cycle can result. The new root's own outgoing arc is replaced by its
 * self-link, so the path that used to run from it up to the old root is
 * broken at the top before anything is re-pointed downward at it. */
function promoteToRoot(entry: Entry): void {
  const sentence = sentenceOf(entry.cell);
  if (!sentence) return;
  const newRootId = entry.token.id;
  const oldRoot = sentence.tokens.find((t) => t.head === t.id);

  // Already the root: nothing to move, but the label may still be stale
  // (a token can carry a non-ROOT dep while holding the self-link).
  if (!oldRoot || oldRoot.id === newRootId) {
    applyTokenEdit((token) => {
      token.head = token.id;
      token.dep = "ROOT";
    });
    return;
  }

  const moved = sentence.tokens.filter((t) => t.head === oldRoot.id && t.id !== newRootId).map((t) => t.id);

  applyTokenEdit((token) => {
    for (const t of sentence.tokens) {
      if (moved.includes(t.id)) t.head = newRootId;
    }
    token.head = token.id;
    token.dep = "ROOT";
  });

  // Every moved arc described its relation to the *old* root, so it is
  // now describing the wrong head — including the old root's own, which
  // was "ROOT" and certainly isn't any more.
  relabelArcsUnder(sentence, newRootId, moved);
}

/** The cycle that re-parenting `childId` under `newHeadId` would close, or
 * null if it would close none.
 *
 * A cycle happens exactly when `newHeadId` sits inside `childId`'s own
 * subtree, so that following `head` links up from it comes back around. The
 * cycle is then the tokens on that upward walk: this returns them in walk
 * order, `[newHeadId, …, childId]`, which is the drop target first and the
 * dragged token last.
 *
 * `computeReadingOrder` recurses over the tree with no cycle guard of its
 * own and would hang on one, so a cycle can never be left standing — but it
 * is *broken*, not refused (see `planCycleBreak`). The reader's edge wins
 * and the parse gives up its least confident claim to make room for it.
 *
 * Null also for a tree that was already malformed before the drag (the
 * guard runs out): there is no single cycle to name in that case, and the
 * drag is not what put it there. */
export function cyclePath(sentence: Sentence, childId: number, newHeadId: number): number[] | null {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const path: number[] = [];
  let cursor: Token | undefined = byId.get(newHeadId);
  for (let guard = 0; cursor && guard <= sentence.tokens.length; guard++) {
    path.push(cursor.id);
    if (cursor.id === childId) return path;
    if (cursor.head === cursor.id) return null; // reached ROOT
    cursor = byId.get(cursor.head);
  }
  return null;
}

/** One `child -> head` arc, as a thing that can be weighed and dropped. */
export interface CycleEdge {
  child: number;
  head: number;
  dep: string;
}

/** The arcs a cycle could be broken at, best candidate order.
 *
 * Every arc on the cycle *except* the reader's own: they dragged `childId`
 * onto its new head and that edge is the point of the exercise, so it is
 * never the one that gives way. What is left is one arc per other token on
 * the cycle — each still pointing at the head it had before the drag.
 *
 * Ordered from the dragged token outward: the arc that ran *into* it comes
 * first, then its own head's, and so on back round to the drop target. The
 * order only decides ties and the no-score fallback (see `planCycleBreak`),
 * and this is the end to start from — the arc into the dragged token is the
 * one its new head most directly displaces, and dropping it turns the
 * branch the reader dragged towards into the branch that takes over the
 * dragged token's old place. */
export function cycleBreakCandidates(sentence: Sentence, cycle: number[], childId: number): CycleEdge[] {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  return [...cycle]
    .reverse()
    .filter((id) => id !== childId)
    .flatMap((id) => {
      const token = byId.get(id);
      return token ? [{ child: token.id, head: token.head, dep: token.dep }] : [];
    });
}

/** What breaking the cycle will cost — decided, but not yet carried out. */
export interface CycleBreak {
  /** `[newHead, …, child]`, as `cyclePath` gives it. */
  cycle: number[];
  /** The arc that goes. */
  dropped: CycleEdge;
  /** The parser's confidence in the dropped arc, or null where it could not
   * score it — see `scoreArc`. */
  confidence: number | null;
  /** How many arcs the choice was made between. One means there was nothing
   * to choose and the confidence decided nothing. */
  candidateCount: number;
  /** The head the dropped arc's dependent takes instead; null means it
   * becomes the sentence's ROOT. */
  reattachTo: number | null;
}

/** Chooses which arc of the cycle to drop, and where its dependent goes.
 *
 * `confidences` is keyed by an arc's *dependent* — one entry per candidate,
 * as measured by `arcConfidences` against the tree the arcs live in, which
 * is the tree as it stands *before* the drag is applied. Call this before
 * applying it: `reattachTo` is read off the dragged token's current head.
 *
 * The least confident arc goes. An arc the parser could not score is
 * *unknown*, not unconfident, and never displaces one with a real score —
 * so scored candidates are ranked among themselves and an unscored one is
 * taken only when there is nothing else at all. That fallback is the first
 * candidate, which is the arc running into the dragged token (see
 * `cycleBreakCandidates`); the reader is told when it was used, because a
 * guess and a measurement should not look alike.
 *
 * Where the dependent goes is forced, not chosen. The dragged token's old
 * head is outside the cycle by construction — every token on the cycle
 * except the dragged one keeps its old head, and the dragged one's old head
 * cannot be on the cycle or the cycle would have closed without the new
 * edge — so re-hanging the orphan there is always safe. Unless the dragged
 * token *was* the root, in which case there is no old head and the sentence
 * needs a new root: the orphan takes it, since the cycle has just been cut
 * out of the tree's top and it is the piece left holding nothing. */
export function planCycleBreak(
  sentence: Sentence,
  childId: number,
  newHeadId: number,
  confidences: ReadonlyMap<number, number | null>,
): CycleBreak | null {
  const cycle = cyclePath(sentence, childId, newHeadId);
  if (!cycle) return null;
  const child = sentence.tokens.find((t) => t.id === childId);
  const candidates = cycleBreakCandidates(sentence, cycle, childId);
  // Nothing to drop: a token dropped on itself, which `canDropOn` refuses
  // anyway. Refusing here too rather than trusting that is what keeps this
  // function safe to call on any pair.
  if (!child || candidates.length === 0) return null;

  let dropped = candidates[0];
  let confidence: number | null = null;
  for (const candidate of candidates) {
    const score = confidences.get(candidate.child) ?? null;
    if (score === null) continue;
    if (confidence === null || score < confidence) {
      dropped = candidate;
      confidence = score;
    }
  }

  return {
    cycle,
    dropped,
    confidence,
    candidateCount: candidates.length,
    reattachTo: child.head === child.id ? null : child.head,
  };
}

/** Carries out `plan` together with the drag that occasioned it — the two
 * are one edit, and the tree is only a tree again once both are done. */
export function applyCycleBreak(sentence: Sentence, childId: number, newHeadId: number, plan: CycleBreak): void {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const child = byId.get(childId);
  const orphan = byId.get(plan.dropped.child);
  if (!child || !orphan) return;
  child.head = newHeadId;
  // A token that has just stopped being the root cannot still be labelled
  // ROOT: that label means "no head", and this one now has one. The parser
  // renames the arc a moment later (`relabelArcsUnder`), but a session with
  // no parser in it — a CoNLL-U upload — would otherwise be left showing two
  // ROOTs, one of them false.
  if (child.dep === "ROOT") child.dep = "dep";
  if (plan.reattachTo === null) {
    orphan.head = orphan.id;
    orphan.dep = "ROOT";
  } else {
    orphan.head = plan.reattachTo;
  }
}

/** Throws unless `sentence` is a single-rooted tree with no cycle in it.
 *
 * Not a nicety. `computeReadingOrder` finds the root by its `head === id`
 * self-link and throws without one, and it recurses down the tree with no
 * cycle guard — so a second root, or a cycle anywhere, is a hang or a throw
 * in the render rather than a wrong-looking arrow. Every cycle-breaking
 * edit is checked through here before anything is drawn from it. */
export function assertSingleRootedTree(sentence: Sentence): void {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const roots = sentence.tokens.filter((t) => t.head === t.id).map((t) => t.id);
  if (roots.length !== 1) {
    throw new Error(`tokenInspector: sentence must have exactly one ROOT, found ${roots.length} (${roots.join(", ")})`);
  }
  for (const token of sentence.tokens) {
    let cursor: Token | undefined = token;
    for (let guard = 0; guard <= sentence.tokens.length; guard++) {
      if (!cursor) throw new Error(`tokenInspector: token ${token.id} heads to a token that isn't in the sentence`);
      if (cursor.head === cursor.id) break;
      cursor = byId.get(cursor.head);
      if (guard === sentence.tokens.length) {
        throw new Error(`tokenInspector: head chain from token ${token.id} cycles`);
      }
    }
  }
}

/** Arrow-key navigation from the currently selected kanji: up/down step to
 * the previous/next kanji in reading order (see `collectEntries`);
 * left/right jump a whole column ("line"), landing on whichever entry in
 * the adjacent column sits closest to the current one's own vertical
 * position — vertical-rl reads column-by-column *leftward*, so left is the
 * next line, right the previous one. Punctuation is never a stop (already
 * excluded by `collectEntries`/`resolveEntry`). No-op past either end. */
function navigate(direction: "up" | "down" | "left" | "right"): void {
  if (!selected) return;
  const { container, entry } = selected;
  const entries = collectEntries(container);
  const index = entries.findIndex((e) => e.cell === entry.cell);
  if (index === -1) return;

  if (direction === "down" || direction === "up") {
    const next = entries[index + (direction === "down" ? 1 : -1)];
    if (next) selectEntry(container, next, selected?.overlay ?? false);
    return;
  }

  const columns = groupByColumn(entries);
  // `entries`/`columns` are freshly built each call (`resolveEntry` makes a
  // new wrapper object every time), so `entry` itself is never the same
  // reference as anything inside `columns` even for the very cell it came
  // from — comparing by `.cell` (a real, stable DOM element) is what
  // actually finds it.
  const colIndex = columns.findIndex((col) => col.some((e) => e.cell === entry.cell));
  if (colIndex === -1) return;
  const targetCol = columns[colIndex + (direction === "left" ? 1 : -1)];
  if (!targetCol) return;
  const y = entry.cell.getBoundingClientRect().top;
  const closest = targetCol.reduce((best, candidate) =>
    Math.abs(candidate.cell.getBoundingClientRect().top - y) < Math.abs(best.cell.getBoundingClientRect().top - y) ? candidate : best,
  );
  selectEntry(container, closest, selected?.overlay ?? false);
}

/** The open context menu, if any — module-level so any of the several
 * things that should dismiss it (a click elsewhere, Escape, scrolling, a
 * re-render) can close it without threading a reference around. */
let openMenu: HTMLElement | null = null;

/** Closes the open menu. `immediate` only where another menu is about to
 * take its place in the same spot — two menus fading through each other
 * there read as one menu flickering. */
function closeContextMenu(immediate = false): void {
  if (openMenu) {
    if (immediate) openMenu.remove();
    else fadeOutAndRemove(openMenu);
  }
  openMenu = null;
}

/** Opens the retag menu for one annotation — right-clicking the UPOS
 * subtitle offers this parser's whole UPOS inventory, right-clicking the
 * deprel label its whole relation inventory (`UPOS_GROUPS`/`DEPREL_GROUPS`),
 * with the token's current value marked. Picking one edits the tree in place and
 * re-renders (see `applyTokenEdit`). Each menu belongs to the label it
 * retags, so there's no ambiguity about which of the two a right-click
 * meant — and the kanji itself stays free for plain selection and
 * head-dragging.
 *
 * Set in tategaki like the text it annotates, and laid out as a
 * dictionary-style table: entries run top-to-bottom and wrap into further
 * columns leftward (`.token-context-menu`'s own flex-wrap in vertical-rl —
 * see kunten.css). Entries keep their inventory order rather than being
 * re-sorted by kana: `UPOS_GROUPS`/`DEPREL_GROUPS` are already written in
 * grammatical order (nominals, then verbals, then function words; core
 * arguments, then modifiers, then coordination), which is how a printed
 * grammar table groups them and is far easier to scan for the value you
 * want than gojūon would be.
 *
 * **One row per base relation.** The relation menu is not a flat list of
 * relations any more. It is a list of *bases*, each with its subtypes inline
 * inside a 〖〗 and each piece separately pickable: 修飾語〖時間・場所〗 is one
 * row in which 修飾語 sets `mod`, 時間 sets `mod@tmod` and 場所 sets
 * `mod@lmod`. `deprelMenuRows` decides the pieces (pure, and tested over the
 * whole inventory); `makeRow` below only draws them. Thirty-four entries
 * become twenty-three rows, and the eight relations that were previously
 * repeating their base's name in full now cost two characters each instead of
 * five or seven.
 *
 * **What that does to the wrap.** Each row is a `white-space: nowrap` atom
 * set down the inline (vertical) axis, so its total label length *is* its
 * `offsetHeight`, and `sizeMenuSquarish` wraps the column run by summing
 * exactly those. What changed with the nesting is the sum. The 34 flat labels
 * came to 202 characters; the 23 rows come to 143 (the brackets and the ・
 * counted in — both figures are asserted in `tests/deprelLabels.test.ts`), and
 * 11 fewer boxes save another 11 lots of the 0.7rem of padding and 0.1rem of
 * gap each one carried. At 20px a character that is 4818px of inline extent
 * before and 3497px after, a factor of 0.726. Column *width* is untouched: no
 * row is wider across the run than an entry was, a row being a single
 * vertical text column like any other, so `w` stays the 35.25px the flat
 * menu's own measurement implies (484.3px over 13 columns, less the box).
 *
 * **And what a category per column does to it.** Every heading now starts at
 * the top of a fresh column (`appendMenuGroup`, and `.token-context-menu` in
 * kunten.css), which is a second, opposite pressure on the same shape: the
 * table can no longer be shorter than five columns however tight the cap goes,
 * and each of the five ends in a part-column that the flat run would have
 * filled from the next category. `sizeMenuSquarish` carries the arithmetic in
 * full; the prediction it made was 12 columns and a box of roughly 471 x 442,
 * against the roughly 414 x 370 the same 23 rows made when the categories ran
 * on from one another.
 *
 * **Measured, at last, on a page.** 12 columns and **471.1 x 428.2** at
 * 1292x792 — the width to a tenth of a pixel and the height 14px under. Two
 * things not in the arithmetic paid for the difference and pulled in opposite
 * directions. The rows were each 12px longer than the formula said, a
 * `<button>`'s UA padding nobody had reset (`.token-menu-seg` in kunten.css
 * carries the whole account); and the two brackets of a row are half-width
 * now, so a bracketed row is 10px shorter per bracket
 * (`.subtype-bracket-open`, same file). What a row measured then was
 *
 *     20n − 10b + 11.2      n characters, b of them 〖 or 〗
 *
 * — 主語 at 51.19 and 補語〖形式〗 at 111.19.
 *
 * **The menu is set on a grid now**, and a row's length is a whole number of
 * cells — a cell being one character's advance, 20px at the menu's 1.25rem.
 * The whole of the arithmetic is
 *
 *     20 · ( Σ (len + 1) over the words, + 1 per bracket )
 *
 * — every word (a pickable segment or the inert 補語 label) takes its own
 * characters plus one cell of padding, 二分 at each end; every bracket takes
 * one cell, 二分 of ink and 二分 of aki; and the ・ takes **nothing**, its 二分
 * of ink standing in the 四分 each of the two words beside it gives up. There
 * is no term for how many pieces are pickable and none for which of the row's
 * ends are held by an inert piece: every piece is padded now, so neither
 * question arises. `.token-context-menu` in kunten.css argues the grid in
 * full; `tests/menuRowPadding.test.ts` holds this model and checks over the
 * whole inventory that every character of every row lands on it.
 *
 * 主語 is 60 by it, 補語〖形式〗 160, 斜格補語〖場所〗 200 and
 * 修飾語〖時間・場所〗 240; the 23 rows sum to 3500px of inline extent, against
 * 3206.8 with the segments padded at 0.35rem and 3027.6 before that. Those
 * figures are arithmetic, not measurement — there has been no browser for any
 * of the last three rounds — but the same model reproduces the three rows that
 * *were* measured with the 二分 in place and the segments still unpadded
 * (161.18 / 121.18 / 201.18, against 161.20 / 121.20 / 201.20 computed).
 *
 * The longest row is still the thing to watch, and it is still
 * 並列構成要素〖動詞連続・外来語〗 at 16 characters: 311.19px when it was
 * measured, 321.2 once the 二分 arrived, 349.2 with its three segments padded
 * at 0.35rem and 360 on the grid, where the flat menu's longest entry was 12
 * characters and 251px.
 * `sizeMenuSquarish`'s floor is the tallest atom, so that row is what stops
 * `shrinkMenuToContent` from tightening the cap below it however much dead
 * space is left — and the figure that floor sits at has moved twice, which
 * is worth knowing before reading the caps recorded there.
 * Nothing breaks when it runs into it: the menu simply stops going squarer.
 * What it means is that `flat`'s row is the single biggest lever on this
 * menu's shape, which was not true of any one entry before.
 *
 * The deprel menu opens from the arrow label, which only a token that has
 * a head carries — so it is never reached on a ROOT token, and the entry
 * for ROOT in the list is how a *different* token is made the root (see
 * `promoteToRoot`), not how one stops being it. Un-rooting on its own has
 * no meaning anyway: it would leave the sentence with no root at all.
 * Correcting a mis-rooted parse is therefore always the same gesture —
 * pick out the token that should have been the root and say so. */
/** The faintest a retag-menu entry is ever drawn.
 *
 * Picked by looking at it in both themes rather than derived from a
 * contrast figure, because what is being judged is whether a word is
 * comfortable to *read* at a glance while choosing between it and sixteen
 * others — not whether it clears a threshold.
 *
 * 0.38 was fine in the light theme, where the ink is near-black on cream,
 * and too dim in the dark one: light ink faded on a near-black panel loses
 * its thin strokes first, and the entries that go with them (限定詞, 感動詞,
 * 句読点) were legible but a strain. 0.46 reads cleanly on both grounds and
 * still leaves the shading unmistakable — on 半 it is the floor against
 * 名詞 at 0.62, 副詞 at 0.88 and 動詞 at 0.98.
 *
 * These are options someone is reading in order to choose between them, so
 * this is a floor and not a target: nothing is ever drawn fainter, however
 * small its probability. */
const MENU_MIN_OPACITY = 0.46;

/** The probability at or below which an option is drawn at the floor.
 *
 * The distributions run over many orders of magnitude — the parser puts
 * 3e-10 on some relations — so opacity follows the logarithm, and the
 * logarithm needs a bottom. A thousandth is where the difference stops
 * meaning anything to a reader: everything below it is "the model would not
 * have said this", and how emphatically it would not have is not a
 * distinction worth a shade. */
const MENU_FAINT_BELOW = 1e-3;

/** Maps a model probability onto the opacity its menu entry is drawn at.
 *
 * Logarithmic between `MENU_FAINT_BELOW` and 1, so the interesting range is
 * spread out instead of being crushed against the floor: on a linear map
 * every relation under a tenth would have looked identical, and most of
 * them are. Zero — a tag the model cannot emit, or a relation the
 * transition system ruled out — lands on the floor like any other
 * vanishingly unlikely one, which is what it is. */
export function opacityForLikelihood(probability: number): number {
  if (!(probability > MENU_FAINT_BELOW)) return MENU_MIN_OPACITY;
  const span = Math.log10(1 / MENU_FAINT_BELOW);
  const t = Math.min(1, Math.log10(probability / MENU_FAINT_BELOW) / span);
  return MENU_MIN_OPACITY + (1 - MENU_MIN_OPACITY) * t;
}

/** Draws each entry of an open retag menu at the opacity its likelihood
 * earns.
 *
 * All or none: once a menu is shaded, every entry in it is shaded. An entry
 * left solid among faded ones is the most prominent thing on the screen,
 * which reads as the model's pick whatever was meant by it — so "the model
 * has nothing to say about this one" cannot be rendered by leaving it
 * alone. Unshaded is a state the whole menu is in or isn't (see
 * `shadeRetagMenu`, which shades nothing at all if the model can't answer).
 *
 * The value the token already carries is shaded along with the rest. It is
 * marked by weight and colour instead (`data-current`, see kunten.css), and
 * those say a different thing from the shading: one that this is the tag on
 * the character, the other what the model makes of that tag. Exempting it
 * hid the second behind the first on precisely the entry a reader has most
 * reason to ask about — a relation the parser puts a thousandth on looked as
 * settled as one it puts 0.999 on.
 *
 * A custom property rather than `opacity` directly, so the rule that keeps
 * the hovered entry solid can simply set `opacity` and win on specificity
 * (see `.token-menu-item` in kunten.css).
 *
 * **Per segment, not per row.** In the relation menu a row is no longer one
 * option but two or three — 修飾語, 時間 and 場所 are three relations sharing
 * a line — and each has its own probability, so each is shaded on its own.
 * That is a gain rather than a complication: which subtype the parser prefers
 * is now visible without opening anything, and 修飾語 drawn solid beside a
 * faint 時間 says something a single opacity for the whole row could not say
 * at all.
 *
 * **The brackets, the ・ and 補語 are not shaded at all.** They belong to no
 * relation, so there is no likelihood to ask about them — and that is the
 * reason, not a weak claim about the parser. Opacity in this menu means one
 * thing, how likely a relation is; a mark that is not a candidate has no
 * position on that axis, and putting it at the floor said "very unlikely"
 * about something that cannot be likely or unlikely at all.
 *
 * They were at the floor until now, on the argument that solid-among-faded
 * reads as the model's pick and a 〖 has no business reading that way. The
 * argument is sound about *prominence* and wrong about the *instrument*: the
 * pick is not signalled by solidity, it is signalled by weight and hue
 * (`data-current` — bold, and `--color-highlight`), and structure has its own
 * hue already. So the distinction moves off opacity and onto colour, which is
 * where the rest of this menu's structure/choice distinction already lives —
 * the group headings are `--color-ink-soft` at full opacity and always have
 * been, and after this change every structural mark in the menu is drawn the
 * one way with no exceptions.
 *
 * What that cost in legibility, measured rather than guessed (sRGB relative
 * luminance, the two theme palettes in app.css, the floor being 0.46):
 *
 *                          light            dark
 *     bracket, floor       1.99 : 1         2.41 : 1     <- what was reported
 *     bracket, full        5.92 : 1         6.41 : 1
 *     entry, full         17.37 : 1        13.63 : 1
 *     the pick (blue)      8.26 : 1         7.60 : 1
 *
 * against the panel. A bracket at the floor was under 3:1 in both themes,
 * which is below what WCAG asks of a *non-text* mark, let alone a glyph;
 * at full strength it clears 4.5:1 in both, and is still 2.9x (light) and
 * 2.1x (dark) lighter than a solidly-drawn entry, so it cannot be mistaken
 * for the most confident option in the menu. It *is* more contrasty than an
 * option the model has nearly ruled out (2.96:1 light, 3.92:1 dark) — which
 * is the trade being made, and the right way round: a bracket that is easier
 * to see than a relation the parser has dismissed is a menu whose structure
 * survives its own shading.
 *
 * Both figures come from theme tokens, so this holds in dark as well as light
 * without a second rule — checked against the palette rather than inferred:
 * `--color-ink-soft` is `#6b6357` on the page and `#a89e8c` in the dark
 * theme, 5.92:1 and 6.41:1 against their own panels. Not looked at in a
 * browser; there was none. */
function shadeMenuItems(menu: HTMLElement, likelihood: (value: string) => number): void {
  const shade = (el: HTMLElement, probability: number) =>
    el.style.setProperty("--menu-item-opacity", opacityForLikelihood(probability).toFixed(3));
  // `.token-menu-item` is the POS and readings menus' whole entry;
  // `.token-menu-seg` is one pickable piece of a relation row. Both carry the
  // raw tag on `data-value`, which is what the model answered about.
  for (const item of menu.querySelectorAll<HTMLElement>(".token-menu-item[data-value], .token-menu-seg[data-value]")) {
    shade(item, likelihood(item.dataset.value!));
  }
  // And nothing else. `.token-menu-punct` and `.token-menu-label` are left
  // alone on purpose (see this function's doc): they carry no `data-value`
  // because there is no relation for the model to have an opinion about, and
  // they are told apart from the options by colour instead.
}

/** Asks the model what it makes of each option in a just-opened retag menu
 * and shades them accordingly.
 *
 * After the fact, like `relabelArcsUnder`: this is a round trip to the
 * Pyodide worker (measured at ~8ms for the tag distribution, ~45ms for the
 * arc), and a menu that waited for it would be a menu that opens late. It
 * opens at once, unshaded, and settles a moment later — which is also
 * exactly how it stays if there is no parser in the session at all.
 *
 * Two different pipes answer, one per menu: the morphologizer's UPOS
 * distribution for 品詞, the parser's relation distribution for 係り受け.
 * Neither is a proxy for the other, and neither is invented.
 *
 * ROOT is the awkward entry. In the 係り受け menu it does not name a relation
 * this arc could have — it restructures the top of the tree (see
 * `promoteToRoot`) — and the parser has no `L-ROOT`/`R-ROOT` move to score
 * it with anyway; its root is a `B-ROOT` break, an answer to a different
 * question. So it gets the floor, and that is a decision about the drawing
 * rather than a claim about the model: no number was put on it, and leaving
 * it solid instead made it the boldest plain entry in a menu of faded ones,
 * which reads as the recommendation it is least entitled to be. At the
 * floor it is legible, pickable, and says nothing. */
async function shadeRetagMenu(kind: "pos" | "dep", entry: Entry, menu: HTMLElement): Promise<void> {
  const sentence = sentenceOf(entry.cell);
  if (!sentence) return;
  const text = sentence.tokens.map((t) => t.text).join("");
  try {
    if (kind === "pos") {
      const distribution = await posScores({ text, tokenCount: sentence.tokens.length, tokenIndex: entry.token.id });
      // The reader may have moved on, or opened a second menu, while this
      // was in flight — shade the menu that asked, or nothing.
      if (!distribution || openMenu !== menu) return;
      // Every entry asks about itself, 形容詞 included. It had to ask about
      // VERB while the app was synthesising the adjective out of a feature and
      // the morphologiser had no class of that name — a missing key would have
      // put it at the floor, which was not what the model said. 0.3.2 emits
      // `ADJ` (P 85.12 / R 83.52 / F 84.31 on the release's own figures), so
      // the entry gets the model's real answer and the special case goes.
      shadeMenuItems(menu, (value) => distribution[value] ?? 0);
      return;
    }
    // Never reached on a ROOT token (the deprel menu opens from the arrow
    // label, which a rootless token doesn't have), but there is no arc to
    // ask about if it were.
    if (entry.token.head === entry.token.id) return;
    const arc = await scoreArc({
      text,
      heads: sentence.tokens.map((t) => t.head),
      deps: sentence.tokens.map((t) => t.dep),
      headIndex: entry.token.head,
      childIndex: entry.token.id,
    });
    if (!arc || openMenu !== menu) return;
    shadeMenuItems(menu, (value) => arc.labels[value] ?? 0);
  } catch {
    // No parser in this session — a CoNLL-U upload annotates a tree the
    // model never saw. An unshaded menu is the honest rendering of having
    // no opinion, and is what the reader already had.
  }
}

/** One relation row as DOM: 修飾語〖時間・場所〗, in which 修飾語 sets `mod`,
 * 時間 sets `mod@tmod` and 場所 sets `mod@lmod`.
 *
 * The row itself is inert — a plain `<div>` with no handler and nothing to
 * hover. Every gesture in it belongs to a segment, and the segments are the
 * relations. What is drawn in between them (the 〖, the ・, the 〗, and a base
 * name SUD never writes bare) is drawn as a `<span>`: not a button, so not
 * focusable, not in the tab order, and with no click to make. A click that
 * lands on one does nothing at all and leaves the menu open, which is the
 * recoverable failure — the alternative, giving the bracket to the segment
 * beside it, would apply a relation the reader did not point at, and there is
 * no obviously right neighbour anyway (〖 sits between the base and its first
 * subtype, and belongs to both).
 *
 * The reason a row cannot itself be a `<button>` — which is what an entry was
 * before the menu nested — is simply that buttons don't nest.
 * `.token-menu-row` in kunten.css therefore carries the row across the run —
 * the figure that sets the column's width — and each `.token-menu-seg`
 * carries the ink, the behaviour, and its own padding along the run, which is
 * an entry's padding and is what the highlight fills.
 *
 * `onPick` is optional, and its absence is what the help modal's figure is
 * built from: the same rows, marked the same way, with nothing to click and
 * nothing in the tab order. That the tutorial and the menu draw a row through
 * one function rather than two is the point of exporting this — a figure that
 * hand-built its own version of a composite row would drift from the menu the
 * first time the composition changed, which is exactly what happened to the
 * flat figure this replaced. */
export function deprelRowElement(
  row: DeprelMenuRow,
  current?: string,
  onPick?: (value: string) => void,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "token-menu-row";
  for (const segment of row.segments) {
    if (segment.kind !== "relation") {
      const span = document.createElement("span");
      // The bracket class is additive: `.token-menu-punct` carries the ink and
      // the inertness, `.subtype-bracket-*` the recentring, and the ・ takes
      // only the first (it is centred in its own em already — measured; see
      // kunten.css).
      span.className = `${segment.kind === "punct" ? "token-menu-punct" : "token-menu-label"} ${
        segment.kind === "punct" ? subtypeBracketClass(segment.text) : ""
      }`.trim();
      span.textContent = segment.text;
      // A base with no bare form still answers "what is this called in
      // SUD?", which is the question the tooltip exists for.
      if (segment.kind === "label") span.title = segment.value;
      el.append(span);
      continue;
    }
    const seg = document.createElement("button");
    seg.type = "button";
    seg.className = "token-menu-seg";
    seg.dataset.value = segment.value;
    // On the segment, never on the row. The token carries exactly one
    // relation, and 修飾語〖時間〗 being current is a statement about 時間 —
    // marking the whole row would say the token was `mod`, `mod@tmod` and
    // `mod@lmod` at once. Bold-and-blue on 修飾語 and bold-and-blue on 時間
    // are then two visibly different rows at a glance, which is the
    // distinction the flat menu drew by having two separate entries.
    if (segment.value === current) seg.dataset.current = "true";
    seg.textContent = segment.text;
    seg.title = segment.value;
    if (onPick) seg.addEventListener("click", () => onPick(segment.value));
    else seg.tabIndex = -1;
    el.append(seg);
  }
  return el;
}

/** Files one category's entries under its heading and hangs the result on the
 * menu, as one `.token-menu-group` — the box that wraps that category's
 * entries into columns of its own, and so the box that makes every heading
 * start at the top of a fresh column.
 *
 * The heading is one line of smaller characters, tracked out to a whole cell
 * each so that they stand on the same grid the entries below them do.
 * Nothing is needed here for that — it is `letter-spacing` and a
 * `text-indent`, and `.token-menu-heading` carries the arithmetic.
 *
 * The heading is bound together with its own first entry in one
 * `.token-menu-group-lead`, which the wrap treats as a single atom. That
 * mattered more when the whole menu was one flow and a heading could be left
 * stranded at the foot of a column; here it is what keeps the pair from being
 * split by a cap tight enough to fit the heading alone (see
 * `sizeMenuSquarish`, whose floor is the tallest atom).
 *
 * All three menus come through here — the relation menu's rows, the
 * part-of-speech menu's tags, the readings menu's candidates — which is why
 * "start each category on a new line" needed one change rather than three. */
export function appendMenuGroup(menu: HTMLElement, heading: string, entries: HTMLElement[]): void {
  // A category with nothing in it would still take a column, headed and
  // empty. The readings menu already skips those (it filters by kind); this
  // makes it true of any caller.
  if (entries.length === 0) return;
  const group = document.createElement("div");
  group.className = "token-menu-group";
  const lead = document.createElement("div");
  lead.className = "token-menu-group-lead";
  const title = document.createElement("div");
  title.className = "token-menu-heading";
  title.textContent = heading;
  lead.append(title, entries[0]);
  group.append(lead, ...entries.slice(1));
  menu.append(group);
}

/** The air left between a nudged menu and the viewport edge it was nudged off
 * — enough that the box reads as inside the window rather than welded to it. */
const MENU_VIEWPORT_GAP = 4;

/** Where a menu's box goes, for a menu opened at `anchor`: which corner hangs
 * from that point, and the nudge that keeps the box inside the viewport.
 *
 * Pure, and handed the viewport rather than reading it, so the arithmetic can
 * be checked without a layout to open a menu in — see `tests/menuAnchor.test.ts`.
 *
 * **The top right corner is the one that is anchored.** A menu is
 * `writing-mode: vertical-rl` like the text it annotates: entries run down a
 * column and columns run right to left, so the first entry of the first
 * category stands in the top right corner and the table grows down and away
 * to the left. Hanging the box from that corner puts the *start* of the
 * menu's own reading order at the point the reader asked from. It used to
 * hang from the top left, which is the far corner of the table — the end of
 * the last category — so the pointer landed on the last column of the menu
 * and the first was a table's width away from the character it was about.
 *
 * **The nudge.** Each axis is clamped to the viewport, which subsumes the two
 * one-sided pushes this replaced: from the top left the box could only ever
 * run off the right and the bottom, and from the top right it runs off the
 * left instead, whenever the anchor is nearer the left edge than the menu is
 * wide. Where a menu does not fit on an axis at all the two clamps are
 * ordered so that the end the reading starts from is the one that survives:
 * the right edge along the block axis (the first column), the top along the
 * inline axis (the head of every column), with the overflow pushed off the
 * far end. Unverified — there is no browser here to open an over-wide menu
 * in, and neither case arises at the present inventories: the widest is the
 * 34-relation menu at some 471px, and `sizeMenuSquarish` caps every menu at
 * 0.88 of the viewport's height besides. */
export function menuTopLeftFor(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  // Top right at the anchor: the box reaches leftward by its own width from
  // there, and downward by its height.
  const left = anchor.x - size.width;
  const top = anchor.y;
  return {
    left: Math.min(Math.max(left, 0), viewport.width - size.width - MENU_VIEWPORT_GAP),
    top: Math.max(Math.min(top, viewport.height - size.height - MENU_VIEWPORT_GAP), 0),
  };
}

/** Hangs an already-sized menu from `x, y`. Runs after `sizeMenuSquarish`,
 * and cannot run before it: where the top right corner goes is the anchor
 * less the width, and the width is whatever the wrap settled on. */
function placeMenu(menu: HTMLElement, x: number, y: number): void {
  const { width, height } = menu.getBoundingClientRect();
  const { left, top } = menuTopLeftFor(
    { x, y },
    { width, height },
    { width: window.innerWidth, height: window.innerHeight },
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openRetagMenu(kind: "pos" | "dep", entry: Entry, x: number, y: number): void {
  closeContextMenu(true);

  const menu = document.createElement("div");
  menu.className = "token-context-menu";
  const current = kind === "pos" ? entry.token.pos : entry.token.dep;

  // A POS entry is one tag and one box: UPOS is a flat tagset with nothing to
  // nest (see the note in `tests/deprelLabels.test.ts` on why xpos, which is
  // hierarchical, doesn't change that — no menu offers it).
  const makeItem = (value: string) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    // The tag itself, so `shadeMenuItems` can find its entry again when the
    // model's opinion of it arrives.
    item.dataset.value = value;
    if (value === current) item.dataset.current = "true";
    item.textContent = uposJa(value);
    // The raw tag isn't shown (it reads badly stacked vertically at this
    // size, and every label in both inventories is already distinct on its
    // own) but stays reachable on hover for anyone working from the tagset.
    item.title = value;
    item.addEventListener("click", () => {
      closeContextMenu();
      applyTokenEdit((token) => void (token.pos = value));
    });
    return item;
  };

  /** The relation menu's own rows: `deprelRowElement` (above) with this
   * token's current relation to mark and this menu's click to make. Picking
   * ROOT isn't a relation to a head, it's the absence of one — it restructures
   * the top of the tree rather than renaming an arc. */
  const makeRow = (row: DeprelMenuRow) =>
    deprelRowElement(row, current, (value) => {
      closeContextMenu();
      if (value === "ROOT") promoteToRoot(entry);
      else applyTokenEdit((token) => void (token.dep = value));
    });

  const groups: [heading: string, entries: HTMLElement[]][] =
    kind === "pos"
      ? uposMenuGroups(current).map(([heading, tags]) => [heading, tags.map(makeItem)])
      : deprelMenuGroups(current).map(([heading, rows]) => [heading, rows.map(makeRow)]);

  // One box per category, each wrapping its own entries into its own
  // columns, so a heading always stands at the top of a column and a category
  // never begins partway down the one its predecessor ended in. See
  // `appendMenuGroup` and `.token-context-menu` in kunten.css.
  //
  // A relation row is one wrap atom exactly as a part-of-speech entry is, so
  // nothing about the nesting inside a row is at stake here: the wrap falls
  // only between rows, and a row is never broken across a column boundary
  // with its subtypes in the next one.
  for (const [heading, entries] of groups) appendMenuGroup(menu, heading, entries);

  // Positioned against the viewport (`position: fixed`), so it isn't
  // clipped by the panel's own `overflow` the way an in-panel absolute
  // element would be; hung from its top right corner and nudged back inside
  // if it would run off an edge (`menuTopLeftFor`).
  //
  // The anchor stands in as a provisional placement only so that the menu is
  // never measured at the body's own static position; `placeMenu` puts the
  // corner where it belongs as soon as the wrap has settled the width, in
  // this same frame, so nothing is painted at the provisional spot.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  openMenu = menu;
  sizeMenuSquarish(menu);
  placeMenu(menu, x, y);

  // The shading lands after the menu does, and after it has been sized:
  // opacity changes nothing about the layout, so the columns the reader is
  // looking at cannot move under them when the model answers.
  //
  // Only the shading is the model's. The *order* stays what it was — the
  // grammatical order this menu has always been in (see this function's own
  // doc), not likeliest-first. Sorting by probability would move every entry
  // every time the menu opened, so where a relation was last time would tell
  // the reader nothing about where it is now, and the one thing a fixed
  // table is good at would be gone. Where an option sits is how it is found;
  // how solid it looks is what the model thinks of it.
  void shadeRetagMenu(kind, entry, menu);
}

/** The part of a `max-height` that isn't content.
 *
 * `box-sizing: border-box` is global here, and in vertical-rl `max-height`
 * caps the *inline* size — so a cap derived from the children's own content
 * extents is short by the inline-axis padding and borders (top and bottom,
 * which are the inline edges in this writing mode) unless they are added
 * back. Measured at ~16px against the current 0.45rem/1px box (and ~24px
 * against the 0.7rem one it replaced): enough to wrap an extra column on a
 * long menu, and on a short one to cap the box below its own content, which
 * then overflowed the rounded border outright.
 *
 * Asked of the menu only. A `.token-menu-group` has neither padding nor a
 * border, so its own cap is the content extent unadorned — which is why the
 * two are set to figures that differ by exactly this. */
function inlineBoxExtra(menu: HTMLElement): number {
  const style = getComputedStyle(menu);
  return (
    (parseFloat(style.paddingTop) || 0) +
    (parseFloat(style.paddingBottom) || 0) +
    (parseFloat(style.borderTopWidth) || 0) +
    (parseFloat(style.borderBottomWidth) || 0)
  );
}

/** The menu's categories and, flattened, the atoms the wrap can fall between
 * — a `.token-menu-group-lead` (a heading and its first entry) or a lone
 * entry or relation row. Every measuring pass below works from these two:
 * the categories are what a cap is written on, and the atoms are what
 * actually lands in the columns. */
function menuParts(menu: HTMLElement): { groups: HTMLElement[]; atoms: HTMLElement[] } {
  const groups = [...menu.children] as HTMLElement[];
  return { groups, atoms: groups.flatMap((group) => [...group.children] as HTMLElement[]) };
}

/** Writes the column-height cap onto one category, or lifts it (`null`) so the
 * category lays itself out as the single column its content wants.
 *
 * `height` as well as `max-height`, deliberately. A wrapping flex container
 * breaks its lines against its own main size, which here is the category's
 * *height* — and a category is itself a flex item of the menu, laid out
 * `align-items: flex-start`, so with only a `max-height` that height would be
 * a fit-content figure the browser has to derive before it can clamp it and
 * re-wrap. That is a path browsers do take, but it is a path; an explicit
 * height is definite from the start and there is no browser here to check the
 * derived one in. Nothing is lost by forcing it: a category shorter than the
 * cap simply has empty space below its last entry, and the box is transparent
 * — `shrinkMenuToContent` then pulls the cap down to the tallest column, which
 * takes that space back off every category at once. */
function setGroupCap(group: HTMLElement, cap: number | null): void {
  group.style.height = cap === null ? "" : `${cap}px`;
  group.style.maxHeight = cap === null ? "none" : `${cap}px`;
}

/** Marks the atom at the top of each column, which is the one that gets no
 * separator drawn above it.
 *
 * The separator between one entry and the next is a rule on the boundary
 * between their two boxes (`.token-menu-group > *::before` in kunten.css), and
 * every atom carries one except where that boundary is not a boundary between
 * two entries at all: at the head of a column there is nothing above but the
 * frame, and the entry the atom actually follows is at the foot of the column
 * to its right.
 *
 * A flex line is not something a selector can see, so this cannot be asked of
 * the cascade — hence an attribute, written once the wrap has settled and read
 * by a `:not()`. It runs last, after `avoidWidowColumns`, because every pass
 * before it can still move an atom from one column to another.
 *
 * `groupColumns` is what decides, so the columns this marks are the same
 * columns `shrinkMenuToContent` counts and `avoidWidowColumns` reasons about,
 * and a disagreement between them is not possible. Its lists are in document
 * order within a column, which for a column of a vertical-rl flex line is
 * top to bottom, so the first element is the head. */
function markColumnHeads(menu: HTMLElement): void {
  for (const group of [...menu.children] as HTMLElement[]) {
    for (const atom of [...group.children] as HTMLElement[]) delete atom.dataset.columnHead;
    for (const column of groupColumns(group)) column[0]?.setAttribute("data-column-head", "true");
  }
}

/** Caps the column height so the whole table comes out roughly square rather
 * than one tall thin strip (or, unconstrained, a single column taller than
 * the screen).
 *
 * Measured, not guessed. With every cap lifted each category sits in one
 * column, so summing their heights gives the total inline extent `L` of the
 * content and the widest atom gives a column's width `w` (its own width plus
 * the gap to the next column). Wrapping that into columns of height `H` needs
 * about `L/H` of them, making the table `(L/H)·w` wide, and setting that
 * equal to `H` gives `H = sqrt(L·w)`.
 *
 * **What forcing a category onto a new column changed.** That closed form
 * assumes columns pack perfectly, and with `G` categories each starting a
 * fresh column they cannot: every category ends with a part-column, half of
 * one on average, so the count is nearer `L/H + G/2` and the table is
 * `(G-1)·Δ` wider again for the extra white between categories (`Δ` being how
 * much more the block-axis gap between two categories is than the gap between
 * two columns of one). Squaring that up is a quadratic rather than a square
 * root:
 *
 *     H² = (L/H + G/2)·w·H + (G-1)·Δ·H
 *     H  = (b + sqrt(b² + 4·L·w)) / 2,   b = (G/2)·w + (G-1)·Δ
 *
 * which is what the first guess below solves. It is only a first guess — the
 * corrective loop measures — but starting from the flat `sqrt(L·w)` now
 * undershoots badly enough to cost a pass or two, since the true `H` is
 * strictly larger whenever `G > 1`.
 *
 * **Arithmetic for the relation menu, and what it came to.** At a 20px entry
 * (1.25rem) every kanji advances 1em down the column and a bracket half of
 * one; what a row comes to on top of that is spelled out in full at
 * `openRetagMenu` above. The five categories came to `L = 2937px` when they
 * were last measured, against `w = 35.6` (30 for a row, 5.6 for the gap) and
 * `Δ = 5.6`, giving `b ≈ 112` and `H ≈ 385`.
 *
 * What the menu actually came out at then is **471.1 × 428.2 over 12
 * columns** at 1292 × 792, well inside a viewport whose height alone is
 * capped at `0.88 · 792 = 697`. The correction loops below move the first
 * guess, and `avoidWidowColumns` afterwards takes each category's own cap
 * down further still — the five ended on 292, 385, 314, 399 and 274, which is
 * why no one figure describes the result any more.
 *
 * **What the grid does to that**, computed rather than measured — there has
 * been no browser for the last three rounds, and this is the arithmetic, not
 * a claim about the page. Every figure the quadratic is made of moved:
 *
 *     L   3500 for the 23 rows, and 500 for the five headings. A heading is
 *         one line of smaller characters tracked out to a cell each
 *         (`.token-menu-heading`), plus the one cell its cartouche takes, so
 *         its extent is `(n + 1)` cells for a label of `n`: 述語・項 5,
 *         修飾 3, 複合・並列 6, 談話・その他 7, 未分類 4 — 100, 60, 120,
 *         140 and 80.
 *         4000 in all. It was 3589.6 before the grid, 3900 with the boxed
 *         headings, 3860 with them deboxed but still full-size, and 3680 with
 *         them set 割注. There is nothing else in it: the 0.1rem that used to
 *         stand between two atoms is 0 now.
 *     w   40 exactly — a 1.5-cell lane and a 二分 gutter, which is the column
 *         pitch of two whole cells — where it was 35.6. The headings do not
 *         enter it: the cartouche is 25px across, centred in the 30px lane
 *         with 2.5px of clear on each side. That is a bound rather than an
 *         identity — the grid runs along the run, not across it — and the
 *         only thing it has to satisfy is staying inside the lane, since a
 *         frame wider than the entry beside it would be the widest atom and
 *         would move `w`. It does not.
 *     Δ   0. A category boundary is an ordinary column boundary now, both
 *         gutters being 二分; it was 5.6.
 *     b   (5/2)·40 = 100, where it was ≈ 112.
 *     H   (100 + √(100² + 4·4000·40)) / 2 ≈ 453.
 *
 * **What the tracked heading costs, plainly.** A 割注 heading was 二分 times
 * its *longer line*; a tracked one is a whole cell times its *whole label*,
 * which is four times the run for a six-character label. Across the five that
 * is 500px of `L` where the 割注 came to 180 — **+320px, or +8.7% of `L`** —
 * and it is the whole of the difference, since nothing else in the quadratic
 * moved. Two of the four labels reworded a round ago were reverted to take
 * some of it back (see `MENU_HEADINGS`), and that is the only place it has
 * been paid down; nothing else was quietly shrunk to hide it.
 *
 * **And the size of the type is free here.** A character advances a cell
 * whatever it is set at — that is the whole point of the tracking — so the
 * heading was raised from half the entries' size to 0.6 of it without moving
 * `L`, `H` or the column count by a pixel. It costs air inside the cartouche
 * and nothing on this axis, which is the axis that is tight.
 *
 * `L/H + G/2` — the column count the quadratic is solving against — is
 * `8.83 + 2.5 = 11.3`, so **11 columns** still, and a border box of about
 * `11·30 + 10·10 + 12 = 442` wide by `453 + 15.6 = 469` tall, against 456 ×
 * 466 under the 割注 and the 471.1 × 428.2 that was last measured. So the
 * price on the page is about **16px of height and no extra column** — by this
 * estimate. It should be read as a near thing rather than a result: 11.3 is
 * far closer to a twelfth column than the 10.9 it replaces, and the estimate
 * is only the loop's first guess. A page may well answer 12.
 *
 * **The 12 and the 15.6 are the menu's own margins**, halved a round after
 * the rest of this was computed and then snapped on the block axis: `2 ·
 * (--menu-cell / 4) + 2px` = 12 across, `2 · 0.425rem + 2px` = 15.6 along,
 * read back off the element by `inlineBoxExtra` rather than written here.
 * They are the only figures in this paragraph that moved, and they are not in
 * `L` — the margin is part of the box and no part of the content — so the
 * first guess `H` is the same 453 throughout.
 *
 * What they touch is the loop below, which squares the *border* box, and they
 * barely touch it. Off square: 5.46% at the original margins, 5.27% halved,
 * 5.70% once the side was snapped from 6px to 四分. All three are past the
 * loop's own 5% test, so it runs one corrective pass in every case, and that
 * pass lands the cap at 440.58, 441.01 and 440.01 respectively — **a pixel
 * across the whole sequence, and no column moves**: the estimate after the
 * pass is 11.58, 11.57 and 11.59. The near thing stays as near as it was
 * throughout. The snap costs 2px of width and takes the box a little further
 * from square, since it was already taller than wide; against the halving's
 * 12px and 13.6px that is small, and the box ends some 14px narrower and
 * 13.6px shorter than before either change.
 *
 * The clamp falls the safe way too. `extra` is subtracted from the viewport
 * ceiling, so halving it *raises* that ceiling by 13.6px, and the floor is the
 * tallest atom, which knows nothing about padding. Neither bound was near
 * binding and both are further off than they were.
 *
 * (An earlier draft of this paragraph said the 5% test was satisfied at the
 * first guess. That was true at `L = 3680`, where the box came out 456 × 466
 * and 2.2% off square, and it stopped being true when the tracked heading
 * took `L` to 4000. It is corrected rather than quietly dropped: the loop
 * runs, and what it does is written above.)
 *
 * The floor is the tallest *atom*, not the tallest category: a category is
 * meant to wrap, an atom cannot (`white-space: nowrap`, and a relation row is
 * a flex box of nowrap segments), so capping below one would squeeze it out
 * of its own box. In this inventory that floor is 並列構成要素〖動詞連続・外来語〗
 * at 16 characters, measured at 311.19px, computed at 349.2 with the segments
 * padded at 0.35rem and at 360 on the grid — which is above three of the five
 * caps recorded above, so it is the thing that stops those categories going
 * squarer rather than a bound they merely sit under. Nothing breaks when a cap
 * meets it: the category simply keeps the height its longest row needs. */
export function sizeMenuSquarish(menu: HTMLElement): void {
  const { groups, atoms } = menuParts(menu);
  if (atoms.length === 0) return;

  // Every cap off first, so what is measured is the content and not the last
  // pass's answer: each category then lays itself out as a single column.
  menu.style.maxHeight = "none";
  for (const group of groups) setGroupCap(group, null);

  // A pass that rounded every heading to whole cells used to stand here, and
  // had to stand here: it changed each category's inline extent, which is the
  // `L` every figure below is derived from, and it could not run last because
  // the wrap would then fall somewhere other than where it had been measured.
  // There is nothing left for it to round. A heading is one line of smaller
  // characters tracked out to a cell each — whatever size they are set at, so
  // a label of `n` characters is `n` cells for every `n`, and the cartouche
  // round it is one more
  // (`.token-menu-heading` in kunten.css). What is summed below is already on
  // the grid, and this function no longer writes anything before it measures.

  const menuStyle = getComputedStyle(menu);
  const groupStyle = getComputedStyle(groups[0]);
  // In vertical-rl the block axis is the horizontal one, so `row-gap` is what
  // separates columns — inside a category, that is the gap between two of its
  // columns; on the menu itself, the gap between two categories.
  const columnGap = parseFloat(groupStyle.rowGap) || 0;
  const groupGap = parseFloat(menuStyle.rowGap) || 0;

  const totalInline = groups.reduce((sum, group) => sum + group.offsetHeight, 0);
  const columnWidth = Math.max(...atoms.map((el) => el.offsetWidth)) + columnGap;
  const tallestAtom = Math.max(...atoms.map((el) => el.offsetHeight));

  // The cap is tracked throughout as the *content* extent. A category takes
  // it as it stands, having no box of its own; the menu takes it plus its own
  // padding and border, which is the one place the border box is what counts.
  const extra = inlineBoxExtra(menu);
  const apply = (h: number) => {
    const cap = Math.ceil(h);
    menu.style.maxHeight = `${cap + extra}px`;
    for (const group of groups) setGroupCap(group, cap);
  };

  // Never shorter than a single atom (which can't wrap), never taller than
  // the viewport allows.
  const clamp = (h: number) => Math.max(tallestAtom, Math.min(h, window.innerHeight * 0.88 - extra));
  const bias = (groups.length / 2) * columnWidth + (groups.length - 1) * Math.max(0, groupGap - columnGap);
  let height = clamp((bias + Math.sqrt(bias * bias + 4 * totalInline * columnWidth)) / 2);
  apply(height);

  // The closed form is still only an estimate — "half a column wasted per
  // category" is an average, not a fact about this inventory. Nudge toward
  // square from the *measured* result; a couple of passes is plenty, and each
  // is a cheap reflow of a small menu.
  for (let i = 0; i < 3; i++) {
    const { width, height: measuredBox } = menu.getBoundingClientRect();
    // Squareness is judged on the border box — that's the shape on screen —
    // while the next cap is derived from the content extent inside it. Since
    // `setGroupCap` gives every category the cap as a height, that box is now
    // exactly the cap tall, so what this loop squares up is the cap against
    // the width; `shrinkMenuToContent` then takes off however much of the cap
    // the tallest column did not use, which on a menu of many columns is a
    // few pixels.
    if (Math.abs(width - measuredBox) / Math.max(width, measuredBox) < 0.05) break;
    const next = clamp((measuredBox - extra) * Math.sqrt(width / measuredBox));
    if (Math.abs(next - height) < 1) break;
    height = next;
    apply(height);
  }

  shrinkMenuToContent(menu);
  avoidWidowColumns(menu, extra);
  // Last, when no pass left can move an atom out of the column it is in.
  markColumnHeads(menu);
}

/** One category's atoms, gathered into the columns they landed in, first
 * column first — which in vertical-rl is the rightmost.
 *
 * Two atoms share a column exactly when they share a left edge, and no two
 * categories can ever share one (each wraps inside a box of its own), so
 * rounding to the pixel discriminates them well enough. This is the same
 * test `shrinkMenuToContent` counts columns by, kept apart from it because
 * that one wants a count over the whole menu and this one wants the contents
 * of one category's columns in order. */
function groupColumns(group: HTMLElement): HTMLElement[][] {
  const byLeft = new Map<number, HTMLElement[]>();
  for (const atom of [...group.children] as HTMLElement[]) {
    const left = Math.round(atom.getBoundingClientRect().left);
    const column = byLeft.get(left);
    if (column) column.push(atom);
    else byLeft.set(left, [atom]);
  }
  return [...byLeft.entries()].sort(([a], [b]) => b - a).map(([, atoms]) => atoms);
}

/** Whether a category's last column holds one row alone while an earlier
 * column of the same category holds two or more.
 *
 * The second half of that is the whole of the definition worth arguing over.
 * A category every one of whose columns holds a single row has no widow in
 * it — 未分類 is three rows of 11, 14 and 10 characters and no two of them
 * fit in one column at any cap the screen allows, so its three columns of one
 * are what that category *is*, and a rule that called the last of them
 * stranded would be describing the inventory rather than the setting. A widow
 * is a row left behind by a wrap the rest of the category survived, which is
 * what "some earlier column holds two" says. */
function isWidowed(columns: HTMLElement[][]): boolean {
  if (columns.length < 2) return false;
  return columns[columns.length - 1].length === 1 && columns.some((column) => column.length > 1);
}

/** Pulls a row back into a category's last column when that column would
 * otherwise hold one row alone.
 *
 * ── The orphan, and why there is no code for it ────────────────────────
 * The matching fault — a heading standing at the foot of a column with the
 * rows it heads beginning in the next one — cannot arise, and it is worth
 * saying where that guarantee lives rather than adding a second pass that
 * would never fire. `appendMenuGroup` binds a heading to its own first entry
 * in one `.token-menu-group-lead`, which is a single flex item and so a
 * single wrap atom; `sizeMenuSquarish` floors every cap at the tallest atom,
 * and `shrinkMenuToContent` cannot go under that floor either, since the
 * tallest *column* it measures contains the tallest atom and is therefore at
 * least as tall as it. So no cap the menu can reach will split a heading from
 * its first row. Checked on the open relation menu: all five headings sit at
 * the top of a column with their first row directly under them.
 *
 * ── The widow, and the lever that moves it ─────────────────────────────
 * Observed on the relation menu at 1292x792, where 述語・項 came out 3 rows,
 * 3 rows, then 補語〖形式〗 by itself. Nothing about the last column decides
 * that; the *penultimate* one does. It had taken all it could hold at the
 * common cap, and what it could not hold was one row. Cap that column a pixel
 * under what it actually reached and it sheds its last row into the widow,
 * which then holds two. The cap is written on the category, not on the menu,
 * because a category is where a wrap happens: `setGroupCap` already writes
 * one per category and `align-items: flex-start` already hangs them all from
 * the same line, so a category that is shorter than its neighbours costs
 * nothing but the white below it, which was transparent anyway.
 *
 * Two things are refused. The cap never goes below the category's own tallest
 * row, which cannot wrap and would be squeezed out of its box. And a pass
 * that costs the category a column is rolled back: a widow is a blemish, an
 * extra column is a wider menu, and the menu's width is the thing every other
 * measurement in `sizeMenuSquarish` is spent on.
 *
 * ── When it cannot be done ─────────────────────────────────────────────
 * Then the widow stays, and stays deliberately. There are two ways to get
 * there. A category whose rows are so long that no column holds two of them
 * is not widowed at all by the test above, and is left alone. A category
 * where shedding would cost a column — where the row pulled back does not fit
 * beside the one it is joining — is rolled back and left as it was, on the
 * ground that a short last column is a smaller fault than a menu a column
 * wider. Neither case is worth an escape hatch: raising the cap instead would
 * make the whole menu taller to tidy one column, and the only other move,
 * squeezing a row, is not available at all. */
function avoidWidowColumns(menu: HTMLElement, extra: number): void {
  const groups = [...menu.children] as HTMLElement[];
  for (const group of groups) {
    const atoms = [...group.children] as HTMLElement[];
    if (atoms.length === 0) continue;
    // Its own tallest row, not the menu's: this cap governs this category and
    // nothing else, so it is only this category's rows it must not squeeze.
    const floor = Math.max(...atoms.map((atom) => atom.offsetHeight));
    const columnsWanted = groupColumns(group).length;
    let cap = parseFloat(group.style.height);
    if (!Number.isFinite(cap)) continue;

    // Each pass sheds one row from one column, and the shed can cascade back
    // through the earlier columns, so the condition is re-read rather than
    // assumed away. Three is more than this inventory has ever needed.
    for (let pass = 0; pass < 3; pass++) {
      const columns = groupColumns(group);
      if (!isWidowed(columns)) break;
      const penultimate = columns[columns.length - 2];
      const top = group.getBoundingClientRect().top;
      const reached = Math.max(...penultimate.map((atom) => atom.getBoundingClientRect().bottom)) - top;
      // A pixel under what that column reached, which is the least that makes
      // it give up its last row.
      const next = Math.floor(reached) - 1;
      if (next < floor || next >= cap) break;
      setGroupCap(group, next);
      if (groupColumns(group).length > columnsWanted) {
        setGroupCap(group, cap);
        break;
      }
      cap = next;
    }
  }

  // Then the same trim `shrinkMenuToContent` does, read per category now that
  // the caps differ. That pass ran before this one and left every category
  // holding one cap, trimmed to the tallest column in the menu; shortening a
  // category above can take that column away, and then every *other* category
  // is standing at a cap its own columns no longer reach. The white shows at
  // the foot of the menu, as the box standing clear of its own content —
  // measured before this loop existed: the relation menu's tallest column
  // came to 396px inside categories still capped at 426.
  //
  // Same tolerance and same rollback as the pass it echoes: a couple of
  // pixels, because a column consumes fractionally more than its last child's
  // border-box bottom, and any pass that costs a column or brings a widow back
  // is undone.
  for (const group of groups) {
    const cap = parseFloat(group.style.height);
    if (!Number.isFinite(cap)) continue;
    const columns = groupColumns(group);
    const top = group.getBoundingClientRect().top;
    const reached = Math.max(...[...group.children].map((atom) => atom.getBoundingClientRect().bottom)) - top;
    const next = Math.ceil(reached) + 2;
    if (!(next < cap)) continue;
    setGroupCap(group, next);
    const after = groupColumns(group);
    if (after.length > columns.length || (isWidowed(after) && !isWidowed(columns))) setGroupCap(group, cap);
  }

  // The menu's own box still has to hold the tallest category standing, since
  // `setGroupCap` writes the cap as a height and a category is exactly that
  // tall whatever its columns came to.
  const caps = groups.map((group) => parseFloat(group.style.height)).filter((cap) => Number.isFinite(cap));
  if (caps.length > 0) menu.style.maxHeight = `${Math.max(...caps) + extra}px`;
}

/** Trims the height cap down to what the columns actually came out to.
 *
 * The cap is a *wrapping* threshold, not a measurement of the result: once
 * the entries have been distributed, the tallest column generally ends well
 * short of it, leaving dead space below every column. It leaves more of it
 * now than it used to, and for a reason worth stating: a category that wraps
 * at all is exactly as tall as the cap whatever its columns come to, so a
 * menu whose tallest column falls 40px short of the cap is 40px of white at
 * the foot of every one of its categories. This pass is therefore load
 * bearing rather than a tidy-up.
 *
 * Tightening the cap re-wraps *every* column, not just the tallest, so
 * each pass has to be checked rather than trusted: entries shuffle between
 * columns, and the new tallest is usually shorter again — which, iterated
 * blindly, runs away. (Measured on the flat menu this replaced: unchecked, it
 * drove a 439px menu down to 238px, spreading the entries over so many
 * columns that the content overflowed and the box went four times wider than
 * tall.) Extra columns are the signal that a step went too far, so a pass
 * that costs any is rolled back and ends the loop; what remains is the
 * tightest cap that still holds the same column count. */
function shrinkMenuToContent(menu: HTMLElement): void {
  const { groups, atoms } = menuParts(menu);
  if (atoms.length === 0) return;

  const style = getComputedStyle(menu);
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0);
  const extra = inlineBoxExtra(menu);
  const apply = (h: number) => {
    menu.style.maxHeight = `${h + extra}px`;
    for (const group of groups) setGroupCap(group, h);
  };
  // Columns are counted over the atoms and not the categories, since it is
  // the atoms that land in them; two categories can never share a column, so
  // no two of these lefts coincide across categories either.
  const columnCount = () => new Set(atoms.map((el) => Math.round(el.getBoundingClientRect().left))).size;
  const tallestColumn = () => {
    const contentTop = menu.getBoundingClientRect().top + padding;
    return Math.max(...atoms.map((el) => el.getBoundingClientRect().bottom)) - contentTop;
  };

  for (let pass = 0; pass < 4; pass++) {
    // A content figure, to match `extent` and to be restorable as one.
    const previousCap = (parseFloat(menu.style.maxHeight) || NaN) - extra;
    if (!Number.isFinite(previousCap)) break;
    const previousColumns = columnCount();
    const extent = tallestColumn();
    if (extent <= 0 || previousCap - extent < 1) break;

    // A couple of pixels of tolerance: the consumed main size of a column
    // is fractionally more than its last child's border-box bottom (gaps
    // and sub-pixel rounding), so re-capping at exactly the measured
    // extent is a hair too tight and tips one entry into a new column
    // (measured: 382.4 tallest at a 460 cap, but capping at 383 re-wrapped
    // 13 columns into 14). This keeps the packing while still closing
    // essentially all of the dead space.
    apply(Math.ceil(extent) + 2);
    if (columnCount() > previousColumns) {
      apply(previousCap);
      break;
    }
  }
}

/** The kanjidic index, for the furigana menu's candidate list. Set by
 * `KundokuView.ts` on each render rather than passed to
 * `setupTokenInspector` — that runs once and is guarded against running
 * again, whereas this needs to be in place whenever the panel has content,
 * including the first render after the index finishes loading.
 *
 * JMdict travels with it because the menu asks that dictionary one question
 * of its own: whether a kun'yomi ending in い is an adjective, and so is to
 * be offered in its classical 終止形 rather than in KANJIDIC2's modern shape.
 * See `classicalAdjectiveKun`. */
let readingIndex: KanjidicIndex | null = null;
let historicalKanaIndex: HistoricalKanaIndex | null = null;
let jmdictIndex: JmdictIndex | null = null;

export function setReadingIndex(
  index: KanjidicIndex | null,
  historicalKana: HistoricalKanaIndex | null,
  jmdict: JmdictIndex | null = null,
): void {
  readingIndex = index;
  historicalKanaIndex = historicalKana;
  jmdictIndex = jmdict;
}

/** What the furigana menu offers for one cell: the readings to list, and —
 * where picking one is not simply storing it — what to store when it is
 * picked.
 *
 * The second field is what a multi-character token needs. Its characters
 * are separate cells but one token, so a reading picked over one character
 * is stored as the whole word's reading with that character's share
 * replaced; see `compoundMemberOffer`. */
interface ReadingOffer {
  candidates: ReadingCandidate[];
  store: (candidate: ReadingCandidate) => { reading: string; okurigana?: string; conjClass?: ConjClass };
}

/** The default is to store the candidate whole, ending included — that is
 * what a pick over an ordinary single-character token means, and dropping the
 * ending is not a smaller version of it but a different reading: with no
 * `Okurigana` in `misc`, `chosenOkurigana` reads the token as a verb with no
 * ending of its own and supplies サ変's す, so picking 易's やす.い off the
 * menu printed 易[やす|スル] and 易やするのみ where 易やすし was meant. Only
 * `compoundMemberOffer` overrides this, and it drops the ending deliberately
 * and for a stated reason (a member of a jukugo is read as a bare stem).
 *
 * The candidate's `conjClass` travels with its ending for the same reason the
 * ending travels at all: it is part of what the reading is. Only the
 * converted candidates carry one — the adjectives, whose classical ending no
 * longer says which of ク/シク活用 it belongs to, and 用's もちゐる, whose
 * ワ行上一段 no ending states — and without it a picked 易 could only be
 * printed in its 終止形, 易し, wherever it stood, and a picked 用 at 用ゐる.
 * See `ReadingCandidate.conjClass`. */
const NOTHING_TO_OFFER: ReadingOffer = {
  candidates: [],
  store: (c) => ({ reading: c.reading, okurigana: c.okurigana, conjClass: c.conjClass }),
};

/** The reading currently written over `cell` — its `<rt>` less the
 * okurigana written inside it, which is inflected for this occurrence and
 * is not part of the reading. */
function shownReadingOf(cell: HTMLElement): string {
  const rt = cell.querySelector("rt");
  if (!rt) return "";
  const text = rt.textContent ?? "";
  return text.slice(0, text.length - shownOkuriganaOf(cell).length);
}

function shownOkuriganaOf(cell: HTMLElement): string {
  return cell.querySelector("rt")?.querySelector(".okurigana")?.textContent ?? "";
}

/** The dictionary form of a reading written *wholly* in the okurigana slot,
 * as the render layer recorded it — see `cellFor`'s `kanaReading` in
 * KundokuView.ts. Empty for every cell whose reading stands over its
 * character, which is every cell the `<rt>` can be read for itself. */
function shownOkuriganaReadingOf(cell: HTMLElement): string {
  return cell.dataset.kanaReading ?? "";
}

/** Alternative readings for `entry`'s token, or nothing to offer.
 *
 * A cell inside a `.compound-group` is one of two things that look
 * identical on the page, and only one of them has a menu — see
 * `compoundMemberOffer`. */
function readingOfferFor(entry: Entry): ReadingOffer {
  const group = entry.cell.closest<HTMLElement>(".compound-group");
  if (group) return compoundMemberOffer(entry, group);
  const dictionary = readingIndex
    ? candidateReadings(readingIndex, entry.token.text, entry.token.pos, historicalKanaIndex ?? undefined, jmdictIndex)
    : [];
  return { ...NOTHING_TO_OFFER, candidates: [...rereadCandidateFor(entry), ...dictionary] };
}

/** The readings offered over one character of a compound group.
 *
 * A genuine multi-token *span* gets none, exactly as before: its furigana
 * is one JMdict reading for the whole span, divided across the member
 * characters by the render layer, and a per-character choice there would be
 * written to a token that reading never consults — a menu that silently did
 * nothing. Spans need their own span-level chooser, which is a separate
 * design (where would a member's own okurigana go?).
 *
 * A fused multi-character token — one CoNLL-U row spanning several
 * characters, every cell stamped with the same id — is the case this
 * answers, and it is a different case in every respect that matters: there
 * is one token, one `misc` map, and one reading for the word, so a choice
 * has somewhere to live and something to mean. What is offered is the
 * clicked *character's* own readings, because that is what the reader is
 * pointing at and what KANJIDIC can answer (asked about the whole string it
 * answers nothing: 番僧, 三百 and 豪富 are all absent from it, measured — so
 * the whole-token list a lone `candidateReadings` would build is empty, and
 * removing the old early return by itself opened no menu at all). Picking
 * one stores the whole word's reading with that character's share swapped
 * for it, which `compoundFurigana` then divides back across the characters.
 *
 * The candidates come from `compoundMemberCandidates`, which is also what
 * the splitter divides by — so every reading offered here is one the
 * annotation can be redrawn from. They carry no okurigana: a member of a
 * jukugo is read as a bare stem (立場 たちば, off た.つ), and the ending on
 * the word as a whole is the group's, decided by where the word stands.
 *
 * Nothing is offered where a sibling character has no reading on the page
 * to contribute — the word's reading could not be stated in full, and a
 * choice composed out of a gap would be a word nobody reads. */
function compoundMemberOffer(entry: Entry, group: HTMLElement): ReadingOffer {
  const cells = [...group.querySelectorAll<HTMLElement>(".kanji-cell[data-token-id]")];
  if (new Set(cells.map((cell) => cell.dataset.tokenId)).size !== 1) return NOTHING_TO_OFFER;
  const index = cells.indexOf(entry.cell);
  const chars = [...entry.token.text];
  if (index < 0 || chars.length !== cells.length || !readingIndex) return NOTHING_TO_OFFER;
  const shares = cells.map(shownReadingOf);
  if (shares.some((share) => share.length === 0)) return NOTHING_TO_OFFER;
  const candidates = compoundMemberCandidates(readingIndex, chars[index], {
    nonInitial: index > 0,
    historicalKana: historicalKanaIndex,
  });
  return {
    candidates,
    store: (candidate) => ({
      reading: shares.map((share, i) => (i === index ? candidate.reading : share)).join(""),
    }),
  };
}

/** The 再読 reading, for a character this parse is reading twice — offered
 * first, since it is what the panel is doing and the dictionary readings are
 * the alternatives to it.
 *
 * Written as the two halves with an ellipsis between them, いまだ…ズ, which is
 * how a grammar cites one and the only honest way to put it in a list beside
 * single readings: the character's reading is in two pieces with a whole
 * clause in the gap, and a menu entry reading いまだず would name a word that
 * is never said. The halves are split across the two fields the item is built
 * from, so `openReadingMenu` renders it in the same hiragana-then-katakana it
 * renders every other candidate in, and the ellipsis rides along on the first.
 *
 * Empty for a character used in one of its ordinary senses (且 as "moreover")
 * — `isRereadUse` decides, the same as everywhere else — and empty once the
 * reader has chosen otherwise, when it is `openReadingMenu`'s 自動 that
 * offers the way back. */
function rereadCandidateFor(entry: Entry): ReadingCandidate[] {
  const sentence = sentenceOf(entry.cell);
  if (!sentence || !isRereadUse(entry.token, sentence)) return [];
  const reread = rereadCharacter(entry.token.text);
  return reread ? [{ kind: "reread", reading: `${reread.first}…`, okurigana: reread.second }] : [];
}

/** The furigana menu: pick which of a character's readings this occurrence
 * takes. Grouped 訓読み/音読み the way a kanji dictionary lists them, and
 * filtered to those compatible with the token's part of speech — see
 * `candidateReadings`.
 *
 * Each item is labelled exactly as the annotation will read once chosen
 * (hiragana reading, katakana okurigana), so the choice is made against
 * what will appear rather than against a dictionary citation form. */
function openReadingMenu(entry: Entry, offer: ReadingOffer, x: number, y: number): void {
  closeContextMenu(true);

  const { candidates } = offer;
  const menu = document.createElement("div");
  menu.className = "token-context-menu";
  // Whether anything is *stored*, which is the only thing the 自動 item below
  // needs to know — it is the way back from a choice, so it has to appear
  // wherever there is a choice to go back from. `chosenReading` used to answer
  // this and can no longer: it declines an auxiliary pick, on the ground that
  // nothing is drawn from one that the app would not have drawn anyway (see
  // `chosenAuxiliary`). That ground does not reach as far as this item. A べし
  // picked on 須 suppresses the character's 再読 construction, which is a
  // visible change with no other way back — the 再読 candidate is not offered
  // while a choice stands — so a menu that hid 自動 there would strand it.
  const current = storedReadingText(entry.token) !== undefined;

  // Which candidate is marked as current comes from what the annotation
  // actually shows, not from `current` — the reading on screen is usually
  // one the resolver worked out rather than one the user picked, and a
  // menu that marked nothing until a choice had been made would misreport
  // the common case as "no reading selected".
  //
  // Only the reading is compared, never the okurigana: what's rendered is
  // inflected for this occurrence (為 shows なシ, the 連用形, against a
  // dictionary な.す), so matching the ending would fail on exactly the
  // inflecting words this menu is most useful for.
  const shownOkurigana = shownOkuriganaOf(entry.cell);
  const shownReading = shownReadingOf(entry.cell);

  // Exactly one entry is marked. Preferring a whole-annotation match picks
  // the right one when the ending happens to be uninflected; falling back
  // to the reading alone is what catches the inflected case (直 displays
  // なほシ, the 連用形, against dictionary なほ.す) — but several candidates
  // can share one reading and differ only in that ending, so without a
  // single winner all of them would light up at once.
  const exact = candidates.find(
    (c) => c.reading === shownReading && toKatakana(c.okurigana ?? "") === shownOkurigana,
  );
  // Where there is no furigana at all, the reading on screen is the grammar
  // word standing in the okurigana slot — 不 is a bare 不 beside ザル — and
  // neither comparison above can see it: both read the furigana slot, and it
  // is empty. What they find there is nothing, and the only candidate that
  // could equal nothing is one whose own reading is the empty string; picking
  // that would store a hand-picked reading of nothing, report it as
  // `source: "kanjidic"`, and move the word out of the bare-kana prose
  // treatment it is written this way for. So the okurigana answers instead —
  // not the kana on the page, which are inflected for this occurrence and so
  // equal no citation (one ず is written ズ, ザル, ザルニ or ズト; しむ is
  // written シメ over 令 and シム over 使), but the dictionary form the render
  // layer recorded beside them, which is the form the menu lists.
  //
  // A fallback and not a widening: it is asked only where the furigana slot
  // is empty, so every cell that has furigana goes on being marked by exactly
  // the two comparisons above and by nothing else.
  const okuriganaWord = shownReading === "" ? shownOkuriganaReadingOf(entry.cell) : "";
  const byOkurigana = okuriganaWord ? candidates.find((c) => c.reading === okuriganaWord) : undefined;
  // A 再読 candidate is offered only where the panel is already reading the
  // character that way (see `rereadCandidateFor`), so where one exists it is
  // by construction the reading on screen. It could not be found by the
  // comparison above in any case: only its first half is in the <rt>, the
  // second being written down the other side of the character.
  const currentCandidate =
    candidates.find((c) => c.kind === "reread") ??
    exact ??
    candidates.find((c) => c.reading === shownReading) ??
    byOkurigana ??
    null;

  const makeItem = (candidate: ReadingCandidate) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    item.textContent = candidate.reading + (candidate.okurigana ? toKatakana(candidate.okurigana) : "");
    if (candidate === currentCandidate) item.dataset.current = "true";
    if (candidate.gloss) item.title = candidate.gloss;
    item.addEventListener("click", () => {
      closeContextMenu();
      // The 再読 reading is the one candidate that is not something to store:
      // it is what the parse already makes of the character, and picking it
      // means going back to that. Storing its two halves as a reading and an
      // okurigana would put いまだ…ず in the <rt> as one word.
      if (candidate.kind === "reread") applyTokenEdit((token) => clearChosenReading(token));
      else {
        // What is stored is not always what was clicked: over one character
        // of a multi-character token, the reading picked is that character's
        // share of a word whose reading is what the token holds. See
        // `ReadingOffer`.
        const { reading, okurigana, conjClass } = offer.store(candidate);
        applyTokenEdit((token) => setChosenReading(token, reading, okurigana, conjClass));
      }
    });
    return item;
  };

  for (const [heading, kind] of READING_KIND_GROUPS) {
    const group = candidates.filter((c) => c.kind === kind);
    // One category, one band of columns of its own — the same structure
    // `openRetagMenu` uses, through the same function, so 音読み and 訓読み
    // start at the top of a column here exactly as 修飾 does there. A kind
    // with no candidates is skipped rather than headed and empty, which
    // matters more now that an empty category would still take a column.
    appendMenuGroup(menu, heading, group.map(makeItem));
  }

  // Only offered once there is a choice to undo — otherwise it would sit
  // there claiming to revert something that never happened.
  if (current) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    item.textContent = "自動";
    item.title = "解析結果どおりの読みに戻す";
    item.addEventListener("click", () => {
      closeContextMenu();
      applyTokenEdit((token) => clearChosenReading(token));
    });
    // A category of one, and now a column of one: 既定 stands at the head of
    // its own short column at the left of the menu rather than trailing the
    // 訓読み it used to follow, which is the clearer place for the way back.
    appendMenuGroup(menu, READING_DEFAULT_HEADING, [item]);
  }

  // Hung from its top right corner, as the retag menu is and for the same
  // reason — see `menuTopLeftFor`, which both openers place through.
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  openMenu = menu;
  sizeMenuSquarish(menu);
  placeMenu(menu, x, y);
}

/** True for the parts of a cell that carry a menu of their own, which the
 * plain selection click must therefore leave alone.
 *
 * Their menus open on a right or double click now (see
 * `setupTokenContextMenu`), so this no longer guards a menu-opening click
 * from also landing on the text behind it. What it still guards is the
 * analysis: a label sits outside every cell, so a left click on one would
 * read as a click on empty panel and take down the very overlay it is part
 * of. Inert is the right answer for all of them — these are controls, and a
 * left click is no longer their gesture.
 *
 * The furigana counts only while its character is being asked about, which
 * is when it is drawn as a control. Before that it is part of the cell like
 * any other, and clicking it selects the character. */
function isMenuTarget(target: HTMLElement): boolean {
  const rt = target.closest("rt");
  if (rt) return !!rt.closest(".token-cell-inspected");
  return !!(target.closest(".token-subtitle") || target.closest(".token-arrow-label"));
}

/** Every part of a cell that is a reading of its character, and so answers
 * for the character's readings when asked.
 *
 * The `<rt>` holds the furigana and the okurigana. The other is a 再読文字's
 * second reading, which is the same character's reading written down the
 * opposite side — so it opens the same menu, which now has something to say
 * about it (see `rereadCandidateFor`). Leaving it out made the one character
 * on the page whose reading is in two places answerable on only one of
 * them. */
const READING_PARTS = "rt, .reread-second";

/** Opens the readings for whichever character `part` annotates, reporting
 * whether there was anything to open — a character the dictionaries don't
 * know, or one inside a multi-token compound span, has no alternatives to
 * offer, and the caller then lets the click mean whatever it would have
 * meant. */
function openReadingMenuFor(part: Element, x: number, y: number): boolean {
  const entry = resolveEntry(part.closest<HTMLElement>(".kanji-cell[data-token-id]"));
  const offer = entry ? readingOfferFor(entry) : NOTHING_TO_OFFER;
  if (!entry || offer.candidates.length === 0) return false;
  openReadingMenu(entry, offer, x, y);
  return true;
}

function setupTokenContextMenu(container: HTMLElement): void {
  // Asking what the parse makes of a character: the part of speech below it,
  // and the arrow from whatever it attaches to. Reading the text and
  // interrogating it are separate gestures, so the plain left click just
  // picks a character out.
  //
  // Every menu in the panel opens from here, on this one gesture. The two
  // labels used to open theirs on a left click, on the reasoning that a
  // label *is* the thing being changed and so is a control like any other —
  // but the panel already answers a left click by selecting and a right
  // click by explaining, and a control that took the first gesture made the
  // rule depend on where in the analysis the pointer had landed. One gesture
  // for every menu is a rule that can be stated. The readings menu is here
  // for the same reason: it was reachable on a left click once the analysis
  // was up, which is precisely when the most is on screen to land on.
  const interrogate = (event: MouseEvent) => {
    const target = event.target as HTMLElement;

    // The labels exist only while the analysis is on screen, which is this
    // same gesture away — so there is always a selection by the time one of
    // them can be reached.
    const kind = target.closest(".token-subtitle") ? "pos" : target.closest(".token-arrow-label") ? "dep" : null;
    if (kind && selected) {
      event.preventDefault();
      openRetagMenu(kind, selected.entry, event.clientX, event.clientY);
      return;
    }

    // The reading answers for itself: this gesture on the furigana — or on a
    // 再読文字's second reading, the same character's reading written down the
    // other side — offers the character's others, without first having to ask
    // about the character.
    const part = target.closest(READING_PARTS);
    if (part) {
      const entry = resolveEntry(part.closest<HTMLElement>(".kanji-cell[data-token-id]"));
      if (entry) {
        event.preventDefault();
        selectEntry(container, entry, selected?.overlay ?? false);
        // Nothing to offer: the character is still selected by the gesture,
        // and no menu appears rather than an empty one.
        openReadingMenuFor(part, event.clientX, event.clientY);
        return;
      }
    }

    const entry = resolveEntry(target.closest<HTMLElement>(".kanji-cell[data-token-id]"));
    // Anywhere else — the margins, the punctuation — keeps whatever the
    // browser would have done, its own menu included.
    if (!entry) return;
    event.preventDefault();
    selectEntry(container, entry, true);
  };

  container.addEventListener("contextmenu", interrogate);
  // And on a double click, which asks the same question with the same button
  // the rest of the panel is driven by. A right click is not always an easy
  // thing to make — a trackpad, a tablet, a mouse with one button — and it is
  // the only way to the analysis, so it should not be the only way.
  //
  // The two clicks that precede it have already run: the first selected the
  // character, the second repeated that. Both are harmless to arrive at this
  // from — selecting is what the analysis does anyway, and a menu is rebuilt
  // rather than stacked (see `openReadingMenu`).
  container.addEventListener("dblclick", interrogate);

  // A click outside an open menu dismisses it, and that is the whole of what
  // it does. Putting a menu away is an act in itself, and one the reader
  // takes by clicking at whatever is nearest rather than at anything in
  // particular — so landing on a character shouldn't also select it, or
  // start dragging it, or raise a second menu where the first one just was.
  //
  // Which takes the capture phase, and `stopPropagation` rather than the
  // handlers each checking for themselves: the drag begins on `pointerdown`
  // too, on the container, and a listener there runs *before* anything on
  // `document` in the bubble phase. Catching it on the way down is what gets
  // ahead of it.
  //
  // The flag is what carries the decision to the events that follow, since
  // dismissing happens on the press and the click arrives after it. Cleared
  // on the next press rather than when it is used, so that a second gesture
  // is a real one again — a double click outside puts the menu away and then
  // acts, which is what someone doing it twice is asking for.
  let dismissedMenu = false;
  document.addEventListener(
    "pointerdown",
    (event) => {
      dismissedMenu = false;
      if (!openMenu || (event.target as HTMLElement).closest(".token-context-menu")) return;
      closeContextMenu();
      dismissedMenu = true;
      event.stopPropagation();
    },
    true,
  );
  for (const type of ["click", "dblclick", "contextmenu"]) {
    document.addEventListener(
      type,
      (event) => {
        if (!dismissedMenu) return;
        event.stopPropagation();
        // For `contextmenu` specifically this is also what keeps the
        // browser's own menu from taking the dismissed one's place.
        event.preventDefault();
      },
      true,
    );
  }
  // Escape is handled in `setupTokenInspector`'s own keydown listener, not
  // here — it has to dismiss the menu *or* the selection, innermost first,
  // and two independent listeners would both fire and do both at once.
}

/** True while a modal dialog is up — the help guide, for now.
 *
 * These keydown listeners are on `document`, so they see keys pressed while
 * a dialog is open and would act on a panel the reader can't even see. Worse
 * for Escape specifically: the handler calls `preventDefault`, which cancels
 * the dialog's *own* native Escape-to-close, so the guide became impossible
 * to dismiss that way and silently dropped the user's selection instead. */
function modalIsOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

/** Set by `setupHeadDrag` when a drag actually moved (as opposed to a
 * plain click) — read and cleared by the click handler in
 * `setupTokenInspector`, which must not treat that drag's terminating
 * click as a fresh selection. */
let suppressNextClick = false;

/** The standing cycle-break notice, if any — module-level so the next
 * interaction can take it down without threading a reference around, the
 * same way `openMenu` works. */

/** How long a notice stands before fading on its own. Long enough to read
 * three short lines twice over; short enough that it is gone before the
 * reader's next drag rather than being dismissed by it. */


/** Re-parents `childId` under `newHeadId` where doing so closes a cycle.
 *
 * Asynchronous, unavoidably: which arc gives way is the parser's opinion,
 * and that is a round trip to the worker (measured at ~45ms per arc, and a
 * cycle rarely offers more than three). The reader's edge is not applied
 * before the answer comes back — applying it and then correcting it a
 * moment later would show them a tree that was never the one they asked
 * for.
 *
 * Re-planned against the live tree rather than the one that was measured,
 * since an undo or another edit can land during that round trip. The
 * confidences are keyed by an arc's dependent, so a candidate that survived
 * the interruption keeps its score and one that didn't is simply unknown —
 * which `planCycleBreak` already knows what to do with. If the cycle is
 * gone altogether, the plain re-parent is now the correct edit and is what
 * happens. */
async function reparentBreakingCycle(sentence: Sentence, childId: number, newHeadId: number): Promise<void> {
  const cycle = cyclePath(sentence, childId, newHeadId);
  if (!cycle) return;
  const confidences = await arcConfidences(sentence, cycleBreakCandidates(sentence, cycle, childId));

  const child = sentence.tokens.find((t) => t.id === childId);
  if (!child) return;
  const plan = planCycleBreak(sentence, childId, newHeadId, confidences);
  if (!plan) {
    applySimpleReparent(sentence, childId, newHeadId);
    return;
  }

  withUndo(() => applyCycleBreak(sentence, childId, newHeadId, plan));
  try {
    assertSingleRootedTree(sentence);
  } catch (err) {
    // Can't happen — but if it ever did, the tree on the screen would hang
    // the very next render, so put it back the way it was and let the
    // failure be loud rather than fatal.
    undo();
    rerenderPreservingSelection();
    throw err;
  }
  rerenderPreservingSelection();

  // Both arcs that changed, renamed the way the parser would name them —
  // the reader's new one, and the orphan's new attachment. A new ROOT needs
  // no relabel: `applyCycleBreak` has already given it the only label the
  // absence of a head can have.
  relabelArcsUnder(sentence, newHeadId, [childId]);
  if (plan.reattachTo !== null) relabelArcsUnder(sentence, plan.reattachTo, [plan.dropped.child]);
}

/** The whole of a re-parent that closes no cycle: one head moves, and the
 * parser renames the arc it now is.
 *
 * Takes the token by id rather than going through `applyTokenEdit`, which
 * edits whatever is currently *selected*. That is the same token here and
 * now — but its sibling `reparentBreakingCycle` reaches its edit after an
 * await, by which time the selection may be somewhere else entirely, and
 * the two should not differ in which token they claim to be moving. */
function applySimpleReparent(sentence: Sentence, childId: number, newHeadId: number): void {
  const child = sentence.tokens.find((t) => t.id === childId);
  if (!child) return;
  withUndo(() => void (child.head = newHeadId));
  rerenderPreservingSelection();
  relabelArcsUnder(sentence, newHeadId, [childId]);
}

/** Drag a token onto another to make that other token its head. A rubber-
 * band line follows the pointer while dragging (drawn in its own fixed
 * overlay SVG, so it isn't clipped by the panel), and the prospective
 * target highlights as the pointer passes over it.
 *
 * Any character can be dragged onto any other in its own sentence — the
 * ROOT included, and a target inside the dragged character's own subtree
 * included. Neither is a plain re-parent: the first leaves the sentence
 * without a root and the second closes a cycle, and `computeReadingOrder`
 * throws on the one and hangs on the other. Both are handled by giving up
 * one arc of the resulting cycle — the parser's least confident (see
 * `planCycleBreak`) — and telling the reader which one went. The reader's
 * own edge is never the one given up.
 *
 * What is still refused is what has no meaning to allow: a target in a
 * different sentence (token ids repeat across sentences, so a `head`
 * pointing into another one says nothing), and a character dropped on
 * itself. */
function setupHeadDrag(container: HTMLElement): void {
  let dragFrom: Entry | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let line: SVGSVGElement | null = null;

  const clearHighlight = () => {
    for (const el of container.querySelectorAll(".token-drop-target")) el.classList.remove("token-drop-target");
  };

  /** Whether releasing on `target` would actually re-parent — asked while the
   * pointer is still moving, so the highlight cannot offer a drop the release
   * then refuses.
   *
   * It could, and did. The highlight boxed any cell in the same sentence while
   * the release additionally refused a cycle, and refused it *silently*: the
   * reader dragged, the target lit up saying yes, they let go, and nothing
   * happened. In 負郭田三百畝、輒半種黍 that was 16 of the 72 pairs, and they are
   * not spread evenly — 種 is the sentence's ROOT, so every one of its eight
   * targets is inside its own subtree, while 負 lost half of its. Reaching for
   * the main verb, which is the obvious thing to reach for, refused every time
   * with no reason given.
   *
   * All 16 now apply: a cycle is broken rather than refused (see
   * `reparentBreakingCycle`). What is left here is the pair of drops that
   * cannot mean anything — a character on itself, and a character in another
   * sentence — so the highlight and the release still agree, which was the
   * point of this function to begin with. */
  const canDropOn = (source: Entry, target: Entry | null): boolean => {
    if (!target || target.cell === source.cell || target.token.id === source.token.id) return false;
    const gapEl = source.cell.closest(".sentence-gap");
    if (!gapEl || target.cell.closest(".sentence-gap") !== gapEl) return false;
    return !!sentenceByGap.get(gapEl);
  };

  /** Off the DOM rather than off `dragFrom`, which `endDrag` has to clear
   * anyway, and which a re-render would have left pointing at a cell no
   * longer in the document. Whatever carries the class is what gives it up. */
  const clearDragSource = () => {
    for (const el of container.querySelectorAll(".token-drag-source")) el.classList.remove("token-drag-source");
  };

  const endDrag = () => {
    line?.remove();
    line = null;
    dragging = false;
    dragFrom = null;
    clearHighlight();
    clearDragSource();
    document.body.classList.remove("token-dragging");
  };

  container.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // Whatever the last drag had to say about itself, this is the reader
    // moving on from it.
    const entry = resolveEntry((event.target as HTMLElement).closest<HTMLElement>(".kanji-cell[data-token-id]"));
    // The ROOT is draggable like anything else. It has no head arrow to
    // re-point, so what it has instead is a new head and a sentence that
    // needs a new root — which is the same cycle break every other drag of
    // this kind gets (see this function's doc).
    if (!entry) return;
    dragFrom = entry;
    startX = event.clientX;
    startY = event.clientY;
  });

  document.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < 5) return;
      dragging = true;
      // Dragging across the text would otherwise sweep a native text
      // selection through the kanji and their ruby/kunten — suppress it for
      // the duration, and drop anything already caught by the few pixels of
      // movement before the threshold tripped.
      document.body.classList.add("token-dragging");
      // The character being carried, marked where it started so the gesture
      // has both its ends on the screen: this one in the accent, the one
      // under the pointer boxed in the highlight (`.token-drop-target`).
      // Its own class rather than the selection's, which means something
      // else and is styled from a different rule — a selection spares the
      // reading of the character it marks, and a drag stands every reading
      // down including that one (see `body.token-dragging` in kunten.css).
      dragFrom.cell.classList.add("token-drag-source");
      window.getSelection()?.removeAllRanges();
      line = document.createElementNS(SVG_NS, "svg");
      line.setAttribute("class", "token-drag-line");
      // An arrowhead, because this line is the dependency arrow being drawn
      // by hand and becomes one on release — so it is pointed the way that
      // arrow will be pointed.
      //
      // Which is at the character being dragged, not at the pointer. The
      // analysis draws its arc from a head to its dependent and puts the head
      // of the arrow on the dependent (`marker-end`, the path running
      // head-first); a drag runs the other way, from the dependent the reader
      // picked up to the head they are offering it to, so the same arrowhead
      // belongs at its start. `auto-start-reverse` on the marker is what
      // turns it around to point back down the line.
      //
      // The alternative reads better for a second and worse afterwards: an
      // arrowhead under the cursor says "this goes there", and then flips the
      // moment the button comes up, because the relation it just made points
      // the other way.
      //
      // Its own copies of the two markers, under their own ids: the analysis
      // overlay's are defined inside an SVG that exists only while the
      // analysis is up, and a character can be dragged with nothing
      // inspected at all.
      line.append(arrowheadDefs("drag-"));
      // Casing first, real line over it — the same two-path halo the
      // dependency arrow uses (see `.token-arrow-path-casing`), so the
      // rubber band stays legible wherever it crosses the text. Both carry
      // the same dash pattern, so the halo wraps each dash rather than
      // laying a solid band under the whole run.
      const casing = document.createElementNS(SVG_NS, "path");
      casing.setAttribute("class", "token-drag-line-casing");
      casing.setAttribute("marker-start", "url(#drag-token-arrowhead-casing)");
      line.append(casing);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "token-drag-line-path");
      path.setAttribute("marker-start", "url(#drag-token-arrowhead)");
      line.append(path);
      document.body.append(line);
    }
    const from = dragFrom.glyph.getBoundingClientRect();
    const d = `M ${from.left + from.width / 2} ${from.top + from.height / 2} L ${event.clientX} ${event.clientY}`;
    for (const p of line!.querySelectorAll("path")) p.setAttribute("d", d);

    clearHighlight();
    const overCell = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>(
      ".kanji-cell[data-token-id]",
    );
    const over = resolveEntry(overCell ?? null);
    if (over && canDropOn(dragFrom, over)) over.cell.classList.add("token-drop-target");
  });

  document.addEventListener("pointerup", (event) => {
    if (!dragFrom) return;
    const source = dragFrom;
    const wasDragging = dragging;
    const overCell = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>(
      ".kanji-cell[data-token-id]",
    );
    const target = resolveEntry(overCell ?? null);
    endDrag();
    if (!wasDragging) return;
    suppressNextClick = true;

    // The same test the highlight was made from, so what the reader was shown
    // and what happens on release cannot disagree.
    const gapEl = source.cell.closest(".sentence-gap");
    const sentence = gapEl && sentenceByGap.get(gapEl);
    if (!target || !sentence || !canDropOn(source, target)) return;

    // With the analysis up, which is the same state a right click or a
    // double click asks for (`interrogate` — `selectEntry(…, true)`) and is
    // reached the same way rather than by a second path of its own. A drag
    // is a question about the parse answered by changing it, and the answer
    // is the analysis: the arrow now runs from the character the reader
    // chose, and the labels say what the parser made of the new arc. Landing
    // in a plain selection instead left the reader to ask for it, having
    // just done the one gesture that most obviously deserves it.
    //
    // Set before the edit rather than after, because `applyTokenEdit`
    // re-renders and `rerenderPreservingSelection` restores whichever depth
    // was up when it started — so this is also what carries the overlay
    // across the re-render onto the new cells.
    selectEntry(container, source, true);
    const childId = source.token.id;
    const headId = target.token.id;

    // Two edits, told apart by whether the target is inside the dragged
    // character's own subtree. The plain one lands at once and has the
    // parser rename the arc afterwards; the other has to ask the parser
    // which arc to give up before it can do anything at all, so it goes
    // away and comes back (see `reparentBreakingCycle`).
    if (cyclePath(sentence, childId, headId)) {
      void reparentBreakingCycle(sentence, childId, headId);
      return;
    }
    // The old label described the *old* head's relation, so it's usually
    // wrong under the new one — have the parser rename the arc it now is.
    applySimpleReparent(sentence, childId, headId);
  });
}

/** Wires up click-to-select and arrow-key navigation on the kundoku panel.
 * Clicking a `.kanji-cell` (punctuation excluded) picks its character out;
 * a right click or a double click asks what the parse makes of it and draws
 * the analysis with it (see `showInspector`). A left click on a *different*
 * character moves whatever is up onto that character, analysis included; a
 * left click on the character that is already picked out is the way back —
 * out of the analysis first, and then out of the selection — and a click
 * anywhere else in the panel, or Escape, lets the selection go at once. Once
 * a token is selected, the four arrow keys step to the
 * next/previous kanji or line (see `navigate`) regardless of where in the
 * document focus
 * happens to be — `.kanji-cell`s aren't natively focusable, so keydown is
 * caught on `document` rather than requiring the panel itself be focused;
 * guarded to do nothing while an actual text input has focus (the sidebar
 * textarea, an editable field some future feature adds, etc.), so this
 * never hijacks ordinary text-editing arrow keys. Attached once to
 * `container` (the scrollable `.tategaki` panel, which persists across
 * re-renders — only its children are replaced) and guarded by a dataset
 * flag so calling this again after a later `renderKundokuView` call is a
 * no-op, not a second listener; the sentence data it needs at click time
 * always comes fresh from `sentenceByGap`, which the current render's own
 * `registerSentence` calls keep up to date. */
export function setupTokenInspector(container: HTMLElement): void {
  if (container.dataset.inspectorAttached) return;
  container.dataset.inspectorAttached = "true";
  setupTokenContextMenu(container);
  setupHeadDrag(container);

  container.addEventListener("click", (event) => {
    // A click that concluded a head-drag isn't a selection click — see
    // `setupHeadDrag`.
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const column = (event.target as HTMLElement).closest<HTMLElement>(".tategaki-column");
    if (!column) return;
    // A label or a furigana opens its own menu (see `setupTokenContextMenu`),
    // and must not also be read as a click on the surrounding text — which
    // for a label, sitting outside any cell, would deselect the very token
    // the menu is about.
    if (isMenuTarget(event.target as HTMLElement)) return;

    const cell = (event.target as HTMLElement).closest<HTMLElement>(".kanji-cell[data-token-id]");
    const entry = resolveEntry(cell);
    if (!entry || !cell) {
      deselect(column);
      return;
    }

    // ── The character that is already picked out ──────────────────────────
    // A click on it means "enough of this", and what it puts down is one
    // thing: with the analysis up it leaves the analysis and keeps the
    // character, and from a plain selection it lets the character go too.
    // Two clicks therefore put down both, one for each of the two things
    // that are up, and the second of them is the inside counterpart of
    // Escape. `token-cell-selected` is on every cell of the picked token
    // (`tokenCells`), so any character of a multi-character token is the
    // same character for this purpose — which is what it is.
    if (cell.classList.contains("token-cell-selected")) {
      if (selected?.overlay) selectEntry(container, entry, false);
      else deselect(column);
      return;
    }

    // ── A different character ─────────────────────────────────────────────
    // The click moves the selection onto it and leaves the mode where it was:
    // pointing at another character while the analysis is up is asking the
    // same question about a different character, not asking to stop.
    //
    // This is a correction of a rounder rule. "Left-clicking a character
    // switches to normal select mode" was read as applying to any character
    // at all, so the analysis came down wherever the next click landed. It is
    // the *analysed* character a left click drops out of — the case above —
    // and the one gesture that could not be a way out was the one that
    // pointed somewhere else.
    //
    // The head is the case that shows why. With the analysis up, the head
    // carries its own box, and it is a different character: so a click on it
    // moves the analysis onto it, and the next box appears over *its* head.
    // Walking up the tree by clicking the box the arrow points at is the
    // gesture that falls out of this rule, and it is the one worth having —
    // under the older rule the same click put the analysis away and left the
    // reader with a plainly selected character in the middle of a parse.
    //
    // The arrow keys carry the mode for the same reason and always have. They
    // move the selection *within* whatever the reader asked for, one character
    // at a time along the reading; a click is how the reader changes their
    // mind about which character, and neither is a way of changing the
    // question. What is left of "a left click is the way out" is the previous
    // branch, which is where the reader says so about the character they are
    // looking at.
    selectEntry(container, entry, selected?.overlay ?? false);
  });

  // And a click anywhere else at all lets the selection go — the other panel,
  // the sidebar, the margins of this one, the page behind them.
  //
  // The two listeners are halves of one rule, and are meant to be read as
  // one: a left click means "this character", and where there is no character
  // under it, it means none. On a character, the listener above picks that
  // character out plainly; off one — the margins of this panel, or anywhere
  // in the page beyond it — this one puts the selection down. Neither ever
  // leaves the analysis standing over a character the reader has just clicked
  // away from, and both end a selection through `deselect`, so what a
  // selection consists of is written down once.
  //
  // The listener above can only answer for clicks inside a column, which left
  // the selection standing after a click on any of those, and standing is the
  // wrong default: the highlight and the analysis are what the reader is
  // being shown *about a character*, and they should end when attention
  // moves off it. Clicking away is how attention moves off it.
  //
  // On `document` rather than on the two panels, because "anywhere else" is
  // the whole page and enumerating it would mean listing every future part of
  // the interface too. What it must not catch is enumerable, and short:
  //
  //  - a click inside *this panel's* column, which the listener above has
  //    already dealt with, including deciding when *not* to deselect. Read
  //    off `container` rather than off the class, because the class is not
  //    this panel's own: the kakikudashi panel is a `.tategaki-column` too
  //    (`text-kakikudashi`, in KakikudashiView.ts), and so is every sample
  //    in the guide. Matching on the class alone therefore exempted the
  //    prose — see below — and would have gone on exempting whatever else
  //    came to be set vertically;
  //  - the labels and readings, which sit outside their cell but belong to
  //    it, and are the targets for their own menus;
  //  - the menus themselves, and anything inside the analysis overlay. The
  //    menus are children of `<body>` (`openContextMenu`, `openReadingMenu`),
  //    so by position they are outside every panel there is, and they act on
  //    the selected token — a retag that deselected the character it was
  //    retagging would be no retag at all;
  //  - a click that dismissed a menu, which never reaches here at all: that
  //    handler stops the event during the capture phase, so there is no
  //    bubble phase left for this one to run in. Putting a menu away is an
  //    act in itself, and not also a click on what lies beneath it;
  //  - the click that ends a head drag, which `suppressNextClick` carries
  //    over from `setupHeadDrag`. A drag begins on a character and may be
  //    released anywhere at all — over the prose, over the sidebar, off the
  //    end of the page — and the release is the end of that gesture, not a
  //    click away from the character the gesture is about;
  //  - the click that ends a *text* drag, which is not a click on wherever
  //    the pointer stopped either. Told apart by the text selection it
  //    leaves standing: a plain click collapses whatever was selected as it
  //    goes down, so a range still standing at click time is one this very
  //    gesture swept out. Tested by containment rather than by mere
  //    existence, so that a click somewhere else entirely while a range
  //    happens to be standing — on a control that doesn't take the caret,
  //    which is free to leave the range alone — still counts as a click
  //    away.
  //
  // Guarded on a modal too, for the reason `modalIsOpen` gives: the guide
  // covers the panel, and a click in the guide is not a click away from a
  // character the reader cannot currently see. The reader who opens the
  // guide over a character has usually opened it *about* that character,
  // and comes back to the analysis still drawn where they left it.
  //
  // What this does *not* exempt, deliberately, is the kakikudashi panel.
  // It is outside the kundoku panel, so the rule reaches it — and nothing
  // there answers a click: KakikudashiView.ts attaches no listeners at all,
  // and the highlight it shows is a reflection of the selection in this
  // panel rather than a selection of its own (`highlightKakikudashi`). So a
  // click on the prose can only mean that the reader has looked away from
  // the character, which is the case this listener exists for. Exempting it
  // also split one panel in two: its margins fall outside every column and
  // so already let the selection go, while its words did not, and which of
  // the two a click got depended on whether it landed on a glyph.
  document.addEventListener("click", (event) => {
    if (!selected || modalIsOpen()) return;
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const target = event.target as HTMLElement;
    const textRange = window.getSelection();
    if (textRange && !textRange.isCollapsed && textRange.anchorNode && target.contains(textRange.anchorNode)) return;
    const column = target.closest(".tategaki-column");
    if (
      (column && container.contains(column)) ||
      target.closest(".token-context-menu") ||
      target.closest(".token-inspector-overlay") ||
      isMenuTarget(target)
    ) {
      return;
    }
    deselect(selected.column);
  });

  const ARROW_DIRECTIONS: Record<string, "up" | "down" | "left" | "right"> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };
  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (modalIsOpen()) return;

    // Innermost thing first: an open retag menu absorbs Escape on its own,
    // leaving the token selected underneath it.
    if (event.key === "Escape" && openMenu) {
      event.preventDefault();
      closeContextMenu();
      return;
    }
    if (!selected) return;
    if (event.key === "Escape") {
      event.preventDefault();
      deselect(selected.column);
      return;
    }
    const direction = ARROW_DIRECTIONS[event.key];
    if (!direction) return;
    event.preventDefault();
    navigate(direction);
  });

  // Undo/redo, on its own listener because it must work with nothing
  // selected — the handler above returns early in that case, which is
  // right for Escape and the arrow keys and wrong for this.
  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    // The sidebar textarea keeps its own native undo stack; never take
    // Cmd+Z away from a field the user is actually typing in.
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
    if (modalIsOpen()) return;

    // Cmd on macOS, Ctrl elsewhere — accepted interchangeably rather than
    // sniffed for, since the other platform's key doesn't collide with
    // anything here (Ctrl+Z has no meaning on macOS, and Windows has no
    // Cmd). Shift+Cmd+Z is the usual redo; Ctrl+Y is its Windows spelling.
    const accel = event.metaKey || event.ctrlKey;
    if (!accel) return;
    const key = event.key.toLowerCase();
    const action = key === "z" ? (event.shiftKey ? redo : undo) : key === "y" ? redo : null;
    if (!action) return;

    // Only claim the keystroke if there was actually something to undo,
    // so at the ends of the history it falls through to the browser.
    if (!action()) return;
    event.preventDefault();
    closeContextMenu();
    rerenderPreservingSelection();
  });
}
