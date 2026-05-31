// Starter template library for engineering compliance.
//
// Ships the common brand-required readings + preventive-maintenance logs so a
// property can be set up in one tap (or one sentence — see nlp.ts). Brand is
// auto-detected from the property name / PMS family; an unknown brand falls
// back to the generic limited-service template.
//
// These are DEFINITIONS only (cadence, thresholds, unit counts). The actual
// per-period history is logged by staff. Adding a brand = add a TEMPLATES entry.

import type {
  ReadingCategory,
  ReadingCadence,
  PmCategory,
  PmCadence,
} from './types';

export interface ReadingTypeSeed {
  category: ReadingCategory;
  name: string;
  unit: string;
  cadence: ReadingCadence;
  minValue: number | null;
  maxValue: number | null;
}

export interface PmTaskSeed {
  category: PmCategory;
  name: string;
  equipmentType: string;
  unitCount: number;
  cadence: PmCadence;
}

export interface ComplianceTemplate {
  key: string;
  label: string;
  /** Property-name keywords that auto-select this template. */
  brandKeywords: string[];
  readingTypes: ReadingTypeSeed[];
  pmTasks: PmTaskSeed[];
}

// ─── Reusable building blocks ───────────────────────────────────────────────

// Pool chemistry — CDC Model Aquatic Health Code safe ranges (the ranges most
// brand standards and health inspectors key on).
const POOL_CHEMISTRY: ReadingTypeSeed[] = [
  { category: 'pool', name: 'Pool — pH', unit: 'pH', cadence: 'daily', minValue: 7.2, maxValue: 7.8 },
  { category: 'pool', name: 'Pool — Free chlorine', unit: 'ppm', cadence: 'daily', minValue: 1, maxValue: 5 },
  { category: 'pool', name: 'Pool — Total alkalinity', unit: 'ppm', cadence: 'daily', minValue: 60, maxValue: 180 },
  { category: 'pool', name: 'Pool — Calcium hardness', unit: 'ppm', cadence: 'weekly', minValue: 200, maxValue: 400 },
  { category: 'pool', name: 'Pool — Water temperature', unit: '°F', cadence: 'daily', minValue: 78, maxValue: 86 },
  { category: 'pool', name: 'Pool — Filter pressure', unit: 'PSI', cadence: 'daily', minValue: 5, maxValue: 30 },
  { category: 'pool', name: 'Pool — Flow rate', unit: 'GPM', cadence: 'daily', minValue: 40, maxValue: 120 },
];

const UTILITY_METERS: ReadingTypeSeed[] = [
  { category: 'utility_meter', name: 'Electric meter', unit: 'kWh', cadence: 'daily', minValue: null, maxValue: null },
  { category: 'utility_meter', name: 'Gas meter', unit: 'CCF', cadence: 'daily', minValue: null, maxValue: null },
  { category: 'utility_meter', name: 'Water meter', unit: 'gal', cadence: 'daily', minValue: null, maxValue: null },
];

const BOILER: ReadingTypeSeed[] = [
  { category: 'boiler', name: 'Boiler — Temperature', unit: '°F', cadence: 'daily', minValue: 120, maxValue: 180 },
  { category: 'boiler', name: 'Boiler — Pressure', unit: 'PSI', cadence: 'daily', minValue: 12, maxValue: 30 },
];

const AREA_TEMPS: ReadingTypeSeed[] = [
  { category: 'area_temp', name: 'Walk-in fridge', unit: '°F', cadence: 'daily', minValue: 33, maxValue: 40 },
  { category: 'area_temp', name: 'Walk-in freezer', unit: '°F', cadence: 'daily', minValue: -10, maxValue: 10 },
  { category: 'area_temp', name: 'Breakfast hot-hold', unit: '°F', cadence: 'per_shift', minValue: 135, maxValue: 175 },
];

// Life-safety PM logs — the checks an AHJ / fire marshal expects, with the
// codes that drive their cadence (NFPA 10/72/101).
const LIFE_SAFETY_PM: PmTaskSeed[] = [
  { category: 'life_safety', name: 'Fire extinguishers', equipmentType: 'fire_extinguisher', unitCount: 15, cadence: 'monthly' },
  { category: 'life_safety', name: 'Emergency lighting', equipmentType: 'emergency_light', unitCount: 18, cadence: 'monthly' },
  { category: 'life_safety', name: 'Exit signs', equipmentType: 'exit_sign', unitCount: 12, cadence: 'monthly' },
  { category: 'life_safety', name: 'AED units', equipmentType: 'aed', unitCount: 1, cadence: 'monthly' },
  { category: 'life_safety', name: 'Smoke / CO detectors', equipmentType: 'smoke_co_detector', unitCount: 110, cadence: 'monthly' },
  { category: 'life_safety', name: 'Fire & smoke doors', equipmentType: 'fire_door', unitCount: 8, cadence: 'annual' },
  { category: 'life_safety', name: 'Eye-wash / first-aid stations', equipmentType: 'eyewash_station', unitCount: 2, cadence: 'monthly' },
  { category: 'life_safety', name: 'Sprinkler system inspection', equipmentType: 'sprinkler', unitCount: 1, cadence: 'quarterly' },
];

