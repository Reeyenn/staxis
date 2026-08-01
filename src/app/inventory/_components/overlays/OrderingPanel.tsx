'use client';

// ─── The Ordering Manager screen ─────────────────────────────────────────────
//
// STATE-AWARE BY CONSTRUCTION. What this renders is decided entirely by what
// the database already holds, and the rule it enforces is "never ask for what
// we already know":
//
//   no items at all          → the empty state, honest about needing inventory
//   never opened before      → the one-time welcome, then never again
//   vendors we can guess at  → suggestions, clearly marked as guesses
//   a vendor with no method  → one chip, on that vendor's row only
//   everything known         → straight to the order cards
//
// There is no wizard and no setup mode. Setup happens by doing: the "who
// supplies this?" chip on an item and the method chip on a vendor row are the
// only two questions this screen ever asks, and each appears only next to the
// thing it is missing.
//
// THE 60-SECOND UNDO IS CLIENT-SIDE AND THE UI SAYS SO. The send API is not
// called until the countdown ends, so "undo" is really "we have not started
// yet" — which is stronger than a recall, and is also why closing the screen
// mid-countdown sends nothing. Both facts are stated in the UI rather than
// left for a manager to discover the hard way.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { T, fonts } from '../tokens';
import { Overlay } from './Overlay';
import { type Lang } from '../inv-i18n';
import { orderingStrings, type OrderingStrings } from './ordering-i18n';
import {
  createSendCountdown,
  fetchOrderingState,
  postOrdering,
  runOrderingAction,
  type SendCountdown,
} from './ordering-actions';
import { telHref } from '@/components/concourse/told-knowledge';
import { moneyFromCents } from '@/lib/format';
import { approxWeekly, daysLeftCue, levelRatio } from './ordering-presentation';
import type {
  BucketKey,
  OrderBlockReason,
  OrderCandidate,
  OrderGroup,
  OrderMethod,
  Vendor,
  VendorSuggestion,
} from '@/lib/ordering/types';

interface CategoryOption {
  bucketKey: BucketKey;
  label: string | null;
  itemCount: number;
}

interface OrderingState {
  introDismissedAt: string | null;
  hasInventory: boolean;
  vendors: Vendor[];
  suggestions: VendorSuggestion[];
  categories: CategoryOption[];
  categoryMap: Array<{ bucketKey: BucketKey; vendorId: string }>;
  groups: OrderGroup[];
  burnBasis: { source: string; daysOfData: number; mlItems: number };
}

interface OrderingPanelProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  propertyId: string;
  /** External vendor email is manager-only; ordinary inventory/order setup is not. */
  canSendPurchaseOrders: boolean;
}

const UNDO_SECONDS = 60;

/** Category labels for the two built-in buckets are ours to translate; a
 *  custom category's label is the hotel's own text and is shown verbatim. */
function categoryLabel(option: CategoryOption, lang: Lang): string {
  if (option.label) return option.label;
  if (option.bucketKey === 'breakfast') return 'Breakfast';
  return 'General';
}

function blockedLabel(reason: OrderBlockReason, tx: OrderingStrings): string {
  switch (reason) {
    case 'method_unknown': return tx.blockedMethod;
    case 'no_email': return tx.blockedEmail;
    case 'no_url': return tx.blockedUrl;
    case 'no_phone': return tx.blockedPhone;
    case 'unconfirmed': return tx.blockedUnconfirmed;
  }
}

function methodLabel(method: OrderMethod, tx: OrderingStrings): string {
  switch (method) {
    case 'email': return tx.methodEmail;
    case 'website': return tx.methodWebsite;
    case 'store': return tx.methodStore;
    case 'phone': return tx.methodPhone;
  }
}

/** One decimal, trailing zero trimmed — "9" not "9.0", "1.5" stays "1.5". */
function trim(n: number): string {
  return String(Math.round(n * 10) / 10);
}

