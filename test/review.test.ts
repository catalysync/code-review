import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reviewMarker, STEPBACK_MARKER } from '../src/fingerprint.js';
import type { GitHubApi, PriorComment, PriorReview } from '../src/github.js';
import type { GhReviewPayload } from '../src/render.js';
import { runReview } from '../src/review.js';
import { fakeLlm } from './helpers.js';

const HEAD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OLD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const PR_DIFF = [
  'diff --git a/app/controllers/contracts_controller.rb b/app/controllers/contracts_controller.rb',
  '--- a/app/controllers/contracts_controller.rb',
  '+++ b/app/controllers/contracts_controller.rb',
  '@@ -20,4 +20,4 @@ class ContractsController < ApplicationController',
  '   private',
  ' ',
  '   def contract_params',
  '-    params.require(:contract).permit(:title, :author_id)',
  '+    params.require(:contract).permit(:title, :author_id, :territory)',
  '   end',
].join('\n');

const INCREMENTAL_DIFF = PR_DIFF;

const finding = {
  file: 'app/controllers/contracts_controller.rb',
  line_start: 23,
  line_end: 23,
  category: 'bug',
  severity: 'blocker',
  tag: 'Important',
  title: 'rights_type is not permitted',
  why: 'The form posts rights_type but strong params drop it, so it is never saved.',
  evidence: 'app/controllers/contracts_controller.rb:23 `permit(:title, :author_id, :territory)`',
};

function fakeGitHub(opts: { reviews?: PriorReview[]; comments?: PriorComment[]; reject422?: boolean } = {}) {
  const posted: GhReviewPayload[] = [];
  let calls = 0;
  const gh: GitHubApi = {
    getPr: async () => ({
      owner: 'o',
      repo: 'r',
      number: 7,
      headSha: HEAD_SHA,
      baseSha: 'base',
      diff: PR_DIFF,
      additions: 1,
      deletions: 1,
      title: 'Add territory',
      body: 'Adds territory and rights_type to contracts.',
    }),
    compareDiff: vi.fn(async () => INCREMENTAL_DIFF),
    listReviews: async () => opts.reviews ?? [],
    listReviewComments: async () => opts.comments ?? [],
    getFile: async () => undefined,
    createReview: vi.fn(async (p: GhReviewPayload) => {
      calls++;
      if (opts.reject422 && calls === 1) throw Object.assign(new Error('Unprocessable'), { status: 422 });
      posted.push(p);
      return { id: calls, htmlUrl: `https://gh/review/${calls}` };
    }),
  };
  return { gh, posted };
}

const repoRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'cr-'));
  writeFileSync(join(root, 'Gemfile'), 'gem "rails"');
  return root;
};

const base = { owner: 'o', repo: 'r', prNumber: 7, walkthrough: false } as const;

