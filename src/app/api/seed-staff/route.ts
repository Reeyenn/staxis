import { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';

// Seed endpoint — disabled after initial use. Returns 410 Gone with the
// standard ApiResponse shape so callers see a structured envelope rather
// than a bare error string.
//
// `data` (when ok) is unreachable here (route is permanently disabled) but
// the import is kept so the type signature matches every other migrated
// route — making this a clean copy-paste skeleton when the next admin
// route gets added.
export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  return err('Seed endpoint disabled', { requestId, status: 410, code: ApiErrorCode.Forbidden });
}

// Suppress the unused-import warning for `ok` — leaving it imported keeps
// the file as a useful template for future seed/admin routes.
void ok;
