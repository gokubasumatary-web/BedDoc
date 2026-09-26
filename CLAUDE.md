# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Run locally (from the project root)
python backend/app.py --width 1280 --height 400 --skip 3
# Dashboard: http://localhost:8080
# Add --agent bed-guardian to trigger the TrueForge agent on risky states

# AI layer
python trueforge/mcp_server.py                                  # MCP bridge, :8000/mcp
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest   # :8790
python trueforge/setup_agent.py --model anthropic/claude-sonnet-5   # register connector + agent

# Deploy to Pi and restart service
bash deploy/deploy.sh

# Check service on Pi
sudo systemctl status beddoc
sudo journalctl -u beddoc -f
```

## Architecture

**BedDoc** — single-patient bed occupancy monitor deployed on Raspberry Pi 4. No person tracking IDs — the system monitors one patient only, always picking the highest-confidence YOLO detection.

**Data flow:** Camera → YOLO inference (every N frames) → StateEngine → Flask API → browser dashboard. Optional: risky state → `AgentTrigger` → TrueForge `bed-guardian` agent → MCP tools → `report_verdict` → dashboard.

**Layout:** `backend/` (Python, run as `python backend/app.py` — modules import each other flat, no package), `frontend/` (Flask `templates/` + `static/`), `trueforge/` (separate processes), `config/`, `models/`, `deploy/`, `docs/`. All filesystem paths come from `backend/paths.py`, resolved from the project root — never use cwd-relative paths.

**Module responsibilities:**

- `backend/app.py` — Flask entry point. Starts `run_detector()` in a daemon thread, owns the `DetectorState` singleton and the optional `AgentTrigger`, exposes API routes.
- `backend/detector.py` — Camera loop. `DetectorState` is a thread-safe container (frame buffer + zone list + `StateEngine` ref + latest agent verdict). `run_detector()` handles camera reconnection (USB reset on every 3rd failure), YOLO inference with frame skipping, and overlay drawing. Weights load from `models/`.
- `backend/tracker.py` — `StateEngine`: 4-state machine (`ON BED → AT EDGE → GETTING OUT → OFF BED`) with per-state debounce and grace timers. `on_state_change(prev, new)` callback fires from `_commit()` under the engine lock — must not block.
- `backend/zone_manager.py` — Persists zones to `config/config.json`; auto-generates `near_polygon` via OpenCV dilation. Edge polygon is drawn manually in the dashboard.
- `backend/agent_trigger.py` — Starts TrueForge sessions in a background thread (20 s cooldown, one run at a time), polls the async turn to completion, keeps run history for the dashboard.
- `frontend/templates/index.html` + `frontend/static/{css,js}/dashboard.*` — Single-page dashboard. Polls `/api/status` every second; renders MJPEG from `/stream`. Zone drawing is client-side.
- `trueforge/mcp_server.py` — MCP server (`beddoc`) wrapping the Flask API as agent tools; `BEDDOC_URL` points it at the backend.
- `trueforge/setup_agent.py` — Registers the MCP connector, optional Anthropic provider, and the `bed-guardian` agent via TrueForge's REST API.

## Key Tunables

| Constant | Location | Default | Effect |
|---|---|---|---|
| `CONF_THRESHOLD` | `backend/detector.py` | 0.15 | Lower → detect more (more false positives) |
| `DEBOUNCE` | `backend/tracker.py` | 10/4/3/3 frames | Higher → slower but stabler state changes |
| `GRACE_SAFE` / `GRACE_AT_RISK` | `backend/tracker.py` | 8 s / 5 s | Unseen time before OFF BED |
| `NEAR_OFFSET` | `backend/zone_manager.py` | 120 px | Width of near zone around bed |
| `COOLDOWN_S` | `backend/agent_trigger.py` | 20 s | Min gap between automatic agent runs |
| `--skip` | CLI arg | 3 | Run YOLO every N frames; higher = faster video, less accurate |

## Known Issues / Roadmap

- **False AT EDGE** when patient sits at top of bed due to camera angle — the TrueForge verifier agent is the mitigation; state logic still needs tuning
- **Nurse proximity detection** (T2 feature) — not yet implemented
- **MQTT alerts** to KuboCare backend — not yet implemented

## Deployment Target

Pi hostname `kcpi2508-l-027`, Tailscale. `deploy/deploy.sh` copies `backend/` + `frontend/` to `/home/pi/BedDoc` and restarts the `beddoc` systemd service. Full hardware details in `docs/CONTEXT.md`.
