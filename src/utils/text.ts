export function formatDateTime(timestamp: number, locale?: string): string {
  const formatter = new Intl.DateTimeFormat(locale ?? navigator.language, {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return formatter.format(new Date(timestamp));
}
