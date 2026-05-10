---
id: ruby
description: Ruby idioms — sourced from rubocop, brakeman.
extends: [_base/universal]
---

# Ruby checks

Apply on Ruby code (any framework).

## Language

- **`rescue =>` without an exception class** — catches `StandardError`. Flag if the surrounding context implies the author meant to catch everything (`rescue Exception`); flag separately if `rescue Exception` is what's actually written (catches `Interrupt`, `SystemExit` — almost never correct).
- **`rescue Exception => e; end`** — flag block-severity, swallows process signals and out-of-memory errors.
- **`begin; rescue; end`** with no body — flag, swallowed silently.
- **`raise "string"`** — works but loses the exception class. Suggest `raise SpecificError, "msg"` or a class.

## Common idioms

- **`obj.send(:method)` with a method name from user input** — flag block-severity, arbitrary method invocation including private. Use `public_send` and a whitelist.
- **`eval`, `instance_eval`, `class_eval`** with any non-literal string — flag.
- **`Marshal.load` on untrusted data** — flag, code execution risk. Use JSON.
- **`open(url)` with `URI.open`** — flag if the URL is non-literal; can be coerced to read local files (`|command`, file paths, etc.). Use `Net::HTTP` explicitly.
- **`%x{...}` or backticks `` `...` ``** with interpolation — flag, shell injection.
- **`system(cmd)` with interpolated strings** — flag, shell injection. Use the array form: `system("ls", "-l", path)`.

## Performance

- **`each` chain with multiple passes** — flag if a single `inject`/`reduce` would do.
- **`Array#+` in a loop** — allocates each time. Use `<<` or `concat`.
- **`String#+` in a loop building a large string** — allocates each time. Use `<<` or `String#concat`.

## Conventions

- **`unless ... else`** — flag, hard to read. Invert to `if`.
- **Method longer than 30 lines / 10 branches** — flag with severity low; not a bug, a maintainability flag.
- **Two-letter variable names outside of block-scope (`a`, `b`, `i`)** — flag in domain code.
