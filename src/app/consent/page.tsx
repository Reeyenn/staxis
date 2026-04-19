export const dynamic = 'force-static';

export default function ConsentPage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>SMS Consent - Staxis</title>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #f9fafb;
            color: #111827;
            line-height: 1.6;
          }
          .container {
            max-width: 680px;
            margin: 48px auto;
            padding: 0 24px 64px;
          }
          .logo {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 40px;
          }
          .logo-mark {
            width: 36px;
            height: 36px;
            background: #f59e0b;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 800;
            font-size: 18px;
            color: #000;
          }
          .logo-name {
            font-size: 20px;
            font-weight: 700;
            color: #111827;
            letter-spacing: -0.02em;
          }
          h1 {
            font-size: 28px;
            font-weight: 700;
            letter-spacing: -0.02em;
            color: #111827;
            margin-bottom: 8px;
          }
          .subtitle {
            font-size: 15px;
            color: #6b7280;
            margin-bottom: 40px;
          }
          .section {
            background: #fff;
            border: 1px solid #e5e7eb;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 16px;
          }
          .section-title {
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.07em;
            text-transform: uppercase;
            color: #9ca3af;
            margin-bottom: 12px;
          }
          .section-body {
            font-size: 15px;
            color: #374151;
          }
          .section-body p + p {
            margin-top: 10px;
          }
          .badge {
            display: inline-block;
            background: #fef3c7;
            color: #92400e;
            font-size: 12px;
            font-weight: 600;
            padding: 3px 10px;
            border-radius: 20px;
            margin-bottom: 14px;
          }
          .example-box {
            background: #f3f4f6;
            border-left: 3px solid #f59e0b;
            border-radius: 0 8px 8px 0;
            padding: 14px 16px;
            margin-top: 14px;
            font-size: 14px;
            color: #374151;
          }
          .example-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.06em;
            color: #9ca3af;
            margin-bottom: 6px;
          }
          .field-row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            padding: 10px 0;
            border-bottom: 1px solid #f3f4f6;
            font-size: 14px;
          }
          .field-row:last-child { border-bottom: none; }
          .field-label { color: #6b7280; font-weight: 500; }
          .field-value { color: #111827; font-weight: 500; text-align: right; max-width: 60%; }
          footer {
            margin-top: 40px;
            font-size: 13px;
            color: #9ca3af;
            text-align: center;
          }
        `}</style>
      </head>
      <body>
        <div className="container">

          <div className="logo">
            <div className="logo-mark">S</div>
            <span className="logo-name">Staxis</span>
          </div>

          <h1>SMS Opt-In Consent</h1>
          <p className="subtitle">How Staxis obtains consent from hotel staff before sending scheduling text messages.</p>

          {/* What is Staxis */}
          <div className="section">
            <p className="section-title">About This Platform</p>
            <div className="section-body">
              <p>Staxis is a hotel operations platform used by limited-service hotel owners and managers to coordinate housekeeping staff scheduling. The platform sends daily availability check messages to hotel employees to confirm whether they can work the following day.</p>
              <p>This is an internal workforce scheduling tool. All message recipients are paid employees of the hotel property using Staxis.</p>
            </div>
          </div>

          {/* How consent is collected */}
          <div className="section">
            <p className="section-title">How Consent Is Collected</p>
            <span className="badge">Opt-In Type: Verbal (In-Person)</span>
            <div className="section-body">
              <p>Before any phone number is added to Staxis, the Staxis founder goes to the hotel property in person, stands with the head housekeeper, and asks each housekeeper one at a time — face to face — whether she is okay with receiving the nightly scheduling text from Staxis. The phone number is only entered into the system after the housekeeper says yes. If she says no, her number is never added and she continues to be scheduled the way she was before.</p>
            </div>
          </div>

          {/* Verbal consent script - verbatim */}
          <div className="section">
            <p className="section-title">Verbal Consent Script (Word-for-Word)</p>
            <div className="section-body">
              <p>This is what is said, in person, to each housekeeper before her number is added:</p>
              <div className="example-box">
                <p className="example-label">Verbatim — Spoken to Each Housekeeper</p>
                <p>
                  "Hey, I'm Reeyen — I built a scheduling tool called Staxis that the hotel is
                  going to start using. Right now Maria texts you every night from her own phone
                  to tell you if you're working tomorrow. With Staxis, you'll get that same text,
                  but it'll come from the Staxis number — 855-514-1450 — instead of from Maria.
                </p>
                <p>
                  It asks one thing: can you work tomorrow, yes or no. You text back YES or NO. If
                  you say yes, in the morning you get one more text with the rooms you're cleaning
                  that day. That's it — two texts max per day, nothing else. No ads, no spam.
                </p>
                <p>
                  If you ever want it to stop, text back STOP and it stops. Is it okay with you if
                  I add your number so you start getting these instead of Maria texting you?"
                </p>
                <p style={{ marginTop: '10px', color: '#6b7280', fontStyle: 'italic' }}>
                  [Wait for the housekeeper to say yes, then add her number to Staxis. If she
                  says no, do not add her number.]
                </p>
              </div>
              <p style={{ marginTop: '14px' }}>
                <strong>What actually happened at Comfort Suites Beaumont, TX:</strong> In April
                2026, the Staxis founder visited the property, walked through the hotel with head
                housekeeper Maria, and asked every housekeeper on the roster this question in
                person. Every housekeeper said yes. Their phone numbers were then added to Staxis
                one by one, with Maria present to confirm. This is the first and only property
                currently using Staxis.
              </p>
            </div>
          </div>

          {/* Message details */}
          <div className="section">
            <p className="section-title">Message Details</p>
            <div className="field-row">
              <span className="field-label">Sender</span>
              <span className="field-value">Staxis (+1 855-514-1450)</span>
            </div>
            <div className="field-row">
              <span className="field-label">Recipients</span>
              <span className="field-value">Hotel employees only (no consumers)</span>
            </div>
            <div className="field-row">
              <span className="field-label">Frequency</span>
              <span className="field-value">Once per day, nightly</span>
            </div>
            <div className="field-row">
              <span className="field-label">Purpose</span>
              <span className="field-value">Internal workforce scheduling</span>
            </div>
            <div className="field-row">
              <span className="field-label">Opt-out method</span>
              <span className="field-value">Reply STOP to any message</span>
            </div>

            <div className="example-box">
              <p className="example-label">Example Message</p>
              <p>Staxis: Can you work tomorrow (Fri Apr 4)? Reply YES or NO. Reply STOP to opt out.</p>
            </div>
          </div>

          {/* No marketing */}
          <div className="section">
            <p className="section-title">What These Messages Are Not</p>
            <div className="section-body">
              <p>These messages are not marketing, promotional, or consumer-facing communications. They are strictly internal employee scheduling notifications sent to hotel staff who have been informed of and agreed to receive them as part of their employment.</p>
            </div>
          </div>

          <footer>
            <div style={{ marginBottom: '6px' }}>
              Staxis — operated by Reeyen Patel (sole proprietor)
            </div>
            <div style={{ marginBottom: '6px' }}>
              2215 Rio Grande St, Austin, TX 78705, United States
            </div>
            <div>
              For questions contact <a href="mailto:rp@reeyenpatel.com" style={{ color: '#6b7280' }}>rp@reeyenpatel.com</a>
            </div>
          </footer>

        </div>
      </body>
    </html>
  );
}
