# EcoSync

EcoSync is a carbon-aware productivity and browser monitoring platform that helps users reduce their digital carbon footprint through real-time carbon analytics, intelligent browser telemetry, eco-optimized task scheduling, and carbon-aware download management.

The project combines a FastAPI backend, a Chrome Extension, and a real-time dashboard interface to monitor browser energy behavior and optimize user actions based on live electricity-grid carbon intensity.

---

# Features

* Real-time carbon intensity tracking using Electricity Maps and BlueHands APIs
* Traffic-light based grid status system
* Browser Tab Auditor with energy classification
* Heavy-tab detection and browser telemetry monitoring
* Carbon-aware Downloads Monitor
* Deferred download scheduling during greener energy windows
* Eco-Scheduler for carbon-optimized task management
* Historical and forecast carbon analytics
* Energy source mix visualization
* Chrome extension integration with Manifest V3
* Live CO₂ estimation and session tracking

---

# Tech Stack

Frontend:

* HTML
* CSS
* JavaScript
* Chart.js

Backend:

* FastAPI
* Python
* HTTPX
* Uvicorn

Browser Extension:

* Chrome Extension APIs
* Manifest V3

APIs Used:

* Electricity Maps API
* BlueHands API

---

# Project Structure

```text
EcoSync/
│
├── main.py
├── requirements.txt
├── test_carbon.py
│
├── extension/
│   ├── manifest.json
│   ├── background.js
│   │
│   ├── popup/
│   │   ├── index.html
│   │   ├── popup.css
│   │   └── popup.js
│   │
│   ├── website/
│   │   ├── main.html
│   │   ├── styles.css
│   │   ├── app.js
│   │   └── icons/
│   │       └── globe.png
│   │
│   └── icons/
│       └── globe.png
│
└── venv/
```

---

# How to Run the Project

## Step 1: Clone the Repository

```bash
git clone <your-repository-link>
cd EcoSync
```

---

# Step 2: Create Virtual Environment

## Windows

```bash
python -m venv venv
```

## Mac/Linux

```bash
python3 -m venv venv
```

---

# Step 3: Activate Virtual Environment

## Windows

```bash
venv\Scripts\activate
```

## Mac/Linux

```bash
source venv/bin/activate
```

---

# Step 4: Install Dependencies

```bash
pip install -r requirements.txt
```

---

# Step 5: Run FastAPI Backend

```bash
python main.py
```

OR

```bash
uvicorn main:app --reload
```

Backend runs on:

```text
http://127.0.0.1:8000
```

---

# Step 6: Load Chrome Extension

1. Open Google Chrome
2. Go to:

```text
chrome://extensions/
```

3. Enable:

* Developer Mode

4. Click:

* Load Unpacked

5. Select the `extension/` folder

The EcoSync extension will now load into Chrome.

---

# Step 7: Open Dashboard

Open:

```text
http://127.0.0.1:8000
```

The EcoSync dashboard should now be running successfully.

---

# Main Modules

## Dashboard

Displays real-time grid carbon intensity, CO₂ emissions, energy-source mix, and forecast analytics.

## Tab Auditor

Monitors browser tabs, classifies energy usage, estimates browser power consumption, and detects heavy tabs.

## Downloads Monitor

Tracks browser downloads, estimates download-related carbon emissions, and enables deferred downloads during cleaner grid windows.

## Eco-Scheduler

Provides carbon-aware task scheduling and eco-optimized execution recommendations.

## Chrome Extension

Continuously monitors browser telemetry and synchronizes live data with the backend dashboard.

---

# Contributors

## Member 1

Worked on:

* `main.py`
* `website/main.html`
* `website/app.js`

Contributions:

* FastAPI backend
* API integrations
* Carbon-intensity handling
* Backend/frontend synchronization
* Dashboard and homepage implementation

---

## Member 2

Worked on:

* `extension/background.js`
* `extension/manifest.json`
* `popup/index.html`
* `popup/popup.js`

Contributions:

* Chrome extension development
* Chrome Tabs API integration
* Tab Auditor module
* Browser telemetry monitoring
* Heavy-tab detection and classification

---

## Member 3

Worked on:

* `extension/background.js`
* `website/app.js`
* `website/main.html`

Contributions:

* Downloads Monitor implementation
* Chrome Downloads API integration
* Download deferral workflows
* Download tracking and monitoring
* Browser-extension download optimization

---

## Member 4

Worked on:

* `website/styles.css`
* `website/app.js`
* `website/main.html`
* `main.py`

Contributions:

* Eco-Scheduler implementation
* Green-window recommendation logic
* Task queue workflows
* UI styling and responsive layouts
* Overall frontend formatting and design

---

# Future Scope

* AI-based carbon optimization recommendations
* Cross-browser extension support
* Cloud-based telemetry storage
* User authentication and profile management
* Machine-learning based energy prediction
* Real-time system-level energy monitoring
* Smart automated scheduling recommendations
