#!/bin/bash
# Builds wasm32/Pyodide wheels for spaCy's compiled dependency stack, in
# build-order-by-risk (cheapest/most-diagnostic first). Each package's sdist
# is downloaded fresh (--no-binary :all: --no-deps) and built in isolation
# so one failure doesn't block collecting wheels for packages that already
# succeeded. Output wheels land in /build/out, bind-mounted to the host's
# public/wasm/wheels/.
set -uo pipefail
source /opt/emsdk/emsdk_env.sh > /dev/null

OUT=/build/out
mkdir -p "$OUT" /build/src
cd /build/src

# Versions verified against thinc==8.3.13's and spacy==3.8.15's real
# Requires-Dist ranges (checked via PyPI JSON API) and against each
# package's actual available releases (my first guesses here didn't exist
# on PyPI at all, e.g. cymem 2.0.11 / murmurhash 1.0.13 / preshed 3.0.12 —
# fixed to the latest real release inside each constraint).
declare -A PACKAGES=(
  [cymem]="2.0.8"        # spacy/thinc want <2.1.0,>=2.0.2
  [murmurhash]="1.0.9"   # want <1.1.0,>=0.28.0/1.0.2
  [preshed]="3.0.9"      # want <3.1.0,>=3.0.2 (4.0.0 exists but is out of range)
  [blis]="1.3.3"         # thinc wants <1.4.0,>=1.3.0
  [srsly]="2.5.3"        # spacy wants <3.0.0,>=2.5.3 (exact lower bound)
  [thinc]="8.3.13"
  [spacy]="3.8.15"
)
ORDER=(cymem murmurhash preshed blis srsly thinc spacy)

# spaCy stopped publishing an sdist for several recent patch releases
# (3.8.14/3.8.15 among them — confirmed via PyPI's JSON API) while still
# tagging the release on GitHub; the git tag is byte-for-byte the same
# source the sdist would have contained, so it's a safe substitute. Add
# entries here for any other package that turns out sdist-less.
declare -A GIT_FALLBACK=(
  [spacy]="https://github.com/explosion/spaCy.git|release-v3.8.15"
)

# blis auto-detects the *host* CPU (via `platform.machine()`) to pick a
# hand-written-assembly kernel set — under Docker Desktop on Apple Silicon
# that's aarch64/cortexa57, which is meaningless for a wasm32 cross-compile
# and fails to link. BLIS_ARCH=generic selects blis's portable C reference
# kernels instead (see blis/_src/make/linux-generic.jsonl in its sdist).
declare -A EXTRA_ENV=(
  [blis]="BLIS_ARCH=generic"
)

echo "== pyodide-build $(pyodide --version 2>&1 || true)"
echo "== emscripten: $(emcc --version | head -1)"

FAILED=()
BUILT=()

for pkg in "${ORDER[@]}"; do
  ver="${PACKAGES[$pkg]}"
  echo ""
  echo "=============================================="
  echo "== Building ${pkg}==${ver}"
  echo "=============================================="

  if compgen -G "$OUT/${pkg}-*.whl" > /dev/null; then
    echo "OK (already built) -> $(basename "$(ls "$OUT/${pkg}-"*.whl | head -1)")"
    BUILT+=("$pkg")
    continue
  fi

  rm -rf "/build/src/${pkg}"
  mkdir -p "/build/src/${pkg}"

  pkg_dir=""
  if [ -n "${GIT_FALLBACK[$pkg]:-}" ]; then
    repo_url="${GIT_FALLBACK[$pkg]%%|*}"
    tag="${GIT_FALLBACK[$pkg]##*|}"
    echo "-- no PyPI sdist for ${pkg}==${ver}; cloning ${repo_url}@${tag}"
    if git clone --quiet --depth 1 --branch "$tag" "$repo_url" "/build/src/${pkg}/extracted/${pkg}" \
        >"/build/src/${pkg}/download.log" 2>&1; then
      pkg_dir="/build/src/${pkg}/extracted/${pkg}"
    fi
  else
    # Fetch the sdist directly from PyPI's JSON API rather than `pip download
    # --no-binary :all:` — for a meson-python/PEP517 package like blis, pip's
    # own resolution of build-system.requires (meson-python, numpy, cython)
    # inherits --no-binary :all: too and tries to build *those* from source
    # from inside pip's isolated build env, which lacks the same system deps
    # this Dockerfile installs. Fetching the sdist as a plain file sidesteps
    # pip's resolver entirely; `pyodide build` handles the package's own
    # build-time deps correctly via its emscripten-targeted build env.
    sdist_url=$(python3 -c "
import json, urllib.request
with urllib.request.urlopen('https://pypi.org/pypi/${pkg}/${ver}/json') as r:
    data = json.load(r)
for u in data['urls']:
    if u['packagetype'] == 'sdist':
        print(u['url']); break
" 2>"/build/src/${pkg}/download.log")
    if [ -n "$sdist_url" ] && wget -q -P "/build/src/${pkg}" "$sdist_url" >>"/build/src/${pkg}/download.log" 2>&1; then
      archive=$(find "/build/src/${pkg}" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.zip' \) | head -1)
      if [ -n "$archive" ]; then
        extract_dir="/build/src/${pkg}/extracted"
        mkdir -p "$extract_dir"
        case "$archive" in
          *.tar.gz) tar xzf "$archive" -C "$extract_dir" ;;
          *.zip) unzip -q "$archive" -d "$extract_dir" ;;
        esac
        pkg_dir=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -1)
      fi
    fi
  fi

  if [ -z "$pkg_dir" ]; then
    echo "!! could not obtain source for ${pkg}==${ver}, see ${pkg}/download.log"
    FAILED+=("${pkg} (download)")
    continue
  fi

  log="/build/src/${pkg}/build.log"
  if (cd "$pkg_dir" && env ${EXTRA_ENV[$pkg]:-} pyodide build) > "$log" 2>&1; then
    wheel=$(find "$pkg_dir/dist" -name '*.whl' | head -1)
    if [ -n "$wheel" ]; then
      cp "$wheel" "$OUT/"
      echo "OK  -> $(basename "$wheel")"
      BUILT+=("$pkg")
    else
      echo "!! pyodide build reported success but no wheel found for ${pkg}, see $log"
      FAILED+=("${pkg} (no wheel output)")
    fi
  else
    echo "!! build FAILED for ${pkg}, see $log"
    tail -40 "$log"
    FAILED+=("${pkg} (build)")
  fi
done

echo ""
echo "=============================================="
echo "SUMMARY"
echo "=============================================="
echo "Built (${#BUILT[@]}): ${BUILT[*]:-none}"
echo "Failed (${#FAILED[@]}): ${FAILED[*]:-none}"
ls -la "$OUT"

if [ "${#FAILED[@]}" -gt 0 ]; then
  exit 1
fi
