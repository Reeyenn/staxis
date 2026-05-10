import { notFound } from 'next/navigation';

// Public signup is disabled — account creation now flows through admin
// (Settings → Account & Team) and, in Phase 3, owner-issued email invites or
// hotel join codes (/invite/[token], /join). Returning notFound() so any
// stale links 404 cleanly.
export default function SignupPage() {
  notFound();
}
