#!/usr/bin/env python3
"""The treebank's own xpos inventory, as a table the app can offer in a menu.

The Kyoto SUD treebank writes a four-field xpos on every token —
``v,動詞,行為,動作``, ``n,名詞,人,役割``, ``p,助詞,句末,*`` — and the four
fields are two facts, not four:

  * the **syntactic prefix**, fields 1-2 (``v,動詞``): a one-letter class and
    the 品詞.  This is what UPOS also states, in a different vocabulary.
  * the **semantic pair**, fields 3-4 (``行為,動作``): a domain and a sense
    within it, which UPOS does not state at all.  ``*`` where the scheme
    records none.

The app's token inspector offers UPOS and deprel from hand-written
inventories, because both are small closed sets a reader can reason about.
The xpos inventory is neither hand-writable nor closed by inspection: it is
122 distinct tags over twelve prefixes, and which semantic pairs are *real*
is a fact about the treebank rather than about the scheme.  So it is read off
the treebank instead, here, and shipped as data.

**Counts are kept and they are load-bearing.**  The inspector shades its menu
items by how likely the model thinks each option is; for xpos there is no
model to ask, and the treebank's own frequency is the honest stand-in.  They
also decide the canonical ordering — a menu that offers 行為/動作 (9,170) above
干支 (2) is offering the reader the answer they almost certainly want first.

**UPOS is derived from the xpos, and this file carries the table that does
it.**  The inspector shows the treebank's own 品詞 and semantic pair, because
that is the vocabulary the annotation is actually written in; UPOS is the
interoperable restatement and is computed rather than chosen.  For that to be
honest the derivation has to be a function, and the xpos alone is not one:

    v,動詞,行為,動作   VERB 40,529   ADV 5,796
    v,動詞,存在,存在   VERB  6,971   AUX 2,790
    v,動詞,描写,形質   ADJ   8,098   ADV 1,612

— a verb used adverbially and the copular 爲 wear the same tag as the plain
verb.  What separates them is already on the token: **VerbForm and VerbType**,
and those two features alone settle it.  Measured over the whole treebank, the
majority UPOS given the key is

    xpos alone                          96.936%   (122 keys)
    xpos + VerbForm                     99.463%   (166 keys)
    xpos + VerbForm + VerbType          99.986%   (167 keys)
    …+ Degree, NounType, Case, Polarity 99.986%   (189 keys)

so two features are taken and the rest are not, the extra 22 keys buying
nothing.  The 77 residual tokens are stragglers — 48 of them an ADP reading of
``v,動詞,存在,存在`` — and the table records the majority, which is what a
menu can act on.

The correspondence is many-to-one in the other direction too (NOUN and PROPN
share ``n,名詞``; PART, CCONJ and SCONJ share ``p,助詞``; VERB, ADJ, ADV and
AUX share ``v,動詞``), which is exactly why it is the xpos that is offered and
UPOS that is computed, and not the reverse.

**Read from the ``adjfix`` branch**, not the ``sjmerged`` one this app takes
its trees from, and the difference matters here and nowhere else: ADJ is not
in the base annotation at all — a stative predicate is a plain VERB there —
and ``adjfix`` is where it is supplied.  A derivation table built off
``sjmerged`` would never produce ADJ, and the model this app ships does emit
it.  The xpos itself is identical in the two branches.

Run:

    python3 scripts/build-xpos-inventory.py

writes ``src/parse/xpos-inventory.json``.  Committed, because the app imports
it directly and a reader without the treebank must still get a working menu.
"""

from __future__ import annotations

import collections
import json
import os
import sys

TREEBANK = os.path.expanduser(
    "~/Linguistics/Tools/SUD-spaCy/assets_lzh/SUD_Classical_Chinese-Kyoto"
)
# `build-kanbun-info-corpus.py`'s `ADJFIX_TAG`, for the reason in the module
# doc: it is the only branch that carries ADJ, and the xpos is the same in both.
TREEBANK_TAG = "relabeled_ext.udep_ruled.punct.rulemerged.adjfix"
SPLITS = ("train", "dev", "test")

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "parse", "xpos-inventory.json")

# A prefix seen this many times or fewer is a typo in the treebank rather than
# a category, and is left out of the menu.  Set from the data: the twelve real
# prefixes all clear four figures, and what falls below is `s,文字` at 6.
PREFIX_FLOOR = 100
# Likewise for a semantic pair under a real prefix.  Kept much lower, because a
# rare *sense* is still a sense a reader may need to reach for (干支 is 2
# tokens and is the right tag for 甲子); this only drops single stray tokens.
SEMANTIC_FLOOR = 2

