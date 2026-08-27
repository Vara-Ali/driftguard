# DriftGuard Architecture

A plain-language walk-through of how DriftGuard is built and why. Written so
a non-engineer (PM, investor, customer engineer) can read it end-to-end and
understand what runs where, how customer data is handled, and why it
actually works on private repositories.

## What it is

DriftGuard watches npm dependencies in a customer's repositories and
proactively drafts a pull request when one of them ships a breaking change.
It does three things today's manual workflow doesn't:

1. **Detects** the breaking change the moment the package is published,
   using LLM-based summarization of the changelog + type diff.
2. **Locates** every place in the customer's codebase that uses the
   affected API.
3. **Drafts** a fix and opens a draft pull request on the customer's repo,
   so the engineer reviews and merges instead of starting from zero.

The customer never sees DriftGuard run. They see a draft PR in their repo
the way they'd see one from a human teammate.

---

## Components

There are four moving pieces. Each one has a clear job and a clear
boundary.

| Component | What it does | Where it runs |
|---|---|---|
| **GitHub App** (`driftguard-dev`) | Identity that DriftGuard uses to act on customer repos. Issues short-lived installation tokens. | GitHub-hosted. Registered once; installed per-customer. |
| **Dashboard** (Next.js) | Customer-facing UI: connect GitHub, view check history, see per-symbol detail. | Public hosting (Vercel / Cloudflare Pages / similar). |
| **Backend API** (Node + Express) | The engine: gathers change data, asks the LLM for a verdict, scans the customer repo, drafts fixes, opens the PR. | Private infrastructure (VPC, dedicated VM, or serverless with warm containers). |
| **Database** (Supabase Postgres) | Tracks which customer installed which GitHub App on which repos. Holds install + repo metadata only. | Supabase (managed). |

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│   Customer  │───▶│  Dashboard   │───▶│  Backend    │
│   Browser   │    │  (Next.js)   │    │  (Express)  │
└─────────────┘    └──────────────┘    └──────┬──────┘
                                               │
                              ┌────────────────┼──────────────────┐
                              ▼                ▼                  ▼
                       ┌─────────────┐  ┌─────────────┐    ┌────────────┐
                       │  Supabase   │  │  MiniMax    │    │  GitHub    │
                       │  Postgres   │  │  LLM API    │    │  REST API  │
                       └─────────────┘  └─────────────┘    └────────────┘
                                                              ▲
                                                              │
                                                       ┌──────┴───────┐
                                                       │  Customer's  │
                                                       │  Repository  │
                                                       └──────────────┘
```

---

## Where each piece lives, in detail

### GitHub App (`driftguard-dev`)

- Lives in **GitHub's infrastructure**, registered to Vara-Ali's account
  for now. GitHub Apps are not deployed — they're a registered identity
  that gets installed by customers on a per-account basis.
- DriftGuard stores the App's private key (`GITHUB_APP_PRIVATE_KEY`),
  client ID, client secret, and webhook secret in the backend's secret
  store (env vars, never committed).
- One App, many installations: every customer that wants to use DriftGuard
  installs the same App on their account. Each installation gets a unique
  numeric ID that the backend uses to mint short-lived tokens.
- **The App has zero access to any customer's code until that customer
  installs it.** Installing is the consent step.

### Dashboard (Next.js)

- **Hosted publicly.** This is the part customers see and click around in.
  Vercel / Netlify / Cloudflare Pages all work; pick whichever the
  operator prefers.
- The dashboard itself **never reads customer source code**. It's a
  metadata viewer — install status, check history, per-symbol summaries.
- The dashboard talks only to the backend (not to GitHub, not to the
  customer's repo). Every action the user can take on the dashboard
  ("Run a check", "Open PR") is a single backend call.

### Backend (Node + Express)

- This is where the actual work happens: pulling npm metadata, calling
  the LLM, scanning the customer's repo, opening the draft PR.
- **It runs on private infrastructure.** A VPC, a dedicated VM, or a
  serverless platform (Railway, Fly, Render) with enough warm time to
  complete an LLM-backed fix-draft in one shot. It's not a public service
  — there's no anonymous endpoint that takes arbitrary input.
- The backend needs two kinds of credentials: the GitHub App's private
  key (to mint installation tokens) and the MiniMax API key (to ask the
  LLM for verdicts and fix suggestions).
- **The customer never talks to the backend directly.** They go through
  the dashboard, which is the only public surface.

### Database (Supabase Postgres)

- Holds the customer ↔ installation ↔ repo mapping. Five tables today:
  `users`, `organizations`, `installations`, `connected_repos`,
  `install_states`.
- Single dev user for Phase 2. Real auth (Supabase Auth or similar) comes
  in Phase 3.
- **No customer source code is stored in this database, ever.** It holds
  metadata only — repo names, default branches, install timestamps.

---

## Onboarding flow

The first time a customer uses DriftGuard:

1. **Customer visits the dashboard** at `https://driftguard.example.com`.
2. **Customer clicks "Connect GitHub".** The dashboard sends them to the
   API's `/api/github/install` endpoint.
