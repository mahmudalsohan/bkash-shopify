// Minimal HTML pages shown to the customer after the bKash redirect.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Tone = "success" | "error" | "info";

export function page(opts: {
  tone: Tone;
  title: string;
  message: string;
  details?: [string, string][];
  action?: { href: string; label: string };
  secondary?: { href: string; label: string };
  status?: number;
}): Response {
  const color = { success: "#1a7f37", error: "#c62828", info: "#e2136e" }[opts.tone];
  const icon = { success: "✓", error: "!", info: "i" }[opts.tone];
  const details = (opts.details ?? [])
    .map(([k, v]) => `<div class="row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`)
    .join("");
  const btn = (a: { href: string; label: string } | undefined, cls: string) =>
    a ? `<a class="${cls}" href="${esc(a.href)}">${esc(a.label)}</a>` : "";

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; background:#f6f6f7; color:#202223;
         display:grid; place-items:center; min-height:100vh; padding:16px; box-sizing:border-box; }
  @media (prefers-color-scheme: dark) { body { background:#111; color:#eee; } .card { background:#1c1c1e !important; } }
  .card { background:#fff; border-radius:16px; padding:32px 24px; max-width:420px; width:100%; text-align:center;
          box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .icon { width:56px; height:56px; border-radius:50%; margin:0 auto 16px; display:grid; place-items:center;
          font-size:28px; font-weight:700; color:#fff; background:${color}; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 20px; opacity:.8; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid rgba(128,128,128,.2); font-size:14px; }
  .row:last-of-type { border-bottom:1px solid rgba(128,128,128,.2); margin-bottom:20px; }
  a.btn { display:block; background:#e2136e; color:#fff; text-decoration:none; padding:12px; border-radius:10px; font-weight:600; }
  a.link { display:block; margin-top:12px; color:inherit; opacity:.7; font-size:14px; }
</style></head>
<body><main class="card">
  <div class="icon">${icon}</div>
  <h1>${esc(opts.title)}</h1>
  <p>${esc(opts.message)}</p>
  ${details}
  ${btn(opts.action, "btn")}
  ${btn(opts.secondary, "link")}
</main></body></html>`;

  return new Response(html, {
    status: opts.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
