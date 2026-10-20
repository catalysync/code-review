import { isRangeCommentable, type FileDiffInfo } from './diff.js';
import { severityCounts } from './severity.js';
import type { Issue, Review, Severity } from './types.js';

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

function renderIssueBody(issue: Issue): string {
  const header = `**${issue.category}/${issue.severity}** — ${issue.why}`;
  if (shouldUseSuggestionBlock(issue)) {
    return `${header}\n\n\`\`\`suggestion\n${issue.suggestion!.trim()}\n\`\`\``;
  }
  if (issue.suggestion) {
    return `${header}\n\n${issue.suggestion.trim()}`;
  }
  return header;
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
   * Parsed diff used to validate anchors. When given, issues that can't be
   * anchored are moved to a "Findings outside the diff" list in the body.
   */
  diffFiles?: Map<string, FileDiffInfo>;
}

/**
 * Build the GitHub review payload from a parsed `Review`. The top-level body
 * carries the walkthrough block (if any) plus a one-sentence severity headline.
 */
export function renderReview(review: Review, opts: RenderReviewOptions): GhReviewPayload {
  const { inline, outside } = opts.diffFiles
    ? partitionIssues(review.issues, opts.diffFiles)
    : { inline: review.issues, outside: [] as Issue[] };
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

  const body = [renderTopBody(review), renderOutsideDiff(outside)].filter(Boolean).join('\n\n');
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
    const range =
      issue.line_start === issue.line_end ? `${issue.line_start}` : `${issue.line_start}-${issue.line_end}`;
    const why = (issue.why || issue.title).replace(/\s+/g, ' ').trim();
    out.push(`- \`${issue.file}:${range}\` **${issue.category}/${issue.severity}** — ${why}`);
  }
  return out.join('\n');
}

/** Display order for severities in the headline — most serious first. */
const SEVERITY_DISPLAY_ORDER: Severity[] = ['security', 'blocker', 'warning', 'suggestion', 'nitpick'];

export function renderTopBody(review: Review): string {
  const walkthrough = renderWalkthrough(review);
  const headline = renderHeadline(review);
  if (!walkthrough) return headline;
  return `${walkthrough}\n\n${headline}`;
}

function renderHeadline(review: Review): string {
  if (review.issues.length === 0) {
    return 'No issues found.';
  }
  const counts = severityCounts(review.issues);
  const parts = SEVERITY_DISPLAY_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return `Review found ${parts.join(', ')} — see inline comments.`;
}

/**
 * Render the walkthrough block: PR-level overview, per-file summaries,
 * a reserved mermaid section (empty in phase 1). Returns an empty string
 * when the walkthrough is empty so callers can skip the surrounding spacing.
 */
export function renderWalkthrough(review: Review): string {
  const w = review.walkthrough;
  if (!w) return '';
  const hasContent = w.overview || w.files.length > 0 || w.mermaid;
  if (!hasContent) return '';
  const out: string[] = ['## Walkthrough'];
  if (w.overview) out.push('', w.overview);
  if (w.files.length > 0) {
    out.push('', '### Files');
    for (const f of w.files) {
      out.push('', `- **${f.file}** — ${f.summary || '(no summary)'}`);
    }
  }
  if (w.mermaid) {
    out.push('', '### Diagram', '', '```mermaid', w.mermaid, '```');
  }
  return out.join('\n');
}
