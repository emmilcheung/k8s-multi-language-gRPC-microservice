#!/usr/bin/env bash
# services/kong-gateway/scripts/build.sh
#
# Renders a Kong declarative config (kong.yml) from:
#   config/kong.base.yml        — base template with {{PLACEHOLDER}} tokens
#   values/_defaults.yml        — default values for all environments
#   values/<env>.yml            — per-environment overrides
#   plugins/jwt-sub.lua         — inlined into every protected route
#   plugins/jwt-scope.lua       — inlined for scope-protected routes
#   plugins/role-check.lua      — inlined for role-protected routes
#   plugins/oauth-deny.lua      — inlined for routes that refuse OAuth tokens
#   plugins/queue-gate.lua      — inlined for waiting-room gated routes
#   KONG_RSA_PUBLIC_KEY (env)   — RSA public key; never stored in values files
#   KONG_RATE_LIMIT_REDIS_HOST  — managed-Redis endpoint; not knowable at commit time
#   KONG_OAUTH_ISSUER (env)     — public origin of the OAuth issuer (= auth-service OAUTH_ISSUER, no
#                                 path). Keys the second jwt_secret and derives the REST audience
#                                 <origin>/api. local/minikube default to http://localhost:8000
#                                 from their values files; dev/staging/prod must supply it
#   QUEUE_HMAC_SECRET (env)     — queue pass-signing secret; when non-empty it wins over the
#                                 values files. Required outside local/minikube once
#                                 QUEUE_GATE_ARMED is "true" (the committed dev default is refused)
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
#   - the OAuth issuer (KONG_OAUTH_ISSUER, or OAUTH_ISSUER in the values file) is missing, is not a
#     bare origin, or is not https outside local/minikube
#   - RATE_LIMIT_POLICY is `redis` but no Redis host resolves
#   - QUEUE_GATE_ARMED is `true` but QUEUE_HMAC_SECRET is empty
#   - QUEUE_GATE_ARMED is `true`, <env> is not local/minikube, and the effective
#     QUEUE_HMAC_SECRET is the committed _defaults.yml dev value (or empty)
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

# SIGNING_KEY also comes from the environment. An empty value keeps
# X-User-Id-Sig generation disabled for environments that have not opted in yet.
KONG_SIGNING_KEY="${KONG_SIGNING_KEY:-}"

# The managed-Redis endpoint cannot live in a values file: ElastiCache mints the
# primary endpoint as master.<replication-group>.<hash>.<region>.cache.amazonaws.com,
# and the hash is only known after `terraform apply`. docker-entrypoint.sh renders
# kong.yml at container start, so the Deployment supplies this the same way it
# supplies the RSA key. Empty is fine for any environment on the `local` policy.
KONG_RATE_LIMIT_REDIS_HOST="${KONG_RATE_LIMIT_REDIS_HOST:-}"

echo "[build.sh] Environment : ${ENV}"
echo "[build.sh] Output file : ${OUTPUT_FILE}"

# ── Use a temp file for the in-progress rendered output ───────────────────────
TMPFILE="$(mktemp)"
trap 'rm -f "${TMPFILE}"' EXIT

# ── Delegate all rendering to Python (works on Bash 3.2 / macOS + Linux) ──────
# Python handles:
#   1. Loading _defaults.yml and <env>.yml (last-write-wins key merge)
#   2. Inlining jwt-sub.lua into every {{JWT_SUB_LUA}} placeholder
#   3. Inlining jwt-scope.lua into {{SCOPE_CHECK_LUA:<scope>}} placeholders
#   4. Inlining role-check.lua into {{ROLE_CHECK_LUA:<role>}} placeholders
#   5. Inlining KONG_RSA_PUBLIC_KEY into the {{RSA_PUBLIC_KEY}} placeholder
#   6. Replacing SIGNING_KEY_PLACEHOLDER inside jwt-sub.lua
#   7. Applying the KONG_RATE_LIMIT_REDIS_HOST env override
#   8. Expanding {{KEY}} references that appear inside values themselves
#   9. Substituting all remaining scalar {{PLACEHOLDER}} tokens
#  10. Validating the Redis host is set whenever the policy is `redis`
#  11. Validating no placeholders remain unresolved
python3 - \
  "${BASE_TEMPLATE}" \
  "${DEFAULTS_FILE}" \
  "${ENV_VALUES_FILE}" \
  "${LUA_FILE}" \
  "${TMPFILE}" \
  "${KONG_RSA_PUBLIC_KEY}" \
  "${KONG_SIGNING_KEY}" \
  "${KONG_RATE_LIMIT_REDIS_HOST}" \
  "${ENV}" \
  <<'PYEOF'
