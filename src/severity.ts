import type { FileDiffInfo } from './diff.js';
import type { Issue, Review, Severity, Tag } from './types.js';

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
  /**
   * Only gate on findings the verifier confirmed. Default true: a finding
   * the model asserted but nobody checked never turns CI red.
   */
  requireVerified?: boolean;
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

/** The tag a finding is shown and gated with (model-free fallback by severity). */
export function effectiveTag(issue: Issue): Tag {
  if (issue.tag) return issue.tag;
  return issue.severity === 'nitpick' || issue.severity === 'suggestion' ? 'Nit' : 'Important';
}

const RANK: Record<Severity, number> = { security: 4, blocker: 3, warning: 2, suggestion: 1, nitpick: 0 };
const TAG_RANK: Record<Tag, number> = { Important: 0, Nit: 1, 'Pre-existing': 2 };

export const severityRank = (s: Severity): number => RANK[s];

/** Important first, then Nit, then Pre-existing; most severe first within a tag. */
export function sortIssues(issues: Issue[]): Issue[] {
  return issues
    .map((issue, idx) => ({ issue, idx }))
    .sort(
      (a, b) =>
        TAG_RANK[effectiveTag(a.issue)] - TAG_RANK[effectiveTag(b.issue)] ||
        RANK[b.issue.severity] - RANK[a.issue.severity] ||
        a.idx - b.idx,
    )
    .map((x) => x.issue);
}

/**
 * Assign the final tag deterministically:
 *  - `Pre-existing` when the model says so, or when none of the cited lines
 *    (primary range or extra locations) fall inside the PR diff's hunks.
 *  - otherwise `Nit` when the model says Nit or the severity is
 *    nitpick/suggestion, else `Important`.
 */
export function assignTag(issue: Issue, prDiff: Map<string, FileDiffInfo>): Issue {
  const ranges = [issue, ...(issue.locations ?? [])];
  const inDiff = ranges.some((r) => {
    const info = prDiff.get(r.file);
    if (!info) return false;
    return info.hunks.some((h) => r.line_start <= h.end && r.line_end >= h.start);
  });
  let tag: Tag;
  if (issue.tag === 'Pre-existing' || !inDiff) tag = 'Pre-existing';
  else if (issue.tag === 'Nit' || issue.severity === 'nitpick' || issue.severity === 'suggestion') tag = 'Nit';
  else tag = 'Important';
  return { ...issue, tag };
}

/** Keep at most `max` findings carrying `tag`, preferring the most severe. */
export function capTag(issues: Issue[], tag: Tag, max: number): { kept: Issue[]; dropped: Issue[] } {
  const withTag = issues.filter((i) => effectiveTag(i) === tag);
  if (withTag.length <= max) return { kept: issues, dropped: [] };
  const keep = new Set(
    withTag
      .map((issue, idx) => ({ issue, idx }))
      .sort((a, b) => RANK[b.issue.severity] - RANK[a.issue.severity] || a.idx - b.idx)
      .slice(0, Math.max(0, max))
      .map((x) => x.issue),
  );
  return {
    kept: issues.filter((i) => effectiveTag(i) !== tag || keep.has(i)),
    dropped: withTag.filter((i) => !keep.has(i)),
  };
}

/**
 * The merge gate. Blocks only on findings that are
 *   1. verified (confirmed by the verifier vote),
 *   2. tagged `Important` (not Nit, not Pre-existing), and
 *   3. in the blocking severity set (blocker / security by default).
 * Findings already posted in an earlier round still count: they were
 * re-found on this commit, so they are still there.
 */
export function evaluateSeverityGate(
  review: Review,
  opts: SeverityGateOptions = {},
): SeverityGateResult {
  const blocking = opts.blocking ?? DEFAULT_BLOCKING_SEVERITIES;
  const requireVerified = opts.requireVerified ?? true;
  const triggering = review.issues.filter(
    (i) =>
      blocking.has(i.severity) &&
      effectiveTag(i) === 'Important' &&
      (!requireVerified || i.verification?.verdict === 'confirmed'),
  );
  const blocked = triggering.length > 0;
  return {
    blocked,
    exitCode: blocked ? 1 : 0,
    triggering,
    counts: severityCounts(review.issues),
  };
}