3. **The API generates a CSRF nonce** (a one-time random string), stores
   it in `install_states` with a 10-minute expiry, and 302-redirects the
   customer to `https://github.com/apps/driftguard-dev/installations/new?state=<nonce>`.
4. **GitHub shows the standard install UI** — customer picks which
   account / org, which repos.
5. **Customer authorizes.** GitHub redirects to the API's
   `/api/github/callback?installation_id=<id>&state=<nonce>`.
6. **The API verifies the nonce** (deletes it from `install_states` so it
   can't be replayed).
7. **The API uses the GitHub App's private key** to ask GitHub "give me an
   access token for installation `<id>`." GitHub returns a token scoped
   only to the repos the customer just authorized. **One hour expiry.**
8. **The API lists the customer's authorized repos** using that token and
   writes one row per repo to `connected_repos`. The installation row
   itself goes into `installations`.
9. **The API redirects the customer back to the dashboard's Repositories
   page.** A success banner confirms the connection.

After onboarding, every check the customer runs follows the same path:
**dashboard → backend → GitHub → draft PR.** The customer never has to
re-authorize unless they revoke the App or the install expires.

---

## What happens during a check

When a customer clicks **Run a check** for a (package, from, to) triple:

1. The dashboard POSTs to the backend's `/api/checks` with the package
   names, versions, the target repo path on the backend's machine, and
   the customer's installation id.
2. **Stage 1 — gather:** the backend fetches the package's npm metadata,
   release notes, and type diff for the version range.
3. **Stage 2 — verdict:** the backend asks the LLM "is this change
   breaking, and which methods/symbols are affected?" The LLM returns a
   structured verdict + confidence.
4. **Stage 3 — scan:** if breaking AND a target repo path was given, the
   backend greps the customer's repo for usages of each affected symbol.
   **This scan happens locally on the backend's machine** (or in a
   short-lived container) — the customer repo is cloned once via the
   installation token, scanned, and the clone is discarded.
5. **Stage 4 — fix-draft:** for every symbol with matches, the backend
   asks the LLM "given this call site, what's the smallest change that
   makes it work with the new version?" Suggestions are tagged HIGH /
   MEDIUM / LOW confidence.
6. **Stage 5 — apply + push:** HIGH-confidence suggestions are written to
   a new branch in the customer's repo (via the installation token) and
   pushed.
7. **Stage 6 — open draft PR:** the backend opens a draft PR against the
   customer's default branch with the LLM's summary as the body. The
   engineer reviews and merges like any other PR.

The whole flow uses **only the installation token** for repo write
operations — never the customer's personal credentials, never a long-lived
PAT that could be leaked.

---

## Why it works with private repositories

GitHub Apps, once installed on an account or org, get scoped access to
exactly the repos the customer authorized. The installation token GitHub
issues in step 7 of onboarding carries those scopes. So:

- **Public repos:** DriftGuard can read them, write to them, open PRs.
- **Private repos:** same — provided the customer authorized them at
  install time.
- **Repos the customer did NOT authorize:** DriftGuard has zero access.
  Calls return 404 from GitHub.

This is the same model that Sentry, Dependabot, Vercel, and every other
modern dev tool uses. It's the reason GitHub Apps exist as a separate
concept from personal access tokens.

---

## Security model

What DriftGuard **does** have access to:

- Repo metadata the customer authorized at install time: name, default
  branch, ID.
