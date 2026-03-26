'use client';

import React, { useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { bulkAddRooms, getRoomsForDate } from '@/lib/firestore';
import type { Room, RoomType, RoomStatus, RoomPriority } from '@/types';
import { Upload, FileText, CheckCircle, AlertCircle, ChevronRight, X } from 'lucide-react';

// ─── CSV parsing ──────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function findColIndex(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

interface ParsedRoom {
  number: string;
  type: RoomType;
  status: RoomStatus;
  priority: RoomPriority;
}

/** Map a PMS status code to RoomType + RoomStatus.
 *  Returns null for rooms that don't need housekeeping (vacant/clean). */
function mapStatus(raw: string): { type: RoomType; status: RoomStatus } | null {
  const s = raw.toUpperCase().replace(/[\s-]/g, '');
  if (['DUE', 'DO', 'DUEOUT', 'CHECKOUT', 'CO', 'C/O', 'DEPARTURE', 'DEP', 'C'].includes(s)) {
    return { type: 'checkout', status: 'dirty' };
  }
  if (['OCC', 'OCCUPIED', 'O', 'SO', 'STAYOVER', 'STAYOV', 'STY', 'STA'].includes(s)) {
    return { type: 'stayover', status: 'dirty' };
  }
  if (['DIR', 'DIRTY', 'D', 'HKP', 'HKPSTAYOVER'].includes(s)) {
    return { type: 'stayover', status: 'dirty' };
  }
  if (['ARR', 'ARRIVAL', 'A', 'CHECKIN', 'CI'].includes(s)) {
    // New arrival: room was previously occupied (checkout)
    return { type: 'checkout', status: 'dirty' };
  }
  // Vacant / clean — skip
  if (['VAC', 'VACANT', 'V', 'CLN', 'CLEAN', 'VCIS', 'VCNS', 'VDIS', 'VDNS', ''].includes(s)) {
    return null;
  }
  // Unknown status — include as stayover/dirty so nothing is missed
  return { type: 'stayover', status: 'dirty' };
}

function parseCsvText(text: string): { rooms: ParsedRoom[]; error: string | null } {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { rooms: [], error: 'CSV has no data rows' };

  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

  const roomCol   = findColIndex(headers, ['room', 'roomno', 'roomnumber', 'room#', 'unit', 'roomno']);
  const statusCol = findColIndex(headers, ['status', 'roomstatus', 'hkpstatus', 'housekeepingstatus', 'hkstatus']);
  const vipCol    = findColIndex(headers, ['vip', 'group', 'priority', 'roomtype2']);

  if (roomCol === -1) {
    return { rooms: [], error: 'Could not find a "Room" column. Check the CSV has a room number header.' };
  }

  const rooms: ParsedRoom[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const roomNum = cells[roomCol]?.replace(/[^0-9A-Za-z-]/g, '').trim();
    if (!roomNum) continue;

    const rawStatus = statusCol !== -1 ? cells[statusCol] ?? '' : '';
    const mapped    = mapStatus(rawStatus);
    if (!mapped) continue; // skip vacant/clean rooms

    const isVip  = vipCol !== -1 && /vip/i.test(cells[vipCol] ?? '');
    rooms.push({ number: roomNum, ...mapped, priority: isVip ? 'vip' : 'standard' });
  }

  return { rooms, error: null };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const { user }                           = useAuth();
  const { activePropertyId, activeProperty } = useProperty();
  const { lang }                           = useLang();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging,      setDragging]      = useState(false);
  const [fileName,      setFileName]      = useState('');
  const [preview,       setPreview]       = useState<ParsedRoom[]>([]);
  const [parseError,    setParseError]    = useState('');
  const [importing,     setImporting]     = useState(false);
  const [result,        setResult]        = useState<{ imported: number; skipped: number } | null>(null);
  const [importError,   setImportError]   = useState('');
  const [importDate,    setImportDate]    = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });

  const processFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
      setParseError('Please select a CSV file.');
      setPreview([]);
      setFileName('');
      return;
    }
    setFileName(file.name);
    setParseError('');
    setResult(null);
    setImportError('');

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { rooms, error } = parseCsvText(text);
      if (error) {
        setParseError(error);
        setPreview([]);
      } else {
        setPreview(rooms);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handleImport = async () => {
    if (!user || !activePropertyId || preview.length === 0) return;
    setImporting(true);
    setImportError('');

    try {
      // Check which rooms already exist for this date
      const existing = await getRoomsForDate(user.uid, activePropertyId, importDate);
      const existingNums = new Set(existing.map(r => r.number));

      const toImport: Omit<Room, 'id'>[] = preview
        .filter(r => !existingNums.has(r.number))
        .map(r => ({
          number:     r.number,
          type:       r.type,
          status:     r.status,
          priority:   r.priority,
          date:       importDate,
          propertyId: activePropertyId,
        }));

      if (toImport.length > 0) {
        await bulkAddRooms(user.uid, activePropertyId, toImport);
      }

      setResult({
        imported: toImport.length,
        skipped:  preview.length - toImport.length,
      });
      setPreview([]);
      setFileName('');
    } catch (err) {
      console.error('Import error:', err);
      setImportError(t('csvImportFailed', lang));
    } finally {
      setImporting(false);
    }
  };

  const reset = () => {
    setPreview([]);
    setFileName('');
    setParseError('');
    setResult(null);
    setImportError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const typeLabel = (type: RoomType) =>
    type === 'checkout' ? (lang === 'es' ? 'Salida' : 'Checkout') : (lang === 'es' ? 'Continuación' : 'Stayover');

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <Link href="/settings" style={{ color: 'var(--text-muted)', textDecoration: 'none', fontSize: '14px' }}>
            ← {t('settings', lang)}
          </Link>
          <ChevronRight size={14} color="var(--text-muted)" />
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px',
            letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '8px',
          }}>
            <FileText size={18} color="var(--amber)" />
            {t('csvImportTitle', lang)}
          </h1>
        </div>

        {/* Success state */}
        {result && (
          <div style={{
            padding: '20px', background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.25)', borderRadius: '14px', marginBottom: '20px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
              <CheckCircle size={20} color="#22c55e" />
              <p style={{ fontWeight: 700, fontSize: '15px', color: '#22c55e' }}>
                {result.imported} {t('csvImportDone', lang)}
              </p>
            </div>
            {result.skipped > 0 && (
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                {result.skipped} {t('csvSkipped', lang)}
              </p>
            )}
            <button
              onClick={reset}
              style={{
                marginTop: '12px', padding: '8px 18px', fontSize: '13px',
                background: 'var(--amber)', color: '#0A0A0A', border: 'none',
                borderRadius: 'var(--radius-md)', fontFamily: 'var(--font-sans)',
                fontWeight: 600, cursor: 'pointer',
              }}
            >
              {lang === 'es' ? 'Importar otro' : 'Import another'}
            </button>
          </div>
        )}

        {!result && (
          <>
            {/* Info card */}
            <div style={{
              padding: '16px 18px', background: 'rgba(212,144,64,0.06)',
              border: '1px solid rgba(212,144,64,0.2)', borderRadius: '14px', marginBottom: '20px',
            }}>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {lang === 'es'
                  ? 'Importa el listado de habitaciones directamente desde tu PMS. Esto carga las habitaciones que necesitan limpieza hoy — checkouts y continuaciones.'
                  : 'Import today\'s room list directly from your PMS. This loads rooms that need cleaning — checkouts and stayovers. Vacant/clean rooms are skipped automatically.'}
              </p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
                {t('csvHelpText', lang)}
              </p>
            </div>

            {/* Date picker */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
                {lang === 'es' ? 'Fecha de importación' : 'Import date'}
              </label>
              <input
                type="date"
                value={importDate}
                onChange={e => setImportDate(e.target.value)}
                className="input"
                style={{ maxWidth: '200px' }}
              />
            </div>

            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragging ? 'var(--amber)' : 'var(--border)'}`,
                borderRadius: '14px',
                padding: '32px 24px',
                textAlign: 'center',
                cursor: 'pointer',
                background: dragging ? 'rgba(212,144,64,0.06)' : 'var(--bg-card)',
                transition: 'all 150ms',
                marginBottom: '16px',
              }}
            >
              <Upload size={28} color={dragging ? 'var(--amber)' : 'var(--text-muted)'} style={{ margin: '0 auto 10px' }} />
              {fileName ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                  <FileText size={16} color="var(--amber)" />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{fileName}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); reset(); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px' }}
                  >
                    <X size={14} color="var(--text-muted)" />
                  </button>
                </div>
              ) : (
                <>
                  <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    {t('csvDropHint', lang)}
                  </p>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {t('uploadCsv', lang)}
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </div>

            {/* Parse error */}
            {parseError && (
              <div style={{
                padding: '12px 16px', background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', marginBottom: '16px',
                display: 'flex', gap: '10px', alignItems: 'flex-start',
              }}>
                <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0, marginTop: '1px' }} />
                <p style={{ fontSize: '13px', color: '#ef4444' }}>{parseError}</p>
              </div>
            )}

            {/* Preview */}
            {preview.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <p style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {t('csvPreviewLabel', lang)}
                  </p>
                  <span style={{
                    fontSize: '12px', fontWeight: 600,
                    background: 'rgba(212,144,64,0.15)', color: 'var(--amber)',
                    padding: '3px 10px', borderRadius: '20px',
                  }}>
                    {preview.length} {t('csvRoomsFound', lang)}
                  </span>
                </div>

                <div style={{
                  border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden',
                  maxHeight: '280px', overflowY: 'auto',
                }}>
                  {/* Table header */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: '80px 1fr 80px',
                    padding: '8px 14px', background: 'var(--bg)',
                    borderBottom: '1px solid var(--border)',
                    fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)',
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                  }}>
                    <span>{t('roomNumber', lang)}</span>
                    <span>{t('type', lang)}</span>
                    <span>{t('priority', lang)}</span>
                  </div>

                  {preview.map((room, idx) => (
                    <div
                      key={room.number + idx}
                      style={{
                        display: 'grid', gridTemplateColumns: '80px 1fr 80px',
                        padding: '10px 14px',
                        borderBottom: idx < preview.length - 1 ? '1px solid var(--border)' : 'none',
                        background: idx % 2 === 0 ? 'var(--bg-card)' : 'transparent',
                      }}
                    >
                      <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)' }}>
                        {room.number}
                      </span>
                      <span style={{
                        fontSize: '12px', fontWeight: 600,
                        color: room.type === 'checkout' ? '#F87171' : '#60A5FA',
                      }}>
                        {typeLabel(room.type)}
                      </span>
                      <span style={{ fontSize: '12px', color: room.priority === 'vip' ? 'var(--amber)' : 'var(--text-muted)' }}>
                        {room.priority === 'vip' ? 'VIP' : t('standard', lang)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Import error */}
            {importError && (
              <div style={{
                padding: '12px 16px', background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.25)', borderRadius: '10px', marginBottom: '16px',
                display: 'flex', gap: '10px',
              }}>
                <AlertCircle size={16} color="#ef4444" />
                <p style={{ fontSize: '13px', color: '#ef4444' }}>{importError}</p>
              </div>
            )}

            {/* Import button */}
            {preview.length > 0 && (
              <button
                onClick={handleImport}
                disabled={importing || !user || !activePropertyId}
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', height: '48px', fontSize: '15px' }}
              >
                {importing ? (
                  <>
                    <div style={{ width: '16px', height: '16px', border: '2px solid rgba(0,0,0,0.2)', borderTopColor: '#0A0A0A', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    {lang === 'es' ? 'Importando…' : 'Importing…'}
                  </>
                ) : (
                  <>{t('importRoomsBtn', lang)} ({preview.length})</>
                )}
              </button>
            )}
          </>
        )}

        {/* Format guide */}
        <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '10px' }}>
            {lang === 'es' ? 'Formato esperado' : 'Expected Format'}
          </p>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '10px' }}>
            {lang === 'es'
              ? 'El CSV debe tener una columna "Room" (o "Room No") con el número de habitación, y una columna "Status" con el estado.'
              : 'The CSV must have a "Room" (or "Room No") column with the room number and a "Status" column.'}
          </p>
          <p style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {lang === 'es' ? 'Códigos de estado soportados' : 'Supported status codes'}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
            {[
              ['OCC / Occupied', lang === 'es' ? 'Continuación' : 'Stayover'],
              ['DUE / Due Out', lang === 'es' ? 'Salida' : 'Checkout'],
              ['DIR / Dirty', lang === 'es' ? 'Continuación sucia' : 'Dirty stayover'],
              ['ARR / Arrival', lang === 'es' ? 'Nueva llegada' : 'New arrival'],
              ['VAC / CLN', lang === 'es' ? 'Omitida (vacía/limpia)' : 'Skipped (vacant/clean)'],
            ].map(([code, desc]) => (
              <div key={code} style={{ display: 'flex', gap: '6px', alignItems: 'flex-start', padding: '3px 0' }}>
                <code style={{ fontSize: '11px', fontWeight: 700, color: 'var(--amber)', background: 'rgba(212,144,64,0.1)', padding: '1px 5px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                  {code}
                </code>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{desc}</span>
              </div>
            ))}
          </div>
        </div>

        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </AppLayout>
  );
}
