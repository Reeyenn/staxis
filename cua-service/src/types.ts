/**
 * Local types for the CUA worker. Subset of src/lib/pms/ in the main
 * Next.js app — kept in sync by hand for now (TODO: extract a shared
 * package once we have 2 consumers, this + scraper).
 */

export type PMSType =
  | 'choice_advantage'
  | 'opera_cloud'
  | 'cloudbeds'
  | 'roomkey'
  | 'skytouch'
  | 'webrezpro'
  | 'hotelogix'
  | 'other';

export interface PMSCredentials {
  loginUrl: string;
  username: string;
  password: string;
}

export type RoomCondition =
  | 'occupied' | 'vacant_clean' | 'vacant_dirty' | 'inspected' | 'out_of_order' | 'unknown';

export interface PMSArrival {
  guestName: string;
  roomNumber: string;
  arrivalDate: string;
  departureDate: string;
  numNights: number;
  numAdults?: number;
  numChildren?: number;
  rateCode?: string;
  confirmationNumber?: string;
  notes?: string;
}

export interface PMSDeparture {
  guestName: string;
  roomNumber: string;
  arrivalDate: string;
  departureDate: string;
  confirmationNumber?: string;
  checkedOut?: boolean;
}

export interface PMSRoomStatus {
  roomNumber: string;
  status: RoomCondition;
  guestName?: string;
  arrivalDate?: string;
  departureDate?: string;
  staySegment?: 'stayover' | 'checkout' | 'arrival' | null;
}

export interface PMSStaffMember {
  name: string;
  role?: string;
  phone?: string;
  email?: string;
  externalId?: string;
}

export interface PMSRoomDescriptor {
  roomNumber: string;
  floor?: string;
  type?: string;
  beds?: string;
}

// ─── Recipe shape (mirrors src/lib/pms/recipe.ts) ────────────────────────

export type RecipeStep =
  | { kind: 'goto';        url: string }
  | { kind: 'fill';        selector: string; value: '$username' | '$password' | string }
  | { kind: 'click';       selector: string }
  // Coordinate-based variants — used by the CUA mapper. Mirror in
  // src/lib/pms/recipe.ts.
  | { kind: 'click_at';    x: number; y: number }
  | { kind: 'type_text';   value: '$username' | '$password' | string }
  | { kind: 'wait_for';    selector: string; timeoutMs?: number }
  | { kind: 'wait_ms';     ms: number }
  | { kind: 'select';      selector: string; value: string }
  | { kind: 'press_key';   key: string }
  | { kind: 'eval_text';   selector: string; binding: string }
  | { kind: 'screenshot';  reason: string };

export interface LoginSteps {
  startUrl: string;
  steps: RecipeStep[];
  successSelectors: string[];
  timeoutMs?: number;
}

export interface CsvHint {
  columns: Record<string, string>;
  requiredColumn?: string;
}

export interface TableRowHint {
  rowSelector: string;
  columns: Record<string, string>;
  skipSelector?: string;
}

export type ParseHint =
  | { mode: 'csv';   hint: CsvHint }
  | { mode: 'table'; hint: TableRowHint }
  | { mode: 'inline_text'; fields: Record<string, string> };

export interface ActionRecipe {
  steps: RecipeStep[];
  parse: ParseHint;
  downloadsCsv?: boolean;
  acceptsDate?: boolean;
  acceptsDays?: boolean;
}

export interface Recipe {
  schema: 1;
  description?: string;
  login: LoginSteps;
  actions: {
    getArrivals?:        ActionRecipe;
    getDepartures?:      ActionRecipe;
    getRoomStatus?:      ActionRecipe;
    getStaffRoster?:     ActionRecipe;
    getRoomLayout?:      ActionRecipe;
    getDashboardCounts?: ActionRecipe;
    getHistoricalOccupancy?: ActionRecipe;
  };
  hints?: {
    dismissDialogs?: string[];
    scrollBeforeParse?: boolean;
  };
}

// ─── Job + recipe storage shapes ──────────────────────────────────────────

export interface OnboardingJob {
  id: string;
  property_id: string;
  pms_type: PMSType;
  status: 'queued' | 'running' | 'mapping' | 'extracting' | 'complete' | 'failed';
  step: string | null;
  progress_pct: number;
  result: Record<string, unknown> | null;
  error: string | null;
  error_detail: Record<string, unknown> | null;
  recipe_id: string | null;
  worker_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Set true by /api/admin/regenerate-recipe so the worker runs the
   *  CUA mapper even when an active recipe exists for this pms_type. */
  force_remap: boolean;
}

export interface ScraperCredentialsRow {
  property_id: string;
  pms_type: PMSType;
  ca_login_url: string;
  ca_username: string;
  ca_password: string;
  is_active: boolean;
}
