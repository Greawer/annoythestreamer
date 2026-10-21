let currentMeme = null;

// --- UPDATE MEME ---
function updateMeme(memeinfo) {
    if (!memeinfo) return;
    currentMeme = memeinfo;
    document.getElementById("top-text").innerHTML = currentMeme.top_text;
    document.getElementById("bottom-text").innerHTML = currentMeme.bottom_text;
}

// --- FETCH NEXT MEME ---
function fetchNextMeme() {
    fetch("/facememe/next", { method: "PUT" })
        .then(res => res.json())
        .then(meme => {
            if (meme && meme._id && (!currentMeme || meme._id !== currentMeme._id)) {
                updateMeme(meme);
            }
        })
        .catch(err => console.error(err));
}

fetchNextMeme();
setInterval(fetchNextMeme, 5000);