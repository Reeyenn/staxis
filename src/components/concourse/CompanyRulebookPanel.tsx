'use client';

// ═══════════════════════════════════════════════════════════════════════════
// CompanyRulebookPanel — the management company's own book, one level above
// "what Staxis knows about this hotel."
//
// WHERE IT LIVES AND WHY
// Inside the Knows view, ABOVE the hotel's facts. Not a new top-level tab: the
// company book and the hotel book are the same relationship with the copilot at
// two altitudes, and a VP who opens Knows should see the company's rules and
// then this hotel's, in that order — which is also the order the copilot reads
// them in. A hotel with no management company renders nothing at all here.
//
// TWO AUDIENCES, ONE SCREEN
//   Company leadership  the full book: open box, Confirm / Edit / Remove, the
//                       structured reading of every approval rule, and the
//                       quiet line where a hotel's settings disagree with it.
//   A hotel GM          the same book, LOCKED. The founder's ruling: "they
//                       should know the policies they're governed by." No open
//                       box, no buttons, and the server refuses their writes
//                       regardless of what this component renders.
//
// HONESTY RULES, inherited from the hotel Knows screen:
//   • A line pulled out of something you pasted shows as NOT CONFIRMED and does
//     not reach any hotel's copilot until you say so — enforced in the database
//     (migration 0365), not just labelled here.
//   • Confirming an approval rule shows you EXACTLY what will be frozen, in one
//     sentence, before you agree to it.
//   • Remove is permanent, and the copy says so.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import { readEnvelope } from '@/lib/api-envelope';
import {
  COMPANY_CATEGORIES,
  COMPANY_CATEGORY_LABELS,
  type CompanyCategory,
} from '@/lib/company/rulebook-policy';
import { CxIcon } from './icons';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Bilingual { en: string; es: string }

interface RulebookFact {
  id: string;
  topic: string;
  content: string;
  category: CompanyCategory;
  source: string;
  reviewState: 'unreviewed' | 'confirmed';
  policyKey: string | null;
  policyValue: string | null;
  createdByName: string | null;
  updatedAt: string;
  nearDuplicateOf?: { id: string; topic: string; content: string; line: Bilingual } | null;
  reading: {
    authority: { line: Bilingual } | null;
    /**
     * Set when the line names TWO approvers and Staxis will not choose between
     * them. Rendered as its own block rather than as a `reading`, because it is
     * the opposite claim: a reading says "this is in force", this says "nothing
     * is, and here is why".
     */
    ambiguousAuthority?: { candidates: string[]; line: Bilingual } | null;
    policy: { line: Bilingual } | null;
  };
}

interface Contradiction {
  propertyId: string;
  propertyName: string;
  key: string;
  line: Bilingual;
}

interface RulebookData {
  organizationId: string;
  canEdit: boolean;
  companyRole: 'owner' | 'vp' | 'finance' | null;
  viewOnlyBecauseHotelJob: boolean;
  settings: {
    gms_see_rulebook: string | null;
    cross_hotel_ai_chat: string | null;
    rulebook_editors: string | null;
    setup_completed_at: string | null;
  };
  stats: { totalKnown: number; pendingReview: number; hotelsCovered: number };
  facts: RulebookFact[];
  contradictions: Contradiction[];
}

