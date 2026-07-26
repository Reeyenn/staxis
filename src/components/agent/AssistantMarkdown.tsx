'use client';

// ─── AssistantMarkdown — the one way a model's reply is rendered ─────────────
//
// A model asked for prose writes markdown whether or not anybody asked it to:
// `**bold**`, `- bullets`, and — the moment a question involves more than one
// row of anything — a GFM pipe table. Any surface that drops that reply into a
// plain `<div>` shows the manager `| Hotel | Open |` and `**Tyler**` as
// literal characters. That is what the cross-hotel ask line did on the command
// centre until 2026-07-26: same model, same markdown, no renderer.
//
// So the renderer is a component rather than a habit. It lived inside
// AskStaxisBar, which meant the second surface to stream an assistant reply had
// to remember to copy it; this file is that copy not existing.
//
// WHY IT IS LAZY, AND WHY THE FALLBACK IS NOT A SPINNER
// react-markdown + remark-gfm are ~60-100KB gzipped and are needed ONLY once a
// model has actually replied — which never happens on a page where nobody asks
// anything. So they load on first use, from a module-level promise every caller
// shares. Until it resolves the RAW text is shown with whitespace preserved:
// a streaming reply is never blank, and if the chunk fails to load the reply is
// still readable rather than replaced by an error. Markdown is a presentation
// upgrade; losing it must never lose the answer.
//
// UNSTYLED ON PURPOSE. Every element is emitted bare so the host surface's own
// CSS (`.asx-*`, `.cc-ask-answer *`) owns the look. A component that shipped its
// own colours would be wrong on one of the two surfaces the day it landed.

import { useEffect, useState, type ReactElement } from 'react';

type AssistantMarkdownRenderer = (props: { text: string }) => ReactElement;

let markdownRendererPromise: Promise<AssistantMarkdownRenderer> | null = null;

function loadMarkdownRenderer(): Promise<AssistantMarkdownRenderer> {
  if (!markdownRendererPromise) {
    const load = Promise.all([
      import('react-markdown'),
      import('remark-gfm'),
    ]).then(([rm, gfm]) => {
      const ReactMarkdown = rm.default;
      const remarkGfm = gfm.default;
      const Renderer: AssistantMarkdownRenderer = ({ text }) => (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p>{children}</p>,
            strong: ({ children }) => <strong>{children}</strong>,
            em: ({ children }) => <em>{children}</em>,
            ul: ({ children }) => <ul>{children}</ul>,
            ol: ({ children }) => <ol>{children}</ol>,
            li: ({ children }) => <li>{children}</li>,
            code: ({ children }) => <code>{children}</code>,
            // A portfolio answer about twenty hotels is a table more often than
            // not, so the table elements are not optional here.
            table: ({ children }) => <table>{children}</table>,
            thead: ({ children }) => <thead>{children}</thead>,
            tbody: ({ children }) => <tbody>{children}</tbody>,
            tr: ({ children }) => <tr>{children}</tr>,
            th: ({ children }) => <th>{children}</th>,
            td: ({ children }) => <td>{children}</td>,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      );
      return Renderer;
    });
    markdownRendererPromise = load.catch((error) => {
      // A transient chunk/network failure should not poison the module cache
      // forever. The current bubble remains readable as plain text; a later
      // assistant bubble gets a fresh chance to load the renderer.
      markdownRendererPromise = null;
      throw error;
    });
  }
  return markdownRendererPromise;
}

export function AssistantMarkdown({ text }: { text: string }) {
  const [Renderer, setRenderer] = useState<AssistantMarkdownRenderer | null>(null);
  useEffect(() => {
    let alive = true;
    loadMarkdownRenderer()
      .then((R) => { if (alive) setRenderer(() => R); })
      .catch(() => { /* keep the plain-text fallback */ });
    return () => { alive = false; };
  }, []);
  if (!Renderer) return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>;
  return <Renderer text={text} />;
}
