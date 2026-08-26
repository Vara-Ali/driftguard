# DriftGuard

> Guards against dependency drift — the gap that opens between the version you
> tested against and the version you are actually running.

## What this is
DriftGuard is an agent that watches a tracked npm dependency for newly published
versions and, when one appears, works out what actually changed. It pulls the
upstream changelog and commit history, uses an LLM to summarize the changes into
a concrete list of breaking API changes, then scans a target codebase for real
call sites of the affected methods. Where it finds a hit, it drafts a fix rather
than just filing a warning.

## Who it's for
Small dev teams and agencies who depend on fast-moving third-party SDKs and get
broken by silent breaking changes — the kind that ship in a patch or minor bump,
never appear in a changelog, and only surface when production stops working.

## Tech stack
- Runtime: Node.js 20 + TypeScript 5.9 (CommonJS), `ts-node` for dev running
- Package registry access: npm registry API (`https://registry.npmjs.org`)
- HTTP client: axios
- Version comparison: semver
- GitHub API: Octokit (`@octokit/rest` v22) — read access first, PR-writing later
- LLM: MiniMax (`MiniMax-M2.7-highspeed`) via the OpenAI-compatible endpoint at
  `https://api.minimax.io/v1/chat/completions` — same provider Recepta uses
- Env management: dotenv

Two pins are deliberate and should not be "upgraded" casually — TypeScript must
stay on 5.x (ts-node cannot load TypeScript 7), and Octokit must be loaded via
dynamic `import()` (it is ESM-only). Both are explained in the Day 1 log.

## Running it
Run everything from the **WSL** shell, not PowerShell — see Day 1 note 3 for why.
```bash
npm install
cp .env.example .env      # then add a real GITHUB_TOKEN
npm run dev               # check tracked deps against the registry
npm run check:github      # GitHub auth smoke test on its own

# Force the change-gathering pipeline for a specific pair. Needed because the
# tracked package is usually not behind, so the "update detected" branch never
# fires against live data.
npm run dev -- --from 1.34.6 --to 1.34.7
npm run dev -- --from 1.34.6 --to 1.34.7 --full-diff   # no diff truncation
```


## Tracked dependency for MVP
`whatsapp-web.js` — chosen because Recepta had a real production break from a
silent internal API change in this package, so there is a genuine before/after
story to demonstrate rather than a synthetic one.

Recepta currently runs **1.34.7** (verified against `bridge/package-lock.json`
and the installed `node_modules`, not the `^1.34.7` range in `package.json`).

---

## 7-Day Build Log

### Day 1 — Scope + Skeleton
Status: COMPLETE
Goal: script that can answer "what's the latest published version of
whatsapp-web.js, and is it newer than the version I'm currently tracking?"
Tasks:
- [x] Init Node.js + TypeScript project
      Node 20.20.2, TypeScript 5.9.3, ts-node 10.9.2, CommonJS. `npm run dev`
      runs `ts-node src/index.ts`. Two version pins were forced, both covered
      under "What did not go to plan" below.
- [x] Set up .env and .gitignore
      `.env.example` is checked in with `GITHUB_TOKEN` plus a `MINIMAX_API_KEY`
      placeholder that stays unused until Day 3. Real `.env` is gitignored.
- [x] Write a module to fetch published versions of a package from the
      npm registry
      `src/registry.ts`. Uses the abbreviated packument
      (`application/vnd.npm.install-v1+json`) — the full document for
      whatsapp-web.js carries per-version detail we do not need. Exposes
      `getLatestVersion`, `getAllVersions`, and `getVersionInfo` (both in one
      request). 404s and network failures raise a typed `RegistryError`.
- [x] Write a module to compare versions using semver
      `src/compare.ts`. Returns tracked/latest, `updateAvailable`,
      `releaseType`, `isBreakingBySemver`, and a ready-to-print `summary`.
      Invalid semver throws rather than silently reporting "up to date".
- [x] Write a config file that stores "currently tracked version" per dependency
      `src/config.ts`. Array of `TrackedDependency`, so adding a second package
      later needs no code change. Also carries the GitHub `owner/repo` that
      Day 2 will need.
