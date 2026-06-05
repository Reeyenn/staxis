// Pure presentation helpers that DRIVE the agent UI render (labels, tones,
// badges, trigger/date formatting, error → message). Imports only contract
// types + the sibling pure `strings` module, so the unit tests load under
// `tsx --conditions=react-server`. No React, no api/fetch, no supabase.

import type {
  AgentStatus, RunStatus, ActionStatus, ActionApprovalMode,
  AgentActionStep, TriggerConfig, BilingualText,
} from '@/lib/agents/types';
import { AGENT_EVENT_CATALOG } from '@/lib/agents/types';
import { s, S, type Lang } from './strings';

/** Matches the PillTone union in _tokens — kept as plain literals here so this
 *  module never imports the React token file. */
export type Tone = 'neutral' | 'sage' | 'warm' | 'caramel' | 'red' | 'purple' | 'ink';

/** Pick the right language from a backend `{ en, es }` object. */
export function pickBilingual(b: Pick<BilingualText, 'en' | 'es'> | undefined | null, lang: Lang): string {
  if (!b) return '';
  return lang === 'es' ? b.es : b.en;
}

/** Step receipt text is FLAT (describeEn / describeEs), not a {en,es} object. */
export function stepDescribe(step: AgentActionStep, lang: Lang): string {
  return lang === 'es' ? step.describeEs : step.describeEn;
}

/** Which transparency badges a step/action shows. */
export function actionBadges(a: { spendsMoney: boolean; contactsGuest: boolean }): Array<'money' | 'guest'> {
  const out: Array<'money' | 'guest'> = [];
  if (a.spendsMoney) out.push('money');
  if (a.contactsGuest) out.push('guest');
  return out;
}

// ── agent status ──
export function agentStatusTone(status: AgentStatus): Tone {
  return ({ draft: 'neutral', active: 'sage', paused: 'caramel', archived: 'red' } as const)[status];
}
export function agentStatusLabel(status: AgentStatus, lang: Lang): string {
  const en = { draft: 'Draft', active: 'Active', paused: 'Paused', archived: 'Archived' }[status];
  const es = { draft: 'Borrador', active: 'Activo', paused: 'Pausado', archived: 'Archivado' }[status];
  return lang === 'es' ? es : en;
}

// ── run status ──
export function runStatusTone(status: RunStatus): Tone {
  return ({ running: 'neutral', success: 'sage', failed: 'red', awaiting_approval: 'caramel' } as const)[status];
}
export function runStatusLabel(status: RunStatus, lang: Lang): string {
  const en = { running: 'Running', success: 'Done', failed: 'Failed', awaiting_approval: 'Awaiting approval' }[status];
  const es = { running: 'En curso', success: 'Listo', failed: 'Falló', awaiting_approval: 'Pendiente de aprobación' }[status];
  return lang === 'es' ? es : en;
}

// ── action-step status ──
export function actionStatusTone(status: ActionStatus): Tone {
  return ({
    proposed: 'neutral', pending_approval: 'caramel', approved: 'sage', rejected: 'red',
    executed: 'sage', skipped: 'neutral', simulated: 'purple',
  } as const)[status];
}
export function actionStatusLabel(status: ActionStatus, lang: Lang): string {
  const en: Record<ActionStatus, string> = {
    proposed: 'Suggested', pending_approval: 'Waiting', approved: 'Approved', rejected: 'Rejected',
    executed: 'Done', skipped: 'Skipped', simulated: 'Would do',
  };
  const es: Record<ActionStatus, string> = {
    proposed: 'Sugerido', pending_approval: 'En espera', approved: 'Aprobado', rejected: 'Rechazado',
    executed: 'Hecho', skipped: 'Omitido', simulated: 'Haría',
  };
  return (lang === 'es' ? es : en)[status];
}

// ── safety dial mode ──
export function modeLabel(mode: ActionApprovalMode, lang: Lang): string {
  if (mode === 'suggest') return s(lang, 'modeSuggest');
  if (mode === 'approve_first') return s(lang, 'modeApprove');
  return s(lang, 'modeAuto');
}

// ── time / date ──
const DAY_SHORT: Record<Lang, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  es: ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'],
};

/** 'HH:MM' (24h) → '8:00 AM'. Returns the input unchanged if unparseable. */
export function formatTime12(hhmm: string, lang: Lang): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = m[2];
  if (h < 0 || h > 23) return hhmm;
  const ampm = h < 12 ? (lang === 'es' ? 'a. m.' : 'AM') : (lang === 'es' ? 'p. m.' : 'PM');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${ampm}`;
}

/** Plain-language trigger summary for review/detail. */
export function formatTrigger(trigger: TriggerConfig, lang: Lang): string {
  if (trigger.type === 'event') {
    const ev = AGENT_EVENT_CATALOG.find((e) => e.name === trigger.eventName);
    return ev ? pickBilingual(ev.label, lang) : trigger.eventName;
  }
  const at = formatTime12(trigger.atLocalTime, lang);
  const days = trigger.daysOfWeek;
  if (!days || days.length === 0 || days.length === 7) {
    return lang === 'es' ? `${s(lang, 'everyDay')} a las ${at}` : `${s(lang, 'everyDay')} at ${at}`;
  }
  const names = [...days].sort((a, b) => a - b).map((d) => DAY_SHORT[lang][d] ?? String(d));
  const list = names.join(', ');
  return lang === 'es' ? `${list} a las ${at}` : `${list} at ${at}`;
}

/** Localized ISO datetime → short display. Locale/timezone dependent (not unit-tested). */
export function formatDateTime(iso: string | null, lang: Lang): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** 'YYYY-MM-DD' → localized date (no timezone shift). */
export function formatLocalDate(ymd: string | null, lang: Lang): string {
  if (!ymd) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── errors ──
export interface ApiError {
  status: number;
  code?: string;
  serverDetail?: string;
}

/** Turn a structured client error into a manager-friendly, localized message.
 *  429s never surface the raw `rate_limited` token. */
export function errorToMessage(err: ApiError | null | undefined, lang: Lang): string {
  if (!err) return s(lang, 'somethingWrong');
  if (err.status === 429) return s(lang, 'rateLimited');
  if (err.serverDetail && err.serverDetail.trim()) return err.serverDetail;
  return s(lang, 'somethingWrong');
}

/** Today as 'YYYY-MM-DD' in the browser's local time (for the test-on-a-date max). */
export function todayLocalYmd(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** N days before today as 'YYYY-MM-DD' (for the test-on-a-date min). */
export function daysAgoLocalYmd(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// re-export for components that want the raw dictionary access
export { S };
