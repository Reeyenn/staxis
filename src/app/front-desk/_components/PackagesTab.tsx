'use client';

// ═══════════════════════════════════════════════════════════════════════════
// Front-desk Packages — incoming guest-delivery log.
//
// Log parcels held behind the desk (Amazon/FedEx/UPS) and mark them picked up.
// AI touch: snap the shipping label → Claude
// Vision pre-fills guest name / room / carrier / tracking (scan only; the clerk
// confirms before saving). Snow design system. Visible to ALL front-desk staff
// (same access level as the Rooms tab — not management-gated like Lost & Found).
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
  subscribePackages,
  fetchPackages,
  createPackage,
  markPackagePickedUp,
  deletePackage,
  scanPackageLabel,
  presignPackagePhoto,
  type PackageRow,
  type PackageCounts,
} from '@/lib/db/packages';
import { PACKAGE_CARRIERS } from '@/lib/packages/types';
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

const carrierLabel = (c: string | null, lang: Lang): string => {
  if (!c) return '';
  if (c === 'Other') return tr(lang, 'Other', 'Otro');
  return c; // brand names are the same in both languages
};

type ViewFilter = 'held' | 'picked_up' | 'all';

const INITIAL_COUNTS: PackageCounts = { held: 0, pickedUp: 0 };

export function PackagesTab({ pid, lang }: { pid: string; lang: Lang }) {
  const { items, counts, loading, loadFailed, refetch } = useRegisterFeed<PackageRow, PackageCounts>(
    pid, subscribePackages, fetchPackages, INITIAL_COUNTS,
  );
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewFilter>('held');
  const [addOpen, setAddOpen] = useState(false);
  const { toasts, showToast } = useRegisterToast();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (view === 'held' && it.status !== 'held') return false;
      if (view === 'picked_up' && it.status !== 'picked_up') return false;
      if (!q) return true;
      const hay = [it.guestName, it.roomNumber, it.carrier, it.trackingNumber, it.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, view, search]);

  return (
    <div style={REGISTER_WRAP}>
      <RegisterHeader
        title={tr(lang, 'Packages', 'Paquetes')}
        subtitle={tr(
          lang,
          'Parcels held at the front desk for guests — log and hand off.',
          'Paquetes guardados en recepción para huéspedes — registra y entrega.',
        )}
        actions={
          <button style={REGISTER_PRIMARY_BTN} onClick={() => setAddOpen(true)}>
            + {tr(lang, 'Add package', 'Registrar paquete')}
          </button>
        }
      />

      <CountChips
        chips={[
          { label: tr(lang, 'Held', 'En espera'), value: counts.held, color: T.ink },
          { label: tr(lang, 'Picked up', 'Entregados'), value: counts.pickedUp, color: T.sageDeep },
        ]}
      />

      <SearchFilterBar<ViewFilter>
        search={search}
        onSearch={setSearch}
        placeholder={tr(lang, 'Search guest, room, tracking…', 'Buscar huésped, habitación, rastreo…')}
        views={[
          { key: 'held', label: tr(lang, 'Held', 'En espera') },
          { key: 'picked_up', label: tr(lang, 'Picked up', 'Entregados') },
          { key: 'all', label: tr(lang, 'All', 'Todos') },
        ]}
        view={view}
        onView={setView}
      />

      <RegisterList
        loading={loading}
        loadFailed={loadFailed}
        lang={lang}
        isEmpty={filtered.length === 0}
        emptyTitle={
          view === 'picked_up'
            ? tr(lang, 'No packages picked up yet', 'Aún no hay paquetes entregados')
            : tr(lang, 'No packages held', 'No hay paquetes en espera')
        }
        emptyHint={tr(lang, 'Tap “Add package” to log an arrival.', 'Toca “Registrar paquete” para registrar una llegada.')}
      >
        {filtered.map((it) => (
          <PackageCard key={it.id} pkg={it} lang={lang} pid={pid} onChanged={refetch} onToast={showToast} />
        ))}
      </RegisterList>

      {addOpen && (
        <AddPackageModal
          pid={pid}
          lang={lang}
          onClose={() => setAddOpen(false)}
          onLogged={() => {
            setAddOpen(false);
            void refetch();
            showToast(tr(lang, 'Package logged.', 'Paquete registrado.'));
          }}
          onToast={showToast}
        />
      )}

      <RegisterToastHost toasts={toasts} />
    </div>
  );
}

// ─── Package card ─────────────────────────────────────────────────────────────

