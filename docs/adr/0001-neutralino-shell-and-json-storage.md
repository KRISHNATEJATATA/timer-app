# Neutralino.js over Electron/Tauri for the desktop shell

The timer must auto-start with Windows and the owner wants a lightweight app. Electron was rejected as too heavy (~200MB) and Tauri as requiring a Rust + MSVC toolchain that isn't installed. We use Neutralino.js (~2MB binary) with the preinstalled WebView2 runtime, launched via a Startup-folder shortcut. Time logs persist as a plain JSON file rather than SQLite — personal scale, human-readable, and trivially exportable.
