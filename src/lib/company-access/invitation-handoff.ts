const RAW_COMPANY_INVITATION_TOKEN = /^[0-9a-f]{64}$/i;
const COMPANY_INVITATION_PATH = /^\/company-invite\/([0-9a-f]{64})$/i;

export const COMPANY_INVITATION_HANDOFF_PARAM = 'companyInvite';
export const COMPANY_INVITATION_HANDOFF_VALUE = '1';
export const COMPANY_INVITATION_RESUME_PATH = '/company-invite/resume';
export const COMPANY_INVITATION_SIGN_IN_HREF = '/signin?redirect=%2Fcompany-invite%2Fresume';

const COMPANY_INVITATION_STORAGE_KEY = 'staxis.company-invitation';

export interface InvitationHandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserSessionStorage(): InvitationHandoffStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function companyInvitationTokenFromPath(path: string): string | null {
  return COMPANY_INVITATION_PATH.exec(path)?.[1]?.toLowerCase() ?? null;
}

export function storeCompanyInvitationHandoff(
  rawToken: string,
  storage: InvitationHandoffStorage | null = browserSessionStorage(),
): boolean {
  const token = rawToken.trim().toLowerCase();
  if (!RAW_COMPANY_INVITATION_TOKEN.test(token) || !storage) return false;
  try {
    storage.setItem(COMPANY_INVITATION_STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function readCompanyInvitationHandoff(
  storage: InvitationHandoffStorage | null = browserSessionStorage(),
): string | null {
  if (!storage) return null;
  try {
    const token = storage.getItem(COMPANY_INVITATION_STORAGE_KEY);
    if (!token || !RAW_COMPANY_INVITATION_TOKEN.test(token)) {
      storage.removeItem(COMPANY_INVITATION_STORAGE_KEY);
      return null;
    }
    return `/company-invite/${token.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function clearCompanyInvitationHandoff(
  storage: InvitationHandoffStorage | null = browserSessionStorage(),
): void {
  try {
    storage?.removeItem(COMPANY_INVITATION_STORAGE_KEY);
  } catch {
    // Storage may be blocked by browser policy; clearing is best-effort.
  }
}