function PackageCard({
  pkg,
  lang,
  pid,
  onChanged,
  onToast,
}: {
  pkg: PackageRow;
  lang: Lang;
  pid: string;
  onChanged: () => Promise<void> | void;
  onToast: (m: string) => void;
}) {
  const { busy, act } = useActRunner(lang, onChanged, onToast);
  const [confirmDel, setConfirmDel] = useState(false);
  const isHeld = pkg.status === 'held';

  return (
    <RegisterCardShell photoUrl={pkg.photoUrl} placeholder={<span aria-hidden>📦</span>} placeholderFontSize={18}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
        {isHeld ? (
          <Tag color={T.caramel} bg={`${T.caramel}14`}>{tr(lang, 'HELD', 'EN ESPERA')}</Tag>
        ) : (
          <Tag color={T.sageDeep} bg={`${T.sageDeep}14`}>{tr(lang, 'PICKED UP', 'ENTREGADO')}</Tag>
        )}
        {pkg.carrier && <Tag color={T.ink2} bg={`${T.ink2}10`}>{carrierLabel(pkg.carrier, lang)}</Tag>}
      </div>

      <div style={{ fontFamily: FONT_SERIF, fontSize: 18, color: T.ink, letterSpacing: '-0.01em', lineHeight: 1.25 }}>
        {pkg.guestName}
      </div>

      <div style={{ fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {pkg.roomNumber && <span>📍 {tr(lang, 'Room', 'Hab.')} {pkg.roomNumber}</span>}
        <span>
          {isHeld ? tr(lang, 'Arrived', 'Llegó') : tr(lang, 'Picked up', 'Entregado')}{' '}
          {fmtWhen(isHeld ? pkg.loggedAt : pkg.pickedUpAt, lang)}
        </span>
        {pkg.trackingNumber && (
          <span style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>#{pkg.trackingNumber}</span>
        )}
      </div>

      {pkg.notes && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: T.ink2, fontFamily: FONT_SANS, fontStyle: 'italic' }}>
          {pkg.notes}
        </div>
      )}

      {/* Actions */}
      {isHeld && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <SmallBtn busy={busy} tone={T.sageDeep} onClick={() =>
            act(() => markPackagePickedUp(pid, pkg.id), tr(lang, 'Marked picked up', 'Marcado entregado'))
          }>
            {'✓ ' + tr(lang, 'Picked up', 'Entregado')}
          </SmallBtn>
          {confirmDel ? (
            <SmallBtn busy={busy} tone={T.warm} onClick={() => {
              setConfirmDel(false);
              void act(() => deletePackage(pid, pkg.id), tr(lang, 'Deleted', 'Eliminado'));
            }}>
              {tr(lang, 'Confirm delete?', '¿Eliminar?')}
            </SmallBtn>
          ) : (
            <SmallBtn busy={busy} tone={T.ink3} onClick={() => {
              setConfirmDel(true);
              setTimeout(() => setConfirmDel(false), 4000);
            }}>
              {tr(lang, 'Delete', 'Eliminar')}
            </SmallBtn>
          )}
        </div>
      )}
    </RegisterCardShell>
  );
}

// ─── Add modal ────────────────────────────────────────────────────────────

const CARRIER_OPTIONS = (lang: Lang) => [
  { value: '', label: tr(lang, 'Unknown', 'Desconocido') },
  ...PACKAGE_CARRIERS.map((c) => ({ value: c, label: carrierLabel(c, lang) })),
];

