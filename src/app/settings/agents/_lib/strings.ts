// Co-located EN/ES strings for the Settings → Agents section.
//
// Why co-located instead of src/lib/translations.ts: t()'s key argument is a
// CLOSED `TranslationKey` union, so adding keys there without extending the
// union is a TypeScript build error — and the repo precedent (Reports / Wages /
// Voice / Clean-Times sub-pages) is inline `lang==='es'?…:…` bilingual anyway.
// This keeps the whole Agents feature self-contained and build-safe. Every
// string still flows through useLang() via the `lang` arg passed to `s()`.

export type Lang = 'en' | 'es';

type Str = { en: string; es: string };

export const S = {
  // ── section / nav ──
  agents: { en: 'Agents', es: 'Agentes' },
  agentsNavDesc: {
    en: 'AI agents that run your routines — you stay in control',
    es: 'Agentes de IA que ejecutan tus rutinas — tú mantienes el control',
  },
  settings: { en: 'Settings', es: 'Configuración' },
  managerOnly: { en: 'Manager access only.', es: 'Acceso solo para gerentes.' },
  selectProperty: { en: 'Select a property to manage its agents.', es: 'Selecciona una propiedad para gestionar sus agentes.' },

  // ── generic ──
  loading: { en: 'Loading…', es: 'Cargando…' },
  retry: { en: 'Try again', es: 'Reintentar' },
  save: { en: 'Save', es: 'Guardar' },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  back: { en: 'Back', es: 'Volver' },
  next: { en: 'Next', es: 'Siguiente' },
  close: { en: 'Close', es: 'Cerrar' },
  somethingWrong: { en: 'Something went wrong.', es: 'Algo salió mal.' },
  rateLimited: { en: "You're doing that too fast — try again in a moment.", es: 'Estás haciendo eso muy rápido — inténtalo de nuevo en un momento.' },

  // ── list / hub ──
  yourAgents: { en: 'Your agents', es: 'Tus agentes' },
  createAgent: { en: 'Create agent', es: 'Crear agente' },
  noAgentsTitle: { en: 'No agents yet', es: 'Aún no hay agentes' },
  noAgentsBody: {
    en: 'Create your first agent to automate a daily routine. You approve anything that spends money or messages guests.',
    es: 'Crea tu primer agente para automatizar una rutina diaria. Tú apruebas todo lo que gaste dinero o contacte huéspedes.',
  },
  lastRun: { en: 'Last run', es: 'Última ejecución' },
  neverRun: { en: 'Never run', es: 'Nunca ejecutado' },
  runNow: { en: 'Run now', es: 'Ejecutar ahora' },
  testOnDate: { en: 'Test on a date', es: 'Probar en una fecha' },
  history: { en: 'History', es: 'Historial' },
  edit: { en: 'Edit', es: 'Editar' },
  activate: { en: 'Activate', es: 'Activar' },
  pause: { en: 'Pause', es: 'Pausar' },
  archive: { en: 'Archive', es: 'Archivar' },
  restore: { en: 'Restore', es: 'Restaurar' },
  archivedSection: { en: 'Archived', es: 'Archivados' },

  // ── approval inbox ──
  approvalsTitle: { en: 'Needs your approval', es: 'Necesita tu aprobación' },
  approvalsCaught: { en: 'All caught up — nothing waiting on you.', es: 'Todo al día — nada pendiente de ti.' },
  approve: { en: 'Approve', es: 'Aprobar' },
  reject: { en: 'Reject', es: 'Rechazar' },
  spendsMoney: { en: 'Spends money', es: 'Gasta dinero' },
  contactsGuest: { en: 'Contacts guest', es: 'Contacta huésped' },

  // ── wizard: shell ──
  newAgent: { en: 'New agent', es: 'Nuevo agente' },
  editAgent: { en: 'Edit agent', es: 'Editar agente' },
  saveDraft: { en: 'Save as draft', es: 'Guardar como borrador' },
  saveChanges: { en: 'Save changes', es: 'Guardar cambios' },
  stepTemplate: { en: 'Template', es: 'Plantilla' },
  stepBasics: { en: 'Basics', es: 'Básico' },
  stepTrigger: { en: 'Trigger', es: 'Disparador' },
  stepScopes: { en: 'What it sees', es: 'Lo que ve' },
  stepActions: { en: 'What it does', es: 'Lo que hace' },
  stepReview: { en: 'Review', es: 'Revisar' },

  // ── wizard: template ──
  templatePick: { en: 'Start from a template', es: 'Empieza con una plantilla' },
  templateNone: {
    en: 'Ready-made agents are coming soon. For now, build a custom agent below.',
    es: 'Los agentes prediseñados llegarán pronto. Por ahora, crea un agente personalizado abajo.',
  },
  buildCustom: { en: 'Build a custom agent', es: 'Crear un agente personalizado' },
  buildCustomDesc: {
    en: 'Pick from the actions Staxis already supports. Still guided — you choose every step.',
    es: 'Elige entre las acciones que Staxis ya admite. Sigue siendo guiado — tú eliges cada paso.',
  },

  // ── wizard: basics ──
  nameLabel: { en: 'Agent name', es: 'Nombre del agente' },
  namePlaceholder: { en: 'e.g. Morning front-desk check', es: 'p. ej. Revisión matutina de recepción' },
  descLabel: { en: 'Description (optional)', es: 'Descripción (opcional)' },
  descPlaceholder: { en: 'What is this agent for?', es: '¿Para qué sirve este agente?' },

  // ── wizard: trigger ──
  triggerSchedule: { en: 'On a schedule', es: 'En un horario' },
  triggerEvent: { en: 'When something happens', es: 'Cuando ocurre algo' },
  timeOfDay: { en: 'Time of day', es: 'Hora del día' },
  daysLabel: { en: 'Days', es: 'Días' },
  everyDay: { en: 'Every day', es: 'Todos los días' },
  eventLabel: { en: 'Event', es: 'Evento' },
  eventGives: { en: 'The agent receives:', es: 'El agente recibe:' },

  // ── wizard: scopes ──
  scopesIntro: { en: 'Choose what this agent can see when it runs.', es: 'Elige qué puede ver este agente cuando se ejecuta.' },
  comingSoon: { en: 'coming soon', es: 'próximamente' },

  // ── wizard: actions ──
  actionsIntro: { en: 'Choose what this agent can do, and how much it can do on its own.', es: 'Elige qué puede hacer este agente y cuánto puede hacer por sí solo.' },
  pickOneAction: { en: 'Pick at least one action.', es: 'Elige al menos una acción.' },
  fillRequiredFields: {
    en: 'Fill in the required fields (marked *) to continue.',
    es: 'Completa los campos obligatorios (marcados con *) para continuar.',
  },
  safetyDial: { en: 'Safety dial', es: 'Nivel de control' },
  modeSuggest: { en: 'Suggest', es: 'Sugerir' },
  modeApprove: { en: 'Ask me first', es: 'Pregúntame primero' },
  modeAuto: { en: 'Auto', es: 'Automático' },
  autoLocked: {
    en: 'Always needs your approval — it spends money or messages guests.',
    es: 'Siempre necesita tu aprobación — gasta dinero o contacta huéspedes.',
  },

  // ── wizard: review ──
  reviewIntro: { en: 'Review your agent before saving.', es: 'Revisa tu agente antes de guardar.' },
  reviewTrigger: { en: 'Runs', es: 'Se ejecuta' },
  reviewSees: { en: 'Can see', es: 'Puede ver' },
  reviewDoes: { en: 'Can do', es: 'Puede hacer' },
  nothing: { en: 'Nothing selected', es: 'Nada seleccionado' },
  saved: { en: 'Saved', es: 'Guardado' },

  // ── receipt / runs ──
  runReceipt: { en: 'Run receipt', es: 'Recibo de ejecución' },
  simulation: { en: 'SIMULATION — nothing actually happened', es: 'SIMULACIÓN — nada ocurrió de verdad' },
  liveRun: { en: 'Live run', es: 'Ejecución real' },
  whatItDid: { en: 'What it did', es: 'Lo que hizo' },
  whatItWouldDo: { en: 'What it would do', es: 'Lo que haría' },
  caveats: { en: 'Honest caveats', es: 'Advertencias honestas' },
  failed: { en: 'Failed', es: 'Falló' },
  noSteps: { en: "This agent wouldn't have done anything.", es: 'Este agente no habría hecho nada.' },
  noRuns: { en: 'No runs yet — try “Test on a date”.', es: 'Aún no hay ejecuciones — prueba “Probar en una fecha”.' },
  runHistory: { en: 'Run history', es: 'Historial de ejecuciones' },

  // ── test on a date ──
  testIntro: {
    en: 'Pick a past day to see what this agent would have done — nothing real happens.',
    es: 'Elige un día pasado para ver qué habría hecho este agente — nada real ocurre.',
  },
  pickDate: { en: 'Date', es: 'Fecha' },
  runTest: { en: 'Run test', es: 'Ejecutar prueba' },

  // ── run now feedback ──
  runStarted: { en: 'Agent ran.', es: 'El agente se ejecutó.' },
  runNeedsApproval: { en: 'Agent ran — actions need your approval.', es: 'El agente se ejecutó — hay acciones que necesitan tu aprobación.' },
  agentNotFound: { en: 'Agent not found.', es: 'Agente no encontrado.' },
} satisfies Record<string, Str>;

export type StrKey = keyof typeof S;

export function s(lang: Lang, key: StrKey): string {
  return S[key][lang];
}
