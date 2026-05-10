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
