#!/usr/bin/env bash
# MANUAL teardown only. No test suite may call this script.
#
# The Part-0 stack is deliberately long-lived: proof public params take minutes
# to download and every later PLAN re-attaches to contract addresses recorded in
# infra/DEPLOYMENTS.json against THIS chain. Stopping it is cheap to undo;
# wiping its volumes is not.
#
#   stack-down.sh              stop containers, keep volumes + chain state
#   stack-down.sh --wipe       ALSO delete volumes (chain state + proof params)
#
# --wipe requires typing the project name back. That is the "explicit human
# intent" gate PLAN-01 Part 0 demands; do not automate around it.

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stack-lib.sh"

load_stack_env

if [[ ${1:-} == "--wipe" ]]; then
  cat >&2 <<EOF

*** DESTRUCTIVE ***
This deletes the chain state shared by every PLAN in this project:
  - every contract address in infra/DEPLOYMENTS.json becomes unresolvable
  - the proof-server public params are re-downloaded from scratch (minutes)

Type the project name to confirm: ${COMPOSE_PROJECT_NAME}
EOF
  read -r -p "> " confirm
  [[ $confirm == "$COMPOSE_PROJECT_NAME" ]] || die "aborted (no match)"
  compose down -v
  say "wiped ${COMPOSE_PROJECT_NAME}. Delete infra/STACK.env to allocate new ports next time."
  exit 0
fi

compose stop
say "stopped ${COMPOSE_PROJECT_NAME} — volumes and chain state kept. infra/stack-up.sh brings it back on the same ports."
