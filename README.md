# code-review

Layered LLM code review for any repo. Composes universal + language + framework + project rules; calls Claude; posts inline GitHub review comments with `suggestion` blocks for one-click apply.

Pairs with [`@catalysync/code-review-prompts`](https://github.com/catalysync/code-review-prompts) (the prompt library this ships vendored).

## Why

Generic LLM reviewers miss the rules that matter to your team and re-suggest the choices you've already considered. CodeRabbit-style tools solve that with hand-curated rules, but they're closed source. This is the OSS shape:

- **Layer 1 — universal rules**: role, calibration, output schema, tone. Adapted from PR-Agent.
- **Layer 2 — stack rules**: per-language and per-framework. Lifted from clippy / gosec / bandit / eslint-plugin-react / tiangolo's FastAPI template / Rails security guide.
- **Layer 3 — project rules**: your repo's `.review/project.md`. The deliberate choices that look like bugs but aren't (e.g. "we use HTTPBearer, don't suggest OAuth2PasswordBearer"), the recurring real issues your team keeps catching.

The harness composes the three at runtime and runs them against a PR diff.

## Install

```bash
npm install -g @catalysync/code-review
```

Or pin per-project:

```bash
pnpm add -D @catalysync/code-review
```

## Quickstart

In a repo:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=ghp_...

code-review init                              # detect stack, scaffold .review/ + templates
code-review pr 42 --owner you --repo proj    # review PR #42 and post inline comments
```

To preview without posting:

```bash
code-review pr 42 --owner you --repo proj --dry-run
```

## Three ways to run it

### 1. Claude Code subagent (recommended for human-driven review)

`code-review init` writes `.claude/agents/reviewer.md`. The agent calls `code-review compose` to get the layered prompt, reads the diff, and renders inline review comments. Posts via `gh api` when you ask it to.

### 2. CLI (for codex, scripts, anything that's not Claude Code)

The `code-review` binary works against any LLM that speaks the Anthropic API. Invoke from a shell or a hook.

### 3. GitHub Action (for always-on auto-review)

`code-review init` also writes `.github/workflows/code-review.yml`. Set the `ANTHROPIC_API_KEY` repo secret and every PR gets reviewed.

## Commands

```
code-review init                Detect stack, scaffold .review/ + .claude/agents/ + .github/workflows/.
code-review compose             Print the composed prompt for stdin or piping to your own tool.
code-review pr <number>         Review a GitHub PR. Posts inline review comments with suggestion blocks.
```

Run `code-review <cmd> --help` for full options.

## Project rules — Layer 3

After `init`, edit `.review/project.md`:

```markdown
---
id: my-project
extends: ["python/+fastapi"]
---

## NOT bugs — don't flag

- We use `HTTPBearer(auto_error=False)` to control the error envelope. Don't suggest `OAuth2PasswordBearer`.
- Lowercase commit messages ≤30 chars are house style.
- Migrations split one-table-per-file. Don't ask us to combine.

## Always flag (project-specific)

- Any `console.log` outside `scripts/`.
- New `any` types added to `packages/api/`.
```

The reviewer reads this before flagging anything. This is the layer that makes review feel useful instead of noisy.

## Token efficiency

The system prompt is the same on every review for the same repo (~5–20 KB). The harness marks it for [Anthropic's prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) (`cache_control: { type: "ephemeral" }`) so subsequent reviews within ~5 minutes pay ~10% of the input-token cost on that segment. For a repo doing many small PRs, this is the difference between a 5¢ and a 0.5¢ review.

The harness also drops likely-generated files from the diff before sending: `pnpm-lock.yaml`, `package-lock.json`, `*.min.js`, `dist/`, `__snapshots__/*.snap`, and friends. See `src/diff.ts` for the full list.

## Output format

The model produces a single YAML object matching the schema in `_base/universal.md`. The harness parses it and renders to GitHub:

- **Inline review comments** anchored to `file:line_start..line_end`.
- **`suggestion` blocks** when the fix is mechanical (rename, single import, dead branch). The user clicks "Commit suggestion" in the GitHub UI to apply.
- **Multi-line suggestions** for ranges. Multi-step fixes that span non-contiguous regions go as separate suggestion comments.
- **Top-level body**: a walkthrough block (PR-level overview + per-file paragraphs, with a reserved mermaid section) followed by a one-sentence severity headline.
- **Never** the YAML schema as a PR comment.

## Phase 1 capabilities

This release lands the foundation called out in [`docs/roadmap/coderabbit-parity.md`](docs/roadmap/coderabbit-parity.md):

- **Severity model** — `nitpick | suggestion | warning | blocker | security`. `blocker` and `security` cause the CLI to exit non-zero. See [`docs/severity-policy.md`](docs/severity-policy.md).
- **File-level summary step** — every reviewed file gets a one-paragraph "what changed and why" summary, produced by a dedicated prompt step (`src/file-summary.ts`). LLM calls are injected so they can be mocked in tests.
- **PR walkthrough block** — file summaries are aggregated into a top-level walkthrough markdown block. The mermaid section is reserved for phase 4.
- **Per-language prompt loader** — files are bucketed by extension (`.ts/.tsx/.mts/.cts`, `.js/.jsx/.mjs/.cjs`, `.py/.pyi`, `.md/.mdx`) and each bucket gets `_base/universal` + its language base. Set `CODE_REVIEW_PROMPT_ROOT` (or `--layer`) to point at a sibling checkout of `code-review-prompts`.
- **Output formatter** — `--format markdown|json`. JSON round-trips through the `ReviewSchema` zod schema in `src/types.ts` so CI consumers get a stable shape.
- **Severity gate** — `code-review pr <n>` exits 1 when any issue carries `blocker` or `security`. Pass `--no-fail-on-blockers` to opt out.

## Wire it into your repo's pre-merge

See [`docs/integrations/harness.md`](docs/integrations/harness.md) for the GitHub Action snippet and the `.claude/settings.json` `PreToolUse` hook that warns when `git merge` or `gh pr merge` is invoked without a green review.

## Add a new stack

The vendored `prompts-vendored/` is a snapshot of `code-review-prompts`. Contribute new languages or framework overlays there — see [`code-review-prompts/CONTRIBUTING.md`](https://github.com/catalysync/code-review-prompts/blob/main/CONTRIBUTING.md). The harness picks them up automatically on the next release.

## Tests

```bash
pnpm install
pnpm test
pnpm build
```

Tests cover compose / detect / parse / render / diff. Anthropic and Octokit calls are not mocked end-to-end here — the contract surfaces are small enough that integration testing is better done by running against a real test PR with `--dry-run`.

## License

MIT.
