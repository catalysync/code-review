import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { composePrompt } from './compose.js';
import { parseDiffFiles } from './diff.js';
import { leavesForChangedFiles } from './languages.js';
import type { Llm } from './llm.js';
import { reviewDiff } from './pipeline.js';
import { effectiveTag } from './severity.js';
import type { Issue } from './types.js';

/**
 * Evals score the reviewer against small PRs with known answers, the way
 * Anthropic turns past incidents into an eval set: each real bug the reviewer
 * must find is an `expect`, each false alarm it must not raise is a `forbid`.
 * A case with no expects is a clean PR that should come back empty.
 *
 * A case is a folder:
 *   case.json   title, description (the PR body), layers, rules, expect, forbid
 *   diff.patch  the unified diff under review
 *   files/      optional: files at the PR head, so the verifier sees real context
 */
export const ExpectationSchema = z.object({
  id: z.string().min(1),
  /** The file the finding must point at, or any of several. */
  file: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  /** Inclusive line range the finding must cite (its own lines or a listed location). */
  lines: z.tuple([z.number().int(), z.number().int()]).optional(),
  /** Case-insensitive regex over the finding's title, why and evidence. */
  match: z.string().optional(),
  note: z.string().optional(),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

export const EvalCaseSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  /** Detected stack layers, as `code-review compose --layer` takes them. */
  layers: z.array(z.string()).default([]),
  /** REVIEW.md text for this case. */
  rules: z.string().optional(),
  expect: z.array(ExpectationSchema).default([]),
  forbid: z.array(ExpectationSchema).default([]),
});

export interface EvalCase extends z.infer<typeof EvalCaseSchema> {
  name: string;
  diff: string;
  files: Map<string, string>;
}

export interface CaseScore {
  name: string;
  title: string;
  caught: string[];
  missed: string[];
  /** Forbidden findings the reviewer raised anyway. */
  falseAlarms: string[];
  /** Important findings that match neither list: not scored as wrong, but noise to look at. */
  unexpected: Issue[];
  issues: Issue[];
  error?: string;
}

export interface EvalSummary {
  cases: CaseScore[];
  expected: number;
  caught: number;
  falseAlarms: number;
  unexpected: number;
  /** caught / expected, or 1 when nothing was expected. */
  recall: number;
  /** Clean cases (no expects) that came back without an Important finding. */
  cleanPassed: number;
  cleanTotal: number;
}

export function loadCases(dir: string): EvalCase[] {
  if (!existsSync(dir)) throw new Error(`no eval cases at ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'case.json')))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const root = join(dir, name);
      const parsed = EvalCaseSchema.safeParse(JSON.parse(readFileSync(join(root, 'case.json'), 'utf8')));
      if (!parsed.success) throw new Error(`invalid ${name}/case.json: ${parsed.error.message}`);
      return { ...parsed.data, name, diff: readFileSync(join(root, 'diff.patch'), 'utf8'), files: readFiles(join(root, 'files')) };
    });
}

function readFiles(root: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) readFiles(join(root, entry.name), rel).forEach((v, k) => out.set(k, v));
    else out.set(normalize(rel).split(sep).join('/'), readFileSync(join(root, entry.name), 'utf8'));
  }
  return out;
}

/** Every file:line range a finding points at: its own lines plus its listed locations. */
function spans(issue: Issue): { file: string; start: number; end: number }[] {
  const own = { file: issue.file, start: issue.line_start, end: Math.max(issue.line_end, issue.line_start) };
  const extra = (issue.locations ?? []).map((l) => ({ file: l.file, start: l.line_start, end: Math.max(l.line_end, l.line_start) }));
  return [own, ...extra];
}

export function matches(issue: Issue, exp: Expectation): boolean {
  const onTarget = spans(issue).some(
    (s) => [exp.file].flat().includes(s.file) && (!exp.lines || (s.start <= exp.lines[1] && s.end >= exp.lines[0])),
  );
  if (!onTarget) return false;
  if (!exp.match) return true;
  const text = [issue.title, issue.why, issue.evidence ?? ''].join('\n');
  return new RegExp(exp.match, 'i').test(text);
}

export function scoreCase(c: Pick<EvalCase, 'name' | 'title' | 'expect' | 'forbid'>, issues: Issue[]): CaseScore {
  const caught = c.expect.filter((e) => issues.some((i) => matches(i, e))).map((e) => e.id);
  const missed = c.expect.filter((e) => !caught.includes(e.id)).map((e) => e.id);
  const falseAlarms = c.forbid.filter((f) => issues.some((i) => matches(i, f))).map((f) => f.id);
  const unexpected = issues.filter(
    (i) => effectiveTag(i) === 'Important' && !c.expect.some((e) => matches(i, e)) && !c.forbid.some((f) => matches(i, f)),
  );
  return { name: c.name, title: c.title, caught, missed, falseAlarms, unexpected, issues };
}

export function summarize(cases: CaseScore[], all: Pick<EvalCase, 'expect'>[]): EvalSummary {
  const expected = all.reduce((n, c) => n + c.expect.length, 0);
  const caught = cases.reduce((n, c) => n + c.caught.length, 0);
  const clean = cases.filter((_, i) => all[i].expect.length === 0);
  return {
    cases,
    expected,
    caught,
    falseAlarms: cases.reduce((n, c) => n + c.falseAlarms.length, 0),
    unexpected: cases.reduce((n, c) => n + c.unexpected.length, 0),
    recall: expected === 0 ? 1 : caught / expected,
    cleanPassed: clean.filter((c) => !c.error && c.issues.every((i) => effectiveTag(i) !== 'Important')).length,
    cleanTotal: clean.length,
  };
}

export interface RunEvalsOptions {
  cases: EvalCase[];
  llm: Llm;
  verifyVotes?: number;
  verifyModel?: string;
  useTools?: boolean;
  /** Called after each case, for progress output. */
  onCase?: (score: CaseScore) => void;
}

/** Runs the real pipeline (find → ground → verify → tag) on every case and scores it. */
export async function runEvals(opts: RunEvalsOptions): Promise<EvalSummary> {
  const scores: CaseScore[] = [];
  for (const c of opts.cases) {
    let score: CaseScore;
    try {
      const changed = [...parseDiffFiles(c.diff).keys()];
      const systemPrompt = composePrompt({ leaves: leavesForChangedFiles(c.layers, changed), projectRules: c.rules });
      const result = await reviewDiff({
        diff: c.diff,
        systemPrompt,
        llm: opts.llm,
        getFile: async (path) => c.files.get(path),
        pr: { title: c.title, body: c.description },
        verifyVotes: opts.verifyVotes,
        verifyModel: opts.verifyModel,
        projectRules: c.rules,
        walkthrough: false,
        useTools: opts.useTools,
      });
      score = scoreCase(c, result.review.issues);
    } catch (err) {
      score = { ...scoreCase(c, []), error: (err as Error).message };
    }
    scores.push(score);
    opts.onCase?.(score);
  }
  return summarize(scores, opts.cases);
}