- [x] Verify GitHub API auth works with a personal access token (read-only test call)
      Verified — `npm run check:github` returns `OK as Vara-Ali (scopes: repo)`
      with ~4,967 requests/hour remaining. `src/github-check.ts` makes a single
      read-only `GET /user` via Octokit and reports login, scopes and rate
      limit. Classic PAT with `repo` scope, so it also covers the branch/commit/
      PR work on Day 6 without needing a second token.
- [x] Confirm working end-to-end: running the script says whether whatsapp-web.js
      has a newer version available than what's tracked
      `npm run dev` fetches the real registry and prints the comparison.

**What was built.** Five modules under `src/`: `config.ts` (what we watch and
the known-good baseline), `registry.ts` (npm registry reads), `compare.ts`
(semver diff), `github-check.ts` (auth smoke test), and `index.ts` (entry
point that ties them together). `tsc --noEmit` is clean and `npm audit`
reports zero vulnerabilities.

**A design decision worth recording.** `compare.ts` deliberately separates
"semver says this is breaking" from "this is safe". A major bump sets
`isBreakingBySemver`, but the whole reason this project exists is that the
Recepta break arrived in a *non-major* bump. So a minor or patch bump prints an
explicit note that it still needs reading rather than being waved through. That
distinction is the thing Day 3's LLM pass is meant to resolve.

**What did not go to plan.**
1. `npm i -D typescript` installed **TypeScript 7.0.2**, which ts-node 10.9.2
   cannot load at all — it crashed in both CJS and ESM mode reading internal TS
   APIs that moved. ts-node 10.9.2 is the latest published release, so there is
   no newer ts-node to fix this. Pinned TypeScript to `^5.9` (now 5.9.3), which
   also matches what Recepta already runs (`^5.5.0`).
2. `@octokit/rest` v22 is **ESM-only** and cannot be `require()`d, which
   collides with a CommonJS + ts-node setup. Three options were tried:
   - ts-node's ESM loader (`--esm`) fails on Node 20.20 with
     `ERR_UNKNOWN_FILE_EXTENSION` — the loader hooks no longer register
     properly on current Node 20.x. Dead end.
   - Downgrading to `@octokit/rest@19` (last CommonJS release) works, but
     carries 6 moderate ReDoS advisories that are only fixable by upgrading.
     Rejected — bad foundation on day one.
   - **Chosen:** stay on CommonJS + ts-node, keep Octokit v22, and load it with
     a dynamic `await import()`. tsconfig `module: node16` makes TypeScript
     preserve the `import()` instead of rewriting it to `require`, and Node
     supports importing ESM from CJS at runtime. Clean audit, modern Octokit,
     and `ts-node` still runs the project as asked.
3. **`npm run` failed from Windows PowerShell** with `'ts-node' is not
   recognized`. The install was done from WSL, so `node_modules/.bin/` holds
   Unix symlinks and none of the `.cmd` shims PowerShell needs. The two
   environments also have different runtimes — WSL is Node 20.20.2 / npm 10.8.2,
   Windows is Node 24.15.0 / npm 11.12.1 — sharing one `node_modules` across
   both is asking for trouble. **Resolved by standardising on WSL.** Run every
   command from the WSL shell, not PowerShell. If Windows-side runs are ever
   needed, `node_modules` has to be deleted and reinstalled from that side.

**Verification.** All comparison branches were exercised directly, not just the
one the live registry happens to produce today (whatsapp-web.js is currently at
1.34.7, so the real run reports "up to date"): minor, patch, major,
equal, tracked-ahead-of-latest, and invalid-semver all behave correctly.
Registry error handling confirmed against a package name that does not exist.


### Day 2 — Change Retrieval
Status: COMPLETE
Goal: given two real version numbers, output the actual GitHub Release notes
plus a rough type/API diff — raw material only, no LLM summarization yet
(that is Day 3).
Tasks:
- [x] Normalize version strings between npm format (1.34.7) and GitHub
      tag format (v1.34.7) in one shared utility, used everywhere tags
      are looked up — do not scatter ad-hoc string prefixing across files
      `src/version-tags.ts`. `toGitHubTag`, `toNpmVersion`, `candidateTags`,
      `isSameVersion`. `candidateTags` returns `['v1.34.7', '1.34.7']` so a
      repo that does not use the `v` convention still resolves instead of
      reporting a spurious "no release found". `toNpmVersion` also handles
      monorepo tags like `pkg-name@1.2.3`.
