#!/usr/bin/env python3
"""Builds public/data/samples/rongo-gakuji.conllu — the 論語 sample the sidebar
button loads.

    python3 scripts/build-analects-sample.py

**Where the text comes from, and where it deliberately does not.**

The trees are the Kyoto SUD treebank's own, taken verbatim from the same
`relabeled_ext.udep_ruled.punct.rulemerged.adjfix` files
`build-kanbun-info-corpus.py` calls gold, and licensed CC BY-SA 4.0 — see
`public/data/samples/LICENSE-Kyoto.txt`, which is the attribution that licence
requires and which ships beside the sample for the same reason
`LICENSE-UniDic.txt` ships beside the kogo index.

The brief for this sample asked for the received edition's punctuation, from
the Kanseki Repository's KR1h0004 — which is the very identifier the treebank's
own `sent_id`s carry, so the two are editions of one text and would have
aligned on their Han characters exactly as `build-kanbun-info-corpus.py`'s
`Gold.norm` aligns kanbun.info's. **It is not taken, and the reason is the
licence.** Kanripo's site footer licenses "all content created by us" CC BY-SA
4.0; KR1h0004's own header declares `BASEEDITION CHANT` / `WITNESS chant`, and
the Kanripo catalogue entry names 阮元's 1816 江西南昌府學 recutting of the Song
《論語注疏》 as the base — i.e. the transcription is the CHinese ANcient Texts
database's (漢達文庫, D. C. Lau Research Centre, CUHK), not Kanripo's to
license. CHANT's own agreement reads "No part of the Site shall be reproduced
or adapted without prior written permission approved by CUHK", and merging its
punctuation into another edition is squarely an adaptation. Two incompatible
claims sit on the same bytes, so nothing was taken from either; this file
contains no Kanripo or CHANT text at all.

**What is corrected here instead, and it is not the received edition's
punctuation but the gold's own mark order.** The treebank's punctuation is
inserted by a rule that emits each mark in the position of the token it hangs
off, which is right whenever those two agree and wrong whenever they do not:

  - a closing 」 hangs off the quoted clause's root, an early token, while the
    ？ or ！ that ends the same sentence hangs off the sentence-final particle,
    a late one — so the pair comes out 乎」？ where every edition, and the
    reader's own hand-annotated 學而, writes 乎？」;
  - and in one place a 「 hangs off the quotation's root while the ： that
    introduces it hangs off 曰, giving 子曰「： for 子曰：「.

All of them are corrected, and all the same way: the two adjacent PUNCT rows
swap places entire — form, lemma, XPOS, head and MISC travelling together — so
what changes is the order two marks are written in and nothing else. No mark is
added, none is removed, no content token moves, and no arc is touched;
`swap_rows` asserts as much before it acts. Ten swaps all told, and the run
prints them.

**Three further edits, each of which the run also prints.** The 篇 heading is
given its on'yomi and one retag, because the ordinary reading rules read a
title as a sentence and make a verb of 學 (`read_title`). The next 篇's heading,
which the treebank's merge left inside this one's last sentence, is cut off and
what remains is re-rooted (`drop_trailing_heading`) — a truncation rather than a
correction, since 為政第二 is simply outside the extract. And every block's ids
are put back to a contiguous 1..n afterwards (`renumber`).

**The extent is the whole of 學而第一** — the heading and all sixteen chapters,
499 Han characters once the next heading is cut, against the 267 of the other
sample. It was chapters 1-6 until the reader asked for the whole 篇.

**The readings are the app's own and not an edition's**, which was also asked
for and could not be given. The request was for kanbun.info's punctuation and
書き下し文 — Web漢文大系, 藤川全祐's site. It has no terms of use, no licence and
no permissions page: the only thing it grants is the right to link to it
("当サイトは、どのページにリンクしていただいてもかまいません"), every page
carries "© Web Kanbun-Taikei", and older captures of the same page said
"All rights reserved" outright. Its 書き下し文 is a living author's editorial
work — his own 凡例 argues at length over readings such as 曰 as いはく — and
silence about reuse is not permission under Japanese copyright law. Bundling it
here would also purport to sublicense it to everyone downstream, which no
quotation right allows. So it is not here, and this file's readings are the
app's own resolver's, with only the heading pinned by hand. The site invites
corrections at its published address, which is also where permission could be
asked for.
"""

