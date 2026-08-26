# Linux build environment for cross-compiling spaCy's C-extension stack to
# wasm32 for Pyodide 0.29.3 (Python 3.13.2, platform tag emscripten_4_0_9).
# Out-of-tree `pyodide build` only supports Linux — this runs under Docker
# Desktop on the (macOS) dev machine. See NOTES.md for the version pinning
# rationale and build order.
FROM python:3.13.2-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    bzip2 ccache f2c g++ gfortran git make patch pkg-config swig \
    unzip wget xz-utils autoconf automake libtool texinfo \
    build-essential libltdl-dev ninja-build cmake bison \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# pyodide-build 0.29.3's auditwheel-emscripten dependency imports
# `wheel.cli.pack`, which newer `wheel` releases (0.44+, as of this writing
# 0.48.0 is latest) removed/restructured — pin an older wheel that still has
# it, installed *after* pyodide-build so it isn't clobbered by pip's resolver.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir "pyodide-build==0.29.3" \
    && pip install --no-cache-dir "wheel==0.43.0"

# pyodide-build 0.29.3's default cross-build-env metadata URL points at
# pyodide's `main` branch, which has since moved on to the 314.x/Python-3.14
# release line: the file moved to a new path AND a new (pydantic-incompatible
# with this pyodide-build version) schema there, and the 0.29.3-tagged copy
# of the old path/schema is one release behind (lists up to 0.29.0, not
# 0.29.3 itself — the file is updated by a post-release CI job). Rather than
# fight either upstream drift, vendor a minimal hand-built v1-schema file
# with just the 0.29.3 entry (url/sha256 taken from the current v2 metadata
# on main) and point the tool's documented override env var at it directly —
# see pyodide_build.xbuildenv_releases.cross_build_env_metadata_url, which
# accepts a local file path as well as a URL.
COPY xbuildenv-metadata.json /opt/xbuildenv-metadata.json
ENV PYODIDE_CROSS_BUILD_ENV_METADATA_URL="/opt/xbuildenv-metadata.json"

# Emscripten SDK, pinned to whatever version pyodide-build 0.29.3 itself
# expects (queried at build time, not hardcoded, since it's the tool's own
# source of truth).
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk.git /opt/emsdk
RUN EMSCRIPTEN_VERSION=$(pyodide config get emscripten_version) \
    && echo "Emscripten version: ${EMSCRIPTEN_VERSION}" \
    && cd /opt/emsdk \
    && ./emsdk install "${EMSCRIPTEN_VERSION}" \
    && ./emsdk activate "${EMSCRIPTEN_VERSION}"

# Also pre-fetch the xbuildenv itself (Pyodide's own built numpy etc., used
# as build-time headers/deps by packages like thinc) at image-build time
# rather than on first `pyodide build` invocation, so build.sh's runtime
# doesn't depend on network access and image layers cache this expensive step.
RUN pyodide xbuildenv install 0.29.3

ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:${PATH}"
RUN echo '. /opt/emsdk/emsdk_env.sh > /dev/null' >> /etc/bash.bashrc

WORKDIR /build
COPY build.sh /build/build.sh
ENTRYPOINT ["/bin/bash", "/build/build.sh"]
