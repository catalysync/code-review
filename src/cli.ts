#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import kleur from 'kleur';
import { composePrompt } from './compose.js';
import { DEFAULT_MAX_TOKENS, FALLBACK_MODEL, defaultModel } from './config.js';
import { detectStack } from './detect.js';
import { formatReview, isOutputFormat, type OutputFormat } from './formatter.js';
import { runReview } from './review.js';
import { readProjectRules } from './project-rules.js';
import { renderHeadline } from './render.js';
import { effectiveTag, evaluateSeverityGate } from './severity.js';
import { createAnthropicLlm } from './anthropic.js';
import { loadCases, runEvals, type CaseScore } from './evals.js';
import { collectFeedback, summarizeFeedback, writeFeedback } from './feedback.js';
import { createGitHubApi, makeOctokit } from './github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  version: string;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as PackageJson;
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const program = new Command();
program.name('code-review').description('Layered LLM code review.').version(readVersion());

export interface InitResult {
  written: string[];
  skipped: string[];
}

/** Scaffold REVIEW.md, the Claude Code reviewer agent and the GitHub workflow. Never overwrites. */
export function scaffold(root: string, leaves: string[], templatesDir = join(__dirname, '..', 'templates')): InitResult {
  const result: InitResult = { written: [], skipped: [] };
  const write = (dest: string, content: () => string) => {
    if (existsSync(dest)) {
      result.skipped.push(dest);
      return;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content());
    result.written.push(dest);
  };
  const legacy = join(root, '.review', 'project.md');
  if (existsSync(legacy)) {
    // Keep using the legacy file; don't add a second, competing rules file.
    result.skipped.push(legacy);
  } else {
    write(join(root, 'REVIEW.md'), () =>
      readFileSync(join(templatesDir, 'REVIEW.md'), 'utf8').replace('{{LAYERS}}', leaves.join(', ') || 'none'),
    );
  }
  write(join(root, '.claude', 'agents', 'reviewer.md'), () =>
    readFileSync(join(templatesDir, '.claude', 'agents', 'reviewer.md'), 'utf8'),
  );
  write(join(root, '.github', 'workflows', 'code-review.yml'), () =>
    readFileSync(join(templatesDir, '.github', 'workflows', 'code-review.yml'), 'utf8'),
  );
  return result;
}

program
  .command('init')
  .description('Detect stack and scaffold REVIEW.md + .claude/agents/reviewer.md + .github/workflows/code-review.yml.')
  .option('-d, --dir <path>', 'repo root', process.cwd())
  .action((opts) => {
    const root = resolve(opts.dir);
    const detected = detectStack(root);
    console.log(kleur.bold('Detected layers:'));
    for (const note of detected.notes) console.log(`  ${kleur.dim('•')} ${note}`);
    if (detected.leaves.length === 0) {
      console.log(kleur.yellow('No stack detected; reviews will use the universal layer plus per-file language layers.'));
    }
    const result = scaffold(root, detected.leaves);
    for (const f of result.written) console.log(kleur.green('✓') + ` wrote ${f}`);
    for (const f of result.skipped) console.log(kleur.dim(`• ${f} already exists, leaving alone`));

    console.log();
    console.log(kleur.bold('Next steps:'));
    console.log(`  1. Edit ${kleur.cyan('REVIEW.md')}: what failure looks like here, what not to flag, paths to skip.`);
    console.log(`  2. Set ${kleur.cyan('ANTHROPIC_API_KEY')} (and ${kleur.cyan('GITHUB_TOKEN')} for posting).`);
    console.log(`  3. Run: ${kleur.cyan('code-review pr <number> --owner X --repo Y --dry-run')}`);
  });

