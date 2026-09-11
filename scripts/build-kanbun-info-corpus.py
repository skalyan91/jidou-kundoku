#!/usr/bin/env python3
"""Builds the corpus `tests/kanbunInfoCorpus.test.ts` measures against:

    tests/fixtures/kanbun-info-passages.json   the 白文, the received 書き下し文,
                                               and each passage's provenance
    tests/fixtures/kanbun-info-parses.conllu   one parse per passage

**Neither of those is in the repository, and this script is the only way to get
them.** The 白文 is out of copyright; the 書き下し文 beside it is kanbun.info's
own editorial rendering, which this project compares against but does not hand
on, so both files are in `.gitignore` and the suite skips where they are
absent. What *is* committed is `kanbun-info-baseline.json` — our own per-passage
measurements, and no fetched text.

Four stages, and only the first touches the network:

    build-kanbun-info-corpus.py index    crawl the section indexes for the
                                         passage URLs (CACHE/urls.json)
    build-kanbun-info-corpus.py fetch    fetch those pages into CACHE
    build-kanbun-info-corpus.py extract  pull 白文 + 書き下し文 out of the cache
    build-kanbun-info-corpus.py ruby     pull the site's furigana out of the same
    build-kanbun-info-corpus.py parse    source a parse for each passage

`index` and `fetch` are written to be a considerate client of a static site:
one request at a time, 0.7s apart, and a page already in CACHE is never asked
for again, so a re-run after a failure resumes rather than re-crawls. 863
requests all told, once.

**The parses come from two places and the suite turns on the difference.**
A passage whose 白文 appears verbatim in the Kyoto SUD treebank is given the
treebank's own annotation — a *gold* parse, correct by construction, so every
difference the suite then measures is this app's own. A passage that is not
there is run through the shipped parser (`lzh_sud_kyoto`, the same wheel
`public/wasm/wheels/` serves the browser), whose mistakes are its own and not
the app's. `tier` in the JSON says which, and the test never mixes them.

Running `parse` needs the parser installed locally:

    python3.13 -m venv /tmp/lzhvenv
    /tmp/lzhvenv/bin/pip install spacy==3.8.15
    /tmp/lzhvenv/bin/pip install public/wasm/wheels/lzh_sud_kyoto-*.whl \
                                public/wasm/wheels/annotated_doc-*.whl

python3.13 and spacy 3.8.15 to match the wheel the browser loads (the Pyodide
build is cp313 and pins that spaCy); a different pair will load the model but
is no longer a promise about what the app itself produces.

Nothing here runs in CI.
"""

import collections
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = "/tmp/kanbuninfo"
FIXTURES = os.path.join(ROOT, "tests", "fixtures")

# The Kyoto treebank, on the **sentence-joined** branch and with the ADJ
# recoding laid over it.
#
# **Why `sjmerged` and not `rulemerged`.** Both hold the same gold trees over
# the same tokens and differ only in where a sentence is held to end.
# `rulemerged` fills a boundary only where `cross_unit_rules.py` finds >= 90%
# dominance for it — 37.1% of them — and leaves every other 句讀 unit standing
# as its own sentence, which cuts a quotation at each of its internal commas:
# 子曰：「學而時習之， as one sentence and 不亦說乎？ as the next, the 「 left open
# across three. `sjmerged` runs the parser's own `SentJoin` pipe over the gold
# instead (scripts/merge_lzh_clauses.py in the SUD-spaCy tree, grouping by
# kanripo paragraph), and that pipe refuses a boundary inside an open quoted
# span unconditionally. Over the test split, blocks whose 「 and 」 do not
# balance fall from 9.35% to 2.37%.
#
# It is also the app's own convention, which is the stronger reason: the
# shipped wheel carries the same `sent_join` pipe, so a text pasted into the
# box is segmented this way and every parser-tier passage in this corpus
# already is. Taking gold from `rulemerged` meant the two tiers were segmented
# by different rules, and the gold tier — the one whose differences are held to
# be *ours* — was the one segmented against the app.
#
# **The ADJ recoding is laid over it, because the joined branch predates it.**
# `adjfix` is the ADJ/VERB split parser 0.3.2 introduced, and a gold parse
# without it would disagree with the app's own POS assumptions on roughly a
# sixth of its predicates (see `isLexicalPredicate`). It was applied to the
# `rulemerged` branch and never to this one. It is a **pure UPOS overlay** —
# diffed column by column over the test split the two files differ in the UPOS
# column and in no other, on 1,349 tokens, every one VERB -> ADJ — and both
# branches hold the same tokens in the same order, which `Gold` asserts rather
# than trusts. So the tags transfer by position and the corpus gets the joined
# sentences and the 0.3.2 categories together instead of having to choose.
TREEBANK = os.path.expanduser(
    "~/Linguistics/Tools/SUD-spaCy/assets_lzh/SUD_Classical_Chinese-Kyoto"
)
TREEBANK_TAG = "relabeled_ext.udep_ruled.punct.sjmerged"
ADJFIX_TAG = "relabeled_ext.udep_ruled.punct.rulemerged.adjfix"

