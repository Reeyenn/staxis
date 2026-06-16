'use client';
// ═══════════════════════════════════════════════════════════════════════════
// Communications · Contacts — its own top-level sub-tab (was a Knowledge tab).
// The hotel's directory: vendors · emergency numbers · brand reps · LOCAL places
// (pharmacy, hospital, grocery, …) with address + hours. ALL STAFF read;
// MANAGERS add/edit (manage_knowledge capability). All data flows through
// /api/knowledge/contacts (service-role); this component never touches the
// browser DB client. Still AI-searchable via the bottom-right assistant
// (search_knowledge) — "what's the nearest pharmacy and their hours?".
//
// Shell mirrors LogbookPane (maxWidth container + serif italic title); the
// cards/editor keep the Knowledge "Snow" styling they moved in with (— snow-bg
// is #FFFFFF, identical to the comms T.bg they now sit on).
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import {
  Plus, Pencil, Trash2, Phone, Mail, MapPin, Clock, ChevronLeft, Loader2,
} from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/comms/client';
import type { KnowledgeContactDTO, ContactCategory, LocalCategory } from '@/lib/knowledge/types';
import { CONTACT_CATEGORIES, LOCAL_CATEGORIES, KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';
import type { L as LType } from './comms-types-fe';
import { T, SERIF, MonoLabel } from './comms-ui';

// ── Snow content styling (moved verbatim from KnowledgePane) ─────────────────
const SANS = 'var(--font-geist), -apple-system, BlinkMacSystemFont, sans-serif';
const card: React.CSSProperties = { border: '1px solid var(--snow-rule)', borderRadius: 12, background: 'var(--snow-bg)' };
const primaryBtn: React.CSSProperties = { background: 'var(--snow-sage-deep)', color: '#fff', border: 'none', borderRadius: 9, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 6 };
const ghostBtn: React.CSSProperties = { background: 'transparent', color: 'var(--snow-ink2)', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '7px 12px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: SANS, display: 'inline-flex', alignItems: 'center', gap: 5 };
const iconBtn: React.CSSProperties = { background: 'transparent', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--snow-ink2)' };
const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid var(--snow-rule)', borderRadius: 9, padding: '9px 11px', fontFamily: SANS, fontSize: 14, outline: 'none', background: 'var(--snow-bg)', color: 'var(--snow-ink)', boxSizing: 'border-box' };
const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 4, display: 'block' };
const subLabel: React.CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--snow-ink3)', marginBottom: 6 };

const CONTACT_CAT_LABEL: Record<ContactCategory, { en: string; es: string }> = {
  vendor: { en: 'Vendors', es: 'Proveedores' },
  emergency: { en: 'Emergency', es: 'Emergencia' },
  brand: { en: 'Brand', es: 'Marca' },
  local: { en: 'Local', es: 'Local' },
};