// ─── Templates ──────────────────────────────────────────────────────────────

const GENERIC: ComplianceTemplate = {
  key: 'generic_limited_service',
  label: 'Limited-service hotel (generic)',
  brandKeywords: [],
  readingTypes: [...POOL_CHEMISTRY, ...UTILITY_METERS, ...BOILER, ...AREA_TEMPS],
  pmTasks: [...LIFE_SAFETY_PM],
};

// Choice Hotels family (Comfort, Sleep, Quality, Clarion, MainStay, Sleep Inn,
// Country Inn …). Choice's QA program ("Choice Privileges / Medallia QA")
// requires daily pool logs + monthly life-safety logs.
const CHOICE: ComplianceTemplate = {
  key: 'choice_hotels',
  label: 'Choice Hotels (Comfort / Sleep / Quality / Clarion / MainStay)',
  brandKeywords: ['comfort', 'sleep inn', 'quality inn', 'clarion', 'mainstay', 'suburban', 'econo lodge', 'rodeway', 'choice'],
  readingTypes: [...POOL_CHEMISTRY, ...UTILITY_METERS, ...BOILER, ...AREA_TEMPS],
  pmTasks: [...LIFE_SAFETY_PM],
};

// Hilton focused-service (Hampton, Tru, Home2, Hilton Garden Inn). Hilton's
// brand standard ("Q&A" / Quality Assurance) is stricter on pool chem cadence.
const HILTON: ComplianceTemplate = {
  key: 'hilton_focused',
  label: 'Hilton (Hampton / Tru / Home2 / Garden Inn)',
  brandKeywords: ['hampton', 'tru by', 'home2', 'hilton garden', 'homewood', 'embassy', 'hilton'],
  readingTypes: [
    ...POOL_CHEMISTRY.map((r) => (r.category === 'pool' && r.cadence === 'daily' ? { ...r, cadence: 'per_shift' as ReadingCadence } : r)),
    ...UTILITY_METERS, ...BOILER, ...AREA_TEMPS,
  ],
  pmTasks: [...LIFE_SAFETY_PM],
};

// Marriott select-service (Fairfield, Courtyard, SpringHill, TownePlace).
const MARRIOTT: ComplianceTemplate = {
  key: 'marriott_select',
  label: 'Marriott (Fairfield / Courtyard / SpringHill / TownePlace)',
  brandKeywords: ['fairfield', 'courtyard', 'springhill', 'towneplace', 'residence inn', 'marriott'],
  readingTypes: [...POOL_CHEMISTRY, ...UTILITY_METERS, ...BOILER, ...AREA_TEMPS],
  pmTasks: [...LIFE_SAFETY_PM],
};

// IHG (Holiday Inn Express, Candlewood, Staybridge).
const IHG: ComplianceTemplate = {
  key: 'ihg_select',
  label: 'IHG (Holiday Inn Express / Candlewood / Staybridge)',
  brandKeywords: ['holiday inn', 'candlewood', 'staybridge', 'avid', 'ihg'],
  readingTypes: [...POOL_CHEMISTRY, ...UTILITY_METERS, ...BOILER, ...AREA_TEMPS],
  pmTasks: [...LIFE_SAFETY_PM],
};

// Wyndham economy (Days Inn, Super 8, La Quinta, Microtel).
const WYNDHAM: ComplianceTemplate = {
  key: 'wyndham_economy',
  label: 'Wyndham (Days Inn / Super 8 / La Quinta / Microtel)',
  brandKeywords: ['days inn', 'super 8', 'la quinta', 'microtel', 'baymont', 'howard johnson', 'wyndham', 'ramada', 'travelodge'],
  readingTypes: [...POOL_CHEMISTRY, ...UTILITY_METERS, ...BOILER, ...AREA_TEMPS],
  pmTasks: [...LIFE_SAFETY_PM],
};

export const TEMPLATES: ComplianceTemplate[] = [CHOICE, HILTON, MARRIOTT, IHG, WYNDHAM, GENERIC];

export function getTemplate(key: string): ComplianceTemplate | null {
  return TEMPLATES.find((t) => t.key === key) ?? null;
}

/**
 * Auto-detect the brand template from a property name (and optional PMS family
 * hint). Falls back to the generic limited-service template. Choice Advantage
 * is the PMS Comfort Suites Beaumont runs, so a `choice` PMS hint maps to the
 * Choice template even if the name is ambiguous.
 */
export function detectTemplate(propertyName: string | null | undefined, pmsType?: string | null): ComplianceTemplate {
  const name = (propertyName ?? '').toLowerCase();
  for (const tpl of TEMPLATES) {
    if (tpl.brandKeywords.some((kw) => name.includes(kw))) return tpl;
  }
  if (pmsType && /choice/i.test(pmsType)) return CHOICE;
  return GENERIC;
}
