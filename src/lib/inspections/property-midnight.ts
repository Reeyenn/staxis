/** Compute the UTC instant for today's midnight in an IANA timezone. */
export function propertyMidnightIso(tz: string): string {
  const now = new Date();
  const datePartsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateParts = datePartsFmt.formatToParts(now);
  const get = (parts: Intl.DateTimeFormatPart[], type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const year = get(dateParts, 'year');
  const month = get(dateParts, 'month');
  const day = get(dateParts, 'day');

  const fullFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let iteration = 0; iteration < 4; iteration++) {
    const parts = fullFmt.formatToParts(new Date(utc));
    const observedYear = get(parts, 'year');
    const observedMonth = get(parts, 'month');
    const observedDay = get(parts, 'day');
    let observedHour = get(parts, 'hour');
    const observedMinute = get(parts, 'minute');
    const observedSecond = get(parts, 'second');
    if (observedHour === 24) observedHour = 0;

    if (
      observedYear === year
      && observedMonth === month
      && observedDay === day
      && observedHour === 0
      && observedMinute === 0
      && observedSecond === 0
    ) {
      return new Date(utc).toISOString();
    }
    const observedAsUtc = Date.UTC(
      observedYear,
      observedMonth - 1,
      observedDay,
      observedHour,
      observedMinute,
      observedSecond,
    );
    const targetAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
    utc += targetAsUtc - observedAsUtc;
  }
  return new Date(utc).toISOString();
}
