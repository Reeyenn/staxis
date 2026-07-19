export const BEFORE_PROPERTY_CHANGE_EVENT = 'hotelops:before-property-change';

export interface PropertyChangeDetail {
  fromPropertyId: string;
  toPropertyId: string;
  source: 'selector' | 'cross-tab';
}

/** Returns false when an open workflow has cancelled the hotel change. */
export function propertyChangeAllowed(detail: PropertyChangeDetail): boolean {
  if (typeof window === 'undefined' || detail.fromPropertyId === detail.toPropertyId) return true;
  return window.dispatchEvent(new CustomEvent<PropertyChangeDetail>(BEFORE_PROPERTY_CHANGE_EVENT, {
    cancelable: true,
    detail,
  }));
}
