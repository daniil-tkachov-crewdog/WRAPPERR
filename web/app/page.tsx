'use client';

import { useState, useEffect, useCallback } from 'react';
import type { User } from '@supabase/supabase-js';
import type { Message, AIModel, ChatSummary, Profile } from '@/lib/types';
import { AI_MODELS, MAX_CHATS, SUMMARY_PROMPT } from '@/lib/constants';
import { isExtensionActive, sendMessageToAI } from '@/lib/extension';
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

  async function handleSendMessage(text: string) {
    if (!extensionActive) return;

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
      const response = await sendMessageToAI(selectedAI, text, timeoutMs);

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
          onSendMessage={handleSendMessage}
          onSwitchAI={handleSwitchAI}
          onTimeoutChange={setTimeoutMs}
        />
      </main>
    </div>
  );
}