// Local sub-types (QUORE parity) — bilingual labels for the 14 LOCAL_CATEGORIES.
const LOCAL_CAT_LABEL: Record<LocalCategory, { en: string; es: string }> = {
  'Accommodations': { en: 'Accommodations', es: 'Alojamiento' },
  'Attractions': { en: 'Attractions', es: 'Atracciones' },
  'Bar/Nightlife': { en: 'Bar / Nightlife', es: 'Bar / Vida nocturna' },
  'Government Service': { en: 'Government Service', es: 'Servicio gubernamental' },
  'Grocery Store': { en: 'Grocery Store', es: 'Supermercado' },
  'Hospitals/Clinics': { en: 'Hospitals / Clinics', es: 'Hospitales / Clínicas' },
  'Mail/Shipping': { en: 'Mail / Shipping', es: 'Correo / Envíos' },
  'Movie Theaters': { en: 'Movie Theaters', es: 'Cines' },
  'Pharmacy': { en: 'Pharmacy', es: 'Farmacia' },
  'Place of Worship': { en: 'Place of Worship', es: 'Lugar de culto' },
  'Recreation': { en: 'Recreation', es: 'Recreación' },
  'Restaurants': { en: 'Restaurants', es: 'Restaurantes' },
  'Shopping': { en: 'Shopping', es: 'Compras' },
  'Travel': { en: 'Travel', es: 'Viajes' },
};
function localLabel(v: string | null, L: LType): string {
  if (!v) return L('Other local', 'Otros locales');
  const m = LOCAL_CAT_LABEL[v as LocalCategory];
  return m ? L(m.en, m.es) : v;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTACTS mode (self-fetching: list ⇄ editor)
// ═══════════════════════════════════════════════════════════════════════════
export function ContactsMode({ pid, isManager, L }: { pid: string; isManager: boolean; L: LType }) {
  const [items, setItems] = React.useState<KnowledgeContactDTO[] | null>(null);
  const [editing, setEditing] = React.useState<null | 'new' | KnowledgeContactDTO>(null);

  const load = React.useCallback(async () => {
    const r = await apiGet<{ contacts: KnowledgeContactDTO[] }>(`/api/knowledge/contacts?pid=${encodeURIComponent(pid)}`);
    if (r.ok && r.data) setItems(r.data.contacts);
    else setItems([]);
  }, [pid]);
  React.useEffect(() => { void load(); }, [load]);

  const remove = async (c: KnowledgeContactDTO) => {
    if (!window.confirm(L(`Delete "${c.name}"?`, `¿Eliminar "${c.name}"?`))) return;
    await apiDelete(`/api/knowledge/contacts?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(c.id)}`);
    await load();
  };

  // Group by category for display (null → "Other"); the 'local' group is then
  // sub-grouped by local_category to mirror QUORE's Local directory list.
  const groups: { key: string; label: string; rows: KnowledgeContactDTO[] }[] = [];
  const order: (ContactCategory | 'other')[] = [...CONTACT_CATEGORIES, 'other'];
  for (const cat of order) {
    const rows = (items ?? []).filter((c) => (c.category ?? 'other') === cat);
    if (rows.length === 0) continue;
    const label = cat === 'other' ? L('Other', 'Otros') : L(CONTACT_CAT_LABEL[cat as ContactCategory].en, CONTACT_CAT_LABEL[cat as ContactCategory].es);
    groups.push({ key: cat, label, rows });
  }
  const count = items?.length ?? 0;

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: T.bg }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 28px 60px', fontFamily: SANS, color: 'var(--snow-ink)' }}>
        {editing ? (
          <ContactEditor pid={pid} L={L} contact={editing === 'new' ? null : editing} onDone={async () => { setEditing(null); await load(); }} onCancel={() => setEditing(null)} />
        ) : (
          <>
            {/* Header — mirrors LogbookPane's serif title + count */}
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <div style={{ marginBottom: 7 }}><MonoLabel>{L(`${count} contacts`, `${count} contactos`)}</MonoLabel></div>
                <div style={{ fontFamily: SERIF, fontSize: 34, fontStyle: 'italic', lineHeight: 1, color: T.ink }}>{L('Contacts', 'Contactos')}</div>
              </div>
              {isManager && (
                <button onClick={() => setEditing('new')} style={{ ...primaryBtn, flexShrink: 0 }}><Plus size={15} /> {L('Add contact', 'Agregar')}</button>
              )}
            </div>

            <div style={{ marginTop: 22 }}>
              {items === null ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--snow-ink3)', fontSize: 13, padding: 20 }}><Loader2 size={15} className="comms-spin" /> {L('Loading…', 'Cargando…')}</div>
              ) : items.length === 0 ? (
                <div style={{ fontFamily: SANS, fontSize: 13.5, color: 'var(--snow-ink3)', padding: '28px 16px', textAlign: 'center', border: '1px dashed var(--snow-rule)', borderRadius: 12 }}>
                  {L('No contacts yet. Add vendors, emergency numbers, brand reps, and nearby places.', 'Aún no hay contactos. Agrega proveedores, números de emergencia, representantes de marca y lugares cercanos.')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {groups.map((g) => (
                    <div key={g.key}>
                      <div style={subLabel}>{g.label}</div>
                      {g.key === 'local'
                        ? localSubGroups(g.rows).map((sub) => (
                            <div key={sub.key} style={{ marginBottom: 12 }}>
                              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--snow-ink2)', marginBottom: 6, paddingLeft: 2 }}>{localLabel(sub.value, L)}</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {sub.rows.map((c) => <ContactCard key={c.id} c={c} isManager={isManager} L={L} onEdit={() => setEditing(c)} onRemove={() => remove(c)} />)}
                              </div>
                            </div>
                          ))
                        : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {g.rows.map((c) => <ContactCard key={c.id} c={c} isManager={isManager} L={L} onEdit={() => setEditing(c)} onRemove={() => remove(c)} />)}
                            </div>
                          )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Sub-group the Local contacts by local_category, in LOCAL_CATEGORIES order,
// with an "Other local" bucket last for rows that have no sub-type set.
function localSubGroups(rows: KnowledgeContactDTO[]): { key: string; value: string | null; rows: KnowledgeContactDTO[] }[] {
  const out: { key: string; value: string | null; rows: KnowledgeContactDTO[] }[] = [];
  for (const lc of LOCAL_CATEGORIES) {
    const sub = rows.filter((c) => c.localCategory === lc);
    if (sub.length) out.push({ key: lc, value: lc, rows: sub });
  }
  const other = rows.filter((c) => !c.localCategory || !LOCAL_CATEGORIES.includes(c.localCategory as LocalCategory));
  if (other.length) out.push({ key: '__other', value: null, rows: other });
  return out;
}

// ── One contact card ─────────────────────────────────────────────────────────
function ContactCard({ c, isManager, L, onEdit, onRemove }: {
  c: KnowledgeContactDTO; isManager: boolean; L: LType; onEdit: () => void; onRemove: () => void;
}) {
  // Map-link the address so "nearest pharmacy" is one tap to directions.
  const mapQuery = [c.address, c.cityStateZip].filter(Boolean).join(', ');
  return (
    <div style={{ ...card, padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {c.name}
          {c.company && <span style={{ fontWeight: 400, color: 'var(--snow-ink2)' }}> · {c.company}</span>}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 3 }}>
          {c.phone && <a href={`tel:${c.phone}`} style={{ fontSize: 13, color: 'var(--snow-sage-deep)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Phone size={12} /> {c.phone}</a>}
          {c.email && <a href={`mailto:${c.email}`} style={{ fontSize: 13, color: 'var(--snow-sage-deep)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Mail size={12} /> {c.email}</a>}
        </div>
        {(c.address || c.cityStateZip) && (
          <div style={{ fontSize: 12.5, color: 'var(--snow-ink2)', marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
            <MapPin size={12} style={{ flexShrink: 0, marginTop: 2, color: 'var(--snow-ink3)' }} />
            {mapQuery ? (
              <a href={`https://maps.google.com/?q=${encodeURIComponent(mapQuery)}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--snow-ink2)', textDecoration: 'none' }}>
                {[c.address, c.cityStateZip].filter(Boolean).join(', ')}
              </a>
            ) : null}
          </div>
        )}
        {c.hours && (
          <div style={{ fontSize: 12.5, color: 'var(--snow-ink2)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Clock size={12} style={{ flexShrink: 0, color: 'var(--snow-ink3)' }} /> {c.hours}
          </div>
        )}
        {c.notes && <div style={{ fontSize: 12.5, color: 'var(--snow-ink3)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{c.notes}</div>}
      </div>
      {isManager && (
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={onEdit} title={L('Edit', 'Editar')} style={iconBtn}><Pencil size={14} /></button>
          <button onClick={onRemove} title={L('Delete', 'Eliminar')} style={iconBtn}><Trash2 size={14} /></button>
        </div>
      )}
    </div>
  );
}

// ── New / edit contact ───────────────────────────────────────────────────────
function ContactEditor({ pid, contact, L, onDone, onCancel }: { pid: string; contact: KnowledgeContactDTO | null; L: LType; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = React.useState(contact?.name ?? '');
  const [company, setCompany] = React.useState(contact?.company ?? '');
  const [category, setCategory] = React.useState<ContactCategory | ''>(contact?.category ?? '');
  const [phone, setPhone] = React.useState(contact?.phone ?? '');
  const [email, setEmail] = React.useState(contact?.email ?? '');
  const [address, setAddress] = React.useState(contact?.address ?? '');
  const [cityStateZip, setCityStateZip] = React.useState(contact?.cityStateZip ?? '');
  const [hours, setHours] = React.useState(contact?.hours ?? '');
  const [localCategory, setLocalCategory] = React.useState(contact?.localCategory ?? '');
  const [notes, setNotes] = React.useState(contact?.notes ?? '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError(null);
    const payload = {
      pid,
      name: name.trim(),
      company: company.trim() || null,
      category: category || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      cityStateZip: cityStateZip.trim() || null,
      hours: hours.trim() || null,
      // Server also drops this unless category==='local'; mirror it here so the
      // payload is clean and a re-categorised contact loses its stale sub-type.
      localCategory: category === 'local' ? (localCategory || null) : null,
      notes: notes.trim() || null,
    };
    const r = contact
      ? await apiPatch('/api/knowledge/contacts', { ...payload, id: contact.id })
      : await apiPost('/api/knowledge/contacts', payload);
    setBusy(false);
    if (r.ok) onDone();
    else setError(r.error || L('Could not save. Try again.', 'No se pudo guardar. Inténtalo de nuevo.'));
  };

  return (
    <div>
      <button onClick={onCancel} style={{ ...ghostBtn, marginBottom: 14 }}><ChevronLeft size={14} /> {L('Cancel', 'Cancelar')}</button>
      <div style={{ ...card, padding: 18, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{contact ? L('Edit contact', 'Editar contacto') : L('New contact', 'Nuevo contacto')}</div>
        <div>
          <label style={labelStyle}>{L('Name', 'Nombre')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={KNOWLEDGE_LIMITS.CONTACT_NAME_MAX} style={inputStyle} autoFocus />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={labelStyle}>{L('Role / company', 'Rol / empresa')}</label>
            <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={KNOWLEDGE_LIMITS.COMPANY_MAX} placeholder={L('e.g. Plumber, ABC Supply', 'ej. Plomero, ABC')} style={inputStyle} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>{L('Category', 'Categoría')}</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as ContactCategory | '')} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">{L('— none —', '— ninguna —')}</option>
              {CONTACT_CATEGORIES.map((c) => <option key={c} value={c}>{L(CONTACT_CAT_LABEL[c].en, CONTACT_CAT_LABEL[c].es)}</option>)}
            </select>
          </div>
        </div>

        {/* Local sub-type — only relevant for the 'local' bucket. */}
        {category === 'local' && (
          <div>
            <label style={labelStyle}>{L('Local category', 'Categoría local')}</label>
            <select value={localCategory} onChange={(e) => setLocalCategory(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="">{L('— choose a type —', '— elige un tipo —')}</option>
              {LOCAL_CATEGORIES.map((lc) => <option key={lc} value={lc}>{L(LOCAL_CAT_LABEL[lc].en, LOCAL_CAT_LABEL[lc].es)}</option>)}
            </select>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>{L('Phone', 'Teléfono')}</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={KNOWLEDGE_LIMITS.PHONE_MAX} style={inputStyle} />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={labelStyle}>{L('Email', 'Correo')}</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={KNOWLEDGE_LIMITS.EMAIL_MAX} style={inputStyle} />
          </div>
        </div>

        <div>
          <label style={labelStyle}>{L('Address', 'Dirección')}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={KNOWLEDGE_LIMITS.ADDRESS_MAX} placeholder={L('e.g. 1200 Main St', 'ej. 1200 Calle Principal')} style={inputStyle} />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={labelStyle}>{L('City, state & ZIP', 'Ciudad, estado y CP')}</label>
            <input value={cityStateZip} onChange={(e) => setCityStateZip(e.target.value)} maxLength={KNOWLEDGE_LIMITS.ADDRESS_MAX} placeholder={L('e.g. Beaumont, TX 77701', 'ej. Beaumont, TX 77701')} style={inputStyle} />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={labelStyle}>{L('Hours', 'Horario')}</label>
            <input value={hours} onChange={(e) => setHours(e.target.value)} maxLength={KNOWLEDGE_LIMITS.HOURS_MAX} placeholder={L('e.g. Mon–Fri 8a–9p, Sat 9a–6p', 'ej. Lun–Vie 8a–9p, Sáb 9a–6p')} style={inputStyle} />
          </div>
        </div>

        <div>
          <label style={labelStyle}>{L('Notes (optional)', 'Notas (opcional)')}</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={KNOWLEDGE_LIMITS.NOTES_MAX} rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
        </div>
        {error && <div style={{ color: 'var(--snow-warm)', fontSize: 12.5 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={busy || !name.trim()} style={{ ...primaryBtn, opacity: busy || !name.trim() ? 0.5 : 1 }}>{busy ? <Loader2 size={14} className="comms-spin" /> : null} {L('Save', 'Guardar')}</button>
          <button onClick={onCancel} style={ghostBtn}>{L('Cancel', 'Cancelar')}</button>
        </div>
      </div>
    </div>
  );
}
