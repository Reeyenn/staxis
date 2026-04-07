'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  subscribeToShiftConfirmations,
  subscribeToManagerNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '@/lib/firestore';
import type { StaffMember, ShiftConfirmation, ManagerNotification, ConfirmationStatus } from '@/types';
import { Calendar, ChevronLeft, ChevronRight, Bell, CheckCircle2, XCircle, Clock, AlertTriangle, Users, Send, Zap } from 'lucide-react';

// ── helpers ──────────────────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.toLocaleDateString('en-CA');
}

function formatDisplayDate(dateStr: string, lang: 'en' | 'es'): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

function isEligible(s: StaffMember, date: string): boolean {
  if (s.isActive === false) return false;
  if (!s.phone) return false;
  if (s.vacationDates?.includes(date)) return false;
  const maxDays = s.maxDaysPerWeek ?? 5;
  const maxHrs  = s.maxWeeklyHours ?? 40;
  if ((s.daysWorkedThisWeek ?? 0) >= maxDays) return false;
  if ((s.weeklyHours ?? 0) >= maxHrs) return false;
  return true;
}

function autoSelect(staff: StaffMember[], date: string, alreadyInPool: Set<string>): StaffMember[] {
  return staff
    .filter(s => isEligible(s, date) && !alreadyInPool.has(s.id))
    .sort((a, b) => {
      // Sort by days worked asc (fairness), senior first within same tier
      const aDays = a.daysWorkedThisWeek ?? 0;
      const bDays = b.daysWorkedThisWeek ?? 0;
      if (aDays !== bDays) return aDays - bDays;
      if (a.isSenior !== b.isSenior) return a.isSenior ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

const STATUS_COLOR: Record<ConfirmationStatus, string> = {
  pending:     'var(--amber)',
  confirmed:   'var(--green)',
  declined:    'var(--red)',
  no_response: 'var(--text-muted)',
};

const STATUS_ICON: Record<ConfirmationStatus, React.ReactNode> = {
  pending:     <Clock size={13} />,
  confirmed:   <CheckCircle2 size={13} />,
  declined:    <XCircle size={13} />,
  no_response: <AlertTriangle size={13} />,
};

// ── component ─────────────────────────────────────────────────────────────────

export default function SchedulingPage() {
  const { user } = useAuth();
  const { activePropertyId, staff, staffLoaded, refreshStaff } = useProperty();
  const { lang } = useLang();

  const tomorrow = addDays(todayStr(), 1);
  const [shiftDate, setShiftDate] = useState(tomorrow);
  const [selected, setSelected] = useState<StaffMember[]>([]);
  const [confirmations, setConfirmations] = useState<ShiftConfirmation[]>([]);
  const [notifications, setNotifications] = useState<ManagerNotification[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  // If staff is empty after the property is known, force a fresh load.
  // This guards against the case where PropertyContext loaded before auth
  // resolved and the initial getStaff call was skipped.
  useEffect(() => {
    if (uid && pid && staff.length === 0) {
      refreshStaff();
    }
  }, [uid, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to confirmations for the selected date
  useEffect(() => {
    if (!uid || !pid) return;
    setSent(false);
    return subscribeToShiftConfirmations(uid, pid, shiftDate, setConfirmations);
  }, [uid, pid, shiftDate]);

  // Subscribe to manager notifications
  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToManagerNotifications(uid, pid, setNotifications);
  }, [uid, pid]);

  const unreadCount = notifications.filter(n => !n.read).length;

  // Staff already in the confirmation pool for this date (not declined)
  const alreadyInPool = useMemo(() => {
    return new Set(
      confirmations
        .filter(c => c.status !== 'declined')
        .map(c => c.staffId)
    );
  }, [confirmations]);

  // All eligible staff for this date (not yet in pool)
  const eligiblePool = useMemo(() => autoSelect(staff, shiftDate, alreadyInPool), [staff, shiftDate, alreadyInPool]);

  const handleAutoSelect = useCallback(() => {
    setSelected(eligiblePool);
  }, [eligiblePool]);

  const toggleSelected = (member: StaffMember) => {
    setSelected(prev =>
      prev.some(s => s.id === member.id)
        ? prev.filter(s => s.id !== member.id)
        : [...prev, member]
    );
  };

  const handleSend = async () => {
    if (!uid || !pid || selected.length === 0 || sending) return;
    setSending(true);
    try {
      const baseUrl = window.location.origin;
      const staffPayload = selected
        .filter(s => s.phone)
        .map(s => ({
          staffId: s.id,
          name: s.name,
          phone: s.phone!,
          language: s.language,
        }));

      const res = await fetch('/api/send-shift-confirmations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      if (!res.ok) throw new Error('Failed to send confirmations');
      setSent(true);
      setSelected([]);
    } catch (error) {
      console.error('Error sending shift confirmations:', error);
      alert(lang === 'es'
        ? 'Error al enviar confirmaciones. Verifica tu conexión e intenta de nuevo.'
        : 'Error sending confirmations. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  };

  const handleMarkAllRead = async () => {
    if (!uid || !pid) return;
    await markAllNotificationsRead(uid, pid);
  };

  const handleNotifClick = async (n: ManagerNotification) => {
    if (!n.read && uid && pid) {
      await markNotificationRead(uid, pid, n.id);
    }
  };

  // All active staff for the weekly hours tracker
  const activeStaff = useMemo(() =>
    staff
      .filter(s => s.isActive !== false)
      .sort((a, b) => (b.weeklyHours ?? 0) - (a.weeklyHours ?? 0)),
    [staff]
  );

  return (
    <AppLayout>
      <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h1 style={{
            fontFamily: 'var(--font-sans)',
            fontWeight: 700,
            fontSize: '24px',
            letterSpacing: '-0.02em',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            margin: 0,
          }}>
            <Calendar size={20} color="var(--navy)" />
            {t('schedulingTitle', lang)}
          </h1>

          {/* Notification bell */}
          <button
            onClick={() => setShowNotifPanel(v => !v)}
            style={{
              position: 'relative',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px',
              color: unreadCount > 0 ? 'var(--amber)' : 'var(--text-muted)',
            }}
          >
            <Bell size={20} strokeWidth={unreadCount > 0 ? 2.2 : 1.6} />
            {unreadCount > 0 && (
              <span style={{
                position: 'absolute',
                top: '2px',
                right: '2px',
                width: '16px',
                height: '16px',
                background: 'var(--red)',
                color: '#fff',
                borderRadius: '50%',
                fontSize: '9px',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
        </div>

        {/* Notification panel */}
        {showNotifPanel && (
          <div className="card animate-in" style={{ padding: '16px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('notificationsTitle', lang)}
              </span>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--amber)', fontWeight: 600, padding: 0 }}
                >
                  {t('markAllRead', lang)}
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noNotifications', lang)}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {notifications.slice(0, 10).map(n => (
                  <div
                    key={n.id}
                    onClick={() => handleNotifClick(n)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '10px',
                      padding: '10px 12px',
                      background: n.read ? 'transparent' : 'rgba(251,191,36,0.05)',
                      border: `1px solid ${n.read ? 'var(--border)' : 'rgba(251,191,36,0.2)'}`,
                      borderRadius: 'var(--radius-md)',
                      cursor: n.read ? 'default' : 'pointer',
                    }}
                  >
                    <span style={{ marginTop: '1px', flexShrink: 0, color: n.type === 'decline' || n.type === 'no_replacement' ? 'var(--red)' : n.type === 'all_confirmed' ? 'var(--green)' : 'var(--amber)' }}>
                      {n.type === 'all_confirmed' ? <CheckCircle2 size={14} /> :
                       n.type === 'decline' ? <XCircle size={14} /> :
                       n.type === 'no_replacement' ? <AlertTriangle size={14} /> :
                       <Users size={14} />}
                    </span>
                    <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                      {n.message}
                    </p>
                    {!n.read && (
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--amber)', flexShrink: 0, marginTop: '4px' }} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Date selector */}
        <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
          <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '10px' }}>
            {t('selectShiftDate', lang)}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              onClick={() => { setShiftDate(d => addDays(d, -1)); setSent(false); setSelected([]); }}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              <ChevronLeft size={16} />
            </button>
            <span style={{ flex: 1, textAlign: 'center', fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {formatDisplayDate(shiftDate, lang)}
            </span>
            <button
              onClick={() => { setShiftDate(d => addDays(d, 1)); setSent(false); setSelected([]); }}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* Sent banner */}
        {sent && (
          <div className="animate-in" style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '12px 16px',
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.25)',
            borderRadius: 'var(--radius-md)',
            marginBottom: '16px',
          }}>
            <CheckCircle2 size={16} color="var(--green)" />
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--green)' }}>
              {t('confirmationsSent', lang)}
            </span>
          </div>
        )}

        {/* Existing confirmations for this date */}
        {confirmations.length > 0 && (
          <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
            <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '12px' }}>
              {t('crewForDate', lang)} {formatDisplayDate(shiftDate, lang)}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {confirmations.map(conf => (
                <div key={conf.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 12px',
                  background: 'rgba(0,0,0,0.02)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)',
                }}>
                  <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary)' }}>
                    {conf.staffName}
                  </span>
                  <span style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    fontSize: '11px',
                    fontWeight: 600,
                    color: STATUS_COLOR[conf.status],
                  }}>
                    {STATUS_ICON[conf.status]}
                    {t(
                      conf.status === 'pending'     ? 'statusPending'     :
                      conf.status === 'confirmed'   ? 'statusConfirmed'   :
                      conf.status === 'declined'    ? 'statusDeclined'    :
                                                      'statusNoResponse',
                      lang
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Auto-select crew */}
        <div className="card" style={{ padding: '16px', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', margin: 0 }}>
              {t('autoSelectCrew', lang)}
              {selected.length > 0 && (
                <span style={{ marginLeft: '8px', color: 'var(--amber)' }}>
                  - {selected.length} {t('crewSelectedCount', lang)}
                </span>
              )}
            </p>
            <button
              onClick={handleAutoSelect}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: 'rgba(251,191,36,0.1)',
                border: '1px solid rgba(251,191,36,0.3)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--amber)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <Zap size={12} />
              {t('autoSelectCrew', lang)}
            </button>
          </div>

          {!staffLoaded ? (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              {lang === 'es' ? 'Cargando…' : 'Loading…'}
            </p>
          ) : staff.filter(s => s.isActive !== false).length === 0 ? (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              {t('noEligibleStaff', lang)}
            </p>
          ) : (
            <>
            {eligiblePool.length === 0 && alreadyInPool.size === 0 && (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
                {t('noEligibleStaff', lang)}
              </p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px' }}>
              {staff
                .filter(s => s.isActive !== false)
                .sort((a, b) => {
                  const aIn = alreadyInPool.has(a.id);
                  const bIn = alreadyInPool.has(b.id);
                  if (aIn !== bIn) return aIn ? -1 : 1;
                  const aSel = selected.some(x => x.id === a.id);
                  const bSel = selected.some(x => x.id === b.id);
                  if (aSel !== bSel) return aSel ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .map(member => {
                  const inPool    = alreadyInPool.has(member.id);
                  const isSelected = selected.some(s => s.id === member.id);
                  const eligible  = isEligible(member, shiftDate) && !inPool;
                  const onVacation = member.vacationDates?.includes(shiftDate);
                  const isAtLimit = !eligible && !inPool && !onVacation && member.isActive !== false && !!member.phone &&
                    ((member.daysWorkedThisWeek ?? 0) >= (member.maxDaysPerWeek ?? 5) ||
                     (member.weeklyHours ?? 0) >= (member.maxWeeklyHours ?? 40));

                  return (
                    <div
                      key={member.id}
                      onClick={() => eligible && toggleSelected(member)}
                      style={{
                        padding: '10px 12px',
                        border: `1px solid ${
                          inPool    ? 'rgba(34,197,94,0.3)'    :
                          isSelected ? 'rgba(251,191,36,0.5)' :
                          eligible  ? 'var(--border)'          :
                                      'rgba(0,0,0,0.04)'
                        }`,
                        background: inPool
                          ? 'rgba(34,197,94,0.05)'
                          : isSelected
                          ? 'rgba(251,191,36,0.07)'
                          : 'rgba(0,0,0,0.02)',
                        borderRadius: 'var(--radius-md)',
                        cursor: eligible ? 'pointer' : 'default',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        opacity: (!eligible && !inPool) ? 0.45 : 1,
                        transition: 'all 0.15s',
                      }}
                    >
                      {/* Checkbox / status indicator */}
                      <div style={{
                        width: '18px',
                        height: '18px',
                        borderRadius: '5px',
                        border: `2px solid ${inPool ? 'var(--green)' : isSelected ? 'var(--amber)' : 'var(--border)'}`,
                        background: inPool
                          ? 'rgba(34,197,94,0.2)'
                          : isSelected
                          ? 'rgba(251,191,36,0.2)'
                          : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}>
                        {(inPool || isSelected) && (
                          <CheckCircle2
                            size={11}
                            color={inPool ? 'var(--green)' : 'var(--amber)'}
                            strokeWidth={2.5}
                          />
                        )}
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', margin: '0 0 2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {member.name}
                        </p>
                        <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
                          {inPool      ? t('crewForDate', lang) :
                           onVacation  ? t('onVacation', lang) :
                           !member.phone ? t('noPhoneLabel', lang) :
                           isAtLimit   ? t('atLimitLabel', lang) :
                           eligible    ? `${member.daysWorkedThisWeek ?? 0} ${t('daysWorkedLabel', lang)}` :
                                         t('inactiveLabel', lang)}
                        </p>
                      </div>

                      {member.isSenior && (
                        <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--amber)', background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: '4px', padding: '1px 5px' }}>
                          SR
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
            </>
          )}

          {/* Send button */}
          {selected.length > 0 && (
            <button
              onClick={handleSend}
              disabled={sending}
              className="animate-in"
              style={{
                marginTop: '16px',
                width: '100%',
                padding: '14px',
                background: sending ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)',
                color: sending ? 'rgba(255,255,255,0.5)' : '#FFFFFF',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                fontWeight: 700,
                fontSize: '14px',
                cursor: sending ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-sans)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              <Send size={14} />
              {sending ? t('sendingLabel', lang) : `${t('sendConfirmations', lang)} (${selected.length})`}
            </button>
          )}
        </div>

        {/* Weekly hours tracker */}
        <div className="card" style={{ padding: '16px' }}>
          <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '14px' }}>
            {t('weeklyHoursTracker', lang)}
          </p>
          {!staffLoaded ? (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              {lang === 'es' ? 'Cargando…' : 'Loading…'}
            </p>
          ) : activeStaff.length === 0 ? (
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('noStaffYet', lang)}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {activeStaff.map(member => {
                const maxHrs = member.maxWeeklyHours ?? 40;
                const hrs    = member.weeklyHours ?? 0;
                const pct    = Math.min((hrs / maxHrs) * 100, 100);
                const atLimit = hrs >= maxHrs;
                const nearLimit = hrs >= maxHrs - 4;

                return (
                  <div key={member.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-primary)' }}>
                        {member.name}
                        {member.vacationDates?.includes(shiftDate) && (
                          <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--blue)', fontWeight: 600 }}>
                            {t('onVacation', lang)}
                          </span>
                        )}
                      </span>
                      <span style={{
                        fontSize: '11px',
                        fontFamily: 'var(--font-mono)',
                        color: atLimit ? 'var(--red)' : nearLimit ? 'var(--amber)' : 'var(--text-muted)',
                      }}>
                        {hrs}h / {maxHrs}h
                      </span>
                    </div>
                    <div style={{ height: '3px', background: 'rgba(0,0,0,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: atLimit ? 'var(--red)' : nearLimit ? 'var(--amber)' : 'var(--green)',
                        borderRadius: '2px',
                        transition: 'width 0.3s',
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </AppLayout>
  );
}
