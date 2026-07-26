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

import { fetchWithAuth } from '@/lib/api-fetch';
import { AssistantMarkdown } from '@/components/agent/AssistantMarkdown';
import { hotelChipLabel, type HotelChip } from '@/lib/company/vp-queue';
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
  organizationName: string;
  companyRole: 'owner' | 'vp' | 'finance';
  hotelCount: number;
}

export interface CommandCenterPayload {
  hotels: PickerHotel[];
  company: PickerCompany | null;
  chat: { available: boolean };
  signedInAs: string | null;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

type Bi = { en: string; es: string };
const pick = (b: Bi, lang: Lang) => (lang === 'es' ? b.es : b.en);

const S = {
  pickTitle: { en: 'Choose a hotel', es: 'Elige un hotel' },
  companyTitle: { en: 'Your hotels', es: 'Tus hoteles' },
  rooms: { en: 'rooms', es: 'habitaciones' },
  room: { en: 'room', es: 'habitación' },
  signOut: { en: 'Sign out', es: 'Cerrar sesión' },
  signedInAs: { en: 'Signed in as', es: 'Conectado como' },
  queueTitle: { en: 'Your morning', es: 'Tu mañana' },
  queueSub: {
    en: 'Everything from your hotels that reached you, in one queue.',
    es: 'Todo lo que llegó desde tus hoteles, en una sola cola.',
  },
  askPlaceholder: {
    en: 'Ask about all your hotels…',
    es: 'Pregunta sobre todos tus hoteles…',
  },
  askLabel: { en: 'Ask across your hotels', es: 'Pregunta en todos tus hoteles' },
  askSend: { en: 'Ask', es: 'Preguntar' },
  askThinking: { en: 'Reading your hotels…', es: 'Leyendo tus hoteles…' },
  askFailed: {
    en: 'Staxis could not answer just now. Nothing about your hotels changed.',
    es: 'Staxis no pudo responder ahora. Nada cambió en tus hoteles.',
  },
  loadFailed: {
    en: 'Staxis could not load your hotels just now. This is not "you have none".',
    es: 'Staxis no pudo cargar tus hoteles ahora. Esto no significa "no tienes ninguno".',
  },
  retry: { en: 'Try again', es: 'Reintentar' },
  hotelsWord: { en: 'hotels', es: 'hoteles' },
  hotelWord: { en: 'hotel', es: 'hotel' },
} as const;

/**
 * Number agreement, both languages, both numbers. "1 need you" and
 * "1 tranquilos" are the kind of sentence that makes a careful reader stop
 * trusting the careful numbers next to them, so each count carries its own
 * singular and plural rather than one shared label.
 */
const SUMMARY_WORDS = {
  needs: {
    one: { en: 'needs you', es: 'te necesita' },
    many: { en: 'need you', es: 'te necesitan' },
  },
  waiting: {
    one: { en: 'waiting', es: 'esperando' },
    many: { en: 'waiting', es: 'esperando' },
  },
  quiet: {
    one: { en: 'quiet', es: 'tranquilo' },
    many: { en: 'quiet', es: 'tranquilos' },
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

/* ── Ask across hotels ── */
.cc-ask{margin-top:10px;background:#fff;border:1px solid rgba(31,35,28,.10);border-radius:18px;
  padding:13px 14px;}
.cc-ask-row{display:flex;align-items:center;gap:9px;}
.cc-ask-spark{color:#C99644;flex-shrink:0;display:grid;place-items:center;}
.cc-ask-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font:inherit;
  font-size:14px;color:#1F231C;padding:5px 0;}
.cc-ask-input::placeholder{color:#A6ABA6;}
.cc-ask-send{height:32px;padding:0 14px;border-radius:999px;border:none;cursor:pointer;
  background:#3E5C48;color:#fff;font:inherit;font-size:12.5px;font-weight:600;flex-shrink:0;
  transition:opacity .18s ease,background .18s ease;}
.cc-ask-send:disabled{opacity:.4;cursor:default;}
.cc-ask-send:not(:disabled):hover{background:#334C3C;}
.cc-ask-send:focus-visible,.cc-ask-input:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
/* On a phone the button and the placeholder cannot share one line without
   clipping the question mid-word, so the button drops to its own full-width
   row. A VP asking from a car park gets a bigger target for it, too. */
@media(max-width:479px){
  .cc-ask-row{flex-wrap:wrap;row-gap:10px;}
  .cc-ask-send{flex:1 0 100%;height:38px;}
}
.cc-ask-answer{margin-top:11px;padding-top:11px;border-top:1px solid rgba(31,35,28,.07);
  font-size:13.5px;line-height:1.62;color:#1F231C;overflow-wrap:anywhere;}
.cc-ask-status{font-family:var(--font-geist-mono),ui-monospace,monospace;font-size:11px;
  color:#8A9187;letter-spacing:.02em;}
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

/**
 * ONE QUESTION ACROSS EVERY HOTEL. Rendered only when the server said the door
 * is open — a COMPANY-scope job AND the company's own `cross_hotel_ai_chat`
 * switch. Both are re-checked by /api/agent/portfolio on the way in and again
 * by every tool it mounts, so this component being wrong could only ever cost a
 * refusal, never a leak.
 *
 * Read-only by construction: the portfolio route mounts no mutation tools, so
 * there is no approval card to render here and no "are you sure" to get wrong.
 * That is exactly why this can be a hundred lines instead of the hotel copilot's
 * two thousand.
 */
function AskAcrossHotels({ lang, organizationId }: { lang: Lang; organizationId: string }) {
  const [question, setQuestion] = React.useState('');
  const [answer, setAnswer] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'streaming' | 'failed'>('idle');
  const [asked, setAsked] = React.useState<string | null>(null);

  const send = async () => {
    const text = question.trim();
    if (!text || state === 'streaming') return;
    setAsked(text);
    setQuestion('');
    setAnswer('');
    setState('streaming');

    try {
      // fetchWithAuth, not bare fetch: it attaches the session bearer and does
      // the refresh-and-retry dance on a 401. A plain fetch would render the
      // failure sentence on any expired-token blip.
      const res = await fetchWithAuth('/api/agent/portfolio', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, organizationId }),
      });
      if (!res.ok || !res.body) throw new Error(`portfolio chat ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamed = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let payload: {
            type?: string;
            delta?: string;
            finalText?: string;
            message?: string;
            code?: string;
          };
          try {
            payload = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (payload.type === 'text_delta' && payload.delta) {
            streamed += payload.delta;
            setAnswer(streamed);
          } else if (payload.type === 'error') {
            // A CODED error is the server saying "something broke and I am not
            // going to tell a VP what" — the sentence is ours, and it is
            // bilingual. Everything else is deliberate server copy (a closed
            // door, a spend cap), which knows more about the refusal than this
            // component does and beats anything we could write; only a coded
            // frame is generic enough for us to speak for.
            streamed = payload.code ? pick(S.askFailed, lang) : (payload.message ?? '');
            if (!streamed) streamed = pick(S.askFailed, lang);
            setAnswer(streamed);
          } else if (payload.type === 'done' && !streamed && payload.finalText) {
            streamed = payload.finalText;
            setAnswer(streamed);
          }
        }
      }
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  const busy = state === 'streaming';

  return (
    <div className="cc-ask">
      <div className="cc-ask-row">
        <span className="cc-ask-spark" aria-hidden>
          <CxIcon name="staxis" size={16} />
        </span>
        <input
          className="cc-ask-input"
          value={question}
          aria-label={pick(S.askLabel, lang)}
          placeholder={pick(S.askPlaceholder, lang)}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
        />
        <button
          type="button"
          className="cc-ask-send"
          disabled={busy || question.trim().length === 0}
          onClick={() => void send()}
        >
          {pick(S.askSend, lang)}
        </button>
      </div>

      {asked !== null && (
        <div className="cc-ask-answer">
          {state === 'failed'
            ? <span className="cc-ask-status">{pick(S.askFailed, lang)}</span>
            : answer.length > 0
              // The SAME renderer the per-hotel copilot uses. A model asked for
              // a comparison writes a markdown table; rendering it as text is
              // how this line shipped showing the VP literal pipe characters.
              ? <AssistantMarkdown text={answer} />
              : <span className="cc-ask-status">{pick(S.askThinking, lang)}</span>}
        </div>
      )}
    </div>
  );
}

// ─── The screen ─────────────────────────────────────────────────────────────

export interface CommandCenterViewProps {
  payload: CommandCenterPayload;
  lang: Lang;
  onOpenHotel: (hotel: PickerHotel) => void;
  onSignOut: () => void;
}

/**
 * The screen, given data. Split from the fetching page so both audiences can be
 * exercised with real payloads and no session in the way.
 */
export function CommandCenterView({
  payload,
  lang,
  onOpenHotel,
  onSignOut,
}: CommandCenterViewProps) {
  const { hotels, company, chat } = payload;
  const summary = company ? chipSummary(hotels, lang) : null;

  return (
    <div className="cc-wrap">
      <CcStyle />
      <div className={company ? 'cc-col cc-wide' : 'cc-col'}>

        <header className="cc-head">
          <div className="cc-mark" aria-hidden><CxIcon name="staxis" size={18} /></div>
          <div className="cc-eyebrow">
            {company ? company.organizationName : 'Staxis'}
          </div>
          <h1 className="cc-title">
            {pick(company ? S.companyTitle : S.pickTitle, lang)}
          </h1>
          {summary && <div className="cc-summary">{summary}</div>}
        </header>

        {company && (
          <>
            {/* The portfolio queue lives in the Staxis tab; a company-scope
                reader who opens it gets PortfolioQueueView rather than a
                hotel's feed, resolved server-side from their own hats. */}
            <a className="cc-portfolio" href="/feed">
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

            {chat.available && (
              <AskAcrossHotels lang={lang} organizationId={company.organizationId} />
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
          style={company ? undefined : { marginTop: 4 }}
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
  onSignOut,
}: {
  lang: Lang;
  onRetry: () => void;
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
