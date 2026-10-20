import type { FileDiffInfo } from './diff.js';
import type { Llm, ToolSpec, UsageMeter } from './llm.js';
import type { Issue, Location, Verification } from './types.js';

/** Reads a file at the PR head. Returns undefined when unavailable. */
export type FileSource = (path: string) => Promise<string | undefined>;

export const VERIFY_TOOL: ToolSpec = {
  name: 'submit_verdict',
  description: 'Submit your verdict on the candidate finding. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['confirmed', 'rejected', 'style'] },
      evidence: {
        type: 'string',
        description: 'Required for confirmed: `path:line` and the exact quoted code that proves the problem.',
      },
      reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['verdict', 'evidence', 'reason'],
  },
};

export const VERIFIER_SYSTEM_PROMPT = `You are verifying ONE candidate finding produced by an automated code reviewer. Many candidate findings are wrong. Your job is to check this one against the code shown, not to defend it.

Answer with the submit_verdict tool:

- confirmed — the code shown proves the problem exists as described and it would cause a real defect (wrong result, crash, data loss, security hole, broken contract). You MUST put the proving line(s) in \`evidence\` as \`path:line: <exact code>\`.
- rejected — any of: the problem is already handled in the code shown (a guard, an early return, a validation, a default, a rescue); the finding depends on a column, method, constant, file or behaviour that does not appear in the code shown; the cited lines do not say what the finding claims; the reasoning is speculative.
- style — the finding might be true but is only about style, naming, formatting, comments, logging/diagnostics or cleanup, and fixing it would not change behaviour.

Be strict. If you cannot quote the line that proves it, the verdict is rejected. Project rules, when given, override generic advice: a finding that contradicts them is rejected.`;

/**
 * Build the code context shown to the verifier: a numbered window of the
 * head-side file around the finding (and its extra locations), plus the
 * finding's file diff. Falls back to diff lines when the file can't be read.
 */
export async function buildVerifierContext(
  issue: Issue,
  opts: { getFile: FileSource; diffFiles: Map<string, FileDiffInfo>; annotatedDiff?: string; radius?: number },
): Promise<string> {
  const radius = opts.radius ?? 40;
  const ranges: Location[] = [issue, ...(issue.locations ?? []).slice(0, 3)];
  const parts: string[] = [];
  for (const r of ranges) {
    const content = await opts.getFile(r.file).catch(() => undefined);
    if (content !== undefined) {
      const lines = content.split('\n');
      const from = Math.max(1, r.line_start - radius);
      const to = Math.min(lines.length, r.line_end + radius);
      const body = [];
      for (let n = from; n <= to; n++) body.push(`${String(n).padStart(5)}  ${lines[n - 1]}`);
      parts.push(`## ${r.file} (head, lines ${from}-${to})\n\n${body.join('\n')}`);
      continue;
    }
    const info = opts.diffFiles.get(r.file);
    if (info) {
      const body = [...info.lines.entries()]
        .filter(([n]) => n >= r.line_start - radius && n <= r.line_end + radius)
        .map(([n, text]) => `${String(n).padStart(5)}  ${text}`);
      parts.push(`## ${r.file} (diff lines only; full file unavailable)\n\n${body.join('\n')}`);
    } else {
      parts.push(`## ${r.file}\n\n(file not found at head)`);
    }
  }
  if (opts.annotatedDiff) {
    parts.push(`## Diff of ${issue.file} in this PR\n\n${opts.annotatedDiff.slice(0, 12_000)}`);
  }
  return parts.join('\n\n');
}

