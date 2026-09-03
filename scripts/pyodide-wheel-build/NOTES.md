# Pyodide/WASM wheel build spike — Phase 0

## Why this exists

`lzh_sud_kyoto` (the SUD parser this app depends on) requires
`spacy>=3.8.14,<3.9.0`. spaCy has never been officially packaged for
Pyodide/WASM. The only public precedent (`liu-nlp/spacy-pyodide` on GitHub)
is unlicensed, unmaintained (last commit Nov 2024), and targets spaCy 3.7.5
against an old `pyodide_2024_0_wasm32` ABI tag that no longer matches any
current Pyodide release — not usable as a dependency.

This directory builds our own WASM wheels for spaCy's compiled dependency
chain (`cymem`, `murmurhash`, `preshed`, `blis`, `thinc`, `spacy` itself, and
`srsly`, which is also Cython-based) via Pyodide's documented out-of-tree
`pyodide build` workflow, targeting the exact versions `lzh_sud_kyoto` needs.

## Target versions (pinned, don't drift without re-verifying)

- **Pyodide runtime: 0.29.3** (bundles **Python 3.13.2**, platform tag
  `emscripten_4_0_9`; confirmed via that release's own `pyodide-lock.json`).
  Deliberately *not* the newer `31x.0.0` line — those bundle Python 3.14,
  which spaCy/thinc do not yet fully support (thinc has `cp314` wheels but
  the full stack, esp. blis, is unproven there; SUD-spaCy's own docs already
  flag 3.14 as unsupported for this reason).
  Deliberately *not* Python 3.12 either, even though that's what the
  SUD-spaCy dev venv happens to use — **spaCy 3.8.15 and thinc 8.3.13
  already ship official `cp313` wheels on PyPI**, so targeting 3.13
  (Pyodide's most recent Python-3.13-based release) is lower-risk than
  hunting for an older Pyodide release that bundles 3.12, and lzh_sud_kyoto's
  `meta.json` only pins the spaCy version, not the Python version.
- **pyodide-build: 0.29.3** (exact match to the runtime version; no 0.29.4
  release of the *build tool* exists — 0.29.4 was a runtime-only patch).
- Confirmed via that pinned release's `pyodide-lock.json`
  (`https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide-lock.json`):
  `numpy`, `jinja2`, `pydantic` are already prebuilt by Pyodide itself
  (re-check this file at spike time — Pyodide's package list grows).
  Confirmed **not** prebuilt: `spacy`, `thinc`, `blis`, `cymem`,
  `murmurhash`, `preshed`, `srsly` — these are exactly what this directory
  must build.

## Build order (easiest/lowest-risk first, to validate the toolchain before
## spending time on the hard case)

1. `cymem`, `murmurhash`, `preshed` — small, dependency-light Cython
   extensions. If these don't build, nothing else will either, and the
   failure is cheap to diagnose.
2. `blis` — the single highest-risk target (BLAS-like kernels, historically
   hand-tuned assembly-adjacent code). Pyodide maintains its own BLIS fork
   for its own numpy/scipy builds, which is a positive signal but does not
   guarantee thinc's exact pinned blis version builds cleanly under
   emscripten. If this fails, fall back to testing whether thinc's
   numpy-only `NumpyOps` backend works without blis at all — this app only
   needs inference, not training, so a slower backend is an acceptable
   trade, not a blocker.
3. `srsly` — Cython-based, needed by spaCy for its serialization layer.
4. `thinc==8.3.13`
5. `spacy==3.8.15` (the version actually installed against the shipped
   `lzh_sud_kyoto-0.3.1` wheel; satisfies its `>=3.8.14,<3.9.0` pin)

Each package: `pip download --no-binary :all: --no-deps <pkg>==<version>`
to get the sdist, unpack it, `cd` in, run `pyodide build`, collect the
resulting wheel from `dist/`.

## Verification gate (must pass before Phase 1+ proceeds in earnest)

In a **real browser tab** (not node-pyodide, which can mask browser-only
failure modes): load Pyodide 0.29.3, `micropip.install` every built wheel
plus the `lzh_sud_kyoto-0.3.1-py3-none-any.whl` **from local static files**
(no PyPI network dependency at runtime — this proves the static-site/offline
story), then:

```python
import spacy
nlp = spacy.load("lzh_sud_kyoto")
doc = nlp("學而時習之，不亦說乎？")
[(t.text, t.pos_, t.dep_, t.head.i) for t in doc]
```

and diff against `tests/fixtures/analects-raw-parses.json` (captured from a
real run of the same wheel outside Pyodide). Also record cold-load time and
parse latency for a ~50-character input in a real browser, for loading-state
UX design later.

If the spike stalls on blis/thinc and the numpy-only-ops fallback doesn't
resolve it either, the CoNLL-U upload path (built independently, with no
Pyodide dependency) is the documented, approved fallback — the app ships as
CoNLL-U-only with the live-parse UI path disabled, not blocked entirely.

## Outcome: spike succeeded — all 7 packages built

All of `cymem`, `murmurhash`, `preshed`, `blis`, `srsly`, `thinc==8.3.13`,
`spacy==3.8.15` built as real `pyodide_2025_0_wasm32` wheels (see `build.sh`
for the exact fixes). Two non-obvious fixes were needed beyond the base
Dockerfile/build.sh:

1. **blis auto-detects the host CPU, not the build target.** Under Docker
   Desktop on Apple Silicon, blis's `setup.py` (`platform.machine()`) picked
   `cortexa57` and tried to compile ARM64 hand-written assembly kernels,
   which obviously can't target wasm32. Fix: `BLIS_ARCH=generic` forces its
   portable C reference-kernel build (see `blis/_src/make/linux-generic.jsonl`
   in its sdist) — set per-package in `build.sh`'s `EXTRA_ENV` map.
2. **spaCy 3.8.14/3.8.15 ship no sdist on PyPI** (confirmed via PyPI's JSON
   API — several other 3.8.x patch releases do have one, these specific two
   don't). The GitHub tag (`release-v3.8.15`) is the same source a sdist
   would have contained; `build.sh`'s `GIT_FALLBACK` map clones it instead.

**Vendoring**: the 7 built wheels + `lzh_sud_kyoto-0.3.1-py3-none-any.whl`
live in `public/wasm/wheels/` (listed in that directory's `manifest.json`,
which `src/parse/pyodideWorker.ts` reads to know what to `micropip.install`).
spaCy's remaining *pure-Python* transitive dependencies not already bundled
in Pyodide 0.29.3's own package repo (`catalogue`, `confection`,
`spacy-legacy`, `spacy-loggers`, `wasabi`, `weasel`, `typer` + typer's own
`shellingham`/`annotated-doc`, `httpx` + its `httpcore`/`anyio`/`sniffio`/
`h11`, `cloudpathlib`, `markdown-it-py`/`mdurl`) are vendored the same way,
as plain `py3-none-any` wheels, also listed in the manifest.

`public/wasm/pyodide/` holds a **curated subset** of the real Pyodide 0.29.3
runtime release (not the full ~465MB distribution): the core runtime files
(`pyodide.mjs`, `pyodide.asm.wasm`, `pyodide.asm.js`, `pyodide-lock.json`,
`python_stdlib.zip`) plus `micropip` and the ~20 already-Pyodide-bundled
pure/compiled packages spaCy's dependency chain actually needs (`numpy`,
`jinja2`, `pydantic`/`pydantic-core`, `requests`, `click`, `tqdm`, `rich`,
`setuptools`, `packaging`, `six`, `certifi`, `idna`, `urllib3`,
`charset-normalizer`, `markupsafe`, `annotated-types`, `smart-open`,
`pygments`, `typing-extensions`, `typing-inspection`). This list was
assembled by hand-tracing `requires_dist` chains and iteratively fixed
against real "ModuleNotFoundError" console output in an actual browser tab —
**verified working end-to-end**: `spacy.load("lzh_sud_kyoto")` and a live
parse of `學而時習之，不亦說乎？` produced output identical to the reference
fixture, with zero console errors, entirely offline (no PyPI/CDN fetch at
runtime). Warm (post-init) parse latency measured ~82ms in-browser.

If a future spaCy/dependency version bump surfaces another
`ModuleNotFoundError: No module named 'X' ... included in the Pyodide
distribution, but it is not installed`, the fix is always the same: find
`X-*.whl` under the full extracted `/tmp/pyodide/` distribution (re-download
`pyodide-0.29.3.tar.bz2` from the GitHub release if it's not still on disk)
and copy it into `public/wasm/pyodide/` — that error message means the
package is already in Pyodide's own `pyodide-lock.json`, just not physically
copied into this curated vendored subset yet.

A real, load-bearing client-side bug was also found and fixed during
verification: `pyodideClient.ts` originally cached a *failed* init attempt
forever (a rejected promise), so retrying after fixing a missing-wheel issue
required a full page reload rather than just clicking "Annotate" again —
fixed to clear the cache and recreate the worker on failure, so a retry is a
genuine retry.
