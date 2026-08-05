import type { Metadata } from 'next';
import MarketingLanding from '@/app/_components/MarketingLanding';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Staxis · AI operations for hotels',
  description:
    'Staxis is an AI operations platform for limited and select-service hotels. It turns available hotel data into housekeeping schedules, work orders, and inventory alerts.',
};

export default function LandingPage() {
  return <MarketingLanding />;
}
