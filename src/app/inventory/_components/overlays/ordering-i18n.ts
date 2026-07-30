// Bilingual (EN + ES) strings for the Ordering Manager overlay. Co-located
// with the overlay (same pattern as ai-i18n.ts / scan-i18n.ts) rather than
// added to the global translations.ts so parallel features don't collide.
//
// HOUSE COPY RULES, enforced by ordering-manager.test.ts:
//   • NO EM DASHES. Founder ruling, 2026-07-28. Use a full stop, a comma or a
//     new line. This is checked by a test over every string in this file so it
//     cannot creep back in one careless edit.
//   • Short plain sentences. No filler ("simply", "just", "seamlessly"), no
//     marketing voice. A manager reads this on a phone between rooms.
//
// THE WELCOME COPY IS THE PRODUCT, NOT CHROME. It is the only place the hotel
// is told what this thing will and will not do with their money, and it shows
// exactly once. Every claim in it is one the code actually keeps:
//
//   "never spends on its own"          there is no payment method anywhere.
//   "never stores card details"        there is no card field anywhere.
//   "never touches your email account" sends go from Staxis's own domain with
//                                      reply-to set to the manager. No mailbox
//                                      credential is ever asked for.
//   "for websites, YOU place it"       the website button says "Prep my order"
//                                      and links out. There is no checkout
//                                      path, deliberately.
//
// If any of those stops being true, this copy is the first thing to change.

import type { Lang } from '../inv-i18n';

export function orderingStrings(lang: Lang) {
  return {
    en: {
      // ── Header ──
      eyebrow: 'Ordering',
      title: 'Worth ordering now',
      close: 'Close',

      // ── The one-time welcome ──
      welcomeTitle: 'Your ordering manager',
      welcomeLine1: 'It watches your stock and preps your orders. You stay in charge of every one.',
      welcomeLine2: 'It never spends money on its own. It never stores card details. It never touches your email account.',
      welcomeLine3: 'What it can do depends on how you order:',
      welcomeEmail: 'Email suppliers. Staxis sends the order from our address on your behalf, with your reply address on it. You get a copy, and 60 seconds to stop it.',
      welcomeWebsite: 'Website suppliers. We prep the exact list and give you the link. You place the order. We cannot and will not check out for you.',
      welcomeStore: 'Store runs. We give you the shopping list. You buy it and tell us it is done.',
      welcomePhone: 'Phone suppliers. We give you the list and their number to tap.',
      welcomeGo: 'Got it',

      // ── Empty state ──
      emptyTitle: 'Nothing to order from yet',
      emptyBody: 'This runs off your inventory and your suppliers. Add a few items with par levels, tell us who supplies them, and this screen fills itself in.',
      emptyNoItems: 'You have no inventory items yet. Add some on the inventory page first.',
      quickStartChat: 'Tell the AI in one sentence',
      quickStartChatHint: 'Open the chat and say something like “food from Sysco by email, linens from Guest Supply’s site, rest is Sam’s”.',
      quickStartVendor: 'Add a supplier',

      // ── All clear ──
      allClearTitle: 'Nothing needs ordering',
      allClearBody: 'Everything with a par level is above it right now.',

      // ── Suggestions ──
      suggestionsTitle: 'Suppliers we think you use',
      suggestionsHint: 'These are guesses from your contacts and your scanned invoices. Nothing is saved until you confirm.',
      suggestionBadge: 'Suggestion',
      fromContacts: 'from your contacts',
      fromInvoices: (n: number) => (n === 1 ? 'on 1 scanned invoice' : `on ${n} scanned invoices`),
      confirm: 'Confirm',
      dismiss: 'Not a supplier',

      // ── Vendors + setup ──
      vendorsTitle: 'Your suppliers',
      howDoYouOrder: 'How do you order from them?',
      methodEmail: 'Email',
      methodWebsite: 'Website',
      methodStore: 'Store run',
      methodPhone: 'Phone',
      coversCategories: 'Covers',
      noCategories: 'No categories yet',
      addVendor: 'Add a supplier',
      websiteUrlLabel: 'Their ordering page',
      save: 'Save',
      cancel: 'Cancel',

      // ── Order cards ──
      sendOrder: 'Send this order',
      prepOrder: 'Prep my order',
      prepHint: 'We prep the list and give you the link. You place the order.',
      openSite: 'Open their site',
      shoppingList: 'Shopping list',
      callThem: 'Call them',
      markPlaced: 'I placed it',
      markBought: 'I bought it',
      copyList: 'Copy list',
      sending: 'Sending',
      sent: 'Sent',
      // A send that fails must say so. The order is not lost when this shows:
      // the countdown has ended but nothing was recorded as placed, so the
      // group is still on the screen with its Send button back.
      sendFailed: 'Could not send. The order is still here, try again.',
      actionFailed: 'That did not save. Try again.',
      undo: 'Undo',
      undoCountdown: (s: number) => `Sending in ${s}s. Tap to stop.`,
      undoHonesty: 'Nothing is sent until the countdown ends. If you close this screen first, nothing goes out and the order stays here.',
      marked: 'Marked as ordered',

      // ── Blocked chips ──
      blockedMethod: 'Tell us how you order from them',
      blockedEmail: 'No email address on file',
      blockedUrl: 'No web address on file',
      blockedPhone: 'No phone number on file',
      blockedUnconfirmed: 'Confirm this supplier first',

      // ── Unmatched ──
      unmatchedTitle: 'Nobody assigned',
      whoSupplies: 'Who supplies this?',
      actuallyFrom: 'Actually from…',
      justThisItem: 'Only this item',
      wholeCategory: (name: string) => `Everything in ${name}`,

      // ── Item rows ──
      onHandOfPar: (onHand: string, par: string) => `${onHand} left of ${par}`,
      burnRate: (n: string) => `you go through about ${n} a week`,
      burnUnknown: 'not enough count history to say how fast this moves',
      daysLeft: (n: string) => `about ${n} days left`,
      order: 'Order',
      lastPaid: (money: string) => `${money} on your last invoice`,
      noPrice: 'no price on file',
      linesWithoutPrice: (n: number) => (n === 1
        ? '1 item has no price on file. The total leaves it out.'
        : `${n} items have no price on file. The total leaves them out.`),
      subtotal: 'Subtotal',
      critical: 'Critical',
      low: 'Low',

      // ── Honesty footer ──
      basisMl: 'Rates come from what the AI has learned about how fast items move.',
      basisRule: 'Rates come from your configured usage and recent occupancy.',
      basisThin: 'Not enough history yet to work out how fast things move. This list uses par levels alone.',
      pricesNote: 'Every price here is what you actually paid on your last invoice. Items you have never scanned an invoice for show no price rather than a guess.',
    },

  }['en'];
}

export type OrderingStrings = ReturnType<typeof orderingStrings>;
