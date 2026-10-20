import { createAnthropicLlm } from './anthropic.js';
import { composePrompt } from './compose.js';
import { DEFAULT_MAX_TOKENS, defaultModel } from './config.js';
import { detectStack } from './detect.js';
import { parseDiffFiles } from './diff.js';
import { extractFingerprints, parseReviewMarker, reviewMarker, STEPBACK_MARKER } from './fingerprint.js';
import { createGitHubApi, makeOctokit, type GitHubApi } from './github.js';
import { leavesForChangedFiles } from './languages.js';
import { emptyUsage, type Llm } from './llm.js';
import { reviewDiff, type DroppedFinding, type ReviewStats } from './pipeline.js';
import { makeSkipMatcher, readProjectRules } from './project-rules.js';
import { renderReview } from './render.js';
import type { Review } from './types.js';

export interface RunReviewArgs {
  repoRoot: string;
  owner: string;
  repo: string;
  prNumber: number;
  layers?: string[];
  projectRulesPath?: string;
  model?: string;
  maxTokens?: number;
  dryRun?: boolean;
  anthropicApiKey?: string;
  /** Anthropic-compatible endpoint (DeepSeek, Z.ai GLM, a proxy). Falls back to ANTHROPIC_BASE_URL. */
  baseUrl?: string;
  githubToken?: string;
  /** Verifier calls per finding; majority wins. 0 disables verification. Default 1. */
  verifyVotes?: number;
  verifyModel?: string;
  /** Max Nit-tagged findings per review. Default 3. */
  maxNits?: number;
  /** Max Pre-existing findings per review. Default 3. */
  maxPreExisting?: number;
  /** After this many review rounds, post a step-back note instead. 0 = no cap. Default 3. */
  maxRounds?: number;
  /** Review only `since..head`. Overrides automatic diff-only re-review. */
  since?: string;
  /** Automatically review only new commits after the first round. Default true. */
  incremental?: boolean;
  /** Per-file walkthrough summaries (best-effort). Default true. */
  walkthrough?: boolean;
  /** Mermaid diagram in the walkthrough (one extra call). Default false. */
  diagram?: boolean;
  /** Use tool calling for structured output. Default true. */
  useTools?: boolean;
  /** Injected for tests. */
  llm?: Llm;
  github?: GitHubApi;
}

export interface RunReviewResult {
  review: Review;
  layers: string[];
  prompt: string;
  promptBytes: number;
  diffBytes: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  posted?: { id: number; htmlUrl: string };
  /** 1 for the first review of this PR by this tool. */
  round: number;
  /** Set when only `since..head` was reviewed. */
  since?: string;
  /** True when the round cap was hit and no review was run. */
  capped: boolean;
  stats: ReviewStats;
  dropped: DroppedFinding[];
  warnings: string[];
  /** Body that was (or, on --dry-run, would have been) posted. */
  body: string;
}

const EMPTY_REVIEW: Review = {
  summary: '',
  estimated_review_effort_1_to_5: 1,
  issues: [],
  security_concerns: 'No',
  test_coverage_assessment: '',
  walkthrough: { overview: '', files: [], mermaid: '' },
};

const EMPTY_STATS: ReviewStats = {
  candidates: 0,
  ungrounded: 0,
  rejected: 0,
  style: 0,
  unverified: 0,
  capped: 0,
  duplicates: 0,
  kept: 0,
};

