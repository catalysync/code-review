import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import type { PromptLayer } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default prompt root: the vendored library that ships inside this package.
 * Override at compose time to point at a fork or a local checkout.
 */
export const DEFAULT_PROMPT_ROOT = join(__dirname, '..', 'prompts-vendored');

function findMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findMd(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Load every prompt under `root` keyed by its repo-relative path (no `.md`). */
export function loadLibrary(root: string = DEFAULT_PROMPT_ROOT): Map<string, PromptLayer> {
  const all = new Map<string, PromptLayer>();
  for (const file of findMd(root)) {
    const raw = readFileSync(file, 'utf8');
    const parsed = matter(raw);
    const rel = file.slice(root.length + 1).replace(/\.md$/, '');
    const id = (parsed.data.id ?? rel) as string;
    const ext = (parsed.data.extends ?? []) as string[];
    all.set(rel, {
      id,
      description: parsed.data.description as string | undefined,
      extends: ext,
      body: parsed.content,
      source: file,
    });
  }
  return all;
}

/**
 * Resolve a leaf reference (e.g. "python/+fastapi") to its full chain in
 * parent-first order. Detects circular extends.
 */
export function resolveChain(leaf: string, library: Map<string, PromptLayer>): PromptLayer[] {
  const visiting = new Set<string>();
  const order: PromptLayer[] = [];
  const visited = new Set<string>();

  function walk(ref: string): void {
    if (visited.has(ref)) return;
    if (visiting.has(ref)) throw new Error(`circular extends touching ${ref}`);
    const layer = library.get(ref);
    if (!layer) throw new Error(`unknown prompt layer: ${ref}`);
    visiting.add(ref);
    for (const parent of layer.extends) walk(parent);
    visiting.delete(ref);
    visited.add(ref);
    order.push(layer);
  }

  walk(leaf);
  return order;
}

/**
 * Compose multiple leaf references into a single prompt body.
 * Project rules (Layer 3) are appended last and win on conflicts.
 */
export function composePrompt(opts: {
  leaves: string[];
  library?: Map<string, PromptLayer>;
  projectRules?: string;
}): string {
  const library = opts.library ?? loadLibrary();
  const seen = new Set<string>();
  const ordered: PromptLayer[] = [];
  for (const leaf of opts.leaves) {
    for (const layer of resolveChain(leaf, library)) {
      if (seen.has(layer.id)) continue;
      seen.add(layer.id);
      ordered.push(layer);
    }
  }
  const parts = ordered.map((l) => l.body.trim());
  if (opts.projectRules?.trim()) {
    parts.push(`\n# Project rules (Layer 3)\n\n${opts.projectRules.trim()}`);
  }
  return parts.join('\n\n---\n\n');
}