- [x] Fetch the GitHub Release body for a given whatsapp-web.js version
      via Octokit, using the normalized tag
      `src/changelog.ts`. Resolves the repo from the package's **own npm
      metadata** rather than local config, so it self-corrects when a project
      moves org — which is exactly what whatsapp-web.js did.
- [x] If no Release exists for a tag, return a clear "no release notes
      available" result rather than crashing
      Returns a discriminated `{ found: false, reason, triedTags }`. 404 on one
      candidate tag falls through to the next; only a non-404 aborts. Code
      comment records that a CHANGELOG.md fallback belongs here for packages
      that use one — deliberately unbuilt, since no in-scope package needs it
      and an untested fallback is worse than an honest "not found".
- [x] Fetch npm registry metadata for a specific version (not just latest)
      `src/npm-metadata.ts`. Publish date, deprecation, deps, peer deps, types
      and main entry points, plus a `repository` parser that copes with npm's
      loose field (string shorthand, `github:` prefix, git+https, git+ssh,
      scp-style). Publish times need the *full* packument, so that response is
      cached per package per process rather than refetched.
- [x] Fetch and diff type definitions between two versions via unpkg/jsdelivr
      `src/type-diff.ts`. unpkg first, jsDelivr as fallback. Exact LCS diff
      with common prefix/suffix trimming, plus a symbol-level diff (see the
      finding below — the symbol diff turned out to matter far more than the
      line diff).
- [x] Combine all of the above into gatherChangeData(packageName, oldVersion,
      newVersion) returning { releaseNotes, npmMetadata, typeDiff }
      `src/gather-changes.ts`. All three sources run concurrently under
      `Promise.allSettled`, so a failed type diff still leaves you the release
      notes. `formatChangeData` renders the three-section console report.
- [x] Wire into index.ts: when an update is detected, call gatherChangeData
      and pretty-print
      Done, plus a `--from/--to` override. Without it the pipeline would be
      undemonstrable: the tracked package is not currently behind, so the
      "update detected" branch never fires against live data.

**What was built.** Six new modules: `version-tags.ts`, `npm-metadata.ts`,
`changelog.ts`, `type-diff.ts`, `gather-changes.ts`, and `octokit-client.ts`
(a shared, lazily-imported Octokit instance — the ESM dynamic import is worth
paying for once rather than per call site).

**The main finding: line diffs are not trustworthy; symbol diffs are.**
1.34.7 reformatted the whole of `index.d.ts` — added semicolons, removed blank
lines, reflowed multi-line signatures. Every single line changed. The first
implementation reported `+885/-738` and confidently listed `sendMessage`,
`getChats` and `destroy` as *removed*, all of which plainly still exist. Two
fixes: match on a normalized key (whitespace collapsed, trailing punctuation
stripped) so cosmetic churn collapses, and raise the exact-LCS cell limit,
which at 4M was too conservative — a 2,260 x 2,481 pair needs ~5.6M cells,
which is only ~22MB. Then add a **symbol-level diff** that extracts declared
names and set-compares them. Names survive reformatting; lines do not. Output
now flags `looksReformatted` when line churn is high but symbol churn is not,
and tells the reader which half to trust.

**The result, on a patch release.** 1.34.6 → 1.34.7 removed eight symbols:
`ClientSession`, `LegacySessionAuth`, `WABrowserId`, `WASecretBundle`,
`WAToken1`, `WAToken2`, `ClientOptions.session`, and `restartOnAuthFail`. That
is the entire legacy session-auth API, deleted in a **patch bump**, and the
release notes never say so — they read as a list of bug fixes. This is the
project's whole thesis reproduced on real data, and it is a better demo than
anything synthetic.

