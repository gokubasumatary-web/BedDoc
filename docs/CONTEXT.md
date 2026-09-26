# BedDoc Context

## Hardware
- Pi: pi@kcpi2508-l-027, Tailscale IP: 100.83.213.24
- Camera: Jieli USB, /dev/video0, 1280x400 MJPEG
- Service: beddoc.service (was bed-sentry-v3.service), port 8080
- Project dir on Pi: /home/pi/BedDoc (was ~/bed-sentry-v3)
- Venv: /home/pi/BedDoc/venv (symlink to the existing /home/pi/bed-sentry/venv)

## Architecture
- backend/detector.py: YOLO detection, no tracking, picks highest confidence box
- backend/tracker.py: StateEngine, 4 states: ON BED, AT EDGE, GETTING OUT, OFF BED
- backend/zone_manager.py: bed zone storage, auto near zone; edge zone drawn manually
- backend/app.py: Flask server, API routes
- backend/agent_trigger.py: starts TrueForge agent runs on risky states
- frontend/: dashboard (templates/index.html, static/css, static/js)
- trueforge/: MCP bridge + agent setup (runs on the laptop, not the Pi)

## Current Issues
- False AT EDGE alerts when patient sits at top of bed (camera angle)

## Next Tasks
- Fix false AT EDGE alerts (AI verifier agent in place; needs model credits)
- Nurse proximity detection (T2)
- MQTT alerts to KuboCare backend
