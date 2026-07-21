/** Secretless local-worktree sync is limited to a non-Vercel dev process. */
export function isExplicitLocalDevelopment(
  nodeEnv: string | undefined,
  vercelEnv: string | undefined,
): boolean {
  return nodeEnv === 'development' && !vercelEnv;
}
