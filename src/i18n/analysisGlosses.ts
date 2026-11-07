/** **English glosses for the analysis vocabulary** — the relation names, the
 * menu headings, and the treebank's own category names that the three 品詞
 * menus offer (品詞, semantic domain, sense).
 *
 * ── Why these are data and not i18n keys ─────────────────────────────────
 * Everything else the reader sees in English comes through `t()` and the two
 * JSON files, which must hold the same keys. These do not, and the
 * difference is deliberate. The labels they gloss are **not interface copy**:
 * 動詞, 目的語 and 行為 are the names of categories in the Kyoto treebank and
 * in SUD, and they are drawn in Japanese in *both* interfaces, because they are
 * the terms a kanbun reader learns and the terms a CoNLL-U file holds. So
 * there is nothing to translate into Japanese, and a `ja.json` entry per term
 * would be some 230 keys whose Japanese value is the key itself — parity kept
 * by copying, which is how parity rots. What an English reader needs is a
 * *gloss beside* the Japanese, keyed by the Japanese, and only in English.
 *
 * The vocabulary is also closed and generated: the 品詞 menus offer exactly
 * what `xpos-inventory.json` holds, and `tests/analysisGlosses.test.ts` walks
 * that inventory (and the relation menu, and every heading) to check that no
 * term reaches an English reader unglossed. A term added to the treebank's
 * inventory without a gloss here fails that test rather than shipping bare.
 *
 * ── How the glosses are worded ──────────────────────────────────────────
 * Short, lower-case, in the standard English of linguistics where there is
 * one (object, conjunct, oblique complement, determiner), and otherwise the
 * plainest English for the treebank's own category. They name a category;
 * they do not define it. The Japanese stays the primary label wherever both
 * are shown — the gloss is set after it, smaller, and in the interface face.
 *
 * ── Why the 品詞 tables are nested ───────────────────────────────────────
 * A domain or a sense is glossed *under its parent*, because the treebank
 * reuses names across parents with different meanings: 関係 is a relational
 * preposition under 前置詞, a kinship term under 名詞・人, and a relative
 * position (上, 下, 中) under 名詞・固定物; 伝達 is a verb of communication
 * under 動詞・行為 and a thing that carries a message under 名詞・可搬. A flat
 * table keyed by the name alone would have to pick one meaning for both. */

type DomainGloss = { readonly gloss: string; readonly senses?: Readonly<Record<string, string>> };
type WordGloss = { readonly gloss: string; readonly domains?: Readonly<Record<string, DomainGloss>> };

/** The treebank's 品詞, with their domains and senses — the tree the three
 * category menus walk, one level per menu. Domains and senses written `*` in
 * the treebank are not listed: a `*` domain draws no chip and heads no menu,
 * and a `*` sense is drawn as 「なし」, glossed by `EMPTY_FIELD_GLOSS`. */
