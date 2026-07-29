'use client';

import React from 'react';
import { Building2, CalendarClock, Mail, ShieldCheck } from 'lucide-react';

export interface CompanyInvitationPreview {
  organizationName: string;
  invitedEmail: string;
  jobTitle: string | null;
  accessProfile: string;
  scopeType: 'organization' | 'portfolio' | 'property';
  scopeLabel: string;
  accessExpiresAt: string | null;
  invitationExpiresAt: string;
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string, lang: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

export function InvitationReviewCard({ preview, lang }: { preview: CompanyInvitationPreview; lang: string }) {
  const scopeKind = preview.scopeType === 'organization'
    ? 'Entire organization'
    : preview.scopeType === 'portfolio'
      ? 'Portfolio or region'
      : 'Hotel';
  const accessExpiration = preview.accessExpiresAt
    ? formatDate(preview.accessExpiresAt, lang)
    : 'No access expiration';

  const rows = [
    {
      icon: Mail,
      label: 'Invited email',
      value: preview.invitedEmail,
    },
    {
      icon: ShieldCheck,
      label: 'Access profile',
      value: titleCase(preview.accessProfile),
    },
    {
      icon: Building2,
      label: scopeKind,
      value: preview.scopeLabel,
    },
    {
      icon: CalendarClock,
      label: 'Access duration',
      value: accessExpiration,
    },
  ];

  return (
    <section
      aria-labelledby="company-invitation-review-title"
      style={{
        padding: '16px',
        borderRadius: 14,
        background: 'rgba(255,255,255,.58)',
        border: '1px solid rgba(31,35,28,.11)',
      }}
    >
      <p style={{ margin: '0 0 4px', color: '#8C6A33', fontSize: 10.5, fontWeight: 700, letterSpacing: '.09em', textTransform: 'uppercase' }}>
        {'Review before accepting'}
      </p>
      <h2 id="company-invitation-review-title" style={{ margin: '0 0 4px', color: '#1F231C', fontSize: 18 }}>
        {preview.organizationName}
      </h2>
      {preview.jobTitle ? (
        <p style={{ margin: '0 0 13px', color: '#5C625C', fontSize: 12.5 }}>
          {'Invited as'} {preview.jobTitle}
        </p>
      ) : null}
      <dl style={{ display: 'grid', gap: 10, margin: preview.jobTitle ? 0 : '13px 0 0' }}>
        {rows.map(({ icon: Icon, label, value }) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', columnGap: 8 }}>
            <Icon size={16} color="#4F7A61" aria-hidden="true" style={{ marginTop: 2 }} />
            <div>
              <dt style={{ color: '#777D75', fontSize: 10.5, fontWeight: 650, letterSpacing: '.04em', textTransform: 'uppercase' }}>{label}</dt>
              <dd style={{ margin: '2px 0 0', color: '#2C312B', fontSize: 13, overflowWrap: 'anywhere' }}>{value}</dd>
            </div>
          </div>
        ))}
      </dl>
      <p style={{ margin: '13px 0 0', paddingTop: 11, borderTop: '1px solid rgba(31,35,28,.08)', color: '#777D75', fontSize: 11.5, lineHeight: 1.45 }}>
        {'Invitation link expires'} {formatDate(preview.invitationExpiresAt, lang)}.
      </p>
    </section>
  );
}
