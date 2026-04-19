export const dynamic = 'force-static';

export default function LandingPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Staxis — Hotel Operations Platform</title>
        <meta
          name="description"
          content="Staxis is a workforce scheduling platform for limited-service hotels. It coordinates housekeeping staff via SMS-based daily availability checks."
        />
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0b0b0c;
            color: #e5e7eb;
            line-height: 1.6;
          }
          a { color: #f59e0b; text-decoration: none; }
          a:hover { text-decoration: underline; }
          .nav {
            max-width: 1080px;
            margin: 0 auto;
            padding: 24px 32px;
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .brand {
            display: flex;
            align-items: center;
            gap: 10px;
          }
          .brand-mark {
            width: 32px;
            height: 32px;
            background: #f59e0b;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 16px;
            color: #000;
          }
          .brand-name {
            font-size: 18px;
            font-weight: 700;
            color: #fff;
            letter-spacing: -0.02em;
          }
          .nav-links {
            display: flex;
            align-items: center;
            gap: 24px;
            font-size: 14px;
          }
          .nav-links a { color: #9ca3af; }
          .nav-links a:hover { color: #f59e0b; text-decoration: none; }
          .signin-btn {
            background: #f59e0b;
            color: #000 !important;
            padding: 8px 18px;
            border-radius: 8px;
            font-weight: 600;
          }
          .signin-btn:hover { background: #fbbf24; text-decoration: none; }
          .hero {
            max-width: 860px;
            margin: 80px auto 40px;
            padding: 0 32px;
            text-align: center;
          }
          .hero h1 {
            font-size: 48px;
            font-weight: 800;
            letter-spacing: -0.03em;
            color: #fff;
            margin-bottom: 20px;
            line-height: 1.15;
          }
          .hero p {
            font-size: 18px;
            color: #9ca3af;
            max-width: 640px;
            margin: 0 auto;
          }
          .section {
            max-width: 860px;
            margin: 0 auto;
            padding: 48px 32px;
          }
          .section h2 {
            font-size: 24px;
            font-weight: 700;
            color: #fff;
            margin-bottom: 20px;
            letter-spacing: -0.02em;
          }
          .card {
            background: #151517;
            border: 1px solid #27272a;
            border-radius: 12px;
            padding: 28px;
            margin-bottom: 16px;
          }
          .card p { color: #d1d5db; margin-bottom: 12px; }
          .card p:last-child { margin-bottom: 0; }
          .grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
          }
          @media (max-width: 720px) {
            .grid { grid-template-columns: 1fr; }
            .hero h1 { font-size: 36px; }
          }
          .grid .card h3 {
            font-size: 15px;
            font-weight: 600;
            color: #fff;
            margin-bottom: 8px;
          }
          .grid .card p { font-size: 14px; color: #9ca3af; }
          .sms-box {
            background: #0f0f10;
            border-left: 3px solid #f59e0b;
            padding: 16px 20px;
            border-radius: 0 8px 8px 0;
            font-size: 14px;
            color: #d1d5db;
            margin-top: 12px;
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          }
          footer {
            max-width: 860px;
            margin: 60px auto 40px;
            padding: 32px;
            border-top: 1px solid #27272a;
            text-align: center;
            color: #6b7280;
            font-size: 13px;
          }
          footer a { color: #9ca3af; margin: 0 12px; }
        `}</style>
      </head>
      <body>
        <nav className="nav">
          <div className="brand">
            <div className="brand-mark">S</div>
            <span className="brand-name">Staxis</span>
          </div>
          <div className="nav-links">
            <a href="/consent">SMS Consent</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/signin" className="signin-btn">Sign In</a>
          </div>
        </nav>

        <section className="hero">
          <h1>Hotel operations, built for limited-service properties.</h1>
          <p>
            Staxis is a workforce scheduling and operations platform for limited-service hotels.
            It coordinates housekeeping staff, tracks room turnover, and automates nightly shift
            confirmations via SMS.
          </p>
        </section>

        <section className="section">
          <h2>What Staxis does</h2>
          <div className="grid">
            <div className="card">
              <h3>Housekeeping scheduling</h3>
              <p>Assigns room cleanings to staff based on availability, skills, and property layout.</p>
            </div>
            <div className="card">
              <h3>Nightly SMS availability checks</h3>
              <p>Sends one text per day to hotel employees asking if they can work tomorrow.</p>
            </div>
            <div className="card">
              <h3>Labor cost tracking</h3>
              <p>Calculates daily labor hours, overtime risk, and cost-per-occupied-room.</p>
            </div>
          </div>
        </section>

        <section className="section">
          <h2>How our SMS messaging works</h2>
          <div className="card">
            <p>
              Staxis sends internal workforce SMS messages to hotel employees (housekeepers,
              maintenance, and front desk staff) on behalf of the hotel property that employs them.
              These are not marketing or promotional messages — they are operational scheduling
              notifications.
            </p>
            <p><strong style={{ color: '#fff' }}>Message types:</strong></p>
            <p>
              1. A nightly availability check asking the employee if they can work the next day.<br />
              2. A shift confirmation with room assignments, sent only after the employee confirms availability.
            </p>
            <div className="sms-box">
              Staxis: Can you work tomorrow (Fri Apr 10)? Reply YES or NO. Reply STOP to opt out.
            </div>
            <p style={{ marginTop: '16px' }}>
              <strong style={{ color: '#fff' }}>Frequency:</strong> One message per day, per employee.
            </p>
            <p>
              <strong style={{ color: '#fff' }}>Opt-out:</strong> Employees can reply STOP to any
              message at any time to immediately stop receiving texts.
            </p>
            <p>
              Full consent details and the verbal opt-in script are published at{' '}
              <a href="/consent">/consent</a>.
            </p>
          </div>
        </section>

        <section className="section">
          <h2>How employees opt in</h2>
          <div className="card">
            <p>
              Consent is collected verbally by the hotel manager at time of hire or at the time
              the employee is added to the Staxis platform. The manager reads a disclosure script
              that tells the employee exactly what messages they will receive, how often, from
              whom, and how to opt out.
            </p>
            <p>
              The employee's phone number is only added to Staxis after they verbally agree. The
              full word-for-word verbal consent script is published at <a href="/consent">/consent</a>.
            </p>
          </div>
        </section>

        <section className="section">
          <h2>About Staxis</h2>
          <div className="card">
            <p>
              Staxis is operated by Reeyen Patel, a sole proprietor based in Austin, Texas. The
              platform was built to solve a specific, concrete problem in the limited-service
              hotel industry: every night, a head housekeeper at a limited-service hotel has to
              text each housekeeper on the roster from her personal phone to ask whether they
              can work the next day, then manually assemble a schedule from the replies. Staxis
              replaces that manual process with a single SMS availability check sent from a
              verified business number, with replies captured automatically in the platform.
            </p>
            <p>
              <strong style={{ color: '#fff' }}>Pilot property:</strong> Comfort Suites Beaumont
              (Beaumont, Texas) — a 78-room limited-service property. Staxis is live at the
              property as of April 2026, sending nightly availability checks to the housekeeping
              roster and coordinating morning room assignments.
            </p>
            <p>
              <strong style={{ color: '#fff' }}>Who we serve:</strong> Limited-service and
              select-service hotel owner-operators with 50–150 rooms who run lean housekeeping
              teams and need a simple, practical tool to coordinate daily labor.
            </p>
          </div>
        </section>

        <section className="section">
          <h2>Contact</h2>
          <div className="card">
            <p>
              <strong style={{ color: '#fff' }}>Staxis</strong> — operated by Reeyen Patel (sole proprietor)<br />
              2215 Rio Grande St, Austin, TX 78705, United States<br />
              Email: <a href="mailto:rp@reeyenpatel.com">rp@reeyenpatel.com</a>
            </p>
            <p>
              For questions about the platform, SMS consent, privacy, billing, or partnership
              inquiries, email the address above. We respond to all inquiries within two business
              days.
            </p>
          </div>
        </section>

        <footer>
          <div style={{ marginBottom: '12px' }}>
            <a href="/consent">SMS Consent</a>·
            <a href="/privacy">Privacy Policy</a>·
            <a href="/terms">Terms of Service</a>·
            <a href="/signin">Sign In</a>
          </div>
          <div style={{ marginBottom: '8px' }}>
            Staxis · Operated by Reeyen Patel · 2215 Rio Grande St, Austin, TX 78705
          </div>
          <div>© 2026 Staxis · <a href="mailto:rp@reeyenpatel.com" style={{ margin: 0 }}>rp@reeyenpatel.com</a></div>
        </footer>
      </body>
    </html>
  );
}
