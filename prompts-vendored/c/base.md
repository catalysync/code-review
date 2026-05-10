---
id: c
description: C — memory safety, undefined behavior, security. Sourced from CERT-C, MISRA-C subsets, common UBSan findings.
extends: [_base/universal]
---

# C checks

Apply on C code. The bar is higher because the language has no memory safety net.

## Memory

- **`malloc` without a paired `free`** in the same lifetime — flag. Show the leak path.
- **`free` then use** (use-after-free) — flag block-severity.
- **`free` twice** (double-free) — flag block-severity.
- **`malloc(n * sizeof(T))` where `n` is from user input** — flag, integer overflow can produce a small allocation that the caller writes past. Use `calloc(n, sizeof(T))` (overflow-checked) or check explicitly.
- **`memcpy(dst, src, n)` where `n` exceeds `dst` size** — flag block-severity, buffer overflow.
- **`strcpy`, `strcat`, `sprintf`, `gets`** — flag block-severity, no bounds check. Use `strncpy` (and null-terminate manually), `snprintf`, `fgets`.
- **`alloca` with a non-constant size** — flag, stack overflow.
- **`memset(ptr, 0, sizeof(ptr))`** when `ptr` is a pointer — flag, sizeof(pointer) not sizeof(target). Use `sizeof(*ptr)` or the type.

## Undefined behavior

- **Signed integer overflow** — `int x = INT_MAX + 1` is UB. Flag operations on signed ints from user input without bounds check.
- **Shift by a negative or oversized amount** — `1 << 32` for a 32-bit int is UB.
- **Reading uninitialized memory** — flag if a code path can reach the read without writing.
- **`NULL` dereferences** — flag if the pointer can be null on the path.
- **Strict-aliasing violations** — flag `*((int *)&float_value)` style casts. Use `memcpy` to type-pun.

## Concurrency

- **`pthread_mutex_lock` without unlock on every return path** — flag, deadlock.
- **Volatile used as a sync primitive** — flag, `volatile` does not provide atomicity. Use `<stdatomic.h>`.

## Format strings

- **`printf(user_input)`** — flag block-severity, format string vulnerability. Always `printf("%s", user_input)`.

## Security

- **`system(cmd)` with non-literal `cmd`** — flag block-severity.
- **`tmpnam`, `mktemp`** — race conditions. Use `mkstemp`.
- **`rand()` for tokens / crypto** — flag, predictable.
- **`access(path, ...)` followed by `open(path, ...)`** — TOCTOU race. Suggest `open` with `O_NOFOLLOW` and check the result.

## Conventions

- **`goto` for cleanup** — accepted in C as the standard cleanup idiom; do not flag unless the labels are unstructured (jumping forward, jumping into blocks).
- **Magic numbers** — flag with severity low if a `#define` or `enum` would help.
- **`int` for sizes / counts** — flag, use `size_t`.
