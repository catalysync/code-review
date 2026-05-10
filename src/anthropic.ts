import Anthropic from '@anthropic-ai/sdk';

export interface AnthropicCallOptions {
  apiKey?: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userMessage: string;
  /** Toggle prompt caching on the system prompt. Default true. */
  cache?: boolean;
}

export interface AnthropicResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Call Anthropic with the system prompt marked for ephemeral caching.
 *
 * The system prompt is the static layered review rules (~5–15k tokens).
 * Marking it with `cache_control: { type: "ephemeral" }` tells the API to
 * cache it for ~5 minutes; subsequent calls hit the cache and pay ~10% of
 * the input-token cost for that segment. For repeat reviews on the same
 * repo this is the difference between a 0.5¢ review and a 5¢ one.
 */
export async function callAnthropic(opts: AnthropicCallOptions): Promise<AnthropicResult> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const cache = opts.cache ?? true;
  const system = cache
    ? [
        {
          type: 'text' as const,
          text: opts.systemPrompt,
          cache_control: { type: 'ephemeral' as const },
        },
      ]
    : opts.systemPrompt;

  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system,
    messages: [{ role: 'user', content: opts.userMessage }],
  });

  const textBlocks = response.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );
  const text = textBlocks.map((b) => b.text).join('\n');
  const usage = response.usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  return {
    text,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
  };
}