import os
import sys
import re

base_template_path = sys.argv[1]
defaults_path      = sys.argv[2]
env_values_path    = sys.argv[3]
lua_path           = sys.argv[4]
output_path        = sys.argv[5]
rsa_public_key     = sys.argv[6]
signing_key        = sys.argv[7]
redis_host_env     = sys.argv[8]
target_env         = sys.argv[9]

scope_lua_path     = lua_path.replace('jwt-sub.lua', 'jwt-scope.lua')
role_lua_path      = lua_path.replace('jwt-sub.lua', 'role-check.lua')
deny_lua_path      = lua_path.replace('jwt-sub.lua', 'oauth-deny.lua')
queue_lua_path     = lua_path.replace('jwt-sub.lua', 'queue-gate.lua')

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
default_queue_secret = values.get('QUEUE_HMAC_SECRET', '')
values.update(load_values(env_values_path))  # env overrides defaults

# ── Environment override for the managed-Redis endpoint ───────────────────────
# See the KONG_RATE_LIMIT_REDIS_HOST comment in build.sh: the ElastiCache
# endpoint is generated by Terraform, so staging/prod leave it blank in the
# values file and inject it at render time.
if redis_host_env:
    values['RATE_LIMIT_REDIS_HOST'] = redis_host_env

# ── OAuth issuer origin (second jwt_secret + REST audience) ──────────────────
# Every environment renders the MCP routes, and once auth-service flips
# OAUTH_ISSUER_ENABLED its tokens carry iss=<this origin>. A gateway rendered
# without it would 401 every OAuth token, so a missing value fails the build
# rather than falling back to a hard-coded origin. A trailing slash is trimmed to
# match auth-service's own normalisation.
oauth_issuer_env = os.environ.get('KONG_OAUTH_ISSUER', '')
if oauth_issuer_env:
    values['OAUTH_ISSUER'] = oauth_issuer_env

# ── Environment override for the queue pass-signing secret ────────────────────
# Read from os.environ (not argv) so it never shows in a process listing. Mirrors
# KONG_RSA_PUBLIC_KEY: the real secret is injected at container start; the values
# files only carry a dev default.
queue_secret_env = os.environ.get('QUEUE_HMAC_SECRET', '')

# The secret is substituted verbatim into a Lua string literal (queue-gate.lua),
# and the gate must use the exact bytes queue-service signs with. So reject, never
# escape, anything that would break or alter the literal. Runs whether or not the
# gate is armed (an injected `"` breaks Lua even when disarmed). Never prints the value.
def check_queue_secret_embeddable(secret, source):
    if not secret:
        return
    bad = []
    if '"' in secret:
        bad.append('a double quote (")')
    if '\\' in secret:
        bad.append('a backslash (\\)')
    if re.search(r'[\x00-\x1f\x7f]', secret):
        bad.append('a control character (including newline or carriage return)')
    if '{{' in secret:
        bad.append('the sequence "{{"')
    if bad:
        print(f'ERROR: QUEUE_HMAC_SECRET ({source}) cannot be embedded safely in the queue gate Lua; '
              f'it contains {", ".join(bad)}.', file=sys.stderr)
        print('  Use a secret without these characters (e.g. base64 or hex); the gate needs the', file=sys.stderr)
        print('  exact bytes queue-service uses, so it is rejected rather than escaped.', file=sys.stderr)
        sys.exit(1)

