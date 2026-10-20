import { describe, expect, it } from 'vitest';
import { parseDiffFiles } from '../src/diff.js';
import type { Issue } from '../src/types.js';
import { buildVerifierContext, checkGrounding, mapLimit, tallyVotes, verifyIssues } from '../src/verify.js';
import { fakeLlm } from './helpers.js';

const FILE = [
  'class PaymentReconciler',
  '  def call(payment_id)',
  '    return if payment_id.nil?',
  '',
  '    payment = Payment.find(payment_id)',
  '    payment.reconcile!',
  '  end',
  'end',
].join('\n');

const DIFF = [
  'diff --git a/app/services/payment_reconciler.rb b/app/services/payment_reconciler.rb',
  '--- a/app/services/payment_reconciler.rb',
  '+++ b/app/services/payment_reconciler.rb',
  '@@ -5,2 +5,2 @@',
  '     payment = Payment.find(payment_id)',
  '-    payment.reconcile',
  '+    payment.reconcile!',
].join('\n');

const files = parseDiffFiles(DIFF);
const getFile = async (p: string) => (p === 'app/services/payment_reconciler.rb' ? FILE : undefined);

const issue = (over: Partial<Issue> = {}): Issue => ({
  file: 'app/services/payment_reconciler.rb',
  line_start: 5,
  line_end: 5,
  category: 'bug',
  severity: 'blocker',
  title: 'Missing nil guard on payment id',
  why: 'Payment.find(nil) raises',
  ...over,
});

const vote = (verdict: string, evidence = '', reason = '') => ({ verdict, evidence, reason }) as never;

describe('tallyVotes', () => {
  it('needs a strict majority to confirm', () => {
    expect(tallyVotes([vote('confirmed', 'a.rb:1')]).verdict).toBe('confirmed');
    expect(tallyVotes([vote('confirmed', 'a.rb:1'), vote('rejected'), vote('confirmed', 'a.rb:2')]).verdict).toBe(
      'confirmed',
    );
    expect(tallyVotes([vote('confirmed', 'a.rb:1'), vote('rejected'), vote('rejected')]).verdict).toBe('rejected');
  });

  it('counts errored votes against confirmation, and reports error only when all failed', () => {
    expect(tallyVotes([vote('confirmed', 'a.rb:1'), vote('error'), vote('error')]).verdict).toBe('rejected');
    expect(tallyVotes([vote('error'), vote('error')]).verdict).toBe('error');
  });

  it('reports style when style votes dominate the non-confirmations', () => {
    expect(tallyVotes([vote('style'), vote('rejected'), vote('style')]).verdict).toBe('style');
  });
});

describe('verifyIssues', () => {
  it('shows the verifier the surrounding code, including guards outside the hunk', async () => {
    const ctx = await buildVerifierContext(issue(), { getFile, diffFiles: files });
    expect(ctx).toContain('return if payment_id.nil?');
    expect(ctx).toMatch(/3 {2}\s*return if payment_id\.nil\?/);
  });

  it('falls back to diff lines when the file cannot be read', async () => {
    const ctx = await buildVerifierContext(issue(), { getFile: async () => undefined, diffFiles: files });
    expect(ctx).toContain('diff lines only');
    expect(ctx).toContain('payment.reconcile!');
  });

  it('runs N votes per finding and records the tally', async () => {
    const { llm, tool } = fakeLlm({
      verdict: (_req, call) => (call === 1 ? vote('rejected', '', 'guarded at line 3') : vote('confirmed', 'x.rb:5: find')),
    });
    const [out] = await verifyIssues([issue()], { llm, votes: 3, getFile, diffFiles: files });
    expect(tool).toHaveBeenCalledTimes(3);
    expect(out.verification).toMatchObject({ verdict: 'confirmed', confirmed: 2, rejected: 1 });
  });

  it('treats a confirmation without file:line evidence as a rejection', async () => {
    const { llm } = fakeLlm({ verdict: () => vote('confirmed', 'trust me') });
    const [out] = await verifyIssues([issue()], { llm, votes: 1, getFile, diffFiles: files });
    expect(out.verification?.verdict).toBe('rejected');
  });

  it('marks the finding unverified (error) when the verifier throws', async () => {
    const { llm } = fakeLlm({
      verdict: () => {
        throw new Error('503');
      },
    });
    const [out] = await verifyIssues([issue()], { llm, votes: 1, getFile, diffFiles: files });
    expect(out.verification?.verdict).toBe('error');
  });

  it('passes project rules to the verifier', async () => {
    const { llm, tool } = fakeLlm({});
    await verifyIssues([issue()], { llm, votes: 1, getFile, diffFiles: files, projectRules: 'NEVER_FLAG_X' });
    expect(tool.mock.calls[0][0].user).toContain('NEVER_FLAG_X');
  });
});

describe('checkGrounding', () => {
  it('accepts evidence quoting real code', async () => {
    const g = await checkGrounding(issue({ evidence: 'app/services/payment_reconciler.rb:5 `Payment.find(payment_id)`' }), {
      getFile,
      diffFiles: files,
    });
    expect(g.ok).toBe(true);
  });

  it('rejects evidence quoting code that does not exist (invented column)', async () => {
    const g = await checkGrounding(
      issue({ evidence: 'app/services/payment_reconciler.rb:5 `where(calculation_state: :pending)`' }),
      { getFile, diffFiles: files },
    );
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/does not appear/);
  });

  it('ignores backticked path:line references and elided quotes', async () => {
    const g = await checkGrounding(
      issue({ evidence: '`app/services/payment_reconciler.rb:5` and `Payment.find(...)`' }),
      { getFile, diffFiles: files },
    );
    expect(g.ok).toBe(true);
  });

  it('rejects a line past the end of the file and an unknown file', async () => {
    expect((await checkGrounding(issue({ line_start: 400, line_end: 400 }), { getFile, diffFiles: files })).ok).toBe(false);
    expect((await checkGrounding(issue({ file: 'nope.rb' }), { getFile, diffFiles: files })).ok).toBe(false);
  });
});

describe('mapLimit', () => {
  it('preserves order and respects the limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
