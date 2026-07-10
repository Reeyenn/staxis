'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Front-desk Lost & Found — the unified register.
//
// Shows BOTH app-logged items and PMS-synced items (read-only). Lets the desk
// log found items + guest lost reports, run AI auto-describe on photos, AI
// auto-match lost↔found, mark returned/shipped/disposed, text the guest, and
// see each found item's 90-day disposal countdown. Snow design system.
// Chrome comes from the shared register scaffold (_register.tsx).
// ═══════════════════════════════════════════════════════════════════════════

import React, { useMemo, useState } from 'react';
import {
  T,
  FONT_SANS,
  FONT_SERIF,
  FONT_MONO,
  Modal,
  Field,
  TextInput,
  TextArea,
  ChipChoose,
} from '@/app/maintenance/_components/_mt-snow';
import {
  subscribeLostFound,
  fetchLostFoundRegister,
  logLostFoundItem,
  updateLostFoundItem,
  matchLostFound,
  describeFoundPhoto,
  autoMatchLost,
  presignFoundPhoto,
  type LostFoundItem,
  type LostFoundCounts,
  type AutoMatchResult,
} from '@/lib/db/lost-and-found';
import { LAF_CATEGORIES } from '@/lib/lost-and-found/types';
import {
  type Lang,
  tr,
  fmtWhen,
  uploadPreparedPhoto,
  usePhotoDraft,
  useRegisterFeed,
  useRegisterToast,
  RegisterToastHost,
  useActRunner,
  REGISTER_WRAP,
  REGISTER_PRIMARY_BTN,
  REGISTER_GHOST_BTN,
  RegisterHeader,
  CountChips,
  SearchFilterBar,
  RegisterList,
  RegisterCardShell,
  Tag,
  SmallBtn,
  PhotoPickerField,
  SaveCancelFooter,
} from './_register';

const CATEGORY_LABELS: Record<string, { en: string; es: string }> = {
  electronics: { en: 'Electronics', es: 'Electrónica' },
  clothing: { en: 'Clothing', es: 'Ropa' },
  jewelry: { en: 'Jewelry', es: 'Joyería' },
  documents: { en: 'Documents', es: 'Documentos' },
  bags: { en: 'Bags', es: 'Bolsos' },
  keys: { en: 'Keys', es: 'Llaves' },
  toiletries: { en: 'Toiletries', es: 'Artículos de aseo' },
  eyewear: { en: 'Eyewear', es: 'Gafas' },
  toys: { en: 'Toys', es: 'Juguetes' },
  money: { en: 'Money', es: 'Dinero' },
  other: { en: 'Other', es: 'Otro' },
};
const catLabel = (c: string | null, lang: Lang) =>
  c ? (CATEGORY_LABELS[c] ? CATEGORY_LABELS[c][lang] : c) : '';

function statusMeta(status: string, lang: Lang): { label: string; color: string } {
  switch (status) {
    case 'open':
      return { label: tr(lang, 'Open', 'Abierto'), color: T.ink };
    case 'matched':
      return { label: tr(lang, 'Matched', 'Emparejado'), color: T.caramel };
    case 'returned':
      return { label: tr(lang, 'Returned', 'Devuelto'), color: T.sageDeep };
    case 'shipped':
      return { label: tr(lang, 'Shipped', 'Enviado'), color: T.sageDeep };
    case 'claimed':
      return { label: tr(lang, 'Claimed', 'Reclamado'), color: T.sageDeep };
    case 'disposed':
      return { label: tr(lang, 'Disposed', 'Desechado'), color: T.ink3 };
    case 'expired':
      return { label: tr(lang, 'Expired', 'Vencido'), color: T.warm };
    default:
      return { label: status, color: T.ink2 };
  }
}

/** Disposal countdown for an open found item. */
function disposalInfo(item: LostFoundItem, lang: Lang): { label: string; color: string } | null {
  if (item.type !== 'found' || item.status !== 'open' || !item.holdUntil) return null;
  const ms = Date.parse(item.holdUntil);
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) return { label: tr(lang, 'Past hold — dispose', 'Vencido — desechar'), color: T.warm };
  if (days <= 7)
    return { label: tr(lang, `Dispose in ${days}d`, `Desechar en ${days}d`), color: T.warm };
  if (days <= 14)
    return { label: tr(lang, `Hold ${days}d left`, `Quedan ${days}d`), color: T.caramel };
  return { label: tr(lang, `Hold ${days}d left`, `Quedan ${days}d`), color: T.ink3 };
}

