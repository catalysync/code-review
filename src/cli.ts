#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import kleur from 'kleur';
import { composePrompt } from './compose.js';
import { detectStack } from './detect.js';
import { formatReview, isOutputFormat, type OutputFormat } from './formatter.js';
import { runReview } from './review.js';
import { evaluateSeverityGate } from './severity.js';

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

program
  .command('init')
  .description('Detect stack and scaffold .review/ + .claude/agents/reviewer.md.')
  .option('-d, --dir <path>', 'repo root', process.cwd())
  .action((opts) => {
    const root = resolve(opts.dir);
    const detected = detectStack(root);
    console.log(kleur.bold('Detected layers:'));
    for (const note of detected.notes) console.log(`  ${kleur.dim('•')} ${note}`);
    if (detected.leaves.length === 0) {
      console.log(kleur.yellow('No stack detected. Pick layers from prompts-vendored/ and pass --layer.'));
      process.exit(1);
    }

    const reviewDir = join(root, '.review');
    mkdirSync(reviewDir, { recursive: true });
    const projectFile = join(reviewDir, 'project.md');
    if (!existsSync(projectFile)) {
      const template = readFileSync(join(__dirname, '..', 'templates', '.review', 'project.md'), 'utf8');
      const filled = template.replace('{{LAYERS}}', JSON.stringify(detected.leaves));
      writeFileSync(projectFile, filled);
      console.log(kleur.green(`✓`) + ` wrote ${projectFile}`);
    } else {
      console.log(kleur.dim(`• ${projectFile} already exists, leaving alone`));
    }

    const agentsDir = join(root, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const reviewerFile = join(agentsDir, 'reviewer.md');
    if (!existsSync(reviewerFile)) {
      cpSync(join(__dirname, '..', 'templates', '.claude', 'agents', 'reviewer.md'), reviewerFile);
      console.log(kleur.green(`✓`) + ` wrote ${reviewerFile}`);
    }

    const wfDir = join(root, '.github', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    const wfFile = join(wfDir, 'code-review.yml');
    if (!existsSync(wfFile)) {
      cpSync(join(__dirname, '..', 'templates', '.github', 'workflows', 'code-review.yml'), wfFile);
      console.log(kleur.green(`✓`) + ` wrote ${wfFile}`);
    }

    console.log();
    console.log(kleur.bold('Next steps:'));
    console.log(`  1. Edit ${kleur.cyan('.review/project.md')} with your repo's deliberate choices.`);
    console.log(`  2. Set ${kleur.cyan('ANTHROPIC_API_KEY')} (and ${kleur.cyan('GITHUB_TOKEN')} for posting).`);
    console.log(`  3. Run: ${kleur.cyan('code-review pr <number> --owner X --repo Y --dry-run')}`);
  });

program
  .command('compose')
  .description('Print the composed prompt for the current repo (or for explicit layers).')
  .option('-d, --dir <path>', 'repo root', process.cwd())
  .option('-l, --layer <name...>', 'override detected layers (e.g. python/+fastapi)')
  .option('-p, --project <path>', 'project rules file', undefined)
  .action((opts) => {
    const root = resolve(opts.dir);
    const layers = opts.layer?.length ? opts.layer : detectStack(root).leaves;
    if (layers.length === 0) {
      console.error(kleur.red('no layers detected'));
      process.exit(1);
    }
    const projectRules = opts.project && existsSync(opts.project) ? readFileSync(opts.project, 'utf8') : undefined;
    const projectFromConvention = join(root, '.review', 'project.md');
    const finalProjectRules =
      projectRules ?? (existsSync(projectFromConvention) ? readFileSync(projectFromConvention, 'utf8') : undefined);
    process.stdout.write(composePrompt({ leaves: layers, projectRules: finalProjectRules }));
  });

program
  .command('pr <number>')
  .description('Review a GitHub pull request.')
  .requiredOption('--owner <owner>', 'GitHub owner')
  .requiredOption('--repo <repo>', 'GitHub repo name')
  .option('-d, --dir <path>', 'repo root for layer detection', process.cwd())
  .option('-l, --layer <name...>', 'override detected layers')
  .option('-p, --project <path>', 'project rules file')
  .option('--model <id>', 'Anthropic model id', 'claude-sonnet-4-6')
  .option('--max-tokens <n>', 'max output tokens', (v) => Number(v), 4096)
  .option('--dry-run', "don't post the review, just print it")
  .option('--format <fmt>', 'output format for --dry-run: markdown | json', 'markdown')
  .option('--no-fail-on-blockers', 'do not exit non-zero on blocker/security findings')
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
        model: opts.model,
        maxTokens: opts.maxTokens,
        dryRun: opts.dryRun,
      });
      printReportSummary(result);
      if (result.posted) {
        console.log();
        console.log(kleur.green('✓ posted: ') + result.posted.htmlUrl);
      } else {
        console.log();
        console.log(kleur.dim('--dry-run: not posted'));
        console.log(formatReview(result.review, format as OutputFormat));
      }

      // Severity gate is the last thing — we always want the report printed
      // even when we're about to exit non-zero, so CI logs are useful.
      const gate = evaluateSeverityGate(result.review);
      if (opts.failOnBlockers !== false && gate.blocked) {
        console.error();
        console.error(
          kleur.red(
            `severity gate: ${gate.triggering.length} blocker/security finding(s) — exiting 1`,
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

function printReportSummary(result: Awaited<ReturnType<typeof runReview>>): void {
  const r = result.review;
  console.log(kleur.bold(`${r.issues.length} issue(s) — effort ${r.estimated_review_effort_1_to_5}/5`));
  for (const issue of r.issues) {
    const sev = severityColor(issue.severity)(issue.severity);
    console.log(`  ${sev} ${kleur.cyan(`${issue.file}:${issue.line_start}`)} — ${issue.title || issue.why}`);
  }
  console.log();
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