# The features the derivation keys on, in the order they are written into the
# key.  Two, because two is where the accuracy stops climbing — see the module
# doc.  A feature added here changes every key in `derivation`.
DERIVATION_FEATURES = ("VerbForm", "VerbType")


def rows(path: str):
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line or line.startswith("#") or "\t" not in line:
                continue
            cols = line.split("\t")
            if len(cols) < 5 or "-" in cols[0] or "." in cols[0]:
                continue
            yield cols


def feature_key(feats: str) -> str:
    """The derivation key's feature half: the chosen features, in a fixed order.

    Fixed rather than as written, so that `VerbType=Cop|VerbForm=Conv` and
    `VerbForm=Conv|VerbType=Cop` are one key and not two.
    """
    if feats == "_":
        return ""
    present = dict(kv.split("=", 1) for kv in feats.split("|") if "=" in kv)
    return "|".join(f"{k}={present[k]}" for k in DERIVATION_FEATURES if k in present)


def main() -> int:
    per_prefix: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    per_key: dict[tuple[str, str], collections.Counter] = collections.defaultdict(collections.Counter)
    prefix_total: collections.Counter = collections.Counter()
    malformed = 0
    tokens = 0

    for split in SPLITS:
        path = f"{TREEBANK}/lzh_kyoto-sud-{split}.{TREEBANK_TAG}.conllu"
        if not os.path.exists(path):
            print(f"missing treebank split: {path}", file=sys.stderr)
            return 1
        for cols in rows(path):
            upos, xpos = cols[3], cols[4]
            if xpos == "_":
                continue
            fields = xpos.split(",")
            if len(fields) != 4:
                malformed += 1
                continue
            prefix = ",".join(fields[:2])
            per_prefix[prefix][(fields[2], fields[3])] += 1
            per_key[(xpos, feature_key(cols[5]))][upos] += 1
            prefix_total[prefix] += 1
            tokens += 1

    prefixes = {
        prefix: {
            "count": prefix_total[prefix],
            # [domain, sense, count], most frequent first — the menu's order.
            "semantics": [
                [domain, sense, n]
                for (domain, sense), n in sorted(
                    pairs.items(), key=lambda kv: (-kv[1], kv[0])
                )
                if n >= SEMANTIC_FLOOR
            ],
        }
        for prefix, pairs in per_prefix.items()
        if prefix_total[prefix] > PREFIX_FLOOR
    }

    # xpos -> { feature key -> UPOS }.  "" is the entry for a token carrying
    # none of `DERIVATION_FEATURES`, and doubles as the fallback: a caller
    # holding a feature combination the treebank never wrote falls back to it
    # rather than to nothing.  See `uposForXpos`.
    derivation: dict[str, dict[str, str]] = collections.defaultdict(dict)
    decided = 0
    for (xpos, key), counts in sorted(per_key.items()):
        if ",".join(xpos.split(",")[:2]) not in prefixes:
            continue
        winner, n = counts.most_common(1)[0]
        derivation[xpos][key] = winner
        decided += n
    # Every xpos must be answerable with no features at all, so that a token
    # the reader has just retagged — which may carry features from its old
    # tag, or none — always resolves.  Where the treebank only ever wrote this
    # xpos with a feature, its commonest answer stands in.
    for xpos, table in derivation.items():
        if "" not in table:
            table[""] = collections.Counter(
                upos
                for (x, _), counts in per_key.items()
                if x == xpos
                for upos, n in counts.items()
                for _ in range(n)
            ).most_common(1)[0][0]

    payload = {
        "_": (
            "Generated by scripts/build-xpos-inventory.py from the Kyoto SUD "
            f"treebank ({TREEBANK_TAG}, {len(SPLITS)} splits, {tokens} tokens). "
            "Do not edit by hand; see that script for what the fields mean."
        ),
        "tokens": tokens,
        "features": list(DERIVATION_FEATURES),
        "prefixes": prefixes,
        "derivation": {xpos: dict(sorted(table.items())) for xpos, table in sorted(derivation.items())},
    }

    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
        handle.write("\n")

    kept = sum(len(v["semantics"]) for v in prefixes.values())
    keys = sum(len(t) for t in derivation.values())
    print(f"{tokens} tokens, {len(prefixes)} prefixes, {kept} distinct xpos")
    print(f"derivation: {keys} keys over {len(derivation)} xpos, "
          f"majority UPOS agrees with {decided}/{tokens} = {decided / tokens:.4%}")
    if malformed:
        print(f"  ({malformed} tokens whose xpos was not four fields, skipped)")
    for xpos, table in sorted(derivation.items()):
        if len(set(table.values())) > 1:
            print(f"  {xpos}: " + "  ".join(f"{k or '(none)'}->{v}" for k, v in table.items()))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
