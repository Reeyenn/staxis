import { redirect } from 'next/navigation';

// Constant redirect target — no per-request data, so it can be static.
export const dynamic = 'force-static';

// The Inventory AI "report card" used to live here as its own page. It's now a
// large overlay on the inventory tab itself (opened via the "AI Helper" rail
// button, or ?action=ai). This redirect keeps any old bookmarks / links working
// by sending them straight to the overlay.
export default function InventoryAiPage() {
  redirect('/inventory?action=ai');
}
