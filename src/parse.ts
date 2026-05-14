import { parse as parseYaml } from 'yaml';
import { ReviewSchema, SEVERITIES, CATEGORIES, type Review, type Severity, type Category } from './types.js';

/**
 * Parse the model's response into a `Review`. The response is expected to
 * contain a single YAML object — possibly wrapped in a fenced ```yaml block,
 * possibly preceded by chain-of-thought we discard.
 *
 * Unknown severities fall back to `suggestion`. Unknown categories fall back
 * to `maintainability`. Both are non-blocking, so the failure mode of a
 * mis-typed label is silently softer instead of silently harsher.
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
  const idx = text.search(/^review:\s*$/m);
  if (idx >= 0) return text.slice(idx);
  return text;
}

function coerceSeverity(raw: unknown): Severity {
  if (typeof raw === 'string' && (SEVERITIES as readonly string[]).includes(raw)) {
    return raw as Severity;
  }
  return 'suggestion';
}

function coerceCategory(raw: unknown): Category {
  if (typeof raw === 'string' && (CATEGORIES as readonly string[]).includes(raw)) {
    return raw as Category;
  }
  return 'maintainability';
}

function validateReview(raw: unknown): Review {
  if (!raw || typeof raw !== 'object') throw new Error('review is not an object');
  const r = raw as Record<string, unknown>;
  const rawIssues = Array.isArray(r.issues) ? r.issues : [];
  const issues = rawIssues.map((i, idx) => coerceIssue(i, idx));

  const candidate = {
    summary: typeof r.summary === 'string' ? r.summary.trim() : '',
    estimated_review_effort_1_to_5:
      typeof r.estimated_review_effort_1_to_5 === 'number' ? r.estimated_review_effort_1_to_5 : 3,
    issues,
    security_concerns: typeof r.security_concerns === 'string' ? r.security_concerns.trim() : 'No',
    test_coverage_assessment:
      typeof r.test_coverage_assessment === 'string' ? r.test_coverage_assessment.trim() : '',
    walkthrough: coerceWalkthrough(r.walkthrough),
  };
  return ReviewSchema.parse(candidate);
}

function coerceIssue(raw: unknown, index: number): unknown {
  if (!raw || typeof raw !== 'object') throw new Error(`issues[${index}] is not an object`);
  const i = raw as Record<string, unknown>;
  if (typeof i.file !== 'string') throw new Error(`issues[${index}].file missing`);
  if (typeof i.line_start !== 'number') throw new Error(`issues[${index}].line_start missing`);
  const line_end = typeof i.line_end === 'number' ? i.line_end : i.line_start;
  return {
    file: i.file,
    line_start: i.line_start,
    line_end,
    category: coerceCategory(i.category),
    severity: coerceSeverity(i.severity),
    title: typeof i.title === 'string' ? i.title.trim() : '',
    why: typeof i.why === 'string' ? i.why.trim() : '',
    suggestion: typeof i.suggestion === 'string' ? i.suggestion.trim() : undefined,
  };
}

function coerceWalkthrough(
  raw: unknown,
): { overview: string; files: { file: string; summary: string }[]; mermaid: string } {
  if (!raw || typeof raw !== 'object') return { overview: '', files: [], mermaid: '' };
  const w = raw as Record<string, unknown>;
  const filesRaw = Array.isArray(w.files) ? w.files : [];
  const files = filesRaw.flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const fo = f as Record<string, unknown>;
    if (typeof fo.file !== 'string') return [];
    return [{ file: fo.file, summary: typeof fo.summary === 'string' ? fo.summary.trim() : '' }];
  });
  return {
    overview: typeof w.overview === 'string' ? w.overview.trim() : '',
    files,
    mermaid: typeof w.mermaid === 'string' ? w.mermaid.trim() : '',
  };
}
