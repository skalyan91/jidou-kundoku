#!/usr/bin/env python3
"""Fills the on'yomi gaps `build-historical-kana-index.mjs` cannot attest.

Run *after* that script, on the index it writes: this reads
public/data/historical-kana-index.json, adds the readings Wiktionary does not
attest, and writes it back, plus a sidecar naming what it added.

WHY A SECOND SOURCE IS NEEDED AT ALL. A kanbun token is a single character,
so only single-character keys in that index can ever match one, and English
Wiktionary annotates historical kana on very few single-kanji on'yomi
entries. Aligning compounds recovers a great many more (see that script), but
measured against a real corpus it still left 20 of 48 must-correct on'yomi
uncovered — 生 しょう, 敬 きょう, 名 みょう and the like, all of them common.

WHY THE ANSWER IS DERIVABLE. The historical spelling of an on'yomi is a
lexical fact about the character: it follows from which Middle Chinese rime
the character belongs to. 京 きょう is きやう and 教 きょう is けう; 相 しょう
is しやう and 消 しょう is せう; 王 おう is わう and 央 おう is あう. Both
members of each pair are spelled identically in modern kana, which is exactly
why no rule over the modern form can work, and why the *character* has to be
consulted. `Qieyun` (nk2028, MIT) gives each character its 音韻地位 — its
position in the 切韻 system, 母/韻/等/呼/聲 — which is that fact.

WHY THE TABLE IS LEARNED RATHER THAN WRITTEN DOWN. Mapping a rime to a kana
spelling by hand is a large table to author from memory and a silent source
of error if any row is wrong: the competing candidates all normalise to the
same modern reading, so a wrong row cannot be caught by checking the modern
form against itself. Instead the correspondence is learned from the pairs
Wiktionary *does* attest, keyed by (攝, 等, 呼, modern reading), and its
accuracy is then measured by leaving each character out in turn — training on
every other character's attestations and predicting that one's. A rule is
credited only when it transfers to a character it was not learned from.

Measured that way: 97.7% correct over 886 predictions, abstaining on 117
where no attested character shares the key. Abstentions are left uncorrected
rather than guessed.

Qieyun's data is the 廣韻, via nk2028's package (MIT-licensed code, and the
rime data itself is a Song-dynasty dictionary); see
public/data/LICENSE-Qieyun.txt.
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

try:
    from Qieyun import 字頭2音韻地位_出處們
except ImportError:
    sys.exit("Qieyun not installed — `pip install qieyun` (dev-time only, like fontTools).")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data"
INDEX = DATA / "historical-kana-index.json"
SIDECAR = DATA / "historical-kana-derived.json"

KATAKANA_TO_HIRAGANA = {chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)}

# 歴史的仮名遣い writes 拗音 full-size — きやう, not きゃう. Some Wiktionary
# editors write their historical annotations with the modern small kana
# anyway, and 6 values arrive that way (長 じょう->じゃう among them) where they
# would reach the page. Folding them is purely orthographic and loses nothing:
# the small and full-size forms denote the same syllable, and the rest of the
# index already writes them full-size, so this is what makes the corpus answer
# in one convention. `kanjidicLookup.ts` applies the same fold on the other
# side of the lookup, to a kun'yomi the index does not attest at all.
SMALL_TO_FULL = {"ゃ": "や", "ゅ": "ゆ", "ょ": "よ"}


def full_size_yoon(s: str) -> str:
    return "".join(SMALL_TO_FULL.get(c, c) for c in s)


def to_hiragana(s: str) -> str:
    return "".join(KATAKANA_TO_HIRAGANA.get(c, c) for c in s)


def positions(char: str):
    """Every 音韻地位 the 廣韻 gives this character. More than one is normal —
    a character read two ways in Middle Chinese has two — and they are all
    used as keys, since the modern reading in hand selects between them."""
    try:
        return [entry[0] for entry in 字頭2音韻地位_出處們(char)]
    except Exception:
        return []


def keys_for(char: str, modern: str, cache):
    if char not in cache:
        cache[char] = positions(char)
    return [(p.攝, p.等, p.呼, modern) for p in cache[char]]


def main() -> None:
    index = json.loads(INDEX.read_text(encoding="utf-8"))
    kanjidic = json.loads((DATA / "kanjidic-index.json").read_text(encoding="utf-8"))

    # What a previous run of this script put into the index, so that it can be
    # excluded from what the next one learns. The script writes back into the
    # file it reads, so without this it trains on its own output: run twice,
    # the training set went from 968 attested pairs to 4861 and the held-out
    # accuracy from 97.7% to a meaningless 99.4%, the derivation now mostly
    # predicting derivations. Reading the sidecar back is what makes a second
    # run produce the same index as the first.
    previously_derived = (
        json.loads(SIDECAR.read_text(encoding="utf-8")) if SIDECAR.exists() else {}
    )

    # The on'yomi of every character KANJIDIC knows, as hiragana — the set this
    # is responsible for. Kun'yomi are left entirely to attestation: they are
    # native vocabulary and have no rime to derive from.
    onyomi = {(ch, to_hiragana(o)) for ch, e in kanjidic.items() for o in e.get("on", [])}

    attested = {
        (ch, modern): hist
        for ch, readings in index.items()
        if len(ch) == 1
        for modern, hist in readings.items()
        if previously_derived.get(ch, {}).get(modern) is None
    }
    training = [(ch, m, h) for (ch, m), h in attested.items() if (ch, m) in onyomi]

    cache: dict = {}
    training = [t for t in training if keys_for(t[0], t[1], cache)]
    print(f"Learning from {len(training)} attested on'yomi pairs over {len({t[0] for t in training})} characters.")

    # Leave-one-CHARACTER-out: every pair of a character is held out together,
    # so a rule is only credited when it carries to an unseen character rather
    # than recalling one it was built from.
    by_char = defaultdict(list)
    for ch, m, h in training:
        by_char[ch].append((m, h))
    correct = wrong = abstain = 0
    for held in by_char:
        table = defaultdict(Counter)
        for ch, m, h in training:
            if ch == held:
                continue
            for k in keys_for(ch, m, cache):
                table[k][h] += 1
        for m, h in by_char[held]:
            votes = Counter()
            for k in keys_for(held, m, cache):
                votes.update(table.get(k, {}))
            if not votes:
                abstain += 1
            elif votes.most_common(1)[0][0] == h:
                correct += 1
            else:
                wrong += 1
    total = correct + wrong
    print(f"Held-out accuracy: {correct}/{total} ({100 * correct / max(1, total):.1f}%), abstained on {abstain}.")

    table = defaultdict(Counter)
    for ch, m, h in training:
        for k in keys_for(ch, m, cache):
            table[k][h] += 1

    # Carried forward, not started empty: a second run derives nothing new,
    # and a sidecar rewritten with that empty result would lose the record of
    # which pairs are derived — which is both the provenance and the thing
    # that keeps the next run from training on them.
    derived: dict = {ch: dict(readings) for ch, readings in previously_derived.items()}
    added = abstained = 0
    for ch, modern in sorted(onyomi):
        if index.get(ch, {}).get(modern) is not None:
            continue
        votes = Counter()
        for k in keys_for(ch, modern, cache):
            votes.update(table.get(k, {}))
        if not votes:
            abstained += 1
            continue
        hist = votes.most_common(1)[0][0]
        if hist == modern:
            continue
        index.setdefault(ch, {})[modern] = hist
        derived.setdefault(ch, {})[modern] = hist
        added += 1

    folded = 0
    for ch, readings in index.items():
        for modern, hist in list(readings.items()):
            folded_hist = full_size_yoon(hist)
            if folded_hist != hist:
                readings[modern] = folded_hist
                folded += 1

    print(f"Derived {added} on'yomi the dump does not attest; abstained on {abstained} with no comparable character.")
    print(f"Folded {folded} attested values written with modern small 拗音 to the full-size historical convention.")
    INDEX.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    SIDECAR.write_text(json.dumps(derived, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {INDEX} and {SIDECAR}.")


if __name__ == "__main__":
    main()
