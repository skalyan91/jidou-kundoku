import type { Sentence, Token } from "../parse/types.ts";
import { redo, undo, withUndo } from "./editHistory.ts";
import { candidateReadings, type KanjidicIndex, type ReadingCandidate } from "../reading/kanjidicLookup.ts";
import { compoundMemberCandidates } from "../reading/compoundReading.ts";
import {
  type ConjClass,
  CONJ_CLASS_CARTOUCHE,
  CONJ_CLASS_UNKNOWN_CARTOUCHE,
} from "../kakikudashi/classicalConjugation.ts";
import type { HistoricalKanaIndex } from "../reading/historicalKana.ts";
import type { JmdictIndex } from "../reading/jmdictLookup.ts";
import { isRereadUse, rereadCharacter } from "../kakikudashi/rereadCharacters.ts";
import {
  chosenTopicParticle,
  clearChosenReading,
  clearChosenTopicParticle,
  derivedConjClass,
  setChosenReading,
  setChosenTopicParticle,
  storedReadingText,
} from "../reading/chosenReading.ts";
import { toKatakana } from "./kana.ts";
import { parserStarted, scoreArc } from "../parse/pyodideClient.ts";
import deprelFrequency from "../parse/deprel-frequency.json" with { type: "json" };
import { cachedXposScores, loadXposScores, prefetchXposScores } from "../parse/xposScoreCache.ts";
import {
  XPOS_INVENTORY,
  domainsUnder,
  parseXpos,
  sensesUnder,
  syntacticPrefix,
  uposForXpos,
  withDomain,
  withPrefix,
  withSense,
  xposFrequency,
  xposPartOfSpeech,
  xposMenuPrefixes,
  xposPrefixes,
  xposSemanticLabel,
  xposesUnder,
} from "../parse/xpos.ts";

/** UPOS (Universal POS) tags, translated to the standard Japanese terms for
 * these categories — not a kanbun-specific gloss, since UPOS itself is a
 * general cross-linguistic tagset, not a kanbun grammar concept. Unlisted tags
 * (there shouldn't be any, in practice) fall back to the raw tag itself — see
 * `uposJa`.
 *
 * **This is no longer the menu's table**, and that is the whole of what
 * changed here. The 品詞 menu offers the treebank's own xpos now (see
 * `posMenuPrefixes`), and UPOS is derived from what the reader picks rather than
 * picked directly — the correspondence being many-to-one in the UPOS direction
 * and not in the other, so a UPOS menu cannot say which kind of 名詞 a noun is
 * and cannot express the semantic pair at all (the argument is written out at
 * the head of `xpos.ts`). What is left for this table is two jobs, both real:
 *
 *   - **the chip's fallback.** A token with no XPOS column — a CoNLL-U upload
 *     that carries none, and the help modal's own figures until they were
 *     given real tags — has no 品詞 for the first chip to say, and its
 *     category is then exactly what UPOS says it is. `posChipParts` falls back
 *     here rather than drawing an empty chip.
 *   - **naming what an edit writes.** Picking a row sets `token.pos` from
 *     `uposForXpos`, and every tag that function can return has to have a name
 *     in this app — checked at load in `assertMenuLabelsComplete`, which is
 *     the one guard of the old three that still guards something.
 *
 * All seventeen stay, `DET` and `X` included, though the derivation table can
 * return neither: an uploaded tree may carry either, and the chip has to be
 * able to name what it is shown. */
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

/** The relation menu's own section structure, grouped under the headings a
 * printed grammar table would use, so a 34-entry list reads as a few short
 * scannable runs instead of one undifferentiated column. Grouping (not gojūon
 * order) is deliberate: the value you want is nearly always findable by its
 * *kind*, and neighbouring relations that differ only by subtype
 * (mod/mod@tmod/mod@lmod) belong side by side — which the bracketed labels
 * now say out loud as well as by position.
 *
 * `DEPREL_GROUPS` *is* the relation menu's inventory: `DEPREL_JA` holds
 * base names only, so the list of relations a reader can actually pick is
 * this one (flattened as `DEPREL_INVENTORY`).
 * `assertMenuLabelsComplete` below checks it at module load, so a relation
 * added here without a base name or a subtype gloss cannot go unlabelled.
 *
 * **There is no hand-written table beside this one any more.** `UPOS_GROUPS`
 * filed the seventeen UPOS under 体言/用言/虚字/雑字, and it is deleted with
 * the menu it served: the 品詞 menu's groups are the treebank's own syntactic
 * prefixes now, headed by the 品詞 itself (名詞, 動詞, 助詞…), and they are
 * generated from the corpus rather than filed by hand — `xposPrefixes` and
 * `xposesUnder` in xpos.ts, ordered commonest-first. The four headings go with it, and two of
 * them had arguments worth keeping if a hand-filed grouping is ever wanted
 * again: 虚字 for the function words, because 体言 and 用言 divide the 実字
 * and this tradition has a name for the remainder rather than needing the
 * modern-linguistic 機能語; 雑字 for what is neither of those, because the
 * その他 it replaced was itself the gloss of one of that group's own members
 * (`X`). Neither question arises now — a group is a 品詞 and names itself.
 *
 * ── The order, which is a handbook's and not this file's ──────────────────
 * The reader's instruction: *"Deprels should also be sorted in a traditional
 * order, to the extent that they match traditional analyses."* "Also" is the
 * word that says where to look — the 品詞 menu was put into 三省堂『全訳漢辞
 * 海』's 品詞分類 a round ago (`xposMenuPrefixes` in parse/xpos.ts, whose block
 * comment sets out the convention, how it was cross-checked, and what was
 * rejected). This is the same job for the relations, done the same way: a
 * named source, followed where the two inventories meet, and departures
 * written down rather than smoothed over.
 *
 * **The source.** 数研出版『体系漢文』(改訂版) — the second of the two
 * handbooks `xposMenuPrefixes` names — which files the sentence into six
 * 成分 on two tiers, as reported with the author's own wording by 漢文学びの
 * とびら (xuexi.mokuren.ne.jp, 『体系漢文』で用いる文法用語のこと・2 and ・5):
 *
 *     基本成分（文の骨組み）  主語 → 述語（謂語）→ 目的語（賓語）
 *     修飾成分（述語を修飾）  連体修飾語（定語）→ 前置連用修飾語（状語）
 *                             → 後置修飾語（補語）
 *
 * Two tiers, the second modifying the first, which is the same shape as the
 * 実詞/虚詞 split the 品詞 order runs on — and the two group headings here are
 * the handbook's own two words for them, exactly as 実詞/虚詞 would have been.
 *
 * **Where the relations land, and how exactly.** Four of the six are a single
 * SUD relation apiece and need no argument: 主語 `subj`, 述語 `ROOT`, 目的語
 * `comp:obj`, 後置修飾語（補語）`comp:obl`. The last of those is the one place
 * the filing moved a relation from one group to another, and the fit is
 * unusually tight rather than approximate: 体系漢文 defines its 補語 as the
 * word "訓読で『～を』と読まず、『～に・～より』などと読む" one — which is
 * exactly what `comp:obl` is in this app, the 於-marked oblique, and exactly
 * how `kundokuTenAssigner` reads it. The handbook calls it a 修飾成分 and not
 * a 基本成分, so it goes with the modifiers, at the end of them, where the
 * handbook puts it.
 *
 * **Where SUD is coarser than the handbook**, which is the reverse of the
 * case the reader flagged and happens once. 連体修飾語（定語）and 前置連用修飾
 * 語（状語）are two 成分, and `mod` is one relation covering both — 大 in 大國
 * and 甚 in 甚善 are both `mod`. So `mod` cannot be placed *by* the handbook:
 * it spans the two slots, and it is therefore left at the head of the span it
 * spans, in the order it already had. `det` and `clf` are 定語 and nothing
 * else, so they sit inside that span rather than ahead of it; ordering them
 * before `mod` would be claiming that `mod` is only 状語, which it is not.
 *
 * **Where the handbook has nothing to say**, which is most of the tail, and
 * each is given a place rather than a correspondence:
 *
 *   - `comp:pred`, `comp:aux`, `comp@expl` — 述語補語, 助動詞補語, 形式補語.
 *     No 成分 answers to any of them: they are the pieces a predicate is built
 *     *of* (the noun under 為/也, the verb under 可/能/欲, an expletive), not
 *     things the predicate stands in a relation to. They stay in the basic
 *     group, after the three 成分 that are, because that is where the
 *     predicate is.
 *   - `cc`, `conj:coord` — 接続語 and 並列語 are 成分 in the 学校文法 the
 *     handbooks share their vocabulary with, and they come after 修飾語 there.
 *     Their own group, in that position.
 *   - `vocative`, `dislocated`, `discourse` — 独立語 in that same scheme
 *     (呼びかけ, 提示, 感動), and so filed together and next; `parataxis`,
 *     `list` and `punct` have no counterpart at all and take the tail of the
 *     group they were already in, which is what keeps `punct`'s own note below
 *     (and the test that pins it) true.
 *   - `compound`, `flat` — **not 成分 at all**, and the reason they moved to
 *     the back is that they are a fact about a *word* rather than about a
 *     sentence: 複合語 is a category of the lexicon in every one of these
 *     handbooks, and a tradition that analyses the sentence into 成分 has
 *     nothing to say about the inside of one of its 語. Last but for the
 *     relations that are not analyses at all.
 *   - `dep`, `udep`, `unk` — 未分類, unchanged and still last: what the parser
 *     could not place cannot be placed here either.
 *
 * **Rejected: the 五文型.** The other order a reader might expect, and the one
 * the instruction sketched — 主語・述語・目的語・補語・修飾語, with 補語 a
 * fourth core element. It is real and it is taught, but it is the *English*
 * five-pattern scheme carried over (青蛙亭漢語塾's 五文型 page says as much in
 * so many words: 漢文 does not distinguish 目的語 from 補語, and the five exist
 * 「英文法に合わせて」), and 体系漢文's 改訂版 went the other way — it retired
 * 補語 as a 成分 outright and kept the word only for a kind of 後置修飾語. Given
 * a choice between a handbook this app already follows for its 品詞 and a
 * borrowed pattern-count, the handbook is taken, and the one place the two
 * differ is here in writing.
 *
 * **Rejected: sorting by frequency inside the groups**, for the reason
 * `xposMenuPrefixes` gives about its own tail: the request is to follow an
 * order, and a two-level sort composed here would be neither the handbook's
 * nor the corpus's.
 *
 * **Not verifiable here.** No browser in this checkout, so nothing says the
 * menu *draws* in this order — only that the list it is built from is in it,
 * which is what tests/deprelLabels.test.ts pins.
 *
 * ── ROOT, promoted to a category of its own, first ───────────────────────
 * The reader's later instruction: *"put the root relation in its own,
 * singleton category at the beginning."* ROOT had been sitting inside 基本成分
 * beside `subj` and `comp:obj` because that is where the handbook's own table
 * puts it — 主語 → 述語（謂語）→ 目的語（賓語） — and nothing above argues it
 * does not belong there grammatically. What changes is not the correspondence,
 * which stands, but the filing: ROOT is not a relation *to* a head the way the
 * other five in that group are, it is the fact of having none, and grouping it
 * with ordinary arcs was always a little untrue to that. Lifted into a group
 * of one, it keeps the handbook's own name for what it names — 述語, the
 * predicate a sentence's ROOT is glossed as at line 279 above and in
 * `DEPREL_JA` itself — rather than the more general `文の主辞` that row's own
 * label already carries; heading and row would otherwise read the same word
 * twice for no reason.
 *
 * `述語` is recorded in `en.json`/`ja.json` as `deprel.group.root.heading`
 * (`"Predicate"` / `"述語"`) because the reader asked for a heading in both
 * languages, but it is not read from there: every other heading in this
 * table, and every relation and 品詞 name in the app, is fixed Japanese
 * grammatical terminology regardless of which UI language is showing, for the
 * reasons `UPOS_JA`/`DEPREL_JA` are never routed through `t()` either — and
 * the default UI language is English (`i18n.ts`'s `readStoredLang() ?? "en"`),
 * so wiring just this one heading through the toggle would show five Japanese
 * headings and one English one on the very first screen a reader sees. The
 * i18n entry is the bilingual record the instruction asked for; the menu's
 * own Japanese stays a literal here, matching its five siblings.
 *
 * `deprelMenuGroups()[0]` is this group and only this group from now on —
 * `assertMenuLabelsComplete`'s split-across-groups check still passes because
 * ROOT never appears anywhere else in this table, and `MENU_HEADINGS` picks
 * up `述語` automatically since it maps every heading out of this array
 * rather than counting them by hand. The one caller that used to read index 0
 * for a *worked example* of a subtyped row beside plain ones — the help
 * modal's 係り受け figure — cannot go on doing that: a singleton has nothing
 * to be subtyped beside. See `deprelRowsShown` in HelpModal.ts for what it
 * reads instead and why. */
const DEPREL_GROUPS: [heading: string, rels: string[]][] = [
  ["述語", ["ROOT"]],
  ["基本成分", ["subj", "comp:obj", "comp:pred", "comp:aux", "comp@expl"]],
  ["修飾成分", ["mod", "mod@tmod", "mod@lmod", "det", "clf", "comp:obl", "comp:obl@lmod"]],
  ["接続・並列", ["cc", "conj:coord", "conj:coord@emb"]],
  ["談話・その他", ["vocative", "dislocated", "discourse", "discourse@sp", "parataxis", "list", "punct"]],
  ["複合語", ["compound", "compound@redup", "flat", "flat@vv", "flat@foreign"]],
  ["未分類", ["dep", "udep", "udep@lmod", "udep@tmod", "unk", "unk@expl"]],
];

/** **The 品詞 menu's inventory is not written in this file at all**, and this
 * note is where the old hand-kept sets used to be.
 *
 * Three of them are deleted. `MORPHOLOGIZER_UPOS` was the fifteen UPOS the
 * shipped wheel's morphologiser can put on a token, read out of
 * `labels.morphologizer` in `lzh_sud_kyoto-0.3.2`'s own `meta.json`;
 * `OFFERED_UPOS` was those fifteen less the uneditable one; `UPOS_GROUPS` was
 * the filing of all seventeen. All three existed to answer one question —
 * which tags may the 品詞 menu offer — and the menu does not offer tags any
 * more. It offers the treebank's four-field xpos, and the answer comes from
 * `XPOS_INVENTORY`: 121 tags under 11 syntactic prefixes, counted off the
 * whole Kyoto treebank (533 362 tokens) by `scripts/build-xpos-inventory.py`.
 * Keeping a set that no code reads, against a model that no longer decides
 * what the menu contains, would be keeping a fact about the wrong thing.
 *
 * **The morphologiser is not the authority here, and could not be.** It has
 * no opinion about an xpos: the tagger is a separate pipe, and its label set
 * is not 121 whole tags but **146 `field,value` pairs** — 4 first fields, 12
 * 品詞, 46 domains and 84 senses (counted in the same `meta.json`). So the
 * model *composes* the four fields and can in principle write a tag the
 * treebank never does; one of its twelve 品詞, 文字, does not head a single
 * attested tag. That is not a defect to guard against but the reason
 * `offeredValues` keeps a token's own value at every level whether the
 * inventory has it or not, exactly as a `DET` used to keep its entry in the
 * UPOS menu.
 *
 * What is *not* deleted is `UNEDITABLE_UPOS` below. Its argument is about what
 * an edit does to the editing system, not about what a model can emit, and it
 * transfers to the new menu intact — see there. */

/** The UPOS that makes a token uneditable, and so the one thing the 品詞 menu
 * must not let a reader write.
 *
 * `resolveEntry` returns `null` for `token.pos === "PUNCT"`: a mark draws no
 * chip, no arrow and no overlay, and clicking one selects nothing. Confirmed
 * on the page as well as in that function — inspecting a 。 leaves the panel
 * with no `.token-subtitle`, no `.token-arrow-label`, no
 * `.token-inspector-overlay` and no `.token-cell-selected`.
 *
 * So **neither menu can be opened on a mark**, and an entry that writes
 * `PUNCT` could only ever have done one thing: turn some *other* character
 * into one. That is not a rare edit, it is a **one-way** edit — the moment it
 * lands the cell stops resolving, so the menu that made the change can never
 * be opened on it again to undo it. An entry whose only use is to remove a
 * token from the editing system is not an entry.
 *
 * The cost, stated plainly: a mark the model mis-tagged as something else can
 * no longer be corrected *to* punctuation from this menu. If that turns out
 * to be wanted, the answer is not to put these entries back — it would be the
 * same trapdoor — but to let `resolveEntry` admit PUNCT tokens so that the
 * edit has a way back. That is a change to what a mark *is* in this panel and
 * belongs with `resolveEntry`, not here.
 *
 * ── Why this survived the move to an xpos menu, and how it is spent now ──
 * It was one tag out of a list of seventeen and is now a *derived* property
 * of a row: what a row writes is `uposForXpos(xpos, morph)`, so what has to
 * be hidden is every row that derives to a member of this set. Five do —
 * 記号〖句点〗, 記号〖読点〗, 記号〖括弧開〗, 記号〖括弧閉〗 and the
 * senseless 記号 — which is a stronger reason to derive the hiding than to
 * list it: a hand-written list of five xpos strings would be five chances to
 * mistype one, and a mistyped member of a *subtraction* hides nothing and
 * fails silently. Filtering by what the row would write cannot miss one.
 *
 * The 記号 group survives the filtering with 記号〖一般〗, which derives to
 * `SYM` — a symbol is not a mark of punctuation and resolves like any other
 * token — so no group is emptied and the eleven headings all stand. */
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

/** **A token's category as the three chips write it**: the treebank's 品詞,
 * the semantic domain, and the sense inside it.
 *
 * ── Three, and the two arrangements this replaces ────────────────────────
 * There was an `xposLabel` here that composed the whole tag into one string,
 * 動詞〖行為・動作〗, in the same 〖〗 a relation's subtype is written in. One
 * pill has one font size, so a composed chip was sized against
 * 名詞〖人・その他の人名〗 — twelve characters, on every character of the text
 * — and a reader saw it on a page and reported it as too small to read. Two
 * pills, 品詞 over 行為・動作, halved the worst case to eight and were still
 * reported small.
 *
 * Three pills follow the tag's own shape rather than a compromise about
 * length. **The pair is a hierarchy and not a compound**: 行為 is a domain and
 * 動作 is one of the fourteen senses inside it, so 行為・動作 and 行為・伝達
 * share a level that 描写・形質 does not, and the `・` between them was a
 * compound's mark standing in for a parent's. Splitting there says what the
 * tag says, and the sizing follows from it — the longest 品詞 is 3, the
 * longest domain 3, the longest sense 6, against 12 composed. See
 * `CHIP_SIZE_OF_CELL` for what that is in pixels and for the guarantee the
 * splitting eventually let go of, and `domainsUnder`/`sensesUnder` in xpos.ts
 * for the same argument made about the menus.
 *
 * The bracket and the `・` are both gone from the chips with the composition
 * that needed them. They exist to say that one thing narrows another, and
 * three pills of descending size say that by position and rank. The 〖〗 goes
 * back to being the deprel label's alone, which is where it came from and
 * where the font measurements behind `subtypeBracketClass` were made.
 *
 * ── What each part is, and when it is absent ─────────────────────────────
 * `word` is the second field and is always present. `domain` and `sense` are
 * the third and fourth, and each is absent exactly where the treebank writes
 * `*` there — which means "the scheme records nothing at this level", not "a
 * value called `*`". Printing it would read as a value; drawing an empty pill
 * would read as a value the app had failed to find. So `p,助詞,句末,*` shows
 * two chips and `p,接尾辞,*,*` shows one.
 *
 * `domainsUnder`/`sensesUnder` list `*` because it is a real field value and a
 * round trip needs it. Hiding it *here* is this file's job, and this is where
 * that starts.
 *
 * **It no longer follows that a `*` level has no menu.** It used to: a level
 * with no chip has nothing to open a menu from, so the menus dropped every `*`
 * row for the same reason the chips do. The sense menu now offers `*` as an
 * explicit choice (see above `editableTag`), and the two rules have come
 * apart on purpose. They answer different questions. A chip says what the tag
 * *records*, and for an empty field there is nothing to record and nothing to
 * draw — an empty pill would read as a value the app had failed to find, which
 * is exactly the misreading that kept `*` off the page in the first place. A
 * menu row says what a reader *may choose*, and "no sense" is a thing a reader
 * can mean. So the chip stays absent and the menu beside it gains a row, and
 * what a reader sees after picking that row is one fewer pill — which is the
 * chips saying, correctly, that the tag now records nothing there.
 *
 * The other one-chip case is the upload path, and it is why `UPOS_JA` outlived
 * the menu it was written for. Every tree this app parses for itself carries
 * an xpos — the wheel's tagger writes `_t.tag_` into it (see
 * `pyodideWorker.ts`) — but a CoNLL-U file may have `_` in that column, and
 * this app's own exporter writes back whatever it read. Such a token still has
 * a category; it is just that the only statement of it is the UPOS one, so the
 * first chip reads 名詞 (or 限定詞, which no xpos derives to and only an upload
 * can bring in) and the other two are not drawn. Nothing here manufactures an
 * xpos out of a UPOS, which cannot be done: one UPOS answers to many xpos, and
 * that many-to-one-ness is the whole reason the menu changed direction.
 *
 * **A reader can tell a tagged token from an untagged one** — one chip against
 * two or three — which matters and is visible without being explained. What
 * they cannot tell from the chips alone is an untagged token from a
 * `p,接尾辞,*,*`, both of which show one pill. That is accepted: the
 * difference is between a tag with no semantics and no tag at all, which is a
 * distinction for the menus (one opens on the 品詞 chip with 接尾辞 marked,
 * the other with nothing marked) rather than for a pill. */
export interface ChipParts {
  /** The first chip: the 品詞, or the UPOS gloss where there is no xpos. */
  readonly word: string;
  /** The second chip, absent where the tag records no domain. */
  readonly domain?: string;
  /** The third chip, absent where the tag records no sense. */
  readonly sense?: string;
}

export function posChipParts(token: Pick<Token, "pos" | "xpos">): ChipParts {
  const parts = parseXpos(token.xpos);
  if (!parts) return { word: uposJa(token.pos) };
  return {
    word: parts.word,
    ...(parts.domain === "*" ? {} : { domain: parts.domain }),
    ...(parts.sense === "*" ? {} : { sense: parts.sense }),
  };
}

/** **One token's three category menus.**
 *
 * The flat menu these replace offered all 116 editable tags at once, filed
 * under eleven 品詞 headings: the largest menu in the app by a factor of five,
 * and one that asked a reader choosing what kind of noun a noun is to scan
 * past every kind of verb on the way. The chips are three now
 * (`posChipParts`), each naming one field of the tag, and each carries the
 * menu for its own field:
 *
 *     品詞      11 rows      the prefixes the treebank uses
 *     domain    ≤ 14 rows    the domains under this 品詞 (名詞 has the most)
 *     sense     ≤ 14 rows    the senses under this 品詞 and domain (動詞・行為)
 *
 * The question a reader is answering is the question the menu contains, and no
 * menu is longer than a column.
 *
 * None of the three lists is written here: `xposPrefixes`, `domainsUnder` and
 * `sensesUnder` are the corpus's own, commonest first. What this file adds is
 * two subtractions and one addition, and they are the same three at every
 * level, which is why they are written once each rather than three times.
 *
 * **`*` goes from two of the three menus, and stays in the sense menu.** It is
 * the treebank writing "the scheme records nothing at this level", and the
 * argument for hiding it everywhere was that the chip for such a level is not
 * drawn (`posChipParts`) and a menu is opened from a chip — so a `*` row would
 * be an entry in a menu that cannot be opened, offering a reader the chance to
 * say nothing.
 *
 * The premise is true of the *token's own* empty field and says nothing about
 * anyone else's. A token whose sense is real draws a sense chip, opens a sense
 * menu, and had no way to say that the sense is wrong and there is none — and
 * that cost one whole tag: `n,名詞,思考,*` is the only tag in the inventory
 * whose sense is `*` under a domain that also has a real one (思考・思考, 862
 * occurrences against this one's 6), so no token could land on it and its own
 * token could not leave and return. The reader asked for "no sense" as a
 * choice; the sense menu offers `*`, written 「なし」 (`fieldLabel`), and the
 * inventory is reachable to the last tag.
 *
 * **The domain menu keeps the subtraction**, which is not an inconsistency but
 * the same test coming out the other way. `*` is a domain of three 品詞 only:
 * under 接尾辞 and 感嘆詞 it is the *only* domain, so those tokens draw no
 * domain chip and have no menu to put the row in, and under 記号 the row would
 * write `s,記号,*,*`, which derives PUNCT and goes by the rule below. A row
 * that no menu can show and no menu may offer is not a row. Nor is it the same
 * request: a `*` domain is the whole tag's semantics being absent, where a `*`
 * sense is one field of it.
 *
 * **The chip stays hidden either way.** A menu row says what a reader may
 * choose and an empty pill would say what the tag records — see
 * `posChipParts`, which is where that asymmetry is argued.
 *
 * **A row whose pick would unmake the token goes**, which is the rule argued
 * at `UNEDITABLE_UPOS`, applied here to what the pick *writes* rather than to
 * the row's own text. The three `with*` helpers make that a uniform test: a
 * row is offered when `uposForXpos` of the tag it would produce is editable.
 *
 * **The token's own value stays**, wherever it came from. A token can arrive
 * wearing a tag no annotator ever wrote — the tagger composes the four fields
 * separately, and an uploaded CoNLL-U can hold anything — and a menu that
 * cannot show the value the chip beside it is displaying leaves nothing marked
 * and makes the first edit a silent discard. It is appended rather than sorted
 * in: the order is a frequency order and an unattested value has no frequency
 * to be ordered by, so last is the one position that claims nothing.
 */

/** Whether a tag is one this app can leave a token holding — the policy
 * `UNEDITABLE_UPOS` states, asked of a *tag* rather than of a menu row.
 *
 * Passed into `withPrefix` as well as applied to the rows, and the difference
 * matters: the repair that runs when a 品詞 changes picks a landing tag of its
 * own, and without this it picked 記号's commonest, `s,記号,句点,*` — a full
 * stop, deriving PUNCT — so the row was then filtered out and 記号 could not be
 * chosen at all. With the same policy inside the repair, 記号 lands on
 * `s,記号,一般,*` instead, which is SYM and resolves like any other token, and
 * both the 品詞 and that tag become reachable. */
export function editableTag(xpos: string, token: Pick<Token, "morph">): boolean {
  return !UNEDITABLE_UPOS.has(uposForXpos(xpos, token.morph) ?? "");
}

/** The three subtractions and the one addition, over one level's values.
 *
 * `rewrite` is what picking a value would write — `withPrefix`, `withDomain`,
 * `withSense` — so the uneditable test is on the resulting tag rather than on
 * the value, and cannot be fooled by a value that is safe under one parent and
 * not under another.
 *
 * `empty` is which of the two answers this level gives to `*`: `"offer"` for
 * the sense menu, `"drop"` for the other two, argued at length above. It
 * governs the token's own value as well as the list's, so that the one rule
 * covers a `p,助詞,句末,*` (whose sense list is `["*"]` and whose own value is
 * the same `*`) without a second clause about it.
 *
 * The uneditable test deliberately does *not* apply to the token's own value.
 * That is the "keep what the token wears" rule and it outranks this one: a
 * 句点 token's domain menu shows 句点 marked, because a menu that cannot show
 * the value the chip beside it displays makes the first edit a silent
 * discard. */
