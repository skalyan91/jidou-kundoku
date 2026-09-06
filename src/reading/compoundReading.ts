import type { KanjidicIndex, ReadingCandidate } from "./kanjidicLookup.ts";
import { historicalSpelling, type HistoricalKanaIndex } from "./historicalKana.ts";

/** KANJIDIC2 stores on'yomi in katakana — converted to hiragana here so
 * candidates compare directly against a JMdict compound reading (always
 * hiragana), same fix as `kanjidicLookup.ts`'s `lookupKanji` (duplicated
 * rather than imported for the same reason: no cross-file coupling needed
 * for two lines). */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

/** Sequential voicing (連濁): a compound's non-initial elements frequently
 * voice their own initial consonant (火 ひ -> 花火 はな*び*), so a candidate
 * reading needs trying both as-is and voiced when it isn't the compound's
 * first character. Unvoiced -> voiced, first kana only (rendaku only ever
 * affects a word's own initial mora). */
const RENDAKU: Record<string, string> = {
  か: "が", き: "ぎ", く: "ぐ", け: "げ", こ: "ご",
  さ: "ざ", し: "じ", す: "ず", せ: "ぜ", そ: "ぞ",
  た: "だ", ち: "ぢ", つ: "づ", て: "で", と: "ど",
  は: "ば", ひ: "び", ふ: "ぶ", へ: "べ", ほ: "ぼ",
};

/** Also read by `kanjidicLookup.ts`'s `pairedRenyouNominalKun`, which has the
 * same question to ask about a bound kun'yomi's own initial mora (伝's
 * `-づた.い` beside つた.う) and must not answer it from a second copy of this
 * table. One-way at runtime: this module's only import from that one is
 * `import type`, which is erased. */
export function rendakuVariant(reading: string): string | null {
  const first = reading[0];
  const voiced = RENDAKU[first];
  return voiced ? voiced + reading.slice(1) : null;
}

/** Handakuon (半濁音): a compound member's own は行 initial read as ぱ行 —
 * 方 ほう read ぽう in 遠方 えんぽう, 蔽 へい read ぺい in 隱蔽 いんぺい, 片 へん
 * read ぺん in 一片 いっぺん.
 *
 * Not 連濁 and not a second copy of it. 連濁 voices (は -> ば) and is licensed
 * by the member's position alone; this is 連声, an assimilation licensed by
 * what stands immediately *before* the member — a moraic ん or っ, and nothing
 * else (see `SANDHI_ONSET_TRIGGERS`). The two are kept apart because the
 * environments are: 竹林 たけばやし voices with no ん in sight, and 遠方 えんぽう
 * has no voicing at all. */
const HANDAKU: Record<string, string> = {
  は: "ぱ", ひ: "ぴ", ふ: "ぷ", へ: "ぺ", ほ: "ぽ",
};

/** 連声 proper (the な行 half): a member whose own reading begins with a bare
 * vowel takes an n- onset after a moraic ん — 皇 おう read のう in 天皇 てんのう,
 * 音 おん read のん in 觀音 かんのん, 緣 えん read ねん in 因緣 いんねん, 應 おう
 * read のう in 感應 かんのう. Same environment as the handakuon above and the
 * same single trigger, so the two are written as two tables and applied
 * together rather than as one rule with a branch inside it. */
const RENJOU_NASAL: Record<string, string> = {
  あ: "な", い: "に", う: "ぬ", え: "ね", お: "の",
};

/** The two kana that condition both of the tables above: a moraic nasal ん and
 * a sokuon っ. Both are codas with no vowel of their own, and the assimilation
 * is the following member's onset closing against one — which is why a member
 * after an ordinary open mora shows neither (大方 is おおかた and never
 * *おおぽう, measured: that reading comes back undivided).
 *
 * Measured over the shipped JMdict and KANJIDIC2 indices — 128,309 headwords
 * written wholly in kanji whose reading is wholly kana and whose every
 * character KANJIDIC2 knows — this gate costs 6 of the 1,533 words the ぱ行
 * table would otherwise recover (茶髪 ちゃぱつ, 数発 すうぱつ, 濾波器 ろぱき,
 * 最繁正時 さいぱんせいじ and the two 羅葡日 titles) and 3 of the 189 the な行
 * table would (木末 こぬれ, 聖観世音 しょうかんぜのん twice). All nine are modern
 * or foreign coinages; none is kanbun, and each is a word this project would
 * reach through its own JMdict entry rather than through a share. */
