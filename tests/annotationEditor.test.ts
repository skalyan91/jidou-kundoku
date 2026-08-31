import { describe, expect, it } from "vitest";
import { kakikudashiFromAnnotation, parseAnnotationText } from "../src/kanbun/annotationEditor.ts";
import { generateAnnotationText, toDisplayKuntenMarks, toPlainKuntenMarks } from "../src/kanbun/texAnnotation.ts";

/** `inferKanaOnly`'s job, exercised through the round trip rather than
 * directly: annotation text in, `AnnotationToken`s and kakikudashibun out,
 * and the annotation text back again.
 *
 * Every line below is verbatim what `generateAnnotationText` produced from
 * the app's own rendered 訓読文 panel for the source sentence named in the
 * test — kaeriten included, which this format writes as the plain characters
 * (レ/一/二/三) `executeKunten` reads and a person can type, not the
 * Kanbun-block display glyphs (㆑/㆒/㆓/㆔) the panel is drawn in. Both
 * alphabets are accepted on the way *in* (see "either alphabet of kaeriten
 * reads the same" below); plain is what comes back out.
 *
 * The okurigana stays katakana in the annotation text — that is the slot's
 * own convention in this format, and `UNIT_RE` identifies the slot by it —
 * and becomes hiragana in the kakikudashibun, which is running Japanese. The
 * expectations below are stated accordingly. */
function tokens(line: string): { text: string; kanaOnly: boolean }[] {
  return parseAnnotationText(line)[0]
    .filter((t) => !t.isPunct)
    .map((t) => ({ text: t.text, kanaOnly: t.kanaOnly }));
}

function kanaOnlyOf(line: string, char: string): boolean {
  const found = tokens(line).find((t) => t.text === char);
  if (!found) throw new Error(`no ${char} in ${line}`);
  return found.kanaOnly;
}

const prose = (line: string) => kakikudashiFromAnnotation(parseAnnotationText(line));

describe("inferKanaOnly tells a grammar word from the ordinary character it shares", () => {
  // The live fault this gate was written for. 耳 is both the 限定 particle
  // read のみ and the noun みみ, and the whole lemma used to be claimed
  // kana-only, so 割其耳 came back through the round trip as 其のみみを割る.
  it("耳(のみ) is the particle — kana only, no kanji in the prose (曰：「易耳。」)", () => {
    const line = "曰(い)ハク、「易(やさ)シキ耳(のみ)ト。";
    expect(kanaOnlyOf(line, "耳")).toBe(true);
    expect(prose(line)).toBe("曰はく易しきのみと。");
  });

  it("耳(みみ)ヲ is the noun — keeps its kanji (割其耳。)", () => {
    const line = "割(わ)ル[二]其(そ)ノ耳(みみ)ヲ[一]。";
    expect(kanaOnlyOf(line, "耳")).toBe(false);
    expect(prose(line)).toContain("耳を");
    expect(prose(line)).not.toContain("みみ");
  });

  // 否 has the same shape as 耳 and lands on the opposite side of it: its
  // particle reading や is written *beside* the character, so it is the
  // okurigana rule that admits the particle, and the furigana that gives the
  // verb away.
  it("否(いな)ム is the verb いなむ — keeps its kanji (然歟否歟？)", () => {
    const line = "然(しか)リテ歟否(いな)ム歟。";
    expect(kanaOnlyOf(line, "否")).toBe(false);
    expect(prose(line)).toContain("否む");
  });

  it("否ヤ is the sentence-final particle — kana only (君飲嘗不醉否？)", () => {
    const line = "君(きみ)飲(の)ム嘗(かつ)テ不ズ[レ]醉(よ)ハ否ヤ。";
    expect(kanaOnlyOf(line, "否")).toBe(true);
    expect(prose(line)).toBe("君飲む嘗て醉はずや。");
  });

  // Every one of the 使役 and modal auxiliaries is also an ordinary verb.
  // 教 is the worst of them — をしふ is far commoner than the causative しむ —
  // and it was losing its kanji for exactly the reason 耳 was.
  it("教(をし)エル is the verb をしふ — keeps its kanji (子教之。)", () => {
    const line = "子(し)教(をし)エル[レ]之(これ)ヲ。";
    expect(kanaOnlyOf(line, "教")).toBe(false);
    expect(prose(line)).toContain("教える");
  });

  it("使シム is the causative auxiliary — kana only (天帝使我長百獸。)", () => {
    const line = "天(てん)帝(てい)ハ使シム[三]我(われ)ヲシテ長(なが)カラ[二]百(ひやく)獸(じう)ヲ[一]。";
    expect(kanaOnlyOf(line, "使")).toBe(true);
    expect(prose(line)).not.toContain("使");
  });

  it("使(し) with a dictionary reading and no okurigana keeps its kanji (酒蟲)", () => {
    // `findOverride(text, "PRON")` answers looser than the pronoun rule asks
    // — 使's own つかふ entry names no POS and so matches any — which used to
    // hand this straight back to kana-only after the furigana rule had
    // declined it.
    expect(kanaOnlyOf("劉使(し)試(こころ)ム。", "使")).toBe(false);
  });

  it("而(なんぢ) keeps the pronoun rule, which names PRON outright", () => {
    expect(kanaOnlyOf("而(なんぢ)。", "而")).toBe(true);
  });
});

