import { isRangeCommentable, type FileDiffInfo } from './diff.js';
import { fingerprintMarker } from './fingerprint.js';
import { effectiveTag, severityCounts } from './severity.js';
import type { Issue, Review, Severity, Tag } from './types.js';

export interface GhReviewComment {
  path: string;
  body: string;
  line: number;
  side: 'RIGHT';
  start_line?: number;
  start_side?: 'RIGHT';
}

export interface GhReviewPayload {
  commit_id: string;
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  body: string;
  comments: GhReviewComment[];
}

/**
 * Decide whether a `suggestion` block from the model is safe to render as a
 * GitHub one-click `suggestion`. Heuristics:
 *  - The suggestion must look like a literal code replacement, not prose.
 *  - The replacement should not span more lines than the comment range — GitHub
 *    accepts this but it's a strong sign of "rewrite this whole region" which
 *    rarely yields a clean apply.
 */
export function shouldUseSuggestionBlock(issue: Issue): boolean {
  if (!issue.suggestion) return false;
  const trimmed = issue.suggestion.trim();
  if (trimmed.length === 0) return false;
  const proseMarkers = /^(rewrite|consider|refactor|extract|move|split|introduce|add a)\b/i;
  if (proseMarkers.test(trimmed)) return false;
  if (/\n\s*\n/.test(trimmed)) return false;
  return true;
}

const fmtRange = (l: { file: string; line_start: number; line_end: number }) =>
  `${l.file}:${l.line_start === l.line_end ? l.line_start : `${l.line_start}-${l.line_end}`}`;

function verificationNote(issue: Issue): string {
  const v = issue.verification;
  if (!v) return '';
  if (v.verdict === 'error') return '_Unverified (verifier unavailable); does not block merge._';
  return '';
}

export function renderIssueBody(issue: Issue): string {
  const tag = effectiveTag(issue);
  const title = issue.title ? ` ${issue.title}` : '';
  const out: string[] = [`**${tag}** · \`${issue.category}/${issue.severity}\` —${title}`];
  if (issue.why) out.push('', issue.why);
  if (issue.evidence) out.push('', `Evidence: ${issue.evidence}`);
  if (issue.locations?.length) {
    out.push('', `Same issue at: ${issue.locations.map((l) => `\`${fmtRange(l)}\``).join(', ')}`);
  }
  if (shouldUseSuggestionBlock(issue)) {
    out.push('', '```suggestion', issue.suggestion!.trim(), '```');
  } else if (issue.suggestion) {
    out.push('', issue.suggestion.trim());
  }
  const note = verificationNote(issue);
  if (note) out.push('', note);
  const marker = fingerprintMarker(issue);
  if (marker) out.push('', marker);
  return out.join('\n');
}

/**
 * Split issues into those GitHub will accept as inline comments and those it
 * would reject (file not in the diff, deleted file, or a line range that is
 * not fully inside one right-side hunk). A single bad anchor makes GitHub
 * reject the entire review with a 422, so the second group is rendered in
 * the top-level body instead.
 */
export function partitionIssues(
  issues: Issue[],
  diffFiles: Map<string, FileDiffInfo>,
): { inline: Issue[]; outside: Issue[] } {
  const inline: Issue[] = [];
  const outside: Issue[] = [];
  for (const issue of issues) {
    if (isRangeCommentable(diffFiles, issue.file, issue.line_start, issue.line_end)) inline.push(issue);
    else outside.push(issue);
  }
  return { inline, outside };
}

export interface RenderReviewOptions {
  commitId: string;
  /**
   * Parsed PR diff used to validate anchors. When given, issues that can't be
   * anchored are moved to a "Findings outside the diff" list in the body.
   */
  diffFiles?: Map<string, FileDiffInfo>;
  /** Put every finding in the body (used as the fallback after a 422). */
  noInline?: boolean;
  /** Footer line (round, verification, diff range). */
  footer?: string;
  /** Hidden marker appended last (see `reviewMarker`). */
  marker?: string;
}

/**
 * Build the GitHub review payload. Findings marked `already_posted` are not
 * posted again. The top-level body starts with the count headline.
 */
export function renderReview(review: Review, opts: RenderReviewOptions): GhReviewPayload {
  const fresh = review.issues.filter((i) => !i.already_posted);
  const { inline, outside } = opts.noInline
    ? { inline: [] as Issue[], outside: fresh }
    : opts.diffFiles
      ? partitionIssues(fresh, opts.diffFiles)
      : { inline: fresh, outside: [] as Issue[] };
  const comments: GhReviewComment[] = inline.map((issue) => {
    const c: GhReviewComment = {
      path: issue.file,
      body: renderIssueBody(issue),
      line: issue.line_end,
      side: 'RIGHT',
    };
    if (issue.line_start !== issue.line_end) {
      c.start_line = issue.line_start;
      c.start_side = 'RIGHT';
    }
    return c;
  });

  const body = [renderTopBody(review), renderOutsideDiff(outside), opts.footer, opts.marker]
    .filter(Boolean)
    .join('\n\n');
  return {
    commit_id: opts.commitId,
    event: 'COMMENT',
    body,
    comments,
  };
}

export function renderOutsideDiff(issues: Issue[]): string {
  if (issues.length === 0) return '';
  const out = ['### Findings outside the diff', ''];
  for (const issue of issues) {
    const why = (issue.why || issue.title).replace(/\s+/g, ' ').trim();
    const marker = fingerprintMarker(issue);
    out.push(
      `- \`${fmtRange(issue)}\` **${effectiveTag(issue)}** · \`${issue.category}/${issue.severity}\` — ${why}${marker ? ` ${marker}` : ''}`,
    );
  }
  return out.join('\n');
}