function AddPackageModal({
  pid,
  lang,
  onClose,
  onLogged,
  onToast,
}: {
  pid: string;
  lang: Lang;
  onClose: () => void;
  onLogged: () => void;
  onToast: (m: string) => void;
}) {
  const [guestName, setGuestName] = useState('');
  const [room, setRoom] = useState('');
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [aiFilled, setAiFilled] = useState(false);
  const photo = usePhotoDraft();

  const onPickFile = async (file: File | null) => {
    const p = await photo.pick(file);
    if (!p) return;
    // AI scan the label (only when we produced a JPEG to send).
    if (p.b64 && p.mime) {
      setScanning(true);
      try {
        const res = await scanPackageLabel(pid, p.b64, p.mime);
        if (res.ok && res.data) {
          const d = res.data;
          // Functional setters: only fill a field that is STILL empty now — the
          // clerk may have typed into it while the scan was in flight, and we
          // must never clobber that (the closure's values are stale).
          if (d.guestName) setGuestName((prev) => (prev.trim() ? prev : d.guestName!));
          if (d.roomNumber) setRoom((prev) => (prev.trim() ? prev : d.roomNumber!));
          if (d.carrier) setCarrier((prev) => (prev ? prev : d.carrier!));
          if (d.trackingNumber) setTracking((prev) => (prev.trim() ? prev : d.trackingNumber!));
          const readAnything = !!(d.guestName || d.roomNumber || d.carrier || d.trackingNumber);
          if (readAnything) {
            // The inline "✨ AI filled — check it" banner is the reminder; no
            // extra toast (avoids a double notification for one action).
            setAiFilled(true);
          } else {
            onToast(tr(lang, 'Couldn’t read the label — enter it manually', 'No se pudo leer la etiqueta — ingrésalo manualmente'));
          }
        } else {
          onToast(tr(lang, 'Couldn’t read the label — enter it manually', 'No se pudo leer la etiqueta — ingrésalo manualmente'));
        }
      } catch {
        onToast(tr(lang, 'Scan failed — enter it manually', 'Escaneo falló — ingrésalo manualmente'));
      } finally {
        setScanning(false);
      }
    }
  };

  const submit = async () => {
    if (submitting) return;
    if (!guestName.trim()) {
      onToast(tr(lang, 'Add the guest name', 'Agrega el nombre del huésped'));
      return;
    }
    setSubmitting(true);
    try {
      // Upload the label photo first (if any) to get a stored path. Optional —
      // a failed upload still logs the package.
      const photoPath = photo.prepared.current
        ? await uploadPreparedPhoto(presignPackagePhoto, pid, 'label', photo.prepared.current)
        : null;

      const res = await createPackage({
        pid,
        guestName: guestName.trim(),
        roomNumber: room.trim() || null,
        carrier: carrier || null,
        trackingNumber: tracking.trim() || null,
        notes: notes.trim() || null,
        photoPath,
      });
      if (res.ok) onLogged();
      else onToast(tr(lang, 'Could not log package', 'No se pudo registrar') + (res.error ? ` (${res.error})` : ''));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={tr(lang, 'Add package', 'Registrar paquete')}
      subtitle={tr(lang, 'Held at the front desk for a guest', 'Guardado en recepción para un huésped')}
      footer={<SaveCancelFooter lang={lang} submitting={submitting} onCancel={onClose} onSubmit={submit} />}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Scan label */}
        <PhotoPickerField
          label={tr(lang, 'Shipping label', 'Etiqueta de envío')}
          hint={scanning ? tr(lang, 'AI reading label…', 'IA leyendo etiqueta…') : tr(lang, 'AI auto-fills the details', 'La IA completa los datos')}
          placeholder={<>📷 {tr(lang, 'Scan label — tap to take or upload', 'Escanear etiqueta — tomar o subir')}</>}
          preview={photo.preview}
          onPick={(f) => void onPickFile(f)}
          onClear={() => {
            photo.clear();
            setAiFilled(false);
          }}
        />

        {aiFilled && (
          <div style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.sageDeep, marginTop: -8 }}>
            ✨ {tr(lang, 'AI filled the details — please check them before saving.', 'La IA completó los datos — revísalos antes de guardar.')}
          </div>
        )}

        <Field label={tr(lang, 'Guest name', 'Nombre del huésped')} required>
          <TextInput value={guestName} onChange={setGuestName} placeholder={tr(lang, 'e.g. Jordan Smith', 'p. ej. Jordan Smith')} maxLength={120} />
        </Field>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Field label={tr(lang, 'Room #', 'Habitación')} style={{ flex: '1 1 120px' }}>
            <TextInput value={room} onChange={setRoom} placeholder="214" maxLength={20} />
          </Field>
          <Field label={tr(lang, 'Tracking #', 'Rastreo')} style={{ flex: '1 1 180px' }}>
            <TextInput value={tracking} onChange={setTracking} placeholder={tr(lang, 'optional', 'opcional')} maxLength={40} />
          </Field>
        </div>

        <Field label={tr(lang, 'Carrier', 'Transportista')}>
          <ChipChoose value={carrier} onChange={setCarrier} options={CARRIER_OPTIONS(lang)} />
        </Field>

        <Field label={tr(lang, 'Notes', 'Notas')}>
          <TextArea value={notes} onChange={setNotes} placeholder={tr(lang, 'anything else…', 'algo más…')} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
