# Plyra Chess desktop on Tauri

Why: the current desktop app runs on Streamlit. Every start boots a Python web server and every click re-runs
the page in Python. Tauri shows a native window with the app's pages bundled inside it, so the window opens
with the page already there, clicks never wait on Python, and closing the window ends the program.

## Phase 1 (this folder, working now in a browser test)
- A Tauri shell with a sidebar: **Train** (the phone app: reviews with on-device Stockfish, practice, rated
  puzzles, Woodpecker, opening drills, sync) and **School** (all five grades).
- Both run from files inside the app. Sign-in and sync go to the Plyra gateway as the phone app does.
- To do before shipping:
  - Gateway CORS: allow `http://tauri.localhost` (Windows) and `tauri://localhost` (macOS) in
    the gateway, only when the Tauri app is ready to ship (the Render variable GATEWAY_CORS_ORIGINS).
  - Build the Windows installer with the GitHub workflow (`.github/workflows/windows.yml`, run by hand).
  - Signed auto-updates with Tauri's updater plugin (its own key, kept off the website like plyra-update.key).
  - Desktop layout pass on the phone screens (they are phone-first today).

## Phase 2: the analysis features
- Game review with the AI coach, position investigations and the Theoretician need Python (engines, LLM).
- They run as a **sidecar**: a small Python service (FastAPI, from the existing code) started by Tauri when one
  of those pages opens, stopped when the window closes. New HTML/JS screens call it on localhost.
- Order: Game review → Investigate a position → Progress → Theoretician (still private).

## Phase 3
- Retire the Streamlit app once every page has moved. Existing users get the new app through one last
  Streamlit update that installs it.

## Build
    npm install
    npm run build          # copies ../omniscient-chess/website (or $PLYRA_WEBSITE) into dist/, then tauri build
Windows needs Rust, Node and the MSVC build tools; the GitHub workflow avoids installing those.
