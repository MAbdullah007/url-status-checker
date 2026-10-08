# Bulk URL Status Checker

Paste up to 100 URLs, get every HTTP status code in one go — 404s highlighted,
redirect chains traced, CSV export included. A self-hosted alternative to
httpstatus.io, built for bulk checks.

## How it works

`api/check.js` is a serverless function: it requests each URL **from the
server** (like httpstatus.io does) and returns the real status code, final URL
after redirects, response time, and the full redirect chain. Server-side
checking means no browser CORS limits.

Anti-bot handling: each URL is tried first with a lightweight HEAD request,
then retried with full desktop-browser headers when a site rejects automated
checks. A persistent 403/429 is labeled **"Needs verify"** — never misreported
as the page's real status.

The frontend (`index.html`) sends URLs in batches of 15 per API call, so even
100 URLs stay comfortably inside serverless execution limits.

## Deploy (Vercel)

1. Push this folder to a GitHub repo.
2. Vercel dashboard → Add New → Project → Import the repo → Deploy.
3. Every future `git push` redeploys automatically.

No environment variables, no build step, no dependencies.