/** Display order for severities in the headline — most serious first. */
const SEVERITY_DISPLAY_ORDER: Severity[] = ['security', 'blocker', 'warning', 'suggestion', 'nitpick'];
const TAG_ORDER: Tag[] = ['Important', 'Nit', 'Pre-existing'];

export function renderTopBody(review: Review): string {
  const headline = renderHeadline(review);
  const walkthrough = renderWalkthrough(review);
  if (!walkthrough) return headline;
  return `${headline}\n\n${walkthrough}`;
}

/**
 * The summary line: always starts with a count, and says plainly
 * "No issues found." when there is nothing to fix.
 */
export function renderHeadline(review: Review): string {
  const fresh = review.issues.filter((i) => !i.already_posted);
  const repeats = review.issues.length - fresh.length;
  const repeatNote = repeats > 0 ? ` (${repeats} already reported earlier, not repeated)` : '';
  if (fresh.length === 0) {
    return repeats > 0 ? `No new issues found${repeatNote}.` : 'No issues found.';
  }
  const tagCounts = TAG_ORDER.map((t) => [t, fresh.filter((i) => effectiveTag(i) === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
  const counts = severityCounts(fresh);
  const sev = SEVERITY_DISPLAY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  const noun = fresh.length === 1 ? 'issue' : 'issues';
  return `**${fresh.length} ${noun}** (${tagCounts}) — ${sev}${repeatNote}. See inline comments.`;
}

/**
 * Render the walkthrough block: PR-level overview, per-file summaries and an
 * optional mermaid diagram. Returns an empty string when the walkthrough is
 * empty so callers can skip the surrounding spacing.
 */
export function renderWalkthrough(review: Review): string {
  const w = review.walkthrough;
  if (!w) return '';
  const hasContent = w.overview || w.files.length > 0 || w.mermaid;
  if (!hasContent) return '';
  const out: string[] = ['## Walkthrough'];
  if (w.overview) out.push('', w.overview);
  if (w.files.length > 0) {
    out.push('', '<details><summary>Files</summary>', '');
    for (const f of w.files) {
      out.push(`- **${f.file}** — ${f.summary || '(no summary)'}`);
    }
    out.push('', '</details>');
  }
  if (w.mermaid) {
    out.push('', '### Diagram', '', '```mermaid', w.mermaid, '```');
  }
  return out.join('\n');
}
