# BedDoc 🛏️

**Real-time bed-exit monitoring for a single patient**, running on a Raspberry Pi 4 with a USB camera and YOLOv8, with an optional **AI agent (TrueForge + Claude)** that checks the camera image and confirms or dismisses each alert.

Built for **KuboCare** senior-care technology.

---

## How it works

```
USB camera ─► YOLOv8 (person box) ─► State engine ─► Flask API ─► Dashboard (browser)
                                          │
                                          └─ risky state ─► TrueForge agent ─► looks at snapshot
                                                                 │                 via MCP tools
                                                                 └─► verdict shown on dashboard
```

1. **Detect** — YOLOv8 finds the patient (highest-confidence person, no tracking IDs).
2. **Locate** — head, torso and foot points are checked against the bed / edge / near zones.
3. **Decide** — a 4-state machine with debounce and grace timers:

| State | Colour | Alert level | Meaning |
|---|---|---|---|
| ON BED | 🟢 green | none | Torso inside the bed zone |
| AT EDGE | 🟠 amber | warning | Patient moved into the edge zone |
| GETTING OUT | 🟠 orange | alert | In the edge zone and not lying flat |
| OFF BED | 🔴 red | critical | Outside all zones, or not seen for the grace period |

4. **Verify (optional)** — on AT EDGE / GETTING OUT / OFF BED, the `bed-guardian` agent in TrueForge fetches the live snapshot, decides **CONFIRMED / FALSE_ALARM / UNCERTAIN**, and posts the verdict back to the dashboard. This targets the main known issue: false AT EDGE when a patient simply sits up.

---

## Project structure

```
BedDoc/
├── backend/                  # Python — detection, state machine, API
│   ├── app.py                #   Flask server: dashboard, MJPEG stream, REST API (entry point)
│   ├── detector.py           #   Camera loop, YOLO inference, overlay drawing, reconnects
│   ├── tracker.py            #   StateEngine: ON BED → AT EDGE → GETTING OUT → OFF BED
│   ├── zone_manager.py       #   Zone storage + auto-generated near zone
│   ├── agent_trigger.py      #   Starts TrueForge agent runs on risky state changes
│   └── paths.py              #   Project paths (config/, models/, frontend/)
│
├── frontend/                 # Browser dashboard (served by Flask)
│   ├── templates/index.html  #   Page layout
│   └── static/
│       ├── css/dashboard.css #   Styles (dark, responsive)
│       └── js/dashboard.js   #   Polling, zone drawing, alerts, AI panel, test mode
│
├── trueforge/                # AI agent layer
│   ├── mcp_server.py         #   MCP bridge: exposes BedDoc as tools for the agent
│   └── setup_agent.py        #   Registers the connector, model and bed-guardian agent
│
├── config/
│   ├── config.json           #   Saved zones + offsets (created from the dashboard, git-ignored)
│   └── bytetrack.yaml        #   Tracker config (not used — BedDoc runs without tracking)
│
├── models/                   # YOLOv8 weights: yolov8s.pt (default), yolov8n.pt (fallback)
├── deploy/
│   ├── deploy.sh             #   Copy to the Pi and restart the service
│   └── beddoc.service        #   systemd unit
├── docs/
│   ├── DOCUMENTATION.md      #   Full technical documentation
│   └── CONTEXT.md            #   Hardware / deployment notes
├── requirements.txt
└── README.md
```

Services and ports:

| Process | Command | Port |
|---|---|---|
| BedDoc backend + dashboard | `python backend/app.py` | 8080 |
| MCP bridge | `python trueforge/mcp_server.py` | 8000 (`/mcp`) |
| TrueForge | `npx @truefoundry/trueforge@latest` | 8790 |

---

## Quick start (laptop)

Requirements: Python 3.10+, a USB camera. For the AI layer also Node.js ≥ 22.14 and an API key for a vision-capable model.

```bash
python -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
pip install -r requirements.txt

python backend/app.py --width 1280 --height 400 --skip 3
```

Open **http://localhost:8080**.

YOLO weights are loaded from `models/`; if a file is missing, ultralytics downloads it automatically.

### First-time zone setup

1. Click **＋ Bed zone** in the camera header and click the 4+ corners of the mattress.
2. Click the first point to close the shape, then **Save zone**.
3. The dashboard immediately asks for the **edge zone** — draw the danger area around the bed the same way.
4. Adjust the **near zone** width under *Zones* in the right column if needed.

| Try this | Expected state |
|---|---|
| Lie on the mattress | ON BED |
| Move to the side of the bed | AT EDGE |
| Sit up with legs over the side | GETTING OUT |
| Walk out of view | OFF BED (after the grace period) |

