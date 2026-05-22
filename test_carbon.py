import httpx
import asyncio
from datetime import datetime, timedelta, timezone

# ── CONFIG ──────────────────────────────────────────────────────────
ELECTRICITY_MAPS_TOKEN = "xkTxNfwG6jWHDK6XrFbn"   # your sandbox token
ZONE = "IN-WE"  # Western India (sandbox zone you selected)
NOW = datetime.now(timezone.utc)
FUTURE = NOW + timedelta(hours=24)
FMT = "%Y-%m-%dT%H:%M:%SZ"

BLUEHANDS_API_KEY = "vO+osrpmYEOFDPY69SZRd8YliMyMkFmJS7285Hpq5KEL8T3Tg8E2AswFmuTtMWODCMh+pPssC7QnOib7vvkI2w=="
BLUEHANDS_LOCATION = "de"

# ─────────────────────────────────────────────────────────────────────

async def test_electricity_maps():
    print("\n===== 1. ELECTRICITY MAPS (SANDBOX) =====")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(
                "https://api.electricitymap.org/v3/carbon-intensity/past",
                params={
                    "zone": ZONE,
                    "datetime": NOW.strftime(FMT)
                },
                headers={"auth-token": ELECTRICITY_MAPS_TOKEN}
            )
            print("Status:", r.status_code)
            print("Response:", r.json())
    except Exception as e:
        print("ERROR:", e)

async def test_bluehands_hosted_sdk():
    print("\n===== 2. BLUEHANDS HOSTED CARBON-AWARE SDK =====")
    headers = {"x-api-key": BLUEHANDS_API_KEY, "accept": "application/json"}

    async with httpx.AsyncClient(timeout=10) as client:
        # Current intensity (working)
        r_cur = await client.get(
            "https://intensity.carbon-aware-computing.com/emissions/current",
            params={"location": BLUEHANDS_LOCATION},
            headers=headers
        )
        print("Current intensity status:", r_cur.status_code)
        print("Current intensity response:", r_cur.json())

        # FORECAST - EXACT endpoint + params from your curl
        r_forecast = await client.get(
            "https://forecast.carbon-aware-computing.com/emissions/forecasts/current",
            params={
                "location": BLUEHANDS_LOCATION,
                "dataStartAt": NOW.strftime("%Y-%m-%dT%H:%M:%S.0000000+00:00"),
                "dataEndAt": FUTURE.strftime("%Y-%m-%dT%H:%M:%S.0000000+00:00"),
                "windowSize": "10"
            },
            headers=headers
        )
        print("Forecast status:", r_forecast.status_code)
        print("Forecast response:", r_forecast.text)

async def main():
    await asyncio.gather(
        test_electricity_maps(),
        test_bluehands_hosted_sdk(),
    )

asyncio.run(main())
