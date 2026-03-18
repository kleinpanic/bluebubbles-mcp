#!/usr/bin/env node
/**
 * BlueBubbles MCP Server v2.0
 *
 * Tools (21 total):
 *   bb_server_info          — server health & version
 *   bb_list_chats           — list conversations
 *   bb_get_chat             — single chat detail by GUID
 *   bb_get_chat_messages    — messages in a chat
 *   bb_create_chat          — start a new conversation
 *   bb_delete_chat          — delete/archive a chat
 *   bb_list_contacts        — address book contacts (with normalized search)
 *   bb_contact_query        — phone/email → full contact info (server-normalized)
 *   bb_list_handles         — all iMessage handles on this Mac
 *   bb_handle_query         — addresses → handle objects + chat GUIDs
 *   bb_send_message         — send iMessage/SMS text
 *   bb_send_attachment      — send file/image (base64 input)
 *   bb_get_attachment       — download attachment by GUID
 *   bb_react_message        — send tapback reaction
 *   bb_unsend_message       — unsend a message (private-api)
 *   bb_edit_message         — edit a sent message (private-api)
 *   bb_set_typing           — send typing indicator (private-api)
 *   bb_mark_read            — mark a chat as read
 *   bb_find_my_devices      — iCloud Find My devices
 *   bb_find_my_friends      — Find My friends/locations
 *
 * Transport:
 *   MCP_TRANSPORT=stdio (default) — stdio MCP (backward compat)
 *   MCP_TRANSPORT=http            — HTTP/SSE on MCP_BIND:MCP_PORT (default 10.70.80.12:18791)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// ─── Config ────────────────────────────────────────────────────────────────────
const BB_URL = process.env.BB_URL ?? "http://127.0.0.1:1234";
const MCP_TRANSPORT = process.env.MCP_TRANSPORT ?? "stdio";
const MCP_PORT = parseInt(process.env.MCP_PORT ?? "18791", 10);
const MCP_BIND = process.env.MCP_BIND ?? "10.70.80.12";
const MCP_VERSION = "2.0.0";

let BB_PASSWORD = process.env.BB_PASSWORD ?? "";
if (!BB_PASSWORD && process.env.BB_PASSWORD_FILE) {
  try {
    if (existsSync(process.env.BB_PASSWORD_FILE)) {
      BB_PASSWORD = readFileSync(process.env.BB_PASSWORD_FILE, "utf-8").trim();
    }
  } catch (err) {
    process.stderr.write("Failed to read password file: " + err + "\n");
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────
function apiUrl(path: string, params: Record<string, string | number> = {}): string {
  const url = new URL(`${BB_URL}${path}`);
  url.searchParams.set("password", BB_PASSWORD);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url.toString();
}

async function bbGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const res = await fetch(apiUrl(path, params));
  if (!res.ok) throw new Error(`BlueBubbles GET ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function bbPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`BlueBubbles POST ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function bbDelete<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { method: "DELETE" });
  if (!res.ok) throw new Error(`BlueBubbles DELETE ${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** Graceful handler for private-api errors — returns structured failure instead of throwing */
function privateApiError(feature: string): string {
  return JSON.stringify({
    ok: false,
    reason: "private_api_unavailable",
    feature,
    hint: "BlueBubbles helper app must be connected and private-api enabled for this feature. Check bb_server_info for private_api status.",
  });
}

function isPrivateApiError(err: Error): boolean {
  return err.message.includes("helper") || err.message.includes("private") ||
    err.message.includes("500") || err.message.includes("not connected");
}

