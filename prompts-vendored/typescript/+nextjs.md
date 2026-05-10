---
id: typescript.nextjs
description: Next.js (App Router) conventions — sourced from eslint-plugin-next and Next docs.
extends: [typescript/+react]
---

# Next.js (App Router) checks

In addition to React rules, apply these on Next.js code.

## Server vs client components

- **`'use client'` directive** — top of file. Required for any component that uses `useState`, `useEffect`, event handlers, browser APIs, or third-party libraries that touch the DOM.
- **`'use client'` push-down** — flag a top-level layout marked `'use client'` when only a leaf needs interactivity. Push the directive to the leaf component to keep the rest server-rendered.
- **Async server component** (`async function Page(...)`) — fine. Flag `async` on a `'use client'` component (won't work, must be a sync function returning JSX).
- **Server-only secrets in client components** — flag block-severity. `process.env.SECRET_KEY` referenced in a `'use client'` file leaks the value into the browser bundle. Use `process.env.NEXT_PUBLIC_*` for intentional client values; otherwise read in a server component or a route handler.
- **Importing `fs`, `path`, `node:*` modules from a client component** — flag block-severity, build will break.

## Routing & metadata

- **`metadata` export from a client component** — flag, only works in server components.
- **`generateMetadata` returning a promise that hits an unauthenticated API** — flag if the API is rate-limited; metadata generation runs at build and request time.
- **`<Link>` with a non-string `href` to a dynamic route** — flag if the route segments aren't escaped, can produce invalid URLs.
- **`<a>` to internal routes** — flag, use `<Link>` for client-side nav. External `<a>` is fine.
- **`router.push` followed by `router.refresh`** — flag if the intent is "re-fetch server data after navigation"; `router.push` already triggers RSC re-render.

## Data fetching

- **`fetch(...)` in server component without `cache:` or `next:` options** — flag if the data is per-request user-specific (will be cached forever) or if it's static (should be cached). Make the intent explicit: `fetch(url, { cache: 'no-store' })` or `{ next: { revalidate: 60 } }`.
- **Calling a server action from a server component for non-mutation reads** — flag, server actions are POST endpoints meant for mutations. Just call the data-fetching function directly.
- **Server action without `'use server'` at the top of the file or function** — flag block-severity, won't work.
- **Server action with no input validation** (zod, valibot, etc.) — flag, the action is a public endpoint accepting arbitrary input.
- **Mutations from a server action without `revalidatePath` or `revalidateTag`** — flag, the UI will show stale data.

## Images & assets

- **`<img>` instead of `<Image>` from `next/image`** — flag with severity low for static assets (loses optimization). Block if the image is user-uploaded and unbounded in size.
- **`<Image>` without `width` and `height`** (and not using `fill`) — flag, layout shift and Next will warn at build.
- **Unoptimized remote images** without configuring `next.config.js` `images.remotePatterns` — flag, runtime error.

## Middleware & route handlers

- **Middleware that fetches from a remote service synchronously** — flag, blocks every request through the matcher.
- **Route handler returning a `Response` that serializes to a different shape per branch** — flag, callers can't type the response.
- **Route handler missing `runtime` declaration** when using node-only APIs — flag, `runtime: 'nodejs'` is the default but be explicit if the file has imports that require it.

## Caching

- **`unstable_cache`** without a key — flag, all calls will hit the same cache entry.
- **`revalidatePath('/')`** in a server action — flag with severity low; revalidates the whole site, not the targeted page. Be specific.

## Bundling

- **Importing the whole of `lodash`** — flag, bundle bloat. Use `lodash-es` per-method imports or move to native.
- **Top-level `import` of a heavy library only used in one route** — flag, suggest dynamic import or moving to that route's file.

## Sources

- `eslint-plugin-next` — official Next.js rules.
- Next docs — App Router conventions, caching reference.
