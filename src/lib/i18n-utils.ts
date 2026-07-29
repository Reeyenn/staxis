// English-only UI helpers. Ignored language parameters keep legacy data/API
// call signatures stable without enabling alternate built-in copy.

export function makeT<S extends Record<string, string>>(
  dict: { en: S },
): (_storedLanguage?: string | null) => S {
  return () => dict.en;
}

export function makeLabelFor<K extends string>(
  labels: { en: Record<K, string> },
): (_storedLanguage: string | null | undefined, key: K) => string {
  return (_storedLanguage, key) => labels.en[key] ?? key;
}

export function dateLocale(_storedLanguage?: string | null): string {
  return 'en-US';
}
