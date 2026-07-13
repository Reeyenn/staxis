'use client';


export const dynamic = 'force-dynamic';

// Settings → Account & Team. Split by concern (pure file split, no logic
// change): admin account CRUD lives in _components/AdminAccountsCrud.tsx,
// team members in _components/TeamMembers.tsx, email invites in
// _components/Invites.tsx, join codes in _components/JoinCodes.tsx, and the
// shared modal/toast/styles in _components/shared.tsx. This file keeps the
// gate, the header, the hotel selector (deliberately its own <select>
// defaulting to the first hotel — NOT the app-wide active property), and the
// shared invite/code button row.

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppLayout } from '@/components/layout/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { Users, ChevronLeft, Mail, KeyRound } from 'lucide-react';
import { useCan } from '@/lib/capabilities/useCan';

import { AdminAccountsCrud } from './_components/AdminAccountsCrud';
import { TeamMembers } from './_components/TeamMembers';
import { useInvites } from './_components/Invites';
import { useJoinCodes } from './_components/JoinCodes';
import { labelStyle, inputStyle, teamBtnStyle } from './_components/shared';

export default function AccountsPage() {
  const { user } = useAuth();
  const { properties } = useProperty();
  const { lang } = useLang();
  const router = useRouter();
  const can = useCan();

  // Allow admin / owner / general_manager. Front-desk / housekeeping /
  // maintenance roles get bounced back to /settings.
  useEffect(() => {
    if (user && !can('manage_team')) router.replace('/settings');
  }, [user, can, router]);

  // Hotels this user can manage. Admin sees all properties; owner/GM only
  // see hotels in their property_access (which is what useProperty already
  // returns since PropertyContext filters by access).
  const manageableHotels = properties;
  const [teamHotelId, setTeamHotelId] = useState<string>('');
  useEffect(() => {
    if (!teamHotelId && manageableHotels.length > 0) setTeamHotelId(manageableHotels[0].id);
  }, [manageableHotels, teamHotelId]);

  const invites = useInvites(user, teamHotelId);
  const joinCodes = useJoinCodes(user, teamHotelId);

  if (!user || !can('manage_team')) return null;

  return (
    <AppLayout>
      <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Header */}
        <div className="animate-in">
          <button
            onClick={() => router.back()}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px',
              background: 'transparent', border: 'none',
              color: 'var(--text-muted)', fontSize: '13px',
              cursor: 'pointer', padding: '0 0 12px',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <ChevronLeft size={14} />
            {t('settings', lang)}
          </button>
          <h1 style={{
            fontFamily: 'var(--font-sans)', fontWeight: 700,
            fontSize: '16px', color: 'var(--text-primary)',
            letterSpacing: '-0.01em',
            display: 'flex', alignItems: 'center', gap: '6px',
          }}>
            <Users size={15} color="var(--navy)" />
            {lang === 'es' ? 'Cuenta y equipo' : 'Account & Team'}
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
            {lang === 'es' ? 'Tu perfil y cuentas del equipo.' : 'Your profile and team accounts.'}
          </p>
        </div>

        {/* Admin-only account CRUD (add button + all-accounts list + modal) */}
        <AdminAccountsCrud user={user} />

        {/* ─── Team management — visible to admin / owner / GM ───────────── */}
        <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {lang === 'es' ? 'Equipo' : 'Team'}
          </h2>

          {manageableHotels.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={labelStyle}>{lang === 'es' ? 'Hotel' : 'Hotel'}</label>
              <select value={teamHotelId} onChange={e => setTeamHotelId(e.target.value)} style={{ ...inputStyle, height: '42px' }}>
                {manageableHotels.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
              </select>
            </div>
          )}

          <TeamMembers user={user} hotelId={teamHotelId} />

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={invites.openModal} style={teamBtnStyle}>
              <Mail size={14} />
              {lang === 'es' ? 'Invitar por correo' : 'Invite by email'}
            </button>
            <button onClick={joinCodes.openModal} style={teamBtnStyle}>
              <KeyRound size={14} />
              {lang === 'es' ? 'Generar código' : 'Generate code'}
            </button>
          </div>

          {invites.list}
          {joinCodes.list}
        </div>

      </div>

      {invites.modal}
      {joinCodes.modal}
    </AppLayout>
  );
}
