import { describe, expect, it } from 'vitest';
import { renderReview, renderWalkthrough, shouldUseSuggestionBlock } from '../src/render.js';
import type { Issue, Review } from '../src/types.js';

const baseReview: Review = {
  summary: 'tiny',
  estimated_review_effort_1_to_5: 2,
  issues: [],
  security_concerns: 'No',
  test_coverage_assessment: 'adequate',
  walkthrough: { overview: '', files: [], mermaid: '' },
};

const issue = (over: Partial<Issue>): Issue => ({
  file: 'src/a.py',
  line_start: 10,
  line_end: 10,
  category: 'bug',
  severity: 'warning',
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

  it('emits a one-sentence severity headline ordered by seriousness', () => {
    const payload = renderReview(
      {
        ...baseReview,
        issues: [
          issue({ severity: 'nitpick' }),
          issue({ severity: 'security' }),
          issue({ severity: 'warning' }),
          issue({ severity: 'blocker' }),
          issue({ severity: 'suggestion' }),
        ],
      },
      { commitId: 'abc' },
    );
    expect(payload.body).toMatch(/1 security, 1 blocker, 1 warning, 1 suggestion, 1 nitpick/);
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
    const payload = renderReview({ ...baseReview, issues: [i] }, { commitId: 'abc' });
    expect(payload.comments[0].body).not.toContain('```suggestion');
    expect(payload.comments[0].body).toContain('rewrite this whole class');
  });

  it('omits suggestion block for multi-paragraph suggestions', () => {
    const i = issue({ suggestion: 'first paragraph\n\nsecond paragraph' });
    expect(shouldUseSuggestionBlock(i)).toBe(false);
  });

  it('prepends the walkthrough block above the headline when populated', () => {
    const payload = renderReview(
      {
        ...baseReview,
        walkthrough: {
          overview: 'Adds a new auth handler and wires it into the router.',
          files: [
            { file: 'src/auth.py', summary: 'New handler.' },
            { file: 'src/router.py', summary: 'Mounts /auth.' },
          ],
          mermaid: '',
        },
        issues: [issue({ severity: 'warning' })],
      },
      { commitId: 'abc' },
    );
    expect(payload.body).toContain('## Walkthrough');
    expect(payload.body).toContain('Adds a new auth handler');
    expect(payload.body).toContain('**src/auth.py**');
    expect(payload.body).toContain('**src/router.py**');
    expect(payload.body).toContain('1 warning');
  });

  it('renderWalkthrough returns empty string when nothing to show', () => {
    expect(renderWalkthrough(baseReview)).toBe('');
  });

  it('renderWalkthrough emits a mermaid fence when set', () => {
    const out = renderWalkthrough({
      ...baseReview,
      walkthrough: { overview: '', files: [], mermaid: 'sequenceDiagram\n  A->>B: hi' },
    });
    expect(out).toContain('```mermaid');
    expect(out).toContain('sequenceDiagram');
  });

  it('renders tag, evidence, class-of-bug locations and the fingerprint marker', () => {
    const payload = renderReview(
      {
        ...baseReview,
        issues: [
          issue({
            tag: 'Important',
            severity: 'blocker',
            title: 'Unpermitted attribute',
            evidence: 'a.py:10 `permit(:x)`',
            locations: [{ file: 'b.py', line_start: 3, line_end: 4 }],
            fingerprint: 'abc',
            loc_fingerprint: 'def',
          }),
        ],
      },
      { commitId: 'abc' },
    );
    const body = payload.comments[0].body;
    expect(body.startsWith('**Important** · `bug/blocker` — Unpermitted attribute')).toBe(true);
    expect(body).toContain('Evidence: a.py:10 `permit(:x)`');
    expect(body).toContain('Same issue at: `b.py:3-4`');
    expect(body).toContain('<!-- cr:fp=abc loc=def -->');
  });

  it('marks findings the verifier could not check as unverified', () => {
    const payload = renderReview(
      {
        ...baseReview,
        issues: [issue({ verification: { verdict: 'error', confirmed: 0, rejected: 0, evidence: '', reason: 'x' } })],
      },
      { commitId: 'abc' },
    );
    expect(payload.comments[0].body).toContain('Unverified');
  });

  it('does not repost already-posted findings and says so in the count line', () => {
    const payload = renderReview(
      { ...baseReview, issues: [issue({ already_posted: true }), issue({ title: 'new one' })] },
      { commitId: 'abc', footer: 'FOOTER', marker: '<!-- m -->' },
    );
    expect(payload.comments).toHaveLength(1);
    expect(payload.body.startsWith('**1 issue** (1 Important) — 1 warning (1 already reported earlier, not repeated).')).toBe(true);
    expect(payload.body.endsWith('FOOTER\n\n<!-- m -->')).toBe(true);
  });
});
