-- Run this in the Supabase SQL editor to set up the SYNAP project for Wrapperr.
-- Drop existing tables first (clean rebuild of SYNAP project).

-- Destructive teardown block: CASCADE wipes child rows too. Running this in production will
-- delete every chat/profile/command/memory — only ever execute on a fresh project or accept full reset.
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS commands CASCADE;
DROP TABLE IF EXISTS chats CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;

-- profiles: one row per auth user
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT DEFAULT '',
  default_ai TEXT DEFAULT 'chatgpt',
  appearance TEXT DEFAULT 'dark',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- chats: max 25 per user, enforced in application
CREATE TABLE chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]',
  ai_model TEXT NOT NULL DEFAULT 'chatgpt',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX chats_user_id_idx ON chats(user_id, updated_at DESC);

-- commands: placeholder for v2 features
CREATE TABLE commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- memories: personal memory units shared across all AIs. One row = one saved item (a full
-- message or a highlighted snippet). Shared table partitioned per user via RLS (user_id +
-- auth.uid() policies below) — NOT a physical table per user. The total-characters cap
-- (MEMORY_CHAR_LIMIT = 2000) is enforced in the web app (lib/memory.ts), NOT at the DB layer,
-- so a malicious client could exceed it; move to a pre-insert trigger if abuse becomes a concern.
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_unit TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX memories_user_id_idx ON memories(user_id, created_at DESC);

-- =====================
-- Row Level Security
-- =====================

-- Enable RLS on every user-data table. Without this, the anon/auth-key clients could read/write
-- ANY row. Every table below MUST have matching policies — RLS-enabled with no policies = total
-- lockout (selects return zero rows silently, which is a confusing failure mode).
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- profiles RLS: each auth user can read/write only their own row (id = auth.uid()). No DELETE
-- policy on purpose — profile deletion is handled by the auth.users CASCADE when the user is
-- removed via the delete_user() RPC below.
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- chats RLS: full CRUD scoped to owner. The MAX_CHATS=25 cap is enforced in the web app
-- (lib/constants.ts), NOT at the DB layer — a malicious client can exceed it. Move to a
-- pre-insert trigger if abuse becomes a concern.
CREATE POLICY "Users can view own chats" ON chats
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chats" ON chats
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chats" ON chats
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own chats" ON chats
  FOR DELETE USING (auth.uid() = user_id);

-- commands RLS: same owner-only CRUD pattern as chats. Table is a v2 placeholder and not yet
-- written to by any client code — policies exist so the surface is locked down by default.
CREATE POLICY "Users can view own commands" ON commands
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own commands" ON commands
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own commands" ON commands
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own commands" ON commands
  FOR DELETE USING (auth.uid() = user_id);

-- memories RLS: owner-only read / insert / delete. No UPDATE policy — memory units are
-- immutable once saved (edit = delete + re-add), matching the simple v1 surface. Same
-- auth.uid() = user_id ownership check as chats/commands.
CREATE POLICY "Users can view own memories" ON memories
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own memories" ON memories
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own memories" ON memories
  FOR DELETE USING (auth.uid() = user_id);

-- =====================
-- Auto-create profile on signup
-- =====================

-- handle_new_user trigger function: auto-creates a matching `profiles` row on every new auth
-- signup so the app never has to deal with "user exists but profile doesn't" branches.
-- SECURITY DEFINER + fixed search_path is required so the function bypasses RLS (the new auth
-- user has no JWT yet) without being vulnerable to search_path injection.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, name, default_ai, appearance)
  VALUES (NEW.id, '', 'chatgpt', 'dark')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- =====================
-- Account deletion function (called client-side via rpc)
-- =====================

-- delete_user RPC: invoked client-side from the AccountTab "Delete account" flow. Deletes the
-- caller's auth.users row, which cascades to profiles/chats/commands. SECURITY DEFINER is
-- required because regular clients cannot touch the auth schema directly — auth.uid() ensures
-- a caller can only delete themselves.
CREATE OR REPLACE FUNCTION delete_user()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM auth.users WHERE id = auth.uid();
END;
$$;
