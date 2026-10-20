import { describe, expect, it, vi } from 'vitest';
import { createAnthropicLlm, type AnthropicLike, type AnthropicMessageLike } from '../src/anthropic.js';
import { defaultModel, FALLBACK_MODEL } from '../src/config.js';
import { ReviewTruncatedError } from '../src/llm.js';

const usage = { input_tokens: 10, output_tokens: 5 };

function fakeClient(responses: AnthropicMessageLike[]) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more canned responses');
    return next;
  });
  return { client: { messages: { create } } as unknown as AnthropicLike, create };
}

const text = (t: string, stop = 'end_turn'): AnthropicMessageLike => ({
  content: [{ type: 'text', text: t }],
  stop_reason: stop,
  usage,
});

describe('createAnthropicLlm', () => {
  it('returns text and usage, with a cached system prompt', async () => {
    const { client, create } = fakeClient([text('hello')]);
    const llm = createAnthropicLlm({ model: 'm', maxTokens: 100, client });
    const out = await llm.text({ system: 'sys', user: 'u' });
    expect(out.text).toBe('hello');
    expect(out.usage.inputTokens).toBe(10);
    const params = create.mock.calls[0][0 as never] as Record<string, unknown>;
    expect(params.max_tokens).toBe(100);
    expect(params.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  });

  it('retries once with double the budget when stop_reason is max_tokens', async () => {
    const { client, create } = fakeClient([text('half a rev', 'max_tokens'), text('full review')]);
    const llm = createAnthropicLlm({ model: 'm', maxTokens: 100, client });
    const out = await llm.text({ system: 's', user: 'u' });
    expect(out.text).toBe('full review');
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1][0 as never] as { max_tokens: number }).max_tokens).toBe(200);
  });

  it('throws ReviewTruncatedError (not a parse error) when the retry is also truncated', async () => {
    const { client } = fakeClient([text('a', 'max_tokens'), text('b', 'max_tokens')]);
    const llm = createAnthropicLlm({ model: 'm', maxTokens: 100, client });
    const err = await llm.text({ system: 's', user: 'u' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewTruncatedError);
    expect(err.message).toMatch(/review truncated/);
    expect(err.message).toMatch(/200/);
  });

  it('forces the tool and returns its input', async () => {
    const { client, create } = fakeClient([
      {
        content: [{ type: 'tool_use', name: 'submit_review', input: { summary: 'No issues found.', issues: [] } }],
        stop_reason: 'tool_use',
        usage,
      },
    ]);
    const llm = createAnthropicLlm({ model: 'm', maxTokens: 100, client });
    const out = await llm.tool({
      system: 's',
      user: 'u',
      tool: { name: 'submit_review', description: 'd', input_schema: { type: 'object' } },
    });
    expect(out.input).toEqual({ summary: 'No issues found.', issues: [] });
    const params = create.mock.calls[0][0 as never] as Record<string, unknown>;
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'submit_review' });
  });

  it('returns undefined input when the provider answers with text only', async () => {
    const { client } = fakeClient([text('review:\n  issues: []')]);
    const llm = createAnthropicLlm({ model: 'm', maxTokens: 100, client });
    const out = await llm.tool({
      system: 's',
      user: 'u',
      tool: { name: 'submit_review', description: 'd', input_schema: { type: 'object' } },
    });
    expect(out.input).toBeUndefined();
    expect(out.text).toContain('review:');
  });
});

describe('defaultModel', () => {
  it('prefers ANTHROPIC_MODEL', () => {
    expect(defaultModel({ ANTHROPIC_MODEL: 'glm-4.7' })).toBe('glm-4.7');
  });
  it('falls back to the built-in default', () => {
    expect(defaultModel({})).toBe(FALLBACK_MODEL);
    expect(defaultModel({ ANTHROPIC_MODEL: '  ' })).toBe(FALLBACK_MODEL);
  });
});
