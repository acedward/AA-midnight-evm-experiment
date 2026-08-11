#!/usr/bin/env bash
# Build the pinned compactc toolchain image (idempotent — no-op if it exists).
# Tag is compact-toolchain:<versions.json compact.compiler>.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stack-lib.sh"

compiler=$(jq -re '.compact.compiler' "$VERSIONS_JSON")
image="compact-toolchain:${compiler}"

if [[ ${1:-} != "--force" ]] && docker image inspect "$image" >/dev/null 2>&1; then
  say "${image} already built"
  printf '%s\n' "$image"
  exit 0
fi

say "building ${image} from release asset compactc-v${compiler} ..."
docker build \
  --build-arg "COMPACT_VERSION=${compiler}" \
  -f "${INFRA_DIR}/compact-toolchain.Dockerfile" \
  -t "$image" \
  "${INFRA_DIR}" >&2

printf '%s\n' "$image"
