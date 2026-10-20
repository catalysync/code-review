import { describe, expect, it } from 'vitest';
import {
  extractFingerprints,
  fingerprintIssue,
  fingerprintMarker,
  isAlreadyPosted,
  normalizeTitle,
  parseReviewMarker,
  reviewMarker,
} from '../src/fingerprint.js';
import type { Issue } from '../src/types.js';

const issue = (over: Partial<Issue> = {}): Issue => ({
  file: 'app/models/contract.rb',
  line_start: 10,
  line_end: 12,
  category: 'bug',
  severity: 'blocker',
  title: 'Unpaid total includes historical settlements',
  why: 'w',
  ...over,
});

const code = ['  def sum_royalties_not_paid', '    royalty_calculations.where(paid: false).sum(:amount)', '  end'];

describe('fingerprints', () => {
  it('is stable across line shifts when the cited code is the same', () => {
    const a = fingerprintIssue(issue(), code);
    const b = fingerprintIssue(issue({ line_start: 30, line_end: 32 }), code);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.loc_fingerprint).toBe(b.loc_fingerprint);
  });

  it('ignores whitespace and title punctuation/case differences', () => {
    const a = fingerprintIssue(issue({ title: 'Unpaid total includes `historical` settlements!' }), code);
    const b = fingerprintIssue(issue(), code.map((l) => `${l}   `));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(normalizeTitle('Foo `bar`, BAZ!')).toBe('foo bar baz');
  });

  it('loc key survives a reworded title; fp key does not', () => {
    const a = fingerprintIssue(issue(), code);
    const b = fingerprintIssue(issue({ title: 'sum_royalties_not_paid counts read-only rows' }), code);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.loc_fingerprint).toBe(b.loc_fingerprint);
    expect(isAlreadyPosted(b, extractFingerprints(fingerprintMarker(a)))).toBe(true);
  });

  it('differs for different code or category', () => {
    const a = fingerprintIssue(issue(), code);
    expect(fingerprintIssue(issue(), ['other']).fingerprint).not.toBe(a.fingerprint);
    expect(fingerprintIssue(issue({ category: 'security' }), code).fingerprint).not.toBe(a.fingerprint);
  });

  it('has no loc key when the code is unknown', () => {
    const a = fingerprintIssue(issue(), []);
    expect(a.fingerprint).toBeTruthy();
    expect(a.loc_fingerprint).toBeUndefined();
    expect(fingerprintMarker(a)).toBe(`<!-- cr:fp=${a.fingerprint} -->`);
  });

  it('extracts every key from a block of comments', () => {
    const keys = extractFingerprints('x <!-- cr:fp=abc123 loc=def456 --> y <!-- cr:fp=0011 -->');
    expect([...keys].sort()).toEqual(['0011', 'abc123', 'def456']);
  });

  it('round-trips the review marker', () => {
    expect(parseReviewMarker(`body\n${reviewMarker({ sha: 'abc123', round: 2 })}`)).toEqual({ sha: 'abc123', round: 2 });
    expect(parseReviewMarker('a human review')).toBeUndefined();
  });
});