import os
import re
import sys

HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿\U00020000-\U0002FFFF]")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TREEBANK = os.path.expanduser(
    "~/Linguistics/Tools/SUD-spaCy/assets_lzh/SUD_Classical_Chinese-Kyoto"
)
TREEBANK_TAG = "relabeled_ext.udep_ruled.punct.rulemerged.adjfix"
OUT = os.path.join(ROOT, "public", "data", "samples", "rongo-gakuji.conllu")

WORK = "KR1h0004_001"  # 論語, 卷一 — 學而第一
LAST_CHAPTER = 16

# The marks that end a sentence, as against the 、，； that divide one.
SENTENCE_FINAL = "。？！"

# Pairs of adjacent opening marks the treebank writes the wrong way round, and
# the order they belong in. Both come of the same cause as the closing-mark
# fault below — each mark is emitted at the position of the token it hangs off,
# and where two marks hang off tokens whose order does not match their own
# nesting, they come out crossed. 子曰「： for 子曰：「, and 曰：《「詩》 for
# 曰：「《詩》, where the speech quotation must open outside the book title it
# contains and not inside it.
OPENING_PAIRS = {("「", "："): ("：", "「"), ("《", "「"): ("「", "《")}

# The 篇 heading that the treebank's merge left inside 學而's last sentence:
# 為政第二 is the *next* juan's, and 患不知人也 is where 學而 ends. Written out
# so that `drop_trailing_heading` can assert it found what it meant to find
# rather than pattern-matching at large.
NEXT_HEADING = "為政篇第二"

# The 篇 heading's readings, pinned character by character.
#
# **A heading is not a sentence, and the ordinary reading rules have no
# business guessing at one.** Left to them 學而篇第一 comes out 學びて篇第一 —
# 學 taken for the verb it usually is and 而 for the て that usually follows
# it, which is a reasonable reading of those two characters everywhere except
# here, where 學而 is the chapter's *name*, quoted from its opening words. A
# title is read straight through in on'yomi: がくじへんだいいち.
#
# Pinned in MISC under `Reading`, which is the key a reader's own hand-picked
# reading is stored under (`reading/chosenReading.ts`) and the one the other
# sample already uses — so this ships as a text somebody has already been
# through, which is exactly what it is, and the reader can still overrule any
# of them from the menu.
TITLE_ON_YOMI = {"學": "がく", "而": "じ", "篇": "へん", "第": "だい", "一": "いち"}


def sent_key(sid):
    """Document order from the id alone.

    A `sent_id` is `KR1h0004_001_par<chapter>_<from>-<to>#<part>`, the range
    being an offset into the chapter and the `#part` a split the treebank's own
    pipeline made. Sorting on (chapter, offset, part) therefore restores the
    reading order across the three shuffled splits — and it has to, because the
    merge step that produced these files keeps the *first* member's id, so the
    opening 子曰：「學而時習之 is filed not under `par1` but under the chapter
    title it was merged onto. That block sorts to 0 here, which is where it
    belongs.
    """
    m = re.match(rf"{WORK}_(title|par(\d+)_(\d+)-\d+)(?:#(\d+))?$", sid)
    if not m:
        return None
    part = int(m.group(4) or 0)
    if m.group(1) == "title":
        # **Only `title#0` is the title.** The merge that produced these files
        # swallowed the 篇 heading and chapter 1's opening into one block and
        # kept the heading's id, so `title#1` and `title#2` are 子曰：「學而時習
        # 之 and 不亦說乎 — chapter 1, filed under the title by an accident of
        # bookkeeping. Sorted as chapter 1 at offset 0 they land ahead of the
        # `par1_12` blocks that continue it, which is where they belong, and
        # the paragraph break below then falls between the heading and them
        # rather than in the middle of the chapter.
        return (0, 0, 0) if part == 0 else (1, 0, part)
    return (int(m.group(2)), int(m.group(3)), part)


