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
  | 'stayoverDay1MinutesField' | 'stayoverDay2MinutesField'
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
  | 'priorityOrder' | 'vipCheckout' | 'earlyCheckout' | 'standardCheckout' | 'vipStayover' | 'standardStayover'
  // Housekeeper room view & ops-wall
  | 'doNotDisturb' | 'dnd' | 'needsCleaning' | 'startCleaning' | 'markDone'
  | 'markDnd' | 'removeDnd' | 'needHelp' | 'helpSentMsg' | 'helpAlertSent'
  // Guest requests
  | 'pending' | 'doneToday' | 'assign' | 'unassigned'
  // Ops-wall
  | 'liveOpsWall' | 'requests' | 'activeRequests' | 'active' | 'requestsCompleted' | 'noRoomsForToday'
  // Requests page
  | 'new' | 'all' | 'newGuestRequest' | 'requestType' | 'notesOptional' | 'selectStaff' | 'create' | 'noStaff'
  // Housekeeping page
  | 'housekeeping' | 'todaysProgress' | 'approved' | 'locked' | 'cleaning' | 'reset' | 'vacant'
  | 'noRoomsTodayHkp' | 'noRoomsFloor'
  // AI Staffing card (dashboard)
  | 'aiStaffingRec' | 'scheduled' | 'tapToEnter' | 'tapToEdit' | 'runMorningSetup'
  | 'totalWork' | 'staffedPerfect'
  | 'avoidableLaborCost' | 'roomsMayNotFinish' | 'scheduledMatchesRec'
  | 'estimatedFinishLabel' | 'savedPast30' | 'addRooms'
  // Smart Assign modal
  | 'assignPreview' | 'confirmAssign'
  // War Room dashboard
  | 'warRoom' | 'warRoomSub' | 'roomStatusBoard' | 'noRoomsWarRoom'
  | 'co' | 'so' | 'vac' | 'pmsSync' | 'neverSynced'
  // Performance tracking page
  | 'performance' | 'performanceSub' | 'teamPerformance'
  | 'onPace' | 'ahead' | 'behindPace'
  | 'roomsPerHr' | 'avgCleanTime'
  | 'leaderboard' | 'last7Days' | 'last14Days'
  | 'roomsDone' | 'avgPerDay' | 'noActivityToday'
  | 'noHistoryYet' | 'historyTab' | 'liveToday'
  | 'totalAssigned' | 'checkoutsShort' | 'stayoversShort'
  | 'loadingHistory' | 'topPerformer'
  // Offline / sync status
  | 'syncingChanges' | 'backOnline' | 'changesQueued'
  // CSV room import
  | 'roomImport' | 'csvImportTitle' | 'uploadCsv' | 'csvPreviewLabel'
  | 'importRoomsBtn' | 'csvHelpText' | 'csvRoomsFound' | 'csvImportDone'
  | 'csvImportFailed' | 'csvDropHint' | 'csvSkipped'
  // Scheduling page
  | 'scheduling' | 'schedulingTitle' | 'schedulingSubtitle'
  | 'selectShiftDate' | 'autoSelectCrew' | 'sendConfirmations'
  | 'confirmationsSent' | 'crewForDate' | 'noEligibleStaff'
  | 'statusPending' | 'statusConfirmed' | 'statusDeclined' | 'statusNoResponse'
  | 'weeklyHoursTracker' | 'notificationsTitle' | 'noNotifications' | 'markAllRead'
  | 'daysWorkedLabel' | 'onVacation' | 'inactiveLabel' | 'maxDaysPerWeekLabel'
  | 'vacationDatesLabel' | 'vacationDatesHelp' | 'isActiveLabel'
  | 'eligibleLabel' | 'atLimitLabel' | 'noPhoneLabel' | 'sendingLabel' | 'crewSelectedCount'
  | 'confirmDeclinedMsg' | 'replacementFoundMsg' | 'noReplacementMsg' | 'allConfirmedMsg'
  | 'recommendedCrew' | 'noPlanData'
  // ── Housekeeping public areas & prediction ────────────────────────────────
  | 'roomDataLoading' | 'noRoomDataYet' | 'pmsSync15Min'
  | 'prepMinutes' | 'totalWorkload'
  | 'frequency' | 'every' | 'days' | 'daily' | 'weekly' | 'custom'
  | 'add' | 'minutesPerClean' | 'locations' | 'removeArea'
  | 'noAreasFloor' | 'saveChanges' | 'saved' | 'saving'
  | 'addPublicArea' | 'areaNamePlaceholder' | 'addAreaBtn' | 'deleted'
  // ── Dashboard extras ──────────────────────────────────────────────────────
  | 'staffTomorrow' | 'contacted' | 'estLaborCost'
  | 'dirtyRooms' | 'needCleaning' | 'checkoutsToday'
  | 'roomStatus' | 'noRoomsAssignedToday' | 'progress' | 'total'
  | 'tomorrowsCrew' | 'noConfirmationsYet'
  // Dashboard: occupancy & revenue
  | 'occupancy' | 'rented' | 'arrivals' | 'inHouse' | 'reservations' | 'blockedRooms'
  | 'adr' | 'revpar' | 'perNight' | 'perAvailRoom'
  // Dashboard: labor cost split
  | 'frontDeskLabor' | 'housekeepingLabor' | 'maintenanceLabor'
  // ── Settings pages ────────────────────────────────────────────────────────
  | 'operationsConfig' | 'operationsConfigDesc'
  | 'propertySettings' | 'propertySettingsDesc'
  | 'staffManagement' | 'staffManagementDesc'
  | 'pmsConnectionDesc' | 'accountManagement' | 'accountManagementDesc'
  | 'minutes' | 'hours' | 'perShift' | 'optional'
  | 'createProperty' | 'deleteProperty' | 'dangerZone'
  // ── Staff directory ───────────────────────────────────────────────────────
  | 'staffDirectory' | 'department' | 'editStaff'
  // ── Sign-in & auth ────────────────────────────────────────────────────────
  | 'signInPrompt' | 'username' | 'password' | 'invalidCredentials'
  // ── Property selector ─────────────────────────────────────────────────────
  | 'selectProperty' | 'signedInAs' | 'noPropertiesFound' | 'noPropertiesDesc'
  // ── Housekeeper app ───────────────────────────────────────────────────────
  | 'loadingRooms' | 'allDone' | 'greatWorkToday'
  | 'noRoomsAssigned' | 'checkBackSoon'
  | 'describeIssue' | 'submit'
  | 'keepHolding' | 'holdToFinish'
  // ── Header ────────────────────────────────────────────────────────────────
  | 'allProperties'
  // ── Room availability ─────────────────────────────────────────────────────
  | 'availableRooms' | 'available' | 'roomOccupied'
  // ── Inventory tracking ────────────────────────────────────────────────────
  | 'inspections'
  | 'inventoryTracking' | 'parLevel' | 'currentStock' | 'belowPar' | 'atPar'
  | 'criticallyLow' | 'addItem' | 'itemAdded' | 'noInventoryItems'
  | 'allCategories' | 'housekeepingCategory' | 'maintenanceCategory' | 'breakfastFbCategory'
  | 'unitLabel' | 'stockUpdated' | 'allStocked'
  | 'overview' | 'reorderList' | 'usageSettings'
  | 'burningPerDay' | 'emptyInDays' | 'orderNow' | 'orderSoon'
  | 'suggestedOrder' | 'copyReorderList' | 'copiedToClipboard'
  | 'usagePerCheckout' | 'usagePerStayover' | 'reorderLeadDays'
  | 'vendor' | 'configureUsageRates' | 'needsOrderingNow'
  | 'allStockedUp' | 'covers2Weeks' | 'avgCheckoutsPerDay' | 'setUsageRates'
  | 'totalItems' | 'pastReorderWindow' | 'criticalOrderToday' | 'empty'
  | 'usageSettingsDesc'
  // ── Maintenance page ──────────────────────────────────────────────────────
  | 'preventive' | 'allFilter' | 'openFilter' | 'urgentFilter' | 'resolvedFilter'
  | 'submitWorkOrder' | 'severityLow' | 'severityMedium' | 'severityUrgent'
  | 'statusSubmitted' | 'statusAssigned' | 'statusInProgress' | 'statusResolved'
  | 'startWork' | 'assignedTo' | 'workOrderSubmitted' | 'openWorkOrders'
  | 'allRoutine' | 'preventiveMaintenance' | 'lastCompleted' | 'never'
  | 'dueToday' | 'addTask' | 'taskName' | 'frequencyDays'
  | 'noWorkOrders' | 'noPreventiveTasks' | 'justNow'
  // Landscaping
  | 'landscaping' | 'noLandscapingTasks' | 'addLandscapingTask' | 'landscapingTaskName'
  | 'season' | 'yearRound' | 'spring' | 'summer' | 'fall' | 'winter'
  | 'inspect' | 'inspection' | 'approve' | 'reject' | 'rejectReason'
  | 'roomApproved' | 'roomRejected' | 'allCaughtUp' | 'alreadyInspected'
  | 'roomsCleaned' | 'avgTime' | 'noRoomsCompleted' | 'avgTurnover'
  | 'noDataYet' | 'cleanedBy' | 'cleanTime' | 'sendBack';

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
    signIn: 'Sign In',
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
    offline: "You're offline - changes will sync when reconnected",
    // Sign-in
    signInHeroTitle: 'Run your hotel like a machine.',
    signInSubtitle: 'Daily operations, optimized.',
    signInFeature1: 'Know exactly how many housekeepers you need',
    signInFeature2: 'Zero manual entry - just input your numbers',
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
    stayoverDay1MinutesField: 'Minutes for Stayover Day 1 (light clean)',
    stayoverDay2MinutesField: 'Minutes for Stayover Day 2 (full clean)',
    shiftLengthField: 'Shift Length',
    weeklyBudgetField: 'Weekly Labor Budget (optional)',
    nextStepTitle: 'Next step:',
    nextStepDesc: "Open Morning Setup every day and hit Calculate. You'll see exactly how many housekeepers you need - and how much you're saving.",
    openApp: 'Open Staxis →',
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
    dailySavingsChart: 'Daily Savings - Last',
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
    notifDoneDesc: "When your manager assigns rooms, you'll get a notification on this phone - even if the app is closed.",
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
    // Housekeeper room view & ops-wall
    doNotDisturb: 'Do Not Disturb',
    dnd: 'DND',
    markDnd: 'Mark DND',
    removeDnd: 'Remove DND',
    needHelp: 'Need Help',
    helpSentMsg: 'Help request sent!',
    helpAlertSent: 'Help Alert Sent',
    needsCleaning: 'Needs Cleaning',
    startCleaning: 'Start Cleaning',
    markDone: 'Mark Done',
    // Guest requests
    pending: 'Pending',
    doneToday: 'Done Today',
    assign: 'Assign',
    unassigned: 'Unassigned',
    // Ops-wall
    liveOpsWall: 'Live Operations Wall',
    requests: 'Requests',
    activeRequests: 'Active Requests',
    active: 'Active',
    requestsCompleted: 'requests completed today',
    noRoomsForToday: 'No rooms for today.',
    // Requests page
    new: 'New',
    all: 'All',
    newGuestRequest: 'New Guest Request',
    requestType: 'Request Type',
    notesOptional: 'Notes (optional)',
    selectStaff: '-- Select staff --',
    create: 'Create',
    noStaff: 'No staff',
    // Housekeeping page
    housekeeping: 'Housekeeping',
    todaysProgress: "Today's Progress",
    approved: 'Approved',
    locked: 'Locked',
    cleaning: 'Cleaning',
    reset: 'Reset',
    vacant: 'Vacant',
    noRoomsTodayHkp: 'No rooms for today. Ask the manager to add rooms first.',
    noRoomsFloor: 'No rooms on this floor.',
    // AI Staffing card
    aiStaffingRec: 'AI Staffing Recommendation',
    scheduled: 'Scheduled',
    tapToEnter: 'tap to enter',
    tapToEdit: 'tap to edit',
    runMorningSetup: 'Run morning setup for a more accurate estimate',
    totalWork: 'Total work',
    staffedPerfect: 'Perfectly staffed today',
    avoidableLaborCost: 'in avoidable labor costs',
    roomsMayNotFinish: 'Rooms may not finish on time - consider adding staff',
    scheduledMatchesRec: 'Scheduled staff matches the AI recommendation',
    estimatedFinishLabel: 'Estimated finish',
    savedPast30: 'Saved in past 30 days',
    addRooms: 'Add Rooms',
    // Smart Assign modal
    assignPreview: 'Assignment Preview',
    confirmAssign: 'Confirm & Assign',
    // War Room dashboard
    warRoom: 'War Room',
    warRoomSub: 'Front Desk Display',
    roomStatusBoard: 'Room Status Board',
    noRoomsWarRoom: 'No rooms found for today. Add rooms or wait for the scraper to sync.',
    co: 'CO',
    so: 'SO',
    vac: 'VAC',
    pmsSync: 'PMS Sync',
    neverSynced: 'Never synced',
    // Performance tracking
    performance: 'Performance',
    performanceSub: 'Track team output',
    teamPerformance: 'Team Performance',
    onPace: 'On Pace',
    ahead: 'Ahead',
    behindPace: 'Behind',
    roomsPerHr: 'Rooms/hr',
    avgCleanTime: 'Avg Clean Time',
    leaderboard: 'Leaderboard',
    last7Days: 'Last 7 Days',
    last14Days: 'Last 14 Days',
    roomsDone: 'Rooms Done',
    avgPerDay: 'Avg/Day',
    noActivityToday: 'No activity yet today',
    noHistoryYet: 'No history yet',
    historyTab: 'History',
    liveToday: 'Live Today',
    totalAssigned: 'Assigned',
    checkoutsShort: 'CO',
    stayoversShort: 'SO',
    loadingHistory: 'Loading history...',
    topPerformer: 'Top Performer',
    // Offline / sync status
    syncingChanges: 'Syncing changes…',
    backOnline: 'Back online',
    changesQueued: 'changes queued',
    // CSV import
    roomImport: 'Room Import',
    csvImportTitle: 'Occupancy Import',
    uploadCsv: 'Upload CSV File',
    csvPreviewLabel: 'Preview',
    importRoomsBtn: 'Import Rooms',
    csvHelpText: 'Accepts Choice Advantage, Opera, and similar PMS CSV exports',
    csvRoomsFound: 'rooms found',
    csvImportDone: 'rooms imported',
    csvImportFailed: 'Import failed - check the file format and try again',
    csvDropHint: 'Drop a CSV here or click to browse',
    csvSkipped: 'skipped (already exist today)',
    // Scheduling
    scheduling: 'Schedule',
    schedulingTitle: 'Scheduling',
    schedulingSubtitle: 'Send shift confirmations',
    selectShiftDate: 'Shift Date',
    autoSelectCrew: 'Auto-Select Crew',
    sendConfirmations: 'Send Confirmations',
    confirmationsSent: 'Confirmations sent',
    crewForDate: 'Crew for',
    noEligibleStaff: 'No eligible staff - check hours & vacation dates',
    statusPending: 'Pending',
    statusConfirmed: 'Confirmed',
    statusDeclined: 'Declined',
    statusNoResponse: 'No Response',
    weeklyHoursTracker: 'Weekly Hours',
    notificationsTitle: 'Notifications',
    noNotifications: 'No notifications',
    markAllRead: 'Mark all read',
    daysWorkedLabel: 'days this week',
    onVacation: 'On vacation',
    inactiveLabel: 'Inactive',
    maxDaysPerWeekLabel: 'Max Days/Week',
    vacationDatesLabel: 'Vacation Dates',
    vacationDatesHelp: 'One date per line (YYYY-MM-DD)',
    isActiveLabel: 'Active',
    eligibleLabel: 'Eligible',
    atLimitLabel: 'At limit',
    noPhoneLabel: 'No phone - add in Staff page',
    sendingLabel: 'Sending…',
    crewSelectedCount: 'selected',
    confirmDeclinedMsg: 'declined - finding replacement',
    replacementFoundMsg: 'Replacement found',
    noReplacementMsg: 'No replacement available',
    allConfirmedMsg: 'All confirmed',
    recommendedCrew: 'Recommended Crew',
    noPlanData: 'No plan data for this date yet. Data updates at 7pm and 6am.',
    // ── Housekeeping public areas & prediction ──
    roomDataLoading: 'Loading room data...',
    noRoomDataYet: 'No room data for this date yet',
    pmsSync15Min: 'Room data syncs from the PMS every 15 minutes',
    prepMinutes: 'Prep Time',
    totalWorkload: 'Total Workload',
    frequency: 'Frequency',
    every: 'Every',
    days: 'days',
    daily: 'Daily',
    weekly: 'Weekly',
    custom: 'Custom',
    add: 'Add',
    minutesPerClean: 'Minutes per clean',
    locations: 'Locations',
    removeArea: 'Remove Area',
    noAreasFloor: 'No areas on this floor. Tap Add to create one.',
    saveChanges: 'Save Changes',
    saved: 'Saved!',
    saving: 'Saving...',
    addPublicArea: 'Add Public Area',
    areaNamePlaceholder: 'e.g. 3rd Floor Hallway',
    addAreaBtn: 'Add Area',
    deleted: 'deleted',
    // ── Dashboard extras ──
    staffTomorrow: 'Staff Tomorrow',
    contacted: 'contacted',
    estLaborCost: 'Est. Labor Cost',
    dirtyRooms: 'Dirty Rooms',
    needCleaning: 'need cleaning',
    checkoutsToday: 'Checkouts Today',
    roomStatus: 'Room Status',
    noRoomsAssignedToday: 'No rooms assigned today.',
    progress: 'Progress',
    total: 'total',
    tomorrowsCrew: "Tomorrow's Crew",
    noConfirmationsYet: 'No confirmations yet - go to Housekeeping › Schedule to send.',
    // Dashboard: occupancy & revenue
    occupancy: 'Occupancy',
    rented: 'Rented',
    arrivals: 'Arrivals',
    inHouse: 'In-House',
    reservations: 'Reservations',
    blockedRooms: 'Blocked Rooms',
    adr: 'ADR',
    revpar: 'RevPAR',
    perNight: 'per night',
    perAvailRoom: 'per avail. room',
    // Dashboard: labor cost split
    frontDeskLabor: 'Front Desk',
    housekeepingLabor: 'Housekeeping',
    maintenanceLabor: 'Maintenance',
    // ── Settings pages ──
    operationsConfig: 'Operations Config',
    operationsConfigDesc: 'Public areas, cleaning times, prep time',
    propertySettings: 'Property Settings',
    propertySettingsDesc: 'Hotel info, rooms, shift length',
    staffManagement: 'Staff Management',
    staffManagementDesc: 'Add and manage housekeepers',
    pmsConnectionDesc: 'Sync room data from your PMS',
    accountManagement: 'Account Management',
    accountManagementDesc: 'Users, roles, access',
    minutes: 'min',
    hours: 'hrs',
    perShift: 'per shift',
    optional: 'optional',
    createProperty: 'Create Property',
    deleteProperty: 'Delete Property',
    dangerZone: 'Danger Zone',
    // ── Staff directory ──
    staffDirectory: 'Staff Directory',
    department: 'Department',
    editStaff: 'Edit Staff',
    // ── Sign-in & auth ──
    signInPrompt: 'Sign in to your account',
    username: 'Username',
    password: 'Password',
    invalidCredentials: 'Invalid username or password.',
    // ── Property selector ──
    selectProperty: 'Select a Property',
    signedInAs: 'Signed in as',
    noPropertiesFound: 'No properties found',
    noPropertiesDesc: "Your account doesn't have access to any properties yet. Contact your administrator to get access.",
    // ── Housekeeper app ──
    loadingRooms: 'Loading your rooms…',
    allDone: "You're all done!",
    greatWorkToday: 'Great work today!',
    noRoomsAssigned: 'No rooms assigned yet.',
    checkBackSoon: 'Check back soon!',
    describeIssue: 'Describe the issue...',
    submit: 'Submit',
    keepHolding: 'Keep holding…',
    holdToFinish: 'Hold to Finish',
    // ── Header ──
    allProperties: 'All properties…',
    // ── Room availability ──
    availableRooms: 'Available Rooms',
    available: 'Available',
    roomOccupied: 'Occupied',
    // ── Inventory tracking ──
    inventoryTracking: 'Inventory',
    inspections: 'Inspections',
    parLevel: 'Par Level',
    currentStock: 'Current Stock',
    belowPar: 'Below Par',
    atPar: 'At Par',
    criticallyLow: 'Critically Low',
    addItem: 'Add Item',
    itemAdded: 'Item added',
    noInventoryItems: 'No inventory items yet',
    allCategories: 'All',
    housekeepingCategory: 'Housekeeping',
    maintenanceCategory: 'Maintenance',
    breakfastFbCategory: 'Breakfast/F&B',
    unitLabel: 'Unit',
    stockUpdated: 'Stock updated',
    allStocked: 'All stocked',
    overview: 'Overview',
    reorderList: 'Reorder List',
    usageSettings: 'Usage Settings',
    burningPerDay: 'Using ~{0}/day',
    emptyInDays: 'Empty in {0} days',
    orderNow: 'ORDER NOW',
    orderSoon: 'Order soon',
    suggestedOrder: 'Suggested order',
    copyReorderList: 'Copy Reorder List',
    copiedToClipboard: 'Copied to clipboard',
    usagePerCheckout: 'Per checkout room',
    usagePerStayover: 'Per stayover room',
    reorderLeadDays: 'Reorder lead days',
    vendor: 'Vendor',
    configureUsageRates: 'Set usage rates for predictions',
    needsOrderingNow: 'items need ordering NOW',
    allStockedUp: 'All stocked up — nothing needs ordering',
    covers2Weeks: 'covers 2 weeks',
    avgCheckoutsPerDay: 'Avg Checkouts/day',
    setUsageRates: 'Set usage rates →',
    totalItems: 'Total Items',
    pastReorderWindow: 'already past reorder window',
    criticalOrderToday: 'CRITICAL — order today',
    empty: 'Empty',
    usageSettingsDesc: 'Set how many of each item are used per checkout and stayover room. The system uses these rates combined with your daily room counts to predict when you\'ll run out.',
    // ── Maintenance page ──
    preventive: 'Preventive',
    allFilter: 'All',
    openFilter: 'Open',
    urgentFilter: 'Urgent',
    resolvedFilter: 'Resolved',
    submitWorkOrder: 'Submit Work Order',
    severityLow: 'Low',
    severityMedium: 'Medium',
    severityUrgent: 'Urgent',
    statusSubmitted: 'New',
    statusAssigned: 'Assigned',
    statusInProgress: 'In Progress',
    statusResolved: 'Resolved',
    startWork: 'Start Work',
    assignedTo: 'Assigned to',
    workOrderSubmitted: 'Work order submitted',
    openWorkOrders: 'Open Work Orders',
    allRoutine: 'all routine',
    preventiveMaintenance: 'Preventive Maintenance',
    lastCompleted: 'Last completed',
    never: 'Never',
    dueToday: 'Due today',
    addTask: 'Add Task',
    taskName: 'Task name',
    frequencyDays: 'Frequency (days)',
    noWorkOrders: 'No work orders yet',
    noPreventiveTasks: 'No preventive tasks yet',
    // Landscaping
    landscaping: 'Landscaping',
    noLandscapingTasks: 'No landscaping tasks yet',
    addLandscapingTask: 'Add Task',
    landscapingTaskName: 'Task Name',
    season: 'Season',
    yearRound: 'Year-Round',
    spring: 'Spring',
    summer: 'Summer',
    fall: 'Fall',
    winter: 'Winter',
    justNow: 'just now',
    inspect: 'Inspect',
    inspection: 'Inspection',
    approve: 'Approve',
    reject: 'Reject',
    rejectReason: 'Reason for rejection',
    roomApproved: 'Room approved',
    roomRejected: 'Sent back for re-clean',
    allCaughtUp: 'All caught up — no rooms waiting for inspection',
    alreadyInspected: 'Already Inspected',
    roomsCleaned: 'rooms',
    avgTime: 'avg',
    noRoomsCompleted: 'No rooms completed yet today',
    avgTurnover: 'Avg Turnover',
    noDataYet: 'no data yet',
    cleanedBy: 'Cleaned by',
    cleanTime: 'Clean time',
    sendBack: 'Send Back',
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
    signIn: 'Iniciar Sesión',
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
    offline: 'Sin conexión - los cambios se sincronizarán al reconectarte',
    // Sign-in
    signInHeroTitle: 'Administra tu hotel como una máquina.',
    signInSubtitle: 'Operaciones diarias, optimizadas.',
    signInFeature1: 'Sabe exactamente cuántas camareras necesitas',
    signInFeature2: 'Sin entrada manual - solo ingresa tus números',
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
    stayoverDay1MinutesField: 'Minutos Continuación Día 1 (limpieza ligera)',
    stayoverDay2MinutesField: 'Minutos Continuación Día 2 (limpieza completa)',
    shiftLengthField: 'Duración del Turno',
    weeklyBudgetField: 'Presupuesto Semanal (opcional)',
    nextStepTitle: 'Próximo paso:',
    nextStepDesc: 'Abre Conf. Matutina cada día y toca Calcular. Verás exactamente cuántas camareras necesitas - y cuánto estás ahorrando.',
    openApp: 'Abrir Staxis →',
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
    dailySavingsChart: 'Ahorros Diarios - Últimos',
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
    notifDoneDesc: 'Cuando tu gerente asigne habitaciones, recibirás una notificación en este teléfono - aunque la app esté cerrada.',
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
    // Housekeeper room view & ops-wall
    doNotDisturb: 'No Molestar',
    dnd: 'NM',
    markDnd: 'Marcar NM',
    removeDnd: 'Quitar NM',
    needHelp: 'Necesito Ayuda',
    helpSentMsg: '¡Solicitud de ayuda enviada!',
    helpAlertSent: 'Alerta Enviada',
    needsCleaning: 'Necesita Limpieza',
    startCleaning: 'Iniciar Limpieza',
    markDone: 'Marcar Listo',
    // Guest requests
    pending: 'Pendiente',
    doneToday: 'Listo Hoy',
    assign: 'Asignar',
    unassigned: 'Sin Asignar',
    // Ops-wall
    liveOpsWall: 'Muro de Operaciones',
    requests: 'Solicitudes',
    activeRequests: 'Solicitudes Activas',
    active: 'Activo',
    requestsCompleted: 'solicitudes completadas hoy',
    noRoomsForToday: 'No hay habitaciones hoy.',
    // Requests page
    new: 'Nueva',
    all: 'Todas',
    newGuestRequest: 'Nueva Solicitud de Huésped',
    requestType: 'Tipo de Solicitud',
    notesOptional: 'Notas (opcional)',
    selectStaff: '-- Seleccionar personal --',
    create: 'Crear',
    noStaff: 'Sin personal',
    // Housekeeping page
    housekeeping: 'Limpieza',
    todaysProgress: 'Progreso de Hoy',
    approved: 'Aprobada',
    locked: 'Bloqueada',
    cleaning: 'Limpiando',
    reset: 'Reiniciar',
    vacant: 'Vacía',
    noRoomsTodayHkp: 'Sin habitaciones para hoy. Pide al gerente que agregue habitaciones.',
    noRoomsFloor: 'Sin habitaciones en este piso.',
    // AI Staffing card
    aiStaffingRec: 'Recomendación IA de Personal',
    scheduled: 'Programado',
    tapToEnter: 'toca para ingresar',
    tapToEdit: 'toca para editar',
    runMorningSetup: 'Configura el turno matutino para mayor precisión',
    totalWork: 'Trabajo total',
    staffedPerfect: 'Personal perfecto hoy',
    avoidableLaborCost: 'en costos de labor evitables',
    roomsMayNotFinish: 'Las habitaciones pueden no terminar a tiempo - considera agregar personal',
    scheduledMatchesRec: 'El personal programado coincide con la recomendación IA',
    estimatedFinishLabel: 'Fin estimado',
    savedPast30: 'Ahorrado en los últimos 30 días',
    addRooms: 'Agregar Hab.',
    // Smart Assign modal
    assignPreview: 'Vista Previa de Asignación',
    confirmAssign: 'Confirmar y Asignar',
    // War Room dashboard
    warRoom: 'Centro de Mando',
    warRoomSub: 'Pantalla de Recepción',
    roomStatusBoard: 'Estado de Habitaciones',
    noRoomsWarRoom: 'No hay habitaciones hoy. Agrega habitaciones o espera la sincronización.',
    co: 'CO',
    so: 'SO',
    vac: 'VAC',
    pmsSync: 'Sincronización PMS',
    neverSynced: 'Sin sincronizar',
    // Performance tracking
    performance: 'Desempeño',
    performanceSub: 'Rastrear desempeño del equipo',
    teamPerformance: 'Desempeño del Equipo',
    onPace: 'Al Día',
    ahead: 'Adelantado',
    behindPace: 'Atrasado',
    roomsPerHr: 'Hab./hr',
    avgCleanTime: 'Tiempo Prom.',
    leaderboard: 'Clasificación',
    last7Days: 'Últimos 7 días',
    last14Days: 'Últimos 14 días',
    roomsDone: 'Hab. Listas',
    avgPerDay: 'Prom./Día',
    noActivityToday: 'Sin actividad hoy',
    noHistoryYet: 'Sin historial aún',
    historyTab: 'Historial',
    liveToday: 'En Vivo Hoy',
    totalAssigned: 'Asignadas',
    checkoutsShort: 'SAL',
    stayoversShort: 'CON',
    loadingHistory: 'Cargando historial...',
    topPerformer: 'Mejor Desempeño',
    // Offline / sync status
    syncingChanges: 'Sincronizando cambios…',
    backOnline: 'Conexión restaurada',
    changesQueued: 'cambios en cola',
    // CSV import
    roomImport: 'Importar Hab.',
    csvImportTitle: 'Importar Ocupación',
    uploadCsv: 'Subir archivo CSV',
    csvPreviewLabel: 'Vista previa',
    importRoomsBtn: 'Importar habitaciones',
    csvHelpText: 'Acepta exportaciones CSV de Choice Advantage, Opera y sistemas similares',
    csvRoomsFound: 'habitaciones encontradas',
    csvImportDone: 'habitaciones importadas',
    csvImportFailed: 'Error al importar - verifica el formato del archivo',
    csvDropHint: 'Arrastra un CSV aquí o haz clic para buscar',
    csvSkipped: 'omitidas (ya existen hoy)',
    // Scheduling
    scheduling: 'Horario',
    schedulingTitle: 'Horarios',
    schedulingSubtitle: 'Enviar confirmaciones de turno',
    selectShiftDate: 'Fecha del Turno',
    autoSelectCrew: 'Seleccionar Equipo',
    sendConfirmations: 'Enviar Confirmaciones',
    confirmationsSent: 'Confirmaciones enviadas',
    crewForDate: 'Equipo para',
    noEligibleStaff: 'Sin personal disponible - revisa horas y vacaciones',
    statusPending: 'Pendiente',
    statusConfirmed: 'Confirmado',
    statusDeclined: 'Rechazado',
    statusNoResponse: 'Sin Respuesta',
    weeklyHoursTracker: 'Horas Semanales',
    notificationsTitle: 'Notificaciones',
    noNotifications: 'Sin notificaciones',
    markAllRead: 'Marcar todo como leído',
    daysWorkedLabel: 'días esta semana',
    onVacation: 'De vacaciones',
    inactiveLabel: 'Inactiva',
    maxDaysPerWeekLabel: 'Días Máx./Semana',
    vacationDatesLabel: 'Fechas de Vacaciones',
    vacationDatesHelp: 'Una fecha por línea (AAAA-MM-DD)',
    isActiveLabel: 'Activa',
    eligibleLabel: 'Disponible',
    atLimitLabel: 'Al límite',
    noPhoneLabel: 'Sin teléfono - agregar en Personal',
    sendingLabel: 'Enviando…',
    crewSelectedCount: 'seleccionadas',
    confirmDeclinedMsg: 'rechazó - buscando reemplazo',
    replacementFoundMsg: 'Reemplazo encontrado',
    noReplacementMsg: 'Sin reemplazo disponible',
    allConfirmedMsg: 'Todas confirmadas',
    recommendedCrew: 'Equipo Recomendado',
    noPlanData: 'Sin datos de planificación para esta fecha. Los datos se actualizan a las 7pm y 6am.',
    // ── Housekeeping public areas & prediction ──
    roomDataLoading: 'Cargando datos de habitaciones...',
    noRoomDataYet: 'No hay datos de habitaciones para esta fecha',
    pmsSync15Min: 'Los datos se sincronizan desde el PMS cada 15 minutos',
    prepMinutes: 'Preparación',
    totalWorkload: 'Carga Total',
    frequency: 'Frecuencia',
    every: 'Cada',
    days: 'días',
    daily: 'Diario',
    weekly: 'Semanal',
    custom: 'Personalizado',
    add: 'Agregar',
    minutesPerClean: 'Minutos por limpieza',
    locations: 'Ubicaciones',
    removeArea: 'Eliminar Área',
    noAreasFloor: 'No hay áreas en este piso. Toca Agregar para crear una.',
    saveChanges: 'Guardar Cambios',
    saved: '¡Guardado!',
    saving: 'Guardando...',
    addPublicArea: 'Agregar Área Pública',
    areaNamePlaceholder: 'p. ej., Pasillo del 3er Piso',
    addAreaBtn: 'Agregar Área',
    deleted: 'eliminado',
    // ── Dashboard extras ──
    staffTomorrow: 'Personal Mañana',
    contacted: 'contactados',
    estLaborCost: 'Costo Estimado',
    dirtyRooms: 'Hab. Sucias',
    needCleaning: 'pendientes',
    checkoutsToday: 'Salidas Hoy',
    roomStatus: 'Estado de Habitaciones',
    noRoomsAssignedToday: 'No hay habitaciones asignadas hoy.',
    progress: 'Progreso',
    total: 'total',
    tomorrowsCrew: 'Equipo de Mañana',
    noConfirmationsYet: 'No hay confirmaciones aún — ve a Limpieza › Horario para enviar.',
    // Dashboard: occupancy & revenue
    occupancy: 'Ocupación',
    rented: 'Rentadas',
    arrivals: 'Llegadas',
    inHouse: 'En Casa',
    reservations: 'Reservaciones',
    blockedRooms: 'Hab. Bloqueadas',
    adr: 'ADR',
    revpar: 'RevPAR',
    perNight: 'por noche',
    perAvailRoom: 'por hab. disponible',
    // Dashboard: labor cost split
    frontDeskLabor: 'Recepción',
    housekeepingLabor: 'Limpieza',
    maintenanceLabor: 'Mantenimiento',
    // ── Settings pages ──
    operationsConfig: 'Config. de Operaciones',
    operationsConfigDesc: 'Áreas públicas, tiempos de limpieza, preparación',
    propertySettings: 'Config. de Propiedad',
    propertySettingsDesc: 'Info del hotel, habitaciones, turno',
    staffManagement: 'Gestión de Personal',
    staffManagementDesc: 'Agregar y administrar camareras',
    pmsConnectionDesc: 'Sincronizar datos desde tu PMS',
    accountManagement: 'Gestión de Cuentas',
    accountManagementDesc: 'Usuarios, roles, acceso',
    minutes: 'min',
    hours: 'hrs',
    perShift: 'por turno',
    optional: 'opcional',
    createProperty: 'Crear Propiedad',
    deleteProperty: 'Eliminar Propiedad',
    dangerZone: 'Zona de Peligro',
    // ── Staff directory ──
    staffDirectory: 'Directorio de Personal',
    department: 'Departamento',
    editStaff: 'Editar Personal',
    // ── Sign-in & auth ──
    signInPrompt: 'Inicia sesión en tu cuenta',
    username: 'Nombre de usuario',
    password: 'Contraseña',
    invalidCredentials: 'Nombre de usuario o contraseña inválidos.',
    // ── Property selector ──
    selectProperty: 'Selecciona una Propiedad',
    signedInAs: 'Sesión iniciada como',
    noPropertiesFound: 'Sin propiedades encontradas',
    noPropertiesDesc: 'Tu cuenta aún no tiene acceso a ninguna propiedad. Contacta a tu administrador.',
    // ── Housekeeper app ──
    loadingRooms: 'Cargando tus habitaciones…',
    allDone: '¡Todo listo!',
    greatWorkToday: '¡Buen trabajo hoy!',
    noRoomsAssigned: 'Sin habitaciones asignadas.',
    checkBackSoon: '¡Revisa pronto!',
    describeIssue: 'Describe el problema...',
    submit: 'Enviar',
    keepHolding: 'Sigue presionando…',
    holdToFinish: 'Mantén para terminar',
    // ── Header ──
    allProperties: 'Todas las propiedades…',
    // ── Room availability ──
    availableRooms: 'Hab. Disponibles',
    available: 'Disponible',
    roomOccupied: 'Ocupada',
    // ── Inventory tracking ──
    inventoryTracking: 'Inventario',
    inspections: 'Inspecciones',
    parLevel: 'Nivel Mínimo',
    currentStock: 'Stock Actual',
    belowPar: 'Bajo Mínimo',
    atPar: 'En Nivel',
    criticallyLow: 'Críticamente Bajo',
    addItem: 'Agregar Artículo',
    itemAdded: 'Artículo agregado',
    noInventoryItems: 'Sin artículos de inventario',
    allCategories: 'Todos',
    housekeepingCategory: 'Limpieza',
    maintenanceCategory: 'Mantenimiento',
    breakfastFbCategory: 'Desayuno/Alimentos',
    unitLabel: 'Unidad',
    stockUpdated: 'Stock actualizado',
    allStocked: 'Todo abastecido',
    overview: 'Resumen',
    reorderList: 'Lista de Pedidos',
    usageSettings: 'Configuración de Uso',
    burningPerDay: 'Consumo ~{0}/día',
    emptyInDays: 'Vacío en {0} días',
    orderNow: 'PEDIR AHORA',
    orderSoon: 'Pedir pronto',
    suggestedOrder: 'Pedido sugerido',
    copyReorderList: 'Copiar Lista',
    copiedToClipboard: 'Copiado al portapapeles',
    usagePerCheckout: 'Por habitación checkout',
    usagePerStayover: 'Por habitación stayover',
    reorderLeadDays: 'Días de anticipación',
    vendor: 'Proveedor',
    configureUsageRates: 'Configure tasas de uso',
    needsOrderingNow: 'artículos necesitan pedido YA',
    allStockedUp: 'Todo abastecido',
    covers2Weeks: 'cubre 2 semanas',
    avgCheckoutsPerDay: 'Promedio Checkouts/día',
    setUsageRates: 'Configurar tasas →',
    totalItems: 'Artículos',
    pastReorderWindow: 'ya pasó la ventana de pedido',
    criticalOrderToday: 'CRÍTICO — pedir hoy',
    empty: 'Vacío',
    usageSettingsDesc: 'Configure cuánto de cada artículo se usa por tipo de habitación. El sistema usa estas tasas junto con los conteos diarios para predecir cuándo se agotarán.',
    // ── Maintenance page ──
    preventive: 'Preventivo',
    allFilter: 'Todos',
    openFilter: 'Abiertos',
    urgentFilter: 'Urgentes',
    resolvedFilter: 'Resueltos',
    submitWorkOrder: 'Enviar Orden',
    severityLow: 'Baja',
    severityMedium: 'Media',
    severityUrgent: 'Urgente',
    statusSubmitted: 'Nueva',
    statusAssigned: 'Asignada',
    statusInProgress: 'En Progreso',
    statusResolved: 'Resuelta',
    startWork: 'Iniciar',
    assignedTo: 'Asignada a',
    workOrderSubmitted: 'Orden de trabajo enviada',
    openWorkOrders: 'Órdenes Abiertas',
    allRoutine: 'todo rutina',
    preventiveMaintenance: 'Mantenimiento Preventivo',
    lastCompleted: 'Último completado',
    never: 'Nunca',
    dueToday: 'Vence hoy',
    addTask: 'Agregar Tarea',
    taskName: 'Nombre de la tarea',
    frequencyDays: 'Frecuencia (días)',
    noWorkOrders: 'Sin órdenes de trabajo',
    noPreventiveTasks: 'Sin tareas preventivas',
    // Landscaping
    landscaping: 'Jardinería',
    noLandscapingTasks: 'Sin tareas de jardinería',
    addLandscapingTask: 'Agregar Tarea',
    landscapingTaskName: 'Nombre de la tarea',
    season: 'Temporada',
    yearRound: 'Todo el año',
    spring: 'Primavera',
    summer: 'Verano',
    fall: 'Otoño',
    winter: 'Invierno',
    justNow: 'ahora mismo',
    inspect: 'Inspeccionar',
    inspection: 'Inspección',
    approve: 'Aprobar',
    reject: 'Rechazar',
    rejectReason: 'Razón del rechazo',
    roomApproved: 'Habitación aprobada',
    roomRejected: 'Enviada para re-limpieza',
    allCaughtUp: 'Todo al día — no hay habitaciones pendientes',
    alreadyInspected: 'Ya Inspeccionadas',
    roomsCleaned: 'habitaciones',
    avgTime: 'prom',
    noRoomsCompleted: 'Sin habitaciones completadas hoy',
    avgTurnover: 'Tiempo Promedio',
    noDataYet: 'sin datos aún',
    cleanedBy: 'Limpiada por',
    cleanTime: 'Tiempo de limpieza',
    sendBack: 'Devolver',
  },
};

export function t(key: TranslationKey, lang: Language = 'en'): string {
  return translations[lang][key] ?? translations['en'][key] ?? key;
}

export default translations;