export function OrderingPanel({
  lang,
  open,
  onClose,
  propertyId,
  canSendPurchaseOrders,
}: OrderingPanelProps) {
  const tx = orderingStrings(lang);
  const [state, setState] = useState<OrderingState | null>(null);
  const [loading, setLoading] = useState(false);
  // A first load that fails has to SAY so. Without this the panel rendered an
  // empty box and only recovered if the manager thought to close and reopen
  // it, which reads as "the hotel has nothing to order" rather than as a
  // failure. A reload that fails while there is already something on screen
  // still keeps the last good render, which is the honest choice there.
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Carries its own tone: a failure that renders in the same green box as a
  // success is barely better than no message at all.
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  // vendorId → seconds remaining. Present means a send is counting down and
  // has NOT been called yet.
  const [pending, setPending] = useState<Record<string, number>>({});
  const countdownRef = useRef<SendCountdown | null>(null);
  if (!countdownRef.current) {
    countdownRef.current = createSendCountdown({
      seconds: UNDO_SECONDS,
      onSecond: (vendorId, secondsLeft) => setPending((prev) => {
        if (secondsLeft === null) {
          if (!(vendorId in prev)) return prev;
          const next = { ...prev };
          delete next[vendorId];
          return next;
        }
        return { ...prev, [vendorId]: secondsLeft };
      }),
    });
  }
  const countdown = countdownRef.current;

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchOrderingState<OrderingState>(propertyId);
    if (result.ok) {
      setState(result.state);
      setLoadFailed(false);
    } else {
      // The panel stays on its last good render rather than blanking; the
      // flag only decides what shows when there is no good render yet.
      setLoadFailed(true);
    }
    setLoading(false);
  }, [propertyId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Every countdown is torn down when the panel unmounts or closes. This is
  // what makes "close the screen and nothing goes out" true rather than a
  // hopeful sentence — the interval that would have fired the send is gone.
  useEffect(() => {
    if (open) return;
    countdown.stopAll();
    setPending({});
  }, [open, countdown]);
  useEffect(() => () => { countdown.stopAll(); }, [countdown]);

  const post = useCallback(
    (body: Record<string, unknown>) => postOrdering(propertyId, body),
    [propertyId],
  );

  const act = useCallback((key: string, body: Record<string, unknown>) => runOrderingAction({
    key,
    post: () => post(body),
    setBusy,
    // A write that did not land says so. Clearing the notice on success is
    // what stops a stale failure sitting over a screen that has since worked.
    onResult: (succeeded) => setNotice(succeeded ? null : { tone: 'bad', text: tx.actionFailed }),
    reload: load,
  }), [post, load, tx.actionFailed]);

  // ── The send, and the 60 seconds before it ──
  const startSend = useCallback((group: OrderGroup) => {
    const vendorId = group.vendorId;
    if (!vendorId) return;
    const itemIds = group.items.map((i) => i.itemId);
    countdown.start(vendorId, async () => {
      let sent = false;
      try {
        sent = await post({ action: 'send_po', vendorId, itemIds });
      } finally {
        // Whichever way it went, the manager is told and the screen refetches.
        // A send that fails quietly is the one outcome this panel must never
        // produce: the manager walks away believing the supplier has the order.
        setNotice(sent
          ? { tone: 'ok', text: tx.sent }
          : { tone: 'bad', text: tx.sendFailed });
        await load();
      }
    });
  }, [countdown, post, load, tx.sent, tx.sendFailed]);

  const cancelSend = useCallback(
    (vendorId: string) => countdown.cancel(vendorId),
    [countdown],
  );

  const categoriesByKey = useMemo(() => {
    const map = new Map<BucketKey, CategoryOption>();
    for (const c of state?.categories ?? []) map.set(c.bucketKey, c);
    return map;
  }, [state?.categories]);

  const showWelcome = !!state && state.introDismissedAt === null;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      eyebrow={tx.eyebrow}
      title={tx.title}
      width={780}
      accent={T.brand}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {notice && (
          <div
            style={notice.tone === 'bad'
              ? chipBox(T.terraDim, T.terra)
              : chipBox(T.forestDim, T.forestText)}
            role={notice.tone === 'bad' ? 'alert' : 'status'}
          >
            {notice.text}
          </div>
        )}

        {showWelcome && (
          <Welcome tx={tx} onGo={() => void act('intro', { action: 'dismiss_intro' })} busy={busy === 'intro'} />
        )}

        {state && !showWelcome && (
          <>
            {!state.hasInventory && <EmptyState tx={tx} noItems />}

            {state.hasInventory && state.suggestions.length > 0 && (
              <Suggestions
                tx={tx}
                suggestions={state.suggestions}
                categories={state.categories}
                lang={lang}
                busy={busy}
                onConfirm={(s, buckets, method) => void act(`sug:${s.key}`, {
                  action: 'confirm_suggestion',
                  name: s.name,
                  email: s.email,
                  phone: s.phone,
                  knowledgeContactId: s.knowledgeContactId,
                  orderMethod: method,
                  bucketKeys: buckets,
                })}
              />
            )}

            {state.hasInventory && state.groups.length === 0 && state.vendors.length === 0
              && state.suggestions.length === 0 && <EmptyState tx={tx} />}

            {state.hasInventory && state.groups.length === 0 && (state.vendors.length > 0 || state.suggestions.length > 0) && (
              <div style={{ padding: '22px 4px' }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 15, fontWeight: 650, color: T.ink }}>{tx.allClearTitle}</div>
                <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, marginTop: 4 }}>{tx.allClearBody}</div>
              </div>
            )}

            {state.groups.map((group) => (
              <GroupCard
                key={group.vendorId ?? 'unmatched'}
                group={group}
                tx={tx}
                lang={lang}
                vendors={state.vendors}
                categoriesByKey={categoriesByKey}
                pendingSeconds={group.vendorId ? pending[group.vendorId] : undefined}
                busy={busy}
                canSendPurchaseOrders={canSendPurchaseOrders}
                onStartSend={() => startSend(group)}
                onCancelSend={() => group.vendorId && cancelSend(group.vendorId)}
                onMarkOrdered={(method) => void act(`mark:${group.vendorId ?? 'x'}`, {
                  action: 'mark_ordered',
                  vendorId: group.vendorId,
                  placedVia: method,
                  itemIds: group.items.map((i) => i.itemId),
                })}
                onSetMethod={(vendorId, method, websiteUrl) => void act(`method:${vendorId}`, {
                  action: 'set_vendor_method',
                  vendorId,
                  orderMethod: method,
                  websiteUrl,
                })}
                onSetItemVendor={(itemId, vendorId) => void act(`item:${itemId}`, {
                  action: 'set_item_vendor',
                  itemId,
                  vendorId,
                })}
                onSetCategoryVendor={(bucketKey, vendorId) => void act(`cat:${bucketKey}`, {
                  action: 'set_category_vendor',
                  bucketKey,
                  vendorId,
                })}
              />
            ))}

            {state.groups.length > 0 && <BasisFooter tx={tx} basis={state.burnBasis} />}
          </>
        )}

        {loadFailed && !state && !loading && (
          <LoadFailed tx={tx} onRetry={() => void load()} />
        )}

        {loading && !state && (
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, padding: '20px 4px' }}>…</div>
        )}
      </div>
    </Overlay>
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

