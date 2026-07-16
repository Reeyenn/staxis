'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { T, fonts, type StockBucket } from './tokens';
import { TickNum } from './fx';
import { t, type Lang } from './inv-i18n';
import { ConfirmDialog } from './ConfirmDialog';

// A single inventory filter tab. 'all' is handled separately (pinned first);
// these are the reorderable / removable ones.
export interface InvTab {
  key: string;                 // 'general' | 'breakfast' | `custom:${uuid}`
  label: string;
  count: number;
  kind: 'builtin' | 'custom';
}

interface InventoryTabsProps {
  lang: Lang;
  allCount: number;
  bucket: StockBucket;
  onBucket: (b: StockBucket) => void;
  /** Ordered, visible tabs (excludes 'all' and hidden built-ins). */
  tabs: InvTab[];
  /** Built-in tabs the hotel has removed — offered for re-adding in edit mode. */
  hiddenBuiltins: InvTab[];
  /** Only management can rearrange / add / remove tabs. */
  canManage: boolean;
  onReorder: (keys: string[]) => void;
  onRemove: (key: string) => void;
  onRestore: (key: string) => void;
  onAdd: (name: string) => void;
}

const FLIP_EASE = 'cubic-bezier(.2,.8,.2,1)';

export function InventoryTabs({
  lang,
  allCount,
  bucket,
  onBucket,
  tabs,
  hiddenBuiltins,
  canManage,
  onReorder,
  onRemove,
  onRestore,
  onAdd,
}: InventoryTabsProps) {
  const tx = t(lang);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [pending, setPending] = useState<InvTab | null>(null);

  // Local order = array of keys. The live label/count always comes from `tabs`
  // (via byKey) so counts stay fresh; local order only drives drag rearranging.
  const [order, setOrder] = useState<string[]>(() => tabs.map((t) => t.key));
  const orderRef = useRef(order);
  orderRef.current = order;

  // Resync order whenever the SET of tab keys changes (a tab added/removed) —
  // but never mid-drag (that would fight the pointer).
  const draggingRef = useRef(false);
  const tabsKey = tabs.map((t) => t.key).join('|');
  useEffect(() => {
    if (draggingRef.current) return;
    setOrder(tabs.map((t) => t.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsKey]);

  const byKey = new Map(tabs.map((t) => [t.key, t]));
  const rendered = order.map((k) => byKey.get(k)).filter((x): x is InvTab => !!x);
  const orderKey = rendered.map((t) => t.key).join('|');

  // ── Drag + FLIP plumbing ──────────────────────────────────────────────
  const chipEls = useRef(new Map<string, HTMLElement>());
  const prevOffsets = useRef(new Map<string, { left: number; top: number }>());
  const lastEditingRef = useRef(editing);
  const dragKeyRef = useRef<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const lastDxRef = useRef(0);
  const lastDyRef = useRef(0);
  const dragOrigLeftRef = useRef(0);
  const dragOrigTopRef = useRef(0);
  const dragStartOrderRef = useRef<string[]>([]);
  // The latest order computed during the drag, updated synchronously in
  // moveDrag so endDrag never depends on a React re-render having flushed.
  const pendingOrderRef = useRef<string[]>([]);
  // Frozen chip centers (viewport space, x+y) — a stable 2-D model to hit-test
  // the pointer against while the live list reflows underneath. y is load-bearing
  // because the strip wraps to multiple rows on narrow / many-tab layouts.
  const origCentersRef = useRef<{ key: string; x: number; y: number }[]>([]);

  const setChipRef = (key: string) => (el: HTMLElement | null) => {
    if (el) chipEls.current.set(key, el);
    else chipEls.current.delete(key);
  };

  // FLIP: after any reorder, slide the non-dragged chips from their previous
  // slot to the new one; re-pin the dragged chip to the pointer.
  useLayoutEffect(() => {
    const els = chipEls.current;
    const prev = prevOffsets.current;
    const skip = lastEditingRef.current !== editing; // don't animate the edit-mode toggle
    lastEditingRef.current = editing;
    const dk = dragKeyRef.current;
    els.forEach((el, key) => {
      const left = el.offsetLeft;
      const top = el.offsetTop;
      if (key === dk) {
        // Keep the lifted chip under the cursor even though its DOM slot moved.
        const tx = dragOrigLeftRef.current - left + lastDxRef.current;
        const ty = dragOrigTopRef.current - top + lastDyRef.current;
        el.style.transition = 'none';
        el.style.transform = `translate(${tx}px, ${ty}px)`;
      } else if (!skip) {
        const p = prev.get(key);
        if (p) {
          const dx = p.left - left;
          const dy = p.top - top;
          if (dx || dy) {
            el.style.transition = 'none';
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            requestAnimationFrame(() => {
              el.style.transition = `transform 220ms ${FLIP_EASE}`;
              el.style.transform = '';
            });
          }
        }
      }
      prev.set(key, { left, top });
    });
    for (const key of Array.from(prev.keys())) if (!els.has(key)) prev.delete(key);
  }, [orderKey, editing]);

  const beginDrag = (e: React.PointerEvent, key: string) => {
    if (!editing) return;
    e.preventDefault();
    const el = chipEls.current.get(key);
    try { el?.setPointerCapture?.(e.pointerId); } catch { /* older browsers */ }
    dragKeyRef.current = key;
    setDragKey(key);
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    lastDxRef.current = 0;
    lastDyRef.current = 0;
    dragOrigLeftRef.current = el ? el.offsetLeft : 0;
    dragOrigTopRef.current = el ? el.offsetTop : 0;
    dragStartOrderRef.current = orderRef.current;
    pendingOrderRef.current = orderRef.current;
    origCentersRef.current = orderRef.current.map((k) => {
      const c = chipEls.current.get(k);
      const r = c ? c.getBoundingClientRect() : null;
      return { key: k, x: r ? r.left + r.width / 2 : 0, y: r ? r.top + r.height / 2 : 0 };
    });
  };

  const moveDrag = (e: React.PointerEvent) => {
    const dk = dragKeyRef.current;
    if (!dk) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    lastDxRef.current = dx;
    lastDyRef.current = dy;
    const el = chipEls.current.get(dk);
    if (el) {
      const tx = dragOrigLeftRef.current - el.offsetLeft + dx;
      const ty = dragOrigTopRef.current - el.offsetTop + dy;
      el.style.transform = `translate(${tx}px, ${ty}px)`;
    }
    const centers = origCentersRef.current;
    const mine = centers.find((c) => c.key === dk);
    if (!mine) return;
    const px = mine.x + dx;
    const py = mine.y + dy;
    // Reading-order (row-major) hit-test so reordering is correct even when the
    // strip wraps: the insertion index = how many other chips precede the pointer
    // (on an earlier row, or on the same row and to its left). ROW_TOL groups
    // chips whose centers sit within half a chip-height into the same row.
    const ROW_TOL = 18;
    const others = centers.filter((c) => c.key !== dk);
    let insert = 0;
    for (const c of others) {
      const before = py > c.y + ROW_TOL || (Math.abs(py - c.y) <= ROW_TOL && px > c.x);
      if (before) insert++;
    }
    const next = others.map((c) => c.key);
    next.splice(insert, 0, dk);
    pendingOrderRef.current = next;
    setOrder((prev) => (prev.join('|') === next.join('|') ? prev : next));
  };

  const endDrag = () => {
    const dk = dragKeyRef.current;
    if (!dk) return;
    const el = chipEls.current.get(dk);
    if (el) {
      el.style.transition = `transform 180ms ${FLIP_EASE}`;
      el.style.transform = '';
      window.setTimeout(() => { if (el) el.style.transition = ''; }, 200);
    }
    dragKeyRef.current = null;
    setDragKey(null);
    draggingRef.current = false;
    const committed = pendingOrderRef.current;
    if (committed.join('|') !== dragStartOrderRef.current.join('|')) onReorder(committed);
  };

  // Failsafe: if the chip's own pointerup is missed (pointer-capture failed and
  // the release landed off-element), a window-level listener still ends the drag
  // — otherwise draggingRef stays true and the resync effect freezes. endDrag is
  // idempotent, so double-firing with the chip handler is harmless.
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;
  useEffect(() => {
    if (!dragKey) return;
    const onUp = () => endDragRef.current();
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragKey]);

  // Losing management rights mid-session shouldn't strand the user in edit mode
  // (the Done button is canManage-gated) with live drag/remove controls.
  useEffect(() => {
    if (!canManage) { setEditing(false); setAdding(false); }
  }, [canManage]);

  // ── Add-tab inline input ──────────────────────────────────────────────
  const commitNew = () => {
    const name = newName.trim();
    setNewName('');
    setAdding(false);
    if (name) onAdd(name);
  };
  const cancelNew = () => { setNewName(''); setAdding(false); };

  const confirmRemove = () => {
    if (pending) onRemove(pending.key);
    setPending(null);
  };

  return (
    <>
      {/* Focused edit mode: dim the rest of the page and float the tab bar, so
          it's obvious you're editing — and tapping anywhere off the bar finishes
          (in case the Done button isn't spotted). */}
      {editing && (
        <div
          onPointerDown={() => { setEditing(false); setAdding(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 40,
            background: 'rgba(31,35,28,0.30)',
            backdropFilter: 'blur(2px)', WebkitBackdropFilter: 'blur(2px)',
          }}
        />
      )}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          ...(editing
            ? {
                position: 'relative', zIndex: 41,
                background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 14,
                padding: '9px 11px', boxShadow: '0 24px 60px -22px rgba(31,42,32,0.5)',
              }
            : {}),
        }}
      >
        {/* All — pinned first, always selectable, never draggable/removable. */}
        <SelectChip
          active={bucket === 'all'}
          label={tx.all}
          count={allCount}
          dim={editing}
          onClick={() => onBucket('all')}
        />

        {rendered.map((tab) =>
          editing ? (
            <EditChip
              key={tab.key}
              ref={setChipRef(tab.key)}
              tab={tab}
              active={bucket === tab.key}
              dragging={dragKey === tab.key}
              removeLabel={tx.removeTab}
              onPointerDown={(e) => beginDrag(e, tab.key)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onRemove={() => setPending(tab)}
            />
          ) : (
            <SelectChip
              key={tab.key}
              active={bucket === tab.key}
              label={tab.label}
              count={tab.count}
              onClick={() => onBucket(tab.key as StockBucket)}
            />
          ),
        )}

        {/* Add a tab — while adding, also offer to bring back any removed
            built-ins (so they aren't clutter in the bar, but aren't a dead end). */}
        {editing && (
          adding ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitNew(); }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelNew(); }
                }}
                onBlur={cancelNew}
                placeholder={tx.newTabPh}
                maxLength={40}
                style={{
                  height: 34, width: 150, padding: '0 12px', borderRadius: 999,
                  background: T.bg, border: `1px solid ${T.ink}`, fontFamily: fonts.sans,
                  fontSize: 12.5, color: T.ink, outline: 'none',
                }}
              />
              {hiddenBuiltins.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  // Fire on pointerDOWN (before the input's onBlur can cancel the
                  // add flow) — reliable on touch where preventDefault-to-hold-
                  // focus isn't guaranteed. onClick is the keyboard fallback; the
                  // pointerdown path unmounts this button first, so it never double-fires.
                  onPointerDown={(e) => { e.preventDefault(); onRestore(tab.key); setNewName(''); setAdding(false); }}
                  onClick={() => { onRestore(tab.key); setNewName(''); setAdding(false); }}
                  style={{
                    height: 34, padding: '0 12px', borderRadius: 999, cursor: 'pointer',
                    background: T.forestDim, color: T.forestText, border: `1px solid rgba(92,122,96,0.28)`,
                    fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1 }}>＋</span>{tab.label}
                </button>
              ))}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              style={{
                height: 34, padding: '0 14px', borderRadius: 999, cursor: 'pointer',
                background: 'transparent', color: T.ink2, border: `1px dashed ${T.rule}`,
                fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 500,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <span style={{ fontSize: 16, lineHeight: 1 }}>＋</span>{tx.addTab}
            </button>
          )
        )}

        {/* Edit / Done toggle — a bright, prominent Done while editing. */}
        {canManage && (
          <button
            type="button"
            onClick={() => { setEditing((v) => !v); setAdding(false); }}
            style={editing ? {
              height: 36, padding: '0 18px', borderRadius: 999, cursor: 'pointer', marginLeft: 4,
              background: T.brand, color: '#fff', border: `1px solid ${T.brand}`,
              fontFamily: fonts.sans, fontSize: 13, fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              boxShadow: '0 8px 18px -6px rgba(62,92,72,0.55)',
            } : {
              height: 34, padding: '0 14px', borderRadius: 999, cursor: 'pointer', marginLeft: 2,
              background: 'transparent', color: T.ink2, border: `1px solid ${T.rule}`,
              fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {editing ? `✓ ${tx.doneEditing}` : `✎ ${tx.editTabs}`}
          </button>
        )}

        {editing && (
          <span style={{ width: '100%', fontFamily: fonts.sans, fontSize: 11.5, color: T.ink3, paddingTop: 3 }}>
            {tx.dragHint}
          </span>
        )}
      </div>

      <ConfirmDialog
        open={!!pending}
        title={tx.removeTabTitle}
        message={pending?.kind === 'custom' ? tx.removeCustomMsg : tx.removeBuiltinMsg}
        confirmLabel={tx.removeConfirmBtn}
        cancelLabel={tx.cancelBtn}
        danger
        onConfirm={confirmRemove}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

// ── Plain selectable chip (normal mode + the pinned All chip) ───────────────
function SelectChip({
  active, label, count, dim, onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  dim?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, height: 34, padding: '0 14px',
        background: active ? T.ink : 'transparent',
        border: `1px solid ${active ? T.ink : T.rule}`,
        borderRadius: 999, cursor: 'pointer',
        color: active ? T.bg : T.ink2,
        fontFamily: fonts.sans, fontSize: 12.5, fontWeight: active ? 600 : 500,
        opacity: dim ? 0.6 : 1,
        transition: 'opacity .16s ease',
      }}
    >
      {label}
      <span style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: active ? 'rgba(255,255,255,0.6)' : T.dim }}>
        <TickNum>{count}</TickNum>
      </span>
    </button>
  );
}

