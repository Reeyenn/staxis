// Shared API response shapes — imported on both sides of the wire so the TS
// compiler catches client/server drift. The audit (Finding M6) flagged ~117
// browser `.json()` callers that each declared an ad-hoc shape; this module
// pulls the highest-traffic shapes into one place.
//
// Convention: each route's response payload (the `data` field inside
// `ApiResponse<T>`) gets a named interface here. The server's route handler
// uses `ok<X>({...})`; the client casts `(await res.json()) as ApiResponse<X>`
// (or the routes that don't use the ok/err envelope cast the raw shape).
//
// Add new shapes as M6 migration progresses. Keep this file thin — only put
// shapes here when there's at least one cross-team caller.

// Agent voice session (Eleven Labs session mint). Raw shape, no envelope.
export interface SessionMintResponse {
  ok: true;
  data: {
    sessionId: string;
    agentId?: string;
    signedUrl?: string;
    expiresAt?: string;
  };
}

// Stripe checkout — wrapped in the ok() envelope, so the client gets
// ApiResponse<StripeCheckoutData>.
export interface StripeCheckoutData {
  url: string;
  sessionId: string;
}

export interface StripePortalData {
  url: string;
}

// Auth / accounts
export interface InviteRow {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
}

export interface AccountRow {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
  username: string;
}

export interface InviteListResponse {
  data: { invites: InviteRow[] };
}

export interface TeamListResponse {
  data: { team: AccountRow[] };
}

// Housekeeper room-action
export interface RoomActionResponse {
  ok: true;
  data?: {
    roomNumber: string;
    previousStatus: string;
    newStatus: string;
  };
}

// Generic error envelope (already in api-response.ts but re-exported here for
// client-side imports that only need the shape).
export interface ApiErrorBody {
  ok: false;
  error: string;
  code?: string;
  requestId?: string;
}