type ViewFilter = 'unresolved' | 'found' | 'lost' | 'resolved' | 'all';

const INITIAL_COUNTS: LostFoundCounts = { open: 0, awaitingReturn: 0, nearingDisposal: 0 };

export function LostFoundTab({ pid, lang }: { pid: string; lang: Lang }) {
  const { items, counts, loading, refetch } = useRegisterFeed<LostFoundItem, LostFoundCounts>(
    pid, subscribeLostFound, fetchLostFoundRegister, INITIAL_COUNTS,
  );
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewFilter>('unresolved');
  const [logOpen, setLogOpen] = useState(false);
  const [logType, setLogType] = useState<'found' | 'lost'>('found');
  const { toasts, showToast } = useRegisterToast();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (view === 'found' && it.type !== 'found') return false;
      if (view === 'lost' && it.type !== 'lost') return false;
      if (view === 'unresolved' && !(it.status === 'open' || it.status === 'matched')) return false;
      if (view === 'resolved' && (it.status === 'open' || it.status === 'matched')) return false;
      if (!q) return true;
      const hay = [
        it.itemDescription,
        it.location,
        it.roomNumber,
        it.guestName,
        it.foundBy,
        catLabel(it.category, lang),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, view, search, lang]);

  return (
    <div style={REGISTER_WRAP}>
      <RegisterHeader
        title={tr(lang, 'Lost & Found', 'Objetos perdidos')}
        subtitle={tr(lang, 'Found items, guest reports, and returns — PMS and staff combined.', 'Objetos encontrados, reportes de huéspedes y devoluciones — del PMS y del personal.')}
        actions={
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={REGISTER_PRIMARY_BTN} onClick={() => { setLogType('found'); setLogOpen(true); }}>
              + {tr(lang, 'Log found item', 'Registrar hallazgo')}
            </button>
            <button style={REGISTER_GHOST_BTN} onClick={() => { setLogType('lost'); setLogOpen(true); }}>
              + {tr(lang, 'Log lost report', 'Registrar pérdida')}
            </button>
          </div>
        }
      />

      <CountChips
        chips={[
          { label: tr(lang, 'Open', 'Abiertos'), value: counts.open, color: T.ink },
          { label: tr(lang, 'Awaiting return', 'Por devolver'), value: counts.awaitingReturn, color: T.caramel },
          { label: tr(lang, 'Nearing disposal', 'Por desechar'), value: counts.nearingDisposal, color: T.warm },
        ]}
      />

      <SearchFilterBar<ViewFilter>
        search={search}
        onSearch={setSearch}
        placeholder={tr(lang, 'Search description, room, guest…', 'Buscar descripción, habitación, huésped…')}
        views={[
          { key: 'unresolved', label: tr(lang, 'Active', 'Activos') },
          { key: 'found', label: tr(lang, 'Found', 'Encontrados') },
          { key: 'lost', label: tr(lang, 'Lost', 'Perdidos') },
          { key: 'resolved', label: tr(lang, 'Resolved', 'Resueltos') },
          { key: 'all', label: tr(lang, 'All', 'Todos') },
        ]}
        view={view}
        onView={setView}
      />

      <RegisterList
        loading={loading}
        lang={lang}
        isEmpty={filtered.length === 0}
        emptyTitle={tr(lang, 'Nothing here yet', 'Nada por aquí todavía')}
        emptyHint={tr(lang, 'Log a found item or a guest lost report to get started.', 'Registra un hallazgo o un reporte de pérdida para empezar.')}
      >
        {filtered.map((it) => (
          <ItemCard
            key={`${it.source}:${it.id}`}
            item={it}
            lang={lang}
            pid={pid}
            allItems={items}
            onChanged={refetch}
            onToast={showToast}
          />
        ))}
      </RegisterList>

      {logOpen && (
        <LogModal
          pid={pid}
          lang={lang}
          initialType={logType}
          onClose={() => setLogOpen(false)}
          onLogged={() => {
            setLogOpen(false);
            void refetch();
            showToast(tr(lang, 'Logged.', 'Registrado.'));
          }}
          onToast={showToast}
        />
      )}

      <RegisterToastHost toasts={toasts} />
    </div>
  );
}

