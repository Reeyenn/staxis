/**
 * One-shot script — make sure the `voice-recordings` storage bucket exists
 * in Supabase and is private. Safe to re-run; if the bucket is already
 * there, this is a no-op.
 *
 * Uses the service-role key, which bypasses RLS on storage.
 */

import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.');
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const bucketName = 'voice-recordings';

  const { data: existing } = await supabase.storage.getBucket(bucketName);
  if (existing) {
    console.log(`✓ Bucket "${bucketName}" already exists (public=${existing.public})`);
    if (existing.public) {
      console.error('  ⚠ bucket is PUBLIC — privacy violation. Update via Supabase Studio.');
      process.exit(1);
    }
    return;
  }

  const { error } = await supabase.storage.createBucket(bucketName, {
    public: false,
    // OpenAI Whisper max upload is 25MB; we cap at 5MB which is well above
    // a 60s mono 16kHz WAV (~1.9MB) but stops bad-actor uploads.
    fileSizeLimit: 5 * 1024 * 1024,
    allowedMimeTypes: [
      'audio/webm',
      'audio/wav',
      'audio/x-wav',
      'audio/ogg',
      'audio/mpeg',
      'audio/mp4',
    ],
  });

  if (error) {
    console.error('✗ createBucket failed:', error.message);
    process.exit(1);
  }
  console.log(`✓ Created private bucket "${bucketName}"`);
}

void main();
