"""
agent_trigger.py — BedDoc → TrueForge event trigger
On risky state changes, starts a run of the TrueForge agent (default: bed-guardian)
in a background thread so detection is never blocked.
"""
import threading
import time
from collections import deque
from datetime import datetime
import requests

RISKY_STATES = ("AT EDGE", "GETTING OUT", "OFF BED")
COOLDOWN_S   = 20.0     # min seconds between automatic agent runs (state can flap)


class AgentTrigger:
    def __init__(self, agent_name: str, base_url: str = "http://localhost:8790"):
        self.agent_name = agent_name
        self.base_url   = base_url.rstrip("/")
        self.api        = self.base_url + "/api/v1"
        self._last_run  = 0.0
        self._busy      = threading.Lock()
        self._runs_lock = threading.Lock()
        self.runs       = deque(maxlen=20)   # newest first, shown on the dashboard

    def on_state_change(self, prev: str, new: str):
        """StateEngine callback. Runs under the engine lock — must return immediately."""
        if new not in RISKY_STATES:
            return
        now = time.time()
        if now - self._last_run < COOLDOWN_S:
            return
        self._last_run = now
        threading.Thread(target=self._run, args=(prev, new), daemon=True).start()

    def run_now(self, state: str) -> bool:
        """Manual check from the dashboard. Returns False if a run is already in progress."""
        if self._busy.locked():
            return False
        threading.Thread(target=self._run, args=(None, state), daemon=True).start()
        return True

    def get_runs(self) -> list:
        with self._runs_lock:
            return [dict(r) for r in self.runs]

    def _record(self, run: dict, **fields):
        with self._runs_lock:
            run.update(fields)

    def _run(self, prev, new: str):
        if not self._busy.acquire(blocking=False):
            print("[Agent] run already in progress, skipping")
            return
        run = {"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
               "trigger": f"{prev} → {new}" if prev else f"Manual check ({new})",
               "status": "running", "message": "", "session_id": None}
        with self._runs_lock:
            self.runs.appendleft(run)
        text = (f"Patient state changed {prev} -> {new}. Verify and act." if prev else
                f"Manual check requested by staff. Current state: {new}. Verify and report.")
        try:
            s = requests.post(f"{self.api}/sessions",
                              json={"agent": {"name": self.agent_name}}, timeout=10)
            s.raise_for_status()
            sid = s.json()["data"]["id"]
            self._record(run, session_id=sid)
            print(f"[Agent] {run['trigger']}: session {sid} started")
            r = requests.post(f"{self.api}/sessions/{sid}/turns", json={
                "stream": False,
                "input": [{"type": "user.message", "content": text}],
            }, timeout=30)
            r.raise_for_status()
            # Turns run asynchronously — poll until done so failures are visible
            tid, status = r.json()["data"]["id"], {}
            deadline = time.time() + 180
            while time.time() < deadline:
                status = requests.get(f"{self.api}/sessions/{sid}/turns/{tid}",
                                      timeout=10).json()["data"]["state"]
                if status.get("status") != "running":
                    break
                time.sleep(2)
            final = status.get("status", "timeout")
            if final == "running":
                final = "timeout"
            self._record(run, status=final, message=(status.get("message") or "")[:300])
            print(f"[Agent] session {sid} turn {final}"
                  + (f": {status['message'][:200]}" if status.get("message") else ""))
        except Exception as e:
            self._record(run, status="error", message=str(e)[:300])
            print(f"[Agent] trigger failed: {e}")
        finally:
            self._busy.release()
