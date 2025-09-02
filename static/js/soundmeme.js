const socket = io();

// --- FETCH SOUNDS FROM SERVER ---
async function loadSounds() {
    const res = await fetch("/soundboard/list");
    const files = await res.json();

    const sounds = {};
    files.forEach(file => {
        const name = file.replace(/\.[^/.]+$/, "");
        sounds[name] = new Audio(`/static/sounds/soundboard/${file}`);
        sounds[name].volume = 0.8;
    });
    return sounds;
}

// --- INIT ---
let sounds = {};
loadSounds().then(loadedSounds => {
    sounds = loadedSounds;

    document.querySelectorAll(".sound-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const soundName = btn.dataset.sound;
            if (sounds[soundName]) {
                const audio = sounds[soundName].cloneNode();
                audio.volume = 0.8;
                audio.play().catch(err => console.log("Playback blocked:", err));
                console.log("Playing sound:", soundName);
                socket.emit("play_sound", { sound: soundName });
            } else {
                console.log("Sound not found:", soundName);
            }
        });
    });
});

// --- PLAY SOUND FROM SERVER ---
socket.on("play_sound", data => {
    const soundName = data.sound;
    if (sounds[soundName]) {
        const audio = sounds[soundName].cloneNode();
        audio.volume = 0.8;
        audio.play().catch(err => console.log("Playback blocked:", err));
        console.log("Playing sound from server:", soundName);
    } else {
        console.log("Sound not found:", soundName);
    }
});




