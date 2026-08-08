export type SignOutAction = () => Promise<void>;

export async function signOutAndNavigateToSignin(
  signOut: SignOutAction,
): Promise<void> {
  await signOut();
  // Deliberate sign-out is a full document transition so the newly signed-out
  // auth state cannot leave a stale protected tree mounted. Replacing the
  // current history entry also keeps Back from reopening that protected URL.
  window.location.replace('/signin');
}
