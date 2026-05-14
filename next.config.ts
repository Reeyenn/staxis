import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Security headers applied to every route.
 *
 * The CSP below is intentionally tight. It only allows:
 *   - scripts/styles/fonts/connections to our own origin
 *   - 'unsafe-inline' for styles, because Next inlines critical CSS and
 *     several pages style elements via the `style` prop (no class-based
 *     alternative without a much bigger refactor)
 *   - inline scripts via Next's auto-injected nonce (handled by Next)
 *   - WebSocket + REST traffic to Supabase (URL pulled from the env var
 *     so preview deploys still match staging or prod)
 *   - data: img URIs for inline placeholders
 *   - https: img sources for the dashboard hero images and any user
 *     uploads. If you want to lock that down further, replace `https:`
 *     with the exact CDN host(s).
 *
 * If you add a new third-party script (Stripe, Sentry, Mixpanel, etc.)
 * you must extend `script-src`/`connect-src` here. Do NOT relax production
 * to `'unsafe-eval'` or `*` — that defeats the point. (`'unsafe-eval'` is
 * appended below for `next dev` only, because React's dev-mode debugger
 * uses eval() to reconstruct call stacks from worker contexts. Production
 * builds never include it.)
 */
function buildCsp(): string {
  // Pull the Supabase URL out of env so previews / staging projects don't
  // need a separate config. Falls back to a safe placeholder when env is
  // missing during type-check / lint.
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://*.supabase.co';
  // Realtime uses wss://; REST uses https://. Strip the scheme and add
  // both forms.
  const supabaseHost = supabaseUrl.replace(/^https?:\/\//, '');
  const supabaseConnect = `https://${supabaseHost} wss://${supabaseHost}`;

  // Google Fonts allowance:
  //   - fonts.googleapis.com serves the CSS (the @font-face stylesheets) →
  //     must be in style-src
  //   - fonts.gstatic.com serves the actual woff2 binaries that those
  //     stylesheets reference → must be in font-src
  // Without both, the Material Symbols + Inter requests get blocked by
  // CSP (browser shows them as 503/blocked in DevTools) and every icon
  // span renders as the literal ligature name ("groups", "calendar_month",
  // "check_circle", etc.) — this was the bug Reeyen screenshotted on
  // 2026-04-27. Both hosts are Google's own CDN, no extra trust risk.
  const googleFontsCss  = 'https://fonts.googleapis.com';
  const googleFontsFile = 'https://fonts.gstatic.com';

  // 'unsafe-eval' is required by React's dev-mode debugger (and Turbopack
  // HMR) to reconstruct call stacks from worker / RSC contexts. Without it
  // the browser surfaces a red "eval() is not supported" overlay on every
  // page load. Scoped to dev only — production builds never include it.
  const isDev = process.env.NODE_ENV !== 'production';
  const scriptSrc = isDev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval'`
    : `script-src 'self' 'unsafe-inline'`;

  return [
    `default-src 'self'`,
    // 'unsafe-inline' is needed because Next.js injects inline scripts for
    // hydration that don't carry our nonce. Pair with a tight script-src
    // host whitelist.
    scriptSrc,
    `style-src 'self' 'unsafe-inline' ${googleFontsCss}`,
    `img-src 'self' data: https:`,
    `font-src 'self' data: ${googleFontsFile}`,
    `connect-src 'self' ${supabaseConnect}`,
    // `frame-src` defaults to `default-src 'self'` when unset, which would
    // block Stripe Elements, Calendly, etc. if/when we embed them. Set it
    // explicitly so the limit is visible and adding a third party is a
    // one-line CSP change instead of a debugging session.
    `frame-src 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    // Upgrade legacy http requests if any third-party tries them.
    `upgrade-insecure-requests`,
  ].join('; ');
}

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: buildCsp(),
  },
  // Don't include the path or query string in cross-origin Referer headers.
  // The /housekeeper/[id] and /laundry/[id] capability URLs include the
  // property id and staff id as query params; without this header, the
  // browser sends the full URL to any external resource (Google Fonts, an
  // <img> from a CDN, an analytics beacon). strict-origin-when-cross-origin
  // strips the path off cross-origin requests but keeps it for same-origin.
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  // We never need to be embedded in a frame. Hard-block to defeat
  // clickjacking entirely (CSP frame-ancestors does the same — this is
  // the legacy header for older browsers / antivirus plugins).
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  // MIME-sniff defense. If any /api/* route ever serves text/html with a
  // non-html content-type, this stops the browser from "helpfully"
  // executing it.
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  // Force HTTPS for two years on this domain plus subdomains, and ask
  // browsers to preload. preload=true means once we're on Chrome's HSTS
  // preload list, browsers refuse plain http to the domain forever.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // Disable browser features we don't use, so a future XSS can't request
  // microphone / camera / geolocation prompts in the user's name.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
];

const nextConfig: NextConfig = {
  experimental: {},
  async headers() {
    return [
      {
        // Apply to every route.
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
  /**
   * Permanent 301 redirect: any request that lands on the legacy Vercel
   * alias (hotelops-ai.vercel.app) is bounced to the canonical brand
   * domain (getstaxis.com) with the same path + query. Reeyen retired
   * the Vercel alias as a user-facing URL; this keeps old bookmarks,
   * shared signup links, and any cached search results working without
   * needing the alias to actually be deleted in Vercel.
   */
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'hotelops-ai.vercel.app' }],
        destination: 'https://getstaxis.com/:path*',
        permanent: true,
      },
    ];
  },
};

// Wrap the export with Sentry's plugin. When SENTRY_AUTH_TOKEN is set on
// Vercel (Production scope), the plugin uploads source maps as part of the
// Next build so stack traces in Sentry resolve to real file/line numbers
// instead of minified `chunks/3-xy7.js:1:2391`.
//
// Without the auth token the plugin is a no-op — the wrapper itself adds
// zero overhead, so this is safe to ship before the token is provisioned.
// See docs/sentry-sourcemaps-activation.md for the 2-minute token-paste
// procedure Reeyen needs to run once.
export default withSentryConfig(nextConfig, {
  // Sentry org + project slugs (from staxis.sentry.io). Both names are
  // public information visible in the dashboard URL; safe to commit.
  org: "staxis",
  project: "javascript-nextjs",

  // Suppress the plugin's setup log lines on every build. They're noise
  // once you're past the initial configuration.
  silent: !process.env.CI,

  // Upload source maps in production builds only — local `next dev` doesn't
  // need them, and uploading on every `next build` during local dev would
  // waste Sentry quota.
  sourcemaps: {
    disable: false,
    // Delete uploaded source maps from the build artifact so they don't
    // ship to the browser. Sentry has them; users shouldn't.
    deleteSourcemapsAfterUpload: true,
  },

  // Tree-shake Sentry SDK debug-logger statements out of the bundle —
  // BUT ONLY WHEN the build runs under webpack. The replacement for the
  // deprecated `disableLogger: true` lives at this nested webpack path
  // (verified in node_modules/@sentry/nextjs/build/types/config/types.d.ts
  // and again by reading the plugin source).
  //
  // ⚠️ Honest note: Next.js 16 defaults to Turbopack for `next build`,
  // and `package.json`'s script is plain `next build` (no `--webpack`).
  // Vercel honors the default. The @sentry/nextjs plugin only wires
  // `webpack.treeshake.removeDebugLogging` through its webpack pipeline,
  // so under our actual production build (Turbopack), this option
  // silently no-ops. The SDK's internal debug logger statements remain
  // in the bundle (small bundle-size cost, no functional impact).
  //
  // Why keep it then: zero cost to leave in. The day we either (a) add
  // `--webpack` to the build command, (b) Sentry ships a Turbopack
  // equivalent, or (c) Next changes its default back to webpack, this
  // option starts doing real work without any code change required.
  // Removing it now would require a follow-up edit later — net negative.
  webpack: { treeshake: { removeDebugLogging: true } },
});
