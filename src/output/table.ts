function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) &&
    !Number.isNaN(Date.parse(value))
  ) {
    return new Date(value).toLocaleString();
  }
  return (typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(
    /[\r\n\t\x1b]/g,
    ' ',
  );
}
export function table(rows: unknown[]): string {
  if (!rows.length) return '(empty)';
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    return rows.map(cell).join('\n');
  }
  const records = rows as Record<string, unknown>[];
  const keys = [...new Set(records.flatMap(Object.keys))];
  const data = [keys, ...records.map((row) => keys.map((key) => cell(row[key])))];
  const widths = keys.map((_, i) => data.reduce((width, row) => Math.max(width, row[i].length), 0));
  return data
    .map((row) =>
      row
        .map((v, i) => v.padEnd(widths[i]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
export function objectText(value: unknown): string {
  if (!value || typeof value !== 'object') return cell(value);
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${cell(item)}`)
    .join('\n');
}
