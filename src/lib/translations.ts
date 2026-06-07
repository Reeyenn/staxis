// Bilingual base type — every manager / admin / dashboard string ships in
// EN + ES. Stays narrow at `'en' | 'es'` so the rest of the codebase keeps
// type-checking against its inline `{en, es}` lookup objects unchanged.
export type Language = 'en' | 'es';

// Housekeeper-facing locales (piece C of the housekeeper mobile rebuild,
// 2026-05-25). HT/TL/VI ship with the housekeeper-facing subset of
// strings translated and fall back to EN via t() for everything else
// (admin / dashboard / config strings managers never see).
//
// Why two types: widening `Language` to five values would force every
// existing `{ en: '...', es: '...' }[lang]` literal across the manager
// dashboard / front-desk / settings pages to add three new branches.
// Most of those screens are never used by housekeepers and don't need
// the extra languages — keeping `Language` narrow lets the type system
// surface accidental "we just rendered Vietnamese in the admin console"
// bugs rather than silently undefined-indexing those literals.
export type HousekeeperLocale = 'en' | 'es' | 'ht' | 'tl' | 'vi';

// Per-locale metadata: display name (English), native name in the
// language's own script, and whether the translations should be treated as
// machine-seeded (UI warns the user "translations may not be exact"
// until human review). EN + ES are fully reviewed; the three new locales
// are best-effort hand translations of the housekeeper subset and need
// review by a fluent speaker.
export interface LocaleMeta {
  code: HousekeeperLocale;
  englishName: string;
  nativeName: string;
  machineTranslated: boolean;
  /** Searchable aliases — the language picker lets the user type any of
   *  these and find their language. Includes endonyms, exonyms, and the
   *  ISO-639-1 code itself so typing "ht" or "creole" both work. */
  searchAliases: string[];
}

export const LOCALE_META: Record<HousekeeperLocale, LocaleMeta> = {
  en: {
    code: 'en',
    englishName: 'English',
    nativeName: 'English',
    machineTranslated: false,
    searchAliases: ['english', 'en'],
  },
  es: {
    code: 'es',
    englishName: 'Spanish',
    nativeName: 'Español',
    machineTranslated: false,
    searchAliases: ['spanish', 'español', 'espanol', 'es', 'castellano'],
  },
  ht: {
    code: 'ht',
    englishName: 'Haitian Creole',
    nativeName: 'Kreyòl Ayisyen',
    machineTranslated: true,
    searchAliases: ['haitian', 'creole', 'kreyol', 'kreyòl', 'ayisyen', 'ht'],
  },
  tl: {
    code: 'tl',
    englishName: 'Tagalog',
    nativeName: 'Tagalog',
    machineTranslated: true,
    searchAliases: ['tagalog', 'filipino', 'pilipino', 'tl', 'fil'],
  },
  vi: {
    code: 'vi',
    englishName: 'Vietnamese',
    nativeName: 'Tiếng Việt',
    machineTranslated: true,
    searchAliases: ['vietnamese', 'tiếng việt', 'tieng viet', 'vi', 'việt'],
  },
};

export const SUPPORTED_LOCALES: readonly HousekeeperLocale[] = ['en', 'es', 'ht', 'tl', 'vi'] as const;

/**
 * Narrow any value coming off `staff.language` (which the DB allows to be
 * any of the five locales) down to the legacy bilingual Language type
 * that the manager-side codebase expects. HT/TL/VI degrade to EN —
 * which is what those manager screens render anyway since they only ship
 * EN + ES strings.
 */
export function toBilingual(locale: string | null | undefined): Language {
  return locale === 'es' ? 'es' : 'en';
}

type TranslationKey =
  // Housekeeper app redesign (Claude Design handoff, June 2026)
  | 'hkCleaningLabel' | 'hkStartCleaning' | 'hkStopLabel' | 'hkStartAgain' | 'hkChecklistDone'
  | 'hkAllRoomsClean' | 'hkAllRoomsCleanSub' | 'hkAllRoomsCleanCount'
  | 'hkYourRooms' | 'hkTapToOpen' | 'hkAlerts'
  | 'hkTabRooms' | 'hkTabMessages' | 'hkNewMessage' | 'hkBack' | 'hkSend'
  | 'hkMessagePlaceholder' | 'hkSearchPeople' | 'hkPeople' | 'hkOnlyManagersPost'
  | 'hkFromManagement' | 'hkMembers' | 'hkDirectMessage' | 'hkJustNow' | 'hkAnnouncementsFromMgmt'
  | 'hkNoMessages'
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
  | 'checklistsTitle' | 'checklistsCardDesc'
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
  // Customer-facing SMS-link pages (housekeeper/[id] + laundry/[id])
  | 'cxIncompleteLink' | 'cxIncompleteLinkHelp' | 'cxHelloPrefix' | 'cxGreatWorkToday'
  | 'hkStartShift' | 'hkShiftStarted' | 'hkRoomShort'
  | 'hkNextShiftPrefix' | 'hkLastShiftPrefix'
  | 'hkTypeCheckout' | 'hkTypeStayover' | 'hkTypeVacant'
  | 'hkReportIssueAria' | 'hkIssueShort' | 'hkResetShort' | 'hkUndoShort' | 'hkCompleteShort'
  | 'hkOffline'
  | 'hkErrCouldntMarkClean' | 'hkErrCouldntToggleDnd' | 'hkErrCouldntSaveIssue' | 'hkErrCouldntResetRoom'
  // Housekeeper mobile rebuild piece A (2026-05-24): Start/Pause/Resume/Done
  // workflow, checklists, exception buttons, lunch break, daily summary.
  | 'hkActionStart' | 'hkActionPause' | 'hkActionResume' | 'hkActionDone'
  | 'hkPaused' | 'hkOpenChecklist' | 'hkChecklistTitle' | 'hkChecklistChecked'
  | 'hkAreaBathroom' | 'hkAreaBedroom' | 'hkAreaLiving' | 'hkAreaKitchen'
  | 'hkAreaEntry' | 'hkAreaAmenities' | 'hkAreaFinal'
  | 'hkException' | 'hkExceptionDnd' | 'hkExceptionNsr' | 'hkExceptionDla'
  | 'hkExceptionSleepOut' | 'hkExceptionSkipped' | 'hkExceptionLabel'
  | 'hkExceptionAddNoteOptional' | 'hkExceptionConfirm' | 'hkExceptionClear'
  | 'hkExceptionDndDescription' | 'hkExceptionNsrDescription'
  | 'hkExceptionDlaDescription' | 'hkExceptionSleepOutDescription'
  | 'hkExceptionSkippedDescription'
  | 'hkGuestNameLabel' | 'hkETALabel' | 'hkNightsLabel' | 'hkNightsUnit'
  | 'hkManagerNotesLabel' | 'hkRushBanner' | 'hkRushDueIn'
  | 'hkFloorPrefix' | 'hkGroupByFloor' | 'hkGroupByRoom'
  | 'hkLunchStart' | 'hkLunchEnd' | 'hkLunchOnBreak' | 'hkLunchMinutesSuffix'
  | 'hkSummaryTitle' | 'hkSummaryRoomsCleaned' | 'hkSummaryActiveMinutes'
  | 'hkSummaryAveragePerRoom' | 'hkSummaryLunchMinutes' | 'hkSummaryShiftHours'
  | 'hkSummaryStillToGo' | 'hkSummaryShowDailySummary'
  | 'hkErrCouldntStart' | 'hkErrCouldntPause' | 'hkErrCouldntResume'
  | 'hkErrCouldntComplete' | 'hkErrCouldntSaveException'
  | 'hkCriticalItem' | 'hkChecklistOptional'
  // Housekeeper mobile rebuild pieces B + C (2026-05-25)
  // Notice board (manager → housekeeper announcement banner)
  | 'hkNotice' | 'hkNoticePinned' | 'hkNoticeDismiss' | 'hkNoticeExpired'
  | 'hkNoticePostTitle' | 'hkNoticePostBody' | 'hkNoticePostPin'
  | 'hkNoticePostExpires' | 'hkNoticePostSubmit' | 'hkNoticePostNoExpiry'
  | 'hkNoticePostExpires1h' | 'hkNoticePostExpires1d' | 'hkNoticePostExpires3d'
  | 'hkNoticePostExpires1w' | 'hkNoticePostExpires1m'
  | 'hkNoticeEmpty' | 'hkNoticePosted' | 'hkNoticeReviewWarning'
  // Structured issue reporting + photo
  | 'hkIssueAction' | 'hkIssueActionReplace' | 'hkIssueActionRepair'
  | 'hkIssueActionClean' | 'hkIssueActionReport'
  | 'hkIssueItem' | 'hkIssueItemPlaceholder'
  | 'hkIssueLocation' | 'hkIssueLocationPlaceholder'
  | 'hkIssueSeverity' | 'hkIssueSeverityMinor' | 'hkIssueSeverityMajor' | 'hkIssueSeverityUrgent'
  | 'hkIssueNote' | 'hkIssueNotePlaceholder'
  | 'hkIssuePhotoAdd' | 'hkIssuePhotoReplace' | 'hkIssuePhotoRemove'
  | 'hkIssueSubmit' | 'hkIssueRoutedToMaintenance'
  | 'hkErrPhotoTooBig' | 'hkErrPhotoUpload'
  // Manager notes (display)
  | 'hkManagerNoteBadge'
  // Manager notes (posting from Rooms tab)
  | 'mgrNotesTitle' | 'mgrNotesPlaceholder' | 'mgrNotesAdd' | 'mgrNotesEmpty'
  | 'mgrNotesExpires' | 'mgrNotesPostedBy' | 'mgrNotesDelete' | 'mgrNotesSaved'
  // Rush flag (front desk → housekeeper)
  | 'rushTitle' | 'rushPrompt' | 'rush15min' | 'rush30min' | 'rush1hr'
  | 'rushSubmit' | 'rushAlreadyActive' | 'rushCleared' | 'rushClearButton'
  | 'rushNotifySent' | 'rushButton'
  // Add Note (housekeeper-facing on job card)
  | 'hkAddNote' | 'hkAddNoteTitle' | 'hkAddNotePlaceholder' | 'hkAddNoteSubmit'
  | 'hkAddNoteSaved' | 'hkAddNoteClear'
  // Mark for inspection
  | 'hkMarkForInspection' | 'hkMarkedForInspection' | 'hkErrMarkInspection'
  // Language switcher (globe)
  | 'langPickerTitle' | 'langPickerSearchPlaceholder' | 'langPickerNoResults'
  | 'langMachineTranslatedNotice'
  // Offline + sync (extension of existing hkOffline)
  | 'hkOfflineQueueCount' | 'hkOfflineSyncing' | 'hkOfflineSynced'
  | 'hkOfflineQueueFailed'
  // Component rooms
  | 'componentRoomLabel' | 'componentRoomChildPrefix' | 'componentRoomAllAreas'
  | 'componentRoomSubAreaDone'
  | 'lndLoadingTasks' | 'lndLaundryLoadsHeading' | 'lndLoadsUnit'
  | 'lndProgressOf' | 'lndProgressDone' | 'lndNoTasksToday'
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
  // ── Room availability ─────────────────────────────────────────────────────
  | 'availableRooms' | 'available' | 'roomOccupied'
  // ── Inventory tracking ────────────────────────────────────────────────────
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
  | 'noDataYet' | 'cleanedBy' | 'cleanTime' | 'sendBack'
  // Stale-data banner (scraper hardening F8)
  | 'staleDataYellow' | 'staleDataRed' | 'staleAlertingDegraded'
  // Voice issue reporting (feature #11)
  | 'voiceIssueTapToSpeak' | 'voiceIssueConnecting' | 'voiceIssueListening'
  | 'voiceIssueProcessing' | 'voiceIssueSuccess' | 'voiceIssueErrorHeard'
  | 'voiceIssueMicBlocked' | 'voiceIssueCapped' | 'voiceIssueError'
  | 'voiceIssueHint' | 'voiceIssueTapToStop'
  // Lost & Found — housekeeper "Found an item" surface
  | 'hkFoundItem' | 'hkFoundItemTitle' | 'hkFoundItemPlaceholder'
  | 'hkFoundItemPhotoAdd' | 'hkFoundItemSubmit' | 'hkFoundItemError';