- Source code in the authorized repos (read + write).
- Ability to create branches and open PRs.

What DriftGuard **does not** have access to:

- The customer's personal GitHub credentials. It uses the App's private
  key, not the customer's PAT or OAuth token.
- Repos the customer did not authorize.
- Anything outside the customer's repos (no org settings, no billing, no
  members).
- Anything past the install's scope (webhooks must be subscribed; secrets
  must be granted; etc. — DriftGuard asks for the minimum).

How data is protected:

| Concern | Mitigation |
|---|---|
| Token theft | Installation tokens expire in 1 hour. The App's private key lives only on the backend, in env vars, never committed. If the backend is breached, rotation is one click on GitHub. |
| Customer code in our DB | We never write customer source to Postgres. Only metadata (repo name, branch name, PR URL) is stored. |
| Customer code in logs | Logs scrub PII paths. The backend logs run IDs and package versions, never file contents. |
| Customer code leaving our infra | Source code stays in the backend process / local clone during scan. Only redacted snippets (the call site + the suggested fix) are sent to the LLM during fix-draft. The LLM API call is the only outbound network hop that touches code. |
| CSRF on install | The `state` nonce in the OAuth-style callback is single-use, short-lived, and stored in Postgres with a 10-minute TTL. Replay returns 400. |
| Compromised dashboard | Dashboard is read-only metadata; can't trigger PRs without a backend call. Backend requires installation id from a DB row, not user input. |

What a customer should know before installing:

- DriftGuard will read source code in the repos they authorize.
- DriftGuard will create branches and draft PRs.
- DriftGuard will call an external LLM with redacted snippets from those
  repos during fix drafting.
- DriftGuard stores **metadata only** about the install — repo names,
  branch names, PR URLs. No source code.

For most B2B SaaS customers that's acceptable; for highly regulated
environments (HIPAA, finance) they'd want a self-hosted backend option.
That's Phase 4+ territory.

---

## Why a customer would use this

- **Catch breaking changes before they reach production.** Today, most
  teams find out a major version broke something when staging fails or a
  customer reports a bug.
- **Save the engineer from "where is this even called?"** The scan stage
  surfaces every affected call site automatically — the engineer doesn't
  have to grep through thousands of files.
- **Skip the blank-page problem.** The LLM-drafted fix isn't always
  mergeable as-is, but it gives the engineer a concrete starting point
  instead of an empty editor.
- **Pipeline fit.** DriftGuard fits between Dependabot (which opens
  version-bump PRs) and a senior engineer's afternoon (which is what
  usually gets spent cleaning up the resulting breakage).

---

## Current state (where we are today)

- ✅ Engine: change detection + LLM verdict + repo scan + fix drafting +
  PR creation. Validated end-to-end on a disposable repo.
- ✅ Phase 1: HTTP API exposing the engine on `:4000` and a Next.js
  dashboard on `:3000`. Read endpoints pull from a JSONL run history.
- ✅ Phase 2: GitHub App replaces PAT auth. Install flow lands
  installation + repo metadata in Supabase. Installation tokens
  authenticate every PR-creating action.
- ⏳ Phase 3 (planned): real user auth (Supabase Auth or similar), per-
  installation settings (which packages to watch, scan paths to exclude,
  default PR base branch), the Findings page (per-symbol detail view).
- ⏳ Phase 4 (planned): self-hosted backend option for regulated
  customers; billing; team accounts.

---

## Glossary

- **GitHub App** — a first-class identity registered with GitHub that
  installs onto accounts/orgs. Different from a personal access token
  (PAT) or an OAuth App.
- **Installation** — one customer's authorization of the App on their
  account. Each installation has a unique numeric ID.
- **Installation token** — short-lived (1 hour) bearer token issued by
  GitHub, scoped to the repos the customer authorized. This is what
  DriftGuard uses for repo operations.
- **App-level JWT** — the token the backend mints using the App's private
  key. Used only to talk to GitHub's `/app/*` endpoints (including
  exchanging for an installation token). Never used for repo ops.
- **Draft PR** — a pull request marked as a draft. GitHub does not block
  it from being merged, but the UI signals "not ready for review." This
  is the right shape for AI-generated fixes — the engineer reviews the
  diff before merging.
