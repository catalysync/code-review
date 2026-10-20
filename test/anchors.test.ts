import { describe, expect, it } from 'vitest';
import { isRangeCommentable, parseDiffFiles, rangeTouchesAddedLines } from '../src/diff.js';
import { partitionIssues, renderReview } from '../src/render.js';
import type { Issue, Review } from '../src/types.js';

const DIFF = [
  'diff --git a/app/a.rb b/app/a.rb',
  '--- a/app/a.rb',
  '+++ b/app/a.rb',
  '@@ -10,4 +10,5 @@ class A',
  ' line10',
  ' line11',
  '+added12',
  ' line13',
  ' line14',
  '@@ -40,2 +41,3 @@ class A',
  ' line41',
  '+added42',
  ' line43',
  'diff --git a/app/gone.rb b/app/gone.rb',
  'deleted file mode 100644',
  '--- a/app/gone.rb',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-x',
  '-y',
].join('\n');

const issue = (over: Partial<Issue>): Issue => ({
  file: 'app/a.rb',
  line_start: 12,
  line_end: 12,
  category: 'bug',
  severity: 'warning',
  title: 't',
  why: 'why',
  ...over,
});

const review = (issues: Issue[]): Review => ({
  summary: '',
  estimated_review_effort_1_to_5: 2,
  issues,
  security_concerns: 'No',
  test_coverage_assessment: '',
  walkthrough: { overview: '', files: [], mermaid: '' },
});

describe('parseDiffFiles', () => {
  it('records right-side hunk ranges, added lines and content', () => {
    const files = parseDiffFiles(DIFF);
    const a = files.get('app/a.rb')!;
    expect(a.hunks).toEqual([
      { start: 10, end: 14 },
      { start: 41, end: 43 },
    ]);
    expect([...a.added]).toEqual([12, 42]);
    expect(a.lines.get(12)).toBe('added12');
    expect(a.lines.get(13)).toBe('line13');
  });

  it('marks deleted files and gives them no right-side hunks', () => {
    const gone = parseDiffFiles(DIFF).get('app/gone.rb')!;
    expect(gone.deleted).toBe(true);
    expect(gone.hunks).toEqual([]);
  });
});

describe('isRangeCommentable', () => {
  const files = parseDiffFiles(DIFF);
  it.each([
    ['app/a.rb', 12, 12, true],
    ['app/a.rb', 10, 14, true],
    ['app/a.rb', 41, 43, true],
    ['app/a.rb', 9, 12, false], // starts before the hunk
    ['app/a.rb', 14, 41, false], // spans two hunks
    ['app/a.rb', 20, 20, false], // between hunks
    ['app/gone.rb', 1, 1, false], // deleted file
    ['app/other.rb', 1, 1, false], // not in diff
    ['app/a.rb', 0, 0, false],
  ] as const)('%s:%i-%i → %s', (file, s, e, expected) => {
    expect(isRangeCommentable(files, file, s, e)).toBe(expected);
  });

  it('detects whether a range touches added lines', () => {
    expect(rangeTouchesAddedLines(files, 'app/a.rb', 10, 11)).toBe(false);
    expect(rangeTouchesAddedLines(files, 'app/a.rb', 11, 13)).toBe(true);
  });
});

describe('out-of-diff findings', () => {
  it('partitions issues by whether GitHub can anchor them', () => {
    const files = parseDiffFiles(DIFF);
    const { inline, outside } = partitionIssues(
      [issue({}), issue({ line_start: 20, line_end: 20 }), issue({ file: 'app/gone.rb', line_start: 1, line_end: 1 })],
      files,
    );
    expect(inline).toHaveLength(1);
    expect(outside.map((i) => `${i.file}:${i.line_start}`)).toEqual(['app/a.rb:20', 'app/gone.rb:1']);
  });

  it('never sends an un-anchorable comment; lists it in the body instead', () => {
    const payload = renderReview(
      review([issue({}), issue({ line_start: 2, line_end: 30, why: 'spans outside the hunk' })]),
      { commitId: 'abc', diffFiles: parseDiffFiles(DIFF) },
    );
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].line).toBe(12);
    expect(payload.body).toContain('### Findings outside the diff');
    expect(payload.body).toContain('`app/a.rb:2-30`');
    expect(payload.body).toContain('spans outside the hunk');
  });
});
