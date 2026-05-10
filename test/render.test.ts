import { describe, expect, it } from 'vitest';
import { renderReview, shouldUseSuggestionBlock } from '../src/render.js';
import type { Issue, Review } from '../src/types.js';

const baseReview: Review = {
  summary: 'tiny',
  estimated_review_effort_1_to_5: 2,
  issues: [],
  security_concerns: 'No',
  test_coverage_assessment: 'adequate',
};

const issue = (over: Partial<Issue>): Issue => ({
  file: 'src/a.py',
  line_start: 10,
  line_end: 10,
  category: 'bug',
  severity: 'high',
  title: 't',
  why: 'why one',
  ...over,
});

describe('renderReview', () => {
  it('returns "No issues found." for empty', () => {
    const payload = renderReview(baseReview, { commitId: 'abc' });
    expect(payload.body).toBe('No issues found.');
    expect(payload.comments).toEqual([]);
    expect(payload.commit_id).toBe('abc');
  });

  it('emits a one-sentence severity headline', () => {
    const payload = renderReview(
      {
        ...baseReview,
        issues: [issue({ severity: 'high' }), issue({ severity: 'medium' }), issue({ severity: 'low' })],
      },
      { commitId: 'abc' },
    );
    expect(payload.body).toMatch(/1 high, 1 medium, 1 low/);
  });

  it('renders single-line inline with suggestion block when fix is mechanical', () => {
    const payload = renderReview(
      {
        ...baseReview,
        issues: [
          issue({
            line_start: 18,
            line_end: 18,
            suggestion: 'from x import y, z',
          }),
        ],
      },
      { commitId: 'abc' },
    );
    expect(payload.comments).toHaveLength(1);
    const c = payload.comments[0];
    expect(c.line).toBe(18);
    expect(c.start_line).toBeUndefined();
    expect(c.body).toContain('```suggestion\nfrom x import y, z\n```');
  });

  it('uses start_line/start_side for multi-line ranges', () => {
    const payload = renderReview(
      {
        ...baseReview,
        issues: [issue({ line_start: 50, line_end: 55 })],
      },
      { commitId: 'abc' },
    );
    const c = payload.comments[0];
    expect(c.line).toBe(55);
    expect(c.start_line).toBe(50);
    expect(c.start_side).toBe('RIGHT');
  });

  it('omits suggestion block for prose-style suggestions', () => {
    const i = issue({ suggestion: 'rewrite this whole class to split read and write paths' });
    expect(shouldUseSuggestionBlock(i)).toBe(false);
    const payload = renderReview(
      { ...baseReview, issues: [i] },
      { commitId: 'abc' },
    );
    expect(payload.comments[0].body).not.toContain('```suggestion');
    expect(payload.comments[0].body).toContain('rewrite this whole class');
  });

  it('omits suggestion block for multi-paragraph suggestions', () => {
    const i = issue({ suggestion: 'first paragraph\n\nsecond paragraph' });
    expect(shouldUseSuggestionBlock(i)).toBe(false);
  });
});