export function buildVerifierMessage(issue: Issue, context: string, projectRules?: string): string {
  const range = issue.line_start === issue.line_end ? `${issue.line_start}` : `${issue.line_start}-${issue.line_end}`;
  const finding = [
    `File: ${issue.file}:${range}`,
    `Category/severity: ${issue.category}/${issue.severity}`,
    `Title: ${issue.title}`,
    `Why: ${issue.why}`,
    issue.evidence ? `Reviewer's evidence: ${issue.evidence}` : `Reviewer's evidence: (none given)`,
    issue.locations?.length
      ? `Also claimed at: ${issue.locations.map((l) => `${l.file}:${l.line_start}`).join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const rules = projectRules?.trim() ? `\n\n# Project rules\n\n${projectRules.trim()}` : '';
  return `# Candidate finding\n\n${finding}\n\n# Code\n\n${context}${rules}`;
}

const EVIDENCE_REF = /[\w./-]+:\d+/;

interface Vote {
  verdict: 'confirmed' | 'rejected' | 'style' | 'error';
  evidence: string;
  reason: string;
}

function readVote(input: unknown): Vote {
  if (!input || typeof input !== 'object') return { verdict: 'error', evidence: '', reason: 'no verdict returned' };
  const o = input as Record<string, unknown>;
  const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
  const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
  const verdict = o.verdict;
  if (verdict === 'confirmed') {
    // A confirmation without a file:line citation doesn't count.
    if (!EVIDENCE_REF.test(evidence)) return { verdict: 'rejected', evidence, reason: 'confirmed without file:line evidence' };
    return { verdict, evidence, reason };
  }
  if (verdict === 'rejected' || verdict === 'style') return { verdict, evidence, reason };
  return { verdict: 'error', evidence, reason: `unknown verdict ${String(verdict)}` };
}

/**
 * Combine votes. Confirmed needs a strict majority of all votes cast; an
 * errored vote counts against confirmation. If every vote errored the result
 * is `error` (the finding is kept but marked unverified and never gates).
 */
export function tallyVotes(votes: Vote[]): Verification {
  const n = votes.length;
  const confirmed = votes.filter((v) => v.verdict === 'confirmed');
  const rejected = votes.filter((v) => v.verdict === 'rejected');
  const style = votes.filter((v) => v.verdict === 'style');
  const errors = votes.filter((v) => v.verdict === 'error');
  const base = { confirmed: confirmed.length, rejected: rejected.length + style.length };
  if (n > 0 && errors.length === n) {
    return { verdict: 'error', ...base, evidence: '', reason: errors[0].reason };
  }
  if (confirmed.length * 2 > n) {
    return { verdict: 'confirmed', ...base, evidence: confirmed[0].evidence, reason: confirmed[0].reason };
  }
  if (style.length > 0 && style.length >= rejected.length) {
    return { verdict: 'style', ...base, evidence: '', reason: style[0].reason };
  }
  const why = rejected[0] ?? style[0] ?? errors[0];
  return { verdict: 'rejected', ...base, evidence: why?.evidence ?? '', reason: why?.reason ?? '' };
}

export interface VerifyOptions {
  llm: Llm;
  /** Independent verifier calls per finding; confirmed needs a majority. */
  votes: number;
  model?: string;
  projectRules?: string;
  getFile: FileSource;
  diffFiles: Map<string, FileDiffInfo>;
  /** Per-file annotated diff, to show the verifier what changed. */
  annotatedByFile?: Map<string, string>;
  usage?: UsageMeter;
  concurrency?: number;
}

/** Verify each finding with `votes` independent calls. Returns issues with `verification` set. */
export async function verifyIssues(issues: Issue[], opts: VerifyOptions): Promise<Issue[]> {
  return mapLimit(issues, opts.concurrency ?? 4, async (issue) => {
    const context = await buildVerifierContext(issue, {
      getFile: opts.getFile,
      diffFiles: opts.diffFiles,
      annotatedDiff: opts.annotatedByFile?.get(issue.file),
    });
    const user = buildVerifierMessage(issue, context, opts.projectRules);
    const votes = await Promise.all(
      Array.from({ length: Math.max(1, opts.votes) }, async (): Promise<Vote> => {
        try {
          const res = await opts.llm.tool({
            system: VERIFIER_SYSTEM_PROMPT,
            user,
            tool: VERIFY_TOOL,
            maxTokens: 1024,
            model: opts.model,
          });
          opts.usage?.add(res.usage);
          return readVote(res.input ?? parseVerdictText(res.text));
        } catch (err) {
          return { verdict: 'error', evidence: '', reason: (err as Error).message };
        }
      }),
    );
    return { ...issue, verification: tallyVotes(votes) };
  });
}

/** Fallback for providers that answer in text: look for a JSON object or a bare verdict word. */
function parseVerdictText(text: string): unknown {
  const json = /\{[\s\S]*\}/.exec(text);
  if (json) {
    try {
      return JSON.parse(json[0]);
    } catch {
      /* fall through */
    }
  }
  const word = /\b(confirmed|rejected|style)\b/i.exec(text);
  return word ? { verdict: word[1].toLowerCase(), evidence: text, reason: '' } : undefined;
}

/**
 * Cheap, model-free grounding check run before verification. Drops findings
 * that cite a file that doesn't exist, a line past the end of the file, or
 * evidence quoting code that appears nowhere in the referenced files (the
 * classic invented-column / invented-method hallucination). Conservative:
 * when content can't be fetched, the finding passes through to the verifier.
 */
export async function checkGrounding(
  issue: Issue,
  opts: { getFile: FileSource; diffFiles: Map<string, FileDiffInfo> },
): Promise<{ ok: boolean; reason?: string }> {
  const info = opts.diffFiles.get(issue.file);
  const content = await opts.getFile(issue.file).catch(() => undefined);
  if (content === undefined && !info) {
    return { ok: false, reason: `cited file ${issue.file} is not in the diff and could not be read` };
  }
  if (content !== undefined && !info?.deleted) {
    const lineCount = content.split('\n').length;
    if (issue.line_start > lineCount) {
      return { ok: false, reason: `line ${issue.line_start} is past the end of ${issue.file} (${lineCount} lines)` };
    }
  }

  const snippets = codeSpans(issue.evidence ?? '');
  if (snippets.length === 0) return { ok: true };

  const refFiles = new Set<string>([issue.file]);
  for (const m of (issue.evidence ?? '').matchAll(/([\w./-]+\.[\w]+):\d+/g)) refFiles.add(m[1]);
  const haystacks: string[] = [];
  for (const f of refFiles) {
    const c = f === issue.file ? content : await opts.getFile(f).catch(() => undefined);
    const fromDiff = opts.diffFiles.get(f);
    if (c !== undefined) haystacks.push(c);
    else if (fromDiff) haystacks.push([...fromDiff.lines.values()].join('\n'));
    else return { ok: true }; // can't check a file we can't read
  }
  // Everything the PR touched counts too: evidence may legitimately quote a
  // name that exists only in another changed file (e.g. a new form field
  // missing from a controller's permit list).
  for (const f of opts.diffFiles.values()) haystacks.push([...f.lines.values()].join('\n'));
  const hay = squash(haystacks.join('\n'));
  if (snippets.some((s) => hay.includes(squash(s)))) return { ok: true };
  return { ok: false, reason: 'evidence quotes code that does not appear in the cited files' };
}

function codeSpans(text: string): string[] {
  const spans: string[] = [];
  for (const m of text.matchAll(/```[\w-]*\n?([\s\S]*?)```|`([^`\n]+)`/g)) {
    const s = (m[1] ?? m[2] ?? '').trim();
    if (s.length < 4) continue;
    if (/^[\w./-]+:\d+(?:-\d+)?$/.test(s)) continue; // a `path:line` reference, not code
    if (s.includes('...') || s.includes('…')) continue; // elided quote; can't match literally
    spans.push(s);
  }
  return spans;
}

const squash = (s: string) => s.replace(/\s+/g, '');

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
