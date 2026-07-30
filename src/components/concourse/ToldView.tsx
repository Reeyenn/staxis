'use client';

// ═══════════════════════════════════════════════════════════════════════════
// "What you've told it" — the told half of the Knows tab.
//
// Three things the hotel has ASSERTED, as opposed to the facts Staxis inferred
// on its own in the other half:
//
//   Contacts    the directory — vendors, emergency, brand, local
//   Procedures  the written SOPs
//   Documents   the file cabinet the copilot reads
//
// WHY THE TWO HALVES ARE SEPARATED THIS HARD
// A manager has to be able to tell what Staxis WORKED OUT from what somebody
// TOLD it, at a glance, always. So the halves never interleave: they are two
// exclusive panes behind one control, each with its own heading that says in
// plain words which kind of knowledge it holds. Inferred facts carry a
// confirm/edit/remove workflow; asserted ones do not need one, because a human
// already vouched for them by typing them in.
//
// CONTACTS OPENS FIRST. See defaultToldSection in told-knowledge.ts — it is a
// safety decision, not a layout preference.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { ToldContacts } from './ToldContacts';
import { ToldSops, ToldDocuments } from './ToldKnowledge';
import {
  TOLD_SECTIONS, TOLD_SECTION_LABEL, canEditTold, defaultToldSection, say,
  type Lang, type ToldSection,
} from './told-knowledge';

const S = {
  noProperty: {
    en: 'Pick a hotel to see what it has told Staxis.',

  },
  signedOut: { en: 'Sign in to see this.', },
  loading: { en: 'Loading…', },
  tablist: { en: 'What you have told Staxis', },
};

export function ToldView({ lang }: { lang: Lang }) {
  const { user, loading: authLoading } = useAuth();
  const { activePropertyId, loading: propertyLoading } = useProperty();
  const [section, setSection] = React.useState<ToldSection>(defaultToldSection);

  const canEdit = canEditTold(user?.role);

  // Both contexts start null and resolve asynchronously, and AppLayout renders
  // its children immediately rather than holding a spinner over them. Without
  // this a signed-in manager who opens the tab on a cold load is told to sign
  // in for a moment — a flat lie that then flips. Wait for the answer instead
  // of guessing it.
  if (authLoading || propertyLoading) return <div className="td-muted">{say(S.loading, lang)}</div>;
  if (!user) return <div className="td-empty">{say(S.signedOut, lang)}</div>;
  if (!activePropertyId) return <div className="td-empty">{say(S.noProperty, lang)}</div>;

  return (
    <div className="td-wrap">
      <div className="cx-seg td-seg" role="tablist" aria-label={say(S.tablist, lang)}>
        {TOLD_SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={section === s}
            className={section === s ? 'cx-on' : ''}
            onClick={() => setSection(s)}
          >
            {say(TOLD_SECTION_LABEL[s], lang)}
          </button>
        ))}
      </div>

      {/*
        Keyed by property: the documents panel reads through a FUNCTION source,
        and useApiResource treats only STRING sources as resource identities —
        a function source does not refetch when the pid inside it changes. The
        key forces a remount on a hotel switch so one hotel's cabinet can never
        be shown under another's heading.
      */}
      <div className="td-body-wrap">
        {section === 'contacts' && (
          <ToldContacts key={`c:${activePropertyId}`} pid={activePropertyId} canEdit={canEdit} lang={lang} />
        )}
        {section === 'sops' && (
          <ToldSops key={`s:${activePropertyId}`} pid={activePropertyId} canEdit={canEdit} lang={lang} />
        )}
        {section === 'documents' && (
          <ToldDocuments key={`d:${activePropertyId}`} pid={activePropertyId} canEdit={canEdit} lang={lang} />
        )}
      </div>
    </div>
  );
}

// ─── Scoped styles ──────────────────────────────────────────────────────────
// Same approach as KN_CSS on the learned half: one scoped block, concourse
// palette, no dependency on the Snow/comms style modules the panes used to
// import. Every tap target on a card is >= 44px because the contact directory
// gets used one-handed.

