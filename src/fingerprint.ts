import { createHash } from 'node:crypto';
import type { Issue } from './types.js';

/**
 * Finding fingerprints let re-runs skip findings that were already posted on
 * the PR. Two keys are stored per finding:
 *
 *   fp  = hash(file, category, normalized title, hash of the cited code)
 *   loc = hash(file, category, hash of the cited code)
 *
 * Hashing the cited *code* (not line numbers) keeps the key stable when
 * unrelated edits shift lines. `loc` also survives the model rewording its
 * title between runs, which it often does. A finding is a duplicate when
 * either key was posted before.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim();
}

export function hashCode(lines: string[]): string {
  const norm = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return norm.length ? sha(norm.join('\n')) : '';
}

/**
 * Attach `fingerprint` / `loc_fingerprint` to an issue. `codeLines` is the
 * content of `line_start..line_end` on the head side (empty if unknown).
 */
export function fingerprintIssue(issue: Issue, codeLines: string[]): Issue {
  const code = hashCode(codeLines);
  const fingerprint = sha([issue.file, issue.category, normalizeTitle(issue.title || issue.why), code].join('\n'));
  const loc_fingerprint = code ? sha([issue.file, issue.category, code].join('\n')) : undefined;
  return { ...issue, fingerprint, ...(loc_fingerprint ? { loc_fingerprint } : {}) };
}

export function fingerprintMarker(issue: Issue): string {
  if (!issue.fingerprint) return '';
  return `<!-- cr:fp=${issue.fingerprint}${issue.loc_fingerprint ? ` loc=${issue.loc_fingerprint}` : ''} -->`;
}

/** Every fp/loc key embedded in a block of text (a comment or review body). */
export function extractFingerprints(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/<!-- cr:fp=([0-9a-f]+)(?: loc=([0-9a-f]+))? -->/g)) {
    out.add(m[1]);
    if (m[2]) out.add(m[2]);
  }
  return out;
}

export function isAlreadyPosted(issue: Issue, posted: ReadonlySet<string>): boolean {
  return (
    (!!issue.fingerprint && posted.has(issue.fingerprint)) ||
    (!!issue.loc_fingerprint && posted.has(issue.loc_fingerprint))
  );
}

/** Marker on every review body this tool posts: records the reviewed commit and round. */
export function reviewMarker(opts: { sha: string; round: number }): string {
  return `<!-- cr:review sha=${opts.sha} round=${opts.round} -->`;
}

export function parseReviewMarker(body: string | null | undefined): { sha: string; round: number } | undefined {
  const m = /<!-- cr:review sha=([0-9a-f]+) round=(\d+) -->/.exec(body ?? '');
  return m ? { sha: m[1], round: Number(m[2]) } : undefined;
}

export const STEPBACK_MARKER = '<!-- cr:stepback -->';
