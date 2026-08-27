# Registering the DriftGuard GitHub App

Phase 2 replaces the personal access token (PAT) used in Days 1–6 with a
proper GitHub App. Apps are the right shape for any future multi-user product
because one App serves many installations, and installation tokens are
short-lived (one hour) and repo-scoped.

This doc walks through the one-time setup. The App credentials are entered
into your local `.env` only — they never appear in `.env.example`, never
appear in chat, and never appear in any committed file.

## Where the App lives

1. Open <https://github.com/settings/apps/new> (or **Settings → Developer
   settings → GitHub Apps → New GitHub App**).
2. If you're registering the App under your personal account, choose **Owned
   by account**. If you're registering it under an organization, choose the
   org.

## Field-by-field

| Field | Value | Notes |
| --- | --- | --- |
| GitHub App name | `driftguard-dev` (or `driftguard-dev-<your-handle>`) | Must be unique across all of GitHub. |
| Description | `Watches npm dependencies for breaking changes and opens draft fix PRs.` | |
| Homepage URL | `http://localhost:3000/repositories` | Local dev only. Change before production. |
| Callback URL | `http://localhost:4000/api/github/callback` | The API server handles this — do not change per-environment without updating the API code. |
| Request user authorization (OAuth) during installation | ✅ enabled | Required so `getInstallationAccount` can read the owner metadata. |
| Webhook | ⛔ **Disabled** for now | Webhooks are out of scope for Phase 2; we use polling-on-render instead. Set the webhook URL field to `http://localhost:4000/api/github/webhook` only if you later enable it. |

### Repository permissions

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | Create the fix branch and push commits. |
| Pull requests | Read and write | Open the draft PR. |
| Metadata | Read-only | Default — required by GitHub for every App. |

### Account permissions

| Permission | Access | Why |
| --- | --- | --- |
| (none) | — | Phase 2 doesn't read profile data. |

### Subscribe to events

Leave empty. The install flow doesn't need webhook events.

### Where can this GitHub App be installed?

Pick **Only on this account** for local dev. If you want to test against
multiple GitHub users/orgs later, switch to **Any account**.

## After saving

Everything you need lives on the App's **General** page. There is no
separate "OAuth App" page — GitHub Apps surface the OAuth credentials
inline.

1. **App ID** — numeric, near the top of the General page. → `GITHUB_APP_ID`.
2. **Client ID** — string starting with `Iv1.`, just below the App ID. →
   `GITHUB_APP_CLIENT_ID`.
3. Scroll to **Client secrets** → click **Generate a new client secret**.
   Copy the value immediately. This is `GITHUB_APP_CLIENT_SECRET`. (You
   cannot see it again; you can only regenerate it.)
4. Click **Generate a private key** under **Private keys**. A `.pem`
   file downloads. **Do not commit this file.** Open it in any text
   editor; the contents (including `-----BEGIN RSA PRIVATE KEY-----` and
   `-----END RSA PRIVATE KEY-----` lines) are what you paste into
   `GITHUB_APP_PRIVATE_KEY` (with `\n` escapes — see below).
5. In the left sidebar of the App's settings page, click **Identify your
   app** → **Public link** — it shows the slug (e.g.
   `github.com/apps/driftguard-dev`). The slug is `GITHUB_APP_SLUG`.

## Pasting into `.env`

Open `/mnt/c/Users/Vara/projects/Self-Maintaining APIs/.env`. Add the
Phase 2 block from `.env.example`, substituting real values. The
private key is the only tricky one — `.env` does not support real
multi-line values, so use literal `\n` where the .pem has line breaks:

```bash
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n...\n-----END RSA PRIVATE KEY-----"
```

The API server (`apps/api/src/github-app.ts`) replaces `\n` with real
newlines at startup, so the App's JWT signer sees a valid PEM.

## Sanity check

After restarting the API:

```bash
cd "/mnt/c/Users/Vara/projects/Self-Maintaining APIs/apps/api"
npm run dev
```

The boot log should **not** print `GITHUB_APP_ID is not set`. If it does,
the `.env` value didn't load — confirm you restarted the API after
saving `.env`.

Then visit `http://localhost:3000/repositories` in a browser and click
**Connect GitHub**. You should land on GitHub's App install page, pick
the `driftguard-e2e-target` repo, and bounce back to the dashboard
with the repo listed.

If you instead see a 500 from `/api/github/install` complaining about
missing env vars, re-check the variable names match exactly:
`GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`.

## Rotating a leaked secret

If any of these values ever leak (committed by accident, posted in
chat, etc.):

- **Client secret** — App settings → Client secrets → Regenerate.
- **Private key** — App settings → Private keys → Revoke the old key,
  generate a new one. The JWT signed by the old key stops working
  immediately.
- **App ID and slug** — cannot be rotated. If they leak, the impact is
  limited (they're public-ish anyway once the App is installed on
  any public repo), but you can delete and re-register the App if
  needed.
