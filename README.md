# Metricoolito — your local Metricool prototype

A single-file social media management prototype inspired by [Metricool](https://metricool.com).
No installs, no accounts, no server. One HTML file you fully own.

## How to open it

**Double-click `index.html`.** That's it — it runs in your browser, works offline.

(Optional) To serve it like a website: `python3 -m http.server 4173` in this folder, then open http://localhost:4173.

## What's inside (mirrors Metricool's core features)

| View | What it does |
|------|--------------|
| **Planner** | Monthly content calendar. Click a day to compose a post, pick networks, date/time and status (draft / scheduled / published). Drag posts between days. Scheduled posts auto-flip to "published" when their time passes. |
| **Analytics** | Followers, impressions, engagement KPIs + growth chart, daily engagement bars, and a best-times-to-post heatmap. Filter per network. Demo metrics are generated locally; your published posts boost the numbers. |
| **Inbox** | Unified messages from all networks. Reply, mark resolved, filter All/Unread/Resolved. "Simulate incoming" adds a fake message so you can play. |
| **SmartLinks** | Link-in-bio page builder with live phone preview, click tracking, reorder/add/remove links, custom color and avatar. |
| **Reports** | 30-day performance report per network + published-post log. "Print / Save as PDF" gives you a client-ready file. |
| **Connections** | Simulate connecting Instagram, X, Facebook, LinkedIn, TikTok, YouTube, Pinterest, Google Business profiles. Only connected networks are selectable when posting. |
| **Settings** | Multiple brands (like Metricool brands = one per client), export/import JSON backups, reset demo data. |

## Managing it yourself

- **Where's my data?** In your browser's localStorage, saved automatically on every change. Nothing leaves your machine.
- **Backups:** Settings → *Export backup* downloads a JSON file. *Import backup* restores it. Do this before clearing browser data or switching browsers.
- **Multiple clients:** Settings → add a brand. Each brand has its own calendar, inbox, links and metrics.
- **Move computers:** copy `index.html` + your backup JSON, then import.
- **Start over:** Settings → *Reset to demo*.

## Customizing (it's just one file)

Open `index.html` in any text editor:

- **Colors/theme:** the `:root { ... }` CSS block at the top (`--brand`, `--accent`, etc.).
- **Networks:** the `NETWORKS` array in the script — add or remove platforms.
- **Demo data:** the `seedDemo()` function.

## Limits (it's a prototype)

Posting, connections and metrics are simulated — nothing is published to real social networks. To go real, each network requires its own developer API (Meta Graph API, X API, LinkedIn API…), OAuth and a backend. This file is the full UI/workflow layer you'd put in front of that.
