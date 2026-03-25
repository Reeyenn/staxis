'use client';

import React, { useEffect, useState } from 'react';
import {
  collectionGroup,
  query,
  where,
  onSnapshot,
  updateDoc,
  Timestamp,
  DocumentReference,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus } from '@/types';
import { format } from 'date-fns';
import { CheckCircle, AlertTriangle, Square, CheckSquare, Camera } from 'lucide-react';

type RoomWithRef = Room & { _ref: DocumentReference };

/** Convert a Firestore Timestamp or raw Date/string to a JS Date */
function firestoreToDate(v: unknown): Date {
  if (v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate();
  }
  return new Date(v as string | number);
}

const PRIORITY_SCORE: Record<string, number> = { vip: 0, early: 1, standard: 2 };

function sortRooms(rooms: RoomWithRef[]): RoomWithRef[] {
  return [...rooms].sort((a, b) => {
    // Checkouts before stayovers
    if (a.type !== b.type) return a.type === 'checkout' ? -1 : 1;
    // Within same type: vip > early > standard
    return (PRIORITY_SCORE[a.priority] ?? 2) - (PRIORITY_SCORE[b.priority] ?? 2);
  });
}

export default function HousekeeperRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: housekeeperId } = React.use(params);
  const today = todayStr();

  const [rooms, setRooms] = useState<RoomWithRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [issueRoomId, setIssueRoomId] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState('');
  const [savingIssue, setSavingIssue] = useState(false);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  useEffect(() => {
    // Single where clause avoids the composite index requirement on the
    // collection group. Date is filtered client-side instead.
    const q = query(
      collectionGroup(db, 'rooms'),
      where('assignedTo', '==', housekeeperId),
    );

    const unsub = onSnapshot(
      q,
      snap => {
        const data = snap.docs
          .map(d => ({ id: d.id, _ref: d.ref, ...d.data() } as RoomWithRef))
          .filter(r => r.date === today);
        setRooms(sortRooms(data));
        setLoading(false);
      },
      error => {
        console.error('[housekeeper] Firestore error:', error);
        setLoading(false);
      },
    );

    return unsub;
  }, [housekeeperId, today]);

  const handleStatusChange = async (room: RoomWithRef, newStatus: RoomStatus) => {
    const updates: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'in_progress') updates.startedAt = Timestamp.now();
    if (newStatus === 'clean') updates.completedAt = Timestamp.now();
    await updateDoc(room._ref, updates);
  };

  const handleSubmitIssue = async () => {
    if (!issueRoomId || !issueNote.trim()) return;
    setSavingIssue(true);
    const room = rooms.find(r => r.id === issueRoomId);
    if (room) {
      const updates: Record<string, unknown> = { issueNote: issueNote.trim() };
      if (photoPreview) {
        updates.hasPhoto = true;
      }
      await updateDoc(room._ref, updates);
    }
    setSavingIssue(false);
    setIssueRoomId(null);
    setIssueNote('');
    setPhotoPreview(null);
  };

  const housekeeperName = rooms[0]?.assignedName ?? 'Housekeeper';
  const total = rooms.length;
  const done = rooms.filter(r => r.status === 'clean').length;
  const allDone = total > 0 && done === total;
  const progressPct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (loading) {
    return (
      <div style={{
        minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#F0FDF4', fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <p style={{ color: '#6B7280', fontSize: '15px' }}>Loading your rooms…</p>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: '100dvh', background: '#F0FDF4',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    }}>
      {/* ── Header ── */}
      <div style={{ background: '#166534', padding: '20px 16px 28px', color: 'white' }}>
        <p style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', opacity: 0.65, marginBottom: '6px',
        }}>
          HotelOps AI
        </p>
        <h1 style={{ fontSize: '26px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '2px' }}>
          {housekeeperName.split(' ')[0]}&apos;s Rooms
        </h1>
        <p style={{ fontSize: '13px', opacity: 0.75, fontWeight: 500 }}>
          {format(new Date(), 'EEEE, MMMM d')}
        </p>

        {/* Progress bar */}
        {total > 0 && (
          <div style={{ marginTop: '18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600 }}>
                {done} of {total} rooms done
              </span>
              <span style={{ fontSize: '13px', fontWeight: 700, opacity: 0.9 }}>
                {progressPct}%
              </span>
            </div>
            <div style={{
              height: '8px', background: 'rgba(255,255,255,0.2)',
              borderRadius: '99px', overflow: 'hidden',
            }}>
              <div style={{
                height: '100%', width: `${progressPct}%`,
                background: '#4ADE80', borderRadius: '99px',
                transition: 'width 500ms cubic-bezier(0.4,0,0.2,1)',
              }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Room list ── */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>

        {allDone ? (
          /* Completion screen */
          <div style={{
            textAlign: 'center', padding: '52px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}>
            <div style={{
              width: '80px', height: '80px', borderRadius: '50%',
              background: '#DCFCE7', display: 'flex', alignItems: 'center',
              justifyContent: 'center', margin: '0 auto 20px',
            }}>
              <CheckCircle size={40} color="#16A34A" />
            </div>
            <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#111827', marginBottom: '10px' }}>
              You&apos;re all done!
            </h2>
            <p style={{ fontSize: '16px', color: '#4B5563', lineHeight: 1.5 }}>
              Great work today, {housekeeperName.split(' ')[0]}! 🎉
            </p>
          </div>
        ) : total === 0 ? (
          /* No rooms state */
          <div style={{
            textAlign: 'center', padding: '52px 24px', background: 'white',
            borderRadius: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}>
            <p style={{ fontSize: '15px', color: '#6B7280', lineHeight: 1.6 }}>
              No rooms assigned yet.<br />Check back soon!
            </p>
          </div>
        ) : (
          rooms.map(room => (
            <RoomCard
              key={room.id}
              room={room}
              isExpanded={expandedRoomId === room.id}
              onToggleExpand={() => setExpandedRoomId(expandedRoomId === room.id ? null : room.id)}
              onStatusChange={handleStatusChange}
              onReportIssue={() => {
                setIssueRoomId(room.id);
                setIssueNote((room.issueNote as string | undefined) ?? '');
                setPhotoPreview(null);
              }}
            />
          ))
        )}
      </div>

      {/* ── Report Issue Modal ── */}
      {issueRoomId && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'flex-end',
            zIndex: 200,
          }}
          onClick={e => { if (e.target === e.currentTarget) { setIssueRoomId(null); setIssueNote(''); setPhotoPreview(null); } }}
        >
          <div style={{
            width: '100%', background: 'white',
            borderRadius: '20px 20px 0 0',
            padding: '24px 16px calc(env(safe-area-inset-bottom, 0px) + 24px)',
          }}>
            <h3 style={{ fontSize: '20px', fontWeight: 700, color: '#111827', marginBottom: '4px' }}>
              Report Issue
            </h3>
            <p style={{ fontSize: '13px', color: '#6B7280', marginBottom: '16px' }}>
              Room {rooms.find(r => r.id === issueRoomId)?.number}
            </p>
            <textarea
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              placeholder="Describe the issue (e.g. broken shower, missing towels, maintenance needed)"
              value={issueNote}
              onChange={e => setIssueNote(e.target.value)}
              rows={4}
              style={{
                width: '100%', padding: '14px', boxSizing: 'border-box',
                border: '1.5px solid #D1D5DB', borderRadius: '12px',
                fontSize: '16px', fontFamily: 'inherit',
                resize: 'none', outline: 'none', lineHeight: 1.5,
              }}
              onFocus={e => { (e.target as HTMLTextAreaElement).style.borderColor = '#166534'; }}
              onBlur={e => { (e.target as HTMLTextAreaElement).style.borderColor = '#D1D5DB'; }}
            />

            {/* Photo upload section */}
            <div style={{ marginTop: '14px' }}>
              {photoPreview ? (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: '10px',
                  padding: '12px', background: '#F0FDF4', borderRadius: '12px',
                  border: '1.5px solid #BBF7D0',
                }}>
                  <div style={{
                    width: '100%', height: '120px', background: '#fff',
                    borderRadius: '8px', overflow: 'hidden',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <img src={photoPreview} alt="Issue photo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }} />
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => {
                        const fileInput = document.getElementById('photo-input-issue') as HTMLInputElement;
                        fileInput?.click();
                      }}
                      style={{
                        flex: 1, height: '40px', border: '1.5px solid #16A34A',
                        borderRadius: '8px', background: 'white', color: '#16A34A',
                        fontSize: '14px', fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      Change Photo
                    </button>
                    <button
                      onClick={() => setPhotoPreview(null)}
                      style={{
                        flex: 1, height: '40px', border: 'none',
                        borderRadius: '8px', background: '#FEE2E2', color: '#DC2626',
                        fontSize: '14px', fontWeight: 600, cursor: 'pointer',
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    const fileInput = document.getElementById('photo-input-issue') as HTMLInputElement;
                    fileInput?.click();
                  }}
                  style={{
                    width: '100%', height: '44px', border: '1.5px dashed #D1D5DB',
                    borderRadius: '12px', background: '#F9FAFB', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    fontSize: '14px', fontWeight: 600, color: '#6B7280',
                    transition: 'all 150ms ease',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#166534';
                    (e.currentTarget as HTMLButtonElement).style.background = '#F0FDF4';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = '#D1D5DB';
                    (e.currentTarget as HTMLButtonElement).style.background = '#F9FAFB';
                  }}
                >
                  <Camera size={16} />
                  Add Photo
                </button>
              )}
              <input
                id="photo-input-issue"
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = ev => {
                      setPhotoPreview(ev.target?.result as string);
                    };
                    reader.readAsDataURL(file);
                  }
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
              <button
                onClick={() => { setIssueRoomId(null); setIssueNote(''); setPhotoPreview(null); }}
                style={{
                  flex: 1, height: '52px', background: '#F3F4F6', border: 'none',
                  borderRadius: '12px', fontSize: '16px', fontWeight: 600,
                  color: '#374151', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitIssue}
                disabled={!issueNote.trim() || savingIssue}
                style={{
                  flex: 1, height: '52px', border: 'none', borderRadius: '12px',
                  fontSize: '16px', fontWeight: 600, cursor: !issueNote.trim() ? 'not-allowed' : 'pointer',
                  background: !issueNote.trim() || savingIssue ? '#D1D5DB' : '#166534',
                  color: !issueNote.trim() || savingIssue ? '#9CA3AF' : 'white',
                  transition: 'background 150ms ease',
                }}
              >
                {savingIssue ? 'Saving…' : 'Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Room Card ── */
function RoomCard({
  room,
  isExpanded,
  onToggleExpand,
  onStatusChange,
  onReportIssue,
}: {
  room: RoomWithRef;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onStatusChange: (r: RoomWithRef, s: RoomStatus) => void;
  onReportIssue: () => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleAction = async (newStatus: RoomStatus) => {
    setLoading(true);
    try {
      await onStatusChange(room, newStatus);
    } finally {
      setLoading(false);
    }
  };

  const checklistItems = [
    { key: 'beds', label: 'Beds Made' },
    { key: 'bathroom', label: 'Bathroom Cleaned' },
    { key: 'towels', label: 'Towels Replaced' },
    { key: 'trash', label: 'Trash Emptied' },
    { key: 'amenities', label: 'Amenities Restocked' },
    { key: 'floors', label: 'Floors Swept/Vacuumed' },
    { key: 'mirrors', label: 'Mirrors & Windows Cleaned' },
  ];

  const handleChecklistToggle = async (key: string) => {
    const currentChecklist = (room.checklist as Record<string, boolean>) ?? {};
    const updated = { ...currentChecklist, [key]: !currentChecklist[key] };
    await updateDoc(room._ref, { checklist: updated });
  };

  const checklistDone = Object.values((room.checklist as Record<string, boolean>) ?? {}).filter(Boolean).length;
  const checklistTotal = checklistItems.length;

  const statusConfig = ({
    dirty:       { bg: '#FFF7ED', border: '#FED7AA', badge: '#EA580C', badgeText: '#FFF7ED', label: 'Needs Cleaning' },
    in_progress: { bg: '#FFFBEB', border: '#FDE68A', badge: '#D97706', badgeText: '#FFFBEB', label: 'In Progress' },
    clean:       { bg: '#F0FDF4', border: '#BBF7D0', badge: '#16A34A', badgeText: '#F0FDF4', label: 'Done' },
    inspected:   { bg: '#F5F3FF', border: '#DDD6FE', badge: '#7C3AED', badgeText: '#F5F3FF', label: 'Inspected' },
  } as Record<string, { bg: string; border: string; badge: string; badgeText: string; label: string }>)[room.status] ?? {
    bg: '#F9FAFB', border: '#E5E7EB', badge: '#6B7280', badgeText: '#F9FAFB', label: room.status,
  };

  const typeLabel = room.type === 'checkout' ? 'Checkout' : 'Stayover';
  const priorityLabel = room.priority === 'vip' ? '★ VIP' : room.priority === 'early' ? '⚡ Early' : null;
  const priorityColor = room.priority === 'vip'
    ? (room.type === 'checkout' ? '#DC2626' : '#7C3AED')
    : room.priority === 'early' ? '#EA580C' : '#6B7280';

  return (
    <div style={{
      background: room.status === 'clean' ? '#F9FAFB' : 'white',
      border: `1.5px solid ${statusConfig.border}`,
      borderLeft: `5px solid ${statusConfig.badge}`,
      borderRadius: '16px',
      padding: '16px',
      opacity: room.status === 'clean' ? 0.8 : 1,
      transition: 'opacity 200ms ease',
      boxShadow: room.status === 'clean' ? 'none' : '0 1px 4px rgba(0,0,0,0.05)',
      cursor: room.status === 'in_progress' ? 'pointer' : 'default',
    }}>
      {/* DND Banner */}
      {(room.isDnd as boolean | undefined) && (
        <div style={{
          background: '#FCD34D', color: '#78350F',
          padding: '10px 12px', borderRadius: '10px',
          fontSize: '13px', fontWeight: 600, marginBottom: '12px',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}>
          🚫 Do Not Disturb
        </div>
      )}

      {/* Top row: room number + status badge */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: '10px', cursor: room.status === 'in_progress' ? 'pointer' : 'default',
        }}
        onClick={room.status === 'in_progress' ? onToggleExpand : undefined}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1 }}>
          <span style={{
            fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: '28px',
            color: '#111827', letterSpacing: '-0.02em', lineHeight: 1,
          }}>
            {room.number}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span style={{
              fontSize: '11px', fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.06em', color: '#6B7280',
            }}>
              {typeLabel}
            </span>
            {priorityLabel && (
              <span style={{
                fontSize: '11px', fontWeight: 700, padding: '1px 6px', borderRadius: '5px',
                color: priorityColor,
                background: `${priorityColor}1A`,
                border: `1px solid ${priorityColor}4D`,
              }}>
                {priorityLabel}
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {room.status === 'in_progress' && (
            <span style={{
              padding: '4px 10px', borderRadius: '6px',
              background: '#DBEAFE', color: '#1e40af',
              fontSize: '11px', fontWeight: 700, letterSpacing: '0.04em',
            }}>
              {checklistDone}/{checklistTotal}
            </span>
          )}
          <span style={{
            padding: '5px 12px', borderRadius: '99px',
            background: statusConfig.badge, color: statusConfig.badgeText,
            fontSize: '12px', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            {statusConfig.label}
          </span>
        </div>
      </div>

      {/* Completed time */}
      {room.status === 'clean' && room.completedAt && (
        <p style={{ fontSize: '12px', color: '#16A34A', fontWeight: 600, marginBottom: '10px' }}>
          ✓ Done at{' '}
          {format(firestoreToDate(room.completedAt), 'h:mm a')}
        </p>
      )}

      {/* Expanded checklist (in_progress only) */}
      {room.status === 'in_progress' && isExpanded && (
        <div style={{ marginBottom: '14px', paddingBottom: '12px', borderBottom: '1px solid #E5E7EB' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr', gap: '8px',
          }}>
            {checklistItems.map(item => {
              const isChecked = (room.checklist as Record<string, boolean>)?.[item.key] ?? false;
              return (
                <div
                  key={item.key}
                  onClick={() => handleChecklistToggle(item.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 12px', borderRadius: '10px',
                    background: isChecked ? '#F0FDF4' : '#F9FAFB',
                    border: `1px solid ${isChecked ? '#BBF7D0' : '#E5E7EB'}`,
                    cursor: 'pointer', transition: 'all 150ms ease',
                  }}
                  onMouseEnter={e => {
                    if (!isChecked) {
                      (e.currentTarget as HTMLDivElement).style.borderColor = '#D1D5DB';
                      (e.currentTarget as HTMLDivElement).style.background = '#FAFBFC';
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isChecked) {
                      (e.currentTarget as HTMLDivElement).style.borderColor = '#E5E7EB';
                      (e.currentTarget as HTMLDivElement).style.background = '#F9FAFB';
                    }
                  }}
                >
                  {isChecked ? (
                    <CheckSquare size={18} color="#16A34A" />
                  ) : (
                    <Square size={18} color="#D1D5DB" />
                  )}
                  <span style={{
                    fontSize: '14px', fontWeight: 500, color: isChecked ? '#16A34A' : '#374151',
                    textDecoration: isChecked ? 'line-through' : 'none',
                  }}>
                    {item.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Issue note display */}
      {(room as Room & { issueNote?: string; hasPhoto?: boolean }).issueNote && (
        <div style={{
          display: 'flex', gap: '6px', alignItems: 'flex-start',
          padding: '8px 10px', background: '#FEF3C7', borderRadius: '8px',
          marginBottom: '12px',
        }}>
          <AlertTriangle size={14} color="#D97706" style={{ flexShrink: 0, marginTop: '1px' }} />
          <div style={{ flex: 1 }}>
            <span style={{ fontSize: '13px', color: '#92400E', lineHeight: 1.4 }}>
              {(room as Room & { issueNote?: string }).issueNote}
            </span>
            {(room as Room & { hasPhoto?: boolean }).hasPhoto && (
              <p style={{ fontSize: '11px', color: '#92400E', marginTop: '4px', fontStyle: 'italic' }}>
                📷 Photo attached
              </p>
            )}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
        {room.status === 'dirty' && (
          <button
            onClick={() => handleAction('in_progress')}
            disabled={loading}
            style={{
              flex: 1, height: '52px', border: 'none', borderRadius: '12px',
              background: '#166534', color: 'white',
              fontSize: '16px', fontWeight: 700, cursor: 'pointer',
              opacity: loading ? 0.7 : 1, transition: 'opacity 150ms ease',
            }}
          >
            {loading ? 'Starting…' : 'Start Cleaning'}
          </button>
        )}

        {room.status === 'in_progress' && (
          <button
            onClick={() => handleAction('clean')}
            disabled={loading}
            style={{
              flex: 1, height: '52px', border: 'none', borderRadius: '12px',
              background: '#15803D', color: 'white',
              fontSize: '16px', fontWeight: 700, cursor: 'pointer',
              opacity: loading ? 0.7 : 1, transition: 'opacity 150ms ease',
            }}
          >
            {loading ? 'Saving…' : 'Mark Done ✓'}
          </button>
        )}

        {room.status === 'clean' && (
          <div style={{
            flex: 1, height: '52px', borderRadius: '12px',
            background: '#DCFCE7', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          }}>
            <CheckCircle size={18} color="#16A34A" />
            <span style={{ fontSize: '15px', fontWeight: 700, color: '#16A34A' }}>Done</span>
          </div>
        )}

        <button
          onClick={onReportIssue}
          style={{
            width: '52px', height: '52px', border: '1.5px solid #E5E7EB',
            borderRadius: '12px', background: 'white', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
          title="Report Issue"
          aria-label="Report issue for this room"
        >
          <AlertTriangle size={18} color="#6B7280" />
        </button>
      </div>
    </div>
  );
}