const SANDHI_ONSET_TRIGGERS = new Set(["ん", "っ"]);

/** The 連声 forms of `reading` as a member standing after `precededBy` — the
 * last kana of the member before it — or the empty list where the environment
 * does not license one. Both tables are consulted, since one reading can only
 * ever match one of them (a reading begins either with は行 or with a vowel,
 * never both).
 *
 * A predicate over the *environment*, deliberately, rather than over the
 * member's provenance. Restricting these forms to a character's on'yomi is the
 * obvious guess and it is wrong: measured the same way, it loses 59 attested
 * words, among them 勝手 かって (手 て is the kun'yomi), 一匹 いっぴき, 半端
 * はんぱ and 天日 てんぴ. Sino-Japanese is where the environment mostly arises,
 * not a condition on the rule. */
export function renjouVariants(reading: string, precededBy: string): string[] {
  if (!SANDHI_ONSET_TRIGGERS.has(precededBy)) return [];
  const first = reading[0];
  const out: string[] = [];
  if (HANDAKU[first]) out.push(HANDAKU[first] + reading.slice(1));
  // The な行 assimilation is the nasal's own, so っ does not license it: 雪隱
  // せっちん turns 隱 いん into ちん, a た行 onset off the sokuon, which is a
  // third table this project has no attested need of yet.
  if (precededBy === "ん" && RENJOU_NASAL[first]) out.push(RENJOU_NASAL[first] + reading.slice(1));
  return out;
}

/** The onsets a sokuon assimilates against: the voiceless obstruents k, s, t,
 * p — か/さ/た/は/ぱ行 in kana, は行 because a は行 onset after a sokuon is
 * itself read ぱ行 (一片 いっ + ぺん, whose ぺん `renjouVariants` above
 * supplies). A voiced onset never triggers it: 拔群 is ばつぐん and never
 * *ばっぐん, which is why the が/ざ/だ/ば rows are absent.
 *
 * Asked in two places that must not disagree about it — `sandhiVariants`
 * below, where the caller already knows what follows (the menu does, from the
 * word's own shares), and `splitCompoundReading`, which re-asks it once a
 * candidate has matched and the following kana is finally known (see its own
 * note). One predicate, so the two answers cannot drift. */
export function sokuonAssimilates(nextOnset: string): boolean {
  return /^[かきくけこさしすせそたちつてとはひふへほぱぴぷぺぽ]$/.test(nextOnset);
}

/** The 促音便 form of `reading` as a member that something follows: its own
 * final き/く/ち/つ — the codas Middle Chinese -k and -t left behind — read as
 * a sokuon. 一 いつ read いっ in 一切 いっさい, 惡 あく read あっ in 惡化 あっか,
 * 恰 かつ read かっ in 恰幅 かっぷく.
 *
 * Unlike 連濁 and 連声 this is a *coda* change, so it is the one variant an
 * initial member takes too — 惡化 geminates on the first of its two
 * characters — and the one gated by what comes after rather than before. A
 * one-mora reading is left alone: a share that is nothing but っ names no
 * syllable and would let the splitter charge a character with a mora that
 * belongs to its neighbour. */
export function sokuonVariant(reading: string): string | null {
  return reading.length > 1 && /[きくちつ]$/.test(reading) ? reading.slice(0, -1) + "っ" : null;
}

