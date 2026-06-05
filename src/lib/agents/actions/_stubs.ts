// ─── Declared-but-stubbed actions ───────────────────────────────────────────
// Full contract NOW (key, bilingual label, input schema, money/guest flags,
// pure describe()) so the wizard (Chat 2) can offer them and Chat 3 only fills
// in execute(). execute() returns a clear not-implemented result; the engine
// records it as a soft failure (status 'executed', result.ok=false) rather
// than throwing.
//
// send_staff_sms / draft_purchase_order spend money or text people → forced
// approve_first. message_guest contacts a guest → forced approve_first.

import { registerAction } from './registry';
import { validateString, validateUuid, validateEnum, validateInt } from '@/lib/api-validate';
import type { AgentActionResult, AgentActionDef } from '@/lib/agents/types';

const TODO = (key: string): AgentActionResult => ({
  ok: false,
  error: `Action "${key}" is declared but not yet implemented (Chat 3).`,
});

// send_staff_sms — wraps enqueueSms later. Twilio cost ⇒ spendsMoney.
const sendStaffSms: AgentActionDef<{ staffId: string; message: string }> = {
  key: 'send_staff_sms',
  label: { en: 'Text a staff member', es: 'Enviar SMS a un empleado' },
  inputSchema: {
    type: 'object',
    properties: {
      staffId: { type: 'string', description: 'staff.id to text' },
      message: { type: 'string', description: 'SMS body' },
    },
    required: ['staffId', 'message'],
  },
  spendsMoney: true,
  contactsGuest: false,
  validate(raw) {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = validateUuid(b.staffId, 'staffId');
    if (id.error) return { error: id.error };
    const m = validateString(b.message, { max: 1600, label: 'message' });
    if (m.error) return { error: m.error };
    return { value: { staffId: id.value!, message: m.value! } };
  },
  async execute() { return TODO('send_staff_sms'); },
  describe(p) {
    return {
      key: 'agents.action.send_staff_sms.describe',
      params: { staffId: p.staffId },
      en: `Would text a staff member: "${p.message}"`,
      es: `Enviaría un SMS a un empleado: "${p.message}"`,
    };
  },
};

const createWorkOrder: AgentActionDef<{ location: string; description: string; priority: string }> = {
  key: 'create_work_order',
  label: { en: 'Create a work order', es: 'Crear una orden de trabajo' },
  inputSchema: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string', enum: ['urgent', 'normal', 'low'] },
    },
    required: ['location', 'description'],
  },
  spendsMoney: false,
  contactsGuest: false,
  validate(raw) {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const loc = validateString(b.location, { max: 200, label: 'location' });
    if (loc.error) return { error: loc.error };
    const desc = validateString(b.description, { max: 1000, label: 'description' });
    if (desc.error) return { error: desc.error };
    const pri = validateEnum(b.priority ?? 'normal', ['urgent', 'normal', 'low'] as const, 'priority');
    if (pri.error) return { error: pri.error };
    return { value: { location: loc.value!, description: desc.value!, priority: pri.value! } };
  },
  async execute() { return TODO('create_work_order'); },
  describe(p) {
    return {
      key: 'agents.action.create_work_order.describe',
      params: { location: p.location, priority: p.priority },
      en: `Would open a ${p.priority} work order at ${p.location}: "${p.description}"`,
      es: `Abriría una orden de trabajo (${p.priority}) en ${p.location}: "${p.description}"`,
    };
  },
};

