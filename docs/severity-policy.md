# Severity policy

`@catalysync/code-review` uses a five-grade severity ladder borrowed from CodeRabbit. The grade tells the reviewer (and the CLI) how seriously to take the finding.

## The grades

| Severity | When to use | Blocks merge? |
| --- | --- | --- |
| `nitpick` | Style or preference. The PR is fine without this change. | no |
| `suggestion` | Non-blocking improvement worth considering. | no |
| `warning` | Likely-bug or maintainability hazard. Reviewer should look but it does not have to block merge. | no |
| `blocker` | Must fix before merge. A correctness, contract, or data-integrity defect. | **yes** |
| `security` | Security defect: injection, auth bypass, secret leak, broken crypto, missing authorization. Not generic security advice. | **yes** |

Categories (`bug | security | performance | maintainability | convention`) are orthogonal — a finding can be `category: performance` + `severity: blocker` (e.g. an N+1 that takes down production), or `category: security` + `severity: warning` (e.g. a defense-in-depth opportunity that isn't currently exploitable).

## Exit-code policy

By default, `code-review pr <n>` exits with code:

- `0` when the review parses and contains no `blocker` / `security` issues.
- `1` when the review contains at least one `blocker` or `security` issue.
- `1` when the review errors before producing a parseable result (network, auth, malformed model output).
- `2` for argument errors (e.g. non-numeric PR number, unknown `--format`).

The blocking set is configurable in code (`evaluateSeverityGate(review, { blocking })`) and via `--no-fail-on-blockers` on the CLI. Phase 2 will expose it in `.review/config.yaml` (`fail_on: [blocker, security]`).

## Why not block on `warning`?

`warning` is meant to be reachable. If `warning` blocked merge, the model would either downgrade real bugs to `suggestion` to keep CI green, or every PR would carry stop-the-line findings for the smallest hazard. Keeping `warning` non-blocking gives the model room to surface "look at this" without false-positive pressure.

If a team wants stricter gating, override the blocking set:

```ts
import { evaluateSeverityGate } from '@catalysync/code-review';

const gate = evaluateSeverityGate(review, {
  blocking: new Set(['warning', 'blocker', 'security']),
});
```

## Calibration

Roughly, for a 200-line PR:

- 0–1 `blocker` or `security` is normal when one exists.
- 1–3 `warning` is normal.
- 0–2 `suggestion` is normal.
- `nitpick` is usually empty; flag at most one.

If the model emits more than that ladder permits, treat it as evidence of padding and re-run with a tighter prompt.
