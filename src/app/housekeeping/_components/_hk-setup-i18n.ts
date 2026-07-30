/**
 * feature/housekeeping-levels (2026-07-24) — bilingual copy for the one-time
 * Housekeeping questionnaire (`HousekeepingSetup.tsx`).
 *
 * Co-located with the component, same pattern as `_onboard-i18n.ts` and
 * `_mapping-i18n.ts`: this is one self-contained feature's copy, so it does not
 * belong in the 2,800-line global `translations.ts` that every parallel feature
 * edits at once.
 *
 * The copy here is read by hotel general managers and head housekeepers, not by
 * engineers. Two rules it follows throughout:
 *   • No jargon. No "PMS", no "level 2" as a bare number, no "status entry".
 *     Every question is phrased the way a manager would say it out loud.
 *   • The three levels are described with their DOWNSIDES as well as their
 *     benefits. A hotel that picks a level it can't sustain churns; a hotel that
 *     picks a smaller honest one stays. The downside lines are load-bearing
 *     product copy, not hedging — do not trim them.
 *
 * ES is NOT type-checked against `HkSetupStrings` (the type is derived from
 * `en`), so every key added to `en` MUST be mirrored into `es` by hand.
 */

type Lang = 'en' | 'es';

const STRINGS = {
  en: {
    // ── Chrome: header, progress, navigation ────────────────────────────
    eyebrow: 'Housekeeping setup',
    title: 'A few questions, once',
    subtitle: "This takes about two minutes, and we'll never ask again.",
    stepWord: 'Step',
    ofWord: 'of',
    goToStep: 'Go back to question',
    back: 'Back',
    next: 'Continue',
    skip: 'Skip this',

    // ── Q1 — how a clean room gets recorded today ───────────────────────
    q1Title: 'How does a clean room get into your system today?',
    q1Sub: "When a housekeeper finishes a room, who types it into the system you already use?",
    q1RadioLabel: 'The housekeeper tells the front desk, and the desk enters it',
    q1RadioHint: 'A radio call, a phone call, or a walk down to the desk',
    q1SupervisorLabel: 'A supervisor or head housekeeper enters it',
    q1SupervisorHint: 'She walks the rooms and records them herself',
    q1DirectLabel: 'The housekeepers enter it themselves',
    q1DirectHint: 'A code on the room phone, or their own login',
    q1UnsureLabel: "I'm not sure",
    q1UnsureHint: "That's fine. We'll work it out with you later",

    // ── Q2 — standard room times ────────────────────────────────────────
    q2Title: 'How long should a room take?',
    q2Sub: 'These are your standard times. Every hour and every dollar we show you is built on these two numbers. You can change them later.',
    q2CheckoutLabel: 'Checkout room',
    q2CheckoutHint: 'The guest has left',
    q2StayoverLabel: 'Stayover room',
    q2StayoverHint: 'The guest is staying another night',
    q2Minutes: 'minutes',
    // Split around the numbers so the allowed range is printed from the shared
    // MIN/MAX constants — the copy can't drift from the rule it describes.
    q2InvalidLead: 'Please enter a whole number of minutes between',
    q2InvalidJoin: 'and',

    // Q2's "+" — room types this hotel invented (a suite, an extended-stay
    // unit, a scheduled deep clean). Most hotels add none.
    q2AddRoom: '+ Add another kind of room',
    q2CustomNameLabel: 'What you call it',
    q2CustomNamePlaceholder: 'Suite, extended stay, deep clean',
    q2CustomTimeLabel: 'Time',
    q2RemoveRoom: 'Remove',
    // Grey, not red: an empty row the manager just added is unfinished, not
    // wrong. It still holds Continue, so it has to say what to do about it.
    q2RoomIncomplete: 'Give this one a name and a time, or remove it.',
    q2RoomReserved: 'Checkout and stayover already have their own times above. Give this one a different name.',
    q2RoomDuplicate: 'is already on your list. Each kind of room needs its own name.',
    // Printed with the shared cap so the sentence can't drift from the rule.
    q2CapLead: 'You can add up to',
    q2CapTail: 'kinds of room.',
    // Shown the moment they add a room of their own, and only then.
    //
    // This screen's own sub-heading promises that every hour and every dollar
    // comes from "these two numbers" — and then invites them to type a third
    // one, in a box labelled Time, under a name they chose. A manager who puts
    // "Suite — 45" there will reasonably believe it moves the money. It does
    // not: custom room types are stored and read by nothing (the reasoning is
    // in the header of src/app/api/housekeeping/setup/route.ts). Saying so in
    // a code comment and not on the screen is how someone finds out in week
    // three, from a number that was wrong the whole time.
    q2CustomNote: 'We keep these so we know how your hotel really works. Your hours and dollars still come from the two times above.',

    // ── Q3 — photo of the paper board (always skippable) ────────────────
    q3Title: 'Show us your board',
    q3Sub: "Take a picture of today's paper board so we have it on file. Completely optional. Skipping costs you nothing.",
    q3Take: 'Take or choose a photo',
    q3Retake: 'Use a different photo',
    q3Uploading: 'Reading your board…',
    // HONESTY: nothing downstream reads the photo yet, so this must not promise
    // that it pre-fills anything. It says what is true — the board is saved.
    q3Generic: 'Got it. Your board is saved.',
    q3ReadLead: 'Looks like',
    q3ReadTail: "That's your board saved.",
    // Shown ONLY when the file itself can't be read (HEIC from an iPhone
    // library). Neutral, not an error: the step is optional either way.
    q3FormatNote: "That photo format can't be read. Try a JPEG, or skip this step.",
    // Any other photo failure. Grey and calm, never red: the step is optional.
    // It exists because the screen no longer moves on by itself when an upload
    // fails — without a word here, their tap would look like it missed.
    q3ReadFailNote: "We couldn't read that photo. Try another one, or skip this step.",
    // Singular + plural kept apart: the sentence is built from counts the photo
    // produced, and "1 sections" on a small hotel's board undercuts the one
    // moment where we are showing them we read their handwriting correctly.
    q3Section: 'section',
    q3Sections: 'sections',
    q3Floor: 'floor',
    q3Floors: 'floors',
    q3Person: 'person',
    q3People: 'people',

    // ── Q4 — shift start + who builds the board ─────────────────────────
    q4Title: 'When does housekeeping start, and who builds the board?',
    q4Sub: "We build tomorrow's board overnight, so it's ready before your team walks in.",
    q4TimeLabel: 'Start time',
    q4WhoLabel: 'Who builds the board today?',
    q4HeadLabel: 'Our head housekeeper',
    q4HeadHint: 'She decides who cleans what',
    q4GmLabel: 'The manager',
    q4GmHint: 'You or another manager',
    q4NobodyLabel: 'Nobody really, people just start',
    q4NobodyHint: 'It sorts itself out each morning',
    q4UnsureLabel: "I'm not sure",
    q4UnsureHint: 'It changes from day to day',
    q4TimeInvalid: 'Please pick a start time.',

    // ── Q5 — inspection policy ──────────────────────────────────────────
    q5Title: "Who checks rooms before they're sold?",
    q5Sub: "Clean and ready-to-sell aren't always the same thing, and we shouldn't treat them as one.",
    q5NoneLabel: 'Nobody',
    q5NoneHint: "Once it's clean, it's ready to sell",
    q5SpotLabel: 'We spot-check some of them',
    q5SpotHint: 'A few rooms a day, or new people',
    q5EveryLabel: 'Every room is checked',
    q5EveryHint: 'Nothing is sold before someone walks it',

    // ── Q6 — side duties ────────────────────────────────────────────────
    q6Title: 'What else do your housekeepers do besides rooms?',
    q6Sub: "Pick everything that applies. If we don't know about this work, the time it takes makes your best people look slow.",
    q6Laundry: 'Laundry',
    q6Breakfast: 'Breakfast',
    q6Lobby: 'Lobby',
    q6PublicAreas: 'Public areas',
    q6Shuttle: 'Driving the shuttle',
    q6None: 'Just rooms',

    // Q6's "+" — duties in the hotel's own words ("pool towels", "van runs").
    q6AddOther: '+ Add something else',
    q6AddLabel: 'What else do they do?',
    q6AddPlaceholder: 'Pool towels, van runs',
    q6AddConfirm: 'Add',
    q6AddCancel: 'Cancel',
    q6RemoveDuty: 'Remove',
    q6DutyReserved: 'is already one of the choices above.',
    q6DutyDuplicate: 'is already on your list.',
    q6CapLead: 'You can add up to',
    q6CapTail: 'of your own.',

    // ── Shared by both "+" screens ──────────────────────────────────────
    // Printed around MAX_CUSTOM_LABEL_LENGTH so the number comes from the rule.
    customTooLongLead: 'Keep the name to',
    customTooLongTail: 'characters or fewer.',

    // ── Q7 — the three levels ───────────────────────────────────────────
    // The screen leads with ONE axis — who at the hotel opens Staxis — and each
    // card collapses to four lines: name, who, the one thing you get (lNGet),
    // and the one honest trade-off that should change the decision. The trade
    // line reuses an existing bad-bullet key (l1Bad2 / l2Bad1 / l3Bad0) so the
    // sentence can never drift from the full list behind "The full picture".
    q7Title: 'How much of Staxis do you want to use?',
    q7Sub: 'The difference is who at your hotel opens Staxis. Start small. You can move up whenever you want.',
    recommended: 'Recommended for you',
    reasonHeadHousekeeper: 'You told us your head housekeeper builds the board. She is the person this pays off for first.',
    reasonSafeStart: 'Nothing changes for your team on day one, and you see the numbers straight away.',
    goodLabel: 'What you get',
    badLabel: 'What it asks of you',
    detailsLabel: 'The full picture',
    lockedLabel: "You don't need this one",
    lockedBody: 'Your housekeepers already mark their own rooms clean in your system. Doing it in Staxis too would mean entering the same room twice.',

    l1Name: 'Staxis plans it',
    l1Who: 'Just you',
    l1Get: 'The morning board, built overnight and ready to print. Plus earned hours against paid hours, in dollars.',
    l1Good1: "Your board is built overnight and ready to print each morning, on the same paper your team already carries.",
    l1Good2: 'You see the hours the work earned against the hours you paid for, in dollars.',
    l1Good3: 'Nothing changes for a single person on your team.',
    l1Bad1: "If the board gets changed on paper during the day, Staxis won't know about it.",
    // The honest reason to climb to the next one. Without this line the money
    // benefit above reads as the whole answer, and nothing explains why anyone
    // would ever pick anything but the cheapest option.
    l1Bad2: "You'll see the totals for the whole hotel, not what each housekeeper actually did.",

    l2Name: 'Your head housekeeper runs her day in it',
    l2Who: 'You and your head housekeeper',
    l2Get: "Her notebook moves into Staxis: board changes, deep cleans, linen, lost and found. Paper she already keeps, not new work.",
    l2Good1: 'Her notebook moves into Staxis: board changes, deep cleans, linen counts, lost and found.',
    l2Good2: "It replaces paper she already keeps, so it isn't extra work on top of her day.",
    l2Good3: 'Your numbers stay honest, because her changes land where they get counted.',
    l2Bad1: 'One more person has to open Staxis every day.',
    l2Bad2: 'If she keeps using paper instead, the numbers quietly drift away from reality.',

    l3Name: 'Your housekeepers carry it',
    l3Who: 'Your whole housekeeping team',
    l3Get: 'One tap from each housekeeper when a room is done. Real minutes per room, per person.',
    l3Good1: 'Each housekeeper sees their rooms on their phone and taps once when a room is done.',
    l3Good2: 'You get real minutes per room, and you can see where the day stands right now.',
    // THE most important line on this screen. Staxis is read-only into the
    // hotel's own system, forever. Without saying so, "taps once when a room is
    // done" reads as replacing the radio call to the front desk — and a hotel
    // that buys this level believing that feels lied to in week one.
    l3Bad0: "It doesn't mark the room clean in your own system. Whoever does that today still does it.",
    l3Bad1: 'Every housekeeper needs a phone and a few minutes of showing.',
    l3Bad2: "It's one new tap in their day. Small, but still new.",

    // ── Saving ──────────────────────────────────────────────────────────
    finish: 'Finish setup',
    saving: 'Saving…',
    saveError: "We couldn't save your answers. Nothing was lost. Try again.",
    // A LOCAL problem (an answer was cleared), not a network one. It must never
    // share the wording above: "try again" on a bad answer is an infinite loop
    // with no clue where the problem is. We also jump back to the question.
    answerCheck: 'One answer needs another look. We’ve taken you back to it.',
    // A 403. "Try again" would be a lie: retrying can never succeed.
    noPermission: "You don't have permission to finish this setup. Ask your owner or general manager to do it.",
    retry: 'Try again',
  },


};

export type HkSetupStrings = (typeof STRINGS)['en'];

export function hkst(lang: Lang): HkSetupStrings {
  return STRINGS['en'] ?? STRINGS.en;
}
