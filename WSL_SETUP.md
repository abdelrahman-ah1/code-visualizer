# Running the C++ mode on Windows (WSL2)

C++ mode needs g++ and gdb on the machine that runs the backend. It was tested only on Ubuntu 22.04 Linux.
Windows native is not supported (no gdb path, no ptrace). Use WSL2 with Ubuntu. NOT verified end to end on Windows/WSL.

## Steps (all inside the Ubuntu/WSL terminal)
1. Check you are on WSL2 (in PowerShell: `wsl -l -v`, the VERSION column must say 2). WSL1 is not expected to work with gdb or the sanitizers.
2. Install the tools: `sudo apt update && sudo apt install -y g++ gdb python3-venv python3-pip git curl`
3. Node: the frontend needs Node 22.12 or newer (frontend/package.json "engines"). Ubuntu's own `apt install nodejs` is older. Install a newer one, for example with nvm (https://github.com/nvm-sh/nvm), then `nvm install 22`.
4. Put the repository in the WSL home folder (for example `~/code-visualizer`), not under `/mnt/c/...`. Files on the Windows drive are slow and can break npm installs and file watching.
5. Backend (from the repo root): `python3 -m venv .venv && . .venv/bin/activate && pip install -r backend/requirements.txt && python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000`
6. Frontend (second WSL terminal): `cd frontend && npm ci && npm run dev`
7. Open http://127.0.0.1:5173 in your Windows browser. WSL2 normally forwards localhost to Windows. If it does not load, open it from a browser inside WSL or use the address `wsl hostname -I` prints for the frontend (the backend request still goes through the Vite proxy).
8. In the app choose Language: C++. If the page says "C++ tools not found", g++ or gdb is missing from the PATH of the terminal that started the backend.

## What was and was not verified
- Verified (Linux, Ubuntu 22.04, g++ 11.4, gdb 12.1, Python 3.10, Node 22): everything in TEST_REPORT_M5.md.
- Not verified: WSL1/WSL2 itself, localhost forwarding from Windows to WSL, running from /mnt/c, Ubuntu 24.04 (gcc 13, gdb 15) behaviour, stock apt gdb (the test machine used a gdb 12.1 unpacked by hand), and the libstdc++ pretty printers with that stock gdb (std::string and std::vector display depend on them; if they are missing those types are shown as opaque objects).
- Python mode already worked on Windows natively before M5. The backend must run in WSL for C++ mode. You can keep using native Windows for Python mode only.

## Likely gaps
Node too old; repo on /mnt/c; WSL1; ASan or gdb refusing to start under a restricted WSL kernel setting (unverified, would show as "recorder failed" or "memory check could not run" in Findings); running the backend from Windows PowerShell by habit.
