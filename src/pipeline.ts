import { annotateDiff, annotatePerFile, filterDiff, isLikelyGenerated, parseDiffFiles, splitByFile, type FileDiffInfo } from './diff.js';
import type { LlmCall } from './file-summary.js';
import { fingerprintIssue, isAlreadyPosted } from './fingerprint.js';
import { UsageMeter, type Llm, type LlmUsage } from './llm.js';
import { parseReview } from './parse.js';
import { assignTag, capTag, sortIssues } from './severity.js';
import { reviewFromToolResult, SUBMIT_REVIEW_TOOL } from './structured.js';
import type { Issue, Review, Walkthrough } from './types.js';
import { checkGrounding, verifyIssues, type FileSource } from './verify.js';
import { generateWalkthrough } from './walkthrough.js';

export interface ReviewDiffOptions {
  /** The diff to review. On a diff-only re-review this is `since..head`. */
  diff: string;
  /** The whole PR diff (`base..head`), used for anchors and tags. Defaults to `diff`. */
  prDiff?: string;
  systemPrompt: string;
  llm: Llm;
  /** Reads a file at the PR head; gives the verifier real context. */
  getFile?: FileSource;
  pr?: { number?: number; title?: string; body?: string; additions?: number; deletions?: number };
  /** Set on a diff-only re-review: the commit the previous round reviewed. */
  since?: string;
  round?: number;
  /** Verifier calls per finding (majority wins). 0 disables verification. Default 1. */
  verifyVotes?: number;
  verifyModel?: string;
  projectRules?: string;
  maxNits?: number;
  maxPreExisting?: number;
  /** Fingerprints already posted on this PR. */
  alreadyPosted?: ReadonlySet<string>;
  walkthrough?: boolean;
  diagram?: boolean;
  summaryModel?: string;
  /** Use the submit_review tool (default). False = ask for YAML text. */
  useTools?: boolean;
  /** Extra paths to exclude from review (REVIEW.md skip list). */
  skip?: (path: string) => boolean;
}

export interface ReviewStats {
  candidates: number;
  ungrounded: number;
  rejected: number;
  style: number;
  unverified: number;
  capped: number;
  duplicates: number;
  kept: number;
}

export interface DroppedFinding {
  issue: Issue;
  reason: 'skipped-path' | 'ungrounded' | 'rejected' | 'style' | 'capped' | 'duplicate';
  detail?: string;
}

export interface ReviewDiffResult {
  /** Final findings (including `already_posted` ones, which are not re-posted) + walkthrough. */
  review: Review;
  stats: ReviewStats;
  dropped: DroppedFinding[];
  usage: LlmUsage;
  warnings: string[];
  annotatedDiff: string;
  prDiffFiles: Map<string, FileDiffInfo>;
}

const YAML_INSTRUCTION =
  'Output a single YAML object with a top-level `review:` key matching the schema in your system prompt.';
const TOOL_INSTRUCTION =
  'Call the submit_review tool exactly once with your findings. An empty issues list is a valid answer.';

