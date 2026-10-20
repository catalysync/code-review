import { parse as parseYaml } from 'yaml';
import {
  ReviewSchema,
  SEVERITIES,
  CATEGORIES,
  TAGS,
  type Review,
  type Severity,
  type Category,
  type Location,
  type Tag,
} from './types.js';

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
  const parsed = parseYaml(yaml) as { review?: unknown; issues?: unknown };
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('model output missing top-level `review:` key');
  }
  if ('review' in parsed) return coerceReview(parsed.review);
  if ('issues' in parsed || 'summary' in parsed) return coerceReview(parsed);
  throw new Error('model output missing top-level `review:` key');
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

/**
 * Validate a review-shaped object (from a tool call or parsed YAML) into a
 * `Review`, softening unknown enum values rather than rejecting the review.
 */
export function coerceReview(raw: unknown): Review {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('review is not an object');
    }
  }
  if (!raw || typeof raw !== 'object') throw new Error('review is not an object');
  const r = raw as Record<string, unknown>;
  const rawIssues = Array.isArray(r.issues) ? r.issues : [];
  const issues = rawIssues.map((i, idx) => coerceIssue(i, idx));

  const candidate = {
    summary: typeof r.summary === 'string' ? r.summary.trim() : '',
    estimated_review_effort_1_to_5:
      typeof r.estimated_review_effort_1_to_5 === 'number'
        ? Math.min(5, Math.max(1, Math.round(r.estimated_review_effort_1_to_5)))
        : 3,
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
  const line_start = toLine(i.line_start);
  if (line_start === undefined) throw new Error(`issues[${index}].line_start missing`);
  const line_end = toLine(i.line_end) ?? line_start;
  const locations = coerceLocations(i.locations);
  return {
    file: i.file,
    line_start: Math.min(line_start, line_end),
    line_end: Math.max(line_start, line_end),
    category: coerceCategory(i.category),
    severity: coerceSeverity(i.severity),
    title: typeof i.title === 'string' ? i.title.trim() : '',
    why: typeof i.why === 'string' ? i.why.trim() : '',
    suggestion: typeof i.suggestion === 'string' && i.suggestion.trim() ? i.suggestion.trim() : undefined,
    ...(coerceTag(i.tag) ? { tag: coerceTag(i.tag) } : {}),
    ...(typeof i.evidence === 'string' && i.evidence.trim() ? { evidence: i.evidence.trim() } : {}),
    ...(locations.length ? { locations } : {}),
  };
}

function toLine(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.trunc(raw));
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

function coerceTag(raw: unknown): Tag | undefined {
  if (typeof raw !== 'string') return undefined;
  const norm = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return TAGS.find((t) => t.toLowerCase() === norm);
}

function coerceLocations(raw: unknown): Location[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    if (!l || typeof l !== 'object') return [];
    const o = l as Record<string, unknown>;
    const start = toLine(o.line_start);
    if (typeof o.file !== 'string' || !o.file || start === undefined) return [];
    const end = toLine(o.line_end) ?? start;
    return [{ file: o.file, line_start: Math.min(start, end), line_end: Math.max(start, end) }];
  });
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
