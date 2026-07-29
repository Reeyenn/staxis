import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/**
 * Subscribe only to the caller's non-sensitive authorization-version row.
 * The event is never treated as authority: it is an invalidation signal that
 * makes AuthContext re-read the no-store server authorization endpoint.
 */
export function subscribeToSessionAuthorizationInvalidations(input: {
  client: Pick<SupabaseClient, 'channel' | 'removeChannel'>;
  authUid: string;
  onInvalidate: () => void;
}): () => void {
  const channel = input.client
    .channel(`session-authorization:${input.authUid}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'account_authorization_notifications',
      filter: `data_user_id=eq.${input.authUid}`,
    }, input.onInvalidate)
    .subscribe((status) => {
      // Close the read-before-subscribe race and every reconnect gap. A role
      // change that committed before the socket became ready emits no event to
      // this channel, so readiness itself must force a fresh server verdict.
      if (status === 'SUBSCRIBED') input.onInvalidate();
    });

  return () => {
    void input.client.removeChannel(channel as RealtimeChannel);
  };
}
