// Typography for the Communications tab's Slack-Classic redesign.
// Hanken Grotesk (UI/body) · Newsreader italic (headlines) · JetBrains Mono
// (micro-labels). Loaded here (imported by the server page) and exposed as CSS
// variables; the comms components read them via var(--font-*). Scoped to this
// tab so the rest of the app stays on Geist.
import { Hanken_Grotesk, Newsreader, JetBrains_Mono } from 'next/font/google';

const hanken = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-hanken',
  display: 'swap',
});

const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-newsreader',
  display: 'swap',
});

const jbmono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-jbmono',
  display: 'swap',
});

/** className that defines --font-hanken / --font-newsreader / --font-jbmono. */
export const commsFontVars = `${hanken.variable} ${newsreader.variable} ${jbmono.variable}`;
