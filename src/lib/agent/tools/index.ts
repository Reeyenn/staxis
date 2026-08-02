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
// stubs or duplicates: get_revenue / get_financial_report
// returned fixed "not integrated" notes, get_inventory duplicated get_low_stock
// against the wrong threshold column, and get_occupancy read the same counts RPC
// as get_today_summary. Surviving retired wire-names live on in TOOL_ALIASES.
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
// The DO wires (2026-07-27): setting the hotel up by talking to it, and
// answering Staxis in the conversation. Every tool in these two files declares
// `confirmInChat` — it proposes, reads back, and writes only after the ROUTE has
// recorded a message from the human since that read-back. See chat-confirm.ts.
import './staxis-setup';
import './staxis-decisions';
// The one-sentence supplier setup (2026-07-28). Same two-call shape: it
// proposes a structured vendor list, reads it back, and writes only after the
// route has recorded a human message since. See chat-confirm.ts.
import './ordering';
// The companion's one wire (2026-08-01): a manager teaches the hotel copilot a
// standing rule in plain language. Same two-call confirmInChat shape as the
// setup tools; the read-back is verbatim rather than structured, on purpose.
import './companion';
// Future cross-feature tool modules (registered from other branches/chats)
// can be added by importing from agent/index.ts at the top level — this
// file is the canonical place for THIS chat's built-in catalog.
