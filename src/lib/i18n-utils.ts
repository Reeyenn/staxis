// Shared i18n plumbing for feature pages (staff-pages overhaul, F9).
//
// Why a sibling of translations.ts rather than additions to it: that file is
// 2,800+ lines and — per the headers of inventory's inv-i18n.ts and
// financials' fin-i18n.ts — is edited by every parallel feature, so
// co-locating tiny pure helpers here avoids turning it into a merge-conflict
// magnet. This module holds NO strings: feature dictionaries stay co-located
// with their feature (inv-i18n / fin-i18n pattern); this is just the
// boilerplate they all re-derive.
//
// Nothing here is imported by feature pages yet — consumers migrate in a
// later wave. Do not change behavior; each helper is a faithful extraction
// of copies that already ship.

import type { Language } from './translations';

/**
 * Inline EN/ES ternary — the exact `lang === 'es' ? es : en` body of the 8
 * byte-identical private copies scattered across pages:
 *   - housekeeping/_components/QualityTab.tsx           (lang: 'en'|'es')
 *   - housekeeper/[id]/_components/InspectorView.tsx    (lang: 5-locale union)
 *   - maintenance/_components/EquipmentPicker.tsx       (lang: string)
 *   - maintenance/_components/ComplianceTab.tsx         (lang: string)
 *   - maintenance/_components/EquipmentRegistry.tsx     (lang: string)
 *   - front-desk/_components/LostFoundTab.tsx           (lang: Lang)
 *   - front-desk/_components/PackagesTab.tsx            (lang: Lang)
 *   - (plus the arrow-fn copies with the same body)
 * The parameter is widened to `string | null | undefined` so every existing
 * signature is a subtype; HT/TL/VI (and anything unknown) render the EN
 * branch, exactly like today's copies.
 */
export function tr(lang: string | null | undefined, en: string, es: string): string {
  return lang === 'es' ? es : en;
}

/**
 * Narrow any locale value down to the bilingual 'en' | 'es' branch the
 * manager-side UI keys off. Mirrors LanguageContext's private narrow() and
 * inv-i18n's invLang() — es stays es, everything else (en/ht/tl/vi/garbage)
 * degrades to en.
 */
export function narrowLang(l: string | null | undefined): Language {
  return l === 'es' ? 'es' : 'en';
}

/**
 * Compile-time EN↔ES key-parity guard, generalized from inv-i18n's
 * `_esKeyParity` trick. Because t()/makeT() return the EN shape, a key added
 * to `en` but forgotten in `es` would return `undefined` at runtime with NO
 * build error. Local dictionaries keep that mistake a type error with:
 *
 *   const _esKeyParity: EsKeyParity<MyStrings> = STRINGS.es;
 *   void _esKeyParity;
 *
 * (makeT below also bakes this check into its `es` parameter, so dictionaries
 * built through it don't need the manual assignment.)
 */
export type EsKeyParity<EnShape> = Record<keyof EnShape, string>;

/**
 * Dictionary-getter factory — generalizes the t()/ft() boilerplate that
 * inv-i18n and fin-i18n each re-derive:
 *
 *   const t = makeT(STRINGS);      // STRINGS = { en: {...}, es: {...} }
 *   t(lang).pageTitle
 *
 * Lookup is `dict[lang] ?? dict.en`, typed as the EN shape (missing locales
 * and HT/TL/VI fall back to EN, same as today's copies). The `es` branch is
 * typed as EsKeyParity<en-shape>, so forgetting an ES key is a compile error.
 * Extra locales (ht/tl/vi/...) may be supplied and must carry the full shape.
 */
export function makeT<S extends Record<string, string>>(
  dict: { en: S; es: EsKeyParity<S> } & Partial<Record<string, S>>,
): (lang: string | null | undefined) => S {
  const map = dict as Partial<Record<string, S>> & { en: S };
  return (lang) => map[lang ?? 'en'] ?? dict.en;
}

/**
 * Keyed-label-getter factory — generalizes the statusLabelFor/catLabelFor
 * (inv-i18n) and deptLabel/capexStatusLabel/... (fin-i18n) boilerplate:
 *
 *   const statusLabelFor = makeLabelFor(STATUS_LABELS);
 *   statusLabelFor(lang, 'good')   // → 'Good' / 'Bien'
 *
 * Fallback chain matches those getters exactly: chosen lang → EN → raw key.
 */
export function makeLabelFor<K extends string>(
  labels: { en: Record<K, string>; es: Record<K, string> } & Partial<Record<string, Record<K, string>>>,
): (lang: string | null | undefined, key: K) => string {
  const map = labels as Partial<Record<string, Record<K, string>>> & { en: Record<K, string> };
  return (lang, key) => map[lang ?? 'en']?.[key] ?? labels.en[key] ?? key;
}

/**
 * Locale string for toLocaleDateString / Intl.DateTimeFormat.
 *
 * The codebase ships several EN/ES locale pairs and areas must keep their
 * exact current rendering, so the pair is parameterized rather than
 * normalized:
 *   - dateLocale(lang)                    → 'es-ES' / 'en-US'  (inv-i18n's exported dateLocale — the default)
 *   - dateLocale(lang, 'es-US')           → 'es-US' / 'en-US'  (financials + front-desk inline ternaries)
 *   - dateLocale(lang, 'es', 'en')        → 'es'    / 'en'     (dashboard LogBookCard, housekeeping _shared)
 */
export function dateLocale(
  lang: string | null | undefined,
  esLocale: string = 'es-ES',
  enLocale: string = 'en-US',
): string {
  return lang === 'es' ? esLocale : enLocale;
}
