import { describe, expect, it } from 'vitest';
import { annotateDiff, filterDiff, isLikelyGenerated } from '../src/diff.js';

const SAMPLE_DIFF = `diff --git a/src/foo.py b/src/foo.py
new file mode 100644
--- /dev/null
+++ b/src/foo.py
@@ -0,0 +1,4 @@
+def foo():
+    return 1
+
+x = foo()
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,2 +1,2 @@
-old
+new
`;

describe('annotateDiff', () => {
  it('prefixes right-side line numbers on new lines', () => {
    const out = annotateDiff(SAMPLE_DIFF);
    expect(out).toContain("## File: 'src/foo.py'");
    expect(out).toMatch(/\s+1 \+def foo\(\):/);
    expect(out).toMatch(/\s+2 \+    return 1/);
    expect(out).toMatch(/\s+4 \+x = foo\(\)/);
  });

  it('does not produce file headers for /dev/null', () => {
    const out = annotateDiff('--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n');
    expect(out).not.toContain('/dev/null');
  });

  it('puts a deleted file under its own header, not the previous file', () => {
    const diff = [
      'diff --git a/keep.ts b/keep.ts',
      '--- a/keep.ts',
      '+++ b/keep.ts',
      '@@ -1,1 +1,2 @@',
      ' export const a = 1;',
      '+export const b = 2;',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-export const secret = 1;',
      '',
    ].join('\n');
    const out = annotateDiff(diff);
    const keepIdx = out.indexOf("## File: 'keep.ts'");
    const goneIdx = out.indexOf("## File: 'gone.ts' (deleted)");
    const secretIdx = out.indexOf('-export const secret');
    expect(keepIdx).toBeGreaterThanOrEqual(0);
    expect(goneIdx).toBeGreaterThan(keepIdx);
    expect(secretIdx).toBeGreaterThan(goneIdx);
    expect(out).not.toContain('deleted file mode');
  });

  it('does not leak binary-file sections under the previous header', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/logo.png b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    expect(annotateDiff(diff)).not.toContain('Binary files');
  });

  it('keeps removed and added lines that look like file headers', () => {
    const diff = [
      'diff --git a/q.sql b/q.sql',
      '--- a/q.sql',
      '+++ b/q.sql',
      '@@ -1,2 +1,2 @@',
      '--- old comment',
      '+++ new comment',
      ' select 1;',
    ].join('\n');
    const out = annotateDiff(diff);
    expect(out).toContain('--- old comment');
    expect(out).toMatch(/1 \+\+\+ new comment/);
    expect(out).toMatch(/2  select 1;/);
  });
});

describe('filterDiff', () => {
  it('drops sections matching the excluder', () => {
    const filtered = filterDiff(SAMPLE_DIFF, isLikelyGenerated);
    expect(filtered).toContain('src/foo.py');
    expect(filtered).not.toContain('pnpm-lock.yaml');
  });
});

describe('isLikelyGenerated', () => {
  it.each([
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'poetry.lock',
    'Cargo.lock',
    'go.sum',
    'app/dist/main.js',
    'foo.min.js',
    '__snapshots__/x.snap',
  ])('flags %s as generated', (path) => {
    expect(isLikelyGenerated(path)).toBe(true);
  });

  it.each(['src/foo.py', 'package.json', 'README.md'])('does not flag %s', (path) => {
    expect(isLikelyGenerated(path)).toBe(false);
  });
});