const createComplaint: AgentActionDef<{ description: string; roomNumber?: string }> = {
  key: 'create_complaint',
  label: { en: 'Log a guest complaint', es: 'Registrar una queja de huésped' },
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      roomNumber: { type: 'string' },
    },
    required: ['description'],
  },
  spendsMoney: false,
  contactsGuest: false,
  validate(raw) {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const desc = validateString(b.description, { max: 1000, label: 'description' });
    if (desc.error) return { error: desc.error };
    let roomNumber: string | undefined;
    if (b.roomNumber !== undefined && b.roomNumber !== null && b.roomNumber !== '') {
      const rn = validateString(b.roomNumber, { max: 10, label: 'roomNumber' });
      if (rn.error) return { error: rn.error };
      roomNumber = rn.value;
    }
    return { value: { description: desc.value!, roomNumber } };
  },
  async execute() { return TODO('create_complaint'); },
  describe(p) {
    return {
      key: 'agents.action.create_complaint.describe',
      params: { roomNumber: p.roomNumber ?? null },
      en: `Would log a complaint${p.roomNumber ? ` for room ${p.roomNumber}` : ''}: "${p.description}"`,
      es: `Registraría una queja${p.roomNumber ? ` para la habitación ${p.roomNumber}` : ''}: "${p.description}"`,
    };
  },
};

// draft_purchase_order — money handled in CENTS. spendsMoney ⇒ approve_first.
const draftPurchaseOrder: AgentActionDef<{ vendorId?: string; amountCents?: number; note?: string }> = {
  key: 'draft_purchase_order',
  label: { en: 'Draft a purchase order', es: 'Redactar una orden de compra' },
  inputSchema: {
    type: 'object',
    properties: {
      vendorId: { type: 'string' },
      amountCents: { type: 'integer', description: 'Amount in cents' },
      note: { type: 'string' },
    },
  },
  spendsMoney: true,
  contactsGuest: false,
  validate(raw) {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out: { vendorId?: string; amountCents?: number; note?: string } = {};
    if (b.vendorId !== undefined && b.vendorId !== null && b.vendorId !== '') {
      const v = validateUuid(b.vendorId, 'vendorId');
      if (v.error) return { error: v.error };
      out.vendorId = v.value;
    }
    if (b.amountCents !== undefined && b.amountCents !== null) {
      const a = validateInt(b.amountCents, { min: 0, max: 100_000_000, label: 'amountCents' });
      if (a.error) return { error: a.error };
      out.amountCents = a.value;
    }
    if (b.note !== undefined && b.note !== null && b.note !== '') {
      const n = validateString(b.note, { max: 500, label: 'note' });
      if (n.error) return { error: n.error };
      out.note = n.value;
    }
    return { value: out };
  },
  async execute() { return TODO('draft_purchase_order'); },
  describe(p) {
    const dollars = p.amountCents !== undefined ? `$${(p.amountCents / 100).toFixed(2)}` : 'an unspecified amount';
    return {
      key: 'agents.action.draft_purchase_order.describe',
      params: { amountCents: p.amountCents ?? null },
      en: `Would draft a purchase order for ${dollars} (pending approval).`,
      es: `Redactaría una orden de compra por ${dollars} (pendiente de aprobación).`,
    };
  },
};

const messageGuest: AgentActionDef<{ message: string; guestPhone?: string }> = {
  key: 'message_guest',
  label: { en: 'Message a guest', es: 'Enviar mensaje a un huésped' },
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      guestPhone: { type: 'string' },
    },
    required: ['message'],
  },
  spendsMoney: false,
  contactsGuest: true,
  validate(raw) {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const m = validateString(b.message, { max: 1000, label: 'message' });
    if (m.error) return { error: m.error };
    let guestPhone: string | undefined;
    if (b.guestPhone !== undefined && b.guestPhone !== null && b.guestPhone !== '') {
      const p = validateString(b.guestPhone, { max: 20, label: 'guestPhone' });
      if (p.error) return { error: p.error };
      guestPhone = p.value;
    }
    return { value: { message: m.value!, guestPhone } };
  },
  async execute() { return TODO('message_guest'); },
  describe(p) {
    return {
      key: 'agents.action.message_guest.describe',
      params: {},
      en: `Would message the guest: "${p.message}"`,
      es: `Enviaría un mensaje al huésped: "${p.message}"`,
    };
  },
};

registerAction(sendStaffSms);
registerAction(createWorkOrder);
registerAction(createComplaint);
registerAction(draftPurchaseOrder);
registerAction(messageGuest);
