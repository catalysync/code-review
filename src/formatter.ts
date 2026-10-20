import { renderHeadline, renderWalkthrough } from './render.js';
import { effectiveTag, severityCounts } from './severity.js';
import { ReviewSchema, type Review, type Severity } from './types.js';

export type OutputFormat = 'markdown' | 'json';

const FORMATS: OutputFormat[] = ['markdown', 'json'];

export function isOutputFormat(s: string): s is OutputFormat {
  return (FORMATS as string[]).includes(s);
}

/**
 * Format a `Review` for output. JSON is round-trip-safe through `ReviewSchema`
 * so CI consumers can pipe it through `jq` or feed it to another tool.
 * Markdown is the human-facing default — what the CLI prints in `--dry-run`.
 */
export function formatReview(review: Review, format: OutputFormat): string {
  if (format === 'json') return formatJson(review);
  return formatMarkdown(review);
}

function formatJson(review: Review): string {
  // Round-trip through zod so we always emit the canonical shape, even if the
  // caller hand-constructed a `Review` with extra keys.
  const canonical = ReviewSchema.parse(review);
  return JSON.stringify(canonical, null, 2);
}

const SEVERITY_DISPLAY_ORDER: Severity[] = ['security', 'blocker', 'warning', 'suggestion', 'nitpick'];

function formatMarkdown(review: Review): string {
  const out: string[] = [renderHeadline(review).replace(/\s*See inline comments\.$/, ''), ''];

  const walkthrough = renderWalkthrough(review);
  if (walkthrough) out.push(walkthrough, '');

  out.push('## Summary');
  out.push(review.summary || '(no summary)');

  const counts = severityCounts(review.issues);
  const headline = SEVERITY_DISPLAY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(', ');
  out.push('', `Effort: ${review.estimated_review_effort_1_to_5}/5${headline ? ` — ${headline}` : ''}`);

  if (review.issues.length > 0) {
    out.push('', '## Issues');
    for (const issue of review.issues) {
      const range =
        issue.line_start === issue.line_end
          ? `${issue.line_start}`
          : `${issue.line_start}-${issue.line_end}`;
      out.push(
        '',
        `### ${issue.file}:${range} — ${effectiveTag(issue)} · ${issue.category}/${issue.severity}${issue.already_posted ? ' (already posted)' : ''}`,
        '',
        issue.title && issue.why ? `**${issue.title}** — ${issue.why}` : issue.why || issue.title || '(no message)',
      );
      if (issue.evidence) out.push('', `Evidence: ${issue.evidence}`);
      if (issue.locations?.length) {
        out.push('', `Same issue at: ${issue.locations.map((l) => `${l.file}:${l.line_start}`).join(', ')}`);
      }
      if (issue.verification) {
        const v = issue.verification;
        out.push('', `Verification: ${v.verdict} (${v.confirmed} confirm / ${v.rejected} reject)${v.evidence ? ` — ${v.evidence}` : ''}`);
      }
      if (issue.suggestion) {
        out.push('', '```suggestion', issue.suggestion.trim(), '```');
      }
    }
  }

  if (review.security_concerns && review.security_concerns !== 'No') {
    out.push('', '## Security concerns', review.security_concerns);
  }
  if (review.test_coverage_assessment) {
    out.push('', '## Test coverage', review.test_coverage_assessment);
  }
  return out.join('\n');
}
