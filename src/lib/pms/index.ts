/**
 * Public surface of the PMS abstraction.
 *
 * Client components should import only from here. Server modules can
 * import directly from ./recipe-loader (which uses service-role) or
 * from this index.
 */

// Types — safe to import everywhere
export type {
  AdapterError,
  AdapterErrorCode,
  AdapterResult,
  DashboardCounts,
  HistoricalOccupancyDay,
  PMSArrival,
  PMSCredentials,
  PMSDeparture,
  PMSRoomDescriptor,
  PMSRoomStatus,
  PMSStaffMember,
  PMSType,
  RoomCondition,
} from './types';
export { PMS_TYPES, isPMSType, adapterError } from './types';

export type {
  ActionRecipe,
  ActionSteps,
  ArrivalsParseHint,
  CsvHint,
  DashboardParseHint,
  DeparturesParseHint,
  HistoryParseHint,
  LoginSteps,
  Recipe,
  RecipeStep,
  RoomLayoutParseHint,
  RoomStatusParseHint,
  StaffParseHint,
  TableRowHint,
} from './recipe';
export { isRecipeShape } from './recipe';

export type { PMSAdapter, AdapterContext } from './adapter';

export type { PMSDefinition } from './registry';
export { PMS_REGISTRY, PMS_DROPDOWN_OPTIONS, getPMSDefinition } from './registry';
