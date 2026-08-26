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
npm run verify            # Day 3 LLM ground-truth validator against 1.34.6 -> 1.34.7

# Day 4: full dogfood — change data, LLM verdict, then usage scan against Recepta.
npm run dev -- --from 1.34.6 --to 1.34.7 --summarize --scan
npm run dev -- --from 1.34.6 --to 1.34.7 --summarize --scan --scan-path /path/to/other/repo
```

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
Status: COMPLETE
Goal: feed the raw change evidence from Day 2 to the LLM and get back a
structured verdict — was this upgrade breaking, what specifically broke,
how confident is the call, and does the maintainer's account in the release
notes match what the type diff shows?
Tasks:
- [x] Design the LLM prompt template that takes gatherChangeData() output
      and produces a structured verdict
      `src/prompts/summarize-change.ts`. Single `buildPrompt(change)` function
      rather than scattered string concat — keeps the wording readable as
      one document so iterating on it stays cheap.
- [x] Define the exact output schema: { breaking, confidence, affectedMethods,
      summary, discrepancyNote }
      `Verdict` interface in `src/llm-client.ts`. `affectedMethods` is an
      array of `{ name, reason }` so the model cannot cheat with a single
      string when it cannot find anything to name.

**SCHEMA LOCK (Day 3 → Day 4+).** The `Verdict` interface is the canonical
spec going forward; **Day 4 must consume `affectedMethods` as
`{ name: string, reason: string }[]`, not `string[]`.** This is a deliberate
improvement — a single string would have lost the model's reasoning about
*why* something was affected, which the Day 4 scanner and Day 5 fix drafter
both rely on. Changing the shape later would force a rebuild of every
downstream consumer, so it is frozen here.
- [x] Implement the LLM call using the existing provider setup from Recepta
      Same provider, same model (`MiniMax-M2.7-highspeed`), same OpenAI-
      compatible chat-completions endpoint at `api.minimax.io/v1/...` —
      `llm-client.ts` is essentially Recepta's `llm.ts` trimmed down to
      chat-completion only.
- [x] Prompt weighted toward top-level symbol removals as strong breaking
      signals, nested inline-type property changes as weak noise
      Three explicit heuristics in the system prompt: top-level exports
      removed/renamed = STRONG breaking, nested property changes = WEAK,
      reformat-flagged diffs = trust the symbol list not the line list.
- [x] Prompt weighted toward discrepancy detection as a first-class finding
      "If the release notes say bug fixes but the type diff shows removed
      public API surface, that mismatch is itself the most important
      finding. Call it out explicitly." — required as a non-null string
      in the schema.
- [x] Validate against the hand-written ground truth for v1.34.6 → v1.34.7
      `src/verify.ts` plus `npm run verify`. Hardcoded `CASES` array so
      adding more cases is one entry. Side-by-side verdict rendering and
      field-level checks.
- [x] Handle malformed/unparseable LLM output gracefully (retry once, then
      fall back to a clear "could not determine" result)
      First attempt, then retry with an explicit "your previous response
      was not parseable JSON" nudge. Two failures in a row → structured
      `VerdictFailure` with the raw text in the result, never a thrown error.
      The retry path was not exercised on the real case (see below).
- [x] Wire into index.ts: after gatherChangeData() runs, pass its output
      through the new LLM summarization step and print the structured
      verdict
      New `--summarize` flag. Off by default — costs tokens, irrelevant
      when the drift check says nothing is behind, which is the common
      case. Missing `MINIMAX_API_KEY` skips the LLM step cleanly rather
      than crashing.

**What was built.** Three new modules plus one new subdir:
`src/prompts/summarize-change.ts` (the template), `src/llm-client.ts` (axios
to MiniMax, strict schema validation, JSON extraction that handles prose /
fences / bare objects, retry-with-nudge, structured failure result), and
`src/verify.ts` (the verifier). Plus a `verify` npm script. The Day 2 pipeline
is now the input to an LLM verdict, end to end.

**The first-try verdict.** On the real v1.34.6 → v1.34.7 data:
- `breaking: true`, `confidence: high` — match.
- Named all eight removed session/auth exports in `affectedMethods` — match.
- Populated `discrepancyNote` (333 chars) explicitly calling out the
  release-notes-downplay vs type-diff-shows-removals mismatch — match.
- Bonus finding the prompt didn't even prime for: it correctly flagged that
  `sendReaction` was *relocated* from a structures module to the Client class,
  a non-removal breaking change that the symbol diff would not have caught.
  Either the LLM picked that up from the release notes
  (`feat(client): move \`sendReaction\` method to the Client by @maxkoryukov`)
  or from reflowing the inline types; either way, the heuristic works.
- **No retry needed.** The verifier shows `retried: false` on the first
  attempt, which means the prompt and schema were tight enough that the model
  produced parseable, schema-matching JSON immediately.