function offeredValues(
  values: readonly string[],
  current: string | undefined,
  token: Pick<Token, "morph">,
  rewrite: (value: string) => string,
  empty: "drop" | "offer" = "drop",
): string[] {
  const meant = (value: string) => value !== "*" || empty === "offer";
  const offered = values.filter(
    (value) => meant(value) && !UNEDITABLE_UPOS.has(uposForXpos(rewrite(value), token.morph) ?? ""),
  );
  if (current !== undefined && meant(current) && !offered.includes(current)) offered.push(current);
  return offered;
}

/** **How a field with nothing in it is written where a reader has to read it**
 * — 「なし」, and never the `*` the treebank stores.
 *
 * `*` is the tagset saying "the scheme records nothing at this level". Drawn
 * raw in a menu it reads as a failure to find something rather than as a
 * value, which was half the case for hiding every `*` row; the other half was
 * that no such row could be opened, and that half was only ever true of the
 * domain menu (see the note above `editableTag`). So the row is offered at the
 * one level that can show it, and this is the other half of offering it.
 *
 * **The label only.** What is stored, what marks the current row, and what the
 * shading asks about all stay `*` — that is what a round trip writes back into
 * the XPOS column, and a menu that stored its own prose would be a menu that
 * edits the file every time it is opened.
 *
 * Every row of the domain and the sense menu is drawn through this, not only
 * the empty one, so a value that is not Japanese cannot reach a column of
 * Japanese without being given a name here; `tests/adjectiveCategory.test.ts`
 * walks the whole inventory to check that none does. The 品詞 menu draws the
 * second field of a `letter,word` prefix, which is never `*`. */
export const EMPTY_FIELD_LABEL = "なし";

export function fieldLabel(value: string): string {
  return value === "*" ? EMPTY_FIELD_LABEL : value;
}

/** The first chip's menu: the 品詞, as `letter,word` prefixes, commonest
 * first.
 *
 * Ten of the eleven, for most tokens, and the missing one is worth stating.
 * **記号 is not offered** — not because a symbol is uneditable, but because of
 * what picking it would write. `withPrefix` keeps the semantic pair where the
 * new 品詞 has it and otherwise takes that 品詞's *commonest* tag, and 記号's
 * commonest is `s,記号,句点,*`, a full stop: 42 983 of its 101 556 tokens. So
 * picking 記号 on an ordinary character would tag it a mark, derive `PUNCT`,
 * and stop the cell resolving — the exact trapdoor `UNEDITABLE_UPOS` exists to
 * shut, arrived at through the repair rather than through the row.
 *
 * The cost is that `s,記号,一般,*` — a symbol, which derives to `SYM` and
 * resolves like any other token — cannot be reached from this menu either. It
 * is reachable for a token that already has it: the token's own prefix is
 * always offered, so a 記号 token gets its eleventh entry and can edit its
 * domain from the chip beside it. Making it reachable for everyone is a change
 * to `withPrefix` in xpos.ts (preferring the commonest *editable* tag over the
 * commonest tag), not to this file, and is left to whoever wants it: this menu
 * offers what the helpers write, and second-guessing them here would put the
 * repair rule in two places.
 *
 * A twelfth entry appears for a token whose own 品詞 the treebank does not
 * have — the tagger's twelve include 文字, which heads no attested tag. */
export function posMenuPrefixes(token: Pick<Token, "xpos" | "morph">): string[] {
  // **The order to offer, which is not the order of commonness.** The reader's
  // rule: *"Always sort menu items in the order found in traditional grammar
  // handbooks."* `xposMenuPrefixes` is that order and `xposPrefixes` is still
  // the corpus's; the two are separated in xpos.ts, where the convention
  // followed and its sources are recorded, because `withPrefix`'s fallback and
  // the shading go on needing the frequency order to mean the frequency order.
  // `MENU_HEADINGS` below stays on `xposPrefixes` deliberately: it is a label
  // set for cell arithmetic, not a menu.
  return offeredValues(xposMenuPrefixes(), syntacticPrefix(token.xpos), token, (prefix) =>
    withPrefix(token.xpos, prefix, (candidate) => editableTag(candidate, token)),
  );
}

/** The second chip's menu: the semantic domains of this token's own 品詞.
 *
 * Empty for a token with no treebank tag, and empty is right: such a token
 * draws no domain chip, so there is nothing to open this from. A 記号 token's
 * comes to one row — 一般, its five marks having gone by the rule above — which
 * is a menu of one and is still worth opening: it is what tells the reader
 * that there is nothing else 記号 can be. */
export function domainMenuValues(token: Pick<Token, "xpos" | "morph">): string[] {
  const parts = parseXpos(token.xpos);
  if (!parts) return [];
  return offeredValues(
    domainsUnder(syntacticPrefix(token.xpos)!),
    parts.domain,
    token,
    (domain) => withDomain(token.xpos, domain),
  );
}

/** The third chip's menu: the senses inside this token's own 品詞 and domain.
 *
 * Empty for a token with no tag, and in that case there is no sense chip to
 * open it from. Nothing sits below the sense, so this is the one level whose
 * pick repairs nothing — `withSense` only substitutes the field.
 *
 * **The one menu that offers `*`**, as 「なし」 — the reader's "no sense",
 * argued above `editableTag` and labelled by `fieldLabel`. It is a menu of one
 * for a domain that records no senses at all (`p,助詞,句末,*`), and that menu
 * is never opened: such a token draws no sense chip. What it is for is the
 * domain that records both, of which the treebank has exactly one — 名詞・思考
 * — where until now the empty tag could not be reached from anywhere. */
export function senseMenuValues(token: Pick<Token, "xpos" | "morph">): string[] {
  const parts = parseXpos(token.xpos);
  if (!parts) return [];
  return offeredValues(
    sensesUnder(syntacticPrefix(token.xpos)!, parts.domain),
    parts.sense,
    token,
    (sense) => withSense(token.xpos, sense),
    "offer",
  );
}

/** Every relation the deprel menu offers, in menu order — exported so a test
 * can walk the whole inventory rather than a hand-picked list of examples,
 * which is what keeps a relation from being added here and rendering as its
 * raw SUD string. (Its part-of-speech twin, `UPOS_INVENTORY`, is gone:
 * `XPOS_INVENTORY` in xpos.ts is the 品詞 menu's inventory now, and it is
 * generated from the treebank rather than written out here.) */
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

/** The 係助詞 category, and the second category of one in the readings menu.
 *
 * Two characters, as the majority of the headings are, and the ordinary
 * grammatical name for what the item does: a は written here marks the subject
 * as the sentence's topic. 係助詞 would name the part of speech rather than
 * the job, and at four characters it is two cells dearer for nothing. */
const TOPIC_PARTICLE_HEADING = "主題";

/** The particle the item writes. A constant rather than a literal at the two
 * places that need it, because the value stored and the label drawn have to be
 * the same character — the menu's own rule that an item reads exactly as the
 * annotation will read. */
const TOPIC_PARTICLE = "は";

/** Whether this token's slot is one the reader may write a 係助詞 into.
 *
 * **The subject relation, and nothing else.** The request was for a は on a
 * subject, and the restriction is not merely caution: what makes the choice
 * safe to honour unconditionally in `caseParticleFor` is that は *replaces*
 * what the slot would otherwise take, which is true of a subject's が and of
 * nothing else in the menu's reach. An object's を and a topic は do co-occur
 * in classical Japanese — をば is exactly that — so an offer on `comp:obj`
 * would be asking a question this design does not answer, and it is left out
 * rather than guessed at.
 *
 * `subj@pass` and the other subtypes are admitted with the plain relation, the
 * way every other subject test in this app reads the label. */
export function topicParticleOffered(token: Token): boolean {
  return token.dep === "subj" || token.dep.startsWith("subj@");
}

/** Every category heading the app writes, across all three menus.
 *
 * Exported for the same reason the inventory above is: what a heading costs is
 * a function of its characters, and it has to be right for every one of them
 * rather than for the two anyone thought to check. They run from two
 * characters (修飾, 名詞, 動詞, 再読, 既定) to six (談話・その他), and a ・ is
 * an ordinary character here — a heading is plain text, not the segmented row
 * a `.token-menu-punct` gets its half-width cell from, so a 中黒 in a label
 * costs a whole cell like any other character. Every one of them is
 * full-width, which is what lets a heading's extent be counted rather than
 * measured; `tests/menuRowPadding.test.ts` checks that over the inventory
 * rather than leaving it as an assumption.
 *
 * ── Fifty-six of them are no longer this file's to word ──────────────────
 * A category menu is headed by the level above the one it edits, so a domain
 * menu is headed by its 品詞 (eleven possible headings — 名詞, 動詞, 記号,
 * 助詞, 副詞, 代名詞, 前置詞, 数詞, 助動詞, 接尾辞, 感嘆詞, in corpus order)
 * and a sense menu by its domain (45 more). All are listed here because any
 * can be the heading on some token, and what this list is for is the
 * arithmetic that has to hold for every heading the app can write. They are
 * not a rewording of the four (体言, 用言, 虚字, 雑字) that headed the UPOS
 * menu but a change of authority: a heading was a name someone chose for a
 * group someone filed, and it is now a field of the tag itself. Nothing here
 * can reword one, and the two-to-six-character range above still holds — the
 * longest of the 56 is three characters.
 *
 * The headings that are *not* here cannot be: a token wearing a 品詞 or a
 * domain the treebank does not have heads its own menu with that. Those come
 * from an uploaded tree or from the tagger's own composition, so they are
 * outside anything this app chose — and outside what these figures are for,
 * which is checking the app's own labels rather than a file's.
 *
 * What this costs the wrap is worth stating, since `sizeMenuSquarish` reasons
 * from these: each category menu is one group under one heading, of eleven
 * short entries (品詞), at most fourteen (名詞's domains) or at most fourteen
 * (動詞・行為's senses). The flat menu they replace was 116 rows under eleven
 * headings in one box, which made it the largest of the three menus by a
 * factor of five; none of these is.
 *
 * ── Length is a cost again, and two rewordings were reverted ───────────
 * This concerns the *relation* menu's four headings, which are still written
 * by hand here. They were reworded a round ago to make a 割注 come out with
 * two lines of equal length. A heading is one tracked line now
 * (`.token-menu-heading`), a label of `n` characters takes `n` cells, and
 * that reason is void — while length, which a 割注 halved and so nearly gave
 * away, is a cost again. So both were put back on trial and both were
 * reverted:
 *
 *   述語とその項 → 述語・項   **reverted, and since superseded.** It was
 *       reworded because 禁則 forced the 割注 to break 述語・ / 項, leaving 項
 *       alone under three characters — the worst pair in the menu. There is no
 *       pair now. What was left was a six-character label where a
 *       four-character one said the same thing, and at seven cells against
 *       five it would have been the longest heading in the menu. That group is
 *       headed 基本成分 now, which is 『体系漢文』's own word for what it holds
 *       (see `DEPREL_GROUPS`) and is four characters like the label it
 *       replaces, so this paragraph's arithmetic is untouched by the change
 *       that made it history. The general point stands for whoever writes the
 *       next one: a grammar coordinates with a 中黒, it does not write a
 *       sentence, and every character is a cell.
 *   分類不明 → 未分類        **reverted.** It was reworded because 未分 / 類
 *       split 分類 down the middle, which was a fault of the break and not
 *       of the name. Nothing breaks now. Both are ordinary Japanese for the
 *       relations the parser could not place (dep, udep, unk); 未分類 is the
 *       shorter and the more usual, and shorter is a cell.
 *
 * The other two entries of that list were 機能語 → 虚字 and その他 → 雑字,
 * both of which stood — and both of which headed the UPOS menu and are gone
 * with it. The arguments are kept at `DEPREL_GROUPS` above, where a future
 * hand-filed grouping would want them.
 *
 * Two comments in HelpModal.ts named 述語・項 in prose; they say 基本成分 now,
 * which is a comment kept true rather than a decision taken there. The figure
 * itself reads `deprelRowsShown()`, which follows the filing on its own —
 * see that function for why it no longer simply takes `deprelMenuGroups()[0]`
 * now that ROOT has a singleton group of its own at that index. */

/** The 品詞 menu's own heading, and the one heading in the app that names a
 * *column of the annotation* rather than a category within one.
 *
 * The other two menus head their groups with a kind — 修飾, 動詞 — because
 * their entries divide into kinds. The 品詞 menu's eleven entries are the
 * kinds, and there is nothing above them to file them under, so the heading
 * says what the column is instead. 品詞 is the word the treebank's own second
 * field is, which is what the entries are.
 *
 * A menu of eleven could have gone without a heading at all. It keeps one
 * because every group in every menu here is drawn through `appendMenuGroup`,
 * which puts a heading at the top of a fresh column — a menu with none would
 * be the only one whose first entry sat where every other menu's heading sits,
 * and the menus a reader opens from three chips a few pixels apart would not
 * line up with one another.
 *
 * Exported for the help modal's figure, which builds the same one group from
 * the same call the menu does. */
export const POS_MENU_HEADING = "品詞";
export const MENU_HEADINGS: readonly string[] = [
  ...DEPREL_GROUPS.map(([heading]) => heading),
  POS_MENU_HEADING,
  // A category menu is headed by the level above the one it edits, so the
  // headings the app can write are every 品詞 (eleven, heading the domain
  // menus) and every domain (heading the sense menus) — read off the corpus
  // rather than listed. `*` is not among them: a `*` domain draws no chip, so
  // no sense menu opens under one.
  //
  // A token wearing a 品詞 or a domain the treebank does not have heads its own
  // menu with that instead, which cannot be enumerated and does not need to
  // be: what this list is for is the cell arithmetic
  // (`tests/menuRowPadding.test.ts`), and a heading from an uploaded tree is
  // outside anything this app chose.
  ...xposPrefixes().map((prefix) => prefix.split(",")[1]),
  ...new Set(
    xposPrefixes().flatMap((prefix) => domainsUnder(prefix).filter((domain) => domain !== "*")),
  ),
  ...READING_KIND_GROUPS.map(([heading]) => heading),
  READING_DEFAULT_HEADING,
  TOPIC_PARTICLE_HEADING,
];

