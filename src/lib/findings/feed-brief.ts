import {
  getMorningBrief,
  type BriefResult,
  type GetBriefOptions,
} from './brief-server';

export type FeedBriefLoader = (options: GetBriefOptions) => Promise<BriefResult>;

/**
 * Ordinary Feed reads are deterministic. Keep this seam explicit and
 * injectable so a regression test can prove that navigation never asks the
 * findings brief's optional paid wording pass to run.
 */
export function loadFeedMorningBrief(
  propertyId: string,
  load: FeedBriefLoader = getMorningBrief,
): Promise<BriefResult> {
  return load({ propertyId, phrasing: false });
}