interface IntakeResult {
  added: Array<{ id: string }>;
  skipped: number;
  readNote: string | null;
  nothingFound: boolean;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

const S = {
  title: { en: 'Company rulebook', es: 'Libro de la empresa' },
  subEdit: {
    en: 'The rules that apply at every hotel your company runs. Staxis follows them at all of them.',
    es: 'Las reglas que aplican en cada hotel de tu empresa. Staxis las sigue en todos.',
  },
  subView: {
    en: 'The rules your management company has set. You can read them here; only company leadership can change them.',
    es: 'Las reglas que fijó tu empresa administradora. Puedes leerlas aquí; solo la dirección puede cambiarlas.',
  },
  locked: { en: 'Read only', es: 'Solo lectura' },
  coversOne: { en: 'covers 1 hotel', es: 'cubre 1 hotel' },
  coversMany: { en: 'hotels', es: 'hoteles' },
  known: { en: 'in the book', es: 'en el libro' },
  pending: { en: 'waiting for you', es: 'esperando tu revisión' },
  boxEyebrow: { en: 'Add to the rulebook', es: 'Agregar al libro' },
  boxPlaceholder: {
    en: 'A policy that holds at every hotel — who you buy from, what needs a signature, how you want things run.',
    es: 'Una política para todos los hoteles: a quién le compran, qué necesita firma, cómo quieren que se haga.',
  },
  boxHint: {
    en: 'Optional. Or drop in a file you already have — an operations manual, a vendor agreement, a policy memo.',
    es: 'Opcional. O sube un archivo que ya tengas: un manual de operaciones, un acuerdo con proveedor, un memo.',
  },
  addFile: { en: 'Add a file', es: 'Agregar archivo' },
  removeFile: { en: 'Remove file', es: 'Quitar archivo' },
  submit: { en: 'Add this', es: 'Agregar esto' },
  submitting: { en: 'Reading…', es: 'Leyendo…' },
  intakeDoneOne: {
    en: '1 rule added below — check it before Staxis applies it at your hotels.',
    es: '1 regla agregada abajo: revísala antes de que Staxis la aplique en tus hoteles.',
  },
  intakeDoneMany: {
    en: 'rules added below — check each one before Staxis applies it at your hotels.',
    es: 'reglas agregadas abajo: revisa cada una antes de que Staxis las aplique en tus hoteles.',
  },
  intakeNothing: {
    en: 'Nothing company-wide in that one — nothing was saved.',
    es: 'Nada para toda la empresa en eso: no se guardó nada.',
  },
  fileTooBig: { en: 'That file is too big — keep it under 4MB.', es: 'Ese archivo es muy grande: máximo 4MB.' },
  fileWrongType: {
    en: 'Staxis can read PDF, Word, and plain text files.',
    es: 'Staxis puede leer archivos PDF, Word y de texto.',
  },
  emptyTitle: { en: 'Your company book is empty', es: 'El libro de tu empresa está vacío' },
  emptyBody: {
    en: 'Write one rule above and every hotel in the company gets it. Nothing here is required — a book with three lines in it is a useful book.',
    es: 'Escribe una regla arriba y todos los hoteles de la empresa la reciben. Nada es obligatorio: un libro con tres líneas ya sirve.',
  },
  emptyView: {
    en: 'Your management company has not written any rules yet.',
    es: 'Tu empresa administradora todavía no ha escrito reglas.',
  },
  readingEyebrow: { en: 'Staxis reads this as', es: 'Staxis entiende esto como' },
  readingAsk: { en: 'Right?', es: '¿Correcto?' },
  readingUnsure: { en: 'Staxis cannot read this one', es: 'Staxis no puede leer esta' },
  dupeEyebrow: { en: 'You may already have this', es: 'Puede que ya tengas esto' },
  dupeUpdate: { en: 'Update that line', es: 'Actualizar esa línea' },
  dupeKeepBoth: { en: 'Keep both', es: 'Conservar las dos' },
  ruleFrozen: { en: 'Approval rule in force', es: 'Regla de aprobación activa' },
  confirm: { en: 'Confirm', es: 'Confirmar' },
  edit: { en: 'Edit', es: 'Editar' },
  remove: { en: 'Remove', es: 'Quitar' },
  save: { en: 'Save', es: 'Guardar' },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  removeSure: {
    en: 'Remove for good? Any approval rule frozen from this line stops applying.',
    es: '¿Quitar definitivamente? Cualquier regla de aprobación de esta línea deja de aplicar.',
  },
  removeYes: { en: 'Yes, remove', es: 'Sí, quitar' },
  nothingHere: { en: 'Nothing here yet', es: 'Nada aquí todavía' },
  mismatchTitle: { en: 'Worth knowing', es: 'Vale la pena saberlo' },
  mismatchHint: {
    en: 'A hotel is set up differently from the book. Nothing is blocked — this is just so you know.',
    es: 'Un hotel está configurado distinto al libro. Nada está bloqueado: solo para que lo sepas.',
  },
  setupTitle: { en: 'Who can do what', es: 'Quién puede hacer qué' },
  setupHint: {
    en: 'Asked once. Change it any time.',
    es: 'Se pregunta una vez. Cámbialo cuando quieras.',
  },
  setupGms: {
    en: 'Your GMs can read this rulebook',
    es: 'Tus gerentes pueden leer este libro',
  },
  setupGmsWhy: {
    en: 'Always on — people should know the policies they are governed by.',
    es: 'Siempre activo: la gente debe conocer las políticas que la rigen.',
  },
  setupChat: {
    en: 'Company leadership can ask Staxis about all hotels at once',
    es: 'La dirección puede preguntarle a Staxis sobre todos los hoteles a la vez',
  },
  setupChatWhy: {
    en: 'Off until you turn it on.',
    es: 'Desactivado hasta que lo actives.',
  },
  setupEditors: { en: 'Who can change the rulebook', es: 'Quién puede cambiar el libro' },
  editorOwnerOnly: { en: 'The owner only', es: 'Solo el propietario' },
  editorOwnerVp: { en: 'The owner and VPs', es: 'El propietario y los supervisores' },
  editorCompany: { en: 'Anyone with a company-wide job', es: 'Cualquiera con un puesto de empresa' },
  saved: { en: 'Saved.', es: 'Guardado.' },
  on: { en: 'On', es: 'Activado' },
  off: { en: 'Off', es: 'Desactivado' },
  loadFailed: {
    en: 'Could not load the company rulebook right now. Do not read this as "there are no rules".',
    es: 'No se pudo cargar el libro de la empresa. No lo tomes como "no hay reglas".',
  },
} as const;

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ACCEPT =
  '.pdf,.txt,.md,.csv,.docx,application/pdf,text/plain,text/markdown,text/csv,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Resolve from the extension rather than File.type — Safari hands back "". */
function mimeForFile(file: File): string | null {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  return EXT_MIME[ext] ?? null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

// ─── Scoped styles ──────────────────────────────────────────────────────────

const CR_CSS = `
.cr-wrap{margin-bottom:30px;}
.cr-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.cr-t{font-size:16px;font-weight:600;color:#1F231C;}
.cr-lock{font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:#6F7A6F;
  background:rgba(31,35,28,.06);border-radius:999px;padding:3px 9px;}
.cr-s{font-size:12.5px;color:#6F7A6F;line-height:1.5;margin-top:4px;max-width:640px;}
.cr-box{background:#fff;border:1px solid rgba(92,122,96,.28);border-radius:18px;padding:16px 18px;margin-top:16px;
  box-shadow:0 10px 26px -20px rgba(31,42,32,.3);}
.cr-ta{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;margin-top:9px;border-radius:12px;
  border:1px solid rgba(31,35,28,.12);background:#FCFDFB;padding:10px 12px;color:#1F231C;font-size:13.5px;
  line-height:1.5;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;outline:none;}
.cr-ta:focus{border-color:rgba(92,122,96,.55);}
.cr-ta::placeholder{color:#A6ABA6;}
.cr-boxfoot{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;}
.cr-hint{font-size:11.5px;color:#8A9187;line-height:1.45;margin-top:7px;}
.cr-file{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:#3E5C48;
  background:rgba(158,183,166,.18);border-radius:999px;padding:5px 11px;max-width:100%;}
.cr-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cr-note{margin-top:12px;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.5;}
.cr-note.cr-good{background:rgba(53,107,76,.09);color:#2C5740;}
.cr-note.cr-bad{background:rgba(184,92,61,.10);color:#8E432B;}
.cr-meta{display:flex;gap:14px;margin-top:12px;flex-wrap:wrap;}
.cr-metai{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;color:#8A9187;}
.cr-grp{margin-top:20px;}
.cr-grpt{font-size:14px;font-weight:600;color:#1F231C;}
.cr-grps{font-size:11.5px;color:#8A9187;margin-top:2px;}
.cr-rows{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;margin-top:9px;overflow:hidden;}
.cr-row{padding:13px 16px;border-bottom:1px solid rgba(31,35,28,.05);}
.cr-row:last-child{border-bottom:none;}
.cr-row.cr-new{background:rgba(201,150,68,.07);}
.cr-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.cr-c{font-size:13.5px;color:#1F231C;line-height:1.5;}
.cr-p{font-size:11.5px;color:#8A9187;margin-top:4px;}
.cr-read{margin-top:9px;border-left:2px solid rgba(92,122,96,.5);padding:2px 0 2px 10px;}
.cr-reade{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#6F8A72;}
.cr-readl{font-size:12.5px;color:#2F3A30;line-height:1.5;margin-top:2px;}
/* "Staxis cannot read this one" — caramel, not sage. A reading and a refusal to
   read must not look like the same kind of statement. */
.cr-unsure{border-left-color:rgba(201,150,68,.7);}
.cr-unsure .cr-reade{color:#8C6A33;}
.cr-acts{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;}
.cr-act{height:30px;padding:0 12px;border-radius:999px;cursor:pointer;font-size:12px;font-weight:500;
  border:1px solid rgba(31,35,28,.14);background:transparent;color:#5C625C;white-space:nowrap;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;transition:background .2s,color .2s;}
.cr-act:hover:not(:disabled){background:rgba(31,35,28,.05);}
.cr-act:disabled{opacity:.5;cursor:default;}
.cr-act.cr-yes{background:#5C7A60;border-color:#5C7A60;color:#fff;font-weight:600;}
.cr-act.cr-yes:hover:not(:disabled){background:#4E6952;}
.cr-act.cr-danger{color:#B85C3D;}
.cr-act:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.cr-sel{height:30px;border-radius:999px;border:1px solid rgba(31,35,28,.14);background:#fff;color:#1F231C;
  font-size:12px;padding:0 9px;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cr-empty{background:#fff;border:1px dashed rgba(92,122,96,.4);border-radius:16px;padding:20px;margin-top:16px;text-align:center;}
.cr-mis{background:rgba(201,150,68,.07);border:1px solid rgba(201,150,68,.22);border-radius:14px;
  padding:12px 14px;margin-top:16px;}
.cr-mist{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8C6A33;}
.cr-misl{font-size:12.5px;color:#5C4A25;line-height:1.55;margin-top:5px;}
.cr-setup{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;padding:14px 16px;margin-top:16px;}
.cr-setr{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:9px 0;
  border-bottom:1px solid rgba(31,35,28,.05);}
.cr-setr:last-child{border-bottom:none;}
.cr-setl{font-size:13px;color:#1F231C;line-height:1.45;}
.cr-setw{font-size:11.5px;color:#8A9187;margin-top:2px;line-height:1.45;}
`;

// ─── Component ──────────────────────────────────────────────────────────────

export function CompanyRulebookPanel({
  lang,
  /**
   * The hotel whose company this is. Defaults to whichever hotel the app is
   * showing — which is every real call site. Explicit only for a harness that
   * renders this panel outside the app shell.
   */
  propertyId,
}: {
  lang: 'en' | 'es';
  propertyId?: string | null;
}) {
  const es = lang === 'es';
  const L = <K extends keyof typeof S>(k: K) => S[k][es ? 'es' : 'en'];

  const { activePropertyId: contextPropertyId } = useProperty();
  const activePropertyId = propertyId ?? contextPropertyId;

  // The hotel on screen tells the server which company this is. A 404 here just
  // means "this hotel is independent", which renders nothing — an independent
  // hotel must not see an empty company panel implying it has a company.
  const { data, loading, error, reload } = useApiResource<RulebookData>(
    `/api/company/rulebook?propertyId=${activePropertyId}`,
    { enabled: !!activePropertyId, keepDataOnError: true },
  );

  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'good' | 'bad'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [draftCat, setDraftCat] = useState<CompanyCategory>('standards');
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const [settingsBusy, setSettingsBusy] = useState(false);

  const post = useCallback(
    async <T,>(url: string, payload: unknown): Promise<{ data?: T; error?: string }> => {
      try {
        const res = await fetchWithAuth(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await readEnvelope<T>(res);
      } catch (e) {
        if (e instanceof SessionEndedError) throw e;
        return { error: e instanceof Error ? e.message : 'Request failed' };
      }
    },
    [],
  );

  const pickFile = (picked: File | null) => {
    setBanner(null);
    if (!picked) { setFile(null); return; }
    if (!mimeForFile(picked)) { setBanner({ kind: 'bad', text: L('fileWrongType') }); return; }
    if (picked.size > MAX_FILE_BYTES) { setBanner({ kind: 'bad', text: L('fileTooBig') }); return; }
    setFile(picked);
  };

  const submitIntake = async () => {
    if (!activePropertyId || busy) return;
    if (!note.trim() && !file) return;
    setBusy(true);
    setBanner(null);
    try {
      const payload: Record<string, unknown> = { propertyId: activePropertyId };
      if (note.trim()) payload.note = note.trim();
      if (file) {
        payload.file = { name: file.name, mimeType: mimeForFile(file), base64: await fileToBase64(file) };
      }
      const res = await post<IntakeResult>('/api/company/rulebook/intake', payload);
      if (res.error !== undefined || !res.data) {
        setBanner({ kind: 'bad', text: res.error || 'Something went wrong.' });
        return;
      }
      const added = res.data.added ?? [];
      setJustAdded(new Set(added.map((a) => a.id)));
      setNote('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      const tail = res.data.readNote ? ` ${res.data.readNote}` : '';
      const headline =
        added.length === 0 ? L('intakeNothing')
          : added.length === 1 ? L('intakeDoneOne')
            : `${added.length} ${L('intakeDoneMany')}`;
      setBanner({ kind: added.length > 0 ? 'good' : 'bad', text: `${headline}${tail}` });
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'confirm' | 'remove') => {
    if (!activePropertyId) return;
    setRowBusy(id);
    try {
      const res = await post('/api/company/rulebook', { propertyId: activePropertyId, action, id });
      if (res.error !== undefined) setBanner({ kind: 'bad', text: res.error });
      else setConfirmingRemove(null);
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  /** "That's the same rule" — put these words on the line already in the book
   *  and drop this restatement. See findNearDuplicate for why this exists. */
  const mergeInto = async (id: string, intoId: string) => {
    if (!activePropertyId) return;
    setRowBusy(id);
    try {
      const res = await post('/api/company/rulebook', {
        propertyId: activePropertyId, action: 'merge', id, intoId,
      });
      if (res.error !== undefined) setBanner({ kind: 'bad', text: res.error });
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  const saveEdit = async (id: string) => {
    if (!activePropertyId || !draft.trim()) return;
    setRowBusy(id);
    try {
      const res = await post('/api/company/rulebook', {
        propertyId: activePropertyId,
        action: 'edit',
        id,
        content: draft.trim(),
        category: draftCat,
      });
      if (res.error !== undefined) setBanner({ kind: 'bad', text: res.error });
      else setEditing(null);
      await reload();
    } finally {
      setRowBusy(null);
    }
  };

  const saveSettings = async (patch: Record<string, string>) => {
    if (!activePropertyId || settingsBusy) return;
    setSettingsBusy(true);
    try {
      const res = await post('/api/company/rulebook', {
        propertyId: activePropertyId,
        action: 'settings',
        settings: patch,
      });
      setBanner(res.error !== undefined
        ? { kind: 'bad', text: res.error }
        : { kind: 'good', text: L('saved') });
      await reload();
    } finally {
      setSettingsBusy(false);
    }
  };

  const groups = useMemo(() => {
    const facts = data?.facts ?? [];
    return COMPANY_CATEGORIES
      .map((category) => ({ category, items: facts.filter((f) => f.category === category) }))
      .filter((g) => g.items.length > 0);
  }, [data]);

  // An independent hotel has no company. The server says so with a 404 and this
  // panel disappears entirely rather than rendering an empty book.
  if (!loading && !data) return null;
  if (!data) return null;

  const canEdit = data.canEdit;
  const hasAnything = data.facts.length > 0;

  return (
    <div className="cr-wrap">
      <style dangerouslySetInnerHTML={{ __html: CR_CSS }} />

      <div className="cr-head">
        <span className="cr-t">{L('title')}</span>
        {!canEdit && <span className="cr-lock">{L('locked')}</span>}
      </div>
      <div className="cr-s">{canEdit ? L('subEdit') : L('subView')}</div>

      {canEdit && (
        <div className="cr-box">
          <div className="cx-dec-eyebrow">{L('boxEyebrow')}</div>
          <textarea
            className="cr-ta"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={L('boxPlaceholder')}
            aria-label={L('boxEyebrow')}
            maxLength={8000}
          />
          <div className="cr-boxfoot">
            <button type="button" className="cr-act" onClick={() => fileRef.current?.click()} disabled={busy}>
              {L('addFile')}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            {file && (
              <span className="cr-file">
                <CxIcon name="inventory" size={13} />
                <span>{file.name}</span>
                <button
                  type="button"
                  className="cr-act"
                  style={{ height: 22, padding: '0 8px', border: 'none' }}
                  onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }}
                  aria-label={L('removeFile')}
                >
                  ×
                </button>
              </span>
            )}
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className="cr-act cr-yes"
              onClick={submitIntake}
              disabled={busy || (!note.trim() && !file)}
            >
              {busy ? L('submitting') : L('submit')}
            </button>
          </div>
          <div className="cr-hint">{L('boxHint')}</div>
        </div>
      )}

      {banner && (
        <div className={`cr-note ${banner.kind === 'good' ? 'cr-good' : 'cr-bad'}`}>{banner.text}</div>
      )}
      {error && <div className="cr-note cr-bad">{L('loadFailed')}</div>}

      <div className="cr-meta">
        <span className="cr-metai">{data.stats.totalKnown} {L('known')}</span>
        <span className="cr-metai">
          {data.stats.hotelsCovered === 1
            ? L('coversOne')
            : `${data.stats.hotelsCovered} ${L('coversMany')}`}
        </span>
        {data.stats.pendingReview > 0 && (
          <span className="cr-metai" style={{ color: '#8C6A33' }}>
            {data.stats.pendingReview} {L('pending')}
          </span>
        )}
      </div>

      {/* Quiet FYI. Never an enforcement, never a claim about the world — only
          where two structured settings genuinely disagree. */}
      {data.contradictions.length > 0 && (
        <div className="cr-mis">
          <div className="cr-mist">{L('mismatchTitle')}</div>
          {data.contradictions.map((c) => (
            <div className="cr-misl" key={`${c.propertyId}:${c.key}`}>{c.line[es ? 'es' : 'en']}</div>
          ))}
          <div className="cr-setw" style={{ marginTop: 6 }}>{L('mismatchHint')}</div>
        </div>
      )}

      {!hasAnything && (
        <div className="cr-empty">
          <div className="cx-dec-t">{canEdit ? L('emptyTitle') : L('emptyView')}</div>
          {canEdit && (
            <div className="cx-dec-s" style={{ maxWidth: 470, margin: '6px auto 0' }}>{L('emptyBody')}</div>
          )}
        </div>
      )}

      {groups.map((g) => {
        const label = COMPANY_CATEGORY_LABELS[g.category];
        return (
          <div className="cr-grp" key={g.category}>
            <div className="cr-grpt">{label.title[es ? 'es' : 'en']}</div>
            <div className="cr-grps">{label.hint[es ? 'es' : 'en']}</div>
            <div className="cr-rows">
              {g.items.map((f) => {
                const unreviewed = f.reviewState === 'unreviewed';
                const isEditing = editing === f.id;
                const disabled = rowBusy === f.id;
                const reading = f.reading.authority ?? f.reading.policy;
                const ambiguous = f.reading.ambiguousAuthority ?? null;
                const dupe = unreviewed ? (f.nearDuplicateOf ?? null) : null;
                return (
                  <div className={`cr-row${justAdded.has(f.id) ? ' cr-new' : ''}`} key={f.id}>
                    <div className="cr-top">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {isEditing ? (
                          <>
                            <textarea
                              className="cr-ta"
                              style={{ marginTop: 0, minHeight: 62 }}
                              value={draft}
                              maxLength={500}
                              onChange={(e) => setDraft(e.target.value)}
                              aria-label={L('edit')}
                            />
                            <select
                              className="cr-sel"
                              style={{ marginTop: 8 }}
                              value={draftCat}
                              onChange={(e) => setDraftCat(e.target.value as CompanyCategory)}
                              aria-label={L('edit')}
                            >
                              {COMPANY_CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {COMPANY_CATEGORY_LABELS[c].title[es ? 'es' : 'en']}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <>
                            <div className="cr-c">{f.content}</div>
                            {f.createdByName && <div className="cr-p">{f.createdByName}</div>}
                          </>
                        )}
                      </div>
                      <span className={`cx-bdg ${unreviewed ? 'cx-warn' : 'cx-ok'}`}>
                        {unreviewed ? L('pending') : L('known')}
                      </span>
                    </div>

                    {/* The structured reading. Before confirming, this is the
                        question the person answers; after, it is the receipt of
                        what is actually in force. */}
                    {!isEditing && reading && (
                      <div className="cr-read">
                        <div className="cr-reade">
                          {unreviewed
                            ? `${L('readingEyebrow')} — ${L('readingAsk')}`
                            : (f.reading.authority ? L('ruleFrozen') : L('readingEyebrow'))}
                        </div>
                        <div className="cr-readl">{reading.line[es ? 'es' : 'en']}</div>
                      </div>
                    )}

                    {/* Two approvers named, no rule stored. Shown whether the
                        line is confirmed or not: a confirmed sentence that
                        SOUNDS like a money rule and enforces nothing is exactly
                        the thing a VP must not have to guess about. */}
                    {!isEditing && ambiguous && (
                      <div className="cr-read cr-unsure">
                        <div className="cr-reade">{L('readingUnsure')}</div>
                        <div className="cr-readl">{ambiguous.line[es ? 'es' : 'en']}</div>
                      </div>
                    )}

                    {!isEditing && dupe && (
                      <div className="cr-read cr-unsure">
                        <div className="cr-reade">{L('dupeEyebrow')}</div>
                        <div className="cr-readl">{dupe.line[es ? 'es' : 'en']}</div>
                      </div>
                    )}

                    {canEdit && (
                      <div className="cr-acts">
                        {isEditing ? (
                          <>
                            <button
                              type="button" className="cr-act cr-yes" disabled={disabled || !draft.trim()}
                              onClick={() => saveEdit(f.id)}
                            >
                              {L('save')}
                            </button>
                            <button type="button" className="cr-act" onClick={() => setEditing(null)}>
                              {L('cancel')}
                            </button>
                          </>
                        ) : confirmingRemove === f.id ? (
                          <>
                            <span style={{ fontSize: 12, color: '#8E432B', alignSelf: 'center' }}>
                              {L('removeSure')}
                            </span>
                            <button
                              type="button" className="cr-act cr-danger" disabled={disabled}
                              onClick={() => act(f.id, 'remove')}
                            >
                              {L('removeYes')}
                            </button>
                            <button type="button" className="cr-act" onClick={() => setConfirmingRemove(null)}>
                              {L('cancel')}
                            </button>
                          </>
                        ) : (
                          <>
                            {/* A restatement gets a CHOICE rather than a
                                Confirm: fold it into the line already in the
                                book, or keep both. "Keep both" is a real
                                answer — the match is a heuristic over English
                                and must never swallow a genuinely new rule. */}
                            {unreviewed && dupe && (
                              <button
                                type="button" className="cr-act cr-yes" disabled={disabled}
                                onClick={() => mergeInto(f.id, dupe.id)}
                              >
                                {L('dupeUpdate')}
                              </button>
                            )}
                            {unreviewed && (
                              <button
                                type="button" className="cr-act cr-yes" disabled={disabled}
                                onClick={() => act(f.id, 'confirm')}
                                style={dupe ? { background: 'transparent', borderColor: 'rgba(31,35,28,.14)', color: '#5C625C' } : undefined}
                              >
                                {dupe ? L('dupeKeepBoth') : L('confirm')}
                              </button>
                            )}
                            <button
                              type="button" className="cr-act" disabled={disabled}
                              onClick={() => { setEditing(f.id); setDraft(f.content); setDraftCat(f.category); }}
                            >
                              {L('edit')}
                            </button>
                            <button
                              type="button" className="cr-act cr-danger" disabled={disabled}
                              onClick={() => setConfirmingRemove(f.id)}
                            >
                              {L('remove')}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* ── Who can do what. Only the people who own the book get asked. ── */}
      {canEdit && (
        <div className="cr-setup">
          <div className="cr-grpt">{L('setupTitle')}</div>
          <div className="cr-grps">{L('setupHint')}</div>

          <div className="cr-setr">
            <div>
              <div className="cr-setl">{L('setupGms')}</div>
              <div className="cr-setw">{L('setupGmsWhy')}</div>
            </div>
            <span className="cx-bdg cx-ok">{L('on')}</span>
          </div>

          <div className="cr-setr">
            <div>
              <div className="cr-setl">{L('setupChat')}</div>
              <div className="cr-setw">{L('setupChatWhy')}</div>
            </div>
            <button
              type="button"
              className={`cr-act${data.settings.cross_hotel_ai_chat === 'true' ? ' cr-yes' : ''}`}
              disabled={settingsBusy}
              aria-pressed={data.settings.cross_hotel_ai_chat === 'true'}
              onClick={() => saveSettings({
                cross_hotel_ai_chat: data.settings.cross_hotel_ai_chat === 'true' ? 'false' : 'true',
              })}
            >
              {data.settings.cross_hotel_ai_chat === 'true' ? L('on') : L('off')}
            </button>
          </div>

          <div className="cr-setr">
            <div className="cr-setl">{L('setupEditors')}</div>
            <select
              className="cr-sel"
              disabled={settingsBusy}
              value={data.settings.rulebook_editors ?? 'owner_and_vp'}
              aria-label={L('setupEditors')}
              onChange={(e) => saveSettings({ rulebook_editors: e.target.value })}
            >
              <option value="owner_only">{L('editorOwnerOnly')}</option>
              <option value="owner_and_vp">{L('editorOwnerVp')}</option>
              <option value="company_scope">{L('editorCompany')}</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}
