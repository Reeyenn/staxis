// Local Snow primitive surface for the Agents section. Re-exports the shared
// staff tokens — the repo's cross-feature convention (settings/wages imports the
// same file) — so every agent component imports primitives from one place and
// the section stays decoupled from other chats' files.

export { T, fonts, Caps, Btn, Card, Pill } from '@/app/staff/_components/_tokens';
export type { PillTone, BtnVariant, BtnSize } from '@/app/staff/_components/_tokens';