function chipBox(bg: string, color: string): React.CSSProperties {
  return {
    padding: '8px 12px',
    borderRadius: 9,
    background: bg,
    color,
    fontFamily: fonts.sans,
    fontSize: 12.5,
    lineHeight: 1.5,
  };
}

export function Welcome({ tx, onGo, busy }: { tx: OrderingStrings; onGo: () => void; busy: boolean }) {
  return (
    <section
      style={{
        border: `1px solid ${T.rule}`,
        borderRadius: 14,
        padding: 18,
        background: T.inkWash,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ fontFamily: fonts.sans, fontSize: 16, fontWeight: 700, color: T.ink }}>{tx.welcomeTitle}</div>
      <p style={{ margin: 0, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.6, color: T.ink2 }}>{tx.welcomeLine1}</p>
      <p style={{ margin: 0, fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.6, color: T.ink2 }}>{tx.welcomeLine2}</p>
      <p style={{ margin: '4px 0 0', fontFamily: fonts.sans, fontSize: 13.5, lineHeight: 1.6, color: T.ink }}>{tx.welcomeLine3}</p>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[tx.welcomeEmail, tx.welcomeWebsite, tx.welcomeStore, tx.welcomePhone].map((line) => (
          <li key={line} style={{ fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 1.55, color: T.ink2 }}>{line}</li>
        ))}
      </ul>
      <div>
        <button type="button" onClick={onGo} disabled={busy} style={primaryBtn()}>{tx.welcomeGo}</button>
      </div>
    </section>
  );
}

/** The screen could not be read at all. Says so, and offers the one thing
 *  that can help, rather than leaving an empty box that reads as "nothing to
 *  order". */
