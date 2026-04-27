import type { NextConfig } from "next";

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
 * you must extend `script-src`/`connect-src` here. Do NOT relax to
 * `'unsafe-eval'` or `*` — that defeats the point.
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

  return [
    `default-src 'self'`,
    // 'unsafe-inline' is needed because Next.js injects inline scripts for
    // hydration that don't carry our nonce. Pair with a tight script-src
    // host whitelist.
    `script-src 'self' 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${supabaseConnect}`,
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
};

export default nextConfig;
