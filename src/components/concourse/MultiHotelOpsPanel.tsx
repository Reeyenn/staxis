'use client';

import React from 'react';

import { useApiResource } from '@/lib/hooks/use-api-resource';
import {
  canClaimMultiHotelEmpty,
  filterMultiHotelRows,
  formatMultiHotelDate,
} from '@/lib/staxis/multi-hotel-types';
import type {
  MultiHotelAssignedItem,
  MultiHotelKnowsItem,
  MultiHotelLabel,
  MultiHotelLogEntry,
  MultiHotelPayload,
  MultiHotelSurface,
} from '@/lib/staxis/multi-hotel-types';
import type { LogReplyDTO } from '@/lib/comms/types';

const PANEL_CSS = `
.mho{margin-top:22px;border:1px solid rgba(31,35,28,.09);border-radius:16px;background:#FAFBF9;padding:14px 15px;color:#1F231C;}
.mho-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.mho-title{font-size:15px;font-weight:650;letter-spacing:-.01em;}
.mho-sub{font-size:12px;color:#727A72;margin-top:3px;line-height:1.45;}
.mho-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-top:14px;}
.mho-tab,.mho-filter{min-height:44px;border:1px solid rgba(62,92,72,.22);border-radius:10px;background:#fff;color:#3E5C48;padding:0 12px;font:600 12px/1.2 var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;}
.mho-tab[aria-pressed=true]{background:#3E5C48;color:#fff;border-color:#3E5C48;}
.mho-tab:focus-visible,.mho-filter:focus-visible,.mho-open:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.mho-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;}
.mho-filter{min-width:170px;text-align:left;font-weight:500;}
.mho-status{margin-top:12px;font-size:12.5px;line-height:1.55;color:#5C625C;}
.mho-status[data-kind=error]{color:#8A3D31;}
.mho-coverage{margin-top:12px;border:1px solid rgba(201,150,68,.35);border-radius:11px;background:#FDFAF4;padding:9px 10px;font-size:12px;line-height:1.5;color:#5C4B2E;}
.mho-list{list-style:none;margin:12px 0 0;padding:0;border-top:1px solid rgba(31,35,28,.08);}
.mho-row{padding:12px 2px;border-bottom:1px solid rgba(31,35,28,.08);}
.mho-row:last-child{border-bottom:0;}
.mho-row-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.mho-hotel{font-size:11px;color:#3E5C48;font-weight:650;letter-spacing:.02em;}
.mho-time{font-size:11px;color:#8A9187;white-space:nowrap;}
.mho-row-title{font-size:13px;line-height:1.45;font-weight:600;margin-top:4px;}
.mho-row-body{font-size:12.5px;line-height:1.5;color:#5C625C;margin-top:3px;white-space:pre-wrap;}
.mho-open{margin-top:8px;min-height:44px;border:0;border-radius:9px;background:transparent;color:#3E5C48;padding:0 8px;font:600 12px/1.2 var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;}
.mho-empty{margin-top:12px;font-size:12.5px;color:#727A72;}
@media (prefers-reduced-motion:reduce){.mho-tab,.mho-filter,.mho-open{transition:none;}}
`;

const TABS: readonly { id: MultiHotelSurface; label: string }[] = [
  { id: 'logbook', label: 'Log book' },
  { id: 'assigned-by-me', label: 'Assigned by me' },
  { id: 'knows', label: 'What Staxis knows' },
];
const EMPTY_HOTELS: MultiHotelLabel[] = [];

function surfaceUrl(surface: MultiHotelSurface, organizationId: string | null): string {
  const params = new URLSearchParams({ surface });
  if (organizationId) params.set('organizationId', organizationId);
  return `/api/staxis/multi-hotel?${params.toString()}`;
}

