'use client';

import { useState } from 'react';
import {
  ArrowRight,
  BedDouble,
  Check,
  CircleAlert,
  MessageSquareText,
  Package,
  Send,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { StaffShell } from '@/components/layout/StaffShell';
import { useLang } from '@/contexts/LanguageContext';
import styles from './shell-preview.module.css';

const METRICS = [
  { value: '82%', en: 'Occupancy', es: 'Ocupación', noteEn: '61 of 74 rooms', noteEs: '61 de 74 habitaciones' },
  { value: '13', en: 'Rooms remaining', es: 'Habitaciones pendientes', noteEn: '4 need inspection', noteEs: '4 necesitan inspección' },
  { value: '6', en: 'Open work orders', es: 'Órdenes abiertas', noteEn: '1 marked urgent', noteEs: '1 marcada urgente' },
  { value: '4', en: 'Low-stock items', es: 'Artículos bajos', noteEn: 'Reorder draft ready', noteEs: 'Pedido listo para revisar' },
];

const TASKS = [
  { icon: BedDouble, en: 'Four rooms are ready for inspection', es: 'Cuatro habitaciones están listas para inspección', metaEn: 'Housekeeping · now', metaEs: 'Limpieza · ahora', tone: 'sage' },
  { icon: Wrench, en: 'Ice machine work order is overdue', es: 'La orden de la máquina de hielo está atrasada', metaEn: 'Maintenance · 28 min', metaEs: 'Mantenimiento · 28 min', tone: 'warm' },
  { icon: Package, en: 'Laundry detergent is below par', es: 'El detergente está por debajo del nivel', metaEn: 'Inventory · reorder suggested', metaEs: 'Inventario · pedido sugerido', tone: 'gold' },
  { icon: MessageSquareText, en: 'Front desk posted a shift update', es: 'Recepción publicó una actualización', metaEn: 'Communications · 7 min', metaEs: 'Comunicación · 7 min', tone: 'blue' },
];

export default function StaffShellPreviewPage() {
  const { lang } = useLang();
  const spanish = lang === 'es';
  const [askOpen, setAskOpen] = useState(false);

  return (
    <StaffShell
      previewMode
      showReviewerSwitch
      fixedSurfaces={<PreviewAsk open={askOpen} setOpen={setAskOpen} spanish={spanish} />}
    >
      <div className={styles.previewPage}>
        <div className={styles.previewFlag}>
          <Sparkles size={14} />
          {spanish ? 'Vista de diseño · datos de ejemplo' : 'Design preview · sample data'}
        </div>

        <header className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>{spanish ? 'Viernes, 10 de julio' : 'Friday, July 10'}</p>
            <h1>{spanish ? 'Buenos días, Jordan.' : 'Good morning, Jordan.'}</h1>
            <p>{spanish ? 'El hotel está estable. Tres decisiones necesitan tu revisión.' : 'The hotel is steady. Three decisions need your review.'}</p>
          </div>
          <button type="button" className={styles.reviewButton}>
            <Sparkles size={17} />
            <span>{spanish ? 'Revisar 3 decisiones' : 'Review 3 decisions'}</span>
            <ArrowRight size={16} />
          </button>
        </header>

        <section className={styles.metrics} aria-label={spanish ? 'Resumen del hotel' : 'Hotel summary'}>
          {METRICS.map((metric) => (
            <article className={styles.metricCard} key={metric.en}>
              <strong>{metric.value}</strong>
              <span>{spanish ? metric.es : metric.en}</span>
              <small>{spanish ? metric.noteEs : metric.noteEn}</small>
            </article>
          ))}
        </section>

        <section className={styles.workspaceGrid}>
          <article className={styles.briefCard}>
            <header className={styles.cardHeader}>
              <div>
                <p className={styles.cardEyebrow}>{spanish ? 'Ahora' : 'Right now'}</p>
                <h2>{spanish ? 'Resumen de operaciones' : 'Operations brief'}</h2>
              </div>
              <span className={styles.livePill}><i /> {spanish ? 'En vivo' : 'Live'}</span>
            </header>
            <div className={styles.taskList}>
              {TASKS.map(({ icon: Icon, tone, ...task }) => (
                <button type="button" className={styles.taskRow} key={task.en}>
                  <span className={`${styles.taskIcon} ${styles[`tone_${tone}`]}`}><Icon size={18} /></span>
                  <span className={styles.taskCopy}>
                    <strong>{spanish ? task.es : task.en}</strong>
                    <small>{spanish ? task.metaEs : task.metaEn}</small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))}
            </div>
          </article>

          <aside className={styles.sideStack}>
            <article className={styles.staxisCard}>
              <div className={styles.staxisOrb}><Sparkles size={21} /></div>
              <p className={styles.cardEyebrow}>Staxis</p>
              <h2>{spanish ? 'Preparé el siguiente turno.' : 'I prepared the next shift.'}</h2>
              <p>{spanish ? 'Equilibré 41 habitaciones entre 7 personas y marqué dos conflictos para revisar.' : 'I balanced 41 rooms across 7 attendants and flagged two conflicts for review.'}</p>
              <div className={styles.decisionActions}>
                <button type="button" className={styles.secondaryAction}>{spanish ? 'Ajustar' : 'Adjust'}</button>
                <button type="button" className={styles.primaryAction}><Check size={15} /> {spanish ? 'Aprobar' : 'Approve'}</button>
              </div>
            </article>

            <article className={styles.progressCard}>
              <div className={styles.progressHeading}>
                <span><CircleAlert size={16} /> {spanish ? 'Habitaciones restantes' : 'Rooms remaining'}</span>
                <strong>13</strong>
              </div>
              <div className={styles.progressTrack}><span style={{ width: '72%' }} /></div>
              <div className={styles.progressLegend}>
                <span>{spanish ? '41 terminadas' : '41 complete'}</span>
                <span>{spanish ? '4 inspecciones' : '4 inspections'}</span>
              </div>
            </article>
          </aside>
        </section>
      </div>
    </StaffShell>
  );
}

function PreviewAsk({ open, setOpen, spanish }: { open: boolean; setOpen: (open: boolean) => void; spanish: boolean }) {
  return (
    <div className={styles.askPreview}>
      {open && (
        <div className={styles.askPanel} role="status">
          <span className={styles.askAvatar}><Sparkles size={15} /></span>
          <p>{spanish ? 'Todo se ve estable. ¿Qué quieres revisar?' : 'Everything looks steady. What would you like to review?'}</p>
        </div>
      )}
      <button type="button" className={styles.askBar} onClick={() => setOpen(!open)} aria-expanded={open}>
        <Sparkles size={16} />
        <span>{spanish ? 'Pregúntale a Staxis sobre el hotel…' : 'Ask Staxis anything about the hotel…'}</span>
        <span className={styles.askSend}><Send size={14} /></span>
      </button>
    </div>
  );
}
