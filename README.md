# WhisperChat

A WhatsApp-style Node.js chat clone with a custom WebSocket server.

## Run it

```bash
npm start
```

Then open `http://localhost:4000`.

You can also run:

```bash
node server.js
```

## What it does

- Serves the UI from a Node.js HTTP server
- Shows two simulated phone screens on the same page
- Syncs both screens through WebSockets in real time
- Lets both screens join the same room code and chat together
- Keeps room state in memory across connected browsers

## Project Structure

- `server/index.js`: HTTP server, WebSocket handshake, room broadcasting
- `server/chatStore.js`: in-memory room, participant, and message logic
- `client/index.html`: two-screen page structure
- `client/styles.css`: visual design
- `client/app.js`: browser-side WebSocket client and UI rendering

## How to use it

1. Open `http://localhost:4000`.
2. Enter the same room code on both simulated phones.
3. Use different names for each phone.
4. Send messages from either side and they will appear instantly on both screens.