export function buildFinderMessage(opts: {
  annotated: string;
  pr?: ReviewDiffOptions['pr'];
  since?: string;
  round?: number;
  useTools: boolean;
}): string {
  const parts: string[] = [];
  const pr = opts.pr ?? {};
  const stat = pr.additions !== undefined ? ` (${pr.additions}+ / ${pr.deletions ?? 0}−)` : '';
  parts.push(`Review the following pull request diff. PR${pr.number ? ` #${pr.number}` : ''}${pr.title ? ` "${pr.title}"` : ''}${stat}.`);
  if (opts.since) {
    parts.push(
      `This is review round ${opts.round ?? 2}. Earlier rounds already reviewed this PR up to commit ${opts.since.slice(0, 12)}; ` +
        'only the changes made since then are shown. Review only these changes and do not re-report problems in code outside them.',
    );
  }
  parts.push(opts.useTools ? TOOL_INSTRUCTION : YAML_INSTRUCTION);
  if (pr.body?.trim()) {
    parts.push(`## PR description (the author's stated intent)\n\n${pr.body.trim().slice(0, 4000)}`);
  }
  parts.push(opts.annotated);
  return parts.join('\n\n');
}

/** Strip a leading count sentence the model may add; the harness writes its own count. */
export function stripLeadingCount(summary: string): string {
  return summary
    .replace(/^\s*(no issues found\.?|\d+\s+(?:issues?|findings?)\b[^.:\n]*[.:])\s*/i, '')
    .trim();
}

/**
 * Review one diff end to end, without any GitHub I/O:
 * find (structured tool call) → ground → verify (vote) → tag → cap → fingerprint/dedupe.
 * The optional walkthrough runs alongside and can never fail the review.
 */
export async function reviewDiff(opts: ReviewDiffOptions): Promise<ReviewDiffResult> {
  const usage = new UsageMeter();
  const warnings: string[] = [];
  const dropped: DroppedFinding[] = [];
  const useTools = opts.useTools ?? true;
  const skip = opts.skip ?? (() => false);
  const excluded = (p: string) => isLikelyGenerated(p) || skip(p);

  const filtered = filterDiff(opts.diff, excluded);
  const annotated = annotateDiff(filtered);
  const prDiffFiles = parseDiffFiles(opts.prDiff ?? opts.diff);
  const reviewedFiles = parseDiffFiles(filtered);
  const getFile = memoizeFiles(opts.getFile);

  const annotatedByFile = new Map<string, string>();
  for (const s of splitByFile(filtered)) annotatedByFile.set(s.path, annotateDiff(s.body));

  const walkthroughP: Promise<Walkthrough | undefined> =
    opts.walkthrough && annotated
      ? generateWalkthrough({
          files: annotatePerFile(filtered).map((s) => ({ file: s.path, annotatedDiff: s.body })),
          llm: asLlmCall(opts.llm, usage, opts.summaryModel),
          diagram: opts.diagram,
          annotatedDiff: annotated,
        }).catch((err) => {
          warnings.push(`walkthrough skipped: ${(err as Error).message}`);
          return undefined;
        })
      : Promise.resolve(undefined);

  let review: Review;
  if (!annotated.trim()) {
    review = {
      summary: '',
      estimated_review_effort_1_to_5: 1,
      issues: [],
      security_concerns: 'No',
      test_coverage_assessment: '',
      walkthrough: { overview: '', files: [], mermaid: '' },
    };
  } else {
    const user = buildFinderMessage({ annotated, pr: opts.pr, since: opts.since, round: opts.round, useTools });
    if (useTools) {
      const res = await opts.llm.tool({ system: opts.systemPrompt, user, tool: SUBMIT_REVIEW_TOOL });
      usage.add(res.usage);
      if (res.input === undefined || res.input === null) {
        warnings.push('provider returned no tool call; fell back to parsing YAML from text');
      }
      review = reviewFromToolResult(res);
    } else {
      const res = await opts.llm.text({ system: opts.systemPrompt, user });
      usage.add(res.usage);
      review = parseReview(res.text);
    }
  }

  const stats: ReviewStats = {
    candidates: review.issues.length,
    ungrounded: 0,
    rejected: 0,
    style: 0,
    unverified: 0,
    capped: 0,
    duplicates: 0,
    kept: 0,
  };

  // 1. Paths the repo asked us to skip never produce findings.
  let issues: Issue[] = [];
  for (const issue of review.issues) {
    if (excluded(issue.file)) dropped.push({ issue, reason: 'skipped-path' });
    else issues.push(issue);
  }

  // 2. Model-free grounding check (invented files, lines, quoted code).
  const grounded: Issue[] = [];
  for (const issue of issues) {
    const g = await checkGrounding(issue, { getFile, diffFiles: new Map([...prDiffFiles, ...reviewedFiles]) });
    if (g.ok) grounded.push(issue);
    else {
      stats.ungrounded++;
      dropped.push({ issue, reason: 'ungrounded', detail: g.reason });
    }
  }
  issues = grounded;

  // 3. Verification vote.
  const votes = opts.verifyVotes ?? 1;
  if (votes > 0 && issues.length > 0) {
    const verified = await verifyIssues(issues, {
      llm: opts.llm,
      votes,
      model: opts.verifyModel,
      projectRules: opts.projectRules,
      getFile,
      diffFiles: prDiffFiles,
      annotatedByFile,
      usage,
    });
    issues = [];
    for (const issue of verified) {
      const v = issue.verification!;
      if (v.verdict === 'rejected') {
        stats.rejected++;
        dropped.push({ issue, reason: 'rejected', detail: v.reason });
      } else if (v.verdict === 'style') {
        stats.style++;
        dropped.push({ issue, reason: 'style', detail: v.reason });
      } else {
        if (v.verdict === 'error') stats.unverified++;
        issues.push(issue);
      }
    }
    if (stats.unverified > 0) warnings.push(`${stats.unverified} finding(s) could not be verified (verifier error); they will not gate`);
  } else if (votes <= 0) {
    stats.unverified = issues.length;
  }

  // 4. Deterministic tags, then caps on Nit / Pre-existing.
  issues = issues.map((i) => assignTag(i, prDiffFiles));
  for (const [tag, max] of [
    ['Nit', opts.maxNits ?? 3],
    ['Pre-existing', opts.maxPreExisting ?? 3],
  ] as const) {
    const capped = capTag(issues, tag, max);
    issues = capped.kept;
    stats.capped += capped.dropped.length;
    for (const issue of capped.dropped) dropped.push({ issue, reason: 'capped', detail: `more than ${max} ${tag}` });
  }

  // 5. Fingerprint, collapse duplicates within this run, mark ones already posted.
  const seen = new Set<string>();
  const final: Issue[] = [];
  for (const issue of issues) {
    const code = await citedCode(issue, getFile, prDiffFiles);
    const fp = fingerprintIssue(issue, code);
    const keys = [fp.fingerprint, fp.loc_fingerprint].filter(Boolean) as string[];
    if (keys.some((k) => seen.has(k))) {
      dropped.push({ issue: fp, reason: 'duplicate', detail: 'same finding twice in one review' });
      continue;
    }
    keys.forEach((k) => seen.add(k));
    if (opts.alreadyPosted && isAlreadyPosted(fp, opts.alreadyPosted)) {
      stats.duplicates++;
      final.push({ ...fp, already_posted: true });
    } else {
      final.push(fp);
    }
  }

  const sorted = sortIssues(final);
  stats.kept = sorted.filter((i) => !i.already_posted).length;

  const walkthrough = await walkthroughP;
  const overview = stripLeadingCount(review.summary);
  return {
    review: {
      ...review,
      issues: sorted,
      // The overview comes free with the finder call; per-file summaries and
      // the diagram only when the walkthrough step ran.
      walkthrough: {
        files: walkthrough?.files ?? [],
        mermaid: walkthrough?.mermaid ?? '',
        overview: walkthrough?.overview || overview,
      },
    },
    stats,
    dropped,
    usage: usage.total,
    warnings,
    annotatedDiff: annotated,
    prDiffFiles,
  };
}

function memoizeFiles(source?: FileSource): FileSource {
  const cache = new Map<string, Promise<string | undefined>>();
  return (path) => {
    if (!source) return Promise.resolve(undefined);
    let p = cache.get(path);
    if (!p) {
      p = source(path).catch(() => undefined);
      cache.set(path, p);
    }
    return p;
  };
}

async function citedCode(issue: Issue, getFile: FileSource, files: Map<string, FileDiffInfo>): Promise<string[]> {
  const out: string[] = [];
  const content = await getFile(issue.file);
  const lines = content?.split('\n');
  const info = files.get(issue.file);
  for (let n = issue.line_start; n <= issue.line_end; n++) {
    const text = lines ? lines[n - 1] : info?.lines.get(n);
    if (text !== undefined) out.push(text);
  }
  return out;
}

function asLlmCall(llm: Llm, usage: UsageMeter, model?: string): LlmCall {
  return async ({ systemPrompt, userMessage }) => {
    const res = await llm.text({ system: systemPrompt, user: userMessage, maxTokens: 1024, model });
    usage.add(res.usage);
    return { text: res.text };
  };
}
