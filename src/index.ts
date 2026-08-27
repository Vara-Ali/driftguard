import 'dotenv/config';

import { TRACKED_DEPENDENCIES, getTrackedDependency } from './config';
import { getLatestVersion, RegistryError } from './registry';
import { compareVersions, VersionCompareError } from './compare';
import { checkGitHubAuth, reportGitHubAuth } from './github-check';
import { formatChangeData, formatScanResult, MissingApiKeyError, type VerdictResult } from './engine';
import { runFullCheck, type RunFullCheckResult } from './run-full-check';
import { appendRun } from './run-history';

/**
 * DriftGuard entry point.
 *
 * Default run: check every tracked dependency against the registry and, when
 * one has drifted behind, gather the raw evidence of what changed.
 *
 * Explicit run: `--from <version> --to <version>` forces the change-gathering
 * stage for a specific pair. That matters because the tracked package is
 * usually *not* behind — without an override there would be no way to exercise
 * or demo the Day 2 pipeline without editing config.
 */

interface CliOptions {
  from?: string;
  to?: string;
  packageName: string;
  fullDiff: boolean;
  /** Pass `--summarize` to also ask the LLM for a verdict. Off by default — the
   *  LLM call costs tokens and is irrelevant when the drift check says nothing
   *  is behind, which is the common case. */
  summarize: boolean;
  /** Pass `--scan` to run findUsages against the configured target repo when the
   *  LLM verdict says `breaking=true`. Implies `--summarize`. */
  scan: boolean;
  /** Override the repo path the scanner should search. */
  scanPath?: string;
  /** Pass `--suggest-fixes` to chain Day 5's per-match fix drafter after
   *  `--scan`. Implies `--scan` (and therefore `--summarize`). */
  suggestFixes: boolean;
  /** Pass `--open-pr` to chain Day 6's GitHub PR creation after
   *  `--suggest-fixes`. Implies `--suggest-fixes`. Gated to require at
   *  least one HIGH-confidence fix before it will run. */
  openPr: boolean;
  /** Override the GitHub repo for PR creation. Defaults to owner from
   *  GITHUB_REPO_OWNER env var, falling back to 'Vara-Ali' / 'driftguard'. */
  prOwner?: string;
  prRepo?: string;
  /** Override the base branch for the PR. Defaults to 'main'. */
  prBaseBranch?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    packageName: TRACKED_DEPENDENCIES[0]?.name ?? 'whatsapp-web.js',
    fullDiff: false,
    summarize: false,
    scan: false,
    suggestFixes: false,
    openPr: false,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--from':
        options.from = argv[++i];
        break;
      case '--to':
        options.to = argv[++i];
        break;
      case '--package':
        options.packageName = argv[++i];
        break;
      case '--full-diff':
        options.fullDiff = true;
        break;
      case '--summarize':
        options.summarize = true;
        break;
      case '--scan':
        options.scan = true;
        options.summarize = true; // scan implies summarize — we need the verdict
        break;
      case '--scan-path':
        options.scanPath = argv[++i];
        break;
      case '--suggest-fixes':
        options.suggestFixes = true;
        options.scan = true;
        options.summarize = true;
        break;
      case '--open-pr':
        options.openPr = true;
        options.suggestFixes = true;
        break;
      case '--pr-owner':
        options.prOwner = argv[++i];
        break;
      case '--pr-repo':
        options.prRepo = argv[++i];
        break;
      case '--pr-base':
        options.prBaseBranch = argv[++i];
        break;
      default:
        break;
    }
  }

  return options;
}

/** Render the LLM verdict as a four-line verdict block for the console. */
function reportVerdict(result: VerdictResult): void {
  if (!result.ok) {
    console.log(`LLM VERDICT: NOT AVAILABLE — ${result.error}`);
    return;
  }

  const v = result.verdict;
  const tag = v.breaking ? `[BREAKING · ${v.confidence}]` : `[safe · ${v.confidence}]`;
  console.log('');
  console.log('LLM VERDICT');
  console.log('-----------');
  console.log(`  ${tag}`);
  console.log(`  ${v.summary}`);
  if (v.discrepancyNote) {
    console.log('');
    console.log('  discrepancy:');
    console.log(`    ${v.discrepancyNote}`);
  }
  if (v.affectedMethods.length > 0) {
    console.log('');
    console.log('  affected:');
    for (const m of v.affectedMethods) {
      console.log(`    - ${m.name}: ${m.reason}`);
    }
  }
  console.log('');
  console.log(`  (latency ${result.latencyMs}ms, ${result.totalTokens} tokens, model ${result.model}${result.retried ? ', retried' : ''})`);
}

/**
 * Phase 1: the CLI is now a thin wrapper around `runFullCheck`. It prints
 * the structured result and (when appropriate) opens a draft PR. This
 * keeps the CLI surface identical to Days 6–7 while letting the new
 * Express server in `apps/api/` call the same orchestrator.
 */
