import { describe, expect, it } from 'vitest';
import { parseReview } from '../src/parse.js';

describe('parseReview', () => {
  it('extracts the review from a fenced yaml block', () => {
    const text = `Here's the review.\n\n\`\`\`yaml\nreview:\n  summary: A short PR.\n  estimated_review_effort_1_to_5: 2\n  issues: []\n  security_concerns: 'No'\n  test_coverage_assessment: adequate\n\`\`\`\n`;
    const review = parseReview(text);
    expect(review.summary).toBe('A short PR.');
    expect(review.issues).toHaveLength(0);
    expect(review.security_concerns).toBe('No');
  });

  it('parses bare yaml with no fence', () => {
    const text = `review:\n  summary: bare\n  estimated_review_effort_1_to_5: 1\n  issues: []\n  security_concerns: 'No'\n  test_coverage_assessment: adequate\n`;
    const review = parseReview(text);
    expect(review.summary).toBe('bare');
  });

  it('coerces issue fields and defaults missing line_end', () => {
    const text = `\`\`\`yaml\nreview:\n  summary: one issue\n  estimated_review_effort_1_to_5: 3\n  issues:\n    - file: src/a.py\n      line_start: 5\n      category: bug\n      severity: high\n      title: missing import\n      why: ImportError at runtime\n      suggestion: |\n        from x import y\n  security_concerns: 'No'\n  test_coverage_assessment: adequate\n\`\`\``;
    const review = parseReview(text);
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0].line_end).toBe(5);
    expect(review.issues[0].suggestion).toBe('from x import y');
  });

  it('falls back to medium severity for unknown values', () => {
    const text = `\`\`\`yaml\nreview:\n  summary: ''\n  estimated_review_effort_1_to_5: 1\n  issues:\n    - file: a.ts\n      line_start: 1\n      category: vibes\n      severity: critical\n      title: x\n      why: y\n  security_concerns: 'No'\n  test_coverage_assessment: ok\n\`\`\``;
    const review = parseReview(text);
    expect(review.issues[0].category).toBe('maintainability');
    expect(review.issues[0].severity).toBe('medium');
  });

  it('throws when there is no review key', () => {
    expect(() => parseReview('foo: bar')).toThrow(/review/);
  });
});
