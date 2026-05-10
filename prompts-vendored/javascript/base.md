---
id: javascript
description: Plain JavaScript idioms — for projects without TypeScript. Sourced from eslint-recommended, jsdoc patterns.
extends: [_base/universal]
---

# JavaScript checks

Apply on JavaScript-only codebases. Most TypeScript checks (`typescript/base`) also apply where the runtime surface is identical (async, ESM, error handling). Where they don't:

## Types via JSDoc

- **`@param`, `@returns` JSDoc on exported functions** — flag missing JSDoc only when the project's existing exports document with JSDoc (drift). Don't impose it on a project that has chosen to skip.
- **`@type {Object}`** — flag, use a specific shape `@type {{ x: number, y: string }}`.

## Equality

- **`==` instead of `===`** — flag. The exception is `x == null` to catch both `null` and `undefined`; that's a documented idiom.

## Modules

- **`require()` mixed with `import`** in the same file — flag, pick one.
- **`module.exports` reassignment after named exports** — flag, the reassignment wipes the named exports.
- **`process.env.X` accessed in browser-bound code without a build-time replacement** — flag, will throw `ReferenceError` at runtime.

## Numbers / dates

- **Comparing floats with `===`** — flag, suggest `Math.abs(a - b) < EPSILON`.
- **`new Date(string)`** with non-ISO strings — flag, parsing is implementation-defined.
- **`parseInt(x)`** without a radix — flag, `parseInt(x, 10)` is the explicit form.

## Async (in addition to TypeScript rules)

- **Callback APIs not promisified** in modern Node code — flag if `util.promisify` would clean up the call site.
- **`await` in a `.forEach`** — flag, `forEach` ignores promises. Use `for...of` or `Promise.all(arr.map(async ...))`.

## Conventions

- **`var` instead of `let`/`const`** — flag, `var` has function-scope leak.
- **Implicit globals** (assignment without `let`/`const`/`var`) — flag block-severity.
- **`with` statement** — flag block-severity.
