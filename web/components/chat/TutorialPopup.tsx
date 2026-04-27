'use client';

import { useState } from 'react';

const SLIDES = [
  {
    title: 'What is Wrapperr?',
    body: 'Wrapperr is a single interface for all your AI models. Chat with ChatGPT, Claude, Grok, Perplexity, Gemini, and DeepSeek — all in one place, with one login.',
  },
  {
    title: 'What can Wrapperr do?',
    body: 'Send messages to any AI model and switch between them mid-conversation. Wrapperr automatically summarises your chat and transfers the context so the new AI picks up exactly where you left off.',
  },
  {
    title: 'Why use Wrapperr?',
    body: 'Stop juggling tabs. Get the best answer by routing your question to the right model — all without losing your train of thought. One history. Many minds.',
  },
];

export default function TutorialPopup() {
  const [index, setIndex] = useState(0);
  const [dragStart, setDragStart] = useState<number | null>(null);

  function prev() {
    setIndex((i) => Math.max(0, i - 1));
  }

  function next() {
    setIndex((i) => Math.min(SLIDES.length - 1, i + 1));
  }

  function onDragStart(x: number) {
    setDragStart(x);
  }

  function onDragEnd(x: number) {
    if (dragStart === null) return;
    const delta = dragStart - x;
    if (delta > 40) next();
    else if (delta < -40) prev();
    setDragStart(null);
  }

  const slide = SLIDES[index];

  return (
    <div className="w-full max-w-sm mx-auto select-none">
      <div
        className="bg-surface border border-border rounded-2xl p-8 cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => onDragStart(e.clientX)}
        onMouseUp={(e) => onDragEnd(e.clientX)}
        onTouchStart={(e) => onDragStart(e.touches[0].clientX)}
        onTouchEnd={(e) => onDragEnd(e.changedTouches[0].clientX)}
      >
        <h2 className="text-lg font-semibold text-white mb-3">{slide.title}</h2>
        <p className="text-muted text-sm leading-relaxed">{slide.body}</p>

        <div className="flex items-center justify-between mt-8">
          <button
            onClick={prev}
            disabled={index === 0}
            className="text-muted text-sm disabled:opacity-0 hover:text-white transition-colors"
          >
            ← Back
          </button>

          <div className="flex gap-1.5">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                onClick={() => setIndex(i)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === index ? 'bg-white' : 'bg-border'
                }`}
              />
            ))}
          </div>

          <button
            onClick={next}
            disabled={index === SLIDES.length - 1}
            className="text-muted text-sm disabled:opacity-0 hover:text-white transition-colors"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
