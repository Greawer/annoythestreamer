document.addEventListener("DOMContentLoaded", () => {

    if (!window.CHAT_CONFIG) {
        console.error("CHAT_CONFIG not found! Make sure chat-config.js is loaded first.");
        return;
    }

    const { admins, colors } = window.CHAT_CONFIG;
    const maxMessages = 50;

    // --- USERNAME SETUP ---
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(";").shift();
        return "";
    }

    function setCookie(name, value, days) {
        const d = new Date();
        d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
        const expires = "expires=" + d.toUTCString();
        document.cookie = name + "=" + encodeURIComponent(value) + ";" + expires + ";path=/";
    }

    let username = getCookie("ats_username");
    while (!username) {
        username = prompt("Enter your username:");
        if (username) setCookie("ats_username", username, 30);
    }
    console.log("Logged in as:", username);

    // --- CHAT ELEMENTS ---
    const chatbox = document.getElementById("chatbox");
    const chatInput = document.getElementById("chatInput");
    const sendChat = document.getElementById("sendChat");
    chatInput.maxLength = 100;

    // --- ADD MESSAGE ---
    async function addMessageToChat(user, message) {
        const msgDiv = document.createElement("div");
        const mentionRegex = new RegExp(`@${username}\\b`, "i");
        if (mentionRegex.test(message)) msgDiv.classList.add("mention-highlight");
        msgDiv.style.textAlign = "left";

        const htmlMessage = await ChatUtils.parseEmojis(message);
        msgDiv.innerHTML = `<strong style="color:${ChatUtils.getUserColor(user, username, admins, colors)}">${user}:</strong> <span style="color:white">${htmlMessage}</span>`;
        chatbox.appendChild(msgDiv);

        while (chatbox.childNodes.length > maxMessages) chatbox.removeChild(chatbox.firstChild);
        chatbox.scrollTop = chatbox.scrollHeight;
    }

    // --- SEND MESSAGE ---
    function sendMessage() {
        const msg = chatInput.value.trim();
        if (!msg) return;
        socket.emit("chat_message", { user: username, message: msg });
        chatInput.value = "";

        if (getComputedStyle(emojiPanel).display !== "none") {
            emojiPanel.style.display = "none";
            emojiToggle.innerHTML = "&#9650;";
        }
    }

    sendChat.addEventListener("click", sendMessage);
    chatInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); sendMessage(); } });

    // --- ONLINE USERS ---
    function renderOnlineUsers(users) {
        const list = document.getElementById("onlineUsers");
        list.innerHTML = "";
        users.forEach(user => {
            const li = document.createElement("li");
            li.textContent = user;
            li.style.color = ChatUtils.getUserColor(user, username, admins, colors);
            list.appendChild(li);
        });
    }

    // --- SOCKET.IO ---
    const socket = io({ query: { username } });
    socket.on("chat_message", async data => await addMessageToChat(data.user, data.message));
    socket.on("chat_history", async messages => {
        chatbox.innerHTML = "";
        for (const m of messages) await addMessageToChat(m.user, m.message);
    });
    socket.on("update_users", users => renderOnlineUsers(users));

    // --- PANEL TOGGLE ---
    const onlinePanel = document.getElementById("onlinePanel");
    const togglePanel = document.getElementById("togglePanel");
    const panelToggleButton = document.getElementById("panelToggleButton");

    togglePanel.addEventListener("click", () => {
        onlinePanel.style.display = "none";
        panelToggleButton.style.display = "flex";
    });

    panelToggleButton.addEventListener("click", () => {
        onlinePanel.style.display = "block";
        panelToggleButton.style.display = "none";
    });

    // --- FORM AJAX ---
    ["facememeform","normalmemeform","ttsmemeform"].forEach(id => {
        const form = document.getElementById(id);
        if (form) form.addEventListener("submit", e => {
            e.preventDefault();
            const formData = new FormData(form);
            formData.append("user", username);
            fetch("/handle_post", { method: "POST", body: formData })
                .then(r => r.json())
                .then(data => {
                    if (data.status === "ok") {
                        if (id === "ttsmemeform") {
                            const languageSelect = form.querySelector("select[name='language']");
                            const selectedLanguage = languageSelect.value;
                            form.reset();
                            languageSelect.value = selectedLanguage;
                        } else {
                            form.reset();
                        }
                    }
                })
                .catch(err => console.error(err));
        });
    });

    // --- CARD SWITCHING ---
    const cards = {
        facememe: document.getElementById("facememe"),
        normalmeme: document.getElementById("normalmeme"),
        soundmeme: document.getElementById("soundmeme"),
        ttsmeme: document.getElementById("ttsmeme")
    };
    const buttons = {
        facememebutton: document.getElementById("facememebutton"),
        normalmemebutton: document.getElementById("normalmemebutton"),
        soundmemebutton: document.getElementById("soundmemebutton"),
        ttsmemebutton: document.getElementById("ttsmemebutton")
    };

    function showCard(cardName) {
        Object.keys(cards).forEach(k => cards[k].style.display = (k === cardName ? "block" : "none"));
        localStorage.setItem("activeForm", cardName);

        if (cardName === "soundmeme") {
            loadSoundButtons();
        }
    }

    const activeCard = localStorage.getItem("activeForm") || "facememe";
    showCard(activeCard);

    Object.keys(buttons).forEach(key => {
        buttons[key].onclick = () => showCard(key.replace("button",""));
    });

    // --- EMOJI PANEL ---
    const emojiToggle = document.getElementById("emojiToggle");
    const emojiPanel = document.getElementById("emojiPanel");
    const emojiGrid = document.getElementById("emojiGrid");
    let allEmojis = [];

    async function loadEmojis() {
        try {
            const res = await fetch("/emoji/list");
            allEmojis = await res.json();
            emojiGrid.innerHTML = "";
            allEmojis.forEach(name => {
                const btn = document.createElement("button");
                btn.className = "emoji-btn";
                btn.innerHTML = `<img src="/static/img/emoji/${name}.jpg" alt="${name}" onerror="this.onerror=null;this.src='/static/img/emoji/${name}.png'">`;
                btn.addEventListener("click", () => {
                    chatInput.value += `:${name}:`;
                    chatInput.focus();
                });
                emojiGrid.appendChild(btn);
            });
        } catch (err) {
            console.error("Failed to load emojis:", err);
        }
    }

    emojiToggle.addEventListener("click", () => {
        const hidden = getComputedStyle(emojiPanel).display === "none";
        emojiPanel.style.display = hidden ? "block" : "none";
        emojiToggle.innerHTML = hidden ? "&#9660;" : "&#9650;";
        if (hidden && !allEmojis.length) loadEmojis();
    });

    // --- SOUND BOARD ---
    function resizeSoundGrid() {
        const card = document.getElementById("soundmeme");
        const grid = card.querySelector(".sound-grid");
        const body = card.querySelector(".card-body");
        const imageHeight = card.querySelector(".card-img-top").offsetHeight;
        const titleHeight = body.querySelector("h5").offsetHeight;
        const descHeight = body.querySelector("p").offsetHeight;
        const bodyStyle = getComputedStyle(body);
        const padding = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);

        let availableHeight = card.clientHeight - imageHeight - titleHeight - descHeight - padding;

        const buttons = grid.querySelectorAll(".sound-btn");
        if (buttons.length > 0) {
            const rows = Math.ceil(buttons.length / 3);
            const gapPx = 2.2;
            availableHeight -= (rows - 1) * gapPx;
        }

        grid.style.height = availableHeight + "px";
    }

    async function loadSoundButtons() {
        const grid = document.querySelector(".sound-grid");
        grid.innerHTML = "";

        const response = await fetch("/soundboard/list");
        const sounds = await response.json();

        sounds.forEach(sound => {
            const btn = document.createElement("button");
            btn.classList.add("sound-btn");
            btn.textContent = sound.title;

            btn.addEventListener("click", () => {
                const soundName = sound.file.replace(/\.[^/.]+$/, "");
                socket.emit("play_sound", { sound: soundName });
            });

            grid.appendChild(btn);
        });

        resizeSoundGrid();
    }

    window.addEventListener("resize", () => resizeSoundGrid());
});
