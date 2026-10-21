const ChatUtils = (() => {
    const emojiCache = {};

    function getUserColor(user, username, admins, colors) {
        if (admins.includes(user)) return colors.admin;
        if (user === username) return colors.self || colors.user;
        return colors.user;
    }

    async function parseEmojis(message) {
        const parts = message.split(/(:[a-zA-Z0-9_]+:)/g);
        for (let i = 0; i < parts.length; i++) {
            const match = parts[i].match(/^:([a-zA-Z0-9_]+):$/);
            if (match) {
                const name = match[1];
                if (emojiCache[name] === undefined) {
                    try {
                        const res = await fetch(`/emoji/${name}`);
                        const data = await res.json();
                        emojiCache[name] = data.url || null;
                    } catch {
                        emojiCache[name] = null;
                    }
                }
                if (emojiCache[name]) parts[i] = `<img class="emoji" src="${emojiCache[name]}" alt="${name}">`;
            }
        }
        return parts.join("");
    }

    return { getUserColor, parseEmojis };
})();