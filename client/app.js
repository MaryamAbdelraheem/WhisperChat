class PhoneClient {
  constructor(root) {
    this.root = root;
    this.joinPanel = root.querySelector("[data-join-panel]");
    this.chatPanel = root.querySelector("[data-chat-panel]");
    this.joinButton = root.querySelector("[data-join-button]");
    this.leaveButton = root.querySelector("[data-leave-button]");
    this.roomCodeInput = root.querySelector("[data-room-code]");
    this.displayNameInput = root.querySelector("[data-display-name]");
    this.roomNameInput = root.querySelector("[data-room-name]");
    this.deviceName = root.querySelector("[data-device-name]");
    this.connectionPill = root.querySelector("[data-connection]");
    this.roomTitle = root.querySelector("[data-room-title]");
    this.roomStatus = root.querySelector("[data-room-status]");
    this.roomCodeLabel = root.querySelector("[data-room-code-label]");
    this.participantCount = root.querySelector("[data-participant-count]");
    this.avatar = root.querySelector("[data-avatar]");
    this.messageStream = root.querySelector("[data-message-stream]");
    this.messageForm = root.querySelector("[data-message-form]");
    this.messageInput = root.querySelector("[data-message-input]");

    this.socket = null;
    this.reconnectTimer = null;
    this.outboundQueue = [];
    this.room = null;
    this.joinPayload = null;
    this.joined = false;
    this.participantName = "";

    this.roomCodeInput.value = this.getStoredRoomCode();
    this.displayNameInput.value = this.getStoredName();
    this.roomNameInput.value = "Live Chat";

    this.bindEvents();
    this.connect();
  }

  getStoredRoomCode() {
    return localStorage.getItem("whisper_room_code") || "demo-room";
  }

  getStoredName() {
    return localStorage.getItem(`whisper_display_name_${this.root.dataset.device}`) || "";
  }

  escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  initialsFor(name) {
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

  setConnectionState(kind, text) {
    this.connectionPill.textContent = kind;
    this.connectionPill.className = "status-pill";
    this.connectionPill.classList.add(kind === "Connected" ? "is-online" : "is-muted");
    this.roomStatus.textContent = text;
  }

  queueOrSend(payload) {
    const message = JSON.stringify(payload);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(message);
      return true;
    }
    this.outboundQueue.push(message);
    return false;
  }

  flushOutboundQueue() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    while (this.outboundQueue.length) {
      this.socket.send(this.outboundQueue.shift());
    }
  }

  joinRoom() {
    const roomCode = this.roomCodeInput.value.trim() || "demo-room";
    const roomName = this.roomNameInput.value.trim() || "Live Chat";
    const displayName = this.displayNameInput.value.trim() || "Guest";

    localStorage.setItem("whisper_room_code", roomCode);
    localStorage.setItem(`whisper_display_name_${this.root.dataset.device}`, displayName);

    this.participantName = displayName;
    this.joinPayload = {
      type: "join_room",
      roomCode,
      roomName,
      name: displayName,
    };

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(this.joinPayload));
    }

    this.joined = true;
    this.joinPanel.hidden = true;
    this.chatPanel.hidden = false;
    this.deviceName.textContent = displayName;
    this.setConnectionState("Connecting", "Joining room...");
  }

  leaveRoom() {
    if (this.socket?.readyState === WebSocket.OPEN && this.room?.code) {
      this.socket.send(JSON.stringify({ type: "leave_room" }));
    }

    this.joined = false;
    this.joinPayload = null;
    this.room = null;
    this.joinPanel.hidden = false;
    this.chatPanel.hidden = true;
    this.setConnectionState("Disconnected", "Waiting to join");
  }

  renderRoom() {
    const room = this.room;
    if (!room) return;

    this.roomTitle.textContent = room.name || "Live Chat";
    this.roomCodeLabel.textContent = room.code || "-";
    this.participantCount.textContent = String(room.participants?.length || 0);

    const current = room.currentParticipant;
    this.deviceName.textContent = current?.name || this.participantName || "Guest";
    this.avatar.textContent = current?.initials || this.initialsFor(this.participantName || "You");

    const participants = room.participants || [];
    this.roomStatus.textContent =
      participants.length >= 2 ? "Both phones connected" : "Waiting for the second phone";
  }

  renderMessages() {
    const room = this.room;
    if (!room) {
      this.messageStream.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__badge">WA</div>
          <h3>Join a room to begin</h3>
          <p>Enter the same room code on both phones and the chat will sync live.</p>
        </div>
      `;
      return;
    }

    if (!room.messages || !room.messages.length) {
      this.messageStream.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__badge">WA</div>
          <h3>Start the conversation</h3>
          <p>Send the first message from either phone.</p>
        </div>
      `;
      return;
    }

    this.messageStream.innerHTML = room.messages
      .map((message, index) => {
        if (message.system) {
          return `
            <div class="message-row system" style="--message-delay:${index * 50}ms">
              <div class="message-bubble system-bubble">
                <p>${this.escapeHtml(message.text)}</p>
              </div>
            </div>
          `;
        }

        const outgoing = message.senderId === room.currentParticipantId;
        return `
          <div class="message-row ${outgoing ? "is-outgoing" : ""}" style="--message-delay:${index * 50}ms">
            <div class="message-bubble">
              <p>${this.escapeHtml(message.text)}</p>
              <div class="message-meta">
                <span>${this.escapeHtml(message.senderName)}</span>
                <span>${this.escapeHtml(message.time)}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    this.messageStream.scrollTop = this.messageStream.scrollHeight;
  }

  connect() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    this.socket.addEventListener("open", () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.setConnectionState("Connected", "Live sync active");

      if (this.joined && this.joinPayload) {
        this.socket.send(JSON.stringify(this.joinPayload));
      }

      this.flushOutboundQueue();
    });

    this.socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (payload.type === "snapshot") {
        this.room = payload.room;
        if (this.joined) {
          this.joinPanel.hidden = true;
          this.chatPanel.hidden = false;
        }
        this.renderRoom();
        this.renderMessages();
      }
    });

    this.socket.addEventListener("close", () => {
      this.setConnectionState("Reconnecting", "Trying to reconnect...");
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 800);
    });

    this.socket.addEventListener("error", () => {
      this.setConnectionState("Offline", "Connection error");
    });
  }

  bindEvents() {
    this.joinButton.addEventListener("click", () => this.joinRoom());

    this.messageForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.messageInput.value.trim();
      if (!text || !this.room?.code) return;

      this.queueOrSend({
        type: "send_message",
        chatId: this.room.code,
        text,
      });

      this.messageInput.value = "";
    });

    this.leaveButton.addEventListener("click", () => this.leaveRoom());

    [this.roomCodeInput, this.displayNameInput, this.roomNameInput].forEach((input) => {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.joinRoom();
      });
    });
  }
}

const phones = Array.from(document.querySelectorAll(".phone")).map((phone, index) => {
  phone.dataset.device = index === 0 ? "left" : "right";
  return new PhoneClient(phone);
});

requestAnimationFrame(() => {
  document.body.classList.add("is-ready");
});
