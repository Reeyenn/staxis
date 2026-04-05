import type { InventoryItem, Room } from '@/types';

export interface ItemPrediction {
  item: InventoryItem;
  dailyBurnRate: number;
  daysUntilEmpty: number | null;
  daysUntilReorder: number | null;
  reorderUrgency: 'critical' | 'soon' | 'ok' | 'overstocked';
  projectedUsageNext7Days: number;
  stockAfter7Days: number;
}

export function computePredictions(
  items: InventoryItem[],
  roomHistory: { date: string; checkouts: number; stayovers: number }[],
): ItemPrediction[] {
  const totalDays = roomHistory.length || 1;
  const avgCheckouts = roomHistory.reduce((sum, d) => sum + d.checkouts, 0) / totalDays;
  const avgStayovers = roomHistory.reduce((sum, d) => sum + d.stayovers, 0) / totalDays;

  return items.map(item => {
    const perCheckout = item.usagePerCheckout ?? 0;
    const perStayover = item.usagePerStayover ?? 0;
    const leadDays = item.reorderLeadDays ?? 3;

    const dailyBurnRate = (avgCheckouts * perCheckout) + (avgStayovers * perStayover);

    const daysUntilEmpty = dailyBurnRate > 0
      ? Math.floor(item.currentStock / dailyBurnRate)
      : null;

    const daysUntilReorder = daysUntilEmpty !== null
      ? daysUntilEmpty - leadDays
      : null;

    let reorderUrgency: ItemPrediction['reorderUrgency'] = 'ok';
    if (daysUntilReorder !== null) {
      if (daysUntilReorder <= 0) reorderUrgency = 'critical';
      else if (daysUntilReorder <= 3) reorderUrgency = 'soon';
      else reorderUrgency = 'ok';
    }
    if (item.parLevel > 0 && item.currentStock > item.parLevel * 1.5) reorderUrgency = 'overstocked';

    const projectedUsageNext7Days = Math.round(dailyBurnRate * 7);
    const stockAfter7Days = Math.max(0, item.currentStock - projectedUsageNext7Days);

    return {
      item,
      dailyBurnRate: Math.round(dailyBurnRate * 10) / 10,
      daysUntilEmpty,
      daysUntilReorder,
      reorderUrgency,
      projectedUsageNext7Days,
      stockAfter7Days,
    };
  });
}

export function extractRoomCounts(rooms: Room[]): { checkouts: number; stayovers: number } {
  return {
    checkouts: rooms.filter(r => r.type === 'checkout').length,
    stayovers: rooms.filter(r => r.type === 'stayover').length,
  };
}
