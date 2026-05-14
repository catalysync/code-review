import { z } from 'zod';

/**
 * Severity vocabulary, CodeRabbit-style.
 *
 *   nitpick     — style / preference / "while you're here".
 *   suggestion  — non-blocking improvement.
 *   warning     — likely-bug or maintainability hazard. Does not block merge by default.
 *   blocker     — must fix before merge. Causes non-zero CLI exit.
 *   security    — security issue. Causes non-zero CLI exit and is highlighted in CI.
 */
export const SEVERITIES = ['nitpick', 'suggestion', 'warning', 'blocker', 'security'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ['bug', 'security', 'performance', 'maintainability', 'convention'] as const;
export type Category = (typeof CATEGORIES)[number];

export const IssueSchema = z.object({
  file: z.string().min(1),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  title: z.string().default(''),
  why: z.string().default(''),
  suggestion: z.string().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const FileSummarySchema = z.object({
  file: z.string().min(1),
  /** One paragraph: what changed and why. */
  summary: z.string().default(''),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const WalkthroughSchema = z.object({
  /** One-paragraph PR-level overview. */
  overview: z.string().default(''),
  /** Per-file paragraphs aggregated under the walkthrough block. */
  files: z.array(FileSummarySchema).default([]),
  /** Reserved for phase 4. Empty mermaid string for now. */
  mermaid: z.string().default(''),
});
export type Walkthrough = z.infer<typeof WalkthroughSchema>;

export const ReviewSchema = z.object({
  summary: z.string().default(''),
  estimated_review_effort_1_to_5: z.number().int().min(1).max(5).default(3),
  issues: z.array(IssueSchema).default([]),
  security_concerns: z.string().default('No'),
  test_coverage_assessment: z.string().default(''),
  walkthrough: WalkthroughSchema.default({ overview: '', files: [], mermaid: '' }),
});
export type Review = z.infer<typeof ReviewSchema>;

export interface PromptLayer {
  id: string;
  description?: string;
  extends: string[];
  body: string;
  source: string;
}

export interface ReviewConfig {
  /** Resolved leaf prompt IDs to load, e.g. ["python/+fastapi"]. */
  layers: string[];
  /** Optional path to a project-level overlay (Layer 3) markdown file. */
  projectRulesPath?: string;
  /** Anthropic model id. */
  model: string;
  /** Max tokens to allow in the model's response. */
  maxTokens: number;
}
