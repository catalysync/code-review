import type { Issue, Review, Severity } from './types.js';

/**
 * Severities that block merge by default. The CLI exits non-zero when any
 * issue in the review carries one of these.
 *
 * The set is intentionally tight: `blocker` is the "must fix" knob the model
 * reaches for; `security` is auto-blocking regardless of how the model labels
 * its other axes. Everything else is informational.
 */
export const DEFAULT_BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set([
  'blocker',
  'security',
]);

export interface SeverityGateOptions {
  /** Override the default blocking set (e.g. for `--fail-on warning`). */
  blocking?: ReadonlySet<Severity>;
}

export interface SeverityGateResult {
  /** True when at least one issue is in the blocking set. */
  blocked: boolean;
  /** Exit code: 1 when blocked, 0 otherwise. */
  exitCode: 0 | 1;
  /** Issues that triggered the gate, for printing. */
  triggering: Issue[];
  /** Count of issues per severity, useful for headlines. */
  counts: Record<Severity, number>;
}

export function severityCounts(issues: Issue[]): Record<Severity, number> {
  const out: Record<Severity, number> = {
    nitpick: 0,
    suggestion: 0,
    warning: 0,
    blocker: 0,
    security: 0,
  };
  for (const i of issues) out[i.severity] += 1;
  return out;
}

export function evaluateSeverityGate(
  review: Review,
  opts: SeverityGateOptions = {},
): SeverityGateResult {
  const blocking = opts.blocking ?? DEFAULT_BLOCKING_SEVERITIES;
  const triggering = review.issues.filter((i) => blocking.has(i.severity));
  const blocked = triggering.length > 0;
  return {
    blocked,
    exitCode: blocked ? 1 : 0,
    triggering,
    counts: severityCounts(review.issues),
  };
}
