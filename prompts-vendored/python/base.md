---
id: python
description: General Python idioms — version, typing, exceptions, security basics. Sourced from bandit, ruff, and PEP guidance.
extends: [_base/universal]
---

# Python checks

In addition to the universal rules, apply these when reviewing Python code.

## Language & version

- **`from __future__ import annotations`** — fine to use; do not flag its presence or absence as a stylistic choice. Flag only if a runtime that introspects annotations (`pydantic.v1`, `typer < 0.7`, `dataclasses` with `eval_str`) is used in the same file and would break.
- **`match` statements (3.10+), `tomllib` (3.11+), `Self` type (3.11+), `TypeAliasType` (3.12+)** — assume the project supports its declared Python version (`python_requires` / `requires-python` in `pyproject.toml`). Do not flag use of these unless the declared minimum is older.
- **`typing.Any`** — flag only when the surrounding code implies a stronger type was intended (e.g., a `Mapping[str, Any]` returned from a function whose docstring says it returns a specific shape). `Any` as an explicit "I haven't typed this yet" marker on a private helper is fine.

## Exceptions

- **`except ValueError, TypeError:`** — Python 2 syntax, **block-severity bug**. Python 3 parses this as `except ValueError as TypeError:`; with multiple types it's a `SyntaxError`. Fix: `except (ValueError, TypeError):`.
- **Bare `except:`** — flag unless paired with a logged-and-re-raised pattern. `except Exception:` is acceptable at top-level handlers (web framework, task runner) where the alternative is process death.
- **Swallowing exceptions silently** (`except Exception: pass`) — flag with severity high unless there's a comment explaining why and a logged side effect. "Best effort" cleanup is the only valid case.
- **Raising `Exception` or `BaseException`** — flag, suggest a specific subclass.
- **`raise X from Y` chaining** — when re-raising inside an `except`, prefer `raise NewError(...) from exc` to preserve context. Flag missing `from` only when the lost context would matter for debugging.

## Typing & dataclasses / pydantic

- **`Optional[X]` vs `X | None`** — both fine. Don't flag stylistic preference unless one is the declared house style.
- **`Pydantic v1 vs v2`** — check `pyproject.toml`. v1: `BaseModel.parse_obj`, `Config` class, `validator`. v2: `BaseModel.model_validate`, `model_config = ConfigDict(...)`, `field_validator`. Mixing API surfaces is a bug.
- **`pydantic.BaseModel` with `from_attributes=True` (v2) / `orm_mode = True` (v1)** — required for `Model.model_validate(orm_row)` to work. Flag if a pydantic schema is constructed from an ORM row without it.
- **`dataclass(frozen=True)` mutated via `__setattr__` workaround** — flag, this defeats the type guarantee.

## Async

- **Sync I/O inside `async def`** — flag. `requests`, `psycopg2`, `time.sleep`, `open()`, `subprocess.run()` block the event loop. Suggest `httpx.AsyncClient`, `asyncpg`, `asyncio.sleep`, `aiofiles`, `asyncio.create_subprocess_exec`.
- **`asyncio.gather` without `return_exceptions=True`** when partial failure is expected — flag if one task's exception will cancel siblings unintentionally.
- **Missing `await` on a coroutine** — type checkers usually catch this; flag if untyped or if a `# type: ignore` is hiding it.
- **Background tasks created with `asyncio.create_task` and not stored** — flag, the task can be GC'd before completion. Store the reference somewhere (a set, a registry).

## Security

(Sourced from bandit checks — adapted for diff review, not file scanning.)

- **`eval`, `exec`, `compile` on any input that touches user data** — flag block-severity. Even with `globals={}`, escapes exist.
- **`pickle.loads` / `cPickle.loads` / `marshal.loads`** on untrusted data — flag. Suggest `json` or a typed schema (pydantic, msgspec).
- **`yaml.load(...)` without `Loader=yaml.SafeLoader`** — flag block-severity. Use `yaml.safe_load`.
- **`subprocess.*(..., shell=True)`** with any non-literal command string — flag. Use the list form.
- **`os.system(...)` with any non-literal command** — flag, use `subprocess` with the list form.
- **`hashlib.md5(...)` / `hashlib.sha1(...)` for password hashing or signing** — flag. For passwords use argon2id (`pwdlib`, `argon2-cffi`). For signing use HMAC with SHA-256 or Ed25519.
- **`random.random()` / `random.choice` for security tokens** — flag. Use `secrets.token_urlsafe`, `secrets.token_bytes`.
- **JWT decode without `algorithms=[...]` pinned** — flag block-severity. `jwt.decode(token, key, algorithms=["HS256"])` — never let the alg come from the header. (`alg=none` and HS-vs-RS confusion attacks.)
- **`requests.get(url, verify=False)`** — flag. SSL verification disabled silently lets MITM attackers swap responses.
- **SQL string concatenation or f-strings into a query** — flag. Use parameterized queries (`?`, `:name`, or driver-specific placeholders).
- **`tempfile.mktemp()`** — race condition. Flag, suggest `tempfile.NamedTemporaryFile` or `tempfile.mkstemp`.
- **Hardcoded passwords, tokens, API keys** in source — flag block-severity even if the value looks like a placeholder ("changeme", "test"). Use environment variables.

## Performance

- **N+1 SQLAlchemy queries** — `for x in session.query(Parent).all(): x.children` triggers a query per row. Flag, suggest `selectinload` / `joinedload` / a single JOIN.
- **`for line in open(path).readlines():`** — reads the whole file into memory. Suggest `for line in open(path):` (lazy iteration) or `with open(path) as f:`.
- **Building a large string with `+=` in a loop** — O(n²) in CPython. Suggest `"".join([...])` or `io.StringIO`.
- **Repeated `dict.keys()` / `dict.values()` membership tests** in a hot loop — `in dict` is O(1); `in dict.keys()` is also O(1) but allocates a view; `in list(dict.keys())` is O(n). Flag the third.

## Conventions

- **`if __name__ == "__main__":`** for entry points only — flag if it's used as a "let me run this module to test it" sketch instead of a real test.
- **Imports at top of file** — flag mid-function imports unless they're a documented circular-import workaround or a heavy optional dep loaded lazily.
- **`print()` in library code** — flag, use `logging`. (CLI scripts and tests are exempt.)
- **`assert` for runtime checks in non-test code** — flag, asserts are stripped under `python -O`. Use `if ... raise ValueError(...)`.
