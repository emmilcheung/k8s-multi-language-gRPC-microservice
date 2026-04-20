#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROUTER_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$ROUTER_DIR/../.." && pwd)"

ROVER_BIN="${ROVER_BIN:-rover}"

echo "Composing supergraph from subgraph SDL files..."
"$ROVER_BIN" supergraph compose \
  --config "$ROUTER_DIR/supergraph-config.yaml" \
  --output "$ROUTER_DIR/supergraph.graphql"

echo "Supergraph composed: $ROUTER_DIR/supergraph.graphql"
