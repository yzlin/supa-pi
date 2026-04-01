export const uniqueStrings = (values: string[]): string[] => [
  ...new Set(values),
];

export const flattenInline = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

export const truncateInline = (value: string, maxLength: number): string => {
  const flattened = flattenInline(value);
  if (flattened.length <= maxLength) {
    return flattened;
  }
  return `${flattened.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};
