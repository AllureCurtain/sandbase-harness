#!/usr/bin/env bash
# spawn-docker.sh — reference `--on-work` handler: one clean container per claim.
#
# `managed-agents worker poll --on-work ./spawn-docker.sh` invokes this script
# once per claimed work item. The item JSON arrives on stdin; the poller has
# already set the MANAGED_AGENTS_* variables this script forwards.
#
# Requires jq and docker on the poller host.
set -euo pipefail

# The per-claim session credential travels in the item's `secret` field —
# a base64url {sessions_token, api_base_url} envelope. The poller deliberately
# does not set it in our environment: it is extracted here and forwarded only
# into the container that serves this session. Never log it.
MANAGED_AGENTS_WORK_SECRET="$(jq -r '.secret // empty')"
export MANAGED_AGENTS_WORK_SECRET

# One output/workspace directory per session, mounted at /workspace so the
# container's deliverables survive it and can be collected afterwards.
OUTPUTS_HOST="${SPAWN_OUTPUTS_DIR:-$PWD/.worker-outputs}"
mkdir -p "$OUTPUTS_HOST/$MANAGED_AGENTS_SESSION_ID"

# The container reaches the runtime through host.docker.internal; when the
# poller resolved a localhost URL, remap it so the sandbox calls back to the
# host instead of itself. Override MANAGED_AGENTS_BASE_URL yourself when your
# topology differs.
BASE_URL="$MANAGED_AGENTS_BASE_URL"
case "$BASE_URL" in
  http://localhost:*|http://127.0.0.1:*)
    BASE_URL="http://host.docker.internal:${BASE_URL##*:}"
    ;;
esac

exec docker run --rm -i \
  -e MANAGED_AGENTS_SESSION_ID \
  -e MANAGED_AGENTS_WORK_ID \
  -e MANAGED_AGENTS_WORKER_ID \
  -e MANAGED_AGENTS_ENVIRONMENT_ID \
  -e MANAGED_AGENTS_ENVIRONMENT_KEY \
  -e MANAGED_AGENTS_API_KEY \
  -e MANAGED_AGENTS_WORK_SECRET \
  -e "MANAGED_AGENTS_BASE_URL=$BASE_URL" \
  -v "$OUTPUTS_HOST/$MANAGED_AGENTS_SESSION_ID:/workspace" \
  -w /workspace \
  "${SPAWN_IMAGE:-ghcr.io/sandbaseai/sandbase-sandbox:latest}" \
  managed-agents worker run --workdir /workspace