export function LoadFailed({ tx, onRetry }: { tx: OrderingStrings; onRetry: () => void }) {
  return (
    <section
      style={{ padding: '20px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}
      role="alert"
    >
      <div style={{ fontFamily: fonts.sans, fontSize: 15, fontWeight: 650, color: T.ink }}>{tx.loadFailedTitle}</div>
      <p style={{ margin: 0, fontFamily: fonts.sans, fontSize: 13, lineHeight: 1.6, color: T.ink2 }}>
        {tx.loadFailedBody}
      </p>
      <div style={{ marginTop: 4 }}>
        <button type="button" onClick={onRetry} style={primaryBtn()}>{tx.retry}</button>
      </div>
    </section>
  );
}

export function EmptyState({ tx, noItems }: { tx: OrderingStrings; noItems?: boolean }) {
  return (
    <section style={{ padding: '20px 4px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: fonts.sans, fontSize: 15, fontWeight: 650, color: T.ink }}>{tx.emptyTitle}</div>
      <p style={{ margin: 0, fontFamily: fonts.sans, fontSize: 13, lineHeight: 1.6, color: T.ink2 }}>
        {noItems ? tx.emptyNoItems : tx.emptyBody}
      </p>
      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 650, color: T.ink }}>{tx.quickStartChat}</div>
        <div style={{ fontFamily: fonts.sans, fontSize: 12.5, lineHeight: 1.55, color: T.ink2 }}>{tx.quickStartChatHint}</div>
      </div>
    </section>
  );
}

export function Suggestions({
  tx, suggestions, categories, lang, busy, onConfirm,
}: {
  tx: OrderingStrings;
  suggestions: VendorSuggestion[];
  categories: CategoryOption[];
  lang: Lang;
  busy: string | null;
  onConfirm: (s: VendorSuggestion, buckets: BucketKey[], method: OrderMethod | null) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<BucketKey[]>([]);
  const [method, setMethod] = useState<OrderMethod | null>(null);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 700, color: T.ink }}>{tx.suggestionsTitle}</div>
      <div style={{ fontFamily: fonts.sans, fontSize: 12, lineHeight: 1.5, color: T.ink2 }}>{tx.suggestionsHint}</div>
      {suggestions.map((s) => {
        const expanded = openKey === s.key;
        return (
          <div key={s.key} style={{ border: `1px dashed ${T.controlBorder}`, borderRadius: 12, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ ...chipBox(T.goldDim, T.goldText), padding: '2px 8px', fontSize: 10.5 }}>{tx.suggestionBadge}</span>
              <span style={{ fontFamily: fonts.sans, fontSize: 14, fontWeight: 650, color: T.ink }}>{s.name}</span>
              <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink2 }}>
                {s.source === 'contact' ? tx.fromContacts : tx.fromInvoices(s.seenOnInvoices)}
              </span>
              <button
                type="button"
                style={{ ...primaryBtn(), marginLeft: 'auto' }}
                disabled={busy === `sug:${s.key}`}
                onClick={() => {
                  if (!expanded) {
                    setOpenKey(s.key);
                    setPicked(s.bucketHints);
                    setMethod(null);
                    return;
                  }
                  onConfirm(s, picked, method);
                  setOpenKey(null);
                }}
              >
                {tx.confirm}
              </button>
            </div>
            {expanded && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{tx.howDoYouOrder}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['email', 'website', 'store', 'phone'] as OrderMethod[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMethod(method === m ? null : m)}
                      style={pillBtn(method === m)}
                    >
                      {methodLabel(m, tx)}
                    </button>
                  ))}
                </div>
                <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{tx.coversCategories}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {categories.map((c) => (
                    <button
                      key={c.bucketKey}
                      type="button"
                      onClick={() => setPicked((p) => (
                        p.includes(c.bucketKey) ? p.filter((k) => k !== c.bucketKey) : [...p, c.bucketKey]
                      ))}
                      style={pillBtn(picked.includes(c.bucketKey))}
                    >
                      {categoryLabel(c, lang)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function GroupCard({
  group, tx, lang, vendors, categoriesByKey, pendingSeconds, busy,
  canSendPurchaseOrders,
  onStartSend, onCancelSend, onMarkOrdered, onSetMethod, onSetItemVendor, onSetCategoryVendor,
}: {
  group: OrderGroup;
  tx: OrderingStrings;
  lang: Lang;
  vendors: Vendor[];
  categoriesByKey: Map<BucketKey, CategoryOption>;
  pendingSeconds: number | undefined;
  busy: string | null;
  canSendPurchaseOrders: boolean;
  onStartSend: () => void;
  onCancelSend: () => void;
  onMarkOrdered: (method: OrderMethod) => void;
  onSetMethod: (vendorId: string, method: OrderMethod, websiteUrl: string | null) => void;
  onSetItemVendor: (itemId: string, vendorId: string) => void;
  onSetCategoryVendor: (bucketKey: BucketKey, vendorId: string) => void;
}) {
  const unmatched = group.vendorId == null;
  const counting = pendingSeconds !== undefined;
  const [urlDraft, setUrlDraft] = useState('');
  const [methodDraft, setMethodDraft] = useState<OrderMethod | null>(null);

  return (
    <section style={{ border: `1px solid ${T.rule}`, borderRadius: 14, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: fonts.sans, fontSize: 15, fontWeight: 700, color: T.ink }}>
          {unmatched ? tx.unmatchedTitle : group.vendorName}
        </span>
        {group.orderMethod && (
          <span style={{ ...chipBox(T.tealDim, T.tealText), padding: '2px 8px', fontSize: 10.5 }}>
            {methodLabel(group.orderMethod, tx)}
          </span>
        )}
        {group.knownSubtotalCents > 0 && (
          <span style={{ marginLeft: 'auto', fontFamily: fonts.sans, fontSize: 13, fontWeight: 650, color: T.ink }}>
            {tx.subtotal} {moneyFromCents(group.knownSubtotalCents)}
          </span>
        )}
      </header>

      {/* Caveats live at GROUP level, said once. The item rows below never
          repeat them: a missing price or a thin burn rate is silence on the
          row and a plain sentence behind the tap. */}
      {unmatched && (
        <div style={{ fontFamily: fonts.sans, fontSize: 12, lineHeight: 1.5, color: T.ink2 }}>
          {tx.unmatchedHint}
        </div>
      )}

      {group.itemsWithoutPrice > 0 && (
        <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.ink2 }}>
          {tx.linesWithoutPrice(group.itemsWithoutPrice)}
        </div>
      )}

      {group.blocked && (
        <div style={chipBox(T.goldDim, T.goldText)}>{blockedLabel(group.blocked, tx)}</div>
      )}

      {/* The missing piece, asked only on the vendor row that is missing it. */}
      {group.blocked === 'method_unknown' && group.vendorId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['email', 'website', 'store', 'phone'] as OrderMethod[]).map((m) => (
              <button key={m} type="button" onClick={() => setMethodDraft(m)} style={pillBtn(methodDraft === m)}>
                {methodLabel(m, tx)}
              </button>
            ))}
          </div>
          {methodDraft === 'website' && (
            <input
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder={tx.websiteUrlLabel}
              style={inputStyle()}
            />
          )}
          {methodDraft && (
            <div>
              <button
                type="button"
                style={primaryBtn()}
                disabled={busy === `method:${group.vendorId}` || (methodDraft === 'website' && !/^https?:\/\/\S+$/i.test(urlDraft.trim()))}
                onClick={() => onSetMethod(group.vendorId as string, methodDraft, methodDraft === 'website' ? urlDraft.trim() : null)}
              >
                {tx.save}
              </button>
            </div>
          )}
        </div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
        {group.items.map((item) => (
          <ItemRow
            key={item.itemId}
            item={item}
            tx={tx}
            lang={lang}
            unmatched={unmatched}
            vendors={vendors}
            categoriesByKey={categoriesByKey}
            busy={busy}
            onSetItemVendor={onSetItemVendor}
            onSetCategoryVendor={onSetCategoryVendor}
          />
        ))}
      </ul>

      {/* Per-method actions. Every label says what actually happens. */}
      {canSendPurchaseOrders && !unmatched && !group.blocked && group.orderMethod === 'email' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {counting ? (
            <>
              <button type="button" onClick={onCancelSend} style={{ ...primaryBtn(), background: T.terra, borderColor: T.terra }}>
                {tx.undoCountdown(pendingSeconds as number)}
              </button>
              <div style={{ fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 1.5, color: T.ink2 }}>{tx.undoHonesty}</div>
            </>
          ) : (
            <div>
              <button type="button" onClick={onStartSend} style={primaryBtn()}>{tx.sendOrder}</button>
            </div>
          )}
        </div>
      )}

      {!unmatched && !group.blocked && group.orderMethod === 'website' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{tx.prepHint}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a href={group.websiteUrl ?? '#'} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn(), textDecoration: 'none' }}>
              {tx.prepOrder}
            </a>
            <button type="button" onClick={() => onMarkOrdered('website')} style={plainBtn()} disabled={busy != null}>
              {tx.markPlaced}
            </button>
          </div>
        </div>
      )}

      {!unmatched && !group.blocked && group.orderMethod === 'store' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => onMarkOrdered('store')} style={primaryBtn()} disabled={busy != null}>
            {tx.markBought}
          </button>
        </div>
      )}

      {!unmatched && !group.blocked && group.orderMethod === 'phone' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {telHref(group.vendorPhone) && (
            <a href={telHref(group.vendorPhone) as string} style={{ ...primaryBtn(), textDecoration: 'none' }}>
              {tx.callThem}
            </a>
          )}
          <button type="button" onClick={() => onMarkOrdered('phone')} style={plainBtn()} disabled={busy != null}>
            {tx.markPlaced}
          </button>
        </div>
      )}
    </section>
  );
}