// ─── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS: Tool[] = [
  // ── Server ─────────────────────────────────────────────────────────────────
  {
    name: "bb_server_info",
    description: "Get BlueBubbles server info, health, and version. Check 'private_api' field before using private-api tools.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── Chats ───────────────────────────────────────────────────────────────────
  {
    name: "bb_list_chats",
    description: "List all iMessage/SMS conversations. Returns guid, displayName, participants, lastMessage.",
    inputSchema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Max chats to return (default 25)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
        sort:   { type: "string", description: "'lastmessage' (default) or 'id'", enum: ["lastmessage", "id"] },
      },
      required: [],
    },
  },
  {
    name: "bb_get_chat",
    description: "Get a single chat's full details by GUID. Faster than listing all chats when you already know the GUID.",
    inputSchema: {
      type: "object",
      properties: {
        guid: { type: "string", description: "The chat GUID (e.g. iMessage;-;+12673479614)" },
      },
      required: ["guid"],
    },
  },
  {
    name: "bb_create_chat",
    description: "Start a new iMessage or SMS conversation.",
    inputSchema: {
      type: "object",
      properties: {
        addresses:  { type: "array", items: { type: "string" }, description: "Phone numbers or emails to add to the chat" },
        message:    { type: "string", description: "Optional opening message to send" },
        isGroup:    { type: "boolean", description: "Create as group chat (default false)" },
        groupName:  { type: "string", description: "Group chat display name (only for group chats)" },
      },
      required: ["addresses"],
    },
  },
  {
    name: "bb_delete_chat",
    description: "Delete or archive a chat locally. Does not delete from other participants.",
    inputSchema: {
      type: "object",
      properties: {
        guid: { type: "string", description: "The chat GUID to delete" },
      },
      required: ["guid"],
    },
  },

  // ── Messages ────────────────────────────────────────────────────────────────
  {
    name: "bb_get_chat_messages",
    description: "Get messages from a specific chat by GUID.",
    inputSchema: {
      type: "object",
      properties: {
        chat_guid: { type: "string", description: "The chat GUID (from bb_list_chats or bb_handle_query)" },
        limit:     { type: "number", description: "Max messages to return (default 25)" },
        offset:    { type: "number", description: "Pagination offset (default 0)" },
        sort:      { type: "string", description: "'DESC' (newest first, default) or 'ASC'", enum: ["DESC", "ASC"] },
        after:     { type: "number", description: "Return only messages after this Unix timestamp (ms)" },
      },
      required: ["chat_guid"],
    },
  },
  {
    name: "bb_send_message",
    description: "Send an iMessage or SMS text. Use chat_guid (preferred) or a phone number/email as the address.",
    inputSchema: {
      type: "object",
      properties: {
        chat_guid: { type: "string", description: "Chat GUID or phone number/email address" },
        message:   { type: "string", description: "Message text to send" },
        method:    { type: "string", description: "'apple-script' (default, more compatible) or 'private-api' (faster)", enum: ["apple-script", "private-api"] },
      },
      required: ["chat_guid", "message"],
    },
  },
  {
    name: "bb_send_attachment",
    description: "Send a file or image to a chat. Accepts base64-encoded data. The MCP decodes it to a temp file on collins before uploading.",
    inputSchema: {
      type: "object",
      properties: {
        chat_guid:  { type: "string", description: "The chat GUID to send the file to" },
        attachment: { type: "string", description: "Base64-encoded file content" },
        filename:   { type: "string", description: "Filename including extension (e.g. 'photo.jpg')" },
        mimeType:   { type: "string", description: "MIME type (e.g. 'image/jpeg', 'image/png', 'application/pdf')" },
      },
      required: ["chat_guid", "attachment", "filename", "mimeType"],
    },
  },
  {
    name: "bb_get_attachment",
    description: "Get attachment metadata by GUID. Set download=true to include base64 file data.",
    inputSchema: {
      type: "object",
      properties: {
        guid:     { type: "string", description: "Attachment GUID" },
        download: { type: "boolean", description: "If true, fetch and return base64-encoded file data (default false)" },
      },
      required: ["guid"],
    },
  },
  {
    name: "bb_react_message",
    description: "Send a tapback reaction to a message. Requires private-api / helper connected. Reaction IDs: 2000=❤️love, 2001=👍like, 2002=👎dislike, 2003=😂laugh, 2004=‼️emphasis, 2005=?question. Prefix with - to remove (e.g. -2000).",
    inputSchema: {
      type: "object",
      properties: {
        chatGuid:    { type: "string", description: "The chat GUID" },
        messageGuid: { type: "string", description: "The message GUID to react to" },
        reaction:    { type: "number", description: "Reaction ID (2000-2005, or negative to remove)" },
      },
      required: ["chatGuid", "messageGuid", "reaction"],
    },
  },
  {
    name: "bb_unsend_message",
    description: "Unsend a message (removes it for all participants). Requires private-api / helper connected. Returns ok:false if unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        guid: { type: "string", description: "The message GUID to unsend" },
      },
      required: ["guid"],
    },
  },
  {
    name: "bb_edit_message",
    description: "Edit the text of a sent iMessage. Requires private-api / helper connected. Returns ok:false if unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        guid:          { type: "string", description: "The message GUID to edit" },
        editedMessage: { type: "string", description: "The new text content" },
      },
      required: ["guid", "editedMessage"],
    },
  },
  {
    name: "bb_set_typing",
    description: "Send or stop a typing indicator in a chat. Requires private-api / helper connected. Returns ok:false if unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        guid:   { type: "string", description: "The chat GUID" },
        typing: { type: "boolean", description: "true to start typing, false to stop" },
      },
      required: ["guid", "typing"],
    },
  },
  {
    name: "bb_mark_read",
    description: "Mark a chat as read (clears unread/notification count).",
    inputSchema: {
      type: "object",
      properties: {
        guid: { type: "string", description: "The chat GUID to mark as read" },
      },
      required: ["guid"],
    },
  },

  // ── Contacts ────────────────────────────────────────────────────────────────
  {
    name: "bb_list_contacts",
    description: "List address book contacts. Search is normalized — '+12673479614' will match '(267) 347-9614'. Returns name, phones, emails.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search query — name, phone (any format), or email" },
        limit:  { type: "number", description: "Max contacts to return (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "bb_contact_query",
    description: "THE canonical contact lookup. Pass phone numbers or emails in any format — BlueBubbles normalizes them server-side and returns full contact info. Use this first when you have a number and need a name, or vice versa.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "array",
          items: { type: "string" },
          description: "List of phone numbers or emails to look up (any format: '+12673479614', '(267) 347-9614', 'user@email.com')",
        },
      },
      required: ["addresses"],
    },
  },

  // ── Handles ──────────────────────────────────────────────────────────────────
  {
    name: "bb_list_handles",
    description: "List all iMessage/SMS handles (addresses) seen on this Mac. Handles are the addresses embedded in chat GUIDs.",
    inputSchema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Max handles to return (default 100)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: [],
    },
  },
  {
    name: "bb_handle_query",
    description: "Look up handles by address. Returns handle objects including associated chat GUIDs. Best way to go from a phone number → chat GUID.",
    inputSchema: {
      type: "object",
      properties: {
        addresses: {
          type: "array",
          items: { type: "string" },
          description: "Phone numbers or emails to look up",
        },
      },
      required: ["addresses"],
    },
  },

  // ── Find My ──────────────────────────────────────────────────────────────────
  {
    name: "bb_find_my_devices",
    description: "Find My — list all iCloud devices with name, location, battery, and status.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "bb_find_my_friends",
    description: "Find My — list friends and their current locations.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

// ─── Normalize phone to digits only (for search comparison) ───────────────────
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

function phoneMatches(phone: string, query: string): boolean {
  const pd = digitsOnly(phone);
  const qd = digitsOnly(query);
  if (!pd || !qd) return false;
  // Match if either is a suffix of the other (handles country code variations)
  return pd.endsWith(qd) || qd.endsWith(pd) || pd.includes(qd) || qd.includes(pd);
}

// ─── Tool handlers ─────────────────────────────────────────────────────────────

async function handleServerInfo(): Promise<string> {
  const data = await bbGet<Record<string, unknown>>("/api/v1/server/info");
  return JSON.stringify(data, null, 2);
}

async function handleListChats(args: Record<string, unknown>): Promise<string> {
  const limit  = Number(args.limit ?? 25);
  const offset = Number(args.offset ?? 0);
  const sort   = String(args.sort ?? "lastmessage");
  const data   = await bbPost<Record<string, unknown>>("/api/v1/chat/query", { limit, offset, sort, withLastMessage: true });

  interface Chat {
    guid: string; displayName?: string; groupName?: string;
    participants?: Array<{ address?: string; firstName?: string; lastName?: string }>;
    lastMessage?: { text?: string; dateCreated?: number };
    isArchived?: boolean;
  }
  const chats = (data.data as Chat[]) ?? [];
  return JSON.stringify({
    total: data.metadata ?? chats.length,
    chats: chats.map(c => ({
      guid: c.guid,
      displayName: c.displayName || c.groupName || "(no name)",
      participants: (c.participants ?? []).map(p => `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || p.address),
      lastMessage: c.lastMessage?.text?.slice(0, 100),
      lastMessageAt: c.lastMessage?.dateCreated,
      isArchived: c.isArchived,
    })),
  }, null, 2);
}

async function handleGetChat(args: Record<string, unknown>): Promise<string> {
  const guid = String(args.guid);
  const data = await bbGet<Record<string, unknown>>(`/api/v1/chat/${encodeURIComponent(guid)}`);
  return JSON.stringify(data, null, 2);
}

async function handleCreateChat(args: Record<string, unknown>): Promise<string> {
  const addresses = args.addresses as string[];
  const body: Record<string, unknown> = { addresses };
  if (args.message)   body.message   = args.message;
  if (args.isGroup)   body.isGroup   = args.isGroup;
  if (args.groupName) body.groupName = args.groupName;
  const data = await bbPost<Record<string, unknown>>("/api/v1/chat/new", body);
  return JSON.stringify(data, null, 2);
}

async function handleDeleteChat(args: Record<string, unknown>): Promise<string> {
  const guid = String(args.guid);
  const data = await bbDelete<Record<string, unknown>>(`/api/v1/chat/${encodeURIComponent(guid)}`);
  return JSON.stringify(data, null, 2);
}

async function handleGetChatMessages(args: Record<string, unknown>): Promise<string> {
  const chatGuid = String(args.chatGuid ?? args.chat_guid);
  const limit    = Number(args.limit ?? 25);
  const offset   = Number(args.offset ?? 0);
  const sort     = String(args.sort ?? "DESC");
  const params: Record<string, string | number> = { limit, offset, sort };
  if (args.after) params.after = Number(args.after);

  const data = await bbGet<Record<string, unknown>>(
    `/api/v1/chat/${encodeURIComponent(chatGuid)}/message`, params
  );
  interface Message {
    guid: string; text?: string; handle?: { address?: string };
    isFromMe?: boolean; dateCreated?: number; dateRead?: number;
    hasAttachments?: boolean; error?: number;
  }
  const messages = (data.data as Message[]) ?? [];
  return JSON.stringify({
    count: messages.length,
    messages: messages.map(m => ({
      guid: m.guid, text: m.text,
      from: m.isFromMe ? "me" : m.handle?.address,
      dateCreated: m.dateCreated, dateRead: m.dateRead,
      hasAttachments: m.hasAttachments, error: m.error,
    })),
  }, null, 2);
}

async function handleSendMessage(args: Record<string, unknown>): Promise<string> {
  let chatGuid = String(args.chatGuid ?? args.chat_guid);
  const message = String(args.message);
  const method  = String(args.method ?? "private-api");
  // Normalize bare phone numbers to iMessage GUID format
  if (/^\+?\d{7,15}$/.test(chatGuid)) {
    const digits = chatGuid.replace(/\D/g, "");
    chatGuid = `iMessage;-;+${digits}`;
  } else if (/^\d{10}$/.test(chatGuid)) {
    chatGuid = `iMessage;-;+1${chatGuid}`;
  }
  const data = await bbPost<Record<string, unknown>>("/api/v1/message/text", {
    chatGuid, message, method, subject: "", tempGuid: `temp-${Date.now()}`,
  });
  return JSON.stringify(data, null, 2);
}

async function handleSendAttachment(args: Record<string, unknown>): Promise<string> {
  const chatGuid   = String(args.chat_guid ?? args.chatGuid);
  const b64        = String(args.attachment);
  const filename   = String(args.filename);
  const mimeType   = String(args.mimeType);

  // Decode base64 to temp file
  const tmpDir  = os.tmpdir();
  const tmpFile = path.join(tmpDir, `bb-attach-${crypto.randomBytes(6).toString("hex")}-${filename}`);
  try {
    writeFileSync(tmpFile, Buffer.from(b64, "base64"));
  } catch (err) {
    throw new Error(`Failed to decode attachment: ${(err as Error).message}`);
  }

  // Multipart upload using FormData + fetch
  try {
    const formData = new FormData();
    formData.append("chatGuid", chatGuid);
    formData.append("name", filename);
    formData.append("tempGuid", `temp-${Date.now()}`);
    const fileBuffer = readFileSync(tmpFile);
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append("attachment", blob, filename);

    const url = new URL(`${BB_URL}/api/v1/message/attachment`);
    url.searchParams.set("password", BB_PASSWORD);
    const res = await fetch(url.toString(), { method: "POST", body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return JSON.stringify(await res.json(), null, 2);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function handleGetAttachment(args: Record<string, unknown>): Promise<string> {
  const guid      = String(args.guid);
  const maxBytes  = Number(args.maxBytes ?? 200 * 1024);  // default 200KB limit for base64 inline

  // Get metadata
  const meta    = await bbGet<Record<string, unknown>>(`/api/v1/attachment/${encodeURIComponent(guid)}`);
  const attMeta = (meta.data ?? meta) as Record<string, unknown>;
  const totalBytes = Number(attMeta.totalBytes ?? 0);
  const mime       = String(attMeta.mimeType ?? "application/octet-stream");

  // Provide direct download URL (no auth in path — BB password in query param)
  const dlUrl = `${BB_URL}/api/v1/attachment/${encodeURIComponent(guid)}/download?password=${encodeURIComponent(BB_PASSWORD)}`;

  // If file is small enough, inline base64; otherwise just return the URL
  if (totalBytes > 0 && totalBytes <= maxBytes) {
    const res = await fetch(dlUrl);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      return JSON.stringify({
        guid, transferName: attMeta.transferName, mimeType: mime,
        totalBytes: buf.length,
        data: buf.toString("base64"),
      }, null, 2);
    }
  }

  // Large files or failed download — return metadata + URL for manual fetch
  return JSON.stringify({
    guid,
    transferName: attMeta.transferName,
    mimeType:     mime,
    totalBytes,
    downloadUrl:  dlUrl,
    note:         totalBytes > maxBytes
      ? `File too large (${totalBytes} bytes > ${maxBytes} limit) for inline base64. Fetch downloadUrl directly.`
      : "Download URL provided for direct fetch.",
  }, null, 2);
}

// Reaction name map — BB v1.9.9 requires named strings, not integers
const REACTION_MAP: Record<string, string> = {
  "love": "love", "like": "like", "dislike": "dislike",
  "laugh": "laugh", "emphasize": "emphasize", "question": "question",
  "-love": "-love", "-like": "-like", "-dislike": "-dislike",
  "-laugh": "-laugh", "-emphasize": "-emphasize", "-question": "-question",
  // Integer aliases (iMessage associatedMessageType)
  "2000": "love",  "2001": "like",  "2002": "dislike",
  "2003": "laugh", "2004": "emphasize", "2005": "question",
  "3000": "-love", "3001": "-like",  "3002": "-dislike",
  "3003": "-laugh","3004": "-emphasize","3005": "-question",
};
async function handleReactMessage(args: Record<string, unknown>): Promise<string> {
  // private-api required — check bb_server_info private_api field before calling
  const rawReaction = String(args.reaction ?? "like");
  const reaction    = REACTION_MAP[rawReaction] ?? rawReaction;
  const data = await bbPost<Record<string, unknown>>("/api/v1/message/react", {
    chatGuid:            String(args.chatGuid),
    selectedMessageGuid: String(args.messageGuid),
    reaction,  // named string: "love","like","dislike","laugh","emphasize","question" (prefix - to remove)
  });
  return JSON.stringify(data, null, 2);
}

async function handleUnsendMessage(args: Record<string, unknown>): Promise<string> {
  try {
    const guid = String(args.guid);
    const data = await bbPost<Record<string, unknown>>(`/api/v1/message/${encodeURIComponent(guid)}/unsend`, {});
    return JSON.stringify(data, null, 2);
  } catch (err) {
    if (isPrivateApiError(err as Error)) return privateApiError("bb_unsend_message");
    throw err;
  }
}

async function handleEditMessage(args: Record<string, unknown>): Promise<string> {
  try {
    const guid = String(args.guid);
    const data = await bbPost<Record<string, unknown>>(`/api/v1/message/${encodeURIComponent(guid)}/edit`, {
      editedMessage: String(args.editedMessage),
      backwardsCompatibilityMessage: String(args.backwardsCompatibilityMessage ?? args.editedMessage),
      partIndex: Number(args.partIndex ?? 0),
    });
    return JSON.stringify(data, null, 2);
  } catch (err) {
    if (isPrivateApiError(err as Error)) return privateApiError("bb_edit_message");
    throw err;
  }
}

async function handleSetTyping(args: Record<string, unknown>): Promise<string> {
  try {
    const guid   = String(args.guid);
    const typing = Boolean(args.typing);
    const data   = await bbPost<Record<string, unknown>>(
      `/api/v1/chat/${encodeURIComponent(guid)}/typing`, { typing }
    );
    return JSON.stringify(data, null, 2);
  } catch (err) {
    if (isPrivateApiError(err as Error)) return privateApiError("bb_set_typing");
    throw err;
  }
}

async function handleMarkRead(args: Record<string, unknown>): Promise<string> {
  const guid = String(args.guid);
  const data = await bbPost<Record<string, unknown>>(
    `/api/v1/chat/${encodeURIComponent(guid)}/read`, {}
  );
  return JSON.stringify(data, null, 2);
}

async function handleListContacts(args: Record<string, unknown>): Promise<string> {
  const limit = Number(args.limit ?? 50);
  const data  = await bbGet<Record<string, unknown>>("/api/v1/contact", { limit: 500 }); // fetch all, filter client-side

  interface Contact {
    firstName?: string; lastName?: string; displayName?: string;
    phoneNumbers?: Array<{ address?: string }>;
    emails?: Array<{ address?: string }>;
  }
  const contacts = (data.data as Contact[]) ?? [];
  const search   = args.search ? String(args.search) : null;

  const filtered = search
    ? contacts.filter(c => {
        const name   = `${c.firstName ?? ""} ${c.lastName ?? ""} ${c.displayName ?? ""}`.toLowerCase();
        const phones = (c.phoneNumbers ?? []).map(p => p.address ?? "");
        const emails = (c.emails ?? []).map(e => e.address ?? "").join(" ").toLowerCase();
        const sl     = search.toLowerCase();
        // Name match (case-insensitive)
        if (name.includes(sl)) return true;
        // Email match
        if (emails.includes(sl)) return true;
        // Phone match — normalized digits comparison
        if (phones.some(p => phoneMatches(p, search))) return true;
        return false;
      })
    : contacts;

  return JSON.stringify({
    count: Math.min(filtered.length, limit),
    contacts: filtered.slice(0, limit).map(c => ({
      name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.displayName,
      phones: (c.phoneNumbers ?? []).map(p => p.address),
      emails: (c.emails ?? []).map(e => e.address),
    })),
  }, null, 2);
}

async function handleContactQuery(args: Record<string, unknown>): Promise<string> {
  const addresses = args.addresses as string[];
  const data = await bbPost<Record<string, unknown>>("/api/v1/contact/query", { addresses });
  return JSON.stringify(data, null, 2);
}

async function handleListHandles(args: Record<string, unknown>): Promise<string> {
  const limit  = Number(args.limit ?? 100);
  const offset = Number(args.offset ?? 0);
  // v1.9.9: GET /api/v1/handle is not exposed; use POST /api/v1/handle/query with empty addresses
  const data   = await bbPost<Record<string, unknown>>("/api/v1/handle/query", { addresses: [], limit, offset });
  return JSON.stringify(data, null, 2);
}

async function handleHandleQuery(args: Record<string, unknown>): Promise<string> {
  const addresses = (args.addresses as string[]).map(a => a.replace(/\D/g, ""));
  // BB v1.9.9 /api/v1/handle/query ignores the addresses filter — fetch all, filter client-side
  const PAGE = 200;
  let offset = 0, allHandles: Record<string, unknown>[] = [], total = Infinity;
  while (allHandles.length < total) {
    const page = await bbPost<Record<string, unknown>>("/api/v1/handle/query", { addresses: [], limit: PAGE, offset, withChats: false });
    const items = (page.data as Record<string, unknown>[]) ?? [];
    const meta  = page.metadata as Record<string, unknown> | undefined;
    if (total === Infinity) total = Number(meta?.total ?? items.length);
    if (!items.length) break;
    allHandles = allHandles.concat(items);
    offset += PAGE;
    if (allHandles.length >= total) break;
  }
  // Filter by normalized digits match
  const matched = allHandles.filter(h => {
    const hd = String((h as Record<string, unknown>).address ?? "").replace(/\D/g, "");
    return addresses.some(a => hd.endsWith(a) || a.endsWith(hd));
  });
  return JSON.stringify({ status: 200, message: "Success", data: matched, metadata: { total: matched.length } }, null, 2);
}

async function handleFindMyDevices(): Promise<string> {
  const data = await bbGet<Record<string, unknown>>("/api/v1/icloud/findmy/devices");
  interface Device { name?: string; batteryLevel?: number; batteryStatus?: string; deviceClass?: string;
    location?: { latitude?: number; longitude?: number; horizontalAccuracy?: number; timestamp?: number }; }
  const devices = (data.data as Device[]) ?? [];
  const summary = devices.map(d => ({
    name: d.name, class: d.deviceClass,
    battery: d.batteryLevel !== undefined ? String(Math.round((d.batteryLevel ?? 0) * 100)) + '% (' + (d.batteryStatus ?? '?') + ')' : 'unknown',
    location: d.location ? {
      lat: d.location.latitude?.toFixed(4), lon: d.location.longitude?.toFixed(4),
      accuracy: d.location.horizontalAccuracy, ts: d.location.timestamp,
    } : null,
  }));
  return JSON.stringify({ status: 200, count: summary.length, devices: summary }, null, 2);
}

async function handleFindMyFriends(): Promise<string> {
  const data = await bbGet<Record<string, unknown>>("/api/v1/icloud/findmy/friends");
  return JSON.stringify(data, null, 2);
}

// ─── Server setup ──────────────────────────────────────────────────────────────
function createServer(): Server {
  const server = new Server(
    { name: "bluebubbles-mcp", version: MCP_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      let result: string;
      switch (name) {
        case "bb_server_info":       result = await handleServerInfo(); break;
        case "bb_list_chats":        result = await handleListChats(args as Record<string, unknown>); break;
        case "bb_get_chat":          result = await handleGetChat(args as Record<string, unknown>); break;
        case "bb_create_chat":       result = await handleCreateChat(args as Record<string, unknown>); break;
        case "bb_delete_chat":       result = await handleDeleteChat(args as Record<string, unknown>); break;
        case "bb_get_chat_messages": result = await handleGetChatMessages(args as Record<string, unknown>); break;
        case "bb_send_message":      result = await handleSendMessage(args as Record<string, unknown>); break;
        case "bb_send_attachment":   result = await handleSendAttachment(args as Record<string, unknown>); break;
        case "bb_get_attachment":    result = await handleGetAttachment(args as Record<string, unknown>); break;
        case "bb_react_message":     result = await handleReactMessage(args as Record<string, unknown>); break;
        case "bb_unsend_message":    result = await handleUnsendMessage(args as Record<string, unknown>); break;
        case "bb_edit_message":      result = await handleEditMessage(args as Record<string, unknown>); break;
        case "bb_set_typing":        result = await handleSetTyping(args as Record<string, unknown>); break;
        case "bb_mark_read":         result = await handleMarkRead(args as Record<string, unknown>); break;
        case "bb_list_contacts":     result = await handleListContacts(args as Record<string, unknown>); break;
        case "bb_contact_query":     result = await handleContactQuery(args as Record<string, unknown>); break;
        case "bb_list_handles":      result = await handleListHandles(args as Record<string, unknown>); break;
        case "bb_handle_query":      result = await handleHandleQuery(args as Record<string, unknown>); break;
        case "bb_find_my_devices":   result = await handleFindMyDevices(); break;
        case "bb_find_my_friends":   result = await handleFindMyFriends(); break;
        default: throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (MCP_TRANSPORT === "http") {
    // HTTP/SSE mode — persistent service bound to wg-teleport mesh IP
    // NOTE: A new Server instance must be created per SSE connection.
    // The MCP SDK Server is NOT reusable across connections.
    const sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      // Health check
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: MCP_VERSION, transport: "http/sse", tools: TOOLS.length, activeSessions: sessions.size }));
        return;
      }

      // SSE connection endpoint — each connection gets its own Server instance
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/message", res);
        const server = createServer();  // fresh instance per connection
        sessions.set(transport.sessionId, { transport, server });
        transport.onclose = () => {
          sessions.delete(transport.sessionId);
          process.stderr.write(`Session ${transport.sessionId.slice(0,8)} closed (${sessions.size} active)
`);
        };
        process.stderr.write(`New session ${transport.sessionId.slice(0,8)} (${sessions.size + 1} active)
`);
        await server.connect(transport);
        return;
      }

      // Message endpoint — client POSTs MCP messages here
      if (req.method === "POST" && url.pathname === "/message") {
        const sessionId = url.searchParams.get("sessionId");
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (!session) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found or expired. Reconnect to /sse." }));
          return;
        }
        await session.transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found", endpoints: ["GET /health", "GET /sse", "POST /message"] }));
    });

    httpServer.listen(MCP_PORT, MCP_BIND, () => {
      process.stderr.write(`BlueBubbles MCP v${MCP_VERSION} — HTTP/SSE on ${MCP_BIND}:${MCP_PORT}\n`);
      process.stderr.write(`Health: http://${MCP_BIND}:${MCP_PORT}/health\n`);
      process.stderr.write(`SSE:    http://${MCP_BIND}:${MCP_PORT}/sse\n`);
      process.stderr.write(`Tools:  ${TOOLS.length} registered\n`);
    });
  } else {
    // stdio mode (default — backward compat)
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`BlueBubbles MCP v${MCP_VERSION} — stdio mode\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
