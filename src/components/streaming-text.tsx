import { useEffect, useState } from "react";

/** Reveals a completed AI response progressively so long answers stay readable. */
export default function StreamingText({ text, className = "" }: { text: string; className?: string }) {
  const [visible, setVisible] = useState("");

  useEffect(() => {
    let index = 0;
    let frame = 0;
    setVisible("");
    const tick = () => {
      index = Math.min(text.length, index + 3);
      setVisible(text.slice(0, index));
      if (index < text.length) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [text]);

  return <span className={className}>{visible}</span>;
}
