// ─── Action: notify_manager ─────────────────────────────────────────────────
// In-app only (no SMS, no guest contact) → auto-eligible. Posts to the
// property's announcement feed via comms/core.postAnnouncement, driven by the
// SAME EN/ES the receipt shows (no bilingual split-brain).

import { registerAction } from './registry';
import { postAnnouncement } from '@/lib/comms/core';
import { validateString } from '@/lib/api-validate';
import type { AgentActionContext, AgentActionResult } from '@/lib/agents/types';

interface NotifyManagerPayload {
  message: string;
  messageEs?: string;
}

registerAction<NotifyManagerPayload>({
  key: 'notify_manager',
  label: { en: 'Notify the team', es: 'Notificar al equipo' },
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Message body (English)' },
      messageEs: { type: 'string', description: 'Optional Spanish translation' },
    },
    required: ['message'],
  },
  spendsMoney: false,
  contactsGuest: false,
  validate(raw: unknown): { error?: string; value?: NotifyManagerPayload } {
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const msg = validateString(body.message, { max: 2000, label: 'message' });
    if (msg.error) return { error: msg.error };
    let messageEs: string | undefined;
    if (body.messageEs !== undefined && body.messageEs !== null && body.messageEs !== '') {
      const es = validateString(body.messageEs, { max: 2000, label: 'messageEs' });
      if (es.error) return { error: es.error };
      messageEs = es.value;
    }
    return { value: { message: msg.value!, messageEs } };
  },
  async execute(payload: NotifyManagerPayload, ctx: AgentActionContext): Promise<AgentActionResult> {
    try {
      const res = await postAnnouncement(ctx.propertyId, {
        body: payload.message,
        sourceLang: 'en',
        senderStaffId: null,
        senderAccountId: ctx.costAccountId,
        bodyEs: payload.messageEs ?? null,
      });
      return { ok: true, result: { messageId: res.id } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
  describe(payload: NotifyManagerPayload) {
    return {
      key: 'agents.action.notify_manager.describe',
      params: { message: payload.message },
      en: `Would post to the team: "${payload.message}"`,
      es: `Publicaría al equipo: "${payload.messageEs ?? payload.message}"`,
    };
  },
});
