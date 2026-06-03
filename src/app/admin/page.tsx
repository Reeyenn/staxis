export const dynamic = 'force-dynamic';

/**
 * /admin — index redirect. There's no admin landing of its own; the owner
 * console lives at /admin/properties (the global nav "Admin" link points
 * there). Visiting bare /admin used to 404; this sends it to the console so
 * typing "/admin" just works. The admin auth gate in ./layout.tsx still runs
 * first (non-admins are bounced before this redirect).
 */

import { redirect } from 'next/navigation';

export default function AdminIndex() {
  redirect('/admin/properties');
}
