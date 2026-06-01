// Maintenance → Work Orders tab.
// "The book replacement." Two statuses only: open + done.
// Submit → Open list (grouped by priority) → tap → Mark Done → History.

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { supabase } from '@/lib/supabase';
import {
  subscribeToWorkOrders, addWorkOrder, markWorkOrderDone,
} from '@/lib/db';
import type { WorkOrder, WorkOrderPriority } from '@/types';
import { Btn, Caps, Pill } from '@/app/housekeeping/_components/_snow';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  PrioDot, PrioPill, prioColor, prioLabel, prioOrder,
  Avatar, Modal, Field, TextInput, TextArea, ChipChoose, PhotoSlot,
  StorageImage, fmtDate, fmtDateShort, fmtSubmittedAt,
} from './_mt-snow';

// Friendlier "role" labels for the byline. AppRole is admin/staff; we map
// to the language operators actually use.
function roleLabel(role: string | undefined): string {
  if (role === 'admin') return 'General manager';
  return 'Staff';
}

// Format the location for display. If it looks like just a room number,
// prefix "Rm "; otherwise show verbatim.
function displayLoc(loc: string): string {
  const trimmed = (loc || '').trim();
  if (/^\d{1,4}$/.test(trimmed)) return `Rm ${trimmed}`;
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────
// CARD — used in the Open list
// ─────────────────────────────────────────────────────────────────────────
function OpenCard({ w, onOpen }: { w: WorkOrder; onOpen: (w: WorkOrder) => void }) {
  return (
    <button onClick={() => onOpen(w)} style={{
      textAlign: 'left', cursor: 'pointer',
      background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 14,
      padding: '16px 22px 16px 26px', display: 'grid',
      gridTemplateColumns: 'minmax(140px, 1fr) 2fr auto', gap: 18, alignItems: 'center',
      width: '100%', position: 'relative', overflow: 'hidden',
    }}>
      {/* slim priority accent bar on the left edge */}
      <span style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 4,
        background: prioColor[w.priority],
      }}/>

      {/* location */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 24, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 400 }}>
          {displayLoc(w.location)}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.06em' }}>
          {w.id.slice(0, 8)}
        </span>
      </div>

      {/* description + submitter */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink, fontWeight: 500, lineHeight: 1.4 }}>
          {w.description}
        </span>
        <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {w.submitterPhotoPath && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              📷 photo
            </span>
          )}
          <span>
            {w.submittedByName || 'Unknown'}
            {w.submitterRole ? ` · ${w.submitterRole}` : ''}
          </span>
          <span style={{ color: T.ink3 }}>·</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
            {fmtSubmittedAt(w.createdAt)}
          </span>
        </span>
      </div>

      {/* chevron */}
      <span style={{
        fontFamily: FONT_SERIF, fontSize: 24, color: T.ink2, fontStyle: 'italic',
        letterSpacing: '-0.02em', lineHeight: 1,
      }}>→</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ROW — History
// ─────────────────────────────────────────────────────────────────────────
function HistoryRow({ w }: { w: WorkOrder }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '120px 1fr 130px 110px 80px',
      gap: 14, padding: '14px 0', borderBottom: `1px solid ${T.ruleSoft}`,
      alignItems: 'center',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: FONT_SERIF, fontSize: 18, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 400 }}>
          {displayLoc(w.location)}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.04em' }}>{w.id.slice(0, 8)}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{w.description}</span>
        {w.completionNote && (
          <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, fontStyle: 'italic' }}>
            “{w.completionNote}”
          </span>
        )}
      </div>
      <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>
        {w.completedByName || '—'}
      </span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: T.ink2 }}>
        {w.completedAt ? fmtDateShort(w.completedAt) : '—'}
      </span>
      <Pill tone="sage">✓ Done</Pill>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// SUBMIT FORM — modal
