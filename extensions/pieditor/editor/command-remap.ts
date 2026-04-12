export function remapCommand(
  text: string,
  commandRemap: Record<string, string>
): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return text;

  const match = trimmed.match(/^\/([^\s:]+)(.*)/s);
  if (!match) return text;

  const [, cmd, rest] = match;
  const target = commandRemap[cmd!];
  return target ? `/${target}${rest}` : text;
}
