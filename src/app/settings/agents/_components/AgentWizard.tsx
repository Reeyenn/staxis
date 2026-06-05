'use client';

// Template-first wizard, shared by create + edit. Fetches the catalog (and, in
// edit mode, the agent) through agentsApi. Builds an AgentConfig via the pure
// config.ts helpers (which clamp the safety floor and keep actions↔perAction in
// lockstep), then writes via POST/PATCH. Save-as-draft creates; Activate creates
// then PATCHes status:'active'.

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { T, fonts, Caps, Btn } from './_tokens';
import { Loading, ErrorBanner } from './states';
import { TemplateStep } from './wizard/TemplateStep';
import { BasicsStep } from './wizard/BasicsStep';
import { TriggerEditor } from './wizard/TriggerEditor';
import { ScopePicker } from './wizard/ScopePicker';
import { ActionPicker } from './wizard/ActionPicker';
import { ReviewStep } from './wizard/ReviewStep';
import { agentsApi, isSessionEnded, type AgentCatalog } from '../_lib/api';
import { emptyWizardState, type WizardState } from '../_lib/wizardState';
import {
  buildAgentConfig, configToWizard, isCoreComplete, requiredPayloadsMet, validTime,
  type ActionFloors,
} from '../_lib/config';
import { clampMode } from '../_lib/safety';
import { errorToMessage } from '../_lib/format';
import { s, type Lang } from '../_lib/strings';
import type { ActionApprovalMode, AgentEventName, ScopeKey } from '@/lib/agents/types';

type Step = 'template' | 'basics' | 'trigger' | 'scopes' | 'actions' | 'review';

const STEP_LABEL: Record<Step, Parameters<typeof s>[1]> = {
  template: 'stepTemplate', basics: 'stepBasics', trigger: 'stepTrigger',
  scopes: 'stepScopes', actions: 'stepActions', review: 'stepReview',
};