function assertMenuLabelsComplete(): void {
  // ── The 品詞 menu ──────────────────────────────────────────────────────
  // The old checks here were a two-way sync between `UPOS_JA` and
  // `UPOS_GROUPS` plus a third against `OFFERED_UPOS`, and all three are gone
  // with the tables they compared. What replaces them is not a translation of
  // them: the inventory is generated now, so the question is no longer
  // "did someone file this by hand correctly" but "does the generated table
  // still support what this file does with it".
  //
  // Every offered row has to be sayable. Each of the three category menus
  // draws one field of the tag verbatim, so a tag `parseXpos` cannot take
  // apart would put a raw `v,動詞,行為,動作` — or nothing at all — in a menu
  // of Japanese.
  const unlabelled = XPOS_INVENTORY.filter((xpos) => xposPartOfSpeech(xpos) === undefined);
  if (unlabelled.length) {
    console.warn("tokenInspector: xpos in the menu has no 品詞", unlabelled);
  }

  // And the shape the chips assume of the two semantic fields: that they are
  // filled from the top down, so a tag never records a sense without a domain
  // to hold it. Three chips are drawn in order and a gap in the middle would
  // put a sense chip directly under a 品詞 chip, reading as a domain. Nothing
  // in the treebank does this today; it is checked because the chips would
  // show it wrong rather than not show it.
  const senseWithoutDomain = XPOS_INVENTORY.filter((xpos) => {
    const parts = parseXpos(xpos);
    return parts?.domain === "*" && parts.sense !== "*";
  });
  if (senseWithoutDomain.length) {
    console.warn("tokenInspector: xpos records a sense with no domain", senseWithoutDomain);
  }

  // And every offered row has to *write* something. Picking a row sets
  // `token.pos` from `uposForXpos`, which answers undefined for a tag its
  // table does not hold — and that case is deliberately a no-op on `pos`
  // (see `openRetagMenu`), so a row the derivation had lost would silently
  // leave the token's category disagreeing with its new tag. Asked without
  // features, which is the entry every feature bundle falls back to.
  const underivable = XPOS_INVENTORY.filter((xpos) => uposForXpos(xpos) === undefined);
  if (underivable.length) {
    console.warn("tokenInspector: xpos in the menu derives no UPOS", underivable);
  }

  // Everything that derivation can write has to have a Japanese name, because
  // the chip falls back to `uposJa` for a token with no xpos and because the
  // app should never hold a tag it cannot say. This is the one place `UPOS_JA`
  // is still checked against anything, and it is checked against the thing an
  // edit can actually produce rather than against a menu.
  const unnamedUpos = [
    ...new Set(XPOS_INVENTORY.map((xpos) => uposForXpos(xpos)).filter((upos) => upos !== undefined)),
  ].filter((upos) => !(upos in UPOS_JA));
  if (unnamedUpos.length) {
    console.warn("tokenInspector: derived UPOS has no Japanese name", unnamedUpos);
  }

  // The two hidings are subtractions and so fail *silently* when they are
  // wrong: a misspelt member of either set removes nothing and the menu goes
  // on offering the thing it was meant to hide. Nothing else would notice, so
  // this does. `UNEDITABLE_UPOS` is checked against what the rows derive to
  // rather than against a tagset — a tag no row can produce hides nothing,
  // whether it is misspelt or merely obsolete.
  const derivable = new Set(XPOS_INVENTORY.map((xpos) => uposForXpos(xpos)));
  const hiddenUnknown = [
    ...[...UNEDITABLE_UPOS].filter((tag) => !derivable.has(tag)),
    ...[...UNEDITABLE_DEPRELS].filter((rel) => !DEPREL_INVENTORY.includes(rel)),
  ];
  if (hiddenUnknown.length) {
    console.warn("tokenInspector: hidden label is not in the inventory it hides from", hiddenUnknown);
  }

  // The two files have to agree about the mark between two semantic fields.
  // `xposSemanticLabel` joins them itself, so `SUBTYPE_SEP` here is a second
  // copy of that decision rather than its source; if xpos.ts ever changed its
  // mind the chip would read 行為/動作 inside this file's own brackets.
  const composed = xposSemanticLabel("v,動詞,行為,動作");
  if (composed !== `行為${SUBTYPE_SEP}動作`) {
    console.warn("tokenInspector: xpos.ts and this file disagree about the subtype separator", composed);
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
 * does in `offeredValues`: a relation the menu does not offer is still shown
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

/** **How big a category chip is, as a fraction of the character it annotates**
 * — a fifth of the cell, which is 17.6px at the shipped 88px column pitch.
 *
 * ── This replaces `MAX_CHIP_LABEL_LENGTH`, and the guarantee it kept ─────
 * The size used to be the cell width over the longest label any chip could
 * draw, so that *even the worst case fitted horizontally within the clicked
 * token's own cell*. That constraint is why the size kept falling as the chip
 * learned to say more: 88/12 = 7.33px for the whole tag composed into one
 * pill, 88/8 = 11px stacked as two lines, 88/6 = 14.67px once the tag was
 * split into three chips sharing one bound.
 *
 * **The reader lifted the guarantee rather than tightening it.** The chips are
 * laid out side by side now and are explicitly permitted to overflow the
 * column. So there is nothing left for a computed bound to guarantee, and
 * dividing a cell width by a character count would be arithmetic performing a
 * constraint that no longer exists. `MAX_CHIP_LABEL_LENGTH` is deleted, and
 * this is where it went: the record of a real constraint that was **lifted,
 * not solved**, and that would have to come back with it if the chips were
 * ever asked to stay inside their column again. What it would be, if so: the
 * longest label any of the three can draw, which is 6 (その他の人名, one sense
 * in 83 where 70 are two characters), plus the invisible 5 (等位接続詞 out of
 * `UPOS_JA`, which the first chip falls back to on a token with no tag).
 *
 * ── Why a fifth, and why a fraction rather than a size ───────────────────
 * A fraction of the cell rather than a `px`, so the chips track the reader's
 * own type scale: `--size-main` is what the whole app is set from, and a chip
 * that stayed 17.6px while the text grew would shrink against it.
 *
 * A fifth because it reproduces the size the old bound gave when the chip said
 * 等位接続詞 and nothing more — 17.6px, the largest this apparatus has ever
 * been drawn at, and the one figure in the sequence above that was on a page
 * for a while without being complained about. The divisor is now a *choice*
 * and not a count, which is the whole difference: nothing recomputes it, and a
 * longer label makes the row wider rather than the type smaller.
 *
 * All three chips take it, and so does the deprel label. That the three share
 * one size is the reader's own instruction and has an argument of its own: a
 * chip whose type size varied by which field it held would read as a hierarchy
 * of importance the tagset does not have. The deprel label was never bounded
 * by any of this — `.token-arrow-label` is `writing-mode: vertical-rl`, so its
 * 12-character worst case runs *down* the column and its width is one
 * character whatever it says — and takes the size for the plainer reason that
 * one apparatus should be set in one size. */
const CHIP_SIZE_OF_CELL = 1 / 5;

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
  // same transition that took them up — see `decollideOverlay` below, and
  // `--reading-lift` in kunten.css, which is where the walk and its reversal
  // are argued.
  unliftReadings(column);
}

/** Puts every lifted reading in `column` back down.
 *
 * Two callers, and the second is why this is a function: taking the analysis
 * down (`clearInspector`) and re-running the decollision on a column whose
 * analysis is staying up (`redecollide`, when the semantics come out or go
 * back). The lifts are measured, not derived — each cell carries the number it
 * was asked for — so a second pass has to start from none of them, exactly as
 * a first pass does. */
function unliftReadings(column: HTMLElement): void {
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
export const READING_RUNS = ".furigana, .okurigana";

/** **The inspected token's own readings** — the highlighted ruby, and the only
 * ruby the deprel label is asked to get out of the way of.
 *
 * The reader's instruction named "the highlighted ruby", and the difference
 * from *every* reading in the column is not a nicety: the label is set
 * vertically and a long relation name runs two to three cells down the page,
 * so its band takes in the neighbours' readings as well as this token's. Asked
 * about all of them it found somebody's 振り仮名 to dodge on nearly every
 * character in a kanbun text, and stepped off its arc's midpoint whether or
 * not the token being inspected had any ruby at all — which is exactly what
 * the reader saw.
 *
 * Derived from `READING_RUNS` rather than written out, so a third kind of
 * reading added there is picked up here too. `.token-cell-inspected` is the
 * class `showInspector` puts on every cell of the token it is drawing for. */
export const INSPECTED_READINGS = READING_RUNS.split(",")
  .map((run) => `.token-cell-inspected ${run.trim()}`)
  .join(", ");

/** The row of category pills — the 品詞, its domain and the sense inside it,
 * one pill per field the tag records (`posChipParts`). One selector rather
 * than three, because everything in this file that asks about them asks about
 * all of them: they are cased together, they are dodged together, and they
 * move together, the row being what carries the position.
 *
 * Still one selector after the reveal split the row in two, and deliberately.
 * The two pills that are hidden until a pointer asks for them are pills in
 * every way that matters here — they are cased (`caseApparatus` draws their
 * rects in the same pass, to be revealed with them), they carry their own
 * menus, and they are the same shape. What tells them apart from the 品詞 is
 * not what they *are* but whether they are on the page, and that is a
 * measurement rather than a class: `settledStrength` answers it, and answers
 * it the same way for a mark faded by a stand-down or by a switch. */
const CATEGORY_PILLS = ".token-subtitle";

/** The box holding the two pills that are not the 品詞 — the semantic domain
 * and the sense inside it.
 *
 * It exists for one reason, and the reason is a guarantee rather than a
 * grouping: it is absolutely positioned, so those two pills take no part in
 * the row's own layout, so the row's width is the 品詞 pill's width, so the
 * `translateX(-50%)` that centres the row centres *that pill* on its
 * character — revealed or not. The reader asked for the semantics on hover
 * and for the 品詞 not to move when they arrive, and the second half is what
 * this element answers. `.token-subtitle-semantics` in kunten.css carries the
 * arithmetic and the alternative that was rejected (moving the anchor instead,
 * which no CSS length can express and which would have put a measure-then-
 * place reflow into the one part of `showInspector` that runs before the
 * overlay is in the document). */
const SEMANTICS_WRAPPER = ".token-subtitle-semantics";

/** The class that reveals them, and it goes on the overlay rather than on the
 * row — because two things have to be revealed together and they are in
 * different subtrees: the pills, which are in the row, and the page-colour
 * rects that case them, which are in the casing SVG the overlay carries as its
 * first child. An overlay holds one row (`decollideOverlay` has always taken
 * it with `querySelector`), so a class on the overlay is a class on the row in
 * every case there is. */
const SEMANTICS_SHOWN = "token-semantics-shown";

/** How long the revealed state outlives the pointer, and why it has to
 * outlive it at all.
 *
 * The seam between two pills is a 2px band of page colour — the wedge the
 * chevron rules open deliberately (`--chip-chevron-gap` in kunten.css) — and
 * `clip-path` clips the hit map with the paint, so a pointer crossing from the
 * 品詞 pill to the domain pill passes through a band where *neither* pill is
 * the target and the character underneath is. A reveal keyed straight to
 * `:hover` would drop there, and dropping does not merely flicker: hidden
 * pills take no pointer events, so the pointer would arrive over a domain pill
 * that could no longer be hovered, and the reader could not reach the pills at
 * all without approaching them from the 品詞 again — and would fail the same
 * way each time. Holding the state briefly covers the crossing, which at any
 * pointer speed is a frame or two.
 *
 * 200ms: long enough to cover a slow drag across a 2px band (a pointer would
 * have to be moving under 10px/s to spend longer than that inside it), short
 * enough that a reader who has moved away sees the pills go with the gesture
 * rather than a beat later. Not measured on a page — there is no browser in
 * this checkout — and it is one number in one place if it is wrong. */
const SEMANTICS_GRACE_MS = 200;

/** The relation's name, drawn on the arc's own midpoint. */
const DEPREL_LABEL = ".token-arrow-label";

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
 *     see `decollideOverlay` below, and `.reading-steps-up` in kunten.css,
 *     which holds the answer under the lane's own ceiling.
 *   - **the deprel label** (`.token-arrow-label`): 49 collisions, needing 1.9
 *     to 159.2px of lift. That is up to nearly two whole characters, and a
 *     reading moved that far is not its own character's any more — which is
 *     exactly the defect the lift this overlay used to do was deleted for
 *     (see the note at the foot of `showInspector`). It is also the one mark
 *     a casing cannot help with: the label carries an opaque background of
 *     its own, so what it covers it covers completely, whatever the reading
 *     under it is wearing. The label does step aside for the *pills* now, and
 *     that is not this rule loosening: a mark stepping out of another mark's
 *     way costs a few pixels of gutter, where a reading stepping out of a
 *     mark's way costs the reader the character it belongs to. What yields to
 *     what, and in which order, is set out at `decollideOverlay`.
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
const READING_OBSTACLES = CATEGORY_PILLS;
// **Read the name carefully: these are the marks a reading *dodges*, not the
// readings.** The two are one string today and the pair of names is deliberate
// (see above) — but the asymmetry is a trap, and it has been walked into once:
// `decollideOverlay` took `READING_OBSTACLES` for "the readings" and so had the
// deprel label step aside for the pills under a name that said it was stepping
// aside for the ruby. The readings themselves are `READING_RUNS`, and they live
// in the column rather than in this overlay.

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
 * Exactly true where the row is where it was placed, and out by the standoff
 * where the row has stood off its character to clear the deprel label (step 2
 * of `decollideOverlay`). That is right rather than a defect: what the reading
 * owes is clearance from the mark, and the mark is where it ended up. The
 * mirroring is a nicety of the common case and the clearance is the rule.
 *
 * Read off the mark and not copied here, so it cannot come to disagree with
 * the stylesheet. A mark in `READING_OBSTACLES` that declared no margin
 * would get no buffer and a reading would be lifted to just touching it.
 *
 * **Off the row where there is one**, which is where splitting the chip in
 * three put it. The gap from the character is a property of the row rather
 * than of any pill — the pills sit 2px apart inside it and the row sits
 * 0.25rem off the glyph — so `.token-subtitle-row` is what declares it, and
 * all three pills answer with the same figure. That is right for all of them:
 * what a reading owes a mark is measured from the mark's own edge and then
 * given this as clearance, so the buffer is the same clearance in each case
 * and only the edge differs.
 *
 * Falls back to the mark itself for a member of `READING_OBSTACLES` that is
 * not in a row. There is none today; a future one that declared no margin
 * anywhere would want its own answer here rather than a constant borrowed
 * from the chips. */
function markBuffer(mark: HTMLElement): number {
  const owner = mark.closest<HTMLElement>(".token-subtitle-row") ?? mark;
  const margin = Math.abs(parseFloat(getComputedStyle(owner).marginTop));
  return Number.isFinite(margin) ? margin : 0;
}

/** Every chip the analysis writes: the category pills (drawn on the
 * character, one per field of the tag the token records) and the deprel label
 * (drawn on the arc). All are HTML, all are opaque, and all are cased in the
 * same pass as the arc. */
const CHIPS = `${CATEGORY_PILLS}, ${DEPREL_LABEL}`;

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
 * foot of `decollideOverlay`: an insertion invalidates layout, and
 * measuring between insertions would reflow once per chip.
 *
 * ── Drawn after the marks have settled, and not before ────────────────
 * This used to run first and hand its reach to the reading lift. It runs
 * *last* now, because two of the marks it cases can move: the deprel label
 * steps out of the pills' way and the pill row stands off the label
 * (`decollideOverlay`), and a casing drawn before either would be a halo left
 * behind where the mark used to be. The reach the decollision needs before it
 * runs is read separately, off the stylesheet, by `casingReach`.
 *
 * A rect per chip is still right after the move: the pills' border boxes now
 * *overlap*, by the chevron's depth, where they used to stand 2px apart
 * (`.token-subtitle-semantics > .token-subtitle` in kunten.css), and the
 * union of overlapping rects is the same unbroken bar the union of
 * nearly-touching ones was. No rect edge falls inside the row's silhouette
 * either way, which is the whole of what a joint casing has to guarantee.
 *
 * ── On the mark as painted, not on the box the paint sits in ──────────
 * A rect used to be drawn on the chip's border box outright, and for three of
 * the four chips it still is, because for three of them the two are the same
 * thing. The exception is the 品詞 pill of a token that has semantics to
 * reveal: at rest that pill's ink is cut `--chip-chevron / 2` short of its own
 * box (the straight clip at `.token-subtitle-row > .token-subtitle:not(
 * :last-child)` in kunten.css), and a halo drawn to the box put 3.76px of page
 * colour past the pill's visible right-hand edge against 0 past its left. With
 * the casing's own 2px on top of it, the folded pill kept 5.76px of paper on
 * its right and 2px on its left — which is the asymmetry a reader reported as
 * the pill's right padding not matching its left, and it is not the padding at
 * all. The pill's *ink* is symmetric to a fortieth of a pixel; see
 * `--chip-clip-end` in kunten.css for that derivation and for what the box
 * cannot be allowed to do about it.
 *
 * So the rect is trimmed by whatever the chip does not paint, which the chip
 * is asked for. It is still a rect per chip and the union is still unbroken:
 * the trim only ever applies at rest, when the semantic pills are not cased at
 * all and there is no seam for the trim to open.
 *
 * ── The two pills that come and go ────────────────────────────────────
 * The domain and the sense are drawn hidden and slide out on hover
 * (`.token-subtitle-semantics` in kunten.css), and they are cased **only while
 * they are out**. A casing is page colour: a rect painted for a pill nobody
 * can see is a cream bar lying across the text beside the character, which is
 * the artefact a reader would report first.
 *
 * Not cased at all while hidden, rather than cased and held back by the same
 * class that holds the pills back — which is what stood here for a round and
 * is wrong by 12px. A hidden pill is parked one `--semantics-slide` to the
 * left of where it belongs, so a rect drawn on its box at that moment is a
 * halo for a position the pill never occupies once it is visible. The rects
 * that matter are the ones drawn by the pass that runs after the slide has
 * settled (`redecollide`), and every reveal schedules one.
 *
 * The class on the rects is kept all the same, and does the other half: it
 * fades them out *with* their pills when the pointer leaves, in the 160ms
 * before the re-run replaces the layer, so the halo never outlives the ink it
 * was drawn for.
 *
 * ── And this now runs more than once ──────────────────────────────────
 * It used to run exactly once per analysis. The reveal made the marks move
 * again — the readings lift out of the revealed pills' way, and the label and
 * the row give what they can (`scheduleRedecollide`) — and a halo left at a
 * box its mark has moved out of is page colour sitting on the text with
 * nothing drawn on it. So `redecollide` takes this layer down and calls this
 * again: once when the slide has settled, and once when the pills have gone.
 * That is a few rects rebuilt twice per hover, against the alternative of a
 * casing that is only right in one of the two states.
 *
 * Which rect is which is asked of each chip — is it inside the semantics
 * wrapper — rather than by walking the wrapper separately: two lists that had
 * to stay in the same order would be a second thing to keep true, and
 * `chip.closest` says the thing itself. */
function caseApparatus(overlay: HTMLElement): void {
  // Everything that is drawn, and — of the two that are only sometimes drawn —
  // only where they are out. Asked of the overlay's own class rather than of
  // each pill's settled opacity, which is what `decollideOverlay` asks and
  // would be the tempting symmetry: the apparatus as a whole stands back to
  // `opacity: 0.4` while a character is selected or dragged, and a test that
  // read the whole chain would then case nothing at all, including the arrow's
  // label. The class says the one thing that is being asked here.
  const revealed = overlay.classList.contains(SEMANTICS_SHOWN);
  const chips = [...overlay.querySelectorAll<HTMLElement>(CHIPS)].filter(
    (chip) => revealed || chip.closest(SEMANTICS_WRAPPER) === null,
  );
  if (chips.length === 0) return;
  const origin = overlay.getBoundingClientRect();
  const shapes = chips.map((chip) => {
    const style = getComputedStyle(chip);
    const box = chip.getBoundingClientRect();
    // **How much of its own box this chip does not paint**, off the page, so
    // the rect is drawn on the mark *as painted* rather than on the box the
    // paint sits in. See `--chip-clip-end` in kunten.css, where the number is
    // declared beside the clip that spends it and the asymmetry it fixes is
    // worked through; 0 for every chip but one, and 0 for that one the moment
    // its point comes out.
    //
    // `parseFloat` of a computed *registered* custom property, which is a
    // resolved pixel length — that is the whole reason the property is
    // registered, and the same trick `--head-box-offset` and the rest are
    // registered for. Unregistered, this would come back as the token stream
    // `calc(0.4270em / 2)` and `parseFloat` would yield NaN. It yields NaN
    // anyway in jsdom, which computes no custom properties at all, and `|| 0`
    // is what leaves the casing exactly as it was there — the same graceful
    // nothing `casingReach` falls back to.
    const unpainted = parseFloat(style.getPropertyValue("--chip-clip-end")) || 0;
    return {
      // Written out field by field rather than spread: a `DOMRect`'s
      // properties live on its prototype, so `{ ...rect }` is `{}` in a
      // browser and the rect would come out at the overlay's own origin with
      // no size at all. (jsdom is more forgiving, which is exactly why this
      // note is here rather than a test.)
      box: {
        top: box.top,
        right: box.right - unpainted,
        bottom: box.bottom,
        left: box.left,
        width: Math.max(0, box.width - unpainted),
        height: box.height,
      },
      // Whether this rect has to come and go with the reveal — see the note
      // above. Asked of the chip, because the chip is what knows.
      semantic: chip.closest(SEMANTICS_WRAPPER) !== null,
      // And whether it is the deprel label's, which is the one rect that has
      // to be able to *travel*: the label is pushed along its column when a
      // foldout arrives under it, and now walks there rather than jumping
      // (`redecollide`). A halo that stayed behind would be page colour lying
      // on the arc for the length of the walk, and a halo is not a thing that
      // can be somewhere its mark is not. Named here rather than found by
      // position, because the rects are drawn in the order `CHIPS` returns
      // them and that order is a fact about a selector.
      label: chip.matches(DEPREL_LABEL),
      // The *outer* radius, which is what `border-radius` names: the corner of
      // the border box, which is the corner both of these marks actually show.
      // Neither carries a `border` any more — the label's frame and the pills'
      // edge are both inset shadows now (`--mark-edge` in kunten.css), drawn
      // inside boxes this pass measures unchanged — so what is read here is
      // the radius of the box the rect is being drawn on, which is what it
      // always had to be.
      //
      // The largest of the four corners, not the first: a pill in the middle
      // of a chevron seam squares off the corners that meet its neighbours
      // (`.token-subtitle-semantics > .token-subtitle` in kunten.css), and a
      // rect drawn at *that* radius would square off the end of the bar as
      // well, where
      // the pill's outer corners are still round. The largest is the outer one
      // wherever a pill has an outer one, and 0 for the middle pill, which has
      // none — which is exactly the silhouette, corner by corner.
      radius: Math.max(
        ...(["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"] as const)
          .map((corner) => parseFloat(style[corner]) || 0),
      ),
    };
  });

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "token-casing-layer");
  svg.setAttribute("width", String(origin.width));
  svg.setAttribute("height", String(origin.height));
  for (const { box, radius, semantic, label } of shapes) {
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute(
      "class",
      semantic
        ? "token-chip-casing token-chip-casing-semantic"
        : label
          ? `token-chip-casing ${LABEL_CASING}`
          : "token-chip-casing",
    );
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
}

/** How far past a mark its casing paints — half the stroke `.token-chip-casing`
 * declares, which is 2px on the page and the same 2px the arc's own casing
 * gives its line.
 *
 * Read off the stylesheet through a probe rather than off the casing itself,
 * because of when it is wanted. Every measurement in `decollideOverlay` is of
 * a mark *as painted*, casing included, and the casing cannot be painted until
 * the decollision has finished moving the marks — so the number is needed one
 * step before the thing that used to yield it exists. The probe is one rect,
 * inserted and taken out again inside this call, carrying the same class the
 * real rects will carry: it is the same rule, so the two cannot come to
 * disagree, and there is still exactly one place in this file that knows how
 * far a casing reaches.
 *
 * 0 where the engine has no computed stroke to give — jsdom, a print context —
 * which leaves every measurement downstream exactly as it was before any of
 * this existed. */
function casingReach(overlay: HTMLElement): number {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "token-casing-layer");
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("class", "token-chip-casing");
  svg.append(rect);
  overlay.append(svg);
  const stroke = parseFloat(getComputedStyle(rect).strokeWidth);
  svg.remove();
  return Number.isFinite(stroke) ? stroke / 2 : 0;
}

/** ── Revealing the semantics, and the three things that can ask for it ─────
 *
 * The reader's instruction was "only show the POS chip by default, and reveal
 * the semantic categories on hover". Hover is the first of the three and the
 * only one they named; the other two are what hover cannot say.
 *
 *   - **the pointer is on the row** (`data-semantics-hovered`), held for
 *     `SEMANTICS_GRACE_MS` past the moment it leaves, for the seam-crossing
 *     reason argued at that constant;
 *   - **a menu opened from one of these pills is still up**
 *     (`data-semantics-menu`). Right-clicking the domain pill opens the domain
 *     menu, and opening it takes the pointer off the row and onto the menu —
 *     so without this the pills would vanish at the instant their own menu
 *     appeared, and the reader would be choosing a value for a chip that is no
 *     longer on the page. A menu that closes the thing it is attached to is
 *     unusable;
 *   - **the reader has pinned the row** (`data-semantics-pinned`), which is a
 *     click on any pill.
 *
 * ── Why a listener and not `.token-subtitle-row:hover` ────────────────────
 * The pure-CSS form was tried on paper first and it cannot hold the last two,
 * which is reason enough; but it also cannot hold the first. `pointer-events`
 * is not an animatable property, so the moment `:hover` stopped matching, the
 * pills would stop taking pointer events — instantly, whatever the opacity
 * transition was doing — and the seam crossing described at
 * `SEMANTICS_GRACE_MS` would lock the reader out rather than blink at them.
 * A timer is the only thing that can hold *both* halves of the revealed state
 * across the crossing, and once there is a timer there is a class, and once
 * there is a class the menu and the pin cost a line each.
 *
 * ── `mouseover`/`mouseout`, on the row, which is `pointer-events: none` ───
 * They fire all the same, and this is not a hope: the pointer-events spec says
 * that events targeting a descendant that has opted back in "trigger event
 * listeners on this parent element as appropriate ... during the event capture
 * /bubble phases", and this whole file already depends on it — `interrogate`'s
 * `contextmenu` listener is on the *container*, above the overlay, and every
 * pill's menu is opened from it. The two events chosen are the bubbling pair
 * for exactly that reason; `mouseenter`/`mouseleave` do not bubble and are
 * dispatched along the ancestor chain by a different mechanism, which the same
 * sentence does not obviously cover.
 *
 * Nothing is torn down. The listeners are on the row, the row is inside the
 * overlay, and `clearInspector` removes the overlay whole — so they go with
 * it, and a timer still pending when it goes fires on a detached row, where
 * `syncSemantics` finds the detached overlay and toggles a class nobody can
 * see. Not looked at on a page: there is no browser in this checkout, and
 * everything above is an argument about which events exist rather than about
 * how anything looks. */
function watchSemantics(row: HTMLElement): void {
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  row.addEventListener("mouseover", () => {
    clearTimeout(hideTimer);
    row.dataset.semanticsHovered = "true";
    syncSemantics(row);
  });

  // Deferred, never immediate — see `SEMANTICS_GRACE_MS`. A `mouseout` from
  // one pill straight onto the next fires this and then the `mouseover` above
  // in the same burst, so the timer is cleared before it can do anything, and
  // moving along the row never takes the row down.
  row.addEventListener("mouseout", () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      delete row.dataset.semanticsHovered;
      syncSemantics(row);
    }, SEMANTICS_GRACE_MS);
  });

  // ── The pin, which is what a device with no hover gets ──────────────────
  // A tap has no hover to offer and no second gesture to spare: on a touch
  // screen the analysis is raised by a long press, and a long press on where
  // the domain pill *would* be lands on the character underneath (the hidden
  // pills take no pointer events) and raises that character's analysis
  // instead. Without something here, the domain and sense menus would be
  // unreachable on touch altogether, which is a feature lost rather than a
  // feature degraded.
  //
  // A click on the 品詞 pill is the gesture, because a click on a pill is the
  // one gesture in this apparatus that already means nothing: the menus moved
  // to the right click, and `isMenuTarget` makes a left click on a pill inert
  // so that it cannot deselect the token the analysis is about. So this takes
  // a gesture that was doing nothing and gives it the one thing a hoverless
  // reader needs. On a pointer device it is a pin — click to keep the
  // semantics up while looking elsewhere, click again to put them away.
  //
  // **The 品詞 pill only**, and not any pill. It is the one that is there in
  // both states, so it is the only one a reader with no hover can aim at; and
  // giving the other two the same click would mean that clicking a domain pill
  // to look closer at it made it disappear, which is the menu problem again in
  // miniature. A click on a semantic pill goes on meaning nothing, as it did.
  //
  // Written as "toggle whatever the row is showing" rather than as a pinned
  // flag alone, because on touch the synthesized hover from a tap *sticks*
  // until the reader taps elsewhere: a pin that only ever cleared the pin
  // would leave the pills up on the second tap and read as a broken switch.
  // Clearing both is the same gesture doing the same thing on both kinds of
  // device.
  row.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    // **A left click on a revealed pill opens that pill's menu**, and while
    // one of the three is open it switches between them. Two rules that were
    // one, written as one condition, because they are the same rule seen
    // twice: the reveal is the gesture that says the reader is working on this
    // tag, and once it has been made the menu should be one click away rather
    // than two.
    //
    // The reader's instruction: *"Single-clicking on the folded-out pill
    // should be enough to open the menu."* What stood here answered only the
    // second half — a left click did something only while a category menu was
    // *already* out, and opening the first one still needed the right click or
    // the double click that `interrogate` listens for. So a reader who had the
    // semantics up in front of them, which is the state this whole apparatus
    // exists to put them in, still had to change gesture to act on what they
    // were looking at.
    //
    // **`semanticsShown` and not `:hover`**, which is what makes this cover
    // all three ways the row can be up (`watchSemantics`'s own header has
    // them): the pointer on the row, the pin a touch reader taps, and the hold
    // a menu takes while it is open. The last of those is what subsumes the
    // tab switch — a category menu being open *is* one of the flags — so there
    // is one condition below where there were two, and the switch is no longer
    // a special case but the ordinary rule arriving in the ordinary way.
    //
    // ── What it costs, since something had to give ────────────────────────
    // The fold-away. A click on the 品詞 pill used to toggle: unfold the row
    // if it was down, put it away if it was up. The unfold survives untouched
    // below — it is the touch reader's only route in, and the instruction
    // keeps it in as many words — but the *put it away* half is now
    // unreachable on a selected token, because a click on a revealed 品詞 pill
    // is the sentence above. The row still comes down every other way it did:
    // the pointer leaves (`SEMANTICS_GRACE_MS`), the menu closes, Escape, a
    // click elsewhere, another character asked about, and the pin dies with
    // the overlay in every one of those. What is gone is a second tap that put
    // the pills back while keeping the character selected, and that is the
    // trade the instruction asks for, recorded here rather than argued away.
    if (selected && semanticsShown(row)) {
      const pill = target.closest<HTMLElement>(TAB_PILLS);
      const kind: RetagKind | null = pill?.classList.contains("token-subtitle-sense")
        ? "sense"
        : pill?.classList.contains("token-subtitle-domain")
          ? "domain"
          : pill
            ? "pos"
            : null;
      if (kind && pill) {
        // ── **A second click on the tab that is out closes its menu** ─────
        // The reader: *"A second tap on the POS pill should just close the
        // menu."* It was a no-op, on the reasoning that a tab strip does not
        // close its own panel — which is true of a tab strip that is always
        // showing one panel, and false of this one, where the panel is a menu
        // and the reader has to be able to put a menu away.
        //
        // **All three pills, where the instruction named the 品詞.** A rule
        // that "the 品詞 pill toggles and the other two only switch" cannot be
        // stated to a reader, and could not be discovered by one either: the
        // three are one strip, drawn alike and clicked alike. What can be
        // stated is *the mark that opened this menu closes it*, which is one
        // sentence covering all four marks (the deprel label takes the same
        // rule at `watchDeprelLabel`) and which is what a reader who has just
        // clicked something expects clicking it again to do.
        //
        // **What it closes, and what it does not.** The menu, and nothing
        // else. `closeContextMenu` releases the hold the open menu had on this
        // row (`markMenuTab`), and the row's own flags then decide what
        // happens to the pills: a pointer still on the row keeps them out, a
        // pinned row keeps them out, and a row held up by nothing lets them go
        // on the usual grace. So this is *not* the fold-away that the
        // one-click open cost — a second tap puts the menu away and leaves the
        // analysis exactly as it was. Folding the pills back is still the
        // pointer leaving, Escape, or selecting elsewhere.
        if (kind === openMenuKind) closeContextMenu();
        else {
          const anchor = menuAnchorFor(kind, pill.getBoundingClientRect());
          openRetagMenu(kind, selected.entry, anchor.x, anchor.y);
          markMenuTab(pill);
        }
        return;
      }
    }

    if (!target.closest(".token-subtitle-pos")) return;
    // The unfold, which is what a click on the 品詞 pill means with the
    // semantics down, and the touch reader's only way to reach the other two
    // pills at all (the paragraphs above this listener argue that at length).
    //
    // The other arm is the fold-away, and it is now reached only where the
    // rule above declined to act: no selection to open a menu about. That is
    // not a state a reader can normally be in — the row is drawn by
    // `showInspector` for the selected token — so this is kept as the honest
    // inverse of the line above it rather than as a live gesture. Deleting it
    // would leave a bare `pin`, which reads as if the flag could only ever go
    // up.
    if (semanticsShown(row)) {
      delete row.dataset.semanticsPinned;
      delete row.dataset.semanticsHovered;
    } else {
      row.dataset.semanticsPinned = "true";
    }
    syncSemantics(row);
  });
}

/** **A left click on the deprel label opens the relation menu.**
 *
 * The reader: *"Left-clicking the deprel pill should be enough to open it."*
 * The three category pills learned this a moment ago (`watchSemantics`, where
 * the gesture is argued); this is the fourth mark with a menu of its own and
 * it was still asking for the right click or the double click.
 *
 * ── With no `semanticsShown` gate, which is the one difference ────────────
 * A pill is only worth one click once the row is revealed: the reveal is the
 * reader's own statement that they are working on the tag, and a click on a
 * folded row still has an older job to do there — unfolding it, which is the
 * touch reader's only route in. The label has neither half of that. It is
 * drawn whenever the analysis is (it is the arc's own name for the relation),
 * it is never folded away, and a left click on it has never meant anything
 * else — `isMenuTarget` has always made it inert so that clicking it could not
 * deselect the token it describes. So the rule here is simply: it opens.
 *
 * **Clicking the label whose menu is already out closes it**, which is the
 * rule the tab strip takes as well (see `watchSemantics`, where the reader's
 * instruction about the 品詞 pill is argued into one sentence for all four
 * marks): the mark that opened a menu is the mark that closes it. Nothing else
 * closes with it — this menu holds no row open in the first place, so there is
 * nothing for the release to take down. `openMenuKind` is `"dep"` for exactly
 * as long as that menu is up, which is what the test below is asking.
 *
 * On the label itself rather than on the container, because the label is
 * rebuilt with every inspection and `clearInspector` removes the overlay
 * whole, so the listener goes with the element it is about — the same
 * lifetime `watchSemantics` has on the row. */
function watchDeprelLabel(label: HTMLElement): void {
  label.addEventListener("click", () => {
    if (!selected) return;
    if (openMenuKind === "dep") {
      closeContextMenu();
      return;
    }
    const anchor = menuAnchorFor("dep", label.getBoundingClientRect());
    openRetagMenu("dep", selected.entry, anchor.x, anchor.y);
    // Marked after the open, for the reason `interrogate` gives at length:
    // opening closes whatever menu was there, and that would clear a mark set
    // beforehand. The label wears the same `data-menu-tab` the pills do
    // (`markMenuTab`), and holds no row open on the way through — there is no
    // `.token-subtitle-row` above it to hold.
    markMenuTab(label);
  });
}

/** Whether this row's semantics are up, from the three flags that can say so.
 * The flags live on the row itself rather than in a variable here so that
 * `closeContextMenu`, which is module-level and has no row in hand, can put
 * one of them down without any bookkeeping surviving the row it belonged to. */
function semanticsShown(row: HTMLElement): boolean {
  return (
    row.dataset.semanticsHovered === "true" ||
    row.dataset.semanticsPinned === "true" ||
    row.dataset.semanticsMenu === "true"
  );
}

/** Writes the answer onto the overlay, which is where both the pills and their
 * casing can see it (`SEMANTICS_SHOWN`) — and, where the answer has changed,
 * sets the rest of the apparatus moving out of the way of what is arriving.
 *
 * **Nothing happens where nothing changed**, which is the first half of the
 * thrash guard the reveal needs: a pointer wandering within the row raises
 * `mouseover` after `mouseover`, and each of them ends here. Comparing against
 * the class already on the overlay makes all but the first of them free. */
function syncSemantics(row: HTMLElement): void {
  const overlay = row.closest<HTMLElement>(".token-inspector-overlay");
  if (!overlay) return;
  const shown = semanticsShown(row);
  if (overlay.classList.contains(SEMANTICS_SHOWN) === shown) return;
  overlay.classList.toggle(SEMANTICS_SHOWN, shown);
  scheduleRedecollide(overlay);
}

/** ── The apparatus gets out of the way of what has just come out ───────────
 *
 * The reader's instruction: the semantic pills "should slide out, and push
 * other elements out of the way" — which reverses an earlier decision that the
 * decollision would not react to the reveal at all. It reacts now, by the same
 * rules that already govern it and by no new ones: `decollideOverlay` is
 * re-run, so the deprel label steps across its gutter for the readings, the
 * row stands off along the column for the label, and the readings lift up
 * their own lanes for whatever pills are on the page. Run again when the pills
 * go back, so everything comes home.
 *
 * Two things had to be true before this could be a re-run rather than a second
 * arrangement:
 *
 *   - **it is idempotent.** `decollideOverlay` restores every mark to where it
 *     was drawn before it measures anything (`drawnAt`, `unliftReadings`), so
 *     the second run is the first run in a different state rather than an
 *     adjustment layered on it. Without that, crossing the row ten times would
 *     walk the label ten steps into the next column.
 *   - **the casing is redrawn with it.** `caseApparatus` paints page colour on
 *     the boxes the marks ended at; a mark that moves afterwards leaves its
 *     halo behind, sitting on the text where the mark used to be. So the layer
 *     goes and is drawn again, which is also what puts the semantic pills'
 *     own rects up at the moment their pills stop moving.
 *
 * ── After the slide, not during it ────────────────────────────────────────
 * Everything `decollideOverlay` does is measured off `getBoundingClientRect`,
 * and a box mid-transition is wherever the transition has got to — up to a
 * whole `--semantics-slide` short of where it is going. Measured then, every
 * reading would be lifted for pills that are still travelling and would be
 * left short by the remainder.
 *
 * The alternative was to measure the settled geometry directly: read the
 * transform the transition is heading for (the way `settledStrength` reads the
 * opacity it is heading for, off the animation's last keyframe) and correct
 * each box by what is left of the journey. It is rejected as the more
 * elaborate of the two — it would put a second, predicted geometry into a
 * function whose whole discipline is measuring marks as painted — and this one
 * measures marks that have actually stopped. What it costs is a delay before
 * the readings move, which is the length of the slide and is the same
 * interval the reader is watching the slide in.
 *
 * The delay is read off the page rather than declared here: `--semantics-reveal`
 * is the wrapper's own transition duration and this asks the wrapper for it,
 * for the reason `casingReach` asks a probe for the casing's stroke. Which
 * also answers reduced motion for free — there the transition is `none`, the
 * duration computes to 0, and the re-run happens immediately, because there is
 * no slide to wait out. */
function scheduleRedecollide(overlay: HTMLElement): void {
  clearTimeout(settling.get(overlay));
  settling.set(
    overlay,
    setTimeout(() => redecollide(overlay), revealSettleMs(overlay)),
  );
}

/** One pending re-run per overlay, and the second half of the thrash guard: a
 * pointer sweeping in and out of the row replaces the pending run rather than
 * queueing another, so a crossing that is over before the slide has settled
 * costs one measurement at the end of it instead of one each way. */