// ─────────────────────────────────────────────────────────────────────────
function SubmitModal({
  open, onClose, onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (args: {
    location: string;
    description: string;
    priority: WorkOrderPriority;
    photo: File | null;
  }) => Promise<void>;
}) {
  const { user } = useAuth();
  const [loc, setLoc] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<WorkOrderPriority>('normal');
  const [photo, setPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setLoc(''); setDescription(''); setPriority('normal'); setPhoto(null);
  };
  const close = () => { reset(); onClose(); };

  const canSubmit = loc.trim().length > 0 && description.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit({
        location: loc.trim(),
        description: description.trim(),
        priority,
        photo,
      });
      reset();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="What's broken?"
      subtitle="Anyone on the team can submit. It goes straight to the open list."
      width={580}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={close}>Cancel</Btn>
          <Btn
            variant="primary"
            size="md"
            onClick={submit}
            disabled={!canSubmit}
            style={{ opacity: canSubmit ? 1 : 0.4 }}
          >
            {busy ? 'Submitting…' : 'Submit work order'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* location */}
        <Field label="Location" required hint="Room number, common area, anything specific.">
          <TextInput value={loc} onChange={setLoc} placeholder='e.g. "Room 312" or "Lobby"' />
        </Field>

        {/* description */}
        <Field label="What's wrong?" required hint="Plain words. The way you'd write it in the book.">
          <TextArea
            value={description}
            onChange={setDescription}
            placeholder="e.g. AC blowing warm air. Filter looked dirty."
            rows={3}
          />
        </Field>

        {/* priority */}
        <Field label="Priority">
          <ChipChoose<WorkOrderPriority>
            options={[
              { value: 'urgent', label: 'Urgent' },
              { value: 'normal', label: 'Normal' },
              { value: 'low',    label: 'Low'    },
            ]}
            value={priority}
            onChange={setPriority}
            render={(opt) => (
              <>
                <PrioDot p={opt.value} size={10} />
                {opt.label}
              </>
            )}
          />
        </Field>

        {/* photo */}
        <Field label="Photo" hint="Optional. A picture saves a thousand words.">
          <PhotoSlot file={photo} onFileChange={setPhoto} />
        </Field>

        {/* submitter (autofill) */}
        <div style={{
          background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 10,
          padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <Avatar name={user?.displayName || 'You'} tone="#688372" size={28} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>
              Submitted by {user?.displayName || 'you'}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {roleLabel(user?.role)} · auto-filled · timestamp set on submit
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DETAIL MODAL — view + mark done
// ─────────────────────────────────────────────────────────────────────────
function DetailModal({
  w, open, onClose, onDone,
}: {
  w: WorkOrder | null;
  open: boolean;
  onClose: () => void;
  onDone: (id: string, args: { note: string; completionPhoto: File | null }) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [completionPhoto, setCompletionPhoto] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!open) { setNote(''); setCompletionPhoto(null); setBusy(false); } }, [open]);

  if (!w) return null;

  const close = () => { setNote(''); setCompletionPhoto(null); onClose(); };
  const done = async () => {
    setBusy(true);
    try {
      await onDone(w.id, { note: note.trim(), completionPhoto });
      setNote(''); setCompletionPhoto(null);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={displayLoc(w.location)}
      subtitle={w.id.slice(0, 8)}
      width={580}
      footer={
        <>
          <Btn variant="ghost" size="md" onClick={close}>Close</Btn>
          <Btn variant="primary" size="md" onClick={done} disabled={busy}>
            {busy ? 'Saving…' : '✓ Mark done'}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* priority + age */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <PrioPill p={w.priority} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Open · submitted {fmtSubmittedAt(w.createdAt)}
          </span>
        </div>

        {/* description */}
        <div>
          <Caps>What&apos;s wrong</Caps>
          <p style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, margin: '8px 0 0', lineHeight: 1.35, fontWeight: 400, letterSpacing: '-0.01em' }}>
            {w.description}
          </p>
        </div>

        {/* photo */}
        {w.submitterPhotoPath && (
          <div>
            <Caps>Photo</Caps>
            <div style={{ marginTop: 8 }}>
              <StorageImage path={w.submitterPhotoPath} alt="submitter photo" />
            </div>
          </div>
        )}

        {/* submitter */}
        <div style={{
          background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 10,
          padding: '10px 14px',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <Avatar name={w.submittedByName || '?'} tone={T.ink2} size={28} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>
              {w.submittedByName || 'Unknown'}
            </span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: T.ink3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {w.submitterRole || 'Staff'} · {fmtSubmittedAt(w.createdAt)}
            </span>
          </div>
        </div>

        {/* completion note */}
        <div style={{ padding: '18px 0 0', borderTop: `1px solid ${T.rule}` }}>
          <Caps>When you&apos;re done</Caps>
          <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '4px 0 12px', fontStyle: 'italic' }}>
            Optional. Future-you will thank present-you for the note.
          </p>
          <TextArea
            value={note}
            onChange={setNote}
            placeholder={'e.g. "Replaced filter, unit is old, will need full replacement soon"'}
            rows={2}
          />
          <div style={{ marginTop: 10 }}>
            <PhotoSlot
              file={completionPhoto}
              onFileChange={setCompletionPhoto}
              label="Completion photo (optional)"
              height={100}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// HISTORY VIEW
// ─────────────────────────────────────────────────────────────────────────
function HistoryView({ orders, onBack }: { orders: WorkOrder[]; onBack: () => void }) {
  const [q, setQ] = useState('');

  const done = orders.filter(o => o.status === 'done');
  const filtered = done.filter(o => {
    if (!q) return true;
    const hay = `${o.location} ${o.description} ${o.completedByName ?? ''} ${o.id}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, gap: 24, flexWrap: 'wrap' }}>
        <div>
          <Caps>Work orders · history</Caps>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400, whiteSpace: 'nowrap' }}>
            <span style={{ fontStyle: 'italic' }}>{done.length} resolved</span>
            <span style={{ color: T.ink3 }}> · everything ever done</span>
          </h1>
        </div>
        <Btn variant="ghost" size="sm" onClick={onBack}>← Back to open</Btn>
      </div>

      <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18, padding: '18px 24px' }}>
        {/* search + date range + export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 14, borderBottom: `1px solid ${T.rule}`, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search room, description, or who fixed it…"
            style={{
              flex: 1, minWidth: 240, height: 36, padding: '0 14px', borderRadius: 10,
              background: T.bg, border: `1px solid ${T.rule}`,
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink, outline: 'none',
            }}
          />
          <Btn variant="ghost" size="sm">Date range ▾</Btn>
          <Btn variant="ghost" size="sm">Export ↓</Btn>
        </div>

        {/* column headers */}
        <div style={{
          display: 'grid', gridTemplateColumns: '120px 1fr 130px 110px 80px',
          gap: 14, padding: '14px 0', borderBottom: `1px solid ${T.ruleSoft}`,
        }}>
          <Caps size={9}>Where</Caps>
          <Caps size={9}>What & note</Caps>
          <Caps size={9}>Fixed by</Caps>
          <Caps size={9}>Completed</Caps>
          <Caps size={9}>Status</Caps>
        </div>

        {filtered.length === 0 && (
          <div style={{ padding: '40px 0', textAlign: 'center' }}>
            <span style={{ fontFamily: FONT_SERIF, fontSize: 18, color: T.ink2, fontStyle: 'italic' }}>
              {q ? 'Nothing matches that search.' : 'Nothing done yet.'}
            </span>
          </div>
        )}
        {filtered.map(w => <HistoryRow key={w.id} w={w} />)}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// OPEN VIEW
// ─────────────────────────────────────────────────────────────────────────
function OpenView({
  orders, onOpen, onShowHistory, onSubmit,
}: {
  orders: WorkOrder[];
  onOpen: (w: WorkOrder) => void;
  onShowHistory: () => void;
  onSubmit: () => void;
}) {
  const open = orders.filter(o => o.status === 'open');
  const done = orders.filter(o => o.status === 'done');

  // Group by priority, oldest-first within each group.
  const groups = prioOrder.map(p => ({
    p,
    items: open
      .filter(o => o.priority === p)
      .sort((a, b) =>
        (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
      ),
  })).filter(g => g.items.length > 0);

  return (
    <div>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, gap: 24, flexWrap: 'wrap' }}>
        <div>
          <Caps>Work orders · today</Caps>
          <h1 style={{ fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0', letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400, whiteSpace: 'nowrap' }}>
            <span style={{ fontStyle: 'italic' }}>{open.length} open</span>
            <span style={{ color: T.ink3 }}> · {done.length} done</span>
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="ghost" size="md" onClick={onShowHistory}>History ({done.length}) →</Btn>
          <Btn variant="primary" size="md" onClick={onSubmit}>＋ New work order</Btn>
        </div>
      </div>

      {/* empty state */}
      {open.length === 0 && (
        <div style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
          padding: '48px 24px', textAlign: 'center',
        }}>
          <span style={{ fontFamily: FONT_SERIF, fontSize: 28, color: T.ink, fontStyle: 'italic', letterSpacing: '-0.02em', fontWeight: 400, lineHeight: 1.3 }}>
            All caught up.
          </span>
          <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2, margin: '8px 0 18px' }}>
            Nothing open. Nice work.
          </p>
          <Btn variant="primary" size="md" onClick={onSubmit}>＋ New work order</Btn>
        </div>
      )}

      {/* priority groups */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {groups.map(g => (
          <div key={g.p}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, padding: '0 4px' }}>
              <PrioDot p={g.p} size={10} />
              <span style={{ fontFamily: FONT_MONO, fontSize: 10, color: prioColor[g.p], letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 600 }}>
                {prioLabel[g.p]}
              </span>
              <span style={{ flex: 1, height: 1, background: T.rule }} />
              <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
                {g.items.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {g.items.map(w => <OpenCard key={w.id} w={w} onOpen={onOpen} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────────────
export function WorkOrdersTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [view, setView] = useState<'open' | 'history'>('open');
  const [submitOpen, setSubmitOpen] = useState(false);
  const [detail, setDetail] = useState<WorkOrder | null>(null);

  // Subscribe to realtime work orders for the active property.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToWorkOrders(user.uid, activePropertyId, setOrders);
    return () => unsub();
  }, [user, activePropertyId]);

  // Keep the open Detail modal's data fresh as orders update.
  const detailRow = useMemo(
    () => (detail ? orders.find(o => o.id === detail.id) ?? detail : null),
    [detail, orders],
  );

  // Upload a photo file to the maintenance-photos bucket. Returns the
  // storage path on success, null on failure.
  const uploadPhoto = async (file: File, kind: 'submitter' | 'completion'): Promise<string | null> => {
    if (!activePropertyId) return null;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `${activePropertyId}/${Date.now()}-${kind}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await supabase.storage
      .from('maintenance-photos')
      .upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
    if (error) {
      console.error('photo upload failed', error);
      return null;
    }
    return path;
  };

  const handleSubmit = async (args: {
    location: string;
    description: string;
    priority: WorkOrderPriority;
    photo: File | null;
  }) => {
    if (!user || !activePropertyId) return;
    let submitterPhotoPath: string | undefined;
    if (args.photo) {
      const path = await uploadPhoto(args.photo, 'submitter');
      if (path) submitterPhotoPath = path;
    }
    await addWorkOrder(user.uid, activePropertyId, {
      propertyId: activePropertyId,
      location: args.location,
      description: args.description,
      priority: args.priority,
      status: 'open',
      submittedByName: user.displayName,
      submitterRole: roleLabel(user.role),
      submitterPhotoPath,
    });
  };

  const handleDone = async (id: string, args: { note: string; completionPhoto: File | null }) => {
    if (!user) return;
    let completionPhotoPath: string | undefined;
    if (args.completionPhoto) {
      const path = await uploadPhoto(args.completionPhoto, 'completion');
      if (path) completionPhotoPath = path;
    }
    await markWorkOrderDone(id, {
      completedByName: user.displayName,
      completionNote: args.note || undefined,
      completionPhotoPath,
    });
  };

  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>
      {view === 'open' ? (
        <OpenView
          orders={orders}
          onOpen={(w) => setDetail(w)}
          onShowHistory={() => setView('history')}
          onSubmit={() => setSubmitOpen(true)}
        />
      ) : (
        <HistoryView orders={orders} onBack={() => setView('open')} />
      )}

      <SubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmit={handleSubmit}
      />
      <DetailModal
        w={detailRow}
        open={!!detail}
        onClose={() => setDetail(null)}
        onDone={handleDone}
      />
    </div>
  );
}