program
  .command('compose')
  .description('Print the composed prompt for the current repo (or for explicit layers).')
  .option('-d, --dir <path>', 'repo root', process.cwd())
  .option('-l, --layer <name...>', 'override detected layers (e.g. python/+fastapi)')
  .option('-p, --project <path>', 'project rules file (default: REVIEW.md and/or .review/project.md)', undefined)
  .action((opts) => {
    const root = resolve(opts.dir);
    const layers = opts.layer?.length ? opts.layer : detectStack(root).leaves;
    if (layers.length === 0) {
      console.error(kleur.red('no layers detected'));
      process.exit(1);
    }
    const rules = readProjectRules(root, opts.project);
    process.stdout.write(composePrompt({ leaves: layers, projectRules: rules.text }));
  });

const toInt = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got ${v}`);
  return n;
};

program
  .command('pr <number>')
  .description('Review a GitHub pull request: find → verify → post → converge.')
  .requiredOption('--owner <owner>', 'GitHub owner')
  .requiredOption('--repo <repo>', 'GitHub repo name')
  .option('-d, --dir <path>', 'repo root for layer detection and REVIEW.md', process.cwd())
  .option('-l, --layer <name...>', 'override detected layers')
  .option('-p, --project <path>', 'project rules file (default: REVIEW.md and/or .review/project.md)')
  .option('--model <id>', `model id (default: $ANTHROPIC_MODEL, else ${FALLBACK_MODEL})`)
  .option('--base-url <url>', 'Anthropic-compatible API base URL (default: $ANTHROPIC_BASE_URL)')
  .option('--max-tokens <n>', 'max output tokens for the finder (retried once at 2x on truncation)', toInt, DEFAULT_MAX_TOKENS)
  .option('--verify-votes <n>', 'verifier calls per finding; majority wins; 0 disables verification', toInt, 1)
  .option('--verify-model <id>', 'model for the verifier (default: same as --model)')
  .option('--max-nits <n>', 'max Nit findings per review', toInt, 3)
  .option('--max-pre-existing <n>', 'max Pre-existing findings per review', toInt, 3)
  .option('--max-rounds <n>', 'after N review rounds, post a step-back note instead; 0 = no cap', toInt, 3)
  .option('--since <sha>', 'review only changes since this commit')
  .option('--no-incremental', 'always review the full PR diff, even after the first round')
  .option('--no-walkthrough', 'skip the per-file walkthrough summaries')
  .option('--diagram', 'add a mermaid diagram to the walkthrough (one extra call)')
  .option('--no-tools', 'ask for YAML text instead of a submit_review tool call (for providers without tool use)')
  .option('--dry-run', "don't post the review, just print it")
  .option('--format <fmt>', 'output format for --dry-run: markdown | json', 'markdown')
  .option('--no-fail-on-blockers', 'do not exit non-zero on verified Important blocker/security findings')
  .action(async (numberArg: string, opts) => {
    const number = Number(numberArg);
    if (!Number.isFinite(number)) {
      console.error(kleur.red('PR number must be a number'));
      process.exit(2);
    }
    const format = (opts.format ?? 'markdown') as string;
    if (!isOutputFormat(format)) {
      console.error(kleur.red(`unknown --format: ${format} (expected markdown | json)`));
      process.exit(2);
    }
    try {
      const result = await runReview({
        repoRoot: resolve(opts.dir),
        owner: opts.owner,
        repo: opts.repo,
        prNumber: number,
        layers: opts.layer,
        projectRulesPath: opts.project,
        model: opts.model ?? defaultModel(),
        baseUrl: opts.baseUrl,
        maxTokens: opts.maxTokens,
        dryRun: opts.dryRun,
        verifyVotes: opts.verifyVotes,
        verifyModel: opts.verifyModel,
        maxNits: opts.maxNits,
        maxPreExisting: opts.maxPreExisting,
        maxRounds: opts.maxRounds,
        since: opts.since,
        incremental: opts.incremental,
        walkthrough: opts.walkthrough,
        diagram: opts.diagram,
        useTools: opts.tools,
      });
      printReportSummary(result);
      if (result.posted) {
        console.log();
        console.log(kleur.green('✓ posted: ') + result.posted.htmlUrl);
      } else if (opts.dryRun) {
        console.log();
        console.log(kleur.dim('--dry-run: not posted'));
        console.log(result.capped ? result.body : formatReview(result.review, format as OutputFormat));
      }

      // Severity gate is the last thing — we always want the report printed
      // even when we're about to exit non-zero, so CI logs are useful.
      const gate = evaluateSeverityGate(result.review);
      if (opts.failOnBlockers !== false && gate.blocked) {
        console.error();
        console.error(
          kleur.red(
            `severity gate: ${gate.triggering.length} verified Important blocker/security finding(s) — exiting 1`,
          ),
        );
        process.exit(1);
      }
    } catch (err) {
      const e = err as Error;
      console.error(kleur.red('error: ') + e.message);
      process.exit(1);
    }
  });

const toFraction = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`expected a number from 0 to 1, got ${v}`);
  return n;
};

program
  .command('eval')
  .description('Score the reviewer against cases with known bugs and known false alarms (evals/cases).')
  .option('--cases <dir>', 'folder of eval cases', 'evals/cases')
  .option('--only <name...>', 'run only these cases')
  .option('--model <id>', `model id (default: $ANTHROPIC_MODEL, else ${FALLBACK_MODEL})`)
  .option('--base-url <url>', 'Anthropic-compatible API base URL (default: $ANTHROPIC_BASE_URL)')
  .option('--max-tokens <n>', 'max output tokens for the finder', toInt, DEFAULT_MAX_TOKENS)
  .option('--verify-votes <n>', 'verifier calls per finding; 0 disables verification', toInt, 1)
  .option('--verify-model <id>', 'model for the verifier (default: same as --model)')
  .option('--no-tools', 'ask for YAML text instead of tool calls')
  .option('--min-recall <x>', 'exit 1 when fewer than this share of known bugs are found (0-1)', toFraction, 0)
  .option('--max-false-alarms <n>', 'exit 1 when more known false alarms are raised', toInt)
  .option('--json', 'print the full result as JSON')
  .action(async (opts) => {
    try {
      let cases = loadCases(resolve(opts.cases));
      if (opts.only?.length) cases = cases.filter((c) => opts.only.includes(c.name));
      const llm = createAnthropicLlm({ baseURL: opts.baseUrl, model: opts.model ?? defaultModel(), maxTokens: opts.maxTokens });
      const summary = await runEvals({
        cases,
        llm,
        verifyVotes: opts.verifyVotes,
        verifyModel: opts.verifyModel,
        useTools: opts.tools,
        onCase: opts.json ? undefined : printCaseScore,
      });
      if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log();
        console.log(
          kleur.bold(
            `bugs found ${summary.caught}/${summary.expected} (${Math.round(summary.recall * 100)}%) · ` +
              `known false alarms raised ${summary.falseAlarms} · other Important findings ${summary.unexpected} · ` +
              `clean PRs clean ${summary.cleanPassed}/${summary.cleanTotal}`,
          ),
        );
      }
      const failed =
        summary.recall < opts.minRecall ||
        (opts.maxFalseAlarms !== undefined && summary.falseAlarms > opts.maxFalseAlarms) ||
        summary.cases.some((c) => c.error);
      process.exit(failed ? 1 : 0);
    } catch (err) {
      console.error(kleur.red('error: ') + (err as Error).message);
      process.exit(1);
    }
  });

function printCaseScore(score: CaseScore): void {
  const ok = !score.error && score.missed.length === 0 && score.falseAlarms.length === 0;
  console.log(`${ok ? kleur.green('✓') : kleur.red('✗')} ${kleur.bold(score.name)} — ${score.title}`);
  if (score.error) console.log(`    ${kleur.red('error:')} ${score.error}`);
  if (score.caught.length) console.log(`    found: ${score.caught.join(', ')}`);
  if (score.missed.length) console.log(`    ${kleur.red('missed:')} ${score.missed.join(', ')}`);
  if (score.falseAlarms.length) console.log(`    ${kleur.red('false alarms:')} ${score.falseAlarms.join(', ')}`);
  for (const i of score.unexpected) console.log(`    ${kleur.yellow('other:')} ${i.file}:${i.line_start} ${i.title || i.why}`);
}

program
  .command('feedback <number>')
  .description('Record what happened to the review comments on a PR (fixed, disputed, intentional, ignored).')
  .requiredOption('--owner <owner>', 'GitHub owner')
  .requiredOption('--repo <repo>', 'GitHub repo name')
  .option('-d, --dir <path>', 'repo root', process.cwd())
  .option('--out <path>', 'feedback log, relative to --dir', '.review/feedback.jsonl')
  .action(async (numberArg: string, opts) => {
    try {
      const number = Number(numberArg);
      const gh = createGitHubApi(makeOctokit(), opts.owner, opts.repo, number);
      const records = collectFeedback(await gh.listReviewComments(), { pr: number, repo: `${opts.owner}/${opts.repo}` });
      const path = resolve(opts.dir, opts.out);
      const all = writeFeedback(path, records);
      console.log(kleur.bold(`PR #${number}: ${records.length} review comment(s) recorded in ${path}`));
      for (const r of records) console.log(`  ${r.outcome.padEnd(12)} ${r.tag} ${r.category}/${r.severity} ${kleur.cyan(r.path)} ${r.title}`);
      console.log();
      console.log(kleur.bold(`All recorded comments (${all.length}), noisiest first:`));
      for (const g of summarizeFeedback(all)) {
        const parts = Object.entries(g.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
        console.log(`  ${g.key.padEnd(28)} ${g.total} total: ${parts.join(', ')}`);
      }
    } catch (err) {
      console.error(kleur.red('error: ') + (err as Error).message);
      process.exit(1);
    }
  });

