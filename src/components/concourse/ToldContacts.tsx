'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The hotel's contact directory, on the Knows tab's told half.
//
// Ported from communications/_components/ContactsPane.tsx. The DATA and the
// ROUTE are unchanged (/api/knowledge/contacts); what changed is the surface
// it sits on — concourse classes instead of the Snow/comms style modules —
// and two deliberate differences:
//
//   1. EMERGENCY SORTS FIRST (CONTACT_GROUP_ORDER in told-knowledge.ts). It
//      used to render in declaration order, below the vendors.
//   2. Phone numbers are dialled through telHref, which strips the formatting
//      punctuation the old card interpolated straight into the href.
//
// EVERY SIGNED-IN PERSON READS THIS. It is not manager-gated and must not
// become so — the front desk is the shift most likely to need it, and this is
// where they got it in Communications. Only add/edit/delete is manager-only,
// and the server enforces that independently (manage_knowledge).
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import type { KnowledgeContactDTO, ContactCategory } from '@/lib/knowledge/types';
import { CONTACT_CATEGORIES, LOCAL_CATEGORIES, KNOWLEDGE_LIMITS } from '@/lib/knowledge/types';
import { toldPost, toldPatch, toldDelete } from './told-api';
import {
  CONTACT_CAT_LABEL, LOCAL_CAT_LABEL, addressLine, groupContacts, mailtoHref,
  mapHref, say, telHref, type Bilingual, type Lang,
} from './told-knowledge';

const S = {
  title: { en: 'Contacts', },
  sub: {
    en: 'Vendors, emergency numbers, brand reps, and nearby places.',

  },
  add: { en: 'Add contact', },
  edit: { en: 'Edit', },
  remove: { en: 'Delete', },
  save: { en: 'Save', },
  cancel: { en: 'Cancel', },
  loading: { en: 'Loading…', },
  empty: {
    en: 'No contacts yet. Add vendors, emergency numbers, brand reps, and nearby places.',

  },
  emptyStaff: {
    en: 'No contacts have been added yet. Ask your manager to add them.',

  },
  // An error must never read as "this hotel has no emergency numbers".
  loadFailed: {
    en: 'The contact list could not load. Do not read this as "there are no contacts". Check your connection and try again.',

  },
  refreshFailed: {
    en: 'The contact list could not refresh. Showing the last results.',

  },
  retry: { en: 'Try again', },
  deleteFailed: { en: 'The contact was not deleted. Try again.', },
  saveFailed: { en: 'Could not save. Try again.', },
  confirmDelete: { en: 'Delete this contact?', },
  dismiss: { en: 'Dismiss', },
  newContact: { en: 'New contact', },
  editContact: { en: 'Edit contact', },
  fName: { en: 'Name', },
  fCompany: { en: 'Role / company', },
  fCompanyPh: { en: 'e.g. Plumber, ABC Supply', },
  fCategory: { en: 'Category', },
  fNone: { en: '(none)', },
  fLocalCat: { en: 'Local category', },
  fLocalPick: { en: '(choose a type)', },
  fPhone: { en: 'Phone', },
  fEmail: { en: 'Email', },
  fAddress: { en: 'Address', },
  fAddressPh: { en: 'e.g. 1200 Main St', },
  fCity: { en: 'City, state & ZIP', },
  fCityPh: { en: 'e.g. Beaumont, TX 77701', },
  fHours: { en: 'Hours', },
  fHoursPh: { en: 'e.g. Mon–Fri 8a–9p, Sat 9a–6p', },
  fNotes: { en: 'Notes (optional)', },
  call: { en: 'Call', },
  directions: { en: 'Directions', },
} as const satisfies Record<string, Bilingual>;

