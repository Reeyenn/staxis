'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { correctInventoryDeliveryAtomic } from '@/lib/db';
import type { InventoryDeliveryCorrectionLine } from '@/lib/inventory-atomic';
import { errToString, generateId } from '@/lib/utils';
import type { EffectiveInventoryDelivery, InventoryItem } from '@/types';
import { Btn } from '../Btn';
import { fmtMoney } from '../format';
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

interface DeliveryCorrectionSheetProps {
  open: boolean;
  lang: Lang;
  delivery: EffectiveInventoryDelivery | null;
  items: InventoryItem[];
  onClose: () => void;
  onSaved?: () => void;
  onAddDelivery: () => void;
}

interface FrozenCorrectionAttempt {
  requestId: string;
  correctedAt: string;
  reason: string;
  line: InventoryDeliveryCorrectionLine;
}

interface CorrectionDraft {
  signature: string;
  selectedItemId: string;
  quantity: string;
  unitCost: string;
  reason: string;
  voiding: boolean;
  attempt: FrozenCorrectionAttempt | null;
}

function copy(lang: Lang) {
  return lang === 'es' ? {
    eyebrow: 'Historial de entrega', title: 'Corregir entrega guardada',
    intro: 'La entrega original nunca se borra. Esta acción agrega una corrección permanente al historial.',
    item: 'Artículo correcto', quantity: 'Cantidad correcta', unitCost: 'Costo unitario correcto (opcional si se desconoce)', reason: 'Motivo requerido',
    before: 'Guardado ahora', after: 'Después de la corrección', voided: 'Entrega anulada',
    correctionCount: (n: number) => `${n} ${n === 1 ? 'corrección anterior' : 'correcciones anteriores'}`,
    physicalCount: 'Si se hizo un conteo físico después de esta entrega, el historial y los dólares se corrigen, pero el conteo físico más reciente sigue mandando sobre las existencias actuales.',
    void: 'Anular entrega', undoVoid: 'No anular', save: 'Guardar corrección', retry: 'Reintentar exactamente', cancel: 'Cancelar',
    addDelivery: 'Agregar nueva entrega', terminalTitle: 'Esta entrega ya fue anulada',
    terminalBody: 'Una anulación es final para mantener el historial claro. Si la mercancía sí llegó, registra una nueva entrega.',
    restored: 'Se recuperó una corrección sin guardar de esta pestaña.',
    locked: 'El resultado anterior no se pudo confirmar. Reintenta exactamente estos datos para no crear una corrección duplicada.',
    required: 'Selecciona un artículo, escribe una cantidad mayor que cero y el motivo. Si ingresas un costo, debe ser válido.',
    unchanged: 'Cambia el artículo, la cantidad o el costo antes de guardar.',
    voidConfirm: '¿Anular esta entrega? La anulación es permanente; si luego llegó mercancía, tendrás que agregar una entrega nueva.',
    discard: '¿Cerrar esta pantalla? La corrección queda guardada y podrás recuperarla al volver.',
    stale: 'Esta entrega cambió desde que abriste la pantalla. Cierra, actualiza el historial y vuelve a intentarlo.',
    closedMonth: 'Esta entrega pertenece a un mes cerrado y no puede cambiarse.',
    failed: 'No se pudo guardar la corrección. Nada fue reemplazado.',
    unsafe: 'La corrección no se envió porque no se pudo guardar un reintento seguro en esta pestaña. Tus cambios siguen aquí.',
    unavailableItem: 'Artículo original eliminado',
  } : {
    eyebrow: 'Delivery history', title: 'Correct saved delivery',
    intro: 'The original delivery is never erased. This adds a permanent correction to its history.',
    item: 'Correct item', quantity: 'Correct quantity', unitCost: 'Correct unit cost (optional if unknown)', reason: 'Required reason',
    before: 'Currently saved', after: 'After correction', voided: 'Delivery voided',
    correctionCount: (n: number) => `${n} earlier ${n === 1 ? 'correction' : 'corrections'}`,
    physicalCount: 'If a physical count happened after this delivery, the history and dollars are corrected, but the newer physical count remains the source of truth for current on-hand stock.',
    void: 'Void delivery', undoVoid: 'Keep delivery', save: 'Save correction', retry: 'Retry exact correction', cancel: 'Cancel',
    addDelivery: 'Add new delivery', terminalTitle: 'This delivery is already voided',
    terminalBody: 'A void is final so the history stays clear. If stock really arrived, record it as a new delivery.',
    restored: 'An unsaved correction from this tab was restored.',
    locked: 'The previous result could not be confirmed. Retry these exact values so a duplicate correction cannot be created.',
    required: 'Choose an item, enter a quantity greater than zero, and give a reason. If you enter a cost, it must be valid.',
    unchanged: 'Change the item, quantity, or cost before saving.',
    voidConfirm: 'Void this delivery? A void is permanent; if stock later arrived, you must add a new delivery.',
    discard: 'Close this screen? This correction is saved and can be recovered when you return.',
    stale: 'This delivery changed after the screen opened. Close, refresh History, and try again.',
    closedMonth: 'This delivery belongs to a closed month and cannot be changed.',
    failed: 'The correction could not be saved. Nothing was replaced.',
    unsafe: 'The correction was not sent because this tab could not save a safe retry. Your changes are still here.',
    unavailableItem: 'Deleted original item',
  };
}