describe("the groups that were already right stay right", () => {
  it("negation 不ズ is kana only, and 亦 keeps its kanji beside it (不亦說乎？)", () => {
    const line = "不ズ[二]亦マタ說(よろこ)バシカラ[一]乎ヤ。";
    expect(tokens(line)).toEqual([
      { text: "不", kanaOnly: true },
      { text: "亦", kanaOnly: false },
      { text: "說", kanaOnly: false },
      { text: "乎", kanaOnly: true },
    ]);
    expect(prose(line)).toBe("亦また說ばしからずや。");
  });

  it("modal auxiliary 可ベカラ is kana only (學不可以已。)", () => {
    const line = "學(まな)ブハ不ズ[レ]可ベカラ[三]以(もつ)テ[一]已(や)ム[二]。";
    expect(kanaOnlyOf(line, "可")).toBe(true);
    expect(kanaOnlyOf(line, "不")).toBe(true);
  });

  it("而シテ is kana only (人不知而不慍)", () => {
    const line = "人(ひと)不ズ[レ]知(し)ラ而シテ不ズ[レ]慍(うら)ミ、";
    expect(kanaOnlyOf(line, "而")).toBe(true);
    expect(prose(line)).toBe("人知らずして慍みず。");
  });

  it("而(しか)モ is kana only — the one reading 而 puts over the character", () => {
    const line = "而(しか)モ家(いへ)豪(がう)富(ふ)ニシテ、";
    expect(kanaOnlyOf(line, "而")).toBe(true);
    expect(prose(line)).toBe("しかも家豪富にして。");
  });

  it("於ヨリ is kana only (青出於藍。)", () => {
    const line = "青(あを)出(で)ル[レ]於ヨリ[レ]藍(らん)。";
    expect(kanaOnlyOf(line, "於")).toBe(true);
    expect(prose(line)).toBe("青藍より出る。");
  });

  /** The other 於, which the 訓読文 panel now writes with a reading over the
   * character — 於(お)イテ. The two slots are what tell the senses apart here,
   * exactly as they do on screen: より stands *in place of* the kanji and
   * fills the okurigana slot alone (rule 3), while おいて is a verb form the
   * prose writes the kanji for, so a reading sits over it and rules 3 and 4
   * both decline. Nothing in `GRAMMAR_WORD_FURIGANA` claims 於, which is what
   * keeps rule 2 out of it. */
  it("於(お)イテ keeps its kanji, where 於ヨリ does not (令於日中俯臥。)", () => {
    const line = "但タダシ令[二]シム於(お)イテ[レ]日(ひ)ノ中(なか)ニ俯(ふ)[一]臥(ぐわ)。";
    expect(kanaOnlyOf(line, "於")).toBe(false);
    expect(prose(line)).toContain("於いて");
  });

  it("再読 未(いまだ) is kana only, but 未(ひつじ) is the earthly branch (未學禮。)", () => {
    expect(kanaOnlyOf("未(いまだ)學(まな)バ[レ]禮(れい)ヲ。", "未")).toBe(true);
    expect(kanaOnlyOf("未(ひつじ)。", "未")).toBe(false);
  });
});