export function ToldContacts({ pid, canEdit, lang }: { pid: string; canEdit: boolean; lang: Lang }) {
  const L = (k: keyof typeof S) => say(S[k], lang);

  const [editing, setEditing] = React.useState<null | 'new' | KnowledgeContactDTO>(null);
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  const { data, loading, error: loadError, reload } = useApiResource<{ contacts: KnowledgeContactDTO[] }>(
    `/api/knowledge/contacts?pid=${encodeURIComponent(pid)}`,
    { keepDataOnError: true },
  );
  const items = data?.contacts ?? null;

  const remove = async (c: KnowledgeContactDTO) => {
    if (!window.confirm(`${L('confirmDelete')}\n\n${c.name}`)) return;
    setMutationError(null);
    const r = await toldDelete(
      `/api/knowledge/contacts?pid=${encodeURIComponent(pid)}&id=${encodeURIComponent(c.id)}`,
    );
    if (r.error !== undefined) { setMutationError(L('deleteFailed')); return; }
    await reload();
  };

  if (editing) {
    return (
      <ContactEditor
        pid={pid}
        lang={lang}
        contact={editing === 'new' ? null : editing}
        onDone={async () => { setEditing(null); await reload(); }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const groups = groupContacts(items ?? []);

  return (
    <div>
      <div className="td-head">
        <div>
          <div className="td-h2">{L('title')}</div>
          <div className="td-sub">{L('sub')}</div>
        </div>
        {canEdit && (
          <button type="button" className="td-act td-yes" onClick={() => setEditing('new')}>
            {L('add')}
          </button>
        )}
      </div>

      {mutationError && (
        <div className="td-note td-bad" role="alert">
          <span>{mutationError}</span>
          <button type="button" className="td-act" onClick={() => setMutationError(null)}>{L('dismiss')}</button>
        </div>
      )}
      {loadError && (
        <div className="td-note td-bad" role="alert">
          <span>{data ? L('refreshFailed') : L('loadFailed')}</span>
          <button type="button" className="td-act" onClick={() => void reload()}>{L('retry')}</button>
        </div>
      )}

      {loading && !data ? (
        <div className="td-muted">{L('loading')}</div>
      ) : items && items.length === 0 ? (
        <div className="td-empty">{canEdit ? L('empty') : L('emptyStaff')}</div>
      ) : items ? (
        <div className="td-groups">
          {groups.map((g) => (
            <div key={g.key} className={`td-grp${g.urgent ? ' td-urgent' : ''}`}>
              <div className="td-grpl">{say(g.label, lang)}</div>
              {g.subGroups
                ? g.subGroups.map((sub) => (
                    <div key={sub.key} className="td-sub-grp">
                      <div className="td-subl">{say(sub.label, lang)}</div>
                      <div className="td-cards">
                        {sub.rows.map((c) => (
                          <ContactCard key={c.id} c={c} canEdit={canEdit} lang={lang}
                            onEdit={() => setEditing(c)} onRemove={() => void remove(c)} />
                        ))}
                      </div>
                    </div>
                  ))
                : (
                    <div className="td-cards">
                      {g.rows.map((c) => (
                        <ContactCard key={c.id} c={c} canEdit={canEdit} lang={lang}
                          onEdit={() => setEditing(c)} onRemove={() => void remove(c)} />
                      ))}
                    </div>
                  )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── One card ────────────────────────────────────────────────────────────────

function ContactCard({ c, canEdit, lang, onEdit, onRemove }: {
  c: KnowledgeContactDTO; canEdit: boolean; lang: Lang; onEdit: () => void; onRemove: () => void;
}) {
  const L = (k: keyof typeof S) => say(S[k], lang);
  const tel = telHref(c.phone);
  const mail = mailtoHref(c.email);
  const map = mapHref(c.address, c.cityStateZip);
  const line = addressLine(c.address, c.cityStateZip);

  return (
    <div className="td-card">
      <div className="td-cardmain">
        <div className="td-cname">
          {c.name}
          {c.company && <span className="td-ccomp"> · {c.company}</span>}
        </div>

        {/* The tap targets. 44px min via .td-tap — this is the one thing on the
            screen somebody uses one-handed while looking at a guest. */}
        {(tel || mail) && (
          <div className="td-taps">
            {/* The number leads the accessible name so it CONTAINS the visible
                text — a voice-control user saying the number they can see has
                to match (WCAG 2.5.3). "Call <name>" alone did not. */}
            {tel && <a className="td-tap td-call" href={tel} aria-label={`${c.phone}, ${L('call')} ${c.name}`}>{c.phone}</a>}
            {mail && <a className="td-tap" href={mail}>{c.email}</a>}
          </div>
        )}

        {line && (
          <div className="td-cmeta">
            {map ? (
              <a className="td-tap td-quiet" href={map} target="_blank" rel="noopener noreferrer"
                 aria-label={`${L('directions')}, ${line}`}>{line}</a>
            ) : line}
          </div>
        )}
        {c.hours && <div className="td-cmeta">{c.hours}</div>}
        {c.notes && <div className="td-cnotes">{c.notes}</div>}
      </div>

      {canEdit && (
        <div className="td-cardacts">
          <button type="button" className="td-act" onClick={onEdit}>{L('edit')}</button>
          <button type="button" className="td-act td-danger" onClick={onRemove}>{L('remove')}</button>
        </div>
      )}
    </div>
  );
}

// ── New / edit ──────────────────────────────────────────────────────────────

function ContactEditor({ pid, contact, lang, onDone, onCancel }: {
  pid: string; contact: KnowledgeContactDTO | null; lang: Lang; onDone: () => void; onCancel: () => void;
}) {
  const L = (k: keyof typeof S) => say(S[k], lang);
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
    try {
      await doSave();
    } finally {
      // toldPost/toldPatch rethrow SessionEndedError (the /signin redirect is
      // already firing). Without the finally the button stayed disabled
      // forever if anything threw — the old comms client swallowed everything,
      // so this hazard is new with the envelope helpers.
      setBusy(false);
    }
  };

  const doSave = async () => {
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
      // The server drops this unless category==='local'; mirrored here so a
      // re-categorised contact loses its stale sub-type.
      localCategory: category === 'local' ? (localCategory || null) : null,
      notes: notes.trim() || null,
    };
    const r = contact
      ? await toldPatch('/api/knowledge/contacts', { ...payload, id: contact.id })
      : await toldPost('/api/knowledge/contacts', payload);
    if (r.error === undefined) onDone();
    else setError(r.error || L('saveFailed'));
  };

  return (
    <div>
      <button type="button" className="td-act" onClick={onCancel}>{L('cancel')}</button>
      <div className="td-panel">
        <div className="td-h2">{contact ? L('editContact') : L('newContact')}</div>

        <label className="td-lab" htmlFor="td-c-name">{L('fName')}</label>
        <input id="td-c-name" className="td-in" value={name} autoFocus
          maxLength={KNOWLEDGE_LIMITS.CONTACT_NAME_MAX} onChange={(e) => setName(e.target.value)} />

        <div className="td-row">
          <div className="td-col">
            <label className="td-lab" htmlFor="td-c-comp">{L('fCompany')}</label>
            <input id="td-c-comp" className="td-in" value={company} placeholder={L('fCompanyPh')}
              maxLength={KNOWLEDGE_LIMITS.COMPANY_MAX} onChange={(e) => setCompany(e.target.value)} />
          </div>
          <div className="td-col">
            <label className="td-lab" htmlFor="td-c-cat">{L('fCategory')}</label>
            <select id="td-c-cat" className="td-in" value={category}
              onChange={(e) => setCategory(e.target.value as ContactCategory | '')}>
              <option value="">{L('fNone')}</option>
              {CONTACT_CATEGORIES.map((c) => (
                <option key={c} value={c}>{say(CONTACT_CAT_LABEL[c], lang)}</option>
              ))}
            </select>
          </div>
        </div>

        {category === 'local' && (
          <>
            <label className="td-lab" htmlFor="td-c-loc">{L('fLocalCat')}</label>
            <select id="td-c-loc" className="td-in" value={localCategory}
              onChange={(e) => setLocalCategory(e.target.value)}>
              <option value="">{L('fLocalPick')}</option>
              {LOCAL_CATEGORIES.map((lc) => (
                <option key={lc} value={lc}>{say(LOCAL_CAT_LABEL[lc], lang)}</option>
              ))}
            </select>
          </>
        )}

        <div className="td-row">
          <div className="td-col">
            <label className="td-lab" htmlFor="td-c-phone">{L('fPhone')}</label>
            <input id="td-c-phone" className="td-in" value={phone} inputMode="tel"
              maxLength={KNOWLEDGE_LIMITS.PHONE_MAX} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="td-col">
            <label className="td-lab" htmlFor="td-c-email">{L('fEmail')}</label>
            <input id="td-c-email" className="td-in" value={email} inputMode="email"
              maxLength={KNOWLEDGE_LIMITS.EMAIL_MAX} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>

        <label className="td-lab" htmlFor="td-c-addr">{L('fAddress')}</label>
        <input id="td-c-addr" className="td-in" value={address} placeholder={L('fAddressPh')}
          maxLength={KNOWLEDGE_LIMITS.ADDRESS_MAX} onChange={(e) => setAddress(e.target.value)} />

        <div className="td-row">
          <div className="td-col">
            <label className="td-lab" htmlFor="td-c-city">{L('fCity')}</label>
            <input id="td-c-city" className="td-in" value={cityStateZip} placeholder={L('fCityPh')}
              maxLength={KNOWLEDGE_LIMITS.ADDRESS_MAX} onChange={(e) => setCityStateZip(e.target.value)} />
          </div>
          <div className="td-col">
            <label className="td-lab" htmlFor="td-c-hours">{L('fHours')}</label>
            <input id="td-c-hours" className="td-in" value={hours} placeholder={L('fHoursPh')}
              maxLength={KNOWLEDGE_LIMITS.HOURS_MAX} onChange={(e) => setHours(e.target.value)} />
          </div>
        </div>

        <label className="td-lab" htmlFor="td-c-notes">{L('fNotes')}</label>
        <textarea id="td-c-notes" className="td-in td-ta" value={notes} rows={3}
          maxLength={KNOWLEDGE_LIMITS.NOTES_MAX} onChange={(e) => setNotes(e.target.value)} />

        {error && <div className="td-note td-bad" role="alert">{error}</div>}

        <div className="td-acts">
          <button type="button" className="td-act td-yes" disabled={busy || !name.trim()}
            onClick={() => void save()}>{L('save')}</button>
          <button type="button" className="td-act" onClick={onCancel}>{L('cancel')}</button>
        </div>
      </div>
    </div>
  );
}
