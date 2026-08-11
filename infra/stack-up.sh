#!/usr/bin/env bash
# Bring up (or REUSE) the one persistent Midnight 2.x network. Idempotent.
#
#   STACK.env exists AND all health probes pass  -> no-op, reuse, exit 0
#   STACK.env exists but the stack is not healthy -> restart/repair in place
#   no STACK.env                                  -> allocate fresh ports, up
#
# This is PLAN-01 gate G1.0. Never tears anything down; see stack-down.sh.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stack-lib.sh"

NODE_TIMEOUT=${AA_NODE_TIMEOUT:-180}
INDEXER_TIMEOUT=${AA_INDEXER_TIMEOUT:-180}
# First boot downloads the public params (multi-minute); later boots hit the
# named volume and are fast.
PROOF_TIMEOUT=${AA_PROOF_TIMEOUT:-900}

command -v docker >/dev/null || die "docker not on PATH"
command -v jq >/dev/null || die "jq not on PATH"
docker info >/dev/null 2>&1 || die "docker daemon not reachable"

if [[ -f "$STACK_ENV" ]]; then
  load_stack_env
  if stack_healthy; then
    say "stack ${COMPOSE_PROJECT_NAME} already healthy — reusing (no restart)"
    exec "${INFRA_DIR}/stack-status.sh"
  fi

  # STACK.env exists but the stack is not answering. Two very different cases:
  #
  #   the stack still EXISTS (stopped containers, or its volumes are on disk)
  #     -> bring it up ON THE SAME PORTS. Re-rolling here would orphan the chain
  #        state that every infra/DEPLOYMENTS.json address resolves against, and
  #        the whole point of Part 0 is that state outlives individual runs.
  #   the stack is GONE and something else now holds its ports
  #     -> the recorded ports are unusable; allocate a fresh window.
  #
  # (PLAN-01 Part 0 step 5 says "else (re)generate ports"; unconditional
  # regeneration would silently abandon a merely-stopped stack, so the rule is
  # narrowed to the case where the ports are actually lost. See §Questions Q6.)
  if stack_exists; then
    say "stack ${COMPOSE_PROJECT_NAME} exists but is not healthy — starting it in place (chain state preserved)"
  elif ports_stolen; then
    say "STACK.env names ${COMPOSE_PROJECT_NAME}, which no longer exists, and its ports are taken — allocating a fresh window"
    base="$(alloc_base_port)"
    write_stack_env "$base"
    load_stack_env
  else
    say "STACK.env names ${COMPOSE_PROJECT_NAME}, which no longer exists; its ports are still free — recreating it there"
  fi
else
  say "no STACK.env — allocating a fresh port window"
  base="$(alloc_base_port)"
  write_stack_env "$base"
  load_stack_env
fi

say "compose project: ${COMPOSE_PROJECT_NAME}"

# Node first, then the indexer: the indexer's spo-indexer aborts if block 1 does
# not exist yet, so we wait for a produced block before starting it. (Compose's
# depends_on: service_healthy covers the /health endpoint, not block production.)
say "starting midnight-node + proof-server ..."
compose up -d --wait midnight-node proof-server
wait_ready "node" probe_node "$NODE_TIMEOUT" || {
  compose logs --tail 120 midnight-node >&2
  die "node did not produce blocks"
}

say "starting indexer ..."
compose up -d --wait indexer
wait_ready "indexer" probe_indexer "$INDEXER_TIMEOUT" || {
  compose logs --tail 120 indexer >&2
  die "indexer GraphQL did not come up"
}
wait_ready "indexer-ws" probe_indexer_ws 30 || die "indexer ws port not published"

say "waiting for proof-server (first boot downloads public params) ..."
wait_ready "proof-server" probe_proof_server "$PROOF_TIMEOUT" || {
  compose logs --tail 120 proof-server >&2
  die "proof-server did not become healthy"
}

exec "${INFRA_DIR}/stack-status.sh"
