---
id: python.fastapi
description: FastAPI conventions — sourced from tiangolo/full-stack-fastapi-template, polarsource/polar, Netflix/dispatch.
extends: [python/base]
---

# FastAPI checks

In addition to the Python rules, apply these on FastAPI projects.

## Routes & dependencies

- **Path operation order matters** — static paths before parametric ones. `/users/me` before `/users/{user_id}`. Flag if the order is reversed and a static path becomes unreachable.
- **`response_model=` on every route returning a body** — flag missing `response_model` only when the return shape leaks fields the public API shouldn't expose (DB-internal IDs, password hashes, audit fields). The route may already be using a `*Read` schema as the return annotation, which is equivalent — don't double-flag.
- **`status_code=` explicit on routes that don't return 200** — flag a 201/204 route that omits this; OpenAPI docs will be wrong.
- **`Depends(get_db)` style** — fine. Async sessions: `AsyncSession = Depends(get_async_session)`. Flag if a sync `Session` is used inside an `async def` route handler (sync DB inside an async path blocks the event loop).
- **Dependency cycles** — circular `Depends` chains are accepted by FastAPI but produce confusing errors. Flag cycles you can see in the diff.
- **`HTTPException` vs returning `JSONResponse(..., status_code=...)`** — both fine. Flag only if the same route mixes both for the same error condition (inconsistent error envelope).

## Pydantic schemas

- **Base / Create / Read / Update split** — when a domain has more than two of {create, read, update} as separate concerns, expect:
  - `XBase(BaseModel)` — shared fields
  - `XCreate(XBase)` — input-only (e.g., plaintext password)
  - `XRead(XBase)` — adds DB-generated fields (id, created_at), `model_config = ConfigDict(from_attributes=True)`
  - `XUpdate(BaseModel)` — every field `Optional`, no `Base` inheritance because partial-update semantics
  - Flag drift: `Create` carrying server-generated fields, `Read` missing `from_attributes`, `Update` inheriting `Base` (forces all fields required).
- **`SecretStr` for passwords/tokens in input schemas** — flag plaintext `str` fields named `password`, `secret`, `token`, `api_key` unless the schema is intentionally a CLI flag holder.

## Auth & security

- **`OAuth2PasswordBearer` vs `HTTPBearer`** — both fine, document which is the house style. Flag mixing in the same project unless one is for tokens-from-a-form and one for tokens-from-a-header on different routes.
- **`HTTPBearer(auto_error=False)`** — flag if `auto_error` defaults to `True` on a route where the team's pattern is "return 401 with our envelope, not FastAPI's default."
- **Login endpoint timing oracles** — when a login route has an early-return for "user not found / inactive / no password" before the password verification call, flag with severity high. Wall-clock difference between the early-return path (microseconds) and the full-verify path (argon2: ~100-300ms) leaks user existence even if status and body are identical. Fix: compute argon2 against a constant dummy hash on the early-return path so both branches do equivalent work.
- **JWT decode without `algorithms=[...]`** — already in `python/base`, but doubly important here because `pyjwt` and `python-jose` both default to "any algorithm in the header" if you don't pin.
- **Refresh token reuse without `kind` claim** — when issuing both access and refresh tokens, flag if the decode path doesn't enforce `kind == "refresh"` on the refresh endpoint. Otherwise an access token can be used to mint new tokens.

## SQLAlchemy 2.0 patterns

- **`Mapped[T] = mapped_column(...)` (typed style)** — modern. Flag `Column(...)` without `Mapped[T]` only when the rest of the codebase is consistently typed (drift), not as a blanket complaint.
- **`async_sessionmaker` + `AsyncSession`** — flag if a route uses sync `Session` while the rest of the project is async.
- **`server_default=` vs `default=`** — `default=` runs in Python at flush time; `server_default=` is the DB DEFAULT clause. Flag a column where the diff has only `default=` but the migration adds the column with no `server_default` and existing rows are expected to be backfilled by the database.
- **N+1 via lazy relationship loading** — flag obvious cases: `for parent in (await session.execute(...)).scalars(): for child in parent.children:` triggers a query per parent. Suggest `selectinload(Parent.children)` in the original `select`.

## Alembic migrations

- **One table per migration file, when convention** — many teams prefer this. Don't enforce it unless the existing migrations follow the pattern. When they do, flag a migration that creates 3 tables in one file.
- **`down_revision` chain** — flag if a new migration's `down_revision` doesn't point at the most recent existing one.
- **`op.create_table(..., sa.Column(..., nullable=False))` with no `server_default`** — when applied to a table with existing rows, this fails. Flag unless the migration also has a backfill `op.execute(...)`.
- **Column type changes in a migration** — flag if the change is not transparent (e.g., `String(255) -> String(64)`). Suggest a multi-step migration.
- **Foreign key without `ondelete=`** — flag, ambiguous behavior. Suggest `ondelete="CASCADE"` / `"SET NULL"` / `"RESTRICT"` based on the relationship.

## Background tasks

- **`BackgroundTasks` from FastAPI** — runs after the response. Flag if used for anything that needs reliability (it's lost on a process restart). Suggest a real queue (arq, celery, dramatiq, taskiq) for durable work.
- **Long-running async tasks fired from a request handler without a queue** — same issue.

## Testing

- **`TestClient` from `fastapi.testclient`** — sync; uses httpx + ASGI transport. Fine.
- **`AsyncClient(transport=ASGITransport(app=app))`** — for async-native test cases. Both styles fine; flag mixing within one test file as inconsistency.
- **DB tests that don't roll back** — flag if test fixtures don't clean up (transaction rollback, truncate, or per-test schema). Tests will pollute each other.
- **Tests that hardcode `localhost:5432` or production-shaped URLs** — flag, suggest reading from settings or `.env.test`.

## Sources

- `tiangolo/full-stack-fastapi-template` — canonical structure, Mapped[T] style, schema layout.
- `polarsource/polar` — service-layer / route-handler split, Pydantic Base/Create/Read/Update.
- `Netflix/dispatch` — production-grade dependency injection patterns.
- `langflow-ai/langflow` — lazy imports for heavy optional deps to keep cold-start fast.
- OWASP Cheat Sheet (REST Security, Authentication).
