# Room Assignment UI — Quick Reference

## Feature Summary
Room assignment UI for the housekeeping page in Staxis. Allows Maria to assign rooms to staff visually with:
- Manual assignment by clicking rooms
- Auto-assign with intelligent distribution
- Visual indicators for assignments
- Batch save to Firestore

## File Modified
`src/app/housekeeping/page.tsx`

## Key Components Added

### State Variables
```typescript
const [isAssignmentMode, setIsAssignmentMode] = useState(false);
const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
const [assignments, setAssignments] = useState<Record<string, string>>({}); // roomId → staffId
const [toastMessage, setToastMessage] = useState<string | null>(null);
```

### Main Functions
- `getStaffColor()` — Returns CSS color for staff member by index
- `handleRoomClick()` — Toggle assignment on room click
- `handleAutoAssign()` — Call autoAssignRooms() and merge results
- `handleDoneAssigning()` — Batch save all assignments to Firestore

### UI Sections
1. **Toggle Button** — Enter/exit assignment mode
2. **Staff Pills** — Select housekeeper (only in assignment mode)
3. **Auto-Assign Button** — One-click intelligent distribution
4. **Room Tiles** — Visual assignment feedback
5. **Color Dots** — Show assignments in normal mode
6. **Toast** — Success notification

## Constants
```typescript
const STAFF_COLORS = [
  '#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C',
  '#0891B2', '#CA8A04', '#DB2777', '#4F46E5', '#059669'
];
```

## Import Added
```typescript
import { getPublicAreasDueToday, calcPublicAreaMinutes, autoAssignRooms } from '@/lib/calculations';
```

## Property Hook Updated
```typescript
// From:
const { activePropertyId, activeProperty } = useProperty();

// To:
const { activePropertyId, activeProperty, staff } = useProperty();
```

## How It Works

### Normal Flow
1. User clicks "Assign Rooms"
2. Assignment mode activates, first staff auto-selected
3. User clicks staff pills to select different housekeeper
4. User clicks rooms to assign/unassign
5. User clicks "Done"
6. All changes batch-saved to Firestore
7. Toast notification appears
8. Exit assignment mode

### Auto-Assign Flow
1. User in assignment mode
2. User clicks "⚡ Auto-Assign"
3. Function distributes rooms intelligently:
   - VIP rooms → senior staff
   - Balanced workload
   - Same-floor preference
   - Skips DND/vacant
4. Results visible immediately on room tiles
5. User can adjust manually if needed
6. User clicks "Done" to save

## Room Assignment Data Structure
```typescript
// Each room gets two fields updated:
{
  assignedTo: "staffId",      // Firebase UUID
  assignedName: "Staff Name"  // Display name
}
```

## Visual Indicators

### In Assignment Mode
- Assigned room: Initial of staff + staff's color
- Selected assignment: Blue border glow + light blue background
- Unassigned: Gray circle (○)

### In Normal Mode
- Assigned room: Small colored dot in top-right corner
- Unassigned: No indicator

### Staff Pills
- Selected: Staff color background + white text + glowing border
- Unselected: Light gray background + dark text

## Translations
All UI text is bilingual (English/Spanish):
- "Assign Rooms" / "Asignar Habitaciones"
- "Done" / "Listo"
- "Unassigned" / "Sin Asignar"
- "Auto-Assign" / "Auto-Asignar"
- "Assignments saved" / "Asignaciones guardadas"

Pattern: `lang === 'es' ? 'Spanish' : 'English'`

## Integration Points

**useAuth()** — For `user.uid`
**useProperty()** — For `activePropertyId`, `staff` array
**useLang()** — For `lang` (en/es)
**useSyncContext()** — For offline tracking via `recordOfflineAction()`

**Firestore:**
- `updateRoom()` — Persist assignments
- Uses existing Room type with `assignedTo` and `assignedName` fields

**Calculations:**
- `autoAssignRooms(rooms, staff)` → `Record<string, staffId>`
- Handles all intelligent distribution logic

## Code Quality
- No new dependencies added
- Uses existing types (Room, StaffMember)
- Inline styles (matches existing codebase pattern)
- All state management within RoomsSection component
- Respects offline mode
- Bilingual support built-in

## Testing Notes
- Manual assignment: Click any room to assign/unassign
- Auto-assign: Verify VIP → senior, workload balanced
- Save: Check Firestore for `assignedTo` and `assignedName`
- Toast: Verify appears and dismisses after 2s
- Pills: Verify scroll on mobile, colors cycle correctly
- Dots: Verify visible in normal mode, hidden during assignment

## Git History
- Commit: `32d8fac`
- Branch: `main`
- Status: Pushed to GitHub ✓

## Related Files
- `src/lib/calculations.ts` — Contains `autoAssignRooms()`
- `src/types/index.ts` — Room type definition
- `src/app/housekeeping/page.tsx` — Implementation

## Performance
- State updates batched
- No unnecessary re-renders (proper dependency arrays)
- Firestore writes batched (single iteration)
- Color calculation uses modulo (efficient for cycling)

## Browser Compatibility
- Uses standard React hooks
- CSS Grid/Flex (no IE11 support needed)
- CSS custom properties (color tokens)
- Respects CSS transforms for animations

## Future Enhancements
- [ ] Drag-and-drop reordering
- [ ] Workload preview (hours per person)
- [ ] Assignment history/undo
- [ ] Email notifications to assigned staff
- [ ] Assignment preferences (staff preferences for floors)
