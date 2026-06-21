const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  addMessage,
  buildSnapshot,
  ensureRoom,
  joinRoom,
  leaveRoom,
  slugify,
} = require("./chatStore");

const PORT = process.env.PORT || 4000;
const CLIENT_ROOT = path.join(__dirname, "..", "client");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const sockets = new Set();
const socketState = new Map();
const roomSockets = new Map();

function sendFrame(socket, data) {
  if (socket.destroyed) return;

  const payload = Buffer.from(JSON.stringify(data));
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : payload.length < 65536
      ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : (() => {
          const len = Buffer.alloc(8);
          len.writeBigUInt64BE(BigInt(payload.length));
          return Buffer.concat([Buffer.from([0x81, 127]), len]);
        })();

  socket.write(Buffer.concat([header, payload]));
}

function roomKey(roomId) {
  return roomId || "default-room";
}

function getRoomSocketSet(roomId) {
  const key = roomKey(roomId);
  if (!roomSockets.has(key)) roomSockets.set(key, new Set());
  return roomSockets.get(key);
}

function removeSocketFromRoom(socket, roomId) {
  const key = roomKey(roomId);
  const set = roomSockets.get(key);
  if (set) {
    set.delete(socket);
    if (!set.size) roomSockets.delete(key);
  }
}

function broadcastRoom(roomId) {
  const set = roomSockets.get(roomKey(roomId));
  if (!set || !set.size) return;

  const room = ensureRoom(roomId);
  for (const socket of set) {
    const state = socketState.get(socket);
    if (!state) continue;
    sendFrame(socket, buildSnapshot(room, state.participantId));
  }
}

function closeSocket(socket) {
  try {
    if (!socket.destroyed) socket.write(Buffer.from([0x88, 0x00]));
  } catch (_) {
    // Ignore shutdown errors.
  }

  const state = socketState.get(socket);
  if (state?.roomId && state?.participantId) {
    const room = ensureRoom(state.roomId);
    leaveRoom(room, state.participantId);
    removeSocketFromRoom(socket, state.roomId);
    broadcastRoom(state.roomId);
  }

  socket.destroy();
  sockets.delete(socket);
  socketState.delete(socket);
}

function parseWebSocketFrames(socket, buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const fin = (byte1 & 0x80) !== 0;
    const opcode = byte1 & 0x0f;
    const masked = (byte2 & 0x80) !== 0;
    let length = byte2 & 0x7f;
    let headerSize = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerSize = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        closeSocket(socket);
        return { messages, remainder: Buffer.alloc(0) };
      }
      length = Number(bigLength);
      headerSize = 10;
    }

    const maskOffset = offset + headerSize;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const frameLength = headerSize + (masked ? 4 : 0) + length;

    if (offset + frameLength > buffer.length) break;

    let payload = buffer.subarray(payloadOffset, payloadOffset + length);
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    if (!fin) {
      offset += frameLength;
      continue;
    }

    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      closeSocket(socket);
      return { messages, remainder: Buffer.alloc(0) };
    } else if (opcode === 0x9) {
      socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
    }

    offset += frameLength;
  }

  return { messages, remainder: buffer.subarray(offset) };
}

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveStaticFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": mimeType(filePath) });
    res.end(data);
  });
}

function handleHttp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const relativePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(CLIENT_ROOT, safePath);

  if (!filePath.startsWith(CLIENT_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  serveStaticFile(res, filePath);
}

const server = http.createServer(handleHttp);

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n")
  );

  sockets.add(socket);
  socketState.set(socket, {
    roomId: null,
    participantId: `participant-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    participantName: "Guest",
  });

  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const result = parseWebSocketFrames(socket, buffer);
    buffer = result.remainder;

    for (const raw of result.messages) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (_) {
        continue;
      }

      const state = socketState.get(socket);
      if (!state) continue;

      if (message.type === "join_room") {
        const name = String(message.name || "Guest").trim().slice(0, 40) || "Guest";
        const roomName = String(message.roomName || "Live Chat").trim().slice(0, 60) || "Live Chat";
        const roomCode = slugify(String(message.roomCode || "").trim()) || "my-room";
        const room = ensureRoom(roomCode, roomName);

        if (state.roomId) {
          const previousRoom = ensureRoom(state.roomId);
          leaveRoom(previousRoom, state.participantId);
          removeSocketFromRoom(socket, state.roomId);
          broadcastRoom(state.roomId);
        }

        state.roomId = room.id;
        state.participantName = name;
        socketState.set(socket, state);
        joinRoom(room, {
          id: state.participantId,
          name,
          initials: name
            .split(/\s+/)
            .filter(Boolean)
            .map((part) => part[0])
            .slice(0, 2)
            .join("")
            .toUpperCase() || "U",
        });
        getRoomSocketSet(room.id).add(socket);
        broadcastRoom(room.id);
      }

      if (message.type === "send_message") {
        if (!state.roomId) continue;
        const room = ensureRoom(state.roomId);
        const sender = {
          id: state.participantId,
          name: state.participantName || "Guest",
        };
        const created = addMessage(room, sender, message.text);
        if (created) broadcastRoom(room.id);
      }

      if (message.type === "leave_room" && state.roomId) {
        const roomId = state.roomId;
        const room = ensureRoom(roomId);
        leaveRoom(room, state.participantId);
        removeSocketFromRoom(socket, roomId);
        state.roomId = null;
        socketState.set(socket, state);
        broadcastRoom(roomId);
      }

      if (message.type === "typing") {
        if (!state.roomId) continue;
        broadcastRoom(state.roomId);
      }
    }
  });

  socket.on("close", () => closeSocket(socket));
  socket.on("error", () => closeSocket(socket));
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process or run PORT=4001 npm start.`);
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, () => {
  console.log(`WhisperChat server running at http://localhost:${PORT}`);
});
