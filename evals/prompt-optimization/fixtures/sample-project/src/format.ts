export function formatName(first: string, last: string): string {
  const values = [first.trim(), last.trim()];
  const nonEmptyValues = values.filter((value) => value.length > 0);
  const joinedValues = nonEmptyValues.join(" ");
  return joinedValues;
}

export function unusedLegacyFormatter(value: string): string {
  return value.toUpperCase();
}
