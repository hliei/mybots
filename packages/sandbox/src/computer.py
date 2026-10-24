import base64
import fcntl
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile

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


def command_state(identifier):
    import uuid
    if str(uuid.UUID(identifier)) != identifier:
        raise ValueError("Invalid command identity")
    directory = Path("/tmp/mybots-commands") / identifier
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def execute(request):
    directory = command_state(request["id"])
    cwd = workspace_path(request["cwd"])
    cwd.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        with (directory / "lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if (directory / "cancelled").exists():
                raise RuntimeError("Command cancelled before start")
            process = subprocess.Popen(
                ["/bin/sh", "-c", request["command"]], cwd=cwd,
                stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                start_new_session=True,
            )
            (directory / "pid").write_text(str(process.pid))
        try:
            code = process.wait(timeout=120)
        finally:
            # Kill remaining processes in this command group when foreground work finishes.
            with (directory / "lock").open("w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                (directory / "pid").unlink(missing_ok=True)
            process.wait()
        sizes = [stdout.tell(), stderr.tell()]
        stdout.seek(0)
        stderr.seek(0)
        print(json.dumps({
            "exitCode": code,
            "stdout": stdout.read(OUTPUT_LIMIT).decode("utf-8", errors="replace"),
            "stderr": stderr.read(OUTPUT_LIMIT).decode("utf-8", errors="replace"),
            "truncated": any(size > OUTPUT_LIMIT for size in sizes),
        }))


def cancel(request):
    directory = command_state(request["id"])
    # The same lock covers start registration and cancellation, including cancel-before-start.
    with (directory / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        (directory / "cancelled").touch()
        pid_file = directory / "pid"
        if pid_file.exists():
            try:
                os.killpg(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


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
    if action == "execute":
        execute(request)
    elif action == "cancel":
        cancel(request)
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
    main()
