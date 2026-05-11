import type { Message } from '@/lib/types';
import { AI_MODELS } from '@/lib/constants';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

interface Props {
  message: Message;
}

// MessageBubble renders chat messages.
// User messages: plain text (whitespace-preserved). We never apply Markdown to user input —
// they wrote it as plain text and shouldn't have their content reinterpreted (e.g. underscores
// turning into italics).
// Assistant messages: Markdown rendered with GFM (tables, strikethrough, task lists, autolinks)
// and KaTeX (LaTeX math). The content-script normalizers convert each AI's provider-specific
// styled-content encoding (e.g. ChatGPT's PUA link markers) into standard Markdown before this
// component sees it, so the renderer is provider-agnostic.
export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const aiLabel = message.aiModel
    ? AI_MODELS.find((m) => m.id === message.aiModel)?.label
    : undefined;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`max-w-[75%] ${
          isUser
            ? 'bg-white text-black rounded-2xl rounded-tr-sm px-4 py-3'
            : 'bg-surface border border-border text-white rounded-2xl rounded-tl-sm px-4 py-3'
        }`}
      >
        {!isUser && aiLabel && (
          <p className="text-xs text-muted mb-1.5 font-medium">{aiLabel}</p>
        )}
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="text-sm leading-relaxed wrapperr-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 underline hover:text-blue-300"
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