describe("a grammar word written with no reading at all", () => {
  // The blank-gloss shape: a particle whose reading the render suppressed
  // (`repeatsPredicateCopula` for 也, `precedingFormSuppliesShite` for 而) or
  // never had (矣). It contributes nothing to the prose, which is what
  // kana-only with no kana means.
  it("也 with its copula suppressed drops out of the prose (君子仁也。)", () => {
    const line = "君(くん)子(し)仁(じん)ナリ也。";
    expect(kanaOnlyOf(line, "也")).toBe(true);
    expect(prose(line)).toBe("君子仁なり。");
  });

  it("也(なり) written out is likewise kana only", () => {
    expect(kanaOnlyOf("君(くん)子(し)仁(じん)也(なり)。", "也")).toBe(true);
  });

  it("矣 is unread and drops out", () => {
    expect(prose("易(やさ)シ矣。")).toBe("易し。");
  });

  it("the blank shape is read as the grammar word, which is what 也 needs", () => {
    // A bare 耳 goes the particle's way rather than the noun's, and
    // deliberately: no render ever writes the noun without みみ over it, while
    // 也 and 耳 both reach this shape whenever `repeatsPredicateCopula`
    // suppresses their reading. The noun is recovered from its furigana, not
    // from the bare character, which is the whole basis of the gate.
    expect(kanaOnlyOf("耳。", "耳")).toBe(true);
  });

  it("an ordinary character with no reading keeps its kanji", () => {
    expect(kanaOnlyOf("山。", "山")).toBe(false);
    expect(prose("山高(たか)シ。")).toBe("山高し。");
  });
});

