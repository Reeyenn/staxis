import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Canonical admin entry used by bookmarks and post-auth return targets. */
export default function AdminPage() {
  redirect('/admin/properties');
}
