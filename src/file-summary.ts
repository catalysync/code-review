import type { FileSummary } from './types.js';

export interface FileSummaryInput {
  /** Repo-relative path of the file being summarized. */
  file: string;
  /** Annotated diff for just this file (output of `annotateDiff` on a single section). */
  annotatedDiff: string;
}

/**
 * Signature the review pipeline uses for LLM calls. We keep the surface tiny
 * so tests can stub it without pulling Anthropic's SDK.
 */
export type LlmCall = (args: {
  systemPrompt: string;
  userMessage: string;
}) => Promise<{ text: string }>;

/**
 * The prompt fed to the LLM for the file-summary step.
 *
 * Exposed so callers can extend it (e.g. with a project-specific style note)
 * and so tests can assert on its content.
 */
export const FILE_SUMMARY_SYSTEM_PROMPT = `You are summarizing a single file's worth of diff for a code-review walkthrough.

Output ONE paragraph (1-3 sentences) describing what changed in this file and why. State observable facts: the function added, the contract changed, the dependency removed. Do not lecture about style. Do not invent intent the diff does not support.

If the diff is generated, vendored, or trivial (e.g. version bumps), say so in one short sentence.

Output only the paragraph. No headers, no bullet list, no YAML.`;

export function buildFileSummaryUserMessage(input: FileSummaryInput): string {
  return `## File: '${input.file}'\n\n${input.annotatedDiff}`;
}

/**
 * Run the file-summary step against one file's annotated diff.
 *
 * Returns a `FileSummary` with the model's paragraph trimmed. Errors from the
 * LLM bubble up — the caller is responsible for deciding whether to skip
 * walkthrough rendering or fail the whole review.
 */
export async function summarizeFile(input: FileSummaryInput, llm: LlmCall): Promise<FileSummary> {
  const result = await llm({
    systemPrompt: FILE_SUMMARY_SYSTEM_PROMPT,
    userMessage: buildFileSummaryUserMessage(input),
  });
  return { file: input.file, summary: result.text.trim() };
}

/**
 * Run the file-summary step against every file in a batched diff.
 *
 * Each entry of `files` is the annotated diff for one file. Calls are issued
 * in parallel — the LLM call is the slow part and the calls are independent.
 */
export async function summarizeFiles(
  files: FileSummaryInput[],
  llm: LlmCall,
): Promise<FileSummary[]> {
  const settled = await Promise.allSettled(files.map((f) => summarizeFile(f, llm)));
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { file: files[i].file, summary: '(summary unavailable)' };
  });
}
