// ─── Agent action catalog ───────────────────────────────────────────────────
// Importing this file self-registers every built-in action. The engine and the
// /api/agents routes import it once so the registry is populated. Chat 3 adds
// new action modules and imports them here.
import './assign-rooms';
import './notify-manager';
import './_stubs';
