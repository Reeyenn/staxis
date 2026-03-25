'use client';

import React, { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, addRoom, updateRoom, deleteRoom, bulkAddRooms, getRoomsForDate, carryOverRooms } from '@/lib/firestore';
import { autoAssignRooms, buildHousekeeperAssignments, getRoomMinutes, formatMinutes, type HousekeeperAssignment } from '@/lib/calculations';
import { sendAssignmentNotifications, sendSmsNotifications } from '@/lib/notifications';
import { todayStr, yesterdayStr } from '@/lib/utils';
import type { Room, RoomStatus, RoomType, RoomPriority, StaffMember } from '@/types';
import { Modal } from '@/components/ui/Modal';
import { BedDouble, Plus, Zap, CheckCircle, Clock, Trash2, Upload, ClipboardCheck, ShieldCheck, X, Users, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';

interface FloorRow {
  id: string;
  start: string;
  end: string;
  type: RoomType;
  priority: RoomPriority;
}

const PRIORITY_ORDER: Record<string, number> = {
  vip_checkout: 0, early_checkout: 1, standard_checkout: 2,
  vip_stayover: 3, standard_stayover: 4,
};

const PRIORITY_BADGE: Record<string, { label: string; labelEs: string; color: string; bg: string; border: string }> = {
  vip_checkout:      { label: '★ VIP Checkout',     labelEs: '★ Salida VIP',           color: '#DC2626', bg: 'rgba(220,38,38,0.1)',   border: 'rgba(220,38,38,0.3)'   },
  early_checkout:    { label: '⚡ Early Checkout',   labelEs: '⚡ Salida Temprana',      color: '#EA580C', bg: 'rgba(234,88,12,0.1)',   border: 'rgba(234,88,12,0.3)'   },
  standard_checkout: { label: 'Checkout',            labelEs: 'Salida',                  color: '#2563EB', bg: 'rgba(37,99,235,0.1)',   border: 'rgba(37,99,235,0.3)'   },
  vip_stayover:      { label: '★ VIP Stayover',      labelEs: '★ Permanencia VIP',      color: '#7C3AED', bg: 'rgba(124,58,237,0.1)', border: 'rgba(124,58,237,0.3)'  },
  early_stayover:    { label: '⚡ Early Stayover',   labelEs: '⚡ Permanencia Temprana', color: '#EA580C', bg: 'rgba(234,88,12,0.1)',   border: 'rgba(234,88,12,0.3)'   },
  standard_stayover: { label: 'Stayover',            labelEs: 'Permanencia',             color: '#4B5563', bg: 'rgba(75,85,99,0.1)',   border: 'rgba(75,85,99,0.3)'    },
};

function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => {
    // vacant rooms sink to bottom (after stayovers but before inspected)
    if (a.type === 'vacant' && b.type !== 'vacant') return 1;
    if (b.type === 'vacant' && a.type !== 'vacant') return -1;
    // inspected sinks to bottom
    if (a.status === 'inspected' && b.status !== 'inspected') return 1;
    if (b.status === 'inspected' && a.status !== 'inspected') return -1;
    // clean (awaiting inspection) above inspected but below active work
    if (a.status === 'clean' && b.status !== 'clean' && b.status !== 'inspected') return 1;
    if (b.status === 'clean' && a.status !== 'clean' && a.status !== 'inspected') return -1;
    const ka = `${a.priority}_${a.type}`;
    const kb = `${b.priority}_${b.type}`;
    return (PRIORITY_ORDER[ka] ?? 5) - (PRIORITY_ORDER[kb] ?? 5);
  });
}

/* Status colour map */
const STATUS = {
  clean:       { color:'#22C55E', bg:'rgba(34,197,94,0.06)',   border:'rgba(34,197,94,0.24)',   stripe:'#22C55E' },
  in_progress: { color:'#FBBF24', bg:'rgba(251,191,36,0.06)',  border:'rgba(251,191,36,0.24)',  stripe:'#FBBF24' },
  dirty:       { color:'#EF4444', bg:'rgba(239,68,68,0.04)',    border:'rgba(239,68,68,0.22)',   stripe:'#EF4444' },
  inspected:   { color:'#8B5CF6', bg:'rgba(139,92,246,0.06)',   border:'rgba(139,92,246,0.24)',  stripe:'#8B5CF6' },
};

