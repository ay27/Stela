# Product Hunt screenshot checklist

Use the real Stela desktop app with `examples/demo-vault`; do not use synthetic
HTML mockups for the Product Hunt gallery source shots.

`gallery.html` wraps the real screenshots below in four fixed `1270 × 760`
marketing cards. Open it in Chrome and capture one `.artboard` at a time.

## Capture marketing cards

1. Open `docs/producthunt/gallery.html` in Chrome (file URL is fine).
2. Set zoom to **100%**.
3. Capture each `.artboard` at exactly **1270 × 760** (DevTools node
   screenshot, or a window-capture tool clipped to the card).
4. Upload the four PNGs to the Product Hunt gallery in the same order as below.

## Before taking source screenshots

1. Run `cd examples/demo-vault && docker compose up -d`.
2. Open the folder as a Stela vault, use English and the light theme.
3. Run every SQL block in `notes/weekly-release-health.md`.
4. Crop the editor title bar if it exposes the local absolute vault path.

## Gallery sequence

1. **Markdown + RunSQL + Agent** (`showall.png`) — Open
   `weekly-release-health.md`; show the Markdown narrative, executed SQL
   result, unfinished ghost query, and the right Agent sidebar.
2. **Data Agent** (`edit_approve.png`) — Collapse the left sidebar, widen the
   Agent sidebar, and ask:
   `Why did open tasks rise after the rollout? Cite SQL evidence.`
   Capture the real tool timeline and final response.
3. **Experience Knowledge** (`knowledge_management.png`) — Open **Experience
   Knowledge** from the bottom dock while `weekly-release-health.md` is
   visible behind it. Show the `open-task-triage` skill; if the Agent saved a
   skill in this session, also expand its Brain maintenance indicator.
4. **Connections and plugins** (`plugin_for_connector.png`) — In Settings,
   capture the two local demo connections with a successful test, then the
   real Connector Plugins tab with its installed MySQL/PostgreSQL connectors
   and installation controls.
