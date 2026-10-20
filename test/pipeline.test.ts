import { describe, expect, it } from 'vitest';
import { buildFinderMessage, reviewDiff, stripLeadingCount } from '../src/pipeline.js';
import { evaluateSeverityGate } from '../src/severity.js';
import { fakeLlm } from './helpers.js';

const DIFF = [
  'diff --git a/app/models/contract.rb b/app/models/contract.rb',
  '--- a/app/models/contract.rb',
  '+++ b/app/models/contract.rb',
  '@@ -1,3 +1,7 @@',
  ' class Contract < ApplicationRecord',
  '   has_many :royalty_calculations',
  '+',
  '+  def sum_royalties_not_paid',
  '+    royalty_calculations.where(paid: false).sum(:amount)',
  '+  end',
  ' end',
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
  '--- a/pnpm-lock.yaml',
  '+++ b/pnpm-lock.yaml',
  '@@ -1 +1 @@',
  '-a',
  '+b',
].join('\n');

const HEAD = [
  'class Contract < ApplicationRecord',
  '  has_many :royalty_calculations',
  '',
  '  def sum_royalties_not_paid',
  '    royalty_calculations.where(paid: false).sum(:amount)',
  '  end',
  'end',
].join('\n');

const getFile = async (p: string) => (p === 'app/models/contract.rb' ? HEAD : undefined);

const real = {
  file: 'app/models/contract.rb',
  line_start: 4,
  line_end: 6,
  category: 'bug',
  severity: 'blocker',
  tag: 'Important',
  title: 'Unpaid total includes historical settlements',
  why: 'historical_settlement rows are read-only and never payable, but are summed.',
  evidence: 'app/models/contract.rb:5 `royalty_calculations.where(paid: false).sum(:amount)`',
};
const invented = {
  ...real,
  line_start: 5,
  line_end: 5,
  title: 'Uses wrong state column',
  evidence: 'app/models/contract.rb:5 `where(calculation_state: :unpaid)`',
};
const nit = (n: number) => ({
  ...real,
  line_start: 5,
  line_end: 5,
  severity: 'nitpick',
  tag: 'Nit',
  title: `nit number ${n}`,
  evidence: `app/models/contract.rb:5 \`sum(:amount)\` ${n}`,
});

