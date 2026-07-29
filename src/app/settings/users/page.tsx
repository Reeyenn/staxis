import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Old bookmarks land on the single customer people/access workspace. */
export default function LegacySettingsUsersPage(): never {
  redirect('/company?tab=access');
}
