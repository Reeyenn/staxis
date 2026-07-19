'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { recordInventoryStockLossAtomic } from '@/lib/db';
import type { InventoryStockLossReason } from '@/lib/inventory-atomic';
import { generateId, errToString } from '@/lib/utils';
import type { InventoryItem } from '@/types';
import { Btn } from '../Btn';
import type { Lang } from '../inv-i18n';
import { fonts, T } from '../tokens';
import { Overlay } from './Overlay';
import overlayStyles from './Overlay.module.css';
import { inputLg, warnBannerStyle } from './form-kit';
import { isDefinitiveDeliveryFailure } from './scan-commit';
import {
  clearInventoryOperationAttempt,
  loadInventoryOperationAttempt,
  persistInventoryOperationAttempt,
} from '@/lib/inventory-operation-attempt';
import {
  clearInventoryOverlayDraft,
  loadInventoryOverlayDraft,
  persistInventoryOverlayDraft,
} from './inventory-overlay-draft';

interface StockLossSheetProps {
  open: boolean;
  lang: Lang;
  item: InventoryItem | null;
  onClose: () => void;
  onSaved?: () => void;
}

interface FrozenLossAttempt {
  requestId: string;
  recordedAt: string;
  itemId: string;
  expectedStock: number;
  quantity: number;
  reason: InventoryStockLossReason;
  notes: string;
}

interface LossDraft {
  itemId: string;
  expectedStock: number;
  quantity: string;
  reason: InventoryStockLossReason;
  notes: string;
  attempt: FrozenLossAttempt | null;
}

const REASONS: InventoryStockLossReason[] = ['missing', 'lost', 'damaged', 'stained', 'theft', 'other'];

function copy(lang: Lang) {
  return lang === 'es' ? {
    eyebrow: 'Ajuste de existencias', title: 'Registrar artículo faltante o dañado',
    quantity: 'Cantidad', reason: 'Motivo', notes: 'Notas opcionales',
    before: 'Antes', after: 'Después', setAside: 'Apartado',
    save: 'Registrar pérdida', retry: 'Reintentar exactamente', cancel: 'Cancelar',
    restored: 'Se recuperó el trabajo sin guardar de esta pestaña.',
    retryLocked: 'El resultado anterior no se pudo confirmar. Los datos exactos están bloqueados; reintenta para evitar registrar la pérdida dos veces.',
    saveFailed: 'No se pudo registrar la pérdida.',
    unsafe: 'La pérdida no se envió porque no se pudo guardar un reintento seguro en esta pestaña. Tu información sigue aquí.',
    stale: 'Las existencias cambiaron desde que abriste esta pantalla. Cierra, actualiza e inténtalo de nuevo.',
    reserved: 'Esto dejaría menos existencias que la cantidad Apartada. Primero reduce Apartado en Editar artículo, para que la reserva no quede falsa.',
    discard: '¿Cerrar esta pantalla? Tu trabajo está guardado y podrás recuperarlo al volver.',
    invalid: 'Escribe una cantidad entera mayor que cero que no exceda las existencias actuales.',
    reasons: { missing: 'Faltante', lost: 'Perdido', damaged: 'Dañado', stained: 'Manchado', theft: 'Robo', other: 'Otro' },
  } : {
    eyebrow: 'Stock adjustment', title: 'Record missing or damaged stock',
    quantity: 'Quantity', reason: 'Reason', notes: 'Optional notes',
    before: 'Before', after: 'After', setAside: 'Set Aside',
    save: 'Record stock loss', retry: 'Retry exact loss', cancel: 'Cancel',
    restored: 'Unsaved work from this tab was restored.',
    retryLocked: 'The previous result could not be confirmed. These exact values are locked; retry them to avoid recording the loss twice.',
    saveFailed: 'The stock loss could not be recorded.',
    unsafe: 'The loss was not sent because this tab could not save a safe retry. Your information is still here.',
    stale: 'Stock changed after this screen opened. Close, refresh, and try again.',
    reserved: 'This would leave less stock than Set Aside. Lower Set Aside in Edit Item first so the reserved amount does not become false.',
    discard: 'Close this screen? Your work is saved and can be recovered when you return.',
    invalid: 'Enter a whole quantity greater than zero and no more than the current stock.',
    reasons: { missing: 'Missing', lost: 'Lost', damaged: 'Damaged', stained: 'Stained', theft: 'Theft', other: 'Other' },
  };
}

function validDraft(value: unknown, item: InventoryItem): LossDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<LossDraft>;
  if (draft.itemId !== item.id || draft.expectedStock !== item.currentStock) return null;
  if (typeof draft.quantity !== 'string' || typeof draft.notes !== 'string') return null;
  if (!REASONS.includes(draft.reason as InventoryStockLossReason)) return null;
  return {
    itemId: item.id,
    expectedStock: item.currentStock,
    quantity: draft.quantity,
    reason: draft.reason as InventoryStockLossReason,
    notes: draft.notes,
    attempt: draft.attempt && typeof draft.attempt === 'object'
      ? draft.attempt as FrozenLossAttempt
      : null,
  };
}

