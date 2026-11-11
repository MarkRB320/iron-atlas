// The builder prepends the allowlisted asset map and the public project origin.
const types = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8', txt: 'text/plain; charset=utf-8',
  png: 'image/png', woff2: 'font/woff2',
};
const unavailable = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page unavailable · Iron Atlas</title><main><h1>Page unavailable</h1><a href="/">Iron Atlas support</a></main></html>';
export default {
  async fetch(request) {
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src " + backend + "; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'",
    });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      headers.set('Allow', 'GET, HEAD');
      return new Response(null, {status: 405, headers});
    }
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/') && Object.hasOwn(files, url.pathname + '/index.html')) {
      url.pathname += '/';
      headers.set('Location', url.href);
      return new Response(null, {status: 308, headers});
    }
    const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    const file = Object.hasOwn(files, path) && files[path];
    headers.set('Content-Type', file ? types[path.split('.').pop()] : types.html);
    let body = null;
    if (request.method === 'GET') {
      body = file ? file.body : unavailable;
      if (file && file.binary) body = Uint8Array.from(atob(body), char => char.charCodeAt(0));
    }
    return new Response(body, {status: file ? 200 : 404, headers});
  },
};
