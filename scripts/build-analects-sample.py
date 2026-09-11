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
# **The sentence-joined branch, and not the rule-merged one.** Both are the
# same gold trees over the same tokens; they differ only in where a sentence is
# held to end. `rulemerged` fills a boundary only where `cross_unit_rules.py`
# finds >= 90% dominance for it — 37.1% of them — and leaves every other 句讀
# unit standing as its own sentence, which cuts a quotation at each of its
# internal commas: 子曰：「學而時習之， then 不亦說乎？ as two sentences, the 「
# opening in one and the 」 closing three later. `sjmerged` runs the parser's
# own `SentJoin` pipe over the gold instead (scripts/merge_lzh_clauses.py in
# the SUD-spaCy tree, grouping by kanripo paragraph), and that pipe refuses a
# boundary inside an open quoted span unconditionally. Measured over the test
# split, blocks whose 「 and 」 do not balance fall from **9.35% to 2.37%**, and
# this extract goes from **82 blocks to 21** — the heading, then a whole 章 to a
# sentence, which is what the app should be showing and what the reader asked
# for.
#
# It is the app's convention as well as the reader's: the shipped wheel carries
# the same `sent_join` pipe, so a text pasted into the box is segmented this
# way. Building the sample off `rulemerged` meant the one document in the app
# that comes from gold was the one document segmented against the app's own
# rule.
TREEBANK_TAG = "relabeled_ext.udep_ruled.punct.sjmerged"

# **Where the ADJ tags come from, since the joined branch predates them.**
# `adjfix` recodes Classical Chinese stative predicates VERB -> ADJ to match
# parser 0.3.2, which emits the category natively; it was applied to the
# `rulemerged` branch and never to this one. It is a **pure UPOS overlay** —
# diffed column by column over the test split, the two files differ in the UPOS
# column and in no other, on 1,349 tokens, every one of them VERB -> ADJ — and
# both branches hold the same 34,233 tokens in the same order (the FORM columns
# are identical, which `adj_overlay` asserts rather than trusts). So the tags
# transfer by position, and the sample gets the joined sentences and the 0.3.2
# categories together instead of having to choose.
ADJFIX_TAG = "relabeled_ext.udep_ruled.punct.rulemerged.adjfix"
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

# The block the next 篇's heading opens on this branch, and the reason there is
# something to take back from it. Joining by paragraph files 為政篇第二 under
# 卷二 where it belongs — but the gold ends 學而 with 。」 *after* the heading,
# so those two marks are filed under 卷二 as well, and 學而's last chapter is
# left with an opening 「 and nothing to close it. See `reclaim_trailing_marks`.
NEXT_TITLE_SID = "KR1h0004_002_title_sj1"

