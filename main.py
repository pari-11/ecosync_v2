from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from datetime import datetime, timezone
import httpx
import uvicorn
import os
from pydantic import BaseModel
from typing import Optional, List, Literal


app = FastAPI(title="EcoSync Carbon API")
pending_download_command = None


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app.mount(
    "/icons",
    StaticFiles(directory=os.path.join(BASE_DIR, "extension", "icons")),
    name="icons",
)
app.mount(
    "/website",
    StaticFiles(directory=os.path.join(BASE_DIR, "extension", "website"), html=True),
    name="website",
)


class DownloadCommand(BaseModel):
    action: str
    download_id: Optional[int] = None


@app.get("/")
async def root():
    return RedirectResponse(url="/website/main.html")


ELECTRICITY_MAPS_TOKEN = "fm2hJUymqumtbGPYUQwx"
BLUEHANDS_API_KEY = "vO+osrpmYEOFDPY69SZRd8YliMyMkFmJS7285Hpq5KEL8T3Tg8E2AswFmuTtMWODCMh+pPssC7QnOib7vvkI2w=="


latest_state = {
    "tabs": [],
    "sessionCO2": 0,
    "heavyCount": 0,
    "totalPower": 0,
    "co2Rate": 0,
    "pollingRequests60s": 0,
    "zombieCO2": 0,
    "updatedAt": None,
}


downloads_state = {
    "gridState": "unknown",
    "current": None,
    "deferred": [],
    "ledger": [],
    "savedCO2": 0,
    "cancelledCount": 0,
}

# ---------------- Eco‑Scheduler models & state ----------------

PriorityTier = Literal["high", "medium", "low"]
TaskStatus = Literal["pending", "completed"]
TaskMode = Literal["online", "offline"]


class EcoTaskCreate(BaseModel):
  title: str
  description: str
  priority: PriorityTier
  tags: List[str] = []
  estimated_minutes: Optional[int] = None


class EcoTask(EcoTaskCreate):
  id: int
  mode: TaskMode
  status: TaskStatus
  recommended_window: str
  eco_note: str
  created_at: datetime
  completed_at: Optional[datetime] = None


eco_tasks: List[EcoTask] = []
_next_task_id = 1


ONLINE_KEYWORDS = [
  "download",
  "upload",
  "sync",
  "video call",
  "zoom",
  "meet",
  "stream",
  "streaming",
  "git push",
  "push",
  "cloud backup",
  "backup",
  "watch",
  "update",
]
OFFLINE_KEYWORDS = [
  "write",
  "code",
  "read",
  "review",
  "brainstorm",
  "document",
  "sketch",
  "organize",
  "research",
]


def classify_task_mode(title: str, description: str, tags: List[str]) -> TaskMode:
  text = " ".join([title, description, " ".join(tags)]).lower()
  tags_lower = [t.lower() for t in tags]

  # explicit tag wins
  if "online" in tags_lower:
    return "online"
  if "offline" in tags_lower:
    return "offline"

  if any(kw in text for kw in ONLINE_KEYWORDS):
    return "online"
  if any(kw in text for kw in OFFLINE_KEYWORDS):
    return "offline"
  return "offline"


def get_recommended_window_and_note(mode: TaskMode, current_intensity: float) -> tuple[str, str]:
  now = datetime.now()
  hour = now.hour

  if mode == "online":
    if current_intensity <= 200:
      start = now.replace(minute=0, second=0, microsecond=0)
      end = start.replace(hour=start.hour + 2 if start.hour <= 21 else 23)
      label = f"{start.strftime('%I:%M %p')} – {end.strftime('%I:%M %p')} (Grid currently clean)"
    elif current_intensity <= 400:
      start = now.replace(hour=22, minute=0, second=0, microsecond=0)
      if hour >= 22:
        start = start.replace(day=start.day + 1)
      end = start.replace(hour=start.hour + 2)
      label = f"{start.strftime('%I:%M %p')} – {end.strftime('%I:%M %p')} (Likely lower intensity)"
    else:
      start = now.replace(hour=3, minute=0, second=0, microsecond=0)
      if hour >= 3:
        start = start.replace(day=start.day + 1)
      end = start.replace(hour=start.hour + 2)
      label = f"{start.strftime('%I:%M %p')} – {end.strftime('%I:%M %p')} (Cleaner valley window)"

    note = "⚡ Online task — align with the suggested green window for lower emissions."
    return label, note

  if current_intensity >= 400:
    note = "🍃 Perfect time for offline focus — the grid is under stress, so local work saves energy."
  else:
    note = "🍃 Offline deep work — great for steady progress with low network demand."

  return "Anytime in your focus block", note


