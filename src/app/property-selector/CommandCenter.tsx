'use client';

// ═══════════════════════════════════════════════════════════════════════════
// THE COMMAND CENTRE — one screen, two readers.
//
// It is the first thing anyone sees after signing in, and it has to be two
// different screens without being two components, because the SAME person can
// change category (a GM promoted to oversight) and because a second screen is
// a second place for "which hotels can I open" to be wrong.
//
//   A HOTEL PERSON — a GM with one hotel, a housekeeper who covers two — gets a
//   door. Name, room count, tap, in. No chips, no counts, no status. A picker
//   that tries to be a dashboard makes somebody read a screen on the way to the
//   screen they wanted.
//
//   A COMPANY PERSON — owner, VP, finance — gets a command centre. The same
//   hotels, ranked by which one wants them this morning, each carrying at most
//   one health chip; their portfolio queue above; and, only where the company
//   turned it on, one line to ask about all of them at once.
//
// ─── WHAT THIS FILE MUST NOT DO ───────────────────────────────────────────
//   1. Invent a status. Every chip comes from the server, which computes it
//      from that hotel's real findings and its real last run. A hotel Staxis
//      has never checked shows NO chip — never "quiet", which is a claim about
//      having looked. There is no client-side default.
//   2. Read Supabase directly. `findings`, `finding_runs` and
//      `organization_memberships` are all deny-all to the browser, so a direct
//      read returns [] with a 200 and this screen would quietly show a calm
//      morning at a burning hotel. Everything comes from
//      /api/property-selector/bootstrap (service-role behind requireSession).
//   3. Render an empty list on a failed read. An empty picker says "you have no
//      hotels"; a failed read has not earned that sentence.
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

import { AssistantMarkdown } from '@/components/agent/AssistantMarkdown';
import {
  useAgentChat,
  type PortfolioActiveScope,
  type PortfolioScopeDisclosure,
} from '@/components/agent/useAgentChat';
import type { DisplayMessage } from '@/components/agent/MessageList';
import { hotelChipLabel, type HotelChip } from '@/lib/company/vp-queue';
import { companyRowLabel } from '@/lib/portfolio-ui/scope-switcher';
import { CxIcon } from '@/components/concourse/icons';

export type Lang = 'en' | 'es';

export interface PickerHotel {
  propertyId: string;
  name: string;
  totalRooms: number;
  chip: HotelChip | null;
  onboardingCompletedAt: string | null;
  onboardingState: string | null;
  onboardingPromptShownAt: string | null;
}

export interface PickerCompany {
  organizationId: string;
  organizationName: string | null;
  companyRole: 'owner' | 'regional_manager';
  hotelCount: number;
  chatAvailable?: boolean;
  /** Fresh receipt carries org-wide queue provenance. Omitted/false fails closed. */
  queueAvailable?: boolean;
}

