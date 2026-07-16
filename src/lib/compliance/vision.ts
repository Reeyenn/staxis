// AI feature #1 — SNAP-TO-LOG.
//
// Photograph a pool test strip / utility meter / boiler gauge / fridge
// thermometer → Claude Vision reads the value and we pre-fill the field.
// Reuses the shared vision-extract shim (same model + cost tracking +
// error handling as inventory photo-count / invoice scan).

import {
  visionExtractJSON,
  VisionSchemaError,
  type VisionImage,
  type VisionUsageReport,
  type VisionCallOptions,
} from '@/lib/vision-extract';

export interface ExtractedReading {
  value: number | null;
  unit: string | null;
  confidence: 'high' | 'medium' | 'low';
  note: string | null;
}

function buildPrompt(typeName: string, unit: string, category: string): string {
  const what =
    category === 'pool' ? 'a pool/spa water test (test strip color chart, digital tester, or titration kit) or a pool equipment gauge'
    : category === 'utility_meter' ? 'a utility meter display (electric kWh, gas, or water — analog dials or digital readout)'
    : category === 'boiler' ? 'a boiler gauge (temperature or pressure dial / digital readout)'
    : category === 'area_temp' ? 'a refrigerator/freezer/food-hold thermometer (dial or digital)'
    : 'a gauge, meter, or test reading';

  // typeName/unit are trusted config (not user free-text), but we still frame
  // the image content as data to read, not instructions to follow.
  return `You are reading ${what} from a photo for hotel engineering compliance.
The target measurement is "${typeName}"${unit ? ` measured in ${unit}` : ''}.

Read the single most relevant numeric value visible. For analog dials, read the needle position. For test strips, match the pad color to the chart and report the numeric concentration. For multi-dial utility meters, read left-to-right into one number.

Return ONLY a JSON object, no prose, no code fences:
{
  "value": <number or null if unreadable>,
  "unit": "<unit you read, or null>",
  "confidence": "high" | "medium" | "low",
  "note": "<short note if the photo is unclear or shows something unexpected, else null>"
}

If you cannot read a value at all, return { "value": null, "unit": null, "confidence": "low", "note": "<why>" }.`;
}

export async function extractReadingFromImage(
  image: VisionImage,
  hint: { name: string; unit: string; category: string },
  onUsage?: (u: VisionUsageReport) => void,
  opts: VisionCallOptions = {},
): Promise<ExtractedReading> {
  return visionExtractJSON<ExtractedReading>(
    image,
    buildPrompt(hint.name, hint.unit, hint.category),
    (raw): ExtractedReading => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new VisionSchemaError('expected an object at top level');
      }
      const obj = raw as Record<string, unknown>;
      if (
        obj.value !== null
        && (typeof obj.value !== 'number' || !Number.isFinite(obj.value) || Math.abs(obj.value) > 1e9)
      ) throw new VisionSchemaError('value must be a finite bounded number or null');
      if (obj.unit !== null && (typeof obj.unit !== 'string' || obj.unit.length > 50)) {
        throw new VisionSchemaError('unit must be a string or null');
      }
      if (obj.confidence !== 'high' && obj.confidence !== 'medium' && obj.confidence !== 'low') {
        throw new VisionSchemaError('confidence must be high, medium, or low');
      }
      if (obj.note !== null && (typeof obj.note !== 'string' || obj.note.length > 500)) {
        throw new VisionSchemaError('note must be a string or null');
      }
      return {
        value: obj.value as number | null,
        unit: obj.unit as string | null,
        confidence: obj.confidence,
        note: obj.note as string | null,
      };
    },
    onUsage,
    'compliance.photo_reading',
    opts,
  );
}
