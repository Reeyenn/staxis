module.exports=[93695,(a,b,c)=>{b.exports=a.x("next/dist/shared/lib/no-fallback-error.external.js",()=>require("next/dist/shared/lib/no-fallback-error.external.js"))},71306,(a,b,c)=>{b.exports=a.r(18622)},79847,a=>{a.n(a.i(3343))},9185,a=>{a.n(a.i(29432))},72842,a=>{a.n(a.i(75164))},54897,a=>{a.n(a.i(30106))},56157,a=>{a.n(a.i(18970))},94331,a=>{a.n(a.i(60644))},15988,a=>{a.n(a.i(56952))},25766,a=>{a.n(a.i(77341))},29725,a=>{a.n(a.i(94290))},5785,a=>{a.n(a.i(90588))},74793,a=>{a.n(a.i(33169))},85826,a=>{a.n(a.i(37111))},21565,a=>{a.n(a.i(41763))},65911,a=>{a.n(a.i(8950))},25128,a=>{a.n(a.i(91562))},40781,a=>{a.n(a.i(49670))},69411,a=>{a.n(a.i(75700))},63081,a=>{a.n(a.i(276))},62837,a=>{a.n(a.i(40795))},34607,a=>{a.n(a.i(11614))},96338,a=>{a.n(a.i(21751))},50642,a=>{a.n(a.i(12213))},32242,a=>{a.n(a.i(22693))},88530,a=>{a.n(a.i(10531))},8583,a=>{a.n(a.i(1082))},38534,a=>{a.n(a.i(98175))},70408,a=>{a.n(a.i(9095))},22922,a=>{a.n(a.i(96772))},78294,a=>{a.n(a.i(71717))},16625,a=>{a.n(a.i(85034))},88648,a=>{a.n(a.i(63444))},51914,a=>{a.n(a.i(66482))},25466,a=>{a.n(a.i(91505))},60168,a=>{"use strict";var b=a.i(7997);a.s(["default",0,function(){return(0,b.jsxs)("html",{lang:"en",children:[(0,b.jsxs)("head",{children:[(0,b.jsx)("meta",{charSet:"utf-8"}),(0,b.jsx)("meta",{name:"viewport",content:"width=device-width, initial-scale=1"}),(0,b.jsx)("title",{children:"Staxis — Hotel Operations Platform"}),(0,b.jsx)("meta",{name:"description",content:"Staxis is a workforce scheduling platform for limited-service hotels. It coordinates housekeeping staff via SMS-based daily availability checks."}),(0,b.jsx)("style",{children:`
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
        `})]}),(0,b.jsxs)("body",{children:[(0,b.jsxs)("nav",{className:"nav",children:[(0,b.jsxs)("div",{className:"brand",children:[(0,b.jsx)("div",{className:"brand-mark",children:"S"}),(0,b.jsx)("span",{className:"brand-name",children:"Staxis"})]}),(0,b.jsxs)("div",{className:"nav-links",children:[(0,b.jsx)("a",{href:"/consent",children:"SMS Consent"}),(0,b.jsx)("a",{href:"/privacy",children:"Privacy"}),(0,b.jsx)("a",{href:"/terms",children:"Terms"}),(0,b.jsx)("a",{href:"/signin",className:"signin-btn",children:"Sign In"})]})]}),(0,b.jsxs)("section",{className:"hero",children:[(0,b.jsx)("h1",{children:"Hotel operations, built for limited-service properties."}),(0,b.jsx)("p",{children:"Staxis is a workforce scheduling and operations platform for limited-service hotels. It coordinates housekeeping staff, tracks room turnover, and automates nightly shift confirmations via SMS."})]}),(0,b.jsxs)("section",{className:"section",children:[(0,b.jsx)("h2",{children:"What Staxis does"}),(0,b.jsxs)("div",{className:"grid",children:[(0,b.jsxs)("div",{className:"card",children:[(0,b.jsx)("h3",{children:"Housekeeping scheduling"}),(0,b.jsx)("p",{children:"Assigns room cleanings to staff based on availability, skills, and property layout."})]}),(0,b.jsxs)("div",{className:"card",children:[(0,b.jsx)("h3",{children:"Nightly SMS availability checks"}),(0,b.jsx)("p",{children:"Sends one text per day to hotel employees asking if they can work tomorrow."})]}),(0,b.jsxs)("div",{className:"card",children:[(0,b.jsx)("h3",{children:"Labor cost tracking"}),(0,b.jsx)("p",{children:"Calculates daily labor hours, overtime risk, and cost-per-occupied-room."})]})]})]}),(0,b.jsxs)("section",{className:"section",children:[(0,b.jsx)("h2",{children:"How our SMS messaging works"}),(0,b.jsxs)("div",{className:"card",children:[(0,b.jsx)("p",{children:"Staxis sends internal workforce SMS messages to hotel employees (housekeepers, maintenance, and front desk staff) on behalf of the hotel property that employs them. These are not marketing or promotional messages — they are operational scheduling notifications."}),(0,b.jsx)("p",{children:(0,b.jsx)("strong",{style:{color:"#fff"},children:"Message types:"})}),(0,b.jsxs)("p",{children:["1. A nightly availability check asking the employee if they can work the next day.",(0,b.jsx)("br",{}),"2. A shift confirmation with room assignments, sent only after the employee confirms availability."]}),(0,b.jsx)("div",{className:"sms-box",children:"Staxis: Can you work tomorrow (Fri Apr 10)? Reply YES or NO. Reply STOP to opt out."}),(0,b.jsxs)("p",{style:{marginTop:"16px"},children:[(0,b.jsx)("strong",{style:{color:"#fff"},children:"Frequency:"})," One message per day, per employee."]}),(0,b.jsxs)("p",{children:[(0,b.jsx)("strong",{style:{color:"#fff"},children:"Opt-out:"})," Employees can reply STOP to any message at any time to immediately stop receiving texts."]}),(0,b.jsxs)("p",{children:["Full consent details and the verbal opt-in script are published at"," ",(0,b.jsx)("a",{href:"/consent",children:"/consent"}),"."]})]})]}),(0,b.jsxs)("section",{className:"section",children:[(0,b.jsx)("h2",{children:"How employees opt in"}),(0,b.jsxs)("div",{className:"card",children:[(0,b.jsx)("p",{children:"Consent is collected verbally by the hotel manager at time of hire or at the time the employee is added to the Staxis platform. The manager reads a disclosure script that tells the employee exactly what messages they will receive, how often, from whom, and how to opt out."}),(0,b.jsxs)("p",{children:["The employee's phone number is only added to Staxis after they verbally agree. The full word-for-word verbal consent script is published at ",(0,b.jsx)("a",{href:"/consent",children:"/consent"}),"."]})]})]}),(0,b.jsxs)("section",{className:"section",children:[(0,b.jsx)("h2",{children:"About Staxis"}),(0,b.jsxs)("div",{className:"card",children:[(0,b.jsx)("p",{children:"Staxis is operated by Reeyen Patel, a sole proprietor based in Austin, Texas. The platform was built to solve a specific, concrete problem in the limited-service hotel industry: every night, a head housekeeper at a limited-service hotel has to text each housekeeper on the roster from her personal phone to ask whether they can work the next day, then manually assemble a schedule from the replies. Staxis replaces that manual process with a single SMS availability check sent from a verified business number, with replies captured automatically in the platform."}),(0,b.jsxs)("p",{children:[(0,b.jsx)("strong",{style:{color:"#fff"},children:"Pilot property:"})," Comfort Suites Beaumont (Beaumont, Texas) — a 78-room limited-service property. Staxis is live at the property as of April 2026, sending nightly availability checks to the housekeeping roster and coordinating morning room assignments."]}),(0,b.jsxs)("p",{children:[(0,b.jsx)("strong",{style:{color:"#fff"},children:"Who we serve:"})," Limited-service and select-service hotel owner-operators with 50–150 rooms who run lean housekeeping teams and need a simple, practical tool to coordinate daily labor."]})]})]}),(0,b.jsxs)("section",{className:"section",children:[(0,b.jsx)("h2",{children:"Contact"}),(0,b.jsxs)("div",{className:"card",children:[(0,b.jsxs)("p",{children:[(0,b.jsx)("strong",{style:{color:"#fff"},children:"Staxis"})," — operated by Reeyen Patel (sole proprietor)",(0,b.jsx)("br",{}),"2215 Rio Grande St, Austin, TX 78705, United States",(0,b.jsx)("br",{}),"Email: ",(0,b.jsx)("a",{href:"mailto:rp@reeyenpatel.com",children:"rp@reeyenpatel.com"})]}),(0,b.jsx)("p",{children:"For questions about the platform, SMS consent, privacy, billing, or partnership inquiries, email the address above. We respond to all inquiries within two business days."})]})]}),(0,b.jsxs)("footer",{children:[(0,b.jsxs)("div",{style:{marginBottom:"12px"},children:[(0,b.jsx)("a",{href:"/consent",children:"SMS Consent"}),"·",(0,b.jsx)("a",{href:"/privacy",children:"Privacy Policy"}),"·",(0,b.jsx)("a",{href:"/terms",children:"Terms of Service"}),"·",(0,b.jsx)("a",{href:"/signin",children:"Sign In"})]}),(0,b.jsx)("div",{style:{marginBottom:"8px"},children:"Staxis · Operated by Reeyen Patel · 2215 Rio Grande St, Austin, TX 78705"}),(0,b.jsxs)("div",{children:["© 2026 Staxis · ",(0,b.jsx)("a",{href:"mailto:rp@reeyenpatel.com",style:{margin:0},children:"rp@reeyenpatel.com"})]})]})]})]})},"dynamic",0,"force-static"])},28004,a=>{a.n(a.i(60168))}];

//# sourceMappingURL=%5Broot-of-the-server%5D__0zbye~u._.js.map