export interface CommandCenterPayload {
  hotels: PickerHotel[];
  reachableHotelCount: number;
  hasCompanyHat: boolean;
  company: PickerCompany | null;
  companies: PickerCompany[];
  requiresCompanySelection: boolean;
  chat: { available: boolean };
  signedInAs: string | null;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

type Bi = { en: string };
const pick = (b: Bi, lang: Lang) => (b.en);

const S = {
  pickTitle: { en: 'Choose a hotel', },
  companyPickTitle: { en: 'Choose a company', },
  companyPickLabel: { en: 'Management company', },
  companyPickPlaceholder: { en: 'Select a company', },
  companyPickHelp: {
    en: 'Choose whose hotels you want to work with. Hotel data and Staxis conversations stay separate between companies.',

  },
  companyFallback: { en: 'Management company', },
  companyTitle: { en: 'Your hotels', },
  rooms: { en: 'rooms', },
  room: { en: 'room', },
  signOut: { en: 'Sign out', },
  signedInAs: { en: 'Signed in as', },
  queueTitle: { en: 'Your morning', },
  queueSub: {
    en: 'Everything from your hotels that reached you, in one queue.',

  },
  askPlaceholder: {
    en: 'Ask about all your hotels…',

  },
  askLabel: { en: 'Ask across your hotels', },
  askSend: { en: 'Ask', },
  askThinking: { en: 'Reading your hotels…', },
  askNew: { en: 'New chat', },
  askHistory: { en: 'Saved portfolio chats', },
  askHistoryPlaceholder: { en: 'Open a saved chat', },
  askHistoryEmpty: { en: 'No saved portfolio chats yet.', },
  askHistoryLoading: { en: 'Loading saved chats…', },
  askConversationLoading: { en: 'Restoring this chat and its scopes…', },
  askConversation: { en: 'Portfolio conversation', },
  askFailed: {
    en: 'Staxis could not answer just now. Nothing about your hotels changed.',

  },
  loadFailed: {
    en: 'Staxis could not load your hotels just now. This is not "you have none".',

  },
  retry: { en: 'Try again', },
  hotelsWord: { en: 'hotels', },
  hotelWord: { en: 'hotel', },
} as const;

/**
 * Number agreement, both languages, both numbers. "1 need you" and
 * "1 tranquilos" are the kind of sentence that makes a careful reader stop
 * trusting the careful numbers next to them, so each count carries its own
 * singular and plural rather than one shared label.
 */
const SUMMARY_WORDS = {
  needs: {
    one: { en: 'needs you', },
    many: { en: 'need you', },
  },
  waiting: {
    one: { en: 'waiting', },
    many: { en: 'waiting', },
  },
  quiet: {
    one: { en: 'quiet', },
    many: { en: 'quiet', },
  },
} as const;

/**
 * "2 need you · 3 waiting · 7 quiet" — the company line, assembled from the
 * chips themselves so it can never disagree with the cards under it. Hotels
 * with no chip are counted in NOTHING: a building Staxis has not checked is
 * not quiet, and padding the sentence with it would be the same lie the chip
 * rule exists to prevent.
 */
export function chipSummary(hotels: readonly PickerHotel[], lang: Lang): string | null {
  const tally = { needs: 0, waiting: 0, quiet: 0 };
  for (const hotel of hotels) {
    if (hotel.chip?.kind === 'needs_you') tally.needs += 1;
    else if (hotel.chip?.kind === 'waiting') tally.waiting += 1;
    else if (hotel.chip?.kind === 'quiet') tally.quiet += 1;
  }
  const parts: string[] = [];
  for (const key of ['needs', 'waiting', 'quiet'] as const) {
    const n = tally[key];
    if (n === 0) continue;
    parts.push(`${n} ${pick(n === 1 ? SUMMARY_WORDS[key].one : SUMMARY_WORDS[key].many, lang)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ─── Styles ─────────────────────────────────────────────────────────────────
//
// Scoped cc-* classes injected the same way every concourse surface does it
// (see concourse-css.tsx): plain global CSS imports are restricted to the root
// layout in the App Router, and :hover / :active / media queries cannot be
// expressed as inline styles. Tokens are the locked Snow palette.
//
// NO DARK MODE. The app has none — there is no theme toggle, no
// prefers-color-scheme rule anywhere in src/, and a single screen that went
// dark on a dark-mode phone would be the only one that did.

const CC_CSS = `
.cc-wrap{min-height:100dvh;display:flex;flex-direction:column;align-items:center;
  padding:max(28px,env(safe-area-inset-top)) 18px 40px;
  background:radial-gradient(ellipse 900px 460px at 50% 0%,#FFFFFF 0%,#F5F7F4 100%);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;color:#1F231C;}
.cc-col{width:100%;max-width:460px;display:flex;flex-direction:column;}
.cc-col.cc-wide{max-width:760px;}

/* ── Header ── */
.cc-head{display:flex;flex-direction:column;gap:6px;margin:14px 2px 22px;}
.cc-mark{width:38px;height:38px;border-radius:13px;display:grid;place-items:center;
  background:#3E5C48;color:#fff;margin-bottom:10px;
  box-shadow:0 12px 26px -16px rgba(62,92,72,.75);}
.cc-eyebrow{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;
  letter-spacing:.16em;text-transform:uppercase;color:#8A9187;}
.cc-title{font-size:26px;font-weight:650;letter-spacing:-.025em;line-height:1.12;margin:0;}
.cc-summary{font-size:13px;color:#5C625C;letter-spacing:.005em;}

/* ── Company boundary ── */
.cc-company-help{max-width:520px;margin:1px 0 0;font-size:13px;line-height:1.55;color:#5C625C;}
.cc-company-field{display:flex;flex-direction:column;gap:7px;margin:0 0 20px;}
.cc-company-field label{font-size:12px;font-weight:620;color:#5C625C;letter-spacing:.005em;}
.cc-company-select-wrap{position:relative;}
.cc-company-select{width:100%;height:44px;appearance:none;-webkit-appearance:none;
  border:1px solid #797F78;border-radius:10px;background:#fff;color:#1F231C;
  padding:0 42px 0 13px;font:inherit;font-size:14px;line-height:20px;cursor:pointer;
  transition:border-color .2s cubic-bezier(.2,0,0,1),box-shadow .2s cubic-bezier(.2,0,0,1);}
.cc-company-select:hover{border-color:#3E5C48;}
.cc-company-select:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;border-color:#3E5C48;}
.cc-company-select:disabled{opacity:.38;cursor:not-allowed;}
.cc-company-chevron{pointer-events:none;position:absolute;right:14px;top:50%;transform:translateY(-50%);
  color:#5C625C;display:grid;place-items:center;}
.cc-company-count{font-size:11.5px;line-height:1.45;color:#8A9187;}
@media(max-width:479px){.cc-company-select{height:48px;}}

/* ── The portfolio entry ── */
.cc-portfolio{display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;
  background:#fff;border:1px solid rgba(62,92,72,.24);border-radius:18px;padding:15px 16px;
  box-shadow:0 12px 30px -24px rgba(31,35,28,.55);
  transition:border-color .18s ease,box-shadow .28s ease,transform .18s ease;}
.cc-portfolio:hover{border-color:rgba(62,92,72,.5);box-shadow:0 16px 34px -22px rgba(31,35,28,.6);}
.cc-portfolio:active{transform:scale(.995);}
.cc-portfolio:focus-visible{outline:2px solid #3E5C48;outline-offset:3px;}
.cc-pf-mark{width:38px;height:38px;border-radius:13px;flex-shrink:0;display:grid;place-items:center;
  color:#3E5C48;background:rgba(158,183,166,.24);}
.cc-pf-body{flex:1;min-width:0;}
.cc-pf-title{font-size:14.5px;font-weight:620;letter-spacing:-.01em;}
.cc-pf-sub{font-size:12.5px;color:#5C625C;margin-top:3px;line-height:1.45;}
.cc-arrow{color:#8A9187;flex-shrink:0;transition:transform .18s ease,color .18s ease;}
.cc-portfolio:hover .cc-arrow,.cc-hotel:hover .cc-arrow{transform:translateX(3px);color:#3E5C48;}
.cc-company-all{display:flex;align-items:center;gap:14px;width:100%;text-align:left;cursor:pointer;
  min-height:58px;background:#fff;border:1px solid rgba(62,92,72,.24);border-radius:16px;
  padding:12px 15px;font:inherit;color:inherit;margin-bottom:10px;
  transition:border-color .18s ease,box-shadow .26s ease,transform .18s ease;}
.cc-company-all:hover{border-color:rgba(62,92,72,.5);box-shadow:0 12px 28px -24px rgba(31,35,28,.55);}
.cc-company-all:active{transform:scale(.99);}
.cc-company-all:focus-visible{outline:2px solid #3E5C48;outline-offset:3px;}
.cc-company-all .cc-hotel-mark{color:#3E5C48;background:rgba(158,183,166,.24);}

/* ── Ask across hotels ── */
.cc-ask{margin-top:10px;background:#fff;border:1px solid rgba(31,35,28,.10);border-radius:18px;
  padding:13px 14px;}
.cc-ask-head{display:flex;align-items:center;gap:8px;margin:0 1px 10px;}
.cc-ask-title{font-size:12px;font-weight:620;color:#5C625C;letter-spacing:.005em;}
.cc-ask-new{margin-left:auto;border:0;background:transparent;color:#5C625C;cursor:pointer;
  min-height:32px;padding:4px 6px;border-radius:7px;font:inherit;font-size:11.5px;
  text-decoration:underline;text-decoration-color:rgba(62,92,72,.28);text-underline-offset:3px;}
.cc-ask-new:hover{color:#1F231C;text-decoration-color:#3E5C48;}
.cc-ask-new:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.cc-ask-history{display:flex;align-items:center;gap:9px;margin:0 1px 11px;min-height:36px;}
.cc-ask-history-label{flex-shrink:0;font-size:11px;font-weight:600;color:#5C625C;}
.cc-ask-history-select{min-width:0;max-width:100%;height:36px;flex:1;border:1px solid rgba(31,35,28,.14);
  border-radius:10px;background:#FAFBF9;color:#1F231C;padding:0 30px 0 10px;font:inherit;font-size:12px;
  cursor:pointer;transition:border-color .15s ease-out,background .15s ease-out;}
.cc-ask-history-select:hover{border-color:rgba(62,92,72,.42);background:#fff;}
.cc-ask-history-select:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
.cc-ask-history-select:disabled{opacity:.58;cursor:default;}
.cc-ask-history-status{margin:0 1px 10px;color:#8A9187;font-size:11px;line-height:1.45;}
.cc-ask-row{display:flex;align-items:center;gap:9px;}
.cc-ask-spark{color:#C99644;flex-shrink:0;display:grid;place-items:center;}
.cc-ask-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font:inherit;
  font-size:14px;color:#1F231C;padding:5px 0;}
.cc-ask-input::placeholder{color:#A6ABA6;}
.cc-ask-send{height:36px;min-width:52px;padding:0 14px;border-radius:999px;border:none;cursor:pointer;
  background:#3E5C48;color:#fff;font:inherit;font-size:12.5px;font-weight:600;flex-shrink:0;
  transition:opacity .15s ease-out,background .15s ease-out,transform .15s ease-out;}
.cc-ask-send:disabled{opacity:.4;cursor:default;}
.cc-ask-send:not(:disabled):hover{background:#334C3C;}
.cc-ask-send:not(:disabled):active{transform:scale(.98);}
.cc-ask-send:focus-visible,.cc-ask-input:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
/* On a phone the button and the placeholder cannot share one line without
   clipping the question mid-word, so the button drops to its own full-width
   row. A VP asking from a car park gets a bigger target for it, too. */
@media(max-width:479px){
  .cc-ask-history{align-items:flex-start;flex-direction:column;gap:5px;}
  .cc-ask-history-select{width:100%;height:44px;}
  .cc-ask-row{flex-wrap:wrap;row-gap:10px;}
  .cc-ask-send{flex:1 0 100%;height:44px;}
}
.cc-ask-thread{margin:0 -2px 12px;padding:12px 2px 2px;border-top:1px solid rgba(31,35,28,.07);
  border-bottom:1px solid rgba(31,35,28,.07);max-height:420px;overflow-y:auto;
  overscroll-behavior:contain;scrollbar-gutter:stable;}
.cc-ask-turn{padding:0 2px 14px;}
.cc-ask-user{width:fit-content;max-width:86%;margin:0 0 10px auto;padding:8px 11px;
  border-radius:13px 13px 4px 13px;background:#1F231C;color:#fff;font-size:13px;
  line-height:1.48;white-space:pre-wrap;overflow-wrap:anywhere;}
.cc-ask-scope{display:flex;align-items:flex-start;gap:7px;margin:0 0 8px;color:#5C625C;
  font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10.5px;line-height:1.5;}
.cc-ask-scope::before{content:'';width:6px;height:6px;border-radius:50%;margin-top:5px;flex:none;
  background:#9EB7A6;box-shadow:0 0 0 3px rgba(158,183,166,.16);}
.cc-ask-answer{font-size:13.5px;line-height:1.62;color:#1F231C;overflow-wrap:anywhere;}
.cc-ask-status{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:11px;
  color:#8A9187;letter-spacing:.02em;}
.cc-ask-error{margin:0 2px 10px;padding:9px 10px;border-radius:9px;
  color:#8E3F26;background:rgba(184,92,61,.08);font-size:12px;line-height:1.5;}
/* The answer is MARKDOWN (AssistantMarkdown). A model comparing hotels reaches
   for a pipe table almost every time, so these are load-bearing, not polish:
   without them the VP reads "| Hotel | Open |" as literal characters. Scoped to
   .cc-ask-answer so nothing else on the screen inherits them. */
.cc-ask-answer>*:first-child{margin-top:0;}
.cc-ask-answer>*:last-child{margin-bottom:0;}
.cc-ask-answer p{margin:0 0 8px;}
.cc-ask-answer strong{font-weight:640;}
.cc-ask-answer ul,.cc-ask-answer ol{margin:4px 0 9px;padding-left:19px;}
.cc-ask-answer li{margin:2px 0;}
.cc-ask-answer code{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:.92em;
  background:rgba(31,35,28,.05);padding:1px 4px;border-radius:4px;}
.cc-ask-answer a{color:#3E5C48;text-decoration:underline;}
/* A twenty-hotel table cannot shrink to a phone, so it scrolls inside its own
   box rather than pushing the whole screen sideways. */
.cc-ask-answer table{display:block;overflow-x:auto;max-width:100%;
  border-collapse:collapse;margin:8px 0;font-size:12.5px;}
.cc-ask-answer th,.cc-ask-answer td{padding:5px 10px;text-align:left;white-space:nowrap;
  border-bottom:1px solid rgba(31,35,28,.07);}
.cc-ask-answer th{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:10px;
  text-transform:uppercase;letter-spacing:.06em;color:#5C625C;font-weight:500;
  border-bottom:1px solid rgba(31,35,28,.14);}

/* ── Hotels ── */
.cc-eyebrow-row{margin:26px 2px 10px;}
.cc-grid{display:grid;grid-template-columns:1fr;gap:10px;}
@media(min-width:640px){.cc-grid.cc-two{grid-template-columns:1fr 1fr;}}
.cc-hotel{display:flex;align-items:center;gap:13px;width:100%;text-align:left;cursor:pointer;
  min-height:74px;background:#fff;border:1px solid rgba(31,35,28,.09);border-radius:16px;
  padding:14px 15px;font:inherit;color:inherit;
  transition:border-color .18s ease,box-shadow .26s ease,transform .18s ease;}
.cc-hotel:hover{border-color:rgba(62,92,72,.34);box-shadow:0 12px 28px -24px rgba(31,35,28,.55);}
.cc-hotel:active{transform:scale(.99);}
.cc-hotel:focus-visible{outline:2px solid #3E5C48;outline-offset:3px;}
.cc-hotel-mark{width:36px;height:36px;border-radius:12px;flex-shrink:0;display:grid;place-items:center;
  color:#5C625C;background:rgba(31,35,28,.045);}
.cc-hotel.cc-alert .cc-hotel-mark{color:#B85C3D;background:rgba(184,92,61,.10);}
.cc-hotel-body{flex:1;min-width:0;}
.cc-hotel-name{font-size:15px;font-weight:600;letter-spacing:-.012em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cc-hotel-sub{font-size:12px;color:#8A9187;margin-top:3px;display:flex;align-items:center;gap:7px;
  flex-wrap:wrap;}

/* ── Chips ── */
.cc-chip{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:9.5px;font-weight:700;
  letter-spacing:.09em;text-transform:uppercase;border-radius:999px;padding:3px 8px;
  border:1px solid transparent;white-space:nowrap;}
.cc-chip-needs_you{color:#8E3F26;background:rgba(184,92,61,.11);border-color:rgba(184,92,61,.26);}
.cc-chip-waiting{color:#8A5A22;background:rgba(176,124,60,.11);border-color:rgba(176,124,60,.26);}
.cc-chip-quiet{color:#3E5C48;background:rgba(158,183,166,.20);border-color:rgba(158,183,166,.34);}
.cc-chip-stale{color:#7B817B;background:rgba(31,35,28,.045);border-color:rgba(31,35,28,.08);}

/* ── Footer ── */
.cc-foot{margin-top:26px;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:0 2px;flex-wrap:wrap;}
.cc-who{font-size:12px;color:#A6ABA6;}
.cc-signout{background:transparent;border:none;padding:6px 0;cursor:pointer;font:inherit;
  font-size:12.5px;color:#5C625C;text-decoration:underline;
  text-decoration-color:rgba(62,92,72,.3);text-underline-offset:3px;}
.cc-signout:hover{color:#1F231C;text-decoration-color:#3E5C48;}
.cc-signout:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;border-radius:4px;}

/* ── Failure ── */
.cc-fail{background:#FAFBF9;border:1px solid rgba(31,35,28,.08);border-radius:16px;
  padding:18px 17px;font-size:13px;line-height:1.6;color:#5C625C;}
.cc-fail button{margin-top:10px;height:32px;padding:0 14px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(62,92,72,.3);background:#fff;font:inherit;font-size:12.5px;color:#1F231C;}
.cc-fail button:hover{border-color:#3E5C48;}
@media(prefers-reduced-motion:reduce){
  .cc-ask-send,.cc-ask-new,.cc-ask-history-select,.cc-company-select{transition:none;}
  .cc-ask-send:not(:disabled):active{transform:none;}
}
`;

function CcStyle() {
  return <style dangerouslySetInnerHTML={{ __html: CC_CSS }} />;
}

function Arrow() {
  return (
    <svg className="cc-arrow" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 12h14M13 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth={1.8}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── The ask line ───────────────────────────────────────────────────────────

export interface PortfolioChatTurnView {
  user: string;
  assistant: string;
  scope: PortfolioActiveScope | null;
}

/**
 * Join the shared hook's message stream to its immutable per-turn scope
 * receipts. Portfolio mode is read-only, so tool rows are intentionally not
 * rendered on this compact management surface.
 */
export function buildPortfolioChatTurns(
  messages: readonly DisplayMessage[],
  disclosures: readonly PortfolioScopeDisclosure[],
): PortfolioChatTurnView[] {
  const scopeByTurn = new Map(disclosures.map(item => [item.turn, item.scope]));
  const turns: PortfolioChatTurnView[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const turn = turns.length;
      turns.push({
        user: message.text,
        assistant: '',
        scope: scopeByTurn.get(turn) ?? null,
      });
      continue;
    }
    if (message.role !== 'assistant' || message.toolName || !message.text || turns.length === 0) {
      continue;
    }
    const last = turns[turns.length - 1];
    last.assistant = last.assistant
      ? `${last.assistant}\n${message.text}`
      : message.text;
  }
  // A scope event normally arrives after the optimistic user message, but
  // React may batch them. Resolve once more so either update order is correct.
  return turns.map((turn, index) => ({
    ...turn,
    scope: scopeByTurn.get(index) ?? turn.scope,
  }));
}

export function formatPortfolioScopeDisclosure(
  scope: PortfolioActiveScope,
  lang: Lang,
): string {
  const chosenScope = scope.hotelNames.length === 1
    ? scope.hotelNames[0]
    : scope.selectorLabel;

  return [
    scope.organizationName,
    `Scope: ${chosenScope}`,
    `${scope.selectedHotelCount} of ${scope.authorizedHotelCount} authorized hotels`,
    `${scope.coverage.reported} of ${scope.coverage.total} reported`,
    ...(scope.hotelNamesOmitted > 0 ? [`${scope.hotelNames.length} names shown; ${scope.hotelNamesOmitted} more in scope`] : []),
    ...(scope.coverage.omitted > 0 ? [`${scope.coverage.omitted} omitted`] : []),
  ].join(' · ');
}

/**
 * A single, reusable management-company conversation. The hook carries the
 * conversation id between turns, so the manager can safely move from all
 * hotels → a region → one named hotel → all hotels without changing surfaces.
 * Its organization-keyed reset prevents that context from crossing companies.
 */
function AskAcrossHotels({ lang, organizationId }: { lang: Lang; organizationId: string }) {
  const [question, setQuestion] = React.useState('');
  const threadRef = React.useRef<HTMLDivElement>(null);
  const historySelectId = React.useId();
  const {
    messages,
    conversations,
    conversationId,
    scopeDisclosures,
    loadingConversations,
    conversationsLoaded,
    loadingConversation,
    streaming,
    error,
    sendMessage,
    startNew,
    loadConversation,
  } = useAgentChat({
    mode: 'portfolio',
    organizationId,
    propertyId: null,
    active: true,
  });
  const turns = buildPortfolioChatTurns(messages, scopeDisclosures);

  React.useEffect(() => {
    // The hook clears conversation state on a company switch; clear draft text
    // too so absolutely no company-A chat state appears under company B.
    setQuestion('');
  }, [organizationId]);

  React.useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, scopeDisclosures, streaming]);

  const send = async () => {
    const text = question.trim();
    if (!text || streaming) return;
    setQuestion('');
    await sendMessage(text);
  };

  return (
    <section
      className="cc-ask"
      aria-label={pick(S.askConversation, lang)}
      aria-busy={streaming || loadingConversations || loadingConversation}
    >
      <div className="cc-ask-head">
        <span className="cc-ask-spark" aria-hidden>
          <CxIcon name="staxis" size={16} />
        </span>
        <span className="cc-ask-title">{pick(S.askLabel, lang)}</span>
        {turns.length > 0 && !streaming && (
          <button type="button" className="cc-ask-new" onClick={startNew}>
            {pick(S.askNew, lang)}
          </button>
        )}
      </div>

      <div className="cc-ask-history">
        <label className="cc-ask-history-label" htmlFor={historySelectId}>
          {pick(S.askHistory, lang)}
        </label>
        <select
          id={historySelectId}
          className="cc-ask-history-select"
          value={conversationId ?? ''}
          disabled={streaming || loadingConversations || loadingConversation}
          onChange={(event) => {
            const nextId = event.target.value;
            if (!nextId) startNew();
            else void loadConversation(nextId);
          }}
        >
          <option value="">{pick(S.askHistoryPlaceholder, lang)}</option>
          {conversations.map((conversation) => (
            <option value={conversation.id} key={conversation.id}>
              {conversation.title?.trim() || pick(S.askConversation, lang)}
            </option>
          ))}
        </select>
      </div>

      {(loadingConversations
        || loadingConversation
        || (conversationsLoaded && conversations.length === 0)) && (
        <div className="cc-ask-history-status" role="status" aria-live="polite">
          {loadingConversation
            ? pick(S.askConversationLoading, lang)
            : loadingConversations
              ? pick(S.askHistoryLoading, lang)
              : pick(S.askHistoryEmpty, lang)}
        </div>
      )}

      {turns.length > 0 && (
        <div
          ref={threadRef}
          className="cc-ask-thread"
          role="log"
          aria-label={pick(S.askConversation, lang)}
        >
          {turns.map((turn, index) => {
            const latest = index === turns.length - 1;
            return (
              <article className="cc-ask-turn" key={index}>
                <div className="cc-ask-user">{turn.user}</div>
                {turn.scope && (
                  <div className="cc-ask-scope" data-active-scope="true">
                    {formatPortfolioScopeDisclosure(turn.scope, lang)}
                  </div>
                )}
                <div className="cc-ask-answer">
                  {turn.assistant
                    // The SAME renderer the per-hotel copilot uses. Portfolio
                    // comparisons regularly contain markdown tables.
                    ? <AssistantMarkdown text={turn.assistant} />
                    : latest && streaming
                      ? (
                          <span className="cc-ask-status" role="status" aria-live="polite">
                            {pick(S.askThinking, lang)}
                          </span>
                        )
                      : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {error && (
        <div className="cc-ask-error" role="alert">
          {error || pick(S.askFailed, lang)}
        </div>
      )}

      <form
        className="cc-ask-row"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <input
          className="cc-ask-input"
          value={question}
          aria-label={pick(S.askLabel, lang)}
          placeholder={pick(S.askPlaceholder, lang)}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          type="submit"
          className="cc-ask-send"
          disabled={streaming || question.trim().length === 0}
        >
          {pick(S.askSend, lang)}
        </button>
      </form>
    </section>
  );
}

// ─── The screen ─────────────────────────────────────────────────────────────

export interface CommandCenterViewProps {
  payload: CommandCenterPayload;
  lang: Lang;
  onOpenHotel: (hotel: PickerHotel) => void;
  onOpenCompany?: (organizationId: string) => void;
  onSelectCompany?: (organizationId: string) => void;
  onSignOut: () => void;
}

function CompanyPicker({
  companies,
  selectedOrganizationId,
  lang,
  onSelectCompany,
}: {
  companies: readonly PickerCompany[];
  selectedOrganizationId: string | null;
  lang: Lang;
  onSelectCompany?: (organizationId: string) => void;
}) {
  if (companies.length < 2) return null;
  const labelId = 'cc-company-select-label';
  const helpId = 'cc-company-select-help';
  const selected = companies.find((company) => company.organizationId === selectedOrganizationId);
  return (
    <div className="cc-company-field">
      <label id={labelId} htmlFor="cc-company-select">
        {pick(S.companyPickLabel, lang)}
      </label>
      <div className="cc-company-select-wrap">
        <select
          id="cc-company-select"
          className="cc-company-select"
          value={selectedOrganizationId ?? ''}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          disabled={!onSelectCompany}
          onChange={(event) => {
            if (event.target.value) onSelectCompany?.(event.target.value);
          }}
        >
          {!selectedOrganizationId && (
            <option value="" disabled>{pick(S.companyPickPlaceholder, lang)}</option>
          )}
          {companies.map((company) => (
            <option key={company.organizationId} value={company.organizationId}>
              {company.organizationName ?? pick(S.companyFallback, lang)}
              {` · ${company.hotelCount} ${pick(company.hotelCount === 1 ? S.hotelWord : S.hotelsWord, lang)}`}
            </option>
          ))}
        </select>
        <span className="cc-company-chevron" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path
              d="m7 10 5 5 5-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>
      <span id={helpId} className="cc-company-count">
        {selected
          ? `${selected.hotelCount} ${pick(selected.hotelCount === 1 ? S.hotelWord : S.hotelsWord, lang)}`
          : pick(S.companyPickHelp, lang)}
      </span>
    </div>
  );
}

/**
 * The screen, given data. Split from the fetching page so both audiences can be
 * exercised with real payloads and no session in the way.
 */
export function CommandCenterView({
  payload,
  lang,
  onOpenHotel,
  onOpenCompany,
  onSelectCompany,
  onSignOut,
}: CommandCenterViewProps) {
  const { hotels, company, companies, requiresCompanySelection, chat } = payload;
  const summary = company ? chipSummary(hotels, lang) : null;
  const choosingCompany = requiresCompanySelection && !company;

  return (
    <div className="cc-wrap">
      <CcStyle />
      <div className={company || choosingCompany ? 'cc-col cc-wide' : 'cc-col'}>

        <header className="cc-head">
          <div className="cc-mark" aria-hidden><CxIcon name="staxis" size={18} /></div>
          <div className="cc-eyebrow">
            {company ? (company.organizationName ?? pick(S.companyFallback, lang)) : 'Staxis'}
          </div>
          <h1 className="cc-title">
            {pick(choosingCompany ? S.companyPickTitle : company ? S.companyTitle : S.pickTitle, lang)}
          </h1>
          {summary && <div className="cc-summary">{summary}</div>}
          {choosingCompany && <p className="cc-company-help">{pick(S.companyPickHelp, lang)}</p>}
        </header>

        {(choosingCompany || company) && (
          <CompanyPicker
            companies={companies}
            selectedOrganizationId={company?.organizationId ?? null}
            lang={lang}
            onSelectCompany={onSelectCompany}
          />
        )}

        {company && onOpenCompany && (
          <button
            type="button"
            className="cc-company-all"
            onClick={() => onOpenCompany(company.organizationId)}
            aria-label={companyRowLabel(company.organizationName)}
          >
            <span className="cc-hotel-mark" aria-hidden><CxIcon name="staxis" size={17} /></span>
            <span className="cc-hotel-body">
              <span className="cc-hotel-name" style={{ display: 'block' }}>
                {companyRowLabel(company.organizationName)}
              </span>
              <span className="cc-hotel-sub">Open the company view</span>
            </span>
            <Arrow />
          </button>
        )}

        {company && (
          <>
            {/* The portfolio queue lives in the Staxis tab; a company-scope
                reader who opens it gets PortfolioQueueView rather than a
                hotel's feed, resolved server-side from their own hats. */}
            {company.queueAvailable === true && (
              <a
                className="cc-portfolio"
                href={`/feed?organizationId=${encodeURIComponent(company.organizationId)}`}
              >
                <span className="cc-pf-mark" aria-hidden><CxIcon name="staxis" size={17} /></span>
                <span className="cc-pf-body">
                  <span className="cc-pf-title" style={{ display: 'block' }}>
                    {pick(S.queueTitle, lang)}
                  </span>
                  <span className="cc-pf-sub" style={{ display: 'block' }}>
                    {pick(S.queueSub, lang)}
                  </span>
                </span>
                <Arrow />
              </a>
            )}

            {chat.available && (
              <AskAcrossHotels
                key={company.organizationId}
                lang={lang}
                organizationId={company.organizationId}
              />
            )}
          </>
        )}

        {/* The count earns the label. A hotel person's heading already says
            "choose a hotel", and repeating it over the list they can see is
            two lines of chrome on the way to a two-item list. */}
        {company && (
          <div className="cc-eyebrow cc-eyebrow-row">
            {`${hotels.length} ${pick(hotels.length === 1 ? S.hotelWord : S.hotelsWord, lang)}`}
          </div>
        )}

        <div
          className={company && hotels.length > 3 ? 'cc-grid cc-two' : 'cc-grid'}
          style={company || choosingCompany ? undefined : { marginTop: 4 }}
        >
          {hotels.map((hotel) => (
            <button
              key={hotel.propertyId}
              type="button"
              data-chip={hotel.chip?.kind ?? 'none'}
              className={hotel.chip?.kind === 'needs_you' ? 'cc-hotel cc-alert' : 'cc-hotel'}
              onClick={() => onOpenHotel(hotel)}
            >
              <span className="cc-hotel-mark" aria-hidden><CxIcon name="hotel" size={17} /></span>
              <span className="cc-hotel-body">
                <span className="cc-hotel-name" style={{ display: 'block' }}>{hotel.name}</span>
                <span className="cc-hotel-sub">
                  {hotel.totalRooms > 0 && (
                    <span>
                      {hotel.totalRooms} {pick(hotel.totalRooms === 1 ? S.room : S.rooms, lang)}
                    </span>
                  )}
                  {/* No chip renders NOTHING — not a grey "unknown" pill. A
                      hotel Staxis has never checked has no status to report. */}
                  {hotel.chip && (
                    <span className={`cc-chip cc-chip-${hotel.chip.kind}`}>
                      {hotelChipLabel(hotel.chip, lang)}
                    </span>
                  )}
                </span>
              </span>
              <Arrow />
            </button>
          ))}
        </div>

        <div className="cc-foot">
          <span className="cc-who">
            {payload.signedInAs
              ? `${pick(S.signedInAs, lang)} ${payload.signedInAs}`
              : ''}
          </span>
          <button type="button" className="cc-signout" onClick={onSignOut}>
            {pick(S.signOut, lang)}
          </button>
        </div>

      </div>
    </div>
  );
}

/** The read failed. Deliberately not an empty list — see the header. */
export function CommandCenterFailed({
  lang,
  onRetry,
  onChooseAnotherCompany,
  onSignOut,
}: {
  lang: Lang;
  onRetry: () => void;
  onChooseAnotherCompany?: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="cc-wrap">
      <CcStyle />
      <div className="cc-col">
        <header className="cc-head">
          <div className="cc-mark" aria-hidden><CxIcon name="staxis" size={18} /></div>
          <h1 className="cc-title">{pick(S.pickTitle, lang)}</h1>
        </header>
        <div className="cc-fail">
          {pick(S.loadFailed, lang)}
          <div>
            <button type="button" onClick={onRetry}>{pick(S.retry, lang)}</button>
            {onChooseAnotherCompany && (
              <button type="button" onClick={onChooseAnotherCompany}>
                {pick(S.companyPickTitle, lang)}
              </button>
            )}
          </div>
        </div>
        <div className="cc-foot">
          <span className="cc-who" />
          <button type="button" className="cc-signout" onClick={onSignOut}>
            {pick(S.signOut, lang)}
          </button>
        </div>
      </div>
    </div>
  );
}
