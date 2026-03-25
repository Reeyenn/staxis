export type Language = 'en' | 'es';

type TranslationKey =
  // Navigation
  | 'dashboard' | 'morningSetup' | 'rooms' | 'analytics' | 'roi' | 'settings' | 'staffing' | 'maintenance'
  // Room status / type / priority
  | 'clean' | 'dirty' | 'inProgress' | 'checkout' | 'stayover'
  | 'vip' | 'earlyCheckin' | 'standard'
  // Staffing
  | 'housekeepers' | 'housekeeper'
  | 'calculateSchedule' | 'calculated' | 'saveToLog'
  | 'occupied' | 'checkouts' | 'stayovers' | 'startTime'
  | 'roomMinutes' | 'publicAreaMinutes' | 'laundryMinutes' | 'totalMinutes'
  | 'recommended' | 'estimatedFinish' | 'laborCost' | 'laborSaved'
  // Time ranges
  | 'today' | 'thisWeek' | 'thisMonth' | 'allTime'
  // Rooms actions
  | 'addRoom' | 'bulkAdd' | 'smartAssign' | 'roomNumber'
  | 'assignTo' | 'priority' | 'type' | 'status'
  | 'start' | 'done' | 'remove'
  // Settings sections
  | 'staff' | 'publicAreas' | 'laundry' | 'property' | 'pmsConnection'
  | 'addStaff' | 'addArea' | 'save' | 'cancel' | 'delete' | 'edit'
  | 'name' | 'phone' | 'language' | 'senior' | 'scheduledToday'
  | 'overtimeWarning' | 'loading' | 'signIn' | 'signOut'
  // ROI
  | 'totalSaved' | 'totalPaid' | 'returnOnInvestment'
  // Public areas
  | 'publicAreasDueToday' | 'noAreasToday' | 'floor'
  // Morning / forecast
  | 'goodMorning' | 'tomorrowForecast' | 'lastSynced'
  | 'twoBedCheckouts' | 'vipRooms' | 'earlyCheckinRequests'
  | 'scheduledStaff' | 'complete'
  // Maintenance
  | 'newWorkOrder' | 'workOrders' | 'severity' | 'low' | 'medium' | 'urgent'
  | 'submitted' | 'assigned' | 'resolved' | 'submittedBy' | 'workOrderNotes'
  | 'markInProgress' | 'markResolved' | 'allOrders' | 'openOrders' | 'reportIssue'
  // Inspection
  | 'inspected' | 'markInspected' | 'inspectedBy' | 'pendingInspection' | 'inspectRoom' | 'needsInspection'

  // ── New keys ──────────────────────────────────────────────────────────────
  // General UI
  | 'back' | 'continue' | 'review' | 'update' | 'offline'
  // Sign-in page
  | 'signInHeroTitle' | 'signInSubtitle'
  | 'signInFeature1' | 'signInFeature2' | 'signInFeature3'
  | 'signInSecure'
  // Onboarding
  | 'onboardingTitle' | 'onboardingSubtitle'
  | 'stepPropertyLabel' | 'stepRoomsStaff' | 'stepFinancials' | 'stepDone'
  | 'propertyNameLabel' | 'propertyNameHelp'
  | 'totalRoomsField' | 'avgOccupancyField' | 'staffOnRosterField'
  | 'hourlyWageField' | 'checkoutMinutesField' | 'stayoverMinutesField'
  | 'shiftLengthField' | 'weeklyBudgetField'
  | 'nextStepTitle' | 'nextStepDesc' | 'openApp' | 'savingDots'
  // Dashboard
  | 'todaysSchedule' | 'startMorningSetup' | 'calculateTodaySchedule'
  | 'laborSavedSuffix' | 'weeklyBudgetLabel'
  | 'roomPriorityQueue' | 'roomsRemainingLabel'
  | 'operations'
  | 'guestRequests' | 'guestRequestsSub'
  | 'staffRosterLabel' | 'staffRosterSub'
  | 'inventoryLabel' | 'inventorySub'
  | 'shiftLogbookLabel' | 'shiftLogbookSub'
  | 'opsWallLabel' | 'opsWallSub'
  | 'roomsCompleteOf' | 'roomsCompleteLabel'
  | 'dailySavingsChart' | 'daysLabel'
  // Morning setup
  | 'roomNumbersSection' | 'scheduleSection'
  | 'meetingRoomRented' | 'addsCleaningTime'
  | 'smartPrediction' | 'apply'
  | 'breakfastStaffing' | 'attendantsLabel' | 'setupStart'
  | 'workloadBreakdown' | 'keyMetrics'
  | 'vsFullTeam' | 'savingToday' | 'savedToLog' | 'savingInProgress'
  | 'laundryBreakdownLabel' | 'houseekeepersNeededToday'
  | 'hourlyWageDollar' | 'basedOnOccupied'
  // Staffing calculator
  | 'planningTool' | 'staffingCalculatorTitle'
  | 'roomInfoSection' | 'roomsOccupiedLabel' | 'checkoutsTodayLabel'
  | 'shiftStartLabel' | 'recommendedHousekeepers'
  | 'costPerRoom' | 'staffingComparison'
  | 'actualHousekeepersLabel' | 'enterCountToSeeImpact'
  | 'staffedRight' | 'overstaffedBy' | 'extraLaborCost'
  | 'understaffedBy' | 'estimatedOvertime'
  | 'enterRoomsToSeeRecs' | 'eightHrShifts'
  // Housekeeper notifications page
  | 'setupNotifications' | 'selectNameDesc'
  | 'enableNotifications' | 'settingUp' | 'tapAllow'
  | 'notifDoneDesc' | 'closeThisPage'
  | 'notificationsBlocked' | 'goToBrowserSettings'
  | 'tryAgain' | 'somethingWentWrong' | 'badLink'
  // Staff page
  | 'staffRosterTitle' | 'totalStaffLabel' | 'scheduledTodayCount' | 'nearOvertime'
  | 'overtimeAlert' | 'overtimeAlertDesc'
  | 'noStaffYet' | 'scheduledTodayStatus' | 'notScheduled'
  | 'addStaffMember' | 'nameRequired' | 'phoneOptional'
  | 'hourlyWageOptional' | 'maxWeeklyHoursLabel' | 'seniorStaff'
  | 'hoursLeftLabel'
  // Priority queue
  | 'priorityOrder' | 'vipCheckout' | 'earlyCheckout' | 'standardCheckout' | 'vipStayover' | 'standardStayover';

