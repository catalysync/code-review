---
id: rust
description: Rust idioms — sourced from clippy, rustsec advisories, the Rust API guidelines.
extends: [_base/universal]
---

# Rust checks

Apply on Rust code.

## Safety

- **`unsafe` blocks** — flag every `unsafe` block that lacks a `// SAFETY:` comment explaining the invariants the caller is upholding.
- **`unwrap()` / `expect()` in library code** — flag. Acceptable in tests, examples, build scripts. In binaries, flag if the panic is reachable from user input.
- **`panic!()` in a library function** — flag, return a `Result` instead.
- **Integer overflow** in release builds — `+`, `-`, `*` wrap silently. Flag if the operation is on user-controlled values without `checked_*` / `saturating_*` / `wrapping_*`.
- **`as` casts that can truncate** — `let x: u8 = some_u32 as u8`. Flag, suggest `try_from`.

## Lifetimes & ownership

- **`&'static` lifetimes manufactured via `Box::leak`** — flag, intentional leak. Make sure the comment explains why.
- **`Rc<RefCell<T>>` / `Arc<Mutex<T>>` chains** — flag with severity low if a simpler ownership model would do; not always wrong.
- **Holding a `MutexGuard` across an `.await`** — flag block-severity, deadlock risk in async code. Drop the guard before awaiting.

## Errors

- **`Box<dyn Error>` in library APIs** — flag, callers can't match on it. Use a concrete error enum or `thiserror`.
- **`Result<T, ()>`** — flag, throws away error info. Use a typed error.
- **`unwrap_or_default`** on a `Result` where the error is meaningful — flag, swallowed.
- **`?` on a `Result` with a different error type without a `From` impl** — won't compile, but flag if the diff has a freshly added `From` that's overly broad.

## Async

- **`tokio::block_on` inside an async function** — flag, will deadlock the runtime.
- **Sync I/O inside an async function** — `std::fs::read`, `std::thread::sleep`, `Mutex` (use `tokio::sync::Mutex`). Flag.
- **`spawn` returning a `JoinHandle` that's dropped without `.await`** — flag, the task may not finish.

## Performance

- **`clone()` in a hot path** when a borrow would do — flag with severity low.
- **`String::from(&str)` vs `.to_string()`** — both fine; don't bikeshed.
- **`.collect::<Vec<_>>()` followed by `.iter()`** — flag, the collect is wasted.
- **`HashMap` for a small fixed key set** — flag with severity low, suggest a `match` or a `phf` map.

## Security

- **`std::process::Command::new(name).arg(userInput)`** — generally safe (no shell). Flag if the args are interpolated into a shell-invoked tool (`sh -c`).
- **`reqwest::Client::builder().danger_accept_invalid_certs(true)`** — flag block-severity.
- **`serde_json::from_str` on untrusted input without size limit** — flag for a DoS vector if the input is unbounded.

## Conventions

- **`pub use` re-exports without a `pub` module structure rationale** — flag with severity low.
- **`#[allow(...)]` without a comment** — flag, every allow needs a justification.
- **`.unwrap()` on a `Result` returned from a function whose docs say it can fail** — flag.

## Sources

- `clippy` — the canonical Rust linter.
- Rust API Guidelines.
- RustSec advisory database.
