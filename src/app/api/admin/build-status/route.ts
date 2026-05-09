/**
 * GET /api/admin/build-status
 *
 * Powers the Marvel/Loki-style timeline on the System tab.
 *
 * Returns:
 *   - commits: last ~12 commits on main from the GitHub API
 *   - deploys: what commit is live on Vercel (website) and Fly (CUA worker)
 *   - worktrees: active local Claude worktrees (only populated in dev —
 *     production has no .claude/worktrees/ directory)
 *
 * Falls back gracefully when external APIs fail or env vars are missing
 * — the System tab still renders, with whatever data it could gather.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const GITHUB_OWNER = 'Reeyenn';
const GITHUB_REPO = 'staxis';

interface Commit {
  sha: string;
  shortSha: string;
  message: string;       // first line only
  authorName: string;
  authorEmail: string;
  ts: string;
  url: string;           // GitHub commit URL
  // Aggregated state of all GitHub check-runs on this commit. null when
  // we couldn't fetch (no token, API failure) — UI treats null as "no
  // signal" and renders nothing rather than a misleading green tick.
  checkStatus?: 'passed' | 'failed' | 'pending' | 'neutral' | null;
}

interface Deploy {
  target: 'vercel-website' | 'fly-cua';
  commitSha: string | null;
  shortSha: string | null;
  deployedAt: string | null;
  url: string;
  // Phase 3 live state from provider APIs. Optional so the UI gracefully
  // handles the case where tokens aren't set (fall back to env-var
  // snapshot only).
  status?: 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' | 'QUEUED' | null;
  inProgress?: boolean;
  failed?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
}

interface Worktree {
  name: string;
  branch: string | null;
  lastActivity: string | null;
  // Populated when the worktree comes from local_worktrees (Reeyen's
  // machine sync). undefined when sourced from local fs scan in dev.
  dirtyFiles?: number;
  commitsAhead?: number;
  commitsBehind?: number;
  headMessage?: string | null;
}

interface Branch {
  name: string;
  shortSha: string;          // tip commit (7 chars)
  latestMessage: string;     // first line of tip commit message
  latestTs: string | null;   // ISO timestamp of tip commit
  aheadOfMain: number;       // commits unique to this branch
  behindMain: number;
  url: string;               // GitHub branch URL
}

interface MergedBranch {
  branchName: string;
  mergeCommitSha: string;    // commit on main where this branch came home
  mergedAt: string;          // ISO timestamp
  title: string;             // PR title
  url: string;               // PR URL
  commitCount: number;       // commits in the PR (used to size the arc)
}

interface Push {
  branch: string;            // ref the push went to
  ts: string;                // when github_events row was written ≈ when GitHub fired the webhook
  sha: string | null;        // head_commit sha if available
  commitMessage: string | null; // first line of head commit
}

interface OpenPR {
  number: number;
  title: string;
  branch: string;            // head ref
  url: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const [commits, deploys, worktrees, branches, merged, pushes, openPRs] = await Promise.all([
    fetchRecentCommits().catch(() => []),
    collectDeploys().catch(() => []),
    listWorktrees().catch(() => []),
    fetchActiveBranches().catch(() => []),
    fetchMergedBranches().catch(() => []),
    fetchRecentPushes().catch(() => []),
    fetchOpenPRs().catch(() => []),
  ]);

  // Phase 3 enrichment: live deploy status (Vercel/Fly APIs) + CI check
  // status on the latest commits. Both depend on commits[]/deploys[]
  // already being resolved, so they run in a second wave. Each enricher
  // is best-effort — failures fall back to the snapshot data.
  const [enrichedDeploys, commitsWithChecks] = await Promise.all([
    enrichDeploysWithLiveStatus(deploys).catch(() => deploys),
    enrichCommitsWithCheckStatus(commits).catch(() => commits),
  ]);

  // Newest activity timestamp across the repo. The UI uses this to flag
  // "main is alive right now" when a commit just landed.
  const mainLatestTs = commitsWithChecks[0]?.ts ?? null;

  return ok({
    commits: commitsWithChecks,
    deploys: enrichedDeploys,
    worktrees, branches, merged, pushes, openPRs,
    mainLatestTs,
    serverNow: new Date().toISOString(),
  }, { requestId });
}

async function fetchMergedBranches(): Promise<MergedBranch[]> {
  // Recently-merged PRs (Loki: "branches that came home"). We pull the
  // last 25 closed PRs and keep only the ones that actually merged
  // (closed-without-merge gets dropped).
  const headers: Record<string, string> = { 'User-Agent': 'staxis-admin' };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=25`,
    { headers, next: { revalidate: 10, tags: ['github-data'] } },
  );
  if (!res.ok) return [];
  const json = await res.json() as Array<{
    title: string;
    head: { ref: string };
    merge_commit_sha: string | null;
    merged_at: string | null;
    commits: number;
    html_url: string;
  }>;

  return json
    .filter((pr) => pr.merged_at !== null && pr.merge_commit_sha)
    .map((pr) => ({
      branchName: pr.head.ref,
      mergeCommitSha: pr.merge_commit_sha as string,
      mergedAt: pr.merged_at as string,
      title: pr.title,
      url: pr.html_url,
      commitCount: pr.commits ?? 1,
    }));
}

async function fetchActiveBranches(): Promise<Branch[]> {
  // List all branches (1 call) → compare each non-main against main in
  // parallel → keep the ones still ahead of main. That gives us the
  // "Loki branching off the sacred timeline" effect for any work that
  // hasn't merged yet.
  const headers: Record<string, string> = { 'User-Agent': 'staxis-admin' };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  // per_page=50 covers most reasonable repo branch counts. The GitHub
  // /branches endpoint returns ALPHABETICAL — there's no sort=updated
  // option — so a small cap silently drops branches whose names sort
  // late (e.g., "hotfix-*" was being missed when capped at 8). With
  // the GITHUB_TOKEN giving 5000/hr we can afford the broader fetch.
  const listRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/branches?per_page=50`,
    { headers, next: { revalidate: 10, tags: ['github-data'] } },
  );
  if (!listRes.ok) return [];
  const branches = await listRes.json() as Array<{ name: string; commit: { sha: string } }>;

  const nonMain = branches.filter((b) => b.name !== 'main' && b.name !== 'master');
  if (nonMain.length === 0) return [];

  const compares = await Promise.all(nonMain.map(async (b) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/main...${encodeURIComponent(b.name)}`,
        { headers, next: { revalidate: 10, tags: ['github-data'] } },
      );
      if (!res.ok) return null;
      const data = await res.json() as {
        ahead_by: number;
        behind_by: number;
        commits: Array<{ sha: string; commit: { message: string; author: { date: string } } }>;
      };
      const tip = data.commits[data.commits.length - 1];
      return {
        name: b.name,
        shortSha: b.commit.sha.slice(0, 7),
        latestMessage: tip ? tip.commit.message.split('\n')[0] : '',
        latestTs: tip ? tip.commit.author.date : null,
        aheadOfMain: data.ahead_by,
        behindMain: data.behind_by,
        url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tree/${encodeURIComponent(b.name)}`,
      } satisfies Branch;
    } catch {
      return null;
    }
  }));

  // Return ALL unmerged branches, newest-first. Reeyen's rule: he wants
  // to see everything on the timeline so nothing rots invisibly. The UI
  // adapts its lane-spacing to fit whatever count we send.
  return compares
    .filter((b): b is Branch => b !== null && b.aheadOfMain > 0)
    .sort((a, b) => (b.latestTs ?? '').localeCompare(a.latestTs ?? ''));
}

async function fetchRecentCommits(): Promise<Commit[]> {
  // per_page=100 (GitHub's max) so the System tab's "X commits today"
  // counter is accurate even on heavy days. With auth we have 5000
  // calls/hr, so the larger payload is free.
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?sha=main&per_page=100`;
  const headers: Record<string, string> = { 'User-Agent': 'staxis-admin' };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers, next: { revalidate: 10, tags: ['github-data'] } });
  if (!res.ok) return [];
  const json = await res.json() as Array<{
    sha: string;
    commit: { message: string; author: { name: string; email: string; date: string } };
    html_url: string;
  }>;

  return json.map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message: c.commit.message.split('\n')[0],
    authorName: c.commit.author.name,
    authorEmail: c.commit.author.email,
    ts: c.commit.author.date,
    url: c.html_url,
  }));
}

async function collectDeploys(): Promise<Deploy[]> {
  // Vercel sets VERCEL_GIT_COMMIT_SHA at build time. In dev that's empty.
  // We don't have a real "last deploy time" from Vercel without the API,
  // so we use the build timestamp baked at deploy time if present.
  const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  const vercelDeployTs = process.env.VERCEL_DEPLOYMENT_CREATED_AT ?? null;

  // For Fly we don't have an obvious env var. Best effort: leave the
  // deploy time null and let the UI say "see Fly dashboard".
  return [
    {
      target: 'vercel-website',
      commitSha: vercelSha,
      shortSha: vercelSha?.slice(0, 7) ?? null,
      deployedAt: vercelDeployTs,
      url: 'https://vercel.com/reeyenns-projects/staxis',
    },
    {
      target: 'fly-cua',
      commitSha: null,
      shortSha: null,
      deployedAt: null,
      url: 'https://fly.io/apps/staxis-cua',
    },
  ];
}

async function readWorktreesFromDb(): Promise<Worktree[]> {
  const { data, error } = await supabaseAdmin
    .from('local_worktrees')
    .select('name, branch, dirty_files, commits_ahead, commits_behind, head_committed_at, head_message, last_seen')
    .order('last_seen', { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return data.map((r) => ({
    name: r.name as string,
    branch: (r.branch as string | null) ?? null,
    lastActivity: (r.head_committed_at as string | null) ?? (r.last_seen as string | null),
    dirtyFiles: (r.dirty_files as number | null) ?? 0,
    commitsAhead: (r.commits_ahead as number | null) ?? 0,
    commitsBehind: (r.commits_behind as number | null) ?? 0,
    headMessage: (r.head_message as string | null) ?? null,
  }));
}

async function fetchRecentPushes(): Promise<Push[]> {
  // Pull push events from the last 5 minutes. The github-webhook route
  // writes a row per push (within ~250ms of the push happening on
  // GitHub) so this query gives us a precise "I just pushed" signal
  // distinct from commit-author-timestamp.
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('github_events')
    .select('event_type, branch, metadata, created_at')
    .eq('event_type', 'push')
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error || !data) return [];

  return data.map((row) => {
    const meta = (row.metadata ?? {}) as { head_commit?: string | null; commit_message?: string | null };
    // The webhook stores the GitHub `ref` in `branch` — that's
    // `refs/heads/<name>` for pushes. Strip the prefix so the UI can
    // match against branch names directly.
    const rawBranch = (row.branch as string | null) ?? '';
    const branch = rawBranch.startsWith('refs/heads/')
      ? rawBranch.slice('refs/heads/'.length)
      : rawBranch;
    return {
      branch,
      ts: row.created_at as string,
      sha: meta.head_commit ?? null,
      commitMessage: meta.commit_message ?? null,
    };
  }).filter((p) => p.branch.length > 0);
}

async function fetchOpenPRs(): Promise<OpenPR[]> {
  const headers: Record<string, string> = { 'User-Agent': 'staxis-admin' };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls?state=open&base=main&sort=updated&direction=desc&per_page=20`,
    { headers, next: { revalidate: 30, tags: ['github-data'] } },
  );
  if (!res.ok) return [];
  const json = await res.json() as Array<{
    number: number;
    title: string;
    head: { ref: string };
    html_url: string;
    draft: boolean;
    created_at: string;
    updated_at: string;
  }>;
  return json.map((pr) => ({
    number: pr.number,
    title: pr.title,
    branch: pr.head.ref,
    url: pr.html_url,
    draft: pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  }));
}

async function enrichCommitsWithCheckStatus(commits: Commit[]): Promise<Commit[]> {
  // GitHub /check-runs endpoint is per-commit, so we limit to the latest
  // 3 to keep the request count bounded. The latest commit is the one
  // that matters most — Reeyen wants to see "did the last thing I
  // pushed pass CI?" at a glance. Older commits' status would be
  // pure trivia.
  if (commits.length === 0) return commits;
  if (!process.env.GITHUB_TOKEN) return commits;
  const headers: Record<string, string> = {
    'User-Agent': 'staxis-admin',
    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
  };

  const targets = commits.slice(0, 3);
  const enriched = await Promise.all(targets.map(async (c) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${c.sha}/check-runs?per_page=30`,
        { headers, next: { revalidate: 20, tags: ['github-data'] } },
      );
      if (!res.ok) return { ...c, checkStatus: null };
      const json = await res.json() as {
        check_runs: Array<{ status: string; conclusion: string | null }>;
      };
      const runs = json.check_runs ?? [];
      if (runs.length === 0) return { ...c, checkStatus: null };

      // Collapse N runs into a single status:
      //   - any failure / timeout / action_required → 'failed'
      //   - any still-running (queued/in_progress) → 'pending'
      //   - all conclusion === 'success' → 'passed'
      //   - else → 'neutral'
      const failed = runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'action_required' || r.conclusion === 'cancelled');
      if (failed) return { ...c, checkStatus: 'failed' as const };
      const pending = runs.some((r) => r.status !== 'completed');
      if (pending) return { ...c, checkStatus: 'pending' as const };
      const allPass = runs.every((r) => r.conclusion === 'success' || r.conclusion === 'skipped' || r.conclusion === 'neutral');
      return { ...c, checkStatus: allPass ? 'passed' as const : 'neutral' as const };
    } catch {
      return { ...c, checkStatus: null };
    }
  }));

  // Stitch enriched results back over the originals. Anything past the
  // first 3 keeps its (undefined) checkStatus.
  return commits.map((c, i) => i < enriched.length ? enriched[i] : c);
}

async function fetchVercelDeployStatus(): Promise<Partial<Deploy> | null> {
  const token = process.env.VERCEL_API_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!token || !projectId) return null;
  try {
    const teamParam = process.env.VERCEL_TEAM_ID ? `&teamId=${process.env.VERCEL_TEAM_ID}` : '';
    const res = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=5${teamParam}`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        next: { revalidate: 15, tags: ['deploy-status'] },
      },
    );
    if (!res.ok) return null;
    const json = await res.json() as {
      deployments: Array<{
        uid: string;
        url: string;
        state: string;
        meta?: { githubCommitSha?: string };
        createdAt: number;
        ready?: number;
        buildingAt?: number;
      }>;
    };
    const latest = json.deployments?.[0];
    if (!latest) return null;
    // Vercel's "state" maps cleanly to our Deploy.status enum.
    const state = latest.state as Deploy['status'];
    const sha = latest.meta?.githubCommitSha ?? null;
    return {
      commitSha: sha,
      shortSha: sha?.slice(0, 7) ?? null,
      deployedAt: latest.ready ? new Date(latest.ready).toISOString() : null,
      startedAt: latest.buildingAt ? new Date(latest.buildingAt).toISOString() : new Date(latest.createdAt).toISOString(),
      finishedAt: latest.ready ? new Date(latest.ready).toISOString() : null,
      url: `https://${latest.url}`,
      status: state,
      inProgress: state === 'BUILDING' || state === 'QUEUED',
      failed: state === 'ERROR' || state === 'CANCELED',
    };
  } catch {
    return null;
  }
}

async function fetchFlyDeployStatus(): Promise<Partial<Deploy> | null> {
  const token = process.env.FLY_API_TOKEN;
  const app = process.env.FLY_APP_NAME ?? 'staxis-cua';
  if (!token) return null;
  try {
    // The Machines REST API doesn't expose a /releases endpoint, so we
    // use Fly's GraphQL gateway. Returns the last 3 releases ordered
    // newest-first; we take [0] for the current state.
    const res = await fetch(
      `https://api.fly.io/graphql`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `{ app(name:"${app}") { releases(first:3) { nodes { version status createdAt } } } }`,
        }),
        next: { revalidate: 15, tags: ['deploy-status'] },
      },
    );
    if (!res.ok) return null;
    const json = await res.json() as {
      data?: { app?: { releases?: { nodes?: Array<{ version: number; status: string; createdAt: string }> } } };
    };
    const latest = json.data?.app?.releases?.nodes?.[0];
    if (!latest) return null;
    // Fly statuses map: 'running'|'queued'|'pending' → BUILDING;
    // 'failed'|'cancelled'|'dead' → ERROR; 'complete'|'succeeded' → READY.
    let mapped: Deploy['status'] = null;
    const status = latest.status?.toLowerCase() ?? '';
    if (status === 'running' || status === 'pending' || status === 'queued') mapped = 'BUILDING';
    else if (status === 'failed' || status === 'cancelled' || status === 'dead') mapped = 'ERROR';
    else if (status === 'complete' || status === 'completed' || status === 'succeeded') mapped = 'READY';
    return {
      deployedAt: latest.createdAt,
      startedAt: latest.createdAt,
      finishedAt: mapped === 'READY' ? latest.createdAt : null,
      status: mapped,
      inProgress: mapped === 'BUILDING',
      failed: mapped === 'ERROR',
    };
  } catch {
    return null;
  }
}

async function enrichDeploysWithLiveStatus(deploys: Deploy[]): Promise<Deploy[]> {
  // Fetch both providers in parallel; merge into the snapshot deploys
  // returned by collectDeploys(). Failure of either falls through silently
  // — the timeline will just show the env-var snapshot for that target.
  const [vercel, fly] = await Promise.all([
    fetchVercelDeployStatus(),
    fetchFlyDeployStatus(),
  ]);
  return deploys.map((d) => {
    if (d.target === 'vercel-website' && vercel) return { ...d, ...vercel };
    if (d.target === 'fly-cua' && fly) return { ...d, ...fly };
    return d;
  });
}

async function listWorktrees(): Promise<Worktree[]> {
  // On Vercel: read Reeyen's worktree state from the local_worktrees
  // table (synced from his machine via /api/local-worktrees/sync).
  // The timeline becomes the single source of truth without needing
  // local filesystem access.
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return readWorktreesFromDb();
  }
  // Local dev: scan the filesystem directly.
  try {
    // Build path dynamically — avoids Turbopack's static analyzer bundling
    // every file under .claude/worktrees/ into the production output.
    const segments = ['.claude', 'worktrees'];
    const dir = join(process.cwd(), ...segments);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: Worktree[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const wtPath = join(dir, e.name);
      let branch: string | null = null;
      let lastActivity: string | null = null;
      try {
        const headPath = join(wtPath, '.git');
        // Could be a file (worktree) or directory (separate clone).
        // Read mtime as a "last activity" proxy.
        const stat = await fs.stat(wtPath);
        lastActivity = stat.mtime.toISOString();
        const headFile = await fs.readFile(join(wtPath, '.git', 'HEAD'), 'utf-8').catch(async () => {
          // worktree: .git is a file with `gitdir: ...`
          const gitFile = await fs.readFile(headPath, 'utf-8');
          const m = /gitdir:\s*(.+)/.exec(gitFile.trim());
          if (!m) return '';
          return await fs.readFile(join(m[1].trim(), 'HEAD'), 'utf-8');
        });
        const refMatch = /ref:\s*refs\/heads\/(.+)/.exec(headFile.trim());
        if (refMatch) branch = refMatch[1].trim();
      } catch {
        /* swallow per-worktree read errors */
      }
      out.push({ name: e.name, branch, lastActivity });
    }
    out.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    return out;
  } catch {
    return [];
  }
}
