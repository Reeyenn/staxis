'use client';

// ═══════════════════════════════════════════════════════════════════════════
// "Standing rules" — the fourth section of the told half of the Knows tab.
//
// WHY HERE AND NOWHERE NEW. A standing rule is something a human ASSERTED, which
// is the exact definition of this half of the screen (see KnowsView's header:
// the two halves never mix an inference with an assertion). The section switch
// above is generated from TOLD_SECTIONS, so adding this cost one entry in that
// array and one line in ToldView. No new page, no new nav, no new card on
// Settings that nobody can navigate to.
//
// Reading follows the told half's rule (anyone signed in): a person governed by
// a rule can read it. Removing follows the manager rule, and the route checks it
// again, which is the check that counts.
//
// THERE IS NO ADD BUTTON, ON PURPOSE. A rule is only ever created by telling the
// companion, which reads it back and waits for a plain yes before writing. A
// text box here would be a second door into the same table with none of that.
// The empty state says how to make one instead.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { useApiResource } from '@/lib/hooks/use-api-resource';
import { readEnvelope } from '@/lib/api-envelope';
import { companionLabels, ruleAttribution } from '@/lib/companion/copy';
import { fetchWithAuth, SessionEndedError } from '@/lib/api-fetch';
import type { Lang } from './told-knowledge';

interface RuleDTO {
  id: string;
  ruleText: string;
  authorName: string | null;
  authorRole: string | null;
  createdAt: string;
}

interface RulesPayload {
  rules: RuleDTO[];
  canRemove: boolean;
}

export function ToldRules({ pid, lang }: { pid: string; canEdit: boolean; lang: Lang }) {
  void lang; // English only (founder ruling 2026-07-29). Prop kept for the section contract.
  const labels = React.useMemo(() => companionLabels(), []);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const { data, loading, error: loadError, reload } = useApiResource<RulesPayload>(
    `/api/companion/rules?pid=${encodeURIComponent(pid)}`,
    { keepDataOnError: true },
  );

  // DELETE carries a body, which the shared `toldDelete` helper does not send,
  // so this panel makes the call itself rather than bending that helper for one
  // caller. Everything else about it is the told half's usual shape.
  const removeRule = React.useCallback(async (id: string) => {
    setRemoving(id);
    setError(null);
    try {
      const res = await fetchWithAuth('/api/companion/rules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, id }),
      });
      const envelope = await readEnvelope<{ removed: { id: string } }>(res);
      if (envelope.error !== undefined) {
        setError('That did not save. Try again in a moment.');
        return;
      }
      setConfirming(null);
      await reload();
    } catch (e) {
      if (e instanceof SessionEndedError) throw e;
      setError('That did not save. Try again in a moment.');
    } finally {
      setRemoving(null);
    }
  }, [pid, reload]);

  if (loading && !data) return <div className="td-muted">{'Loading…'}</div>;

  const rules = data?.rules ?? [];
  const canRemove = data?.canRemove ?? false;

  return (
    <div>
      <div className="td-head">
        <div>
          <div className="td-h2">{labels.rulesTitle}</div>
          <div className="td-sub">{labels.rulesSub}</div>
        </div>
      </div>

      {(error || loadError) && (
        <div className="td-note td-bad">
          <span>{error ?? 'These could not be loaded. Check your connection and try again.'}</span>
        </div>
      )}

      {rules.length === 0 ? (
        <div className="td-empty">{labels.rulesEmpty}</div>
      ) : (
        <div className="td-cards">
          {rules.map((rule) => (
            <div className="td-card td-col-card" key={rule.id}>
              <div className="td-cardrow">
                <div className="td-cardmain">
                  <div className="td-cname">{rule.ruleText}</div>
                  <div className="td-cmeta">
                    {ruleAttribution({
                      authorName: rule.authorName,
                      authorRole: rule.authorRole,
                      createdAt: rule.createdAt,
                    })}
                  </div>
                </div>
                {canRemove && (
                  <div className="td-cardacts">
                    {confirming === rule.id ? (
                      <>
                        <button
                          type="button"
                          className="td-act td-danger"
                          disabled={removing === rule.id}
                          onClick={() => void removeRule(rule.id)}
                        >
                          {removing === rule.id ? 'Removing…' : 'Yes, remove'}
                        </button>
                        <button
                          type="button"
                          className="td-act"
                          onClick={() => setConfirming(null)}
                        >
                          {'Keep it'}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="td-act td-danger"
                        onClick={() => setConfirming(rule.id)}
                      >
                        {labels.rulesDelete}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