// ─── One item, one calm line ────────────────────────────────────────────────
//
// The collapsed row carries exactly three things: the level gauge, the name,
// and what to order. The one extra line it may earn is days-left, and only
// when the item is close to running out. Everything else — exact counts, the
// weekly rate, prices, the supplier control — lives behind a tap on the row.
// Caveats are NEVER printed here: a thin burn rate or a missing price is
// silence on the row (the group and the footer already said it once) and a
// plain sentence in the details.

function ItemRow({
  item, tx, lang, unmatched, vendors, categoriesByKey, busy, onSetItemVendor, onSetCategoryVendor,
}: {
  item: OrderCandidate;
  tx: OrderingStrings;
  lang: Lang;
  unmatched: boolean;
  vendors: Vendor[];
  categoriesByKey: Map<BucketKey, CategoryOption>;
  busy: string | null;
  onSetItemVendor: (itemId: string, vendorId: string) => void;
  onSetCategoryVendor: (bucketKey: BucketKey, vendorId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [scope, setScope] = useState<'item' | 'category'>('item');
  const category = categoriesByKey.get(item.bucketKey);
  const weekly = approxWeekly(item.burnPerDay);
  const cue = daysLeftCue(item.daysLeft);
  const ratio = levelRatio(item.onHand, item.par);
  const levelColor = item.status === 'critical' ? T.terra : T.gold;
  const detailFont: React.CSSProperties = {
    fontFamily: fonts.sans, fontSize: 12, lineHeight: 1.5, color: T.ink2,
  };

  return (
    <li style={{ borderTop: `1px solid ${T.ruleSoft}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => { setOpen(!open); if (open) setPicking(false); }}
          aria-expanded={open}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 0',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              flex: 'none', width: 34, height: 5, borderRadius: 999,
              background: T.inkWash, overflow: 'hidden', display: 'inline-block',
            }}
          >
            <span
              style={{
                display: 'block', height: '100%', borderRadius: 999,
                width: `${Math.max(ratio * 100, 6)}%`, background: levelColor,
              }}
            />
          </span>
          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span
              style={{
                fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {item.name}
            </span>
            {cue && (
              <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: cue.kind === 'today' ? T.terra : T.ink2 }}>
                {cue.kind === 'today' ? tx.daysToday : tx.daysLeftLine(cue.days)}
              </span>
            )}
          </span>
          <span style={{ marginLeft: 'auto', flex: 'none', fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 650, color: T.ink }}>
            {tx.order} {trim(item.suggestedQty)} {item.unit}
          </span>
          <svg
            width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
            style={{ flex: 'none', transition: 'transform 140ms ease', transform: open ? 'rotate(90deg)' : 'none' }}
          >
            <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke={T.ink2} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {unmatched && !open && (
          <button
            type="button"
            onClick={() => { setOpen(true); setPicking(true); }}
            style={{ ...plainBtn(), flex: 'none', padding: '5px 11px', fontSize: 12 }}
          >
            {tx.whoSupplies}
          </button>
        )}
      </div>

      {open && (
        <div style={{ padding: '0 0 12px 44px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={detailFont}>{tx.onHandOfPar(trim(item.onHand), trim(item.par))}</span>
          {/* A rate is a number only when the evidence backs it; otherwise the
              honest sentence, here and nowhere else. */}
          {item.burnPerDay != null
            ? (weekly && <span style={detailFont}>{tx.burnRate(weekly)}</span>)
            : <span style={detailFont}>{tx.burnUnknown}</span>}
          {item.lastPriceCents != null
            ? (
              <span style={detailFont}>
                {tx.lastPaid(moneyFromCents(item.lastPriceCents))}
                {item.lineTotalCents != null && `. ${tx.lineTotalAt(moneyFromCents(item.lineTotalCents))}`}
              </span>
            )
            : <span style={detailFont}>{tx.noPrice}</span>}
          {/* Only ever present on an item whose order is late. A fresh order
              takes the item off this list entirely. */}
          {item.openOrder && (
            <span style={detailFont}>{tx.orderedDaysAgo(item.openOrder.daysAgo)}</span>
          )}

          {/* Setup by doing: the supplier control, right where it matters. */}
          {!picking ? (
            <div style={{ marginTop: 3 }}>
              <button
                type="button"
                onClick={() => setPicking(true)}
                style={{ ...plainBtn(), padding: '5px 11px', fontSize: 12 }}
              >
                {unmatched ? tx.whoSupplies : tx.actuallyFrom}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 3 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setScope('item')} style={pillBtn(scope === 'item')}>{tx.justThisItem}</button>
                {category && (
                  <button type="button" onClick={() => setScope('category')} style={pillBtn(scope === 'category')}>
                    {tx.wholeCategory(categoryLabel(category, lang))}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {vendors.filter((v) => v.reviewState === 'confirmed').map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    disabled={busy != null}
                    onClick={() => {
                      if (scope === 'category') onSetCategoryVendor(item.bucketKey, v.id);
                      else onSetItemVendor(item.itemId, v.id);
                      setPicking(false);
                    }}
                    style={pillBtn(false)}
                  >
                    {v.name}
                  </button>
                ))}
                <button type="button" onClick={() => setPicking(false)} style={linkBtn()}>{tx.cancel}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function BasisFooter({ tx, basis }: { tx: OrderingStrings; basis: OrderingState['burnBasis'] }) {
  // Says which of the three evidence tiers the rates on this screen came from.
  // A hotel with no history reads "based on par levels alone" rather than
  // being left to assume the days-left dashes are a glitch.
  const line = basis.mlItems > 0
    ? tx.basisMl
    : basis.daysOfData >= 7
      ? tx.basisRule
      : tx.basisThin;
  return (
    <footer style={{ borderTop: `1px solid ${T.ruleSoft}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 1.5, color: T.ink2 }}>{line}</span>
      <span style={{ fontFamily: fonts.sans, fontSize: 11.5, lineHeight: 1.5, color: T.ink2 }}>{tx.pricesNote}</span>
    </footer>
  );
}

// ─── Small styles ───────────────────────────────────────────────────────────

function primaryBtn(): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 9,
    background: T.brand,
    color: '#fff',
    border: `1px solid ${T.brand}`,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: 650,
    cursor: 'pointer',
    display: 'inline-block',
  };
}

function plainBtn(): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 9,
    background: 'transparent',
    color: T.ink,
    border: `1px solid ${T.controlBorder}`,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function pillBtn(active: boolean): React.CSSProperties {
  return {
    padding: '5px 11px',
    borderRadius: 999,
    background: active ? T.brand : 'transparent',
    color: active ? '#fff' : T.ink,
    border: `1px solid ${active ? T.brand : T.controlBorder}`,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  };
}

function linkBtn(): React.CSSProperties {
  return {
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: T.tealText,
    fontFamily: fonts.sans,
    fontSize: 11.5,
    fontWeight: 650,
    cursor: 'pointer',
    textDecoration: 'underline',
  };
}

function inputStyle(): React.CSSProperties {
  return {
    padding: '8px 10px',
    borderRadius: 9,
    border: `1px solid ${T.controlBorder}`,
    fontFamily: fonts.sans,
    fontSize: 13,
    color: T.ink,
    maxWidth: 380,
  };
}

export default OrderingPanel;
