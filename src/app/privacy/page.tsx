export const dynamic = 'force-static';

export default function PrivacyPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Privacy Policy — Staxis</title>
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
          ul { margin: 0 0 12px 20px; }
          li { font-size: 15px; color: #374151; margin-bottom: 6px; }
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

          <h1>Privacy Policy</h1>
          <p className="meta">Last updated: April 11, 2026</p>

          <p>
            This Privacy Policy describes how Staxis ("we", "us", "our") collects, uses, and
            protects information in connection with the Staxis hotel operations platform (the
            "Service").
          </p>

          <h2>1. Who we serve</h2>
          <p>
            Staxis is a B2B workforce scheduling and operations platform used by limited-service
            hotel owners and managers. Our users fall into two groups: (a) hotel managers and
            owners who log in to the platform, and (b) hotel employees (housekeeping, maintenance,
            and front desk staff) whose phone numbers are added to the platform by their employer
            so they can receive scheduling SMS messages.
          </p>

          <h2>2. Information we collect</h2>
          <ul>
            <li><strong>Account information:</strong> Name, email, and password of hotel managers who sign in.</li>
            <li><strong>Employee contact information:</strong> Name, role, and mobile phone number of hotel employees, entered by the hotel manager after obtaining verbal consent.</li>
            <li><strong>Operational data:</strong> Room status, housekeeping assignments, shift schedules, and labor hours.</li>
            <li><strong>SMS message logs:</strong> Timestamps, delivery status, and employee replies (YES, NO, STOP, HELP) for messages sent through Twilio.</li>
          </ul>

          <h2>3. How we use information</h2>
          <p>
            We use the information we collect to provide the Service: to assign rooms, send daily
            availability SMS messages to employees, record their replies, calculate labor costs,
            and generate reports for the hotel manager. We do not use employee phone numbers or
            data for marketing, advertising, or any purpose unrelated to workforce scheduling.
          </p>

          <h2>4. SMS messaging and consent</h2>
          <p>
            Staxis sends internal workforce SMS messages to hotel employees via Twilio. Messaging
            frequency is limited to at most two messages per employee per day (a nightly
            availability check and a shift confirmation). Consent is collected verbally by the
            hotel manager using the disclosure script published at{' '}
            <a href="/consent">/consent</a>. Employees may opt out at any time by replying STOP to
            any Staxis message.
          </p>
          <p>
            <strong>We do not share mobile phone numbers or opt-in data with third parties or
            affiliates for marketing or promotional purposes.</strong> Phone numbers are only
            shared with Twilio, our SMS delivery provider, solely for the purpose of delivering
            scheduling messages.
          </p>

          <h2>5. How we share information</h2>
          <p>
            We share information only with service providers necessary to run the Service:
          </p>
          <ul>
            <li><strong>Twilio</strong> — SMS delivery (phone numbers and message content)</li>
            <li><strong>Google Firebase / Firestore</strong> — data storage and authentication</li>
            <li><strong>Vercel</strong> — application hosting</li>
          </ul>
          <p>
            We do not sell personal information. We do not share information with advertisers or
            marketing partners.
          </p>

          <h2>6. Data retention</h2>
          <p>
            We retain account and operational data for as long as the hotel property maintains an
            active Staxis subscription. Employee phone numbers are deleted upon request from the
            hotel manager or when the employee replies STOP to opt out.
          </p>

          <h2>7. Your rights</h2>
          <p>
            Hotel employees may request access to, correction of, or deletion of their personal
            information at any time by contacting their hotel manager or by emailing{' '}
            <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>. Replying STOP to any
            Staxis SMS will immediately stop all further messages.
          </p>

          <h2>8. Security</h2>
          <p>
            We use industry-standard security measures including encrypted data transmission
            (HTTPS/TLS), encrypted data storage, and access controls. No method of transmission
            or storage is 100% secure, but we take commercially reasonable steps to protect your
            information.
          </p>

          <h2>9. Changes to this policy</h2>
          <p>
            We may update this Privacy Policy from time to time. The "Last updated" date at the
            top of this page will reflect the most recent changes.
          </p>

          <h2>10. Contact</h2>
          <p>
            Questions about this policy or your data can be sent to{' '}
            <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>.
          </p>

          <footer>
            <div style={{ marginBottom: '6px' }}>
              Staxis — operated by Reeyen Patel (sole proprietor) · 2215 Rio Grande St, Austin, TX 78705
            </div>
            <div>
              <a href="/">Home</a> · <a href="/consent">SMS Consent</a> · <a href="/terms">Terms</a> · <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
