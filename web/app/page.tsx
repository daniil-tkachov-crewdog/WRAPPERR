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
  const [authLoading, setAuthLoading] = useState(true);
  const [extensionActive, setExtensionActive] = useState(false);

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedAI, setSelectedAI] = useState<AIModel>('chatgpt');
  const [loading, setLoading] = useState(false);
  const [transferring, setTransferring] = useState(false);

  // Auth init
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        await loadProfile(session.user.id);
        await loadChats(session.user.id);
      }
      setAuthLoading(false);
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
  }

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

    if (!error) {
      await loadChats(user.id);
    }
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
      const response = await sendMessageToAI(selectedAI, text);

      const aiMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: response,
        aiModel: selectedAI,
        timestamp: Date.now(),
      };

      const finalMessages = [...updatedMessages, aiMessage];
      setMessages(finalMessages);
      await saveChat(chatId, chatName, finalMessages, selectedAI);
    } catch (err) {
      const errMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: 'Something went wrong. Please check the extension and try again.',
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
      const summary = await sendMessageToAI(selectedAI, SUMMARY_PROMPT);

      setSelectedAI(newAI);

      const contextMessage = `Here's the context from our previous conversation:\n\n${summary}\n\nPlease continue from where we left off.`;
      const contextResponse = await sendMessageToAI(newAI, contextMessage);

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
        await saveChat(currentChatId, chatName, updatedMessages, newAI);
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
          onSendMessage={handleSendMessage}
          onSwitchAI={handleSwitchAI}
        />
      </main>
    </div>
  );
}