# The XPOS this treebank gives a verb of communication — 曰, 云, 言, 謂, 問, 答.
# `repair_punct_heads` reads it to tell a mark standing between a speech verb
# and its quotation from every other mark.
COMMUNICATION_XPOS_PREFIX = "v,動詞,行為,伝達"

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

    A `sent_id` on this branch is `KR1h0004_001_par<chapter>_sj<n>`, the `sj`
    number counting the sentences `SentJoin` left within one kanripo
    paragraph — one for most chapters, four for 子貢問 (chapter 15). Sorting on
    (chapter, n) restores the reading order.

    **The heading is its own block again, which it was not before.** The
    rule-merged branch swallowed the 篇 heading and the opening of chapter 1
    into one block and kept the heading's id, so `title#1` and `title#2` were
    chapter 1 filed under the title and had to be sorted back out by hand.
    Joining by paragraph does not make that merge: the heading is a paragraph,
    chapter 1 is another, and `title_sj1` is the heading and nothing else.
    """
    m = re.match(rf"{WORK}_(?:title|par(\d+))_sj(\d+)$", sid)
    if not m:
        return None
    return (int(m.group(1) or 0), int(m.group(2)))


def token_rows(path):
    """Every token row of a CoNLL-U file, in file order and comments dropped."""
    return [
        ln.split("\t")
        for ln in open(path, encoding="utf-8").read().split("\n")
        if ln and ln[0].isdigit()
    ]


def adj_overlay(split):
    """UPOS by position, read off the `adjfix` branch for one split.

    The transfer is sound only if the two branches hold the same tokens in the
    same order, which is what makes it a *re-segmentation* of one corpus rather
    than two corpora — so that is asserted here, form by form over the whole
    split, before a single tag is taken. See `ADJFIX_TAG`.
    """
    path = f"{TREEBANK}/lzh_kyoto-sud-{split}.{ADJFIX_TAG}.conllu"
    if not os.path.exists(path):
        sys.exit(f"treebank not found: {path}")
    return token_rows(path)


def read_blocks():
    """Every block of 卷一, in reading order, as (chapter, sid, rows).

    The ADJ tags are laid over each block as it is read, from the same offset
    into the same split — `at` walks the sjmerged file in step with the overlay
    list, so the two indices stay together across blocks this extract skips as
    well as the ones it keeps.
    """
    found = {}
    next_title = None
    recoded = 0
    for split in ("train", "dev", "test"):
        path = f"{TREEBANK}/lzh_kyoto-sud-{split}.{TREEBANK_TAG}.conllu"
        if not os.path.exists(path):
            sys.exit(f"treebank not found: {path}")
        overlay = adj_overlay(split)
        blocks = open(path, encoding="utf-8").read().split("\n\n")
        at = 0
        for block in blocks:
            rows = [ln.split("\t") for ln in block.split("\n") if ln and ln[0].isdigit()]
            start, at = at, at + len(rows)
            m = re.search(r"^# sent_id = (\S+)$", block, re.M)
            if not m:
                continue
            for offset, row in enumerate(rows):
                other = overlay[start + offset]
                assert row[1] == other[1], (
                    f"{split}: the two branches disagree about token {start + offset}: "
                    f"{row[1]} against {other[1]}"
                )
                if row[3] != other[3]:
                    assert (row[3], other[3]) == ("VERB", "ADJ"), (
                        f"{split}: unexpected recoding {row[3]} → {other[3]} on {row[1]}"
                    )
                    row[3] = other[3]
            if m.group(1) == NEXT_TITLE_SID:
                next_title = rows
            key = sent_key(m.group(1))
            if key is None or key[0] > LAST_CHAPTER:
                continue
            recoded += sum(1 for row in rows if row[3] == "ADJ")
            found[m.group(1)] = (key, rows)
        assert at == len(overlay), f"{split}: {at} tokens against the overlay's {len(overlay)}"
    assert next_title is not None, f"{NEXT_TITLE_SID} not found — see reclaim_trailing_marks"
    return (
        [
            (key[0], sid, rows)
            for sid, (key, rows) in sorted(found.items(), key=lambda kv: kv[1][0])
        ],
        recoded,
        next_title,
    )


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


def repair_punct_heads(rows, sid, log):
    """Re-heads a content token that the join left hanging off a mark.

    **This is a defect in `sent_join`, not in the gold, and it is named here
    rather than quietly absorbed.** Where the pipe joins a clause onto the
    chain before it, it re-heads that clause's root on the token the previous
    unit ended at; in one block of this extract that token is a punctuation
    mark, and 孝 and 悌 in 子曰「：弟子入則孝，出則悌 come back `parataxis` of the
    ： at position 4. A mark governs nothing in SUD, so the arc is wrong
    whatever it was meant to say, and the app's own reorder engine would be
    reading a return from a token that is not a word.

    **It is rare and it is measured.** Over the whole test split — 34,233
    tokens, the same tokens the rule-merged branch holds — exactly **2** tokens
    in **1** block hang off a mark, and over dev's 38,739 not one does. The
    rule-merged branch has none, which is what says this arrived with the join.

    The repair is the smallest one that names an annotation rather than
    guessing at it: the mark's own head is what the clause attaches to, since
    the mark was standing in that position and marks take their head from the
    thing they punctuate. 孝 and 悌 become `parataxis` of 曰, which is the token
    the ： itself hangs off and the verb whose speech they are. It is asserted
    that the new head is a word, so a chain of marks cannot slip through.

    **Upstream is where this belongs.** `sent_join` should skip back over
    punctuation when it picks the token to re-head onto; until it does, every
    corpus built from this branch carries the same two arcs.
    """
    by_id = {row[0]: row for row in rows}
    for row in rows:
        head = by_id.get(row[6])
        if row[3] == "PUNCT" or head is None or head[3] != "PUNCT":
            continue
        new_head = by_id.get(head[6])
        assert new_head is not None and new_head[3] != "PUNCT", (
            f"{sid}: {row[1]} hangs off the mark {head[1]}, whose own head is not a word"
        )
        # **And where the mark's head is the speech verb, the clause belongs to
        # the quotation and not to the verb.** The mark in 子曰：「弟子入則孝，
        # 出則悌，… is the ： between 曰 and its quotation, so the mark's own head
        # is 曰 — but 孝 and 悌 are not things 曰 does, they are the saying, and
        # the saying already has a head: the `comp:obj` 弟子 that opens it.
        # Hung on 曰 instead they left that complement a subtree of one word,
        # and both panels then read the quotation as a *name* — 子弟子を曰ひ、
        # 「入りて則ち孝し… — the frame stranded and a を on the opening word.
        # 學而 3 is the same shape annotated the other way (鮮矣仁 hangs off the
        # complement 言, not off 曰) and reads correctly, which is what says
        # which of the two attachments is this treebank's own.
        if COMMUNICATION_XPOS_PREFIX in new_head[4]:
            complement = next(
                (
                    r
                    for r in rows
                    if r[6] == new_head[0] and r[7] in ("comp:obj", "comp:pred") and r[3] != "PUNCT"
                ),
                None,
            )
            if complement is not None and int(complement[0]) < int(row[0]):
                new_head = complement
        row[6] = new_head[0]
        log.append(
            f"{sid}: {row[1]} was {row[7]} of the mark {head[1]}; re-headed on {new_head[1]} "
            f"(a sent_join defect — see repair_punct_heads)"
        )


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


def reclaim_trailing_marks(rows, sid, next_title, log):
    """Takes back the 。」 that closes 學而 and is filed under 為政.

    **The other side of the fault the old cut answered.** The gold ends this
    篇 with 患不知人也。」 — the 。 and the 」 following the *next* 篇's heading in
    the source, because each mark is emitted at the position of the token it
    hangs off and those two hang off tokens in different paragraphs. The
    rule-merged branch ran the heading into 學而's last chapter, so the extract
    had to cut 為政篇第二 out of it and re-root what remained. Joining by
    paragraph puts the heading where it belongs, under 卷二 — and takes the two
    marks with it, leaving this extract's last chapter with an opening 「 and
    nothing to close it, which the balance check at the foot of `main` catches.

    So the heading is no longer this script's to remove, and the marks are its
    to take back. The run must be punctuation to its end and must follow
    `NEXT_HEADING` character for character, or nothing is taken and the
    assertion says why; the marks are re-headed on the chapter's own root,
    since the token they hung off is not in this file.
    """
    forms = [r[1] for r in next_title]
    stop = len(forms)
    while stop and next_title[stop - 1][3] == "PUNCT":
        stop -= 1
    marks = next_title[stop:]
    assert "".join(forms[:stop]) == NEXT_HEADING, (
        f"{NEXT_TITLE_SID}: {''.join(forms[:stop])} is not {NEXT_HEADING}"
    )
    if not marks:
        return
    root = next(r[0] for r in rows if r[6] == "0")
    for mark in marks:
        row = list(mark)
        row[0] = str(len(rows) + 1)
        row[6], row[7] = root, "punct"
        rows.append(row)
    log.append(
        f"{sid}: took back {''.join(m[1] for m in marks)} from {NEXT_TITLE_SID}, "
        f"where the gold files the mark that closes this 篇"
    )


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
    blocks, recoded, next_title = read_blocks()
    if not blocks:
        sys.exit(f"no {WORK} blocks found in {TREEBANK}")

    log, title_log, cut_log, head_log = [], [], [], []
    out = []
    seen_chapters = set()
    for index, (chapter, sid, rows) in enumerate(blocks):
        # Before the swap, which asserts that neither mark is a head — an
        # assertion this repair is what makes true. See `repair_punct_heads`.
        repair_punct_heads(rows, sid, head_log)
        fix_mark_order(rows, sid, log)
        # The 篇 heading, which is the first block and nothing else — on this
        # branch that is simply true, the heading being a paragraph of its own;
        # see `sent_key` for the merge that used to make it otherwise.
        if index == 0:
            read_title(rows, title_log)
        if index == len(blocks) - 1:
            reclaim_trailing_marks(rows, sid, next_title, cut_log)
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
    print(f"  {recoded} stative predicates tagged ADJ, from {ADJFIX_TAG.split('.')[-1]}")
    for line in title_log + cut_log + head_log:
        print(f"  {line}")
    print(f"  {len(log)} mark-order corrections:")
    for line in log:
        print(f"    {line}")


if __name__ == "__main__":
    main()
