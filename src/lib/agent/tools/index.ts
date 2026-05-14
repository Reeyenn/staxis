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
import './reports';
import './walkthrough';

// Future cross-feature tool modules (registered from other branches/chats)
// can be added by importing from agent/index.ts at the top level — this
// file is the canonical place for THIS chat's built-in catalog.
