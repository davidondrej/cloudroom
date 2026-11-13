---
name: gpu
description: Rent a GPU box with `room-cli gpu` for training, large models, CUDA, or 3D rendering. Needs the user's approval and Cloud Credits. Every plan.
---

# GPUs

`room-cli gpu` rents a separate Linux box with NVIDIA GPUs. Your own machine stays where it is; you run commands on the GPU box and copy files to and from it.

## When to use it

- Only for work that truly needs a GPU, or would take far too long on the CPU. GPUs are expensive.
- Suggest it to the user first, with what you want to run and roughly how long. Then start it: the user approves in a card that shows the Cloud Credits. That approval covers this thread for 24 hours: a new session at the same or a lower price an hour starts without asking while its credits last.

## Workflow

1. `room-cli gpu list` shows GPU types, Cloud Credits per hour, and how many are free now. Pick the cheapest type that fits: an RTX 4090 (24 GB) is enough for most rendering and small models.
2. `room-cli gpu start --gpu RTX-4090 --purpose "Fine-tune the classifier on data/"` asks the user and waits. Add `--hours N` to set its length; without it, the session takes 2 hours, or what the user's Cloud Credits cover. If it says it's still waiting, tell the user and run `room-cli gpu wait ID`. Don't end your turn while waiting.
3. `room-cli gpu push ID ./data` copies a file or folder to `work/` in the box's working folder (`/workspace`).
4. `room-cli gpu run ID --cwd work -- python train.py` runs a command and prints its output. Each command starts fresh in `/workspace`, so use `--cwd` or `cd DIR && …`. Install what you need with `pip` or `apt-get`; the default image has PyTorch with CUDA.
5. For long jobs, add `--detach`, then check with `room-cli gpu logs ID COMMAND_ID --follow`.
6. `room-cli gpu pull ID work/out ./results` copies results back.
7. `room-cli gpu stop ID` as soon as the GPU work is done. It's charged by the minute until then.

## Limits

- One session per thread. It stops by itself at its hours or spending limit, or when it sits idle: no command running, or the GPU unused. That takes 5 minutes on the Free plan and 15 on paid plans, less while GPUs are scarce. Its files are deleted when it stops, so pull results first.
- `--count` up to 4 GPUs, `--hours` up to 8. The Free plan gets 1 GPU and 1 session, and its Cloud Credits cover about 20 minutes of H100 or an hour of RTX 4090: leave `--hours` out and the session takes what they cover. The box has 4 vCPU and 16 GB RAM per GPU: add `--cpu` or `--memory` when the job needs more, like loading a large model. `--disk` and `--image` change the box too.
- The box may only reach package registries (PyPI, apt, GitHub), not the whole internet.
- `room-cli gpu help` lists every command.
