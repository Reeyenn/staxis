import type { Metadata } from 'next';
import MarketingLanding from './_components/MarketingLanding';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Staxis · AI operations for hotels',
  description:
    'Staxis is an AI operations platform for limited and select-service hotels. It turns available hotel data into housekeeping schedules, work orders, and supply reorders.',
};

export default function LandingPage() {
  return <MarketingLanding />;
}
