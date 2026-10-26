import base64
from contextlib import contextmanager
import fcntl
import io
import json
import os
from pathlib import Path
import signal
import shutil
import selectors
import time
import subprocess
import sys
import tarfile

ROOT = Path("/workspace")
TRANSFER_LIMIT = 16 * 1024 * 1024
FILE_LIMIT = 1024 * 1024
OUTPUT_LIMIT = 65536


def workspace_path(value):
    if not isinstance(value, str) or len(value) > 4096 or "\x00" in value or "\\" in value:
        raise ValueError("Invalid workspace path")
    if value.startswith("/") or ".." in value.split("/"):
        raise ValueError("Expected a workspace-relative path")
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError("Path escapes the Computer workspace")
    return path


def command_state(identifier, create=False):
    import uuid
    if str(uuid.UUID(identifier)) != identifier:
        raise ValueError("Invalid command identity")
    directory = Path("/tmp/mybots-commands") / identifier
    if create:
        directory.mkdir(parents=True, exist_ok=True)
    return directory


def save_state(directory, state):
    temporary = directory / "state.next"
    temporary.write_text(json.dumps(state))
    temporary.replace(directory / "state.json")


def load_state(directory):
    return json.loads((directory / "state.json").read_text())


def process_token(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except FileNotFoundError:
        return None


def group_alive(pid):
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            if fields[0] != "Z" and int(fields[2]) == pid:
                return True
        except FileNotFoundError:
            pass
    return False


def kill_group(state):
    pid = state.get("pid")
    if pid is None or not group_alive(pid):
        return
    # A surviving supervisor or the original leader prevents signalling a reused PID.
    if (process_token(state["supervisor"]) != state["supervisorToken"]
            and process_token(pid) != state["pidToken"]):
        raise RuntimeError("Cannot confirm command process identity")
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def public_state(state):
    keys = ("commandId", "owner", "service", "retained", "running", "exitCode",
            "timedOut", "truncated", "stdout", "stderr")
    return {key: state[key] for key in keys}


@contextmanager
def generation_lock(generation):
    import uuid
    if str(uuid.UUID(generation)) != generation:
        raise ValueError("Invalid command generation")
    directory = Path("/var/lib/mybots/worker-generations")
    with (directory / generation).open("r") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lock.seek(0)
        yield lock


def start(request):
    with generation_lock(request["generation"]) as lock:
        if lock.read():
            raise RuntimeError("Worker command generation is closed")
        launch(request)


def seal_generation(request):
    # The host closed the read-only marker; join launch executors that passed its check.
    with generation_lock(request["generation"]):
        pass


def launch(request):
    cwd = workspace_path(request["cwd"])
    cwd.mkdir(parents=True, exist_ok=True)
    timeout = request["timeoutMs"]
    if not isinstance(timeout, int) or not 0 < timeout <= 3600000:
        raise ValueError("Invalid command deadline")
    owner = request.get("owner")
    if owner is not None:
        import re
        if (not isinstance(owner, dict)
                or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", owner.get("botId", ""))
                or not re.fullmatch(r"[1-9][0-9]*", owner.get("turnId", ""))):
            raise ValueError("Invalid command owner")
    if request.get("service") and owner is None:
        raise ValueError("A service needs an owner")
    directory = command_state(request["id"], create=True)
    (directory / "request.json").write_text(json.dumps(request))
    with (directory / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = {
            "commandId": request["id"], "owner": owner,
            "service": bool(request.get("service")), "retained": False,
            "running": True, "exitCode": None, "timedOut": False,
            "stdout": "", "stderr": "", "truncated": False,
        }
        save_state(directory, state)
        child = subprocess.Popen(
            [sys.executable, __file__, "run", request["id"]],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, start_new_session=True,
        )
        state.update(supervisor=child.pid, supervisorToken=process_token(child.pid))
        save_state(directory, state)
    print(json.dumps(public_state(state)))


def run(identifier):
    directory = command_state(identifier)
    request = json.loads((directory / "request.json").read_text())
    with (directory / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load_state(directory)
        if (directory / "cancelled").exists():
            state.update(running=False, exitCode=-9, stderr="Command cancelled before start")
            save_state(directory, state)
            return
        cwd = workspace_path(request["cwd"])
        env = dict(os.environ)
        env.update(HOME=str(cwd), XDG_CACHE_HOME=str(cwd / ".cache"),
                   UV_CACHE_DIR=str(cwd / ".cache/uv"),
                   PATH=str(cwd / ".local/bin") + ":" + env["PATH"])
        process = subprocess.Popen(
            ["/bin/bash", "-c", request["command"]], cwd=cwd, env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True,
        )
        state.update(pid=process.pid, pidToken=process_token(process.pid))
        save_state(directory, state)
    streams = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    for stream, name in [(process.stdout, "stdout"), (process.stderr, "stderr")]:
        os.set_blocking(stream.fileno(), False)
        streams.register(stream, selectors.EVENT_READ, name)
    deadline = time.monotonic() + request["timeoutMs"] / 1000
    try:
        while True:
            previous = state.copy()
            timed_out = not state["service"] and time.monotonic() >= deadline
            cancelled = (directory / "cancelled").exists()
            if timed_out or cancelled:
                kill_group(state)
                state["timedOut"] = timed_out
            code = process.poll()
            if code is not None and not state["service"]:
                kill_group(state)
            for key, _ in streams.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    streams.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                buffer = buffers[key.data]
                available = OUTPUT_LIMIT - len(buffer)
                buffer.extend(chunk[:available])
                state["truncated"] |= len(chunk) > available
                state[key.data] = buffer.decode("utf-8", errors="replace")
            if code is not None and not streams.get_map() and not group_alive(process.pid):
                state.update(running=False, exitCode=124 if state["timedOut"] else code)
            with (directory / "lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                state["retained"] = load_state(directory)["retained"]
                if state != previous:
                    save_state(directory, state)
            if not state["running"]:
                break
    finally:
        kill_group(state)
        process.wait()
        streams.close()


def snapshot(request):
    state = load_state(command_state(request["id"]))
    if request.get("botId") is not None and (state["owner"] or {}).get("botId") != request["botId"]:
        raise ValueError("Command belongs to another Bot")
    if state["running"] and process_token(state["supervisor"]) != state["supervisorToken"]:
        raise RuntimeError("Command supervisor lost; cleanup must be confirmed")
    return state


def cancel(request):
    directory = command_state(request["id"])
    with (directory / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = snapshot(request)
        (directory / "cancelled").touch()
        kill_group(state)
    deadline = time.monotonic() + 5
    while load_state(directory)["running"]:
        if time.monotonic() >= deadline:
            raise RuntimeError("Command cleanup timed out")
        time.sleep(0.05)


def owned_commands():
    root = Path("/tmp/mybots-commands")
    if not root.exists():
        return []
    states = []
    for path in root.iterdir():
        try:
            states.append(load_state(path))
        except FileNotFoundError:
            pass
    return states


def finish_turn(request):
    for state in owned_commands():
        if state["owner"] != request["owner"]:
            continue
        directory = command_state(state["commandId"])
        if request["completed"] and state["service"] and state["running"]:
            with (directory / "lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                latest = load_state(directory)
                latest["retained"] = True
                save_state(directory, latest)
        else:
            cancel({"id": state["commandId"]})
            shutil.rmtree(directory)


def export_workspace():
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        entries = sorted(ROOT.rglob("*"))
        if len(entries) > 2048:
            raise ValueError("Workspace exceeds 2048 entries")
        total = 0
        for entry in entries:
            if entry.is_symlink() or not (entry.is_file() or entry.is_dir()):
                raise ValueError("Only regular files and directories can be exported")
            total += entry.stat().st_size if entry.is_file() else 0
            if total > TRANSFER_LIMIT:
                raise ValueError("Workspace exceeds 16 MiB limit")
            archive.add(entry, arcname=entry.relative_to(ROOT), recursive=False)
    if stream.tell() > TRANSFER_LIMIT:
        raise ValueError("Archive exceeds 16 MiB limit")
    sys.stdout.buffer.write(stream.getvalue())


def import_workspace(request):
    data = base64.b64decode(request["archive"], validate=True)
    if len(data) > TRANSFER_LIMIT:
        raise ValueError("Archive exceeds 16 MiB limit")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        members = archive.getmembers()
        if len(members) > 2048 or sum(member.size for member in members) > TRANSFER_LIMIT:
            raise ValueError("Archive exceeds workspace transfer limits")
        # Validate the complete manifest before extracting; never create links or special files.
        for member in members:
            workspace_path(member.name)
            if not (member.isfile() or member.isdir()):
                raise ValueError("Only regular files and directories can be imported")
        for member in members:
            path = workspace_path(member.name)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source:
                    path.write_bytes(source.read())
                path.chmod(member.mode & 0o777)


def main():
    request = json.loads(sys.stdin.buffer.read(24 * 1024 * 1024))
    action = request["action"]
    if action == "start":
        start(request)
    elif action == "seal_generation":
        seal_generation(request)
    elif action == "snapshot":
        print(json.dumps(public_state(snapshot(request))))
    elif action == "commands":
        print(json.dumps([public_state(state) for state in owned_commands()]))
    elif action == "finish_turn":
        finish_turn(request)
    elif action == "cancel":
        cancel(request)
    elif action == "release":
        shutil.rmtree(command_state(request["id"]))
    elif action == "list":
        path = workspace_path(request["path"])
        entries = sorted(path.iterdir(), key=lambda entry: entry.name)
        print(json.dumps({
            "entries": [entry.name + ("/" if entry.is_dir() else "") for entry in entries[:1000]],
            "truncated": len(entries) > 1000,
        }))
    elif action == "read":
        path = workspace_path(request["path"])
        if path.stat().st_size > FILE_LIMIT or not path.is_file():
            raise ValueError("Expected a regular file of at most 1 MiB")
        sys.stdout.write(path.read_bytes().decode("utf-8"))
    elif action == "write":
        content = request["content"].encode("utf-8")
        if len(content) > FILE_LIMIT:
            raise ValueError("File exceeds 1 MiB limit")
        path = workspace_path(request["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    elif action == "export":
        export_workspace()
    elif action == "import":
        import_workspace(request)
    else:
        raise ValueError("Unknown Computer operation")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "run":
        run(sys.argv[2])
    else:
        main()
