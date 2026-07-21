/**
 * Repository-wide migration policy.
 *
 * A superseded migration remains in the directory as historical evidence but
 * must never be applied to any environment. Keep this list shared by the
 * doctor, drift checker, and bulk applier so an operator cannot accidentally
 * execute a migration that a different tool intentionally ignores.
 */

export const SUPERSEDED_MIGRATIONS: ReadonlySet<string> = new Set([
  // 0162 would replace mfa_verified_or_grace() with a missing-claim deny.
  // It was never applied to production and is explicitly superseded by 0311,
  // whose global 2FA switch and trusted-device grace are load-bearing.
  '0162',
]);

export function migrationVersion(filename: string): string | null {
  return /^(\d{4})_.+\.sql$/.exec(filename)?.[1] ?? null;
}

export function applicableMigrationFiles(files: ReadonlyArray<string>): string[] {
  return files.filter((filename) => {
    const version = migrationVersion(filename);
    return version !== null && !SUPERSEDED_MIGRATIONS.has(version);
  });
}
