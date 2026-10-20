import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCases, matches, runEvals, scoreCase } from '../src/evals.js';
import type { Issue } from '../src/types.js';
import { fakeLlm } from './helpers.js';

const CASES = join(__dirname, '..', 'evals', 'cases');

const issue = (over: Partial<Issue>): Issue => ({
  file: 'app/models/contract.rb',
  line_start: 10,
  line_end: 12,
  category: 'bug',
  severity: 'blocker',
  title: 'Unpaid total includes historical settlements',
  why: 'They were paid in the old system.',
  ...over,
});

describe('eval cases', () => {
  it('ships valid seed cases: real bugs, known false alarms and a clean PR', () => {
    const cases = loadCases(CASES);
    expect(cases.map((c) => c.name)).toEqual([
      'docs-only',
      'invented-column',
      'nil-guard-exists',
      'settlements-paid-twice',
      'unpermitted-param',
    ]);
    expect(cases.flatMap((c) => c.expect)).toHaveLength(2);
    expect(cases.flatMap((c) => c.forbid)).toHaveLength(2);
    expect(cases.find((c) => c.name === 'settlements-paid-twice')!.files.get('app/models/royalty_calculation.rb')).toContain(
      'historical_settlement',
    );
  });
});

describe('matches', () => {
  const exp = { id: 'x', file: 'app/models/contract.rb', lines: [9, 12] as [number, number], match: 'historical' };

  it('needs the file, an overlapping line and the pattern', () => {
    expect(matches(issue({}), exp)).toBe(true);
    expect(matches(issue({ line_start: 2, line_end: 3 }), exp)).toBe(false);
    expect(matches(issue({ title: 'Slow query', why: 'n+1' }), exp)).toBe(false);
    expect(matches(issue({ file: 'other.rb' }), exp)).toBe(false);
  });

  it('counts a listed location as pointing at the file', () => {
    const elsewhere = issue({ file: 'app/models/payment.rb', line_start: 1, line_end: 1, locations: [{ file: 'app/models/contract.rb', line_start: 11, line_end: 11 }] });
    expect(matches(elsewhere, exp)).toBe(true);
  });

  it('accepts any of several files', () => {
    expect(matches(issue({ file: 'b.rb' }), { id: 'y', file: ['a.rb', 'b.rb'] })).toBe(true);
  });
});

describe('scoreCase', () => {
  const c = {
    name: 'c',
    title: 't',
    expect: [{ id: 'bug', file: 'app/models/contract.rb', match: 'historical' }],
    forbid: [{ id: 'nil', file: 'app/models/contract.rb', match: '\\bnil\\b' }],
  };

  it('separates caught bugs, misses, known false alarms and other noise', () => {
    const score = scoreCase(c, [
      issue({}),
      issue({ title: 'Possible nil', why: 'x may be nil' }),
      issue({ title: 'Slow query', why: 'n+1' }),
      issue({ title: 'Rename', why: 'naming', severity: 'nitpick' }),
    ]);
    expect(score.caught).toEqual(['bug']);
    expect(score.missed).toEqual([]);
    expect(score.falseAlarms).toEqual(['nil']);
    expect(score.unexpected.map((i) => i.title)).toEqual(['Slow query']);
  });

  it('reports a miss when nothing matches', () => {
    expect(scoreCase(c, []).missed).toEqual(['bug']);
  });
});

describe('runEvals', () => {
  it('runs the pipeline per case and scores what survives verification', async () => {
    const cases = loadCases(CASES).filter((c) => ['settlements-paid-twice', 'nil-guard-exists', 'docs-only'].includes(c.name));
    const { llm } = fakeLlm({
      review: (req) => {
        if (req.user.includes('sum_royalties_not_paid')) {
          return {
            summary: 'one bug',
            issues: [
              {
                ...issue({}),
                evidence: 'app/models/contract.rb:11 `royalty_calculations.unpaid.sum(:royalty_cents)`',
              },
            ],
          };
        }
        if (req.user.includes('edition_label')) {
          return {
            summary: 'one finding',
            issues: [
              {
                file: 'app/services/books/display_title.rb',
                line_start: 6,
                line_end: 6,
                category: 'bug',
                severity: 'warning',
                title: 'book.title may be nil',
                why: 'strip on nil raises NoMethodError',
                evidence: 'app/services/books/display_title.rb:6 `title = book.title.strip`',
              },
            ],
          };
        }
        return { summary: 'docs', issues: [] };
      },
      // The verifier rejects the nil finding, as a good verifier should.
      verdict: (req) =>
        req.user.includes('may be nil')
          ? { verdict: 'rejected', evidence: '', reason: 'guarded on line 4' }
          : { verdict: 'confirmed', evidence: 'app/models/contract.rb:11 `unpaid.sum`', reason: 'includes historical rows' },
    });

    const seen: string[] = [];
    const summary = await runEvals({ cases, llm, onCase: (s) => seen.push(s.name) });

    expect(seen).toEqual(['docs-only', 'nil-guard-exists', 'settlements-paid-twice']);
    expect(summary).toMatchObject({ expected: 1, caught: 1, recall: 1, falseAlarms: 0, cleanPassed: 2, cleanTotal: 2 });
    expect(summary.cases.every((c) => !c.error)).toBe(true);
  });

  it('records a failing case instead of stopping the run', async () => {
    const cases = loadCases(CASES).filter((c) => c.name === 'docs-only');
    const llm = {
      text: async () => {
        throw new Error('boom');
      },
      tool: async () => {
        throw new Error('provider down');
      },
    };
    const summary = await runEvals({ cases, llm });
    expect(summary.cases[0].error).toContain('provider down');
    expect(summary.cleanPassed).toBe(0);
  });
});
