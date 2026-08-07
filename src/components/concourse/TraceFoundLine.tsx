'use client';

// ─── One line on the Staxis list ──────────────────────────────────────────
//
// A pattern the companion found on another screen, said in one sentence, with
// the same two buttons the peek carries. Nothing is drawn here and nothing is
// fetched here: this component subscribes, renders, and calls back.
//
// WHY IT LOOKS LIKE A ROW AND NOT LIKE A CARD. The Staxis list is one list, and
// the whole product argument for it is that everything worth a decision turns
// up in the same shape. A pattern arriving in its own bordered box with its own
// colour would be the app saying "and here is the AI section", which is the
// framing the companion exists to replace.
//
// It renders NOTHING when the companion has nothing, which is most of the time,
// and it never occupies space while empty.

import { useEffect, useState } from 'react';
import { subscribeToTraceLine, type TraceLine } from '@/components/companion/trace-events';

export function TraceFoundLine() {
  const [line, setLine] = useState<TraceLine | null>(null);

  useEffect(() => subscribeToTraceLine(setLine), []);

  if (!line) return null;

  return (
    <div className="trl-row" data-row-kind="trace" data-row-id={line.topic}>
      <div className="trl-mark" aria-hidden />
      <div className="trl-body">
        <div className="trl-text">{line.text}</div>
        <div className="trl-where">{line.whereFound}</div>
      </div>
      {/* The buttons the companion actually built for this thing, in order.
          The first is the one it leads with. Nothing here writes a label. */}
      <div className="trl-acts">
        {line.replies.map((reply, i) => (
          <button
            key={reply.id}
            type="button"
            className={i === 0 ? 'trl-yes' : 'trl-no'}
            onClick={() => line.onReply(reply.id)}
          >
            {reply.label}
          </button>
        ))}
      </div>
      <style dangerouslySetInnerHTML={{ __html: TRL_CSS }} />
    </div>
  );
}

// Values taken from the list's own FEED_CSS rather than rounded to a nearby
// token, for the reason its header gives: on this screen the numbers are final.
const TRL_CSS = `
.trl-row{display:flex;align-items:center;gap:12px;background:#fff;
  border:1px solid rgba(31,35,28,.09);border-radius:13px;padding:12px 16px;margin-bottom:10px;
  box-shadow:0 10px 24px -24px rgba(31,42,32,.9);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.trl-mark{width:11px;height:11px;background:#1F231C;transform:rotate(45deg);border-radius:2px;flex-shrink:0;}
.trl-body{min-width:0;}
.trl-text{font-size:14px;font-weight:600;line-height:1.4;color:var(--snow-ink,#1F231C);}
.trl-where{font-size:11.5px;color:var(--snow-ink3,#8A9187);margin-top:2px;}
.trl-acts{margin-left:auto;display:flex;gap:7px;flex-shrink:0;}
.trl-yes,.trl-no{height:30px;border-radius:9px;font:inherit;font-size:12.5px;cursor:pointer;}
.trl-yes{padding:0 13px;border:none;background:#3E5C48;color:#fff;font-weight:600;}
.trl-yes:hover{background:#35513F;}
.trl-no{padding:0 12px;border:1px solid rgba(31,35,28,.13);background:#fff;color:var(--snow-ink2,#5C625C);}
.trl-no:hover{background:#F5F7F4;}
.trl-yes:focus-visible,.trl-no:focus-visible{outline:2px solid #3E5C48;outline-offset:2px;}
@media (max-width:899px){.trl-row{display:none;}}
`;
