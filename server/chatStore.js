const rooms = new Map();

function nowTime() {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function initialsFor(name) {
  const parts = String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!parts.length) return "U";
  return parts
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function createRoom(roomId, roomName = "Live Chat") {
  const id = roomId || slugify(roomName) || `room-${Date.now()}`;
  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      name: roomName,
      createdAt: Date.now(),
      messages: [
        {
          id: `msg-${Date.now()}`,
          senderId: "system",
          senderName: "System",
          text: "Room created. Invite the second phone to join this code.",
          time: nowTime(),
          system: true,
        },
      ],
      participants: new Map(),
    });
  }

  return rooms.get(id);
}

function ensureRoom(roomId, roomName) {
  return createRoom(roomId, roomName);
}

function joinRoom(room, participant) {
  const existing = room.participants.get(participant.id);
  room.participants.set(participant.id, {
    ...existing,
    ...participant,
    initials: initialsFor(participant.name),
    joinedAt: existing?.joinedAt || Date.now(),
  });
}

function leaveRoom(room, participantId) {
  room.participants.delete(participantId);
}

function addMessage(room, sender, text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) return null;

  const message = {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    senderId: sender.id,
    senderName: sender.name,
    senderInitials: initialsFor(sender.name),
    text: cleanText,
    time: nowTime(),
    system: false,
  };

  room.messages.push(message);
  return message;
}

function buildSnapshot(room, currentParticipantId) {
  const participants = Array.from(room.participants.values()).map((participant) => ({
    id: participant.id,
    name: participant.name,
    initials: participant.initials || initialsFor(participant.name),
    online: true,
    joinedAt: participant.joinedAt,
  }));

  return {
    type: "snapshot",
    room: {
      id: room.id,
      name: room.name,
      code: room.id,
      participantCount: participants.length,
      messages: room.messages,
      participants,
      currentParticipantId,
      currentParticipant:
        room.participants.get(currentParticipantId) || null,
    },
  };
}

module.exports = {
  addMessage,
  buildSnapshot,
  ensureRoom,
  joinRoom,
  leaveRoom,
  slugify,
};