# ---------------- Eco‑Scheduler endpoints ----------------


@app.get("/api/scheduler/tasks", response_model=List[EcoTask])
async def list_tasks():
  # Sort by priority, then mode (online first), then created_at
  priority_order = {"high": 0, "medium": 1, "low": 2}
  mode_order = {"online": 0, "offline": 1}
  return sorted(
    eco_tasks,
    key=lambda t: (
      priority_order.get(t.priority, 1),
      mode_order.get(t.mode, 1),
      t.created_at,
    ),
  )


@app.post("/api/scheduler/tasks", response_model=EcoTask)
async def create_task(task: EcoTaskCreate):
  global _next_task_id

  try:
    async with httpx.AsyncClient(timeout=10) as client:
      r = await client.get("http://127.0.0.1:8000/api/carbon/live/in")
      data = r.json()
      current_intensity = float(data.get("intensity") or 0.0)
  except Exception:
    current_intensity = 0.0

  mode = classify_task_mode(task.title, task.description, task.tags)
  recommended_window, eco_note = get_recommended_window_and_note(mode, current_intensity)

  new_task = EcoTask(
    id=_next_task_id,
    title=task.title,
    description=task.description,
    priority=task.priority,
    tags=task.tags,
    estimated_minutes=task.estimated_minutes,
    mode=mode,
    status="pending",
    recommended_window=recommended_window,
    eco_note=eco_note,
    created_at=datetime.now(timezone.utc),
    completed_at=None,
  )
  _next_task_id += 1
  eco_tasks.append(new_task)
  return new_task


class TaskStatusUpdate(BaseModel):
  status: TaskStatus


@app.patch("/api/scheduler/tasks/{task_id}", response_model=EcoTask)
async def update_task_status(task_id: int, body: TaskStatusUpdate):
  for t in eco_tasks:
    if t.id == task_id:
      t.status = body.status
      if body.status == "completed":
        t.completed_at = datetime.now(timezone.utc)
      return t
  raise HTTPException(status_code=404, detail="Task not found")


@app.delete("/api/scheduler/tasks/{task_id}")
async def delete_task(task_id: int):
  global eco_tasks
  before = len(eco_tasks)
  eco_tasks = [t for t in eco_tasks if t.id != task_id]
  if len(eco_tasks) == before:
    raise HTTPException(status_code=404, detail="Task not found")
  return {"ok": True}


@app.delete("/api/scheduler/tasks")
async def clear_tasks():
  global eco_tasks, _next_task_id
  eco_tasks = []
  _next_task_id = 1
  return {"ok": True}


# ---------------- existing carbon + downloads endpoints ----------------


@app.post("/api/state")
async def push_state(data: dict):
  global latest_state
  latest_state = data
  return {"ok": True}


@app.get("/api/state")
async def get_state():
  return latest_state


@app.post("/api/downloads/state")
async def push_downloads_state(data: dict):
  global downloads_state
  downloads_state = {
    "gridState": data.get("gridState", "unknown"),
    "current": data.get("current"),
    "deferred": data.get("deferred", []),
    "ledger": data.get("ledger", []),
    "savedCO2": data.get("savedCO2", 0),
    "cancelledCount": data.get("cancelledCount", 0),
  }
  return {"ok": True}


@app.get("/api/downloads/state")
async def get_downloads_state():
  return downloads_state


@app.get("/api/downloads/commands")
def get_download_command():
  global pending_download_command

  if pending_download_command is None:
    return {"command": None}

  cmd = pending_download_command
  pending_download_command = None
  return {"command": cmd}


@app.post("/api/downloads/commands")
def post_download_command(cmd: DownloadCommand):
  global pending_download_command

  pending_download_command = {
    "action": cmd.action,
    "download_id": cmd.download_id,
  }
  return {"ok": True}


@app.get("/api/carbon/live/{zone}")
async def live_carbon(zone: str):
  try:
    if zone == "in":
      url = "https://api.electricitymap.org/v3/carbon-intensity/latest"
      params = {
        "zone": "IN-WE",
      }
      headers = {"auth-token": ELECTRICITY_MAPS_TOKEN}
    elif zone == "de":
      url = "https://intensity.carbon-aware-computing.com/emissions/current"
      params = {"location": "de"}
      headers = {"x-api-key": BLUEHANDS_API_KEY}
    else:
      raise HTTPException(status_code=400, detail="Use 'in' or 'de'")

    async with httpx.AsyncClient(timeout=20) as client:
      r = await client.get(url, params=params, headers=headers)
      print("Electricity Maps status:", r.status_code, "body:", r.text)
      data = r.json()
      intensity = data.get("carbonIntensity") or data.get("value") or 0

      if intensity < 200:
        color = "green"
      elif intensity < 400:
        color = "yellow"
      else:
        color = "red"

      return {
        "zone": zone,
        "intensity": intensity,
        "trafficLight": color,
        "timestamp": datetime.now().isoformat(),
      }

  except HTTPException:
    raise
  except Exception:
    return {
      "zone": zone,
      "intensity": 0,
      "trafficLight": "unknown",
      "timestamp": datetime.now().isoformat(),
      "error": "API timeout — retrying next refresh",
    }

