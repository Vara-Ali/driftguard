import 'dotenv/config';

import { TRACKED_DEPENDENCIES, getTrackedDependency } from './config';
import { getLatestVersion, RegistryError } from './registry';
import { compareVersions, VersionCompareError } from './compare';
import { checkGitHubAuth, reportGitHubAuth } from './github-check';
import { gatherChangeData, formatChangeData } from './gather-changes';

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
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    packageName: TRACKED_DEPENDENCIES[0]?.name ?? 'whatsapp-web.js',
    fullDiff: false,
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
      default:
        break;
    }
  }

  return options;
}

/** Fetch and print the change evidence for one upgrade. */
async function reportChanges(
  packageName: string,
  oldVersion: string,
  newVersion: string,
  fullDiff: boolean,
): Promise<void> {
  console.log('');
  console.log(`Gathering change data for ${packageName} ${oldVersion} → ${newVersion} ...`);

  const data = await gatherChangeData(packageName, oldVersion, newVersion);
  console.log(formatChangeData(data, { maxDiffLines: fullDiff ? 0 : 60 }));
}

async function checkDependencies(
  fullDiff: boolean,
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

        await reportChanges(dep.name, comparison.tracked, comparison.latest, fullDiff);
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

    await reportChanges(options.packageName, options.from, options.to, options.fullDiff);
    process.exit(0);
  }

  if (options.from || options.to) {
    console.error('\n--from and --to must be given together.');
    process.exit(1);
  }

  console.log('');
  const { checked, drifted, failed } = await checkDependencies(options.fullDiff);

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
