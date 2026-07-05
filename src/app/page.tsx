import type { Metadata } from 'next';
import MarketingLanding from './_components/MarketingLanding';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Staxis — The hotel that runs itself',
  description:
    'Staxis is an AI operations platform for limited-service hotels. It watches your property management system 24/7 and turns what it sees into housekeeping schedules, work orders, and supply reorders — automatically.',
};

export default function LandingPage() {
  return <MarketingLanding />;
}
