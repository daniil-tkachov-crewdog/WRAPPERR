import type { Message } from '@/lib/types';
import { AI_MODELS } from '@/lib/constants';

interface Props {
  message: Message;
}

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
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
}
