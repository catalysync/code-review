import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, collectFeedback, summarizeFeedback, writeFeedback } from '../src/feedback.js';
import type { PriorComment } from '../src/github.js';

const bot = (id: number, over: Partial<PriorComment> = {}): PriorComment => ({
  id,
  path: 'app/models/contract.rb',
  line: 10,
  body: `**Important** · \`bug/blocker\` — Unpaid total includes historical settlements\n\nWhy.\n\n<!-- cr:fp=abc${id} loc=def${id} -->`,
  ...over,
});
const reply = (to: number, body: string): PriorComment => ({ id: to * 100, path: 'app/models/contract.rb', line: 10, body, inReplyToId: to });

describe('classify', () => {
  it('reads the outcome from replies first, then from the code', () => {
    expect(classify(bot(1), [reply(1, 'This is a false positive, the guard is above.')])).toBe('disputed');
    expect(classify(bot(1), [reply(1, 'Intentional: we keep them for the statement.')])).toBe('intentional');
    expect(classify(bot(1, { line: null }), [])).toBe('fixed');
    expect(classify(bot(1), [reply(1, 'Fixed in the next commit')])).toBe('fixed');
    expect(classify(bot(1), [reply(1, 'Good catch, will fix')])).toBe('acknowledged');
    expect(classify(bot(1), [])).toBe('ignored');
  });
});

describe('collectFeedback', () => {
  it("records only the reviewer's own top-level comments, with tag and category", () => {
    const comments = [bot(1), reply(1, 'wrong, this is handled'), bot(2, { line: null }), { id: 3, path: 'x.rb', line: 1, body: 'human comment' }];
    const records = collectFeedback(comments, { pr: 7, repo: 'o/r', now: new Date('2026-10-20T00:00:00Z') });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      pr: 7,
      comment_id: 1,
      tag: 'Important',
      category: 'bug',
      severity: 'blocker',
      title: 'Unpaid total includes historical settlements',
      outcome: 'disputed',
      replies: 1,
    });
    expect(records[1].outcome).toBe('fixed');
  });
});

describe('writeFeedback', () => {
  it('replaces older records of the same comment and keeps the rest', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cr-fb-')), '.review', 'feedback.jsonl');
    const first = collectFeedback([bot(1), bot(2)], { pr: 7, repo: 'o/r' });
    writeFeedback(path, first);
    const again = collectFeedback([bot(1, { line: null })], { pr: 7, repo: 'o/r' });
    const all = writeFeedback(path, again);

    expect(all.map((r) => [r.comment_id, r.outcome])).toEqual([
      [2, 'ignored'],
      [1, 'fixed'],
    ]);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

describe('summarizeFeedback', () => {
  it('puts the noisiest kind of comment first', () => {
    const records = [
      ...collectFeedback([bot(1, { line: null }), bot(2, { line: null })], { pr: 1, repo: 'o/r' }),
      ...collectFeedback(
        [bot(3, { body: '**Nit** · `convention/nitpick` — Rename\n\n<!-- cr:fp=aa3 -->' }), bot(4, { body: '**Nit** · `convention/nitpick` — Rename\n\n<!-- cr:fp=aa4 -->' })],
        { pr: 1, repo: 'o/r' },
      ),
    ];
    const groups = summarizeFeedback(records);
    expect(groups.map((g) => g.key)).toEqual(['Nit convention', 'Important bug']);
    expect(groups[0].counts.ignored).toBe(2);
  });
});
