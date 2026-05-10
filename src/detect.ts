import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Map detected stack signals to leaf prompt IDs in the vendored library.
 * The result is the `leaves` field consumed by `composePrompt`.
 */
export interface DetectedStack {
  leaves: string[];
  notes: string[];
}

interface ProjectFile {
  path: string;
  contains?: string[];
}

const STACKS: { leaf: string; signals: ProjectFile[]; reason: string }[] = [
  {
    leaf: 'python/+fastapi',
    signals: [
      { path: 'pyproject.toml', contains: ['fastapi'] },
      { path: 'requirements.txt', contains: ['fastapi'] },
    ],
    reason: 'fastapi listed as a dependency',
  },
  {
    leaf: 'python/base',
    signals: [{ path: 'pyproject.toml' }, { path: 'requirements.txt' }, { path: 'setup.py' }],
    reason: 'python project markers',
  },
  {
    leaf: 'typescript/+nextjs',
    signals: [
      { path: 'next.config.js' },
      { path: 'next.config.mjs' },
      { path: 'next.config.ts' },
      { path: 'package.json', contains: ['"next"'] },
    ],
    reason: 'next.js detected',
  },
  {
    leaf: 'typescript/+react',
    signals: [{ path: 'package.json', contains: ['"react"'] }],
    reason: 'react detected',
  },
  {
    leaf: 'typescript/base',
    signals: [{ path: 'tsconfig.json' }],
    reason: 'tsconfig present',
  },
  {
    leaf: 'javascript/base',
    signals: [{ path: 'package.json' }],
    reason: 'package.json present (no tsconfig)',
  },
  {
    leaf: 'ruby/+rails',
    signals: [
      { path: 'Gemfile', contains: ['rails'] },
      { path: 'config/application.rb' },
    ],
    reason: 'rails detected',
  },
  {
    leaf: 'ruby/base',
    signals: [{ path: 'Gemfile' }, { path: 'Rakefile' }],
    reason: 'ruby project markers',
  },
  {
    leaf: 'go/base',
    signals: [{ path: 'go.mod' }],
    reason: 'go.mod present',
  },
  {
    leaf: 'rust/base',
    signals: [{ path: 'Cargo.toml' }],
    reason: 'Cargo.toml present',
  },
  {
    leaf: 'c/base',
    signals: [{ path: 'Makefile' }, { path: 'CMakeLists.txt' }, { path: 'meson.build' }],
    reason: 'C build markers (heuristic — confirm manually)',
  },
];

function matches(repoRoot: string, signal: ProjectFile): boolean {
  const full = join(repoRoot, signal.path);
  if (!existsSync(full)) return false;
  if (!signal.contains?.length) return true;
  let body: string;
  try {
    body = readFileSync(full, 'utf8');
  } catch {
    return false;
  }
  return signal.contains.every((needle) => body.includes(needle));
}

export function detectStack(repoRoot: string): DetectedStack {
  const leaves: string[] = [];
  const notes: string[] = [];
  // Resolve specificity: pick the most specific match per language family.
  const families = new Set<string>();
  for (const stack of STACKS) {
    if (stack.signals.some((s) => matches(repoRoot, s))) {
      const family = stack.leaf.split('/')[0];
      if (!families.has(family)) {
        leaves.push(stack.leaf);
        families.add(family);
        notes.push(`${stack.leaf}: ${stack.reason}`);
      }
    }
  }
  if (leaves.length === 0) {
    notes.push('no stack detected — pass --layer explicitly');
  }
  return { leaves, notes };
}
