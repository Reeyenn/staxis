# Wake-word setup ("Hey Staxis" / "Oye Staxis")

One-time manual step to enable the wake-word feature. Until both keyword
files exist on disk, the wake-word toggle is hidden from the Settings
page and the `<WakeWord />` component refuses to initialize. The rest of
the voice surface (mic button, TTS playback) works regardless.

## What you need

- A Picovoice console account (free indie tier covers up to 10k users):
  <https://console.picovoice.ai>
- Access to deploy this repo (you'll redeploy after dropping the files).

## Steps

1. Sign in to <https://console.picovoice.ai> and grab the **AccessKey**.
   Add it to your environment:
   ```
   PICOVOICE_ACCESS_KEY=<the-key>
   ```
   For local dev that's `.env.local`. For prod that's the Vercel project's
   Environment Variables tab.

2. In the Picovoice console, train two custom wake words:
   - "Hey Staxis"
   - "Oye Staxis"

   For each: pick **Web (WASM)** as the platform, download the `.ppn`
   file. Don't pick "Browser"-tagged variants for other frameworks; the
   Web (WASM) build is what `@picovoice/porcupine-web` expects.

3. Drop the two files into the repo at:
   ```
   public/wake-words/hey-staxis.ppn
   public/wake-words/oye-staxis.ppn
   ```
   Filenames must match exactly — the gate check in
   `/api/agent/wake-word-available` looks for those literal names.

4. Commit the files and push. Vercel rebuilds; the Settings toggle
   appears on the next deploy.

## Verifying it's wired up

- Visit `/api/agent/wake-word-available` (signed in) — should return
  `{"ok": true, "data": { "available": true }}`.
- Open **Settings → Voice**. The "Hey Staxis wake word" toggle should
  render. (If only "Voice replies" appears, one of the .ppn files or
  the env var is missing.)
- Toggle it on in the chat panel. Grant mic permission when prompted.
- Say "Hey Staxis" — the floating chat panel should open and start
  recording.

## Why both English and Spanish

Comfort Suites Beaumont (the first paying customer) has a Spanish-first
housekeeping crew; "Oye Staxis" reads as natural Spanish for the same
action. The two keywords share one Porcupine worker so there's no extra
CPU cost.

## Built-in `stop` keyword

The wake-word component also registers Porcupine's built-in "stop"
keyword to support voice-interrupting Staxis mid-reply. No `.ppn` file
is needed for the built-in; it's bundled with the worker.
