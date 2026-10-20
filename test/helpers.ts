import { vi } from 'vitest';
import type { Llm, LlmRequest, LlmToolRequest, LlmUsage } from '../src/llm.js';

export const usage = (): LlmUsage => ({
  inputTokens: 100,
  outputTokens: 10,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

export interface FakeLlmScript {
  /** submit_review input (or a function of the user message). */
  review?: unknown | ((req: LlmToolRequest) => unknown);
  /** submit_verdict input per verifier call. */
  verdict?: (req: LlmToolRequest, call: number) => unknown;
  /** Plain text answers (summaries, diagram). */
  text?: (req: LlmRequest) => string;
}

/** An `Llm` that never touches the network; dispatches on the tool name. */
export function fakeLlm(script: FakeLlmScript) {
  let verifyCalls = 0;
  const tool = vi.fn(async (req: LlmToolRequest) => {
    if (req.tool.name === 'submit_review') {
      const input = typeof script.review === 'function' ? (script.review as (r: LlmToolRequest) => unknown)(req) : script.review;
      return { input, text: '', usage: usage() };
    }
    if (req.tool.name === 'submit_verdict') {
      const input = script.verdict
        ? script.verdict(req, verifyCalls++)
        : { verdict: 'confirmed', evidence: 'x:1: x', reason: '' };
      return { input, text: '', usage: usage() };
    }
    throw new Error(`unexpected tool ${req.tool.name}`);
  });
  const text = vi.fn(async (req: LlmRequest) => ({ text: script.text ? script.text(req) : 'summary', usage: usage() }));
  const llm: Llm = { tool, text };
  return { llm, tool, text };
}
