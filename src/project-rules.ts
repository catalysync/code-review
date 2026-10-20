import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

export interface ProjectRules {
  /** Combined rules text appended to the prompt as Layer 3 (frontmatter stripped). */
  text?: string;
  /** Globs from the "Skip" section of REVIEW.md; matching files are dropped from the diff. */
  skip: string[];
  /** Files the rules were read from. */
  sources: string[];
}

/**
 * Read the repo's review rules. `REVIEW.md` at the repo root is the primary
 * file (Anthropic-style: short, says what failure looks like, caps nits,
 * lists paths to skip). `.review/project.md` is still read for backward
 * compatibility; when both exist, both are used. An explicit `override`
 * path replaces both.
 */
export function readProjectRules(repoRoot: string, override?: string): ProjectRules {
  const candidates = override ? [override] : [join(repoRoot, 'REVIEW.md'), join(repoRoot, '.review', 'project.md')];
  const texts: string[] = [];
  const sources: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const body = matter(readFileSync(path, 'utf8')).content.trim();
    if (!body) continue;
    texts.push(body);
    sources.push(path);
  }
  const text = texts.length ? texts.join('\n\n') : undefined;
  return { text, skip: text ? parseSkipGlobs(text) : [], sources };
}

/**
 * Pull globs out of a `## Skip` / `## Paths to skip` / `## Ignore` section:
 * every bullet's first token (backticks optional) is a glob.
 */
export function parseSkipGlobs(markdown: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inSection = /\b(skip|ignore)\b/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const bullet = /^\s*[-*]\s+`?([^`\s]+)`?/.exec(line);
    if (bullet) out.push(bullet[1]);
  }
  return out;
}

/** Minimal glob → RegExp: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A bare directory ("docs/") matches everything under it.
  if (glob.endsWith('/')) re += '.*';
  return new RegExp(`^${re}$`);
}

export function makeSkipMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (path) => res.some((r) => r.test(path));
}
