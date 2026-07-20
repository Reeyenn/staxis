'use client';


export const dynamic = 'force-dynamic';
import React from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { t } from '@/lib/translations';
import { Wifi, Clock, ChevronRight, Bell, UserCog, ScrollText, BarChart3, Timer, DollarSign, ListChecks } from 'lucide-react';
import { useCan } from '@/lib/capabilities/useCan';
import type { CapabilityKey } from '@/lib/capabilities/registry';
import { T, fonts } from '@/app/staff/_components/_tokens';

export default function SettingsPage() {
  const { lang }           = useLang();
  const { user }           = useAuth();
  const can                = useCan();

  // Each card is gated by its own capability (default: every role gets it; an
  // admin can switch a role OFF per hotel from the Access tab). Voice is a
  // personal preference and stays visible to everyone.
  const allSections: { href: string; icon: typeof Wifi; label: string; desc: string; cap?: CapabilityKey }[] = [
    { href:'/settings/pms', icon:Wifi, label:t('pmsConnection', lang), desc: lang === 'es' ? 'Sincronización automática con tu sistema de gestión hotelera' : 'Auto-sync data from your property management system', cap:'manage_settings' },
    { href:'/settings/reports', icon:BarChart3, label: lang === 'es' ? 'Reportes' : 'Reports', desc: lang === 'es' ? 'Genera, exporta y programa reportes cuando los necesites' : 'Run, export, and schedule reports on demand', cap:'run_reports' },
    { href:'/settings/checklists', icon:ListChecks, label: t('checklistsTitle', lang), desc: t('checklistsCardDesc', lang), cap:'manage_checklists' },
    { href:'/settings/users', icon:UserCog, label: lang === 'es' ? 'Usuarios y roles' : 'Users & Roles', desc: lang === 'es' ? 'Cambia roles, desactiva cuentas, transfiere propietario' : 'Change roles, deactivate accounts, transfer ownership', cap:'manage_users' },
    { href:'/settings/notifications', icon:Bell, label: lang === 'es' ? 'Notificaciones' : 'Notifications', desc: lang === 'es' ? 'Cuándo y cómo recibir el reporte diario y semanal' : 'When and how to receive the daily and weekly report', cap:'manage_notifications' },
    { href:'/settings/shifts', icon:Clock, label: lang === 'es' ? 'Turnos' : 'Shifts', desc: lang === 'es' ? 'Plantillas de turnos por departamento (8a–4p, 7a–3p, etc.)' : 'Shift presets by department (8a–4p, 7a–3p, etc.)', cap:'manage_shifts' },
    { href:'/settings/clean-times', icon:Timer, label: lang === 'es' ? 'Tiempos de limpieza' : 'Clean Times', desc: lang === 'es' ? 'Minutos estándar por tipo de limpieza — impulsan el balanceo de carga' : 'Standard minutes per cleaning type — drive workload balancing', cap:'manage_clean_times' },
    { href:'/settings/wages', icon:DollarSign, label: lang === 'es' ? 'Salarios' : 'Wages', desc: lang === 'es' ? 'Salario por hora por rol y por persona — alimenta el % de costo laboral' : 'Hourly wage by role and per person — powers the labor cost % tile', cap:'view_wages' },
    { href:'/settings/activity-log', icon:ScrollText, label: lang === 'es' ? 'Registro de actividad' : 'Activity Log', desc: lang === 'es' ? 'Cada limpieza, inspección, ausencia y cambio en una sola lista buscable y exportable.' : 'Every cleaning, inspection, callout, and change in one searchable, exportable timeline.', cap:'view_activity_log' },
  ];
  const sections = allSections.filter((s) => !s.cap || (!!user && can(s.cap)));

  return (
    <AppLayout>
      <div style={{ padding:'20px 16px', display:'flex', flexDirection:'column', gap:'14px', fontFamily:fonts.sans }}>

        {/* ── Header ── */}
        <div className="animate-in">
          <h1 style={{ fontFamily:fonts.sans, fontWeight:600, fontSize:'18px', color:T.ink, letterSpacing:'-0.02em' }}>
            {t('settings', lang)}
          </h1>
        </div>

        <div className="animate-in stagger-1" style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
          {sections.map(({ href, icon: Icon, label, desc }, idx) => (
            <Link key={href} href={href} style={{ textDecoration:'none' }}>
              <div
                className="card card-interactive"
                style={{
                  padding:'16px 18px',
                  display:'flex', alignItems:'center', gap:'16px',
                  animationDelay:`${idx * 40}ms`,
                  background:T.paper, border:`1px solid ${T.rule}`,
                  borderRadius:16, boxShadow:T.cardShadow,
                }}
              >
                <div style={{
                  width:'48px', height:'48px', borderRadius:'14px', flexShrink:0,
                  background:T.sageDim,
                  border:'1px solid rgba(92,122,96,0.25)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <Icon size={21} color={T.brand} />
                </div>

                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{
                    fontFamily:fonts.sans, fontWeight:600, fontSize:'15px', letterSpacing:'-0.01em',
                    color:T.ink, marginBottom:'3px', lineHeight:1.2,
                  }}>
                    {label}
                  </p>
                  <p style={{ fontSize:'13px', color:T.ink2, lineHeight:1.4 }}>{desc}</p>
                </div>

                <ChevronRight size={18} color={T.ink3} style={{ flexShrink:0 }} />
              </div>
            </Link>
          ))}
        </div>

      </div>
    </AppLayout>
  );
}
