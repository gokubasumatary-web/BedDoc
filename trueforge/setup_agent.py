"""
setup_agent.py — register BedDoc with a local TrueForge instance.

    python trueforge/setup_agent.py                               # MCP connector only
    python trueforge/setup_agent.py --model anthropic/claude-sonnet-5   # + bed-guardian agent
    python trueforge/setup_agent.py --anthropic                          # + Anthropic provider from $ANTHROPIC_API_KEY, agent on claude-sonnet-5

The model must already be configured in TrueForge (Settings → Models);
list the available ones with:  python trueforge/setup_agent.py --list-models
"""
import argparse, os, sys
import requests

MCP_NAME   = "beddoc"
AGENT_NAME = "bed-guardian"

INSTRUCTIONS = """You are a bedside safety agent for a single patient. You receive bed-monitor state changes.
1. Always call get_camera_snapshot first and decide whether the patient is really leaving the bed, or only sitting up or shifting.
2. Use get_patient_status and get_event_log for context.
3. Call report_verdict with CONFIRMED, FALSE_ALARM or UNCERTAIN and one short sentence describing what you saw.
4. If the verdict is CONFIRMED and the state is GETTING OUT or OFF BED, notify the nurse with a one-line summary (use a messaging connector if one is attached; otherwise put the summary in your reply).
Never acknowledge alerts unless a human asks you to. Be brief."""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trueforge-url", default="http://localhost:8790")
    ap.add_argument("--mcp-url",       default="http://127.0.0.1:8000/mcp")
    ap.add_argument("--model",         help="Model FQN provider/model for the agent")
    ap.add_argument("--list-models",   action="store_true")
    ap.add_argument("--anthropic",     action="store_true",
                    help="Configure the Anthropic provider from $ANTHROPIC_API_KEY")
    a = ap.parse_args()
    api = a.trueforge_url.rstrip("/") + "/api/v1"

    if a.anthropic:
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            sys.exit("ANTHROPIC_API_KEY is not set")
        model = "claude-sonnet-5"
        r = requests.put(f"{api}/settings/model-providers", timeout=10, json={"manifest": {
            "type": "anthropic", "auth": {"api_key": key},
            "models": [{"model_id": model, "name": model, "properties": {}}],
        }})
        print(f"Anthropic provider: HTTP {r.status_code}")
        if not r.ok:
            sys.exit(r.text)
        a.model = a.model or f"anthropic/{model}"

    if a.list_models:
        for m in requests.get(f"{api}/models", timeout=10).json().get("data", []):
            print(m.get("name") or m)
        return

    r = requests.put(f"{api}/settings/mcp-servers", timeout=10, json={"manifest": {
        "type": "remote", "name": MCP_NAME, "url": a.mcp_url,
        "description": "BedDoc bed-exit monitor: patient state, alerts, event log, "
                       "camera snapshot, and verdict reporting.",
    }})
    print(f"MCP connector '{MCP_NAME}' -> {a.mcp_url}: HTTP {r.status_code}")
    if not r.ok:
        sys.exit(r.text)

    if not a.model:
        print("No --model given; skipping agent. Configure a model in TrueForge, then rerun with --model.")
        return

    body = {"name": AGENT_NAME,
            "description": "Verifies BedDoc bed-exit alerts from the camera image and escalates real exits.",
            "manifest": {
                "model": {"name": a.model, "params": {"temperature": 0.2}},
                "instructions": INSTRUCTIONS,
                "mcp_servers": [{"name": MCP_NAME, "enable_tools": ["@all"], "preload": True,
                                 # the agent runs unattended; only acknowledging needs a human
                                 "require_approval_for_tools": ["acknowledge_alerts"]}],
            }}
    existing = {g["name"]: g["id"] for g in requests.get(f"{api}/agents", timeout=10).json().get("data", [])}
    if AGENT_NAME in existing:
        update = {k: v for k, v in body.items() if k != "name"}   # name is immutable
        r = requests.put(f"{api}/agents/{existing[AGENT_NAME]}", json=update, timeout=10)
    else:
        r = requests.post(f"{api}/agents", json=body, timeout=10)
    print(f"Agent '{AGENT_NAME}' ({a.model}): HTTP {r.status_code}")
    if not r.ok:
        sys.exit(r.text)


if __name__ == "__main__":
    main()
