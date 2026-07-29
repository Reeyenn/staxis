import { RouteLoadingState } from '@/components/layout/RouteResourceState';

export default function Loading() {
  return <RouteLoadingState title="Opening this page…" message="Loading the current Staxis workspace." />;
}
