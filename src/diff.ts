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
  let oldPath: string | null = null;
  let rightLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      // New file section: forget the previous file so its header never
      // swallows metadata or hunks that belong to this one.
      currentFile = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith('--- ') && currentFile === null) {
      oldPath = stripDiffPath(line.slice(4), 'a/');
      continue;
    }
    if (line.startsWith('+++ ') && currentFile === null) {
      const path = stripDiffPath(line.slice(4), 'b/');
      if (path === '/dev/null') {
        if (!oldPath || oldPath === '/dev/null') continue;
        currentFile = oldPath;
        out.push('', `## File: '${oldPath}' (deleted)`, '');
        continue;
      }
      currentFile = path;
      out.push('', `## File: '${path}'`, '');
      continue;
    }
    if (line.startsWith('@@')) {
      if (currentFile === null) continue;
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

function stripDiffPath(raw: string, prefix: 'a/' | 'b/'): string {
  const unquoted = raw.trim().replace(/^"|"$/g, '');
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

export interface HunkRange {
  /** First right-side line in the hunk (inclusive). */
  start: number;
  /** Last right-side line in the hunk (inclusive). */
  end: number;
}

export interface FileDiffInfo {
  path: string;
  deleted: boolean;
  /** Right-side line ranges GitHub accepts review comments on. */
  hunks: HunkRange[];
  /** Right-side lines added by this diff (`+` lines). */
  added: Set<number>;
  /** Right-side line → content (added and context lines). */
  lines: Map<number, string>;
}

/**
 * Parse a unified diff into per-file right-side line information. This is the
 * ground truth for which lines a GitHub review comment can anchor to: a
 * comment (or multi-line range) must sit entirely inside one hunk on the
 * RIGHT side, otherwise `pulls.createReview` rejects the whole review.
 */
export function parseDiffFiles(rawDiff: string): Map<string, FileDiffInfo> {
  const files = new Map<string, FileDiffInfo>();
  let current: FileDiffInfo | null = null;
  let oldPath: string | null = null;
  let hunk: HunkRange | null = null;
  let rightLine = 0;

  const closeHunk = () => {
    if (current && hunk && hunk.end >= hunk.start) current.hunks.push(hunk);
    hunk = null;
  };

  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      closeHunk();
      current = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith('--- ') && current === null) {
      oldPath = stripDiffPath(line.slice(4), 'a/');
      continue;
    }
    if (line.startsWith('+++ ') && current === null) {
      const path = stripDiffPath(line.slice(4), 'b/');
      const deleted = path === '/dev/null';
      const key = deleted ? oldPath : path;
      if (!key || key === '/dev/null') continue;
      current = { path: key, deleted, hunks: [], added: new Set(), lines: new Map() };
      files.set(key, current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('@@')) {
      closeHunk();
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      rightLine = m ? Number(m[1]) : 0;
      hunk = { start: rightLine, end: rightLine - 1 };
      continue;
    }
    if (!hunk) continue;
    const h: HunkRange = hunk;
    if (line.startsWith('+')) {
      current.added.add(rightLine);
      current.lines.set(rightLine, line.slice(1));
      h.end = rightLine;
      rightLine += 1;
    } else if (line.startsWith(' ')) {
      current.lines.set(rightLine, line.slice(1));
      h.end = rightLine;
      rightLine += 1;
    }
  }
  closeHunk();
  return files;
}

/** True when `start..end` sits entirely inside one right-side hunk of `file`. */
export function isRangeCommentable(
  files: Map<string, FileDiffInfo>,
  file: string,
  start: number,
  end: number,
): boolean {
  const info = files.get(file);
  if (!info || info.deleted) return false;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  if (lo < 1) return false;
  return info.hunks.some((h) => lo >= h.start && hi <= h.end);
}

/** True when any line in `start..end` was added by the diff. */
export function rangeTouchesAddedLines(
  files: Map<string, FileDiffInfo>,
  file: string,
  start: number,
  end: number,
): boolean {
  const info = files.get(file);
  if (!info) return false;
  for (let n = Math.min(start, end); n <= Math.max(start, end); n++) {
    if (info.added.has(n)) return true;
  }
  return false;
}

/** Filter the diff down to a subset of paths (e.g. drop generated files). */
export function filterDiff(diff: string, isExcluded: (path: string) => boolean): string {
  const sections = splitByFile(diff);
  return sections.filter((s) => !isExcluded(s.path)).map((s) => s.body).join('\n');
}

export interface FileSection {
  path: string;
  body: string;
}

/**
 * Split a unified diff into per-file sections. Exposed so callers (e.g. the
 * file-summary step) can feed one file at a time to the LLM.
 */
export function splitByFile(diff: string): FileSection[] {
  return splitByFileInternal(diff);
}

function splitByFileInternal(diff: string): FileSection[] {
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

/**
 * Convenience: split a diff into per-file annotated sections. Each section's
 * `body` is the output of `annotateDiff` on that single file. Empty/dev-null
 * sections are dropped.
 */
export function annotatePerFile(diff: string): FileSection[] {
  return splitByFile(diff)
    .filter((s) => s.path && !s.body.includes('+++ /dev/null'))
    .map((s) => ({ path: s.path, body: annotateDiff(s.body) }));
}