describe('runReview', () => {
  it('posts one review with inline comments, fingerprints and a round marker', async () => {
    const { gh, posted } = fakeGitHub();
    const { llm } = fakeLlm({ review: { summary: '', issues: [finding] } });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm });
    expect(posted).toHaveLength(1);
    const p = posted[0];
    expect(p.commit_id).toBe(HEAD_SHA);
    expect(p.comments).toHaveLength(1);
    expect(p.comments[0].body).toMatch(/<!-- cr:fp=[0-9a-f]+/);
    expect(p.comments[0].body).toContain('**Important**');
    expect(p.body.startsWith('**1 issue** (1 Important)')).toBe(true);
    expect(p.body).toContain(reviewMarker({ sha: HEAD_SHA, round: 1 }));
    expect(res.round).toBe(1);
    expect(res.layers).toEqual(['ruby/+rails']);
  });

  it('says plainly "No issues found." when there are none', async () => {
    const { gh, posted } = fakeGitHub();
    const { llm } = fakeLlm({ review: { summary: 'No issues found.', issues: [] } });
    await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm });
    expect(posted[0].body.startsWith('No issues found.')).toBe(true);
    expect(posted[0].comments).toEqual([]);
  });

  it('does not repost a finding whose fingerprint is already on the PR', async () => {
    const first = fakeGitHub();
    const { llm } = fakeLlm({ review: { summary: '', issues: [finding] } });
    await runReview({ ...base, repoRoot: repoRoot(), github: first.gh, llm });
    const priorComment = first.posted[0].comments[0];

    const second = fakeGitHub({
      reviews: [{ id: 1, commitId: HEAD_SHA, body: first.posted[0].body }],
      comments: [{ id: 9, body: priorComment.body, path: priorComment.path, line: priorComment.line }],
    });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: second.gh, llm });
    expect(second.posted[0].comments).toEqual([]);
    expect(second.posted[0].body).toMatch(/^No new issues found \(1 already reported earlier, not repeated\)\./);
    expect(res.stats.duplicates).toBe(1);
    expect(res.round).toBe(2);
  });

  it('after the first round, reviews only the diff since the last reviewed commit', async () => {
    const { gh } = fakeGitHub({ reviews: [{ id: 1, commitId: OLD_SHA, body: reviewMarker({ sha: OLD_SHA, round: 1 }) }] });
    const { llm, tool } = fakeLlm({ review: { summary: '', issues: [] } });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm });
    expect(gh.compareDiff).toHaveBeenCalledWith(OLD_SHA, HEAD_SHA);
    expect(res.since).toBe(OLD_SHA);
    expect(tool.mock.calls[0][0].user).toContain('round 2');
  });

  it('--no-incremental and an unreachable since both fall back to the full diff', async () => {
    const prior = [{ id: 1, commitId: OLD_SHA, body: reviewMarker({ sha: OLD_SHA, round: 1 }) }];
    const a = fakeGitHub({ reviews: prior });
    const { llm } = fakeLlm({ review: { summary: '', issues: [] } });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: a.gh, llm, incremental: false });
    expect(a.gh.compareDiff).not.toHaveBeenCalled();
    expect(res.since).toBeUndefined();

    const b = fakeGitHub({ reviews: prior });
    (b.gh.compareDiff as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Not Found'));
    const res2 = await runReview({ ...base, repoRoot: repoRoot(), github: b.gh, llm });
    expect(res2.since).toBeUndefined();
    expect(res2.warnings.join()).toMatch(/reviewing the full PR diff/);
  });

  it('honours an explicit --since', async () => {
    const { gh } = fakeGitHub();
    const { llm } = fakeLlm({ review: { summary: '', issues: [] } });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm, since: OLD_SHA });
    expect(gh.compareDiff).toHaveBeenCalledWith(OLD_SHA, HEAD_SHA);
    expect(res.since).toBe(OLD_SHA);
  });

  it('after max rounds, posts one step-back note instead of another review', async () => {
    const prior = [1, 2, 3].map((n) => ({ id: n, commitId: OLD_SHA, body: reviewMarker({ sha: OLD_SHA, round: n }) }));
    const { gh, posted } = fakeGitHub({ reviews: prior });
    const { llm, tool } = fakeLlm({ review: { summary: '', issues: [finding] } });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm, maxRounds: 3 });
    expect(res.capped).toBe(true);
    expect(tool).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toContain('Review paused after 3 rounds');
    expect(posted[0].body).toContain(STEPBACK_MARKER);

    const again = fakeGitHub({ reviews: [...prior, { id: 4, commitId: HEAD_SHA, body: posted[0].body }] });
    const res2 = await runReview({ ...base, repoRoot: repoRoot(), github: again.gh, llm, maxRounds: 3 });
    expect(res2.capped).toBe(true);
    expect(again.posted).toHaveLength(0);
  });

  it('moves findings outside the diff to the body instead of failing the whole review', async () => {
    const { gh, posted } = fakeGitHub();
    const outside = {
      ...finding,
      line_start: 80,
      line_end: 80,
      evidence: '',
      title: 'Old bug far away',
    };
    const { llm } = fakeLlm({ review: { summary: '', issues: [finding, outside] } });
    await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm });
    expect(posted[0].comments).toHaveLength(1);
    expect(posted[0].body).toContain('### Findings outside the diff');
    expect(posted[0].body).toContain('contracts_controller.rb:80');
    expect(posted[0].body).toContain('**Pre-existing**');
  });

  it('if GitHub still answers 422, reposts with every finding in the body', async () => {
    const { gh, posted } = fakeGitHub({ reject422: true });
    const { llm } = fakeLlm({ review: { summary: '', issues: [finding] } });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm });
    expect(gh.createReview).toHaveBeenCalledTimes(2);
    expect(posted[0].comments).toEqual([]);
    expect(posted[0].body).toContain('### Findings outside the diff');
    expect(res.warnings.join()).toMatch(/422/);
  });

  it('--dry-run posts nothing', async () => {
    const { gh, posted } = fakeGitHub();
    const { llm } = fakeLlm({ review: { summary: '', issues: [finding] } });
    const res = await runReview({ ...base, repoRoot: repoRoot(), github: gh, llm, dryRun: true });
    expect(posted).toHaveLength(0);
    expect(res.posted).toBeUndefined();
    expect(res.body).toContain('**1 issue**');
  });

  it('applies REVIEW.md rules to the prompt and its skip list to the diff', async () => {
    const root = repoRoot();
    writeFileSync(join(root, 'REVIEW.md'), 'RULE_FROM_REVIEW_MD\n\n## Skip\n\n- app/controllers/\n');
    const { gh } = fakeGitHub();
    const { llm, tool } = fakeLlm({ review: { summary: '', issues: [] } });
    const res = await runReview({ ...base, repoRoot: root, github: gh, llm });
    expect(res.prompt).toContain('RULE_FROM_REVIEW_MD');
    expect(tool).not.toHaveBeenCalled(); // the only changed file is skipped
  });
});
