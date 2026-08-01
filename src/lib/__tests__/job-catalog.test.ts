import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  ACTIVE_MISSION_JOBS,
  JOB_CATALOG,
  cronCadenceHours,
  type JobCatalogEntry,
} from '@/lib/automation/job-catalog';
import { SCHEDULE_REGISTRY } from '@/lib/cron-schedule-registry';

const ROOT = process.cwd();

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function routeFilesBelow(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...routeFilesBelow(path));
    else if (entry.name === 'route.ts') files.push(path);
  }
  return files;
}

function routePath(routeFile: string): string {
  const prefix = join(ROOT, 'src', 'app');
  return routeFile.slice(prefix.length).replace(/\/route\.ts$/, '');
}

function activeGithubSchedules(): string[] {
  const workflowsDir = join(ROOT, '.github', 'workflows');
  const rows: string[] = [];
  for (const workflowFile of readdirSync(workflowsDir).filter((file) => file.endsWith('.yml'))) {
    const content = readFileSync(join(workflowsDir, workflowFile), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = /^\s*-\s+cron:\s*['"]([^'"]+)['"](?:\s+#.*)?$/.exec(line);
      if (match) rows.push(`${workflowFile}|${match[1]}`);
    }
  }
  return sorted(rows);
}

function githubWorkflowRouteTargets(): string[] {
  const workflowsDir = join(ROOT, '.github', 'workflows');
  const targets = new Set<string>();
  const routePattern = /\/api\/cron\/[a-z0-9]+(?:-[a-z0-9]+)*(?![a-z0-9-])/g;
  for (const workflowFile of readdirSync(workflowsDir).filter((file) => file.endsWith('.yml'))) {
    const content = readFileSync(join(workflowsDir, workflowFile), 'utf8');
    for (const match of content.matchAll(routePattern)) targets.add(match[0]);
  }
  return sorted(targets);
}

describe('observational job catalog', () => {
  it('has unique ids and represents every lifecycle explicitly', () => {
    const ids = JOB_CATALOG.map((job) => job.id);
    assert.equal(new Set(ids).size, ids.length, 'job catalog ids must be unique');
    assert.deepEqual(
      sorted(new Set(JOB_CATALOG.map((job) => job.lifecycle))),
      ['active', 'event-driven', 'manual-only', 'retired', 'staged'],
    );
  });

  it('catalogs every /api/cron route and outside heartbeat route exactly once', () => {
    const cronRoot = join(ROOT, 'src', 'app', 'api', 'cron');
    const cronRoutePaths = readdirSync(cronRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        try {
          readFileSync(join(cronRoot, entry.name, 'route.ts'), 'utf8');
          return true;
        } catch {
          return false;
        }
      })
      .map((entry) => `/api/cron/${entry.name}`);
    const heartbeatRoutePaths = routeFilesBelow(join(ROOT, 'src', 'app', 'api'))
      .filter((file) => /writeCronHeartbeat\(\s*['"][^'"]+['"]/.test(readFileSync(file, 'utf8')))
      .map(routePath);
    const routePaths = new Set([...cronRoutePaths, ...heartbeatRoutePaths]);

    const catalogRouteJobs = JOB_CATALOG
      .filter((job) => job.target.kind === 'route')
      .map((job) => ({ job, path: job.target.kind === 'route' ? job.target.path : '' }));

    for (const path of routePaths) {
      assert.equal(
        catalogRouteJobs.filter((entry) => entry.path === path).length,
        1,
        `${path} must have exactly one catalog row`,
      );
    }
    for (const { job, path } of catalogRouteJobs) {
      if (routePaths.has(path)) continue;
      assert.equal(job.lifecycle, 'retired', `${path} is absent and may only be cataloged as retired`);
      assert.equal(job.source.kind, 'github', `${path} must remain referenced by a retained workflow`);
    }
  });

  it('catalogs every GitHub workflow, including manual and event-driven operations', () => {
    const workflowFiles = readdirSync(join(ROOT, '.github', 'workflows'))
      .filter((file) => file.endsWith('.yml'));
    const catalogWorkflowFiles = new Set<string>();
    for (const job of JOB_CATALOG) {
      if (job.source.kind === 'github') catalogWorkflowFiles.add(job.source.workflowFile);
      if (job.target.kind === 'workflow') catalogWorkflowFiles.add(job.target.workflowFile);
    }
    assert.deepEqual(sorted(catalogWorkflowFiles), sorted(workflowFiles));
  });

  it('catalogs every literal cron route targeted by a GitHub workflow', () => {
    const catalogTargets = new Set(
      JOB_CATALOG
        .filter((job) => job.target.kind === 'route')
        .map((job) => (job.target.kind === 'route' ? job.target.path : '')),
    );
    for (const target of githubWorkflowRouteTargets()) {
      assert.ok(catalogTargets.has(target), `workflow target ${target} is missing from the catalog`);
    }
  });

  it('matches every active Vercel schedule without generating or changing it', () => {
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
      crons?: Array<{ path: string; schedule: string }>;
    };
    const actual = sorted((vercel.crons ?? []).map((cron) => `${cron.path}|${cron.schedule}`));
    const catalog = sorted(
      JOB_CATALOG
        .filter((job) => job.lifecycle === 'active' && job.source.kind === 'vercel')
        .map((job) => `${job.target.kind === 'route' ? job.target.path : ''}|${job.schedule}`),
    );
    assert.deepEqual(catalog, actual);
  });

  it('matches every uncommented GitHub schedule without treating manual workflows as active', () => {
    const catalog = sorted(
      JOB_CATALOG
        .filter((job) => job.lifecycle === 'active' && job.source.kind === 'github')
        .map((job) => `${job.source.kind === 'github' ? job.source.workflowFile : ''}|${job.schedule}`),
    );
    assert.deepEqual(catalog, activeGithubSchedules());
  });

  it('never gives an inactive job an automatic schedule', () => {
    for (const job of JOB_CATALOG) {
      if (job.lifecycle === 'active') {
        assert.notEqual(job.schedule, null, `active job ${job.id} must identify its current schedule`);
        assert.ok(
          job.runner === 'vercel-cron' || job.runner === 'github-actions',
          `active job ${job.id} must identify its scheduler`,
        );
      } else {
        assert.equal(job.schedule, null, `${job.lifecycle} job ${job.id} must not carry an active schedule`);
      }
    }
  });

  it('keeps the legacy registry as an exact Mission Control projection', () => {
    const expected = ACTIVE_MISSION_JOBS.map((job) => ({
      heartbeatName: job.heartbeat.name,
      source: job.source.kind === 'vercel'
        ? { kind: 'vercel' as const, cronPath: job.target.kind === 'route' ? job.target.path : '' }
        : { kind: 'github' as const, workflowFile: job.source.kind === 'github' ? job.source.workflowFile : '' },
      cronExpr: job.schedule,
    }));
    assert.deepEqual(SCHEDULE_REGISTRY, expected);
  });

  it('matches catalog heartbeat names to route implementations', () => {
    const routeJobs = JOB_CATALOG.filter(
      (job): job is JobCatalogEntry & { target: { kind: 'route'; path: string } } => job.target.kind === 'route',
    );

    for (const job of routeJobs) {
      const routeFile = join(ROOT, 'src', 'app', job.target.path, 'route.ts');
      let content: string;
      try {
        content = readFileSync(routeFile, 'utf8');
      } catch {
        assert.equal(job.lifecycle, 'retired', `${job.id} targets a missing non-retired route`);
        continue;
      }
      const heartbeatNames = [...content.matchAll(/writeCronHeartbeat\(\s*['"]([^'"]+)['"]/g)]
        .map((match) => match[1]);
      if (heartbeatNames.length === 0) {
        assert.equal(job.heartbeat, null, `${job.id} catalogs a heartbeat but its route writes none`);
      } else {
        assert.ok(job.heartbeat, `${job.id} writes a heartbeat but the catalog omits it`);
        assert.ok(
          heartbeatNames.includes(job.heartbeat!.name),
          `${job.id} catalogs heartbeat ${job.heartbeat!.name}, route writes ${heartbeatNames.join(', ')}`,
        );
      }
    }
  });

  it('derives current cadence shapes used by monitoring', () => {
    assert.equal(cronCadenceHours('*/5 * * * *'), 5 / 60);
    assert.equal(cronCadenceHours('0 */6 * * *'), 6);
    assert.equal(cronCadenceHours('0 5 * * *'), 24);
    assert.equal(cronCadenceHours('0 9 * * 0'), 168);
  });
});