async function reportChanges(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  fullDiff: boolean,
  summarize: boolean,
  scan: boolean,
  scanPath?: string,
  suggestFixes = false,
  openPr = false,
  prOwner?: string,
  prRepo?: string,
  prBaseBranch?: string,
): Promise<void> {
  console.log('');
  console.log(`Gathering change data for ${packageName} ${oldVersion} → ${newVersion} ...`);

  // Run the full pipeline once. The orchestrator records every stage's
  // outcome into a structured result; we print from it below.
  const target = scanPath
    ?? process.env.RECEPTA_TARGET_PATH
    ?? '/mnt/c/Users/Vara/projects/business-brain/cohort-1-squad-siachen';

  const result: RunFullCheckResult = await runFullCheck({
    packageName,
    fromVersion: oldVersion,
    toVersion: newVersion,
    targetRepoPath: scan ? target : '',
    prOptions:
      openPr && summarize && suggestFixes
        ? {
            owner: prOwner ?? process.env.GITHUB_REPO_OWNER ?? 'Vara-Ali',
            repo: prRepo ?? process.env.GITHUB_REPO_NAME ?? 'driftguard',
            baseBranch: prBaseBranch ?? process.env.GITHUB_REPO_BASE ?? 'main',
          }
        : undefined,
  });

  // Always print the raw change evidence.
  console.log(formatChangeData(result.changeData, { maxDiffLines: fullDiff ? 0 : 60 }));

  if (summarize) {
    if (!process.env.MINIMAX_API_KEY) {
      console.log('');
      console.log('Skipping LLM summary — MINIMAX_API_KEY is not set.');
      return;
    }
    console.log('');
    console.log('Asking LLM for a structured verdict ...');
    reportVerdict(result.verdict);
  }

  if (scan && result.scan) {
    console.log('');
    console.log(`Verdict says breaking — scanning ${result.scan.targetPath} for usages of affected symbols ...`);
    console.log(formatScanResult(result.scan));
  }

  if (suggestFixes && result.draft) {
    console.log('');
    console.log('FIX DRAFT COMPLETE');
    console.log('------------------');
    const t = result.draft.totals;
    console.log(`  symbols with matches : ${t.symbolsWithMatches}`);
    console.log(`  suggestions generated : ${t.suggestions}`);
    console.log(`  high / medium / low   : ${t.highConfidence} / ${t.mediumConfidence} / ${t.lowConfidence}`);
    console.log(`  requires manual review: ${t.manualReview}`);
    console.log(`  generation errors     : ${t.errors}`);
    console.log(`  report saved to       : ${result.reportPath}`);
    console.log('');
    console.log('Read the report, decide which fixes to apply, and skip the manual-review ones.');
  }

  if (openPr) {
    if (!result.pr) {
      // Orchestrator decided not to attempt PR (e.g. zero HIGH fixes, or prOptions absent).
      console.log('');
      console.log('Skipping --open-pr: no PR was attempted for this run.');
    } else if (result.pr.ok) {
      console.log('');
      console.log('DRAFT PR OPENED');
      console.log('---------------');
      console.log(`  applied : ${result.pr.applied} HIGH-confidence fix(es)`);
      console.log(`  skipped : ${result.pr.skipped}`);
      console.log(`  url     : ${result.pr.prUrl}`);
    } else {
      console.log('');
      console.log(`Draft PR failed: ${result.pr.error}`);
      console.log('  → Branch may have been created. Inspect the repo before retrying.');
    }
  }

  // Persist the run into history so the dashboard sees it. Best-effort —
  // a history write failure should not break the CLI's exit code.
  try {
    await appendRun(result);
    console.log('');
    console.log(`Run appended to run history (runId: ${result.runId}).`);
  } catch (e) {
    console.log(`Could not write run history: ${(e as Error).message}`);
  }
}

async function checkDependencies(
  fullDiff: boolean,
  summarize: boolean,
): Promise<{ checked: number; drifted: number; failed: number }> {
  let drifted = 0;
  let failed = 0;

  for (const dep of TRACKED_DEPENDENCIES) {
    try {
      const latest = await getLatestVersion(dep.name);
      const comparison = compareVersions(dep.name, dep.trackedVersion, latest);

      console.log(comparison.summary);

      if (comparison.updateAvailable) {
        drifted += 1;

        if (comparison.isBreakingBySemver) {
          console.log('  Major bump — upstream is declaring breaking changes.');
        } else {
          // The reason this project exists: a clean-looking bump is not a safe one.
          console.log(
            `  Not flagged breaking by semver, but a ${comparison.releaseType} bump can still ` +
              'break internal API usage. Reading the actual changes now.',
          );
        }

        await reportChanges(dep.name, comparison.tracked, comparison.latest, fullDiff, summarize, false);
      }
    } catch (error) {
      failed += 1;

      if (error instanceof RegistryError || error instanceof VersionCompareError) {
        console.log(`${dep.name}: CHECK FAILED — ${error.message}`);
      } else {
        console.log(`${dep.name}: CHECK FAILED — ${(error as Error).message}`);
      }
    }
  }

  return { checked: TRACKED_DEPENDENCIES.length, drifted, failed };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log('DriftGuard — dependency drift check');
  console.log('===================================');

  // Explicit pair: skip the drift check and go straight to change gathering.
  if (options.from && options.to) {
    const tracked = getTrackedDependency(options.packageName);
    console.log('');
    console.log(
      `Explicit comparison requested${tracked ? '' : ' (package not in config — checking anyway)'}.`,
    );

    await reportChanges(
  options.packageName,
  options.from,
  options.to,
  options.fullDiff,
  options.summarize,
  options.scan,
  options.scanPath,
  options.suggestFixes,
  options.openPr,
  options.prOwner,
  options.prRepo,
  options.prBaseBranch,
);
    process.exit(0);
  }

  if (options.from || options.to) {
    console.error('\n--from and --to must be given together.');
    process.exit(1);
  }

  console.log('');
  const { checked, drifted, failed } = await checkDependencies(options.fullDiff, options.summarize);

  console.log('');
  console.log(`Checked ${checked} dependenc${checked === 1 ? 'y' : 'ies'}: ${drifted} behind, ${failed} failed.`);
  console.log('');

  reportGitHubAuth(await checkGitHubAuth());

  // A dependency being out of date is a finding, not a crash. Only a failed
  // check is a non-zero exit.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('DriftGuard failed unexpectedly:', error);
  process.exit(1);
});