/** **Every form `reading` takes as a compound member standing where it does**
 * — the 連声 onsets against the member before it, the 促音便 coda against the
 * member after it, and the two together — with the base reading itself left
 * out, since a caller already has that.
 *
 * The one enumeration of the sound changes, and it has three callers that
 * must not disagree about them: `compoundMemberCandidates` just below, which
 * offers them to the splitter and to the furigana menu; `splitCompoundReading`
 * through that; and the on'yomi *recognisers* in `readingResolver.ts`
 * (`onyomiCompound`'s gate and `isOnyomiSpan`), which have to accept ぽん as
 * 奔's own ホン where a split has put a sokuon in front of it. That third
 * caller is what makes this exported rather than inlined: those gates ask
 * "is this share this character's on'yomi?", and once the splitter can hand
 * them a share the environment has altered, a gate reading the raw KANJIDIC2
 * list answers no to a reading it has itself just produced. 衞獻公出奔 lost
 * its す exactly that way while this was two enumerations.
 *
 * `precededBy` and `followedBy` are the touching kana of the neighbouring
 * members, absent where the caller does not know them (or where there is no
 * such neighbour); `nonFinal` says a member follows even when its first kana
 * is not yet known, which is the splitter's position — see its own note. */
export function sandhiVariants(
  reading: string,
  position: { precededBy?: string; followedBy?: string; nonFinal?: boolean },
): string[] {
  const { precededBy, followedBy, nonFinal = false } = position;
  const onsets = precededBy === undefined ? [] : renjouVariants(reading, precededBy);
  // A member can be assimilated at both ends at once — the two changes are
  // different slots — so the coda is taken over the 連声 forms as well as over
  // the reading itself. Where the caller cannot yet say what follows, the
  // geminate is offered and the gate is asked later; where it can, it is asked
  // here. Either way it is `sokuonAssimilates` that answers.
  const geminable = (nonFinal || followedBy !== undefined) && (followedBy === undefined || sokuonAssimilates(followedBy));
  const codas = geminable
    ? [reading, ...onsets].map(sokuonVariant).filter((v): v is string => v !== null)
    : [];
  return [...onsets, ...codas];
}

/** The readings one character of a compound can contribute to the whole
 * compound's reading: its on'yomi and the *stems* of its kun'yomi — a member
 * of a jukugo never carries its own okurigana (立場 is たちば, off た.つ) —
 * plus, for a member that is not the compound's first character, each of
 * those voiced (see `RENDAKU`), plus the sound changes a member undergoes
 * against its neighbours (`renjouVariants`, `sokuonVariant`).
 *
 * This is the one enumeration of what a member may be read as, and it
 * answers to two callers that must not disagree: `splitCompoundReading`
 * below, which divides a whole compound's reading by finding an assignment
 * out of this set, and the furigana menu (`readingCandidatesFor` in
 * tokenInspector.ts), which offers a member's alternatives to the reader.
 * A menu entry outside the splitter's set would be a reading that could be
 * chosen and then could not be divided back across the characters — a
 * choice that stored correctly and did not appear. Sharing the set is what
 * makes that impossible rather than merely unlikely.
 *
 * **The four position options are how much of the neighbourhood the caller
 * knows, and each licenses exactly what it can.** `nonInitial`/`nonFinal`
 * are the bare positional facts: the first licenses 連濁, which asks nothing
 * of the environment beyond standing second. `precededBy` and `followedBy`
 * are the neighbouring members' touching kana, and they are what the 連声
 * and 促音 variants need, since those are conditioned by the actual sounds
 * on either side. A caller who supplies only the booleans gets the smaller
 * set, which is the safe direction: the menu (which knows every share, so
 * it passes all four) stays a subset of what the splitter will divide, and
 * never the reverse.
 *
 * `historicalKana` spells each candidate in 歴史的仮名遣い — the same
 * per-character substitution `compoundFurigana` applies to the shares it
 * puts on the page (`historical` there), and for the same reason: the
 * annotation is historical throughout, so a menu written in modern kana
 * would offer readings in an orthography the page does not use and would
 * not recognise the reading already displayed as one of its own entries.
 * Omit it and the candidates come back in KANJIDIC's own modern kana, which
 * is what a JMdict compound reading has to be matched against. */
