/**
 * UTF-8-safe base64 of a vars object for a composition preview's `?vars=` query.
 * Headlines/body can contain non-Latin-1 characters that plain
 * `btoa(JSON.stringify(...))` throws on, so encode through TextEncoder first.
 * Shared by the Studio create page (module preview) and the projects detail
 * dialog (project preview with unsaved template-parameter overrides).
 */
export function b64UrlVars(vars: Record<string, string>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(vars));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return encodeURIComponent(btoa(bin));
}
