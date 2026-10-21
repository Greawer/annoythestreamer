import { useEffect, useState } from "react";

type Sound = {
  file: string;
  label: string;
  url: string;
};

export default function Soundboard() {
  const [sounds, setSounds] = useState<Sound[]>([]);

  useEffect(() => {
    fetch("/api/soundboardlist")
      .then(res => res.json())
      .then((sounds: { file: string; title: string; url: string }[]) => {
        setSounds(sounds.map(sound => ({
          file: sound.file,
          label: sound.title,
          url: sound.url,
        })));
      })
      .catch(err => console.error("Error loading sounds:", err));
  }, []);

  const playSound = (url: string) => {
    const audio = new Audio(url);
    audio.play().catch(err => console.error("Audio error:", err));
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mt-4">
      {sounds.length === 0 && (
        <p className="col-span-full text-gray-400 text-sm italic">
          No sounds found.
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
