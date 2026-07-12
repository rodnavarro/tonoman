---
name: list-projects
description: List the projects (git repos) available in the agent's workspace, to decide where to create or modify code. Use whenever the operator asks to build/develop/change something and you need to know what projects exist or where to put new work.
allowed-tools: Bash
---

# List available projects

The workspace is granted host locations mounted under `~/files/`. Each is
`~/files/<name>` and may contain many git repos. List them:

```bash
find ~/files -maxdepth 5 -type d -name .git -prune 2>/dev/null | sed 's#/\.git$##' | sort
```

Show the operator the repos you found and **ask which one to work in** — or whether
to create a **new folder** (which you will `git init`). Never assume the location;
confirm before scaffolding. You may only read/write under `~/files/`.
