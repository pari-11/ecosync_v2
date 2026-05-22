from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from datetime import datetime, timezone
import httpx
import uvicorn
import os
from pydantic import BaseModel
from typing import Optional

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

app.mount("/icons", StaticFiles(directory=os.path.join(BASE_DIR, "extension", "icons")), name="icons")
app.mount("/website", StaticFiles(directory=os.path.join(BASE_DIR, "extension", "website"), html=True), name="website")


class DownloadCommand(BaseModel):
    action: str
    download_id: Optional[int] = None


@app.get("/")
async def root():
    return RedirectResponse(url="/website/main.html")


ELECTRICITY_MAPS_TOKEN = "xkTxNfwG6jWHDK6XrFbn"
BLUEHANDS_API_KEY = "vO+osrpmYEOFDPY69SZRd8YliMyMkFmJS7285Hpq5KEL8T3Tg8E2AswFmuTtMWODCMh+pPssC7QnOib7vvkI2w=="


latest_state = {
    "tabs": [],
    "sessionCO2": 0,
    "heavyCount": 0,
    "totalPower": 0,
    "co2Rate": 0,
    "pollingRequests60s": 0,
    "zombieCO2": 0,
    "updatedAt": None
}

downloads_state = {
    "gridState": "unknown",
    "current": None,
    "deferred": [],
    "ledger": [],
    "savedCO2": 0,
    "cancelledCount": 0
}


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
        "download_id": cmd.download_id
    }
    return {"ok": True}


@app.get("/api/carbon/live/{zone}")
async def live_carbon(zone: str):
    try:
        if zone == "in":
            url = "https://api.electricitymap.org/v3/carbon-intensity/past"
            params = {
                "zone": "IN-WE",
                "datetime": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
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
                "timestamp": datetime.now().isoformat()
            }

    except HTTPException:
        raise
    except Exception:
        return {
            "zone": zone,
            "intensity": 0,
            "trafficLight": "unknown",
            "timestamp": datetime.now().isoformat(),
            "error": "API timeout — retrying next refresh"
        }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)