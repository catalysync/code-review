import type { Issue, Review } from './types.js';

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
  // Prose suggestions usually start with "rewrite", "consider", "extract", etc.
  const proseMarkers = /^(rewrite|consider|refactor|extract|move|split|introduce|add a)\b/i;
  if (proseMarkers.test(trimmed)) return false;
  // Multi-paragraph suggestions are prose.
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
 * Build the GitHub review payload from a parsed `Review`. The top-level body
 * is at most one short sentence; per-issue inline comments do the work.
 */
export function renderReview(review: Review, opts: { commitId: string }): GhReviewPayload {
  const comments: GhReviewComment[] = review.issues.map((issue) => {
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

  const body = renderTopBody(review);
  return {
    commit_id: opts.commitId,
    event: 'COMMENT',
    body,
    comments,
  };
}

function renderTopBody(review: Review): string {
  if (review.issues.length === 0) {
    return 'No issues found.';
  }
  const blocks = review.issues.filter((i) => i.severity === 'block').length;
  const high = review.issues.filter((i) => i.severity === 'high').length;
  const medium = review.issues.filter((i) => i.severity === 'medium').length;
  const low = review.issues.filter((i) => i.severity === 'low').length;
  const counts: string[] = [];
  if (blocks) counts.push(`${blocks} block`);
  if (high) counts.push(`${high} high`);
  if (medium) counts.push(`${medium} medium`);
  if (low) counts.push(`${low} low`);
  const headline = counts.join(', ');
  return `Review found ${headline} — see inline comments.`;
}
