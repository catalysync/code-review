import { describe, expect, it } from 'vitest';
import { parseDiffFiles } from '../src/diff.js';
import {
  assignTag,
  capTag,
  DEFAULT_BLOCKING_SEVERITIES,
  effectiveTag,
  evaluateSeverityGate,
  severityCounts,
  sortIssues,
} from '../src/severity.js';
import type { Issue, Review, Severity } from '../src/types.js';

const confirmed = { verdict: 'confirmed' as const, confirmed: 1, rejected: 0, evidence: 'src/a.ts:1', reason: '' };

const issue = (severity: Severity, over: Partial<Issue> = {}): Issue => ({
  file: 'src/a.ts',
  line_start: 1,
  line_end: 1,
  category: 'bug',
  severity,
  title: '',
  why: '',
  verification: confirmed,
  ...over,
});

const review = (issues: Issue[]): Review => ({
  summary: '',
  estimated_review_effort_1_to_5: 2,
  issues,
  security_concerns: 'No',
  test_coverage_assessment: '',
  walkthrough: { overview: '', files: [], mermaid: '' },
});

describe('severity gate', () => {
  it('default blocking set is blocker + security only', () => {
    expect([...DEFAULT_BLOCKING_SEVERITIES].sort()).toEqual(['blocker', 'security']);
  });

  it('passes (exit 0) for empty issue list', () => {
    const gate = evaluateSeverityGate(review([]));
    expect(gate.blocked).toBe(false);
    expect(gate.exitCode).toBe(0);
    expect(gate.triggering).toEqual([]);
  });

  it('passes for only nitpick/suggestion/warning', () => {
    const gate = evaluateSeverityGate(
      review([issue('nitpick'), issue('suggestion'), issue('warning')]),
    );
    expect(gate.blocked).toBe(false);
    expect(gate.exitCode).toBe(0);
  });

  it('blocks (exit 1) on a single blocker', () => {
    const gate = evaluateSeverityGate(review([issue('warning'), issue('blocker')]));
    expect(gate.blocked).toBe(true);
    expect(gate.exitCode).toBe(1);
    expect(gate.triggering).toHaveLength(1);
    expect(gate.triggering[0].severity).toBe('blocker');
  });

  it('blocks (exit 1) on a security finding', () => {
    const gate = evaluateSeverityGate(review([issue('security'), issue('suggestion')]));
    expect(gate.blocked).toBe(true);
    expect(gate.exitCode).toBe(1);
    expect(gate.triggering[0].severity).toBe('security');
  });

  it('honors a custom blocking set', () => {
    const gate = evaluateSeverityGate(review([issue('warning')]), {
      blocking: new Set<Severity>(['warning', 'blocker', 'security']),
    });
    expect(gate.blocked).toBe(true);
    expect(gate.triggering[0].severity).toBe('warning');
  });

  it('counts every severity, defaulting to 0', () => {
    const counts = severityCounts([issue('blocker'), issue('blocker'), issue('nitpick')]);
    expect(counts.blocker).toBe(2);
    expect(counts.nitpick).toBe(1);
    expect(counts.security).toBe(0);
    expect(counts.warning).toBe(0);
    expect(counts.suggestion).toBe(0);
  });

  it('does not gate on an unverified blocker', () => {
    const gate = evaluateSeverityGate(review([issue('blocker', { verification: undefined })]));
    expect(gate.blocked).toBe(false);
  });

  it('does not gate on a blocker the verifier could not check', () => {
    const gate = evaluateSeverityGate(
      review([issue('security', { verification: { ...confirmed, verdict: 'error', confirmed: 0 } })]),
    );
    expect(gate.blocked).toBe(false);
  });

  it('does not gate on Pre-existing or Nit findings, whatever their severity', () => {
    const gate = evaluateSeverityGate(
      review([issue('blocker', { tag: 'Pre-existing' }), issue('security', { tag: 'Nit' })]),
    );
    expect(gate.blocked).toBe(false);
  });

  it('can be told not to require verification', () => {
    const gate = evaluateSeverityGate(review([issue('blocker', { verification: undefined })]), {
      requireVerified: false,
    });
    expect(gate.blocked).toBe(true);
  });
});

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,4 @@',
  ' a',
  '+b',
  ' c',
  ' d',
].join('\n');

describe('tags', () => {
  const files = parseDiffFiles(DIFF);

  it('derives a tag from severity when none is set', () => {
    expect(effectiveTag(issue('nitpick'))).toBe('Nit');
    expect(effectiveTag(issue('suggestion'))).toBe('Nit');
    expect(effectiveTag(issue('warning'))).toBe('Important');
  });

  it('tags findings outside the PR diff as Pre-existing, regardless of the model', () => {
    const t = assignTag(issue('blocker', { line_start: 50, line_end: 50, tag: 'Important' }), files);
    expect(t.tag).toBe('Pre-existing');
  });

  it('keeps the model\'s Pre-existing even inside the diff', () => {
    expect(assignTag(issue('warning', { line_start: 11, line_end: 11, tag: 'Pre-existing' }), files).tag).toBe(
      'Pre-existing',
    );
  });

  it('tags in-diff findings Important or Nit', () => {
    expect(assignTag(issue('blocker', { line_start: 11, line_end: 11 }), files).tag).toBe('Important');
    expect(assignTag(issue('warning', { line_start: 12, line_end: 12, tag: 'Nit' }), files).tag).toBe('Nit');
    expect(assignTag(issue('suggestion', { line_start: 11, line_end: 11, tag: 'Important' }), files).tag).toBe('Nit');
  });

  it('counts a class-of-bug finding as in-diff when any location is', () => {
    const t = assignTag(
      issue('blocker', { line_start: 90, line_end: 90, locations: [{ file: 'src/a.ts', line_start: 11, line_end: 11 }] }),
      files,
    );
    expect(t.tag).toBe('Important');
  });

  it('caps a tag, keeping the most severe', () => {
    const nits = [
      issue('nitpick', { title: 'n1', tag: 'Nit' }),
      issue('suggestion', { title: 's1', tag: 'Nit' }),
      issue('nitpick', { title: 'n2', tag: 'Nit' }),
      issue('blocker', { title: 'b', tag: 'Important' }),
    ];
    const { kept, dropped } = capTag(nits, 'Nit', 1);
    expect(kept.map((i) => i.title)).toEqual(['s1', 'b']);
    expect(dropped.map((i) => i.title)).toEqual(['n1', 'n2']);
  });

  it('sorts Important, then Nit, then Pre-existing; most severe first', () => {
    const sorted = sortIssues([
      issue('warning', { title: 'pre', tag: 'Pre-existing' }),
      issue('nitpick', { title: 'nit', tag: 'Nit' }),
      issue('warning', { title: 'warn', tag: 'Important' }),
      issue('security', { title: 'sec', tag: 'Important' }),
    ]);
    expect(sorted.map((i) => i.title)).toEqual(['sec', 'warn', 'nit', 'pre']);
  });
});
