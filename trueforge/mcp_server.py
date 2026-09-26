"""
mcp_server.py — BedDoc MCP bridge for TrueForge
Exposes the Flask API (app.py) as MCP tools over streamable HTTP.
Runs as a separate process; the detector is untouched.

    python trueforge/mcp_server.py                   # http://127.0.0.1:8000/mcp
    BEDDOC_URL=http://kcpi2508-l-027:8080 python trueforge/mcp_server.py
"""
import os
from typing import Literal
import requests
from mcp.server.mcpserver import MCPServer, Image

BEDDOC_URL = os.environ.get("BEDDOC_URL", "http://127.0.0.1:8080").rstrip("/")
MCP_HOST       = os.environ.get("MCP_HOST", "127.0.0.1")
MCP_PORT       = int(os.environ.get("MCP_PORT", "8000"))
TIMEOUT        = 5

mcp = MCPServer("beddoc")


def _get(path):
    r = requests.get(f"{BEDDOC_URL}{path}", timeout=TIMEOUT)
    r.raise_for_status()
    return r


def _post(path, body=None):
    r = requests.post(f"{BEDDOC_URL}{path}", json=body or {}, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


@mcp.tool()
def get_patient_status() -> dict:
    """Current patient state (ON BED / AT EDGE / GETTING OUT / OFF BED),
    how long it has lasted, alert level, camera status and FPS."""
    s = _get("/api/status").json()
    return {
        "patient_state":    s.get("patient_state"),
        "state_duration_s": s.get("state_duration_s"),
        "alert_level":      s.get("alert_level"),
        "alert_name":       s.get("alert_name"),
        "cam_status":       s.get("cam_status"),
        "fps":              s.get("fps"),
        "motion_score":     s.get("motion_score"),
        "zone_count":       s.get("zone_count"),
        "unacknowledged_alerts": sum(1 for a in s.get("alerts", [])
                                     if not a.get("acknowledged")),
    }


@mcp.tool()
def get_recent_alerts(limit: int = 10) -> list:
    """Most recent alerts (newest first), including whether each was acknowledged."""
    return _get("/api/status").json().get("alerts", [])[:max(1, min(limit, 20))]


@mcp.tool()
def get_event_log(limit: int = 30) -> list:
    """Recent state-change log entries (newest first)."""
    return _get("/api/status").json().get("log", [])[:max(1, min(limit, 100))]


@mcp.tool()
def acknowledge_alerts() -> dict:
    """Mark the latest alerts as acknowledged (same as the dashboard button)."""
    return _post("/api/acknowledge")


@mcp.tool()
def get_camera_snapshot() -> Image:
    """Latest annotated camera frame (JPEG) with zones and detection overlay."""
    return Image(data=_get("/api/snapshot.jpg").content, format="jpeg")


@mcp.tool()
def report_verdict(verdict: Literal["CONFIRMED", "FALSE_ALARM", "UNCERTAIN"], reason: str) -> dict:
    """Record your judgement of the current alert on the dashboard.
    CONFIRMED = patient is really leaving the bed; FALSE_ALARM = only sitting up,
    shifting or otherwise safe; UNCERTAIN = the image does not allow a decision.
    reason: one short sentence describing what you saw."""
    return _post("/api/agent-verdict", {"verdict": verdict, "reason": reason})


if __name__ == "__main__":
    print(f"=== BedDoc MCP === http://{MCP_HOST}:{MCP_PORT}/mcp -> {BEDDOC_URL}")
    mcp.run(transport="streamable-http", host=MCP_HOST, port=MCP_PORT)
