let currentTTSId = null;

// --- FETCH NEXT TTS ---
async function fetchNextTTS() {
    try {
        const res = await fetch("/ttsmeme/next");
        const data = await res.json();
        if (!data._id) return null;
        if (currentTTSId === data._id) return null;
        return data;
    } catch (err) {
        console.error("Error fetching TTS:", err);
        return null;
    }
}

// --- PLAY TTS ---
async function playTTS(tts) {
    if (!tts) return;
    currentTTSId = tts._id;

    const audio = new Audio("/" + tts.filepath);
    audio.volume = 0.8;

    document.getElementById("ttsMessage").innerText = tts.text;
    document.getElementById("ttsUser").innerText = tts.user || "";

    audio.onended = async () => {
        await fetch("/tts/done/" + tts._id, { method: "PUT" });

        setTimeout(() => {
            document.getElementById("ttsMessage").innerText = "";
            document.getElementById("ttsUser").innerText = "";
            currentTTSId = null;
            runLoop();
        }, 2000);
    };

    audio.onerror = (e) => {
        console.error("Failed to play TTS:", e);
        currentTTSId = null;
        runLoop();
    };

    audio.play().catch(() => {
        console.warn("Autoplay blocked, retrying in 1s...");
        setTimeout(() => audio.play(), 1000);
    });
}

// --- TTS LOOP ---
async function runLoop() {
    const nextTTS = await fetchNextTTS();
    if (nextTTS) {
        playTTS(nextTTS);
    } else {
        setTimeout(runLoop, 2000);
    }
}

runLoop();