**Cost / latency.** On `MiniMax-M2.7-highspeed`: ~16.5s wall clock, ~3,450
tokens per call (release notes ~5KB + symbol diff + system prompt). That is
roughly the budget for one decision: ~2¢ at retail MiniMax rates, which is
fine for an end-of-build summary but not something to fire on every version
that drifts behind. Notes for later tier decisions:

- `--summarize` is opt-in. Drift check itself stays free.
- The release-notes body alone is the bulk of the tokens; if cost becomes
  a concern, the obvious next knob is truncating the body in `buildPrompt`
  (already a parameter on `formatChangeData` for the same reason).
- `--full-diff` does not enlarge the prompt — diff truncation happens at the
  format step, not the prompt step. Means even an untruncated run costs the
  same as the truncated one.

**What did not go to plan.**
1. The first `buildPrompt` template used `<boolean>` / `<string>` placeholders
   for type fields. Inside a backtick template literal TypeScript tried to
   parse `<boolean>` as a tag function and failed with TS1005. Fixed by
   rewriting the placeholders in parentheses.
2. The first `buildPrompt` template also included `` `affectedMethods` ``
   literally in the prose. That closes the outer template literal early, and
   TS pointed at line 74 (a non-existent error in the JSON schema block,
   which actually lived further down). Escaped the inner backticks. Worth
   recording: prompts read like prose but they're code, and they need to
   parse cleanly. The next prompt that needs angle-bracket-like syntax or
   backticks should escape deliberately.
3. `verify.ts` crashed with `MissingApiKeyError` on the first run because
   it had no `import 'dotenv/config'`. `index.ts` and `github-check.ts`
   already had it; verify did not. Added. Surprised this took one round to
   surface — should have added it the moment `getVerdictForChange` was
   written.

**Known limitation, deliberately not fixed.** `affectedMethods.reason` is
free text from the model. The verifier checks the *names* appear, not the
quality of the reason strings. A future "semantic correctness" check is
out of scope for day 3; the schema is right, the field is informative, and
over-specifying it now would just lock in one prompt iteration.

**Note for Day 6 / demo.** The verdict block produced by `--summarize` is
already shaped like the body of a pull request: a one-line headline, a
plain-English summary, the discrepancy note, and the affected methods.
When the PR-writing code lands, it should lift these fields directly
rather than re-prompting.

Pre-flight findings (checked against the live GitHub API at the end of Day 1):

### Day 4 — Codebase Usage Scanner
Status: COMPLETE
Goal: given the Day 3 verdict's `{ name, reason }[]` array, scan a target
repo and report every real call site of each removed/affected symbol —
turning "the upgrade is breaking" into "this upgrade is breaking **for
you, in these specific files**".

The dogfood target for this build is the Recepta codebase (Recepta was
chosen as the demo case precisely because it actually depended on
whatsapp-web.js), so a real scan against Recepta proves whether the break
in 1.34.6 → 1.34.7 would have been caught in advance.
Tasks:
- [x] Write `findUsages(affectedMethods, targetRepoPath)` that takes the
      `{ name, reason }[]` array from Day 3 and searches a target codebase
      for references to each method/symbol name
      `src/scanner.ts`. Returns `{ targetPath, backend, scanned, usages,
      anyHits }`; per-symbol `SymbolUsage` carries the LLM's reason, every
      match, the match count, and which backend produced the results.
- [x] Use a simple, reliable search first (ripgrep via child_process, or a
      plain recursive file read + string/regex match) — do NOT build a full
      AST parser today, that's overkill for an MVP and Day 2 already showed
      formatting-sensitive parsing is fragile
      Ripgrep-preferred via `execFileSync` with explicit path resolution,
      manual walker fallback. Both produce the same `CodeMatch` shape so
      downstream code does not care which ran. See "What did not go to plan"
      below for why the ripgrep plumbing took three attempts.
- [x] For each match, capture: file path, line number, and the actual line
      of code containing the match
      Captured as `CodeMatch { file, line, code }`. File paths are always
      repo-relative in the output regardless of backend.
- [x] Filter obvious noise: matches inside node_modules, .git, dist/, build
      folders
      ripgrep path uses `--glob '!**/{dir}/**'`, manual walker skips
      directories outright. Covers `node_modules`, `.git`, `dist`, `build`,
      `coverage`, `.next`, `.nuxt`, `.turbo`, `.cache`, `out`. Comment
      stripping deliberately skipped — it would add complexity for marginal
      value, since the per-symbol counts already let the reader see noise
      versus real exposure.
- [x] Handle common/generic symbol names — flag match counts per symbol so
      the demo can see noise, don't silently drop them
      Every symbol is reported even at zero matches. For non-zero counts,
      the first 10 file:line hits are printed and the rest are summarized
      as `... and N more match(es)`. The full count is never dropped.
