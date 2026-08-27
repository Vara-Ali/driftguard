import 'dotenv/config';

import { TRACKED_DEPENDENCIES, getTrackedDependency } from './config';
import { getLatestVersion, RegistryError } from './registry';
import { compareVersions, VersionCompareError } from './compare';
import { checkGitHubAuth, reportGitHubAuth } from './github-check';
import { gatherChangeData, formatChangeData } from './gather-changes';
import { summarizeChange, MissingApiKeyError, type VerdictResult } from './llm-client';
import { findUsages, formatScanResult } from './scanner';
import { draftFixesForChange } from './fix-generator';
import { saveReport, announceReport } from './report';
import { runOpenPr } from './git-actions';

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

/** Fetch and print the change evidence for one upgrade. */
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

  const data = await gatherChangeData(packageName, oldVersion, newVersion);
  console.log(formatChangeData(data, { maxDiffLines: fullDiff ? 0 : 60 }));

  if (summarize) {
    if (!process.env.MINIMAX_API_KEY) {
      console.log('');
      console.log('Skipping LLM summary — MINIMAX_API_KEY is not set.');
      return;
    }

    console.log('');
    console.log('Asking LLM for a structured verdict ...');
    let verdict: VerdictResult | undefined;
    try {
      const result = await summarizeChange(packageName, oldVersion, newVersion);
      verdict = result.verdict;
      reportVerdict(verdict);
    } catch (error) {
      if (error instanceof MissingApiKeyError) {
        console.log(`Skipping LLM summary — ${error.message}`);
        return;
      }
      console.log(`LLM summary failed unexpectedly: ${(error as Error).message}`);
      return;
    }

    // Day 4: only scan when the verdict is unambiguously breaking. If the LLM
    // says "safe" or returned a failure result, scanning the codebase for
    // "removed" symbols would just produce noise.
    if (scan && verdict && verdict.ok && verdict.verdict.breaking) {
      const target = scanPath
        ?? process.env.RECEPTA_TARGET_PATH
        ?? '/mnt/c/Users/Vara/projects/business-brain/cohort-1-squad-siachen';

      console.log('');
      console.log(`Verdict says breaking — scanning ${target} for usages of affected symbols ...`);
      try {
        const scanResult = await findUsages(verdict.verdict.affectedMethods, target);
        console.log(formatScanResult(scanResult));
      } catch (error) {
        console.log(`Scan failed: ${(error as Error).message}`);
      }

      // Day 5: chain the per-match fix drafter when --suggest-fixes is set.
      if (suggestFixes) {
        console.log('');
        console.log('Generating per-usage fix suggestions ...');
        try {
          const draft = await draftFixesForChange(packageName, oldVersion, newVersion, target);
          const savedPath = saveReport(draft);
          for (const line of announceReport(draft, savedPath)) {
            console.log(line);
          }

          // Day 6: chain the GitHub PR creation when --open-pr is set.
          // Gated to require at least one HIGH-confidence fix so we never
          // open an empty PR by accident.
          if (openPr) {
            if (draft.totals.highConfidence === 0) {
              console.log('');
              console.log('Skipping --open-pr: zero HIGH-confidence fixes would be applied.');
              console.log('  (MEDIUM / LOW / manual-review suggestions go into a PR as a checklist,');
              console.log('   not as auto-applied diffs. Run without --open-pr to just see the report.)');
            } else {
              console.log('');
              console.log('Opening draft PR on GitHub ...');
              console.log(`  → creating branch on ${prRepo ?? process.env.GITHUB_REPO_NAME ?? 'driftguard'} ...`);
              try {
                const result = await runOpenPr({
                  draft,
                  repo: {
                    owner: prOwner ?? process.env.GITHUB_REPO_OWNER ?? 'Vara-Ali',
                    name: prRepo ?? process.env.GITHUB_REPO_NAME ?? 'driftguard',
                  },
                  baseBranch: prBaseBranch ?? process.env.GITHUB_REPO_BASE ?? 'main',
                  targetRepoPath: target,
                });

                if (result.ok) {
                  console.log('  → PR opened.');
                  console.log('');
                  console.log('DRAFT PR OPENED');
                  console.log('---------------');
                  console.log(`  applied : ${result.applied} HIGH-confidence fix(es)`);
                  console.log(`  skipped : ${result.skipped}`);
                  console.log(`  url     : ${result.prUrl}`);
                } else {
                  console.log('');
                  console.log(`Draft PR failed: ${result.error}`);
                  console.log('  → Branch may have been created. Inspect the repo before retrying.');
                }
              } catch (error) {
                console.log(`Draft PR threw unexpectedly: ${(error as Error).message}`);
                if ((error as Error).stack) {
                  console.log((error as Error).stack);
                }
              }
            }
          }
        } catch (error) {
          if (error instanceof MissingApiKeyError) {
            console.log(`Skipping fix draft — ${error.message}`);
          } else {
            console.log(`Fix draft failed: ${(error as Error).message}`);
          }
        }
      }
    }
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
