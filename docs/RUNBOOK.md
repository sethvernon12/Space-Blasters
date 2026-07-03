# RUNBOOK — Phase 0 local development & verification

Everything here is **local-only**. Nothing talks to any real Supabase project — the
tooling hard-refuses `*.supabase.co` URLs (see `db/scripts/lib.mjs`).

## One-time setup
```bash
cd db
npm install          # installs pg + embedded-postgres (real PostgreSQL binaries,
                     # ~40 MB, dev-only; no Docker or system Postgres required)
```

## Everyday commands (run from `db/`)
```bash
npm run migrate         # boots a throwaway PostgreSQL, applies supabase/local baseline
                        # + supabase/migrations/*.sql, seeds skills, tears down.
                        # Proves the migration set applies cleanly end-to-end.

npm test                # THE CROSS-CHILD LEAK TEST (10 tests): cross-family reads &
                        # writes blocked, sibling isolation, anon (game key) total
                        # lockout, mastery read-only to clients, append-only attempts,
                        # immutable consent ledger, unclaimed legacy rows invisible.

npm run validate        # static checks (taxonomy vs the REAL index.html STAGES/skill
                        # tags, CCSS shape, DATA_MAP coverage) + database security
                        # posture (RLS enabled+forced everywhere, zero anon grants,
                        # policies present, skills seed == taxonomy).

npm run validate:static # the file-level checks only (fast, no database)

npm run seed            # migrate + seed demo families/attempts/mastery, then report
```

### Using your own Postgres instead of the embedded one (optional)
```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```
Only local hosts are accepted (allowlist; anything Supabase-like is refused with a hard
error). **The target's `public` schema is DROPPED and recreated on every run** — point
this only at a scratch database (that's what CI's throwaway service container is).

## Game verification (unchanged from before)
```bash
# syntax: extract + parse the game script
python3 -c "import re;open('/tmp/game.js','w').write(re.search(r'<script>(.*?)</script>', open('index.html').read(), re.S).group(1))" && node --check /tmp/game.js

# visuals: 9 screenshots (iPhone portrait/landscape + desktop × start/game/results)
cd tools && node screenshot.mjs   # -> screens/ (gitignored); supabase.co blocked
```

## CI (runs automatically on every push/PR)
`.github/workflows/ci.yml`: game-syntax parse, static taxonomy validation, and the
migrate + validate + leak-test suite against a clean Postgres 16 service container.

## What this tooling can NEVER do (by design)
- Connect to the production Supabase project (hard guard + no credentials in repo).
- Apply migrations to any real database — that is a human-approved dashboard/CLI step
  (see `docs/NEEDS_HUMAN.md` and CLAUDE.md NON-NEGOTIABLE #1).
- Submit scores to the real leaderboard (screenshot tool aborts supabase.co requests).
