import Anthropic from '@anthropic-ai/sdk';
import { ReviewTruncatedError, type Llm, type LlmRequest, type LlmToolRequest, type LlmUsage, type ToolSpec } from './llm.js';

/** The slice of the Anthropic SDK client we use. Lets tests pass a fake. */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<AnthropicMessageLike>;
  };
}

export interface AnthropicMessageLike {
  content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface AnthropicLlmOptions {
  /** Falls back to `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) via the SDK. */
  apiKey?: string;
  /**
   * Anthropic-compatible endpoint. Falls back to `ANTHROPIC_BASE_URL` via the
   * SDK. DeepSeek: https://api.deepseek.com/anthropic, Z.ai GLM:
   * https://api.z.ai/api/anthropic.
   */
  baseURL?: string;
  model: string;
  maxTokens: number;
  /**
   * Budget for the single retry after a `max_tokens` stop. Defaults to twice
   * `maxTokens`.
   */
  retryMaxTokens?: number;
  /** Mark the system prompt for prompt caching. Default true (ignored by providers that don't support it). */
  cache?: boolean;
  /** Injected client, for tests. */
  client?: AnthropicLike;
}

/**
 * Build an `Llm` backed by the Anthropic Messages API (or any endpoint that
 * speaks it).
 *
 * The system prompt is marked `cache_control: ephemeral`: it's the static
 * layered rules, identical across reviews of the same repo, so repeat calls
 * pay ~10% of its input cost.
 *
 * Truncation is handled explicitly: a response that stops on `max_tokens` is
 * retried once with a larger budget, and if it is still cut off the call
 * fails with `ReviewTruncatedError` instead of handing half a review to the
 * parser.
 */
export function createAnthropicLlm(opts: AnthropicLlmOptions): Llm {
  const client: AnthropicLike =
    opts.client ??
    (new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    }) as unknown as AnthropicLike);
  const cache = opts.cache ?? true;

  const system = (text: string) =>
    cache ? [{ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } }] : text;

  async function create(
    req: LlmRequest,
    extra: Partial<Anthropic.MessageCreateParamsNonStreaming>,
  ): Promise<AnthropicMessageLike> {
    const budget = req.maxTokens ?? opts.maxTokens;
    const params = (maxTokens: number): Anthropic.MessageCreateParamsNonStreaming => ({
      model: req.model ?? opts.model,
      max_tokens: maxTokens,
      system: system(req.system),
      messages: [{ role: 'user', content: req.user }],
      ...extra,
    });
    const first = await client.messages.create(params(budget));
    if (first.stop_reason !== 'max_tokens') return first;
    const retryBudget = req.maxTokens ? req.maxTokens * 2 : (opts.retryMaxTokens ?? opts.maxTokens * 2);
    const second = await client.messages.create(params(retryBudget));
    if (second.stop_reason === 'max_tokens') throw new ReviewTruncatedError(retryBudget);
    return second;
  }

  return {
    async text(req) {
      const msg = await create(req, {});
      return { text: textOf(msg), usage: usageOf(msg) };
    },
    async tool(req: LlmToolRequest) {
      const msg = await create(req, {
        tools: [toAnthropicTool(req.tool)],
        tool_choice: { type: 'tool', name: req.tool.name },
      });
      const call = msg.content.find((b) => b.type === 'tool_use' && b.name === req.tool.name);
      return { input: call?.input, text: textOf(msg), usage: usageOf(msg) };
    },
  };
}

function toAnthropicTool(tool: ToolSpec): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  };
}

function textOf(msg: AnthropicMessageLike): string {
  return msg.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function usageOf(msg: AnthropicMessageLike): LlmUsage {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadInputTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: msg.usage.cache_creation_input_tokens ?? 0,
  };
}
