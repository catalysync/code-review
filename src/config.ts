/** Model used when neither `--model` nor `ANTHROPIC_MODEL` is set. */
export const FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Default output budget for the finder call. A structured review with a
 * handful of findings is ~1–3k tokens; 8k leaves room for large PRs, and a
 * truncated response is retried once with double the budget.
 */
export const DEFAULT_MAX_TOKENS = 8192;

/** Resolve the default model: `ANTHROPIC_MODEL` env var, else the fallback. */
export function defaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTHROPIC_MODEL?.trim() || FALLBACK_MODEL;
}
