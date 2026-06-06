'use client';

import { useState, useEffect, useCallback } from 'react';
import type { User } from '@supabase/supabase-js';
import type { Message, AIModel, ChatSummary, Profile, CompareResponse } from '@/lib/types';
import { AI_MODELS, MAX_CHATS, SUMMARY_PROMPT } from '@/lib/constants';
import { isExtensionActive, sendMessageToAI, rereadFromAI } from '@/lib/extension';
import { loadAIOptions, saveAIOptions, type AIOptionsMap } from '@/lib/aiOptionsStorage';
import { createClient } from '@/lib/supabase/client';
import Sidebar from '@/components/layout/Sidebar';
import ChatWindow from '@/components/layout/ChatWindow';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function chatNameFromMessage(text: string): string {
  return text.trim().split(/\s+/).slice(0, 5).join(' ');
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // authLoading must start true — the page must not render as logged-out while getSession() is
  // still in flight. Set to false only once the session check resolves (success or failure).
  const [authLoading, setAuthLoading] = useState(true);
  const [extensionActive, setExtensionActive] = useState(false);

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedAI, setSelectedAI] = useState<AIModel>('chatgpt');
  const [loading, setLoading] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(60000);

  // ── Compare AI state ─────────────────────────────────────────────────────
  // compareMode: master toggle for the feature. Off by default. Turning it on opens an in-thread
  // selector card; turning it off (re-clicking the pill / new chat / refresh) clears the
  // selection and lock but leaves any already-rendered compare messages in the thread.
  // compareAIs: chosen set, editable only while compareLocked === false (i.e. before first send).
  // compareLocked: flips to true on first successful send so the selector hides and follow-ups
  // keep fanning out to the same set, preserving per-tab context across the conversation.
  // These are NOT persisted to Supabase right now — the feature is fully in-memory.
  const [compareMode, setCompareMode] = useState(false);
  const [compareAIs, setCompareAIs] = useState<AIModel[]>([]);
  const [compareLocked, setCompareLocked] = useState(false);

  // ── Per-AI options (pill selections) ─────────────────────────────────────
  // aiOptions: which feature / intelligence / style slot value each AI currently has selected.
  // Switching the active AI preserves the previously-selected slots for the prior AI, so
  // bouncing ChatGPT→Claude→ChatGPT keeps Thinking sticky. Persisted to localStorage under
  // 'wrapperr:aiOptions:v1' via aiOptionsStorage.ts. Never persisted to Supabase — these are
  // session-local UX toggles, not chat data. Lazy initialiser keeps SSR safe (loadAIOptions
  // returns {} when window is undefined).
  const [aiOptions, setAiOptions] = useState<AIOptionsMap>(() => loadAIOptions());
  useEffect(() => { saveAIOptions(aiOptions); }, [aiOptions]);

  // setAIOption: update one slot for one AI. Pass undefined to clear the slot (e.g. "no tool
  // active"). Used by InputBar via prop-drilling through ChatWindow → ActiveChatState.
  function setAIOption(ai: AIModel, slot: 'feature' | 'intelligence' | 'style', value: string | string[] | undefined) {
    setAiOptions((prev) => {
      const cur = prev[ai] ?? {};
      const next = { ...cur };
      if (value === undefined) {
        delete next[slot];
      } else {
        next[slot] = value as never;
      }
      return { ...prev, [ai]: next };
    });
  }

  // Auth init
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setUser(session?.user ?? null);
      // Unblock the UI immediately once we know the session state — profile and chats load after.
      // Previously setAuthLoading(false) was after the awaits, so a slow/hanging Supabase query
      // kept the fullscreen spinner up forever.
      setAuthLoading(false);
      if (session?.user) {
        await loadProfile(session.user.id);
        await loadChats(session.user.id);
      }
    }).catch(() => {
      setAuthLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setUser(session?.user ?? null);
        if (session?.user) {
          await loadProfile(session.user.id);
          await loadChats(session.user.id);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Extension detection
  useEffect(() => {
    function check() {
      setExtensionActive(isExtensionActive());
    }
    check();
    const timer = setInterval(check, 2000);
    return () => clearInterval(timer);
  }, []);

  async function loadProfile(userId: string) {
    const supabase = createClient();
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (data) {
      setProfile(data as Profile);
      setSelectedAI(data.default_ai as AIModel);
    }
  }

  async function loadChats(userId: string) {
    const supabase = createClient();
    const { data } = await supabase
      .from('chats')
      .select('id, name, ai_model, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(MAX_CHATS);
    if (data) setChats(data as ChatSummary[]);
  }

  async function handleSelectChat(id: string) {
    const supabase = createClient();
    setCurrentChatId(id);
    const { data } = await supabase
      .from('chats')
      .select('messages, ai_model')
      .eq('id', id)
      .single();
    if (data) {
      setMessages(data.messages as Message[]);
      setSelectedAI(data.ai_model as AIModel);
    }
  }

  function handleNewChat() {
    setCurrentChatId(null);
    setMessages([]);
    setSelectedAI(profile?.default_ai ?? 'chatgpt');
    setLoading(false);
    setTransferring(false);
    // Compare must reset on every new chat — that's one of the documented "switch off" paths
    // (along with re-clicking the pill and full page refresh).
    setCompareMode(false);
    setCompareAIs([]);
    setCompareLocked(false);
  }

  // toggleCompare: invoked from the Compare pill in InputBar. Flipping ON clears any stale
  // selection so the picker starts empty. Flipping OFF wipes selection and lock; already-rendered
  // compare messages stay visible in the thread (read as historical), and the single-AI flow
  // resumes immediately. While compareMode is true, handleSwitchAI is a hard no-op (see below)
  // so there's no chance of cross-contamination with the single-AI path.
  function toggleCompare() {
    setCompareMode((prev) => {
      const next = !prev;
      if (next) {
        setCompareAIs([]);
        setCompareLocked(false);
      } else {
        setCompareAIs([]);
        setCompareLocked(false);
      }
      return next;
    });
  }

  // toggleCompareAI: add/remove an AI from the picker. Only meaningful while !compareLocked;
  // once locked the selector card is hidden so this isn't called.
  function toggleCompareAI(ai: AIModel) {
    setCompareAIs((prev) =>
      prev.includes(ai) ? prev.filter((x) => x !== ai) : [...prev, ai]
    );
  }

  // saveChat: upserts the chat row in Supabase, then refreshes the sidebar list.
  // Called fire-and-forget from message handlers — never awaited inside the UI try-block, because a
  // hung Supabase write would otherwise block the loading spinner. Supabase returns errors as a
  // value (not a throw), so the outer .catch() does NOT see RLS / schema / auth failures — we have
  // to log `error` explicitly here. If chats stop appearing in the sidebar, that console line is
  // the entry point for diagnosis.
  async function saveChat(
    chatId: string,
    chatName: string,
    updatedMessages: Message[],
    ai: AIModel
  ) {
    if (!user) return;

    const supabase = createClient();
    const { error } = await supabase.from('chats').upsert({
      id: chatId,
      user_id: user.id,
      name: chatName,
      messages: updatedMessages,
      ai_model: ai,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error('saveChat upsert error:', error);
      return;
    }
    await loadChats(user.id);
  }

  // runCompareTurn: parallel fan-out to the selected AI set. Pushes the user message and a
  // single compare message (responses all 'pending'), then fires sendMessageToAI() per AI
  // concurrently, settling each slot independently via Promise.allSettled. Failed sends become
  // status: 'error' slides; they do NOT poison the other slots. After this resolves, compareLocked
  // is true so follow-ups reuse the same set. Intentionally never calls saveChat() — Compare is
  // memory-only for now (Supabase schema has a single ai_model per chat).
  // Compare deliberately ignores aiOptions[ai] — it's a baseline shootout. Per-AI tools/models
  // apply only to the single-AI flow (handleSendMessage below).
  async function runCompareTurn(text: string, ais: AIModel[]) {
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    const compareId = generateId();
    const initial: CompareResponse[] = ais.map((ai) => ({
      ai,
      content: '',
      status: 'pending',
    }));
    const compareMessage: Message = {
      id: compareId,
      role: 'compare',
      content: '',
      timestamp: Date.now(),
      responses: initial,
    };
    setMessages((prev) => [...prev, userMessage, compareMessage]);
    setLoading(true);
    setCompareLocked(true);

    await Promise.allSettled(
      ais.map(async (ai) => {
        try {
          const resp = await sendMessageToAI(ai, text, timeoutMs);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === compareId && m.responses
                ? {
                    ...m,
                    responses: m.responses.map((r) =>
                      r.ai === ai ? { ...r, content: resp, status: 'done' } : r
                    ),
                  }
                : m
            )
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === compareId && m.responses
                ? {
                    ...m,
                    responses: m.responses.map((r) =>
                      r.ai === ai ? { ...r, status: 'error', error: detail } : r
                    ),
                  }
                : m
            )
          );
        }
      })
    );

    setLoading(false);
  }

  // retryCompareSlide: RE-READ the latest assistant message from the AI's existing tab — does
  // NOT re-send the prompt. Solves the "Wrapperr captured only the start / 'Thinking…'" failure
  // by re-scraping the tab where the AI has by now finished generating in full. The capture
  // pipeline prefers the network buffer (markdown-fidelity) and falls back to DOM. Sets the
  // slide back to 'pending' for visual feedback; on success swaps to 'done' with the freshly
  // read content; on failure swaps to 'error' so the user can still try again.
  async function retryCompareSlide(compareId: string, ai: AIModel) {
    setMessages((cur) =>
      cur.map((m) =>
        m.id === compareId && m.responses
          ? {
              ...m,
              responses: m.responses.map((r) =>
                r.ai === ai ? { ...r, status: 'pending', error: undefined } : r
              ),
            }
          : m
      )
    );

    try {
      const resp = await rereadFromAI(ai, timeoutMs);
      setMessages((cur) =>
        cur.map((m) =>
          m.id === compareId && m.responses
            ? {
                ...m,
                responses: m.responses.map((r) =>
                  r.ai === ai ? { ...r, content: resp, status: 'done' } : r
                ),
              }
            : m
        )
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setMessages((cur) =>
        cur.map((m) =>
          m.id === compareId && m.responses
            ? {
                ...m,
                responses: m.responses.map((r) =>
                  r.ai === ai ? { ...r, status: 'error', error: detail } : r
                ),
              }
            : m
        )
      );
    }
  }

  async function handleSendMessage(text: string) {
    if (!extensionActive) return;

    // Compare branch — completely isolated from the single-AI flow. Requires ≥2 AIs in the
    // selected set; otherwise the InputBar's send is disabled so we shouldn't get here, but
    // we guard defensively.
    if (compareMode) {
      if (compareAIs.length < 2) return;
      await runCompareTurn(text, compareAIs);
      return;
    }

    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setLoading(true);

    // Create chat ID on first message
    let chatId = currentChatId;
    let chatName = chats.find((c) => c.id === chatId)?.name ?? '';

    if (!chatId) {
      if (chats.length >= MAX_CHATS) {
        setMessages((m) => [
          ...m,
          {
            id: generateId(),
            role: 'assistant',
            content: `You have reached the ${MAX_CHATS}-chat limit. Please delete some chats in Settings → Memory to start a new conversation.`,
            aiModel: selectedAI,
            timestamp: Date.now(),
          },
        ]);
        setLoading(false);
        return;
      }
      chatId = generateId();
      chatName = chatNameFromMessage(text);
      setCurrentChatId(chatId);
    }

    try {
      // Per-AI options for the active AI are passed through. If applyOptions isn't wired for
      // this AI yet (FEATURES_WIRED[ai] === false in aiFeatures.ts) the content script ignores
      // the payload and sends with the site's current state — the UI shows a dim caption so
      // the user knows the toggles aren't live yet.
      const response = await sendMessageToAI(selectedAI, text, timeoutMs, aiOptions[selectedAI]);

      const aiMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: response,
        aiModel: selectedAI,
        timestamp: Date.now(),
      };

      const finalMessages = [...updatedMessages, aiMessage];
      setMessages(finalMessages);
      saveChat(chatId, chatName, finalMessages, selectedAI).catch((e) =>
        console.error('saveChat failed:', e)
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const errMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: `Something went wrong: ${detail}`,
        aiModel: selectedAI,
        timestamp: Date.now(),
      };
      setMessages([...updatedMessages, errMessage]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitchAI(newAI: AIModel) {
    // Defensive: while Compare is on the UI hides the model selector, but if any code path
    // tries to switch the active single-AI we silently no-op. Compare must never trigger the
    // summary-relay flow.
    if (compareMode) return;
    if (newAI === selectedAI) return;

    // No messages yet — just switch
    if (messages.length === 0) {
      setSelectedAI(newAI);
      return;
    }

    setTransferring(true);

    try {
      const summary = await sendMessageToAI(selectedAI, SUMMARY_PROMPT, timeoutMs);

      setSelectedAI(newAI);

      const contextMessage = `Here's the context from our previous conversation:\n\n${summary}\n\nPlease continue from where we left off.`;
      const contextResponse = await sendMessageToAI(newAI, contextMessage, timeoutMs);

      const transferMsg: Message = {
        id: generateId(),
        role: 'assistant',
        content: contextResponse,
        aiModel: newAI,
        timestamp: Date.now(),
      };

      const updatedMessages = [...messages, transferMsg];
      setMessages(updatedMessages);

      if (currentChatId) {
        const chatName = chats.find((c) => c.id === currentChatId)?.name ?? 'Chat';
        saveChat(currentChatId, chatName, updatedMessages, newAI).catch((e) =>
          console.error('saveChat failed:', e)
        );
      }
    } catch {
      setSelectedAI(newAI);
    } finally {
      setTransferring(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="w-5 h-5 border border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-bg overflow-hidden">
      <Sidebar
        chats={chats}
        currentChatId={currentChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        isLoggedIn={!!user}
      />

      <main className="flex-1 flex flex-col min-w-0">
        <ChatWindow
          user={user}
          extensionActive={extensionActive}
          messages={messages}
          selectedAI={selectedAI}
          loading={loading}
          transferring={transferring}
          timeoutMs={timeoutMs}
          chatName={chats.find((c) => c.id === currentChatId)?.name}
          onSendMessage={handleSendMessage}
          onSwitchAI={handleSwitchAI}
          onTimeoutChange={setTimeoutMs}
          compareMode={compareMode}
          compareAIs={compareAIs}
          compareLocked={compareLocked}
          onToggleCompare={toggleCompare}
          onToggleCompareAI={toggleCompareAI}
          onRetryCompareSlide={retryCompareSlide}
          aiOptions={aiOptions}
          onAIOptionChange={setAIOption}
        />
      </main>
    </div>
  );
}
