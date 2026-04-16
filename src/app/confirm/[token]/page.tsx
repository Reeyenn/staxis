/**
 * Retired page. Link-based confirmation was replaced by the text-reply flow —
 * housekeepers now reply YES or NO by SMS instead of tapping a link.
 * Kept as a tiny stub so any stale link doesn't 404.
 * Safe to delete this file entirely.
 */
export default function Page() {
  return (
    <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', maxWidth: 480 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>This link is no longer active</h1>
      <p style={{ color: '#555' }}>
        We&apos;ve switched to text replies. Please reply <strong>YES</strong> or <strong>NO</strong> to
        the text you received from the hotel.
      </p>
    </div>
  );
}