- [x] Run against a REAL target: the Recepta repo (a local checkout of
      `cohort-1-squad-siachen/bridge` and `cohort-1-squad-siachen/backend`),
      not a synthetic test repo
      Default `RECEPTA_TARGET_PATH` in `.env.example` points at the real
      checkout. Overridable per-run via the env var or `--scan-path`.
- [x] Wire into index.ts: after the Day 3 LLM verdict prints, if
      `breaking=true`, automatically run `findUsages` against the configured
      target repo path and print every match found
      New `--scan` flag (implies `--summarize` because we need the verdict
      to know which symbols to search for). Only scans when the verdict
      explicitly says `breaking=true` — scanning on a "safe" verdict or a
      failed result would just be noise.

**What was built.** One new module, one new CLI flag, and one new env var.
`src/scanner.ts` (~200 lines) plus `findUsages()` and `formatScanResult()`.
Wired through `reportChanges` in `index.ts` so `npm run dev -- --from X --to Y
--summarize --scan` is a complete dogfood demo.

**The real result on Recepta — no exposure.**
Scanning Recepta for the 8 removed/whatsapp-web.js 1.34.7-affected symbols:

| Symbol | Matches in Recepta |
|---|---|
| ClientSession | 0 |
| LegacySessionAuth | 0 |
| WABrowserId | 0 |
| WASecretBundle | 0 |
| WAToken1 | 0 |
| WAToken2 | 0 |
| restartOnAuthFail | 0 |
| session | **227** — but every one is unrelated |

Recepta has **zero real exposure** to the 1.34.7 session-auth removal. The
227 `session` matches are all things like `sessionsRoot` config, the
`/sessions/` directory on disk, `whatsapp-web.session-manager` log channel
names, and `LocalAuth` (which is the *replacement* for the removed
`LegacySessionAuth`). A grep for `\.session` as a property on a Client
object returns nothing — so even when the LLM correctly flags `session`
as a removed Client option, the codebase does not use it.

That is the Day 4 finding, and it is a **legitimate story**: DriftGuard
correctly identified a real, upstream breaking change, then correctly
determined that *this particular consumer* is unaffected. That is the
opposite of a false positive — it is a real negative, which is what you
want a code-search tool to produce when there is genuinely nothing to
find.

**What did not go to plan.**
1. **Ripgrep was not actually ripgrep.** Three attempts to call
   `execFileSync('rg', ...)` failed silently on this WSL system. The shell
   `which rg` returned a path, and `rg --version` printed `ripgrep 14.1.1`,
   so the first attempt *looked* like it had worked. It had not: this
   system's `rg` is a shell function that wraps the Claude CLI, masquerading
   as ripgrep. The `14.1.1` line was Claude reporting back through its
   shim. The actual ripgrep binary is not installed on this box. `which`
   also failed when called from a child process, because subprocess PATH
   inheritance does not see shell functions or aliases. Resolution:
   explicitly look in `/usr/local/bin/rg`, `/usr/bin/rg`, `/home/vara/.local/bin/rg`,
   etc. None of them exist on this box, so the scanner transparently falls
   back to the manual walker. Backend label is honest about that — the
   output reads `backend: manual-walker`, not a lie. Cost: a few hundred
   files walked in JS instead of C; total scan time still under a second
   on Recepta, so no practical impact.
2. The first attempt also had a TS1128 on a JSDoc comment that contained
   `'{**/}'` — the curly braces inside a backtick-string JSDoc were parsed
   as template substitution. Rephrased without the pattern. Same class of
   bug as the Day 3 `<boolean>` placeholders: prompts and comments read
   like prose but they have to parse cleanly.

**Known limitation, deliberately not fixed.** The scanner does no AST
awareness. It matches the symbol name anywhere it appears — including in
comments, strings, and unrelated variable names. Day 2's lesson was that
formatting-sensitive parsing is fragile and not worth the dependency; that
lesson applies here too. The per-symbol counts let a human spot that a
`session` symbol returning 227 matches is noise rather than a real signal,
which the verifier on Day 3 had to corroborate manually. A future
heuristic — e.g. "strip `//`, `/* */`, and string-literal matches before
counting" — would tighten this up but is not yet worth the engineering.

**Worth noting for Day 7 demo.** The "real negative" finding (Recepta is
not exposed) is as valuable as a "real positive" for the dogfood story:
it shows the pipeline does not raise false alarms when a real consumer
happens not to use a removed API. The Day 5 fix drafter's load is then
zero in this case — nothing to migrate — and that itself is a feature.

**Open question for Day 5–6.** The 1.34.6 → 1.34.7 story now has three
outcomes stacked: breaking (Day 3 confirmed), but Recepta is unaffected
(Day 4 confirmed). The 1.x → 2.0 upgrade flagged at the end of Day 1 may
be the stronger demo for Day 7 — it would exercise the "real positive"
path rather than the "real negative" path. Revisit when Day 5 lands.

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
