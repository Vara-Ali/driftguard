# DriftGuard

An agent that watches your dependencies for silent breaking changes,
summarizes what changed, finds where your codebase uses the affected
methods, and drafts a fix — before it breaks production.

## Why

Third-party SDKs and packages ship breaking changes constantly, often
with no clear warning. Changelogs go unread. Nobody notices until
something silently fails in production — and then it takes hours to
figure out what changed and where it's used.

This project came out of a real incident: a silent internal API change
in `whatsapp-web.js` broke a production WhatsApp bot, and the fix had
to be found and patched manually. DriftGuard is the tool that should
have caught it first.

## What it does (in progress)

- Tracks a dependency for new published versions
- Pulls and summarizes the changelog/diff using an LLM
- Scans a target codebase for usages of affected methods
- Drafts a fix (as a report first, PR later)

## Status

Early build — see [PROJECT.md](./PROJECT.md) for the day-by-day build log.

## Tech stack

Node.js, TypeScript, npm registry API, GitHub API (Octokit), LLM API for
change summarization.

## License

TBD
