// Printable week — one button → browser print dialog → paper or PDF.
//
// Pure HTML builder extracted verbatim from the ScheduleView god-component
// (index.tsx). No React, no side effects: given a week + roster it returns a
// full standalone HTML document string that ScheduleView writes into a popup.

import {
  weekMinutesByStaff, fmtHours, fmtMinRange,
  type BoardShift, type WeekInfo,
} from '@/lib/schedule-board';
import { deptMeta, asDeptKey, type DeptKey } from '../_tokens';
import type { StaffMember } from '@/types';

const DEFAULT_WEEKLY_CAP = 40;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function printableWeekHtml({
  week, staff, getDay, nameOf, capMinById, propertyName, lang,
}: {
  week: WeekInfo;
  staff: StaffMember[];
  getDay: (date: string) => BoardShift[];
  nameOf: (staffId: string) => string;
  capMinById: Map<string, number>;
  propertyName?: string;
  lang: 'en' | 'es';
}) {
  const es = lang === 'es';
  const dayLists = week.days.map(d => getDay(d.date));
  const weekMin = weekMinutesByStaff(dayLists);
  const shiftFor = new Map<string, BoardShift>();
  week.days.forEach((d, i) => {
    for (const s of dayLists[i]) shiftFor.set(`${s.staffId}:${d.date}`, s);
  });

  const lanes: DeptKey[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];
  const active = staff.filter(s => s.isActive !== false);
  const rows: string[] = [];
  for (const dep of lanes) {
    const list = active
      .filter(s => asDeptKey(s.department) === dep)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (list.length === 0) continue;
    rows.push(`<tr class="dept"><td colspan="9">${esc(deptMeta[dep].label)}</td></tr>`);
    for (const s of list) {
      const min = weekMin.get(s.id) ?? 0;
      const over = min > (capMinById.get(s.id) ?? DEFAULT_WEEKLY_CAP * 60);
      const cells = week.days.map(d => {
        const sh = shiftFor.get(`${s.id}:${d.date}`);
        if (!sh) return '<td></td>';
        const note = sh.note ? `<div class="note">${esc(sh.note)}</div>` : '';
        return `<td><div class="chip">${fmtMinRange(sh.startMin, sh.endMin)}</div>${note}</td>`;
      }).join('');
      rows.push(`<tr><td class="name">${esc(nameOf(s.id))}</td>${cells}<td class="hours${over ? ' ot' : ''}">${min > 0 ? fmtHours(min) + (over ? ' OT' : '') : ''}</td></tr>`);
    }
  }
  const counts = week.days.map((d, i) => `<td>${dayLists[i].length}</td>`).join('');

  const title = `${propertyName ? esc(propertyName) + ' — ' : ''}${es ? 'Semana' : 'Week'} ${esc(week.label)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #1F231C; margin: 28px; }
  h1 { font-size: 19px; margin: 0; font-weight: 600; }
  .sub { font-size: 11px; color: #5C625C; margin: 3px 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #C9CCC9; padding: 5px 6px; font-size: 10.5px; text-align: center; vertical-align: top; }
  th { background: #F2F1EC; font-weight: 700; }
  th .num { font-size: 13px; font-weight: 400; display: block; }
  td.name, th.name { text-align: left; white-space: nowrap; font-weight: 600; }
  tr.dept td { background: #F7F6F2; text-align: left; font-weight: 700; font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; }
  .chip { font-weight: 600; white-space: nowrap; }
  .note { font-size: 8.5px; color: #5C625C; margin-top: 2px; }
  td.hours { font-weight: 700; white-space: nowrap; }
  td.hours.ot { color: #A04A2C; }
  tr.count td { background: #F7F6F2; font-weight: 700; }
  @media print { body { margin: 10mm; } }
</style></head><body>
<h1>${title}</h1>
<div class="sub">${es ? 'Impreso desde Staxis' : 'Printed from Staxis'} · ${esc(new Date().toLocaleDateString())}</div>
<table>
  <tr>
    <th class="name">${es ? 'PERSONAL' : 'STAFF'}</th>
    ${week.days.map(d => `<th>${esc(d.dow.toUpperCase())}<span class="num">${d.mon} ${d.dayNum}</span></th>`).join('')}
    <th>${es ? 'HORAS' : 'HOURS'}</th>
  </tr>
  ${rows.join('\n')}
  <tr class="count"><td class="name">${es ? 'EN TURNO' : 'ON SHIFT'}</td>${counts}<td></td></tr>
</table>
</body></html>`;
}