check_queue_secret_embeddable(queue_secret_env, 'environment')
if queue_secret_env:
    values['QUEUE_HMAC_SECRET'] = queue_secret_env

# ── Expand {{KEY}} references that appear inside values themselves ────────────
# Lets a values file name its namespace once and derive all nine HOST_* FQDNs
# from it. Before this, the namespace was copy-pasted into every HOST_* entry,
# which is how staging/prod ended up carrying a namespace nobody had re-checked
# and how HOST_USERS/HOST_ATTENDANCE went missing without anyone noticing: a
# missing key silently falls back to the docker-compose default in _defaults.yml
# (`user-service:3004`), a name that does not resolve in Kubernetes.
# Bounded rounds so a self-referential value fails the unresolved check below
# rather than looping forever.
def expand_values(values, rounds=5):
    for _ in range(rounds):
        changed = False
        for key, val in list(values.items()):
            new = re.sub(r'\{\{([A-Z_][A-Z0-9_]*)\}\}',
                         lambda m: values.get(m.group(1), m.group(0)), val)
            if new != val:
                values[key] = new
                changed = True
        if not changed:
            break
    return values

values = expand_values(values)
# Expand the default the same way as the effective value so the comparison below
# is like-for-like (a {{KEY}} in the default would otherwise never match).
default_queue_secret = re.sub(r'\{\{([A-Z_][A-Z0-9_]*)\}\}',
                              lambda m: values.get(m.group(1), m.group(0)), default_queue_secret)
check_queue_secret_embeddable(values.get('QUEUE_HMAC_SECRET', ''), 'after expansion')

# ── Validate: the OAuth issuer is a bare origin ───────────────────────────────
oauth_issuer = values.get('OAUTH_ISSUER', '').rstrip('/')
if not re.fullmatch(r'https?://[A-Za-z0-9.-]+(:[0-9]+)?', oauth_issuer):
    print('ERROR: KONG_OAUTH_ISSUER is missing or not a bare origin (scheme://host[:port], no path/query).', file=sys.stderr)
    print('  Set it to the same origin as auth-service OAUTH_ISSUER (global.publicOrigin), e.g.:', file=sys.stderr)
    print('    export KONG_OAUTH_ISSUER="https://ticketing.example.com"', file=sys.stderr)
    sys.exit(1)
if target_env not in ('local', 'minikube') and not oauth_issuer.startswith('https://'):
    print(f'ERROR: KONG_OAUTH_ISSUER must be https for environment "{target_env}" (auth-service refuses a plain-http issuer in production).', file=sys.stderr)
    sys.exit(1)
values['OAUTH_ISSUER'] = oauth_issuer
# The REST audience is <origin>/api, matching auth-service OAUTH_API_AUDIENCE.
oauth_api_audience = oauth_issuer + '/api'

# ── Validate: the redis policy needs a host ───────────────────────────────────
# Kong's rate-limiting schema makes redis.host conditionally required when
# policy is `redis`; without it `kong config parse` fails and Kong refuses to
# load the declarative config at all, so the gateway never starts. Catch it here
# at render time — the earliest point — instead of at container start.
if values.get('RATE_LIMIT_POLICY') == 'redis' and not values.get('RATE_LIMIT_REDIS_HOST'):
    print('ERROR: RATE_LIMIT_POLICY is "redis" but RATE_LIMIT_REDIS_HOST is empty.', file=sys.stderr)
    print('  Set KONG_RATE_LIMIT_REDIS_HOST to the managed Redis endpoint, e.g.:', file=sys.stderr)
    print('    export KONG_RATE_LIMIT_REDIS_HOST="$(terraform output -raw elasticache_primary_endpoint)"', file=sys.stderr)
    sys.exit(1)

