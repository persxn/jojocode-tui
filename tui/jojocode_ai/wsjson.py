"""A minimal, dependency-free WebSocket client (RFC 6455) for JSON messaging.

Just enough for one long-lived client connection: the opening handshake, masked
text frames out, unmasked frames in, automatic ping/pong, and a clean close.
stdlib only (`socket`, `ssl`) so the TUI keeps zero runtime dependencies.

Not a general-purpose library: no permessage-deflate, no huge (>2^32) frames,
one message per frame on send.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import selectors
import socket
import ssl
import struct
import threading
from urllib.parse import urlparse

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


class WSError(RuntimeError):
    pass


class WSClosed(WSError):
    """The peer closed the connection (or it dropped)."""

    def __init__(self, code: int | None = None, reason: str = ""):
        super().__init__(f"websocket closed ({code}) {reason}".strip())
        self.code = code
        self.reason = reason


class WSClient:
    def __init__(self, url: str, headers: dict[str, str] | None = None,
                 connect_timeout: float = 15.0):
        self.url = url
        self.headers = headers or {}
        self.connect_timeout = connect_timeout
        self._sock: socket.socket | None = None
        self._buf = b""
        self._send_lock = threading.Lock()
        self._closed = False

    # -- lifecycle ------------------------------------------------------- #
    def connect(self) -> None:
        u = urlparse(self.url)
        secure = u.scheme == "wss"
        host = u.hostname or "127.0.0.1"
        port = u.port or (443 if secure else 80)
        path = u.path or "/"
        if u.query:
            path += "?" + u.query

        raw = socket.create_connection((host, port), timeout=self.connect_timeout)
        if secure:
            ctx = ssl.create_default_context()
            raw = ctx.wrap_socket(raw, server_hostname=host)
        self._sock = raw

        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {host}:{port}" if u.port else f"Host: {host}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        for k, v in self.headers.items():
            lines.append(f"{k}: {v}")
        self._sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())

        # read headers up to the blank line
        self._sock.settimeout(self.connect_timeout)
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise WSError("connection closed during handshake")
            head += chunk
        header_blob, _, rest = head.partition(b"\r\n\r\n")
        status_line = header_blob.split(b"\r\n", 1)[0].decode("latin1")
        if "101" not in status_line:
            raise WSError(f"handshake failed: {status_line}")
        accept = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
        if accept.lower() not in header_blob.decode("latin1").lower():
            raise WSError("handshake failed: bad Sec-WebSocket-Accept")
        self._buf = rest
        self._sock.settimeout(None)

    def close(self, code: int = 1000) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_frame(OP_CLOSE, struct.pack(">H", code))
        except OSError:
            pass
        try:
            self._sock.close()  # type: ignore[union-attr]
        except OSError:
            pass

    # -- framing ------------------------------------------------------- #
    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._sock is None:
            raise WSClosed()
        fin_op = 0x80 | opcode
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = struct.pack(">BB", fin_op, 0x80 | n)
        elif n < (1 << 16):
            hdr = struct.pack(">BBH", fin_op, 0x80 | 126, n)
        else:
            hdr = struct.pack(">BBQ", fin_op, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._send_lock:
            try:
                self._sock.sendall(hdr + mask + masked)
            except OSError as e:
                raise WSClosed(reason=str(e))

    def _recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            try:
                chunk = self._sock.recv(65536)  # type: ignore[union-attr]
            except (OSError, AttributeError) as e:
                raise WSClosed(reason=str(e))
            if not chunk:
                raise WSClosed(reason="eof")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _read_frame(self) -> tuple[int, bool, bytes]:
        b0, b1 = self._recv_exact(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", self._recv_exact(2))
        elif length == 127:
            (length,) = struct.unpack(">Q", self._recv_exact(8))
        payload = self._recv_exact(length) if length else b""
        if masked:  # servers must not mask; tolerate anyway
            mk = payload[:4]
            payload = bytes(c ^ mk[i % 4] for i, c in enumerate(payload[4:]))
        return opcode, fin, payload

    # -- public messaging -------------------------------------------- #
    def send_json(self, obj: dict) -> None:
        self._send_frame(OP_TEXT, json.dumps(obj, separators=(",", ":")).encode())

    def recv_json(self, timeout: float | None = None) -> dict | None:
        """Next JSON message, or None if the socket has no data within `timeout`.

        Handles ping/pong and close control frames transparently. Reassembles
        fragmented text messages. Raises WSClosed when the peer goes away.
        """
        if self._sock is None:
            raise WSClosed()
        if timeout is not None and not self._buf:
            sel = selectors.DefaultSelector()
            sel.register(self._sock, selectors.EVENT_READ)
            ready = sel.select(timeout)
            sel.close()
            if not ready:
                return None

        data = b""
        op_first = None
        while True:
            opcode, fin, payload = self._read_frame()
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else None
                self._closed = True
                raise WSClosed(code, payload[2:].decode("utf-8", "replace"))
            if opcode in (OP_TEXT, OP_BIN):
                op_first = opcode
                data = payload
            elif opcode == OP_CONT:
                data += payload
            if fin:
                break
        try:
            return json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as e:
            raise WSError(f"bad JSON frame: {e}")
