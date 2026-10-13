import { GRAPHITE, STATIC_PAGE_COLOR_VARIABLES } from './brand-palette.js';

const pageShell = (title: string, heading: string, message: string, status: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${STATIC_PAGE_COLOR_VARIABLES}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--page);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:560px;text-align:center}.status{color:var(--stone);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}h1{margin:16px 0 0;font-size:clamp(40px,8vw,64px);line-height:1.05;font-weight:700;letter-spacing:-.04em}p.message{margin:20px auto 0;max-width:440px;color:var(--stone);font-size:15px;line-height:1.6}.footer{margin-top:48px;color:var(--stone);font-size:12px}.footer a{color:inherit;text-decoration:none}.footer a:hover{text-decoration:underline}</style></head><body><main><section><div class="status">${status}</div><h1>${heading}</h1><p class="message">${message}</p></section><div class="footer">Powered by <a href="https://opfield.dev" rel="noopener noreferrer">Opfield</a></div></main></body></html>`;

export const OPFIELD_NOT_FOUND_HTML = pageShell(
  'Page not found',
  'Page not found',
  'The requested host or page is not available.',
  'Error 404'
);

const EXTERNAL_BRANDING_HTML = 'Powered by <a href="https://opfield.dev" rel="noopener noreferrer">Opfield</a>';

const MAINTENANCE_ACCESS_LINK_HTML = '<a class="access" href="#access" id="maintenance-access-link">Team access</a>';

/**
 * Redeems an access code. A rejected code is 403 (202 from nginx daemons before 2.11.1); anything else means the code
 * could not be checked.
 */
const MAINTENANCE_ACCESS_SCRIPT = `<script>(()=>{const link=document.getElementById('maintenance-access-link');const error=document.getElementById('maintenance-access-error');const show=text=>{error.textContent=text;error.hidden=false};link.addEventListener('click',async e=>{e.preventDefault();const code=window.prompt('Access code')?.trim();if(!code)return;error.hidden=true;try{const r=await fetch('/_opfield/maintenance-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});if(r.status===204){window.location.reload();return}show(r.status===403||r.status===202?'This access code is not valid or has expired.':'The access code could not be checked. Try again.')}catch{show('The access code could not be checked. Try again.')}})})();</script>`;

/**
 * The maintenance page. `teamAccess` offers the access-code form; a route whose config cannot carry the access-code
 * bypass gets the page without it.
 */
function maintenancePageHtml(teamAccess: boolean, hideExternalBranding: boolean): string {
  const footer = [teamAccess ? MAINTENANCE_ACCESS_LINK_HTML : '', hideExternalBranding ? '' : EXTERNAL_BRANDING_HTML]
    .filter(Boolean)
    .join('<span aria-hidden="true"> · </span>');
  const access = teamAccess ? '<p class="access-error" id="maintenance-access-error" role="alert" hidden></p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>Maintenance in progress</title><style>${STATIC_PAGE_COLOR_VARIABLES}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--page);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:560px;text-align:center}.status{color:var(--stone);font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}h1{margin:16px 0 0;font-size:clamp(40px,8vw,64px);line-height:1.05;font-weight:700;letter-spacing:-.04em}p.message{margin:20px auto 0;max-width:440px;color:var(--stone);font-size:15px;line-height:1.6}.footer{margin-top:48px;color:var(--stone);font-size:12px}.footer a,.access{color:inherit;text-decoration:none}.footer a:hover,.access:hover{text-decoration:underline}.access-error{margin:12px 0 0;color:var(--red);font-size:12px}</style></head><body><main><section><div class="status">Temporarily unavailable</div><h1>Maintenance in progress</h1><p class="message">This service is temporarily unavailable while scheduled work is completed. Please try again later.</p></section><div class="footer">${footer}</div>${access}</main>${teamAccess ? MAINTENANCE_ACCESS_SCRIPT : ''}</body></html>`;
}

export const OPFIELD_MAINTENANCE_HTML = maintenancePageHtml(true, false);

export function opfieldNotFoundHtml(hideExternalBranding = false): string {
  if (!hideExternalBranding) return OPFIELD_NOT_FOUND_HTML;
  return OPFIELD_NOT_FOUND_HTML.replace(`<div class="footer">${EXTERNAL_BRANDING_HTML}</div>`, '');
}

/**
 * Served by the ingress node for a status page route while Opfield cannot answer and no earlier copy of the page is
 * cached yet (a cached copy is served instead whenever there is one). It reloads itself, so a visitor sees the page as
 * soon as Opfield is back.
 */
export const OPFIELD_STATUS_PAGE_UNAVAILABLE_HTML = pageShell(
  'Status temporarily unavailable',
  'Back in a moment',
  'The status page is being updated. This page reloads by itself.',
  'Temporarily unavailable'
).replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="refresh" content="15">');

export function opfieldStatusPageUnavailableHtml(hideExternalBranding = false): string {
  if (!hideExternalBranding) return OPFIELD_STATUS_PAGE_UNAVAILABLE_HTML;
  return OPFIELD_STATUS_PAGE_UNAVAILABLE_HTML.replace(`<div class="footer">${EXTERNAL_BRANDING_HTML}</div>`, '');
}

export function opfieldMaintenanceHtml(hideExternalBranding = false, teamAccess = true): string {
  return maintenancePageHtml(teamAccess, hideExternalBranding);
}

export const OPFIELD_RESTARTING_SCRIPT = `(() => {
  const check = async () => {
    try {
      const response = await fetch('/health', {
        cache: 'no-store',
        headers: { 'X-Opfield-Health-Probe': 'restart-page' },
      });
      if (response.ok) {
        const health = await response.json();
        if (!health.lifecycleState || health.lifecycleState === 'running') {
          const page = await fetch(window.location.href, {
            cache: 'no-store',
            headers: { Accept: 'text/html' },
          });
          if (page.ok) {
            window.setTimeout(() => window.location.reload(), 1000);
            return;
          }
        }
      }
    } catch {}
    window.setTimeout(check, 1000);
  };
  window.setTimeout(check, 1000);
})();`;

export const OPFIELD_RESTARTING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <meta name="color-scheme" content="dark">
    <title>Restarting Opfield</title>
    <style>
      *{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:${GRAPHITE.page};color:${GRAPHITE.ink};font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.content{width:100%;max-width:384px;text-align:center}.icon{display:flex;width:48px;height:48px;margin:0 auto 16px;align-items:center;justify-content:center;border:1px solid color-mix(in srgb,${GRAPHITE.amber} 35%,transparent);background:color-mix(in srgb,${GRAPHITE.amber} 6%,transparent);color:${GRAPHITE.amber}}.spinner{width:24px;height:24px;animation:spin .9s linear infinite}h1{margin:0;font-size:18px;line-height:1.4;font-weight:600}p{margin:8px 0 0;color:${GRAPHITE.soft};font-size:14px;line-height:1.55}.footer{margin-top:28px;color:${GRAPHITE.stone};font-size:12px}.footer a{color:${GRAPHITE.soft};text-decoration:none}.footer a:hover{text-decoration:underline}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation-duration:1.8s}}
    </style>
    <script src="/opfield-restarting.js" defer></script>
  </head>
  <body>
    <main class="content">
      <div class="icon" aria-hidden="true"><svg class="spinner" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg></div>
      <h1>Restarting Opfield</h1>
      <p>Opfield is finishing active work before restarting. New actions are temporarily locked.</p>
      <div class="footer">Powered by <a href="https://opfield.dev" rel="noopener noreferrer">Opfield</a></div>
    </main>
  </body>
</html>`;

export function escapeNginxReturnText(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\$/g, '\\$')
    .replace(/[\r\n]+/g, ' ')}'`;
}
