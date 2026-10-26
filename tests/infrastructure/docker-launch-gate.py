#!/usr/bin/python3
import json
import os
from pathlib import Path
import subprocess
import sys
import time

payload = sys.stdin.buffer.read()
try:
    request = json.loads(payload)
except (ValueError, UnicodeDecodeError):
    request = {}
gate = Path(os.environ["MYBOTS_DOCKER_LAUNCH_GATE"])
waiting = False
if request.get("action") == "start":
    try:
        with Path(str(gate) + ".waiting").open("x") as marker:
            marker.write("ready")
        waiting = True
    except FileExistsError:
        pass
if waiting:
    deadline = time.monotonic() + 60
    while not gate.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("Docker launch gate was not released")
        time.sleep(0.02)
result = subprocess.run(
    [os.environ["MYBOTS_REAL_DOCKER"], *sys.argv[1:]], input=payload,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
)
if waiting:
    Path(str(gate) + ".result").write_text(json.dumps({
        "exitCode": result.returncode, "stderr": result.stderr.decode(),
    }))
for descriptor, data in ((1, result.stdout), (2, result.stderr)):
    try:
        os.write(descriptor, data)
    except BrokenPipeError:
        pass
sys.exit(result.returncode)
