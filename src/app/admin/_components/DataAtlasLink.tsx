'use client';

import Link from 'next/link';
import { Database } from 'lucide-react';

import styles from './AIControlCenter.module.css';

/**
 * The Hotels-page doorway to the founder's read-only backend view.
 * It deliberately reuses the Access / AI Control Center trigger so all
 * administration tools keep one visual and responsive contract.
 */
export function DataAtlasLink() {
  return (
    <Link
      href="/admin/data-atlas"
      className={styles.trigger}
      aria-label="Open Database Atlas"
      title="Open Database Atlas"
    >
      <Database className={styles.triggerIcon} size={15} aria-hidden="true" />
      <span className={styles.triggerText}>Database Atlas</span>
    </Link>
  );
}
