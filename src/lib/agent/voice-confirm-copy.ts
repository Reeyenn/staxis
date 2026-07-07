// ─── Voice approval gate — deterministic spoken copy ────────────────────────
//
// The voice-brain route holds CARD-tier actions for spoken confirmation. The
// exact words spoken (a read-back on the turn we stage, and a cross-turn prompt
// note telling the model an action is awaiting a yes/no) are built HERE so they
// are:
//   • deterministic — always derived from buildActionSummary(toolName, args),
//     never model free-text, so the confirmation can't drift from what will run;
//   • bilingual EN/ES with real accented characters;
//   • unit-testable at a real seam (route handlers are awkward to import).
//
// Extracted from the route so the copy is the single source of truth and can be
// pinned by tests.

import { buildActionSummary } from './approval';

export type VoiceLang = 'en' | 'es';

/** en unless explicitly 'es'. staff.language may be ht/tl/vi — those collapse to
 *  en because the approval copy only exists in EN + ES. */
export function pickVoiceLang(lang: string | undefined | null): VoiceLang {
  return lang === 'es' ? 'es' : 'en';
}

/**
 * The read-back spoken on the turn a card-tier action is staged. `more` = true
 * when the model proposed more than one card this turn. We only stage the FIRST
 * one (voice holds one action at a time), so the copy asks the user to bring the
 * others up again after this one — it does NOT promise a queue (nothing persists
 * the un-staged proposals).
 */
export function buildSpokenReadback(
  toolName: string,
  toolArgs: Record<string, unknown>,
  lang: VoiceLang,
  more = false,
): string {
  const summary = buildActionSummary(toolName, toolArgs, lang);
  if (lang === 'es') {
    return (
      `Para confirmar — ${summary}. Di sí para continuar, o dime qué cambiar.` +
      (more ? ' Vamos de una en una — dime lo demás después de esta.' : '')
    );
  }
  return (
    `Just to confirm — ${summary}. Say yes to go ahead, or tell me what to change.` +
    (more ? " Let's do these one at a time — tell me the rest after this one." : '')
  );
}

/**
 * The cross-turn system-prompt block injected when a card-tier action is still
 * awaiting the user's spoken confirmation. Re-derived from the DB row every turn
 * (fits the stateless, history-replayed voice model) so no session mutation is
 * needed beyond the pending-actions table.
 */
export function buildPendingConfirmationPromptBlock(
  toolName: string,
  toolArgs: Record<string, unknown>,
  lang: VoiceLang,
): string {
  const summary = buildActionSummary(toolName, toolArgs, lang);
  if (lang === 'es') {
    return [
      '─── Acción esperando confirmación hablada ───',
      `UNA ACCIÓN ANTERIOR ESTÁ ESPERANDO LA CONFIRMACIÓN HABLADA DEL USUARIO: ${summary}.`,
      'Lo más probable es que el usuario esté respondiendo a esto ahora.',
      'Si acepta (sí / dale / hazlo / correcto / adelante), llama a confirm_pending_action.',
      'Si rechaza (no / cancela / olvídalo / déjalo / no importa), llama a cancel_pending_action.',
      'Si pide algo diferente, llama primero a cancel_pending_action y luego atiende la nueva solicitud.',
      'No vuelvas a leer la confirmación en voz alta; ya se le leyó. Después de confirmar o cancelar, di en UNA frase corta qué se hizo.',
    ].join('\n');
  }
  return [
    '─── Action awaiting spoken confirmation ───',
    `A PREVIOUS ACTION IS AWAITING THE USER'S SPOKEN CONFIRMATION: ${summary}.`,
    'The user is most likely responding to it right now.',
    'If they agree (yes / go ahead / do it / correct / sí / dale / hazlo), call confirm_pending_action.',
    'If they decline (no / cancel / never mind / stop / no importa), call cancel_pending_action.',
    'If they ask for something different, call cancel_pending_action FIRST, then handle the new request.',
    'Do NOT read the confirmation back again — it was already spoken. After confirming or cancelling, say in ONE short sentence what was done.',
  ].join('\n');
}