function signature(delivery: EffectiveInventoryDelivery): string {
  return JSON.stringify([
    delivery.rootOrderId,
    delivery.status,
    delivery.effectiveItemId,
    delivery.effectiveQuantity,
    delivery.effectiveUnitCost,
    delivery.correctionCount,
  ]);
}

function validDraft(value: unknown, delivery: EffectiveInventoryDelivery): CorrectionDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<CorrectionDraft>;
  if (draft.signature !== signature(delivery)) return null;
  if (
    typeof draft.selectedItemId !== 'string'
    || typeof draft.quantity !== 'string'
    || typeof draft.unitCost !== 'string'
    || typeof draft.reason !== 'string'
    || typeof draft.voiding !== 'boolean'
  ) return null;
  return {
    signature: draft.signature,
    selectedItemId: draft.selectedItemId,
    quantity: draft.quantity,
    unitCost: draft.unitCost,
    reason: draft.reason,
    voiding: draft.voiding,
    attempt: draft.attempt && typeof draft.attempt === 'object'
      ? draft.attempt as FrozenCorrectionAttempt
      : null,
  };
}

function validFrozenCorrectionAttempt(
  value: unknown,
  rootOrderId: string,
): FrozenCorrectionAttempt | null {
  if (!value || typeof value !== 'object') return null;
  const attempt = value as Partial<FrozenCorrectionAttempt>;
  const line = attempt.line as Partial<InventoryDeliveryCorrectionLine> | undefined;
  if (
    typeof attempt.requestId !== 'string'
    || typeof attempt.correctedAt !== 'string'
    || Number.isNaN(new Date(attempt.correctedAt).getTime())
    || typeof attempt.reason !== 'string'
    || !attempt.reason.trim()
    || !line
    || line.orderId !== rootOrderId
    || line.lineKey !== rootOrderId
    || typeof line.expectedItemId !== 'string'
    || !Number.isFinite(line.expectedQuantity)
    || !Number.isFinite(line.correctedQuantity)
    || (line.correctedItemId !== null && typeof line.correctedItemId !== 'string')
  ) return null;
  return attempt as FrozenCorrectionAttempt;
}

function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