export function stepBackBody(rounds: number): string {
  return [
    `**Review paused after ${rounds} rounds.**`,
    '',
    'Instead of another round of line comments: step back and reconsider the approach. ' +
      'If fixes keep producing new findings, the problem is likely the design rather than individual lines. ' +
      'Consider simplifying or splitting the change, or ask a human reviewer to look at the direction.',
    '',
    'Open threads from earlier rounds still need an answer (fix, or resolve with a reason).',
    '',
    STEPBACK_MARKER,
  ].join('\n');
}

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const gh =
    args.github ?? createGitHubApi(makeOctokit(args.githubToken), args.owner, args.repo, args.prNumber);
  const pr = await gh.getPr();
  const [reviews, comments] = await Promise.all([gh.listReviews(), gh.listReviewComments()]);
  const warnings: string[] = [];

  // Convergence: count our earlier rounds on this PR.
  const prior = reviews.filter((r) => parseReviewMarker(r.body));
  const round = prior.length + 1;
  const maxRounds = args.maxRounds ?? 3;

  const rules = readProjectRules(args.repoRoot, args.projectRulesPath);
  const changedFiles = [...parseDiffFiles(pr.diff).keys()];
  const layers = args.layers?.length
    ? args.layers
    : leavesForChangedFiles(detectStack(args.repoRoot).leaves, changedFiles);
  const systemPrompt = composePrompt({ leaves: layers, projectRules: rules.text });

  const base = {
    layers,
    prompt: systemPrompt,
    promptBytes: Buffer.byteLength(systemPrompt, 'utf8'),
    round,
  };

  if (maxRounds > 0 && prior.length >= maxRounds) {
    const body = stepBackBody(prior.length);
    const alreadyNoted = reviews.some((r) => r.body.includes(STEPBACK_MARKER));
    let posted: { id: number; htmlUrl: string } | undefined;
    if (!args.dryRun && !alreadyNoted) {
      posted = await gh.createReview({ commit_id: pr.headSha, event: 'COMMENT', body, comments: [] });
    }
    if (alreadyNoted) warnings.push('round cap reached and the step-back note was already posted; nothing to do');
    const u = emptyUsage();
    return {
      ...base,
      review: EMPTY_REVIEW,
      diffBytes: 0,
      tokensIn: u.inputTokens,
      tokensOut: u.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      posted,
      capped: true,
      stats: EMPTY_STATS,
      dropped: [],
      warnings,
      body,
    };
  }

  // Diff-only re-review: after the first round, look at new commits only.
  let since = args.since;
  if (!since && args.incremental !== false && prior.length > 0) {
    since = parseReviewMarker(prior[prior.length - 1].body)?.sha;
  }
  if (since === pr.headSha) since = undefined; // re-run on the same commit: review it fully, dedupe handles repeats
  let diff = pr.diff;
  if (since) {
    try {
      diff = await gh.compareDiff(since, pr.headSha);
    } catch (err) {
      warnings.push(`could not diff ${since.slice(0, 12)}..head (${(err as Error).message}); reviewing the full PR diff`);
      since = undefined;
    }
  }

  const alreadyPosted = new Set<string>();
  for (const c of comments) extractFingerprints(c.body).forEach((f) => alreadyPosted.add(f));
  for (const r of prior) extractFingerprints(r.body).forEach((f) => alreadyPosted.add(f));

  const model = args.model ?? defaultModel();
  const llm =
    args.llm ??
    createAnthropicLlm({
      apiKey: args.anthropicApiKey,
      baseURL: args.baseUrl,
      model,
      maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
    });

  const votes = args.verifyVotes ?? 1;
  const result = await reviewDiff({
    diff,
    prDiff: pr.diff,
    systemPrompt,
    llm,
    getFile: (path) => gh.getFile(path, pr.headSha),
    pr: { number: pr.number, title: pr.title, body: pr.body, additions: pr.additions, deletions: pr.deletions },
    since,
    round,
    verifyVotes: votes,
    verifyModel: args.verifyModel,
    projectRules: rules.text,
    maxNits: args.maxNits,
    maxPreExisting: args.maxPreExisting,
    alreadyPosted,
    walkthrough: args.walkthrough ?? true,
    diagram: args.diagram,
    useTools: args.useTools,
    skip: makeSkipMatcher(rules.skip),
  });
  warnings.push(...result.warnings);

  const s = result.stats;
  const droppedByVerify = s.rejected + s.style + s.ungrounded;
  const footer =
    `<sub>Round ${round}` +
    ` · ${since ? `reviewed changes since ${since.slice(0, 7)}` : 'reviewed the full diff'}` +
    ` · ${votes > 0 ? `verified (${votes} vote${votes === 1 ? '' : 's'} per finding)` : 'unverified'}` +
    (s.candidates ? ` · ${s.candidates} candidate(s), ${droppedByVerify} dropped as unconfirmed` : '') +
    '</sub>';
  const renderOpts = {
    commitId: pr.headSha,
    diffFiles: result.prDiffFiles,
    footer,
    marker: reviewMarker({ sha: pr.headSha, round }),
  };
  let payload = renderReview(result.review, renderOpts);

  let posted: { id: number; htmlUrl: string } | undefined;
  if (!args.dryRun) {
    try {
      posted = await gh.createReview(payload);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 422 || payload.comments.length === 0) throw err;
      // Last-resort: GitHub still rejected an anchor. Post everything in the body.
      warnings.push(`GitHub rejected inline comments (422: ${(err as Error).message}); posted findings in the review body`);
      payload = renderReview(result.review, { ...renderOpts, noInline: true });
      posted = await gh.createReview(payload);
    }
  }

  return {
    ...base,
    review: result.review,
    diffBytes: Buffer.byteLength(result.annotatedDiff, 'utf8'),
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadInputTokens,
    cacheCreationTokens: result.usage.cacheCreationInputTokens,
    posted,
    since,
    capped: false,
    stats: result.stats,
    dropped: result.dropped,
    warnings,
    body: payload.body,
  };
}
