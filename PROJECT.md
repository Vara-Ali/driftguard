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
Status: NOT STARTED
Goal: given two versions, pull the raw evidence of what changed between them —
GitHub releases, CHANGELOG.md, and the commit range — so there is something
real to summarize on Day 3.

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
