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
      // ── Beginner guide (opens on top of the report card) ──
      guideButtonTitle: 'New here? How the AI works',
      guideButtonSub: 'A plain-English guide — no tech knowledge needed. What it learns, how accurate it gets, and how to help it.',
      guideEyebrow: 'A simple guide',
      guideTitle: 'How the inventory AI works',
      guideSections: [
        {
          h: 'What is this?',
          p: 'Staxis quietly watches two things: the inventory counts your team already does, and how busy the hotel is (check-outs and stayovers from your hotel system). From those, it learns how fast every item really gets used at YOUR hotel — like "about 3 towels per checkout" — and predicts what you’ll need next. There’s nothing to set up. It learns from normal work.',
        },
        {
          h: 'How it learns, step by step',
          p: '1. Your team counts a shelf like normal.  2. The AI works out how much was used since the last count, and how many guests stayed in between.  3. It compares what it PREDICTED against what REALLY happened — every count is a graded test.  4. Grades pile up. When an item passes enough real tests, it earns the "Graduated" badge — meaning its predictions have proven themselves on your actual hotel, not in theory.',
        },
        {
          h: 'What the numbers on this screen mean',
          p: 'Predicted usage — how much of that item the AI thinks your hotel uses per day right now.  Predicted on hand — what it believes is sitting on the shelf.  Clean data windows — completed count-to-count periods it could learn from (it needs 15).  Graded predictions — real tests it’s been scored on (it needs 8, spread across at least two weeks, with good enough grades).',
        },
        {
          h: 'How accurate does it get?',
          p: 'Brand new, it starts from sensible industry averages — decent guesses, but not your hotel. After a few weeks of counting, it’s learning your hotel specifically. After about 3 months of steady counting, everyday items (towels, coffee, soap, shampoo) usually land 85–90% accurate — about as good as physically possible, because shelf miscounts and unpredictable guests make 100% impossible for anyone. Rare items like light bulbs and batteries stay manual on purpose: their usage isn’t tied to guests, and pretending otherwise would just mean made-up numbers.',
        },
        {
          h: 'How to make it learn faster and better',
          p: 'Count twice a week — the single biggest lever: twice the lessons, and each lesson is cleaner.  Log every delivery and write-off in the app — an unlogged delivery looks like guests used 40 towels overnight and poisons the math (scanning the invoice does this for you).  Keep the robot connection healthy — a day without hotel data can’t teach anything (missed days now repair themselves once it reconnects).  And every hotel on Staxis makes the starting guesses smarter for the next one — automatically.',
        },
        {
          h: 'What it will never do',
          p: 'It will never ask you to stop counting completely. Counting is how the AI proves it’s right — and the only way anyone catches theft, damage, or waste. The real goal: counting shrinks from a weekly chore to a quick spot-check, while the AI does the reorder thinking for you.',
        },
        {
          h: 'The timeline',
          p: 'Counting twice a week → useful, hotel-specific predictions in about 3 weeks, and the "Graduated" trust badge in about 2–3 months. Counting weekly → roughly double that. The clock starts the day the hotel’s robot is connected and counting begins.',
        },
      ],
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
      guideButtonTitle: '¿Nuevo aquí? Cómo funciona la IA',
      guideButtonSub: 'Una guía en lenguaje sencillo — sin conocimientos técnicos. Qué aprende, qué tan precisa llega a ser y cómo ayudarla.',
      guideEyebrow: 'Una guía sencilla',
      guideTitle: 'Cómo funciona la IA de inventario',
      guideSections: [
        {
          h: '¿Qué es esto?',
          p: 'Staxis observa silenciosamente dos cosas: los conteos de inventario que tu equipo ya hace, y qué tan ocupado está el hotel (salidas y huéspedes que se quedan, según tu sistema hotelero). Con eso aprende qué tan rápido se usa realmente cada artículo en TU hotel — por ejemplo "unas 3 toallas por salida" — y predice lo que vas a necesitar. No hay nada que configurar. Aprende del trabajo normal.',
        },
        {
          h: 'Cómo aprende, paso a paso',
          p: '1. Tu equipo cuenta un estante como siempre.  2. La IA calcula cuánto se usó desde el último conteo y cuántos huéspedes hubo en medio.  3. Compara lo que PREDIJO contra lo que REALMENTE pasó — cada conteo es un examen calificado.  4. Las calificaciones se acumulan. Cuando un artículo aprueba suficientes exámenes reales, gana la insignia de "Graduado" — sus predicciones se probaron en tu hotel real, no en teoría.',
        },
        {
          h: 'Qué significan los números de esta pantalla',
          p: 'Uso previsto — cuánto de ese artículo cree la IA que tu hotel usa por día ahora mismo.  Existencias previstas — lo que cree que hay en el estante.  Ventanas de datos limpias — períodos completos entre conteos de los que pudo aprender (necesita 15).  Predicciones calificadas — exámenes reales en los que fue evaluada (necesita 8, repartidos en al menos dos semanas, con buenas notas).',
        },
        {
          h: '¿Qué tan precisa llega a ser?',
          p: 'Recién estrenada, parte de promedios sensatos de la industria — buenas suposiciones, pero no tu hotel. Tras unas semanas de conteos, ya aprende tu hotel específicamente. Después de unos 3 meses de conteo constante, los artículos de uso diario (toallas, café, jabón, champú) suelen quedar entre 85–90% de precisión — casi el máximo físicamente posible, porque los errores al contar estantes y los huéspedes impredecibles hacen que el 100% sea imposible para cualquiera. Los artículos raros como focos y baterías se quedan manuales a propósito: su uso no depende de los huéspedes, y fingir lo contrario serían números inventados.',
        },
        {
          h: 'Cómo hacer que aprenda más rápido y mejor',
          p: 'Cuenta dos veces por semana — la palanca más grande: el doble de lecciones, y cada lección más limpia.  Registra cada entrega y cada merma en la app — una entrega sin registrar parece que los huéspedes usaron 40 toallas en una noche y envenena las cuentas (escanear la factura lo hace por ti).  Mantén sana la conexión del robot — un día sin datos del hotel no puede enseñar nada (los días perdidos ahora se reparan solos al reconectarse).  Y cada hotel en Staxis hace más inteligentes las suposiciones iniciales para el siguiente — automáticamente.',
        },
        {
          h: 'Lo que nunca hará',
          p: 'Nunca te pedirá dejar de contar por completo. Contar es cómo la IA demuestra que acierta — y la única forma de detectar robo, daño o desperdicio. La meta real: contar pasa de ser una tarea semanal a una revisión rápida, mientras la IA piensa los pedidos por ti.',
        },
        {
          h: 'Los tiempos',
          p: 'Contando dos veces por semana → predicciones útiles y específicas de tu hotel en unas 3 semanas, y la insignia de "Graduado" en unos 2–3 meses. Contando una vez por semana → aproximadamente el doble. El reloj empieza el día que el robot del hotel está conectado y comienzan los conteos.',
        },
      ],
    },
  }[lang];
}

export type AiStrings = ReturnType<typeof aiStrings>;
