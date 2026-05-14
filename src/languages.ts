import { composePrompt, loadLibrary } from './compose.js';
import type { PromptLayer } from './types.js';

/**
 * Languages phase 1 ships with. Adding a language is a 3-line PR: extend
 * `LANGUAGE_EXTENSIONS`, ensure the prompt file exists in the prompts repo,
 * extend the leaf map in `LANGUAGE_LEAVES`.
 */
export const LANGUAGES = ['typescript', 'javascript', 'python', 'markdown', 'unknown'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * File extension → language. Keep this lowercase. The dispatch matches on the
 * trailing `.ext` of the path; double-extensions like `.d.ts` resolve to the
 * last segment.
 */
const LANGUAGE_EXTENSIONS: Record<string, Language> = {
  ts: 'typescript',
  tsx: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  py: 'python',
  pyi: 'python',
  md: 'markdown',
  mdx: 'markdown',
};

/**
 * Language → leaf prompt id under the configured prompt root. Markdown has no
 * dedicated leaf in phase 1 — it gets the universal layer only, since md
 * issues are typically style/typo, which the universal `_base` already covers.
 */
const LANGUAGE_LEAVES: Record<Language, string | null> = {
  typescript: 'typescript/base',
  javascript: 'javascript/base',
  python: 'python/base',
  markdown: null,
  unknown: null,
};

/**
 * Detect the language of a file from its path. Returns `'unknown'` when the
 * extension is not in the table — callers fall back to the universal prompt.
 */
export function detectLanguage(path: string): Language {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0 || dot === lower.length - 1) return 'unknown';
  const ext = lower.slice(dot + 1);
  return LANGUAGE_EXTENSIONS[ext] ?? 'unknown';
}

/**
 * Group files by their detected language. Preserves input order within each
 * group so the LLM sees deterministic file ordering.
 */
export function groupFilesByLanguage<T extends { file: string }>(files: T[]): Map<Language, T[]> {
  const out = new Map<Language, T[]>();
  for (const f of files) {
    const lang = detectLanguage(f.file);
    const bucket = out.get(lang) ?? [];
    bucket.push(f);
    out.set(lang, bucket);
  }
  return out;
}

export interface PromptForLanguageOptions {
  language: Language;
  /** Override the prompt library (e.g. for tests or a sibling-repo prompt root). */
  library?: Map<string, PromptLayer>;
  /** Layer 3 project overlay. Appended last per `composePrompt`. */
  projectRules?: string;
}

/**
 * Compose the system prompt for a single language. Returns the universal
 * prompt alone when the language has no dedicated leaf (markdown, unknown).
 */
export function promptForLanguage(opts: PromptForLanguageOptions): string {
  const library = opts.library ?? loadLibrary();
  const leaf = LANGUAGE_LEAVES[opts.language];
  const leaves = leaf ? [leaf] : ['_base/universal'];
  return composePrompt({ leaves, library, projectRules: opts.projectRules });
}

/**
 * Map of every language → the leaf id used to compose its prompt. Exposed so
 * the CLI's `compose` command can list available targets.
 */
export function languageLeaves(): Readonly<Record<Language, string | null>> {
  return LANGUAGE_LEAVES;
}
