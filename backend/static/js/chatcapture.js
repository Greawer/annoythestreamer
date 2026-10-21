document.addEventListener("DOMContentLoaded", () => {

    const chatbox = document.getElementById("chatbox");
    const maxMessages = 50;
    const admins = window.CHAT_CONFIG.admins;
    const colors = window.CHAT_CONFIG.colors;
    const username = "OBS";

    // --- ADD MESSAGE ---
    async function addMessage(user, message) {
        const msgDiv = document.createElement("div");
        msgDiv.classList.add("message");
        msgDiv.style.textAlign = "left";

        const htmlMessage = await ChatUtils.parseEmojis(message);
        msgDiv.innerHTML = `<strong style="color:${ChatUtils.getUserColor(user, username, admins, colors)}">${user}:</strong> <span style="color:white">${htmlMessage}</span>`;
        chatbox.appendChild(msgDiv);

        while (chatbox.childNodes.length > maxMessages) chatbox.removeChild(chatbox.firstChild);
        chatbox.scrollTop = chatbox.scrollHeight;
    }

    // --- SOCKET.IO ---
    const socket = io({ query: { username } });
    socket.on("chat_message", async data => await addMessage(data.user, data.message));
    socket.on("chat_history", async messages => {
        chatbox.innerHTML = "";
        for (const m of messages.slice(-maxMessages)) await addMessage(m.user, m.message);
    });

});