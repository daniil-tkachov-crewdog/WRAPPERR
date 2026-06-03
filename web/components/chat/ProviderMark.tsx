import type { AIModel } from '@/lib/types';

// ProviderMark — abstract geometric SVG glyph per AI provider, used in the sidebar recents,
// top bar avatar stack, message provider chips, relay card tiles, and composer model selector.
// These are intentionally NOT the trademarked provider logos; if real logos are licensed later,
// swap them in here without touching the rest of the UI. `color` defaults to currentColor so
// the parent's `style={{ color: hue }}` or `text-p-*` class drives the tint.
interface Props {
  id: AIModel;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function ProviderMark({ id, size = 16, color = 'currentColor', strokeWidth = 1.5 }: Props) {
  const c = color;
  const sw = strokeWidth;
  // Per-provider path set. Switch instead of object lookup so TS narrows the id and we get a
  // dead-code error if we miss a provider.
  let path: React.ReactNode;
  switch (id) {
    case 'chatgpt':
      // concentric spark — soft outer ring around a centred node
      path = (
        <g fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 4.2c2.3 0 3.9 1.3 4.4 3.2 1.9.5 3.2 2.1 3.2 4.4 0 2.3-1.3 3.9-3.2 4.4-.5 1.9-2.1 3.2-4.4 3.2-2.3 0-3.9-1.3-4.4-3.2C5.7 15.7 4.4 14.1 4.4 12c0-2.3 1.3-3.9 3.2-4.4C8.1 5.7 9.7 4.4 12 4.4Z" opacity="0.55"/>
          <circle cx="12" cy="12" r="2.3"/>
        </g>
      );
      break;
    case 'claude':
      // warm starburst — soft asterisk
      path = (
        <g stroke={c} strokeWidth={sw + 0.3} strokeLinecap="round">
          <path d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3 6.3 17.7"/>
        </g>
      );
      break;
    case 'grok':
      // angular prism — corner arrow
      path = (
        <g fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 19 19 5M9 5h6v6"/>
        </g>
      );
      break;
    case 'gemini':
      // facet diamond
      path = (
        <g fill="none" stroke={c} strokeWidth={sw} strokeLinejoin="round">
          <path d="M12 3c.4 4.6 1.4 5.6 6 6-4.6.4-5.6 1.4-6 6-.4-4.6-1.4-5.6-6-6 4.6-.4 5.6-1.4 6-6Z"/>
        </g>
      );
      break;
    case 'deepseek':
      // whale-tail wave — abstract
      path = (
        <g fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 13c3 0 4-5 8-5s5 5 8 5"/>
          <path d="M4 17c3 0 4-3 8-3s5 3 8 3" opacity="0.5"/>
        </g>
      );
      break;
    case 'perplexity':
      // search ring — coming soon
      path = (
        <g fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="6"/>
          <path d="m20 20-4-4"/>
        </g>
      );
      break;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
      {path}
    </svg>
  );
}

// ArrowSwap — relay icon used in the sidebar to mark chats that had a model handoff.
// Lives here so the chat-related SVGs are colocated.
export function ArrowSwap({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M7 4 3 8l4 4"/>
      <path d="M3 8h13a4 4 0 0 1 4 4"/>
      <path d="m17 20 4-4-4-4"/>
      <path d="M21 16H8a4 4 0 0 1-4-4" opacity="0.45"/>
    </svg>
  );
}
