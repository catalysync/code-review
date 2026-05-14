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
