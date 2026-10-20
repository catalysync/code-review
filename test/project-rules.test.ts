import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globToRegExp, makeSkipMatcher, parseSkipGlobs, readProjectRules } from '../src/project-rules.js';

const repo = () => mkdtempSync(join(tmpdir(), 'rules-'));

describe('readProjectRules', () => {
  it('reads REVIEW.md at the repo root', () => {
    const root = repo();
    writeFileSync(join(root, 'REVIEW.md'), '# Review\n\nFailure here means wrong money.\n\n## Skip\n\n- `db/schema.rb`\n- vendor/\n');
    const rules = readProjectRules(root);
    expect(rules.text).toContain('wrong money');
    expect(rules.skip).toEqual(['db/schema.rb', 'vendor/']);
  });

  it('still reads the legacy .review/project.md, without its frontmatter', () => {
    const root = repo();
    mkdirSync(join(root, '.review'));
    writeFileSync(join(root, '.review', 'project.md'), '---\nid: p\nextends: []\n---\nLEGACY_RULE');
    const rules = readProjectRules(root);
    expect(rules.text).toBe('LEGACY_RULE');
    expect(rules.text).not.toContain('extends');
  });

  it('combines both when both exist', () => {
    const root = repo();
    mkdirSync(join(root, '.review'));
    writeFileSync(join(root, 'REVIEW.md'), 'NEW_RULE');
    writeFileSync(join(root, '.review', 'project.md'), 'OLD_RULE');
    const rules = readProjectRules(root);
    expect(rules.text).toContain('NEW_RULE');
    expect(rules.text).toContain('OLD_RULE');
    expect(rules.sources).toHaveLength(2);
  });

  it('an explicit path replaces the defaults', () => {
    const root = repo();
    writeFileSync(join(root, 'REVIEW.md'), 'DEFAULT');
    writeFileSync(join(root, 'other.md'), 'OVERRIDE');
    expect(readProjectRules(root, join(root, 'other.md')).text).toBe('OVERRIDE');
  });

  it('returns nothing when there are no rules', () => {
    expect(readProjectRules(repo())).toEqual({ text: undefined, skip: [], sources: [] });
  });
});

describe('skip globs', () => {
  it('only reads bullets under a skip/ignore heading', () => {
    const md = '## Always flag\n\n- `console.log`\n\n## Paths to skip\n\n- `**/*.generated.ts` (codegen)\n* docs/\n\n## Other\n\n- x';
    expect(parseSkipGlobs(md)).toEqual(['**/*.generated.ts', 'docs/']);
  });

  it.each([
    ['db/schema.rb', 'db/schema.rb', true],
    ['db/schema.rb', 'db/schema.rbx', false],
    ['vendor/', 'vendor/a/b.rb', true],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/a.md', false],
    ['**/*.md', 'docs/a.md', true],
    ['**/*.md', 'a.md', true],
    ['app/**/legacy_*.rb', 'app/models/x/legacy_y.rb', true],
    ['config/?.yml', 'config/a.yml', true],
  ])('%s matches %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('builds a matcher from many globs', () => {
    const skip = makeSkipMatcher(['vendor/', '*.lock']);
    expect(skip('vendor/x.rb')).toBe(true);
    expect(skip('Gemfile.lock')).toBe(true);
    expect(skip('app/x.rb')).toBe(false);
  });
});