describe('reviewDiff', () => {
  it('runs find → ground → verify → tag → cap → fingerprint', async () => {
    const { llm, tool } = fakeLlm({
      review: { summary: '6 issues found. Adds an unpaid total.', issues: [real, invented, nit(1), nit(2), nit(3), nit(4)] },
      verdict: (req) =>
        req.user.includes('nit number 2')
          ? { verdict: 'style', evidence: '', reason: 'naming' }
          : { verdict: 'confirmed', evidence: 'app/models/contract.rb:5: sum(:amount)', reason: 'ok' },
    });
    const res = await reviewDiff({ diff: DIFF, systemPrompt: 'SYS', llm, getFile, maxNits: 1 });

    // invented column dropped before any verifier call; nit 2 dropped as style; 2 of the 3 remaining nits over the cap of 1.
    expect(res.stats).toMatchObject({ candidates: 6, ungrounded: 1, style: 1, capped: 2, kept: 2 });
    expect(tool.mock.calls.filter((c) => c[0].tool.name === 'submit_verdict')).toHaveLength(5);
    expect(res.review.issues.map((i) => i.tag)).toEqual(['Important', 'Nit']);
    expect(res.review.issues.every((i) => i.fingerprint && i.verification?.verdict === 'confirmed')).toBe(true);
    expect(evaluateSeverityGate(res.review).blocked).toBe(true);
    // The model's own count is stripped; the harness writes the count.
    expect(res.review.walkthrough.overview).toBe('Adds an unpaid total.');
  });

  it('drops findings the verifier rejects, so they never gate', async () => {
    const { llm } = fakeLlm({
      review: { summary: '', issues: [real] },
      verdict: () => ({ verdict: 'rejected', evidence: '', reason: 'already excluded upstream' }),
    });
    const res = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm, getFile, walkthrough: false });
    expect(res.review.issues).toEqual([]);
    expect(res.dropped[0]).toMatchObject({ reason: 'rejected', detail: 'already excluded upstream' });
    expect(evaluateSeverityGate(res.review).blocked).toBe(false);
  });

  it('with verification off, findings are kept but cannot gate', async () => {
    const { llm, tool } = fakeLlm({ review: { summary: '', issues: [real] } });
    const res = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm, getFile, verifyVotes: 0 });
    expect(tool).toHaveBeenCalledTimes(1);
    expect(res.review.issues).toHaveLength(1);
    expect(res.stats.unverified).toBe(1);
    expect(evaluateSeverityGate(res.review).blocked).toBe(false);
  });

  it('marks findings already posted (by fingerprint) without dropping them from the gate', async () => {
    const { llm } = fakeLlm({ review: { summary: '', issues: [real] } });
    const first = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm, getFile });
    const posted = new Set([first.review.issues[0].fingerprint!]);
    const { llm: llm2 } = fakeLlm({ review: { summary: '', issues: [{ ...real, title: 'Reworded title' }] } });
    const second = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm: llm2, getFile, alreadyPosted: new Set([first.review.issues[0].loc_fingerprint!, ...posted]) });
    expect(second.review.issues[0].already_posted).toBe(true);
    expect(second.stats).toMatchObject({ duplicates: 1, kept: 0 });
    expect(evaluateSeverityGate(second.review).blocked).toBe(true);
  });

  it('collapses the same finding reported twice in one review', async () => {
    const { llm } = fakeLlm({ review: { summary: '', issues: [real, { ...real }] } });
    const res = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm, getFile });
    expect(res.review.issues).toHaveLength(1);
    expect(res.dropped.map((d) => d.reason)).toEqual(['duplicate']);
  });

  it('never sends generated files or REVIEW.md skip paths to the model, and drops findings on them', async () => {
    const { llm, tool } = fakeLlm({
      review: { summary: '', issues: [{ ...real, file: 'pnpm-lock.yaml', line_start: 1, line_end: 1 }] },
    });
    const res = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm, getFile, skip: (p) => p.startsWith('app/models/') });
    expect(res.annotatedDiff).toBe('');
    expect(tool).not.toHaveBeenCalled();
    expect(res.review.issues).toEqual([]);
  });

  it('survives a walkthrough failure', async () => {
    const { llm } = fakeLlm({
      review: { summary: '', issues: [] },
      text: () => {
        throw new Error('summary model down');
      },
    });
    const res = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm, getFile, walkthrough: true });
    expect(res.review.issues).toEqual([]);
    expect(res.review.walkthrough.files).toEqual([{ file: 'app/models/contract.rb', summary: '(summary unavailable)' }]);
  });

  it('falls back to YAML when the provider ignores the tool', async () => {
    const llm = {
      tool: async () => ({
        input: undefined,
        text: 'review:\n  summary: none\n  issues: []\n',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }),
      text: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
    };
    const res = await reviewDiff({ diff: DIFF, systemPrompt: 'S', llm, getFile });
    expect(res.warnings.join()).toMatch(/fell back to parsing YAML/);
  });
});

describe('finder message', () => {
  it('includes PR intent and, on re-review, scopes the model to new changes', () => {
    const msg = buildFinderMessage({
      annotated: 'DIFF',
      pr: { number: 7, title: 'Add totals', body: 'Fixes unpaid total' },
      since: 'abcdef1234567890',
      round: 2,
      useTools: true,
    });
    expect(msg).toContain('PR #7 "Add totals"');
    expect(msg).toContain('Fixes unpaid total');
    expect(msg).toContain('round 2');
    expect(msg).toContain('abcdef123456');
    expect(msg).toContain('submit_review');
  });

  it('strips a leading count from the model summary', () => {
    expect(stripLeadingCount('3 issues: a, b. Rest.')).toBe('a, b. Rest.');
    expect(stripLeadingCount('No issues found. Clean.')).toBe('Clean.');
    expect(stripLeadingCount('Adds X.')).toBe('Adds X.');
  });
});