// ─── Item card ──────────────────────────────────────────────────────────────

function ItemCard({
  item,
  lang,
  pid,
  allItems,
  onChanged,
  onToast,
}: {
  item: LostFoundItem;
  lang: Lang;
  pid: string;
  allItems: LostFoundItem[];
  onChanged: () => Promise<void> | void;
  onToast: (m: string) => void;
}) {
  const { busy, act } = useActRunner(lang, onChanged, onToast);
  const [matches, setMatches] = useState<AutoMatchResult['matches'] | null>(null);
  const [matching, setMatching] = useState(false);
  const sm = statusMeta(item.status, lang);
  const disposal = disposalInfo(item, lang);
  const isFound = item.type === 'found';
  const editable = item.editable;

  const matchedItem = item.matchedItemId
    ? allItems.find((x) => x.source === 'app' && x.id === item.matchedItemId)
    : null;

  const runAutoMatch = async () => {
    if (matching) return;
    setMatching(true);
    try {
      const res = await autoMatchLost(pid, item.id);
      if (res.ok && res.data) setMatches(res.data.matches);
      else onToast(tr(lang, 'Could not find matches', 'No se pudieron buscar coincidencias'));
    } finally {
      setMatching(false);
    }
  };

  return (
    <RegisterCardShell
      photoUrl={item.photoUrl}
      placeholder={<span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>{tr(lang, 'No photo', 'Sin foto')}</span>}
      placeholderFontSize={10}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        {isFound ? (
          <Tag color={T.sageDeep} bg={T.sageDim}>{tr(lang, 'FOUND', 'ENCONTRADO')}</Tag>
        ) : (
          <Tag color={T.warm} bg={T.warmDim}>{tr(lang, 'LOST', 'PERDIDO')}</Tag>
        )}
        <Tag color={sm.color} bg={`${sm.color}14`}>{sm.label}</Tag>
        {!editable && <Tag color={T.purple} bg={T.purpleDim}>{tr(lang, 'From PMS', 'Del PMS')}</Tag>}
        {disposal && <Tag color={disposal.color} bg={`${disposal.color}14`}>{disposal.label}</Tag>}
      </div>

      <div style={{ fontFamily: FONT_SERIF, fontSize: 18, color: T.ink, letterSpacing: '-0.01em', lineHeight: 1.25 }}>
        {item.itemDescription || tr(lang, '(no description)', '(sin descripción)')}
      </div>

      <div style={{ fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {item.category && <span>{catLabel(item.category, lang)}</span>}
        {(item.roomNumber || item.location) && (
          <span>📍 {item.roomNumber ? `${tr(lang, 'Room', 'Hab.')} ${item.roomNumber}` : item.location}</span>
        )}
        {item.occurredAt && <span>{isFound ? tr(lang, 'Found', 'Encontrado') : tr(lang, 'Lost', 'Perdido')} {fmtWhen(item.occurredAt, lang)}</span>}
        {item.foundBy && <span>{tr(lang, 'by', 'por')} {item.foundBy}</span>}
        {item.guestName && <span>👤 {item.guestName}</span>}
      </div>

      {matchedItem && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: T.caramelDeep, fontFamily: FONT_SANS }}>
          ↔ {tr(lang, 'Matched with', 'Emparejado con')}: {matchedItem.itemDescription}
        </div>
      )}

      {item.notes && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, fontStyle: 'italic' }}>
          {item.notes}
        </div>
      )}

      {/* Actions */}
      {editable && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {isFound && (item.status === 'open' || item.status === 'matched') && (
            <>
              <SmallBtn busy={busy} tone={T.sageDeep} onClick={() =>
                act(() => updateLostFoundItem(pid, item.id, { status: 'returned' }), tr(lang, 'Marked returned', 'Marcado devuelto'))
              }>
                {tr(lang, 'Returned', 'Devuelto')}
              </SmallBtn>
              <SmallBtn busy={busy} tone={T.sageDeep} onClick={() =>
                act(() => updateLostFoundItem(pid, item.id, { status: 'shipped' }), tr(lang, 'Marked shipped', 'Marcado enviado'))
              }>
                {tr(lang, 'Shipped', 'Enviado')}
              </SmallBtn>
              <SmallBtn busy={busy} tone={T.ink3} onClick={() =>
                act(() => updateLostFoundItem(pid, item.id, { status: 'disposed' }), tr(lang, 'Marked disposed', 'Marcado desechado'))
              }>
                {tr(lang, 'Dispose', 'Desechar')}
              </SmallBtn>
            </>
          )}
          {!isFound && item.status === 'open' && (
            <>
              <SmallBtn busy={busy} tone={T.ink} onClick={runAutoMatch}>
                {matching ? tr(lang, 'Searching…', 'Buscando…') : '✨ ' + tr(lang, 'Find matches', 'Buscar coincidencias')}
              </SmallBtn>
              <SmallBtn busy={busy} tone={T.ink3} onClick={() =>
                act(() => updateLostFoundItem(pid, item.id, { status: 'returned' }), tr(lang, 'Closed', 'Cerrado'))
              }>
                {tr(lang, 'Close report', 'Cerrar reporte')}
              </SmallBtn>
            </>
          )}
        </div>
      )}
      {!editable && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: T.ink3, fontFamily: FONT_SANS }}>
          {tr(lang, 'Managed in the PMS — read-only here.', 'Gestionado en el PMS — solo lectura aquí.')}
        </div>
      )}

      {/* Auto-match suggestions */}
      {matches && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.ink3, marginBottom: 8 }}>
            {tr(lang, 'Suggested matches', 'Coincidencias sugeridas')}
          </div>
          {matches.length === 0 ? (
            <div style={{ fontSize: 12.5, color: T.ink3, fontFamily: FONT_SANS }}>
              {tr(lang, 'No likely matches among open found items.', 'No hay coincidencias probables entre los objetos encontrados.')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {matches.map((m) => (
                <div
                  key={m.id}
                  style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', border: `1px solid ${T.rule}`, borderRadius: 10, padding: '8px 10px' }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: T.ink, fontFamily: FONT_SANS, fontWeight: 600 }}>
                      {m.item.itemDescription}
                      {m.aiConfidence && (
                        <span style={{ marginLeft: 8, fontSize: 11, color: m.aiConfidence === 'high' ? T.sageDeep : m.aiConfidence === 'medium' ? T.caramel : T.ink3 }}>
                          {tr(lang, m.aiConfidence + ' confidence', m.aiConfidence)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: T.ink2, fontFamily: FONT_SANS, marginTop: 2 }}>
                      {(m.aiReason ? [m.aiReason] : m.reasons).slice(0, 3).join(' · ')}
                    </div>
                  </div>
                  <SmallBtn busy={busy} tone={T.sageDeep} onClick={() =>
                    act(() => matchLostFound(pid, item.id, m.item.id), tr(lang, 'Matched', 'Emparejado'))
                  }>
                    {tr(lang, 'Match', 'Emparejar')}
                  </SmallBtn>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </RegisterCardShell>
  );
}

// ─── Log modal ────────────────────────────────────────────────────────────

function LogModal({
  pid,
  lang,
  initialType,
  onClose,
  onLogged,
  onToast,
}: {
  pid: string;
  lang: Lang;
  initialType: 'found' | 'lost';
  onClose: () => void;
  onLogged: () => void;
  onToast: (m: string) => void;
}) {
  const [type, setType] = useState<'found' | 'lost'>(initialType);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [location, setLocation] = useState('');
  const [room, setRoom] = useState('');
  const [guestName, setGuestName] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [describing, setDescribing] = useState(false);
  const photo = usePhotoDraft();

  const onPickFile = async (file: File | null) => {
    const p = await photo.pick(file);
    if (!p) return;
    // AI auto-describe (found items only, and only when we have a JPEG).
    if (type === 'found' && p.b64 && p.mime) {
      setDescribing(true);
      try {
        const res = await describeFoundPhoto(pid, p.b64, p.mime);
        if (res.ok && res.data) {
          if (res.data.description && !description.trim()) setDescription(res.data.description);
          if (res.data.category) setCategory(res.data.category);
          onToast(tr(lang, 'AI filled the description', 'La IA completó la descripción'));
        }
      } catch {
        /* manual entry still works */
      } finally {
        setDescribing(false);
      }
    }
  };

  const submit = async () => {
    if (submitting) return;
    if (!description.trim()) {
      onToast(tr(lang, 'Add a description', 'Agrega una descripción'));
      return;
    }
    setSubmitting(true);
    try {
      // Upload photo first (if any) to get a path.
      const photoPath = photo.prepared.current
        ? await uploadPreparedPhoto(presignFoundPhoto, pid, 'photo', photo.prepared.current)
        : null;

      const res = await logLostFoundItem({
        pid,
        type,
        itemDescription: description.trim(),
        category,
        location: location.trim() || null,
        roomNumber: room.trim() || null,
        guestName: guestName.trim() || null,
        foundBy: type === 'found' ? tr(lang, 'Front desk', 'Recepción') : null,
        reportedBy: type === 'lost' ? tr(lang, 'Front desk', 'Recepción') : null,
        notes: notes.trim() || null,
        photoPath,
      });
      if (res.ok) onLogged();
      else onToast(tr(lang, 'Could not log item', 'No se pudo registrar') + (res.error ? ` (${res.error})` : ''));
    } finally {
      setSubmitting(false);
    }
  };

  const catOptions = LAF_CATEGORIES.map((c) => ({ value: c, label: catLabel(c, lang) }));

  return (
    <Modal
      open
      onClose={onClose}
      title={type === 'found' ? tr(lang, 'Log found item', 'Registrar hallazgo') : tr(lang, 'Log lost report', 'Registrar pérdida')}
      subtitle={tr(lang, 'Adds to the Lost & Found register', 'Se agrega al registro de objetos perdidos')}
      footer={<SaveCancelFooter lang={lang} submitting={submitting} onCancel={onClose} onSubmit={submit} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Type toggle */}
        <ChipChoose
          value={type}
          onChange={(v) => setType(v)}
          options={[
            { value: 'found', label: tr(lang, 'Found item', 'Objeto encontrado') },
            { value: 'lost', label: tr(lang, 'Guest lost report', 'Reporte de pérdida') },
          ]}
        />

        {/* Photo (found only) */}
        {type === 'found' && (
          <PhotoPickerField
            label={tr(lang, 'Photo', 'Foto')}
            hint={describing ? tr(lang, 'AI reading photo…', 'IA leyendo la foto…') : tr(lang, 'AI auto-fills the description', 'La IA completa la descripción')}
            placeholder={<>+ {tr(lang, 'Tap to take or upload', 'Tomar o subir foto')}</>}
            preview={photo.preview}
            onPick={(f) => void onPickFile(f)}
            onClear={photo.clear}
          />
        )}

        <Field label={tr(lang, 'Description', 'Descripción')} required>
          <TextInput value={description} onChange={setDescription} placeholder={tr(lang, 'e.g. black North Face jacket, size M', 'p. ej. chaqueta negra North Face, talla M')} maxLength={500} />
        </Field>

        <Field label={tr(lang, 'Category', 'Categoría')}>
          <ChipChoose value={category} onChange={setCategory} options={catOptions} />
        </Field>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label={tr(lang, 'Room #', 'Habitación')} style={{ flex: '1 1 120px' }}>
            <TextInput value={room} onChange={setRoom} placeholder="214" maxLength={20} />
          </Field>
          <Field label={tr(lang, 'Area / location', 'Área / lugar')} style={{ flex: '1 1 160px' }}>
            <TextInput value={location} onChange={setLocation} placeholder={tr(lang, 'lobby, pool deck…', 'recepción, alberca…')} maxLength={200} />
          </Field>
        </div>

        <Field label={tr(lang, 'Guest name', 'Nombre del huésped')}>
          <TextInput value={guestName} onChange={setGuestName} placeholder={tr(lang, 'optional', 'opcional')} maxLength={120} />
        </Field>

        <Field label={tr(lang, 'Notes', 'Notas')}>
          <TextArea value={notes} onChange={setNotes} placeholder={tr(lang, 'anything else…', 'algo más…')} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
