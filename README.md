# Option Combo Simulator (with IBKR Live Integration)

## 📌 Project Overview
The Option Combo Simulator is a web-based, entirely client-side (HTML/JS/CSS) tool designed to construct, visualize, and analyze complex options trading strategies (like Iron Condors, Straddles, Vertical Spreads) before executing them. 

It replicates and enhances the experience of using an Excel spreadsheet to track costs, calculate breakevens, and visualize the theoretical P&L curves across different underlying prices and simulated dates.

Recently, the project has been empowered with a **Python Backend (`ib_server.py`)** that uses `ib_insync` to create a WebSocket bridge to Interactive Brokers (TWS/Gateway), streaming live market data directly into the web UI for real-time portfolio analysis.

## 🏗️ Technical Architecture

### 1. Frontend: Visualization & Engine (`index.html`, `app.js`, `chart.js`, `bsm.js`, `style.css`)
- **No Build Step Required**: The core application runs directly in any modern browser without Webpack, React, or Node.js.
- **State Management (`app.js`)**: Maintains the global simulation variables (Underlying Price, Simulated Date, IV Offset, Interest Rate) and an array of `groups` (Option Combos), each containing multiple `legs` (Calls/Puts, Long/Short).
- **Pricing Model (`bsm.js`)**: Implements the Black-Scholes-Merton (BSM) formula to calculate the theoretical price of European-style options based on the inputs (S, K, T, r, v).
- **Rendering Engine (`chart.js`)**: A custom, highly optimized HTML5 `<canvas>` rendering engine. It draws the aggregated P&L curve, the zero-axis, automatically detects and annotates **Break-even points (Zero-crossings)**, and maps interactions (hover tooltips) smoothly at 60fps.
- **Data Persistence**: Uses a custom JSON export/import mechanism to save and load complex combo portfolios locally.

### 2. Backend: Live Data Gateway (`ib_server.py`, `config.ini`)
- **Python Asyncio Daemon**: Built using `asyncio` and `websockets` to provide a non-blocking WebSocket server (default port `8765`).
- **TWS Integration (`ib_insync`)**: Connects to a local Interactive Brokers TWS or IB Gateway instance (default port `7496`). 
- **Smart Subscription Management**: The frontend only subscribes to option legs where the "Live Market Data" toggle is enabled. The Python server dynamically manages `reqMktData` and cancels stale subscriptions to conserve IB API rate limits. 
- **Ambiguity Resolution**: Uses strict `Option` definitions (`exchange='SMART', multiplier='100', currency='USD'`) to prevent "Ambiguous Contract" errors from the IB API when querying highly liquid assets like SPY.

## 🚀 How to Run

1. **Frontend Only (Offline Simulation)**
   Simply open `index.html` in your web browser.

2. **Backend (Live Integration)**
   - Ensure Interactive Brokers TWS or Gateway is running and API access is enabled (Settings -> API -> Settings -> "Enable ActiveX and Socket Clients").
   - Install Python dependencies: `pip install ib_insync websockets`
   - Start the server: `python ib_server.py`
   - Refresh `index.html`. Toggle the "Live Market Data" switch on any Combo Group to stream live quotes into the "Cost" fields. Use the "Sync" button next to "Underlying Price" to force a snapshot update of the underlying asset.

## 🤖 Prompts & Development History (For LLM Continuity)

This project was built iteratively entirely through LLM pairing. If you are an LLM taking over this source code, here are the key developmental milestones and prompts that shaped the current architecture:

### Phase 1: Core Excel Replacement & UI 
* **Goal:** "Create an application that replicates the functionality of my Excel cost calculation spreadsheet for options trading. Input option price, type, qty, and calculate premium received, average asset price, effective price. Quantity is multiplied by 100."
* **Goal:** "Modify UI style to a bright, SaaS-like billing style, avoiding dark themes. Ensure the layout is responsive on smaller screens (MacBooks), making the sidebar collapsible and the transaction table scrollable."

### Phase 2: Date Calculation & Chart Engine Refinement
* **Goal:** "Review and optimize Date logic. The `app.js` has potential issues with date calculations due to local timezone and DST shifts. Refactor `diffDays` and `addDays` to enforce strict UTC mathematical calculations."
* **Goal:** "Optimize the chart redrawing logic. Move expensive Date object creations and BSM DTE calculations out of the inner loop in `chart.js` `draw` method to ensure smooth 60fps rendering during slider interactions."
* **Goal:** "Annotate the P&L chart to show break-even points where the curve crosses the zero axis. Display the underlying price and percentage change from the current underlying."

### Phase 3: Interactive Brokers Integration
* **Goal:** "The chart needs a global 'Underlying Symbol' label because combos cannot share an X-axis if they span different underlyings. Add this to the UI and JSON export."
* **Goal:** "Connect the spreadsheet to IBKR for live data. Create a Python backend using `ib_insync` to fetch TWS option prices. Use WebSockets to broadcast to the HTML. Add a 'Live Data' toggle to UI groups to map realtime quotes to the 'Cost' column so the charts animate dynamically."
* **Goal:** "Fix Python asyncio errors. Replace blocking `ib.qualifyContracts` with `await ib.qualifyContractsAsync` inside the websocket handler to prevent 'This event loop is already running' crashes. Fix Error 321 (Ambiguous Contract) by strictly querying SMART options."
* **Goal:** "Add a manual 'Sync Latest Price' button next to the Underlying Price input to allow fetching snapshot quotes when the market is closed and tick stream is silent."

---
_Note to subsequent developers / AI agents: The architecture heavily favors separation of concerns. Charting is completely decoupled from the data stream. If adding new BSM greeks or strategy templates, start with `bsm.js` and `app.js` state structure before touching UI bindings._
