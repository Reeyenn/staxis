# No-API PMS Access for Staxis

**Research date:** July 1, 2026  
**Scope:** Limited/select-service hotels, especially Home2 Suites by Hilton and avid hotels by IHG  
**Constraint:** APIs are not a viable launch dependency; Staxis is currently read-only

## Executive conclusion

The manager correctly identified an authentication and execution-location problem, but one technical premise is wrong: Staxis does **not** need PMS source code or a hidden URL to read a native Windows or remote-desktop PMS. Windows exposes many desktop controls through UI Automation, and pixel-only environments can be operated through screen capture, OCR, mouse, and keyboard. Microsoft documents both methods for desktop and VDI automation.

The harder boundary is authorization: getting an approved credential and an approved machine/session from which the PMS can be reached. Computer vision does not bypass Hilton, IHG, or Marriott device trust, VPN, SSO, or franchise technology rules.

Staxis should therefore ship two no-API connection modes:

1. **Report Inbox — default.** Configure the PMS's built-in report scheduler to email operational Excel/CSV/PDF reports to a unique Staxis address. Parse and normalize them into the existing `pms_*` schema. This requires no API, no software on the branded workstation, and no remote-control tool.
2. **Property Edge — exception.** Run an authorized computer-use worker inside a property-approved Windows/VDI environment when scheduled exports cannot meet the required data or freshness. The edge runtime uses UI Automation first and vision/OCR second, then sends only normalized fields to Staxis.

This is better matched to Staxis than copying Lance wholesale. Lance publicly claims write actions such as modifying reservations, whereas Staxis currently only reads data. For a read-only product, scheduled exports remove most of the access problem with far less security and reliability risk.

The fastest test is not “Can we break into PEP?” It is:

> Can a Home2 GM schedule Room Detail/Room Status, Arrivals, and Departures reports to a Staxis inbox at an acceptable cadence?

Hilton PEP definitely supports scheduled report queues and external email delivery; the remaining unknown is whether the needed operational reports can run frequently enough at a specific property.

## What the transcript establishes

The manager described four distinct constraints that should not be blended together:

- **Computer login:** Some branded machines require a Hilton/IHG/Marriott-linked Windows identity before the desktop is usable.
- **Application login:** The PMS itself requires a second account, and sometimes SSO/MFA.
- **Network/device trust:** Some systems work only from the property network, a corporate VPN, a managed endpoint, or an approved remote desktop.
- **UI type:** Some PMS applications are native/legacy or rendered through a remote session, not normal public websites.

The manager also described successful remote use through Splashtop or Microsoft Remote Desktop at properties where the brand or owner permits it. That proves the PMS can be driven remotely once an authorized session exists. It does not prove that any vendor is permitted to install remote-control software on a Hilton/Marriott endpoint.

The product requirement visible in the Staxis codebase is narrower than full PMS control:

- live room/housekeeping status;
- arrivals;
- departures;
- work orders;
- occupancy/dashboard counts;
- optional room inventory, revenue, rates, and historical reports.

Staxis already has the correct cloud-side pattern for web PMS systems: a persistent per-hotel browser, one learned recipe per PMS family, deterministic replay, schema validation, last-good preservation, and human-assisted MFA. What is missing is a second execution environment for property-bound systems and a file/report ingestion path.

## What Lance has publicly proven—and what it has not

### Publicly supported facts

Lance says its agents:

- see and operate hotel software using computer-use agents;
- work without APIs or custom integrations;
- navigate PMS, CRS, task, and back-office systems visually;
- support legacy and on-premise PMS/CRS workflows;
- can be set up in under an hour;
- are used by hotel groups representing more than 50 Marriott, Hilton, and Hyatt properties.

