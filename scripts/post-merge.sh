#!/bin/bash
# Convenience post-merge helper. Not auto-invoked anywhere — run manually when
# a pulled merge changed dependencies or DB schema. Hooking this into git
# post-merge or CI deployment is the developer's choice; do NOT auto-run
# `db push` against a production database.
set -e
pnpm install --frozen-lockfile
# pnpm --filter @workspace/db run push   # uncomment for local dev only
