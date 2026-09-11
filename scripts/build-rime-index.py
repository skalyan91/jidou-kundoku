#!/usr/bin/env python3
"""Builds `public/data/rime-index.json` — the 韻 of the 廣韻 for every character
it holds, so the app can annotate a poem's line ends with the rime they fall in.

    python3.13 -m venv /tmp/qieyunvenv
    /tmp/qieyunvenv/bin/pip install 'qieyun==0.13.3'
    /tmp/qieyunvenv/bin/python scripts/build-rime-index.py

A venv of its own and not the parser's: `qieyun` pins `networkx==2.5.1`, whose
`graphml` module reads `np.float_` at import time, and that attribute was
removed in NumPy 2. In a bare venv there is no NumPy for it to find and the
import is clean; in the spaCy venv `scripts/build-kanbun-info-corpus.py` uses
there is, and `from Qieyun import ...` dies before it returns. Nothing here
needs spaCy and nothing there needs Qieyun, so the two stay apart.

**Why the index is shipped rather than computed.** The same reason
`historical-kana-index.json` is: this app is client-side and has no server to
ask, and `qieyun` is a Python package. A reader who has never heard of it still
gets the annotation. `scripts/derive-onyomi-kana.py` already takes its 音韻地位
from this package at build time; this is the second use of the same source and
the licence file beside the data (`public/data/LICENSE-Qieyun.txt`) already
covers it — see the note at the foot of this docstring about the one sentence
in it that needed widening.

── What a character's entry is ──────────────────────────────────────────────

The 韻目 — the rime *as the 廣韻 itself names it*, in the tone it stands in:
深 is 侵, 在 is 海 or 代, 國 is 德. That is `韻部原貌` in this package, and it
is deliberately not `音韻地位.韻`, which normalises every tone onto its 平聲
representative (在 -> 咍, 國 -> 登). The two answer different questions. 韻 is
the right key for a *phonological* fact — which is why the on'yomi derivation
next door uses it — but a rhyme in regulated verse is a rhyme within one 韻目
*including its tone*: 深・心・金・簪 rhyme because all four are 侵, and 在 does
not rhyme with 咍 because it is not in it. An annotation printed beside a line
of verse is making the second claim, so it prints the second thing.

The 韻目 carries its own 聲 and its own 卷 — 侵 is 平聲 and stands in 卷二, so
it is 下平聲侵韻, which is exactly how kanbun.info writes it — and both are
functions of the 韻目 alone (asserted below, not assumed). So they live in a
206-row table of their own and a character's entry is just the string of 韻目
characters, which is what keeps this file to a quarter of a megabyte for
19,499 characters.

The 卷 comes from the page image URL the package hands back
(`.../volume2/p046.jpg`): 卷一 is 上平聲, 卷二 下平聲, 卷三 上聲, 卷四 去聲,
卷五 入聲. Derived rather than tabulated because a 206-row table of volume
numbers written from memory is 206 chances to be silently wrong, and because
the derivation is checkable — every 韻目 must land in exactly one volume, and
the script fails if one does not.

── A character with more than one 音韻地位 ───────────────────────────────────

**Every one of them is recorded, in the 廣韻's own order, and none is
preferred.** 4,044 of the 19,499 characters here have two or more; 深 is 侵
(式針切, 平) and 沁 (式禁切, 去), 簪 is 侵 (側吟切) and 覃 (作含切). Writing one
of those down and dropping the other would be a claim the 廣韻 does not make,
and the app cannot make it either: which reading a character has in a
particular line is a fact about the line, not about the character.

**What the app does with the ambiguity is decide it from the poem, from the
line's own part of speech, or show it.** See `src/render/rimeAnnotation.ts`'s
`rimeGlossForLine`: a regulated poem rhymes on one 韻目 throughout, so where
the even lines' finals share exactly one 韻目 between them that is the poem's
rhyme and each line-final entry is filtered to it — 深 prints 侵 and not 沁
because 心 and 金 are unambiguously 侵 and 深 has 侵 among its own. An odd
line's final does not rhyme, so the poem says nothing about it — but where the
廣韻's own glosses divide along a plain part-of-speech line, `POS_RESOLVED_RIME`
below says which of the two the app's own tag on that token means, in exactly
the cases a hand has checked and no others. Where neither applies every value
is printed (`rimeLabel` in `rimeAnnotation.ts`), so a single value on the page
always means the 廣韻 gives only one, the poem itself picked it out, or the
token's own part of speech does.

── The licence ──────────────────────────────────────────────────────────────

`public/data/LICENSE-Qieyun.txt` covers this: the package is MIT and the rime
data is the 廣韻 (1008), long out of copyright. One sentence in it needed
widening and has been widened — it said "nothing from it reaches the browser,
only the derived JSON index does", which was true when the only use was the
on'yomi derivation, where what ships is a table of *kana spellings* learned
from the 音韻地位. What ships now includes 廣韻 rime categories themselves. That
is still public-domain Song-dynasty lexicography and still not the package's
own code, but the sentence as written no longer described the file beside it.
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    from Qieyun import iter音韻地位, 音韻地位2字頭_韻書出處們
except ImportError:  # pragma: no cover - dev-time script
    sys.exit("Qieyun not installed — see this file's docstring for the venv.")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "rime-index.json"

# 卷一..卷五 of the 廣韻, in the package's own page-image paths.
VOLUME_TONE = {
    "1": "上平聲",
    "2": "下平聲",
    "3": "上聲",
    "4": "去聲",
    "5": "入聲",
}
VOLUME_RE = re.compile(r"/volume(\d)/")
PAGE_RE = re.compile(r"/p(\d+)")

# 廣韻 and nothing else. The package also carries 王一 — 王仁昫's 刊謬補缺切韻,
# an earlier and differently-cut recension — and 韻圖 witnesses (韻鏡 and the
# like) beside it. Those are other books' analyses of the same character, and
# mixing them would make "how many rimes does this character have" mean nothing
# in particular: a difference between the two 韻書 would come out looking like
# a genuine 多音字. The 廣韻 is what `public/data/LICENSE-Qieyun.txt` names, it
# is what kanbun.info's own rime notes cite (「下平声侵韻」), and it is the one
# book this index reports. The counts of what was left out are printed.
SOURCE = "廣韻"

# ── 四聲別義: a curated table of characters a POS resolves ───────────────────
#
# **What this is for.** A line-final the poem does not rhyme on (see
# `rimeAnnotation.ts`'s own note on odd lines) is not resolved by the poem at
# all, and 在 — 國破山河在, 春望's own first line — prints 海代二韻 for exactly
# that reason: 海 (上聲, "to dwell, to exist") and 代 (去聲, "the place where")
# are both in the 廣韻 and nothing in the rhyme scheme prefers one. But 在 here
# is the intransitive verb, and the 廣韻's own witnesses say so without being
# asked: `音韻地位2字頭_韻書出處們` hands back a `釋義` for every witness, and
# 海's is 「居也存也」("to dwell, to exist"), 代's is 「所在」("the place
# where") — a verb sense against a nominal one, sitting on the two tones as
# plainly as the poem's own reading of the line does. Where the app already
# knows a token's part of speech — the treebank's own tag on a parsed text, or
# a reader's retag through the 品詞 chip — that is real evidence a coin toss is
# not, and this table is where it is spent.
#
# **A curated table over the characters that actually matter, not a general
# parser over all of them.** An earlier pass at this tried reading every
# multi-rime character's `釋義` with a general classifier and reported real
# false narrowings on frequent characters — a terse dictionary gloss is not
# machine-parsable prose, and 廣韻 glosses lean on cross-reference and
# etymological pun (妻's own 平聲 entry below is one) as often as they state a
# plain definition. So nothing here is inferred: every entry was looked up by
# hand against this script's own `音韻地位2字頭_韻書出處們` output, the same
# call this docstring quotes 在 from, and is listed with the gloss that earned
# it a place — the same discipline `LEXICALIZED_NUMERAL_COMPOUND` and
# `CLASSIFIER_ONYOMI` (`src/reading/readingResolver.ts`) apply to their own
# tables, and for the same reason: a table that cannot be checked against its
# own citations is a table nobody can maintain.
#
# **Restricted to characters with exactly two 音韻地位.** 4,044 of the index's
# 19,499 characters have more than one; 3,378 have exactly two. A three-rime
# split has three senses to keep straight instead of one opposition, and none
# of the classic 四聲別義 pairs below needed a third — the scope is a choice
# made for tractability, not a claim that no three-rime character ever has a
# decisive split, and a character outside it is simply left unresolved rather
# than guessed at.
#
# **Admitted only where a coarse part of speech decides it, and refused where
# the 廣韻's own words do not.** 教 (平聲 "效也", 去聲 "教訓也...教之爲言傚也")
# was looked at and left out: both tones read as the same verb, "to instruct",
# and nothing in either gloss marks one of them nominal. 思, this docstring's
# own second example above the fold, was looked at and left out for the same
# reason — 平聲's「思念也」and 去聲's「念也」are the same two words with one
# character in common; the traditional grammatical account of 思 as "to think"
# against "a thought" is real but it is not what these two glosses say by
# themselves, and this table only admits what the glosses say. 王, 語, 任, 興,
# 相, 從, 張, 操, 禁, 甚, 先, 累, 施, 爲 were checked and refused for the same
# reason — the go聲 witness restates the same verb, gives no witness beyond a
# cross-reference, or genuinely reads either way. 為/爲 was refused for a
# second reason as well: it is one of the commonest characters in the corpus,
# and the false-narrowing risk a frequent character carries is exactly what
# the finding above warns against.
#
# **Each value is a UPOS** (`NOUN`, `VERB`, `ADJ` — the derived tag
# `uposForXpos` in `src/parse/xpos.ts` computes, not the xpos itself), because
# UPOS is the coarse class the 四聲別義 opposition actually falls on and the
# xpos alone does not carry it: `v,動詞` is shared by VERB, ADJ, ADV and AUX,
# so a table keyed on the xpos's own first two fields could not tell 好 the
# adjective from 好 the verb apart, and UPOS, derived from the fields together
# with `VerbForm`/`VerbType`, can. A token whose UPOS is neither key — a 名詞
# read adverbially, an unset tag on an unparsed upload — resolves nothing and
# both 韻目 print, exactly as a character outside this table does.
POS_RESOLVED_RIME: dict[str, dict[str, str]] = {
    # 上聲海韻「居也存也」to dwell, to exist / 去聲代韻「所在」the place where —
    # this table's own worked example, and the line the feature exists for.
    "在": {"VERB": "海", "NOUN": "代"},
    # 上聲麌韻: rain the phenomenon itself ("天地之氣和則雨...水从雲下也").
    # 去聲遇韻「詩曰雨雪其霶」— 詩經 quoted for 雨 used transitively, "to rain
    # [something] down": the classic denominal verb.
    "雨": {"NOUN": "麌", "VERB": "遇"},
    # 平聲微韻「上曰衣下曰裳」the upper garment, so named. 去聲未韻「衣著」to
    # wear, to dress in — the same denominal shift as 雨.
    "衣": {"NOUN": "微", "VERB": "未"},
    # 平聲桓韻「首飾...弁冕之總名也」a headdress, the general name for caps.
    # 去聲換韻「冠束」to bind on a cap, to cap (a young man, at his coming of
    # age).
    "冠": {"NOUN": "桓", "VERB": "換"},
    # 平聲文韻「賦也施也與也...別也」to allot, to bestow, to divide. 去聲問韻
    # 「分劑」a portion, a measured share.
    "分": {"VERB": "文", "NOUN": "問"},
    # 平聲仙韻「轉也」to turn, to pass along, to transmit. 去聲線韻「訓也...
    # 以傳示後人也」an explanation handed down to later readers, and 「郵馬」a
    # post-relay — both nominal, a record and a relay-station.
    "傳": {"VERB": "仙", "NOUN": "線"},
    # 平聲蒸韻「駕也勝也登也」to drive, to overcome, to mount. 去聲證韻「車乘
    # 也」a chariot, a team of four horses — 論語 and 孟子's own 千乘之國.
    "乘": {"VERB": "蒸", "NOUN": "證"},
    # 平聲支韻「跨馬也」to straddle a horse. 去聲寘韻「騎乘」a mounted rider —
    # the same nominal shift as 乘 itself, one line above, and the same pair
    # every classical-Chinese primer's 破音字 list opens with.
    "騎": {"VERB": "支", "NOUN": "寘"},
    # 上聲晧韻「善也美也」good, fine. 去聲号韻「愛好」to love, to be fond of.
    "好": {"ADJ": "晧", "VERB": "号"},
    # 平聲陽韻「量度」to measure. 去聲漾韻「合斗斛」a capacity, a dou-and-hu
    # measure.
    "量": {"VERB": "陽", "NOUN": "漾"},
    # 平聲唐韻「隱也匿也」to hide, to conceal. 去聲宕韻「通俗文曰庫藏曰帑」a
    # storehouse, per 通俗文.
    "藏": {"VERB": "唐", "NOUN": "宕"},
    # 上聲阮韻「遙遠也」far, distant. 去聲願韻「離也」to separate from, to keep
    # at a distance.
    "遠": {"ADJ": "阮", "VERB": "願"},
    # 上聲隱韻「迫也幾也」near, close. 去聲焮韻「附也」to draw near to, to
    # attach oneself to.
    "近": {"ADJ": "隱", "VERB": "焮"},
    # 平聲文韻「知聲也」to perceive sound, to hear. 去聲問韻「名達」renown that
    # reaches far — reputation, a nominal sense (詩經, quoted: 令聞令望).
    "聞": {"VERB": "文", "NOUN": "問"},
    # 上聲晧韻 above is 好; this is 和, 平聲戈韻「和順也諧也」harmonious,
    # gentle. 去聲過韻「聲相應」sounds answering each other — to harmonize
    # with, as one voice answers another in song.
    "和": {"ADJ": "戈", "VERB": "過"},
    # 平聲寒韻「艱也不易稱也」difficult, not easily accomplished. 去聲翰韻
    # 「患也」a calamity, an affliction — 患難 is the same nominal 患.
    "難": {"ADJ": "寒", "NOUN": "翰"},
    # 去聲寘韻「難易也簡易也」easy, simple. 入聲昔韻「變易」to change, to
    # alter.
    "易": {"ADJ": "寘", "VERB": "昔"},
    # 去聲暮韻「法度」a law, a standard. 入聲鐸韻「度量也」to measure, to
    # estimate — 度德量力, to gauge one's own virtue and strength.
    "度": {"NOUN": "暮", "VERB": "鐸"},
    # 上聲語韻「居也止也制也息也留也定也」to dwell, to reside, to settle. 去聲
    # 御韻「處所也」a place, a location — the same opposition as 在 itself,
    # down to the 所 the two glosses share.
    "處": {"VERB": "語", "NOUN": "御"},
    # 平聲桓韻「視也」to observe, to look at. 去聲換韻「樓觀...爾雅曰觀謂之闕」
    # a watchtower, what 爾雅 calls a 闕 — the same rime as 冠 above, a
    # different character.
    "觀": {"VERB": "桓", "NOUN": "換"},
    # 平聲齊韻「齊也」— an etymological gloss (妻 punned on 齊, "an equal"),
    # rather than a plain definition, but the headword's plain sense, "wife",
    # is not in question. 去聲霽韻「以女妻人」to give a woman to someone in
    # marriage — the unambiguous denominal verb, "to marry (a daughter) off".
    "妻": {"NOUN": "齊", "VERB": "霽"},
}


def build():
    # 韻目 -> {tone, volume}; and 韻目 -> the (volume, page) it was first seen
    # at, which is what orders the table into the book's own order.
    rime_tone: dict[str, set[str]] = defaultdict(set)
    rime_volume: dict[str, set[str]] = defaultdict(set)
    rime_at: dict[str, tuple[int, int]] = {}
    # char -> 韻目 list, in the order the book gives them.
    chars: dict[str, list[str]] = defaultdict(list)
    sources = Counter()
    skipped = 0

    for position in iter音韻地位():
        tone = position.聲
        for char, witnesses in 音韻地位2字頭_韻書出處們(position):
            for w in witnesses:
                sources[w["資料名稱"]] += 1
                if w["資料名稱"] != SOURCE:
                    continue
                rime = w.get("韻部原貌") or ""
                if len(rime) != 1:
                    # A 韻目 is one character in every row this has been run
                    # over; an empty or multi-character one would break the
                    # string encoding below, so it is counted and dropped
                    # rather than written out.
                    skipped += 1
                    continue
                m = VOLUME_RE.search(w.get("書影") or "")
                if not m:
                    skipped += 1
                    continue
                volume = m.group(1)
                rime_tone[rime].add(tone)
                rime_volume[rime].add(volume)
                # One search, and the match narrowed before it is read: the
                # ternary that stood here ran the same regex twice and left the
                # `.group(1)` unnarrowed, which a type checker flags and a
                # reader has to re-derive is safe.
                page_at = PAGE_RE.search(w["書影"])
                page = int(page_at.group(1)) if page_at else 0
                here = (int(volume), page)
                if rime not in rime_at or here < rime_at[rime]:
                    rime_at[rime] = here
                if rime not in chars[char]:
                    chars[char].append(rime)

    others = {k: v for k, v in sources.items() if k != SOURCE}
    if others:
        print(f"other 韻書 witnesses passed over: {others}")

    # The two facts the 206-row table rests on, checked rather than trusted:
    # a 韻目 has one 聲 and stands in one 卷. If either ever fails, a
    # character's entry can no longer be a bare 韻目 and this script has to
    # grow a shape, which is a thing to find out here and not in the browser.
    for rime, tones in rime_tone.items():
        if len(tones) != 1:
            sys.exit(f"韻目 {rime} carries more than one 聲: {sorted(tones)}")
    for rime, volumes in rime_volume.items():
        if len(volumes) != 1:
            sys.exit(f"韻目 {rime} stands in more than one 卷: {sorted(volumes)}")

    order = sorted(rime_at, key=lambda r: rime_at[r])
    rimes = {
        rime: {
            "tone": next(iter(rime_tone[rime])),
            "volume": VOLUME_TONE[next(iter(rime_volume[rime]))],
        }
        for rime in order
    }
    # Each character's rimes in the book's order too, so that 深 reads 侵沁 and
    # not 沁侵 whichever position the iteration reached first.
    rank = {rime: i for i, rime in enumerate(order)}
    table = {ch: "".join(sorted(rs, key=lambda r: rank[r])) for ch, rs in sorted(chars.items())}

    # `POS_RESOLVED_RIME` checked against the book it is curated from, not
    # merely trusted: a character it names has to be one the 廣韻 actually
    # gives more than one 音韻地位, and the two 韻目 it maps have to be *all*
    # of that character's rimes and neither more nor fewer — a table that drifted
    # from the data (a rebuild that split or merged a 韻目, a typo in a key)
    # otherwise ships a silently wrong disambiguation instead of failing the
    # build that would have caught it.
    for ch, mapping in POS_RESOLVED_RIME.items():
        if ch not in table:
            sys.exit(f"POS_RESOLVED_RIME names {ch}, which the 廣韻 gives no rime at all")
        book_rimes = set(table[ch])
        mapped_rimes = set(mapping.values())
        if len(mapped_rimes) != len(mapping):
            sys.exit(f"POS_RESOLVED_RIME's {ch} maps two 品詞 to the same 韻目 {mapping}")
        if mapped_rimes != book_rimes:
            sys.exit(
                f"POS_RESOLVED_RIME's {ch} names {sorted(mapped_rimes)}, "
                f"which is not the 廣韻's own {sorted(book_rimes)}"
            )

    payload = {
        "_provenance": {
            "source": "廣韻 (Guangyun, 1008), via the `qieyun` Python package (nk2028, MIT).",
            "licence": "public/data/LICENSE-Qieyun.txt",
            "built_by": "scripts/build-rime-index.py",
            "field": "韻部原貌 — the 韻目 as the 廣韻 names it, in its own tone.",
            "ambiguity": "Every 音韻地位 the book gives a character is recorded, in the "
                         "book's order; none is preferred. The app decides between them "
                         "from the poem, from a hand-curated table of the 廣韻's own "
                         "part-of-speech-divided glosses (posRime), or shows them all.",
        },
        "rimes": rimes,
        "chars": table,
        "posRime": POS_RESOLVED_RIME,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    multi = sum(1 for v in table.values() if len(v) > 1)
    print(f"{len(table)} characters, {len(rimes)} 韻目, {multi} characters with more than one")
    print(f"{skipped} witnesses skipped (no single-character 韻目, or no page image)")
    print(f"{len(POS_RESOLVED_RIME)} characters carry a hand-curated 品詞 disambiguation")
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    build()
