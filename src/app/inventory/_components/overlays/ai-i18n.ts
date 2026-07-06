// Bilingual (EN + ES) strings for the Inventory AI report overlay. Co-located
// with the overlay (same pattern as inv-i18n.ts / the overlay ss/cs string
// blocks) rather than added to the global translations.ts so parallel features
// don't collide.

import type { Lang } from '../inv-i18n';

export function aiStrings(lang: Lang) {
  return {
    en: {
      // ── Header / chrome ──
      eyebrow: 'Inventory AI',
      title: 'What the AI has learned',
      subtitle:
        'The inventory page stays fully manual — you count and reorder yourself. Behind the scenes the AI keeps learning how fast each item moves. This is its report card.',
      // ── Summary stats ──
      itemsTracked: 'Items tracked',
      graduated: 'Models graduated',
      accuracy: 'Overall accuracy',
      lastPredicted: 'Last predicted',
      pctOff: (n: string) => `${n}% off`,
      accuracyPending: 'Filling in',
      of: 'of',
      // ── Freshness / warnings ──
      staleWarning:
        'The AI hasn’t made a fresh prediction in over a day. Its numbers below may be out of date — nothing on the inventory page depends on them.',
      noJobsWarning:
        'The AI hasn’t produced any data yet. It starts learning as soon as counts come in.',
      gapWarning: (missing: number, of: number) =>
        `Heads up: hotel data is missing for ${missing} of the last ${of} days (the robot wasn’t reporting). Counts taken across those days can’t teach the AI yet — the gaps repair automatically once the robot reconnects.`,
      lastPredictedAt: (when: string) => `Last predicted ${when}`,
      never: 'never',
      // ── Empty state ──
      emptyTitle: 'The AI hasn’t made any predictions yet',
      emptyBody:
        'It starts learning as counts come in. Keep counting inventory the normal way — after a few counts per item, the AI will begin predicting daily usage and show its work here.',
      // ── Per-item list ──
      listHeading: 'Item by item',
      predictedUsage: 'Predicted usage',
      predictedStock: 'Predicted on hand',
      perDay: '/day',
      lastCount: 'Last real count',
      predictionWas: 'AI predicted',
      wasOff: (n: string) => `${n}% off`,
      spotOn: 'spot on',
      noComparisonYet: 'No count to compare against yet',
      noPredictionYet: 'No prediction yet',
      countProgress: (a: number, b: number) => `${a} of ${b} counts`,
      windowsProgress: (a: number, b: number) => `${a} of ${b} clean data windows`,
      pairsProgress: (a: number, b: number) => `${a} of ${b} graded predictions`,
      // Plain-language "why hasn't this graduated" — one per trainer reason code.
      gradReason: (code: string): string =>
        ({
          insufficient_training_windows: 'Still collecting count-to-count history',
          insufficient_prospective_pairs: 'Needs more counts to grade its predictions against',
          prospective_span_too_short: 'Graded predictions need to span more weeks',
          prospective_wape_too_high: 'Predictions not accurate enough yet — still learning',
          prospective_actuals_all_zero: 'Item barely moves — stays manual',
          does_not_beat_baseline: 'Not yet beating the industry-average guess',
        })[code] ?? '',
      // ── Status chips ──
      chipGraduated: 'Graduated',
      chipLearning: 'Learning',
      chipNotEnough: 'Not enough data',
      // ── Loading / error ──
      loading: 'Loading…',
      loadError: 'Couldn’t load the AI report. Try again in a moment.',
    },
    es: {
      eyebrow: 'IA de inventario',
      title: 'Lo que la IA ha aprendido',
      subtitle:
        'La página de inventario sigue siendo totalmente manual — tú cuentas y pides. Por detrás, la IA sigue aprendiendo qué tan rápido se mueve cada artículo. Esta es su libreta de calificaciones.',
      itemsTracked: 'Artículos seguidos',
      graduated: 'Modelos graduados',
      accuracy: 'Precisión general',
      lastPredicted: 'Última predicción',
      pctOff: (n: string) => `${n}% de error`,
      accuracyPending: 'Cargando',
      of: 'de',
      staleWarning:
        'La IA no ha hecho una predicción nueva en más de un día. Sus números abajo pueden estar desactualizados — nada en la página de inventario depende de ellos.',
      noJobsWarning:
        'La IA aún no ha producido datos. Empieza a aprender en cuanto lleguen los conteos.',
      gapWarning: (missing: number, of: number) =>
        `Atención: faltan datos del hotel en ${missing} de los últimos ${of} días (el robot no estaba reportando). Los conteos hechos durante esos días aún no pueden enseñarle a la IA — los huecos se reparan automáticamente cuando el robot se reconecta.`,
      lastPredictedAt: (when: string) => `Última predicción ${when}`,
      never: 'nunca',
      emptyTitle: 'La IA aún no ha hecho ninguna predicción',
      emptyBody:
        'Empieza a aprender a medida que llegan los conteos. Sigue contando el inventario de la forma normal — tras algunos conteos por artículo, la IA empezará a predecir el uso diario y mostrará su trabajo aquí.',
      listHeading: 'Artículo por artículo',
      predictedUsage: 'Uso previsto',
      predictedStock: 'Existencias previstas',
      perDay: '/día',
      lastCount: 'Último conteo real',
      predictionWas: 'La IA predijo',
      wasOff: (n: string) => `${n}% de error`,
      spotOn: 'exacto',
      noComparisonYet: 'Aún no hay conteo para comparar',
      noPredictionYet: 'Sin predicción aún',
      countProgress: (a: number, b: number) => `${a} de ${b} conteos`,
      windowsProgress: (a: number, b: number) => `${a} de ${b} ventanas de datos limpias`,
      pairsProgress: (a: number, b: number) => `${a} de ${b} predicciones calificadas`,
      gradReason: (code: string): string =>
        ({
          insufficient_training_windows: 'Aún reuniendo historial entre conteos',
          insufficient_prospective_pairs: 'Necesita más conteos para calificar sus predicciones',
          prospective_span_too_short: 'Las predicciones calificadas deben abarcar más semanas',
          prospective_wape_too_high: 'Las predicciones aún no son suficientemente precisas — sigue aprendiendo',
          prospective_actuals_all_zero: 'El artículo apenas se mueve — se queda manual',
          does_not_beat_baseline: 'Aún no supera el promedio de la industria',
        })[code] ?? '',
      chipGraduated: 'Graduado',
      chipLearning: 'Aprendiendo',
      chipNotEnough: 'Datos insuficientes',
      loading: 'Cargando…',
      loadError: 'No se pudo cargar el informe de la IA. Inténtalo de nuevo en un momento.',
    },
  }[lang];
}

export type AiStrings = ReturnType<typeof aiStrings>;
