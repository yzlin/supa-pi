export function canAccessAdminPanel(role: string, debug: boolean): boolean {
  if (debug) {
    return true;
  }
  return role === "admin";
}
