#!/usr/bin/env python3
"""recommend-model — look at this machine and pick an Ollama model that will
actually run well, then (optionally) pull it and launch the TUI.

    python3 recommend-model.py              # just print the recommendation
    python3 recommend-model.py --pull       # also `ollama pull` it
    python3 recommend-model.py --run        # pull, then `jojo --model <it>`
    python3 recommend-model.py --json       # machine-readable

stdlib only. Detects total RAM, CPU cores, and NVIDIA VRAM / Apple unified
memory. The ranking is deliberately conservative — a model that swaps is worse
than a smaller one that doesn't.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import shutil
import subprocess
import sys

GB = 1024 ** 3

# name -> (approx resident GB, min usable GB to recommend, blurb)
CATALOG = [
    ("gpt-oss:120b", 65, 72, "frontier open-weight reasoning model"),
    ("gpt-oss:20b", 13, 22, "excellent agent model, fits a 24 GB box"),
    ("qwen2.5-coder:14b-instruct-q4_K_M", 9, 14, "strong coder, modest footprint"),
    ("qwen2.5-coder:7b-instruct-q4_K_M", 5, 7, "solid on a laptop"),
    ("qwen2.5-coder:3b", 2, 3, "last resort — small context, weaker reasoning"),
]


def total_ram_gb() -> float:
    try:
        if hasattr(os, "sysconf") and "SC_PHYS_PAGES" in os.sysconf_names:
            return os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / GB
    except (ValueError, OSError):
        pass
    if platform.system() == "Windows":
        class MS(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MS()
        m.dwLength = ctypes.sizeof(MS)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return m.ullTotalPhys / GB
    return 0.0


def nvidia_vram_gb() -> float:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return 0.0
    try:
        out = subprocess.run(
            [exe, "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=8,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return 0.0
    mib = [float(x) for x in out.split() if x.strip().replace(".", "").isdigit()]
    return max(mib) / 1024 if mib else 0.0


def unified_memory() -> bool:
    """True on machines where the GPU shares system RAM (no separate VRAM pool):
    all Apple-silicon Macs, and NVIDIA Tegra/Grace-class boards (GB10, Orin, Thor)."""
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return True
    try:
        with open("/proc/device-tree/model", "rb") as f:
            model = f.read().decode("ascii", "replace").lower()
        if any(k in model for k in ("gb10", "grace", "orin", "thor", "tegra", "jetson")):
            return True
    except OSError:
        pass
    exe = shutil.which("nvidia-smi")
    if exe:
        try:
            names = subprocess.run([exe, "-L"], capture_output=True, text=True,
                                   timeout=8).stdout.lower()
            if any(k in names for k in ("gb10", "grace", "orin", "thor")):
                return True
        except (OSError, subprocess.SubprocessError):
            pass
    return False


def detect() -> dict:
    ram = round(total_ram_gb(), 1)
    vram = round(nvidia_vram_gb(), 1)
    unified = unified_memory()
    # usable budget for weights + KV cache, leaving headroom for the OS/editor
    if unified:
        usable = round(ram * 0.72, 1)
        accel = "unified memory (GPU shares system RAM)"
    elif vram >= 4:
        usable = vram
        accel = f"NVIDIA GPU ({vram:.0f} GB VRAM)"
    else:
        usable = round(ram * 0.65, 1)
        accel = "CPU only"
    return {
        "os": f"{platform.system()} {platform.machine()}",
        "cpu_cores": os.cpu_count() or 0,
        "ram_gb": ram,
        "vram_gb": vram,
        "accelerator": accel,
        "usable_gb": usable,
    }


def recommend(info: dict) -> tuple[str, str]:
    usable = info["usable_gb"]
    for name, resident, need, blurb in CATALOG:
        if usable >= need:
            return name, blurb
    name, _, _, blurb = CATALOG[-1]
    return name, blurb + " (this machine is below every comfortable target)"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="recommend-model")
    ap.add_argument("--json", action="store_true", help="print JSON and exit")
    ap.add_argument("--pull", action="store_true", help="ollama pull the recommended model")
    ap.add_argument("--run", action="store_true", help="pull, then launch `jojo` with it")
    ap.add_argument("--yes", "-y", action="store_true", help="don't ask before pulling")
    ap.add_argument("--model", help="skip detection; use this model")
    args = ap.parse_args(argv)

    info = detect()
    model, why = (args.model, "chosen by --model") if args.model else recommend(info)

    if args.json:
        print(json.dumps({**info, "recommended": model, "why": why}, indent=2))
        return 0

    print("  this machine")
    print(f"    {info['os']} · {info['cpu_cores']} cores · {info['ram_gb']:.0f} GB RAM")
    print(f"    accelerator: {info['accelerator']}")
    print(f"    usable for a model: ~{info['usable_gb']:.0f} GB")
    print()
    print(f"  recommended model:  {model}")
    print(f"    {why}")
    print()

    if not (args.pull or args.run):
        print("  next:")
        print(f"    ollama pull {model}")
        print(f"    jojo --model {model}")
        return 0

    if not shutil.which("ollama"):
        print("  ! 'ollama' is not installed — run ollama-setup.sh first", file=sys.stderr)
        return 1
    if not args.yes:
        try:
            if input(f"  pull {model} now? [Y/n] ").strip().lower() in ("n", "no"):
                return 0
        except EOFError:
            pass
    if subprocess.run(["ollama", "pull", model]).returncode != 0:
        return 1
    if args.run:
        jojo = shutil.which("jojo") or [sys.executable, "-m", "jojocode_ai"]
        cmd = ([jojo] if isinstance(jojo, str) else jojo) + ["--model", model]
        os.execvp(cmd[0], cmd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