# ── Validate: an armed queue gate needs an HMAC secret ────────────────────────
# QUEUE_HMAC_SECRET is rendered into queue-gate.lua at build time (which is also
# container start, via docker-entrypoint.sh). An armed gate with no secret would
# verify passes against an empty key, so fail before Kong starts. The value is
# never printed.
if values.get('QUEUE_GATE_ARMED') == 'true' and not values.get('QUEUE_HMAC_SECRET'):
    print('ERROR: QUEUE_GATE_ARMED is "true" but QUEUE_HMAC_SECRET is empty.', file=sys.stderr)
    print('  Set QUEUE_HMAC_SECRET in the values file to the queue-service pass-signing secret.', file=sys.stderr)
    sys.exit(1)

# ── Validate: an armed gate outside local must not use the committed dev secret ─
# _defaults.yml carries a dev QUEUE_HMAC_SECRET that is public in git. If no env
# values file or runtime QUEUE_HMAC_SECRET replaces it, anyone could forge a
# qq_pass cookie. Compared against the expanded default; never printed.
if (values.get('QUEUE_GATE_ARMED') == 'true'
        and target_env not in ('local', 'minikube')
        and values.get('QUEUE_HMAC_SECRET', '') in ('', default_queue_secret)):
    print('ERROR: QUEUE_GATE_ARMED is "true" for environment '
          f'"{target_env}" but QUEUE_HMAC_SECRET is empty or the committed dev default.', file=sys.stderr)
    print('  Inject QUEUE_HMAC_SECRET into the container from a secret (same value as the', file=sys.stderr)
    print('  queue-service Queue__HmacSecret); never commit it to a values file.', file=sys.stderr)
    sys.exit(1)

# ── Load and indent jwt-sub.lua ───────────────────────────────────────────────
# The {{JWT_SUB_LUA}} placeholder sits at 18 spaces of indentation inside a
# YAML literal block scalar (`- |`).  Every line of the Lua file must be
# indented by 18 spaces so the block parses correctly.
LUA_INDENT = ' ' * 18

with open(lua_path) as f:
    jwt_sub_content = f.read().replace('SIGNING_KEY_PLACEHOLDER', signing_key)

lua_lines = jwt_sub_content.rstrip('\n').splitlines()

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

# ── Lint: every jwt route declares its OAuth policy (D9) ─────────────────────
# A route that verifies JWTs must say whether OAuth access tokens may use it:
# {{SCOPE_CHECK_LUA:<scope>}} admits tokens that hold <scope>, {{OAUTH_DENY_LUA}}
# refuses them. Exactly one, as the FIRST post-function access entry: the guards read the
# token the jwt plugin verified, which a pre-function cannot see. A route that
# forgets fails the build instead of silently admitting agents (F11).
OAUTH_GUARD_RE = re.compile(r'\{\{(?:SCOPE_CHECK_LUA:[^}]+|OAUTH_DENY_LUA)\}\}')
bad_routes = []
for block in re.split(r'\n(?=      - name: )', content):
    lines = [l for l in block.split('\n') if not l.lstrip().startswith('#')]
    block = '\n'.join(lines) + '\n'
    if '          - name: jwt\n' not in block:
        continue
    guards = OAUTH_GUARD_RE.findall(block)
    post = block.find('          - name: post-function\n')
    if len(guards) != 1 or post == -1:
        bad_routes.append(lines[0].strip())
        continue
    # The guard must sit in the FIRST `- |` entry of the post-function access
    # list, so nothing (e.g. a header-injecting entry) runs before it. Compare
    # entries by their `- |` markers, not by indentation depth.
    entries = re.split(r'^[ \t]*- \|[ \t]*$', block[post:], flags=re.M)[1:]
    if not entries or not OAUTH_GUARD_RE.search(entries[0]):
        bad_routes.append(lines[0].strip())
