# CodeRabbit parity roadmap

How `@catalysync/code-review` stacks up against the published CodeRabbit feature surface today, and the six-phase plan to close the gap.

## Capability inventory

Status legend: **shipped**, **partial**, **missing**.

| Capability | Status | Notes |
| --- | --- | --- |
| Walkthrough summary (PR-level "what changed and why") | partial (phase 1) | Top-level walkthrough block, populated from per-file summaries. Mermaid section is reserved and empty in phase 1. |
| File-level summaries (one paragraph per file) | partial (phase 1) | New `fileSummaryStep` runs per-file before the issue pass; rendered above the inline comments block. |
| Line-level review comments with severity grades | partial (phase 1) | New severity vocabulary: `nitpick / suggestion / warning / blocker / security`. Replaces the `block / high / medium / low` ladder. |
| Code suggestions in commit-ready diff format | shipped | Inline `suggestion` blocks emitted by `render.ts` when the fix is mechanical. |
| Sequence / flow diagrams (mermaid) for cross-file changes | missing | Stub block reserved in walkthrough; generator lands in phase 4. |
| PR description rewrite / improvement suggestions | missing | Phase 5. |
| Security review lane (auth, secrets, SQLi, XSS, SSRF, CORS, dep CVEs) | partial | Universal prompt has a security checklist; dedicated lane prompt + secret-scan + dep-CVE feed land in phase 3. |
| Performance review lane (N+1, allocations, render thrash, bundle delta) | partial | Universal prompt mentions perf; dedicated lane + bundle-delta probe lands in phase 3. |
| Test quality lane (coverage, mocks/fakes/stubs hygiene, flaky patterns) | partial | Universal `test_coverage_assessment` field; dedicated lane in phase 3. |
| Style + a11y lane (jsx-a11y, semantic HTML, mizu/Tailwind) | missing | Phase 3, plus a Tailwind/mizu-aware overlay. |
| Learnings memory (repo conventions captured + replayed) | missing | Phase 6. Stored in `.review/learnings.jsonl`, appended to layer 3. |
| Multi-language support via per-language prompts | partial (phase 1) | Loader detects per-file language and assembles `universal + language` per hunk batch. Phase 1: ts/tsx, js/jsx, py, md. |
| Configurable severity gating (PR-level fail policy) | partial (phase 1) | CLI exits 1 on `blocker` or `security` by default; gate is configurable in phase 2. |
| Multiple LLM backends (Claude, GPT, Gemini, local) behind a Provider interface | missing | Phase 2. |
| Comment threading / interactive replies | missing | Phase 6 (lower priority). |
| JSON output for CI | partial (phase 1) | `--format json` emits a `Review` shape validated by zod. |
| Generated-file filter | shipped | `diff.ts` drops lockfiles, dist/, snapshots. |
| Prompt caching (cost control) | shipped | Anthropic `cache_control: ephemeral` on the system prompt. |
| Path-aware rules (`.coderabbit.yaml`-style) | missing | Phase 5. |
| Repo init / scaffolding | shipped | `code-review init` writes `.review/project.md`, `.claude/agents/reviewer.md`, `.github/workflows/code-review.yml`. |

## Phase plan

24 PRs across six phases. Each bullet is a single shippable change ≤400 LOC.

### Phase 1 — parity foundation (this PR)

Goal: land the severity model, file-summary pass, walkthrough block, per-language loader, JSON output. Establishes the data shapes the rest of the roadmap builds on.

- `feat: severity model` — new ladder `nitpick / suggestion / warning / blocker / security`, zod-validated, with exit-code gate (`blocker` and `security` exit 1). Old `block/high/medium/low` is dropped; the prompt schema and parser both move.
- `feat: file summary step` — separate prompt step that consumes the hunks of a single file and emits one paragraph of "what changed and why". Rendered as the first section per file.
- `feat: pr walkthrough block` — top-level markdown aggregating per-file summaries, with an empty mermaid section reserved for phase 4.
- `feat: per-lang prompt loader` — language detection table (`.ts/.tsx`, `.js/.jsx`, `.py`, `.md`) + a prompt assembler that picks `_base/universal` + the language base per file. Path: configurable via `--prompt-root`.
- `feat: json output format` — `--format json|markdown` flag; JSON shape is the `Review` zod schema.
- `test: phase 1 surface` — language detection table, severity gate exit code, JSON shape, prompt-assembler picks right language, mocked LLM (no network).
- `docs: coderabbit roadmap` — this file.
- `docs: harness integration` — README "Phase 1 capabilities" + `docs/severity-policy.md` + `docs/integrations/harness.md` (GH Action snippet + `.claude/settings.json` PreToolUse hook).

