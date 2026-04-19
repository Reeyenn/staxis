export const dynamic = 'force-static';

export default function TermsPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Terms of Service — Staxis</title>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #f9fafb;
            color: #111827;
            line-height: 1.6;
          }
          .container { max-width: 720px; margin: 48px auto; padding: 0 24px 64px; }
          .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 32px; }
          .logo-mark {
            width: 32px; height: 32px; background: #f59e0b; border-radius: 8px;
            display: flex; align-items: center; justify-content: center;
            font-weight: 800; font-size: 16px; color: #000;
          }
          .logo-name { font-size: 18px; font-weight: 700; color: #111827; letter-spacing: -0.02em; }
          h1 { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 6px; }
          .meta { font-size: 13px; color: #6b7280; margin-bottom: 32px; }
          h2 { font-size: 18px; font-weight: 700; margin-top: 28px; margin-bottom: 10px; color: #111827; }
          p { font-size: 15px; color: #374151; margin-bottom: 12px; }
          a { color: #d97706; }
          footer { margin-top: 48px; font-size: 13px; color: #9ca3af; text-align: center; }
        `}</style>
      </head>
      <body>
        <div className="container">
          <div className="logo">
            <div className="logo-mark">S</div>
            <span className="logo-name">Staxis</span>
          </div>

          <h1>Terms of Service</h1>
          <p className="meta">Last updated: April 11, 2026</p>

          <p>
            These Terms of Service ("Terms") govern your access to and use of the Staxis hotel
            operations platform (the "Service"). By creating an account or using the Service,
            you agree to these Terms.
          </p>

          <h2>1. The Service</h2>
          <p>
            Staxis provides workforce scheduling and operations tools for limited-service hotels,
            including housekeeping assignment management, labor cost tracking, and SMS-based
            nightly availability checks for hotel employees.
          </p>

          <h2>2. Eligibility</h2>
          <p>
            The Service is intended for use by hotel owners, managers, and their employees. You
            must be authorized to act on behalf of your hotel property to create an account.
          </p>

          <h2>3. Acceptable use</h2>
          <p>
            You agree not to: (a) use the Service for any unlawful purpose, (b) send SMS messages
            to individuals who have not provided verbal consent as described at{' '}
            <a href="/consent">/consent</a>, (c) use the Service to send marketing, promotional,
            or consumer-facing messages, (d) reverse engineer or interfere with the Service, or
            (e) use the Service in any way that violates Twilio's messaging policies or
            applicable telecommunications laws including the TCPA.
          </p>

          <h2>4. SMS consent obligations</h2>
          <p>
            Hotel managers using the Service are responsible for obtaining verbal consent from
            each employee before adding their phone number to Staxis, using the script published
            at <a href="/consent">/consent</a>. Hotel managers must immediately remove any
            employee who requests to be removed, and Staxis will automatically honor STOP replies.
          </p>

          <h2>5. Account security</h2>
          <p>
            You are responsible for maintaining the confidentiality of your account credentials
            and for all activities that occur under your account.
          </p>

          <h2>6. Disclaimer of warranties</h2>
          <p>
            The Service is provided "as is" without warranties of any kind, either express or
            implied, including but not limited to warranties of merchantability, fitness for a
            particular purpose, or non-infringement.
          </p>

          <h2>7. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, Staxis shall not be liable for any indirect,
            incidental, special, consequential, or punitive damages arising out of or related to
            your use of the Service.
          </p>

          <h2>8. Termination</h2>
          <p>
            We may suspend or terminate your access to the Service at any time for violation of
            these Terms. You may stop using the Service at any time.
          </p>

          <h2>9. Changes to these Terms</h2>
          <p>
            We may update these Terms from time to time. The "Last updated" date at the top of
            this page will reflect the most recent changes.
          </p>

          <h2>10. Contact</h2>
          <p>
            Questions about these Terms can be sent to{' '}
            <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>.
          </p>

          <footer>
            <div style={{ marginBottom: '6px' }}>
              Staxis — operated by Reeyen Patel (sole proprietor) · 2215 Rio Grande St, Austin, TX 78705
            </div>
            <div>
              <a href="/">Home</a> · <a href="/consent">SMS Consent</a> · <a href="/privacy">Privacy</a> · <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
