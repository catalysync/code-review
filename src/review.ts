import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAnthropicLlm } from './anthropic.js';
import { DEFAULT_MAX_TOKENS, defaultModel } from './config.js';
import { composePrompt } from './compose.js';
import { detectStack } from './detect.js';
import { annotateDiff, filterDiff, isLikelyGenerated, parseDiffFiles } from './diff.js';
import { fetchPr, makeOctokit, postReview } from './github.js';
import { parseReview } from './parse.js';
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
}

export interface RunReviewResult {
  review: Review;
  prompt: string;
  promptBytes: number;
  diffBytes: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  posted?: { id: number; htmlUrl: string };
}

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const layers = args.layers?.length ? args.layers : detectStack(args.repoRoot).leaves;
  if (layers.length === 0) {
    throw new Error('no layers detected and none provided — pass --layer python/+fastapi etc.');
  }
  const projectRules = readProjectRules(args.repoRoot, args.projectRulesPath);
  const systemPrompt = composePrompt({ leaves: layers, projectRules });

  const octokit = makeOctokit(args.githubToken);
  const pr = await fetchPr(octokit, args.owner, args.repo, args.prNumber);
  const filteredDiff = filterDiff(pr.diff, isLikelyGenerated);
  const annotated = annotateDiff(filteredDiff);
  const userMessage = `Review the following pull request diff. PR #${pr.number} (${pr.additions}+ / ${pr.deletions}−). Output a single YAML object matching the schema in your system prompt — do not post that YAML as a PR comment.\n\n${annotated}`;

  const llm = createAnthropicLlm({
    apiKey: args.anthropicApiKey,
    baseURL: args.baseUrl,
    model: args.model ?? defaultModel(),
    maxTokens: args.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  const result = await llm.text({ system: systemPrompt, user: userMessage });
  const review = parseReview(result.text);

  let posted: { id: number; htmlUrl: string } | undefined;
  if (!args.dryRun) {
    const payload = renderReview(review, { commitId: pr.headSha, diffFiles: parseDiffFiles(pr.diff) });
    posted = await postReview(octokit, args.owner, args.repo, args.prNumber, payload);
  }

  return {
    review,
    prompt: systemPrompt,
    promptBytes: Buffer.byteLength(systemPrompt, 'utf8'),
    diffBytes: Buffer.byteLength(annotated, 'utf8'),
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadInputTokens,
    cacheCreationTokens: result.usage.cacheCreationInputTokens,
    posted,
  };
}

function readProjectRules(repoRoot: string, override?: string): string | undefined {
  const candidates = override ? [override] : [join(repoRoot, '.review', 'project.md')];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return undefined;
}
