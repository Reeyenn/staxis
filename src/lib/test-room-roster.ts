/**
 * Stable room numbers for repository-owned test properties.
 *
 * The roster is ten rooms per floor, starting at 101. Keeping the sequence
 * deterministic means a rerun can add only missing natural keys and never
 * replace a room that already exists.
 */
export function buildStandardTestRoomNumbers(totalRooms: number): string[] {
  if (!Number.isInteger(totalRooms) || totalRooms < 1 || totalRooms > 2000) {
    throw new RangeError('totalRooms must be an integer between 1 and 2000');
  }

  return Array.from({ length: totalRooms }, (_, index) => {
    const floor = Math.floor(index / 10) + 1;
    const roomOnFloor = (index % 10) + 1;
    return `${floor}${String(roomOnFloor).padStart(2, '0')}`;
  });
}