function printReportSummary(
result: Awaited<ReturnType<typeof runReview>>): void {
  for (const w of result.warnings) console.log(kleur.yellow('warning: ') + w);
  if (result.capped) {
    console.log(kleur.bold(`round cap reached (${result.round - 1} rounds) — step-back note instead of a review`));
    return;
  }
  const r = result.review;
  console.log(kleur.bold(renderHeadline(r).replace(/\*\*/g, '').replace(/\s*See inline comments\.$/, '')));
  for (const issue of r.issues) {
    const sev = severityColor(issue.severity)(issue.severity);
    const tag = effectiveTag(issue);
    const repeat = issue.already_posted ? kleur.dim(' (already posted)') : '';
    console.log(`  ${tag.padEnd(12)} ${sev} ${kleur.cyan(`${issue.file}:${issue.line_start}`)} — ${issue.title || issue.why}${repeat}`);
  }
  const s = result.stats;
  console.log();
  console.log(
    kleur.dim(
      `round ${result.round}${result.since ? ` (changes since ${result.since.slice(0, 7)})` : ''} · ` +
        `${s.candidates} candidate(s): ${s.ungrounded} ungrounded, ${s.rejected} rejected, ${s.style} style-only, ` +
        `${s.capped} over cap, ${s.duplicates} already posted, ${s.unverified} unverified`,
    ),
  );
  console.log(
    kleur.dim(
      `tokens: ${result.tokensIn} in (cache: ${result.cacheReadTokens} read / ${result.cacheCreationTokens} created), ${result.tokensOut} out`,
    ),
  );
}

function severityColor(s: string) {
  if (s === 'security') return kleur.red().bold;
  if (s === 'blocker') return kleur.red().bold;
  if (s === 'warning') return kleur.yellow;
  if (s === 'suggestion') return kleur.cyan;
  return kleur.gray;
}

program.parseAsync(process.argv);
