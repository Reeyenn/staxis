'use client';


export const dynamic = 'force-dynamic';
import React from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { useAuth } from '@/contexts/AuthContext';
import { t } from '@/lib/translations';
import { ChevronRight, UserCog, ScrollText, BarChart3 } from 'lucide-react';
import { useCan } from '@/lib/capabilities/useCan';
import type { CapabilityKey } from '@/lib/capabilities/registry';
import { T, fonts } from '@/app/staff/_components/_tokens';

export default function SettingsPage() {
  const { lang }           = useLang();
  const { user }           = useAuth();
  const can                = useCan();

  // Each card is gated by its own capability (default: every role gets it; an
  // admin can switch a role OFF per hotel from the Access tab). `capsAny` means
  // "show if the viewer has ANY of these" — Reports folds in report delivery
  // (formerly the Notifications tile), so it shows for either capability.
  const allSections: { href: string; icon: typeof BarChart3; label: string; desc: string; cap?: CapabilityKey; capsAny?: CapabilityKey[] }[] = [
    { href:'/settings/reports', icon:BarChart3, label: lang === 'es' ? 'Reportes' : 'Reports', desc: lang === 'es' ? 'Genera y exporta reportes, y define cuándo se envía el reporte diario y semanal' : 'Run and export reports, and set when the daily & weekly report is sent', capsAny:['run_reports','manage_notifications'] },
    { href:'/settings/users', icon:UserCog, label: lang === 'es' ? 'Usuarios y roles' : 'Users & Roles', desc: lang === 'es' ? 'Cambia roles, desactiva cuentas, transfiere propietario' : 'Change roles, deactivate accounts, transfer ownership', cap:'manage_users' },
    { href:'/settings/activity-log', icon:ScrollText, label: lang === 'es' ? 'Registro de actividad' : 'Activity Log', desc: lang === 'es' ? 'Cada limpieza, inspección, ausencia y cambio en una sola lista buscable y exportable.' : 'Every cleaning, inspection, callout, and change in one searchable, exportable timeline.', cap:'view_activity_log' },
  ];
  const sections = allSections.filter((s) => {
    if (!user) return !s.cap && !s.capsAny;
    if (s.capsAny) return s.capsAny.some((c) => can(c));
    if (s.cap) return can(s.cap);
    return true;
  });

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