These claims appear on [Lance's product site](https://www.lance.live/) and its [Y Combinator company profile](https://www.ycombinator.com/companies/lance). The YC profile is particularly explicit that Lance uses “vision based computer-use agents” for older on-prem PMS or CRS workflows.

Lance also has a separate operations surface. Its iOS app advertises live room boards, inspections, departures/DND rounds, work orders, preventive maintenance, messaging, and shared front-desk tablet use. That means the PMS is not necessarily the UI hotel staff use all day; Lance can mirror or coordinate PMS-derived state inside its own app. See the [Lance Ops App Store listing](https://apps.apple.com/us/app/lance-ops/id6781946784).

Its hiring pattern is also revealing. Lance is hiring solutions engineers to work directly with client hotels on implementations, according to its [Solutions Engineer listing](https://www.linkedin.com/jobs/view/solutions-engineer-at-lance-yc-w26-4416965376). That is evidence of a high-touch deployment motion, not yet a universal self-serve connector.

### Most likely deployment model

Public evidence does not disclose the exact topology. The most credible reconstruction is:

| Environment | Likely Lance execution path | Confidence |
|---|---|---:|
| Public/cloud PMS | Dedicated cloud browser with persistent hotel session | High |
| Browser PMS restricted by SSO/MFA | Hotel-authorized account, persistent session, human MFA assistance | High |
| Legacy PMS reachable over approved RDP/Citrix/VDI | Vision agent operates the remote session as pixels | High |
| Native app on an accessible Windows host | Local/remote desktop automation using UI controls plus vision | Medium |
| Brand computer with no permitted install or remote session | Written exception, approved endpoint, or a non-PMS fallback such as reports | Medium |
| Covert security bypass | No public evidence, and not a viable commercial strategy | High |

The likely “secret” is not source-code access. It is customer-supplied authenticated execution:

1. The hotel or management company provides an authorized user/session.
2. Lance observes the screen instead of integrating with an API.
3. A vision agent drives mouse/keyboard workflows.
4. Lance mirrors outcomes into its own operations app.
5. Solutions engineers handle property-specific setup and exceptions.

That changes integration from a 12–18 month vendor partnership into a same-day property implementation. It does **not** remove the need for permission to access the system.

### Important caveats

- Brand logos on a vendor site do not establish Hilton/Marriott corporate approval. They can mean independently owned franchise properties use the product.
- “Supporting 50+ hotels” may represent one or a small number of management groups and is not proof of 50 unique PMS/security configurations.
- Lance does not publicly document its local agent, browser extension, RDP vendor, or edge appliance.
- Its public privacy policy names Twilio, LiveKit, and OpenAI, but does not explain the computer-use deployment or PMS credential model.
- No public evidence shows Lance bypassing a managed-device or corporate-network control. A legitimate vendor would obtain an approved session or avoid the controlled endpoint.

## The manager's “source code” concern

Source code is unnecessary for UI automation.

[Microsoft UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview) gives authorized programs access to most desktop UI elements as a tree and permits automated test tools to inspect and manipulate controls. This works across Win32, Windows Forms, WPF, and other common Windows control frameworks.

When an application is visible only as pixels through VDI, RDP, or Citrix, automation can fall back to:

- screenshots;
- OCR;
- image/semantic target recognition;
- mouse and keyboard input;
- state verification after each action.

Microsoft explicitly recommends [mouse, keyboard, image, and OCR automation for VDI](https://learn.microsoft.com/en-us/power-automate/desktop-flows/how-to/automate-using-mouse-keyboard-ocr). UiPath and Power Automate also support native remote runtimes when the remote environment permits an approved agent installation.

The hierarchy for Staxis should be:

1. Structured exported file;
2. Browser DOM/network response, where authorized;
3. Windows UI Automation/accessibility tree;
4. OCR and vision over a remote screen;
5. Human-assisted capture as a temporary fallback.

Vision should be the last structured option, not the first.

## A proven no-API path: scheduled report delivery

The transcript's M3 question has a mundane answer: hospitality systems commonly move data through generated export files, not source code. M3 says its warehouse accepts “any exportable data or system with an API,” and PMS vendors commonly produce M3-specific XML or export files. See [M3's partner page](https://www.m3as.com/partners/) and this [Stayntouch M3 setup guide](https://stayntouch.freshdesk.com/support/solutions/articles/24000034805-m3-accounting-setup-guide-for-stayntouch-pms).

Inn-Flow publicly documents the same mechanism across branded PMS systems:

- [Hilton PEP](https://support.inn-flow.net/support/solutions/articles/1000317138-pep-how-to-setup-import-via-email-) creates a Dynamic Customer Report Queue and emails Excel reports to a property-specific import address.
- [OPERA](https://support.inn-flow.net/support/solutions/articles/1000322242-opera-how-to-setup-import-via-email) uses Report Scheduler to email XML/PDF reports.
- [Marriott FOSSE](https://support.inn-flow.net/support/solutions/articles/1000297642-fosse-how-to-setup-import-via-email-) configures an email pack inside the report spooler.
- [Agilysys Stay](https://support.inn-flow.net/support/solutions/articles/1000334927-agilysys-stay-how-to-set-up-auto-import) schedules dynamic CSV reports to an import inbox.

This matters because it proves three things:

1. Branded hotels already authorize external systems to receive PMS-derived files.
2. The data can leave a locked property system without installing remote-control software.
3. A vendor can onboard by guiding the GM through a report scheduler rather than negotiating an API.

For PEP specifically, Inn-Flow documents queues that select named reports, choose Excel output, and deliver to an external email. Public hotel-employee discussions also describe PEP downtime reports being emailed several times per day. That does not prove every operational report can run every 15 minutes, but it makes a live-enough Report Inbox a high-value property test.

## Recommended connector ladder

Staxis should classify every property by the lowest-risk connector that meets the product's freshness requirement.

### Tier 1 — Report Inbox

**Use when:** The PMS can schedule or quickly email the needed operational report.

**Flow:**

1. Staxis creates an address such as `h2-abc123@pms.getstaxis.com`.
2. The GM opens the PMS report scheduler.
3. The GM selects room status/room detail, arrivals, departures, and optionally occupancy.
4. The PMS emails Excel/CSV/PDF files on a schedule.
5. A dedicated inbound-email worker authenticates the sender/domain where possible, malware-scans the attachment, stores the immutable original briefly, and invokes a versioned parser.
6. Staxis validates room counts, required columns, dates, and state values before promoting the new snapshot.
7. The UI displays source and freshness: “PEP report · updated 8 minutes ago.”

**Advantages:**

- no API;
- no software on the brand computer;
- no shared PMS password;
- no persistent remote access;
- easy audit trail and replay;
- much lower PCI scope if reports exclude payment fields;
- straightforward to support across PEP, OPERA, FOSSE, and Agilysys.

**Limitations:**

- freshness depends on scheduler cadence;
- the report may be a snapshot rather than an event stream;
- changing a room in Staxis will not update the PMS;
- report formats can change;
- some reports may contain unnecessary guest or payment data and must be excluded/redacted.

### Tier 2 — Existing cloud CUA

**Use when:** The PMS is web-accessible from a Staxis-controlled browser after an authorized hotel login.

This is the current Choice Advantage architecture. Keep the persistent browser, learned recipe, deterministic replay, safety validators, MFA pause, and last-good semantics.

Do not assume “cloud” means publicly reachable. The hotel may still require a particular SSO realm, source IP, device certificate, or corporate VPN.

### Tier 3 — Property Edge

**Use when:** Data cannot be exported at the required cadence, but the hotel/brand can provide an authorized local Windows, RDP, Citrix, or VDI session.

The edge runtime should be a separate Staxis product, not an extension of Playwright pretending every PMS is a website.

Recommended design:

- one signed Windows service or managed VM per property;
- outbound-only mutual-TLS connection to Staxis; no open inbound port;
- dedicated least-privilege Windows/PMS robot account;
- local UI Automation first, vision/OCR fallback;
- fixed screen resolution and DPI for pixel workflows;
- local redaction of card numbers, IDs, addresses, and unrelated guest data;
- transmit normalized fields rather than continuous video or screenshots;
- encrypted local credential storage;
- human-assisted MFA and a visible kill switch;
- signed/versioned workflows per PMS family;
- deterministic replay after learning;
- heartbeat, stale-data detection, and remote log access without arbitrary shell access;
- one active desktop session per property to avoid fighting front-desk staff.

An approved RDP/Citrix path is technically sufficient. Microsoft and UiPath both document automation of remote desktops. If the remote server permits no agent, surface automation can still operate the pixels; if it permits an approved remote runtime, native selectors are more reliable.

**Do not install this on a brand-managed computer without written permission.** Hilton's 2026 Home2 franchise disclosure includes a HITS agreement requiring authorized hardware/software and says other equipment or software may not be added to the information system without prior specific written permission. See the [2026 Home2 FDD](https://hmd-wp.go-vip.net/wp-content/uploads/2026/03/2026-US-FDD-Home2.pdf).

### Tier 4 — Attended bridge

**Use only as a pilot fallback:** A manager opens the report or PMS page and clicks “Sync now” while present.

This can prove parser accuracy and customer value before an unattended path exists, but it is not a scalable final integration.

## Brand/PMS routing

Do not route prospects only by hotel brand. These chains are mid-migration, so two Home2 or avid properties can have different PMS and access rules. Onboarding must ask for the exact PMS name/version.

### Home2 Suites by Hilton

Likely environments:

- Hilton PEP, co-developed with HotelKey;
- legacy OnQ components during migration;
- Hilton-managed Windows/network and SSO controls.

Hilton calls PEP a cloud-based platform and announced a rollout across thousands of properties. The [official Hilton announcement](https://stories.hilton.com/releases/hotel-key-partnership) says it was co-developed with HotelKey and was intended to reach more than 7,000 hotels.

**Recommended order:**

1. PEP Report Inbox;
2. existing cloud CUA only if the hotel has authorized remote/browser access;
3. approved Property Edge/VDI;
4. attended daily import during the pilot.

**First property experiment:**

- Open `Operations → Reports → Reports Scheduler`.
- Add a Dynamic Customer Report Queue.
- Inspect the available list for `Room Detail`, `Room Status`, `Housekeeping`, `Arrivals`, `Departures`, `In House`, or equivalent names.
- Determine the minimum repeat interval and whether multiple daily time slots are allowed.
- Export Excel, not PDF, where available.
- Send five samples to a Staxis test inbox while changing one test room through normal hotel operations.
- Measure lag and field coverage.

If PEP can send room detail/status every 15–30 minutes, the access problem for read-only Staxis is largely solved without a local robot. If the minimum useful interval is several hours, use report delivery for cold start/reconciliation and Property Edge for live status.

### avid hotels by IHG

The specific property may run:

- HotelKey cloud PMS;
- OPERA Cloud;
- legacy OPERA 5 or another locally presented/remote application.

IHG selected HotelKey as an approved cloud PMS for limited-service brands including avid. IHG's 2025 annual report says HotelKey was its first approved PMS in the Americas/EMEAA, OPERA Cloud became another option, cloud PMS deployment reached 2,000 hotels in 2025, and the company expected 4,000 by the end of 2026. The report also calls out mobile and remote access. See the [IHG 2025 annual report](https://www.ihgplc.com/~/media/Files/I/Ihg-Plc/investors/annual-report/2025/ihg-ar25-interactive.pdf).

**Recommended order:**

1. Ask “HotelKey, OPERA Cloud, or OPERA 5?” before the demo.
2. For HotelKey/OPERA Cloud, test authorized cloud CUA and scheduled reports.
3. For OPERA 5, test Report Scheduler email first.
4. Use approved Property Edge/VDI only if operational reports are too stale.

The manager's avid example may be true for that legacy property but should not be generalized to every avid. The IHG estate is actively moving toward cloud PMS and remote access.

### Marriott select-service

Likely environments include:

- FOSSE legacy;
- Agilysys Stay as Marriott transitions properties;
- OPERA Cloud for parts of the portfolio.

Marriott selected both Agilysys and Oracle cloud PMS platforms. [Agilysys describes its Marriott agreement](https://www.agilysys.com/en/news/agilysys-announces-agreement-with-marriott-international-to-deliver-its-cloud-native-property-management-system/) as covering luxury, premium, and select-service properties in the US and Canada, while [Oracle describes OPERA Cloud](https://www.oracle.com/middleeast/news/announcement/oracle-cloud-to-help-elevate-property-management-for-marriott-international-2024-01-30/) across Marriott segments.

**Recommended order:**

1. FOSSE report email for daily finance/cold start;
2. Property Edge or approved remote session for live FOSSE operations;
3. report scheduler or cloud CUA for Agilysys/OPERA Cloud.

## Data minimization and authorization

The no-API path still creates vendor and privacy obligations.

Minimum controls:

- a written agreement naming Staxis as an authorized hotel operations vendor/agent;
- a property and brand-IT approval record where required;
- no employee password sharing;
- a named service/robot account where the PMS supports it;
- read-only permissions for the initial product;
- least privilege and one property per credential;
- MFA completed by an authorized person, not defeated or silently bypassed;
- no capture of full card number, CVV, passport, driver's license, or payment screens;
- screenshot retention off by default; short encrypted retention only for explicit support cases;
- a per-property disconnect button and automatic credential revocation workflow;
- immutable access and synchronization audit logs;
- a documented subprocessor and data-retention list.

PCI scope matters even if Staxis never intentionally stores card data. PCI SSC says a service provider can be in scope when it has direct or indirect access to, or can affect, a cardholder-data environment. See [PCI SSC FAQ 1579](https://www.pcisecuritystandards.org/faqs/1579/). Keeping Staxis on report-only, non-payment screens and excluding payment fields materially reduces risk; it does not replace a formal assessment.

## Reliability requirements

The ingestion product should fail stale, not fail confidently.

Every feed needs:

- `source_type`: report inbox, cloud CUA, property edge, or manual;
- `source_generated_at` and `received_at`;
- parser/recipe version;
- report business date and property identifier;
- row count and unique-room count;
- expected-room-count comparison;
- field completeness metrics;
- normalized status distribution;
- checksum and duplicate detection;
- last-good snapshot preservation;
- explicit freshness state in the UI;
- an alert after consecutive missing/partial deliveries.

Validation examples:

- a 100-room property cannot silently promote a 12-room report;
- arrivals and departures must match the selected business date;
- no two rows may claim the same room in a single snapshot;
- status values outside the learned mapping pause promotion;
- a sudden 80% drop in rows requires review;
- an older emailed report cannot overwrite a newer snapshot;
- financial/payment columns should be discarded before persistence unless separately authorized.

Report Inbox should use golden sample files per PMS/version. Property Edge should retain the existing Staxis pattern: expensive AI only for learn/repair, deterministic replay for steady-state.

## Why hardware KVM/cameras are not the recommended shortcut

An HDMI capture device, KVM-over-IP appliance, or camera pointed at a branded workstation can technically expose pixels without installing software. It is still remote access to a controlled information system, may capture payment/guest data, can conflict with Hilton's authorized-equipment terms, and is operationally fragile.

Do not treat hardware as a loophole. It is viable only if brand/property IT explicitly approves it as the execution endpoint. A scheduled report or approved VDI session is cleaner.

## Two-week validation plan

### Days 1–2: classify real properties

For one Home2 and one avid, record:

- exact PMS and version;
- whether it is browser, native app, or remote app;
- whether the manager can access Reports Scheduler;
- available operational report names;
- minimum scheduler cadence;
- allowed formats and external email recipients;
- whether a read-only vendor/robot account can be provisioned;
- whether approved VPN/RDP/VDI access exists.

Do not accept “Hilton” or “IHG” as the PMS answer.

### Days 3–5: Report Inbox spike

- Create a separate operational-report inbound address and worker.
- Do not mix it with the current authentication-code email worker.
- Accept `.xlsx`, `.csv`, `.xml`, `.txt`, and PDF only as a last resort.
- Parse five sample PEP reports into `pms_room_status_log`, `pms_reservations`, and `pms_in_house_snapshot`.
- Add freshness, row-count, and last-good checks.
- Compare Staxis against the live PMS after controlled room-status changes.

### Days 6–8: cadence and failure test

- Run through a real housekeeping shift.
- Measure median and worst-case delivery lag.
- Stop one delivery and verify the UI says stale.
- Change one report column/header and verify the parser quarantines it.
- Confirm old emails cannot roll back newer state.
- Confirm no payment fields or full guest profiles are stored.

### Days 9–12: Property Edge proof

Only if reports are insufficient:

- Use a hotel-approved Windows VM or RDP test environment.
- Inspect a representative native app with Microsoft's `Inspect.exe`.
- Build one read-only workflow for the room-status screen.
- Use UI Automation for controls and OCR/vision for inaccessible areas.
- Transmit normalized test data through outbound mTLS.
- Test session timeout, resolution changes, MFA pause, and human takeover.

### Days 13–14: go/no-go

Report Inbox is a go if:

- setup takes less than 30 minutes;
- freshness is within the product promise;
- at least 99.5% of room/status rows match controlled truth;
- the feed self-identifies stale/partial data;
- no software is installed on the brand workstation;
- no personal employee password is stored.

Property Edge is a go only if:

- written approval and a dedicated account/session exist;
- the worker cannot access payment workflows;
- it survives restart and reconnect tests;
- staff and agent cannot unknowingly control the same desktop;
- the hotel can instantly disable it.

## Questions for the next manager call

Ask these while screen sharing:

1. What exact PMS name and version is this property using?
2. Is the screen local, a browser, Citrix/RDP, or another remote application?
3. Under Reports, is there a scheduler or report queue?
4. Can you search for Room Detail, Room Status, Housekeeping, Arrivals, Departures, In House, and Downtime reports?
5. Can one of those reports export to Excel/CSV?
6. Can it be emailed to an external address?
7. What is the shortest repeat interval? Can multiple times be added?
8. Is the schedule tied to an individual employee account?
9. Can the hotel create a read-only vendor account instead of sharing a manager login?
10. Does the owner/management company have an approved VPN, VDI, or remote-support path for vendors?
11. Who can open a brand IT ticket for written approval?
12. Which fields does Staxis actually need, and can guest names/payment columns be omitted?

## Product and sales recommendation

Do not sell “we bypass your PMS security” or “works on anything with no integration.” That language frightens competent operators and creates brand risk.

Use:

> “Staxis connects through reporting your PMS already supports or through an authorized read-only screen session. No PMS replacement and no year-long API project.”

The first sales wedge should be:

- read-only;
- no workstation install where Report Inbox is available;
- live-enough room status with an honest freshness badge;
- reversible in one click;
- no payment data;
- property setup in under 30 minutes.

## Final priority

1. **Build and validate Report Inbox for Hilton PEP.**
2. **Repeat it for IHG HotelKey/OPERA and Marriott FOSSE/Agilysys report formats.**
3. **Add an onboarding classifier based on actual PMS/version and report capability.**
4. **Prototype Property Edge only for properties that fail the report-freshness test.**
5. **Keep APIs as a later certification/scale path, not a launch dependency.**

The strategic insight is simple: Lance solved the general “operate the screen” problem. Staxis does not yet need the entire solution. For read-only hotel operations, the PMS's own export machinery is often the shortest path around the integration queue—without going around the security boundary.