---

## AI verification (TrueForge)

Run three processes:

```bash
# 1. Backend with the agent trigger on
python backend/app.py --width 1280 --height 400 --skip 3 --agent bed-guardian

# 2. MCP bridge  (set BEDDOC_URL=http://<pi-ip>:8080 to use the Pi)
python trueforge/mcp_server.py

# 3. TrueForge — its network guard blocks localhost MCP servers unless allowed
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest
```

Then register everything once:

```bash
# Option A: Anthropic key from the environment (configures provider + agent)
ANTHROPIC_API_KEY=... python trueforge/setup_agent.py --anthropic

# Option B: model already added in TrueForge → Settings → Models
python trueforge/setup_agent.py --list-models
python trueforge/setup_agent.py --model <provider/model>
```

The dashboard's **AI verification** panel shows the latest verdict, recent runs (with errors), and a **Check now** button.

Agent tools (MCP):

| Tool | Does |
|---|---|
| `get_patient_status` | Current state, duration, alert level, camera, FPS |
| `get_recent_alerts` / `get_event_log` | History for context |
| `get_camera_snapshot` | Latest annotated JPEG |
| `report_verdict` | Posts CONFIRMED / FALSE_ALARM / UNCERTAIN + reason to the dashboard |
| `acknowledge_alerts` | Requires human approval in TrueForge |

Model calls happen only on risky state changes (at most one run every 20 s). The monitor works fully without the AI layer — just omit `--agent`.

---

## Deploy to the Raspberry Pi

```bash
bash deploy/deploy.sh      # copies backend/ + frontend/ to ~/BedDoc and restarts `beddoc`
```

```bash
sudo systemctl status beddoc
sudo journalctl -u beddoc -f
```

**Migrating a Pi from Bed-Sentry v3** (one time):

```bash
mkdir -p ~/BedDoc/config ~/BedDoc/models
cp ~/bed-sentry-v3/config.json ~/BedDoc/config/          # keep drawn zones
cp ~/bed-sentry-v3/*.pt ~/BedDoc/models/ 2>/dev/null     # keep weights
ln -s /home/pi/bed-sentry/venv ~/BedDoc/venv             # reuse the existing venv
sudo systemctl disable --now bed-sentry-v3
# then from the laptop: bash deploy/deploy.sh ; and on the Pi: sudo systemctl enable beddoc
```

---

## API

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Dashboard |
| `/stream` | GET | MJPEG video stream |
| `/api/status` | GET | State, alerts, log, debug, zones, AI verdict and agent runs |
| `/api/snapshot.jpg` | GET | Latest annotated frame |
| `/api/zones` | POST | Save zones |
| `/api/zones/<id>` | DELETE | Delete a zone |
| `/api/zone-settings` | POST | Set near-zone offset |
| `/api/acknowledge` | POST | Acknowledge alerts |
| `/api/test-mode`, `/api/test-log` | POST / GET | Record a test session |
| `/api/agent-verdict` | POST | Agent posts its verdict |
| `/api/agent/run` | POST | Start an AI check now |

---

## Tuning

| Setting | File | Current | Effect |
|---|---|---|---|
| `CONF_THRESHOLD` | `backend/detector.py` | 0.15 | Lower = more detections, more false positives |
| `DEBOUNCE` | `backend/tracker.py` | 10 / 4 / 3 / 3 frames | Frames before a new state is committed |
| `GRACE_SAFE` / `GRACE_AT_RISK` | `backend/tracker.py` | 8 s / 5 s | Time unseen before OFF BED |
| `NEAR_OFFSET` | `backend/zone_manager.py` | 120 px | Near-zone width (also a dashboard slider) |
| `COOLDOWN_S` | `backend/agent_trigger.py` | 20 s | Minimum gap between automatic AI runs |
| `--skip` | CLI / service | 2–3 | Run YOLO every N frames |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Video frozen / low FPS | Raise `--skip`; check the camera with `v4l2-ctl --list-devices` |
| Zones missing after save | Hard refresh (Ctrl+Shift+R); check `config/config.json` exists |
| Person not detected | Lower `CONF_THRESHOLD`; improve lighting; keep the body in frame |
| False AT EDGE when sitting up | Known issue — enable AI verification, or redraw a tighter edge zone |
| AI panel: "Outbound URL blocked" | Start TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS` (see above) |
| AI panel: "credit balance is too low" | Add credits to the model provider account |

More detail in [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md).

---

## Built with

YOLOv8 (ultralytics) · OpenCV · Flask · Model Context Protocol · TrueFoundry TrueForge · Claude · Raspberry Pi 4