const settling = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** How long to wait for the reveal to stop moving: the wrapper's own longest
 * transition, plus two frames.
 *
 * The two frames are slack, not a second opinion. A `setTimeout` for exactly
 * the duration can be served on the frame the transition finishes *or* the one
 * before it, and measuring a frame early on a 12px slide would be measuring a
 * box up to 12px short — where measuring two frames late is measuring a box
 * that has been still for 32ms. The asymmetry is the whole of the argument.
 *
 * 0 where there is no transition at all — reduced motion, or a wrapper that
 * has gone — so the re-run is immediate rather than delayed by slack it does
 * not need. */
function revealSettleMs(overlay: HTMLElement): number {
  // **Read off the pills, not the wrapper.** The slide used to be declared on
  // the wrapper and is now declared on each pill, because the reader asked for
  // the two subcategories to unfold one after the other and a stagger is two
  // boxes starting at different times. The wrapper carries no transition at
  // all any more, so asking it would answer 0 and the decollision would
  // measure the run before it had moved.
  //
  // The longest of them, which with the stagger is the *sense* — its delay is
  // a whole `--semantics-reveal`, so it finishes at twice the duration. Taken
  // as a max over whatever pills are there rather than by naming the sense,
  // since a tag whose sense is `*` draws no sense pill and the domain is then
  // the last thing moving.
  const pills = [...overlay.querySelectorAll<HTMLElement>(`${SEMANTICS_WRAPPER} ${CATEGORY_PILLS}`)];
  if (pills.length === 0) return 0;
  return Math.max(
    ...pills.map((pill) => {
      const style = getComputedStyle(pill);
      return settleMsFrom(style.transitionDuration, style.transitionDelay);
    }),
  );
}

/** The arithmetic of the above, with the page taken out of it: how long a
 * transition declared as these two computed values takes to finish, in
 * milliseconds, plus the two frames of slack argued at `revealSettleMs`.
 *
 * Separated so that it can be exercised without a browser — the units are the
 * part of this that can be quietly wrong, and there is no layout in the test
 * suite to catch it. Computed `transition-*` values come back as
 * comma-separated lists, one entry per transitioned property, and engines
 * normalise to seconds ("0.16s"); the millisecond form is read rather than
 * assumed, because "0.16" taken for milliseconds instead of seconds is a
 * re-run 160ms early, measuring a slide that has barely begun. */
export function settleMsFrom(duration: string, delay: string): number {
  const times = (value: string): number[] =>
    value.split(",").map((entry) => {
      const text = entry.trim();
      const time = parseFloat(text);
      if (!Number.isFinite(time)) return 0;
      return text.endsWith("ms") ? time : time * 1000;
    });
  const durations = times(duration);
  const delays = times(delay);
  // The last of the properties to finish, which is what "settled" means for a
  // rule that transitions two of them. A `transition-delay` list can be
  // shorter than the duration list — the browser repeats it — so a missing
  // entry falls back to the first rather than to zero.
  const longest = Math.max(0, ...durations.map((each, i) => each + (delays[i] ?? delays[0] ?? 0)));
  return longest > 0 ? longest + 32 : 0;
}

/** The class that arms the walk below, on the overlay because the two things
 * that walk are in different subtrees — the label, and the label's own casing
 * rect in the SVG the overlay carries as its first child. `.token-marks-eased`
 * in kunten.css has the transition and the reduced-motion answer. */
const MARKS_EASED = "token-marks-eased";

/** The class `caseApparatus` puts on the deprel label's casing rect, so that
 * the halo can be walked with the mark it is the halo of. */
const LABEL_CASING = "token-chip-casing-label";

/** The decollision and the casing, run again over an overlay that is already
 * on the page. Both, and in that order, for the reasons at
 * `scheduleRedecollide` — and then the one mark that moved is walked to where
 * it now belongs instead of appearing there.
 *
 * ── The reader asked for the push to be animated ──────────────────────────
 * *"The deprel push-up should be animated."* The push is `labelLift`: a
 * foldout arrives in the gutter the label is standing in, and the label steps
 * along its column to get off it (see `decollideOverlay`, step 1b, where the
 * arithmetic and the reason it is vertical are argued). It was a jump, and it
 * is a jump in reaction to a slide — the semantics take `--semantics-reveal`
 * to come out, and the mark they push arrived instantly.
 *
 * ── The hazard, which is the whole reason this is here and not in the CSS ─
 * `decollideOverlay` *measures* every mark it moves, and it measures the label
 * twice: once to work out its own step (`labelStandoff`, `labelLift`) and once
 * more, after it has moved it, to see how far the pill row must then stand off
 * it (`rowStandoff`). A CSS transition on the property that function writes —
 * `top` — would make the second of those a measurement of a box that has not
 * started travelling yet: `getBoundingClientRect` resolves style, the
 * transition is created at that resolution, and its value at t=0 is the value
 * the label is *leaving*. The row would then stand off a label that is no
 * longer there, on every run. And the run after that would restore the label
 * (`drawnAt`) into a live transition and measure it wherever it had got to,
 * which is the general form of the same fault.
 *
 * So nothing that this function measures is ever allowed to be in flight:
 *
 *   - **the easing is disarmed before anything is measured** — the class comes
 *     off and the offset is cleared, which cancels any walk still running and
 *     puts the label at its own declared position;
 *   - **it is armed again only after everything is measured and drawn**, and
 *     the walk is expressed as an *offset* (`translate`) rather than as the
 *     position itself, so the position `decollideOverlay` wrote is the
 *     position the label has, at every instant this function is not looking.
 *
 * That is also the answer to "which timer waits for it": none, and none is
 * needed. `scheduleRedecollide` and `settleMsFrom` are what wait for the
 * *pills* to stop sliding before their boxes are measured, and they go on
 * doing exactly that; a second settle for the label would be a second timer
 * for a mark whose flight this function cannot see. Had the transition been
 * left armed on `top`, `revealSettleMs` would have had to take the longest of
 * the wrapper's transition and the label's — which is the shape the existing
 * pattern would have taken, and is written down here as the road not taken.
 *
 * **A re-run mid-walk carries on rather than restarting.** Where the label is
 * measured from is its *painted* box, taken before the disarm, so an offset
 * the last walk had not finished spending is inside it and the new walk begins
 * from what the reader can see rather than from where the last one was aiming.
 *
 * **The halo walks with it.** `caseApparatus` draws the label's casing at the
 * position the label has just been given; left alone it would be 2px of page
 * colour sitting at the destination, cutting the arc where the label has not
 * arrived, for as long as the walk lasts. So the rect takes the same offset on
 * the same clock (`LABEL_CASING`).
 *
 * **What is not walked, and deliberately.** The pill row's own standoff
 * (`rowStandoff`) still arrives at once. The reader named the label, the row's
 * move is the rarer of the two, and a row that eased while the pills inside it
 * were sliding on their own clock would be two animations on one mark. It is
 * one class away if it is wanted.
 *
 * Nothing here was looked at: there is no browser in this checkout. The claims
 * about when a transition's value is read are the spec's (CSS Transitions:
 * a transition is started during style change events, and its value at its
 * start time is the before-change value), not observations. */
function redecollide(overlay: HTMLElement): void {
  // The analysis may have been taken down while this was pending — a click
  // elsewhere, a re-render, another character asked about — and a detached
  // overlay has nothing to decollide and no column to do it in.
  if (!overlay.isConnected) return;
  const column = overlay.closest<HTMLElement>(".tategaki-column");
  if (!column) return;
  const label = overlay.querySelector<HTMLElement>(DEPREL_LABEL);
  const painted = label?.getBoundingClientRect().top;
  // Disarmed, and the offset dropped with it: from here to the foot of this
  // function every box is where its own style says it is.
  overlay.classList.remove(MARKS_EASED);
  label?.style.removeProperty("translate");
  // The old halo goes before the marks move, and the new one is drawn after
  // they have. In between there is no casing layer, and no paint either: this
  // is all one task.
  overlay.querySelector(".token-casing-layer")?.remove();
  decollideOverlay(column, overlay, casingReach(overlay));
  caseApparatus(overlay);
  if (!label || painted === undefined) return;
  // How far back the label has to be put to look as though it has not moved
  // yet. Half a pixel is the floor `animateAnnotationShift` uses for the same
  // question in KundokuView: below it there is nothing to see, and a mark that
  // did not move must not stir while one that did is travelling.
  const shift = painted - label.getBoundingClientRect().top;
  if (Math.abs(shift) < 0.5) return;
  const halo = overlay.querySelector<SVGRectElement>(`.${LABEL_CASING}`);
  // `translate` and not `transform`, on the label, because the label already
  // has a `transform` of its own — `translate(-50%, -50%)`, which is what
  // centres it on the point the arc hands it — and the individual property
  // composes with it instead of replacing it. Restating that centring here to
  // append an offset to it would be one literal in two files. The rect has no
  // transform of its own and takes the ordinary property.
  label.style.translate = `0 ${shift}px`;
  if (halo) halo.style.transform = `translateY(${shift}px)`;
  // The before-change style, made real: a transition needs two styles to
  // interpolate between, and both of the writes above and below happen in this
  // one task. Forcing layout here is what puts a resolved style between them.
  void label.offsetWidth;
  overlay.classList.add(MARKS_EASED);
  label.style.removeProperty("translate");
  halo?.style.removeProperty("transform");
}

/** The row whose semantics are being held up by a menu of its own. One slot,
 * because there is one open menu (`openMenu`), and it is released from
 * `closeContextMenu` so that every way a menu can go — a pick, a click
 * outside, Escape, a re-render — releases it. */
let semanticsMenuRow: HTMLElement | null = null;

/** Holds the row that `target` belongs to open while its menu is up.
 *
 * Called from `markMenuTab` and from nowhere else, which is what makes the
 * hold a property of the mark that is out rather than of the gesture that put
 * it out — the argument, and the bug that forced it, are at `markMenuTab`.
 * That also settles the ordering trap this used to carry in its own doc:
 * `openRetagMenu` begins by closing whatever menu was there, and a hold taken
 * before it would be released by it. Marking happens after the open on every
 * route, so the hold does too.
 *
 * Nothing happens for a `target` with no row above it, which is exactly the
 * deprel label: its menu is not about the row and must not hold one. */
function holdSemanticsFor(target: HTMLElement): void {
  const row = target.closest<HTMLElement>(".token-subtitle-row");
  if (!row) return;
  semanticsMenuRow = row;
  row.dataset.semanticsMenu = "true";
  syncSemantics(row);
}

