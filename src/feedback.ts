import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PriorComment } from './github.js';

/**
 * Records what happened to each comment the reviewer posted, so noise can be
 * measured instead of guessed: which kinds of comment get fixed, which get
 * argued with, and which get ignored. Anthropic tracks the same thing to tune
 * its reviewer; here it feeds REVIEW.md.
 *
 * Outcomes, read from the thread and the code:
 *   fixed         the code under the comment changed (GitHub marks it outdated),
 *                 or the author replied that it's fixed
 *   disputed      a reply says the finding is wrong
 *   intentional   a reply says it's deliberate
 *   acknowledged  a reply agrees, but the line hasn't changed yet
 *   ignored       no reply and the line is unchanged
 */
export const OUTCOMES = ['fixed', 'disputed', 'intentional', 'acknowledged', 'ignored'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface FeedbackRecord {
  pr: number;
  repo: string;
  comment_id: number;
  path: string;
  tag: string;
  category: string;
  severity: string;
  title: string;
  outcome: Outcome;
  replies: number;
  recorded_at: string;
}

const BOT_MARKER = /<!-- cr:fp=[0-9a-f]+/;
const HEADER = /^\*\*(Important|Nit|Pre-existing)\*\* · `([a-z]+)\/([a-z]+)` —\s*(.*)$/m;

const DISPUTED = /\b(wrong|false positive|not (?:a|an) (?:bug|issue|problem)|incorrect|doesn'?t apply|does not apply|not true|invalid|already handled|already guarded)\b/i;
const INTENTIONAL = /\b(intentional(?:ly)?|by design|on purpose|deliberate(?:ly)?|won'?t fix|wontfix|expected behaviou?r)\b/i;
const FIXED = /\b(fixed|done|addressed|resolved|changed it|updated)\b/i;
const AGREED = /\b(good catch|nice catch|thanks|will fix|agreed|true)\b/i;

export function isBotComment(c: PriorComment): boolean {
  return !c.inReplyToId && BOT_MARKER.test(c.body);
}

export function classify(comment: PriorComment, replies: PriorComment[]): Outcome {
  const outdated = comment.line === null;
  const text = replies.map((r) => r.body).join('\n');
  if (DISPUTED.test(text)) return 'disputed';
  if (INTENTIONAL.test(text)) return 'intentional';
  if (outdated || FIXED.test(text)) return 'fixed';
  if (AGREED.test(text)) return 'acknowledged';
  return 'ignored';
}

export function collectFeedback(comments: PriorComment[], ctx: { pr: number; repo: string; now?: Date }): FeedbackRecord[] {
  const now = (ctx.now ?? new Date()).toISOString();
  return comments.filter(isBotComment).map((c) => {
    const replies = comments.filter((r) => r.inReplyToId === c.id);
    const header = c.body.match(HEADER);
    return {
      pr: ctx.pr,
      repo: ctx.repo,
      comment_id: c.id,
      path: c.path,
      tag: header?.[1] ?? 'unknown',
      category: header?.[2] ?? 'unknown',
      severity: header?.[3] ?? 'unknown',
      title: header?.[4]?.trim() ?? '',
      outcome: classify(c, replies),
      replies: replies.length,
      recorded_at: now,
    };
  });
}

export function readFeedback(path: string): FeedbackRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FeedbackRecord);
}

/** Adds the records, replacing older records of the same comment (outcomes change as a PR moves). */
export function writeFeedback(path: string, records: FeedbackRecord[]): FeedbackRecord[] {
  const key = (r: FeedbackRecord) => `${r.repo}#${r.comment_id}`;
  const fresh = new Set(records.map(key));
  const merged = [...readFeedback(path).filter((r) => !fresh.has(key(r))), ...records];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, merged.map((r) => JSON.stringify(r)).join('\n') + (merged.length ? '\n' : ''));
  return merged;
}

export interface FeedbackGroup {
  key: string;
  total: number;
  counts: Record<Outcome, number>;
}

/** Outcome counts per tag/category, noisiest first (most disputed + ignored). */
export function summarizeFeedback(records: FeedbackRecord[]): FeedbackGroup[] {
  const groups = new Map<string, FeedbackGroup>();
  for (const r of records) {
    const key = `${r.tag} ${r.category}`;
    const g = groups.get(key) ?? { key, total: 0, counts: Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number> };
    g.total += 1;
    g.counts[r.outcome] += 1;
    groups.set(key, g);
  }
  const noise = (g: FeedbackGroup) => (g.counts.disputed + g.counts.ignored) / g.total;
  return [...groups.values()].sort((a, b) => noise(b) - noise(a) || b.total - a.total);
}
