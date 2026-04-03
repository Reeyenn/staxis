'use client';

import React from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useAuth } from '@/contexts/AuthContext';
import { t } from '@/lib/translations';
import { Building2, Wifi, Users, ChevronRight, Settings, Wrench } from 'lucide-react';

export default function SettingsPage() {
  const { lang }           = useLang();
  const { activeProperty } = useProperty();
  const { user }           = useAuth();

  const sections = [
    { href:'/settings/property', icon:Building2, label:'Property',         desc:'Name, room count, wages, shift length'              },
    { href:'/settings/operations', icon:Wrench, label:'Operations Config', desc:'Public areas, cleaning times, prep time'            },
    { href:'/settings/pms',      icon:Wifi,      label:'PMS Connection',  desc:'Auto-sync data from your property management system'},
    { href:'/staff',             icon:Users,     label:'Staff Directory', desc:'View and manage all hotel staff by department'      },
    ...(user?.role === 'admin'
      ? [{ href:'/settings/accounts', icon:Users, label:'Accounts', desc:'Manage user logins and property access' }]
      : []),
  ];

  return (
    <AppLayout>
      <div style={{ padding:'20px 16px', display:'flex', flexDirection:'column', gap:'14px' }}>

        {/* ── Header ── */}
        <div className="animate-in">
          <h1 style={{ fontFamily:'var(--font-sans)', fontWeight:700, fontSize:'24px', color:'var(--text-primary)', letterSpacing:'-0.02em' }}>
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