const XPOS_GLOSS: Readonly<Record<string, WordGloss>> = {
  名詞: {
    gloss: "noun",
    domains: {
      人: {
        gloss: "person",
        senses: {
          役割: "role or title",
          名: "given name",
          人: "person",
          姓氏: "surname",
          関係: "kinship term",
          その他の人名: "other personal name",
          複合的人名: "compound personal name",
        },
      },
      主体: {
        gloss: "agent",
        senses: {
          国名: "state name",
          集団: "group",
          動物: "animal",
          書物: "book",
          神仏: "deity",
          機関: "office or institution",
        },
      },
      固定物: {
        gloss: "fixed thing",
        senses: {
          関係: "relative position",
          地名: "place name",
          建造物: "building",
          地形: "landform",
          樹木: "tree",
        },
      },
      時: { gloss: "time" },
      可搬: {
        gloss: "movable thing",
        senses: {
          道具: "tool",
          成果物: "artefact",
          伝達: "written message",
          糧食: "food",
          乗り物: "vehicle",
        },
      },
      制度: { gloss: "institution", senses: { 儀礼: "rite", 場: "institutional place" } },
      不可譲: { gloss: "inalienable", senses: { 身体: "body part", 属性: "attribute", 疾病: "illness" } },
      描写: { gloss: "description", senses: { 形質: "quality", 態度: "attitude" } },
      数量: { gloss: "quantity" },
      行為: { gloss: "action" },
      天象: { gloss: "heavens", senses: { 気象: "weather", 天文: "celestial body", 怪異: "portent" } },
      度量衡: { gloss: "unit of measure" },
      思考: { gloss: "thought", senses: { 思考: "thought" } },
      外観: { gloss: "appearance", senses: { 人: "person" } },
    },
  },
  動詞: {
    gloss: "verb",
    domains: {
      行為: {
        gloss: "action",
        senses: {
          動作: "action",
          伝達: "communication",
          交流: "interaction",
          移動: "motion",
          態度: "attitude",
          得失: "gain and loss",
          設置: "placement",
          生産: "production",
          使役: "causation",
          分類: "classification",
          儀礼: "rite",
          役割: "role",
          姿勢: "posture",
          飲食: "eating and drinking",
        },
      },
      存在: { gloss: "existence", senses: { 存在: "existence" } },
      描写: {
        gloss: "description",
        senses: { 形質: "quality", 量: "quantity", 態度: "attitude", 境遇: "circumstance" },
      },
      変化: { gloss: "change", senses: { 生物: "life", 性質: "property", 制度: "institution" } },
    },
  },
  数詞: {
    gloss: "numeral",
    domains: {
      数字: { gloss: "digit" },
      数: { gloss: "number" },
      干支: { gloss: "cyclical sign" },
    },
  },
  記号: {
    gloss: "symbol",
    domains: {
      句点: { gloss: "full stop" },
      読点: { gloss: "comma" },
      括弧開: { gloss: "opening bracket" },
      括弧閉: { gloss: "closing bracket" },
      一般: { gloss: "general" },
    },
  },
  副詞: {
    gloss: "adverb",
    domains: {
      否定: {
        gloss: "negation",
        senses: { 無界: "unbounded", 体言否定: "nominal negation", 禁止: "prohibition", 有界: "bounded" },
      },
      時相: {
        gloss: "tense and aspect",
        senses: {
          緊接: "immediate",
          完了: "perfect",
          将来: "future",
          終局: "final",
          過去: "past",
          恒常: "constant",
          現在: "present",
          変化: "change",
          継起: "succession",
        },
      },
      判断: { gloss: "judgement", senses: { 確定: "certainty", 推定: "conjecture", 逆接: "concession" } },
      頻度: { gloss: "frequency", senses: { 重複: "repetition", 頻繁: "frequent", 偶発: "occasional" } },
      範囲: { gloss: "scope", senses: { 総括: "inclusive", 共同: "joint", 限定: "restrictive" } },
      疑問: { gloss: "interrogative", senses: { 原因: "cause", 所在: "place", 反語: "rhetorical question" } },
      程度: { gloss: "degree", senses: { 極度: "extreme", 軽度: "slight", やや高度: "fairly high" } },
      描写: { gloss: "description" },
    },
  },
  助動詞: {
    gloss: "auxiliary",
    domains: {
      可能: { gloss: "possibility" },
      願望: { gloss: "desire" },
      必要: { gloss: "necessity" },
      受動: { gloss: "passive" },
    },
  },
  助詞: {
    gloss: "particle",
    domains: {
      句末: { gloss: "sentence-final" },
      接続: { gloss: "connective", senses: { 属格: "genitive", 並列: "coordinating", 体言化: "nominalizing" } },
      提示: { gloss: "presentative" },
      句頭: { gloss: "sentence-initial" },
    },
  },
  前置詞: {
    gloss: "preposition",
    domains: {
      基盤: { gloss: "basis" },
      関係: { gloss: "relation" },
      源泉: { gloss: "source" },
      経由: { gloss: "route" },
    },
  },
  代名詞: {
    gloss: "pronoun",
    domains: {
      // 止格 and 起格 are the treebank's names for the two case forms of a
      // first-person pronoun (我 against 吾). Glossed literally rather than as
      // "object form" and "subject form", which would claim more about the
      // distinction than the scheme does.
      人称: { gloss: "personal", senses: { 止格: "terminal case", 起格: "initial case", 他: "other" } },
      指示: { gloss: "demonstrative" },
      疑問: { gloss: "interrogative" },
    },
  },
  接尾辞: { gloss: "suffix" },
  感嘆詞: { gloss: "interjection" },
  // The tagger can write this 品詞 though no attested tag has it (see the
  // note above `UNEDITABLE_UPOS` in tokenInspector.ts), so a chip can show it.
  文字: { gloss: "written character" },
};

/** The UPOS names the first chip falls back to on a token with no treebank
 * tag (`uposJa` in tokenInspector.ts), keyed by that Japanese name. Where a
 * name is also a 品詞 of the treebank (名詞, 動詞, …) `XPOS_GLOSS` answers
 * first and gives the same word. */
const UPOS_NAME_GLOSS: Readonly<Record<string, string>> = {
  名詞: "noun",
  固有名詞: "proper noun",
  代名詞: "pronoun",
  動詞: "verb",
  助動詞: "auxiliary",
  形容詞: "adjective",
  副詞: "adverb",
  接置詞: "adposition",
  等位接続詞: "coordinating conjunction",
  従属接続詞: "subordinating conjunction",
  助詞: "particle",
  句読点: "punctuation",
  限定詞: "determiner",
  数詞: "numeral",
  感動詞: "interjection",
  記号: "symbol",
  その他: "other",
};

