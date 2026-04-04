# Room Assignment UI — Visual Reference

## UI Layout Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Housekeeping Page                                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  [Assign Rooms]  ← Toggle button (gray when inactive)      │
│                                                              │
│  (When in assignment mode:)                                │
│                                                              │
│  [Sarah ★] [John] [Maria] [Carlos] [Unassigned]            │
│    ↑ selected, blue   gray    gray    gray      gray        │
│  (horizontally scrollable)                                  │
│                                                              │
│  [⚡ Auto-Assign]                                            │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│ Room Legend:  🚪 Checkout  🚫 DND  🔒 Occupied  💎 Vacant   │
├─────────────────────────────────────────────────────────────┤
│ Floor 1                                    2/8              │
│                                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐          │
│  │ 101  │  │ 102  │  │ 103  │  │ 104  │  │ 105  │          │
│  │  S   │  │  ○   │  │  ○   │  │  -   │  │  M   │          │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘          │
│   (Sarah   (unass    (unass   (no       (Maria
│    - blue    - gray)  - gray)  assign)   - red)
│    color dot)                                                │
│                                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐                              │
│  │ 106  │  │ 107  │  │ 108  │                              │
│  │  C   │  │  ○   │  │  J   │                              │
│  └──────┘  └──────┘  └──────┘                              │
│   (Carlos  (unass    (John
│    - green) - gray)  - yellow)
│                                                              │
│ Floor 2                                    3/5              │
│                                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐          │
│  │ 201  │  │ 202  │  │ 203  │  │ 204  │  │ 205  │          │
│  │  ○   │  │  S   │  │  ○   │  │  M   │  │  ○   │          │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘          │
│   (unass    (Sarah   (unass    (Maria    (unass             │
│    - gray)  - blue)  - gray)   - red)    - gray)           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Assignment Mode Visual States

### Normal Mode (Assignment OFF)
```
Room tiles show:
- Room number (large, monospace)
- Status label (dirty, cleaning, clean, approved)
- Status color (red, yellow, green, purple)
- Room type emoji (top-right: 🚪🚫🔒💎)
- Assigned color dot (if assigned)
```

### Assignment Mode (Assignment ON)
```
Room tiles show:
- Room number (same)
- Housekeeper initial or ○ for unassigned (replaces status)
- Color matches housekeeper's pill (or gray for unassigned)
- Bright blue border glow if assigned to selected staff
- Light blue background if assigned to selected staff
- No status color or emoji
```

---

## Staff Pill States

### Unselected Pill
```
┌─────────────────┐
│ Sarah ★    │ (gray background, black text)
└─────────────────┘
  Light gray (#F3F4F6) background
  1px border: var(--border)
```

### Selected Pill
```
┌─────────────────┐
│ Sarah ★    │ (blue background, white text, glowing border)
└─────────────────┘
  Blue (#2563EB) background
  No border
  Box shadow: 0 0 0 2px #2563EB40 (glowing effect)
```

### Unassigned Pill (Unselected)
```
┌──────────────────┐
│ Unassigned   │ (gray background, black text)
└──────────────────┘
  Light gray (#F3F4F6) background
  1px border: var(--border)
```

### Unassigned Pill (Selected)
```
┌──────────────────┐
│ Unassigned   │ (darker gray background, white text)
└──────────────────┘
  Medium gray (#D1D5DB) background
  No border
  Box shadow: 0 0 0 2px #D1D5DB40
```

---

## Color Assignment Example

With 5 staff members:
```
Index 0 → Sarah    → #2563EB (blue)
Index 1 → John     → #DC2626 (red)
Index 2 → Maria    → #16A34A (green)
Index 3 → Carlos   → #9333EA (purple)
Index 4 → Ana      → #EA580C (orange)
```

Colors cycle if >10 staff: `STAFF_COLORS[index % 10]`

---

## Room Assignment Indicator (Normal Mode)

Small colored dot appears in top-right corner of room tile:
```
┌────────────┐
│ 101      ● │  ← 14px diameter dot
│   dirty  │    Blue dot = Sarah assigned
└────────────┘    White border
                  Subtle shadow
```

Dot properties:
- Width: 14px
- Height: 14px
- Border-radius: 50% (circle)
- Border: 2px white
- Box-shadow: 0 1px 3px rgba(0,0,0,0.1)
- Background: Staff color

---

## Toast Notification

Appears at bottom-right for 2 seconds:
```
┌────────────────────────────┐
│ ✓ Assignments saved        │
└────────────────────────────┘
```

Properties:
- Position: fixed, bottom: 20px, right: 20px
- Background: #10B981 (green)
- Color: #FFFFFF (white)
- Padding: 12px 16px
- Border-radius: var(--radius-md)
- Font: 14px, fontWeight 500
- Box-shadow: 0 4px 12px rgba(0,0,0,0.15)
- z-index: 1000
- Animation: slideIn 0.3s ease-out

---

## User Interaction Flow

```
1. User clicks [Assign Rooms]
   ↓
2. Assignment mode activates
   - Staff pills appear
   - Auto-Assign button appears
   - First staff member auto-selected
   ↓
3. User can:
   a) Click staff pill to select different person
   b) Click room to assign/unassign
   c) Click [⚡ Auto-Assign] for intelligent distribution
   ↓
4. User reviews assignments (visual verification via room tiles)
   ↓
5. User clicks [Done]
   ↓
6. All assignments batch-saved to Firestore
   ↓
7. Toast: "Assignments saved"
   ↓
8. Exit assignment mode
   ↓
9. Color dots now visible on all assigned rooms
```

---

## Button Styles Reference

### [Assign Rooms] Button (Inactive)
```
Padding: 10px 14px
Background: var(--bg-input) [light gray]
Color: var(--text-primary) [dark gray]
Border: 1px solid var(--border)
Border-radius: var(--radius-md)
Font-size: 14px
Font-weight: 600
Cursor: pointer
Transition: all 0.2s
```

### [Assign Rooms] / [Done] Button (Active in Assignment Mode)
```
Padding: 10px 14px
Background: #2563EB [blue]
Color: #FFFFFF [white]
Border: none
Border-radius: var(--radius-md)
Font-size: 14px
Font-weight: 600
Cursor: pointer
Transition: all 0.2s
```

### [⚡ Auto-Assign] Button
```
Padding: 10px 14px
Background: #F59E0B [amber/orange]
Color: #FFFFFF [white]
Border: none
Border-radius: var(--radius-md)
Font-size: 13px
Font-weight: 600
Cursor: pointer
Display: flex
Gap: 6px (icon + text)
Transition: all 0.2s
```

---

## Responsive Behavior

- **Staff pills**: Horizontally scrollable on mobile via `overflowX: 'auto'`
- **Room grid**: Existing flex-wrap layout preserved
- **Buttons**: Full width or flex as before
- **Toast**: Fixed position, bottom-right corner (visible on all screen sizes)

---

## Accessibility Notes

- Room tiles show title attribute with full assignment info
- Pill buttons have clear visual feedback (color change, border)
- Toast provides visual confirmation of save
- All text is readable at standard font sizes
- Color is not the only indicator (status + color + initial)
