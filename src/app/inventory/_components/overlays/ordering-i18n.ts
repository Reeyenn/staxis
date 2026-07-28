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
    es: {
      // ── Header ──
      eyebrow: 'Pedidos',
      title: 'Vale la pena pedir ahora',
      close: 'Cerrar',

      // ── The one-time welcome ──
      welcomeTitle: 'Tu encargado de pedidos',
      welcomeLine1: 'Vigila tu inventario y prepara tus pedidos. Tú decides cada uno.',
      welcomeLine2: 'Nunca gasta dinero por su cuenta. Nunca guarda datos de tarjetas. Nunca entra en tu correo.',
      welcomeLine3: 'Lo que puede hacer depende de cómo pidas:',
      welcomeEmail: 'Proveedores por correo. Staxis envía el pedido desde nuestra dirección de tu parte, con tu dirección para responder. Recibes una copia y 60 segundos para detenerlo.',
      welcomeWebsite: 'Proveedores con sitio web. Preparamos la lista exacta y te damos el enlace. Tú haces el pedido. No podemos ni vamos a pagar por ti.',
      welcomeStore: 'Ir a la tienda. Te damos la lista de compra. Tú la compras y nos avisas.',
      welcomePhone: 'Proveedores por teléfono. Te damos la lista y su número para llamar.',
      welcomeGo: 'Entendido',

      // ── Empty state ──
      emptyTitle: 'Todavía no hay a quién pedir',
      emptyBody: 'Esto funciona con tu inventario y tus proveedores. Agrega artículos con nivel par, dinos quién los surte, y esta pantalla se llena sola.',
      emptyNoItems: 'Aún no tienes artículos de inventario. Agrega algunos en la página de inventario primero.',
      quickStartChat: 'Dile a la IA en una frase',
      quickStartChatHint: 'Abre el chat y di algo como «la comida de Sysco por correo, la lencería del sitio de Guest Supply, lo demás de Sam’s».',
      quickStartVendor: 'Agregar proveedor',

      // ── All clear ──
      allClearTitle: 'No hace falta pedir nada',
      allClearBody: 'Todo lo que tiene nivel par está por encima ahora mismo.',

      // ── Suggestions ──
      suggestionsTitle: 'Proveedores que creemos que usas',
      suggestionsHint: 'Son suposiciones de tus contactos y tus facturas escaneadas. No se guarda nada hasta que confirmes.',
      suggestionBadge: 'Sugerencia',
      fromContacts: 'de tus contactos',
      fromInvoices: (n: number) => (n === 1 ? 'en 1 factura escaneada' : `en ${n} facturas escaneadas`),
      confirm: 'Confirmar',
      dismiss: 'No es proveedor',

      // ── Vendors + setup ──
      vendorsTitle: 'Tus proveedores',
      howDoYouOrder: '¿Cómo les pides?',
      methodEmail: 'Correo',
      methodWebsite: 'Sitio web',
      methodStore: 'Ir a la tienda',
      methodPhone: 'Teléfono',
      coversCategories: 'Cubre',
      noCategories: 'Sin categorías todavía',
      addVendor: 'Agregar proveedor',
      websiteUrlLabel: 'Su página de pedidos',
      save: 'Guardar',
      cancel: 'Cancelar',

      // ── Order cards ──
      sendOrder: 'Enviar este pedido',
      prepOrder: 'Prepara mi pedido',
      prepHint: 'Preparamos la lista y te damos el enlace. Tú haces el pedido.',
      openSite: 'Abrir su sitio',
      shoppingList: 'Lista de compra',
      callThem: 'Llamar',
      markPlaced: 'Ya lo pedí',
      markBought: 'Ya lo compré',
      copyList: 'Copiar lista',
      sending: 'Enviando',
      sent: 'Enviado',
      undo: 'Deshacer',
      undoCountdown: (s: number) => `Se envía en ${s}s. Toca para detener.`,
      undoHonesty: 'No se envía nada hasta que termine la cuenta atrás. Si cierras esta pantalla antes, no sale nada y el pedido se queda aquí.',
      marked: 'Marcado como pedido',

      // ── Blocked chips ──
      blockedMethod: 'Dinos cómo les pides',
      blockedEmail: 'Sin correo registrado',
      blockedUrl: 'Sin dirección web registrada',
      blockedPhone: 'Sin teléfono registrado',
      blockedUnconfirmed: 'Confirma este proveedor primero',

      // ── Unmatched ──
      unmatchedTitle: 'Sin proveedor asignado',
      whoSupplies: '¿Quién surte esto?',
      actuallyFrom: 'En realidad es de…',
      justThisItem: 'Solo este artículo',
      wholeCategory: (name: string) => `Todo en ${name}`,

      // ── Item rows ──
      onHandOfPar: (onHand: string, par: string) => `quedan ${onHand} de ${par}`,
      burnRate: (n: string) => `gastas unos ${n} por semana`,
      burnUnknown: 'no hay suficientes conteos para saber qué tan rápido se gasta',
      daysLeft: (n: string) => `quedan unos ${n} días`,
      order: 'Pedir',
      lastPaid: (money: string) => `${money} en tu última factura`,
      noPrice: 'sin precio registrado',
      linesWithoutPrice: (n: number) => (n === 1
        ? '1 artículo no tiene precio registrado. El total no lo incluye.'
        : `${n} artículos no tienen precio registrado. El total no los incluye.`),
      subtotal: 'Subtotal',
      critical: 'Crítico',
      low: 'Bajo',

      // ── Honesty footer ──
      basisMl: 'Las tasas vienen de lo que la IA ha aprendido sobre qué tan rápido se gastan los artículos.',
      basisRule: 'Las tasas vienen de tu uso configurado y la ocupación reciente.',
      basisThin: 'Todavía no hay suficiente historial para saber qué tan rápido se gastan las cosas. Esta lista usa solo los niveles par.',
      pricesNote: 'Cada precio aquí es lo que pagaste de verdad en tu última factura. Los artículos de los que nunca escaneaste una factura no muestran precio en vez de mostrar una suposición.',
    },
  }[lang];
}

export type OrderingStrings = ReturnType<typeof orderingStrings>;
