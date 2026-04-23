import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

// Public endpoint — returns the staff scheduled to work today for a given
// property. Used by the housekeeper mobile page to let someone identify who
// they are (no login required — the URL encodes the property).
//
// Legacy `uid` query param is accepted for URL back-compat but ignored: the
// old Firestore layout keyed data under users/{uid}/properties/{pid}/... so
// the UI baked uid into bookmarks. Under Supabase, `pid` alone is enough
// (property_id is the real scoping key).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pid = searchParams.get('pid');

  if (!pid) {
    return NextResponse.json({ error: 'Missing pid' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('*')
    .eq('property_id', pid)
    .eq('scheduled_today', true);

  if (error) {
    const msg = errToString(error);
    console.error('[staff-list] query failed', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Translate snake_case → camelCase for the client (it expects the legacy
  // Firestore shape). Only the fields the client actually reads are mapped;
  // extra fields pass through under their snake_case names and will be
  // ignored harmlessly by current callers.
  const mapped = (data ?? []).map(s => ({
    id: s.id,
    name: s.name,
    phone: s.phone,
    language: s.language,
    isSenior: s.is_senior,
    department: s.department,
    scheduledToday: s.scheduled_today,
    hourlyWage: s.hourly_wage,
    weeklyHours: s.weekly_hours,
    maxWeeklyHours: s.max_weekly_hours,
    maxDaysPerWeek: s.max_days_per_week,
    daysWorkedThisWeek: s.days_worked_this_week,
    isActive: s.is_active,
    schedulePriority: s.schedule_priority,
    isSchedulingManager: s.is_scheduling_manager,
  }));

  return NextResponse.json(mapped);
}
