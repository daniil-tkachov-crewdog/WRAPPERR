import type { Config } from 'tailwindcss';

/* Tailwind theme — Spectrum.
   The new Spectrum tokens (bg/rail/panel/raise/line/text/mid/dim/faint) are exposed as
   utility classes. The legacy keys (surface/border/muted) are kept as aliases pointed at the
   new tokens so any older code still works without per-file edits. Provider hue helpers
   (text-p-claude etc.) let inline classNames reach the oklch vars without long arbitrary
   syntax — useful for spines, chips, and the send button. */
const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        rail: 'var(--rail)',
        panel: 'var(--panel)',
        raise: 'var(--raise)',
        line: 'var(--line)',
        'line-soft': 'var(--line-soft)',
        text: 'var(--text)',
        mid: 'var(--mid)',
        dim: 'var(--dim)',
        faint: 'var(--faint)',
        // Legacy aliases — keep older usages (surface/border/muted) working without per-file edits.
        surface: 'var(--panel)',
        border: 'var(--line)',
        muted: 'var(--mid)',
        // Provider hues — direct access for spines, chips, send button glow.
        'p-chatgpt': 'var(--p-chatgpt)',
        'p-claude': 'var(--p-claude)',
        'p-grok': 'var(--p-grok)',
        'p-gemini': 'var(--p-gemini)',
        'p-deepseek': 'var(--p-deepseek)',
        'p-perplexity': 'var(--p-perplexity)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
