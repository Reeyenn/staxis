'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { subscribeToRooms, updateRoom } from '@/lib/firestore';
import { todayStr } from '@/lib/utils';
import type { Room } from '@/types';
import { Ban } from 'lucide-react';

export default function FrontDeskPage() {
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const { lang } = useLang();
  const router = useRouter();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<Room | null>(null);
  const [processing, setProcessing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
  }, [user, activePropertyId]);

  if (authLoading || propLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-4 rounded-full mb-3 mx-auto" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--navy)' }} />
            <div className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
              {lang === 'es' ? 'Cargando habitaciones...' : 'Loading rooms...'}
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  const roomsByFloor = groupRoomsByFloor(rooms);

  const handleEarlyCheckout = async () => {
    if (!selectedRoom || !user || !activePropertyId) return;
    setProcessing(true);
    try {
      await updateRoom(user.uid, activePropertyId, selectedRoom.id, {
        type: 'checkout'
      });
      setSelectedRoom(null);
      setToast(lang === 'es'
        ? `Habitación ${selectedRoom.number} marcada como Salida Anticipada`
        : `Room ${selectedRoom.number} marked as Early Checkout`);
      setTimeout(() => setToast(null), 2500);
    } catch (error) {
      console.error('Error marking early checkout:', error);
      setToast(lang === 'es' ? 'Error al procesar' : 'Error processing request');
      setTimeout(() => setToast(null), 2500);
    } finally {
      setProcessing(false);
    }
  };

  const handleExtension = async () => {
    if (!selectedRoom || !user || !activePropertyId) return;
    setProcessing(true);
    try {
      await updateRoom(user.uid, activePropertyId, selectedRoom.id, {
        type: 'stayover'
      });
      setSelectedRoom(null);
      setToast(lang === 'es'
        ? `Habitación ${selectedRoom.number} marcada como Extensión`
        : `Room ${selectedRoom.number} marked as Extension`);
      setTimeout(() => setToast(null), 2500);
    } catch (error) {
      console.error('Error marking extension:', error);
      setToast(lang === 'es' ? 'Error al procesar' : 'Error processing request');
      setTimeout(() => setToast(null), 2500);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen" style={{ backgroundColor: 'var(--bg)' }}>
        {/* Header */}
        <div style={{ padding: '20px 24px 0' }}>
          <h1 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '22px', color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1, margin: 0 }}>
            {lang === 'es' ? 'Recepción' : 'Front Desk'}
          </h1>
        </div>

        {/* Rooms by Floor */}
        <div className="p-4 space-y-6">
          {Object.entries(roomsByFloor).map(([floor, floorRooms]) => (
            <div key={floor}>
              <h2
                className="text-sm font-semibold mb-3 px-2 uppercase tracking-wider"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('floor', lang)} {floor}
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {floorRooms.map(room => (
                  <RoomCard
                    key={room.id}
                    room={room}
                    onSelect={() => setSelectedRoom(room)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Success Toast */}
        {toast && (
          <div
            className="fixed top-20 left-1/2 z-50 px-5 py-3 rounded-lg shadow-lg font-semibold text-sm"
            style={{
              transform: 'translateX(-50%)',
              backgroundColor: 'var(--green)',
              color: 'white',
              animation: 'fadeIn 0.2s ease-out',
            }}
          >
            {toast}
          </div>
        )}

        {/* Bottom Sheet - Room Details Popup */}
        {selectedRoom && (
          <RoomDetailSheet
            room={selectedRoom}
            onClose={() => setSelectedRoom(null)}
            onEarlyCheckout={handleEarlyCheckout}
            onExtension={handleExtension}
            processing={processing}
            lang={lang}
          />
        )}
      </div>
    </AppLayout>
  );
}

interface RoomCardProps {
  room: Room;
  onSelect: () => void;
}

function RoomCard({ room, onSelect }: RoomCardProps) {
  const { lang } = useLang();
  const statusColor = getStatusColor(room.status);

  return (
    <button
      onClick={onSelect}
      className="transition-all active:scale-95"
      style={{
        position: 'relative',
        padding: '10px 8px',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${statusColor}`,
        backgroundColor: 'var(--bg-card)',
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
      }}
    >
      {room.isDnd && (
        <div style={{ position: 'absolute', top: '4px', right: '4px', color: 'var(--amber)', lineHeight: 0 }}>
          <Ban size={12} />
        </div>
      )}
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1 }}>
        {room.number}
      </div>
      <div
        style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: statusColor }}
      >
        {getStatusLabel(room.status, lang)}
      </div>
    </button>
  );
}

interface RoomDetailSheetProps {
  room: Room;
  onClose: () => void;
  onEarlyCheckout: () => Promise<void>;
  onExtension: () => Promise<void>;
  processing: boolean;
  lang: string;
}

function RoomDetailSheet({
  room,
  onClose,
  onEarlyCheckout,
  onExtension,
  processing,
  lang
}: RoomDetailSheetProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black bg-opacity-40 transition-opacity"
        onClick={onClose}
        style={{ animation: 'fadeIn 0.2s ease-out' }}
      />

      {/* Sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl overflow-y-auto"
        style={{
          backgroundColor: 'var(--bg-card)',
          borderColor: 'var(--border)',
          animation: 'slideUp 0.3s ease-out',
          padding: '14px 18px 18px',
          maxHeight: '70vh',
        }}
      >
        {/* Close indicator */}
        <div className="flex justify-center mb-3">
          <div className="w-10 h-1 rounded-full" style={{ backgroundColor: 'var(--border)' }} />
        </div>

        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '12px' }}>
          <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', margin: 0, lineHeight: 1 }}>
            {room.number}
          </h2>
          <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: getStatusColor(room.status) }}>
            {getStatusLabel(room.status, lang)}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {room.type === 'checkout' ? (lang === 'es' ? 'Salida' : 'Checkout') : room.type === 'stayover' ? (lang === 'es' ? 'Continuación' : 'Stayover') : (lang === 'es' ? 'Vacía' : 'Vacant')}
          </span>
        </div>

        {/* Meta line */}
        {(room.assignedName || room.isDnd) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            {room.assignedName && (
              <span>{lang === 'es' ? 'Asignada' : 'Assigned'}: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{room.assignedName}</span></span>
            )}
            {room.isDnd && (
              <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{lang === 'es' ? 'No Molestar' : 'Do Not Disturb'}</span>
            )}
          </div>
        )}

        {/* Action Button */}
        {room.type === 'stayover' && (
          <button
            onClick={onEarlyCheckout}
            disabled={processing}
            className="w-full rounded-lg font-semibold transition-colors disabled:opacity-50"
            style={{
              padding: '12px',
              backgroundColor: 'var(--amber)',
              color: 'white',
              fontSize: '14px',
            }}
          >
            {processing ? (lang === 'es' ? 'Procesando...' : 'Processing...') : (lang === 'es' ? 'Marcar Salida Anticipada' : 'Mark Early Checkout')}
          </button>
        )}

        {room.type === 'checkout' && (
          <button
            onClick={onExtension}
            disabled={processing}
            className="w-full rounded-lg font-semibold transition-colors disabled:opacity-50"
            style={{
              padding: '12px',
              backgroundColor: 'var(--navy)',
              color: 'white',
              fontSize: '14px',
            }}
          >
            {processing ? (lang === 'es' ? 'Procesando...' : 'Processing...') : (lang === 'es' ? 'Marcar Extensión' : 'Mark Extension')}
          </button>
        )}

        <style jsx>{`
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes slideUp {
            from {
              transform: translateY(100%);
              opacity: 0;
            }
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }
        `}</style>
      </div>
    </>
  );
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'clean':
    case 'inspected':
      return 'var(--green)';
    case 'in_progress':
      return 'var(--amber)';
    case 'dirty':
      return 'var(--red)';
    default:
      return 'var(--text-muted)';
  }
}

function getStatusLabel(status: string, lang: string = 'en'): string {
  if (lang === 'es') {
    switch (status) {
      case 'dirty': return 'Sucia';
      case 'in_progress': return 'Limpiando';
      case 'clean': return 'Limpia';
      case 'inspected': return 'Inspeccionada';
      default: return status;
    }
  }
  switch (status) {
    case 'dirty': return 'Dirty';
    case 'in_progress': return 'Cleaning';
    case 'clean': return 'Clean';
    case 'inspected': return 'Inspected';
    default: return status;
  }
}

function groupRoomsByFloor(rooms: Room[]): Record<string, Room[]> {
  const grouped: Record<string, Room[]> = {};
  rooms.forEach(room => {
    const floor = room.number.charAt(0) || '1';
    if (!grouped[floor]) grouped[floor] = [];
    grouped[floor].push(room);
  });
  return Object.fromEntries(
    Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))
  );
}
