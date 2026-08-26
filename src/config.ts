/**
 * What DriftGuard is watching, and which version it currently considers "known
 * good". When an update is confirmed reviewed and safe, bump `trackedVersion`
 * here — that is the only place the baseline lives.
 */

export interface TrackedDependency {
  /** npm package name, exactly as published. */
  name: string;
  /** The version we currently consider the baseline. */
  trackedVersion: string;
  /** GitHub `owner/repo`, used from Day 2 to pull releases and commits. */
  repo: string;
  /** Why this version — useful when the baseline is a deliberate pin. */
  note?: string;
}

export const TRACKED_DEPENDENCIES: TrackedDependency[] = [
  {
    name: 'whatsapp-web.js',
    trackedVersion: '1.34.7',
    repo: 'pedroslopez/whatsapp-web.js',
    note:
      'Version Recepta runs in production (bridge + backend). Taken from the ' +
      'resolved entry in bridge/package-lock.json, not the "^1.34.7" range in ' +
      'package.json — the range is what we allow, the lock is what we actually run.',
  },
];

/** npm registry base URL. */
export const NPM_REGISTRY = 'https://registry.npmjs.org';

/** Network timeout for registry calls, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Look up a tracked dependency by package name.
 * Returns undefined if the package is not being tracked.
 */
export function getTrackedDependency(name: string): TrackedDependency | undefined {
  return TRACKED_DEPENDENCIES.find((dep) => dep.name === name);
}