### Phase 2 — provider abstraction + config (4 PRs)

Goal: stop being Anthropic-only, give teams a config surface that doesn't require code edits.

- `feat: provider iface` — `Provider` interface (`generate({system, user, signal})`), Anthropic implementation refactored behind it.
- `feat: openai provider` — GPT-4.1 / GPT-5 backend behind the same interface; model id + base URL configurable.
- `feat: gemini + local providers` — Gemini and OpenAI-compatible local (Ollama / vLLM) backends; chosen via `--provider <name>`.
- `feat: review config file` — `.review/config.yaml` reads provider, model, severity gate, prompt root, generated-file globs. CLI flags override.

### Phase 3 — review lanes (4 PRs)

Goal: deliver the four lanes CodeRabbit advertises as distinct passes.

- `feat: security lane` — dedicated prompt overlay loaded for files that touch auth, request handlers, raw SQL, or env-var reads. Lane prompt covers SQLi, XSS, SSRF, CORS, secrets.
- `feat: perf lane` — overlay for hot paths (loops, render trees, `Promise.all` candidates, DB callsites). Lane prompt covers N+1, allocations, render thrash.
- `feat: test quality lane` — overlay for `**/*.test.*`, `**/__tests__/**`, `**/spec/**`. Lane prompt covers mocks/fakes/stubs hygiene, flaky patterns, missing edge cases, snapshot abuse.
- `feat: a11y + style lane` — overlay for `.tsx/.jsx` with jsx-a11y rules, semantic HTML, Tailwind/mizu utility ordering, dark-mode contrast hints. Pulls from existing `code-review-prompts/typescript/+react.md`.

### Phase 4 — diagrams + cross-file reasoning (3 PRs)

Goal: render the kind of visuals reviewers actually share in PR threads.

- `feat: dep graph` — build a small per-PR dependency graph from import edges in changed files. Used to seed the mermaid block.
- `feat: mermaid sequence` — emit a sequence diagram when a PR adds/changes a request handler + at least one downstream call. Live in the walkthrough's reserved mermaid section.
- `feat: cross-file critique` — second pass that gets the dep graph + file summaries and looks for cross-file invariants (handler ↔ schema, migration ↔ ORM, route ↔ middleware).

### Phase 5 — config + PR description (4 PRs)

Goal: feel like CodeRabbit when you open the PR.

- `feat: pr description rewrite` — first review comment includes a proposed PR description (Context, Decision, Alternatives, Risks, Testing). Author can copy or ignore.
- `feat: path-aware rules` — `.review/paths.yaml` with `globs: rules` map; rules merge into layer 3 only for matching files. Mirrors `.coderabbit.yaml`.
- `feat: changeset hints` — when `.changeset/` is missing for a feat/fix PR, post one suggestion comment with a draft changeset.
- `feat: cost + token report` — write `.review/report.json` per run with tokens, cache hits, per-lane cost; surfaced as a one-liner in the walkthrough footer.

### Phase 6 — memory + interaction (4 PRs)

Goal: get better with use.

- `feat: learnings store` — `.review/learnings.jsonl`, one record per accepted/dismissed suggestion. Recorded by a GH webhook handler.
- `feat: learnings recall` — at compose time, the top-K relevant learnings (by file path + category) are appended to layer 3. Bounded to 2 KB.
- `feat: pr comment threading` — when an author replies to a review comment with `@code-review explain` / `@code-review fix`, the bot answers in-thread. Stateless beyond the parent comment id.
- `feat: dismiss + train` — `@code-review dismiss <reason>` records the dismissal in learnings so the same comment doesn't recur.

## Cross-cutting gates

These don't ship as PRs but constrain every PR above:

- Lint + typecheck clean.
- Tests green ≥95 % on changed files.
- No real LLM or GitHub calls in tests — mock with `msw` or factory.
- Commit messages lowercase, ≤30 chars, no attribution.
- PRs ≤400 LOC unless tagged `pr-size-override` with a one-line rationale.
