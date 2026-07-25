/**
 * feature/housekeeping-levels (2026-07-24) — bilingual copy for the one-time
 * Housekeeping questionnaire (`HousekeepingSetup.tsx`).
 *
 * Co-located with the component, same pattern as `_onboard-i18n.ts` and
 * `_mapping-i18n.ts`: this is one self-contained feature's copy, so it does not
 * belong in the 2,800-line global `translations.ts` that every parallel feature
 * edits at once.
 *
 * The copy here is read by hotel general managers and head housekeepers, not by
 * engineers. Two rules it follows throughout:
 *   • No jargon. No "PMS", no "level 2" as a bare number, no "status entry".
 *     Every question is phrased the way a manager would say it out loud.
 *   • The three levels are described with their DOWNSIDES as well as their
 *     benefits. A hotel that picks a level it can't sustain churns; a hotel that
 *     picks a smaller honest one stays. The downside lines are load-bearing
 *     product copy, not hedging — do not trim them.
 *
 * ES is NOT type-checked against `HkSetupStrings` (the type is derived from
 * `en`), so every key added to `en` MUST be mirrored into `es` by hand.
 */

type Lang = 'en' | 'es';

const STRINGS = {
  en: {
    // ── Chrome: header, progress, navigation ────────────────────────────
    eyebrow: 'Housekeeping setup',
    title: 'A few questions, once',
    subtitle: "This takes about two minutes, and we'll never ask again.",
    stepWord: 'Step',
    ofWord: 'of',
    goToStep: 'Go back to question',
    back: 'Back',
    next: 'Continue',
    skip: 'Skip this',

    // ── Q1 — how a clean room gets recorded today ───────────────────────
    q1Title: 'How does a clean room get into your system today?',
    q1Sub: "When a housekeeper finishes a room, who types it into the system you already use?",
    q1RadioLabel: 'The housekeeper tells the front desk, and the desk enters it',
    q1RadioHint: 'A radio call, a phone call, or a walk down to the desk',
    q1SupervisorLabel: 'A supervisor or head housekeeper enters it',
    q1SupervisorHint: 'She walks the rooms and records them herself',
    q1DirectLabel: 'The housekeepers enter it themselves',
    q1DirectHint: 'A code on the room phone, or their own login',
    q1UnsureLabel: "I'm not sure",
    q1UnsureHint: "That's fine — we'll work it out with you later",

    // ── Q2 — standard room times ────────────────────────────────────────
    q2Title: 'How long should a room take?',
    q2Sub: 'These are your standard times. Every hour and every dollar we show you is built on these two numbers — you can change them later.',
    q2CheckoutLabel: 'Checkout room',
    q2CheckoutHint: 'The guest has left',
    q2StayoverLabel: 'Stayover room',
    q2StayoverHint: 'The guest is staying another night',
    q2Minutes: 'minutes',
    // Split around the numbers so the allowed range is printed from the shared
    // MIN/MAX constants — the copy can't drift from the rule it describes.
    q2InvalidLead: 'Please enter a whole number of minutes between',
    q2InvalidJoin: 'and',

    // ── Q3 — photo of the paper board (always skippable) ────────────────
    q3Title: 'Show us your board',
    q3Sub: "Take a picture of today's paper board so we have it on file. Completely optional — skipping costs you nothing.",
    q3Take: 'Take or choose a photo',
    q3Retake: 'Use a different photo',
    q3Uploading: 'Reading your board…',
    // HONESTY: nothing downstream reads the photo yet, so this must not promise
    // that it pre-fills anything. It says what is true — the board is saved.
    q3Generic: 'Got it — your board is saved.',
    q3ReadLead: 'Looks like',
    q3ReadTail: "— that's your board saved.",
    // Shown ONLY when the file itself can't be read (HEIC from an iPhone
    // library). Neutral, not an error: the step is optional either way.
    q3FormatNote: "That photo format can't be read — try a JPEG, or just skip this step.",
    // Singular + plural kept apart: the sentence is built from counts the photo
    // produced, and "1 sections" on a small hotel's board undercuts the one
    // moment where we are showing them we read their handwriting correctly.
    q3Section: 'section',
    q3Sections: 'sections',
    q3Floor: 'floor',
    q3Floors: 'floors',
    q3Person: 'person',
    q3People: 'people',

    // ── Q4 — shift start + who builds the board ─────────────────────────
    q4Title: 'When does housekeeping start, and who builds the board?',
    q4Sub: "We build tomorrow's board overnight, so it's ready before your team walks in.",
    q4TimeLabel: 'Start time',
    q4WhoLabel: 'Who builds the board today?',
    q4HeadLabel: 'Our head housekeeper',
    q4HeadHint: 'She decides who cleans what',
    q4GmLabel: 'The manager',
    q4GmHint: 'You or another manager',
    q4NobodyLabel: 'Nobody really — people just start',
    q4NobodyHint: 'It sorts itself out each morning',
    q4UnsureLabel: "I'm not sure",
    q4UnsureHint: 'It changes from day to day',
    q4TimeInvalid: 'Please pick a start time.',

    // ── Q5 — inspection policy ──────────────────────────────────────────
    q5Title: "Who checks rooms before they're sold?",
    q5Sub: "Clean and ready-to-sell aren't always the same thing, and we shouldn't treat them as one.",
    q5NoneLabel: 'Nobody',
    q5NoneHint: "Once it's clean, it's ready to sell",
    q5SpotLabel: 'We spot-check some of them',
    q5SpotHint: 'A few rooms a day, or new people',
    q5EveryLabel: 'Every room is checked',
    q5EveryHint: 'Nothing is sold before someone walks it',

    // ── Q6 — side duties ────────────────────────────────────────────────
    q6Title: 'What else do your housekeepers do besides rooms?',
    q6Sub: "Pick everything that applies. If we don't know about this work, the time it takes makes your best people look slow.",
    q6Laundry: 'Laundry',
    q6Breakfast: 'Breakfast',
    q6Lobby: 'Lobby',
    q6PublicAreas: 'Public areas',
    q6Shuttle: 'Driving the shuttle',
    q6None: 'Just rooms',

    // ── Q7 — the three levels ───────────────────────────────────────────
    q7Title: 'How much of Staxis do you want to use?',
    q7Sub: 'Start where it fits your hotel today. You can move up whenever you want.',
    recommended: 'Recommended for you',
    reasonHeadHousekeeper: 'You told us your head housekeeper builds the board — she is the person this pays off for first.',
    reasonSafeStart: 'Nothing changes for your team on day one, and you see the numbers straight away.',
    whoLabel: 'Who opens Staxis',
    goodLabel: 'What you get',
    badLabel: 'What it asks of you',
    lockedLabel: "You don't need this one",
    lockedBody: 'Your housekeepers already mark their own rooms clean in your system — doing it in Staxis too would mean entering the same room twice.',

    l1Name: 'Staxis plans it',
    l1Who: 'Just you',
    l1Good1: "Your board is built overnight and ready to print each morning — on the same paper your team already carries.",
    l1Good2: 'You see the hours the work earned against the hours you paid for, in dollars.',
    l1Good3: 'Nothing changes for a single person on your team.',
    l1Bad1: "If the board gets changed on paper during the day, Staxis won't know about it.",
    // The honest reason to climb to the next one. Without this line the money
    // benefit above reads as the whole answer, and nothing explains why anyone
    // would ever pick anything but the cheapest option.
    l1Bad2: "You'll see the totals for the whole hotel, not what each housekeeper actually did.",

    l2Name: 'Your head housekeeper runs her day in it',
    l2Who: 'You and your head housekeeper',
    l2Good1: 'Her notebook moves into Staxis — board changes, deep cleans, linen counts, lost and found.',
    l2Good2: "It replaces paper she already keeps, so it isn't extra work on top of her day.",
    l2Good3: 'Your numbers stay honest, because her changes land where they get counted.',
    l2Bad1: 'One more person has to open Staxis every day.',
    l2Bad2: 'If she keeps using paper instead, the numbers quietly drift away from reality.',

    l3Name: 'Your housekeepers carry it',
    l3Who: 'Your whole housekeeping team',
    l3Good1: 'Each housekeeper sees their rooms on their phone and taps once when a room is done.',
    l3Good2: 'You get real minutes per room, and you can see where the day stands right now.',
    // THE most important line on this screen. Staxis is read-only into the
    // hotel's own system, forever. Without saying so, "taps once when a room is
    // done" reads as replacing the radio call to the front desk — and a hotel
    // that buys this level believing that feels lied to in week one.
    l3Bad0: "It doesn't mark the room clean in your own system — whoever does that today still does it.",
    l3Bad1: 'Every housekeeper needs a phone and a few minutes of showing.',
    l3Bad2: "It's one new tap in their day — small, but it's still new.",

    // ── Saving ──────────────────────────────────────────────────────────
    finish: 'Finish setup',
    saving: 'Saving…',
    saveError: "We couldn't save your answers. Nothing was lost — try again.",
    // A LOCAL problem (an answer was cleared), not a network one. It must never
    // share the wording above: "try again" on a bad answer is an infinite loop
    // with no clue where the problem is. We also jump back to the question.
    answerCheck: 'One answer needs another look — we’ve taken you back to it.',
    // A 403. "Try again" would be a lie: retrying can never succeed.
    noPermission: "You don't have permission to finish this setup. Ask your owner or general manager to do it.",
    retry: 'Try again',
  },

  es: {
    // ── Chrome ──────────────────────────────────────────────────────────
    eyebrow: 'Configuración de limpieza',
    title: 'Unas preguntas, una sola vez',
    subtitle: 'Toma unos dos minutos y no te lo volveremos a preguntar.',
    stepWord: 'Paso',
    ofWord: 'de',
    goToStep: 'Volver a la pregunta',
    back: 'Atrás',
    next: 'Continuar',
    skip: 'Omitir esto',

    // ── Q1 ──────────────────────────────────────────────────────────────
    q1Title: '¿Cómo se registra hoy una habitación limpia en tu sistema?',
    q1Sub: 'Cuando una camarista termina una habitación, ¿quién la captura en el sistema que ya usan?',
    q1RadioLabel: 'La camarista le avisa a recepción y recepción la captura',
    q1RadioHint: 'Por radio, por teléfono o bajando a recepción',
    q1SupervisorLabel: 'La supervisora o el ama de llaves la captura',
    q1SupervisorHint: 'Ella recorre las habitaciones y las registra',
    q1DirectLabel: 'Las camaristas la capturan ellas mismas',
    q1DirectHint: 'Con un código en el teléfono de la habitación o con su propio acceso',
    // Gender-neutral on purpose: most of the people answering this are women,
    // and 'No estoy seguro' is masculine.
    q1UnsureLabel: 'No sabría decir',
    q1UnsureHint: 'No hay problema — lo vemos contigo más adelante',

    // ── Q2 ──────────────────────────────────────────────────────────────
    q2Title: '¿Cuánto debe tomar una habitación?',
    q2Sub: 'Estos son tus tiempos estándar. Cada hora y cada dólar que te mostramos sale de estos dos números — puedes cambiarlos después.',
    q2CheckoutLabel: 'Habitación de salida',
    q2CheckoutHint: 'El huésped ya se fue',
    q2StayoverLabel: 'Habitación ocupada',
    q2StayoverHint: 'El huésped se queda otra noche',
    q2Minutes: 'minutos',
    q2InvalidLead: 'Escribe un número entero de minutos entre',
    q2InvalidJoin: 'y',

    // ── Q3 ──────────────────────────────────────────────────────────────
    q3Title: 'Muéstranos tu tablero',
    q3Sub: 'Toma una foto del tablero de papel de hoy para que lo tengamos guardado. Es totalmente opcional — omitirlo no te cuesta nada.',
    q3Take: 'Tomar o elegir una foto',
    q3Retake: 'Usar otra foto',
    q3Uploading: 'Leyendo tu tablero…',
    q3Generic: 'Listo — tu tablero quedó guardado.',
    q3ReadLead: 'Parece que hay',
    q3ReadTail: '— tu tablero quedó guardado.',
    q3FormatNote: 'No podemos leer ese formato de foto — prueba con un JPEG, o simplemente omite este paso.',
    q3Section: 'sección',
    q3Sections: 'secciones',
    q3Floor: 'piso',
    q3Floors: 'pisos',
    q3Person: 'persona',
    q3People: 'personas',

    // ── Q4 ──────────────────────────────────────────────────────────────
    q4Title: '¿A qué hora empieza limpieza y quién arma el tablero?',
    q4Sub: 'Armamos el tablero de mañana durante la noche, así que queda listo antes de que llegue tu equipo.',
    q4TimeLabel: 'Hora de inicio',
    q4WhoLabel: '¿Quién arma el tablero hoy?',
    q4HeadLabel: 'Nuestra ama de llaves',
    q4HeadHint: 'Ella decide quién limpia qué',
    q4GmLabel: 'El gerente',
    q4GmHint: 'Tú u otro gerente',
    q4NobodyLabel: 'Nadie en realidad — cada quien empieza',
    q4NobodyHint: 'Se va acomodando cada mañana',
    q4UnsureLabel: 'No sabría decir',
    q4UnsureHint: 'Cambia de un día a otro',
    q4TimeInvalid: 'Elige una hora de inicio.',

    // ── Q5 ──────────────────────────────────────────────────────────────
    q5Title: '¿Quién revisa las habitaciones antes de venderlas?',
    q5Sub: 'Limpia y lista para vender no siempre son lo mismo, y no deberíamos tratarlas igual.',
    q5NoneLabel: 'Nadie',
    q5NoneHint: 'Si está limpia, ya se puede vender',
    q5SpotLabel: 'Revisamos algunas',
    q5SpotHint: 'Unas cuantas al día, o las de gente nueva',
    q5EveryLabel: 'Se revisa cada habitación',
    q5EveryHint: 'No se vende nada sin que alguien la recorra',

    // ── Q6 ──────────────────────────────────────────────────────────────
    q6Title: '¿Qué más hacen tus camaristas además de las habitaciones?',
    q6Sub: 'Marca todo lo que aplique. Si no sabemos de ese trabajo, el tiempo que toma hace que tu mejor gente parezca lenta.',
    q6Laundry: 'Lavandería',
    q6Breakfast: 'Desayuno',
    q6Lobby: 'Lobby',
    q6PublicAreas: 'Áreas públicas',
    q6Shuttle: 'Manejar la camioneta',
    q6None: 'Solo habitaciones',

    // ── Q7 ──────────────────────────────────────────────────────────────
    q7Title: '¿Cuánto de Staxis quieres usar?',
    // 'subir de nivel' is avoided on purpose — EN never says "level" either.
    q7Sub: 'Empieza donde le funcione a tu hotel hoy. Puedes avanzar cuando quieras.',
    recommended: 'Recomendado para ti',
    reasonHeadHousekeeper: 'Nos dijiste que tu ama de llaves arma el tablero — ella es la primera persona a la que esto le rinde.',
    reasonSafeStart: 'Nada cambia para tu equipo el primer día, y tú ves los números de inmediato.',
    whoLabel: 'Quién abre Staxis',
    goodLabel: 'Lo que ganas',
    badLabel: 'Lo que te pide',
    lockedLabel: 'Esto no te hace falta',
    lockedBody: 'Tus camaristas ya marcan sus propias habitaciones como limpias en tu sistema — hacerlo también en Staxis significaría capturar la misma habitación dos veces.',

    l1Name: 'Staxis lo planea',
    l1Who: 'Solo tú',
    l1Good1: 'Tu tablero se arma durante la noche y queda listo para imprimir cada mañana — en el mismo papel que tu equipo ya usa.',
    l1Good2: 'Ves las horas que el trabajo generó frente a las horas que pagaste, en dólares.',
    l1Good3: 'No cambia nada para ninguna persona de tu equipo.',
    l1Bad1: 'Si el tablero se cambia en papel durante el día, Staxis no se entera.',
    l1Bad2: 'Verás los totales del hotel completo, no lo que hizo cada camarista.',

    l2Name: 'Tu ama de llaves lleva su día aquí',
    l2Who: 'Tú y tu ama de llaves',
    l2Good1: 'Su libreta se muda a Staxis — cambios del tablero, limpiezas profundas, conteo de blancos, objetos olvidados.',
    l2Good2: 'Reemplaza el papel que ya lleva, así que no es trabajo extra encima de su día.',
    l2Good3: 'Tus números se mantienen honestos, porque sus cambios quedan registrados donde sí se cuentan.',
    l2Bad1: 'Una persona más tiene que abrir Staxis todos los días.',
    l2Bad2: 'Si ella sigue usando papel, los números se alejan poco a poco de la realidad.',

    l3Name: 'Tus camaristas lo llevan en la mano',
    l3Who: 'Todo tu equipo de limpieza',
    l3Good1: 'Cada camarista ve sus habitaciones en su teléfono y toca una vez cuando termina una.',
    l3Good2: 'Obtienes los minutos reales por habitación y ves cómo va el día en este momento.',
    l3Bad0: 'No marca la habitación como limpia en tu propio sistema — quien lo hace hoy lo sigue haciendo.',
    l3Bad1: 'Cada camarista necesita un teléfono y unos minutos de explicación.',
    l3Bad2: 'Es un toque nuevo en su día — pequeño, pero sigue siendo nuevo.',

    // ── Guardado ────────────────────────────────────────────────────────
    finish: 'Terminar configuración',
    saving: 'Guardando…',
    saveError: 'No pudimos guardar tus respuestas. No se perdió nada — inténtalo de nuevo.',
    answerCheck: 'Hay una respuesta que revisar antes de guardar — te llevamos de vuelta a ella.',
    noPermission: 'No tienes permiso para terminar esta configuración. Pídele a tu dueño o gerente general que la haga.',
    retry: 'Intentar de nuevo',
  },
};

export type HkSetupStrings = (typeof STRINGS)['en'];

export function hkst(lang: Lang): HkSetupStrings {
  return STRINGS[lang] ?? STRINGS.en;
}