export function compoundMemberCandidates(
  kanjidic: KanjidicIndex,
  char: string,
  options: {
    nonInitial?: boolean;
    nonFinal?: boolean;
    precededBy?: string;
    followedBy?: string;
    historicalKana?: HistoricalKanaIndex | null;
  } = {},
): ReadingCandidate[] {
  const entry = kanjidic[char];
  if (!entry) return [];
  const { nonInitial = false, nonFinal = false, precededBy, followedBy, historicalKana = null } = options;
  const spell = (reading: string) =>
    historicalKana ? historicalSpelling(historicalKana, char, reading) : reading;
  const gloss = entry.meanings[0];
  const base: ReadingCandidate[] = [
    ...entry.on.map((o) => ({ reading: spell(toHiragana(o)), gloss, kind: "on" as const })),
    ...entry.kun.map((k) => ({
      reading: spell(
        k
          .split(".")[0] // drop the okurigana-dot suffix — a compound reading never carries a member's own okurigana
          .replace(/^-|-$/g, ""), // KANJIDIC2's leading/trailing hyphen marks "used as a suffix"/"used as a prefix" respectively — a position note, not part of the reading itself; "-び" for 火 is already the rendaku-voiced suffix form
      ),
      gloss,
      kind: "kun" as const,
    })),
  ].filter((c) => c.reading.length > 0);

  // Voiced *after* the historical spelling, not before: rendaku voices a
  // reading's own first kana, and both spellings have the same first kana
  // unless the substitution changed it, which it never does (ひゃく ->
  // ひやく -> びやく, the share 三百 shows on the page). The 連声 forms go on
  // beside it and not on top of it: both rewrite the member's onset, so a
  // reading is either voiced or assimilated and never both (方 offers ほう,
  // ぼう and ぽう, never *ぽう off ぼう).
  const all = base.flatMap((c) => {
    // 連濁 is licensed by the position alone, the sound changes by the
    // neighbouring kana, so the two are asked separately and the voiced form
    // is then put through the same sandhi as the plain one (a voiced member
    // ending in く geminates like any other).
    const voiced = nonInitial ? rendakuVariant(c.reading) : null;
    const forms = [
      ...(voiced ? [voiced] : []),
      ...[c.reading, ...(voiced ? [voiced] : [])].flatMap((r) =>
        sandhiVariants(r, { precededBy: nonInitial ? precededBy : undefined, followedBy, nonFinal }),
      ),
    ];
    return [c, ...forms.map((reading) => ({ ...c, reading }))];
  });

  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.reading) ? false : (seen.add(c.reading), true)));
}

/** Every spelling of every reading `chars[index]` may contribute, for the
 * splitter: both orthographies at once, since one reading arrives modern
 * (JMdict's own reading for the whole word) and another arrives historical
 * (a reading the reader picked off the menu, which is spelled the way the
 * page spells it). Splitting has to accept either. */
function splitCandidates(
  kanjidic: KanjidicIndex,
  char: string,
  position: { nonInitial: boolean; nonFinal: boolean; precededBy?: string },
  historicalKana: HistoricalKanaIndex | null,
): string[] {
  const modern = compoundMemberCandidates(kanjidic, char, position);
  const historical = historicalKana
    ? compoundMemberCandidates(kanjidic, char, { ...position, historicalKana })
    : [];
  return [...new Set([...modern, ...historical].map((c) => c.reading))];
}

