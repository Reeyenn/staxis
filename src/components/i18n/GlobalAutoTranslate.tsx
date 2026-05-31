'use client';

import React from 'react';
import { useLang } from '@/contexts/LanguageContext';
import { useProperty } from '@/contexts/PropertyContext';
import { supabase } from '@/lib/supabase';

// ─── App-wide auto-translate fallback (HT / TL / VI) ────────────────────────
// The manager app's strings are mostly inline `lang === 'es' ? … : …`
// ternaries (EN/ES only). For HT/TL/VI we machine-translate the on-screen
// English text in place, cached server-side (comms_translation_cache) and
// client-side (localStorage), so every page renders fully in the chosen
// language with no English gaps. Completely inert for EN/ES (the 98% path)
// and fail-safe: any error leaves the page in English.

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE', 'SVG', 'PATH']);
const MAX_NODES_PER_PASS = 800;
const HAS_LETTER = /\p{L}/u;

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  let token: string | undefined;
  try { token = (await supabase.auth.getSession()).data.session?.access_token; } catch { /* */ }
  return fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}

export function GlobalAutoTranslate() {
  const { locale } = useLang();
  const { activePropertyId } = useProperty();
  const active = (locale === 'ht' || locale === 'tl' || locale === 'vi') && !!activePropertyId;

  const cacheRef = React.useRef<Map<string, string>>(new Map());
  const appliedRef = React.useRef<WeakMap<Text, string>>(new WeakMap());
  const inFlightRef = React.useRef(false);

  React.useEffect(() => {
    if (!active) return;
    if (typeof window === 'undefined' || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;

    let disposed = false;
    let applying = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Load client cache for this locale.
    cacheRef.current = new Map();
    appliedRef.current = new WeakMap();
    try {
      const raw = localStorage.getItem(`staxis-i18n-${locale}`);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, string>;
        for (const [k, v] of Object.entries(obj)) cacheRef.current.set(k, v);
      }
    } catch { /* */ }

    const persist = () => {
      try {
        const obj: Record<string, string> = {};
        let n = 0;
        for (const [k, v] of cacheRef.current) { obj[k] = v; if (++n > 4000) break; }
        localStorage.setItem(`staxis-i18n-${locale}`, JSON.stringify(obj));
      } catch { /* quota — ignore */ }
    };

    const collectAndApply = async () => {
      if (disposed) return;
      const cache = cacheRef.current;
      const applied = appliedRef.current;
      const pending = new Set<string>();
      const nodes: Text[] = [];

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.closest('[data-no-translate]')) return NodeFilter.FILTER_REJECT;
          if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
          const v = node.nodeValue;
          if (!v) return NodeFilter.FILTER_REJECT;
          const t = v.trim();
          if (t.length < 2 || t.length > 2000 || !HAS_LETTER.test(t)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let cur = walker.nextNode();
      while (cur && nodes.length < MAX_NODES_PER_PASS) { nodes.push(cur as Text); cur = walker.nextNode(); }

      // Apply cached + queue misses.
      applying = true;
      try {
        for (const node of nodes) {
          const raw = node.nodeValue ?? '';
          // Already showing our translation? skip.
          if (applied.get(node) === raw) continue;
          const source = raw.trim();
          const hit = cache.get(source);
          if (hit) {
            const lead = raw.match(/^\s*/)?.[0] ?? '';
            const tail = raw.match(/\s*$/)?.[0] ?? '';
            const next = lead + hit + tail;
            if (next !== raw) { node.nodeValue = next; applied.set(node, next); }
            else { applied.set(node, raw); }
          } else {
            pending.add(source);
          }
        }
      } finally {
        applying = false;
      }

      // Translate misses (bounded), then re-apply.
      if (pending.size > 0 && !inFlightRef.current && activePropertyId) {
        inFlightRef.current = true;
        try {
          const texts = Array.from(pending).slice(0, 300);
          const res = await authFetch('/api/comms/translate', {
            method: 'POST',
            body: JSON.stringify({ pid: activePropertyId, texts, target: locale }),
          });
          if (res.ok) {
            const json = (await res.json()) as { ok?: boolean; data?: { translations?: Record<string, string> } };
            const map = json?.data?.translations ?? {};
            for (const [k, v] of Object.entries(map)) if (v) cache.set(k, v);
            persist();
            if (!disposed) { schedule(); } // re-apply with new cache
          }
        } catch { /* best-effort */ } finally {
          inFlightRef.current = false;
        }
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void collectAndApply(); }, 500);
    };

    const observer = new MutationObserver(() => { if (!applying) schedule(); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [active, locale, activePropertyId]);

  return null;
}
