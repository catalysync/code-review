# Evals

Small PRs with known answers. `code-review eval` runs the real pipeline (find → ground → verify → tag) on each one and reports:

- how many known bugs it found
- how many known false alarms it raised
- how many other Important findings it made (noise to look at)
- whether clean PRs came back clean

Run it before and after changing a prompt, a model or the verifier, and compare.

```bash
code-review eval                         # all cases, model from $ANTHROPIC_MODEL
code-review eval --only unpermitted-param
code-review eval --min-recall 1 --max-false-alarms 0   # fail CI on any regression
```

It makes real model calls, a few per case.

## A case

```
evals/cases/<name>/
  case.json    title, description (the PR body), layers, rules (REVIEW.md text), expect, forbid
  diff.patch   the unified diff under review
  files/       optional: files at the PR head, so grounding and the verifier see real code
```

`expect` lists the real bugs the reviewer must find; `forbid` lists false alarms it must not raise. Each entry has an `id`, a `file` (or a list of files), an optional `lines: [from, to]` range and an optional `match` regex over the finding's title, why and evidence. A case with no `expect` is a clean PR: it passes when no Important finding comes back.

## The seed cases

| Case | Kind | From |
|---|---|---|
| `settlements-paid-twice` | real bug | Boksmart PR #1556: unpaid total included historical settlements |
| `unpermitted-param` | real bug | Boksmart PR #1556: `rights_type` on the form but not in permitted params |
| `nil-guard-exists` | false alarm | a "missing nil guard" when the guard is two lines up |
| `invented-column` | false alarm | the PR #1556 review cited a `calculation_state` column that doesn't exist |
| `docs-only` | clean | a docs-only PR must come back with nothing |

## Growing it

Every bug the reviewer misses in a real PR, and every false alarm an author has to argue with, becomes a new case. `code-review feedback <pr>` records which comments were disputed or ignored; those are the first candidates.
