import { parse as parseYaml } from 'yaml';
import type { Issue, Review, Severity, Category } from './types.js';

const SEVERITIES: Severity[] = ['block', 'high', 'medium', 'low'];
const CATEGORIES: Category[] = ['bug', 'security', 'performance', 'maintainability', 'convention'];

/**
 * Parse the model's response into a `Review`. The response is expected to
 * contain a single YAML object — possibly wrapped in a fenced ```yaml block,
 * possibly preceded by chain-of-thought we discard.
 */
export function parseReview(modelText: string): Review {
  const yaml = extractYaml(modelText);
  const parsed = parseYaml(yaml) as { review?: unknown };
  if (!parsed || typeof parsed !== 'object' || !('review' in parsed)) {
    throw new Error('model output missing top-level `review:` key');
  }
  return validateReview(parsed.review);
}

function extractYaml(text: string): string {
  const fenced = /```ya?ml\s*\n([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1];
  // Fall back to "first line that looks like YAML through end of message".
  const idx = text.search(/^review:\s*$/m);
  if (idx >= 0) return text.slice(idx);
  // Last resort: assume the whole message is YAML.
  return text;
}

function validateReview(raw: unknown): Review {
  if (!raw || typeof raw !== 'object') throw new Error('review is not an object');
  const r = raw as Record<string, unknown>;
  const issues = Array.isArray(r.issues) ? r.issues.map((i, idx) => validateIssue(i, idx)) : [];
  return {
    summary: typeof r.summary === 'string' ? r.summary.trim() : '',
    estimated_review_effort_1_to_5:
      typeof r.estimated_review_effort_1_to_5 === 'number' ? r.estimated_review_effort_1_to_5 : 3,
    issues,
    security_concerns: typeof r.security_concerns === 'string' ? r.security_concerns.trim() : 'No',
    test_coverage_assessment:
      typeof r.test_coverage_assessment === 'string' ? r.test_coverage_assessment.trim() : '',
  };
}

function validateIssue(raw: unknown, index: number): Issue {
  if (!raw || typeof raw !== 'object') throw new Error(`issues[${index}] is not an object`);
  const i = raw as Record<string, unknown>;
  if (typeof i.file !== 'string') throw new Error(`issues[${index}].file missing`);
  if (typeof i.line_start !== 'number') throw new Error(`issues[${index}].line_start missing`);
  const line_end = typeof i.line_end === 'number' ? i.line_end : i.line_start;
  const category = CATEGORIES.includes(i.category as Category)
    ? (i.category as Category)
    : 'maintainability';
  const severity = SEVERITIES.includes(i.severity as Severity)
    ? (i.severity as Severity)
    : 'medium';
  return {
    file: i.file,
    line_start: i.line_start,
    line_end: line_end as number,
    category,
    severity,
    title: typeof i.title === 'string' ? i.title.trim() : '',
    why: typeof i.why === 'string' ? i.why.trim() : '',
    suggestion: typeof i.suggestion === 'string' ? i.suggestion.trim() : undefined,
  };
}
