import asyncio
from pathlib import Path
import sys

hostname, target, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
supervisor, token = sys.argv[4:6]


def alive():
    try:
        fields = Path(f"/proc/{supervisor}/stat").read_text().rsplit(")", 1)[1].split()
        return fields[0] != "Z" and fields[19] == token
    except FileNotFoundError:
        return False


async def connect():
    return await asyncio.wait_for(asyncio.open_connection(target, port), 2)


async def copy(reader, writer):
    while data := await reader.read(65536):
        writer.write(data)
        await writer.drain()


async def forward(reader, writer):
    upstream = None
    tasks = []
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 5)
        hosts = [line.split(b":", 1)[1].strip().decode("ascii")
                 for line in header.split(b"\r\n")[1:] if line.lower().startswith(b"host:")]
        # Reject alternate browser origins before forwarding any cookies or credentials.
        if len(hosts) != 1 or hosts[0].split(":")[0] != hostname:
            writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            return
        source, upstream = await connect()
        upstream.write(header)
        await upstream.drain()
        tasks = [asyncio.create_task(copy(reader, upstream)),
                 asyncio.create_task(copy(source, writer))]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except (OSError, ValueError, UnicodeError, asyncio.TimeoutError, asyncio.IncompleteReadError,
            asyncio.LimitOverrunError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if upstream:
            upstream.close()
        writer.close()


async def main():
    server = await asyncio.start_server(forward, "0.0.0.0", 8080)
    async with server:
        # The shared PID namespace and start token keep cleanup tied to the original service.
        while alive():
            await asyncio.sleep(0.2)


asyncio.run(main())
