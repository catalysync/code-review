---
id: project
description: Project-specific review rules — Layer 3.
extends: {{LAYERS}}
---

# Project rules

This file is the third layer of the review prompt. It tells the reviewer the
deliberate choices you've made that look like bugs but aren't, and the local
conventions worth enforcing.

## NOT bugs — don't flag these

(Examples — replace with your project's actual deliberate choices. Each entry
saves a reviewer round-trip on a real recurring suggestion.)

- We use `<library X>` not `<library Y>`. The architecture decision is in `docs/adr/0003-x-vs-y.md`. Don't suggest the swap.
- Lowercase commit messages ≤30 chars are house style. Don't suggest conventional-commits.
- File names are kebab-case. Don't suggest PascalCase.

## Always flag (project-specific)

- Mention of `console.log` outside the `scripts/` directory.
- Any new `any` type added to `packages/api/`.
- Migrations that touch more than one table.

## Path-aware checks

### `src/auth/`

- (project-specific auth rules)

### `migrations/`

- (project-specific migration rules)