const translations: Record<Language, Record<TranslationKey, string>> = {
  en: {
    // ── Navigation ──
    dashboard: 'Dashboard',
    morningSetup: 'Morning Setup',
    rooms: 'Rooms',
    analytics: 'Analytics',
    roi: 'ROI',
    settings: 'Settings',
    staffing: 'Staffing',
    // ── Room status / type / priority ──
    clean: 'Clean',
    dirty: 'Dirty',
    inProgress: 'In Progress',
    checkout: 'Checkout',
    stayover: 'Stayover',
    vip: 'VIP',
    earlyCheckin: 'Early Check-In',
    standard: 'Standard',
    // ── Staffing ──
    housekeepers: 'Housekeepers',
    housekeeper: 'Housekeeper',
    calculateSchedule: 'Calculate Schedule',
    calculated: 'Calculated',
    saveToLog: 'Save to Log',
    occupied: 'Rooms Occupied Last Night',
    checkouts: 'Rooms Checking Out Today',
    stayovers: 'Stayovers',
    startTime: 'Start Time',
    roomMinutes: 'Room Cleaning',
    publicAreaMinutes: 'Public Areas',
    laundryMinutes: 'Laundry',
    totalMinutes: 'Total',
    recommended: 'Recommended',
    estimatedFinish: 'Est. Finish',
    laborCost: 'Labor Cost',
    laborSaved: 'Saved Today',
    // ── Time ranges ──
    today: 'Today',
    thisWeek: 'This Week',
    thisMonth: 'This Month',
    allTime: 'All Time',
    // ── Room actions ──
    addRoom: 'Add Room',
    bulkAdd: 'Bulk Add',
    smartAssign: 'Smart Assign',
    roomNumber: 'Room Number',
    assignTo: 'Assign To',
    priority: 'Priority',
    type: 'Type',
    status: 'Status',
    start: 'Start',
    done: 'Done',
    remove: 'Remove',
    // ── Settings ──
    staff: 'Staff',
    publicAreas: 'Public Areas',
    laundry: 'Laundry',
    property: 'Property',
    pmsConnection: 'PMS Connection',
    addStaff: 'Add Staff',
    addArea: 'Add Area',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    name: 'Name',
    phone: 'Phone',
    language: 'Language',
    senior: 'Senior',
    scheduledToday: 'Scheduled Today',
    overtimeWarning: 'Will hit overtime',
    loading: 'Loading...',
    signIn: 'Sign in with Google',
    signOut: 'Sign Out',
    // ── ROI ──
    totalSaved: 'Total Saved',
    totalPaid: 'Total Paid',
    returnOnInvestment: 'Return on Investment',
    // ── Public areas ──
    publicAreasDueToday: 'Public Areas Due Today',
    noAreasToday: 'No public areas scheduled today',
    floor: 'Floor',
    // ── Morning / forecast ──
    goodMorning: 'Good morning',
    tomorrowForecast: "Tomorrow's Forecast",
    lastSynced: 'Last synced',
    twoBedCheckouts: '2-Bed Rooms Checking Out',
    vipRooms: 'VIP Rooms',
    earlyCheckinRequests: 'Early Check-In Requests',
    scheduledStaff: 'Housekeepers Scheduled',
    complete: 'Complete',
    // ── Maintenance ──
    maintenance: 'Maintenance',
    newWorkOrder: 'New Work Order',
    workOrders: 'Work Orders',
    severity: 'Severity',
    low: 'Low',
    medium: 'Medium',
    urgent: 'Urgent',
    submitted: 'Submitted',
    assigned: 'Assigned',
    resolved: 'Resolved',
    submittedBy: 'Submitted By',
    workOrderNotes: 'Notes',
    markInProgress: 'Mark In Progress',
    markResolved: 'Mark Resolved',
    allOrders: 'All',
    openOrders: 'Open',
    reportIssue: 'Report Issue',
    // ── Inspection ──
    inspected: 'Inspected',
    markInspected: 'Sign Off',
    inspectedBy: 'Signed off by',
    pendingInspection: 'Pending Inspection',
    inspectRoom: 'Inspect Room',
    needsInspection: 'Needs Inspection',

    // ── New keys ─────────────────────────────────────────────────────────────
    // General UI
    back: 'Back',
    continue: 'Continue',
    review: 'Review',
    update: 'Update',
    offline: "You're offline — changes will sync when reconnected",
    // Sign-in
    signInHeroTitle: 'Run your hotel like a machine.',
    signInSubtitle: 'Daily operations, optimized.',
    signInFeature1: 'Know exactly how many housekeepers you need',
    signInFeature2: 'Zero manual entry — just input your numbers',
    signInFeature3: 'See dollar savings updated every single day',
    signInSecure: 'Secure sign-in via Google. No password needed.',
    // Onboarding
    onboardingTitle: 'Set up your property',
    onboardingSubtitle: 'Takes about 2 minutes',
    stepPropertyLabel: 'Property',
    stepRoomsStaff: 'Rooms & Staff',
    stepFinancials: 'Financials',
    stepDone: 'Done',
    propertyNameLabel: 'Property Name',
    propertyNameHelp: 'This will appear in all your reports and schedules',
    totalRoomsField: 'Total Rooms',
    avgOccupancyField: 'Average Rooms Occupied Per Night',
    staffOnRosterField: 'Housekeeping Staff on Roster',
    hourlyWageField: 'Housekeeper Hourly Wage',
    checkoutMinutesField: 'Minutes to Clean a Checkout Room',
    stayoverMinutesField: 'Minutes to Clean a Stayover Room',
    shiftLengthField: 'Shift Length',
    weeklyBudgetField: 'Weekly Labor Budget (optional)',
    nextStepTitle: 'Next step:',
    nextStepDesc: "Open Morning Setup every day and hit Calculate. You'll see exactly how many housekeepers you need — and how much you're saving.",
    openApp: 'Open HotelOps AI →',
    savingDots: 'Saving...',
    // Dashboard
    todaysSchedule: "Today's Schedule",
    startMorningSetup: 'Start morning setup',
    calculateTodaySchedule: "Calculate today's schedule",
    laborSavedSuffix: 'labor saved',
    weeklyBudgetLabel: 'Weekly Budget',
    roomPriorityQueue: 'Room Priority Queue',
    roomsRemainingLabel: 'rooms remaining',
    operations: 'Operations',
    guestRequests: 'Guest Requests',
    guestRequestsSub: 'Track room requests',
    staffRosterLabel: 'Staff Roster',
    staffRosterSub: 'Manage housekeepers',
    inventoryLabel: 'Inventory',
    inventorySub: 'Par levels & supplies',
    shiftLogbookLabel: 'Shift Logbook',
    shiftLogbookSub: 'Handoff notes',
    opsWallLabel: 'Ops Wall',
    opsWallSub: 'Live room status display',
    roomsCompleteOf: 'of',
    roomsCompleteLabel: 'rooms complete',
    dailySavingsChart: 'Daily Savings — Last',
    daysLabel: 'Days',
    // Morning setup
    roomNumbersSection: 'Room Numbers',
    scheduleSection: 'Schedule',
    meetingRoomRented: 'Meeting Room rented today?',
    addsCleaningTime: 'Adds cleaning time',
    smartPrediction: 'Smart Prediction',
    apply: 'Apply',
    breakfastStaffing: 'Breakfast Staffing',
    attendantsLabel: 'Attendant(s)',
    setupStart: 'Setup Start',
    workloadBreakdown: 'Workload Breakdown',
    keyMetrics: 'Key Metrics',
    vsFullTeam: 'vs. scheduling your full team',
    savingToday: 'Saving',
    savedToLog: 'Saved to Daily Log',
    savingInProgress: 'Saving…',
    laundryBreakdownLabel: 'Laundry Breakdown',
    houseekeepersNeededToday: 'housekeepers needed today',
    hourlyWageDollar: 'Hourly Wage ($)',
    basedOnOccupied: '1 attendant per ~45 guests',
    // Staffing calculator
    planningTool: 'Planning Tool',
    staffingCalculatorTitle: 'Staffing Calculator',
    roomInfoSection: 'Room Info',
    roomsOccupiedLabel: 'Rooms Occupied',
    checkoutsTodayLabel: 'Checkouts Today',
    shiftStartLabel: 'Shift Start',
    recommendedHousekeepers: 'Recommended Housekeepers',
    costPerRoom: 'Cost Per Room',
    staffingComparison: 'Staffing Comparison',
    actualHousekeepersLabel: 'Actual Housekeepers Scheduled',
    enterCountToSeeImpact: 'Enter your actual scheduled count to see over/understaffing impact',
    staffedRight: 'Staffed exactly right',
    overstaffedBy: 'Overstaffed by',
    extraLaborCost: 'Extra labor cost:',
    understaffedBy: 'Understaffed by',
    estimatedOvertime: 'Estimated overtime:',
    enterRoomsToSeeRecs: 'Enter rooms occupied to see staffing recommendations',
    eightHrShifts: '8-hr shifts',
    // Housekeeper notifications
    setupNotifications: 'Set up notifications',
    selectNameDesc: 'Select your name so we can send your room assignments to this phone.',
    enableNotifications: 'Enable Notifications',
    settingUp: 'Setting up…',
    tapAllow: 'Tap "Allow" when your browser asks.',
    notifDoneDesc: "When your manager assigns rooms, you'll get a notification on this phone — even if the app is closed.",
    closeThisPage: 'You can close this page.',
    notificationsBlocked: 'Notifications blocked',
    goToBrowserSettings: 'Go to your browser settings, find this site, and allow notifications. Then come back and try again.',
    tryAgain: 'Try again',
    somethingWentWrong: 'Something went wrong',
    badLink: 'This link is missing information. Ask your manager to resend the correct link.',
    // Staff page
    staffRosterTitle: 'Staff Roster',
    totalStaffLabel: 'Total Staff',
    scheduledTodayCount: 'Scheduled Today',
    nearOvertime: 'Near Overtime',
    overtimeAlert: 'Overtime Alert',
    overtimeAlertDesc: 'One or more staff members are approaching or exceeding their maximum weekly hours.',
    noStaffYet: 'No staff added yet. Add your first housekeeper to get started.',
    scheduledTodayStatus: 'Scheduled Today',
    notScheduled: 'Not Scheduled',
    addStaffMember: 'Add Staff Member',
    nameRequired: 'Name *',
    phoneOptional: 'Phone (optional)',
    hourlyWageOptional: 'Hourly Wage (optional)',
    maxWeeklyHoursLabel: 'Max Weekly Hours',
    seniorStaff: 'Senior Staff',
    hoursLeftLabel: 'h left',
    // Priority queue
    priorityOrder: 'Priority Order',
    vipCheckout: 'VIP Checkout',
    earlyCheckout: 'Early Checkout',
    standardCheckout: 'Standard Checkout',
    vipStayover: 'VIP Stayover',
    standardStayover: 'Standard Stayover',
  },

  es: {
    // ── Navigation ──
    dashboard: 'Tablero',
    morningSetup: 'Conf. Matutina',
    rooms: 'Habitaciones',
    analytics: 'Análisis',
    roi: 'Retorno',
    settings: 'Ajustes',
    staffing: 'Personal',
    // ── Room status / type / priority ──
    clean: 'Limpia',
    dirty: 'Sucia',
    inProgress: 'En Progreso',
    checkout: 'Salida',
    stayover: 'Continuación',
    vip: 'VIP',
    earlyCheckin: 'Entrada Temprana',
    standard: 'Estándar',
    // ── Staffing ──
    housekeepers: 'Camareras',
    housekeeper: 'Camarera',
    calculateSchedule: 'Calcular Horario',
    calculated: 'Calculado',
    saveToLog: 'Guardar',
    occupied: 'Habitaciones Ocupadas Anoche',
    checkouts: 'Salidas de Hoy',
    stayovers: 'Continuaciones',
    startTime: 'Hora de Inicio',
    roomMinutes: 'Limpieza de Hab.',
    publicAreaMinutes: 'Áreas Comunes',
    laundryMinutes: 'Lavandería',
    totalMinutes: 'Total',
    recommended: 'Recomendado',
    estimatedFinish: 'Fin Estimado',
    laborCost: 'Costo de Labor',
    laborSaved: 'Ahorrado Hoy',
    // ── Time ranges ──
    today: 'Hoy',
    thisWeek: 'Esta Semana',
    thisMonth: 'Este Mes',
    allTime: 'Total',
    // ── Room actions ──
    addRoom: 'Agregar Hab.',
    bulkAdd: 'Agregar Varias',
    smartAssign: 'Asignación Inteligente',
    roomNumber: 'Número de Hab.',
    assignTo: 'Asignar A',
    priority: 'Prioridad',
    type: 'Tipo',
    status: 'Estado',
    start: 'Iniciar',
    done: 'Listo',
    remove: 'Eliminar',
    // ── Settings ──
    staff: 'Personal',
    publicAreas: 'Áreas Comunes',
    laundry: 'Lavandería',
    property: 'Propiedad',
    pmsConnection: 'Conexión PMS',
    addStaff: 'Agregar Personal',
    addArea: 'Agregar Área',
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    edit: 'Editar',
    name: 'Nombre',
    phone: 'Teléfono',
    language: 'Idioma',
    senior: 'Senior',
    scheduledToday: 'Programada Hoy',
    overtimeWarning: 'Llegará a tiempo extra',
    loading: 'Cargando...',
    signIn: 'Iniciar sesión con Google',
    signOut: 'Cerrar Sesión',
    // ── ROI ──
    totalSaved: 'Total Ahorrado',
    totalPaid: 'Total Pagado',
    returnOnInvestment: 'Retorno de Inversión',
    // ── Public areas ──
    publicAreasDueToday: 'Áreas Comunes para Hoy',
    noAreasToday: 'No hay áreas comunes programadas para hoy',
    floor: 'Piso',
    // ── Morning / forecast ──
    goodMorning: 'Buenos días',
    tomorrowForecast: 'Pronóstico de Mañana',
    lastSynced: 'Última sincronización',
    twoBedCheckouts: 'Hab. Dobles con Salida',
    vipRooms: 'Habitaciones VIP',
    earlyCheckinRequests: 'Solicitudes de Entrada Temprana',
    scheduledStaff: 'Camareras Programadas',
    complete: 'Completado',
    // ── Maintenance ──
    maintenance: 'Mantenimiento',
    newWorkOrder: 'Nueva Orden',
    workOrders: 'Órdenes de Trabajo',
    severity: 'Severidad',
    low: 'Baja',
    medium: 'Media',
    urgent: 'Urgente',
    submitted: 'Enviada',
    assigned: 'Asignada',
    resolved: 'Resuelta',
    submittedBy: 'Enviada Por',
    workOrderNotes: 'Notas',
    markInProgress: 'Marcar En Progreso',
    markResolved: 'Marcar Resuelta',
    allOrders: 'Todas',
    openOrders: 'Abiertas',
    reportIssue: 'Reportar Problema',
    // ── Inspection ──
    inspected: 'Inspeccionada',
    markInspected: 'Aprobar',
    inspectedBy: 'Aprobada por',
    pendingInspection: 'Pendiente de Inspección',
    inspectRoom: 'Inspeccionar Hab.',
    needsInspection: 'Necesita Inspección',

    // ── New keys ─────────────────────────────────────────────────────────────
    // General UI
    back: 'Atrás',
    continue: 'Continuar',
    review: 'Revisar',
    update: 'Actualizar',
    offline: 'Sin conexión — los cambios se sincronizarán al reconectarte',
    // Sign-in
    signInHeroTitle: 'Administra tu hotel como una máquina.',
    signInSubtitle: 'Operaciones diarias, optimizadas.',
    signInFeature1: 'Sabe exactamente cuántas camareras necesitas',
    signInFeature2: 'Sin entrada manual — solo ingresa tus números',
    signInFeature3: 'Ve los ahorros en dólares actualizados cada día',
    signInSecure: 'Inicio seguro con Google. Sin contraseña.',
    // Onboarding
    onboardingTitle: 'Configura tu propiedad',
    onboardingSubtitle: 'Tarda unos 2 minutos',
    stepPropertyLabel: 'Propiedad',
    stepRoomsStaff: 'Hab. y Personal',
    stepFinancials: 'Finanzas',
    stepDone: 'Listo',
    propertyNameLabel: 'Nombre de la Propiedad',
    propertyNameHelp: 'Aparecerá en todos tus reportes y horarios',
    totalRoomsField: 'Total de Habitaciones',
    avgOccupancyField: 'Hab. Promedio Ocupadas por Noche',
    staffOnRosterField: 'Personal de Limpieza',
    hourlyWageField: 'Salario por Hora',
    checkoutMinutesField: 'Minutos por Hab. de Salida',
    stayoverMinutesField: 'Minutos por Hab. de Continuación',
    shiftLengthField: 'Duración del Turno',
    weeklyBudgetField: 'Presupuesto Semanal (opcional)',
    nextStepTitle: 'Próximo paso:',
    nextStepDesc: 'Abre Conf. Matutina cada día y toca Calcular. Verás exactamente cuántas camareras necesitas — y cuánto estás ahorrando.',
    openApp: 'Abrir HotelOps AI →',
    savingDots: 'Guardando...',
    // Dashboard
    todaysSchedule: 'Horario de Hoy',
    startMorningSetup: 'Iniciar configuración matutina',
    calculateTodaySchedule: 'Calcular el horario de hoy',
    laborSavedSuffix: 'labor ahorrada',
    weeklyBudgetLabel: 'Presupuesto Semanal',
    roomPriorityQueue: 'Cola de Habitaciones',
    roomsRemainingLabel: 'habitaciones restantes',
    operations: 'Operaciones',
    guestRequests: 'Solicitudes de Huéspedes',
    guestRequestsSub: 'Rastrear solicitudes',
    staffRosterLabel: 'Plantilla de Personal',
    staffRosterSub: 'Administrar camareras',
    inventoryLabel: 'Inventario',
    inventorySub: 'Niveles y suministros',
    shiftLogbookLabel: 'Libro de Turnos',
    shiftLogbookSub: 'Notas de traspaso',
    opsWallLabel: 'Muro de Operaciones',
    opsWallSub: 'Estado de habitaciones en vivo',
    roomsCompleteOf: 'de',
    roomsCompleteLabel: 'habitaciones listas',
    dailySavingsChart: 'Ahorros Diarios — Últimos',
    daysLabel: 'Días',
    // Morning setup
    roomNumbersSection: 'Números de Habitaciones',
    scheduleSection: 'Horario',
    meetingRoomRented: '¿Sala de reuniones rentada hoy?',
    addsCleaningTime: 'Agrega tiempo de limpieza',
    smartPrediction: 'Predicción Inteligente',
    apply: 'Aplicar',
    breakfastStaffing: 'Personal para Desayuno',
    attendantsLabel: 'Asistente(s)',
    setupStart: 'Inicio de Preparación',
    workloadBreakdown: 'Desglose de Carga',
    keyMetrics: 'Métricas Clave',
    vsFullTeam: 'vs. programar todo el equipo',
    savingToday: 'Ahorrando',
    savedToLog: 'Guardado en el Registro',
    savingInProgress: 'Guardando…',
    laundryBreakdownLabel: 'Desglose de Lavandería',
    houseekeepersNeededToday: 'camareras necesarias hoy',
    hourlyWageDollar: 'Salario por Hora ($)',
    basedOnOccupied: '1 asistente por ~45 huéspedes',
    // Staffing calculator
    planningTool: 'Herramienta de Planificación',
    staffingCalculatorTitle: 'Calculadora de Personal',
    roomInfoSection: 'Info de Habitaciones',
    roomsOccupiedLabel: 'Habitaciones Ocupadas',
    checkoutsTodayLabel: 'Salidas de Hoy',
    shiftStartLabel: 'Inicio de Turno',
    recommendedHousekeepers: 'Camareras Recomendadas',
    costPerRoom: 'Costo por Habitación',
    staffingComparison: 'Comparación de Personal',
    actualHousekeepersLabel: 'Camareras Realmente Programadas',
    enterCountToSeeImpact: 'Ingresa tu conteo real para ver el impacto',
    staffedRight: 'Personal exactamente correcto',
    overstaffedBy: 'Sobredotado por',
    extraLaborCost: 'Costo extra de labor:',
    understaffedBy: 'Subdotado por',
    estimatedOvertime: 'Tiempo extra estimado:',
    enterRoomsToSeeRecs: 'Ingresa habitaciones ocupadas para ver recomendaciones',
    eightHrShifts: 'turnos de 8 hrs',
    // Housekeeper notifications
    setupNotifications: 'Configurar notificaciones',
    selectNameDesc: 'Selecciona tu nombre para que podamos enviar tus asignaciones de habitaciones a este teléfono.',
    enableNotifications: 'Activar Notificaciones',
    settingUp: 'Configurando…',
    tapAllow: 'Toca "Permitir" cuando el navegador lo pida.',
    notifDoneDesc: 'Cuando tu gerente asigne habitaciones, recibirás una notificación en este teléfono — aunque la app esté cerrada.',
    closeThisPage: 'Puedes cerrar esta página.',
    notificationsBlocked: 'Notificaciones bloqueadas',
    goToBrowserSettings: 'Ve a los ajustes del navegador, encuentra este sitio y permite las notificaciones. Luego regresa e intenta de nuevo.',
    tryAgain: 'Intentar de nuevo',
    somethingWentWrong: 'Algo salió mal',
    badLink: 'Este enlace está incompleto. Pide a tu gerente que reenvíe el enlace correcto.',
    // Staff page
    staffRosterTitle: 'Plantilla de Personal',
    totalStaffLabel: 'Total de Personal',
    scheduledTodayCount: 'Programadas Hoy',
    nearOvertime: 'Cerca de Tiempo Extra',
    overtimeAlert: 'Alerta de Tiempo Extra',
    overtimeAlertDesc: 'Uno o más miembros del personal se están acercando o excediendo sus horas máximas semanales.',
    noStaffYet: 'Sin personal todavía. Agrega tu primera camarera para comenzar.',
    scheduledTodayStatus: 'Programada Hoy',
    notScheduled: 'No Programada',
    addStaffMember: 'Agregar Personal',
    nameRequired: 'Nombre *',
    phoneOptional: 'Teléfono (opcional)',
    hourlyWageOptional: 'Salario por Hora (opcional)',
    maxWeeklyHoursLabel: 'Horas Semanales Máximas',
    seniorStaff: 'Personal Senior',
    hoursLeftLabel: 'h restantes',
    // Priority queue
    priorityOrder: 'Orden de Prioridad',
    vipCheckout: 'Salida VIP',
    earlyCheckout: 'Salida Temprana',
    standardCheckout: 'Salida Estándar',
    vipStayover: 'Permanencia VIP',
    standardStayover: 'Permanencia Estándar',
  },
};

export function t(key: TranslationKey, lang: Language = 'en'): string {
  return translations[lang][key] ?? translations['en'][key] ?? key;
}

export default translations;