@app.get("/api/carbon/history")
async def carbon_history():
  """
  Past 6h + next 6h carbon intensity trend
  for dashboard graph.
  """

  try:
    headers = {"auth-token": ELECTRICITY_MAPS_TOKEN}

    # ---------------- HISTORY ----------------

    history_url = "https://api.electricitymap.org/v3/carbon-intensity/history"

    async with httpx.AsyncClient(timeout=20) as client:
      history_res = await client.get(
        history_url,
        params={"zone": "IN-WE"},
        headers=headers,
      )

    history_json = history_res.json()

    history_points = history_json.get("history", [])

    # ---------------- FORECAST ----------------

    forecast_url = "https://api.electricitymap.org/v3/carbon-intensity/forecast"

    async with httpx.AsyncClient(timeout=20) as client:
      forecast_res = await client.get(
        forecast_url,
        params={"zone": "IN-WE"},
        headers=headers,
      )

    forecast_json = forecast_res.json()

    forecast_points = forecast_json.get("forecast", [])

    final_points = []

    # Last 6 historical points
    for item in history_points[-6:]:
      final_points.append({
        "time": item.get("datetime", "")[11:16],
        "value": item.get("carbonIntensity", 0),
        "type": "history",
      })

    # Next 6 forecast points
    for item in forecast_points[:6]:
      final_points.append({
        "time": item.get("datetime", "")[11:16],
        "value": item.get("carbonIntensity", 0),
        "type": "forecast",
      })

    # fallback if sandbox blocks data
    if not final_points:
      sample = [540, 525, 500, 470, 455, 430, 400, 370, 340, 320, 290, 260]

      for i, val in enumerate(sample):
        final_points.append({
          "time": f"{i + 6}:00",
          "value": val,
          "type": "forecast" if i >= 6 else "history",
        })

    return {"points": final_points}

  except Exception as e:
    print("History endpoint error:", e)

    return {
      "points": [
        {"time": "06:00", "value": 540},
        {"time": "07:00", "value": 520},
        {"time": "08:00", "value": 500},
        {"time": "09:00", "value": 470},
        {"time": "10:00", "value": 430},
        {"time": "11:00", "value": 390},
        {"time": "12:00", "value": 360},
        {"time": "13:00", "value": 330},
        {"time": "14:00", "value": 300},
        {"time": "15:00", "value": 280},
        {"time": "16:00", "value": 260},
        {"time": "17:00", "value": 240},
      ]
    }


@app.get("/api/carbon/power-breakdown")
async def power_breakdown():
  """
  Live energy source mix
  """

  try:
    headers = {"auth-token": ELECTRICITY_MAPS_TOKEN}

    url = "https://api.electricitymap.org/v3/power-breakdown/latest"

    async with httpx.AsyncClient(timeout=20) as client:
      res = await client.get(
        url,
        params={"zone": "IN-WE"},
        headers=headers,
      )

    data = res.json()

    breakdown = data.get("powerConsumptionBreakdown", {})

    mapped = {
      "Coal": breakdown.get("coal", 0),
      "Solar": breakdown.get("solar", 0),
      "Wind": breakdown.get("wind", 0),
      "Hydro": breakdown.get("hydro", 0),
      "Gas": breakdown.get("gas", 0),
      "Nuclear": breakdown.get("nuclear", 0),
    }

    total = sum(mapped.values())

    if total <= 0:
      raise Exception("Invalid breakdown data")

    sources = []

    for source, value in mapped.items():
      pct = round((value / total) * 100)

      if pct > 0:
        sources.append({
          "source": source,
          "percent": pct,
        })

    sources.sort(key=lambda x: x["percent"], reverse=True)

    return {"sources": sources}

  except Exception as e:
    print("Breakdown endpoint error:", e)

    # fallback data
    return {
      "sources": [
        {"source": "Coal", "percent": 72},
        {"source": "Solar", "percent": 11},
        {"source": "Wind", "percent": 8},
        {"source": "Hydro", "percent": 6},
        {"source": "Gas", "percent": 3},
      ]
    }

if __name__ == "__main__":
  uvicorn.run(app, host="127.0.0.1", port=8000)