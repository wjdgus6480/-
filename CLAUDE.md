# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DOTDAY: a personal app that shows todos, calendar events and projects as user-configurable tables. Local-first React frontend (IndexedDB) + Spring Boot sync API + MySQL. Project docs, comments and commit messages are written in Korean. Keep that style.

```
React + IndexedDB (Vercel) ──HTTPS/JWT──▶ Spring Boot 3.5 / Java 21 (Render, Docker) ──JDBC──▶ MySQL 8 (Aiven)
```

## Commands

Frontend (repo root):
```bash
npm run dev                                   # http://localhost:5173
npm test                                      # vitest run (all; no server needed)
npx vitest run tests/recurrence.test.ts       # single file
npx vitest run -t "테스트 이름"                # single test by name
npm run typecheck                             # tsc --noEmit (also runs as part of `npm run build`)
E2E_API_URL=http://localhost:8080 npx vitest run tests/e2e.backend.test.ts   # against a real running backend
```

Backend (`backend/`, JDK 21):
```bash
./mvnw test                                   # JUnit + MockMvc against H2 in-memory (no Docker/MySQL)
./mvnw test -Dtest=DomainSyncApiTest          # single test class
bash scripts/mysql-test.sh                    # same suite on real MySQL; needs backend/local.env with TEST_DATABASE_URL
DATABASE_URL='mysql://…' JWT_SECRET=<32+ chars> ./mvnw spring-boot:run      # http://localhost:8080
```

There's no linter. Type checking (`tsc`) is the static check.

## Configuration

- Frontend `VITE_API_URL` empty → **local-only mode**: no login and no sync, and `services.api`/`remote`/`domainRemote` are `null`. Set it to `http://localhost:8080` to enable auth and sync. `vite.config.ts` forces it to `''` under vitest, so tests never hit a real server.
- Backend env: `DATABASE_URL` (Aiven Service URI, `mysql://…?ssl-mode=REQUIRED`, which `DatabaseUrlEnvironment` converts to JDBC) or `DB_URL`/`DB_USER`/`DB_PASSWORD`. Also `JWT_SECRET` (the server won't start without it), `CORS_ORIGINS` and `TOKEN_TTL` (default 14d).
- Schema is managed by Flyway (`backend/src/main/resources/db/migration`) and applied on server startup. Add a new `V{n}__*.sql`. Never edit an applied migration.

## Architecture

### Two independent data planes
Business data (`src/domain/`: tasks, events, projects, categories) and view preferences (`src/views/`: column/sort/filter/layout configs) are deliberately separate. Each has its own repository, IndexedDB outbox (`domain_outbox` / `view_outbox`), conflict and backup stores, sync engine, REST remote, and server endpoint (`/api/sync/domain/*` vs `/api/sync/views/*`, `DomainOpService` vs `ViewOpService`). A change to one plane usually needs the matching change on the other side of the wire, not in the other plane.

### Local-first write path
`repo.ts` writes the record **and** an outbox op in one IndexedDB transaction (`src/db/idb.ts` defines the stores; bump `DB_VERSION` and add an `oldVersion <` upgrade branch for schema changes). The sync engine (`sync.ts`) later pushes the ops:
- Ops carry an `op_id`. The server stores each result, so resending the same `op_id` returns the stored result (idempotent). Result is one of `applied | conflict | not_found | rejected | retry`.
- `version` = the last server-confirmed version (0 = not yet on the server). Conflicts use a field-level 3-way merge (views: top-level fields only). Deletes are soft deletes, recoverable for 30 days.
- Pull is cursor-based: `GET …?since=<server_seq>`. The backend's `SeqCounter` hands out `server_seq` by locking a counter row, so a late-committing lower seq is never skipped by another device's cursor. Keep this invariant when touching backend writes.
- Failures are classified and backed off in `src/lib/syncPolicy.ts`. While the Render free tier is asleep, ops just stay in the outbox.

### Ownership / isolation
Every backend query is scoped by `owner_id` taken from the JWT (`CurrentUser`). Sessions are per device and revocable (`SessionValidator`, logout vs logout-all). Destructive account actions require a login within the last 10 minutes (`/api/auth/reauth`). On the frontend, repositories get the owner through a `() => session.owner` closure. `src/app/services.ts` wires everything and subscribes the session to `AuthController` before UI updates. `src/domain/migrate.ts` moves pre-login local data into the account on first sign-in.

Field names and validation rules on the server live in `backend/.../sync/EntitySpec.java` / `FieldSpec.java` (and `ViewConfigValidator`). Keep them in sync with `src/domain/types.ts` and `src/views/fields.ts`/`validate.ts`.

### Tests
- Frontend sync-engine tests (`tests/helpers.ts` → `makeDevice`/`makeServer`) run multiple simulated devices against a **PGlite emulator server** built from the SQL in `legacy/supabase/migrations/`. That legacy Supabase SQL is not used in production. It exists only as the test emulator, so don't delete it.
- REST adapters (`*/remote.ts`, `src/app/api.ts`) are tested with a fake fetch (`tests/apiFake.ts`). IndexedDB comes from `fake-indexeddb` (`tests/setup.ts`).
- The real server contract is verified by the backend JUnit tests (`ApiTestBase`, H2), plus optionally `mysql-test.sh` to catch H2 and MySQL differences.

## Design rules (from README)
- Identifier columns (title/name) can't be hidden. Only their order and width can change. The open/complete-row controls sit in a fixed leading cell outside column config.
- On mobile the table scrolls horizontally. Responsive layout never overrides the user's show/hide choices. Only the first column is sticky.
- View settings auto-save. "Save as" duplicates the view. If several default views exist (a sync race), the most recently modified one wins.
- Out of scope for the current phase: email verification/reset mail, OAuth (Google/Kakao/Naver) and CAPTCHA. These existed in the v0.4 Supabase build.
