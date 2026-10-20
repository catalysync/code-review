import { describe, expect, it } from 'vitest';
import { coerceReview, parseReview } from '../src/parse.js';
import { reviewFromToolResult, SUBMIT_REVIEW_TOOL } from '../src/structured.js';
import { usage } from './helpers.js';

describe('submit_review tool', () => {
  it('declares the tag enum and requires evidence', () => {
    const schema = SUBMIT_REVIEW_TOOL.input_schema as {
      properties: { issues: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } };
    };
    const item = schema.properties.issues.items;
    expect(item.properties.tag.enum).toEqual(['Important', 'Nit', 'Pre-existing']);
    expect(item.required).toContain('evidence');
  });
});

describe('reviewFromToolResult', () => {
  it('validates the tool input', () => {
    const review = reviewFromToolResult({
      input: {
        summary: '1 issue: a missing permit.',
        issues: [
          {
            file: 'app/c.rb',
            line_start: 5,
            line_end: 7,
            category: 'bug',
            severity: 'blocker',
            tag: 'important',
            title: 'rights_type not permitted',
            why: 'never saved',
            evidence: 'app/c.rb:6: `permit(:title)`',
            locations: [{ file: 'app/d.rb', line_start: '9' }],
          },
        ],
      },
      text: '',
      usage: usage(),
    });
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0].tag).toBe('Important');
    expect(review.issues[0].evidence).toContain('permit(:title)');
    expect(review.issues[0].locations).toEqual([{ file: 'app/d.rb', line_start: 9, line_end: 9 }]);
  });

  it('accepts a JSON-string tool input (some providers send one)', () => {
    const review = reviewFromToolResult({ input: '{"summary":"No issues found.","issues":[]}', text: '', usage: usage() });
    expect(review.issues).toEqual([]);
  });

  it('falls back to YAML text when no tool call came back', () => {
    const review = reviewFromToolResult({
      input: undefined,
      text: '```yaml\nreview:\n  summary: ok\n  issues: []\n```',
      usage: usage(),
    });
    expect(review.summary).toBe('ok');
  });

  it('fails with a clear message when there is neither', () => {
    expect(() => reviewFromToolResult({ input: undefined, text: '', usage: usage() })).toThrow(/neither/);
    expect(() => reviewFromToolResult({ input: undefined, text: 'just prose', usage: usage() })).toThrow(
      /no submit_review tool call/,
    );
  });
});

describe('coerceReview', () => {
  it('clamps effort, normalizes swapped ranges and drops unknown tags', () => {
    const r = coerceReview({
      estimated_review_effort_1_to_5: 9,
      issues: [{ file: 'a.ts', line_start: 9, line_end: 3, category: 'bug', severity: 'warning', tag: 'urgent' }],
    });
    expect(r.estimated_review_effort_1_to_5).toBe(5);
    expect(r.issues[0].line_start).toBe(3);
    expect(r.issues[0].line_end).toBe(9);
    expect(r.issues[0].tag).toBeUndefined();
  });

  it('parseReview accepts a bare object without the review: key', () => {
    expect(parseReview('summary: x\nissues: []').summary).toBe('x');
  });
});
