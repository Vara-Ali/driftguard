-- DriftGuard Phase 2 — initial schema.
--
-- Apply once via the Supabase SQL editor on the dedicated DriftGuard project.
-- This file is the source of truth; do not split it into per-table migrations
-- until something here needs to change.
--
-- Single hardcoded dev user (00000000-0000-0000-0000-000000000001) backs the
-- Phase 2 single-user MVP. Real auth lands later — when it does, this row gets
-- replaced by a real session-backed user lookup at the call sites in
-- apps/api/src/routes/github.ts.

-- ─── Users ────────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  github_login  text unique not null,
  created_at    timestamptz not null default now()
);

-- Seed the dev user. The ID is fixed so the API can reference it without a
-- session lookup during Phase 2. ON CONFLICT keeps the file idempotent.
insert into users (id, github_login)
values ('00000000-0000-0000-0000-000000000001', 'Vara-Ali')
on conflict (id) do nothing;

-- ─── Organizations ────────────────────────────────────────────────────────
-- GitHub distinguishes user-owned installations from org-owned ones. The
-- `kind` column mirrors that: 'user' for personal-account installs,
-- 'organization' for org installs. One row per GitHub owner that has at
-- least one installation connected to DriftGuard.
create table if not exists organizations (
  id            uuid primary key default gen_random_uuid(),
  github_login  text unique not null,
  kind          text not null check (kind in ('user', 'organization')),
  created_at    timestamptz not null default now()
);

-- ─── Installations ────────────────────────────────────────────────────────
-- One row per GitHub App installation. github_installation_id is the GitHub-
-- assigned numeric id from the install callback. The current dev user (the
-- only authenticated principal in Phase 2) is recorded as `installed_by`.
create table if not exists installations (
  id                       uuid primary key default gen_random_uuid(),
  github_installation_id   bigint unique not null,
  owner_kind               text not null check (owner_kind in ('user', 'organization')),
  owner_github_login       text not null,
  installed_by_user_id     uuid not null references users(id),
  installed_at             timestamptz not null default now()
);

create index if not exists installations_owner_idx
  on installations (owner_github_login);

-- ─── Connected repos ──────────────────────────────────────────────────────
-- One row per repo the App is authorized on, scoped to its installation.
-- `repo_full_name` is "owner/name" and is the join key the rest of the API
-- uses to look up a repo.
create table if not exists connected_repos (
  id                uuid primary key default gen_random_uuid(),
  installation_id   uuid not null references installations(id) on delete cascade,
  repo_full_name    text not null,
  repo_id           bigint not null,
  default_branch    text not null,
  added_at          timestamptz not null default now(),
  unique (installation_id, repo_full_name)
);

create index if not exists connected_repos_installation_idx
  on connected_repos (installation_id);

-- ─── Install states (CSRF nonce for the OAuth-style callback) ─────────────
-- Single-use state tokens. The install endpoint writes one of these with a
-- 10-minute TTL; the callback reads-and-deletes it. Storing in DB instead of
-- memory so the nonce survives an API restart mid-install.
create table if not exists install_states (
  state        text primary key,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists install_states_expiry_idx
  on install_states (expires_at);