export default function RoomsPage() {
  const { user }                                   = useAuth();
  const { activePropertyId, staff, activeProperty } = useProperty();
  const { lang }                    = useLang();

  const [rooms,         setRooms]         = useState<Room[]>([]);
  const [showAddModal,  setShowAddModal]  = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [filterStatus,  setFilterStatus]  = useState<RoomStatus | 'all'>('all');
  const [toast,         setToast]         = useState<string | null>(null);
  const [typeEditingRoomId, setTypeEditingRoomId] = useState<string | null>(null);
  const [priorityEditingRoomId, setPriorityEditingRoomId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<'priority' | 'number'>('priority');

  // Carry-over state
  const [yesterdayCount, setYesterdayCount] = useState<number | null>(null);
  const [carryingOver,   setCarryingOver]   = useState(false);

  // Inspection modal state
  const [inspectingRoom,  setInspectingRoom]  = useState<Room | null>(null);
  const [inspectorName,   setInspectorName]   = useState('');

  // Smart Assign modal state
  const [showAssignModal,    setShowAssignModal]    = useState(false);
  const [pendingAssignments, setPendingAssignments] = useState<Record<string, string>>({});
  const [isPublishing,       setIsPublishing]       = useState(false);

  const [newRoom, setNewRoom] = useState({
    number:'', type:'checkout' as RoomType, priority:'standard' as RoomPriority,
    assignedTo:'', assignedName:'',
  });
  const [bulkText,     setBulkText]     = useState('');
  const [bulkType,     setBulkType]     = useState<RoomType>('checkout');
  const [bulkPriority, setBulkPriority] = useState<RoomPriority>('standard');
  const [bulkMode,     setBulkMode]     = useState<'manual' | 'floors'>('manual');
  const [floorRows,    setFloorRows]    = useState<FloorRow[]>([
    { id: '1', start: '101', end: '120', type: 'checkout', priority: 'standard' },
  ]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
  }, [user, activePropertyId]);

  // When today's rooms are confirmed empty, check if yesterday had rooms
  useEffect(() => {
    if (!user || !activePropertyId) return;
    if (rooms.length > 0) { setYesterdayCount(null); return; } // today already has rooms
    getRoomsForDate(user.uid, activePropertyId, yesterdayStr()).then(prev => {
      setYesterdayCount(prev.length > 0 ? prev.length : 0);
    });
  }, [user, activePropertyId, rooms.length]);

  const handleCarryOver = async () => {
    if (!user || !activePropertyId) return;
    setCarryingOver(true);
    const count = await carryOverRooms(user.uid, activePropertyId, yesterdayStr(), todayStr());
    setCarryingOver(false);
    setYesterdayCount(null);
    showToast(lang === 'es' ? `${count} habitaciones transferidas — estado reiniciado a sucias` : `${count} rooms carried over — all reset to dirty`);
  };

  const sorted    = sortMode === 'number'
    ? [...rooms].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
    : sortRooms(rooms);
  const displayed = filterStatus === 'all' ? sorted : sorted.filter(r => r.status === filterStatus);

  const handleAdd = async () => {
    if (!user || !activePropertyId || !newRoom.number.trim()) return;
    const staffMember = staff.find(s => s.id === newRoom.assignedTo);
    await addRoom(user.uid, activePropertyId, {
      number: newRoom.number.trim(), type: newRoom.type, priority: newRoom.priority,
      status: 'dirty', assignedTo: newRoom.assignedTo || undefined,
      assignedName: staffMember?.name || undefined,
      date: todayStr(), propertyId: activePropertyId,
    });
    setNewRoom({ number:'', type:'checkout', priority:'standard', assignedTo:'', assignedName:'' });
    setShowAddModal(false);
  };

  const handleBulkAdd = async () => {
    if (!user || !activePropertyId || !bulkText.trim()) return;
    const numbers = bulkText.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    await bulkAddRooms(user.uid, activePropertyId, numbers.map(number => ({
      number, type: bulkType, priority: bulkPriority,
      status: 'dirty' as RoomStatus, date: todayStr(), propertyId: activePropertyId,
    })));
    setBulkText('');
    setShowBulkModal(false);
  };

  const handleFloorAdd = async () => {
    if (!user || !activePropertyId) return;
    const roomsToAdd: Omit<Room, 'id'>[] = [];
    for (const row of floorRows) {
      const start = parseInt(row.start);
      const end   = parseInt(row.end);
      if (isNaN(start) || isNaN(end) || end < start || (end - start) > 200) continue;
      for (let n = start; n <= end; n++) {
        roomsToAdd.push({
          number: String(n), type: row.type, priority: row.priority,
          status: 'dirty' as RoomStatus, date: todayStr(), propertyId: activePropertyId,
        });
      }
    }
    if (roomsToAdd.length === 0) return;
    await bulkAddRooms(user.uid, activePropertyId, roomsToAdd);
    setFloorRows([{ id: '1', start: '101', end: '120', type: 'checkout', priority: 'standard' }]);
    setBulkMode('manual');
    setShowBulkModal(false);
    showToast(lang === 'es' ? `${roomsToAdd.length} habitaciones agregadas!` : `${roomsToAdd.length} rooms added!`);
  };

  // Open Smart Assign modal — compute AI assignments and show preview
  const handleSmartAssign = async () => {
    if (!user || !activePropertyId || rooms.length === 0 || staff.length === 0) return;
    const assignable = rooms.filter(r => r.status !== 'clean' && r.status !== 'inspected');
    if (assignable.length === 0) { showToast('All rooms are already clean or inspected!'); return; }
    const scheduledStaff = staff.filter(s => s.scheduledToday);
    if (scheduledStaff.length === 0) { showToast('No housekeepers are scheduled today.'); return; }
    const assignments = autoAssignRooms(
      assignable.map(r => ({ id: r.id, number: r.number, type: r.type, priority: r.priority })),
      staff
    );
    setPendingAssignments(assignments);
    setShowAssignModal(true);
  };

  // Publish: save to Firestore + send notifications
  const handlePublishAssignments = async () => {
    if (!user || !activePropertyId) return;
    setIsPublishing(true);
    try {
      await Promise.all(Object.entries(pendingAssignments).map(([rid, staffId]) => {
        const m = staff.find(s => s.id === staffId);
        return updateRoom(user.uid, activePropertyId, rid, { assignedTo: staffId, assignedName: m?.name });
      }));

      const staffRooms: Record<string, string[]> = {};
      Object.entries(pendingAssignments).forEach(([rid, staffId]) => {
        const room = rooms.find(r => r.id === rid);
        if (!room) return;
        if (!staffRooms[staffId]) staffRooms[staffId] = [];
        staffRooms[staffId].push(room.number);
      });

      const staffNames:  Record<string, string> = {};
      const staffTokens: Record<string, string> = {};
      const staffPhones: Record<string, string> = {};
      staff.forEach(s => {
        staffNames[s.id]  = s.name;
        if (s.fcmToken) staffTokens[s.id] = s.fcmToken;
        if (s.phone)    staffPhones[s.id] = s.phone;
      });

      sendAssignmentNotifications(staffRooms, staffNames, staffTokens).catch(console.error);
      sendSmsNotifications(staffRooms, staffNames, staffPhones)
        .then(({ sent, failed }) => console.log(`SMS: ${sent} sent, ${failed} failed`))
        .catch(console.error);

      const count = Object.keys(pendingAssignments).length;
      setShowAssignModal(false);
      setPendingAssignments({});
      showToast(lang === 'es'
        ? `¡Asignaciones publicadas! ${count} habitación${count !== 1 ? 'es' : ''} asignada${count !== 1 ? 's' : ''}.`
        : `Assignments published! ${count} room${count !== 1 ? 's' : ''} assigned.`);
    } finally {
      setIsPublishing(false);
    }
  };

  const handleStatusChange = async (room: Room, newStatus: RoomStatus) => {
    if (!user || !activePropertyId) return;
    const updates: Partial<Room> = { status: newStatus };
    if (newStatus === 'in_progress') updates.startedAt  = new Date();
    if (newStatus === 'clean')       updates.completedAt = new Date();
    await updateRoom(user.uid, activePropertyId, room.id, updates);
  };

  const handleInspect = async () => {
    if (!user || !activePropertyId || !inspectingRoom) return;
    const name = inspectorName.trim() || 'Manager';
    await updateRoom(user.uid, activePropertyId, inspectingRoom.id, {
      status: 'inspected',
      inspectedBy: name,
      inspectedAt: new Date(),
    });
    setInspectingRoom(null);
    setInspectorName('');
    showToast(lang === 'es' ? `Habitación ${inspectingRoom.number} aprobada ✓` : `Room ${inspectingRoom.number} approved ✓`);
  };

  const handleDelete = async (rid: string) => {
    if (!user || !activePropertyId) return;
    await deleteRoom(user.uid, activePropertyId, rid);
  };

  const handlePriorityChange = async (room: Room, newPriority: RoomPriority) => {
    if (!user || !activePropertyId) return;
    await updateRoom(user.uid, activePropertyId, room.id, { priority: newPriority });
    setPriorityEditingRoomId(null);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const dirty      = rooms.filter(r => r.status === 'dirty').length;
  const inProgress = rooms.filter(r => r.status === 'in_progress').length;
  const clean      = rooms.filter(r => r.status === 'clean').length;
  const inspected  = rooms.filter(r => r.status === 'inspected').length;
  const bulkCount  = bulkText.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).length;

  // Room type breakdown
  const checkoutCount = rooms.filter(r => r.type === 'checkout').length;
  const stayoverCount = rooms.filter(r => r.type === 'stayover').length;
  const vacantCount   = rooms.filter(r => r.type === 'vacant').length;

  return (
    <AppLayout>
      <div style={{ padding:'20px 16px', display:'flex', flexDirection:'column', gap:'14px' }}>

        {/* ── Header ── */}
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px' }} className="animate-in">
          <div>
            <p style={{ color:'var(--text-muted)', fontSize:'11px', fontWeight:500, letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:'4px' }}>
              {format(new Date(), 'EEEE, MMMM d')}
            </p>
            <h1 style={{ fontFamily:'var(--font-sans)', fontWeight:700, fontSize:'26px', color:'var(--text-primary)', letterSpacing:'-0.02em', display:'flex', alignItems:'center', gap:'8px' }}>
              <BedDouble size={18} color="var(--amber)" />
              {t('rooms', lang)}
            </h1>
          </div>
          <div style={{ display:'flex', gap:'8px', flexShrink:0, paddingTop:'4px' }}>
            <button onClick={() => setShowBulkModal(true)} className="btn btn-secondary btn-sm">
              <Upload size={13} /> {t('bulkAdd', lang)}
            </button>
            <button onClick={() => setShowAddModal(true)} className="btn btn-primary btn-sm">
              <Plus size={13} /> {t('addRoom', lang)}
            </button>
          </div>
        </div>

        {/* ── Housekeeping View shortcut ── */}
        <Link href="/housekeeping" style={{ textDecoration:'none' }} className="animate-in">
          <div style={{
            display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'12px 14px', borderRadius:'var(--radius-md)',
            background:'var(--bg-card)', border:'1px solid var(--border)',
            transition:'all 150ms',
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
              <div style={{ width:'32px', height:'32px', borderRadius:'8px', background:'var(--amber-dim)', border:'1px solid var(--amber-border)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <Users size={15} color="var(--amber)" />
              </div>
              <div>
                <p style={{ fontSize:'14px', fontWeight:700, color:'var(--text-primary)', lineHeight:1.2 }}>Housekeeping View</p>
                <p style={{ fontSize:'11px', color:'var(--text-muted)' }}>Big buttons · Floor filters · Mobile-first</p>
              </div>
            </div>
            <span style={{ fontSize:'16px', color:'var(--text-muted)' }}>›</span>
          </div>
        </Link>

        {/* ── Stat cards — 2×2 grid ── */}
        <div className="animate-in stagger-1" style={{ display:'flex', flexDirection:'column', gap:'14px' }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:'10px' }}>
            {([
              { status:'dirty'       as RoomStatus, label: lang === 'es' ? 'Sucias' : 'Dirty',        count:dirty,      ...STATUS.dirty       },
              { status:'in_progress' as RoomStatus, label: lang === 'es' ? 'En Progreso' : 'Cleaning', count:inProgress, ...STATUS.in_progress },
              { status:'clean'       as RoomStatus, label: lang === 'es' ? 'Listas' : 'Ready',         count:clean,      ...STATUS.clean       },
              { status:'inspected'   as RoomStatus, label: lang === 'es' ? 'Aprobadas' : 'Approved',   count:inspected,  ...STATUS.inspected   },
            ]).map(({ status, label, count, color, bg, border }) => (
              <button key={status}
                onClick={() => setFilterStatus(filterStatus === status ? 'all' : status)}
                style={{
                  padding:'14px 8px', textAlign:'center', cursor:'pointer',
                  background: filterStatus === status ? bg : 'var(--bg-card)',
                  border: `1.5px solid ${filterStatus === status ? border : 'var(--border)'}`,
                  borderRadius:'var(--radius-md)',
                  transition:'all 150ms ease-out',
                }}
              >
                <div style={{ fontFamily:'var(--font-mono)', fontWeight:700, fontSize:'2.2rem', color, lineHeight:1, letterSpacing:'-0.03em' }}>
                  {count}
                </div>
                <div style={{ fontSize:'10px', fontWeight:700, color, marginTop:'5px', textTransform:'uppercase', letterSpacing:'0.08em', opacity:0.85 }}>
                  {label}
                </div>
              </button>
            ))}
          </div>
          {/* Room type breakdown */}
          <div style={{ fontSize:'12px', color:'var(--text-muted)', fontWeight:500, textAlign:'center', paddingTop:'2px' }}>
            {checkoutCount} {lang === 'es' ? 'salidas' : 'checkouts'} · {stayoverCount} {lang === 'es' ? 'permanencias' : 'stayovers'} · {vacantCount} {lang === 'es' ? 'vacantes' : 'vacant'}
          </div>
        </div>

        {/* ── Needs inspection alert banner ── */}
        {clean > 0 && (
          <div className="animate-in stagger-1" style={{
            display:'flex', alignItems:'center', gap:'10px',
            padding:'10px 14px', borderRadius:'var(--radius-md)',
            background:'rgba(34,197,94,0.06)', border:'1px solid rgba(34,197,94,0.24)',
          }}>
            <ClipboardCheck size={15} color="#22C55E" style={{ flexShrink:0 }} />
            <span style={{ fontSize:'13px', color:'#22C55E', fontWeight:600 }}>
              {clean} room{clean !== 1 ? 's' : ''} {lang === 'es' ? 'esperan inspección' : 'waiting for sign-off'}
            </span>
          </div>
        )}

        {/* ── Smart assign ── */}
        {rooms.filter(r => r.status !== 'clean' && r.status !== 'inspected').length > 0 && staff.length > 0 && (
          <button onClick={handleSmartAssign} className="btn btn-secondary animate-in stagger-2" style={{ width:'100%' }}>
            <Zap size={16} color="var(--amber)" />
            {t('smartAssign', lang)}
          </button>
        )}

        {/* ── Sort toggle ── */}
        {rooms.length > 0 && (
          <div className="animate-in stagger-2" style={{ display:'flex', alignItems:'center', gap:'8px', justifyContent:'flex-end' }}>
            <span style={{ fontSize:'11px', fontWeight:600, color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'0.06em', flexShrink:0 }}>
              {lang === 'es' ? 'Ordenar' : 'Sort'}
            </span>
            <div style={{ display:'flex', gap:'2px', background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:'8px', padding:'3px', flexShrink:0 }}>
              <button
                onClick={() => setSortMode('priority')}
                style={{
                  padding:'4px 10px', fontSize:'11px', fontWeight:600, borderRadius:'6px', border:'none', cursor:'pointer',
                  background: sortMode === 'priority' ? 'var(--amber)' : 'transparent',
                  color: sortMode === 'priority' ? '#0A0A0A' : 'var(--text-secondary)',
                  transition:'all 150ms ease-out',
                }}
              >
                {t('priorityOrder', lang)}
              </button>
              <button
                onClick={() => setSortMode('number')}
                style={{
                  padding:'4px 10px', fontSize:'11px', fontWeight:600, borderRadius:'6px', border:'none', cursor:'pointer',
                  background: sortMode === 'number' ? 'var(--amber)' : 'transparent',
                  color: sortMode === 'number' ? '#0A0A0A' : 'var(--text-secondary)',
                  transition:'all 150ms ease-out',
                }}
              >
                # {t('roomNumber', lang)}
              </button>
            </div>
          </div>
        )}

        {/* ── Room list / empty state ── */}
        {displayed.length === 0 ? (
          <div className="animate-in stagger-2" style={{ display:'flex', flexDirection:'column', gap:'12px' }}>
            {/* Carry-over banner — only when today is truly empty and yesterday had rooms */}
            {rooms.length === 0 && yesterdayCount !== null && yesterdayCount > 0 && (
              <div style={{
                padding:'18px', borderRadius:'var(--radius-md)',
                background:'rgba(212,144,64,0.08)', border:'1px solid rgba(212,144,64,0.3)',
                display:'flex', flexDirection:'column', gap:'12px',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                  <BedDouble size={18} color="var(--amber)" style={{ flexShrink:0 }} />
                  <div>
                    <p style={{ fontSize:'14px', fontWeight:700, color:'var(--text-primary)', marginBottom:'2px' }}>
                      {lang === 'es'
                        ? `${yesterdayCount} habitaciones de ayer disponibles`
                        : `${yesterdayCount} rooms from yesterday`}
                    </p>
                    <p style={{ fontSize:'12px', color:'var(--text-muted)' }}>
                      {lang === 'es'
                        ? 'Traerlas a hoy con estado sucio — sin asignaciones ni timestamps.'
                        : 'Carry them into today — all reset to dirty, assignments cleared.'}
                    </p>
                  </div>
                </div>
                <div style={{ display:'flex', gap:'8px' }}>
                  <button
                    onClick={handleCarryOver}
                    disabled={carryingOver}
                    className="btn btn-primary"
                    style={{ flex:1 }}
                  >
                    {carryingOver
                      ? (lang === 'es' ? 'Cargando...' : 'Carrying over...')
                      : (lang === 'es' ? `Traer ${yesterdayCount} habitaciones` : `Carry over ${yesterdayCount} rooms`)}
                  </button>
                  <button
                    onClick={() => setYesterdayCount(0)}
                    className="btn btn-secondary"
                    style={{ flexShrink:0 }}
                  >
                    {lang === 'es' ? 'Empezar vacío' : 'Start fresh'}
                  </button>
                </div>
              </div>
            )}
            {/* Standard empty state */}
            <div style={{
              textAlign:'center', padding:'52px 20px',
              background:'var(--bg-card)', border:'1px solid var(--border)',
              borderRadius:'var(--radius-md)',
            }}>
              <div style={{
                width:'60px', height:'60px', borderRadius:'16px', margin:'0 auto 14px',
                background:'rgba(255,255,255,0.04)', border:'1px solid var(--border)',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                <BedDouble size={28} color="var(--text-muted)" />
              </div>
              <p style={{ color:'var(--text-secondary)', fontSize:'15px', fontWeight:500, lineHeight:1.5 }}>
                {rooms.length === 0
                  ? (lang === 'es' ? 'Sin habitaciones. Agrega o usa "Traer de ayer".' : 'No rooms added yet. Hit "Add Room" or "Bulk Add" to get started.')
                  : (lang === 'es' ? 'Sin habitaciones en este filtro.' : 'No rooms match the current filter.')}
              </p>
            </div>
          </div>
        ) : (
          <div className="animate-in stagger-2" style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
            {displayed.map(room => (
              <RoomCard
                key={room.id}
                room={room}
                onStatusChange={handleStatusChange}
                onDelete={handleDelete}
                onInspect={() => { setInspectingRoom(room); setInspectorName(''); }}
                onTypeChange={(newType) => { if (user && activePropertyId) updateRoom(user.uid, activePropertyId, room.id, { type: newType }); }}
                onDndToggle={() => { if (user && activePropertyId) updateRoom(user.uid, activePropertyId, room.id, { isDnd: !room.isDnd }); }}
                onPriorityChange={(newPriority) => handlePriorityChange(room, newPriority)}
                typeEditingRoomId={typeEditingRoomId}
                setTypeEditingRoomId={setTypeEditingRoomId}
                priorityEditingRoomId={priorityEditingRoomId}
                setPriorityEditingRoomId={setPriorityEditingRoomId}
                lang={lang}
              />
            ))}
          </div>
        )}

        {/* ── Add room modal ── */}
        <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title={t('addRoom', lang)}>
          <div style={{ display:'flex', flexDirection:'column', gap:'14px' }}>
            <div>
              <label className="label">{t('roomNumber', lang)}</label>
              <input
                type="text" placeholder="e.g. 215" autoFocus
                value={newRoom.number} onChange={e => setNewRoom(r => ({ ...r, number:e.target.value }))}
                className="input"
                style={{ fontSize:'24px', fontFamily:'var(--font-mono)', fontWeight:700, textAlign:'center', letterSpacing:'0.05em' }}
              />
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
              <div>
                <label className="label">{t('type', lang)}</label>
                <select value={newRoom.type} onChange={e => setNewRoom(r => ({ ...r, type:e.target.value as RoomType }))} className="input">
                  <option value="checkout">{t('checkout', lang)}</option>
                  <option value="stayover">{t('stayover', lang)}</option>
                </select>
              </div>
              <div>
                <label className="label">{t('priority', lang)}</label>
                <select value={newRoom.priority} onChange={e => setNewRoom(r => ({ ...r, priority:e.target.value as RoomPriority }))} className="input">
                  <option value="standard">{t('standard', lang)}</option>
                  <option value="vip">{t('vip', lang)}</option>
                  <option value="early">{t('earlyCheckin', lang)}</option>
                </select>
              </div>
            </div>
            {staff.length > 0 && (
              <div>
                <label className="label">{t('assignTo', lang)}</label>
                <select
                  value={newRoom.assignedTo}
                  onChange={e => setNewRoom(r => ({ ...r, assignedTo:e.target.value, assignedName:staff.find(s => s.id === e.target.value)?.name ?? '' }))}
                  className="input"
                >
                  <option value="">{lang === 'es' ? '— Sin Asignar —' : '— Unassigned —'}</option>
                  {staff.filter(s => s.scheduledToday).map(s => (
                    <option key={s.id} value={s.id}>{s.name}{s.isSenior ? ' ⭐' : ''}</option>
                  ))}
                </select>
              </div>
            )}
            <div style={{ display:'flex', gap:'10px', marginTop:'4px' }}>
              <button onClick={() => setShowAddModal(false)} className="btn btn-secondary" style={{ flex:1 }}>{t('cancel', lang)}</button>
              <button onClick={handleAdd} disabled={!newRoom.number.trim()} className="btn btn-primary" style={{ flex:1 }}>{t('addRoom', lang)}</button>
            </div>
          </div>
        </Modal>

        {/* ── Bulk add modal ── */}
        <Modal isOpen={showBulkModal} onClose={() => { setShowBulkModal(false); setBulkMode('manual'); }} title="Add Rooms">
          <div style={{ display:'flex', flexDirection:'column', gap:'14px' }}>

            {/* Mode tabs */}
            <div style={{ display:'flex', background:'var(--bg)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:'3px', gap:'3px' }}>
              {(['manual', 'floors'] as const).map(mode => (
                <button key={mode} onClick={() => setBulkMode(mode)} style={{
                  flex:1, padding:'8px', borderRadius:'calc(var(--radius-md) - 3px)',
                  background: bulkMode === mode ? 'var(--bg-card)' : 'transparent',
                  border: bulkMode === mode ? '1px solid var(--border)' : 'none',
                  cursor:'pointer', color: bulkMode === mode ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: bulkMode === mode ? 600 : 400, fontSize:'13px',
                  fontFamily:'var(--font-sans)', transition:'all 120ms',
                }}>
                  {mode === 'manual' ? 'Manual' : (lang === 'es' ? '🏨 Por Piso' : '🏨 Floor Setup')}
                </button>
              ))}
            </div>

            {bulkMode === 'manual' ? (
              <>
                <div>
                  <label className="label">{lang === 'es' ? 'Números de Habitaciones (separados por coma o línea)' : 'Room Numbers (comma or line separated)'}</label>
                  <textarea
                    placeholder={lang === 'es' ? '201, 202, 203\nuno por línea' : '201, 202, 203\nor one per line'}
                    value={bulkText} onChange={e => setBulkText(e.target.value)}
                    className="input" rows={5}
                    style={{ resize:'vertical', fontFamily:'var(--font-mono)', fontSize:'16px' }}
                  />
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                  <div>
                    <label className="label">{t('type', lang)} (all)</label>
                    <select value={bulkType} onChange={e => setBulkType(e.target.value as RoomType)} className="input">
                      <option value="checkout">{t('checkout', lang)}</option>
                      <option value="stayover">{t('stayover', lang)}</option>
                    </select>
                  </div>
                  <div>
                    <label className="label">{t('priority', lang)} (all)</label>
                    <select value={bulkPriority} onChange={e => setBulkPriority(e.target.value as RoomPriority)} className="input">
                      <option value="standard">{t('standard', lang)}</option>
                      <option value="vip">{t('vip', lang)}</option>
                      <option value="early">{t('earlyCheckin', lang)}</option>
                    </select>
                  </div>
                </div>
                <div style={{ display:'flex', gap:'10px', marginTop:'4px' }}>
                  <button onClick={() => setShowBulkModal(false)} className="btn btn-secondary" style={{ flex:1 }}>{t('cancel', lang)}</button>
                  <button onClick={handleBulkAdd} disabled={!bulkText.trim()} className="btn btn-primary" style={{ flex:1 }}>
                    {lang === 'es' ? `Agregar ${bulkCount} Habitaciones` : `Add ${bulkCount} Rooms`}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize:'13px', color:'var(--text-muted)', marginTop:'-4px' }}>
                  {lang === 'es' ? 'Define rangos por piso. Cada piso agrega todas las habitaciones del rango.' : 'Set room ranges per floor. Each floor adds all rooms in the range.'}
                </p>

                <div style={{ display:'flex', flexDirection:'column', gap:'10px', maxHeight:'360px', overflowY:'auto' }}>
                  {floorRows.map((row, idx) => {
                    const startNum = parseInt(row.start);
                    const endNum   = parseInt(row.end);
                    const count    = (!isNaN(startNum) && !isNaN(endNum) && endNum >= startNum) ? endNum - startNum + 1 : 0;
                    const floorLabel = (!isNaN(startNum) && startNum >= 100) ? Math.floor(startNum / 100) : idx + 1;
                    return (
                      <div key={row.id} style={{
                        background:'var(--bg)', border:'1px solid var(--border)',
                        borderRadius:'var(--radius-md)', padding:'12px',
                      }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'8px' }}>
                          <span style={{ fontSize:'13px', fontWeight:700, color:'var(--text-primary)' }}>
                            {lang === 'es' ? 'Piso' : 'Floor'} {floorLabel}
                          </span>
                          <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                            {count > 0 && (
                              <span style={{ fontSize:'11px', fontWeight:600, color:'var(--amber)', background:'var(--amber-dim)', border:'1px solid var(--amber-border)', padding:'2px 8px', borderRadius:'100px' }}>
                                {count} {lang === 'es' ? 'hab.' : 'rooms'}
                              </span>
                            )}
                            {floorRows.length > 1 && (
                              <button
                                onClick={() => setFloorRows(rows => rows.filter(r => r.id !== row.id))}
                                style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', padding:'0 4px', fontSize:'18px', lineHeight:1 }}
                              >×</button>
                            )}
                          </div>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px', marginBottom:'8px' }}>
                          <div>
                            <label className="label" style={{ fontSize:'10px' }}>{lang === 'es' ? 'Hab. Inicial #' : 'Start Room #'}</label>
                            <input
                              type="text" inputMode="numeric" value={row.start}
                              onChange={e => setFloorRows(rows => rows.map(r => r.id === row.id ? { ...r, start: e.target.value } : r))}
                              className="input" style={{ fontFamily:'var(--font-mono)', fontWeight:700, fontSize:'20px', textAlign:'center' }}
                            />
                          </div>
                          <div>
                            <label className="label" style={{ fontSize:'10px' }}>{lang === 'es' ? 'Hab. Final #' : 'End Room #'}</label>
                            <input
                              type="text" inputMode="numeric" value={row.end}
                              onChange={e => setFloorRows(rows => rows.map(r => r.id === row.id ? { ...r, end: e.target.value } : r))}
                              className="input" style={{ fontFamily:'var(--font-mono)', fontWeight:700, fontSize:'20px', textAlign:'center' }}
                            />
                          </div>
                        </div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px' }}>
                          <div>
                            <label className="label" style={{ fontSize:'10px' }}>{t('type', lang)}</label>
                            <select value={row.type} onChange={e => setFloorRows(rows => rows.map(r => r.id === row.id ? { ...r, type: e.target.value as RoomType } : r))} className="input" style={{ fontSize:'13px' }}>
                              <option value="checkout">{t('checkout', lang)}</option>
                              <option value="stayover">{t('stayover', lang)}</option>
                              <option value="vacant">{lang === 'es' ? 'Vacante' : 'Vacant'}</option>
                            </select>
                          </div>
                          <div>
                            <label className="label" style={{ fontSize:'10px' }}>{t('priority', lang)}</label>
                            <select value={row.priority} onChange={e => setFloorRows(rows => rows.map(r => r.id === row.id ? { ...r, priority: e.target.value as RoomPriority } : r))} className="input" style={{ fontSize:'13px' }}>
                              <option value="standard">{t('standard', lang)}</option>
                              <option value="vip">VIP</option>
                              <option value="early">{lang === 'es' ? 'Temprano' : 'Early'}</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button
                  onClick={() => {
                    const last = floorRows[floorRows.length - 1];
                    const lastEnd = parseInt(last?.end ?? '120');
                    const nextStart = isNaN(lastEnd) ? 201 : (Math.floor(lastEnd / 100) + 1) * 100 + 1;
                    setFloorRows(rows => [...rows, {
                      id: String(Date.now()),
                      start: String(nextStart),
                      end: String(nextStart + 19),
                      type: 'checkout', priority: 'standard',
                    }]);
                  }}
                  className="btn btn-secondary"
                  style={{ width:'100%' }}
                >
                  {lang === 'es' ? '+ Agregar Piso' : '+ Add Floor'}
                </button>

                {(() => {
                  const total = floorRows.reduce((sum, row) => {
                    const s = parseInt(row.start), e = parseInt(row.end);
                    return (!isNaN(s) && !isNaN(e) && e >= s) ? sum + (e - s + 1) : sum;
                  }, 0);
                  return total > 0 ? (
                    <p style={{ fontSize:'12px', color:'var(--text-muted)', textAlign:'center' }}>
                      {lang === 'es' ? 'Vista previa:' : 'Preview:'} <strong style={{ color:'var(--text-primary)' }}>{total}</strong> {lang === 'es' ? 'hab. en' : 'rooms across'} <strong style={{ color:'var(--text-primary)' }}>{floorRows.length}</strong> {lang === 'es' ? `piso${floorRows.length !== 1 ? 's' : ''}` : `floor${floorRows.length !== 1 ? 's' : ''}`}
                    </p>
                  ) : null;
                })()}

                <div style={{ display:'flex', gap:'10px', marginTop:'4px' }}>
                  <button onClick={() => { setShowBulkModal(false); setBulkMode('manual'); }} className="btn btn-secondary" style={{ flex:1 }}>
                    {t('cancel', lang)}
                  </button>
                  <button
                    onClick={handleFloorAdd}
                    disabled={floorRows.reduce((sum, row) => { const s = parseInt(row.start), e = parseInt(row.end); return (!isNaN(s) && !isNaN(e) && e >= s) ? sum + (e - s + 1) : sum; }, 0) === 0}
                    className="btn btn-primary"
                    style={{ flex:1 }}
                  >
                    {(() => { const n = floorRows.reduce((sum, row) => { const s = parseInt(row.start), e = parseInt(row.end); return (!isNaN(s) && !isNaN(e) && e >= s) ? sum + (e - s + 1) : sum; }, 0); return lang === 'es' ? `Agregar ${n} Habitaciones` : `Add ${n} Rooms`; })()}
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>

        {/* ── Inspect modal ── */}
        <Modal
          isOpen={!!inspectingRoom}
          onClose={() => setInspectingRoom(null)}
          title={`${t('inspectRoom', lang)} ${inspectingRoom?.number ?? ''}`}
        >
          <div style={{ display:'flex', flexDirection:'column', gap:'16px' }}>
            <div style={{
              display:'flex', alignItems:'center', gap:'10px',
              padding:'12px 14px', borderRadius:'var(--radius-md)',
              background:'rgba(139,92,246,0.08)', border:'1px solid rgba(139,92,246,0.25)',
            }}>
              <ShieldCheck size={18} color="#8B5CF6" style={{ flexShrink:0 }} />
              <span style={{ fontSize:'13px', color:'var(--text-secondary)', lineHeight:1.4 }}>
                {lang === 'es'
                  ? 'Confirma que esta habitación ha sido inspeccionada y está lista para el huésped.'
                  : 'Confirm this room has been inspected and is guest-ready.'}
              </span>
            </div>
            <div>
              <label className="label">
                {lang === 'es' ? 'Tu nombre (opcional)' : 'Your name (optional)'}
              </label>
              <input
                type="text"
                placeholder={lang === 'es' ? 'ej. Manager, Carlos...' : 'e.g. Manager, Sarah...'}
                value={inspectorName}
                onChange={e => setInspectorName(e.target.value)}
                className="input"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleInspect(); }}
              />
            </div>
            <div style={{ display:'flex', gap:'10px' }}>
              <button onClick={() => setInspectingRoom(null)} className="btn btn-secondary" style={{ flex:1 }}>
                {t('cancel', lang)}
              </button>
              <button
                onClick={handleInspect}
                className="btn btn-primary"
                style={{ flex:2, background:'#8B5CF6', borderColor:'#8B5CF6' }}
              >
                <ShieldCheck size={14} />
                {t('markInspected', lang)}
              </button>
            </div>
          </div>
        </Modal>

      </div>

      {/* ── Smart Assign Modal ── */}
      {showAssignModal && (
        <SmartAssignModal
          rooms={rooms.filter(r => r.status !== 'clean' && r.status !== 'inspected')}
          staff={staff}
          pendingAssignments={pendingAssignments}
          startTime={activeProperty?.morningBriefingTime ?? '08:00'}
          onClose={() => { setShowAssignModal(false); setPendingAssignments({}); }}
          onReassign={(roomId, newStaffId) =>
            setPendingAssignments(prev => ({ ...prev, [roomId]: newStaffId }))
          }
          onPublish={handlePublishAssignments}
          isPublishing={isPublishing}
          lang={lang}
        />
      )}

      {/* ── Toast ── */}
      {toast && (
        <div style={{
          position:'fixed', bottom:'80px', left:'50%', transform:'translateX(-50%)',
          background:'var(--green)', color:'#0A0A0A',
          padding:'10px 18px', borderRadius:'var(--radius-md)',
          fontSize:'13px', fontWeight:600, whiteSpace:'nowrap',
          boxShadow:'0 4px 16px rgba(0,0,0,0.3)',
          zIndex:9999, pointerEvents:'none',
          animation:'fadeUp 150ms var(--ease) both',
        }}>
          ✓ {toast}
        </div>
      )}
    </AppLayout>
  );
}

/* ── Room Card ── */
function RoomCard({
  room, onStatusChange, onDelete, onInspect, onTypeChange, onDndToggle, onPriorityChange,
  typeEditingRoomId, setTypeEditingRoomId, priorityEditingRoomId, setPriorityEditingRoomId, lang,
}: {
  room: Room;
  onStatusChange: (r: Room, s: RoomStatus) => void;
  onDelete: (id: string) => void;
  onInspect: () => void;
  onTypeChange: (newType: RoomType) => void;
  onDndToggle: () => void;
  onPriorityChange: (newPriority: RoomPriority) => void;
  typeEditingRoomId: string | null;
  setTypeEditingRoomId: (id: string | null) => void;
  priorityEditingRoomId: string | null;
  setPriorityEditingRoomId: (id: string | null) => void;
  lang: 'en' | 'es';
}) {
  const s = STATUS[room.status] ?? STATUS.dirty;
  const isTypeEditing = typeEditingRoomId === room.id;
  const isPriorityEditing = priorityEditingRoomId === room.id;
  const pb = room.type !== 'vacant' ? PRIORITY_BADGE[`${room.priority}_${room.type}`] : undefined;

  return (
    <div style={{
      background: s.bg,
      border: `1px solid ${s.border}`,
      borderLeft: room.isDnd ? `3px solid #F97316` : `4px solid ${s.stripe}`,
      borderRadius:'var(--radius-md)',
      padding:'14px',
      opacity: room.status === 'inspected' ? 0.65 : room.status === 'clean' ? 0.88 : 1,
      transition:'all 200ms cubic-bezier(0.2,0,0,1)',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>

        {/* Room number chip */}
        <div style={{
          minWidth:'54px', height:'54px', borderRadius:'12px', flexShrink:0,
          background: s.bg,
          border: `1.5px solid ${s.border}`,
          display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          <span style={{ fontFamily:'var(--font-mono)', fontWeight:700, fontSize:'20px', color:s.color }}>
            {room.number}
          </span>
        </div>

        {/* Info */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:'5px', flexWrap:'wrap', marginBottom:'5px' }}>
            {/* Type badge with inline selector */}
            <div style={{ position:'relative' }}>
              <button
                onClick={() => { setPriorityEditingRoomId(null); setTypeEditingRoomId(isTypeEditing ? null : room.id); }}
                className={`badge badge-${room.type}`}
                style={{ cursor:'pointer' }}
              >
                {room.type === 'checkout' && (lang === 'es' ? 'Salida' : 'Checkout')}
                {room.type === 'stayover' && (lang === 'es' ? 'Permanencia' : 'Stayover')}
                {room.type === 'vacant' && (lang === 'es' ? 'Vacante' : 'Vacant')}
              </button>
              {isTypeEditing && (
                <div style={{
                  position:'absolute', top:'100%', left:0, marginTop:'4px', zIndex:10,
                  display:'flex', gap:'4px', flexWrap:'nowrap',
                  background:'var(--bg-card)', border:'1px solid var(--border)',
                  borderRadius:'var(--radius-md)', padding:'6px',
                }}>
                  {(['checkout', 'stayover', 'vacant'] as RoomType[]).map(type => (
                    <button
                      key={type}
                      onClick={() => {
                        onTypeChange(type);
                        setTypeEditingRoomId(null);
                      }}
                      style={{
                        padding:'6px 10px', fontSize:'11px', fontWeight:600, borderRadius:'4px',
                        border: room.type === type ? '1.5px solid var(--amber)' : '1px solid var(--border)',
                        background: room.type === type ? 'rgba(217,119,6,0.1)' : 'transparent',
                        color: room.type === type ? 'var(--amber)' : 'var(--text-secondary)',
                        cursor:'pointer', transition:'all 150ms ease-out',
                      }}
                    >
                      {type === 'checkout' && (lang === 'es' ? 'Salida' : 'Checkout')}
                      {type === 'stayover' && (lang === 'es' ? 'Perm.' : 'Stay.')}
                      {type === 'vacant' && (lang === 'es' ? 'Vac.' : 'Vac.')}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {room.isDnd && <span style={{ fontSize:'10px', fontWeight:700, padding:'2px 7px', borderRadius:'6px', background:'rgba(249,115,22,0.12)', color:'#F97316', border:'1px solid rgba(249,115,22,0.3)' }}>DND</span>}
            {/* Priority badge — color-coded, clickable to change */}
            {room.type !== 'vacant' && pb && (
              <div style={{ position:'relative' }}>
                <button
                  onClick={() => { setTypeEditingRoomId(null); setPriorityEditingRoomId(isPriorityEditing ? null : room.id); }}
                  style={{
                    fontSize:'10px', fontWeight:700, padding:'2px 7px', borderRadius:'6px',
                    background: pb.bg, color: pb.color, border:`1px solid ${pb.border}`,
                    cursor:'pointer', transition:'all 150ms ease-out',
                  }}
                >
                  {lang === 'es' ? pb.labelEs : pb.label}
                </button>
                {isPriorityEditing && (
                  <div style={{
                    position:'absolute', top:'100%', left:0, marginTop:'4px', zIndex:20,
                    display:'flex', gap:'4px',
                    background:'var(--bg-card)', border:'1px solid var(--border)',
                    borderRadius:'var(--radius-md)', padding:'6px',
                    boxShadow:'0 4px 16px rgba(0,0,0,0.15)', whiteSpace:'nowrap',
                  }}>
                    {(['standard', 'vip', 'early'] as RoomPriority[]).map(p => {
                      const optBadge = PRIORITY_BADGE[`${p}_${room.type}`];
                      return (
                        <button
                          key={p}
                          onClick={() => onPriorityChange(p)}
                          style={{
                            padding:'5px 9px', fontSize:'11px', fontWeight:600, borderRadius:'4px',
                            border: room.priority === p ? `1.5px solid ${optBadge?.color ?? 'var(--border)'}` : '1px solid var(--border)',
                            background: room.priority === p ? (optBadge?.bg ?? 'transparent') : 'transparent',
                            color: room.priority === p ? (optBadge?.color ?? 'var(--text-secondary)') : 'var(--text-secondary)',
                            cursor:'pointer', transition:'all 150ms ease-out',
                          }}
                        >
                          {p === 'vip' ? '★ VIP' : p === 'early' ? (lang === 'es' ? '⚡ Temprana' : '⚡ Early') : (lang === 'es' ? 'Estándar' : 'Standard')}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {/* Status badge */}
            {room.status === 'dirty'       && <span className="badge badge-dirty">{t('dirty', lang)}</span>}
            {room.status === 'in_progress' && <span className="badge badge-progress">{t('inProgress', lang)}</span>}
            {room.status === 'clean'       && <span className="badge badge-clean">{lang === 'es' ? 'Lista ✓' : 'Ready ✓'}</span>}
            {room.status === 'inspected'   && (
              <span style={{
                fontSize:'10px', fontWeight:700, padding:'2px 7px', borderRadius:'6px',
                background:'rgba(139,92,246,0.12)', color:'#8B5CF6',
                border:'1px solid rgba(139,92,246,0.25)',
              }}>
                {t('inspected', lang)} ✓
              </span>
            )}
          </div>
          {room.assignedName && (
            <p style={{ fontSize:'12px', color:'var(--text-muted)', fontWeight:500 }}>
              {room.assignedName}
            </p>
          )}
          {/* Completion timestamp */}
          {room.completedAt && room.status !== 'inspected' && (
            <p style={{ fontSize:'11px', color:'var(--green)', marginTop:'2px', fontWeight:600 }}>
              ✓ {lang === 'es' ? 'Lista a las' : 'Done at'} {format(
                typeof (room.completedAt as any)?.toDate === 'function'
                  ? (room.completedAt as any).toDate()
                  : new Date(room.completedAt as any),
                'h:mm a'
              )}
            </p>
          )}
          {/* Inspection info */}
          {room.status === 'inspected' && room.inspectedAt && (
            <p style={{ fontSize:'11px', color:'#8B5CF6', marginTop:'2px', fontWeight:600 }}>
              ✓ {t('inspectedBy', lang)} {room.inspectedBy || 'Manager'} · {format(
                typeof (room.inspectedAt as any)?.toDate === 'function'
                  ? (room.inspectedAt as any).toDate()
                  : new Date(room.inspectedAt as any),
                'h:mm a'
              )}
            </p>
          )}
        </div>

        {/* Actions */}
        <div style={{ display:'flex', gap:'6px', flexShrink:0, alignItems:'center' }}>
          {/* DND toggle button */}
          <button
            onClick={onDndToggle}
            title={room.isDnd ? 'Remove DND' : 'Set DND'}
            style={{
              minHeight:'40px', width:'40px', padding:'0',
              background: room.isDnd ? 'rgba(249,115,22,0.12)' : 'transparent',
              border: room.isDnd ? '1px solid rgba(249,115,22,0.3)' : '1px solid var(--border)',
              borderRadius:'var(--radius-sm)',
              display:'flex', alignItems:'center', justifyContent:'center',
              cursor:'pointer', transition:'all 150ms ease-out',
            }}
          >
            <X size={16} color={room.isDnd ? '#F97316' : 'var(--text-secondary)'} />
          </button>

          {room.type === 'vacant' ? (
            <div style={{
              padding:'10px 12px', fontSize:'12px', fontWeight:600, color:'var(--text-muted)',
              borderRadius:'var(--radius-sm)',
            }}>
              {lang === 'es' ? 'Sin servicio' : 'No service'}
            </div>
          ) : room.status === 'dirty' ? (
            <button onClick={() => onStatusChange(room, 'in_progress')} className="btn btn-secondary btn-sm"
              style={{ minHeight:'40px', paddingLeft:'11px', paddingRight:'11px' }}>
              <Clock size={13} /> {t('start', lang)}
            </button>
          ) : room.status === 'in_progress' ? (
            <button onClick={() => onStatusChange(room, 'clean')} className="btn btn-green btn-sm"
              style={{ minHeight:'40px', paddingLeft:'11px', paddingRight:'11px' }}>
              <CheckCircle size={13} /> {t('done', lang)}
            </button>
          ) : room.status === 'clean' ? (
            <button
              onClick={onInspect}
              className="btn btn-sm"
              style={{
                minHeight:'40px', paddingLeft:'11px', paddingRight:'11px',
                background:'rgba(139,92,246,0.12)', border:'1px solid rgba(139,92,246,0.35)',
                color:'#8B5CF6', fontWeight:600,
              }}
            >
              <ShieldCheck size={13} /> {t('markInspected', lang)}
            </button>
          ) : room.status === 'inspected' ? (
            <div style={{
              width:'36px', height:'36px', borderRadius:'9px',
              background:'rgba(139,92,246,0.1)', border:'1px solid rgba(139,92,246,0.2)',
              display:'flex', alignItems:'center', justifyContent:'center',
            }}>
              <ShieldCheck size={15} color="#8B5CF6" />
            </div>
          ) : null}

          <button onClick={() => onDelete(room.id)} className="btn btn-danger btn-sm"
            style={{ minHeight:'40px', width:'40px', padding:'0' }}>
            <Trash2 size={13} />
          </button>
        </div>

      </div>
    </div>
  );
}

/* ── Smart Assign Modal ──────────────────────────────────────────────────── */

const PRIORITY_LABELS: Record<string, string> = {
  vip_checkout: '⭐ VIP Checkout',
  early_checkout: '⚡ Early Checkout',
  standard_checkout: 'Checkout',
  vip_stayover: '⭐ VIP Stayover',
  standard_stayover: 'Stayover',
  early_stayover: 'Stayover',
};

function getPriorityLabel(type: string, priority: string) {
  return PRIORITY_LABELS[`${priority}_${type}`] ?? type;
}

function getPriorityColor(type: string, priority: string): { bg: string; color: string; border: string } {
  if (priority === 'vip')   return { bg: 'rgba(139,92,246,0.1)', color: '#8B5CF6', border: 'rgba(139,92,246,0.3)' };
  if (priority === 'early') return { bg: 'rgba(251,191,36,0.1)', color: '#D97706', border: 'rgba(251,191,36,0.3)' };
  if (type === 'checkout')  return { bg: 'rgba(239,68,68,0.08)', color: '#EF4444', border: 'rgba(239,68,68,0.25)' };
  return { bg: 'rgba(99,102,241,0.08)', color: '#6366F1', border: 'rgba(99,102,241,0.25)' };
}

function SmartAssignModal({
  rooms, staff, pendingAssignments, startTime,
  onClose, onReassign, onPublish, isPublishing, lang,
}: {
  rooms: Room[];
  staff: StaffMember[];
  pendingAssignments: Record<string, string>;
  startTime: string;
  onClose: () => void;
  onReassign: (roomId: string, newStaffId: string) => void;
  onPublish: () => void;
  isPublishing: boolean;
  lang: 'en' | 'es';
}) {
  const scheduledStaff = staff.filter(s => s.scheduledToday);
  const roomSlots = rooms.map(r => ({ id: r.id, number: r.number, type: r.type, priority: r.priority }));

  const hkAssignments = buildHousekeeperAssignments(roomSlots, staff, pendingAssignments, startTime);

  // Rooms not assigned to anyone (shouldn't happen but handle gracefully)
  const unassignedRooms = rooms.filter(r => !pendingAssignments[r.id]);

  const totalRooms = Object.keys(pendingAssignments).length;

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 300,
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--bg)',
        borderRadius: '20px 20px 0 0',
        maxHeight: '92dvh',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 -4px 32px rgba(0,0,0,0.25)',
      }}>

        {/* Header */}
        <div style={{
          padding: '20px 20px 0',
          borderBottom: '1px solid var(--border)',
          paddingBottom: '16px',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <Zap size={18} color="var(--amber)" />
                <h2 style={{
                  fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px',
                  color: 'var(--text-primary)', letterSpacing: '-0.02em',
                }}>
                  {lang === 'es' ? 'Asignaciones IA' : 'Smart Assignments'}
                </h2>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>
                {totalRooms} {lang === 'es' ? 'habitaciones' : 'rooms'} · {hkAssignments.length} {lang === 'es' ? 'mucamas' : 'housekeepers'} · {lang === 'es' ? 'Optimizado por IA' : 'AI-optimized'} · {lang === 'es' ? 'Ajusta si es necesario' : 'Adjust if needed'}
              </p>
            </div>
            <button
              onClick={onClose}
              style={{
                width: '36px', height: '36px', borderRadius: '9px', flexShrink: 0,
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <X size={16} color="var(--text-secondary)" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

          {hkAssignments.map(hk => (
            <HkCard
              key={hk.staffId}
              hk={hk}
              allStaff={scheduledStaff}
              onReassign={onReassign}
              lang={lang}
            />
          ))}

          {unassignedRooms.length > 0 && (
            <div style={{
              padding: '14px', borderRadius: 'var(--radius-md)',
              background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
            }}>
              <p style={{ fontSize: '13px', fontWeight: 700, color: '#EF4444', marginBottom: '6px' }}>
                ⚠ {unassignedRooms.length} {lang === 'es' ? 'habitaciones sin asignar' : 'rooms unassigned'} — {lang === 'es' ? 'asigna mucamas al turno de hoy' : 'schedule housekeepers for today'}
              </p>
              {unassignedRooms.map(r => (
                <span key={r.id} style={{
                  display: 'inline-block', margin: '2px 4px 2px 0',
                  padding: '2px 8px', borderRadius: '6px',
                  background: 'rgba(239,68,68,0.1)', color: '#EF4444',
                  fontSize: '12px', fontWeight: 600,
                }}>
                  {r.number}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 16px calc(env(safe-area-inset-bottom, 0px) + 14px)',
          borderTop: '1px solid var(--border)',
          display: 'flex', gap: '10px',
          flexShrink: 0,
          background: 'var(--bg)',
        }}>
          <button onClick={onClose} className="btn btn-secondary" style={{ flex: 1 }}>
            {lang === 'es' ? 'Cancelar' : 'Cancel'}
          </button>
          <button
            onClick={onPublish}
            disabled={isPublishing || totalRooms === 0}
            className="btn btn-primary"
            style={{ flex: 2, gap: '6px', opacity: isPublishing ? 0.7 : 1 }}
          >
            {isPublishing ? (
              lang === 'es' ? 'Publicando…' : 'Publishing…'
            ) : (
              <>
                <Users size={15} />
                {lang === 'es' ? `Publicar ${totalRooms} asignaciones` : `Publish ${totalRooms} Assignments`}
                <ChevronRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Housekeeper assignment card ─────────────────────────────────────────── */

function HkCard({
  hk, allStaff, onReassign, lang,
}: {
  hk: HousekeeperAssignment;
  allStaff: StaffMember[];
  onReassign: (roomId: string, newStaffId: string) => void;
  lang: 'en' | 'es';
}) {
  const hoursAndMins = formatMinutes(hk.totalMinutes);

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      {/* HK header */}
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.03)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {/* Avatar */}
            <div style={{
              width: '36px', height: '36px', borderRadius: '10px', flexShrink: 0,
              background: 'var(--amber)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontWeight: 700, fontSize: '14px', color: '#0A0A0A' }}>
                {hk.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                <span style={{
                  fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {hk.name}
                </span>
                {hk.isSenior && (
                  <span style={{
                    fontSize: '10px', padding: '1px 6px', borderRadius: '4px',
                    background: 'rgba(251,191,36,0.15)', color: '#D97706',
                    fontWeight: 700, letterSpacing: '0.04em', flexShrink: 0,
                  }}>
                    ⭐ SR
                  </span>
                )}
              </div>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500, marginTop: '1px' }}>
                {hk.rooms.length} {lang === 'es' ? 'habitaciones' : 'rooms'} · {hoursAndMins} · {lang === 'es' ? 'Listo a las' : 'Done by'} <strong style={{ color: 'var(--text-secondary)' }}>{hk.estimatedDoneBy}</strong>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Room rows */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {hk.rooms.map((room, idx) => {
          const colors = getPriorityColor(room.type, room.priority);
          const label  = getPriorityLabel(room.type, room.priority);
          const mins   = getRoomMinutes(room);

          return (
            <div key={room.id} style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 14px',
              borderBottom: idx < hk.rooms.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              {/* Room number */}
              <span style={{
                fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '16px',
                color: 'var(--text-primary)', minWidth: '40px',
              }}>
                {room.number}
              </span>

              {/* Priority/type chip */}
              <span style={{
                fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '5px',
                background: colors.bg, color: colors.color, border: `1px solid ${colors.border}`,
                flexShrink: 0, letterSpacing: '0.03em',
              }}>
                {label}
              </span>

              {/* Minutes */}
              <span style={{
                fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600,
                marginLeft: 'auto', flexShrink: 0,
              }}>
                {mins}m
              </span>

              {/* Reassign select */}
              <select
                value={hk.staffId}
                onChange={e => onReassign(room.id, e.target.value)}
                style={{
                  fontSize: '11px', fontWeight: 600, padding: '4px 6px',
                  border: '1px solid var(--border)', borderRadius: '6px',
                  background: 'var(--bg)', color: 'var(--text-secondary)',
                  cursor: 'pointer', flexShrink: 0, maxWidth: '100px',
                }}
              >
                {allStaff.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name.split(' ')[0]}{s.isSenior ? ' ⭐' : ''}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
