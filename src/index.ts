import 'dotenv/config';

import { TRACKED_DEPENDENCIES } from './config';
import { getLatestVersion, RegistryError } from './registry';
import { compareVersions, VersionCompareError } from './compare';
import { checkGitHubAuth, reportGitHubAuth } from './github-check';

/**
 * DriftGuard entry point.
 *
 * Day 1 scope: for every tracked dependency, ask the npm registry what the
 * latest published version is and report whether we have drifted behind it.
 * Reading what actually changed is Day 2.
 */

async function checkDependencies(): Promise<{ checked: number; drifted: number; failed: number }> {
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
              'break internal API usage. Day 2 will read the actual changes.',
          );
        }
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
  console.log('DriftGuard — dependency drift check');
  console.log('===================================');
  console.log('');

  const { checked, drifted, failed } = await checkDependencies();

  console.log('');
  console.log(`Checked ${checked} dependenc${checked === 1 ? 'y' : 'ies'}: ${drifted} behind, ${failed} failed.`);
  console.log('');

  // Auth smoke test only — no GitHub feature work happens until Day 2.
  reportGitHubAuth(await checkGitHubAuth());

  // A dependency being out of date is a finding, not a crash. Only a failed
  // check is a non-zero exit.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('DriftGuard failed unexpectedly:', error);
  process.exit(1);
});
