'use client';

import React from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { t } from '@/lib/translations';
import { Users, MapPin, RefreshCw, Building2, Wifi, Upload, ChevronRight, Settings } from 'lucide-react';

const sections = [
  { href:'/settings/property',    icon:Building2, label:'Property',       desc:'Name, room count, wages, shift length'              },
  { href:'/settings/staff',       icon:Users,     label:'Staff',          desc:'Add/remove housekeepers, track hours'               },
  { href:'/settings/public-areas',icon:MapPin,    label:'Public Areas',   desc:'Areas, cleaning frequency, minutes per clean'       },
  { href:'/settings/laundry',     icon:RefreshCw, label:'Laundry',        desc:'Towels, sheets, comforters — loads per run'         },
  { href:'/settings/pms',         icon:Wifi,      label:'PMS Connection', desc:'Auto-sync data from your property management system'},
  { href:'/settings/import',      icon:Upload,    label:'Room Import',    desc:'Manually import occupancy from a PMS CSV export'    },
];

export default function SettingsPage() {
  const { lang }           = useLang();
  const { activeProperty } = useProperty();

  return (
    <AppLayout>
      <div style={{ padding:'20px 16px', display:'flex', flexDirection:'column', gap:'14px' }}>

        {/* ── Header ── */}
        <div className="animate-in">
          {activeProperty && (
            <p style={{ color:'var(--text-muted)', fontSize:'11px', fontWeight:500, letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:'4px' }}>
              {activeProperty.name}
            </p>
          )}
          <h1 style={{ fontFamily:'var(--font-sans)', fontWeight:700, fontSize:'26px', color:'var(--text-primary)', letterSpacing:'-0.02em', display:'flex', alignItems:'center', gap:'8px' }}>
            <Settings size={18} color="var(--amber)" />
            {t('settings', lang)}
          </h1>
        </div>

        {/* ── List of settings sections
              spec: list.md §standard density — row height 56px min
              spec: card.md §Interactive — hover translateY(-1px) shadow-2 ── */}
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
                {/* Icon container — spec: misc.md §Avatar — circular/rounded icon bg */}
                <div style={{
                  width:'48px', height:'48px', borderRadius:'13px', flexShrink:0,
                  background:'var(--amber-dim)',
                  border:'1px solid var(--amber-border)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <Icon size={21} color="var(--amber)" />
                </div>

                {/* Text */}
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

        {/* ── Footer ── */}
        <p style={{
          textAlign:'center', fontSize:'11px', color:'var(--text-muted)',
          fontWeight:500, letterSpacing:'0.06em', padding:'8px',
        }}>
          HotelOps <span style={{ color:'var(--amber)' }}>AI</span>
        </p>

      </div>
    </AppLayout>
  );
}
