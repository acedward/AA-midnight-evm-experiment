# compact-toolchain — the pinned compactc compiler in a container, so no host
# machine in this project needs a Compact install.
#
# Derived from compact-end-2-end @ aa344546 infra/compact-toolchain.Dockerfile,
# with ONE substantive change: the upstream image installs the compiler through
# the `compact` version manager (`compact update <version>`), and that manager
# does not publish the 0.33 release-candidate line — `compact list` tops out at
# 0.31.1 and `compact update 0.33.0-rc.1` fails with "Couldn't find version".
# The 0.33 RC compilers are published as prebuilt release assets on
# LFDT-Minokawa/compact instead, so we fetch the pinned asset directly. Same
# binary, same tag, no version-manager indirection.
#
# Tag tracks `compact.compiler` from versions.json; built by
# infra/build-compact-image.sh. ENTRYPOINT is compactc itself (the manager is
# not installed), so the invocation is `compactc <flags> <src> <outdir>`.

FROM debian:stable-slim

# e.g. 0.33.0-rc.1 -> release tag compactc-v0.33.0-rc.1
ARG COMPACT_VERSION
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

RUN test -n "$COMPACT_VERSION" || { echo "COMPACT_VERSION build arg is required" >&2; exit 1; }

# The assets are musl-static, one per platform triple.
RUN set -eux; \
    case "${TARGETARCH:-arm64}" in \
      arm64) triple="aarch64-unknown-linux-musl" ;; \
      amd64) triple="x86_64-unknown-linux-musl" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${COMPACT_VERSION}/compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o /tmp/compactc.zip "$url"; \
    mkdir -p /opt/compactc; \
    unzip -q /tmp/compactc.zip -d /opt/compactc; \
    rm /tmp/compactc.zip; \
    chmod +x /opt/compactc/*; \
    # NOT a symlink: the bundled `compactc` wrapper resolves its siblings from
    # `dirname $0`, which through a symlink in /usr/local/bin points at the wrong
    # directory and fails with "compactc.bin: No such file or directory".
    printf '#!/bin/sh\nexec /opt/compactc/compactc "$@"\n' > /usr/local/bin/compactc; \
    chmod +x /usr/local/bin/compactc

# Fail the BUILD, not some later contract compile, if zkir-v3 is missing: every
# contract in this project compiles with --feature-zkir-v3, and a compactc
# without the zkir-v3 backend silently emits no verifier keys ("ZKIR not found").
RUN test -x /opt/compactc/zkir-v3 || { echo "image lacks zkir-v3" >&2; exit 1; }

WORKDIR /work
ENTRYPOINT ["compactc"]