/** Splits a compound's combined dictionary reading (e.g. くんし for 君子)
 * into one substring per character (くん, し), by backtracking through each
 * character's own KANJIDIC on'yomi/kun'yomi candidates and finding an
 * assignment that exactly consumes the whole reading. Longest-candidate-
 * first at each step (a greedy shortest match can wrongly claim a prefix
 * that belongs to the next character — e.g. picking 1-mora こ for 子 over
 * the correct 2-mora candidate when both are valid readings of that
 * character in isolation) with backtracking if a later character then has
 * no match left. Each non-initial character's candidates are also tried
 * rendaku-voiced (see `RENDAKU`). Returns null if no assignment fully
 * consumes the reading — callers should fall back to each character's own
 * independently-resolved reading in that case, not force a wrong split.
 *
 * **The sound changes are matched, not derived, and that is the whole of
 * why they are safe here.** A member of a genuinely fused span shows 連濁,
 * 連声 and 促音便 against its neighbours, and this function is handed a
 * whole word's *attested* reading — JMdict already says 遠方 is えんぽう —
 * so admitting ぽう as a reading 方 may contribute only lets an assignment
 * be found for a string the dictionary vouches for. Nothing is invented:
 * a compound with no dictionary reading still gets none, and this does not
 * reopen the retired rule that *derived* voicing across a modifier boundary
 * (see the commit "Retire 連濁, and mend three rules it sat beside" — 竹の林
 * はやし stays はやし, because there no attested word reading is being
 * divided at all).
 *
 * Measured over the shipped indices, on the 128,309 all-kanji JMdict
 * headwords whose reading is wholly kana and whose every character is in
 * KANJIDIC2: 107,401 divided before, 116,438 after, and **not one of the
 * 107,401 divides differently** — the widened set only ever finds an
 * assignment where there was none. The three changes recover 1,527
 * (handakuon: 遠方 えん|ぽう, 隱蔽 いん|ぺい, 鉛筆 えん|ぴつ), 186 (連声 な行:
 * 天皇 てん|のう, 觀音 かん|のん, 因緣 いん|ねん) and 6,112 (促音便: 惡化 あっ|か,
 * 壓卷 あっ|かん, 恰幅 かっ|ぷく) respectively, 9,037 together — 一片 いっ|ぺん
 * is one of the 1,212 that needs two of them at once (一敗 いっ|ぱい,
 * 圧迫 あっ|ぱく, 一杯 いっ|ぱい are the same shape).
 *
 * `historicalKana` lets a reading already in 歴史的仮名遣い be divided too,
 * by admitting each character's historical spellings alongside its modern
 * ones (see `splitCandidates`). A hand-picked compound reading is stored as
 * it is written on the page, which is historical — さんびやく for 三百,
 * がうふ for 豪富 — and neither of those divides at all against KANJIDIC's
 * modern kana alone (measured: both come back null). Omit it and the split
 * is exactly what it was, which is what JMdict's own modern readings want. */
export function splitCompoundReading(
  chars: string[],
  reading: string,
  kanjidic: KanjidicIndex,
  historicalKana: HistoricalKanaIndex | null = null,
): string[] | null {
  function backtrack(charIndex: number, pos: number): string[] | null {
    if (charIndex === chars.length) return pos === reading.length ? [] : null;
    const nonFinal = charIndex < chars.length - 1;
    const candidates = splitCandidates(
      kanjidic,
      chars[charIndex],
      // The kana this member stands after is the one already consumed, which
      // is the *chosen* share's last and not the previous character's first
      // reading — 一片's ぺん is licensed by the っ that 一 was actually
      // divided as, not by the いつ it might have been.
      { nonInitial: charIndex > 0, nonFinal, precededBy: pos > 0 ? reading[pos - 1] : undefined },
      historicalKana,
    );
    const sorted = [...candidates].sort((a, b) => b.length - a.length);
    for (const cand of sorted) {
      if (cand.length === 0 || !reading.startsWith(cand, pos)) continue;
      // The 促音 gate, asked here because only now is the following kana
      // known: a candidate's length is what decides where the next member
      // starts, so `compoundMemberCandidates` cannot ask it for the splitter
      // the way it can for the menu. Same predicate, one place, both callers
      // — see `sokuonAssimilates`. Only a derived share ever ends in っ; no
      // KANJIDIC reading does.
      if (cand.endsWith("っ") && !sokuonAssimilates(reading[pos + cand.length] ?? "")) continue;
      const rest = backtrack(charIndex + 1, pos + cand.length);
      if (rest) return [cand, ...rest];
    }
    return null;
  }
  return backtrack(0, 0);
}
