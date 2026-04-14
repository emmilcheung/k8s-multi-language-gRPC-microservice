#!/usr/bin/env bash
# services/kong-gateway/scripts/build.sh
#
# Renders a Kong declarative config (kong.yml) from:
#   config/kong.base.yml        — base template with {{PLACEHOLDER}} tokens
#   values/_defaults.yml        — default values for all environments
#   values/<env>.yml            — per-environment overrides
#   plugins/jwt-sub.lua         — inlined into every protected route
#   KONG_RSA_PUBLIC_KEY (env)   — RSA public key; never stored in values files
#
# Usage:
#   KONG_RSA_PUBLIC_KEY="$(cat /path/to/public.pem)" ./scripts/build.sh <env> [output-file]
#
#   <env>          : local | minikube | dev | staging | prod
#   [output-file]  : path to write the rendered config
#                    (default: services/kong-gateway/kong.yml)
#
# Requires: bash 3.2+, python3 (for template rendering)
#
# Exits non-zero if:
#   - KONG_RSA_PUBLIC_KEY is not set or empty
#   - <env> is missing or has no matching values/<env>.yml
#   - any placeholder remains unresolved after substitution

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BASE_TEMPLATE="${GATEWAY_DIR}/config/kong.base.yml"
DEFAULTS_FILE="${GATEWAY_DIR}/values/_defaults.yml"
LUA_FILE="${GATEWAY_DIR}/plugins/jwt-sub.lua"

# ── Argument validation ────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <env> [output-file]" >&2
  echo "  env: local | minikube | dev | staging | prod" >&2
  exit 1
fi

ENV="$1"
OUTPUT_FILE="${2:-${GATEWAY_DIR}/kong.yml}"
ENV_VALUES_FILE="${GATEWAY_DIR}/values/${ENV}.yml"

if [[ ! -f "${ENV_VALUES_FILE}" ]]; then
  echo "ERROR: No values file found for environment '${ENV}' (expected: ${ENV_VALUES_FILE})" >&2
  exit 1
fi

# ── Secret validation ──────────────────────────────────────────────────────────
# RSA_PUBLIC_KEY must come from the environment — never from a values file.
if [[ -z "${KONG_RSA_PUBLIC_KEY:-}" ]]; then
  echo "ERROR: KONG_RSA_PUBLIC_KEY environment variable is not set." >&2
  echo "  Export it before calling this script:" >&2
  echo "    export KONG_RSA_PUBLIC_KEY=\"\$(cat /path/to/public.pem)\"" >&2
  exit 1
fi

echo "[build.sh] Environment : ${ENV}"
echo "[build.sh] Output file : ${OUTPUT_FILE}"

# ── Use a temp file for the in-progress rendered output ───────────────────────
TMPFILE="$(mktemp)"
trap 'rm -f "${TMPFILE}"' EXIT

# ── Delegate all rendering to Python (works on Bash 3.2 / macOS + Linux) ──────
# Python handles:
#   1. Loading _defaults.yml and <env>.yml (last-write-wins key merge)
#   2. Inlining jwt-sub.lua into every {{JWT_SUB_LUA}} placeholder
#   3. Inlining KONG_RSA_PUBLIC_KEY into the {{RSA_PUBLIC_KEY}} placeholder
#   4. Substituting all remaining scalar {{PLACEHOLDER}} tokens
#   5. Validating no placeholders remain unresolved
python3 - \
  "${BASE_TEMPLATE}" \
  "${DEFAULTS_FILE}" \
  "${ENV_VALUES_FILE}" \
  "${LUA_FILE}" \
  "${TMPFILE}" \
  "${KONG_RSA_PUBLIC_KEY}" \
  <<'PYEOF'
import sys
import re

base_template_path = sys.argv[1]
defaults_path      = sys.argv[2]
env_values_path    = sys.argv[3]
lua_path           = sys.argv[4]
output_path        = sys.argv[5]
rsa_public_key     = sys.argv[6]

scope_lua_path     = lua_path.replace('jwt-sub.lua', 'jwt-scope.lua')

