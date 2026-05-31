'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import type { OrderingMode, Vendor } from '@/lib/ordering/types';

import { T, fonts, statusColor } from '../tokens';
import { Btn } from '../Btn';
import { Overlay } from './Overlay';
import {
  apiCreateVendor,
  apiImportCatalog,
  apiListCatalog,
  apiListVendors,
  apiSetMode,
  apiUpdateVendor,
  type VendorFields,
} from '../ordering-api';

interface OrderingSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  canManage: boolean;
  orderingMode: OrderingMode;
  onModeChange: (m: OrderingMode) => void;
  /** Inventory items may have been seeded (catalog import) — refresh the shell. */
  onChanged?: () => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 38,
  padding: '0 12px',
  borderRadius: 9,
  boxSizing: 'border-box',
  background: T.bg,
  border: `1px solid ${T.rule}`,
  fontFamily: fonts.sans,
  fontSize: 13,
  color: T.ink,
  outline: 'none',
};

export function OrderingSettingsPanel({
  open,
  onClose,
  canManage,
  orderingMode,
  onModeChange,
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

  const tt = {
    eyebrow: { en: 'Ordering settings', es: 'Ajustes de pedidos' }[L],
    modeTitle: { en: 'Ordering mode', es: 'Modo de pedidos' }[L],
    simpleName: { en: 'Simple', es: 'Simple' }[L],
    simpleDesc: { en: 'Place an order from the reorder list and it emails the vendor right away. Track Sent → Received. No approval step.', es: 'Crea una orden desde la lista de reorden y se envía al proveedor de inmediato. Sigue Enviado → Recibido. Sin aprobación.' }[L],
    proName: { en: 'Pro', es: 'Pro' }[L],
    proDesc: { en: 'Orders get a PO number and start as "Needs approval". A manager approves before the order can be emailed. Best for management companies.', es: 'Las órdenes reciben un número de OC y empiezan como "Requiere aprobación". Un gerente aprueba antes de enviarse. Ideal para empresas gestoras.' }[L],
    current: { en: 'Current', es: 'Actual' }[L],
    use: { en: 'Use this', es: 'Usar este' }[L],
    saving: { en: 'Saving…', es: 'Guardando…' }[L],
    done: { en: 'Done', es: 'Listo' }[L],
    managerOnly: { en: 'Only managers can change ordering settings.', es: 'Solo gerentes pueden cambiar estos ajustes.' }[L],
    vendorsTitle: { en: 'Vendors', es: 'Proveedores' }[L],
    addVendor: { en: 'Add vendor', es: 'Agregar proveedor' }[L],
    name: { en: 'Name', es: 'Nombre' }[L],
    email: { en: 'Email', es: 'Correo' }[L],
    phone: { en: 'Phone', es: 'Teléfono' }[L],
    account: { en: 'Account #', es: 'N.º de cuenta' }[L],
    save: { en: 'Save', es: 'Guardar' }[L],
    cancel: { en: 'Cancel', es: 'Cancelar' }[L],
    edit: { en: 'Edit', es: 'Editar' }[L],
    deactivate: { en: 'Deactivate', es: 'Desactivar' }[L],
    reactivate: { en: 'Reactivate', es: 'Reactivar' }[L],
    noVendors: { en: 'No vendors yet. Add one so orders can be emailed automatically.', es: 'Aún no hay proveedores. Agrega uno para enviar órdenes automáticamente.' }[L],
    noEmailHint: { en: '(no email — orders save as draft)', es: '(sin correo — las órdenes quedan en borrador)' }[L],
    catalogTitle: { en: 'Starter catalog', es: 'Catálogo inicial' }[L],
    catalogDesc: { en: 'Seed this property with common limited-service-hotel supplies in one click. Skips anything you already have.', es: 'Carga suministros comunes de hotel en un clic. Omite lo que ya tengas.' }[L],
    importBtn: { en: 'Import starter catalog', es: 'Importar catálogo inicial' }[L],
    importing: { en: 'Importing…', es: 'Importando…' }[L],
    importDone: (i: number, s: number) => ({ en: `Imported ${i} item(s), skipped ${s} already present.`, es: `Importados ${i} artículo(s), omitidos ${s} ya presentes.` }[L]),
    items: { en: 'items available', es: 'artículos disponibles' }[L],
  };

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

  const pickMode = async (mode: OrderingMode) => {
    if (!activePropertyId || saving || mode === orderingMode) return;
    setSaving(true);
    setError(null);
    try {
      await apiSetMode(activePropertyId, mode);
      onModeChange(mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

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

  const modeCard = (mode: OrderingMode, label: string, desc: string) => {
    const active = orderingMode === mode;
    return (
      <div style={{ flex: 1, background: T.paper, border: `1.5px solid ${active ? statusColor.good : T.rule}`, borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontFamily: fonts.serif, fontSize: 20, fontStyle: 'italic', color: T.ink }}>{label}</span>
          {active && <span style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: statusColor.good, fontWeight: 700 }}>{tt.current}</span>}
        </div>
        <p style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2, lineHeight: 1.5, margin: 0, flex: 1 }}>{desc}</p>
        {canManage && !active && <Btn variant="primary" size="sm" disabled={saving} onClick={() => pickMode(mode)}>{saving ? tt.saving : tt.use}</Btn>}
      </div>
    );
  };

  return (
    <Overlay open={open} onClose={onClose} eyebrow={tt.eyebrow} italic={orderingMode === 'pro' ? tt.proName : tt.simpleName} accent={statusColor.good} width={900}
      footer={<Btn variant="ghost" size="md" onClick={onClose}>{tt.done}</Btn>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        {error && <div style={banner(statusColor.critical)}>{error}</div>}
        {!canManage && <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink2 }}>{tt.managerOnly}</div>}

        {/* Mode */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sectionLabel(tt.modeTitle)}
          <div style={{ display: 'flex', gap: 12 }}>
            {modeCard('simple', tt.simpleName, tt.simpleDesc)}
            {modeCard('pro', tt.proName, tt.proDesc)}
          </div>
        </section>

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

function banner(color: string): React.CSSProperties {
  return {
    background: T.paper,
    border: `1px solid ${color}`,
    borderLeft: `3px solid ${color}`,
    borderRadius: 10,
    padding: '10px 14px',
    fontFamily: fonts.sans,
    fontSize: 13,
    color: T.ink,
  };
}