export function DeliveryCorrectionSheet({
  open,
  lang,
  delivery,
  items,
  onClose,
  onSaved,
  onAddDelivery,
}: DeliveryCorrectionSheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const tx = copy(lang);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  const [attempt, setAttempt] = useState<FrozenCorrectionAttempt | null>(null);
  const [restored, setRestored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const currentSignature = delivery ? signature(delivery) : '';
  const storageInput = useMemo(() => user?.uid && activePropertyId && delivery
    ? { kind: 'delivery-correction' as const, userId: user.uid, propertyId: activePropertyId, scope: delivery.rootOrderId }
    : null, [activePropertyId, delivery, user?.uid]);
  const durableAttemptInput = useMemo(() => user?.uid && activePropertyId && delivery
    ? { kind: 'delivery-correction' as const, userId: user.uid, propertyId: activePropertyId, scope: delivery.rootOrderId }
    : null, [activePropertyId, delivery, user?.uid]);
  const retryLocked = attempt != null;
  const parsedQuantity = Number(quantity);
  const parsedCost = numberOrNull(unitCost);
  const fieldsValid = voiding || (
    selectedItemId !== ''
    && quantity.trim() !== ''
    && Number.isFinite(parsedQuantity)
    && parsedQuantity > 0
    && (parsedCost == null || Number.isFinite(parsedCost))
  );
  const changed = delivery != null && (voiding
    || selectedItemId !== delivery.effectiveItemId
    || parsedQuantity !== delivery.effectiveQuantity
    || parsedCost !== delivery.effectiveUnitCost);
  const dirty = delivery != null && (
    selectedItemId !== (delivery.effectiveItemId ?? '')
    || quantity !== String(delivery.effectiveQuantity)
    || unitCost !== (delivery.effectiveUnitCost == null ? '' : String(delivery.effectiveUnitCost))
    || reason.trim() !== ''
    || voiding
    || retryLocked
  );

  useEffect(() => {
    if (!open || !delivery) return;
    let durableAttempt = durableAttemptInput
      ? loadInventoryOperationAttempt(
          durableAttemptInput,
          (value) => validFrozenCorrectionAttempt(value, delivery.rootOrderId),
        )
      : null;
    // Realtime may reveal that the previously unknown request committed before
    // the sheet reopens. The audit row's request UUID is definitive evidence,
    // so the local recovery envelope can be retired without another RPC.
    if (durableAttempt && delivery.lastCorrection?.requestId === durableAttempt.requestId) {
      clearInventoryOperationAttempt(durableAttemptInput!, durableAttempt.requestId);
      durableAttempt = null;
    }
    const stored = storageInput
      ? validDraft(loadInventoryOverlayDraft<CorrectionDraft>(storageInput), delivery)
      : null;
    const frozenLine = durableAttempt?.line;
    const frozenVoiding = frozenLine?.correctedQuantity === 0 && frozenLine.correctedItemId == null;
    setSelectedItemId(durableAttempt
      ? frozenLine?.correctedItemId ?? ''
      : stored?.selectedItemId ?? delivery.effectiveItemId ?? '');
    setQuantity(durableAttempt ? String(frozenLine?.correctedQuantity ?? 0) : stored?.quantity ?? String(delivery.effectiveQuantity));
    setUnitCost(durableAttempt
      ? (frozenLine?.correctedUnitCost == null ? '' : String(frozenLine.correctedUnitCost))
      : stored?.unitCost ?? (delivery.effectiveUnitCost == null ? '' : String(delivery.effectiveUnitCost)));
    setReason(durableAttempt?.reason ?? stored?.reason ?? '');
    setVoiding(durableAttempt ? frozenVoiding : stored?.voiding ?? false);
    setAttempt(durableAttempt);
    setRestored(Boolean(durableAttempt || stored));
    setSaving(false);
    setError('');
  }, [delivery, durableAttemptInput, open, storageInput]);

  useEffect(() => {
    if (!open || !delivery || !storageInput) return;
    if (!dirty) {
      clearInventoryOverlayDraft(storageInput);
      return;
    }
    persistInventoryOverlayDraft({
      ...storageInput,
      data: {
        signature: currentSignature,
        selectedItemId,
        quantity,
        unitCost,
        reason,
        voiding,
        attempt,
      } satisfies CorrectionDraft,
    });
  }, [attempt, currentSignature, delivery, dirty, open, quantity, reason, selectedItemId, storageInput, unitCost, voiding]);

  const requestClose = () => {
    if (dirty && !window.confirm(tx.discard)) return;
    onClose();
  };

  const pickItem = (itemId: string) => {
    setSelectedItemId(itemId);
    // A rematch changes which item received the line, not what the invoice
    // charged. Never replace delivery evidence with the catalog item's latest
    // cost just because a different item was selected.
  };

  const save = async () => {
    if (!user || !activePropertyId || !delivery || !delivery.effectiveItemId || saving) return;
    setError('');
    if (!retryLocked && (!fieldsValid || !reason.trim())) {
      setError(tx.required);
      return;
    }
    if (!retryLocked && !changed) {
      setError(tx.unchanged);
      return;
    }
    if (!retryLocked && voiding && !window.confirm(tx.voidConfirm)) return;
    const line: InventoryDeliveryCorrectionLine = attempt?.line ?? {
      lineKey: delivery.rootOrderId,
      orderId: delivery.rootOrderId,
      expectedItemId: delivery.effectiveItemId,
      expectedQuantity: delivery.effectiveQuantity,
      expectedUnitCost: delivery.effectiveUnitCost,
      correctedItemId: voiding ? null : selectedItemId,
      correctedQuantity: voiding ? 0 : parsedQuantity,
      correctedUnitCost: voiding ? null : parsedCost,
    };
    const frozen = attempt ?? {
      requestId: generateId(),
      correctedAt: new Date().toISOString(),
      reason: reason.trim(),
      line,
    };
    const frozenDraft = {
      signature: currentSignature, selectedItemId, quantity, unitCost, reason, voiding, attempt: frozen,
    } satisfies CorrectionDraft;
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
      (value) => validFrozenCorrectionAttempt(value, delivery.rootOrderId),
    );
    if (JSON.stringify(verified) !== JSON.stringify(frozen)) {
      setError(tx.unsafe);
      return;
    }
    setAttempt(frozen);
    setSaving(true);
    try {
      await correctInventoryDeliveryAtomic(
        user.uid,
        activePropertyId,
        frozen.requestId,
        new Date(frozen.correctedAt),
        user.displayName || user.username || 'team',
        frozen.reason,
        [frozen.line],
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
        if (/closed month/i.test(message)) setError(tx.closedMonth);
        else if (/changed after|already voided|40001/i.test(message)) setError(tx.stale);
        else setError(tx.failed);
      } else {
        setError(tx.locked);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!delivery) return null;
  if (delivery.status === 'voided' || !delivery.effectiveItemId) {
    return (
      <Overlay open={open} onClose={onClose} eyebrow={tx.eyebrow} title={tx.terminalTitle} width={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: fonts.sans, color: T.ink2, lineHeight: 1.55 }}>
          <div>{tx.terminalBody}</div>
          {delivery.lastCorrection?.reason && <div><strong style={{ color: T.ink }}>{tx.reason}:</strong> {delivery.lastCorrection.reason}</div>}
          <Btn variant="primary" size="lg" style={{ minHeight: 44, alignSelf: 'flex-start' }} onClick={onAddDelivery}>{tx.addDelivery}</Btn>
        </div>
      </Overlay>
    );
  }

  const beforeCost = delivery.effectiveUnitCost;
  const afterItem = items.find((item) => item.id === selectedItemId);
  const afterLabel = voiding ? tx.voided : `${afterItem?.name ?? delivery.effectiveItemName ?? tx.unavailableItem} · ${quantity || '—'} · ${parsedCost == null || Number.isNaN(parsedCost) ? '—' : fmtMoney(parsedCost)}`;
  return (
    <Overlay
      open={open}
      onClose={requestClose}
      hasUnsavedChanges={dirty}
      eyebrow={tx.eyebrow}
      title={tx.title}
      width={700}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', width: '100%' }}>
          <Btn size="lg" style={{ minHeight: 44, color: voiding ? T.ink2 : T.terra, borderColor: voiding ? T.controlBorder : T.terra }} onClick={() => setVoiding((value) => !value)} disabled={saving || retryLocked}>
            {voiding ? tx.undoVoid : tx.void}
          </Btn>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Btn size="lg" onClick={requestClose} disabled={saving}>{tx.cancel}</Btn>
            <Btn size="lg" variant="primary" style={{ minHeight: 44 }} onClick={() => void save()} disabled={saving || (!retryLocked && (!fieldsValid || !reason.trim() || !changed))}>
              {saving ? '…' : retryLocked ? tx.retry : tx.save}
            </Btn>
          </div>
        </div>
      )}
    >
      <div className={overlayStyles.formStack}>
        <div style={{ fontFamily: fonts.sans, color: T.ink2, lineHeight: 1.55 }}>{tx.intro}</div>
        {delivery.correctionCount > 0 && <div style={{ fontFamily: fonts.sans, color: T.ink2, fontSize: 12 }}>{tx.correctionCount(delivery.correctionCount)}</div>}
        {restored && <div role="status" style={{ ...warnBannerStyle, background: T.sageDim, color: T.forestText }}>{tx.restored}</div>}
        {retryLocked && <div role="alert" style={warnBannerStyle}>{tx.locked}</div>}
        {error && <div role="alert" style={warnBannerStyle}>{error}</div>}
        {!voiding && (
          <div className={overlayStyles.formGrid3}>
            <label>
              <span className={overlayStyles.fieldLabel}>{tx.item}</span>
              <select className={overlayStyles.formControl} style={{ ...inputLg, marginTop: 6 }} value={selectedItemId} disabled={saving || retryLocked} onChange={(event) => pickItem(event.target.value)}>
                {!items.some((item) => item.id === delivery.effectiveItemId) && <option value={delivery.effectiveItemId}>{delivery.effectiveItemName ?? tx.unavailableItem} ({tx.unavailableItem})</option>}
                {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label>
              <span className={overlayStyles.fieldLabel}>{tx.quantity}</span>
              <input className={overlayStyles.formControl} style={{ ...inputLg, marginTop: 6 }} inputMode="decimal" value={quantity} disabled={saving || retryLocked} onChange={(event) => { if (/^\d*\.?\d*$/.test(event.target.value)) setQuantity(event.target.value); }} />
            </label>
            <label>
              <span className={overlayStyles.fieldLabel}>{tx.unitCost}</span>
              <input className={overlayStyles.formControl} style={{ ...inputLg, marginTop: 6 }} inputMode="decimal" value={unitCost} disabled={saving || retryLocked} onChange={(event) => { if (/^\d*\.?\d*$/.test(event.target.value)) setUnitCost(event.target.value); }} />
            </label>
          </div>
        )}
        <label>
          <span className={overlayStyles.fieldLabel}>{tx.reason}</span>
          <textarea className={overlayStyles.formControl} rows={3} maxLength={1000} style={{ ...inputLg, height: 'auto', minHeight: 88, paddingTop: 10, marginTop: 6, resize: 'vertical' }} value={reason} disabled={saving || retryLocked} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10, padding: 14, border: `1px solid ${T.controlBorder}`, borderRadius: 12, fontFamily: fonts.sans }}>
          <div><div className={overlayStyles.fieldLabel}>{tx.before}</div><strong>{delivery.effectiveItemName} · {delivery.effectiveQuantity} · {beforeCost == null ? '—' : fmtMoney(beforeCost)}</strong></div>
          <div aria-hidden="true">↓</div>
          <div><div className={overlayStyles.fieldLabel}>{tx.after}</div><strong style={{ color: voiding ? T.terra : T.ink }}>{afterLabel}</strong></div>
        </div>
        <div role="note" style={{ padding: 12, borderRadius: 10, background: T.inkWash, fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2, lineHeight: 1.5 }}>{tx.physicalCount}</div>
      </div>
    </Overlay>
  );
}