UA = "jidou-kundoku corpus builder (non-commercial research tool; one-off fetch)"

HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿\U00020000-\U0002FFFF]")
KANA = re.compile(r"[ぁ-ゖァ-ヺ]")


# ---------------------------------------------------------------------------
# index
# ---------------------------------------------------------------------------

# The site's own sitemap divides into 経部 / 史部 / 子部 / 集部 plus 故事名言.
# Everything below is the prose; **the 集部 is excluded entire** — 詩経, 楚辞,
# 二十四詩品, 漢詩, 唐詩選 and the poet indexes are all verse, and kundoku of
# verse is a different art this app is not aimed at. Listed rather than walked
# from the sitemap so that adding or dropping a work is a visible edit here,
# and checked against the sitemap by `index` each time it runs.
SECTION_INDEXES = {
    "keibu/rongo00.html": "論語",              # two levels: 篇 index, then 章
    "keibu/daigaku00.html": "大学",
    "keibu/kokyo00.html": "孝経",
    "shibu01/shiki000.html": "史記（抄）",
    "shibu02/roushi00.html": "老子",
    "shibu02/sonshi00.html": "孫子",
    "shibu02/goshi00.html": "呉子",
    "shibu02/shiba00.html": "司馬法",
    "shibu02/utsuryo00.html": "尉繚子",
    "shibu02/montai00.html": "李衛公問対（抄）",
    "shibu02/rikutou00.html": "六韜",
    "shibu02/sanryaku00.html": "三略",
}
TWO_LEVEL = {"keibu/rongo00.html"}
KOJI_INDEXES = [f"koji/koji00{k}.html" for k in
                ("a", "ka", "sa", "ta", "na", "ha", "ma", "ya", "ra")]

BODY_LINK = re.compile(r'<a href="([^"]+\.html)"[^>]*>(.*?)</a>', re.S)
KOJI_LINK = re.compile(r'<td class="cell_left03"><a href="([^"]+)"[^>]*>(.*?)</a>', re.S)