export function AgentWizard({
  mode, pid, lang, agentId,
}: {
  mode: 'create' | 'edit';
  pid: string;
  lang: Lang;
  agentId?: string;
}) {
  const router = useRouter();
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null);
  const [state, setState] = useState<WizardState>(emptyWizardState());
  const [agentLoaded, setAgentLoaded] = useState(mode === 'create');
  const [stepIdx, setStepIdx] = useState(0);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const floors: ActionFloors = useMemo(
    () => Object.fromEntries((catalog?.actions ?? []).map((a) => [a.key, a.approvalFloor])),
    [catalog],
  );
  const requiredByAction = useMemo(
    () => Object.fromEntries((catalog?.actions ?? []).map((a) => [a.key, a.inputSchema.required ?? []])),
    [catalog],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const c = await agentsApi.catalog(pid);
        if (!active) return;
        if (!c.ok) { setLoadErr(errorToMessage(c.error, lang)); return; }
        setCatalog(c.data);
        if (mode === 'edit' && agentId) {
          const ag = await agentsApi.get(agentId);
          if (!active) return;
          if (!ag.ok) { setLoadErr(ag.error.status === 404 ? s(lang, 'agentNotFound') : errorToMessage(ag.error, lang)); return; }
          const fl: ActionFloors = Object.fromEntries(c.data.actions.map((a) => [a.key, a.approvalFloor]));
          setState(configToWizard(ag.data.agent, fl));
          setAgentLoaded(true);
        }
      } catch (e) {
        if (isSessionEnded(e)) return;
        if (active) setLoadErr(s(lang, 'somethingWrong'));
      }
    })();
    return () => { active = false; };
  }, [pid, mode, agentId, lang]);

  const steps: Step[] = mode === 'edit'
    ? ['basics', 'trigger', 'scopes', 'actions', 'review']
    : ['template', 'basics', 'trigger', 'scopes', 'actions', 'review'];
  const step = steps[stepIdx];

  // ── state mutators ──
  const patch = (p: Partial<WizardState>) => setState((prev) => ({ ...prev, ...p }));
  const toggleDay = (d: number) => setState((prev) => ({
    ...prev, daysOfWeek: prev.daysOfWeek.includes(d) ? prev.daysOfWeek.filter((x) => x !== d) : [...prev.daysOfWeek, d],
  }));
  const toggleScope = (k: ScopeKey) => setState((prev) => ({
    ...prev, scopes: prev.scopes.includes(k) ? prev.scopes.filter((x) => x !== k) : [...prev.scopes, k],
  }));
  const toggleAction = (k: string) => setState((prev) => {
    if (prev.actions.includes(k)) {
      const modes = { ...prev.modes }; delete modes[k];
      const payloads = { ...prev.payloads }; delete payloads[k];
      return { ...prev, actions: prev.actions.filter((x) => x !== k), modes, payloads };
    }
    return { ...prev, actions: [...prev.actions, k], modes: { ...prev.modes, [k]: floors[k] ?? 'suggest' } };
  });
  const setMode = (k: string, m: ActionApprovalMode) => setState((prev) => ({ ...prev, modes: { ...prev.modes, [k]: m } }));
  const setPayload = (k: string, field: string, value: unknown) => setState((prev) => {
    const cur = { ...(prev.payloads[k] ?? {}) };
    if (value === undefined) delete cur[field]; else cur[field] = value;
    return { ...prev, payloads: { ...prev.payloads, [k]: cur } };
  });
  const selectTemplate = (key: string) => {
    if (key === 'custom') { patch({ templateKey: 'custom' }); return; }
    const meta = catalog?.templates.find((tm) => tm.key === key);
    if (!meta) { patch({ templateKey: key }); return; }
    const dc = meta.defaultConfig;
    const modes: Record<string, ActionApprovalMode> = {};
    for (const ak of dc.actions) {
      const fl = floors[ak] ?? 'suggest';
      modes[ak] = clampMode(dc.approvalRules.perAction[ak] ?? dc.approvalRules.defaultMode ?? fl, fl);
    }
    const payloads = (dc.templateParams?.payloads ?? {}) as Record<string, Record<string, unknown>>;
    setState((prev) => ({
      ...prev,
      templateKey: key,
      triggerKind: dc.trigger.type,
      atLocalTime: dc.trigger.type === 'schedule' ? dc.trigger.atLocalTime : '08:00',
      daysOfWeek: dc.trigger.type === 'schedule' ? (dc.trigger.daysOfWeek ?? []) : [],
      eventName: dc.trigger.type === 'event' ? dc.trigger.eventName : '',
      scopes: [...dc.scopes],
      actions: [...dc.actions],
      modes,
      payloads,
    }));
  };

  function stepOk(st: Step): boolean {
    switch (st) {
      case 'template': return state.templateKey !== null;
      case 'basics': return state.name.trim().length > 0;
      case 'trigger': return state.triggerKind === 'schedule' ? validTime(state.atLocalTime) : state.eventName.trim().length > 0;
      case 'scopes': return true;
      case 'actions': return state.actions.length > 0 && requiredPayloadsMet(state, requiredByAction);
      case 'review': return true;
    }
  }

  const canSave = isCoreComplete(state) && requiredPayloadsMet(state, requiredByAction) && state.templateKey !== null;

  async function save(activate: boolean) {
    if (!canSave) return;
    setSaving(true); setError(null);
    const config = buildAgentConfig(state, floors);
    const name = state.name.trim();
    const description = state.description.trim();
    try {
      if (mode === 'create') {
        const r = await agentsApi.create({ propertyId: pid, name, description: description || undefined, templateKey: state.templateKey, config });
        if (!r.ok) { setError(errorToMessage(r.error, lang)); setSaving(false); return; }
        if (activate) {
          const up = await agentsApi.update(r.data.agent.id, { status: 'active' });
          if (!up.ok) { setError(errorToMessage(up.error, lang)); setSaving(false); return; }
        }
      } else if (agentId) {
        const r = await agentsApi.update(agentId, { name, description, config });
        if (!r.ok) { setError(errorToMessage(r.error, lang)); setSaving(false); return; }
      }
      router.push('/settings/agents');
    } catch (e) {
      if (isSessionEnded(e)) return;
      setError(s(lang, 'somethingWrong'));
      setSaving(false);
    }
  }

  if (loadErr) return <ErrorBanner message={loadErr} lang={lang} />;
  if (!catalog || !agentLoaded) return <Loading lang={lang} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* step indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {steps.map((st, i) => (
          <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Caps c={i === stepIdx ? T.ink : T.ink3} weight={i === stepIdx ? 700 : 500}>{s(lang, STEP_LABEL[st])}</Caps>
            {i < steps.length - 1 && <span style={{ color: T.ink3 }}>·</span>}
          </span>
        ))}
      </div>

      {/* step body */}
      <div style={{ minHeight: 220 }}>
        {step === 'template' && (
          <TemplateStep templates={catalog.templates} selected={state.templateKey} onSelect={selectTemplate} lang={lang} />
        )}
        {step === 'basics' && (
          <BasicsStep name={state.name} description={state.description} onName={(v) => patch({ name: v })} onDescription={(v) => patch({ description: v })} lang={lang} />
        )}
        {step === 'trigger' && (
          <TriggerEditor
            kind={state.triggerKind}
            atLocalTime={state.atLocalTime}
            daysOfWeek={state.daysOfWeek}
            eventName={state.eventName}
            onKind={(k) => patch({ triggerKind: k })}
            onTime={(v) => patch({ atLocalTime: v })}
            onToggleDay={toggleDay}
            onEvent={(name: AgentEventName) => patch({ eventName: name })}
            lang={lang}
          />
        )}
        {step === 'scopes' && (
          <ScopePicker scopes={catalog.scopes} selected={state.scopes} onToggle={toggleScope} lang={lang} />
        )}
        {step === 'actions' && (
          <>
            <ActionPicker
              actions={catalog.actions}
              selected={state.actions}
              modes={state.modes}
              payloads={state.payloads}
              onToggle={toggleAction}
              onMode={setMode}
              onPayload={setPayload}
              lang={lang}
            />
            {state.actions.length === 0 && (
              <p style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink3, marginTop: 10 }}>{s(lang, 'pickOneAction')}</p>
            )}
          </>
        )}
        {step === 'review' && (
          <ReviewStep state={state} actionMeta={catalog.actions} scopeMeta={catalog.scopes} floors={floors} lang={lang} />
        )}
      </div>

      {error && <ErrorBanner message={error} lang={lang} />}

      {/* footer nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderTop: `1px solid ${T.rule}`, paddingTop: 16 }}>
        <div>
          {stepIdx > 0 && (
            <Btn variant="ghost" onClick={() => setStepIdx((i) => i - 1)} disabled={saving}>
              <ChevronLeft size={14} /> {s(lang, 'back')}
            </Btn>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {step !== 'review' ? (
            <Btn variant="primary" onClick={() => setStepIdx((i) => i + 1)} disabled={!stepOk(step)}>{s(lang, 'next')}</Btn>
          ) : mode === 'create' ? (
            <>
              <Btn variant="ghost" onClick={() => save(false)} disabled={!canSave || saving}>{s(lang, 'saveDraft')}</Btn>
              <Btn variant="primary" onClick={() => save(true)} disabled={!canSave || saving}>{s(lang, 'activate')}</Btn>
            </>
          ) : (
            <Btn variant="primary" onClick={() => save(false)} disabled={!canSave || saving}>{s(lang, 'saveChanges')}</Btn>
          )}
        </div>
      </div>
    </div>
  );
}
