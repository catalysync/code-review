# code-review

Layered LLM code review for any repo. It reviews a GitHub pull request, **checks every finding before posting it**, posts inline comments with one-click `suggestion` blocks, and keeps re-reviews short. It follows the process in Anthropic's [How the Claude Code team does code review](https://claude.dev/blog/solving-code-review-at-anthropic/): predictable output over volume.

Pairs with [`@catalysync/code-review-prompts`](https://github.com/catalysync/code-review-prompts), the prompt library this ships vendored.

## How a review runs

```
find  →  verify  →  post  →  converge
```

1. **Find.** One call reads the diff with three layers of rules (universal → language/framework → your `REVIEW.md`) and returns findings through a `submit_review` tool call, validated against a schema. No free-text parsing. If the output is cut off, it retries once with a bigger budget, then fails with a clear "review truncated" error.
2. **Verify.** Every finding goes to a separate verifier call that sees the finding, the cited code and its surroundings, and must confirm it with file:line evidence. `--verify-votes 3` takes a majority of three. Rejected and style-only findings are dropped.
3. **Post.**
   - Each finding is tagged **Important**, **Nit** (max 3) or **Pre-existing** (code the PR didn't touch, max 3).
   - Findings whose lines aren't in the diff go into the summary instead of inline. One stray line number used to make GitHub reject the whole review.
   - The summary starts with a count and says "No issues found" when there are none.
   - Each comment carries a hidden fingerprint, so the same finding is never posted twice.
4. **Converge.**
   - After the first round, re-reviews only look at commits since the last reviewed one (`--since`, or automatic).
   - After `--max-rounds` (default 3) it posts one note asking the author to step back instead of another round.
   - The model is told to report a whole class of bug once, listing every location.

**CI gate.** The command exits 1 only on **verified, Important** findings with blocker/security severity, never on a single unverified opinion. Add `--no-fail-on-blockers` to make it advisory.

## Install

Not on npm yet. Run it from a clone:

```bash
git clone https://github.com/catalysync/code-review && cd code-review
pnpm install && pnpm build
alias code-review="node $PWD/dist/cli.js"
```

## Quickstart

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=$(gh auth token)

cd /path/to/your/repo
code-review init                                   # REVIEW.md + Claude Code agent + GitHub workflow
code-review pr 42 --owner you --repo proj --dry-run  # print the review, post nothing
code-review pr 42 --owner you --repo proj            # post it
```

Start with `--dry-run` for a week and tune `REVIEW.md` before letting it post or block merges.

## Other models (DeepSeek, GLM, anything Anthropic-compatible)

The CLI speaks the Anthropic Messages API, so any provider with an Anthropic-compatible endpoint works:

```bash
# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic ANTHROPIC_API_KEY=$DEEPSEEK_KEY \
  code-review pr 42 --owner you --repo proj --model deepseek-flash --verify-model deepseek-flash --dry-run

# Z.ai GLM
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic ANTHROPIC_API_KEY=$ZAI_KEY \
  code-review pr 42 --owner you --repo proj --model glm-4.7 --dry-run
```

- `--model` defaults to `$ANTHROPIC_MODEL`, and `--base-url` to `$ANTHROPIC_BASE_URL`.
- A cheaper `--verify-model` keeps cost down.
- If a provider can't do tool calls, add `--no-tools` to fall back to YAML output.
- Prompt caching (`cache_control`) is used where supported; other providers ignore it.

## REVIEW.md

`code-review init` writes a short `REVIEW.md` at the repo root. Keep it short. It tells the reviewer:

- **what failure looks like here**: "a migration that locks a big table", "royalties counted twice", "docs that lie"
- **what not to flag**: deliberate choices that look like bugs
- **paths to skip**: generated code, vendored files
- **always flag**: the mistakes your team keeps catching

When the reviewer keeps flagging something that's fine, add a line to `REVIEW.md`. When it keeps finding the same real bug, add a lint rule or a line in `CLAUDE.md` so the code stops being written that way. A legacy `.review/project.md` is still read.

## Commands

```
code-review init       Detect the stack; scaffold REVIEW.md, .claude/agents/reviewer.md, .github/workflows/code-review.yml
code-review compose    Print the composed prompt (pipe it into another tool)
code-review pr <n>     Review a PR: find → verify → post → converge
code-review eval       Score the reviewer against evals/cases: known bugs found, known false alarms raised
code-review feedback <n>  Record what happened to each review comment on a PR in .review/feedback.jsonl
```

Main `pr` options:

| Option | Default | What it does |
| --- | --- | --- |
| `--dry-run` / `--format markdown\|json` | off | Print instead of posting |
| `--model`, `--base-url` | env | Provider and model |
| `--verify-votes <n>` | 1 | Verifier calls per finding; 0 turns verification off |
| `--verify-model <id>` | `--model` | Cheaper model for verification |
| `--max-nits`, `--max-pre-existing` | 3, 3 | Cap low-value findings |
| `--max-rounds <n>` | 3 | Step-back note after N rounds; 0 = no cap |
| `--since <sha>` / `--no-incremental` | auto | Diff-only re-review control |
| `--no-walkthrough`, `--diagram` | walkthrough on | Per-file summaries, mermaid diagram |
| `--max-tokens <n>` | 8192 | Finder budget (retried once at 2x) |
| `--no-fail-on-blockers` | gate on | Don't exit 1 |

## Measuring it

Two commands keep the reviewer honest over time, the way Anthropic measures its own:

- **`code-review eval`** runs the pipeline on small PRs with known answers (`evals/cases`) and prints how many real bugs it found, how many known false alarms it raised, and whether clean PRs stayed clean. Run it before and after changing a prompt or model. `--min-recall 1 --max-false-alarms 0` turns it into a CI check. See [`evals/README.md`](evals/README.md).
- **`code-review feedback <n> --owner X --repo Y`** reads the bot's comments on a PR and records each outcome: fixed, disputed, intentional, acknowledged or ignored. It prints which kinds of comment are noisiest. Disputed and ignored comments are what to tune `REVIEW.md` against, and the best new eval cases.

## CodeRabbit-style extras, isolated

The walkthrough (per-file summaries) and the optional mermaid diagram are separate calls. If they fail, the review still posts without them, so they can never block or break a review.

## Three ways to run it

1. **Claude Code subagent:** `.claude/agents/reviewer.md` from `init`. Run it before opening a PR, the way Anthropic reviews in a fresh context first.
2. **CLI:** from any shell, script or hook.
3. **GitHub Action:** `.github/workflows/code-review.yml` from `init`. Set `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL` for other providers) as repo secrets. To block merges, make the check required in branch protection.

## Tests

```bash
pnpm install
pnpm test     # vitest, no network: model and GitHub calls are mocked
pnpm lint     # tsc --noEmit
pnpm build
```

## License

MIT.
