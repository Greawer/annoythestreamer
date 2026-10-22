import { useEffect, useState } from "react";

type Sound = {
  file: string;
  label: string;
  url: string;
};

export default function Soundboard() {
  const [sounds, setSounds] = useState<Sound[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/soundboardlist")
      .then(async (res) => {
        const result = await res.json()
        if (!res.ok) throw new Error(result.message || `Sound list request failed (${res.status})`)
        return result as { file: string; title: string; url: string }[]
      })
      .then((assets) => {
        setSounds(assets.map(sound => ({
          file: sound.file,
          label: sound.title,
          url: sound.url,
        })));
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Error loading sounds")
        console.error("Error loading sounds:", err)
      });
  }, []);

  const playSound = (url: string) => {
    const audio = new Audio(url);
    audio.play().catch(err => console.error("Audio error:", err));
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mt-4">
      {sounds.length === 0 && (
        <p className="col-span-full text-gray-400 text-sm italic">
          {error || "No usable sounds found."}
        </p>
      )}
      {sounds.map((sound, i) => (
        <button
          key={i}
          onClick={() => playSound(sound.url)}
          className="bg-gray-800 hover:bg-gray-700 text-white rounded-xl py-2 px-3 text-sm transition"
        >
          {sound.label}
        </button>
      ))}
    </div>
  );
}
