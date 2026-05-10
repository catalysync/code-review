import { Octokit } from '@octokit/rest';
import type { GhReviewPayload } from './render.js';

export interface PrContext {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  diff: string;
  additions: number;
  deletions: number;
}

export function makeOctokit(token?: string): Octokit {
  const auth = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!auth) throw new Error('GITHUB_TOKEN or GH_TOKEN must be set');
  return new Octokit({ auth });
}

/** Fetch the PR diff plus head SHA + line totals in one call. */
export async function fetchPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PrContext> {
  const pr = await octokit.pulls.get({ owner, repo, pull_number: number });
  const diffResp = await octokit.pulls.get({
    owner,
    repo,
    pull_number: number,
    mediaType: { format: 'diff' },
  });
  // The diff override changes the response data shape to a string.
  const diff = diffResp.data as unknown as string;
  return {
    owner,
    repo,
    number,
    headSha: pr.data.head.sha,
    baseSha: pr.data.base.sha,
    diff,
    additions: pr.data.additions,
    deletions: pr.data.deletions,
  };
}

/** Submit one PR review with all inline comments grouped under it. */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
  payload: GhReviewPayload,
): Promise<{ id: number; htmlUrl: string }> {
  const resp = await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: number,
    commit_id: payload.commit_id,
    event: payload.event,
    body: payload.body,
    comments: payload.comments.map((c) => ({
      path: c.path,
      body: c.body,
      line: c.line,
      side: c.side,
      ...(c.start_line ? { start_line: c.start_line, start_side: c.start_side } : {}),
    })),
  });
  return { id: resp.data.id, htmlUrl: resp.data.html_url };
}
