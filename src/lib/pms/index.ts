/**
 * Public surface of the PMS abstraction.
 *
 * After Plan v8 Phase D.3 sweep: only types + registry remain. The
 * legacy adapter / recipe / recipe-loader files were unused (entire
 * code paths superseded by cua-service's mapping-driver + recipe-runner
 * + new generic-table-writer pipeline).
 */

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

export type { PMSDefinition } from './registry';
export { PMS_REGISTRY, PMS_DROPDOWN_OPTIONS, getPMSDefinition } from './registry';
