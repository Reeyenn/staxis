/**
 * Public surface of the PMS abstraction.
 *
 * The active app surface uses the shared PMS types for report-era data and
 * manual hotel state. Robot-only onboarding and mapping registries are retired
 * with their admin surfaces.
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
