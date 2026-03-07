# Runtime Files

## Why is runtime data stored in `_runtime/` inside the repository instead of `~/.config/infiniclaw/`?

From an architectural perspective, keeping the `_runtime/` directory inside the repository clone provides significant operational benefits, even though it requires strict ignore rules in your editor and search tools.

### 1. Sandbox Isolation (The "Holodeck" Superpower)
Because `_runtime/` is relative to the repository root, the entire state of the fleet is **scoped to that specific clone**.

If you want to test a massive, dangerous change to the fleet without breaking production, you can simply clone a fresh copy of the repo to another folder and run it. Because the new clone gets its own completely isolated SQLite database, its own IPC queues, and its own logs within its local `_runtime/`, it will never collide with your production fleet running from the main directory.

If runtime data were moved to a global `~/.infiniclaw/` or `~/.config/infiniclaw/` directory, every clone of the repo would fight over the exact same global database and IPC queues, destroying the ability to run safe, isolated environments on the same machine.

### 2. The "Nuke from Orbit" Guarantee
When development state gets irrecoverably corrupted (e.g., toxic session loops, broken databases, or orphaned IPC files), having the state inside the repo means running `rm -rf _runtime/` provides a guaranteed, perfect reset of the environment. You don't have to go hunting through hidden global directories to clear caches.

### 3. The XDG Standard
The Linux/macOS XDG Base Directory specification dictates that `~/.config/` should *only* be used for static configuration files (which is why `machine.json`, `allow-list.json`, and the `secrets/` repo live there). 

Runtime data includes massive `JSONL` session files, high-IO SQLite databases (`messages.db`), fast-polling IPC queues, and PM2 logs. Dumping gigabytes of volatile active state into a `.config` folder violates that standard and complicates configuration backups. (The technically correct XDG location for data would be `~/.local/share/infiniclaw/`, but you would lose the sandbox isolation described above).

### Managing the Clutter
To prevent the `_runtime/` folder from polluting your development experience:
*   It is already in `.gitignore`.
*   Ensure your text editor (VS Code/Cursor) has `_runtime` added to `files.exclude` and `search.exclude`.
*   When using CLI search tools, rely on `.rgignore` or use flags like `--exclude-dir=_runtime`.