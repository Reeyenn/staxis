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
}

interface Deploy {
  target: 'vercel-website' | 'fly-cua';
  commitSha: string | null;
  shortSha: string | null;
  deployedAt: string | null;
  url: string;
}

interface Worktree {
  name: string;
  branch: string | null;
  lastActivity: string | null;
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

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const [commits, deploys, worktrees, branches, merged] = await Promise.all([
    fetchRecentCommits().catch(() => []),
    collectDeploys().catch(() => []),
    listWorktrees().catch(() => []),
    fetchActiveBranches().catch(() => []),
    fetchMergedBranches().catch(() => []),
  ]);

  // Newest activity timestamp across the repo. The UI uses this to flag
  // "main is alive right now" when a commit just landed.
  const mainLatestTs = commits[0]?.ts ?? null;

  return ok({
    commits, deploys, worktrees, branches, merged,
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
    { headers, next: { revalidate: 10 } },
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

  // per_page=8 caps the compare loop below at 8 GitHub round-trips per
  // refresh. Combined with the 10s server cache and 10s client poll
  // (REFRESH_MS in SystemTab), we use ~3960 calls/hr against the 5000/hr
  // authenticated quota.
  const listRes = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/branches?per_page=8`,
    { headers, next: { revalidate: 10 } },
  );
  if (!listRes.ok) return [];
  const branches = await listRes.json() as Array<{ name: string; commit: { sha: string } }>;

  const nonMain = branches.filter((b) => b.name !== 'main' && b.name !== 'master');
  if (nonMain.length === 0) return [];

  const compares = await Promise.all(nonMain.map(async (b) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/main...${encodeURIComponent(b.name)}`,
        { headers, next: { revalidate: 10 } },
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

  return compares
    .filter((b): b is Branch => b !== null && b.aheadOfMain > 0)
    .sort((a, b) => (b.latestTs ?? '').localeCompare(a.latestTs ?? ''))
    .slice(0, 8);
}

async function fetchRecentCommits(): Promise<Commit[]> {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?sha=main&per_page=12`;
  const headers: Record<string, string> = { 'User-Agent': 'staxis-admin' };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers, next: { revalidate: 10 } });
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

async function listWorktrees(): Promise<Worktree[]> {
  // .claude/worktrees/ only exists on Reeyen's dev machine. On Vercel we
  // skip outright — both because the dir doesn't exist and because letting
  // Turbopack walk into it during `next build` bundles thousands of files
  // by mistake.
  if (process.env.VERCEL || process.env.VERCEL_ENV) return [];
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
