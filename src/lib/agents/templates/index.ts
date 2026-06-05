// ─── Agent template catalog ─────────────────────────────────────────────────
// Importing a template module self-registers it (see ./registry). Chat 2 adds
// the generic 'custom' planner so wizard-built agents are runnable; Chat 3 adds
// named template modules (e.g. './morning-turnover') and imports them here too.
import './custom';
