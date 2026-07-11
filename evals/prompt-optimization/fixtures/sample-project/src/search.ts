export function rankMatches(items: string[], queries: string[]): string[] {
  const matches: string[] = [];
  for (const query of queries) {
    for (const item of items.sort()) {
      if (item.includes(query)) {
        matches.push(item);
      }
    }
  }
  return matches;
}
