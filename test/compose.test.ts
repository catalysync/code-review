import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composePrompt, loadLibrary, resolveChain } from '../src/compose.js';

function tinyLib() {
  const root = mkdtempSync(join(tmpdir(), 'lib-'));
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'a/base.md'), `---\nid: a\nextends: []\n---\nA body. flag x. block-severity y. flag z. flag p. flag q.`);
  writeFileSync(join(root, 'b/base.md'), `---\nid: b\nextends: ["a/base"]\n---\nB body. flag b1. flag b2. flag b3. flag b4. flag b5.`);
  return root;
}

describe('library load + chain resolution', () => {
  it('loads markdown with frontmatter', () => {
    const root = tinyLib();
    const lib = loadLibrary(root);
    expect(lib.has('a/base')).toBe(true);
    expect(lib.has('b/base')).toBe(true);
    expect(lib.get('b/base')!.extends).toEqual(['a/base']);
  });

  it('resolves a parent-first chain', () => {
    const root = tinyLib();
    const lib = loadLibrary(root);
    const chain = resolveChain('b/base', lib);
    expect(chain.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('dedupes when multiple leaves share a parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-'));
    mkdirSync(join(root, 'shared'));
    mkdirSync(join(root, 'x'));
    mkdirSync(join(root, 'y'));
    writeFileSync(join(root, 'shared/base.md'), `---\nid: shared\nextends: []\n---\nShared body. flag s1. flag s2. flag s3. flag s4. flag s5.`);
    writeFileSync(join(root, 'x/+a.md'), `---\nid: x.a\nextends: ["shared/base"]\n---\nXA. flag xa1. flag xa2. flag xa3. flag xa4. flag xa5.`);
    writeFileSync(join(root, 'y/+b.md'), `---\nid: y.b\nextends: ["shared/base"]\n---\nYB. flag yb1. flag yb2. flag yb3. flag yb4. flag yb5.`);
    const lib = loadLibrary(root);
    const composed = composePrompt({ leaves: ['x/+a', 'y/+b'], library: lib });
    const sharedHits = composed.match(/Shared body/g)?.length ?? 0;
    expect(sharedHits).toBe(1);
    expect(composed).toContain('XA.');
    expect(composed).toContain('YB.');
  });

  it('throws on circular extends', () => {
    const root = mkdtempSync(join(tmpdir(), 'lib-'));
    mkdirSync(join(root, 'cycle'));
    writeFileSync(join(root, 'cycle/a.md'), `---\nid: a\nextends: ["cycle/b"]\n---\nA. flag a1. flag a2. flag a3. flag a4. flag a5.`);
    writeFileSync(join(root, 'cycle/b.md'), `---\nid: b\nextends: ["cycle/a"]\n---\nB. flag b1. flag b2. flag b3. flag b4. flag b5.`);
    const lib = loadLibrary(root);
    expect(() => resolveChain('cycle/a', lib)).toThrow(/circular/);
  });

  it('appends project rules as Layer 3', () => {
    const root = tinyLib();
    const lib = loadLibrary(root);
    const composed = composePrompt({
      leaves: ['b/base'],
      library: lib,
      projectRules: '## NOT bugs\n- We use HTTPBearer.',
    });
    expect(composed).toMatch(/Project rules \(Layer 3\)/);
    expect(composed).toContain('HTTPBearer');
  });

  it('default library loads vendored prompts', () => {
    const lib = loadLibrary();
    expect(lib.size).toBeGreaterThan(5);
    expect(lib.has('_base/universal')).toBe(true);
  });
});
