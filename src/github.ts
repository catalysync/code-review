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
  title: string;
  body: string;
}

export interface PriorReview {
  id: number;
  commitId: string;
  body: string;
  submittedAt?: string;
}

export interface PriorComment {
  id: number;
  body: string;
  path: string;
  line?: number | null;
  /** Set on a reply: the comment it answers. */
  inReplyToId?: number;
  user?: string;
  createdAt?: string;
}

/**
 * Everything the review flow needs from GitHub for one PR. `runReview` only
 * talks to this interface, so tests pass an in-memory fake.
 */
export interface GitHubApi {
  getPr(): Promise<PrContext>;
  /** Unified diff `base...head` (used for diff-only re-review). */
  compareDiff(base: string, head: string): Promise<string>;
  listReviews(): Promise<PriorReview[]>;
  listReviewComments(): Promise<PriorComment[]>;
  /** File content at `ref`, or undefined if missing / binary / too large. */
  getFile(path: string, ref: string): Promise<string | undefined>;
  createReview(payload: GhReviewPayload): Promise<{ id: number; htmlUrl: string }>;
}

export function makeOctokit(token?: string): Octokit {
  const auth = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!auth) throw new Error('GITHUB_TOKEN or GH_TOKEN must be set');
  return new Octokit({ auth });
}

/** Fetch the PR diff plus head SHA + line totals. */
export async function fetchPr(octokit: Octokit, owner: string, repo: string, number: number): Promise<PrContext> {
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
    title: pr.data.title ?? '',
    body: pr.data.body ?? '',
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

export function createGitHubApi(octokit: Octokit, owner: string, repo: string, number: number): GitHubApi {
  return {
    getPr: () => fetchPr(octokit, owner, repo, number),
    async compareDiff(base, head) {
      const resp = await octokit.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
        mediaType: { format: 'diff' },
      });
      return resp.data as unknown as string;
    },
    async listReviews() {
      const reviews = await octokit.paginate(octokit.pulls.listReviews, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return reviews.map((r) => ({
        id: r.id,
        commitId: r.commit_id ?? '',
        body: r.body ?? '',
        submittedAt: r.submitted_at ?? undefined,
      }));
    },
    async listReviewComments() {
      const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return comments.map((c) => ({
        id: c.id,
        body: c.body ?? '',
        path: c.path,
        line: c.line ?? null,
        inReplyToId: c.in_reply_to_id ?? undefined,
        user: c.user?.login,
        createdAt: c.created_at,
      }));
    },
    async getFile(path, ref) {
      try {
        const resp = await octokit.repos.getContent({ owner, repo, path, ref });
        const data = resp.data as { type?: string; content?: string; encoding?: string };
        if (Array.isArray(resp.data) || data.type !== 'file' || !data.content) return undefined;
        const text = Buffer.from(data.content, (data.encoding as BufferEncoding) ?? 'base64').toString('utf8');
        return text.includes('\u0000') ? undefined : text;
      } catch {
        return undefined;
      }
    },
    createReview: (payload) => postReview(octokit, owner, repo, number, payload),
  };
}
