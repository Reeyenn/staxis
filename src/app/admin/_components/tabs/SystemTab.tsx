'use client';

/**
 * System tab — placeholder for Phase 1.
 *
 * Phase 7 fills this with: Marvel/Loki-style visual timeline (commits +
 * deploys + active worktrees), scheduled-jobs status, personal product
 * TODO/roadmap, and the audit log of admin actions.
 */

import React from 'react';

export function SystemTab() {
  return (
    <div style={{
      padding: '24px',
      background: 'var(--surface-secondary)',
      border: '1px dashed var(--border)',
      borderRadius: '10px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '6px' }}>
        System view coming in Phase 7
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5, maxWidth: '520px', margin: '0 auto' }}>
        The Marvel/Loki-style visual timeline — main branch as a glowing trunk,
        side-streams for active Claude worktrees, deploy markers for Vercel + Fly —
        plus scheduled-jobs status, personal roadmap, and admin audit log all
        live here.
      </p>
    </div>
  );
}
