---
id: typescript
description: TypeScript idioms — types, narrowing, async, promise hygiene, ESM. Sourced from typescript-eslint, type-level community conventions.
extends: [_base/universal]
---

# TypeScript checks

In addition to the universal rules, apply these on TypeScript code.

## Types

- **`any`** — flag unless the file has `// @ts-expect-error <reason>` adjacent or the comment explains why a stronger type isn't reachable. `unknown` + narrowing is almost always the right alternative.
- **`as` casts on values that didn't come from `unknown`** — flag. `as` defeats the type system; prefer narrowing (`if ('foo' in x)`, `instanceof`, type guards).
- **`as any`** — flag block-severity. Cascades type holes downstream.
- **`!` non-null assertion** in code paths where null is reachable — flag. Prefer explicit narrowing or a default.
- **`Function` type or `object` type** — flag, both are too loose. Use a specific signature or `Record<string, unknown>`.
- **`enum` (numeric)** — flag, prefer string-literal unions or `as const` objects. Numeric enums leak the reverse mapping at runtime and hurt tree-shaking.
- **Returning `Promise<any>` or `Promise<unknown>`** from a public function — flag, the caller has no way to use it without casting.

## Async

- **Floating promises** — `someAsync()` not awaited and not stored — flag. Either `await`, `void`, or assign to a variable. Lint rule `no-floating-promises` catches this; flag if it's slipped through.
- **`async` function with no `await`** — flag, the `async` is misleading. Either remove it or add the await it implies.
- **`Promise.all` over a list with mixed success/failure semantics** — flag, suggest `Promise.allSettled` if partial failure is acceptable.
- **`for (const x of arr) { await ... }`** — sequential. Flag if `Promise.all(arr.map(async x => ...))` would be safe (no shared mutable state, no rate limit).
- **`new Promise((resolve) => { ... resolve() ... })` wrapping a callback** without rejecting on error — flag, swallowed errors.

## Modules / ESM

- **`require(...)` in `.ts` files compiled to ESM** — flag, breaks under Node ESM resolution.
- **`__dirname` / `__filename` in ESM** — undefined under ESM. On Node 20.11+ use `import.meta.dirname` / `import.meta.filename`. On older runtimes use `fileURLToPath(new URL('.', import.meta.url))`.
- **Default exports in libraries** — flag, named exports are easier to refactor and tree-shake. Apps are exempt.
- **Circular imports** — flag if visible in the diff.
- **Mixed `.js` and `.ts` extensions in import paths** — pick one, follow `tsconfig.json#moduleResolution`.

## Error handling

- **`try { ... } catch (e) { }`** swallowed silently — flag.
- **`catch (e)` without typing** — `e` is `unknown` in modern TS. Flag if the code accesses `e.message` without `e instanceof Error` narrowing.
- **`throw "string"`** instead of `throw new Error(...)` — flag, loses stack trace.

## Performance

- **`JSON.parse(JSON.stringify(x))` for deep cloning** — flag, suggest `structuredClone`.
- **`Array.from(new Set(arr))` in a hot path** — fine for small lists; flag with severity low if `arr` is bounded by user input and could be very large.
- **String concatenation with `+` in a tight loop** — V8 handles this well now, don't flag unless you have a specific benchmark in mind.
- **`forEach` then `filter` then `map`** chain over large arrays — flag if a single pass would do.

## Conventions

- **`interface` vs `type`** — both fine. Flag mixing styles within one module as inconsistency.
- **Function vs arrow function for top-level exports** — both fine; defer to the file's existing style.
- **`const enum`** — flag if the project uses isolated modules (`tsconfig.json#isolatedModules: true`); incompatible.
- **`namespace`** — flag, deprecated for non-d.ts use.