# ── Load values files ──────────────────────────────────────────────────────────
def load_values(path):
    """Parse a simple KEY: value YAML file into a dict (scalar values only)."""
    values = {}
    with open(path) as f:
        for line in f:
            line = line.rstrip('\n')
            if not line or line.lstrip().startswith('#'):
                continue
            m = re.match(r'^([A-Z_][A-Z0-9_]*):\s*(.*)', line)
            if m:
                key = m.group(1)
                val = m.group(2).strip().strip('"').strip("'")
                values[key] = val
    return values

values = load_values(defaults_path)
values.update(load_values(env_values_path))  # env overrides defaults

# ── Load and indent jwt-sub.lua ───────────────────────────────────────────────
# The {{JWT_SUB_LUA}} placeholder sits at 18 spaces of indentation inside a
# YAML literal block scalar (`- |`).  Every line of the Lua file must be
# indented by 18 spaces so the block parses correctly.
LUA_INDENT = ' ' * 18

with open(lua_path) as f:
    lua_lines = f.read().rstrip('\n').splitlines()

lua_block = '\n'.join(LUA_INDENT + line for line in lua_lines)

# ── Load and indent RSA public key ────────────────────────────────────────────
# The key sits inside a YAML literal block scalar at 10 spaces of indentation.
# The key may arrive as:
#   a) Real newlines (from `cat public.pem` or multi-line env var)
#   b) Literal \n sequences (from secrets.env single-line format)
# Decode both forms before splitting into lines.
RSA_INDENT = ' ' * 10

rsa_decoded = rsa_public_key.replace('\\n', '\n').strip()
rsa_lines = rsa_decoded.splitlines()
rsa_block = '\n'.join(RSA_INDENT + line for line in rsa_lines)

# ── Read base template ────────────────────────────────────────────────────────
with open(base_template_path) as f:
    content = f.read()

# ── Substitute {{JWT_SUB_LUA}} (multi-line, placeholder may have leading spaces) ──
content = re.sub(r'[ \t]*\{\{JWT_SUB_LUA\}\}', lua_block, content)

# ── Substitute {{SCOPE_CHECK_LUA:<scope>}} placeholders ───────────────────────
# Each occurrence encodes the required scope in the placeholder, e.g.:
#   {{SCOPE_CHECK_LUA:orders:read}}
# build.sh reads jwt-scope.lua, replaces SCOPE_PLACEHOLDER with the captured
# scope string, indents 18 spaces, and substitutes inline.
def make_scope_lua(scope_lua_content, scope, indent):
    replaced = scope_lua_content.replace('SCOPE_PLACEHOLDER', scope)
    lines = replaced.rstrip('\n').splitlines()
    return '\n'.join(indent + line for line in lines)

with open(scope_lua_path) as f:
    scope_lua_content = f.read()

def replace_scope_check(m):
    scope = m.group(1)
    return make_scope_lua(scope_lua_content, scope, LUA_INDENT)

content = re.sub(r'[ \t]*\{\{SCOPE_CHECK_LUA:([^}]+)\}\}', replace_scope_check, content)

# ── Substitute {{RSA_PUBLIC_KEY}} ─────────────────────────────────────────────
content = re.sub(r'[ \t]*\{\{RSA_PUBLIC_KEY\}\}', rsa_block, content)

# ── Substitute scalar {{PLACEHOLDER}} tokens ──────────────────────────────────
for key, val in values.items():
    content = content.replace('{{' + key + '}}', val)

# ── Validate: no unresolved placeholders remain ───────────────────────────────
# Strip YAML comment lines before scanning so that example placeholders in
# comments (e.g. "# Placeholder syntax: {{VARIABLE_NAME}}") don't cause a
# false-positive validation failure.
non_comment_content = '\n'.join(
    line for line in content.splitlines()
    if not line.lstrip().startswith('#')
)
unresolved = sorted(set(re.findall(r'\{\{[A-Z_]+\}\}', non_comment_content)))
if unresolved:
    print('ERROR: The following placeholders were not resolved:', file=sys.stderr)
    for p in unresolved:
        print(f'  {p}', file=sys.stderr)
    sys.exit(1)

# ── Write output ──────────────────────────────────────────────────────────────
with open(output_path, 'w') as f:
    f.write(content)

PYEOF

# ── Copy temp file to final output location ───────────────────────────────────
mkdir -p "$(dirname "${OUTPUT_FILE}")"
cp "${TMPFILE}" "${OUTPUT_FILE}"

echo "[build.sh] Done. Rendered kong.yml written to: ${OUTPUT_FILE}"