**What did not go to plan.**
1. A type-only import of the ESM-only Octokit from a CommonJS file fails with
   TS1541. Fixed with an explicit
   `with { 'resolution-mode': 'import' }` attribute. Type-only, erased at
   runtime, so it costs nothing.
2. Three rounds were needed to make the symbol extractor trustworthy. Paren and
   bracket depth tracking had to be added so that parameter names in reflowed
   multi-line signatures stop looking like member declarations, and a keyword /
   built-in-type denylist had to be added on top. That cut spurious additions
   from 28 to 7.
3. **Verification nearly produced a false conclusion.** A `grep`-based check
   suggested `LegacySessionAuth` and `session` were still present in 1.34.7 and
   therefore false positives. They were not — `LegacySessionAuth` survives only
   inside a *comment*, and `session` only as a field inside an open parameter
   list. The extractor strips comments and tracks depth, so it was right and
   the grep was the wrong instrument. Worth recording as a caution: verifying a
   structural claim with a text search invites exactly this mistake.

**Known limitation, deliberately not fixed.** Member-level symbol extraction is
formatting-sensitive in one direction. A property nested inside an inline type
literal — `Array<{ buttonId: string; ... }>` in 1.34.6 — becomes visible to the
extractor once a reflow puts it on its own line. That produced four harmless
false *additions* (`buttonId`, `intervalMs`, `phoneNumber`, `showNotification`).
Top-level declarations (class, interface, enum, type) come from a separate
formatting-immune pattern and are reliable. Since the false positives only ever
land in the additions column, and Day 3 cross-references against release notes
anyway, a real TypeScript parse is not yet worth the dependency.

**Flagged for Day 5–6, not acted on.** `v2.0.0-alpha.0` is tagged upstream while
npm `latest` remains 1.34.7. A genuine 1.x → 2.0 major upgrade may be available
to demo against instead of a synthetic one. Decide nearer the time; the 1.34.6 →
1.34.7 legacy-auth removal above may honestly be the stronger story precisely
because it is a *patch*.

Pre-flight findings (checked against the live GitHub API at the end of Day 1):
- The repo has **moved** to `wwebjs/whatsapp-web.js`. The old
  `pedroslopez/...` path still redirects, but config now points at the real one.
- There is **no CHANGELOG.md** in the repo — both casings 404. The original
  plan to read a changelog file does not apply to this package.
- **GitHub Releases are the real source**, and they are substantial: the
  v1.34.7 release body is ~5,000 characters, v1.34.6 ~2,655. That is genuinely
  useful input for the Day 3 LLM pass.
- Release tags carry a `v` prefix (`v1.34.7`) while npm versions do not
  (`1.34.7`). Day 2 must normalize between the two or every lookup misses.
- A **`v2.0.0-alpha.0` tag exists** even though npm `latest` is still 1.34.7.
  A major version is in progress upstream — worth watching, and a good demo
  angle for a genuinely breaking upgrade.


### Day 3 — LLM Breaking-Change Summarizer
Status: NOT STARTED
Goal: feed the raw change evidence to the LLM and get back a structured list of
breaking changes, each naming the specific affected method or export.

### Day 4 — Codebase Usage Scanner
Status: NOT STARTED
Goal: scan a target repo for real call sites of the affected methods and report
file + line for each hit, with the false-positive rate low enough to trust.

### Day 5 — Fix Drafter
Status: NOT STARTED
Goal: for each confirmed call site, draft a concrete code change that migrates
it to the new API, with the old and new code shown side by side.

### Day 6 — GitHub Output
Status: NOT STARTED
Goal: turn the drafted fixes into real output on GitHub — branch, commit, and a
pull request with the summary and reasoning in the body. First use of Octokit
write access.

### Day 7 — End-to-End Demo + Polish
Status: NOT STARTED
Goal: run the whole pipeline against the actual Recepta break as the demo case,
tighten the output, and write up the before/after story.

---

## Engineering Log Rule
Every time a task above is completed, this file gets updated immediately — check
off the task, and add 1-2 lines describing what was actually built, decisions
made, and anything that did not work as expected. This is a running engineering
log, not a one-time README.