function validFrozenLossAttempt(value: unknown, itemId: string): FrozenLossAttempt | null {
  if (!value || typeof value !== 'object') return null;
  const attempt = value as Partial<FrozenLossAttempt>;
  if (
    typeof attempt.requestId !== 'string'
    || typeof attempt.recordedAt !== 'string'
    || Number.isNaN(new Date(attempt.recordedAt).getTime())
    || attempt.itemId !== itemId
    || !Number.isFinite(attempt.expectedStock)
    || !Number.isInteger(attempt.quantity)
    || (attempt.quantity ?? 0) <= 0
    || !REASONS.includes(attempt.reason as InventoryStockLossReason)
    || typeof attempt.notes !== 'string'
  ) return null;
  return attempt as FrozenLossAttempt;
}

export function StockLossSheet({ open, lang, item, onClose, onSaved }: StockLossSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const tx = copy(lang);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState<InventoryStockLossReason>('missing');
  const [notes, setNotes] = useState('');
  const [attempt, setAttempt] = useState<FrozenLossAttempt | null>(null);
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const storageInput = useMemo(() => user?.uid && activePropertyId && item
    ? { kind: 'stock-loss' as const, userId: user.uid, propertyId: activePropertyId, scope: item.id }
    : null, [activePropertyId, item, user?.uid]);
  const durableAttemptInput = useMemo(() => user?.uid && activePropertyId && item
    ? { kind: 'stock-loss' as const, userId: user.uid, propertyId: activePropertyId, scope: item.id }
    : null, [activePropertyId, item, user?.uid]);
  const expectedStock = item?.currentStock ?? 0;
  const displayedExpectedStock = attempt?.expectedStock ?? expectedStock;
  const parsedQuantity = Number(quantity);
  const validQuantity = /^\d+$/.test(quantity)
    && Number.isInteger(parsedQuantity)
    && parsedQuantity > 0
    && parsedQuantity <= displayedExpectedStock;
  const after = validQuantity ? displayedExpectedStock - parsedQuantity : displayedExpectedStock;
  const setAside = Math.max(0, item?.setAside ?? 0);
  const retryLocked = attempt != null;
  const reservedConflict = !retryLocked && validQuantity && after < setAside;
  const dirty = quantity !== '' || notes.trim() !== '' || reason !== 'missing' || attempt != null;

  useEffect(() => {
    if (!open || !item) return;
    const durableAttempt = durableAttemptInput
      ? loadInventoryOperationAttempt(
          durableAttemptInput,
          (value) => validFrozenLossAttempt(value, item.id),
        )
      : null;
    const stored = storageInput
      ? validDraft(loadInventoryOverlayDraft<LossDraft>(storageInput), item)
      : null;
    setQuantity(durableAttempt ? String(durableAttempt.quantity) : stored?.quantity ?? '');
    setReason(durableAttempt?.reason ?? stored?.reason ?? 'missing');
    setNotes(durableAttempt?.notes ?? stored?.notes ?? '');
    setAttempt(durableAttempt);
    setRestored(Boolean(durableAttempt || stored));
    setSaving(false);
    setError('');
  }, [durableAttemptInput, item, open, storageInput]);

  useEffect(() => {
    if (!open || !item || !storageInput) return;
    if (!dirty) {
      clearInventoryOverlayDraft(storageInput);
      return;
    }
    persistInventoryOverlayDraft({
      ...storageInput,
      data: { itemId: item.id, expectedStock, quantity, reason, notes, attempt } satisfies LossDraft,
    });
  }, [attempt, dirty, expectedStock, item, notes, open, quantity, reason, storageInput]);

  const requestClose = () => {
    if ((dirty || retryLocked) && !window.confirm(tx.discard)) return;
    onClose();
  };

  const save = async () => {
    if (!user || !activePropertyId || !item || saving) return;
    setError('');
    if ((!retryLocked && !validQuantity) || reservedConflict) {
      setError(reservedConflict ? tx.reserved : tx.invalid);
      return;
    }
    const frozen = attempt ?? {
      requestId: generateId(),
      recordedAt: new Date().toISOString(),
      itemId: item.id,
      expectedStock,
      quantity: parsedQuantity,
      reason,
      notes: notes.trim(),
    };
    const frozenDraft: LossDraft = {
      itemId: item.id,
      expectedStock,
      quantity: String(frozen.quantity),
      reason: frozen.reason,
      notes: frozen.notes,
      attempt: frozen,
    };
    // Unlike an editable draft, this UUID becomes transactional evidence once
    // the request starts. Refuse to send unless it survives a write/readback.
    if (
      !storageInput
      || !durableAttemptInput
      || !persistInventoryOverlayDraft({ ...storageInput, data: frozenDraft })
      || !persistInventoryOperationAttempt(durableAttemptInput, frozen)
    ) {
      setError(tx.unsafe);
      return;
    }
    const verified = loadInventoryOperationAttempt(
      durableAttemptInput,
      (value) => validFrozenLossAttempt(value, item.id),
    );
    if (JSON.stringify(verified) !== JSON.stringify(frozen)) {
      setError(tx.unsafe);
      return;
    }
    setAttempt(frozen);
    setSaving(true);
    try {
      await recordInventoryStockLossAtomic(
        user.uid,
        activePropertyId,
        frozen.requestId,
        new Date(frozen.recordedAt),
        user.displayName || user.username || 'team',
        {
          itemId: frozen.itemId,
          expectedStock: frozen.expectedStock,
          quantity: frozen.quantity,
          reason: frozen.reason,
          notes: frozen.notes,
        },
      );
      if (storageInput) clearInventoryOverlayDraft(storageInput);
      clearInventoryOperationAttempt(durableAttemptInput, frozen.requestId);
      setAttempt(null);
      onSaved?.();
      onClose();
    } catch (caught) {
      const message = errToString(caught);
      if (isDefinitiveDeliveryFailure(caught, retryLocked)) {
        clearInventoryOperationAttempt(durableAttemptInput, frozen.requestId);
        setAttempt(null);
        // Database messages can contain internal details and are not useful to
        // hotel staff. Only translate the one recovery case they can act on.
        setError(/changed after|40001/i.test(message) ? tx.stale : tx.saveFailed);
      } else {
        setError(tx.retryLocked);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!item) return null;
  return (
    <Overlay
      open={open}
      onClose={requestClose}
      hasUnsavedChanges={dirty || retryLocked}
      eyebrow={tx.eyebrow}
      title={tx.title}
      width={620}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
          <Btn size="lg" onClick={requestClose} disabled={saving}>{tx.cancel}</Btn>
          <Btn size="lg" variant="primary" style={{ minHeight: 44 }} onClick={() => void save()} disabled={saving || (!retryLocked && (!validQuantity || reservedConflict))}>
            {saving ? '…' : retryLocked ? tx.retry : tx.save}
          </Btn>
        </div>
      )}
    >
      <div className={overlayStyles.formStack}>
        {restored && <div role="status" style={{ ...warnBannerStyle, background: T.sageDim, color: T.forestText }}>{tx.restored}</div>}
        {retryLocked && <div role="alert" style={warnBannerStyle}>{tx.retryLocked}</div>}
        {error && <div role="alert" style={warnBannerStyle}>{error}</div>}
        <div style={{ fontFamily: fonts.sans, color: T.ink, fontWeight: 700, fontSize: 17 }}>{item.name}</div>
        <div className={overlayStyles.formGrid2}>
          <label>
            <span className={overlayStyles.fieldLabel}>{tx.quantity}</span>
            <input className={`${overlayStyles.formControl}`} style={{ ...inputLg, marginTop: 6 }} inputMode="numeric" value={quantity} disabled={saving || retryLocked} onChange={(event) => { if (/^\d*$/.test(event.target.value)) setQuantity(event.target.value); }} />
          </label>
          <label>
            <span className={overlayStyles.fieldLabel}>{tx.reason}</span>
            <select className={overlayStyles.formControl} style={{ ...inputLg, marginTop: 6 }} value={reason} disabled={saving || retryLocked} onChange={(event) => setReason(event.target.value as InventoryStockLossReason)}>
              {REASONS.map((value) => <option key={value} value={value}>{tx.reasons[value]}</option>)}
            </select>
          </label>
        </div>
        <div aria-live="polite" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 12, padding: 14, border: `1px solid ${reservedConflict ? T.terra : T.controlBorder}`, borderRadius: 12, fontFamily: fonts.sans }}>
          <div><div className={overlayStyles.fieldLabel}>{tx.before}</div><strong>{displayedExpectedStock}</strong></div>
          <span aria-hidden="true">→</span>
          <div style={{ textAlign: 'right' }}><div className={overlayStyles.fieldLabel}>{tx.after}</div><strong>{after}</strong></div>
          {setAside > 0 && <div style={{ gridColumn: '1 / -1', color: reservedConflict ? T.terra : T.ink2, fontSize: 12 }}>{tx.setAside}: {setAside}</div>}
        </div>
        {reservedConflict && <div role="alert" style={warnBannerStyle}>{tx.reserved}</div>}
        <label>
          <span className={overlayStyles.fieldLabel}>{tx.notes}</span>
          <textarea className={overlayStyles.formControl} rows={3} style={{ ...inputLg, height: 'auto', minHeight: 88, paddingTop: 10, marginTop: 6, resize: 'vertical' }} value={notes} disabled={saving || retryLocked} maxLength={1000} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>
    </Overlay>
  );
}