def _get(path):
    """One page, from CACHE if it is there and from the site if it is not."""
    out = os.path.join(CACHE, "pages", path.replace("/", "_"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if not (os.path.exists(out) and os.path.getsize(out) > 500):
        req = urllib.request.Request("https://kanbun.info/" + path, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            open(out, "wb").write(r.read())
        time.sleep(0.7)
    return open(out, encoding="utf-8-sig", errors="replace").read()


def _body_links(html):
    """The links inside the <article>, which are the passages; the ones outside
    it are the site-wide navigation, repeated on every page."""
    a, b = html.find("<article"), html.find("ninja_onebutton")
    body = html[a:b] if a >= 0 else html
    for m in BODY_LINK.finditer(body):
        href, title = m.group(1), re.sub(r"<[^>]+>|&nbsp;|\s+", " ", m.group(2)).strip()
        if href.startswith(("http", "..", "#")):
            continue
        yield href.split("/")[-1], title


def index():
    urls = {}
    sitemap = _get("sitemap/sitemap.html")
    for path in list(SECTION_INDEXES) + KOJI_INDEXES[:1]:
        if path.split("/")[-1] not in sitemap:
            print(f"WARNING: {path} is no longer linked from the sitemap", flush=True)

    for path, work in SECTION_INDEXES.items():
        folder = path.split("/")[0]
        tier1 = list(_body_links(_get(path)))
        if path in TWO_LEVEL:
            # 論語 indexes its 篇, and each 篇 page lists its 章 — and then
            # repeats the 篇 navigation at the foot of its own article, inside
            # the same <article> the chapter links are in. `seen` is what keeps
            # those twenty pages out of the corpus as passages of their own.
            seen = {href for href, _ in tier1}
            pages = [(h, t) for href, _ in tier1
                     for h, t in _body_links(_get(f"{folder}/{href}")) if h not in seen]
        else:
            pages = tier1
        for href, title in pages:
            urls.setdefault(f"{folder}/{href}", {"work": work, "section": path, "title": title})

    # 故事名言, the site's own collection of famous passages. Only the entries
    # whose source bracket is something other than ［論語］: the 762 論語 ones
    # are the same chapters the 論語 pages already carry, and the ~284 entries
    # with no bracket at all are 四字熟語 headwords with no 白文 behind them.
    # A ⇒ in the title is a cross-reference to another entry, not an entry.
    for path in KOJI_INDEXES:
        for m in KOJI_LINK.finditer(_get(path)):
            title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
            sources = re.findall(r"［([^］]+)］", title)
            if "⇒" in title or not sources or "論語" in sources:
                continue
            urls.setdefault("koji/" + m.group(1).split("/")[-1],
                            {"work": "故事名言", "section": path, "title": title})

    json.dump(urls, open(os.path.join(CACHE, "urls.json"), "w"), ensure_ascii=False, indent=1)
    counts = collections.Counter(v["work"] for v in urls.values())
    print(f"{len(urls)} passage pages")
    for work, n in counts.most_common():
        print(f"  {work} {n}")


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------

def fetch():
    urls = json.load(open(os.path.join(CACHE, "urls.json"), encoding="utf-8"))
    os.makedirs(os.path.join(CACHE, "pages"), exist_ok=True)
    for path in urls:
        out = os.path.join(CACHE, "pages", path.replace("/", "_"))
        if os.path.exists(out) and os.path.getsize(out) > 500:
            continue
        req = urllib.request.Request("https://kanbun.info/" + path, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                open(out, "wb").write(r.read())
        except Exception as e:  # noqa: BLE001 — a miss is reported, not fatal
            print("FAIL", path, e, flush=True)
        time.sleep(0.7)  # static pages, fetched once; no reason to hurry the host


# ---------------------------------------------------------------------------
# extract
# ---------------------------------------------------------------------------

RUBY_RT = re.compile(r"<rp>.*?</rp>|<rt>.*?</rt>", re.S)
TAG = re.compile(r"<[^>]+>")
# "001（01-01）" heads a 論語 chapter, "01 " a 大学/老子 section, "【一】" a 孝経 one.
LEAD = re.compile(r"^(?:\d+（[\d\-]+）|\d{1,3}[　\s]?|【[^】]+】)")
# 〔開宗明義章第一〕（古文）, 〔補伝〕, 〔史記、廉頗藺相如列伝〕 — the editor's own
# label for the passage, printed inside the 白文 div and not part of the text.
# Only leading ones, and only these two shapes: a 大学 passage really does carry
# a parenthesised 彼爲善之、 mid-text, which is text and stays.
LABEL = re.compile(r"^(?:〔[^〕]*〕|（(?:古文|今文)）)+")
# The site prints the 白文 in a `genbun0N` div and its 訓読 in the `yomi0N` div
# that follows, with an occasional empty anchor div between them. Both classes
# are numbered (genbun01/02, yomi01/02/03) with no difference in content — the
# number varies with the page's own styling. `(?:(?!</div>).)*?` rather than
# `.*?` because the lazy form will happily swallow a whole run of divs to reach
# the next `yomi` one, which is how 六韜's 訓読-in-the-白文 first appeared.
PAIR = re.compile(
    r'<div class="genbun0[12]">((?:(?!</div>).)*?)</div>\s*(?:<div[^>]*>\s*</div>\s*)*'
    r'<div class="yomi0[123]">((?:(?!</div>).)*?)</div>',
    re.S,
)


def detag(s):
    """The base text of a ruby run, with the furigana dropped: the site writes
    every reading as <ruby>子<rp>（</rp><rt>し</rt><rp>）</rp></ruby>, and it is
    the 子 this suite compares against, not the し."""
    s = RUBY_RT.sub("", s)
    s = s.replace("<br />", "").replace("<br>", "")
    s = TAG.sub("", s).replace("&nbsp;", "").replace("&amp;", "&")
    return re.sub(r"\s+", "", s)


def extract():
    urls = json.load(open(os.path.join(CACHE, "urls.json"), encoding="utf-8"))
    corpus = []
    for path, meta in urls.items():
        f = os.path.join(CACHE, "pages", path.replace("/", "_"))
        if not os.path.exists(f):
            continue
        html = open(f, encoding="utf-8-sig", errors="replace").read()
        a, b = html.find("<article"), html.find("ninja_onebutton")
        body = html[a:b] if a >= 0 else html
        n = 0
        for m in PAIR.finditer(body):
            han = LABEL.sub("", LEAD.sub("", detag(m.group(1))))
            yomi = detag(m.group(2))
            # A 故事名言 page opens with the saying in Japanese, in the same div
            # class the 白文 uses elsewhere. Kana in a 白文 is the tell, and the
            # only one there is: the block is otherwise indistinguishable.
            if not han or not yomi or KANA.search(han):
                continue
            n += 1
            corpus.append({
                "id": f"{path.split('/')[-1][:-5]}#{n}",
                "page": path,
                "work": meta["work"],
                "title": meta["title"],
                "han": han,
                "yomi": yomi,
            })
    json.dump(corpus, open(os.path.join(CACHE, "corpus.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{len(corpus)} passages from {len({c['page'] for c in corpus})} pages")


# ---------------------------------------------------------------------------
# ruby: the site's own furigana, which `detag` above throws away
# ---------------------------------------------------------------------------

RUBY = re.compile(r"<ruby>(.*?)<rp>（</rp><rt>([^<]*)</rt><rp>）</rp></ruby>", re.S)


def ruby():
    """Writes tests/fixtures/kanbun-info-ruby.json — the readings the site
    prints over its own 書き下し文.

    **Why this is a stage of its own and not a field on a passage.** `detag`
    strips every `<rt>` by design, because what the distance compares is the
    prose and the prose is the base text. That was the right call for the
    distance and the wrong one for everything else: a reading is invisible to a
    character-level comparison of two strings that both keep the kanji, so
    每 defect the reader has caught by eye this session — くりて for きたり,
    シリング for こころざし, ことる for ことなり, 斯 read か, 得 read え where the
    form wants う — scored as a perfect match. The site publishes the answer to
    all of them: **68,505 ruby runs over 98.6% of its 書き下し文 blocks**, 62,712
    of them a single character.

    It is written beside the passages rather than into them so that
    `kanbun-info-passages.json` and every baseline keyed against it stay byte
    for byte what they were — this adds an instrument and moves no number.

    The ids are `extract`'s, rebuilt by the same walk under the same skip
    conditions, so the two files key together. Only the 書き下し文 side is read:
    a 白文 carries no reading, and the site's 注釈 below it carries readings for
    words it is *discussing*, which are not this text's.
    """
    urls = json.load(open(os.path.join(CACHE, "urls.json"), encoding="utf-8"))
    out, runs = {}, 0
    for path, meta in urls.items():
        f = os.path.join(CACHE, "pages", path.replace("/", "_"))
        if not os.path.exists(f):
            continue
        html = open(f, encoding="utf-8-sig", errors="replace").read()
        a, b = html.find("<article"), html.find("ninja_onebutton")
        body = html[a:b] if a >= 0 else html
        n = 0
        for m in PAIR.finditer(body):
            han = LABEL.sub("", LEAD.sub("", detag(m.group(1))))
            yomi = detag(m.group(2))
            if not han or not yomi or KANA.search(han):
                continue
            n += 1
            pairs = [
                [TAG.sub("", base), rt]
                for base, rt in RUBY.findall(m.group(2))
                if TAG.sub("", base) and rt
            ]
            if not pairs:
                continue
            out[f"{path.split('/')[-1][:-5]}#{n}"] = pairs
            runs += len(pairs)
    dst = os.path.join(FIXTURES, "kanbun-info-ruby.json")
    json.dump(out, open(dst, "w"), ensure_ascii=False, indent=0)
    print(f"{runs} ruby runs over {len(out)} passages -> {dst}")


# ---------------------------------------------------------------------------
# parse: gold where the treebank has it, the shipped parser where it does not
# ---------------------------------------------------------------------------

def read_conllu(path):
    sid, cur = None, []
    for line in open(path, encoding="utf-8"):
        line = line.rstrip("\n")
        if line.startswith("# sent_id ="):
            sid = line.split("=", 1)[1].strip()
            continue
        if line.startswith("#"):
            continue
        if not line.strip():
            if cur:
                yield sid, cur
            sid, cur = None, []
            continue
        f = line.split("\t")
        if "-" in f[0] or "." in f[0]:  # MWT range / empty node
            continue
        cur.append(f)
    if cur:
        yield sid, cur


class Gold:
    """The treebank as one string, so a 白文 can be looked for in it.

    Two things stand between the site's text and the corpus's. The corpus
    punctuates its own way and splits into its own sentences, so both sides are
    reduced to their Han characters before comparison and a site passage is
    allowed to span several corpus sentences. And the two use different graphs
    for the same character — 為/爲, 卽/即, 眾/衆. The fold for that is learnt
    from the corpus itself rather than written by hand: where a token's FORM and
    LEMMA are different single Han characters they are graphic variants of one
    word, and the LEMMA column is already the 舊字體 kanbun.info prints.
    """

    def __init__(self):
        self.sents = []
        recoded = 0
        for split in ("train", "dev", "test"):
            p = f"{TREEBANK}/lzh_kyoto-sud-{split}.{TREEBANK_TAG}.conllu"
            # The ADJ overlay, read off the `adjfix` branch of the same split
            # and applied by position — see `ADJFIX_TAG` for why that is sound
            # and what it is for. The two branches are re-segmentations of one
            # corpus, so the token sequences are identical; that is asserted
            # here, form by form, before a single tag is taken.
            overlay = [
                f for _, toks in read_conllu(f"{TREEBANK}/lzh_kyoto-sud-{split}.{ADJFIX_TAG}.conllu")
                for f in toks
            ]
            at = 0
            for sid, toks in read_conllu(p):
                for f in toks:
                    other = overlay[at]
                    at += 1
                    assert f[1] == other[1], (
                        f"{split}: the two branches disagree about token {at - 1}: {f[1]} against {other[1]}"
                    )
                    if f[3] != other[3]:
                        assert (f[3], other[3]) == ("VERB", "ADJ"), \
                            f"{split}: unexpected recoding {f[3]} -> {other[3]} on {f[1]}"
                        f[3] = other[3]
                        recoded += 1
                self.sents.append((split, sid, toks))
            assert at == len(overlay), f"{split}: {at} tokens against the overlay's {len(overlay)}"
        self.recoded = recoded
        self.fold = {}
        for _, _, toks in self.sents:
            for f in toks:
                if len(f[1]) == 1 and len(f[2]) == 1 and f[1] != f[2] \
                        and HAN.match(f[1]) and HAN.match(f[2]):
                    self.fold[f[1]] = f[2]
        buf, self.starts, self.ends, pos = [], {}, {}, 0
        for i, (_, _, toks) in enumerate(self.sents):
            t = self.norm("".join(f[1] for f in toks))
            self.starts.setdefault(pos, i)
            buf.append(t)
            pos += len(t)
            self.ends.setdefault(pos, i)
        self.big = "".join(buf)

    def norm(self, s):
        return "".join(self.fold.get(c, c) for c in s if HAN.match(c))

    @staticmethod
    def docid(sid):
        # KR1h0004_004_par1_1-2 -> KR1h0004_004. The Kanseki Repository work
        # and juan, which is what says a hit is the passage rather than a
        # coincidence of common characters spread over two unrelated books.
        return re.split(r"_(?:par|title|body|colophon)", sid)[0]

    def find(self, han):
        """The run of whole consecutive gold sentences whose text is exactly
        this 白文, or None. Both ends must fall on a sentence boundary: a
        passage that is only part of a gold sentence would give only part of a
        tree, which is not a gold parse of anything."""
        key = self.norm(han)
        if len(key) < 4:  # too short to be identified by its characters alone
            return None
        hits = []
        p = self.big.find(key)
        while p != -1:
            if p in self.starts and p + len(key) in self.ends:
                i, j = self.starts[p], self.ends[p + len(key)]
                docs = {self.docid(self.sents[k][1]) for k in range(i, j + 1)}
                if len(docs) == 1:
                    hits.append((i, j, docs.pop()))
            p = self.big.find(key, p + 1)
        return hits[0] if len(hits) >= 1 else None

    def stitch(self, han, i, j):
        """The gold sentences i..j as CoNLL-U blocks, with each Han character's
        FORM taken from the site's own text.

        The tree is the treebank's; the orthography is the site's. Left as the
        corpus writes it, a 為 the site prints as 爲 would send the reading
        resolver to a different kanjidic entry and produce a difference this
        suite would have to explain away as orthography — which is exactly the
        axis it normalises. Punctuation keeps the corpus's own marks, since the
        tree hangs off them."""
        site = [c for c in han if HAN.match(c)]
        k = 0
        blocks = []
        for idx in range(i, j + 1):
            _, sid, toks = self.sents[idx]
            rows = []
            for f in toks:
                f = list(f)
                if HAN.match(f[1] or " "):
                    out = []
                    for ch in f[1]:
                        out.append(site[k] if HAN.match(ch) else ch)
                        if HAN.match(ch):
                            k += 1
                    f[1] = "".join(out)
                rows.append("\t".join(f))
            blocks.append((sid, rows))
        assert k == len(site), f"surface remap fell out of step: {k} vs {len(site)}"
        return blocks


def parse():
    corpus = json.load(open(os.path.join(CACHE, "corpus.json"), encoding="utf-8"))
    gold = Gold()
    print(
        f"treebank: {len(gold.sents)} sentences, {len(gold.fold)} graphic variants folded, "
        f"{gold.recoded} stative predicates tagged ADJ from {ADJFIX_TAG.split('.')[-1]}"
    )

    import spacy
    nlp = spacy.load("lzh_sud_kyoto")
    import lzh_sud_kyoto
    version = getattr(lzh_sud_kyoto, "__version__", nlp.meta.get("version", "?"))

    out, meta = [], []
    for c in corpus:
        hit = gold.find(c["han"])
        if hit:
            i, j, doc = hit
            blocks = gold.stitch(c["han"], i, j)
            tier, source = "gold", doc
        else:
            # One nlp() call per passage: `chunkText` only ever cuts past 1500
            # characters and the longest passage here is far short of that, so
            # the app's chunking is the identity on this corpus.
            d = nlp(c["han"])
            blocks = []
            for s in d.sents:
                base = s[0].i
                rows = []
                for t in s:
                    rows.append("\t".join([
                        str(t.i - base + 1), t.text, t.lemma_ or "_",
                        t.pos_ or t.tag_ or "_", t.tag_ or "_",
                        str(t.morph) or "_",
                        "0" if t.head.i == t.i else str(t.head.i - base + 1),
                        "root" if t.head.i == t.i else t.dep_,
                        "_", "_",
                    ]))
                blocks.append((None, rows))
            tier, source = "parser", f"lzh_sud_kyoto {version}"

        first = True
        for sid, rows in blocks:
            if first:
                out.append(f"# passage = {c['id']}")
                first = False
            if sid:
                out.append(f"# gold_sent_id = {sid}")
            out.extend(rows)
            out.append("")
        meta.append({
            "id": c["id"], "work": c["work"], "title": c["title"], "page": c["page"],
            "han": c["han"], "yomi": c["yomi"], "tier": tier, "source": source,
            "sentences": len(blocks),
        })

    os.makedirs(FIXTURES, exist_ok=True)
    with open(os.path.join(FIXTURES, "kanbun-info-parses.conllu"), "w", encoding="utf-8") as f:
        f.write(HEADER_CONLLU)
        f.write("\n".join(out))
    with open(os.path.join(FIXTURES, "kanbun-info-passages.json"), "w", encoding="utf-8") as f:
        json.dump({"_provenance": PROVENANCE, "passages": meta}, f, ensure_ascii=False, indent=1)
        f.write("\n")

    g = sum(1 for m in meta if m["tier"] == "gold")
    print(f"{len(meta)} passages: {g} gold, {len(meta) - g} parser")


PROVENANCE = {
    "白文": "kanbun.info (Web漢文大系). Ancient, out of copyright.",
    "書き下し文": "kanbun.info's own editorial rendering, quoted here as the "
                  "comparison target of a regression suite in a non-commercial "
                  "research tool. Not redistributed as a reading text.",
    "parses": "gold from the Kyoto SUD treebank (SUD_Classical_Chinese-Kyoto, "
              "see tests/fixtures/kanbun-info-parses.conllu); otherwise from "
              "lzh_sud_kyoto, the wheel in public/wasm/wheels/.",
    "built_by": "scripts/build-kanbun-info-corpus.py",
}

HEADER_CONLLU = """# Parses for the kanbun.info passages, one block per sentence.
#
# `# passage = <id>` opens a passage and every sentence up to the next such
# line belongs to it. `# gold_sent_id` names the Kyoto treebank sentence a
# gold block was taken from; a block without one came from lzh_sud_kyoto.
#
# On a gold block the FORM column has been rewritten to kanbun.info's own
# graphs (爲 for the corpus's 為, and so on) while HEAD/DEPREL/UPOS/FEATS are
# the treebank's untouched. Built by scripts/build-kanbun-info-corpus.py.
#
# Kyoto treebank: SUD_Classical_Chinese-Kyoto, CC BY-SA (see its LICENSE.txt).
"""


if __name__ == "__main__":
    {"index": index, "fetch": fetch, "extract": extract, "ruby": ruby, "parse": parse}[sys.argv[1]]()
