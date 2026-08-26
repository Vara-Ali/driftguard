import semver from 'semver';

/**
 * Compares a tracked version against the latest published version.
 *
 * A note on what this can and cannot tell you: `releaseType` is what semver
 * *claims* about the bump, not what the release actually did. The entire
 * premise of this project is that breaking changes routinely ship in minor and
 * patch bumps — the Recepta break came from an internal API change in a patch
 * release. So treat `isBreakingBySemver` as "the maintainer admitted it", and
 * treat everything else as still worth reading. That judgement is what the LLM
 * pass on Day 3 is for.
 */

export type ReleaseType =
  | 'major'
  | 'minor'
  | 'patch'
  | 'premajor'
  | 'preminor'
  | 'prepatch'
  | 'prerelease';

export interface VersionComparison {
  /** The baseline version from config. */
  tracked: string;
  /** The version currently published under `latest`. */
  latest: string;
  /** True when `latest` is strictly newer than `tracked`. */
  updateAvailable: boolean;
  /** The kind of bump, or null when the versions are equal. */
  releaseType: ReleaseType | null;
  /** True only for a major bump — semver's own signal that it broke something. */
  isBreakingBySemver: boolean;
  /** True when the tracked version is *ahead* of latest (pre-release, or an unpublished build). */
  isAheadOfLatest: boolean;
  /** One-line human summary, ready to print. */
  summary: string;
}

/** Raised when a version string is not valid semver. */
export class VersionCompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersionCompareError';
  }
}

/**
 * Compare a tracked version against the latest published version.
 *
 * Throws VersionCompareError if either version is not valid semver — better to
 * fail loudly than to silently report "up to date" off a typo in config.
 */
export function compareVersions(
  packageName: string,
  tracked: string,
  latest: string,
): VersionComparison {
  const trackedClean = semver.valid(tracked);
  const latestClean = semver.valid(latest);

  if (!trackedClean) {
    throw new VersionCompareError(`Tracked version "${tracked}" for ${packageName} is not valid semver.`);
  }
  if (!latestClean) {
    throw new VersionCompareError(`Latest version "${latest}" for ${packageName} is not valid semver.`);
  }

  const updateAvailable = semver.gt(latestClean, trackedClean);
  const isAheadOfLatest = semver.gt(trackedClean, latestClean);
  const releaseType = (semver.diff(trackedClean, latestClean) as ReleaseType | null) ?? null;
  const isBreakingBySemver = releaseType === 'major' || releaseType === 'premajor';

  return {
    tracked: trackedClean,
    latest: latestClean,
    updateAvailable,
    releaseType,
    isBreakingBySemver,
    isAheadOfLatest,
    summary: buildSummary(packageName, trackedClean, latestClean, updateAvailable, isAheadOfLatest, releaseType),
  };
}

function buildSummary(
  packageName: string,
  tracked: string,
  latest: string,
  updateAvailable: boolean,
  isAheadOfLatest: boolean,
  releaseType: ReleaseType | null,
): string {
  const prefix = `${packageName}: tracked=${tracked}, latest=${latest}`;

  if (updateAvailable) {
    return `${prefix} → UPDATE AVAILABLE (${releaseType})`;
  }
  if (isAheadOfLatest) {
    return `${prefix} → tracked version is ahead of latest (${releaseType})`;
  }
  return `${prefix} → up to date`;
}
