import type { LlmToolResult, ToolSpec } from './llm.js';
import { coerceReview, parseReview } from './parse.js';
import { CATEGORIES, SEVERITIES, TAGS, type Review } from './types.js';

const lineRange = {
  file: { type: 'string', description: 'Repo-relative path exactly as in the `## File:` header.' },
  line_start: { type: 'integer', minimum: 1, description: 'Right-side (new file) line number.' },
  line_end: { type: 'integer', minimum: 1, description: 'Right-side line number; equal to line_start for one line.' },
};

/**
 * The finder's only output channel. Forcing this tool (`tool_choice`) gives a
 * JSON object that is then validated with the zod `ReviewSchema`, instead of
 * scraping YAML out of free text.
 */
export const SUBMIT_REVIEW_TOOL: ToolSpec = {
  name: 'submit_review',
  description:
    'Submit the code review. Call exactly once. An empty `issues` array is a valid, common answer.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Start with the number of issues ("2 issues: ..." or "No issues found."), then 1-3 sentences.',
      },
      estimated_review_effort_1_to_5: { type: 'integer', minimum: 1, maximum: 5 },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ...lineRange,
            category: { type: 'string', enum: [...CATEGORIES] },
            severity: { type: 'string', enum: [...SEVERITIES] },
            tag: {
              type: 'string',
              enum: [...TAGS],
              description: 'Important = real problem in changed code; Nit = minor; Pre-existing = problem in code this PR did not change.',
            },
            title: { type: 'string', description: '5-10 words.' },
            why: { type: 'string', description: 'The trigger scenario or violated invariant, and its impact.' },
            evidence: {
              type: 'string',
              description: 'file:line plus the exact quoted code that proves the issue. No evidence, no finding.',
            },
            suggestion: {
              type: 'string',
              description: 'Optional exact replacement for line_start..line_end, or a short prose fix.',
            },
            locations: {
              type: 'array',
              description: 'Other places with the same class of bug. Report the class once, list every instance here.',
              items: { type: 'object', properties: lineRange, required: ['file', 'line_start'] },
            },
          },
          required: ['file', 'line_start', 'line_end', 'category', 'severity', 'tag', 'title', 'why', 'evidence'],
        },
      },
      security_concerns: { type: 'string', description: '"No" or "<category>: <one sentence>".' },
      test_coverage_assessment: { type: 'string' },
    },
    required: ['summary', 'issues'],
  },
};

/**
 * Turn the finder's response into a `Review`. Prefers the tool call; falls
 * back to the legacy YAML parser only when the provider returned text
 * instead of a tool call.
 */
export function reviewFromToolResult(result: LlmToolResult): Review {
  if (result.input !== undefined && result.input !== null) return coerceReview(result.input);
  if (result.text.trim()) {
    try {
      return parseReview(result.text);
    } catch (err) {
      throw new Error(
        `model returned no submit_review tool call and its text was not a parseable review: ${(err as Error).message}`,
      );
    }
  }
  throw new Error('model returned neither a submit_review tool call nor any text');
}
