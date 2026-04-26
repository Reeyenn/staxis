import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

// Public endpoint — returns the active staff for a given property so the
// housekeeper / laundry mobile pages can let a worker identify themselves.
// No login required because the page is reached via an SMS link.
//
// Privacy: returns ONLY the fields the public identification UI actually
// needs (id + name + language + role flags). Phone numbers, wages, hours
// limits, and other PII stay server-side. Was previously `select('*')`,
// dumping the full staff row including phone + hourly_wage to anyone with
// the property id.
//
// Filter: `scheduled_today` was the historical filter, but the new shift-
// confirmation flow targets tomorrow's crew — so the page would say "no
// staff scheduled" for anyone on tomorrow's roster. Returning all active
// staff is the right baseline; the client-side UI filters further.
//
// Legacy `uid` query param is accepted but ignored.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pid = searchParams.get('pid');

  if (!pid) {
    return NextResponse.json({ error: 'Missing pid' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('staff')
    .select('id, name, language, is_senior, department, scheduled_today, is_active, is_scheduling_manager')
    .eq('property_id', pid)
    .eq('is_active', true);

  if (error) {
    const msg = errToString(error);
    console.error('[staff-list] query failed', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const mapped = (data ?? []).map(s => ({
    id: s.id,
    name: s.name,
    language: s.language,
    isSenior: s.is_senior,
    department: s.department,
    scheduledToday: s.scheduled_today,
    isActive: s.is_active,
    isSchedulingManager: s.is_scheduling_manager,
  }));

  return NextResponse.json(mapped);
}
