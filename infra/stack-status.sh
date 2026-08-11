#!/usr/bin/env bash
# Health + endpoints for the persistent stack. Exit 0 only if all three
# services answer. Safe to run any time; changes nothing.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stack-lib.sh"

load_stack_env

printf '\nstack: %s\n' "$COMPOSE_PROJECT_NAME"
printf '  network id     %s\n' "$MIDNIGHT_NETWORK_ID"
printf '  node RPC       %s\n' "$AA_NODE_URL"
printf '  indexer HTTP   %s\n' "$AA_INDEXER_HTTP"
printf '  indexer WS     %s\n' "$AA_INDEXER_WS"
printf '  proof server   %s\n' "$AA_PROOF_SERVER"
printf '\ncontainers:\n'
compose ps --format '  {{.Name}}\t{{.Status}}\t{{.Publishers}}' 2>/dev/null || true

printf '\nhealth:\n'
rc=0
for probe in probe_node probe_indexer probe_indexer_ws probe_proof_server; do
  name=${probe#probe_}
  if detail=$("$probe" 2>&1); then
    printf '  ✓ %-14s %s\n' "$name" "$detail"
  else
    printf '  ✗ %-14s %s\n' "$name" "$detail"
    rc=1
  fi
done

printf '\n'
if ((rc == 0)); then
  printf 'stack healthy.\n'
else
  printf 'stack NOT healthy — run infra/stack-up.sh\n'
fi
exit $rc
