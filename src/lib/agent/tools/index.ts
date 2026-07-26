// ─── Tool catalog index ───────────────────────────────────────────────────
// Importing this file triggers self-registration of all tool modules. The
// /api/agent/command endpoint imports this once at module load so the
// registry is populated before the first request.
//
// To add a new tool: create a file in this directory and re-export nothing
// from this index. The side-effect of importing registerTool() runs the
// registration. Order doesn't matter (registry is a Map).

import './room-actions';
import './queries';
import './management';
// './reports' is GONE (2026-07-27 catalog rebuild). All five of its tools were
// stubs or duplicates: get_revenue / get_financial_report / compare_properties
// returned fixed "not integrated" notes, get_inventory duplicated get_low_stock
// against the wrong threshold column, and get_occupancy read the same counts RPC
// as get_today_summary. Their wire-names live on in TOOL_ALIASES.
import './walkthrough';
import './complaints';
import './lost-found';
import './financials';
import './pms-feeds';
import './knowledge';
import './memory';
import './comms-actions';
import './schedule-actions';
import './inventory-actions';
import './inventory-monthly-accounting';
import './reminders';
import './recurring-todos';
// The SEE tools (2026-07-27): what Staxis itself has noticed, the receipt
// behind it, what is waiting on a decision, preventive schedules, the equipment
// register, and whether the nightly check actually ran. All read-only.
import './staxis-findings';
// Cross-hotel chat. Every tool in here declares `surfaces: ['portfolio']`, so
// importing it does NOT widen the chat/voice/walkthrough catalogs — the surface
// filter in getToolsForRole keeps the two sets disjoint by construction.
import './portfolio';

// Future cross-feature tool modules (registered from other branches/chats)
// can be added by importing from agent/index.ts at the top level — this
// file is the canonical place for THIS chat's built-in catalog.