export function MultiHotelOpsPanel({
  organizationId = null,
  scopeKey,
}: {
  /** Null means all current authoritative hotels; never a client hotel array. */
  organizationId?: string | null;
  /** Account + org/authority fingerprint. Changes clear stale rows. */
  scopeKey: string | null;
}) {
  const [surface, setSurface] = React.useState<MultiHotelSurface>('logbook');
  const [hotelFilter, setHotelFilter] = React.useState('all');
  const [selectedEntry, setSelectedEntry] = React.useState<MultiHotelLogEntry | null>(null);
  const url = React.useMemo(() => surfaceUrl(surface, organizationId), [organizationId, surface]);
  const resource = useApiResource<MultiHotelPayload>(url, {
    enabled: !!scopeKey,
    identityKey: scopeKey ?? 'multi-hotel-unresolved',
    keepDataOnError: false,
    timeoutMs: 45_000,
    revalidateOnFocus: true,
    clearDataOnFocusRevalidate: true,
  });
  const payload = resource.data;
  const hotels = React.useMemo(() => payload?.hotels ?? EMPTY_HOTELS, [payload?.hotels]);
  const detailUrl = selectedEntry
    ? `/api/staxis/multi-hotel?surface=logbook&propertyId=${encodeURIComponent(selectedEntry.propertyId)}&entryId=${encodeURIComponent(selectedEntry.id)}${organizationId ? `&organizationId=${encodeURIComponent(organizationId)}` : ''}`
    : '/api/staxis/multi-hotel?surface=logbook';
  const detail = useApiResource<{ replies: LogReplyDTO[]; repliesComplete?: boolean }>(detailUrl, {
    enabled: !!scopeKey && !!selectedEntry && surface === 'logbook',
    identityKey: selectedEntry && scopeKey
      ? `${scopeKey}|log-detail:${selectedEntry.propertyId}:${selectedEntry.id}`
      : 'multi-hotel-detail-unresolved',
    keepDataOnError: false,
  });

  React.useEffect(() => {
    if (hotelFilter !== 'all' && !hotels.some((hotel) => hotel.propertyId === hotelFilter)) {
      setHotelFilter('all');
    }
  }, [hotelFilter, hotels]);

  React.useEffect(() => {
    if (!selectedEntry) return;
    if (surface !== 'logbook' || !hotels.some((hotel) => hotel.propertyId === selectedEntry.propertyId)) {
      setSelectedEntry(null);
    }
  }, [hotels, selectedEntry, surface]);

  const entries = React.useMemo(
    () => filterMultiHotelRows(payload?.entries ?? [], hotelFilter),
    [hotelFilter, payload?.entries],
  );
  const assigned = React.useMemo(
    () => filterMultiHotelRows(payload?.assigned ?? [], hotelFilter),
    [hotelFilter, payload?.assigned],
  );
  const items = React.useMemo(
    () => filterMultiHotelRows(payload?.items ?? [], hotelFilter),
    [hotelFilter, payload?.items],
  );

  return (
    <section className="mho" aria-label="Multi-hotel Staxis views">
      <style dangerouslySetInnerHTML={{ __html: PANEL_CSS }} />
      <div className="mho-head">
        <div>
          <div className="mho-title">Across your hotels</div>
          <div className="mho-sub">Read-only rollups. Select a log entry to read its replies.</div>
        </div>
      </div>
      <div className="mho-tabs" role="group" aria-label="Hotel operations">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={surface === tab.id}
            className="mho-tab"
            onClick={() => setSurface(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {hotels.length > 1 && (
        <div className="mho-controls">
          <label htmlFor="mho-hotel-filter" className="mho-sub">Hotel</label>
          <select
            id="mho-hotel-filter"
            className="mho-filter"
            value={hotelFilter}
            onChange={(event) => setHotelFilter(event.target.value)}
            aria-label="Filter by hotel"
          >
            <option value="all">All hotels</option>
            {hotels.map((hotel) => <option key={hotel.propertyId} value={hotel.propertyId}>{hotel.hotelName}</option>)}
          </select>
        </div>
      )}

      {resource.loading && (
        <div className="mho-status" role="status" aria-live="polite" aria-busy="true">Loading this view…</div>
      )}
      {resource.error && !resource.loading && (
        <div className="mho-status" data-kind="error" role="alert">This view could not be read. It was not treated as empty.</div>
      )}
      {!resource.loading && !resource.error && payload?.coverage && !payload.coverage.complete && (
        <div className="mho-coverage" role="status">
          {payload.coverage.processedHotelCount} of {payload.coverage.authorizedHotelCount} hotels answered this recent, bounded view.
          {payload.coverage.omittedHotelCount > 0 ? ` ${payload.coverage.omittedHotelCount} hotel${payload.coverage.omittedHotelCount === 1 ? '' : 's'} were outside this load limit.` : ''}
          {payload.coverage.unavailableHotelCount > 0 ? ` ${payload.coverage.unavailableHotelCount} hotel${payload.coverage.unavailableHotelCount === 1 ? '' : 's'} did not answer completely.` : ''}
          {payload.coverage.rowsOmitted > 0 ? ` At least ${payload.coverage.rowsOmitted} row${payload.coverage.rowsOmitted === 1 ? '' : 's'} were held back by a bounded source or response window.` : ''}
          {payload.coverage.truncated ? ' Some source rows or reply counts may be outside this bounded view.' : ''}
          {(() => {
            const identityHotels = payload.coverage.unavailable
              .filter((hotel) => hotel.reason === 'identity_unavailable')
              .map((hotel) => hotel.hotelName);
            if (identityHotels.length === 0) return '';
            const shown = identityHotels.slice(0, 3).join(', ');
            const suffix = identityHotels.length > 3 ? ` and ${identityHotels.length - 3} more` : '';
            return ` A staff profile could not be matched at ${shown}${suffix}, so Assigned by me is unavailable there.`;
          })()}
          {' '}This is not a claim of complete hotel history.
        </div>
      )}
      {!resource.loading && !resource.error && payload && surface === 'logbook' && (
        <LogbookRows
          entries={entries}
          complete={canClaimMultiHotelEmpty(payload.coverage)}
          selectedEntry={selectedEntry}
          replies={detail.data?.replies ?? []}
          repliesComplete={detail.data?.repliesComplete !== false}
          repliesLoading={detail.loading}
          repliesError={!!detail.error}
          repliesErrorMessage={detail.error}
          onSelect={setSelectedEntry}
        />
      )}
      {!resource.loading && !resource.error && payload && surface === 'assigned-by-me' && (
        <AssignedRows items={assigned} complete={canClaimMultiHotelEmpty(payload.coverage)} />
      )}
      {!resource.loading && !resource.error && payload && surface === 'knows' && (
        <KnowsRows items={items} complete={canClaimMultiHotelEmpty(payload.coverage)} />
      )}
    </section>
  );
}

function LogbookRows({
  entries,
  complete,
  selectedEntry,
  replies,
  repliesComplete,
  repliesLoading,
  repliesError,
  repliesErrorMessage,
  onSelect,
}: {
  entries: MultiHotelLogEntry[];
  complete: boolean;
  selectedEntry: MultiHotelLogEntry | null;
  replies: LogReplyDTO[];
  repliesComplete: boolean;
  repliesLoading: boolean;
  repliesError: boolean;
  repliesErrorMessage: string | null;
  onSelect: (entry: MultiHotelLogEntry | null) => void;
}) {
  if (entries.length === 0) return <div className="mho-empty" role="status">{complete ? 'No log book entries in the selected hotels.' : 'No complete log book result is available for the selected scope.'}</div>;
  return (
    <ul className="mho-list">
      {entries.map((entry) => (
        <li className="mho-row" key={`${entry.propertyId}:${entry.id}`}>
          <div className="mho-row-top"><span className="mho-hotel">{entry.hotelName}</span><span className="mho-time">{formatMultiHotelDate(entry.createdAt, entry.timezone)}</span></div>
          <button type="button" className="mho-open" style={{ display: 'block', paddingLeft: 0, marginTop: 4 }} onClick={() => onSelect(selectedEntry?.id === entry.id && selectedEntry.propertyId === entry.propertyId ? null : entry)}>{entry.title}</button>
          {entry.body && <div className="mho-row-body">{entry.body}</div>}
          {selectedEntry?.id === entry.id && selectedEntry.propertyId === entry.propertyId && (
            <div className="mho-row-body" role="region" aria-label={`Replies for ${entry.title}`}>
              {repliesLoading ? 'Loading replies…' : repliesError ? (repliesErrorMessage ?? 'Replies could not be read.') : replies.length === 0 ? 'No replies yet.' : replies.map((reply) => (
                <div key={reply.id} style={{ marginTop: 6 }}><strong>{reply.authorName ?? 'Staff'}:</strong> {reply.body}</div>
              ))}
              {!repliesLoading && !repliesError && !repliesComplete && (
                <div style={{ marginTop: 6 }}>Showing the first 500 replies.</div>
              )}
              <button type="button" className="mho-open" onClick={() => onSelect(null)}>Close detail</button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function AssignedRows({ items, complete }: { items: MultiHotelAssignedItem[]; complete: boolean }) {
  if (items.length === 0) return <div className="mho-empty" role="status">{complete ? 'Nothing you handed to another person is waiting or newly settled.' : 'No complete Assigned-by-me result is available for the selected scope.'}</div>;
  return (
    <ul className="mho-list">
      {items.map((item) => (
        <li className="mho-row" key={`${item.propertyId}:${item.taskId}`}>
          <div className="mho-row-top"><span className="mho-hotel">{item.hotelName}</span><span className="mho-time">{formatMultiHotelDate(item.createdAt, item.timezone)}</span></div>
          <div className="mho-row-title">{item.title}</div>
          <div className="mho-row-body">{item.state === 'waiting' ? `Waiting on ${item.assigneeName ?? 'the assigned person'}.` : item.state === 'cant' ? (item.reason ?? 'Marked cannot complete.') : item.state === 'skipped' ? 'Marked not needed.' : 'Marked done.'}</div>
        </li>
      ))}
    </ul>
  );
}

function KnowsRows({ items, complete }: { items: MultiHotelKnowsItem[]; complete: boolean }) {
  if (items.length === 0) return <div className="mho-empty" role="status">{complete ? 'No shared operational knowledge was found in the selected hotels.' : 'No complete knowledge result is available for the selected scope.'}</div>;
  return (
    <ul className="mho-list">
      {items.map((item) => (
        <li className="mho-row" key={`${item.propertyId}:${item.kind}:${item.id}`}>
          <div className="mho-row-top"><span className="mho-hotel">{item.hotelName}</span><span className="mho-time">{item.group === 'noticed' ? 'Noticed' : 'Taught'}</span></div>
          <div className="mho-row-body">{item.sentence}</div>
        </li>
      ))}
    </ul>
  );
}
