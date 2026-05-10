---
id: typescript.react
description: React conventions — sourced from eslint-plugin-react, react-hooks, and the React docs' "you might not need an effect" guidance.
extends: [typescript/base]
---

# React checks

In addition to the TypeScript rules, apply these on React code.

## Hooks

- **Hook called conditionally** — flag block-severity. `if (cond) useState(...)` violates the rules of hooks; React will throw or silently corrupt state across renders.
- **Hook called inside a loop or callback** — same. Hooks must be called at the top level of the component or another hook.
- **`useEffect` with missing dependency** — flag, the effect will use stale values. Common offenders: closures over props/state not in the deps array.
- **`useEffect` with an over-eager dependency** (an inline object/array literal) — flag, causes the effect to run every render. Suggest `useMemo` for the dep or move it out of the component.
- **`useEffect` doing what could be a `useMemo` / a derived value / an event handler** — flag with the React docs' "you might not need an effect" lens. If the effect just sets state from props, it's a derived value: compute it inline.
- **Cleanup missing on `useEffect` that subscribes** — flag, leaks. `useEffect(() => { sub(); return () => unsub(); }, [...])`.
- **`useState` initializer that's expensive** — flag, suggest the lazy form `useState(() => expensive())`.
- **`useCallback` / `useMemo` without a dependency array** — flag, equivalent to recomputing every render (and worse, signals intent that's not delivered).
- **`useCallback` wrapping a function that's only used inside one effect** — flag, the memo is unused; the dep array of the effect is what controls the closure.

## Components

- **Components named in lowercase** — flag, React treats lowercase as host elements (HTML tags). `function button(...)` will silently fail to render.
- **Mutating props** — flag block-severity. Props are immutable.
- **`key={index}` on a list that can reorder, insert, or delete items** — flag, causes wrong DOM diffs and lost state. Use a stable id.
- **Using `<></>` (fragment) when the parent already accepts an array** — flag with severity low; it's a noise reduction, not a bug.
- **Inline object / array / function as a prop to a memoized child** — flag, defeats the memo. `<MemoChild config={{ x: 1 }} />` re-renders every time. Suggest hoisting or `useMemo`/`useCallback`.

## State

- **`setState(s + 1)` followed by `setState(s + 1)` expecting two increments** — flag, will only increment once. Use the functional form `setState(s => s + 1)`.
- **State that's derived from props** stored in `useState` — flag, suggest computing inline (`const x = useMemo(() => derive(props.y), [props.y])`).
- **Storing the same data in two places** (state + context, state + URL) — flag, will diverge.

## Forms

- **Uncontrolled input mixed with controlled state** — flag, React warns at runtime.
- **Form submission without `e.preventDefault()`** in a SPA — flag, page navigates.
- **Sensitive form data (password, credit card) in `defaultValue`** — flag, captures input but doesn't update React state on change.

## Accessibility

- **`<div onClick={...}>` without `role="button"` and `onKeyDown`** — flag, not keyboard accessible.
- **`<img>` without `alt`** — flag. Decorative images use `alt=""`.
- **`<a href="#">` for buttons** — flag, use `<button type="button">`.
- **`tabIndex` greater than 0** — flag, breaks tab order.

## Performance

- **`React.memo` on a component that has children as a prop** — flag, children almost always changes identity each render unless the parent memoizes them.
- **Re-rendering a long list without virtualization** — flag if list length is unbounded.
- **`useReducer` for trivial state** — flag with severity low; not a bug, just complexity tax.

## Server / client boundaries (React Server Components, Next App Router — see `+nextjs`)

- **`'use client'` at the top of a file that has no client-only API usage** — flag with severity low; expanding the client bundle for nothing.
- **Importing a server-only module from a client component** — flag block-severity.

## Sources

- `eslint-plugin-react` — rules of JSX, key, deprecated APIs.
- `eslint-plugin-react-hooks` — rules of hooks, exhaustive-deps.
- React docs — "you might not need an effect", "thinking in React".
- `eslint-plugin-jsx-a11y` — accessibility heuristics.
