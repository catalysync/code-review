# Wiring `code-review` into a pre-merge harness

This doc shows how a downstream repo plugs `@catalysync/code-review` into its development harness so no PR merges without an adversarial review. Two integration points:

1. **GitHub Action** — runs the review on every PR. Posts inline comments. Fails the check when the severity gate trips.
2. **Claude Code `PreToolUse` hook** — warns (and optionally blocks) when a human or agent runs `git merge` / `gh pr merge` locally without a recent green review.

The two work together: the Action is the authoritative gate; the hook is a guardrail against bypassing it.

## 1. GitHub Action

Add the file below as `.github/workflows/code-review.yml`. `code-review init` writes a starter version; this is the same template, annotated.

```yaml
name: code-review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write   # post inline review comments

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }

      - run: pnpm add -D @catalysync/code-review

      - name: review
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          pnpm exec code-review pr "${{ github.event.pull_request.number }}" \
            --owner "${{ github.repository_owner }}" \
            --repo "${{ github.event.repository.name }}"
```

The job exits non-zero when the severity gate trips (`blocker` or `security`). Branch-protection rules can then require the `code-review / review` check before merge.

To run the review without posting (for forks / first-time contributors), add `--dry-run --format json` and pipe the output into a comment via `actions/github-script`. Phase 2 lands a first-class `--post-mode dry-run|inline|summary` flag.

### Required secrets

| Secret | Where to set | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | repo or org secrets | Authenticates the model call. Required. |
| `GITHUB_TOKEN` | provided by Actions | Posts inline comments. The default `GITHUB_TOKEN` is enough — no PAT needed. |

### Pre-merge gate

In **Settings → Branches → Branch protection rules** for `main`:

- Require status checks before merging.
- Mark `code-review / review` as required.
- Optionally also require `code-review / review` to be **up to date** with `main` — this re-runs the review on every push to the PR branch.

## 2. Claude Code `PreToolUse` hook

The Action is the gate, but a hook gives the human (or agent) a chance to notice they're about to merge without a review. Add this to the downstream repo's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "command": "node",
        "args": [".claude/hooks/warn-on-merge.mjs"]
      }
    ]
  }
}
```

And drop `.claude/hooks/warn-on-merge.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const cmd = input?.tool_input?.command ?? '';

const dangerous = [
  /\bgit\s+merge\b/,
  /\bgh\s+pr\s+merge\b/,
];
if (!dangerous.some((re) => re.test(cmd))) {
  process.exit(0);
}

// Soft-block: print a message to the user, then allow the call. Switch to
// `process.exit(2)` to hard-block instead.
process.stderr.write(
  [
    'pre-merge guard: this command merges code.',
    'Confirm the `code-review / review` GitHub check is green before continuing.',
    'Bypass by setting CODE_REVIEW_OVERRIDE=1 in the shell that runs this.',
    '',
  ].join('\n'),
);
if (!process.env.CODE_REVIEW_OVERRIDE) {
  process.exit(2);   // tell Claude Code to abort the tool call
}
process.exit(0);
```

The hook lives in the **downstream** repo, not this one — each repo decides whether it wants hard-block, soft-warn, or just print.

## Recommended posture

For a solo dev / small team:

- Hook in soft-warn mode (`process.exit(0)` with a stderr note).
- Action with `--dry-run` for the first week to calibrate the model.
- Flip the Action to enforcing mode and the hook to hard-block once the false-positive rate is acceptable.

For a larger team:

- Action enforcing from day one.
- Hook hard-blocks `gh pr merge`; the merge button on GitHub becomes the canonical path.
- Branch protection requires the check.

## Limits in phase 1

- The Action runs once per push. Comment-threading replies (`@code-review explain`) land in phase 6.
- The hook is shipped only as documentation in this PR. Phase 2 ships a `code-review hook install` command that writes the hook + settings entries into the downstream repo.
- Forks: `secrets.ANTHROPIC_API_KEY` is not available on PRs from forks. Use a `pull_request_target` workflow that runs the review against the merge commit, with an allowlist for first-time contributors. This is documented separately in phase 5.