def read_blocks():
    """Every block of 卷一, in reading order, as (chapter, sid, rows)."""
    found = {}
    for split in ("train", "dev", "test"):
        path = f"{TREEBANK}/lzh_kyoto-sud-{split}.{TREEBANK_TAG}.conllu"
        if not os.path.exists(path):
            sys.exit(f"treebank not found: {path}")
        for block in open(path, encoding="utf-8").read().split("\n\n"):
            m = re.search(r"^# sent_id = (\S+)$", block, re.M)
            if not m:
                continue
            key = sent_key(m.group(1))
            if key is None or key[0] > LAST_CHAPTER:
                continue
            rows = [ln.split("\t") for ln in block.split("\n") if ln and ln[0].isdigit()]
            found[m.group(1)] = (key, rows)
    return [
        (key[0], sid, rows)
        for sid, (key, rows) in sorted(found.items(), key=lambda kv: kv[1][0])
    ]


def swap_rows(rows, i):
    """Rows i and i+1 change places, whole.

    Everything but the ID column travels with its row, so each mark keeps the
    token it hangs off; only the two IDs stay where they are and are therefore
    re-worn by the other row. That is sound exactly as long as neither row is
    anything's head — otherwise a HEAD elsewhere in the sentence would go on
    naming an ID that now belongs to the other mark — which for a leaf PUNCT it
    never is, and which is asserted rather than assumed.
    """
    a, b = rows[i], rows[i + 1]
    assert a[3] == b[3] == "PUNCT", f"not a pair of marks: {a[1]} {b[1]}"
    ids = {a[0], b[0]}
    assert not any(r[6] in ids for r in rows), f"a mark in {a[1]}{b[1]} is a head"
    rows[i], rows[i + 1] = a[:1] + b[1:], b[:1] + a[1:]


def fix_mark_order(rows, sid, log):
    """The orderings the gold's insertion rule gets wrong. See the module
    docstring for why they are wrong and why swapping is the whole fix."""
    for i in range(len(rows) - 1):
        first, second = rows[i][1], rows[i + 1][1]
        if (first, second) in OPENING_PAIRS:
            swap_rows(rows, i)
            a, b = OPENING_PAIRS[(first, second)]
            log.append(f"{sid}: {first}{second} → {a}{b}")
        elif first == "」" and second in SENTENCE_FINAL:
            swap_rows(rows, i)
            log.append(f"{sid}: 」{second} → {second}」")


def drop_trailing_heading(rows, sid, log):
    """Cuts the next 篇's heading off the end of this one.

    The merge that produced these files ran 學而's last chapter together with
    the heading of 為政第二, so the extract's final sentence reads
    患不知人也為政篇第二 — and worse, it is *頭* 篇 that the merge made the
    sentence's root, with 患 hanging off it as a `mod`. Cutting the heading is
    therefore not only a matter of dropping five tokens: what remains has to be
    given back its own root.

    This is a truncation and not a correction. Every extract has to end
    somewhere, and 為政 is simply outside this one — the same as chapter 17
    would be. The rule is exact rather than approximate: the run must be
    `NEXT_HEADING` character for character and must be the last content in the
    block, or nothing is dropped and the assertion says why.
    """
    forms = [r[1] for r in rows]
    start = next(
        (i for i in range(len(forms)) if "".join(forms[i:i + len(NEXT_HEADING)]) == NEXT_HEADING),
        None,
    )
    if start is None:
        return
    stop = start + len(NEXT_HEADING)
    assert all(r[3] == "PUNCT" for r in rows[stop:]), f"{sid}: content after the heading"
    dropped = {r[0] for r in rows[start:stop]}

    # The one surviving content token that hung off the heading is what 學而's
    # last sentence is actually about, so it becomes the root; the marks that
    # hung off the heading follow it there. Anything else pointing into the run
    # would mean the heading governed real text, which would make this the
    # wrong cut — so it is asserted, not assumed.
    orphans = [r for r in rows[:start] if r[6] in dropped]
    content = [r for r in orphans if r[3] != "PUNCT"]
    assert len(content) == 1, f"{sid}: {len(content)} content tokens hang off the heading"
    del rows[start:stop]
    new_root = content[0][0]
    content[0][6], content[0][7] = "0", "root"
    for row in rows:
        if row[6] in dropped:
            row[6] = new_root
    log.append(f"{sid}: dropped the next 篇's heading {NEXT_HEADING}, re-rooted on {content[0][1]}")


