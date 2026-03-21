# Branch Brain Container

Lighter image for branch brains — same agent-runner entrypoint as main bot containers (`stdin JSON → agent-runner → claude`), but without heavy dependencies (python, ripgrep, tmux). Uses `BRANCH_BRAIN_IMAGE` config (`localhost/infiniclaw-branch-brain:latest`).

Build: `podman build -t localhost/infiniclaw-branch-brain:latest -f bots/container/branch-brain/Dockerfile bots/container/`
