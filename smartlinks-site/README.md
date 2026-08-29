# FablePeak public SmartLinks renderer

This directory is the canonical source for the public SmartLinks page described in
[ADR 0004](../docs/adr/0004-public-smartlinks.md) (as amended by its "Decisions (2026-08-29)"
section): edit it here in the FablePeak repo, then mirror the folder contents to the separate
`ttropolis/links-fablepeak` GitHub Pages repo, which serves <https://links.fablepeak.com> from a
deliberately different origin to the authenticated app on `fablepeak.com` so that a DOM-XSS bug in
this anonymously-rendered, tenant-authored page can never reach a signed-in user's session. The
site is three static files with no build step and no dependencies — `index.html` (the whole
renderer: it reads `?b=<slug>`, calls the anon `get_smartlink` RPC over plain `fetch`, and records
clicks through `record_smartlink_click`), `404.html`, and `CNAME` — and deployment additionally
requires the DNS record `CNAME links.fablepeak.com → ttropolis.github.io`, plus "Enforce HTTPS"
enabled on the Pages site once the certificate is issued; without that DNS record GitHub Pages
will not serve the custom domain and the canonical URL `https://links.fablepeak.com/?b=<slug>`
will not resolve.
