'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import type { Vendor } from '@/lib/ordering/types';

import { T, fonts, statusColor } from '../tokens';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import { banner, inputMd as inputStyle } from './form-kit';
import {
  apiCreateVendor,
  apiImportCatalog,
  apiListCatalog,
  apiListVendors,
  apiUpdateVendor,
  type VendorFields,
} from '../ordering-api';

interface OrderingSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  canManage: boolean;
  /** Inventory items may have been seeded (catalog import) — refresh the shell. */
  onChanged?: () => void;
}

// Co-located strings for the ordering-settings panel — same factory
// convention as the other overlays (ssStrings / csStrings / rpStrings…).
function osStrings(lang: 'en' | 'es') {
  return {
    en: {
      eyebrow: 'Ordering settings',
      italic: 'Vendors & catalog',
      howItWorks: 'Place an order from the reorder list and it emails the vendor right away, then track Sent → Received.',
      saving: 'Saving…',
      done: 'Done',
      managerOnly: 'Only managers can change ordering settings.',
      vendorsTitle: 'Vendors',
      addVendor: 'Add vendor',
      name: 'Name',
      email: 'Email',
      phone: 'Phone',
      account: 'Account #',
      save: 'Save',
      cancel: 'Cancel',
      edit: 'Edit',
      deactivate: 'Deactivate',
      reactivate: 'Reactivate',
      noVendors: 'No vendors yet. Add one so orders can be emailed automatically.',
      noEmailHint: '(no email — orders save as draft)',
      catalogTitle: 'Starter catalog',
      catalogDesc: 'Seed this property with common limited-service-hotel supplies in one click. Skips anything you already have.',
      importBtn: 'Import starter catalog',
      importing: 'Importing…',
      importDone: (i: number, s: number) => `Imported ${i} item(s), skipped ${s} already present.`,
      items: 'items available',
    },
    es: {
      eyebrow: 'Ajustes de pedidos',
      italic: 'Proveedores y catálogo',
      howItWorks: 'Crea una orden desde la lista de reorden y se envía al proveedor de inmediato; luego sigue Enviado → Recibido.',
      saving: 'Guardando…',
      done: 'Listo',
      managerOnly: 'Solo gerentes pueden cambiar estos ajustes.',
      vendorsTitle: 'Proveedores',
      addVendor: 'Agregar proveedor',
      name: 'Nombre',
      email: 'Correo',
      phone: 'Teléfono',
      account: 'N.º de cuenta',
      save: 'Guardar',
      cancel: 'Cancelar',
      edit: 'Editar',
      deactivate: 'Desactivar',
      reactivate: 'Reactivar',
      noVendors: 'Aún no hay proveedores. Agrega uno para enviar órdenes automáticamente.',
      noEmailHint: '(sin correo — las órdenes quedan en borrador)',
      catalogTitle: 'Catálogo inicial',
      catalogDesc: 'Carga suministros comunes de hotel en un clic. Omite lo que ya tengas.',
      importBtn: 'Importar catálogo inicial',
      importing: 'Importando…',
      importDone: (i: number, s: number) => `Importados ${i} artículo(s), omitidos ${s} ya presentes.`,
      items: 'artículos disponibles',
    },
  }[lang];
}

