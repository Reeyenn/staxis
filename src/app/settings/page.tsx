'use client';


export const dynamic = 'force-dynamic';
import React from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { t } from '@/lib/translations';
import { Wifi, Users, Volume2, Clock, ChevronRight, Bell, UserCog, ScrollText, BarChart3, DollarSign } from 'lucide-react';
import { canManageTeam } from '@/lib/roles';

export default function SettingsPage() {
  const { lang }           = useLang();
  const { user }           = useAuth();

  // Account & Team is the hub for profile + team management. Visible to
  // admin/owner/GM (anyone who can manage a team). Other roles see only the
  // PMS-connection card today.
  const sections = [
    { href:'/settings/pms', icon:Wifi, label:t('pmsConnection', lang), desc: lang === 'es' ? 'Sincronización automática con tu sistema de gestión hotelera' : 'Auto-sync data from your property management system' },
    {
      href:'/settings/voice',
      icon: Volume2,
      label: lang === 'es' ? 'Voz' : 'Voice',
      desc: lang === 'es' ? 'Activa o desactiva las respuestas habladas de Staxis' : 'Tune how Staxis listens and speaks',
    },
    ...(user && canManageTeam(user.role)
      ? [
          {
            href:'/settings/reports',
            icon:BarChart3,
            label: lang === 'es' ? 'Reportes' : 'Reports',
            desc: lang === 'es' ? 'Genera, exporta y programa reportes cuando los necesites' : 'Run, export, and schedule reports on demand',
          },
          {
            href:'/settings/accounts',
            icon:Users,
            label: lang === 'es' ? 'Cuenta y equipo' : 'Account & Team',
            desc: lang === 'es' ? 'Tu perfil, contraseña y cuentas del equipo' : 'Your profile, password, and team accounts',
          },
          {
            href:'/settings/users',
            icon:UserCog,
            label: lang === 'es' ? 'Usuarios y roles' : 'Users & Roles',
            desc: lang === 'es' ? 'Cambia roles, desactiva cuentas, transfiere propietario' : 'Change roles, deactivate accounts, transfer ownership',
          },
          {
            href:'/settings/notifications',
            icon:Bell,
            label: lang === 'es' ? 'Notificaciones' : 'Notifications',
            desc: lang === 'es' ? 'Cuándo y cómo recibir el reporte diario y semanal' : 'When and how to receive the daily and weekly report',
          },
          {
            href:'/settings/shifts',
            icon:Clock,
            label: lang === 'es' ? 'Turnos' : 'Shifts',
            desc: lang === 'es' ? 'Plantillas de turnos por departamento (8a–4p, 7a–3p, etc.)' : 'Shift presets by department (8a–4p, 7a–3p, etc.)',
          },
          {
            href:'/settings/wages',
            icon:DollarSign,
            label: lang === 'es' ? 'Salarios' : 'Wages',
            desc: lang === 'es' ? 'Salario por hora por rol y por persona — alimenta el % de costo laboral' : 'Hourly wage by role and per person — powers the labor cost % tile',
          },
          {
            href:'/settings/activity-log',
            icon:ScrollText,
            label: lang === 'es' ? 'Registro de actividad' : 'Activity Log',
            desc: lang === 'es'
              ? 'Cada limpieza, inspección, ausencia y cambio en una sola lista buscable y exportable.'
              : 'Every cleaning, inspection, callout, and change in one searchable, exportable timeline.',
          },
        ]
      : []),
  ];

  return (
    <AppLayout>
      <div style={{ padding:'20px 16px', display:'flex', flexDirection:'column', gap:'14px' }}>

        {/* ── Header ── */}
        <div className="animate-in">
          <h1 style={{ fontFamily:'var(--font-sans)', fontWeight:700, fontSize:'17px', color:'var(--text-primary)', letterSpacing:'-0.01em' }}>
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
                }}
              >
                <div style={{
                  width:'48px', height:'48px', borderRadius:'13px', flexShrink:0,
                  background:'rgba(27,58,92,0.06)',
                  border:'1px solid rgba(27,58,92,0.12)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <Icon size={21} color="var(--navy)" />
                </div>

                <div style={{ flex:1, minWidth:0 }}>
                  <p style={{
                    fontWeight:700, fontSize:'16px',
                    color:'var(--text-primary)', marginBottom:'3px', lineHeight:1.2,
                  }}>
                    {label}
                  </p>
                  <p style={{ fontSize:'13px', color:'var(--text-muted)', lineHeight:1.4 }}>{desc}</p>
                </div>

                <ChevronRight size={18} color="var(--text-muted)" style={{ flexShrink:0 }} />
              </div>
            </Link>
          ))}
        </div>

      </div>
    </AppLayout>
  );
}
