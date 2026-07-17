/**
 * Public surface of the sick-callout coverage flow. Importers should
 * pull from '@/lib/sick-callout' (this file) rather than reaching into
 * individual modules — keeps refactors local.
 */

export type {
  CalloutEvent,
  CalloutReporter,
  CalloutReason,
  CalloutLeaveTiming,
  CalloutStatus,
  CalloutBannerEntry,
  ImpactedAssignment,
  RevertOutcomeEntry,
} from './types';

export {
  createCallout,
  revertCallout,
  runRedistributionForCallout,
  listActiveCalloutsForBanner,
  hasActiveCalloutToday,
} from './service';

export type {
  CreateCalloutInput,
  CreateCalloutResult,
  RevertCalloutInput,
  RevertCalloutResult,
} from './service';

export {
  planRevert,
  computeRedistributeAt,
} from './redistribute-policy';

export type {
  CurrentTaskState,
  RevertDecision,
} from './redistribute-policy';

export {
  classifyCalloutSms,
  normaliseCalloutText,
} from './sms-parser';

export type { CalloutSmsClass } from './sms-parser';

export {
  sendCalloutNotifications,
  sendRevertNotifications,
  buildPickupSms,
  buildRevertSms,
} from './notify';