function releaseSemanticsHold(): void {
  const row = semanticsMenuRow;
  semanticsMenuRow = null;
  if (!row) return;
  delete row.dataset.semanticsMenu;
  syncSemantics(row);
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
 * than a coincidence. `decollideOverlay` lifts a run by `run.bottom -
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

/** **How far the deprel label steps out of the pills' way** — across its
 * gutter, and never along the column.
 *
 * The axis is the whole of the rule. The label's position *along* the column
 * is the arc's own midpoint, and that is a claim about which stretch of the
 * sentence the arc spans: moved up or down it names a different stretch, which
 * is a collision solved by telling a lie. Its distance *out* from the column
 * is a claim about nothing at all — a label further into the gutter is the
 * same label, further out — so that is the one direction it can be given.
 *
 * `outward` is the sign of that direction, taken from where the label already
 * is relative to the character (the arc's bow puts it on one side and the
 * function is told which rather than assuming it). `wall` is the coordinate
 * its leading edge may not pass, and the caller puts that at the neighbouring
 * column's glyphs: a label standing over the next column's characters is a
 * label standing beside the wrong column of text, which is the same lie in the
 * other axis.
 *
 * **0 means the label does not move**, and it covers both ways that can
 * happen: nothing was in its way, or nothing under the wall would clear it.
 * The two need not be told apart — there is no leader line to draw any more
 * (see the note at the foot of `showInspector`) — and a label moved half way
 * out is a label displaced for nothing, so a step that does not clear is not
 * taken. What that costs is written down at `decollideOverlay`: at the shipped
 * scale the gutter is worth about 9px and a three-pill row overhangs 74, so
 * this clears a one-pill row and leaves a three-pill one to the row itself.
 *
 * Fixed-point rather than one pass over the obstacles, because the pills are a
 * contiguous row: a label sitting entirely inside the middle pill asks only
 * for that pill's width, and having moved by it is against the next pill
 * along. Each pass steps by the deepest overlap it can still see, and the loop
 * ends when a pass finds none. */
export function labelStandoff(
  label: Extent,
  obstacles: readonly Extent[],
  outward: 1 | -1,
  wall: number,
): number {
  let step = 0;
  for (let pass = 0; pass < obstacles.length; pass++) {
    const moved = { ...label, left: label.left + outward * step, right: label.right + outward * step };
    let deeper = step;
    for (const box of obstacles) {
      if (moved.top >= box.bottom || box.top >= moved.bottom) continue; // not in its band
      if (moved.left >= box.right || box.left >= moved.right) continue; // already clear across
      deeper = Math.max(deeper, step + (outward < 0 ? moved.right - box.left : box.right - moved.left));
    }
    if (deeper === step) break;
    step = deeper;
  }
  if (step <= 0) return 0;
  // The wall it may not pass, as a distance rather than as a veto.
  //
  // **Clamped, not refused, and that is a correction.** This returned 0 when
  // the clearing step would cross the wall — the overlay's "refuse rather than
  // half-clear" answer — and the effect on the page was that it almost never
  // moved at all: a three-pill row against a long label needs about 56px
  // across and the gutter is about 7px, so the common case failed the test and
  // nothing budged. A partial step is not a failed clearing; it is 7px less
  // overlap, and the marks are legible in proportion to how far apart they
  // are. Refusing bought tidiness in the arithmetic and paid for it in the one
  // place that matters.
  //
  // Both boxes are the marks as painted (`obstacleFor`), so the casing is
  // already inside this comparison.
  const room = outward < 0 ? label.left - wall : wall - label.right;
  return Math.max(0, Math.min(step, room));
}

/** **How far the deprel label steps *along the column* to clear a foldout** —
 * the vertical counterpart of `labelStandoff`, and the one displacement that
 * function's own doc says the label may not make.
 *
 * That prohibition still holds for everything else, and the reason it is
 * lifted here is the shape of the obstacle. The rule was written against the
 * *readings*, which stand beside the label in the gutter: to get past a
 * reading the label must cross the gutter, and its position along the column
 * is the arc's own midpoint — a claim about which stretch of the sentence the
 * arc spans, which moving it up or down would falsify.
 *
 * A foldout is the other orientation. The pill row is a horizontal bar, so
 * clearing it sideways means travelling its whole **length** — about 91px for
 * two pills, which is why a walled version of that move read as no move at all
 * — while clearing it vertically costs its **height**, about 24px. The short
 * way out is across the bar, not along it.
 *
 * What that costs is the arc-midpoint claim, and it is worth paying here
 * because the foldout is *transient*: the label returns to the midpoint the
 * moment the pills go back (`decollideOverlay` restores every mark before it
 * measures). A permanent displacement would be a lie about the parse; one that
 * lasts as long as the reader holds a row open is the label getting out of the
 * way of something the reader is looking at.
 *
 * Away from the bar, on the side the label is already on, so the label leaves
 * by the nearer edge. `0` where the two do not meet. */
export function labelLift(label: Extent, obstacles: readonly Extent[]): number {
  let lift = 0;
  for (const box of obstacles) {
    if (label.left >= box.right || box.left >= label.right) continue; // not across it
    if (label.top >= box.bottom || box.top >= label.bottom) continue; // not on it
    // Whichever way out is shorter, measured from where the label is now.
    const up = label.bottom - box.top;
    const down = box.bottom - label.top;
    lift = up <= down ? Math.max(lift, up) : Math.min(lift, -down);
  }
  return lift;
}

/** **How far the pill row stands off its character to clear the deprel
 * label** — along the column, on the side it is already on, and never past
 * `ceiling`.
 *
 * The row's freedom is the mirror image of the label's. What says which
 * character the row annotates is its *centring* on the glyph, and what says
 * which way the head lies is which side of the character it took
 * (`placeSubtitle`) — so neither the centre nor the side can be given up. How
 * far it stands off the end of the token says nothing, and is the same
 * freedom, on the same axis, that the readings themselves are given below.
 *
 * `outward` is -1 for a row written above its character and 1 for one written
 * below: away from the glyph, which is the only direction that can clear
 * anything, the label being past the *other* end of the token whenever it is
 * in the way at all.
 *
 * `ceiling` is the caller's, and 0 rather than a partial move when the need
 * exceeds it — the same refusal `labelStandoff` makes at its wall, for the
 * same reason. A row moved as far as it may and still under the label has
 * spent the reader's "this pill belongs to that character" for nothing. */
export function rowStandoff(row: Extent, label: Extent, outward: 1 | -1, ceiling: number): number {
  if (row.left >= label.right || label.left >= row.right) return 0;
  if (row.top >= label.bottom || label.top >= row.bottom) return 0;
  const needed = outward < 0 ? row.bottom - label.top : label.bottom - row.top;
  // Clamped to the ceiling rather than abandoned above it — `labelStandoff`'s
  // own note argues the change, and it applies here for the same reason: a row
  // that cannot get wholly clear of the label still reads better for having
  // got as clear as the next character's air allows.
  return needed > 0 ? Math.max(0, Math.min(needed, ceiling)) : 0;
}

/** Records where a mark was drawn the first time it is asked, and puts it back
 * there every time after. The inline `left`/`top` `showInspector` writes is
 * the drawn position; `decollideOverlay` then edits it, so the drawn value has
 * to be kept somewhere that survives the edit and dies with the element. Its
 * own dataset is that place. */
function drawnAt(mark: HTMLElement | null, axis: "top" | "left"): void {
  if (!mark) return;
  const key = axis === "top" ? "drawnTop" : "drawnLeft";
  const drawn = mark.dataset[key];
  if (drawn === undefined) mark.dataset[key] = mark.style[axis];
  else mark.style[axis] = drawn;
}

/** **Every mark this overlay draws, moved out of every other one's way** — in
 * one pass, in one order, and the order is the part of this that a later
 * reader could not recover from the code.
 *
 * ── The boxes, and what each of them may do ───────────────────────────────
 * Three kinds of box are on the page at once, and each has exactly one degree
 * of freedom, because in each case the other axis carries meaning:
 *
 *   - **the pill row** (`.token-subtitle-row`) — centred on its glyph and
 *     written past one end of the token. The centring says which character it
 *     annotates and the side says which way the head lies, so both are fixed;
 *     how far it stands off the end says nothing, and that is what it can
 *     give.
 *
 *     **Its box is the 品詞 pill, and only ever the 品詞 pill.** The domain
 *     and the sense live in an absolutely positioned wrapper inside it
 *     (`SEMANTICS_WRAPPER`), so they are out of the row's flow and the row
 *     measures without them — which is what keeps the 品詞 centred on its
 *     character whether or not they are revealed, and is what this function
 *     therefore sees. The wrapper is also drawn at `opacity: 0` until a
 *     pointer asks for it, so the pills inside it fall below `FULL_STRENGTH`
 *     and are dropped from the obstacle list at step 3 as well: at the moment
 *     the analysis goes up, the semantics are not on the page and nothing here
 *     moves for them.
 *
 *     That is a return to the geometry every figure in this file's notes was
 *     measured against. The collisions counted on 酒蟲 — 49 of them, 10.66 to
 *     25.34px — were counted when the chip was a single pill, and the three-
 *     pill row that replaced it is what made the label and the row reach each
 *     other at all. With the semantics out of flow the resting state is one
 *     pill again, so the figures below describe what is on the page again,
 *     and the deep case the two movers could only half-clear is no longer the
 *     common one.
 *
 *     **And this whole pass runs again when they are revealed**, which is the
 *     reader's own correction of an earlier decision that it would not: the
 *     semantic pills "should slide out, and push other elements out of the
 *     way". They push by these rules and no others — the label across its
 *     gutter, the row along its column, the readings up their lanes — and
 *     everything comes home when the pills go back, because the re-run begins
 *     by putting every mark where it was drawn (`drawnAt`,
 *     `unliftReadings`). `scheduleRedecollide` has the timing, which waits for
 *     the slide to stop rather than measuring it mid-flight, and the guard
 *     against a pointer that crosses the row repeatedly. What is still true is
 *     that *this function* knows nothing about hover: it measures what is on
 *     the page, and pills that are not on the page are the ones
 *     `settledStrength` finds at zero.
 *   - **the deprel label** (`.token-arrow-label`) — on the arc's own midpoint.
 *     Its position along the column names the stretch of text the arc spans
 *     and is fixed; its distance out into the gutter says nothing, and that is
 *     what it can give.
 *   - **the readings** (`.furigana`, `.okurigana`) — each in its own
 *     character's lane. Which lane says whose reading it is and is fixed; how
 *     high it sits in the lane says nothing, and that is what it can give.
 *
 * ── The order they yield in ──────────────────────────────────────────────
 * Strictly one way down this list, no mark ever yielding to one below it:
 *
 *   1. **The label yields to the readings**, across its gutter only
 *      (`labelStandoff`), never past the neighbouring column's characters —
 *      and **to the readings only, never to the pills**.
 *   2. **The pill row yields to the label** where the label is left, along the
 *      column only (`rowStandoff`), never onto the neighbouring character.
 *   3. **The readings yield to the pills** where the pills are left, up their
 *      own lanes only, never for the label.
 *
 * **1 is narrower than it first was, and the narrowing is the point.** The
 * label began by dodging the pills as well, and that is the wrong trade: the
 * pill row has a move of its own and spends it at 2, so a label stepping
 * sideways for a pill pays for a separation the other party can supply — and
 * pays it sideways, which is *toward the neighbouring column* and the one
 * direction in this overlay that costs a reader anything. The readings are the
 * opposite case: their only give is up their own lane, which does nothing
 * about a label beside them in the gutter, so the label's step is the only
 * give the pair has. Each mark now yields exactly where it is the only one
 * that can.
 *
 * Two of those are new and the third is what this function has always done.
 * The pair that had no arrangement at all is 1 and 2: the label sits at the
 * arc's midpoint and the row is written past the far end of the token, so for
 * most of this overlay's life they could not reach each other — and then the
 * chip became three pills side by side (`posChipParts`), about 167px of row
 * for an ordinary tag, overhanging its column by some 84px each way where one
 * pill overhangs 32. A label out in the gutter is inside that span. The two
 * collide now for a long relation name on a short arc, and for any label on a
 * cross-line arc whose midpoint falls level with the token.
 *
 * **The reveal has since taken most of that back**, and the arrangement is
 * kept rather than unwound. The row measures one pill again (see the box list
 * above), so a label that has spent its gutter is clear of it outright: at the
 * shipped scale the label's painted trailing edge stands at −29 from the
 * glyph's centre and its wall at −66, while a 品詞 pill of three characters
 * reaches −34 — so 7px of gutter puts the label's edge at −36, past the pill,
 * with nothing left for the row to do. What is left for step 2 is the case
 * where the label has no gutter to spend because it had no reading to dodge,
 * which is a shallow overlap and is exactly what the row's own 10px of travel
 * was measured to clear. Both movers stay, because both cases are still real
 * and because the clamping each of them does is what the reader reported the
 * absence of; what changed is that the case neither could clear has stopped
 * being the ordinary one. The arithmetic is pinned in
 * tests/inspectorLayout.test.ts.
 *
 * **Why both of them move, and in that order.** Neither has enough room
 * alone. Measured off the stylesheet at the shipped 88px advance: the label's
 * outer edge stands 57px from the glyph's centre — 59 with its casing — and
 * the next column's characters begin at 66, so it has about 7px of gutter to
 * spend. That clears a one-pill row, whose end reaches 5px into the label, and
 * cannot begin to clear a three-pill one, which covers the label entirely and
 * would have to be stepped out of by 56. The row sits in the 44px
 * between its glyph and the next one down the column, taking 4px of margin at
 * each end and about 24px of pill and 2 of casing, so it has about 10px of
 * standoff before it would be spending the next character's air as well —
 * which clears a shallow overlap and not a deep one. Between them they take the ordinary
 * cases and refuse the extreme ones, and the extreme case is the one this
 * overlay has always answered by letting two marks overlap rather than by
 * putting one of them somewhere it does not belong.
 *
 * The label goes first because it is the cheaper move: it spends gutter, where
 * the row spends the air between two characters. Nothing iterates — the row is
 * measured against the label where the label ended up, and the readings
 * against the row where the row ended up — so one pass settles it and no mark
 * is ever measured against a box that is about to move.
 *
 * **And that is why this is one function.** The three could be three, and were
 * two; but the reading lift is computed from the row's box, and a row that
 * moved after the lift had been computed would leave every lifted reading
 * lifted for a box that is no longer there. Nothing in a separate function
 * could state that, whereas here it is just the order of the paragraphs.
 *
 * Everything below is measured as painted, casing included — see `obstacleFor`
 * — and the casing itself is drawn afterwards, by `caseApparatus`, at the
 * boxes the marks ended up at.
 *
 * ── 3: lifting a reading out of the pills' way ──────────────────────────
 * Lifts a reading up its own column, as far as that reading has to go and no
 * further, for as long as the analysis is up.
 *
 * The row is drawn from the glyph's own centre and is wider than the glyph,
 * so the end of it overhangs the reading lane — 2 to 10.8px of it, measured
 * across 酒蟲, and further now that the row is three pills — and lands on the
 * okurigana hanging there at the character's foot. The pills are opaque and
 * the run underneath is simply gone.
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
function decollideOverlay(column: HTMLElement, overlay: HTMLElement, casing: number): void {
  const row = overlay.querySelector<HTMLElement>(".token-subtitle-row");
  const label = overlay.querySelector<HTMLElement>(DEPREL_LABEL);
  // ── Back to where they were drawn, before anything is measured ──────────
  // This function moves the two marks by *adding* to where they are, and it
  // now runs more than once on the same overlay: the semantics slide out on
  // hover and go back when the pointer leaves, and the reader asked that the
  // rest of the apparatus get out of their way and then come back
  // (`redecollide`). Adding to an already-moved mark would walk it further out
  // on every crossing of the row.
  //
  // So each mark carries the position it was *drawn* at, written the first
  // time this runs and restored on every run after, and every measurement
  // below is taken from there. Which is the same discipline the readings are
  // already under — they are unlifted and re-measured rather than adjusted —
  // and it means a run of this function depends on nothing but the page.
  drawnAt(row, "top");
  drawnAt(label, "left");
  // **Both of the label's axes**, since the foldout push moves it along the
  // column (`labelLift`) where the readings move it across the gutter. Without
  // this the vertical displacement was never undone: the pills would retract
  // and the label would stay where they had put it, and the next run would
  // measure a label already clear and so compute no move at all — a mark that
  // drifts once and then reports itself settled.
  drawnAt(label, "top");
  unliftReadings(column);
  // The character being asked about, which is what both moves are bounded
  // against: the row is centred on its glyph and the label stands in the
  // gutter beside its column. Every cell of a multi-character token carries
  // the class, and they share a column, so any of them answers for the
  // horizontal bounds and the two ends answer for the vertical one.
  const glyphs = [...column.querySelectorAll<HTMLElement>(".token-cell-inspected .kanji-glyph")];
  // The column's own pitch, declared once on `:root` in typography.css and
  // read off the page here for the same reason the arc reads `--head-box-size`
  // rather than measuring the box: it is the same number across the page and
  // down it (`--size-main` + `--kanji-gap`), and a copy of it in this file
  // would be a constant in two places. 0 — no such property, a print context,
  // jsdom — leaves both marks exactly where they were placed, which is what
  // this overlay did before any of this existed.
  const advance = glyphs[0]
    ? parseFloat(getComputedStyle(glyphs[0]).getPropertyValue("--kanji-advance")) || 0
    : 0;

  if (label && row && glyphs[0] && advance > 0) {
    const glyphBox = glyphs[0].getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    const labelBox = obstacleFor(label.getBoundingClientRect(), 0, casing).box;
    // The glyph's own centre across the page. Taken off the row rather than
    // off the glyph because that is what the row *is* — it is placed at the
    // glyph's centre and pulled back half its own width (`translateX(-50%)`)
    // — so this cannot come to disagree with the thing being bounded.
    const anchorX = (rowBox.left + rowBox.right) / 2;
    // Which side of the character the arc's bow has put the label on. Read off
    // the label rather than assumed, so this stays right if the bow is ever
    // turned over, and so that a cross-line arc — whose label sits on the
    // plain chord midpoint, on whichever side the head lies — is bounded
    // toward the head rather than away from it.
    const outward = (labelBox.left + labelBox.right) / 2 < anchorX ? -1 : 1;

    // ── 1. The label steps out of the pills' way ────────────────────────
    // The wall is the near edge of the neighbouring column's characters: one
    // advance out from this glyph's centre, less half a glyph. Past it the
    // label would stand beside the wrong column of text.
    // **The label steps aside for the readings and for nothing else** — not for
    // the pills, which it was briefly made to do and which was the wrong trade.
    //
    // The two obstacles are not alike. The pill row has a move of its own: it
    // can stand further off along the column (step 2 below), and does. So a
    // label that also moved sideways for the pills would be paying for a
    // separation the other party can supply, and paying in the one direction
    // that costs something — sideways is *toward the neighbouring column*,
    // where a reader's eye is on different text entirely. The readings have no
    // such move: they lift along the column for the pills (step 3), and lifting
    // does nothing about a label that sits beside them in the gutter. Between
    // the label and the ruby, the label's sideways step is the only give there
    // is, so that is the one it spends.
    //
    // The marks are found the same way step 3 finds them and filtered the same
    // way, so the two cannot come to disagree about which readings are on the
    // page. Measured before step 3 lifts them, which is sound rather than
    // merely convenient: the label gives across the gutter and the readings
    // give along the column, so neither move can put back an overlap the other
    // has just taken out.
    // `INSPECTED_READINGS` off the column — **this token's** ruby and no one
    // else's, which is what "the highlighted ruby" means and is where the last
    // round of this went wrong; that constant's own doc has the reasoning.
    // Off the column rather than the overlay because the readings are the
    // text's own ruby, not marks this overlay draws, and **not** through
    // `READING_OBSTACLES`, which reads like the readings and is not — it names
    // *what a reading is asked to dodge*, and is the pills.
    //
    // **The boxes are the readings as painted, and the standoff is added
    // afterwards.** Widening them first — which is what stood here — conflates
    // two different questions: *is the label on a reading* and *how far clear
    // should it end up*. Inflating by the standoff made the first question
    // answer yes wherever a reading was merely near, and the reader's report
    // was the consequence: the label dodged sideways with no ruby under it at
    // all. Detect on the ink, clear by the margin.
    //
    // Empty runs are dropped for the same reason. A `.furigana` with nothing in
    // it is a real element at a real position with no width, and it is not
    // something a label can be drawn on top of; before this filter, a column of
    // unread characters offered a row of zero-width obstacles that the standoff
    // then turned into wide ones.
    const readings = [...column.querySelectorAll<HTMLElement>(INSPECTED_READINGS)].filter(
      (run) => (run.textContent ?? "").trim() !== "" && run.getBoundingClientRect().width > 0,
    );

    /** **Where a reading's kana actually are, which is not where its box is.**
     *
     * The reader's report: the label "should only stay clear of the ruby lane
     * if it would otherwise collide with the highlighted ruby" — and it was
     * standing clear of the *lane*. `getBoundingClientRect` returns the
     * element's laid-out box, and a reading's box is the lane it is set in: a
     * two-kana furigana beside a five-character token still measures the whole
     * run's extent, so a label anywhere along that lane read as a collision
     * with kana that are nowhere near it.
     *
     * A `Range` over the run's contents measures the text instead — its
     * `getClientRects` are the line boxes the glyphs actually occupy — so a
     * label beside an empty stretch of lane now passes it, and one that really
     * is on the kana still dodges.
     *
     * Falls back to the element's own box where a Range answers nothing: jsdom
     * has no layout, and a run that reports no rects would otherwise become
     * invisible to the dodge rather than merely smaller. */
    const inkOf = (run: HTMLElement): DOMRect[] => {
      const range = document.createRange();
      range.selectNodeContents(run);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      return rects.length > 0 ? rects : [run.getBoundingClientRect()];
    };
    // **As painted, with no casing added to either side.** `obstacleFor` grows a
    // box by the casing every mark keeps around itself, and that is right when
    // the question is "do these two touch". It is wrong here, because the
    // question is "how far apart do they end up": the label's own casing and
    // the reading's would each add their 2px to the answer, and the label would
    // stand `rubyGap + 4` clear of a ruby it was asked to stand `rubyGap` clear
    // of. The reader measured it and said so.
    //
    // The margin below is itself measured between painted boxes, so the two
    // sides of the arithmetic now agree about what an edge is.
    const readingBoxes = readings.flatMap(inkOf);

    // **The margin: what the ruby keeps from its own kanji.**
    //
    // The reader's rule, and it is a better one than the arc standoff that
    // stood here, because it is the rhythm already on the page. A reading sits
    // a certain distance off the character it reads; a label that clears the
    // reading by the same distance joins that rhythm instead of introducing a
    // second, unrelated one. It also scales with the type for free, being
    // measured rather than declared.
    //
    // Measured across the column — the axis the label moves on — between each
    // run and the glyph of its own cell, and **the nearest taken**.
    //
    // The nearest and not the widest, which is the correction the reader asked
    // for: "if ruby is only one line, the deprel label shouldn't clear space
    // for two lines". A reading in a second lane sits a whole lane further out,
    // so its distance from the glyph *includes* the first lane's width — take
    // the largest of those and the margin stops being the gap the ruby keeps
    // and becomes a gap plus a lane, which is exactly the doubling that was
    // seen. What "the ruby keeps from the kanji" means is the offset of the
    // innermost run, and that is the same number whether one lane is occupied
    // or three.
    //
    // Clamped at zero for a reading that overlaps its own glyph: it should not,
    // but a negative margin would pull the label *into* the ruby it is
    // clearing, and the guard costs nothing.
    const gaps = readings.map((run) => {
      const glyph = run.closest(".kanji-cell")?.querySelector<HTMLElement>(".kanji-glyph");
      if (!glyph) return 0;
      const runBox = run.getBoundingClientRect();
      const own = glyph.getBoundingClientRect();
      return runBox.left >= own.right ? runBox.left - own.right : own.left - runBox.right;
    });
    const rubyGap = gaps.length > 0 ? Math.max(0, Math.min(...gaps)) : 0;

    // Nothing under it, nothing to give: a label clear of every reading stays
    // exactly where the arc's midpoint put it. Detection is on the ink and the
    // margin is added after — see the note at `INSPECTED_READINGS` for what
    // happens when those two are collapsed into one number.
    const labelRect = label.getBoundingClientRect();
    const overlap = labelStandoff(labelRect, readingBoxes, outward, outward < 0 ? -Infinity : Infinity);
    const rubyStep = overlap > 0 ? overlap + rubyGap : 0;

    // ── 1b. …and again for a foldout, which is a different rule ─────────
    //
    // **The semantic pills push the label, and the 品詞 pill does not.** The
    // reader has asked for both: "don't move decollided deprel labels
    // horizontally unless it's to get out of the way of ruby", and then "when
    // the foldout happens, it should push the deprel label out of the way if
    // necessary". Those reconcile by scope rather than by contradicting each
    // other. At rest the row is one pill overhanging its column by about 32px,
    // it rarely reaches the label at all, and when it does the row's own move
    // along the column (step 2) is the cheaper answer. A foldout is a second
    // pill and a third arriving *sideways*, into the gutter the label is
    // standing in — the row cannot yield its way out of that, because the thing
    // that grew is the row.
    //
    // **Unwalled, like the ruby pass — the wall was tried and it read as no
    // move at all.** The first version of this stopped at the near edge of the
    // neighbouring column's characters, on the reasoning that a foldout is
    // transient and the row still has step 2 to give. The arithmetic says that
    // bound is far too tight to matter: the label's centre sits one
    // `gutterOffset` out (44px at the shipped scale) and is about 18px wide, so
    // its far edge is near `anchorX + 53` against a wall at `anchorX + 66` —
    // **13px of room**, against the ~91px a two-pill foldout needs to clear.
    // The label moved its 13px, stayed under the pills, and the reader reported
    // it as not pushing at all. Twice, now, a clamp on this label has read as a
    // missing rule; the lesson is taken.
    //
    // Sent as a second call rather than one list, even though both are now
    // unwalled, because the two obstacle classes are cleared by different
    // margins: the readings by the gap the ruby keeps from its kanji, the pills
    // by nothing beyond their own casing. One call cannot give two margins.
    //
    // Measured from where the ruby pass left the label, so the two are one
    // journey and not two claims on the same gutter.
    const revealed = overlay.classList.contains(SEMANTICS_SHOWN);
    const foldoutBoxes = revealed
      ? [...overlay.querySelectorAll<HTMLElement>(`${SEMANTICS_WRAPPER} ${CATEGORY_PILLS}`)].map(
          (pill) => obstacleFor(pill.getBoundingClientRect(), 0, casing).box,
        )
      : [];
    if (rubyStep > 0) {
      label.style.left = `${(parseFloat(label.style.left) || 0) + outward * rubyStep}px`;
    }
    // **The foldout pushes it along the column, not across the gutter.** See
    // `labelLift`: the row is a horizontal bar, so the short way off it is
    // vertical — its height rather than its length — and the sideways version
    // of this needed ~91px where the gutter had 13. Measured from where the
    // ruby pass left the label, so the two moves are one journey.
    // **Measured from where the label was *drawn*, not from where the ruby
    // pass left it** — and that is a correction, not a shortcut.
    //
    // The two moves are on orthogonal axes: the readings are cleared across the
    // gutter and the foldout along the column, so neither can undo the other
    // and there is nothing for an ordering to buy. Sequencing them cost
    // something instead. The ruby pass is unwalled, so where the label is on
    // the *right* — a cross-line arc to a column on the right, which is the
    // case the reader reported — it is shoved rightward past the ruby, and the
    // foldout sits on that same right-hand side. By the time the lift was
    // measured the label had already been carried clear of the pills
    // horizontally, so it found no overlap and did nothing. The reader saw a
    // sideways move and no vertical one, which is exactly what this was.
    const lift = labelLift(labelRect, foldoutBoxes);
    if (lift !== 0) {
      label.style.top = `${(parseFloat(label.style.top) || 0) - lift}px`;
    }

    // ── 1c. …and it stays inside the text, because a label that is cut in
    //        half names nothing ────────────────────────────────────────────
    //
    // The label is set `vertical-rl` and centred on its point, so a long
    // relation name — 並列構成要素〖動詞連続〗, twelve characters — is some 200px
    // tall and reaches 100px each way from the midpoint it is placed on. Where
    // that midpoint is near the head or the foot of a column, most of the label
    // is outside the text and `.tategaki`'s `overflow-y: hidden` takes it off.
    // The reader's report is that cross-line labels are worst, and the geometry
    // says why: a cross-line label sits on its own chord's midpoint (`peak` is
    // 0 for it), and when the target is at the top of a column that midpoint is
    // near the top too, so half the label is above the first character.
    //
    // Clamped along the column and by the least that makes it whole. This is
    // the one exception to "a label's position along the column is the arc's
    // own midpoint and may not be moved" — and it is not really an exception:
    // a mark that has been clipped is not naming a different stretch of the
    // sentence, it is naming nothing at all. Measured against the column's own
    // box, since that is what clips it.
    //
    // Nothing is clamped that fits, so the ordinary case is untouched; and a
    // label taller than the whole column is left where it was rather than being
    // pinned to an edge it cannot satisfy at either end.
    const columnBox = column.getBoundingClientRect();
    const clamped = label.getBoundingClientRect();
    if (clamped.height <= columnBox.height) {
      const above = columnBox.top + casing - clamped.top;
      const below = clamped.bottom - (columnBox.bottom - casing);
      const shift = above > 0 ? above : below > 0 ? -below : 0;
      if (shift !== 0) {
        label.style.top = `${(parseFloat(label.style.top) || 0) + shift}px`;
      }
    }

    // ── 2. The row stands off its character to clear the label ──────────
    // Measured after the step above, which is the whole of what the ordering
    // buys: the row yields to the label where the label ended up, and a label
    // that got itself clear asks the row for nothing.
    // **The row's box is the 品詞 pill's box** — the semantics are out of the
    // row's flow (`SEMANTICS_WRAPPER`), and `getBoundingClientRect` gives an
    // element's own border box rather than the union with whatever overflows
    // it, so `rowBox` above is that pill as painted and nothing more. Which is
    // what should be measured: it is what is on the page at the moment the
    // analysis arrives, and it is what stays there.
    const above = row.classList.contains("token-subtitle-above");
    const edge = above
      ? Math.min(...glyphs.map((glyph) => glyph.getBoundingClientRect().top))
      : Math.max(...glyphs.map((glyph) => glyph.getBoundingClientRect().bottom));
    // The air the row keeps from its own character — `.token-subtitle-below`'s
    // margin, read off the page as `markBuffer` reads it — and the ceiling
    // that keeps it from spending the next character's air as well. The gap
    // between two glyphs down the column is one advance less a glyph; the row
    // takes `stand` of it as margin and its own height as ink, its casing
    // reaches `casing` further, and what is left over is the travel that still
    // leaves the same `stand` of air on the far side.
    const stand = above ? edge - rowBox.bottom : rowBox.top - edge;
    const ceiling = advance - glyphBox.height - 2 * stand - rowBox.height - casing;
    const standoff = rowStandoff(
      obstacleFor(rowBox, 0, casing).box,
      obstacleFor(label.getBoundingClientRect(), 0, casing).box,
      above ? -1 : 1,
      ceiling,
    );
    if (standoff > 0) {
      row.style.top = `${(parseFloat(row.style.top) || 0) + (above ? -standoff : standoff)}px`;
    }
  }

  // ── 3. The readings lift out of the pills' way ──────────────────────────
  // Queried through `READING_OBSTACLES` rather than reusing `pills` above,
  // though the two selectors are the same string today. That the readings
  // dodge exactly the pills is a finding about all five of this overlay's
  // marks (the measurement is at that constant), where `CATEGORY_PILLS` is
  // just what a pill is; one name for both would make the finding look like a
  // definition, and the two would part company the moment either changed.
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
 *
 * ── Foot to top was wrong, and by exactly the box ─────────────────────────
 * The reader's report: *"Multi-character token ties still jut into the
 * token's head boxes."* They did, and the amount is not a guess. This ran
 * from one glyph's `bottom` to the next glyph's `top` — the *characters'* own
 * edges — and each of those characters is boxed, with the box standing off
 * the glyph rather than sitting on it (`.kanji-glyph::after` in kunten.css,
 * where the three bands are argued). Read outward from the glyph's edge, at
 * the shipped scale:
 *
 *     0 - 2px   `--head-box-casing`, page colour (the box's inner halo)
 *     2 - 4px   `--head-box-stroke` of ink — the border itself
 *     4 - 6px   `--head-box-casing` again, page colour outside it
 *
 * So a line starting at the glyph's edge crossed the whole 2px of the box's
 * own stroke and then ran a further 2px *inside* the halo, at both ends: 4px
 * of overlap past the outer face of the ink, 6px past the outermost pixel the
 * box paints. That is the jutting, and it is why the note at the drawing site
 * ends by saying a casing on this line "would bite 2px out of the box borders
 * it runs into" — the line was already inside them.
 *
 * ── Where it stops now, and why not at the other two candidates ──────────
 * At **the border's own centre line**, `--head-box-size - --head-box-stroke/2`
 * = 4 - 1 = **3px** from the glyph's edge, which is the figure and the
 * expression the arc's bow already uses against this same box (`boxBorder` in
 * `showInspector`, where the two custom properties and the reason for reading
 * the *declared* values are argued at length). Two rejected:
 *
 *   - **6px, clear of the casing** (`--head-box-size + --head-box-halo`, the
 *     reach every annotation on a boxed character is placed against). It is
 *     the right figure for an annotation and the wrong one for this line. A
 *     casing is page colour kept around a mark to hold *other* ink off it,
 *     and this line is not other ink: it and the two boxes it runs between
 *     are one mark drawn in one colour, which is the argument
 *     `.token-head-join` in kunten.css already makes for its stroke and for
 *     its refusal of a casing of its own. Stopping at 6px would leave a 2px
 *     band of paper between the tie and each box — a break in a mark whose
 *     whole job is to say that the boxes are not separate.
 *   - **4px, the ink's outer face.** Right to within a rounding: it puts the
 *     line's end exactly on the surface of the stroke it meets. But a butt
 *     joint at a fractional device pixel can show a hairline of paper, and
 *     the cure — running 1px into a stroke of the same colour — is invisible,
 *     since the tie and the border are both `--color-accent` at the same 2px
 *     width. The arc reached the same conclusion about the same box.
 *
 * Read off the box's *declared* dimensions rather than measured, for the
 * reason the arc gives in full: the three lengths are animated, this runs in
 * the same task that adds `token-cell-head`, and a box measured then is a box
 * of nothing. The line is therefore drawn at once where the box will be in
 * 160ms — which is also how the arc's apex is drawn, and the overlay fades in
 * over that same interval.
 *
 * Not looked at on a page: there is no browser in this checkout. Every figure
 * above is arithmetic against the lengths kunten.css declares. */
function markHeadCells(cells: HTMLElement[]): HeadJoin[] {
  for (const cell of cells) cell.classList.add("token-cell-head");
  const joins: HeadJoin[] = [];
  // Asked once for the token rather than once per pair, and not at all for a
  // single-character one — every token in the text is offered to this function
  // and most of them have no pair to join, where `getComputedStyle` would be a
  // style resolution spent on nothing.
  const inset =
    cells.length > 1
      ? headBoxInset(cells[0].querySelector<HTMLElement>(".kanji-glyph") ?? cells[0])
      : 0;
  for (let i = 0; i < cells.length - 1; i++) {
    const glyph = cells[i].querySelector<HTMLElement>(".kanji-glyph");
    const next = cells[i + 1].querySelector<HTMLElement>(".kanji-glyph");
    if (!glyph || !next) continue;
    const from = glyph.getBoundingClientRect();
    const to = next.getBoundingClientRect();
    if (Math.abs(from.left - to.left) > 4) continue; // wrapped into the next column
    const run = headJoinRun(from.bottom, to.top, inset);
    if (!run) continue;
    joins.push({ x: from.left + from.width / 2, top: run.top, bottom: run.bottom });
  }
  return joins;
}

/** How far inside each glyph's own edge a tie between two boxed characters
 * begins and ends: the head box's border, at its centre line. See
 * `markHeadCells` above, which argues the figure and the two it beat.
 *
 * The same two custom properties the arc's bow reads, asked of the same kind
 * of element, and falling back the same way: **0 where nothing is declared**
 * (no box on this page, or an engine that computes no custom properties —
 * jsdom does not), which draws the tie exactly where it was drawn before any
 * box existed rather than drawing nothing. */
function headBoxInset(anchor: HTMLElement | undefined): number {
  if (!anchor) return 0;
  const style = getComputedStyle(anchor);
  const size = parseFloat(style.getPropertyValue("--head-box-size")) || 0;
  const stroke = parseFloat(style.getPropertyValue("--head-box-stroke")) || 0;
  return size > 0 ? Math.max(0, size - stroke / 2) : 0;
}

/** The run a tie actually covers, from the two glyph edges it spans and the
 * inset each end keeps out of the box it is meeting — `null` where there is
 * no run left to draw.
 *
 * **The degenerate case is refused rather than clamped**, and there are two
 * of them, which is why this is a function and not two lines at the call
 * site. The first is the one that was already guarded: two cells whose glyphs
 * do not stand clear of one another at all (`to <= from`), which is what a
 * wrap or a zero-height measurement looks like. The second is new with the
 * inset — two glyphs closer together than twice it, where the boxes' own
 * borders already meet or overlap in the gap and a tie between them would be
 * drawn backwards. At the shipped scale the gap between two glyphs down a
 * column is a whole `--kanji-gap` (44px) against `2 x 3 = 6px` of inset, so
 * this cannot fire on the page as it is set; it fires if the type is ever set
 * so tight that the boxes touch, and then the right answer is no line, since
 * two boxes with nothing between them are already the one unit the tie exists
 * to draw.
 *
 * Exported because it is the whole of the geometry and there is no browser
 * here to measure a rendered one. */
export function headJoinRun(
  from: number,
  to: number,
  inset: number,
): { top: number; bottom: number } | null {
  const top = from + inset;
  const bottom = to - inset;
  return bottom > top ? { top, bottom } : null;
}

/** Renders the click-to-inspect overlay for `entry`: a row of category chips
 * (its 品詞 at rest, and its semantic domain and sense on hover — see
 * `posChipParts` for the three, `watchSemantics` for the reveal) anchored just
 * past its glyph — above it if the arrow to its head points *upward* (head below it
 * in the column), below otherwise, so the chips never sit on the same side the
 * arrow is approaching from — and, unless `entry.token` is its own sentence's
 * ROOT (no real head to point to), an arrow from its head's glyph to its own,
 * labeled with its deprel. Arrow *endpoints* are measured off each
 * `.kanji-glyph` specifically — never the wider `.kanji-cell`, which also
 * includes the ruby annotation's own footprint and would throw the endpoints
 * off the kanji's true center — but the *font size* instead uses the full cell
 * width (kanji+ruby+kunten), per `CHIP_SIZE_OF_CELL`'s own doc. Every position
 * is pixel coordinates relative to `column` (the same technique
 * `positionCompoundLines` uses); everything lives inside one
 * `.token-inspector-overlay` layer, a normal child of `column` (not
 * viewport-fixed), so it scrolls with the text for free inside the panel's own
 * `overflow-x: auto`.
 *
 * ── The chips overflow their column, on purpose, and what that means ─────
 * A column is one character wide and three pills are not, so the row reaches
 * over the columns on either side of the one it annotates. A reader asked for
 * that explicitly, and it is what let the font size stop being a function of
 * the longest label (`CHIP_SIZE_OF_CELL`).
 *
 * **Which side it overflows changed with the reveal, and how much.** The row
 * used to be three pills centred on the glyph, hanging about 83px each way. It
 * is one pill now — the 品詞 alone, hanging about 32px each way — and the
 * revealed semantics hang off that pill's right-hand edge alone, about 100px
 * of them, since the overlay is set `horizontal-tb` and the row reads left to
 * right inside it.
 *
 * So the resting state reaches half as far as it did, and the revealed one
 * reaches further, on one side, for as long as a pointer is on it. Screen-right
 * is the block-flow *start* in `vertical-rl` — the text already read — and by
 * the note below that is the edge a reader cannot scroll back to. The case to
 * look at on a page is therefore unchanged in kind and moved in degree: a
 * character in the rightmost column loses its right-hand pill, but only while
 * the semantics are up, and never the 品詞, which is what a reader asked to
 * see by default. Arithmetic, not a measurement: there is no browser in this
 * checkout.
 *
 * Two consequences were checked in the stylesheets rather than on a page —
 * there was no browser here — and are recorded so that whoever has one knows
 * where to look:
 *
 * **What can clip it.** `.tategaki` is `overflow-x: auto` with `overflow-y:
 * hidden` (tategaki.css, where the pairing is argued at length), and
 * `.main-panel` above it is `overflow: hidden`. The vertical axis is the hard
 * clip, and the row is *safer* there than the stack it replaces: three pills
 * side by side are one pill tall where three stacked were three, so the
 * generous top/bottom padding that note relies on has more room, not less.
 * The horizontal axis is the scrolling one, so a row running off toward the
 * *end* of the block flow extends the scrollable area and can be scrolled to;
 * one running off the *start* edge — which in `vertical-rl` is the right-hand
 * side, the first column of the text — is not reachable by scrolling and will
 * be cut. So the case to look at on a page is a character in the rightmost
 * column of a sentence, whose row can lose its right-hand pill. Nothing here
 * can fix that without changing what the panel's overflow is, which is a
 * decision about the panel and not about the chips.
 *
 * **What it does to clicks.** Nothing, on the characters it covers, except
 * where a pill is actually over them, and less than that at rest: a hidden
 * semantic pill takes no pointer events either (`.token-subtitle-semantics`
 * in kunten.css), so for as long as the reader has not asked for them the
 * whole of that 107px is transparent to the text. `.token-inspector-overlay`
 * is `pointer-events: none` and only `.token-subtitle` opts back in
 * (kunten.css), so the row box is transparent to the text underneath — a click
 * in it still selects the character it lands on. A click on a *pill* opens that pill's
 * menu, which is what a pill is for, and is the one way the row takes a
 * gesture from a neighbouring character. That was true of the single chip too;
 * there is simply more of it.
 *
 * The pills used to stand 2px apart and those gaps fell through to the text as
 * well. They are gone: the pills meet at a chevron seam now, and what falls
 * through instead is each pill's *notch* — which lands on the pill drawn
 * underneath it rather than on the text, `clip-path` clipping the hit map with
 * the paint, so a click in the notch opens the menu of the segment the reader
 * is actually pointing at. See the chevron rules in kunten.css. */
export function showInspector(column: HTMLElement, headEntry: Entry | null, entry: Entry): void {
  clearInspector(column);
  // **Fetch the tagger's opinion of this sentence now, not when a menu opens.**
  //
  // There is no "annotation mode" in this app to switch into, but this is the
  // moment that means it: drawing the analysis is what a right click asks for,
  // and a reader who has asked for it is annotating and is a gesture or two
  // away from a 品詞 or 意味 menu. Sending the request here rather than from
  // `shadeRetagMenu` buys those hundreds of milliseconds — the time it takes to
  // read the arc and move the pointer to a pill — and spends them on a round
  // trip the reader would otherwise watch, so the menu can be shaded from the
  // model in the frame that draws it. One request covers the whole sentence,
  // so every menu on every character of it is warm after the first click.
  //
  // Fire-and-forget in the strong sense: `prefetchXposScores` starts the
  // request and returns, it cannot throw, and if it never answers the menus
  // shade from the corpus prior exactly as they always have. Nothing below
  // this line waits for it and nothing about the overlay depends on it.
  //
  // **Not at render time, for all that the reader would rather have it there.**
  // Warming every sentence as the tree is drawn was the tempting version, and
  // it is the wrong one on this architecture: the tagger passes would queue on
  // the same single worker that is still parsing the rest of the document
  // (main.ts dispatches its batches one after another as the characters are
  // revealed), so a document-wide warm would put N pipeline runs *in front of*
  // text the reader is waiting to see. Per-sentence and on demand costs one
  // pass for the sentence being annotated, at a moment when nothing else is
  // competing for the worker, and reaches the same place by the time it
  // matters.
  const inspected = sentenceOf(entry.cell);
  if (inspected) {
    prefetchXposScores(inspected.tokens.map((t) => t.text).join(""), inspected.tokens.length);
  }
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
  // One size for every mark the analysis writes: the three category chips and
  // the deprel label. A fixed fraction of the cell, not a bound computed from
  // the longest label — see `CHIP_SIZE_OF_CELL`, which is also where the
  // guarantee that used to live here is buried.
  const fontSize = cellRect.width * CHIP_SIZE_OF_CELL;

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
    // **A same-column label is *placed* in the gutter; a cross-line label is
    // placed on its own midpoint and moved only if something is in the way.**
    //
    // The two are different kinds of decision and an earlier round of this
    // conflated them. A same-column arc runs beside a column of text, so its
    // label has nowhere to be except the gutter, and `gutterOffset` is where
    // that label *lives* — not a response to a collision. A cross-line arc
    // runs between the columns; the midpoint of the edge is where its label
    // belongs, and it is already clear of the text there.
    //
    // Giving the cross-line case the same half-cell put its label 44px off the
    // edge it names, which the reader reported as "way off". Displacement for
    // it is `decollideOverlay`'s business and is minimal by construction: the
    // label steps across the gutter only far enough to clear the readings
    // (`labelStandoff`, plus the gap the ruby itself keeps from its kanji), and
    // the pill row yields along the column rather than the label yielding to
    // it. So the rule the reader asked for — on the midpoint, moving only far
    // enough to leave room for the chip and the ruby — is what falls out of
    // placing it honestly and letting the decollision do the rest.
    //
    // `peak` is 0 for a cross-line arc, so this is the chord midpoint exactly.
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
    watchDeprelLabel(label);
    overlay.append(label);
  }

  // ── The three category chips ──────────────────────────────────────────
  // The 品詞, its semantic domain and the sense inside it, as three pills —
  // see `posChipParts` for why the composed form went and why the split falls
  // where it does, and `CHIP_SIZE_OF_CELL` for what the split is worth in
  // pixels and why the three share one size. Each carries its own casing
  // (`caseApparatus` walks `.token-subtitle`), its own hit target and its own
  // menu; the size is the apparatus's, not the chip's.
  //
  // All three are plain text, where the deprel label goes through
  // `setDeprelLabel` to get its brackets into spans of their own. There is no
  // bracket here any more — the stacking says what it said — and there could
  // not usefully be: the recentring those spans exist for is a *vertical*
  // correction (`vhal` half-width and a rebalanced padding along the column,
  // argued at `.subtype-bracket-open` in kunten.css), and these chips are the
  // marks in this app set horizontally.
  const parts = posChipParts(entry.token);
  const chip = (className: string, text: string) => {
    const el = document.createElement("div");
    el.className = `token-subtitle ${className}`;
    el.textContent = text;
    el.style.fontSize = `${fontSize}px`;
    return el;
  };
  // A container, so the three are laid out by the layout rather than by this
  // function measuring each one's width to place the next, which would be a
  // reflow inside the part of it that runs before the overlay is in the
  // document at all. The row is what carries the position, the centring and
  // the gap from the character; the pills carry only what a pill is.
  // `markBuffer` reads that gap off the row for the same reason it used to
  // read it off the chip: it is declared once, in the stylesheet.
  const subtitle = document.createElement("div");
  subtitle.className = "token-subtitle-row";
  // **The row takes the chips' own size, so that an `em` on it means what it
  // means on them.** Every pill already carries this size inline (see `chip`),
  // and the row did not — it inherited the column's, which is the main text at
  // `--size-main`, two and a half times larger. That was invisible until the
  // row's centring came to be expressed in `em`: `--chip-chevron` is `0.4270em`,
  // so the quarter-chevron correction below resolved to 4.70px against the
  // 1.88px it is meant to be, and the pill sat some 2.8px *right* of its
  // character instead of on it. Declared here rather than in the stylesheet
  // because the size itself is measured (`CHIP_SIZE_OF_CELL` of the cell) and
  // the pills' own inline sizes are set the same way, in `chip` above.
  //
  // Nothing else on this row is em-valued — the gap from the character is
  // `0.25rem` on `.token-subtitle-above/-below`, which `markBuffer` reads — so
  // this changes one thing and only one.
  subtitle.style.fontSize = `${fontSize}px`;
  subtitle.append(chip("token-subtitle-pos", parts.word));
  // ── The other two, in a box of their own ────────────────────────────────
  // The 品詞 is what the row shows at rest; the domain and the sense arrive on
  // hover, and arrive without moving it. That is what the wrapper is for and
  // it is a layout guarantee rather than a grouping: absolutely positioned, it
  // is out of the row's flow, so the row measures the 品詞 pill alone and
  // `translateX(-50%)` centres that pill on the character in both states. The
  // full argument, the arithmetic and the alternative that was rejected are at
  // `SEMANTICS_WRAPPER` above and at `.token-subtitle-semantics` in
  // kunten.css.
  //
  // Absent where the treebank writes `*` at that level, and absent for a
  // token with no tag at all. Not drawn empty and not drawn: a missing pill is
  // how a reader sees that there is nothing recorded there, and it is why one
  // pill alone means "no semantics" (see `posChipParts`).
  const semantics = document.createElement("div");
  semantics.className = "token-subtitle-semantics";
  if (parts.domain !== undefined) {
    semantics.append(chip("token-subtitle-domain", parts.domain));
  }
  if (parts.sense !== undefined) {
    semantics.append(chip("token-subtitle-sense", parts.sense));
  }
  // **Only when it holds something**, which the chevron rules make
  // load-bearing rather than tidy. Everything about the seam is keyed on
  // `:not(:last-child)`, and an empty wrapper appended after the 品詞 pill
  // would satisfy that test: the pill would reserve the half chevron of
  // trailing padding it needs for a point it can never grow, and would have
  // its ink cut back by the same amount to hide the reservation. The ink would
  // look right and the *box* would be 3.76px wider than a lone pill's — which
  // is 1.88px of `translateX(-50%)`, so the one character in the text whose
  // tag records nothing at all would have its chip sitting off centre. See the
  // chevron rules in kunten.css, where the reservation is argued.
  if (semantics.childElementCount > 0) {
    subtitle.append(semantics);
    watchSemantics(subtitle);
  }
  subtitle.style.left = `${glyphRect.left - columnRect.left + glyphRect.width / 2}px`;
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

  // How far past a mark its casing paints, read off the stylesheet before
  // anything is drawn — every measurement below is of a mark as painted, and
  // the casing itself cannot be drawn until the marks have stopped moving.
  const casing = casingReach(overlay);

  // The three marks moved out of one another's way, once, in the order they
  // yield in: the deprel label out of the pills' way across its gutter, the
  // pill row off its character to clear what is left of the label, and the
  // readings up their own lanes out of the pills'. They walk back when the
  // analysis goes (`clearInspector`). `decollideOverlay` is the whole of the
  // arrangement and is where the order is argued — including the two marks
  // that are deliberately left overlapping.
  decollideOverlay(column, overlay, casing);

  // The casing for the whole apparatus, painted once and under all of it —
  // the arc's own, the arrowhead's, and the chips'. Drawn from the chips as
  // they finally stand, which is why it is here and not beside them or before
  // the decollision; see `caseApparatus`, where the paint order is argued.
  caseApparatus(overlay);

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
  // very smallest move. `decollideOverlay` has the measurements, for that
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

/** The direct dependent of a token about to be dragged that the cycle-break
 * machinery is already deciding for, and so the one this cascade's own
 * `cascadeDependents` must never be offered a second opinion about.
 *
 * A cycle only forms when the drop target sits inside the dragged token's
 * own subtree, which means some direct child of the dragged token is an
 * ancestor of (or is) that target — and `cyclePath` names exactly that
 * ancestor chain, `[newHeadId, …, childId]`, walked upward by following
 * `head` links from the target to the dragged token. The entry immediately
 * before `childId` in that walk is therefore a token whose own `head` really
 * is `childId`: the one direct dependent on the path, and the same arc
 * `cycleBreakCandidates` always lists first ("the arc into the dragged
 * token", in its own doc).
 *
 * Offering *that* dependent the ordinary cascade's "move to the new head"
 * option would be offering it a move into its own descendant (the new head
 * sits inside its subtree by the same construction that put it on the cycle
 * to begin with) or, in the one-step case, directly onto itself — either a
 * fresh cycle or a self-loop, exactly the side door the task requires this
 * cascade not to open. `planCycleBreak`/`applyCycleBreak` already decide this
 * dependent's fate as part of settling the cycle itself, whether that leaves
 * it exactly where it was or moves it to the dragged token's *old* head (a
 * different destination from the cascade's own "move to the new head", and
 * not one this function has any part in choosing) — so it is excluded here,
 * whole, for that older and more specific mechanism to finish resolving.
 *
 * `undefined` for a cycle too short to name one — `cyclePath` only ever
 * returns `null` for "no cycle" or an array of at least two ids for a real
 * one, so this is reached in practice only from a genuine cycle, but a
 * one-element input is handled rather than assumed away. */
export function cycleChildOfDraggedToken(cycle: readonly number[]): number | undefined {
  return cycle.length >= 2 ? cycle[cycle.length - 2] : undefined;
}

/** One dependent of a token about to change heads, as a question the parser
 * can answer twice over: how confident it is in the arc as it stands (the
 * dependent pointing at its current head) and, separately, how confident it
 * would be in the arc that does not yet exist (the dependent pointing at the
 * new head instead). Both numbers are the same quantity `scoreArc` already
 * returns for the deprel menu's own shading — the softmax mass an arc-eager
 * parser puts on making an arc at all, at the parser state where it could —
 * so the two are on one scale and `planDependentCascade` can compare them
 * directly without renormalising either one.
 *
 * `stayConfidence` is null on exactly the same two occasions `move` is: not
 * "the parser scored this arc at zero" but "the parser was never asked, or
 * the transition oracle could not reach this arc in the tree it was asked
 * about" (see `scoreArc`'s own doc on what a non-projective arc gives back).
 * That distinction is the same one `planCycleBreak` already keeps about a
 * cycle's own candidate arcs, and it must survive here as a `null` rather
 * than collapsing into a number: a null must never masquerade as a low score
 * in the comparison below. */
export interface DependentCascadeCandidate {
  id: number;
  stayConfidence: number | null;
  move: { label: string; confidence: number } | null;
}

/** What became of one dependent once the parser — or its absence — had its
 * say. `moved` is false and `dep` absent when the dependent keeps its old
 * head, unchanged in every field: it never needed a new relation, because it
 * never got a new arc. `moved` is true only alongside a `dep`, which is the
 * label `scoreArc` itself returned for the new arc — never a default, and
 * never the relation the dependent used to carry to its old head, which
 * described a different arc entirely and has no claim on this one. */
export interface DependentCascadeDecision {
  id: number;
  moved: boolean;
  dep?: string;
}

/** Resolves every dependent of a token that is about to keep or lose it as a
 * head — the rule the reader asked for: *"all of that token's dependents
 * must choose to either keep that token as their head, or transfer their
 * deprel to the new head; this will be determined by the parser's assigned
 * arc likelihoods, as will the deprels of any arcs thus created."*
 *
 * **The rule, stated once so it can be checked rather than trusted.** A
 * dependent moves to the new head exactly when both arcs could be scored and
 * the new one's confidence is *strictly* greater than the old one's. Three
 * things follow from writing it this way rather than as "moves unless scored
 * otherwise" or some other phrasing that reads the same on the one case
 * anyone tries first.
 *
 * A dependent whose new arc could not be scored at all never moves, whatever
 * the old arc's own confidence was: an unscoreable arc is not an arc the
 * parser doubts, it is a question the parser was not asked — most often a
 * non-projective result once the dependent is hypothetically moved (see
 * `scoreArc`'s own doc) — and doubt about a different arc is not evidence for
 * granting this one. This is the same distinction `planCycleBreak` already
 * keeps about a cycle's candidate arcs, applied to the opposite side of a
 * comparison: there, an unscored candidate is protected from being dropped;
 * here, an unscored candidate is refused a move it would otherwise be a
 * guess to grant.
 *
 * A dependent whose *old* arc could not be scored — rarer, but not
 * impossible, since moving the token above it can change which of the
 * sentence's arcs cross which, and projectivity is a fact about the whole
 * tree rather than about one edge of it — also never moves, even where the
 * new arc scored cleanly. The old head is where the dependent already is;
 * staying there needs no justification, and the comparison only ever
 * supplies a reason to leave, never a default reason to refuse staying.
 *
 * A tie moves nothing, for the same reason: the instruction is to decide by
 * the parser's arc likelihoods, and two equal likelihoods have not decided
 * anything. Where the evidence does not separate "stay" from "move", this
 * function's answer is "stay" — never a coin toss dressed as one, which the
 * reader explicitly ruled out.
 *
 * **A session with no parser is not a special case of this rule; it is the
 * general case with every candidate unscoreable.** A `DependentCascadeCandidate`
 * built with `stayConfidence: null` and `move: null` — which is what a
 * session with no parser behind it can honestly report about any arc, having
 * asked nothing — decides `moved: false` here for exactly the reason above,
 * with no branch of this function's own code needing to know that no parser
 * was ever asked. The caller that assembles these candidates is the one
 * place that distinction has to live (see `cascadeDependents`), and it lives
 * there so that this function can be tested — and trusted — without ever
 * standing up a parser to do it. */
export function planDependentCascade(
  candidates: readonly DependentCascadeCandidate[],
): DependentCascadeDecision[] {
  return candidates.map(({ id, stayConfidence, move }) => {
    if (move !== null && stayConfidence !== null && move.confidence > stayConfidence) {
      return { id, moved: true, dep: move.label };
    }
    return { id, moved: false };
  });
}

/** Gathers the two arc scores `planDependentCascade` needs for every direct
 * dependent of `tId` other than `exceptId`, and applies whatever it decides —
 * folded into the reparent that occasioned it exactly the way
 * `relabelArcsUnder`'s own after-the-fact relabel is: landed here, outside
 * any `withUndo`, this never pushes a history entry of its own, so it undoes
 * in the same single press as the structural edit above it rather than
 * needing a second one of its own (`editHistory.ts`'s own note on
 * `withUndo` is what makes that true: a mutation made between two `withUndo`
 * calls belongs to whichever one comes next, because `undo` only ever
 * compares against the last snapshot pushed).
 *
 * `exceptId`, when given, is `cycleChildOfDraggedToken`'s answer — the one
 * direct dependent of `tId` the cycle-break machinery is already deciding
 * for itself. See that function's own doc for why offering it this cascade's
 * "move to the new head" a second time would be opening the side door the
 * task warns against.
 *
 * Never asks the parser anything if this session has no parser running.
 * `scoreArc` begins with `await initParser()`, which in a CoNLL-U-only
 * session — every shipped sample, every upload — would start the 46MB
 * download from a plain drag rather than from a reader asking for live
 * parsing; `shadeRetagMenu` was shipped with exactly that mistake once
 * already (see its own doc), and this is the same guard for the same
 * reason. What such a session decides instead is not a gap needing its own
 * logic: every candidate it would otherwise have built carries two nulls,
 * and `planDependentCascade` already turns two nulls into "stay" for every
 * one of them (see its own doc) — so the honest fallback and this early
 * return produce the identical tree, and the return exists only to save the
 * round trip nothing would have changed anyway. */
function cascadeDependents(sentence: Sentence, tId: number, newHeadId: number, exceptId?: number): void {
  const dependents = sentence.tokens.filter((t) => t.head === tId && t.id !== exceptId);
  if (dependents.length === 0 || !parserStarted()) return;

  const text = sentence.tokens.map((t) => t.text).join("");
  const heads = sentence.tokens.map((t) => t.head);
  const deps = sentence.tokens.map((t) => t.dep);

  Promise.all(
    dependents.map(async (dep): Promise<DependentCascadeCandidate> => {
      // The arc as it stands — a real arc in the live, already-edited tree
      // (`t`'s own head is `newHeadId` here already; this function only ever
      // runs after that structural edit has landed), so this asks `scoreArc`
      // about a real arc exactly the way `relabelArcsUnder` does.
      const stay = await scoreArc({ text, heads, deps, headIndex: tId, childIndex: dep.id }).catch(() => null);
      // The hypothetical arc, scored the only way `scoreArc` can score one
      // that is not yet real (see its own doc: the head/child indices asked
      // about have to be the tree's own, or the transition oracle never
      // reaches a state that answers about them): a copy of the live tree
      // with this one dependent's head already moved, so there is an actual
      // arc at `newHeadId -> dep.id` to walk to.
      const movedHeads = heads.slice();
      movedHeads[sentence.tokens.findIndex((t) => t.id === dep.id)] = newHeadId;
      const move = await scoreArc({ text, heads: movedHeads, deps, headIndex: newHeadId, childIndex: dep.id }).catch(
        () => null,
      );
      return {
        id: dep.id,
        stayConfidence: stay?.confidence ?? null,
        move: move ? { label: move.label, confidence: move.confidence } : null,
      };
    }),
  ).then((candidates) => {
    const moved = planDependentCascade(candidates).filter((d) => d.moved);
    if (moved.length === 0) return;
    // Re-checked against the live tree, not the one the scores were measured
    // against: an undo or a further edit can land during the round trip.
    // `t` no longer heading to `newHeadId` means this cascade's whole edit
    // has already been reverted out from under it — not merely one
    // dependent's own arc having moved on, which the per-dependent check
    // below catches separately.
    const t = sentence.tokens.find((tok) => tok.id === tId);
    if (!t || t.head !== newHeadId) return;
    let changed = false;
    for (const d of moved) {
      const token = sentence.tokens.find((tok) => tok.id === d.id);
      if (!token || token.head !== tId) continue;
      token.head = newHeadId;
      token.dep = d.dep!;
      changed = true;
    }
    if (changed) rerenderPreservingSelection();
  });
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

/** **The three category menus are one menu with three tabs**, and this is the
 * tab that is out.
 *
 * The reader's rule: *"The POS/semantic context menus should be treated as
 * tabs of the same menu, and when any one is open, left-clicking one of the
 * other chevron-separated segments should be sufficient to switch to that
 * menu."* The three ask successively narrower questions about one tag —
 * 品詞, then that 品詞's domains, then that domain's senses — so they are
 * three views of one thing rather than three unrelated menus, and the row of
 * chevroned pills is already shaped like a tab strip.
 *
 * What follows from calling them tabs, and is implemented on that reading:
 *
 *  - **Switching costs a left click**, not the right click that opens a menu
 *    from nothing. Opening is a question the reader asks of a character;
 *    switching is moving between the answers to a question already asked, and
 *    charging the same gesture for both would make the strip feel like three
 *    menus that happen to be adjacent.
 *  - **The panel does not jump.** Each menu is still subjoined to its own pill
 *    (`menuAnchorFor`), and because the pills share a row they share a bottom
 *    edge — so the menu's top stays put across a switch and only its right
 *    edge moves, to sit under the tab that is out. That is what a tab strip
 *    does.
 *  - **The tab that is out is marked**, and joins the panel below it
 *    (`data-menu-tab`, `.token-subtitle[data-menu-tab]` in kunten.css).
 *
 * `null` where no category menu is open — including while the *relation* menu
 * is, which is not one of these tabs: it belongs to the deprel label, is
 * left-joined rather than subjoined, and asks about the arc rather than the
 * tag. */
let openMenuKind: RetagKind | null = null;

/** Which mark is currently wearing the tab mark, so it can be unmarked without
 * a search of a DOM that may since have been re-rendered. */
let taggedTab: HTMLElement | null = null;

/** The three pills that are tabs of one menu, as one selector. The relation
 * label is not one of them: its menu is left-joined to the label rather than
 * subjoined to a pill, and it asks about the arc rather than about the tag.
 *
 * **This is now the whole of that distinction**, and there used to be a
 * `TAB_KINDS` set beside it saying the same thing in kinds. Both places that
 * read it asked "is one of the three category menus open" as a way of asking
 * "is this click a tab switch"; neither asks that any more, because a click on
 * a revealed pill opens that pill's menu whether or not a menu is already up
 * (`watchSemantics`, where the change is argued). What is left is a question
 * about the element under the pointer, and a selector is what answers it. */
const TAB_PILLS = ".token-subtitle-pos, .token-subtitle-domain, .token-subtitle-sense";

/** **The mark whose menu is out**, set on every one of the four marks and not
 * only on the three tabs.
 *
 * It was the three pills alone, and the deprel label — which is the fourth
 * mark with a menu of its own — had nothing at all to say that its menu was
 * open. The reader's instruction: *"If you're going to give the selected tab a
 * cream background, then the pill is going to need a drop shadow. In which
 * case, give the deprel label the same treatment."* "The same treatment" needs
 * the same marker, so this now takes the label too and the stylesheet keys two
 * rules on it (`.token-subtitle[data-menu-tab]` and
 * `.token-arrow-label[data-menu-tab]` in kunten.css). One slot still, because
 * there is one open menu.
 *
 * ── And it is what holds the row open, which is a bug fixed by moving it ──
 * The reader's report: *"When a menu is open, the pill foldout should not
 * auto-hide even on mouseout."* The hold existed already
 * (`holdSemanticsFor`/`data-semantics-menu`/`releaseSemanticsHold`) and
 * `semanticsShown` read it, so none of the machinery was missing. What was
 * missing was one call. `interrogate` held the row when it opened a menu from
 * a pill, but the *tab switch* in `watchSemantics` — a left click on another
 * pill while a category menu is out — went straight to `openRetagMenu`, which
 * begins by closing the menu that is there, which releases the hold, and then
 * marked the new tab and stopped. So the row was held for the first menu of a
 * session and unheld for every menu after a switch, and the reader would have
 * seen exactly what they reported: the foldout that survived a mouseout the
 * first time stopped surviving it as soon as they moved between tabs.
 *
 * Two of the three candidates are ruled out rather than merely not taken: the
 * hold was *not* confined to the semantic menus (`interrogate` called it for
 * every kind, the 品詞 pill included, and for the deprel label too, where it
 * finds no row and does nothing — correctly, since that menu is not about the
 * row); and the grace timer does re-check, since it calls `syncSemantics` and
 * `semanticsShown` reads all three flags rather than the hovered one.
 *
 * Adding the missing call to the switch would have fixed the report and left
 * the shape that produced it, which is a rule spread over two callers that
 * both have to remember it. So the hold moves here instead, where it becomes a
 * property of the mark rather than of the gesture: **a tab that is out holds
 * its own row open, and there is one place that can get it wrong.** The label
 * costs nothing on the way through — `holdSemanticsFor` looks for a
 * `.token-subtitle-row` above the mark it is given and finds none above the
 * label — so the rule reads "while any of the three category menus is open the
 * row stays revealed, whatever the pointer is doing", which is the rule that
 * was asked for. */
function markMenuTab(mark: HTMLElement | null): void {
  if (taggedTab && taggedTab !== mark) delete taggedTab.dataset.menuTab;
  taggedTab = mark;
  if (mark) mark.dataset.menuTab = "true";
  // The hold follows the mark, in both directions and in this order: the
  // release first, so that a switch between two pills of one row does not
  // release the row it has just re-held. `holdSemanticsFor` overwrites
  // `semanticsMenuRow`, so releasing afterwards would put down the flag it had
  // just picked up.
  releaseSemanticsHold();
  if (mark) holdSemanticsFor(mark);
}

/** Closes the open menu. `immediate` only where another menu is about to
 * take its place in the same spot — two menus fading through each other
 * there read as one menu flickering. */
function closeContextMenu(immediate = false): void {
  if (openMenu) {
    if (immediate) openMenu.remove();
    else fadeOutAndRemove(openMenu);
  }
  openMenu = null;
  openMenuKind = null;
  // A menu opened from a category pill holds its row's semantics up for as
  // long as it is there, and the hold now travels with the tab mark
  // (`markMenuTab`, where the invariant is argued). Every route a menu can
  // take out — a pick, a click outside, Escape, a re-render, another menu
  // opening — arrives here, so unmarking here is what lets the hold go.
  markMenuTab(null);
}

/** Opens the retag menu for one annotation — right-clicking the 品詞 chip
 * offers the eleven 品詞, the domain chip that 品詞's own domains, the sense
 * chip that domain's own senses, and the deprel label the whole relation
 * inventory (`posMenuPrefixes`/`domainMenuValues`/`senseMenuValues`/
 * `DEPREL_GROUPS`), with the token's current value marked. Picking one edits
 * the tree in place and re-renders (see `applyTokenEdit`). Each menu belongs
 * to the label it retags, so there is no ambiguity about which of the four a
 * right-click meant — and the kanji itself stays free for plain selection and
 * head-dragging.
 *
 * Set in tategaki like the text it annotates, and laid out as a
 * dictionary-style table: entries run top-to-bottom and wrap into further
 * columns leftward (`.token-context-menu`'s own flex-wrap in vertical-rl —
 * see kunten.css). Entries keep their inventory order rather than being
 * re-sorted by kana, though the menus get that order from different places.
 * `DEPREL_GROUPS` is written in grammatical order (core arguments, then
 * modifiers, then coordination), which is how a printed grammar table groups
 * them and is far easier to scan for the value you want than gojūon would be.
 * The three category menus take the corpus's: prefixes commonest-first,
 * domains commonest-first within a prefix, senses commonest-first within a
 * domain. That is not a grammar's order and
 * could not be — nobody has filed 121 semantic pairs into a scheme, and
 * inventing one here would be inventing a taxonomy the treebank does not have
 * — but it is the order that puts what a reader is most likely to want at the
 * head of the column they are reading down, and it is the same order the
 * shading draws (see `xposPrior`), so position and weight say one thing
 * rather than two.
 *
 * **Three menus, because there are three chips.** There was one 品詞 menu
 * for a while and it was flat: 116 rows under eleven headings, every semantic
 * pair the treebank attests, in one box. It was the largest menu in the app
 * by a factor of five and it asked a reader choosing what kind of noun a noun
 * is to scan past every kind of verb on the way. Splitting the chip in two
 * (`posChipParts`) split the question with it, once and then again: the tag
 * has three editable levels and each chip now carries its own. Eleven 品詞,
 * at most fourteen domains (under 名詞), at most fourteen senses (under
 * 動詞・行為) — each a column or two where the flat menu needed a dozen. See
 * `posMenuPrefixes`, `domainMenuValues` and `senseMenuValues`, which are where
 * the inventories and the filtering are.
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
/** The values a menu's shadable rows carry — the same rows `shadeMenuItems`
 * paints, asked for as a list.
 *
 * `xposPosterior` needs the rows up front rather than a value at a time,
 * because it normalises each menu by its own largest weight and so cannot
 * answer about one row in isolation. Selected by the same query as the shading
 * itself, so a row that gets a weight and a row that gets painted are the same
 * set by construction rather than by two lists agreeing. */
function shadedMenuValues(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>(".token-menu-item[data-value], .token-menu-seg[data-value]")].map(
    (item) => item.dataset.value!,
  );
}

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

/** How common the commonest tag in the treebank is — 46 329 occurrences of
 * `v,動詞,行為,動作`, the plain content verb — and so the denominator the
 * 品詞 menu's shading is put over. Read off the inventory rather than written
 * down, because a regenerated corpus moves it. */
const COMMONEST_XPOS = Math.max(...XPOS_INVENTORY.map((xpos) => xposFrequency(xpos)));

/** **The model's own opinion about this character, spread over one menu's
 * rows** — the posterior the three priors below stand in for whenever it can
 * be had.
 *
 * The comment on `xposPrior` says that "*nothing in this pipeline predicts an
 * xpos distribution*". That was wrong, and this function is the correction.
 * The wheel's `tagger` is a custom `multifield_tagger` whose model is *"the
 * four per-field softmaxes **and a joint softmax over the attested codes**,
 * side by side"* — so there is a scored inventory, over the 121 tags the
 * training data contains, conditioned on the token. `xposScores` in
 * `parse/pyodideClient.ts` is the pipe; its own doc records the validation
 * (argmax equals the tag the pipeline itself assigns, on 60 tokens of four
 * sentences).
 *
 * **Each menu is marginalised over its own question, and conditioned on the
 * answers above it.** The three menus ask three different things, so the same
 * distribution has to be summed three different ways:
 *
 *  - a **品詞** row is every tag under that prefix, summed — the reader has not
 *    yet said anything to condition on;
 *  - a **domain** row is every tag with that domain **under this token's own
 *    品詞**, summed — the menu offers that 品詞's domains, so a row that
 *    counted other prefixes would answer a question the row does not ask;
 *  - a **sense** row is one whole tag, its 品詞 and domain both fixed.
 *
 * **Then normalised by the menu's own largest, which is what makes the dimming
 * differential.** What a reader is doing with an open menu is choosing among
 * the rows in *it*, so the scale that matters is relative to the best row
 * there, not to the tagset. This is the substantive difference from
 * `xposPrior`: that one is normalised against the commonest tag in the
 * treebank and can leave a rare 品詞's whole menu grey, which is right about
 * "how usual is this tag" and useless for "which of these do I want here".
 * Both are kept and they answer different questions.
 *
 * **Null rather than a map of zeros** wherever the model has said nothing
 * about this menu — no distribution, no rows, no mass on any row, or a token
 * whose own tag will not parse so the lower two menus have nothing to
 * condition on. The caller then keeps the prior it has already drawn. Zeros
 * would redraw the menu at the floor, which reads as "the model has ruled all
 * of these out" — a far stronger claim than "the model was not asked".
 *
 * **Written to be handed nonsense**, because what is on the other end is a
 * softmax marshalled through JSON out of a WASM worker: a key that is not a
 * four-field tag, a NaN, a negative, an infinity. Each is dropped to zero
 * rather than propagated, since a NaN reaching `opacityForLikelihood` comes
 * out at the floor and is indistinguishable from a confident refusal. */
export function xposPosterior(
  kind: "pos" | "domain" | "sense",
  rows: readonly string[],
  distribution: Record<string, number>,
  current: string | undefined,
): Map<string, number> | null {
  if (rows.length === 0) return null;
  const parts = parseXpos(current);
  // The lower two menus are conditioned on the token's own tag; without one
  // there is no question to answer. The 品詞 menu needs no such condition.
  if (kind !== "pos" && parts === undefined) return null;

  const mass = new Map<string, number>(rows.map((row) => [row, 0]));
  for (const [tag, score] of Object.entries(distribution)) {
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0) continue;
    const scored = parseXpos(tag);
    if (scored === undefined) continue;
    const prefix = `${scored.letter},${scored.word}`;
    const row =
      kind === "pos"
        ? prefix
        : prefix !== `${parts!.letter},${parts!.word}`
          ? undefined
          : kind === "domain"
            ? scored.domain
            : scored.domain === parts!.domain
              ? scored.sense
              : undefined;
    if (row === undefined || !mass.has(row)) continue;
    mass.set(row, mass.get(row)! + score);
  }

  const best = Math.max(...mass.values());
  if (!(best > 0)) return null;
  for (const [row, score] of mass) mass.set(row, score / best);
  return mass;
}

/** **How usual this relation is in the treebank** — the relation menu's prior,
 * and the answer to a menu that sat flat beside three shaded ones.
 *
 * The three category menus draw a corpus prior *synchronously and
 * unconditionally* and then let the model's posterior land over it if it
 * arrives (see `shadeRetagMenu`). The relation menu had only the second half,
 * and on a CoNLL-U text — every shipped sample, and every upload — there is no
 * parser to ask, so it stayed unshaded. The reader reported it twice, and the
 * second time made the diagnosis plain: the shading had not failed, the menu
 * simply had nothing to fall back on.
 *
 * `xposPrior`'s doc argues the whole case for a prior and every word applies
 * here: 34 relations unshaded give a reader looking for one nothing to start
 * from, and shaded they start in the right half of the list. What a prior
 * cannot say is which relation is right *here*, which is what the posterior is
 * for and what it still does when a parser is in the session.
 *
 * **Normalised against the commonest relation, not the corpus** — 108,006 `mod`
 * out of 533,362 tokens — for `xposPrior`'s reason: dividing by the token count
 * would put every row between the floor and 0.20 and leave the menu with no
 * solid entry at all, which reads as a model unsure of everything rather than
 * as a frequency table. Against `mod` the scale is "share of the commonest
 * relation there is": 1 for `mod`, 0.88 for `comp:obj`, 0.51 for `subj`, 0.037
 * for `mod@tmod`, and the floor for the handful the treebank writes rarely.
 *
 * **Subtypes count as themselves.** A row's segments are picked separately and
 * each carries its own `data-value`, so `mod` and `mod@tmod` are two answers a
 * reader chooses between; folding a subtype into its base would shade every
 * segment of a row alike and say nothing about the choice on offer.
 *
 * Zero for a relation the treebank does not have, which is the floor — the same
 * treatment `xposPrior` gives a tag no annotator has written.
 *
 * Counted by `scripts/build-deprel-frequency.py`, over the same corpus and the
 * same branch as the xpos inventory, so a shaded relation menu and a shaded
 * 品詞 menu are commensurable. */
export function deprelPrior(relation: string): number {
  return (DEPREL_FREQUENCY[relation] ?? 0) / COMMONEST_DEPREL;
}

/** The shipped counts, and the commonest of them as the denominator. Read once
 * rather than searched per row: the table is 36 entries and a menu asks it 34
 * times in a frame. */
const DEPREL_FREQUENCY: Record<string, number> = deprelFrequency.relations;
const COMMONEST_DEPREL = Math.max(1, ...Object.values(DEPREL_FREQUENCY));

/** **What the 品詞 menu's shading means, now that no model can answer it.**
 *
 * The relation menu's shading is the parser's own probability for each arc
 * label, and the 品詞 menu's used to be the morphologiser's own probability
 * for each UPOS. The menu does not offer UPOS any more, and *nothing in this
 * pipeline predicts an xpos distribution*: the wheel's tagger emits a tag, not
 * a scored inventory, and `posScores` — the pipe that answered here — can only
 * ever speak about the fifteen UPOS. Asking it and mapping its answer onto
 * rows through `uposForXpos` was considered and is worse than useless: it
 * would give all 34 rows under 名詞 one identical shade (they all derive to
 * NOUN or PROPN), so the number would vary exactly where the reader has
 * already decided and be constant exactly where they are choosing.
 *
 * So the number changes its source, and this is that change written down: it
 * is **the treebank's own frequency**, `xposFrequency`, over the commonest tag
 * in the treebank. A prior, not a posterior. It says how usual a tag is in
 * Literary Chinese as the Kyoto annotators tagged it, and it says the same
 * thing on every character in the text — where the old shading said something
 * different about every character, having been conditioned on the sentence.
 *
 * That is a genuine weakening and the reason for accepting it is that the
 * alternative is worse in these menus specifically. A sense menu runs to
 * fourteen rows and a domain menu to fourteen, where the UPOS menu had 14 in
 * all — and unshaded, a reader looking for the right kind of 名詞 gets
 * fourteen equally-black domains and nothing to start from. Shaded this way,
 * 人 (65 342) stands out from 外観 (10) and the search starts in the right
 * half of the list. What the shading cannot do is tell them which is right
 * *here*, and it never claimed to for the entries a model had ruled out
 * either — see `opacityForLikelihood`, whose floor is exactly "the model would
 * not have said this".
 *
 * **Normalised against the commonest tag rather than against the corpus.**
 * Over 533 362 tokens the commonest tag is 8.7% of the text, so dividing by
 * the token count would put *every* row between the floor and 0.81 and leave
 * the menu with no solid entry at all — a menu drawn entirely in grey, which
 * reads as a model that is unsure of everything rather than as a frequency
 * table. Against the commonest tag the scale is "share of the most usual tag
 * there is": 1 for `v,動詞,行為,動作`, the floor for the six rows the treebank
 * writes fewer than 47 times, and a spread across the rest. Six at the floor
 * against 27 the other way round.
 *
 * Zero for a tag the treebank does not have — the token's own unattested tag,
 * appended to its list by `offeredValues`. The floor is right for it: it is
 * a tag no annotator has ever written, which is what the floor means here.
 *
 * Unlike the two model pipes this needs no round trip and cannot fail, so the
 * 品詞 menu is now shaded in the frame it opens in and is shaded in a session
 * with no parser in it at all — where before, a CoNLL-U upload got an unshaded
 * menu. The frequencies are shipped data.
 *
 * Exported for the tests, which walk the whole inventory through it: what
 * matters about a shading is the shape of it over every row, not the two rows
 * anyone thought to check. */
export function xposPrior(xpos: string): number {
  return xposFrequency(xpos) / COMMONEST_XPOS;
}

/** How often the treebank writes the commonest 品詞 — 168 830 名詞, out of
 * 533 362 tokens — and so the denominator the 品詞 menu's shading is put over.
 * Summed from the rows rather than read off a prefix count, because a prefix
 * count is not something `xpos.ts` exposes and the sum is the same number. */
const COMMONEST_XPOS_PREFIX = Math.max(
  ...xposPrefixes().map((prefix) => xposesUnder(prefix).reduce((n, xpos) => n + xposFrequency(xpos), 0)),
);

/** The same shading one level up, for the menu whose rows are 品詞 rather than
 * tags: how often the treebank writes *any* tag under this prefix, over how
 * often it writes the commonest 品詞. Everything `xposPrior` says about what
 * the number is and is not — a corpus prior, unconditioned on the token, in
 * the place a model's probability used to be — holds here unchanged.
 *
 * It spreads well over the eleven: 名詞 solid, 動詞 0.993, and 感嘆詞 (131
 * occurrences) alone at the floor.
 *
 * **One row is shaded by mass it will not give you**, and it is worth saying
 * which. 記号 is 19% of the treebank and comes out at 0.960, but five of its
 * six rows are the marks `UNEDITABLE_UPOS` hides, so picking 記号 gets you
 * 記号〖一般〗 and its 1 358 occurrences rather than the 101 556 the shading
 * is drawn from. The alternative — summing only the offered rows, which would
 * put 記号 at 0.623 — was rejected because it makes the number answer a
 * different question from the row it is drawn on: the row says 記号, and how
 * usual 記号 is in Literary Chinese is a fact about 記号 and not about what
 * this menu will let a reader do with it. The wrinkle is one row of eleven and
 * is recorded here rather than smoothed away. */
export function xposPrefixPrior(prefix: string): number {
  return xposesUnder(prefix).reduce((n, xpos) => n + xposFrequency(xpos), 0) / COMMONEST_XPOS_PREFIX;
}

/** How often the treebank writes every tag under one 品詞 and domain, summed
 * — and, as the denominator, the same for the commonest such pair: 動詞・行為,
 * 111 912 of the 533 362 tokens, which is a quarter of a corpus in one branch
 * of one 品詞. */
const COMMONEST_XPOS_DOMAIN = Math.max(
  ...xposPrefixes().flatMap((prefix) =>
    domainsUnder(prefix).map((domain) => domainMass(prefix, domain)),
  ),
);

function domainMass(prefix: string, domain: string): number {
  return sensesUnder(prefix, domain).reduce(
    (n, sense) => n + xposFrequency(`${prefix},${domain},${sense}`),
    0,
  );
}

/** The middle level's shading: how often the treebank writes anything under
 * this 品詞 and domain, over how often it writes the commonest domain there
 * is. Everything `xposPrior` says about what the number is and is not — a
 * corpus prior, unconditioned on the token, standing where a model's
 * probability used to — holds here unchanged.
 *
 * Zero for a (prefix, domain) the treebank does not have, which is the
 * token's own where an upload or the tagger's composition has invented one.
 * The floor is right for it: it is a domain no annotator has ever written. */
export function xposDomainPrior(prefix: string, domain: string): number {
  return domainMass(prefix, domain) / COMMONEST_XPOS_DOMAIN;
}

/** Which of the four retag menus is in play. Each opens from its own label —
 * the three category chips and the arrow's — and each is a different question
 * about the same token, so the kind travels with every call rather than being
 * inferred from what the token happens to carry.
 *
 * Three of the four edit one field apiece of the same tag; the fourth edits an
 * arc. That they share a code path at all is a fact about menus and not about
 * annotation: what is common is a box of rows in tategaki with one row marked,
 * and everything below `groups` in `openRetagMenu` is written once for that
 * reason. */
export type RetagKind = "pos" | "domain" | "sense" | "dep";

/** Shades a just-opened retag menu: the treebank's frequencies for the two
 * 品詞 menus, the parser's own opinion for 係り受け.
 *
 * The relation half is after the fact, like `relabelArcsUnder`: it is a round
 * trip to the Pyodide worker (measured at ~45ms for the arc), and a menu that
 * waited for it would be a menu that opens late. It opens at once, unshaded,
 * and settles a moment later — which is also exactly how it stays if there is
 * no parser in the session at all. The 品詞 half is local and immediate; see
 * `xposPrior` for what its number is and why it is no longer a model's.
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
async function shadeRetagMenu(kind: RetagKind, entry: Entry, menu: HTMLElement): Promise<void> {
  if (kind !== "dep") {
    // Synchronous, and deliberately before any `await`: there is nothing to
    // wait for, so the shading is part of the frame that draws the menu and
    // the reader never sees it arrive.
    //
    // **Three menus, three vocabularies, one quantity.** A row names a field
    // value and not a tag, so the frequency it stands for is the mass of every
    // tag that has that value *in this token's context*: a 品詞 row is a
    // prefix and takes the sum of its rows', a domain row a (prefix, domain)
    // and takes the sum of its senses', a sense row a whole tag and takes its
    // own count. Hence a closure per level rather than one function — the
    // second and third need the fields the reader is not editing, which are
    // this token's.
    //
    // Each is normalised by the commonest thing *of the same kind* in the
    // whole treebank rather than within the menu: the commonest 品詞 (名詞,
    // 168 830), the commonest domain (動詞・行為, 111 912), the commonest tag
    // (動詞・行為・動作, 46 329). Within-menu normalisation would put a solid
    // row at the head of every menu, including the menus of a 品詞 the
    // treebank barely writes, and so would say "this is the usual answer"
    // where the honest thing to say is "none of these is usual". The cost is
    // that a rare 品詞's sense menu can come out grey throughout, which is
    // what being rare looks like.
    const prefix = syntacticPrefix(entry.token.xpos) ?? "";
    shadeMenuItems(
      menu,
      kind === "pos"
        ? xposPrefixPrior
        : kind === "domain"
          ? (domain) => xposDomainPrior(prefix, domain)
          : (sense) => xposPrior(withSense(entry.token.xpos, sense)),
    );
    // …and then, if the model will answer, shade it again over the top.
    //
    // **The prior is drawn first and unconditionally, and that ordering is the
    // point.** The model's distribution comes from a round trip into the WASM
    // worker and may take a frame or several; it is null in a session with no
    // parser behind the tree at all (a CoNLL-U upload), and null again where
    // the tokenization has moved under it. Drawing the corpus prior
    // synchronously means the menu is never unshaded at any moment — the reader
    // sees frequencies immediately, and sees them replaced by the model's own
    // opinion if and when it arrives. The alternative, awaiting the model
    // before shading anything, trades a menu that is always useful for one that
    // is briefly blank and sometimes stays that way.
    //
    // The two say different things and the second is the better one where it
    // exists: the prior is "how usual is this tag in Literary Chinese", the
    // posterior "which of these rows does the tagger want *for this
    // character*". See `xposPosterior`.
    const sentence = sentenceOf(entry.cell);
    if (!sentence) return;
    const rows = shadedMenuValues(menu);
    if (rows.length === 0) return;
    const text = sentence.tokens.map((t) => t.text).join("");
    const count = sentence.tokens.length;
    // **The warm case does not await, and that is the whole of the change.**
    // Showing the analysis for this character asked for its sentence's
    // distributions a gesture ago (see `showInspector`), so ordinarily the
    // answer is already in hand: `cachedXposScores` is a synchronous read, an
    // `async` function runs synchronously until its first `await`, and there
    // is no `await` on this branch — so the posterior lands in the same frame
    // as the prior above it and the reader never sees the intermediate
    // shading. `undefined` is the one value that means "nothing cached yet"; a
    // cached `null` is the model's settled refusal and must *not* be re-asked
    // (see the cache's own note on the three values).
    let distribution = cachedXposScores(text, count, entry.token.id);
    if (distribution === undefined) {
      // Cold — the reader got here without the overlay (the pills are reachable
      // from a fused span's menu, and a session may have had its parser start
      // late), or the prefetch is still in flight. Wait for it, which is what
      // this function did on every open before the cache existed.
      //
      // Deliberately the same sentence-wide request the prefetch makes, rather
      // than the single-token `xposScores`: it costs the model exactly the same
      // pass (the worker tags the whole doc either way), it de-duplicates
      // against a prefetch already in flight instead of racing it, and it
      // leaves the rest of this sentence's menus warm. A single-token fallback
      // would buy nothing — the two calls share their Python and refuse in the
      // same cases, so a token the batch declined is not a token the single
      // call would answer.
      await loadXposScores(text, count);
      distribution = cachedXposScores(text, count, entry.token.id) ?? null;
    }
    // The reader may have moved on, or opened another menu, while that was in
    // flight — shade the menu that asked, or nothing. Same discipline the
    // relation menu keeps below. (Vacuous on the warm path, where no time has
    // passed; kept unconditional because which path ran is not this line's
    // business.)
    if (!distribution || openMenu !== menu) return;
    const weights = xposPosterior(kind, rows, distribution, entry.token.xpos);
    if (!weights) return;
    shadeMenuItems(menu, (value) => weights.get(value) ?? 0);
    return;
  }
  // ── **Only where this session has a parser at all** ─────────────────────
  //
  // The reader's report: *"what happened to the likelihood dimming in the
  // deprel menu?"* It went when the shipped samples did, and the two are the
  // same fact seen from opposite ends.
  //
  // **What the relation menu has that the other three do not is nothing.** The
  // three category menus draw the treebank's own frequencies first and
  // synchronously (the branch above), and put the model's posterior over the
  // top only if it arrives; so in a session with no model they still dim, and
  // they dim with a real quantity. This menu has no such table — nobody has
  // counted the 34 relations over the Kyoto treebank the way
  // `scripts/build-xpos-inventory.py` counts the 121 tags — so `scoreArc` is
  // the whole of its shading, and a session that cannot ask is a menu drawn
  // flat.
  //
  // **And the shipped samples are exactly that session.** They are CoNLL-U
  // trees and open by the upload route, deliberately never starting Pyodide —
  // `SAMPLE_TEXTS` in Sidebar.ts argues it at length ("a sample opens without
  // Pyodide having to come up at all"), and `parserStarted` in
  // pyodideClient.ts argues the other half, that such a session "has
  // deliberately not paid for 20MB of Pyodide and 26.5MB of wheels". So the
  // reader opened a sample, opened the relation menu, and got a flat menu
  // beside three shaded ones.
  //
  // **What this line changes is not the flatness; it is the 46MB.** `scoreArc`
  // begins with `await initParser()`, which in such a session *starts the
  // download* — from a right click, with no status, no progress bar, and
  // (because the menu is long gone by the time it lands) nothing to show for
  // it. That is the policy `parserStarted` exists to state, broken here and
  // nowhere else: the xpos prefetch already consults it for precisely this
  // reason. Asked here, a sample session neither pays nor pretends.
  //
  // **What is still missing, and where it would come from.** The honest fix
  // for a parser-less session is the one the 品詞 menus already have: a corpus
  // prior. The Kyoto treebank has a relation on every one of its 533,362
  // tokens, and counting them in `scripts/build-xpos-inventory.py` beside the
  // tags would give this menu the same fallback in the same shape. It is not
  // done here because the treebank is not in this checkout and a frequency
  // invented from anything else — this document's own relations, say — would
  // be a number that looks like the others and is not one.
  if (!parserStarted()) return;
  // **The prior first, and before anything that can return.** Every branch
  // below is a reason the model cannot answer — no sentence, no parser in this
  // session, a ROOT token, an arc the oracle refuses — and each of them used to
  // leave the menu flat. Drawn here, the relation menu is shaded in the frame
  // it opens in, exactly as the three category menus are, and the model's own
  // opinion lands over it afterwards where there is one to have.
  shadeMenuItems(menu, deprelPrior);

  const sentence = sentenceOf(entry.cell);
  if (!sentence) return;
  const text = sentence.tokens.map((t) => t.text).join("");
  try {
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
    // **The two quiet outcomes, named rather than merged.** Neither is a
    // failure and neither is warned about, but a reader of this code should
    // not have to work out which `!arc || openMenu !== menu` was covering:
    // `null` is an arc the transition oracle could not reach (the tree is
    // non-projective at that point — `scoreArc`'s own doc measured 2 of 6
    // sampled arcs on one sentence, so this is ordinary), and a menu that is
    // no longer `openMenu` is one the reader has already replaced or closed.
    if (!arc) return;
    if (openMenu !== menu) return;
    shadeMenuItems(menu, (value) => arc.labels[value] ?? 0);
  } catch (err) {
    // **This used to be a bare `catch {}`, and that is what hid the bug this
    // function was just fixed for.** The comment it carried — "no parser in
    // this session" — was a guess about which failure it was swallowing, and
    // it was the wrong guess for three rounds of work: the parser-less session
    // is handled above now, so anything arriving here is a genuine fault
    // (`Example.from_dict` refusing a tree, a tokenization that no longer
    // lines up, a worker that died) and is worth saying so.
    //
    // `console.warn` and not a thrown error, because an unshaded menu is still
    // a usable menu: the reader can pick any relation in it, and the shading
    // is an opinion about the options rather than part of them. Quiet on the
    // ordinary path by construction — the one case that fires often enough to
    // be noise is the session with no parser, and that returns before the try.
    console.warn("tokenInspector: could not score this arc; the relation menu is unshaded", err);
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

/** **The air a joined menu leaves between itself and its mark** — 6px, which
 * is `--head-box-reach` in kunten.css and is the one distance this overlay
 * declares between a boxed character and anything written beside it.
 *
 * The reader's correction: *"I didn't mean subjoin/left join with zero space!
 * Use the same amount of space as between the head box and the deprel label."*
 * `menuAnchorFor` returned the pill's bottom right and the label's top left
 * exactly, so the menu's border and the mark's shared a pixel and the two read
 * as one box with a seam in it rather than as a panel hanging off a mark.
 *
 * ── The arithmetic, off the box's own three lengths ───────────────────────
 * The head box is three bands drawn outward from the glyph's edge
 * (`.kanji-glyph::after`, and the note above it at `@property
 * --head-box-offset`):
 *
 *     --head-box-offset   4px   out to the outer edge of the border box
 *                               (`--head-box-size` on `:root`)
 *     --head-box-stroke   2px   the line, painted *inward* from that edge —
 *                               so it lives inside the offset and adds
 *                               nothing to the total
 *     --head-box-casing   2px   page colour spread beyond it
 *                               (`--head-box-halo` on `:root`)
 *     ----------------------------------------------------------------
 *     --head-box-reach    6px   offset + casing
 *
 * and that sum is exactly what every annotation on a boxed character is placed
 * against: the reading's lane, the second reading's lane, the kaeriten's foot,
 * the 踊り字's foot (`left/top: calc(100% + var(--head-box-reach))`, five
 * places in kunten.css). It is the panel's declared standoff from a head box,
 * it is derived rather than chosen, and it moves if the box ever does — which
 * is the property that made it worth taking over any figure of this menu's
 * own.
 *
 * ── The two readings that were rejected, with their figures ───────────────
 *   **`--head-box-casing` alone, 2px.** The white a reader actually sees
 *     between the box's vermilion line and an annotation placed at the reach:
 *     the outermost 2px of the box is page colour, so ink stops at 4px out and
 *     the annotation starts at 6. It is the honest answer to "the space
 *     between the two marks" and it is rejected on the instruction's own
 *     terms — 2px is what the reader was calling zero.
 *   **`--head-box-offset` alone, 4px.** The space between the character and
 *     its box, which is a different pair of things.
 *
 * ── What could not be measured, and is recorded rather than guessed ───────
 * The gap between a head box and the deprel label is not a fixed quantity on
 * the page, so it could not simply be read off: the label is placed at the
 * *gutter's* midpoint (`showInspector`, `labelX = midX + nx * cellRect.width /
 * 2`), which is a fact about the columns, while the box is placed against the
 * head character, which is generally somewhere else down the column entirely.
 * Where the two do stand beside each other, the arithmetic at the shipped
 * scale is: glyph half-width 22px (`--size-main` 2.75rem), box painting out to
 * 22 + 6 = 28px from the column's centre line; the label centred at
 * `cellRect.width / 2` = 44px with an across-the-run size of 1.2 x 17.6 +
 * 2 x (0.15rem + 1.5px) = 28.92px, so its frame stands at 44 - 14.46 =
 * 29.54px and its own 2px casing at 27.54. Frame to frame that is 3.54px;
 * casing to casing the two just touch. Neither is a declared figure and
 * neither would survive a change to the type scale, which is the second reason
 * the reach is what this takes. (The `2 x (0.15rem + 1.5px)` was `2 x 0.15rem
 * + 2 x 1.5px` when the frame was a `border`: it is an inset shadow now and
 * the padding carries what the border used to, so the sum, and every figure
 * derived from it here, is unchanged to the pixel. That was the point of
 * paying for it in the padding — see `.token-arrow-label` in kunten.css.) Arithmetic against the stylesheets: there is
 * no browser in this checkout and nothing here was looked at.
 *
 * A number here rather than a length read off the page, because
 * `menuAnchorFor` is pure and is exercised without a layout
 * (`tests/menuAnchor.test.ts`). The one copy this costs is declared beside the
 * function that spends it and is named after the property it copies. */
export const MENU_JOIN_GAP = 6;

/** **Where a retag menu joins the mark it was opened from**, as the point
 * `menuTopLeftFor` hangs the box's top right corner from.
 *
 * The reader's rule: *"The POS/semantic context menu should be subjoined to
 * the pill, and the deprel context menu should be left-joined to its pill."*
 * So a menu is no longer dropped at the pointer — it is joined to its own
 * mark, and which edge it joins on differs by kind because the two marks are
 * set on different axes.
 *
 *  - **A category pill is horizontal**, one of a row running across the
 *    gutter, so its menu is *subjoined*: the menu's top right corner sits at
 *    the pill's bottom right, putting the menu's top edge against the pill's
 *    bottom edge and their right edges flush. It hangs straight down from the
 *    thing it is about.
 *  - **The deprel label is vertical**, set down the column like the text, so
 *    its menu is *left-joined*: the top right corner sits at the label's top
 *    left, putting the menu's right edge against the label's left edge with
 *    their tops level. It grows away to the left, which is the direction a
 *    `vertical-rl` table grows anyway.
 *
 * Both follow from the corner `menuTopLeftFor` anchors — the first entry of
 * the first category stands in the menu's top right, so joining *that* corner
 * to the mark is what puts the start of the menu's reading order against the
 * mark the reader asked from. Joining any other corner would put the far end
 * of the table there.
 *
 * Pure, and given a box rather than an element, so the arithmetic is checkable
 * without a layout — see `tests/menuAnchor.test.ts`. The viewport clamp still
 * happens afterwards in `menuTopLeftFor`, so a join near an edge gives way to
 * staying on screen; a menu that has been clamped is no longer flush, which is
 * the right order of priority. */
export function menuAnchorFor(
  kind: RetagKind,
  mark: Extent,
  gap: number = MENU_JOIN_GAP,
): { x: number; y: number } {
  // One axis each, and it is the axis of the join. A subjoined menu drops away
  // from the pill's foot, so the gap goes on `y` and the right edges stay
  // flush — which is what keeps the tab strip's promise that switching tabs
  // moves only the panel's far edge and never its top (see `openMenuKind`). A
  // left-joined menu grows away from the label's leading edge, so the gap goes
  // on `x` and the tops stay level. Moving both would push each menu diagonally
  // off the mark it belongs to, which is neither of the two joins the reader
  // named.
  return kind === "dep"
    ? { x: mark.left - gap, y: mark.top }
    : { x: mark.right, y: mark.bottom + gap };
}

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

function openRetagMenu(kind: RetagKind, entry: Entry, x: number, y: number): void {
  closeContextMenu(true);

  const menu = document.createElement("div");
  menu.className = "token-context-menu";
  // What the menu marks as this token's own answer, in the vocabulary that
  // menu's entries are written in: a prefix, a domain, a sense, a relation.
  // Undefined for a chip whose level the token records nothing at — which
  // cannot be reached, a menu being opened from a chip and that chip not being
  // drawn. The one live case is the 品詞 menu on a token with no treebank tag:
  // nothing is marked, correctly, because the chip above it is showing a UPOS
  // and that is not one of the eleven answers on offer.
  const parts = parseXpos(entry.token.xpos);
  const current =
    kind === "pos"
      ? syntacticPrefix(entry.token.xpos)
      : kind === "domain"
        ? parts?.domain
        : kind === "sense"
          ? parts?.sense
          : entry.token.dep;

  /** **The edit all three category menus make**: a whole tag, and the UPOS
   * that follows from it.
   *
   * The three differ only in how the tag is arrived at — `withPrefix`,
   * `withDomain`, `withSense` in xpos.ts, which substitute one field and
   * repair the fields below it, keeping what still exists under the new parent
   * and falling back to the commonest only where the old value has no meaning
   * there. What happens afterwards is the same for all three and is written
   * once, here.
   *
   * **The UPOS is not the reader's choice.** It is a function of the tag and
   * of the features the token already carries, so picking 描写 as a domain on a
   * token bearing `VerbForm=Conv` yields ADV and not ADJ — a descriptive verb
   * *used adverbially*, which is what such a token is. That is also why the
   * morph is not touched: it says how the word is being used, the xpos says
   * what it is, and the reader is editing the second.
   *
   * Undefined leaves `pos` exactly as it was rather than writing a guess. It
   * can only happen for a tag outside the derivation table — an uploaded
   * tree's own, or one the tagger composed that the treebank has never
   * attested — and for those this app has no opinion to record. A stale UPOS
   * is recoverable; a fabricated one is not distinguishable from a real one
   * afterwards. */
  const retag = (xpos: string) => {
    closeContextMenu();
    applyTokenEdit((token) => {
      token.xpos = xpos;
      const upos = uposForXpos(xpos, token.morph);
      if (upos !== undefined) token.pos = upos;
    });
  };

  /** One entry of any of the three category menus: one box, one pick, one
   * short line of Japanese.
   *
   * `value` is the field value the menu is written in — a prefix, a domain, a
   * sense — and is what marks the current entry and what `shadeMenuItems` asks
   * about. `text` is what the row draws, which is the same string for every
   * value but one: `fieldLabel` writes `*` as 「なし」, and the split between
   * the two arguments is what keeps the stored value the treebank's while the
   * row reads as Japanese. There is no composition to do in any of them now: each menu edits
   * one field and shows that field's values, where the single flat menu these
   * replace had to write all four in one row and bracket half of them. The
   * bracket went with the chip that needed it (see `posChipParts`), and what
   * is left is the plainest entry in the app.
   *
   * `title` carries the tag the pick would write, whole. That is worth more
   * than the field value on its own: the four fields are what a CoNLL-U file
   * holds, and it is also the one place a reader can see the *repair* before
   * making it — hovering 名詞 on a token tagged `v,動詞,行為,動作` shows
   * `n,名詞,人,役割`, which is what picking it will do. */
  const makeItem = (value: string, text: string, xpos: string) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    item.dataset.value = value;
    if (value === current) item.dataset.current = "true";
    item.textContent = text;
    item.title = xpos;
    item.addEventListener("click", () => retag(xpos));
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

  // One group apiece for the three category menus, because each is one list
  // and there is nothing to file it under. What heads them is the level
  // *above* the one they edit: the domain menu is headed by the 品詞 whose
  // domains they are, the sense menu by the domain. That is the one thing
  // which distinguishes a menu from the other ten (or the other fifty-one) of
  // its kind, and it is already on the chip above the one that opened it, so
  // the heading confirms rather than informs. The 品詞 menu has no level above
  // it and is headed by the name of the column instead (`POS_MENU_HEADING`).
  const groups: [heading: string, entries: HTMLElement[]][] =
    kind === "pos"
      ? [[
          POS_MENU_HEADING,
          posMenuPrefixes(entry.token).map((prefix) =>
            makeItem(prefix, prefix.split(",")[1] ?? prefix, withPrefix(entry.token.xpos, prefix, (candidate) => editableTag(candidate, entry.token))),
          ),
        ]]
      : kind === "domain"
        ? [[
            posChipParts(entry.token).word,
            domainMenuValues(entry.token).map((domain) =>
              makeItem(domain, fieldLabel(domain), withDomain(entry.token.xpos, domain)),
            ),
          ]]
        : kind === "sense"
          ? [[
              parts?.domain === undefined ? posChipParts(entry.token).word : fieldLabel(parts.domain),
              senseMenuValues(entry.token).map((sense) =>
                makeItem(sense, fieldLabel(sense), withSense(entry.token.xpos, sense)),
              ),
            ]]
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
  openMenuKind = kind;
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
 * why no one figure describes the result any more. (Measured when the
 * relations were filed under five headings. They are under six now and the
 * measurement has not been repeated — there is no browser here — so those
 * five caps are a record of that menu and not of this one; the arithmetic
 * below is redone, which is all that can be.)
 *
 * **What the grid does to that**, computed rather than measured — there has
 * been no browser for the last three rounds, and this is the arithmetic, not
 * a claim about the page. Every figure the quadratic is made of moved:
 *
 *     L   3500 for the 23 rows, and 620 for the six headings. A heading is
 *         one line of smaller characters tracked out to a cell each
 *         (`.token-menu-heading`), plus the one cell its cartouche takes, so
 *         its extent is `(n + 1)` cells for a label of `n`: 基本成分 5,
 *         修飾成分 5, 接続・並列 6, 談話・その他 7, 複合語 4, 未分類 4 — 100,
 *         100, 120, 140, 80 and 80.
 *         4120 in all. It was 3589.6 before the grid, 3900 with the boxed
 *         headings, 3860 with them deboxed but still full-size, and 3680 with
 *         them set 割注. There is nothing else in it: the 0.1rem that used to
 *         stand between two atoms is 0 now.
 *
 *         **Five headings became six** when the relations were re-filed into
 *         『体系漢文』's 成分 (see `DEPREL_GROUPS`): the group that held the
 *         compounds and the coordinators was split, since one of the two is a
 *         sentence element and the other is a fact about a word. The rows did
 *         not move — the same 23 relations are on the same 23 rows — so the
 *         whole of the cost is one more heading and one more forced column
 *         start: **+120 on `L`, +20 on `b`**, and the two lines below carry it.
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
 *     b   (6/2)·40 = 120, where it was 100 at five categories and ≈ 112
 *         before the grid.
 *     H   (120 + √(120² + 4·4120·40)) / 2 ≈ 470, where five categories gave
 *         453.
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
 * `4120/470 + 3 = 8.77 + 3 = 11.8`, so **12 columns**, and a border box of
 * about `12·30 + 11·10 + 12 = 482` wide by `470 + 15.6 = 486` tall, against
 * the 442 × 469 the same arithmetic gave at five categories, 456 × 466 under
 * the 割注 and the 471.1 × 428.2 that was last measured. So the six-category
 * filing costs about **40px of width, 16px of height and the twelfth column**
 * — by this estimate, and the estimate was already calling 11 a near thing at
 * 11.3. It is still only the loop's first guess, and a page may answer either.
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
 * its first row. Checked on the open relation menu: all five headings sat at
 * the top of a column with their first row directly under them. (Five when it
 * was checked; the relations are filed under six now — see `DEPREL_GROUPS` —
 * and the guarantee is about a heading and its row, so it does not count
 * them.)
 *
 * ── The widow, and the lever that moves it ─────────────────────────────
 * Observed on the relation menu at 1292x792, where the first category — 述語・
 * 項 as it was then filed, and holding two rows this one does not — came out 3
 * rows, 3 rows, then 補語〖形式〗 by itself. Nothing about the last column decides
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
  // The shares on either side are what license this member's 連声 and 促音
  // forms — 遠方's 方 is offered ぽう because the share before it ends in ん,
  // and offered it only there. `shares` is the page's own division of the
  // word, guaranteed non-empty by the check above, so the touching kana is
  // exactly what the splitter will see when it divides the reading this
  // menu composes: `compoundMemberCandidates` is asked the same question
  // from both ends and cannot answer them differently.
  const candidates = compoundMemberCandidates(readingIndex, chars[index], {
    nonInitial: index > 0,
    nonFinal: index < chars.length - 1,
    precededBy: index > 0 ? shares[index - 1].slice(-1) : undefined,
    followedBy: index < chars.length - 1 ? shares[index + 1][0] : undefined,
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

/** The conjugation-class cartouche for each candidate of a readings menu, in
 * the list's own order — a label where the entry's own spelling does not tell
 * it from another entry's, and `undefined` everywhere else.
 *
 * **This answers the question `candidateReadings` left open.** Its
 * de-duplication key carries the class (see the `.filter` at the end of it),
 * so 立's た.つ and た.てる both survive as 立ツ and the reader can reach the
 * 下二段 — and its own doc says of that: "the menu shows 立ツ twice,
 * distinguished only by a paradigm the list does not print. That is a display
 * question and not this function's to answer." This is the display, and the
 * question was answered by measuring first.
 *
 * ── The population, counted over the shipped index ────────────────────────
 * All 12,356 characters of `kanjidic-index.json`, at `pos: "VERB"`, counting
 * candidates that share a reading *and* an okurigana and so render as the same
 * string:
 *
 *     158 characters carry a collision
 *     173 collisions, every one of them a pair — no group of three exists
 *     173 entries therefore stand behind an identical twin
 *
 * — far more than the two 立 and 破 that the comment names, and the same
 * figures at ADJ, PART and ADV (the inflecting arm of `candidateReadings` does
 * not vary with those tags); NOUN, PRON and PROPN see 2, out of the
 * nominalisations. Every one of the 173 is kun against kun. `tests/
 * conjClassCartouche.test.ts` re-derives all of it rather than trusting this
 * paragraph.
 *
 * By shape, 12 are two named classes (延's の+ぶ is 上二段バ行 against 下二段バ行,
 * 退's そ+く 四段カ行 against 下二段カ行) and **161 are a class against no class
 * at all** — 引's ひ+く, where one candidate carries 下二段カ行 from
 * `classicalVerbKun` and the other carries nothing.
 *
 * ── Why that majority does not decide against the 連用形 ───────────────────
 * It looks as though it must. Indexing by 連用形 separates 伝ひ from 伝へ
 * beautifully, and a candidate with no class has no 連用形 to compute — so on
 * 161 of the 173 it would print one string twice and fix nothing. **The
 * premise is false, and the reason is the one thing `classicalVerbKun` is
 * careful about**: a candidate carries a class only where its ending can no
 * longer state one, and a candidate that carries none is therefore precisely
 * the one whose ending *does* state it. 引's classless ひ+く is a modern
 * dictionary ending, and `classicalConjClass` reads 四段カ行 off it unaided.
 * Both members of the pair have a paradigm; only one of them has it written
 * down.
 *
 * So both of the reader's options are live, and the measurement separates them
 * on their merits rather than on a technicality. Asking each of the 173 pairs
 * whether its two members differ, with `derivedConjClass` supplying the
 * paradigm wherever the candidate does not carry one:
 *
 *     by conjugation class      173 / 173
 *     by 連用形                  165 / 173
 *
 * **The eight that the class separates and the 連用形 does not are a fact about
 * the paradigms, not about this data.** 四段 and 上二段 of one row share their
 * 連用形 exactly — ラ四 and ラ上二 both give り, so 足's た+る is たり either way;
 * likewise 飽 あき, 墜 おち, 満/滿 みち and 亡/滅/兦 ほろび. An index keyed on the
 * 連用形 cannot tell those apart however honestly it is built, which is why the
 * cartouche is what is implemented here and the 連用形 is not. (It is also why
 * the 岩波古語辞典's own arrangement is not a counter-example: a dictionary
 * indexed by 連用形 still prints the class beside the headword. The two are not
 * rivals there and are not rivals here — what was asked for was one of them,
 * and the one that separates every pair is the cartouche.)
 *
 * The three hardest cases are worth naming, because they are the ones a
 * one-route derivation loses: 合's あ+わす, 赤's あか+らむ and 卑's いや+しむ, each
 * a converted 下二段 candidate against an unconverted one whose ending carries
 * a stem mora (わす, らむ, しむ) — the shape `classicalConjClass` declines to
 * read at all. `derivedConjClass`'s second route answers all three off the
 * lexicon's own modern spelling, and answers them right: 四段サ行, 四段マ行,
 * 四段マ行.
 *
 * ── What a candidate with no paradigm at all is told to say ───────────────
 * The truth about such a candidate is not "class unknown, carry on": it is
 * that **picking it will not inflect it**, since `chosenConjClass` returns
 * undefined, no `syntheticLexiconEntry` is built, and the reading stands at
 * the form the menu showed wherever the sentence puts it. So the cartouche
 * says so — `CONJ_CLASS_UNKNOWN_CARTOUCHE`, 未詳 — rather than leaving the gap
 * that would read as "the plain one of the pair". Over the shipped index that
 * is reached exactly once, on 黑's くろ+し under a nominal tag, where the
 * nominalisation arm's unclassed 終止形 stands beside the ク活用 one the
 * adjective rule built.
 *
 * ── The one pair it can only report, not resolve ──────────────────────────
 * 无's な+し, also nominal, is the same word twice: ク活用 なし arriving from
 * both arms, one carrying the class and one not. Both are labelled ク, and
 * that is the right outcome rather than a failure — **the cartouche never
 * invents a distinction it cannot find.** Two entries that are one word are
 * shown to be one word, and what remains is a duplicate in the list, which is
 * `candidateReadings`'s business and not this function's.
 *
 * ── Only where it does work ───────────────────────────────────────────────
 * A cartouche is printed on **both** members of a colliding pair and on
 * nothing else, and that is a rule about what the menu is rather than an
 * economy. Everywhere else the entry's own ending already names its paradigm,
 * by exactly the argument above — printing it a second time in a box would be
 * annotating a fact the entry is already stating. And labelling only *one*
 * member of a pair would be worse than labelling neither: the unmarked one
 * would read as the ordinary reading and the marked one as an oddity, where
 * the truth is that they are two words.
 *
 * The label is derived by asking `derivedConjClass` — the very function
 * `chosenConjClass` asks once the pick is stored — so what the cartouche names
 * is the paradigm the app will actually inflect by, and the two cannot come to
 * disagree. It is a label and never a reading: it is a `<span>` appended to
 * the item's box, `offer.store` is handed the *candidate*, and nothing that
 * reaches `setChosenReading` or the page has been near this string.
 *
 * Silent for a `reread` candidate (いまだ…ズ is a construction, not a word with
 * a paradigm) and for anything with neither an ending nor a class — the
 * on'yomi, and the bare-stem candidates a compound member is offered, which
 * `compoundMemberCandidates` de-duplicates on the reading alone and so never
 * lets collide in the first place. */
export function conjClassCartouches(
  lemma: string,
  candidates: readonly ReadingCandidate[],
): (string | undefined)[] {
  // The string the item renders, which is the whole of what a collision is:
  // `makeItem` writes `reading + toKatakana(okurigana)`, and the katakana fold
  // is one-to-one over the kana this list holds, so the hiragana pair is the
  // same test at less risk of disagreeing with the renderer over a mark.
  const rendered = (candidate: ReadingCandidate) => `${candidate.reading}|${candidate.okurigana ?? ""}`;
  const shared = new Map<string, number>();
  for (const candidate of candidates) shared.set(rendered(candidate), (shared.get(rendered(candidate)) ?? 0) + 1);
  return candidates.map((candidate) => {
    if ((shared.get(rendered(candidate)) ?? 0) < 2) return undefined;
    if (candidate.kind === "reread") return undefined;
    if (candidate.okurigana === undefined && candidate.conjClass === undefined) return undefined;
    const conjClass =
      candidate.conjClass ??
      (candidate.okurigana === undefined
        ? undefined
        : derivedConjClass(lemma, candidate.reading, candidate.okurigana));
    return conjClass === undefined ? CONJ_CLASS_UNKNOWN_CARTOUCHE : CONJ_CLASS_CARTOUCHE[conjClass];
  });
}

/** The furigana menu: pick which of a character's readings this occurrence
 * takes. Grouped 訓読み/音読み the way a kanji dictionary lists them, and
 * filtered to those compatible with the token's part of speech — see
 * `candidateReadings`.
 *
 * Each item is labelled exactly as the annotation will read once chosen
 * (hiragana reading, katakana okurigana), so the choice is made against
 * what will appear rather than against a dictionary citation form.
 *
 * **With one addition, and it is set apart so as not to weaken that.** Where
 * two entries render as the same string — 立ツ against 立ツ, one 四段タ行 and
 * one 下二段タ行 — each carries a cartouche naming its paradigm, which is a
 * label and not part of the reading: it is a `<span>` beside the text, in a
 * 匡郭, at 0.65 of the size. The rule that the item reads as the annotation
 * will read is what makes the cartouche necessary rather than optional — two
 * entries that will read alike have nothing else to tell them apart. See
 * `conjClassCartouches`, which is where the population was counted and the
 * design argued. */
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

  // Keyed by the candidate object rather than by position, because the groups
  // below are `filter`ed out of this list before they are mapped and an index
  // taken there would be the *group's*. See `conjClassCartouches`.
  const cartouches = new Map<ReadingCandidate, string>();
  conjClassCartouches(entry.token.lemma, candidates).forEach((label, i) => {
    if (label !== undefined) cartouches.set(candidates[i], label);
  });

  const makeItem = (candidate: ReadingCandidate) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    item.textContent = candidate.reading + (candidate.okurigana ? toKatakana(candidate.okurigana) : "");
    // A label, not a reading, and appended as its own element so that it can
    // only ever be one: `item.textContent` above is the whole of what the
    // annotation will say, the click handler below is handed the candidate and
    // never the box, and no path from here reaches `setChosenReading` with a
    // character of this string in it. See `conjClassCartouches` for when one is
    // drawn at all, and `.token-menu-conj` in kunten.css for the frame.
    const cartouche = cartouches.get(candidate);
    if (cartouche !== undefined) {
      const mark = document.createElement("span");
      mark.className = "token-menu-conj";
      mark.textContent = cartouche;
      item.append(mark);
    }
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

  // The 係助詞, offered on a subject and on nothing else — see
  // `topicParticleOffered` for why the restriction is part of the design and
  // not a first cut at it.
  //
  // **One item that toggles, rather than a pair.** Every other item in this
  // menu is a choice among alternatives and is marked current when it is the
  // one in force; a は has no alternative to stand against, only its own
  // absence, so a second item saying "not は" would be naming the ordinary
  // state of every subject in the text. The item is therefore marked the way
  // the readings are, and clicking the marked one takes it off again — which
  // is what its `title` says in each of the two states, since a toggle is the
  // one shape in this menu a reader cannot infer from the mark alone.
  if (topicParticleOffered(entry.token)) {
    const written = chosenTopicParticle(entry.token) !== undefined;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "token-menu-item";
    item.textContent = TOPIC_PARTICLE;
    item.title = written ? "主題の「は」を外す" : "主題の「は」を付ける";
    if (written) item.dataset.current = "true";
    item.addEventListener("click", () => {
      closeContextMenu();
      applyTokenEdit((token) =>
        written ? clearChosenTopicParticle(token) : setChosenTopicParticle(token, TOPIC_PARTICLE),
      );
    });
    appendMenuGroup(menu, TOPIC_PARTICLE_HEADING, [item]);
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
    // Four labels, four menus. The chips are told apart by their own classes
    // rather than by their order in the stack: they are separate elements with
    // separate questions behind them, and a hit test that read "the second
    // `.token-subtitle`" would break the moment a token recorded no domain and
    // its sense chip stood second.
    const kind: RetagKind | null = target.closest(".token-subtitle-sense")
      ? "sense"
      : target.closest(".token-subtitle-domain")
        ? "domain"
        : target.closest(".token-subtitle-pos")
          ? "pos"
          : target.closest(".token-arrow-label")
            ? "dep"
            : null;
    if (kind && selected) {
      event.preventDefault();
      // Joined to the mark, not dropped at the pointer — see `menuAnchorFor`.
      // The mark is the element the hit test above already found, asked for
      // again by the same selectors so the two cannot disagree about which
      // pill was clicked.
      const mark = target.closest<HTMLElement>(
        kind === "dep" ? DEPREL_LABEL : `.token-subtitle-${kind}`,
      );
      const anchor = mark
        ? menuAnchorFor(kind, mark.getBoundingClientRect())
        : { x: event.clientX, y: event.clientY };
      openRetagMenu(kind, selected.entry, anchor.x, anchor.y);
      // Marked after the open, which closes the previous menu and would
      // otherwise clear the mark that was just set — and which is also what
      // releases the hold this call is about to take, so the order is not
      // optional in either respect.
      //
      // **All four marks, where it used to be the three tabs.** The deprel
      // label now wears the same marker so it can take the same treatment
      // (`markMenuTab`, and `.token-arrow-label[data-menu-tab]` in
      // kunten.css). Marking it costs the row nothing: the hold that travels
      // with the marker looks for a `.token-subtitle-row` above the mark, and
      // there is none above a label.
      //
      // Opening the menu takes the pointer off the row and onto the menu, so
      // the semantics would otherwise fade out behind it — including the very
      // pill this menu is about. Held until the menu goes
      // (`closeContextMenu`).
      markMenuTab(mark);
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
      // **A press on a mark that answers a left click is that gesture, not a
      // dismissal.**
      // This listener is on `document` in the *capture* phase, so without this
      // it ran first, closed the menu, and stopped the click that followed —
      // which is why the tab strip appeared to do nothing at all. The gesture
      // itself is in the row's own click handler; all that is needed here is
      // to let the click through. See `openMenuKind`.
      //
      // **Asked of the row and not of `openMenuKind`**, which is what carries
      // the one-click open (`watchSemantics`) past this listener. It used to
      // ask whether one of the three category menus was open, which was
      // exactly the set of cases the switch could arise in; a click on a
      // revealed pill now means "open this pill's menu" whatever menu is up,
      // and the case that guard missed was a real one — with the *relation*
      // menu open, a press on a pill was dismissed here and the pill's own
      // menu never opened. The pill's row is what knows whether it is
      // revealed, so that is what is asked.
      //
      // **And the deprel label, unconditionally**, which is the second half of
      // the same rule and needs no state to decide: it opens its menu on a
      // left click whenever it is on the page (`watchDeprelLabel`), so a press
      // on it must reach it whatever menu is up. Without this line the case
      // that is *most* likely — a category menu open, the reader turning to
      // the arc — was swallowed here, dismissing the menu and never opening
      // the relation one, which is precisely the fault this listener already
      // had to be taught about once for the pills.
      const target = event.target as HTMLElement;
      if (target.closest(DEPREL_LABEL)) return;
      const pressed = target.closest<HTMLElement>(TAB_PILLS);
      const pressedRow = pressed?.closest<HTMLElement>(".token-subtitle-row");
      if (pressedRow && semanticsShown(pressedRow)) return;
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
 * happens.
 *
 * `childId`'s *other* dependents — every one of them but the single one
 * `cycleChildOfDraggedToken` names, which this function's own cycle-break
 * already resolved — are handed to `cascadeDependents` once the tree is
 * settled, exactly as `applySimpleReparent` hands it every one of its own.
 * See that function's doc for the rule they are resolved by. */
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
  cascadeDependents(sentence, childId, newHeadId, cycleChildOfDraggedToken(cycle));
}

/** The whole of a re-parent that closes no cycle: one head moves, and the
 * parser renames the arc it now is.
 *
 * Takes the token by id rather than going through `applyTokenEdit`, which
 * edits whatever is currently *selected*. That is the same token here and
 * now — but its sibling `reparentBreakingCycle` reaches its edit after an
 * await, by which time the selection may be somewhere else entirely, and
 * the two should not differ in which token they claim to be moving.
 *
 * `childId`'s own dependents — every token that pointed at it before this
 * edit and still does after, since this edit never touches them itself —
 * are handed to `cascadeDependents`, which settles each of them onto `child`
 * or onto `newHeadId` by the parser's own arc likelihoods (see its doc for
 * the rule, and for what a session with no parser does instead). Called
 * after the structural edit has landed and been redrawn, exactly where
 * `relabelArcsUnder` is: the cascade's own decision needs a heads array with
 * `child`'s new head already in it, which only exists once this line above
 * it has run. */
function applySimpleReparent(sentence: Sentence, childId: number, newHeadId: number): void {
  const child = sentence.tokens.find((t) => t.id === childId);
  if (!child) return;
  withUndo(() => void (child.head = newHeadId));
  rerenderPreservingSelection();
  relabelArcsUnder(sentence, newHeadId, [childId]);
  cascadeDependents(sentence, childId, newHeadId);
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
 * itself.
 *
 * The dragged character's own dependents are not left dangling from
 * wherever it used to be. Each one is settled — kept under the dragged
 * character, or moved to follow it to the new head — by `cascadeDependents`,
 * called from `applySimpleReparent` and `reparentBreakingCycle` once the
 * drag's own edit has landed; see that function's doc for the rule and for
 * why a session with no live parser makes no move at all rather than
 * guessing one. */
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
    // **An open menu goes with the character it was opened from.** A retag
    // menu is a question about one token — its rows are that token's own
    // 品詞's domains, that domain's senses, that arc's relations — and picking
    // one edits whatever `selected` is by the time the click lands. Left
    // standing over a different character it is not merely stale, it is
    // wrong: it would offer the old token's options and apply them to the new
    // one.
    //
    // Closed before the move rather than after it, so the release of the
    // menu's hold on the pill row (`markMenuTab`) happens while the row it is
    // holding is still the row the menu came from.
    //
    // Escape above puts the menu away and stops; an arrow puts it away *and*
    // moves, which is the difference between dismissing a menu and going on
    // reading with it dismissed.
    closeContextMenu();
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
