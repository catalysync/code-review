import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectStack } from '../src/detect.js';

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), 'repo-'));
}

describe('detectStack', () => {
  it('detects fastapi via pyproject.toml', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'pyproject.toml'), 'dependencies = ["fastapi", "sqlalchemy"]');
    const result = detectStack(root);
    expect(result.leaves).toContain('python/+fastapi');
  });

  it('detects nextjs via next.config.js', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'next.config.js'), 'module.exports = {};');
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    const result = detectStack(root);
    expect(result.leaves).toContain('typescript/+nextjs');
  });

  it('detects rails via Gemfile + config/application.rb', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'Gemfile'), 'gem "rails"');
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'application.rb'), 'class Application < Rails::Application');
    const result = detectStack(root);
    expect(result.leaves).toContain('ruby/+rails');
  });

  it('detects go via go.mod', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'go.mod'), 'module example');
    expect(detectStack(root).leaves).toContain('go/base');
  });

  it('detects rust via Cargo.toml', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'Cargo.toml'), '[package]');
    expect(detectStack(root).leaves).toContain('rust/base');
  });

  it('returns empty when no signals match', () => {
    const root = tmpRepo();
    const result = detectStack(root);
    expect(result.leaves).toEqual([]);
    expect(result.notes[0]).toMatch(/no stack detected/);
  });

  it('picks the most specific match per family', () => {
    const root = tmpRepo();
    writeFileSync(join(root, 'pyproject.toml'), 'dependencies = ["fastapi"]');
    const result = detectStack(root);
    // Should pick +fastapi, not also python/base
    expect(result.leaves.filter((l) => l.startsWith('python/'))).toEqual(['python/+fastapi']);
  });
});
