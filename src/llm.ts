/**
 * Provider-neutral LLM surface used by every review step. The pipeline only
 * ever talks to this interface, so tests inject a fake and never hit a real
 * model.
 */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface LlmRequest {
  system: string;
  user: string;
  /** Per-call override of the client's default output budget. */
  maxTokens?: number;
  /** Per-call override of the client's default model. */
  model?: string;
}

export interface LlmToolRequest extends LlmRequest {
  tool: ToolSpec;
}

export interface LlmTextResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmToolResult {
  /** Tool input object when the model called the tool, else undefined. */
  input: unknown;
  /** Any text the model emitted (used as a fallback when no tool call came back). */
  text: string;
  usage: LlmUsage;
}

export interface Llm {
  text(req: LlmRequest): Promise<LlmTextResult>;
  /** Force a call to `req.tool` and return its input. */
  tool(req: LlmToolRequest): Promise<LlmToolResult>;
}

/** Thrown when the model's output was cut off by `max_tokens` even after a retry. */
export class ReviewTruncatedError extends Error {
  constructor(public readonly maxTokens: number) {
    super(
      `review truncated: the model hit max_tokens (${maxTokens}) even after a retry with a larger budget. ` +
        'Raise --max-tokens, or split the PR.',
    );
    this.name = 'ReviewTruncatedError';
  }
}

export const emptyUsage = (): LlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

/** Accumulates usage across the several calls one review makes. */
export class UsageMeter {
  readonly total: LlmUsage = emptyUsage();
  add(u: LlmUsage): void {
    this.total.inputTokens += u.inputTokens;
    this.total.outputTokens += u.outputTokens;
    this.total.cacheReadInputTokens += u.cacheReadInputTokens;
    this.total.cacheCreationInputTokens += u.cacheCreationInputTokens;
  }
}
