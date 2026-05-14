import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKING_SEVERITIES, evaluateSeverityGate, severityCounts } from '../src/severity.js';
import type { Issue, Review, Severity } from '../src/types.js';

const issue = (severity: Severity, over: Partial<Issue> = {}): Issue => ({
  file: 'src/a.ts',
  line_start: 1,
  line_end: 1,
  category: 'bug',
  severity,
  title: '',
  why: '',
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
});