export function OrderingSettingsPanel({
  open,
  onClose,
  canManage,
  onChanged,
}: OrderingSettingsPanelProps) {
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const L = lang === 'es' ? 'es' : 'en';

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Vendors
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<{ name: string; email: string; phone: string; account: string }>({
    name: '', email: '', phone: '', account: '',
  });

  // Catalog
  const [catalogCount, setCatalogCount] = useState<number | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);

  const tt = osStrings(L);

  const loadVendors = useCallback(async () => {
    if (!activePropertyId) return;
    try {
      setVendors(await apiListVendors(activePropertyId, true));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vendors');
    }
  }, [activePropertyId]);

  useEffect(() => {
    if (!open || !activePropertyId) return;
    setError(null);
    setEditing(null);
    setImportResult(null);
    void loadVendors();
    void apiListCatalog(activePropertyId).then((c) => setCatalogCount(c.length)).catch(() => setCatalogCount(null));
  }, [open, activePropertyId, loadVendors]);

  const openNew = () => { setEditing('new'); setForm({ name: '', email: '', phone: '', account: '' }); };
  const openEdit = (v: Vendor) => {
    setEditing(v.id);
    setForm({ name: v.name, email: v.email ?? '', phone: v.phone ?? '', account: v.accountNumber ?? '' });
  };

  const saveVendor = async () => {
    if (!activePropertyId || saving || !form.name.trim()) return;
    setSaving(true);
    setError(null);
    const fields: VendorFields = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      accountNumber: form.account.trim() || null,
    };
    try {
      if (editing === 'new') await apiCreateVendor(activePropertyId, fields);
      else if (editing) await apiUpdateVendor(activePropertyId, editing, fields);
      setEditing(null);
      await loadVendors();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (v: Vendor) => {
    if (!activePropertyId || saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiUpdateVendor(activePropertyId, v.id, { isActive: !v.isActive });
      await loadVendors();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  const doImport = async () => {
    if (!activePropertyId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await apiImportCatalog(activePropertyId);
      setImportResult(r);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setSaving(false);
    }
  };

  const sectionLabel = (s: string) => (
    <span style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.ink3, fontWeight: 600 }}>{s}</span>
  );

  return (
    <Overlay open={open} onClose={onClose} eyebrow={tt.eyebrow} italic={tt.italic} accent={statusColor.good} width={900}
      footer={<Btn variant="ghost" size="md" onClick={onClose}>{tt.done}</Btn>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {error && <div style={banner(statusColor.critical)}>{error}</div>}
        {!canManage && <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{tt.managerOnly}</div>}

        {/* How ordering works — one plain line (no modes; ordering is always
            "place → email the vendor → track Sent/Received"). */}
        <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: 0 }}>{tt.howItWorks}</p>

        {/* Vendors */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {sectionLabel(tt.vendorsTitle)}
            <span style={{ flex: 1 }} />
            {canManage && editing === null && <Btn variant="ghost" size="sm" onClick={openNew}>{tt.addVendor}</Btn>}
          </div>

          {editing !== null && (
            <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <input style={inputStyle} placeholder={tt.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <input style={inputStyle} placeholder={tt.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                <input style={inputStyle} placeholder={tt.phone} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                <input style={inputStyle} placeholder={tt.account} value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Btn variant="ghost" size="sm" onClick={() => setEditing(null)}>{tt.cancel}</Btn>
                <Btn variant="primary" size="sm" disabled={saving || !form.name.trim()} onClick={saveVendor}>{saving ? tt.saving : tt.save}</Btn>
              </div>
            </div>
          )}

          {vendors.length === 0 && editing === null ? (
            <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>{tt.noVendors}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {vendors.map((v) => (
                <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 10, opacity: v.isActive ? 1 : 0.5 }}>
                  <span style={{ fontFamily: fonts.sans, fontSize: 13, fontWeight: 600, color: T.ink }}>{v.name}</span>
                  <span style={{ fontFamily: fonts.mono, fontSize: 11, color: v.email ? T.ink2 : statusColor.low }}>
                    {v.email || tt.noEmailHint}
                  </span>
                  <span style={{ flex: 1 }} />
                  {canManage && (
                    <>
                      <Btn variant="ghost" size="sm" onClick={() => openEdit(v)}>{tt.edit}</Btn>
                      <Btn variant="ghost" size="sm" disabled={saving} onClick={() => toggleActive(v)}>{v.isActive ? tt.deactivate : tt.reactivate}</Btn>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Starter catalog */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sectionLabel(tt.catalogTitle)}
          <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: 0 }}>
            {tt.catalogDesc}{catalogCount != null ? ` · ${catalogCount} ${tt.items}` : ''}
          </p>
          {importResult && <div style={banner(statusColor.good)}>{tt.importDone(importResult.imported, importResult.skipped)}</div>}
          {canManage && (
            <div>
              <Btn variant="primary" size="sm" disabled={saving} onClick={doImport}>{saving ? tt.importing : tt.importBtn}</Btn>
            </div>
          )}
        </section>
      </div>
    </Overlay>
  );
}
