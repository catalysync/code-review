/**
 * Format a unified diff for the model with explicit right-side line numbers
 * prefixed onto every visible line. Matches the format described in
 * `_base/universal.md` so the model knows how to cite lines.
 *
 * Input: a standard `git diff` / GitHub PR diff (multi-file, unified format).
 * Output: a string with one block per file, headed by `## File: '...'`, hunks
 * annotated with `<lineno> <prefix> <content>`.
 */
export function annotateDiff(rawDiff: string): string {
  const lines = rawDiff.split('\n');
  const out: string[] = [];
  let currentFile: string | null = null;
  let rightLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      // diff --git a/path b/path → next +++ line gives the new path
      continue;
    }
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).replace(/^b\//, '').replace(/^"|"$/g, '');
      if (path === '/dev/null') continue;
      currentFile = path;
      out.push('');
      out.push(`## File: '${path}'`);
      out.push('');
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (m) rightLine = Number(m[1]);
      out.push(line);
      continue;
    }
    if (currentFile === null) continue;
    if (line.startsWith('+')) {
      out.push(`${pad(rightLine)} ${line}`);
      rightLine += 1;
    } else if (line.startsWith('-')) {
      out.push(`${pad(0)} ${line}`);
    } else if (line.startsWith(' ')) {
      out.push(`${pad(rightLine)} ${line}`);
      rightLine += 1;
    } else {
      out.push(line);
    }
  }
  return out.join('\n').trim();
}

function pad(n: number): string {
  return String(n || '').padStart(5, ' ');
}

/** Filter the diff down to a subset of paths (e.g. drop generated files). */
export function filterDiff(diff: string, isExcluded: (path: string) => boolean): string {
  const sections = splitByFile(diff);
  return sections.filter((s) => !isExcluded(s.path)).map((s) => s.body).join('\n');
}

interface FileSection {
  path: string;
  body: string;
}

function splitByFile(diff: string): FileSection[] {
  const sections: FileSection[] = [];
  const lines = diff.split('\n');
  let currentPath = '';
  let buffer: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (currentPath) sections.push({ path: currentPath, body: buffer.join('\n') });
      currentPath = '';
      buffer = [line];
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m) currentPath = m[2];
    } else {
      buffer.push(line);
    }
  }
  if (currentPath) sections.push({ path: currentPath, body: buffer.join('\n') });
  return sections;
}

const DEFAULT_EXCLUDES: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)uv\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /\.min\.(js|css)$/,
  /\.snap$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
];

export const isLikelyGenerated = (path: string): boolean =>
  DEFAULT_EXCLUDES.some((re) => re.test(path));
