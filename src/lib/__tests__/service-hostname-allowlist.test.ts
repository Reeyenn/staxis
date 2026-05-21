/**
 * Tests for the service-to-service hostname allowlist in src/lib/env.ts.
 *
 * Plan v2 F-AI-6 + F-AI-14: a compromised env editor that flips
 * RAILWAY_SCRAPER_URL / ML_SERVICE_URLS / VERCEL_DOCTOR_URL to an
 * attacker host would redirect bearer secrets on the next cron tick.
 * The allowlist closes that vector at env-parse time.
 *
 * Strategy: env.ts re-parses on every property access (via the Proxy),
 * so flipping process.env between cases is enough to exercise the
 * NODE_ENV=production gate. We don't import `env` directly because
 * that would also pull in many other modules; we re-construct the
 * smallest schema fragment that wraps the helpers.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = ['NODE_ENV', 'VERCEL_ENV', 'ML_SERVICE_URLS', 'RAILWAY_SCRAPER_URL', 'VERCEL_DOCTOR_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // Fresh require so the inner allowlist constants are re-read.
  delete require.cache[require.resolve('@/lib/env')];
});

function freshEnv(): typeof import('@/lib/env').env {
  delete require.cache[require.resolve('@/lib/env')];
  return require('@/lib/env').env;
}

describe('hostname allowlist — prod gate', () => {
  test('bypassed in dev (NODE_ENV unset)', () => {
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    process.env.RAILWAY_SCRAPER_URL = 'https://attacker.example/scrape';
    // Should NOT throw — the bypass for non-prod environments lets the
    // value through. The security boundary is "Vercel prod deploys",
    // not "any time the env module loads".
    const env = freshEnv();
    assert.equal(env.RAILWAY_SCRAPER_URL, 'https://attacker.example/scrape');
  });

  test('enforced when NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VERCEL_ENV;
    process.env.RAILWAY_SCRAPER_URL = 'https://attacker.example/scrape';
    // parseEnv wraps the Zod refine message — the thrown Error message
    // names the offending var.
    assert.throws(() => freshEnv(), /RAILWAY_SCRAPER_URL/);
  });

  test('enforced when VERCEL_ENV=production', () => {
    delete process.env.NODE_ENV;
    process.env.VERCEL_ENV = 'production';
    process.env.RAILWAY_SCRAPER_URL = 'https://attacker.example/scrape';
    assert.throws(() => freshEnv(), /RAILWAY_SCRAPER_URL/);
  });

  test('allows *.railway.app in prod', () => {
    process.env.NODE_ENV = 'production';
    process.env.RAILWAY_SCRAPER_URL = 'https://hotelops-scraper-prod.up.railway.app';
    const env = freshEnv();
    assert.equal(env.RAILWAY_SCRAPER_URL, 'https://hotelops-scraper-prod.up.railway.app');
  });

  test('allows hotelops-ai.vercel.app in prod', () => {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_DOCTOR_URL = 'https://hotelops-ai.vercel.app/api/admin/doctor';
    const env = freshEnv();
    assert.equal(env.VERCEL_DOCTOR_URL, 'https://hotelops-ai.vercel.app/api/admin/doctor');
  });

  test('allows getstaxis.com in prod', () => {
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_DOCTOR_URL = 'https://getstaxis.com/api/admin/doctor';
    const env = freshEnv();
    assert.equal(env.VERCEL_DOCTOR_URL, 'https://getstaxis.com/api/admin/doctor');
  });

  test('rejects ML_SERVICE_URLS containing an off-allowlist entry', () => {
    process.env.NODE_ENV = 'production';
    process.env.ML_SERVICE_URLS = 'https://staxis-ml.railway.app,https://attacker.example';
    assert.throws(() => freshEnv(), /ML_SERVICE_URLS/);
  });

  test('accepts ML_SERVICE_URLS with all-allowlist entries', () => {
    process.env.NODE_ENV = 'production';
    process.env.ML_SERVICE_URLS = 'https://staxis-ml-1.railway.app,https://staxis-ml-2.fly.dev';
    const env = freshEnv();
    assert.equal(env.ML_SERVICE_URLS, 'https://staxis-ml-1.railway.app,https://staxis-ml-2.fly.dev');
  });
});
