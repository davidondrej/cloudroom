---
name: gpu
description: Rent a GPU box with `room-cli gpu` for heavy GPU work, such as training or fine-tuning models, running large models, CUDA code, or 3D rendering. Each session needs the user's approval and uses their Cloud Credits. Beta, paid plans (Pro and up), Local and Cloud threads.
---

# GPUs

`room-cli gpu` rents a separate Linux box with NVIDIA GPUs. Your own machine stays where it is; you run commands on the GPU box and copy files to and from it.

## When to use it

- Only for work that truly needs a GPU, or would take far too long on the CPU. GPUs are expensive.
- Suggest it to the user first, with what you want to run and roughly how long. Then start it: the user approves in a card that shows the Cloud Credits.

## Workflow

1. `room-cli gpu list` shows GPU types, Cloud Credits per hour, and how many are free now.
2. `room-cli gpu start --gpu H100 --hours 1 --purpose "Fine-tune the classifier on data/"` asks the user and waits. If it says it's still waiting, tell the user and run `room-cli gpu wait ID`. Don't end your turn while waiting.
3. `room-cli gpu push ID ./data` copies a file or folder to `work/` in the box's working folder (`/workspace`).
4. `room-cli gpu run ID --cwd work -- python train.py` runs a command and prints its output. Each command starts fresh in `/workspace`, so use `--cwd` or `cd DIR && …`. Install what you need with `pip` or `apt-get`; the default image has PyTorch with CUDA.
5. For long jobs, add `--detach`, then check with `room-cli gpu logs ID COMMAND_ID --follow`.
6. `room-cli gpu pull ID work/out ./results` copies results back.
7. `room-cli gpu stop ID` as soon as the GPU work is done. It's charged by the minute until then.

## Limits

- One session per thread. It stops by itself at its hours or spending limit, or after 15 minutes with no command running. Its files are deleted when it stops, so pull results first.
- `--count` up to 4 GPUs, `--hours` up to 8. `--cpu`, `--memory`, `--disk`, and `--image` change the box.
- The box may only reach package registries (PyPI, apt, GitHub), not the whole internet.
- `room-cli gpu help` lists every command.
