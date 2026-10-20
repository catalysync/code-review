import { describe, expect, it, vi } from 'vitest';
import {
  buildFileSummaryUserMessage,
  FILE_SUMMARY_SYSTEM_PROMPT,
  summarizeFile,
  summarizeFiles,
  type LlmCall,
} from '../src/file-summary.js';
import { buildWalkthrough } from '../src/walkthrough.js';

const fakeLlm = (responseFor: Record<string, string>): LlmCall =>
  vi.fn(async ({ userMessage }: { systemPrompt: string; userMessage: string }) => {
    for (const [needle, response] of Object.entries(responseFor)) {
      if (userMessage.includes(needle)) return { text: response };
    }
    return { text: '(no canned response)' };
  });

describe('file-summary step', () => {
  it('produces a FileSummary for one file using the canned LLM response', async () => {
    const llm = fakeLlm({ 'src/auth.py': 'Adds login handler with bcrypt.' });
    const summary = await summarizeFile(
      { file: 'src/auth.py', annotatedDiff: '+def login(): ...' },
      llm,
    );
    expect(summary).toEqual({ file: 'src/auth.py', summary: 'Adds login handler with bcrypt.' });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('passes the canonical system prompt to the LLM', async () => {
    const spy = vi.fn(async () => ({ text: 'ok' }));
    await summarizeFile({ file: 'a.ts', annotatedDiff: '+x' }, spy);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: FILE_SUMMARY_SYSTEM_PROMPT }),
    );
  });

  it('embeds the file path in the user message', () => {
    const msg = buildFileSummaryUserMessage({
      file: 'src/x.ts',
      annotatedDiff: '+const x = 1;',
    });
    expect(msg).toContain("## File: 'src/x.ts'");
    expect(msg).toContain('+const x = 1;');
  });

  it('summarizes multiple files in parallel', async () => {
    const llm = fakeLlm({
      'a.ts': 'A changed.',
      'b.py': 'B added.',
    });
    const out = await summarizeFiles(
      [
        { file: 'a.ts', annotatedDiff: '+a' },
        { file: 'b.py', annotatedDiff: '+b' },
      ],
      llm,
    );
    expect(out).toEqual([
      { file: 'a.ts', summary: 'A changed.' },
      { file: 'b.py', summary: 'B added.' },
    ]);
  });

  it('falls back to "(summary unavailable)" when the LLM rejects', async () => {
    const llm: LlmCall = vi.fn(async ({ userMessage }) => {
      if (userMessage.includes('a.ts')) throw new Error('rate limited');
      return { text: 'B ok.' };
    });
    const out = await summarizeFiles(
      [
        { file: 'a.ts', annotatedDiff: '+a' },
        { file: 'b.py', annotatedDiff: '+b' },
      ],
      llm,
    );
    expect(out[0]).toEqual({ file: 'a.ts', summary: '(summary unavailable)' });
    expect(out[1]).toEqual({ file: 'b.py', summary: 'B ok.' });
  });

  it('does not make any real network calls in tests', async () => {
    // Guard: this is the only LLM-exposed surface in phase 1. The contract is
    // "callers inject the LLM". Confirm that the canned-fake path returns
    // synchronously deterministic content.
    const llm = fakeLlm({ x: 'deterministic' });
    const out = await summarizeFile({ file: 'x.ts', annotatedDiff: 'x' }, llm);
    expect(out.summary).toBe('deterministic');
  });
});

describe('buildWalkthrough', () => {
  it('shapes a Walkthrough from per-file summaries', () => {
    const w = buildWalkthrough({
      overview: 'Big change.',
      files: [
        { file: 'a.ts', summary: 'A.' },
        { file: 'b.ts', summary: 'B.' },
      ],
    });
    expect(w.overview).toBe('Big change.');
    expect(w.files).toHaveLength(2);
    expect(w.mermaid).toBe('');
  });

  it('dedupes by file path', () => {
    const w = buildWalkthrough({
      files: [
        { file: 'a.ts', summary: 'first' },
        { file: 'a.ts', summary: 'second' },
      ],
    });
    expect(w.files).toHaveLength(1);
    expect(w.files[0].summary).toBe('first');
  });

  it('passes a mermaid block through when provided (phase 4 hook)', () => {
    const w = buildWalkthrough({ files: [], mermaid: 'sequenceDiagram\n  A->>B: hi' });
    expect(w.mermaid).toContain('sequenceDiagram');
  });
});

describe('generateWalkthrough', () => {
  it('summarizes files and keeps a valid mermaid diagram', async () => {
    const { generateWalkthrough } = await import('../src/walkthrough.js');
    const llm: LlmCall = vi.fn(async ({ systemPrompt }) => ({
      text: systemPrompt.includes('mermaid') ? '```mermaid\nsequenceDiagram\n  A->>B: call\n```' : 'Changed.',
    }));
    const w = await generateWalkthrough({
      files: [{ file: 'a.rb', annotatedDiff: '+x' }],
      llm,
      diagram: true,
      annotatedDiff: '+x',
    });
    expect(w.files).toEqual([{ file: 'a.rb', summary: 'Changed.' }]);
    expect(w.mermaid).toBe('sequenceDiagram\n  A->>B: call');
  });

  it('never throws: failed summaries and diagrams degrade to placeholders', async () => {
    const { generateWalkthrough } = await import('../src/walkthrough.js');
    const llm: LlmCall = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const w = await generateWalkthrough({ files: [{ file: 'a.rb', annotatedDiff: '+x' }], llm, diagram: true, annotatedDiff: '+x' });
    expect(w.files).toEqual([{ file: 'a.rb', summary: '(summary unavailable)' }]);
    expect(w.mermaid).toBe('');
  });

  it('skips per-file summaries above maxFiles and drops non-mermaid diagram output', async () => {
    const { generateWalkthrough, sanitizeMermaid } = await import('../src/walkthrough.js');
    const llm: LlmCall = vi.fn(async () => ({ text: 'NONE' }));
    const w = await generateWalkthrough({
      files: [
        { file: 'a', annotatedDiff: '' },
        { file: 'b', annotatedDiff: '' },
      ],
      llm,
      maxFiles: 1,
    });
    expect(w.files).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
    expect(sanitizeMermaid('NONE')).toBe('');
    expect(sanitizeMermaid('flowchart LR\n a-->b')).toBe('flowchart LR\n a-->b');
  });
});