export const TOLD_CSS = `
.td-wrap{margin-top:18px;}
/* The section switch is the control that REACHES the emergency numbers, so it
   gets the same 44px floor as everything it leads to. .cx-seg pins its buttons
   to 26px, which is a comfortable desktop control and a poor thumb target. */
.td-seg{width:fit-content;max-width:100%;overflow-x:auto;}
.td-seg button{min-height:44px;height:auto;padding:0 15px;}
.td-body-wrap{margin-top:20px;}
.td-h2{font-size:16px;font-weight:600;color:#1F231C;}
.td-sub{font-size:12.5px;color:#8A9187;margin-top:3px;line-height:1.45;max-width:520px;}
.td-hint{font-size:11.5px;color:#8A9187;line-height:1.5;margin-top:10px;max-width:620px;}
.td-muted{font-size:13px;color:#A6ABA6;padding:18px 2px;}
.td-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;}
.td-groups{display:flex;flex-direction:column;gap:22px;margin-top:18px;}
.td-grp{}
.td-grpl{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;letter-spacing:.14em;
  text-transform:uppercase;color:#A6ABA6;margin-bottom:8px;}
.td-urgent > .td-grpl{color:#B85C3D;}
.td-sub-grp{margin-bottom:12px;}
.td-subl{font-size:11.5px;font-weight:600;color:#5C625C;margin:0 0 6px 2px;}
.td-cards{display:flex;flex-direction:column;gap:8px;margin-top:10px;}
.td-card{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:14px;padding:12px 14px;
  display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%;box-sizing:border-box;
  text-align:left;font-family:inherit;color:inherit;}
.td-urgent .td-card{border-color:rgba(184,92,61,.3);}
.td-col-card{flex-direction:column;align-items:stretch;}
.td-cardrow{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;width:100%;}
.td-clickable{cursor:pointer;transition:background .2s,border-color .2s;}
.td-clickable:hover{background:rgba(158,183,166,.10);border-color:rgba(92,122,96,.35);}
.td-clickable:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.td-cardmain{flex:1;min-width:0;}
.td-cname{font-size:14px;font-weight:600;color:#1F231C;line-height:1.35;}
.td-ccomp{font-weight:400;color:#5C625C;}
.td-cmeta{font-size:12.5px;color:#5C625C;margin-top:3px;line-height:1.45;}
.td-metarow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11.5px;color:#8A9187;}
.td-cnotes{font-size:12.5px;color:#8A9187;margin-top:5px;white-space:pre-wrap;line-height:1.45;}
.td-clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.td-prov{font-size:11.5px;color:#8A9187;margin-top:14px;}
.td-body{margin-top:14px;font-size:14px;line-height:1.6;color:#1F231C;white-space:pre-wrap;word-break:break-word;}
.td-cardacts{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;}

/* Tap targets — the emergency number is dialled one-handed, under pressure. */
.td-taps{display:flex;gap:8px;flex-wrap:wrap;margin-top:5px;}
.td-tap{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border-radius:999px;
  font-size:13.5px;font-weight:600;color:#3E5C48;background:rgba(158,183,166,.18);text-decoration:none;
  word-break:break-all;}
.td-tap:hover{background:rgba(158,183,166,.3);}
.td-tap:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.td-urgent .td-call{color:#8E432B;background:rgba(184,92,61,.12);font-size:15px;}
.td-urgent .td-call:hover{background:rgba(184,92,61,.2);}
.td-quiet{background:transparent;padding:0 2px;font-weight:400;font-size:12.5px;color:#5C625C;
  text-decoration:underline;text-underline-offset:2px;}
.td-quiet:hover{background:transparent;color:#3E5C48;}

.td-act{min-height:44px;padding:0 13px;border-radius:999px;cursor:pointer;font-size:12.5px;font-weight:500;
  border:1px solid rgba(31,35,28,.14);background:transparent;color:#5C625C;white-space:nowrap;
  display:inline-flex;align-items:center;justify-content:center;text-decoration:none;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;transition:background .2s,color .2s;}
.td-act:hover:not(:disabled){background:rgba(31,35,28,.05);}
.td-act:disabled{opacity:.5;cursor:default;}
.td-act.td-yes{background:#5C7A60;border-color:#5C7A60;color:#fff;font-weight:600;}
.td-act.td-yes:hover:not(:disabled){background:#4E6952;}
.td-act.td-danger{color:#B85C3D;}
.td-act:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.td-acts{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;}

.td-chips{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px;}
.td-chip{font-size:11px;font-weight:700;color:#3E5C48;background:rgba(158,183,166,.2);border-radius:999px;
  padding:3px 9px;}
.td-chip.td-lock{color:#5C625C;background:rgba(31,35,28,.06);}
.td-bdg{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;font-weight:600;
  letter-spacing:.05em;padding:3px 8px;border-radius:999px;white-space:nowrap;}
.td-bdg.td-good{color:#356B4C;background:rgba(53,107,76,.10);}
.td-bdg.td-warn{color:#8E432B;background:rgba(184,92,61,.12);}
.td-bdg.td-muted{color:#5C625C;background:rgba(31,35,28,.06);}
.td-bdg.td-muted-b{color:#5C625C;background:rgba(31,35,28,.06);}
.td-bdg.td-dept{color:#3E5C48;background:rgba(158,183,166,.2);}
/* "Reading scan…" has to look like work in progress, not like a settled
   state — it shares the muted tone with "Not text-searchable", which is the
   opposite claim. */
.td-bdg.td-working::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;
  background:currentColor;margin-right:6px;vertical-align:middle;animation:td-pulse 1.4s ease-in-out infinite;}
@keyframes td-pulse{0%,100%{opacity:.25;}50%{opacity:1;}}

.td-note{margin-top:12px;border-radius:12px;padding:10px 12px;font-size:12.5px;line-height:1.5;
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.td-note span{flex:1;min-width:180px;}
.td-note.td-bad{background:rgba(184,92,61,.10);color:#8E432B;}
.td-note.td-good{background:rgba(53,107,76,.09);color:#2C5740;}
.td-empty{background:#fff;border:1px dashed rgba(92,122,96,.4);border-radius:16px;padding:22px 20px;
  margin-top:18px;text-align:center;font-size:13px;color:#8A9187;line-height:1.5;}

.td-panel{background:#fff;border:1px solid rgba(31,35,28,.08);border-radius:16px;padding:16px 18px;margin-top:12px;}
.td-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.td-row{display:flex;gap:12px;flex-wrap:wrap;}
.td-col{flex:1;min-width:170px;display:flex;flex-direction:column;}
.td-lab{display:block;font-size:11.5px;font-weight:600;color:#5C625C;margin:12px 0 5px;}
.td-in{width:100%;box-sizing:border-box;min-height:44px;border-radius:11px;border:1px solid rgba(31,35,28,.12);
  background:#FCFDFB;padding:10px 12px;color:#1F231C;font-size:13.5px;line-height:1.45;outline:none;
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.td-in:focus{border-color:rgba(92,122,96,.55);}
.td-in::placeholder{color:#A6ABA6;}
.td-ta{resize:vertical;min-height:72px;}
.td-ta.td-tall{min-height:180px;}
.td-sel{min-height:44px;border-radius:999px;border:1px solid rgba(31,35,28,.14);background:#fff;color:#1F231C;
  font-size:12.5px;padding:0 10px;font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;
  cursor:pointer;}
.td-uploadbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.td-docedit{border-top:1px solid rgba(31,35,28,.07);margin-top:12px;padding-top:12px;display:flex;gap:10px;
  align-items:flex-end;flex-wrap:wrap;}
.td-foldbtn{flex:1;min-width:0;display:flex;align-items:center;gap:9px;background:transparent;border:none;
  cursor:pointer;text-align:left;padding:0;font:inherit;color:inherit;min-height:44px;}
.td-foldbtn:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}

@media (prefers-reduced-motion: reduce){
  .td-bdg.td-working::before{animation:none;opacity:.7;}
}

@media (max-width:600px){
  .td-head{flex-direction:column;align-items:stretch;}
  .td-card{flex-direction:column;align-items:stretch;}
  .td-cardrow{flex-direction:column;align-items:stretch;}
  .td-cardacts{margin-top:10px;}
}
`;

export function ToldStyle() {
  return <style dangerouslySetInnerHTML={{ __html: TOLD_CSS }} />;
}