// ── Draggable, removable chip (edit mode) ───────────────────────────────────
const EditChip = React.forwardRef<HTMLDivElement, {
  tab: InvTab;
  active: boolean;
  dragging: boolean;
  removeLabel: string;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onRemove: () => void;
}>(function EditChip({ tab, active, dragging, removeLabel, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onRemove }, ref) {
  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 8px 0 10px',
        background: active ? T.ink : T.bg,
        border: `1px solid ${active ? T.ink : T.rule}`,
        borderRadius: 999,
        color: active ? T.bg : T.ink2,
        fontFamily: fonts.sans, fontSize: 12.5, fontWeight: active ? 600 : 500,
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none', userSelect: 'none',
        boxShadow: dragging ? '0 12px 26px -10px rgba(31,42,32,0.45)' : 'none',
        transform: dragging ? 'scale(1.04)' : undefined,
        position: 'relative', zIndex: dragging ? 5 : 1,
      }}
    >
      {/* grip affordance */}
      <span aria-hidden style={{ fontSize: 11, letterSpacing: -1, lineHeight: 1, color: active ? 'rgba(255,255,255,0.5)' : T.faint }}>⣿</span>
      {tab.label}
      <span style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: active ? 'rgba(255,255,255,0.6)' : T.dim }}>
        {tab.count}
      </span>
      <button
        type="button"
        aria-label={removeLabel}
        title={removeLabel}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        style={{
          width: 20, height: 20, borderRadius: 999, cursor: 'pointer', marginLeft: 1,
          background: active ? 'rgba(255,255,255,0.16)' : T.terraDim,
          border: 'none', color: active ? '#FFFFFF' : T.terra,
          fontSize: 12, lineHeight: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        ✕
      </button>
    </div>
  );
});