if bad_routes:
    print('ERROR: each jwt route needs exactly one OAuth guard '
          '(SCOPE_CHECK_LUA or OAUTH_DENY_LUA) as the FIRST entry of its post-function access list:',
          file=sys.stderr)
    for r in bad_routes:
        print(f'  {r}', file=sys.stderr)
    sys.exit(1)

# ── Substitute {{JWT_SUB_LUA}} (multi-line, placeholder may have leading spaces) ──
content = re.sub(r'[ \t]*\{\{JWT_SUB_LUA\}\}', lua_block, content)

# ── Substitute {{SCOPE_CHECK_LUA:<scope>}} placeholders ───────────────────────
# Each occurrence encodes the required scope in the placeholder, e.g.:
#   {{SCOPE_CHECK_LUA:orders:read}}
# build.sh reads jwt-scope.lua, replaces SCOPE_PLACEHOLDER with the captured
# scope string, indents 18 spaces, and substitutes inline.
def make_scope_lua(scope_lua_content, scope, indent):
    replaced = (scope_lua_content.replace('SCOPE_PLACEHOLDER', scope)
                .replace('API_AUDIENCE_PLACEHOLDER', oauth_api_audience))
    lines = replaced.rstrip('\n').splitlines()
    return '\n'.join(indent + line for line in lines)

with open(scope_lua_path) as f:
    scope_lua_content = f.read()

def replace_scope_check(m):
    scope = m.group(1)
    return make_scope_lua(scope_lua_content, scope, LUA_INDENT)

content = re.sub(r'[ \t]*\{\{SCOPE_CHECK_LUA:([^}]+)\}\}', replace_scope_check, content)

# ── Substitute {{OAUTH_DENY_LUA}} ────────────────────────────────────────────
with open(deny_lua_path) as f:
    deny_lua_block = '\n'.join(
        LUA_INDENT + line for line in f.read().rstrip('\n').splitlines())

content = re.sub(r'[ \t]*\{\{OAUTH_DENY_LUA\}\}', lambda m: deny_lua_block, content)

# ── Substitute {{QUEUE_GATE_LUA:<mode>}} ─────────────────────────────────────
# Modes: graphql-reserve (gate bodies containing "reserve") and always (gate
# every request). The Lua keeps its {{QUEUE_*}} scalars; the pass below fills them.
QUEUE_GATE_MODES = ('graphql-reserve', 'always')

with open(queue_lua_path) as f:
    queue_lua_content = f.read()

def replace_queue_gate(m):
    mode = m.group(1)
    if mode not in QUEUE_GATE_MODES:
        print(f'ERROR: unknown queue gate mode {mode!r}; expected one of {QUEUE_GATE_MODES}',
              file=sys.stderr)
        sys.exit(1)
    lines = queue_lua_content.replace('QUEUE_GATE_MODE_PLACEHOLDER', mode).rstrip('\n').splitlines()
    return '\n'.join(LUA_INDENT + line for line in lines)

content = re.sub(r'[ \t]*\{\{QUEUE_GATE_LUA:([^}]+)\}\}', replace_queue_gate, content)

# ── Substitute {{ROLE_CHECK_LUA:<role>}} placeholders ────────────────────────
# Similar to SCOPE_CHECK_LUA, each occurrence encodes the required role:
#   {{ROLE_CHECK_LUA:organizer}}
def make_role_lua(role_lua_content, role, indent):
    replaced = role_lua_content.replace('ROLE_PLACEHOLDER', role)
    lines = replaced.rstrip('\n').splitlines()
    return '\n'.join(indent + line for line in lines)

with open(role_lua_path) as f:
    role_lua_content = f.read()

def replace_role_check(m):
    role = m.group(1)
    return make_role_lua(role_lua_content, role, LUA_INDENT)

content = re.sub(r'[ \t]*\{\{ROLE_CHECK_LUA:([^}]+)\}\}', replace_role_check, content)

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