/** The gloss for 「なし」, the sense menu's "no sense" row (`fieldLabel`). */
export const EMPTY_FIELD_GLOSS = "none";

/** SUD base relations, keyed as `DEPREL_JA` in tokenInspector.ts is. */
export const RELATION_GLOSS: Readonly<Record<string, string>> = {
  ROOT: "root",
  subj: "subject",
  comp: "complement",
  "comp:obj": "object",
  "comp:obl": "oblique complement",
  "comp:pred": "predicative complement",
  "comp:aux": "complement of an auxiliary",
  mod: "modifier",
  compound: "compound element",
  flat: "flat-structure element",
  clf: "classifier",
  cc: "coordinator",
  "conj:coord": "conjunct",
  punct: "punctuation",
  det: "determiner",
  discourse: "discourse marker",
  vocative: "vocative",
  dislocated: "dislocated element",
  parataxis: "paratactic clause",
  list: "list item",
  orphan: "remnant",
  dep: "unspecified dependent",
  udep: "unspecified dependent",
  unk: "unknown dependent",
};

/** SUD subtypes — what the part after `@` narrows a relation to, keyed as
 * `DEPREL_SUBTYPE_JA` is. */
export const SUBTYPE_GLOSS: Readonly<Record<string, string>> = {
  tmod: "time",
  lmod: "place",
  emb: "embedded",
  redup: "reduplication",
  vv: "serial verb",
  foreign: "loanword",
  sp: "sentence-final",
  expl: "expletive",
};

/** The headings this app writes by hand: the relation menu's seven, the
 * 品詞 menu's own, and the readings menu's five. The other headings — a
 * domain menu headed by its 品詞, a sense menu by its domain — are category
 * names and are glossed from `XPOS_GLOSS` by the caller, which knows the
 * parent a domain name belongs to. */
export const HEADING_GLOSS: Readonly<Record<string, string>> = {
  述語: "predicate",
  基本成分: "core arguments",
  修飾成分: "modifiers",
  "接続・並列": "coordination",
  "談話・その他": "discourse and other",
  複合語: "compounds",
  未分類: "unclassified",
  品詞: "part of speech",
  再読: "double reading",
  音読み: "on’yomi",
  訓読み: "kun’yomi",
  既定: "default",
  主題: "topic",
};

/** The two rows of the readings menu that are actions, not readings: 自動,
 * which takes back the reading the reader chose and returns the one the
 * analysis gives, and the toggle that writes or removes a topic は. They are
 * written in Japanese in both interfaces, like the category names, and an
 * English reader got the Japanese note under them and no gloss, the one
 * pair of rows in any menu with nothing in English. "automatic" says what
 * 自動 says; the note under it says what picking it does. */
export const READING_ACTION_GLOSS: Readonly<Record<string, string>> = {
  自動: "automatic",
  は: "topic particle",
};

/** A relation, `base@subtype` included: "modifier: time" for `mod@tmod`.
 * Undefined for a base this table does not know (an uploaded tree can carry
 * anything), so that the caller shows the Japanese alone rather than half a
 * gloss. A subtype without a gloss falls back to the SUD subtype itself,
 * which is English already. */
export function deprelGloss(dep: string): string | undefined {
  const at = dep.indexOf("@");
  const base = RELATION_GLOSS[at < 0 ? dep : dep.slice(0, at)];
  if (base === undefined) return undefined;
  if (at < 0) return base;
  const subtype = dep.slice(at + 1);
  return `${base}: ${SUBTYPE_GLOSS[subtype] ?? subtype}`;
}

/** A 品詞 (the first chip, the 品詞 menu's rows, a domain menu's heading),
 * or the UPOS name the first chip shows for a token with no treebank tag. */
export function wordGloss(word: string): string | undefined {
  return XPOS_GLOSS[word]?.gloss ?? UPOS_NAME_GLOSS[word];
}

/** A semantic domain under its 品詞. */
export function domainGloss(word: string, domain: string): string | undefined {
  if (domain === "*") return EMPTY_FIELD_GLOSS;
  return XPOS_GLOSS[word]?.domains?.[domain]?.gloss;
}

/** A sense under its 品詞 and domain; `*` (drawn 「なし」) is "none". */
export function senseGloss(word: string, domain: string, sense: string): string | undefined {
  if (sense === "*") return EMPTY_FIELD_GLOSS;
  return XPOS_GLOSS[word]?.domains?.[domain]?.senses?.[sense];
}

/** One of the hand-written headings in `HEADING_GLOSS`. */
export function headingGloss(heading: string): string | undefined {
  return HEADING_GLOSS[heading];
}
