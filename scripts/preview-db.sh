#!/usr/bin/env bash
set -euo pipefail

# Orca-hosted, self-contained per-preview Postgres helper (referenced by orca.config's branch-demo
# preview). Living in the Orca repo — not the app repo — is the point: it works on ANY branch without
# the app carrying it, so there are no app-repo commits and no per-worktree copying.
#
# Run from the worktree's backend dir (orca.config does `cd backend` first): it reads THAT worktree's
# .env for DB credentials and, for `create`, runs the worktree's own scripts/migrate-local.sh — the
# only app-repo pieces it leans on, and both are present on every branch.
#
#   preview-db.sh create <db>   clone PREVIEW_TEMPLATE_DB (default branch_demo) -> <db>, then migrate <db>
#   preview-db.sh drop   <db>   terminate connections + drop <db>
#
# Config (env): PREVIEW_TEMPLATE_DB, PREVIEW_ENV_FILE (default .env); DB_HOST/DB_PORT/DB_MASTER_USER/
# PGPASSWORD come from the worktree .env.

CMD="${1:-}"; DB="${2:-}"
[[ -n "${CMD}" && -n "${DB}" ]] || { echo "Usage: $0 <create|drop> <db-name>" >&2; exit 1; }

# --- validate: DDL-safe identifier (interpolated into DDL, no bind params), and Orca's own preview
#     namespace ONLY, so a bad name can never touch the shared dev database. ---
valid_ident() { [[ "$1" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; }
valid_ident "${DB}" || { echo "Error: '${DB}' is not a valid database identifier" >&2; exit 1; }
[[ "${DB}" == orca_* ]] || { echo "Error: refusing to manage non-preview database '${DB}' (must start with 'orca_')" >&2; exit 1; }

# --- load DB connection env from THIS worktree's .env (cwd is the worktree backend dir) ---
ENV_FILE="${PREVIEW_ENV_FILE:-.env}"
[[ -f "${ENV_FILE}" ]] || { echo "Error: ${ENV_FILE} not found — run from the worktree's backend dir (is the worktree provisioned with backend/.env?)" >&2; exit 1; }
while IFS= read -r line || [[ -n "${line}" ]]; do
  [[ "${line}" =~ ^[[:space:]]*# ]] && continue; [[ -z "${line}" ]] && continue
  key="${line%%=*}"; val="${line#*=}"
  if [[ "${val}" =~ ^\'(.*)\'$ ]] || [[ "${val}" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"; fi
  export "${key}=${val}"
done < "${ENV_FILE}"

HOST="${DB_HOST:-localhost}"; PORT="${DB_PORT:-5432}"; SU="${DB_MASTER_USER:-postgres}"
: "${PGPASSWORD:?PGPASSWORD must be set (in the worktree .env) for admin psql}"
psql_admin() { psql -X -v ON_ERROR_STOP=1 -h "${HOST}" -p "${PORT}" -U "${SU}" -d postgres "$@"; }

# Bar new connections, terminate live ones, then drop. ALLOW_CONNECTIONS false closes the race where a
# live preview backend reconnects between terminate and DROP.
drop_sql() {
  cat <<SQL
DO \$\$ BEGIN
  -- datconnlimit = -2 marks an INVALID database (a CREATE ... WITH TEMPLATE interrupted mid-copy):
  -- it can only be DROPped, and ALTER on it raises a FATAL that kills the whole session — which is
  -- exactly the DB a re-run needs to clear. Skip the ALTER for those; the DROP below still reaps them.
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = '$1' AND datconnlimit <> -2) THEN
    EXECUTE format('ALTER DATABASE %I ALLOW_CONNECTIONS false', '$1');
  END IF;
END \$\$;
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "$1";
SQL
}

case "${CMD}" in
  drop)
    echo "Dropping preview DB ${DB}"
    psql_admin <<<"$(drop_sql "${DB}")"
    echo "Dropped: ${DB}"
    ;;
  create)
    TEMPLATE="${PREVIEW_TEMPLATE_DB:-branch_demo}"
    valid_ident "${TEMPLATE}" || { echo "Error: invalid template database '${TEMPLATE}'" >&2; exit 1; }
    echo "Cloning ${TEMPLATE} -> ${DB}"
    # CREATE DATABASE ... WITH TEMPLATE needs the template free of sessions: bar + terminate them for
    # the (fast) clone, then ALWAYS re-allow — the trap restores connections even if the clone fails,
    # so a failed spin-up can never leave the dev DB locked out.
    reallow() { psql_admin -c "ALTER DATABASE \"${TEMPLATE}\" ALLOW_CONNECTIONS true;" >/dev/null 2>&1 || true; }
    psql_admin -c "ALTER DATABASE \"${TEMPLATE}\" ALLOW_CONNECTIONS false;"
    trap reallow EXIT
    psql_admin <<SQL
$(drop_sql "${DB}")
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEMPLATE}' AND pid <> pg_backend_pid();
CREATE DATABASE "${DB}" WITH TEMPLATE "${TEMPLATE}";
SQL
    reallow; trap - EXIT
    echo "Migrating ${DB}"
    DB_NAME="${DB}" bash scripts/migrate-local.sh # the worktree's migrator; applies this branch's migrations
    echo "Preview DB ready: ${DB} (cloned from ${TEMPLATE})"
    ;;
  *)
    echo "Unknown command '${CMD}' (use create|drop)" >&2; exit 1
    ;;
esac
