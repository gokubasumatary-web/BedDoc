"""
app.py — BedDoc Flask server (API + dashboard)

    python backend/app.py --width 1280 --height 400 --skip 3 [--agent bed-guardian]
"""
import argparse, threading, time
from flask import Flask, Response, jsonify, request, render_template
from detector import DetectorState, run_detector
from zone_manager import save_zones, validate_zone, ZONE_COLORS, update_offsets
from agent_trigger import AgentTrigger
from paths import TEMPLATES_DIR, STATIC_DIR

VERDICTS = ("CONFIRMED", "FALSE_ALARM", "UNCERTAIN")

app   = Flask(__name__, template_folder=str(TEMPLATES_DIR), static_folder=str(STATIC_DIR))
state = DetectorState()
agent = None          # AgentTrigger when started with --agent

def generate_stream():
    while True:
        frame = state.get_frame()
        if frame:
            yield (b'--FRAME\r\nContent-Type: image/jpeg\r\n\r\n' + frame + b'\r\n')
        time.sleep(0.033)

@app.route('/stream')
def video_stream():
    return Response(generate_stream(),
                    mimetype='multipart/x-mixed-replace; boundary=FRAME')

@app.route('/api/status')
def api_status():
    snap = state.get_snapshot()
    snap["agent"] = ({"enabled": True, "name": agent.agent_name, "url": agent.base_url,
                      "busy": agent._busy.locked(), "runs": agent.get_runs()}
                     if agent else {"enabled": False})
    return jsonify(snap)

@app.route('/api/agent/run', methods=['POST'])
def api_agent_run():
    if not agent:
        return jsonify({"ok": False, "error": "Agent not enabled (start with --agent)"}), 400
    if not agent.run_now(state.engine.state):
        return jsonify({"ok": False, "error": "Agent is already running"}), 409
    return jsonify({"ok": True})

@app.route('/api/snapshot.jpg')
def api_snapshot():
    frame = state.get_frame()
    if not frame:
        return jsonify({"ok": False, "error": "No frame yet"}), 503
    return Response(frame, mimetype='image/jpeg')

@app.route('/api/zones', methods=['POST'])
def api_save_zones():
    data  = request.get_json(force=True)
    zones = data.get("zones", [])
    if not zones:
        return jsonify({"ok": False, "error": "No zones"}), 400
    for z in zones:
        if not validate_zone(z):
            return jsonify({"ok": False, "error": f"Invalid zone"}), 400
    save_zones(zones)
    state.reload_zones()
    return jsonify({"ok": True})

@app.route('/api/zones/<zone_id>', methods=['DELETE'])
def api_delete_zone(zone_id):
    current = state.get_zones()
    updated = [z for z in current if z.get("id") != zone_id]
    save_zones(updated)
    state.reload_zones()
    return jsonify({"ok": True})

@app.route('/api/zone-settings', methods=['POST'])
def api_zone_settings():
    data = request.get_json(force=True)
    edge = max(20,  min(150, int(data.get("edge_offset", 50))))
    near = max(50,  min(300, int(data.get("near_offset", 120))))
    update_offsets(edge, near)
    state.reload_zones()
    return jsonify({"ok": True})

@app.route('/api/acknowledge', methods=['POST'])
def api_acknowledge():
    state.engine.acknowledge_alert()
    return jsonify({"ok": True})

@app.route('/api/agent-verdict', methods=['POST'])
def api_agent_verdict():
    data    = request.get_json(force=True)
    verdict = str(data.get("verdict", "")).upper()
    if verdict not in VERDICTS:
        return jsonify({"ok": False, "error": f"verdict must be one of {VERDICTS}"}), 400
    reason  = str(data.get("reason", ""))[:500]
    v = state.set_agent_verdict(verdict, reason, state.engine.state)
    print(f"[Agent] verdict {verdict} for {v['for_state']}: {reason}")
    return jsonify({"ok": True, "verdict": v})

@app.route('/api/test-mode', methods=['POST'])
def api_test_mode():
    data = request.get_json(force=True)
    active = bool(data.get("active", False))
    if active:
        state.test_log.clear()
    state.test_mode = active
    return jsonify({"ok": True, "test_mode": state.test_mode})

@app.route('/api/test-log')
def api_test_log():
    return jsonify({"log": list(state.test_log)})

@app.route('/')
def index():
    return render_template('index.html')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--camera', type=int, default=0)
    parser.add_argument('--model',  type=str, default='yolov8n')
    parser.add_argument('--skip',   type=int, default=2)
    parser.add_argument('--width',  type=int, default=1280)
    parser.add_argument('--height', type=int, default=400)
    parser.add_argument('--port',   type=int, default=8080)
    parser.add_argument('--agent',  type=str, default=None,
                        help='TrueForge agent to run on risky state changes (e.g. bed-guardian)')
    parser.add_argument('--trueforge-url', type=str, default='http://localhost:8790')
    args = parser.parse_args()

    global agent
    if args.agent:
        agent = AgentTrigger(args.agent, args.trueforge_url)
        state.engine.on_state_change = agent.on_state_change
        print(f"[Agent] TrueForge trigger on: {args.agent} @ {args.trueforge_url}")

    t = threading.Thread(
        target=run_detector,
        kwargs=dict(state=state, model_name=args.model,
                    camera_index=args.camera, frame_skip=args.skip,
                    width=args.width, height=args.height),
        daemon=True
    )
    t.start()
    print(f"\n=== BedDoc === http://0.0.0.0:{args.port}\n")
    app.run(host='0.0.0.0', port=args.port, threaded=True, debug=False)

if __name__ == '__main__':
    main()
