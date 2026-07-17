import type { CSSProperties } from 'react';

/**
 * Shared inline-style constants for the small per-room action buttons and
 * their centered dialogs (AddNoteButton / MarkForInspectionButton /
 * ReportFoundItemButton). These were byte-identical copies in each file;
 * pulling them here keeps the buttons visually in lockstep. Styles that
 * differ per file (e.g. the secondary/cancel button) stay local.
 */

export const smallBtnStyle: CSSProperties = {
  minHeight: 36,
  padding: '6px 10px',
  border: '1px solid #E5E7EB',
  borderRadius: 8,
  background: 'transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  WebkitTapHighlightColor: 'transparent',
};

export const smallBtnLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: '#4B5563',
  whiteSpace: 'nowrap',
};

export const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.55)',
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};

export const dialogStyle: CSSProperties = {
  width: '100%',
  maxWidth: 420,
  background: 'white',
  borderRadius: 20,
  padding: 22,
};

export const closeBtnStyle: CSSProperties = {
  minHeight: 36,
  minWidth: 36,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export const primaryBtnStyle: CSSProperties = {
  flex: 1,
  height: 48,
  border: 'none',
  borderRadius: 10,
  color: 'white',
  fontSize: 15,
  fontWeight: 700,
  cursor: 'pointer',
};

/**
 * Bottom-sheet scaffold shared by the three slide-up modals (ChecklistModal,
 * ExceptionDropdown, StructuredIssueReporter). The overlay's z-index varies
 * per modal, so callers that need a different layer spread this and override
 * `zIndex`. The 44×44 close button was an identical inline copy in each file.
 */
export const sheetOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.55)',
  zIndex: 250,
  display: 'flex',
  alignItems: 'flex-end',
};

export const sheetCloseBtnStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