// EN and ES carry every TranslationKey; HT/TL/VI carry the housekeeper-
// facing subset and fall back to EN via t() for anything missing. The
// `Partial<>` on the three new locales keeps the type honest — no need to
// type-stub admin strings nobody on the housekeeper side will ever read.
interface TranslationMaps {
  en: Record<TranslationKey, string>;
  es: Record<TranslationKey, string>;
  ht: Partial<Record<TranslationKey, string>>;
  tl: Partial<Record<TranslationKey, string>>;
  vi: Partial<Record<TranslationKey, string>>;
}

const translations: TranslationMaps = {
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
    checklistsTitle: 'Checklists',
    checklistsCardDesc: 'Build and edit your cleaning & inspection checklists',
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
    // Customer-facing SMS-link pages (housekeeper/[id] + laundry/[id])
    cxIncompleteLink: 'Incomplete link',
    cxIncompleteLinkHelp: 'Ask your manager for the full link. Parameters are missing.',
    cxHelloPrefix: 'Hi',
    cxGreatWorkToday: 'Great work today',
    hkStartShift: 'Start Shift',
    hkShiftStarted: 'Shift started',
    hkRoomShort: 'Room',
    hkNextShiftPrefix: 'Next shift: ',
    hkLastShiftPrefix: 'Last shift: ',
    hkTypeCheckout: 'CHECKOUT',
    hkTypeStayover: 'STAYOVER',
    hkTypeVacant: 'VACANT',
    hkReportIssueAria: 'Report issue',
    hkIssueShort: 'Issue',
    hkResetShort: 'Reset',
    hkCleaningLabel: 'Cleaning',
    hkStartCleaning: 'Start cleaning',
    hkStopLabel: 'Stop',
    hkStartAgain: 'Start again',
    hkChecklistDone: 'Checklist done',
    hkAllRoomsClean: 'All rooms clean!',
    hkAllRoomsCleanSub: 'Amazing work today, {name}.',
    hkAllRoomsCleanCount: 'You finished all {count} rooms.',
    hkYourRooms: 'Your rooms',
    hkTapToOpen: 'tap to open',
    hkAlerts: 'Alerts',
    hkTabRooms: 'Rooms',
    hkTabMessages: 'Messages',
    hkNewMessage: 'New message',
    hkBack: 'Back',
    hkSend: 'Send',
    hkMessagePlaceholder: 'Message…',
    hkSearchPeople: 'Search people…',
    hkPeople: 'People',
    hkOnlyManagersPost: 'Only managers can post here',
    hkFromManagement: 'From management',
    hkMembers: 'members',
    hkDirectMessage: 'Direct message',
    hkJustNow: 'Just now',
    hkAnnouncementsFromMgmt: 'Announcements from management',
    hkNoMessages: 'No messages yet',
    hkUndoShort: 'Undo',
    hkCompleteShort: 'Complete',
    hkOffline: "You're offline. Changes won't save until you're back online.",
    hkErrCouldntMarkClean: "Couldn't mark Clean. Check your connection and try again.",
    hkErrCouldntToggleDnd: "Couldn't toggle Do Not Disturb.",
    hkErrCouldntSaveIssue: "Couldn't save the issue. Try again.",
    hkErrCouldntResetRoom: "Couldn't reset the room.",
    // Workflow rebuild A (2026-05-24)
    hkActionStart: 'Start',
    hkActionPause: 'Pause',
    hkActionResume: 'Resume',
    hkActionDone: 'Done',
    hkPaused: 'Paused',
    hkOpenChecklist: 'Open checklist',
    hkChecklistTitle: 'Cleaning checklist',
    hkChecklistChecked: 'checked',
    hkChecklistOptional: 'Items are optional — you can finish without checking every one.',
    hkCriticalItem: 'Important',
    hkAreaBathroom: 'Bathroom',
    hkAreaBedroom: 'Bedroom',
    hkAreaLiving: 'Living area',
    hkAreaKitchen: 'Kitchen',
    hkAreaEntry: 'Entry',
    hkAreaAmenities: 'Amenities',
    hkAreaFinal: 'Final check',
    hkException: 'Exception',
    hkExceptionDnd: 'Do Not Disturb',
    hkExceptionNsr: 'No Service',
    hkExceptionDla: 'Double-Lock',
    hkExceptionSleepOut: 'Sleep Out',
    hkExceptionSkipped: 'Skipped',
    hkExceptionLabel: 'Mark this room as',
    hkExceptionAddNoteOptional: 'Add a note (optional)',
    hkExceptionConfirm: 'Confirm',
    hkExceptionClear: 'Clear exception',
    hkExceptionDndDescription: 'Guest asked not to be disturbed',
    hkExceptionNsrDescription: 'Guest opted out of cleaning today',
    hkExceptionDlaDescription: 'Door is double-locked from inside',
    hkExceptionSleepOutDescription: "Guest paid but never arrived",
    hkExceptionSkippedDescription: 'Could not clean — needs supervisor',
    hkGuestNameLabel: 'Guest',
    hkETALabel: 'Arriving',
    hkNightsLabel: 'Nights',
    hkNightsUnit: 'nights',
    hkManagerNotesLabel: 'Manager note',
    hkRushBanner: 'URGENT',
    hkRushDueIn: 'Due',
    hkFloorPrefix: 'Floor',
    hkGroupByFloor: 'By floor',
    hkGroupByRoom: 'By number',
    hkLunchStart: 'Start lunch',
    hkLunchEnd: 'End lunch',
    hkLunchOnBreak: 'On lunch break',
    hkLunchMinutesSuffix: 'min',
    hkSummaryTitle: "Today's summary",
    hkSummaryRoomsCleaned: 'Rooms cleaned',
    hkSummaryActiveMinutes: 'Active cleaning',
    hkSummaryAveragePerRoom: 'Average per room',
    hkSummaryLunchMinutes: 'Lunch break',
    hkSummaryShiftHours: 'Shift hours',
    hkSummaryStillToGo: 'Still to clean',
    hkSummaryShowDailySummary: 'View summary',
    hkErrCouldntStart: "Couldn't start the room.",
    hkErrCouldntPause: "Couldn't pause.",
    hkErrCouldntResume: "Couldn't resume.",
    hkErrCouldntComplete: "Couldn't mark Done.",
    hkErrCouldntSaveException: "Couldn't save exception.",
    // Piece B/C — added 2026-05-25 by feature/housekeeper-mobile-rebuild-BC
    hkNotice: 'Notice',
    hkNoticePinned: 'Pinned',
    hkNoticeDismiss: 'Dismiss',
    hkNoticeExpired: 'Expired',
    hkNoticePostTitle: 'Post a notice',
    hkNoticePostBody: 'Write the announcement',
    hkNoticePostPin: 'Pin to the top until it expires',
    hkNoticePostExpires: 'Expires',
    hkNoticePostSubmit: 'Post notice',
    hkNoticePostNoExpiry: 'No expiry',
    hkNoticePostExpires1h: 'In 1 hour',
    hkNoticePostExpires1d: 'In 1 day',
    hkNoticePostExpires3d: 'In 3 days',
    hkNoticePostExpires1w: 'In 1 week',
    hkNoticePostExpires1m: 'In 1 month',
    hkNoticeEmpty: 'No active notices',
    hkNoticePosted: 'Notice posted',
    hkNoticeReviewWarning: 'Reviewed by manager — translations may not be exact',
    hkIssueAction: 'What needs to happen?',
    hkIssueActionReplace: 'Replace',
    hkIssueActionRepair: 'Repair',
    hkIssueActionClean: 'Clean',
    hkIssueActionReport: 'Report',
    hkIssueItem: 'What item?',
    hkIssueItemPlaceholder: 'Lightbulb, sink, TV…',
    hkIssueLocation: 'Where in the room?',
    hkIssueLocationPlaceholder: 'Near the sink, on the wall…',
    hkIssueSeverity: 'How urgent?',
    hkIssueSeverityMinor: 'Minor',
    hkIssueSeverityMajor: 'Major',
    hkIssueSeverityUrgent: 'Urgent',
    hkIssueNote: 'Anything else?',
    hkIssueNotePlaceholder: 'Optional details',
    hkIssuePhotoAdd: 'Add a photo',
    hkIssuePhotoReplace: 'Replace photo',
    hkIssuePhotoRemove: 'Remove photo',
    hkIssueSubmit: 'Send to maintenance',
    hkIssueRoutedToMaintenance: 'Sent to maintenance',
    hkErrPhotoTooBig: 'Photo is too big — try a smaller one.',
    hkErrPhotoUpload: "Couldn't upload the photo. Try again.",
    hkManagerNoteBadge: 'Manager note',
    mgrNotesTitle: 'Manager notes',
    mgrNotesPlaceholder: 'Add a note for the housekeeper',
    mgrNotesAdd: 'Add note',
    mgrNotesEmpty: 'No notes for this room today',
    mgrNotesExpires: 'Visible until',
    mgrNotesPostedBy: 'Posted by',
    mgrNotesDelete: 'Delete',
    mgrNotesSaved: 'Note saved',
    rushTitle: 'Mark as rush',
    rushPrompt: 'How urgent?',
    rush15min: 'In 15 min',
    rush30min: 'In 30 min',
    rush1hr: 'In 1 hour',
    rushSubmit: 'Send rush',
    rushAlreadyActive: 'This room is already marked rush',
    rushCleared: 'Rush cleared',
    rushClearButton: 'Clear rush',
    rushNotifySent: 'Housekeeper notified',
    rushButton: 'Rush',
    hkAddNote: 'Add note',
    hkAddNoteTitle: 'Quick note',
    hkAddNotePlaceholder: 'Note for the manager',
    hkAddNoteSubmit: 'Save note',
    hkAddNoteSaved: 'Note saved',
    hkAddNoteClear: 'Clear note',
    hkMarkForInspection: 'Mark for inspection',
    hkMarkedForInspection: 'Marked for inspection',
    hkErrMarkInspection: "Couldn't mark for inspection.",
    langPickerTitle: 'Choose your language',
    langPickerSearchPlaceholder: 'Search for your language',
    langPickerNoResults: 'No language matches',
    langMachineTranslatedNotice: 'Some text may not be fully translated yet',
    hkOfflineQueueCount: 'Will sync when you reconnect',
    hkOfflineSyncing: 'Syncing your changes',
    hkOfflineSynced: 'Changes synced',
    hkOfflineQueueFailed: 'Some changes did not sync — tap to retry',
    componentRoomLabel: 'Suite',
    componentRoomChildPrefix: 'Includes',
    componentRoomAllAreas: 'All areas',
    componentRoomSubAreaDone: 'Done',
    lndLoadingTasks: 'Loading tasks...',
    lndLaundryLoadsHeading: 'Laundry Loads',
    lndLoadsUnit: 'loads',
    lndProgressOf: 'of',
    lndProgressDone: 'done',
    lndNoTasksToday: 'No laundry tasks today. Check back later!',
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
    // ── Room availability ──
    availableRooms: 'Available Rooms',
    available: 'Available',
    roomOccupied: 'Occupied',
    // ── Inventory tracking ──
    inventoryTracking: 'Inventory',
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
    // Stale-data banner (scraper hardening F8). {{age}} placeholder is
    // replaced client-side with a human-friendly age ("45 min", "2h", "1d").
    staleDataYellow:       'Numbers may be out of date (last updated {{age}} ago).',
    staleDataRed:          'Live numbers unavailable. Don’t act on these until they update (last updated {{age}} ago).',
    staleAlertingDegraded: 'Alerting is degraded — SMS notifications may not fire.',
    // Voice issue reporting (feature #11). The mic button on the issue
    // modal — housekeeper taps it, speaks in their own language, AI
    // extracts structured fields and files the maintenance ticket.
    voiceIssueTapToSpeak: 'Tap to speak — describe the problem',
    voiceIssueConnecting: 'Connecting…',
    voiceIssueListening:  'Listening… speak in any language',
    voiceIssueTapToStop:  'Tap to stop',
    voiceIssueProcessing: 'Got it — filing the ticket…',
    voiceIssueSuccess:    'Ticket filed.',
    voiceIssueErrorHeard: "Sorry, I didn't catch that. Try again or type it.",
    voiceIssueMicBlocked: 'Mic blocked. Enable microphone access in your phone settings, or type the issue.',
    voiceIssueCapped:     'Voice limit reached for today. Please type the issue.',
    voiceIssueError:      "Voice didn't work. You can type the issue instead.",
    voiceIssueHint:       'Or type below',
    // Lost & Found
    hkFoundItem:          'Found item',
    hkFoundItemTitle:     'Report a found item',
    hkFoundItemPlaceholder: 'What did you find? (e.g. black jacket)',
    hkFoundItemPhotoAdd:  'Add photo',
    hkFoundItemSubmit:    'Log item',
    hkFoundItemError:     "Couldn't log the item. Try again.",
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
    checklistsTitle: 'Listas de verificación',
    checklistsCardDesc: 'Crea y edita tus listas de limpieza e inspección',
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
    // Customer-facing SMS-link pages (housekeeper/[id] + laundry/[id])
    cxIncompleteLink: 'Enlace incompleto',
    cxIncompleteLinkHelp: 'Pídele a tu encargada el enlace completo. Faltan parámetros.',
    cxHelloPrefix: 'Hola',
    cxGreatWorkToday: '¡Buen trabajo hoy',
    hkStartShift: 'Comenzar Turno',
    hkShiftStarted: 'Turno iniciado',
    hkRoomShort: 'Hab.',
    hkNextShiftPrefix: 'Próximo turno: ',
    hkLastShiftPrefix: 'Turno anterior: ',
    hkTypeCheckout: 'SALIDA',
    hkTypeStayover: 'OCUPADA',
    hkTypeVacant: 'VACANTE',
    hkReportIssueAria: 'Reportar problema',
    hkIssueShort: 'Problema',
    hkResetShort: 'Revertir',
    hkCleaningLabel: 'Limpiando',
    hkStartCleaning: 'Comenzar limpieza',
    hkStopLabel: 'Detener',
    hkStartAgain: 'Empezar de nuevo',
    hkChecklistDone: 'Lista completa',
    hkAllRoomsClean: '¡Todas las habitaciones limpias!',
    hkAllRoomsCleanSub: 'Excelente trabajo hoy, {name}.',
    hkAllRoomsCleanCount: 'Terminaste las {count} habitaciones.',
    hkYourRooms: 'Tus habitaciones',
    hkTapToOpen: 'toca para abrir',
    hkAlerts: 'Alertas',
    hkTabRooms: 'Habitaciones',
    hkTabMessages: 'Mensajes',
    hkNewMessage: 'Nuevo mensaje',
    hkBack: 'Atrás',
    hkSend: 'Enviar',
    hkMessagePlaceholder: 'Mensaje…',
    hkSearchPeople: 'Buscar personas…',
    hkPeople: 'Personas',
    hkOnlyManagersPost: 'Solo los gerentes pueden publicar aquí',
    hkFromManagement: 'De la gerencia',
    hkMembers: 'miembros',
    hkDirectMessage: 'Mensaje directo',
    hkJustNow: 'Ahora mismo',
    hkAnnouncementsFromMgmt: 'Anuncios de la gerencia',
    hkNoMessages: 'Sin mensajes aún',
    hkUndoShort: 'Quitar',
    hkCompleteShort: 'Completar',
    hkOffline: 'Sin conexión. Tus cambios no se guardarán hasta volver a estar en línea.',
    hkErrCouldntMarkClean: 'No se pudo guardar como Limpia. Verifica tu conexión e intenta de nuevo.',
    hkErrCouldntToggleDnd: 'No se pudo cambiar No Molestar.',
    hkErrCouldntSaveIssue: 'No se pudo guardar el problema. Tócalo otra vez.',
    hkErrCouldntResetRoom: 'No se pudo reiniciar la habitación.',
    // Workflow rebuild A (2026-05-24)
    hkActionStart: 'Comenzar',
    hkActionPause: 'Pausar',
    hkActionResume: 'Reanudar',
    hkActionDone: 'Listo',
    hkPaused: 'En pausa',
    hkOpenChecklist: 'Ver lista',
    hkChecklistTitle: 'Lista de limpieza',
    hkChecklistChecked: 'marcados',
    hkChecklistOptional: 'La lista es opcional — puedes terminar sin marcar todo.',
    hkCriticalItem: 'Importante',
    hkAreaBathroom: 'Baño',
    hkAreaBedroom: 'Dormitorio',
    hkAreaLiving: 'Sala',
    hkAreaKitchen: 'Cocina',
    hkAreaEntry: 'Entrada',
    hkAreaAmenities: 'Amenidades',
    hkAreaFinal: 'Inspección final',
    hkException: 'Excepción',
    hkExceptionDnd: 'No Molestar',
    hkExceptionNsr: 'Sin Servicio',
    hkExceptionDla: 'Doble Seguro',
    hkExceptionSleepOut: 'No Llegó',
    hkExceptionSkipped: 'Omitida',
    hkExceptionLabel: 'Marcar esta habitación como',
    hkExceptionAddNoteOptional: 'Agregar nota (opcional)',
    hkExceptionConfirm: 'Confirmar',
    hkExceptionClear: 'Quitar excepción',
    hkExceptionDndDescription: 'El huésped pidió no ser molestado',
    hkExceptionNsrDescription: 'El huésped no quiere limpieza hoy',
    hkExceptionDlaDescription: 'Puerta con doble seguro por dentro',
    hkExceptionSleepOutDescription: 'El huésped pagó pero no llegó',
    hkExceptionSkippedDescription: 'No se pudo limpiar — avisar supervisor',
    hkGuestNameLabel: 'Huésped',
    hkETALabel: 'Llegada',
    hkNightsLabel: 'Noches',
    hkNightsUnit: 'noches',
    hkManagerNotesLabel: 'Nota del supervisor',
    hkRushBanner: 'URGENTE',
    hkRushDueIn: 'Para',
    hkFloorPrefix: 'Piso',
    hkGroupByFloor: 'Por piso',
    hkGroupByRoom: 'Por número',
    hkLunchStart: 'Comenzar almuerzo',
    hkLunchEnd: 'Terminar almuerzo',
    hkLunchOnBreak: 'En almuerzo',
    hkLunchMinutesSuffix: 'min',
    hkSummaryTitle: 'Resumen del día',
    hkSummaryRoomsCleaned: 'Habitaciones limpiadas',
    hkSummaryActiveMinutes: 'Tiempo de limpieza',
    hkSummaryAveragePerRoom: 'Promedio por habitación',
    hkSummaryLunchMinutes: 'Tiempo de almuerzo',
    hkSummaryShiftHours: 'Horas del turno',
    hkSummaryStillToGo: 'Faltan por limpiar',
    hkSummaryShowDailySummary: 'Ver resumen',
    hkErrCouldntStart: 'No se pudo comenzar la habitación.',
    hkErrCouldntPause: 'No se pudo pausar.',
    hkErrCouldntResume: 'No se pudo reanudar.',
    hkErrCouldntComplete: 'No se pudo marcar como Lista.',
    hkErrCouldntSaveException: 'No se pudo guardar la excepción.',
    // Piece B/C — added 2026-05-25
    hkNotice: 'Aviso',
    hkNoticePinned: 'Fijado',
    hkNoticeDismiss: 'Cerrar',
    hkNoticeExpired: 'Expirado',
    hkNoticePostTitle: 'Publicar un aviso',
    hkNoticePostBody: 'Escribe el anuncio',
    hkNoticePostPin: 'Fijar arriba hasta que expire',
    hkNoticePostExpires: 'Expira',
    hkNoticePostSubmit: 'Publicar aviso',
    hkNoticePostNoExpiry: 'Sin expiración',
    hkNoticePostExpires1h: 'En 1 hora',
    hkNoticePostExpires1d: 'En 1 día',
    hkNoticePostExpires3d: 'En 3 días',
    hkNoticePostExpires1w: 'En 1 semana',
    hkNoticePostExpires1m: 'En 1 mes',
    hkNoticeEmpty: 'No hay avisos activos',
    hkNoticePosted: 'Aviso publicado',
    hkNoticeReviewWarning: 'Revisado por gerente — traducciones pueden no ser exactas',
    hkIssueAction: '¿Qué se necesita hacer?',
    hkIssueActionReplace: 'Reemplazar',
    hkIssueActionRepair: 'Reparar',
    hkIssueActionClean: 'Limpiar',
    hkIssueActionReport: 'Reportar',
    hkIssueItem: '¿Qué cosa?',
    hkIssueItemPlaceholder: 'Bombilla, lavabo, TV…',
    hkIssueLocation: '¿Dónde en la habitación?',
    hkIssueLocationPlaceholder: 'Cerca del lavabo, en la pared…',
    hkIssueSeverity: '¿Qué tan urgente?',
    hkIssueSeverityMinor: 'Menor',
    hkIssueSeverityMajor: 'Mayor',
    hkIssueSeverityUrgent: 'Urgente',
    hkIssueNote: '¿Algo más?',
    hkIssueNotePlaceholder: 'Detalles opcionales',
    hkIssuePhotoAdd: 'Agregar foto',
    hkIssuePhotoReplace: 'Reemplazar foto',
    hkIssuePhotoRemove: 'Quitar foto',
    hkIssueSubmit: 'Enviar a mantenimiento',
    hkIssueRoutedToMaintenance: 'Enviado a mantenimiento',
    hkErrPhotoTooBig: 'La foto es muy grande — usa una más pequeña.',
    hkErrPhotoUpload: 'No se pudo subir la foto. Intenta otra vez.',
    hkManagerNoteBadge: 'Nota del gerente',
    mgrNotesTitle: 'Notas del gerente',
    mgrNotesPlaceholder: 'Agregar nota para la camarista',
    mgrNotesAdd: 'Agregar nota',
    mgrNotesEmpty: 'No hay notas para esta habitación hoy',
    mgrNotesExpires: 'Visible hasta',
    mgrNotesPostedBy: 'Publicado por',
    mgrNotesDelete: 'Borrar',
    mgrNotesSaved: 'Nota guardada',
    rushTitle: 'Marcar como urgente',
    rushPrompt: '¿Qué tan urgente?',
    rush15min: 'En 15 min',
    rush30min: 'En 30 min',
    rush1hr: 'En 1 hora',
    rushSubmit: 'Enviar urgente',
    rushAlreadyActive: 'Esta habitación ya está marcada urgente',
    rushCleared: 'Urgencia quitada',
    rushClearButton: 'Quitar urgencia',
    rushNotifySent: 'Camarista notificada',
    rushButton: 'Urgente',
    hkAddNote: 'Agregar nota',
    hkAddNoteTitle: 'Nota rápida',
    hkAddNotePlaceholder: 'Nota para el gerente',
    hkAddNoteSubmit: 'Guardar nota',
    hkAddNoteSaved: 'Nota guardada',
    hkAddNoteClear: 'Quitar nota',
    hkMarkForInspection: 'Marcar para inspección',
    hkMarkedForInspection: 'Marcada para inspección',
    hkErrMarkInspection: 'No se pudo marcar para inspección.',
    langPickerTitle: 'Elige tu idioma',
    langPickerSearchPlaceholder: 'Busca tu idioma',
    langPickerNoResults: 'No coincide ningún idioma',
    langMachineTranslatedNotice: 'Algunos textos aún no están traducidos por completo',
    hkOfflineQueueCount: 'Se sincronizará cuando regrese la conexión',
    hkOfflineSyncing: 'Sincronizando tus cambios',
    hkOfflineSynced: 'Cambios sincronizados',
    hkOfflineQueueFailed: 'Algunos cambios no se sincronizaron — toca para reintentar',
    componentRoomLabel: 'Suite',
    componentRoomChildPrefix: 'Incluye',
    componentRoomAllAreas: 'Todas las áreas',
    componentRoomSubAreaDone: 'Listo',
    lndLoadingTasks: 'Cargando tareas...',
    lndLaundryLoadsHeading: 'Cargas de Lavandería',
    lndLoadsUnit: 'cargas',
    lndProgressOf: 'de',
    lndProgressDone: 'listas',
    lndNoTasksToday: 'No hay tareas de lavandería hoy. ¡Vuelve más tarde!',
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
    // ── Room availability ──
    availableRooms: 'Hab. Disponibles',
    available: 'Disponible',
    roomOccupied: 'Ocupada',
    // ── Inventory tracking ──
    inventoryTracking: 'Inventario',
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
    // Banner de datos desactualizados (F8). {{age}} se reemplaza al
    // renderizar con la edad ("45 min", "2 h", "1 d").
    staleDataYellow:       'Los números pueden estar desactualizados (última actualización hace {{age}}).',
    staleDataRed:          'Datos en vivo no disponibles. No actúe sobre estos números hasta que se actualicen (última actualización hace {{age}}).',
    staleAlertingDegraded: 'Las alertas están degradadas — las notificaciones SMS pueden no enviarse.',
    // Reporte de problema por voz (función #11).
    voiceIssueTapToSpeak: 'Toca para hablar — describe el problema',
    voiceIssueConnecting: 'Conectando…',
    voiceIssueListening:  'Escuchando… habla en tu idioma',
    voiceIssueTapToStop:  'Toca para detener',
    voiceIssueProcessing: 'Listo — creando el ticket…',
    voiceIssueSuccess:    'Ticket creado.',
    voiceIssueErrorHeard: 'Lo siento, no escuché bien. Intenta de nuevo o escríbelo.',
    voiceIssueMicBlocked: 'Micrófono bloqueado. Permite el acceso al micrófono en la configuración del teléfono, o escribe el problema.',
    voiceIssueCapped:     'Límite de voz alcanzado por hoy. Por favor escribe el problema.',
    voiceIssueError:      'La voz no funcionó. Puedes escribir el problema en su lugar.',
    voiceIssueHint:       'O escribe abajo',
    // Lost & Found
    hkFoundItem:          'Objeto encontrado',
    hkFoundItemTitle:     'Reportar objeto encontrado',
    hkFoundItemPlaceholder: '¿Qué encontraste? (p. ej. chaqueta negra)',
    hkFoundItemPhotoAdd:  'Agregar foto',
    hkFoundItemSubmit:    'Registrar',
    hkFoundItemError:     'No se pudo registrar. Intenta de nuevo.',
  },

  // ─────────────────────────────────────────────────────────────────────
  // Haitian Creole (Kreyòl Ayisyen)
  // ─────────────────────────────────────────────────────────────────────
  // Hand-translated subset covering the housekeeper-facing UI. Every
  // other key falls back to English via t(). LANGUAGE_META marks this as
  // machine_translated so the UI shows the "translations may not be
  // exact" notice until a fluent speaker reviews.
  ht: {
    // Header / shell
    cxHelloPrefix: 'Bonjou',
    cxIncompleteLink: 'Lyen ki pa konplè',
    cxIncompleteLinkHelp: 'Mande manadjè w lyen konplè a. Gen paramèt ki manke.',
    cxGreatWorkToday: 'Bon travay jodi a',
    // Shift
    hkStartShift: 'Kòmanse Travay',
    hkShiftStarted: 'Travay kòmanse',
    hkNextShiftPrefix: 'Pwochen travay: ',
    hkLastShiftPrefix: 'Dènye travay: ',
    // Rooms
    hkRoomShort: 'Chanm',
    hkTypeCheckout: 'CHEK-OUT',
    hkTypeStayover: 'RETE',
    hkTypeVacant: 'VID',
    hkFloorPrefix: 'Etaj',
    hkGroupByFloor: 'Pa etaj',
    hkGroupByRoom: 'Pa nimewo',
    // Actions
    hkActionStart: 'Kòmanse',
    hkActionPause: 'Kanpe',
    hkActionResume: 'Kontinye',
    hkActionDone: 'Fini',
    hkPaused: 'Kanpe',
    hkCompleteShort: 'Fini',
    hkResetShort: 'Refè',
    hkCleaningLabel: 'Ap netwaye',
    hkStartCleaning: 'Kòmanse netwaye',
    hkStopLabel: 'Kanpe',
    hkStartAgain: 'Rekòmanse',
    hkChecklistDone: 'Lis fini',
    hkAllRoomsClean: 'Tout chanm yo pwòp!',
    hkAllRoomsCleanSub: 'Bon travay jodi a, {name}.',
    hkAllRoomsCleanCount: 'Ou fini tout {count} chanm yo.',
    hkYourRooms: 'Chanm ou yo',
    hkTapToOpen: 'tape pou ouvri',
    hkAlerts: 'Alèt',
    hkTabRooms: 'Chanm',
    hkTabMessages: 'Mesaj',
    hkNewMessage: 'Nouvo mesaj',
    hkBack: 'Tounen',
    hkSend: 'Voye',
    hkMessagePlaceholder: 'Mesaj…',
    hkSearchPeople: 'Chèche moun…',
    hkPeople: 'Moun',
    hkOnlyManagersPost: 'Se sèlman manadjè ki ka poste isit la',
    hkFromManagement: 'Soti nan jesyon an',
    hkMembers: 'manm',
    hkDirectMessage: 'Mesaj dirèk',
    hkJustNow: 'Kounye a',
    hkAnnouncementsFromMgmt: 'Anons soti nan jesyon an',
    hkNoMessages: 'Poko gen mesaj',
    hkUndoShort: 'Anile',
    // Checklist
    hkOpenChecklist: 'Ouvri lis',
    hkChecklistTitle: 'Lis netwayaj',
    hkChecklistChecked: 'tcheke',
    hkChecklistOptional: 'Lis la opsyonèl — ou ka fini san tcheke tout bagay.',
    hkCriticalItem: 'Enpòtan',
    hkAreaBathroom: 'Twalèt',
    hkAreaBedroom: 'Chanm a kouche',
    hkAreaLiving: 'Sal',
    hkAreaKitchen: 'Kwizin',
    hkAreaEntry: 'Antre',
    hkAreaAmenities: 'Pwodwi',
    hkAreaFinal: 'Tchekap final',
    // Exceptions
    hkException: 'Eksepsyon',
    hkExceptionDnd: 'Pa Deranje',
    hkExceptionNsr: 'Pa Bezwen Sèvis',
    hkExceptionDla: 'Pòt Doub-Kloure',
    hkExceptionSleepOut: 'Pa Vini',
    hkExceptionSkipped: 'Sote',
    hkExceptionLabel: 'Make chanm sa a kòm',
    hkExceptionAddNoteOptional: 'Ajoute yon nòt (opsyonèl)',
    hkExceptionConfirm: 'Konfime',
    hkExceptionClear: 'Retire eksepsyon',
    hkExceptionDndDescription: 'Klyen mande pou pa deranje',
    hkExceptionNsrDescription: 'Klyen pa vle sèvis jodi a',
    hkExceptionDlaDescription: 'Pòt doub-kloure pa anndan',
    hkExceptionSleepOutDescription: 'Klyen peye men pa janm rive',
    hkExceptionSkippedDescription: 'Pa kapab netwaye — bezwen sipèvizè',
    // Issue (legacy)
    hkIssueShort: 'Pwoblèm',
    hkReportIssueAria: 'Rapòte yon pwoblèm',
    // Guest context
    hkGuestNameLabel: 'Klyen',
    hkETALabel: 'Ap rive',
    hkNightsLabel: 'Nwit',
    hkNightsUnit: 'nwit',
    hkManagerNotesLabel: 'Nòt manadjè',
    hkManagerNoteBadge: 'Nòt manadjè',
    // Rush
    hkRushBanner: 'IJAN',
    hkRushDueIn: 'Pou',
    // Lunch + summary
    hkLunchStart: 'Kòmanse manje',
    hkLunchEnd: 'Fin manje',
    hkLunchOnBreak: 'Ap manje',
    hkLunchMinutesSuffix: 'min',
    hkSummaryTitle: 'Rezime jodi a',
    hkSummaryRoomsCleaned: 'Chanm netwaye',
    hkSummaryActiveMinutes: 'Tan netwayaj',
    hkSummaryAveragePerRoom: 'Mwayèn pa chanm',
    hkSummaryLunchMinutes: 'Tan manje',
    hkSummaryShiftHours: 'Èdtravay',
    hkSummaryStillToGo: 'Ki rete pou netwaye',
    hkSummaryShowDailySummary: 'Wè rezime',
    // Offline + sync
    hkOffline: 'Ou òfline. Chanjman yo p ap sove jiskaske ou rekonekte.',
    hkOfflineQueueCount: 'Ap senkronize lè konnektivite tounen',
    hkOfflineSyncing: 'Ap senkronize chanjman ou yo',
    hkOfflineSynced: 'Chanjman senkronize',
    hkOfflineQueueFailed: 'Kèk chanjman pa senkronize — tape pou eseye ankò',
    // Error toasts
    hkErrCouldntMarkClean: 'Pa kapab make kòm Pwòp. Tcheke koneksyon w ak eseye ankò.',
    hkErrCouldntToggleDnd: 'Pa kapab chanje Pa Deranje.',
    hkErrCouldntSaveIssue: 'Pa kapab sove pwoblèm nan. Eseye ankò.',
    hkErrCouldntResetRoom: 'Pa kapab refè chanm nan.',
    hkErrCouldntStart: 'Pa kapab kòmanse chanm nan.',
    hkErrCouldntPause: 'Pa kapab kanpe.',
    hkErrCouldntResume: 'Pa kapab kontinye.',
    hkErrCouldntComplete: 'Pa kapab make Fini.',
    hkErrCouldntSaveException: 'Pa kapab sove eksepsyon.',
    hkErrMarkInspection: 'Pa kapab make pou enspeksyon.',
    hkErrPhotoTooBig: 'Foto a twò gwo — eseye yon pi piti.',
    hkErrPhotoUpload: 'Pa kapab voye foto a. Eseye ankò.',
    // Notice board (housekeeper side)
    hkNotice: 'Avi',
    hkNoticePinned: 'Klouwe',
    hkNoticeDismiss: 'Fèmen',
    hkNoticeExpired: 'Ekspire',
    hkNoticeReviewWarning: 'Revize pa manadjè — tradiksyon ka pa egzak',
    // Structured issue (housekeeper)
    hkIssueAction: 'Kisa ki bezwen rive?',
    hkIssueActionReplace: 'Ranplase',
    hkIssueActionRepair: 'Repare',
    hkIssueActionClean: 'Netwaye',
    hkIssueActionReport: 'Rapòte',
    hkIssueItem: 'Ki bagay?',
    hkIssueItemPlaceholder: 'Anpoul, lavabo, TV…',
    hkIssueLocation: 'Ki kote nan chanm nan?',
    hkIssueLocationPlaceholder: 'Bò lavabo a, sou mi…',
    hkIssueSeverity: 'Konbyen ijan?',
    hkIssueSeverityMinor: 'Piti',
    hkIssueSeverityMajor: 'Gwo',
    hkIssueSeverityUrgent: 'Ijan',
    hkIssueNote: 'Lòt bagay?',
    hkIssueNotePlaceholder: 'Detay opsyonèl',
    hkIssuePhotoAdd: 'Ajoute foto',
    hkIssuePhotoReplace: 'Ranplase foto',
    hkIssuePhotoRemove: 'Retire foto',
    hkIssueSubmit: 'Voye nan antretyen',
    hkIssueRoutedToMaintenance: 'Voye nan antretyen',
    // Add note + mark for inspection (housekeeper)
    hkAddNote: 'Ajoute nòt',
    hkAddNoteTitle: 'Nòt rapid',
    hkAddNotePlaceholder: 'Nòt pou manadjè a',
    hkAddNoteSubmit: 'Sove nòt',
    hkAddNoteSaved: 'Nòt sove',
    hkAddNoteClear: 'Retire nòt',
    hkMarkForInspection: 'Make pou enspeksyon',
    hkMarkedForInspection: 'Make pou enspeksyon',
    // Language picker
    langPickerTitle: 'Chwazi lang ou',
    langPickerSearchPlaceholder: 'Chèche lang ou',
    langPickerNoResults: 'Pa gen lang ki matche',
    langMachineTranslatedNotice: 'Kèk tèks ka pa konplètman tradwi ankò',
    // Component rooms
    componentRoomLabel: 'Swit',
    componentRoomChildPrefix: 'Genyen',
    componentRoomAllAreas: 'Tout zòn yo',
    componentRoomSubAreaDone: 'Fini',
    // Common
    cancel: 'Anile',
    submit: 'Voye',
    savingDots: 'Ap sove...',
    loadingRooms: 'Ap chaje chanm yo...',
    inProgress: 'Ap fèt',
    earlyCheckin: 'Antre bonè',
    done: 'Fini',
    allDone: 'Tout bagay fini!',
    noRoomsAssigned: 'Ou pa gen chanm jodi a',
    checkBackSoon: 'Retounen pita',
    reportIssue: 'Rapòte yon pwoblèm',
    describeIssue: 'Dekri pwoblèm nan',
    doNotDisturb: 'Pa Deranje',
    markDnd: 'Make Pa Deranje',
    removeDnd: 'Retire Pa Deranje',
    // Laundry strings (laundry page is also housekeeper-facing)
    lndLoadingTasks: 'Ap chaje travay yo...',
    lndLaundryLoadsHeading: 'Chaj Lave',
    lndLoadsUnit: 'chaj',
    lndProgressOf: 'sou',
    lndProgressDone: 'fini',
    lndNoTasksToday: 'Pa gen travay lave jodi a. Retounen pita!',
  },

  // ─────────────────────────────────────────────────────────────────────
  // Tagalog
  // ─────────────────────────────────────────────────────────────────────
  tl: {
    cxHelloPrefix: 'Kumusta',
    cxIncompleteLink: 'Hindi kumpleto ang link',
    cxIncompleteLinkHelp: 'Hingin sa manager ang kumpletong link. May kulang na detalye.',
    cxGreatWorkToday: 'Magaling na trabaho ngayong araw',
    hkStartShift: 'Simulan ang Shift',
    hkShiftStarted: 'Nagsimula na ang shift',
    hkNextShiftPrefix: 'Susunod na shift: ',
    hkLastShiftPrefix: 'Huling shift: ',
    hkRoomShort: 'Kwarto',
    hkTypeCheckout: 'CHECKOUT',
    hkTypeStayover: 'STAYOVER',
    hkTypeVacant: 'WALA',
    hkFloorPrefix: 'Palapag',
    hkGroupByFloor: 'Sa palapag',
    hkGroupByRoom: 'Sa numero',
    hkActionStart: 'Simulan',
    hkActionPause: 'I-pause',
    hkActionResume: 'Ituloy',
    hkActionDone: 'Tapos na',
    hkPaused: 'Naka-pause',
    hkCompleteShort: 'Tapos',
    hkResetShort: 'I-reset',
    hkCleaningLabel: 'Naglilinis',
    hkStartCleaning: 'Simulan ang paglilinis',
    hkStopLabel: 'Itigil',
    hkStartAgain: 'Magsimula ulit',
    hkChecklistDone: 'Tapos na ang listahan',
    hkAllRoomsClean: 'Malinis na lahat ng kwarto!',
    hkAllRoomsCleanSub: 'Magaling ngayon, {name}.',
    hkAllRoomsCleanCount: 'Natapos mo lahat ng {count} kwarto.',
    hkYourRooms: 'Mga kwarto mo',
    hkTapToOpen: 'i-tap para buksan',
    hkAlerts: 'Mga alerto',
    hkTabRooms: 'Mga Kwarto',
    hkTabMessages: 'Mga Mensahe',
    hkNewMessage: 'Bagong mensahe',
    hkBack: 'Bumalik',
    hkSend: 'Ipadala',
    hkMessagePlaceholder: 'Mensahe…',
    hkSearchPeople: 'Maghanap ng tao…',
    hkPeople: 'Mga tao',
    hkOnlyManagersPost: 'Mga manager lang ang puwedeng mag-post dito',
    hkFromManagement: 'Mula sa pamamahala',
    hkMembers: 'mga miyembro',
    hkDirectMessage: 'Direktang mensahe',
    hkJustNow: 'Ngayon lang',
    hkAnnouncementsFromMgmt: 'Mga anunsyo mula sa pamamahala',
    hkNoMessages: 'Wala pang mensahe',
    hkUndoShort: 'Bawiin',
    hkOpenChecklist: 'Buksan ang listahan',
    hkChecklistTitle: 'Listahan ng paglilinis',
    hkChecklistChecked: 'na-check',
    hkChecklistOptional: 'Opsyonal ang listahan — pwede mong tapusin nang hindi nila-lahat.',
    hkCriticalItem: 'Mahalaga',
    hkAreaBathroom: 'Banyo',
    hkAreaBedroom: 'Tulugan',
    hkAreaLiving: 'Sala',
    hkAreaKitchen: 'Kusina',
    hkAreaEntry: 'Pasukan',
    hkAreaAmenities: 'Mga supply',
    hkAreaFinal: 'Huling tsek',
    hkException: 'Eksepsiyon',
    hkExceptionDnd: 'Huwag Istorbohin',
    hkExceptionNsr: 'Walang Serbisyo',
    hkExceptionDla: 'Doble-Kandado',
    hkExceptionSleepOut: 'Hindi Dumating',
    hkExceptionSkipped: 'Nilaktawan',
    hkExceptionLabel: 'Markahan ang kwartong ito bilang',
    hkExceptionAddNoteOptional: 'Magdagdag ng nota (opsyonal)',
    hkExceptionConfirm: 'Kumpirmahin',
    hkExceptionClear: 'Alisin ang eksepsiyon',
    hkExceptionDndDescription: 'Humingi ang bisita na huwag istorbohin',
    hkExceptionNsrDescription: 'Hindi gusto ng bisita ang serbisyo ngayong araw',
    hkExceptionDlaDescription: 'Doble-kandado ang pinto mula sa loob',
    hkExceptionSleepOutDescription: 'Nagbayad ang bisita pero hindi dumating',
    hkExceptionSkippedDescription: 'Hindi nalinis — kailangan ng supervisor',
    hkIssueShort: 'Problema',
    hkReportIssueAria: 'Mag-report ng problema',
    hkGuestNameLabel: 'Bisita',
    hkETALabel: 'Darating',
    hkNightsLabel: 'Mga gabi',
    hkNightsUnit: 'na gabi',
    hkManagerNotesLabel: 'Nota ng manager',
    hkManagerNoteBadge: 'Nota ng manager',
    hkRushBanner: 'URGENT',
    hkRushDueIn: 'Dapat tapos',
    hkLunchStart: 'Simulan ang tanghalian',
    hkLunchEnd: 'Tapusin ang tanghalian',
    hkLunchOnBreak: 'Nag-tatanghalian',
    hkLunchMinutesSuffix: 'min',
    hkSummaryTitle: 'Buod ng araw',
    hkSummaryRoomsCleaned: 'Mga nalinisang kwarto',
    hkSummaryActiveMinutes: 'Oras ng paglilinis',
    hkSummaryAveragePerRoom: 'Karaniwan kada kwarto',
    hkSummaryLunchMinutes: 'Oras ng tanghalian',
    hkSummaryShiftHours: 'Oras ng shift',
    hkSummaryStillToGo: 'Dapat pang linisin',
    hkSummaryShowDailySummary: 'Tignan ang buod',
    hkOffline: 'Wala kang koneksyon. Hindi mase-save ang mga pagbabago hanggang bumalik ka online.',
    hkOfflineQueueCount: 'Magsisync kapag bumalik ang koneksyon',
    hkOfflineSyncing: 'Sini-sync ang iyong mga pagbabago',
    hkOfflineSynced: 'Na-sync na ang mga pagbabago',
    hkOfflineQueueFailed: 'Hindi nag-sync ang ilang pagbabago — pindutin para subukan ulit',
    hkErrCouldntMarkClean: 'Hindi nai-mark na malinis. Tingnan ang koneksyon at subukan ulit.',
    hkErrCouldntToggleDnd: 'Hindi nai-toggle ang Huwag Istorbohin.',
    hkErrCouldntSaveIssue: 'Hindi na-save ang problema. Subukan ulit.',
    hkErrCouldntResetRoom: 'Hindi na-reset ang kwarto.',
    hkErrCouldntStart: 'Hindi nasimulan ang kwarto.',
    hkErrCouldntPause: 'Hindi na-pause.',
    hkErrCouldntResume: 'Hindi naituloy.',
    hkErrCouldntComplete: 'Hindi nai-mark na Tapos.',
    hkErrCouldntSaveException: 'Hindi na-save ang eksepsiyon.',
    hkErrMarkInspection: 'Hindi nai-mark para sa inspeksyon.',
    hkErrPhotoTooBig: 'Masyadong malaki ang larawan — subukan ang mas maliit.',
    hkErrPhotoUpload: 'Hindi nai-upload ang larawan. Subukan ulit.',
    hkNotice: 'Paunawa',
    hkNoticePinned: 'Naka-pin',
    hkNoticeDismiss: 'Isara',
    hkNoticeExpired: 'Expired na',
    hkNoticeReviewWarning: 'Sinuri ng manager — maaaring hindi eksakto ang pagsasalin',
    hkIssueAction: 'Ano ang dapat gawin?',
    hkIssueActionReplace: 'Palitan',
    hkIssueActionRepair: 'Ayusin',
    hkIssueActionClean: 'Linisin',
    hkIssueActionReport: 'I-report',
    hkIssueItem: 'Anong bagay?',
    hkIssueItemPlaceholder: 'Bombilya, lababo, TV…',
    hkIssueLocation: 'Saan sa kwarto?',
    hkIssueLocationPlaceholder: 'Malapit sa lababo, sa dingding…',
    hkIssueSeverity: 'Gaano kaurgent?',
    hkIssueSeverityMinor: 'Maliit',
    hkIssueSeverityMajor: 'Malaki',
    hkIssueSeverityUrgent: 'Urgent',
    hkIssueNote: 'May iba pa ba?',
    hkIssueNotePlaceholder: 'Opsyonal na detalye',
    hkIssuePhotoAdd: 'Magdagdag ng larawan',
    hkIssuePhotoReplace: 'Palitan ang larawan',
    hkIssuePhotoRemove: 'Tanggalin ang larawan',
    hkIssueSubmit: 'Ipadala sa maintenance',
    hkIssueRoutedToMaintenance: 'Naipadala sa maintenance',
    hkAddNote: 'Magdagdag ng nota',
    hkAddNoteTitle: 'Mabilis na nota',
    hkAddNotePlaceholder: 'Nota para sa manager',
    hkAddNoteSubmit: 'I-save ang nota',
    hkAddNoteSaved: 'Na-save ang nota',
    hkAddNoteClear: 'Alisin ang nota',
    hkMarkForInspection: 'I-mark para sa inspeksyon',
    hkMarkedForInspection: 'Na-mark para sa inspeksyon',
    langPickerTitle: 'Piliin ang iyong wika',
    langPickerSearchPlaceholder: 'Hanapin ang iyong wika',
    langPickerNoResults: 'Walang tugmang wika',
    langMachineTranslatedNotice: 'May ilang teksto na maaaring hindi pa lubos na naisalin',
    componentRoomLabel: 'Suite',
    componentRoomChildPrefix: 'Kasama ang',
    componentRoomAllAreas: 'Lahat ng lugar',
    componentRoomSubAreaDone: 'Tapos',
    cancel: 'Kanselahin',
    submit: 'Isumite',
    savingDots: 'Sine-save...',
    loadingRooms: 'Niloload ang mga kwarto...',
    inProgress: 'Ginagawa',
    earlyCheckin: 'Maagang check-in',
    done: 'Tapos',
    allDone: 'Tapos na lahat!',
    noRoomsAssigned: 'Wala kang kwarto ngayong araw',
    checkBackSoon: 'Bumalik mamaya',
    reportIssue: 'Mag-report ng problema',
    describeIssue: 'Ilarawan ang problema',
    doNotDisturb: 'Huwag Istorbohin',
    markDnd: 'I-mark na Huwag Istorbohin',
    removeDnd: 'Alisin ang Huwag Istorbohin',
    lndLoadingTasks: 'Niloload ang mga gawain...',
    lndLaundryLoadsHeading: 'Mga Labada',
    lndLoadsUnit: 'load',
    lndProgressOf: 'sa',
    lndProgressDone: 'tapos na',
    lndNoTasksToday: 'Walang gawaing labada ngayong araw. Bumalik mamaya!',
  },

  // ─────────────────────────────────────────────────────────────────────
  // Vietnamese (Tiếng Việt)
  // ─────────────────────────────────────────────────────────────────────
  vi: {
    cxHelloPrefix: 'Xin chào',
    cxIncompleteLink: 'Liên kết không đầy đủ',
    cxIncompleteLinkHelp: 'Yêu cầu quản lý gửi liên kết đầy đủ. Thiếu thông số.',
    cxGreatWorkToday: 'Làm việc tốt hôm nay',
    hkStartShift: 'Bắt đầu ca',
    hkShiftStarted: 'Ca đã bắt đầu',
    hkNextShiftPrefix: 'Ca tiếp theo: ',
    hkLastShiftPrefix: 'Ca cuối: ',
    hkRoomShort: 'Phòng',
    hkTypeCheckout: 'TRẢ PHÒNG',
    hkTypeStayover: 'Ở LẠI',
    hkTypeVacant: 'TRỐNG',
    hkFloorPrefix: 'Tầng',
    hkGroupByFloor: 'Theo tầng',
    hkGroupByRoom: 'Theo số',
    hkActionStart: 'Bắt đầu',
    hkActionPause: 'Tạm dừng',
    hkActionResume: 'Tiếp tục',
    hkActionDone: 'Xong',
    hkPaused: 'Đang dừng',
    hkCompleteShort: 'Hoàn tất',
    hkResetShort: 'Đặt lại',
    hkCleaningLabel: 'Đang dọn',
    hkStartCleaning: 'Bắt đầu dọn',
    hkStopLabel: 'Dừng',
    hkStartAgain: 'Bắt đầu lại',
    hkChecklistDone: 'Đã xong danh sách',
    hkAllRoomsClean: 'Tất cả phòng đã sạch!',
    hkAllRoomsCleanSub: 'Làm tốt lắm hôm nay, {name}.',
    hkAllRoomsCleanCount: 'Bạn đã hoàn thành tất cả {count} phòng.',
    hkYourRooms: 'Phòng của bạn',
    hkTapToOpen: 'nhấn để mở',
    hkAlerts: 'Cảnh báo',
    hkTabRooms: 'Phòng',
    hkTabMessages: 'Tin nhắn',
    hkNewMessage: 'Tin nhắn mới',
    hkBack: 'Quay lại',
    hkSend: 'Gửi',
    hkMessagePlaceholder: 'Tin nhắn…',
    hkSearchPeople: 'Tìm người…',
    hkPeople: 'Mọi người',
    hkOnlyManagersPost: 'Chỉ quản lý mới có thể đăng ở đây',
    hkFromManagement: 'Từ ban quản lý',
    hkMembers: 'thành viên',
    hkDirectMessage: 'Tin nhắn trực tiếp',
    hkJustNow: 'Vừa xong',
    hkAnnouncementsFromMgmt: 'Thông báo từ ban quản lý',
    hkNoMessages: 'Chưa có tin nhắn',
    hkUndoShort: 'Hoàn tác',
    hkOpenChecklist: 'Mở danh sách',
    hkChecklistTitle: 'Danh sách làm sạch',
    hkChecklistChecked: 'đã đánh dấu',
    hkChecklistOptional: 'Danh sách là tùy chọn — bạn có thể hoàn thành mà không cần đánh dấu tất cả.',
    hkCriticalItem: 'Quan trọng',
    hkAreaBathroom: 'Phòng tắm',
    hkAreaBedroom: 'Phòng ngủ',
    hkAreaLiving: 'Phòng khách',
    hkAreaKitchen: 'Nhà bếp',
    hkAreaEntry: 'Lối vào',
    hkAreaAmenities: 'Tiện nghi',
    hkAreaFinal: 'Kiểm tra cuối',
    hkException: 'Ngoại lệ',
    hkExceptionDnd: 'Đừng Làm Phiền',
    hkExceptionNsr: 'Không Cần Dịch Vụ',
    hkExceptionDla: 'Khóa Đôi',
    hkExceptionSleepOut: 'Không Đến',
    hkExceptionSkipped: 'Bỏ Qua',
    hkExceptionLabel: 'Đánh dấu phòng này là',
    hkExceptionAddNoteOptional: 'Thêm ghi chú (tùy chọn)',
    hkExceptionConfirm: 'Xác nhận',
    hkExceptionClear: 'Xóa ngoại lệ',
    hkExceptionDndDescription: 'Khách yêu cầu không làm phiền',
    hkExceptionNsrDescription: 'Khách không muốn dọn dẹp hôm nay',
    hkExceptionDlaDescription: 'Cửa bị khóa đôi từ bên trong',
    hkExceptionSleepOutDescription: 'Khách đã trả tiền nhưng không đến',
    hkExceptionSkippedDescription: 'Không thể dọn — cần giám sát',
    hkIssueShort: 'Vấn đề',
    hkReportIssueAria: 'Báo cáo vấn đề',
    hkGuestNameLabel: 'Khách',
    hkETALabel: 'Sẽ đến',
    hkNightsLabel: 'Đêm',
    hkNightsUnit: 'đêm',
    hkManagerNotesLabel: 'Ghi chú quản lý',
    hkManagerNoteBadge: 'Ghi chú quản lý',
    hkRushBanner: 'KHẨN',
    hkRushDueIn: 'Hạn',
    hkLunchStart: 'Bắt đầu ăn trưa',
    hkLunchEnd: 'Kết thúc ăn trưa',
    hkLunchOnBreak: 'Đang ăn trưa',
    hkLunchMinutesSuffix: 'phút',
    hkSummaryTitle: 'Tóm tắt hôm nay',
    hkSummaryRoomsCleaned: 'Phòng đã dọn',
    hkSummaryActiveMinutes: 'Thời gian dọn dẹp',
    hkSummaryAveragePerRoom: 'Trung bình mỗi phòng',
    hkSummaryLunchMinutes: 'Thời gian ăn trưa',
    hkSummaryShiftHours: 'Giờ làm việc',
    hkSummaryStillToGo: 'Còn lại để dọn',
    hkSummaryShowDailySummary: 'Xem tóm tắt',
    hkOffline: 'Bạn đang ngoại tuyến. Thay đổi sẽ không lưu cho đến khi có kết nối.',
    hkOfflineQueueCount: 'Sẽ đồng bộ khi có kết nối',
    hkOfflineSyncing: 'Đang đồng bộ các thay đổi',
    hkOfflineSynced: 'Đã đồng bộ thay đổi',
    hkOfflineQueueFailed: 'Một số thay đổi không đồng bộ — chạm để thử lại',
    hkErrCouldntMarkClean: 'Không thể đánh dấu Sạch. Kiểm tra kết nối và thử lại.',
    hkErrCouldntToggleDnd: 'Không thể chuyển Đừng Làm Phiền.',
    hkErrCouldntSaveIssue: 'Không thể lưu vấn đề. Thử lại.',
    hkErrCouldntResetRoom: 'Không thể đặt lại phòng.',
    hkErrCouldntStart: 'Không thể bắt đầu phòng.',
    hkErrCouldntPause: 'Không thể tạm dừng.',
    hkErrCouldntResume: 'Không thể tiếp tục.',
    hkErrCouldntComplete: 'Không thể đánh dấu Xong.',
    hkErrCouldntSaveException: 'Không thể lưu ngoại lệ.',
    hkErrMarkInspection: 'Không thể đánh dấu để kiểm tra.',
    hkErrPhotoTooBig: 'Ảnh quá lớn — thử ảnh nhỏ hơn.',
    hkErrPhotoUpload: 'Không thể tải ảnh lên. Thử lại.',
    hkNotice: 'Thông báo',
    hkNoticePinned: 'Đã ghim',
    hkNoticeDismiss: 'Đóng',
    hkNoticeExpired: 'Hết hạn',
    hkNoticeReviewWarning: 'Đã quản lý xem — bản dịch có thể không chính xác',
    hkIssueAction: 'Cần làm gì?',
    hkIssueActionReplace: 'Thay thế',
    hkIssueActionRepair: 'Sửa chữa',
    hkIssueActionClean: 'Làm sạch',
    hkIssueActionReport: 'Báo cáo',
    hkIssueItem: 'Vật gì?',
    hkIssueItemPlaceholder: 'Bóng đèn, bồn rửa, TV…',
    hkIssueLocation: 'Ở đâu trong phòng?',
    hkIssueLocationPlaceholder: 'Gần bồn rửa, trên tường…',
    hkIssueSeverity: 'Khẩn cấp đến mức nào?',
    hkIssueSeverityMinor: 'Nhỏ',
    hkIssueSeverityMajor: 'Lớn',
    hkIssueSeverityUrgent: 'Khẩn',
    hkIssueNote: 'Còn gì khác không?',
    hkIssueNotePlaceholder: 'Chi tiết tùy chọn',
    hkIssuePhotoAdd: 'Thêm ảnh',
    hkIssuePhotoReplace: 'Thay ảnh',
    hkIssuePhotoRemove: 'Xóa ảnh',
    hkIssueSubmit: 'Gửi cho bảo trì',
    hkIssueRoutedToMaintenance: 'Đã gửi cho bảo trì',
    hkAddNote: 'Thêm ghi chú',
    hkAddNoteTitle: 'Ghi chú nhanh',
    hkAddNotePlaceholder: 'Ghi chú cho quản lý',
    hkAddNoteSubmit: 'Lưu ghi chú',
    hkAddNoteSaved: 'Đã lưu ghi chú',
    hkAddNoteClear: 'Xóa ghi chú',
    hkMarkForInspection: 'Đánh dấu để kiểm tra',
    hkMarkedForInspection: 'Đã đánh dấu để kiểm tra',
    langPickerTitle: 'Chọn ngôn ngữ của bạn',
    langPickerSearchPlaceholder: 'Tìm ngôn ngữ',
    langPickerNoResults: 'Không tìm thấy ngôn ngữ',
    langMachineTranslatedNotice: 'Một số văn bản có thể chưa được dịch hoàn toàn',
    componentRoomLabel: 'Suite',
    componentRoomChildPrefix: 'Bao gồm',
    componentRoomAllAreas: 'Tất cả khu vực',
    componentRoomSubAreaDone: 'Xong',
    cancel: 'Hủy',
    submit: 'Gửi',
    savingDots: 'Đang lưu...',
    loadingRooms: 'Đang tải phòng...',
    inProgress: 'Đang làm',
    earlyCheckin: 'Nhận phòng sớm',
    done: 'Xong',
    allDone: 'Đã xong hết!',
    noRoomsAssigned: 'Bạn không có phòng hôm nay',
    checkBackSoon: 'Quay lại sau',
    reportIssue: 'Báo cáo vấn đề',
    describeIssue: 'Mô tả vấn đề',
    doNotDisturb: 'Đừng Làm Phiền',
    markDnd: 'Đánh dấu Đừng Làm Phiền',
    removeDnd: 'Xóa Đừng Làm Phiền',
    lndLoadingTasks: 'Đang tải nhiệm vụ...',
    lndLaundryLoadsHeading: 'Tải giặt',
    lndLoadsUnit: 'tải',
    lndProgressOf: 'trên',
    lndProgressDone: 'xong',
    lndNoTasksToday: 'Không có nhiệm vụ giặt hôm nay. Quay lại sau!',
  },
};

/**
 * Look up a translation. Accepts either the narrow Language ('en' | 'es')
 * — what most of the codebase uses — or the wider HousekeeperLocale that
 * the housekeeper page now supports. Missing keys fall back to EN.
 */
export function t(key: TranslationKey, lang: HousekeeperLocale = 'en'): string {
  return translations[lang]?.[key] ?? translations.en[key] ?? key;
}

export default translations;
