/** Only these Auth responses prove the remote user is already absent. */
export function isConfirmedAuthUserNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; code?: unknown };
  return value.status === 404 || value.code === 'user_not_found';
}
