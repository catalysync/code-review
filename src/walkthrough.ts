import { summarizeFiles, type FileSummaryInput, type LlmCall } from './file-summary.js';
import type { FileSummary, Walkthrough } from './types.js';

export interface BuildWalkthroughOptions {
  /** Optional PR-level overview from the model. Trimmed; empty allowed. */
  overview?: string;
  /** Per-file summaries from `summarizeFiles`. Order is preserved. */
  files: FileSummary[];
  /**
   * Optional mermaid block. Phase 1 always passes an empty string — the
   * cross-file reasoning that produces a real diagram lands in phase 4.
   */
  mermaid?: string;
}

/**
 * Assemble a `Walkthrough` from per-file summaries. The mermaid section is
 * reserved for phase 4; pass an empty string for now. This is a pure
 * data-shaping function — no I/O, no LLM — so it is trivially testable.
 */
export function buildWalkthrough(opts: BuildWalkthroughOptions): Walkthrough {
  const seen = new Set<string>();
  const files: FileSummary[] = [];
  for (const f of opts.files) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    files.push({ file: f.file, summary: f.summary.trim() });
  }
  return {
    overview: (opts.overview ?? '').trim(),
    files,
    mermaid: (opts.mermaid ?? '').trim(),
  };
}

export const DIAGRAM_SYSTEM_PROMPT = `You draw one small mermaid diagram for a pull-request walkthrough.

If the diff changes a flow across two or more components (a request handler and what it calls, a job and the models it touches, a CLI command and its steps), output a mermaid \`sequenceDiagram\` or \`flowchart\` of that flow with at most 12 nodes or messages, using names that appear in the diff.

If there is no such cross-component flow, output exactly: NONE

Output only the mermaid source (no code fence, no prose) or NONE.`;

const MERMAID_START = /^(sequenceDiagram|flowchart|graph|classDiagram|stateDiagram(?:-v2)?|erDiagram)\b/;

/** Keep a diagram only if it looks like real mermaid; anything else becomes ''. */
export function sanitizeMermaid(text: string): string {
  const unfenced = text
    .trim()
    .replace(/^```(?:mermaid)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  return MERMAID_START.test(unfenced) ? unfenced : '';
}

export interface GenerateWalkthroughOptions {
  /** Per-file annotated diffs (from `annotatePerFile`). */
  files: FileSummaryInput[];
  llm: LlmCall;
  overview?: string;
  /** Skip per-file summaries above this many files (cost guard). Default 25. */
  maxFiles?: number;
  /** Also ask for a mermaid diagram (one extra call). Default false. */
  diagram?: boolean;
  /** Full annotated diff, used for the diagram call. */
  annotatedDiff?: string;
}

/**
 * The optional CodeRabbit-style walkthrough: per-file summaries plus an
 * optional diagram. Every LLM call here is best-effort — a failed summary
 * becomes "(summary unavailable)" and a failed or malformed diagram is
 * dropped — so this step can never break the review itself.
 */
export async function generateWalkthrough(opts: GenerateWalkthroughOptions): Promise<Walkthrough> {
  const maxFiles = opts.maxFiles ?? 25;
  const files = opts.files.length <= maxFiles ? await summarizeFiles(opts.files, opts.llm) : [];
  let mermaid = '';
  if (opts.diagram && opts.annotatedDiff) {
    try {
      const res = await opts.llm({ systemPrompt: DIAGRAM_SYSTEM_PROMPT, userMessage: opts.annotatedDiff });
      mermaid = sanitizeMermaid(res.text);
    } catch {
      mermaid = '';
    }
  }
  return buildWalkthrough({ overview: opts.overview, files, mermaid });
}