describe("parseAnnotationText round trip", () => {
  // The lines below are `generateAnnotationText`'s own output for the first
  // sentences of 酒蟲.conllu, marks and all.
  const lines = [
    "酒(さけ)ノ蟲(むし)",
    "長(ちやう)山(さん)ノ劉(りう)氏(し)、體(からだ)肥(こ)エ嗜(たしな)ム[レ]飲(いん)ヲ。",
    "每(ごと)ニ[二]獨(どく)酌(しやく)スル[一]、輒(すなは)チ盡(つ)クス[二]一(いち)甕(をう)ヲ[一]。",
    "負(ふ)郭(くわく)ノ田(た)三(さん)百(びやく)畝(ほ)アリ、輒(すなは)チ半(なか)バ種(う)ヱ[レ]黍(きび)ヲ、而(しか)モ家(いへ)豪(がう)富(ふ)ニシテ、不ズ[三]以(もつ)テ[レ]飲(いん)ヲ為(な)セ[二]累(るゐ)ト也(なり)[一]。",
  ];

  it("re-emits the annotation text it was given, byte for byte", () => {
    const text = lines.join("\n");
    expect(generateAnnotationText(parseAnnotationText(text))).toBe(text);
  });

  it("either alphabet of kaeriten reads the same, and plain is what comes back", () => {
    // The two alphabets write the same marks: レ/一/二 as this format and the
    // `kanbun` LaTeX package write them and a person can type them, ㆑/㆒/㆓ as
    // the panel draws them — which is what a reader copying a line off the
    // page has in hand. So a line is read in either, and recorded and
    // re-emitted in the plain one.
    //
    // This is the case the format used to lose outright: the panel wrote ㆑
    // and `executeKunten` reads レ, so every kaeriten was silently ignored and
    // 嗜ム㆑飲ヲ came back in source order as 嗜む飲を.
    const plain = "嗜(たしな)ム[レ]飲(いん)ヲ。";
    const display = "嗜(たしな)ム[㆑]飲(いん)ヲ。";
    expect(prose(plain)).toBe("飲を嗜む。");
    expect(prose(display)).toBe("飲を嗜む。");
    expect(parseAnnotationText(display)).toEqual(parseAnnotationText(plain));
    expect(generateAnnotationText(parseAnnotationText(display))).toBe(plain);
  });

  it("the two alphabets are a pair, and only a kunten string is read back into glyphs", () => {
    expect(toPlainKuntenMarks("㆘㆒㆑㆖")).toBe("下一レ上");
    expect(toDisplayKuntenMarks("下一レ上")).toBe("㆘㆒㆑㆖");
    // Idempotent both ways, so text of unknown provenance — a hand-edited
    // line mixing the two — is safe to run through either.
    expect(toPlainKuntenMarks("下一レ上")).toBe("下一レ上");
    expect(toDisplayKuntenMarks("㆘㆒㆑㆖")).toBe("㆘㆒㆑㆖");
    // A numeral past the Kanbun block's own four has no display glyph and
    // stays as it is.
    expect(toDisplayKuntenMarks("五")).toBe("五");
  });

  it("the kaeriten drive the reading order, tier by tier", () => {
    // レ点, over the one character after it (酒蟲's opening sentence).
    expect(prose("長(ちやう)山(さん)ノ劉(りう)氏(し)、體(からだ)肥(こ)エ嗜(たしな)ム[レ]飲(いん)ヲ。")).toBe("長山の劉氏體肥え飲を嗜む。");

    // 一二点 (割其耳。), the object read before the verb that governs it.
    expect(prose("割(わ)ル[二]其(そ)ノ耳(みみ)ヲ[一]。")).toBe("其の耳を割る。");

    // 上下点 over a 一二点 group — hand-written in the classical notation for
    // 有朋自遠方來, which is the shape the tier exists for: a return that has
    // to reach across a 一二点 pair already spoken for. 上 is read before its
    // 下 governor even though a 下 carries the tier's *last* symbol, which a
    // 2-member group writes in place of a 中 it does not have.
    expect(prose("有(あ)リ[下]朋(とも)自ヨリ[二]遠(とほ)キ方(かた)[一]來(く)ル[上]。")).toBe("朋遠き方より來る有り。");

    // The app's own marks for that same sentence (一二点 with a レ点 inside),
    // and its own 書き下し文 for it, verbatim.
    expect(prose("有(あ)リ[二]朋(とも)自ヨリ[レ]遠(とほ)シ方(かた)來(く)ル[一]、")).toBe("朋遠しより方來る有り。");

    // The fused 一二三 of 不以飲為累也 — three ranks on one tier, with the
    // negation postposed to the very end as ず. (以 keeps its kanji here
    // where the render drops it: `inferKanaOnly` has no render to consult,
    // which is the standing gap its own tests above describe. The reading
    // *order* is the point being pinned.)
    const fused = "負(ふ)郭(くわく)ノ田(た)三(さん)百(びやく)畝(ほ)アリ、輒(すなは)チ半(なか)バ種(う)ヱ[レ]黍(きび)ヲ、而(しか)モ家(いへ)豪(がう)富(ふ)ニシテ、不ズ[三]以(もつ)テ[レ]飲(いん)ヲ為(な)セ[二]累(るゐ)ト也(なり)[一]。";
    expect(prose(fused)).toBe("負郭の田三百畝あり輒ち半ば黍を種ゑしかも家豪富にして飲を以て累となり為せず。");
  });

  it("the prose is hiragana throughout, and the annotation text keeps its katakana", () => {
    // The one place the two registers part company. 肥エ and 飲ヲ are katakana
    // in the 訓読文 and in this format — `UNIT_RE` finds the okurigana slot by
    // that very range — and 肥え and 飲を in the 書き下し文, which is running
    // Japanese.
    const line = "長(ちやう)山(さん)ノ劉(りう)氏(し)、體(からだ)肥(こ)エ嗜(たしな)ム[レ]飲(いん)ヲ。";
    expect(generateAnnotationText(parseAnnotationText(line))).toBe(line);
    expect(prose(line)).toBe("長山の劉氏體肥え飲を嗜む。");
    expect(prose(line)).not.toMatch(/[ァ-ヶ]/u);
  });

  it("an unedited token keeps the real kanaOnly its render carried", () => {
    // `previous` outranks the inference entirely, which is the point of it:
    // 耳(みみ) tagged kana-only by an actual render stays kana-only here even
    // though `inferKanaOnly` would now decline it.
    const line = "割(わ)ル[二]其(そ)ノ耳(みみ)ヲ[一]。";
    const previous = parseAnnotationText(line);
    previous[0][2] = { ...previous[0][2], kanaOnly: true };
    expect(parseAnnotationText(line, previous)[0][2].kanaOnly).toBe(true);
    // …and a token the edit changed falls back to the inference.
    const edited = "割(わ)ル[二]其(そ)ノ耳(みみ)ニ[一]。";
    expect(parseAnnotationText(edited, previous)[0][2].kanaOnly).toBe(false);
  });
});
