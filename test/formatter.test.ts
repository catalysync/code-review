import { describe, expect, it } from 'vitest';
import { formatReview, isOutputFormat } from '../src/formatter.js';
import { ReviewSchema, type Review } from '../src/types.js';

const baseReview: Review = {
  summary: 'Adds a new endpoint and one regression test.',
  estimated_review_effort_1_to_5: 2,
  issues: [
    {
      file: 'src/router.py',
      line_start: 12,
      line_end: 14,
      category: 'security',
      severity: 'security',
      title: 'Missing auth check',
      why: 'The new /admin route does not call require_admin().',
      suggestion: '    require_admin(request)',
    },
  ],
  security_concerns: 'Missing auth on /admin route.',
  test_coverage_assessment: 'missing for the new branch',
  walkthrough: {
    overview: 'Adds /admin and wires it into the router.',
    files: [{ file: 'src/router.py', summary: 'Adds /admin handler.' }],
    mermaid: '',
  },
};

describe('isOutputFormat', () => {
  it('accepts markdown and json', () => {
    expect(isOutputFormat('markdown')).toBe(true);
    expect(isOutputFormat('json')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isOutputFormat('yaml')).toBe(false);
    expect(isOutputFormat('')).toBe(false);
  });
});

describe('formatReview json', () => {
  it('round-trips through ReviewSchema with stable keys', () => {
    const json = formatReview(baseReview, 'json');
    const parsed = JSON.parse(json);
    const back = ReviewSchema.parse(parsed);
    expect(back).toEqual(baseReview);
  });

  it('emits a JSON object that contains the issue severity vocabulary', () => {
    const json = formatReview(baseReview, 'json');
    expect(json).toContain('"severity": "security"');
    expect(json).toContain('"category": "security"');
    expect(json).toContain('"walkthrough"');
  });

  it('drops unknown keys (canonical shape only)', () => {
    const tainted = { ...baseReview, extra_field: 'should not leak' } as unknown as Review;
    const parsed = JSON.parse(formatReview(tainted, 'json'));
    expect(parsed.extra_field).toBeUndefined();
    expect(parsed.summary).toBe(baseReview.summary);
  });

  it('serializes an empty review without throwing', () => {
    const empty: Review = {
      summary: '',
      estimated_review_effort_1_to_5: 1,
      issues: [],
      security_concerns: 'No',
      test_coverage_assessment: '',
      walkthrough: { overview: '', files: [], mermaid: '' },
    };
    const json = formatReview(empty, 'json');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe('formatReview markdown', () => {
  it('prints walkthrough, summary, headline, issues, security, coverage', () => {
    const md = formatReview(baseReview, 'markdown');
    expect(md).toContain('## Walkthrough');
    expect(md).toContain('Adds /admin and wires it into the router.');
    expect(md).toContain('## Summary');
    expect(md).toContain('Effort: 2/5 — 1 security');
    expect(md).toContain('## Issues');
    expect(md).toContain('src/router.py:12-14 — Important · security/security');
    expect(md.startsWith('**1 issue** (1 Important)')).toBe(true);
    expect(md).toContain('```suggestion');
    expect(md).toContain('## Security concerns');
    expect(md).toContain('## Test coverage');
  });

  it('omits issues section when there are none', () => {
    const empty: Review = {
      summary: 'tiny',
      estimated_review_effort_1_to_5: 1,
      issues: [],
      security_concerns: 'No',
      test_coverage_assessment: '',
      walkthrough: { overview: '', files: [], mermaid: '' },
    };
    const md = formatReview(empty, 'markdown');
    expect(md).not.toContain('## Issues');
    expect(md).not.toContain('## Walkthrough');
  });
});
