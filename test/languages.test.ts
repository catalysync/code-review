import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLibrary } from '../src/compose.js';
import {
  detectLanguage,
  groupFilesByLanguage,
  languageLeaves,
  promptForLanguage,
  type Language,
} from '../src/languages.js';

describe('detectLanguage', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/b.tsx', 'typescript'],
    ['src/c.mts', 'typescript'],
    ['src/d.cts', 'typescript'],
    ['src/e.js', 'javascript'],
    ['src/f.jsx', 'javascript'],
    ['src/g.mjs', 'javascript'],
    ['src/h.cjs', 'javascript'],
    ['app/main.py', 'python'],
    ['stubs/types.pyi', 'python'],
    ['README.md', 'markdown'],
    ['docs/page.mdx', 'markdown'],
  ] as const)('%s → %s', (path, expected: Language) => {
    expect(detectLanguage(path)).toBe(expected);
  });

  it.each([
    'Makefile',
    'CHANGELOG',
    'src/binary.bin',
    'foo.unknown',
    'no-extension',
    'trailing.dot.',
  ])('treats %s as unknown', (path) => {
    expect(detectLanguage(path)).toBe('unknown');
  });

  it('handles uppercase extensions', () => {
    expect(detectLanguage('src/A.TS')).toBe('typescript');
    expect(detectLanguage('README.MD')).toBe('markdown');
  });
});

describe('groupFilesByLanguage', () => {
  it('buckets files and preserves order within a bucket', () => {
    const groups = groupFilesByLanguage([
      { file: 'a.ts' },
      { file: 'b.py' },
      { file: 'c.ts' },
      { file: 'd.md' },
      { file: 'unknown' },
    ]);
    expect(groups.get('typescript')?.map((f) => f.file)).toEqual(['a.ts', 'c.ts']);
    expect(groups.get('python')?.map((f) => f.file)).toEqual(['b.py']);
    expect(groups.get('markdown')?.map((f) => f.file)).toEqual(['d.md']);
    expect(groups.get('unknown')?.map((f) => f.file)).toEqual(['unknown']);
  });
});

function tinyLibrary() {
  const root = mkdtempSync(join(tmpdir(), 'lang-lib-'));
  mkdirSync(join(root, '_base'));
  mkdirSync(join(root, 'typescript'));
  mkdirSync(join(root, 'python'));
  mkdirSync(join(root, 'javascript'));
  writeFileSync(
    join(root, '_base/universal.md'),
    `---\nid: universal\nextends: []\n---\nUNIVERSAL_BODY flag1 flag2 flag3 flag4 flag5`,
  );
  writeFileSync(
    join(root, 'typescript/base.md'),
    `---\nid: typescript\nextends: ["_base/universal"]\n---\nTYPESCRIPT_BODY flag1 flag2 flag3 flag4 flag5`,
  );
  writeFileSync(
    join(root, 'python/base.md'),
    `---\nid: python\nextends: ["_base/universal"]\n---\nPYTHON_BODY flag1 flag2 flag3 flag4 flag5`,
  );
  writeFileSync(
    join(root, 'javascript/base.md'),
    `---\nid: javascript\nextends: ["_base/universal"]\n---\nJAVASCRIPT_BODY flag1 flag2 flag3 flag4 flag5`,
  );
  return loadLibrary(root);
}

describe('promptForLanguage', () => {
  it('composes the universal + ts base for typescript', () => {
    const library = tinyLibrary();
    const out = promptForLanguage({ language: 'typescript', library });
    expect(out).toContain('UNIVERSAL_BODY');
    expect(out).toContain('TYPESCRIPT_BODY');
    expect(out).not.toContain('PYTHON_BODY');
  });

  it('composes the universal + py base for python', () => {
    const library = tinyLibrary();
    const out = promptForLanguage({ language: 'python', library });
    expect(out).toContain('UNIVERSAL_BODY');
    expect(out).toContain('PYTHON_BODY');
    expect(out).not.toContain('TYPESCRIPT_BODY');
  });

  it('composes the universal + js base for javascript', () => {
    const library = tinyLibrary();
    const out = promptForLanguage({ language: 'javascript', library });
    expect(out).toContain('UNIVERSAL_BODY');
    expect(out).toContain('JAVASCRIPT_BODY');
  });

  it('falls back to the universal prompt for markdown', () => {
    const library = tinyLibrary();
    const out = promptForLanguage({ language: 'markdown', library });
    expect(out).toContain('UNIVERSAL_BODY');
    expect(out).not.toContain('TYPESCRIPT_BODY');
    expect(out).not.toContain('PYTHON_BODY');
  });

  it('falls back to the universal prompt for unknown', () => {
    const library = tinyLibrary();
    const out = promptForLanguage({ language: 'unknown', library });
    expect(out).toContain('UNIVERSAL_BODY');
  });

  it('appends layer 3 project rules when provided', () => {
    const library = tinyLibrary();
    const out = promptForLanguage({
      language: 'typescript',
      library,
      projectRules: 'NEVER suggest renaming `db`.',
    });
    expect(out).toContain('Project rules (Layer 3)');
    expect(out).toContain('NEVER suggest renaming');
  });

  it('exposes the leaf table for inspection', () => {
    const leaves = languageLeaves();
    expect(leaves.typescript).toBe('typescript/base');
    expect(leaves.python).toBe('python/base');
    expect(leaves.javascript).toBe('javascript/base');
    expect(leaves.markdown).toBeNull();
    expect(leaves.unknown).toBeNull();
  });
});

describe('leavesForChangedFiles', () => {
  it('adds a language base the repo-level detector missed', async () => {
    const { leavesForChangedFiles } = await import('../src/languages.js');
    expect(leavesForChangedFiles(['ruby/+rails'], ['app/models/a.rb', 'scripts/build.ts'])).toEqual([
      'ruby/+rails',
      'typescript/base',
    ]);
  });

  it('does not add a family that is already covered', async () => {
    const { leavesForChangedFiles } = await import('../src/languages.js');
    expect(leavesForChangedFiles(['typescript/+react'], ['a.tsx', 'b.js'])).toEqual(['typescript/+react']);
  });

  it('falls back to the universal layer when nothing matches', async () => {
    const { leavesForChangedFiles } = await import('../src/languages.js');
    expect(leavesForChangedFiles([], ['README.md', 'Makefile'])).toEqual(['_base/universal']);
    expect(leavesForChangedFiles([], ['main.go'])).toEqual(['go/base']);
  });
});