def read_title(rows, log):
    """The heading's own readings, and the one retag they need to take.

    Pinning the readings is not quite enough on its own: 學 is tagged VERB by
    the treebank, and a VERB goes on being conjugated whatever furigana stands
    over it, so `Reading=がく` alone yields 學し而篇第一 — the し that makes a
    サ変 verb of an on'yomi noun. The heading's 學 is not a verb; it is the
    first character of a name. So it is retagged NOUN, and that is the single
    dependency-annotation change this script makes to the treebank. It is
    confined to the heading, which the treebank does not analyse as a clause
    either — its own label for 而 there is `orphan`, the parser saying it could
    not attach it.
    """
    for row in rows:
        reading = TITLE_ON_YOMI.get(row[1])
        if reading is None:
            continue
        set_misc(row, "Reading", reading)
        if row[3] == "VERB":
            row[3] = "NOUN"
            log.append(f"heading: {row[1]} VERB → NOUN, so the reading is not conjugated")
    log.append("heading: " + "".join(TITLE_ON_YOMI.get(r[1], "") for r in rows) + " pinned as on'yomi")


def renumber(rows):
    """IDs back to a contiguous 1..n, with every HEAD following them.

    Only `drop_trailing_heading` can leave a gap, and it leaves one every time
    — but this runs over every block, because a renumbering that is applied
    selectively is one that can be forgotten. It is a no-op wherever the ids
    are already contiguous, which is everywhere else. `parseConllu` happens to
    tolerate gaps (it renumbers by position), but the file is CoNLL-U before it
    is this app's input, and every other tool would be entitled to reject it.
    """
    moved = {row[0]: str(i + 1) for i, row in enumerate(rows)}
    for i, row in enumerate(rows):
        row[0] = str(i + 1)
        if row[6] != "0":
            row[6] = moved[row[6]]


def set_misc(row, key, value):
    """MISC with `key=value` added, keeping whatever the treebank put there."""
    parts = [] if row[9] in ("_", "") else row[9].split("|")
    parts = [p for p in parts if not p.startswith(f"{key}=")]
    parts.append(f"{key}={value}")
    row[9] = "|".join(parts)


def main():
    blocks = read_blocks()
    if not blocks:
        sys.exit(f"no {WORK} blocks found in {TREEBANK}")

    log, title_log, cut_log = [], [], []
    out = []
    seen_chapters = set()
    for index, (chapter, sid, rows) in enumerate(blocks):
        fix_mark_order(rows, sid, log)
        # The 篇 heading, which is the first block and nothing else — see
        # `sent_key` for why `title#1` and `title#2` are not it.
        if index == 0:
            read_title(rows, title_log)
        if index == len(blocks) - 1:
            drop_trailing_heading(rows, sid, cut_log)
        renumber(rows)
        # Each chapter is a paragraph of the received text, and a chapter runs
        # over several of these blocks — so the break goes on the first token of
        # the first block of each, which is the convention the other sample
        # (酒蟲) uses and which `parse/sourceLayout.ts` reads. The heading is not
        # given one: it opens the document, and there is nothing above it to be
        # separated from. **What sets the heading apart as a paragraph of its
        # own is chapter 1's break, not any mark of its own** — and chapter 1
        # begins at `title#1`, immediately after it, which is what `sent_key`
        # is for.
        if chapter and chapter not in seen_chapters:
            set_misc(rows[0], "LineBreak", "para")
        seen_chapters.add(chapter)
        text = "".join(r[1] for r in rows)
        out.append(f"# sent_id = {sid}\n# text = {text}\n")
        out.append("".join("\t".join(r) + "\n" for r in rows))
        out.append("\n")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("".join(out))

    # Characters, not rows: the treebank writes 弟子 and 君子 as single tokens,
    # so a count of Han rows would be short of the text by one per compound.
    han = sum(len(r[1]) for _, _, rows in blocks for r in rows if HAN.match(r[1]))
    opens = sum(1 for _, _, rows in blocks for r in rows if r[1] == "「")
    closes = sum(1 for _, _, rows in blocks for r in rows if r[1] == "」")
    assert opens == closes, f"unbalanced quotation marks: {opens} 「 vs {closes} 」"
    print(f"{OUT}")
    print(f"  {len(blocks)} sentences, chapters 1-{LAST_CHAPTER}, {han} Han characters")
    print(f"  {LAST_CHAPTER} paragraph breaks, {opens} quotations")
    for line in title_log + cut_log:
        print(f"  {line}")
    print(f"  {len(log)} mark-order corrections:")
    for line in log:
        print(f"    {line}")


if __name__ == "__main__":
    main()
