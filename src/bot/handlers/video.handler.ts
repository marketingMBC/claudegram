import { Context } from 'grammy';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config.js';
import { sendToAgent } from '../../claude/agent.js';
import { sessionManager } from '../../claude/session-manager.js';
import { messageSender } from '../../telegram/message-sender.js';
import { isDuplicate, markProcessed } from '../../telegram/deduplication.js';
import { isStaleMessage } from '../middleware/stale-filter.js';
import {
  queueRequest,
  isProcessing,
  getQueuePosition,
  setAbortController,
} from '../../claude/request-queue.js';
import { escapeMarkdownV2 as esc } from '../../telegram/markdown.js';
import { getStreamingMode } from './command.handler.js';
import { downloadFileSecure, getTelegramFileUrl } from '../../utils/download.js';
import { sanitizeError } from '../../utils/sanitize.js';
import { getSessionKeyFromCtx } from '../../utils/session-key.js';

const UPLOADS_DIR = '.claudegram/uploads';

function sanitizeFileName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function ensureUploadsDir(projectDir: string): string {
  const dir = path.join(projectDir, UPLOADS_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function downloadTelegramFile(ctx: Context, fileId: string, destPath: string): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) {
    throw new Error('Telegram did not provide file_path for this file.');
  }
  const fileUrl = getTelegramFileUrl(config.TELEGRAM_BOT_TOKEN, file.file_path);
  await downloadFileSecure(fileUrl, destPath);
  return file.file_path;
}

async function sendMediaToAgent(
  ctx: Context,
  savedPath: string,
  mediaType: string,
  caption?: string,
  extraInfo?: string
): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  if (!keyInfo) return;
  const { sessionKey } = keyInfo;

  const session = sessionManager.getSession(sessionKey);
  if (!session) return;

  const relativePath = path.relative(session.workingDirectory, savedPath);
  const captionText = caption?.trim();

  const noteLines = [
    `User sent a ${mediaType} via Telegram.`,
    `Saved at: ${savedPath}`,
    `Relative path: ${relativePath}`,
    captionText ? `Caption/instruction: "${captionText}"` : 'Caption: (none)',
    ...(extraInfo ? [extraInfo] : []),
    'If the caption includes a question or request, answer it. Otherwise, acknowledge receipt briefly.',
    `You can inspect the ${mediaType} with tools if needed.`,
  ];

  const agentPrompt = noteLines.join('\n');

  if (isProcessing(sessionKey)) {
    const position = getQueuePosition(sessionKey) + 1;
    await ctx.reply(`\u23f3 Queued \\(position ${position}\\)`, { parse_mode: 'MarkdownV2' });
  }

  await queueRequest(sessionKey, agentPrompt, async () => {
    if (getStreamingMode() === 'streaming') {
      await messageSender.startStreaming(ctx);
      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);
      try {
        const response = await sendToAgent(sessionKey, agentPrompt, {
          onProgress: (progressText) => {
            messageSender.updateStream(ctx, progressText);
          },
          abortController,
        });
        await messageSender.finishStreaming(ctx, response.text);
      } catch (error) {
        await messageSender.cancelStreaming(ctx);
        throw error;
      }
    } else {
      await ctx.replyWithChatAction('typing');
      const abortController = new AbortController();
      setAbortController(sessionKey, abortController);
      const response = await sendToAgent(sessionKey, agentPrompt, { abortController });
      await messageSender.sendMessage(ctx, response.text);
    }
  });
}

function requireSession(ctx: Context, sessionKey: string) {
  const session = sessionManager.getSession(sessionKey);
  if (!session) return null;
  return session;
}

async function replyNoSession(ctx: Context): Promise<void> {
  await ctx.reply(
    '\u26a0\ufe0f No project set\\.\n\nIf the bot restarted, use `/continue` or `/resume` to restore your last session\\.\nOr use `/project` to open a project first\\.',
    { parse_mode: 'MarkdownV2' }
  );
}

// ── Video messages ──────────────────────────────────────────────

export async function handleVideo(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const video = ctx.message?.video;

  if (!keyInfo || !messageId || !messageDate || !video) return;
  const { sessionKey } = keyInfo;

  if (isStaleMessage(messageDate)) return;
  if (isDuplicate(messageId)) return;
  markProcessed(messageId);

  const session = requireSession(ctx, sessionKey);
  if (!session) { await replyNoSession(ctx); return; }

  const fileSizeBytes = video.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  if (fileSizeMB > config.VIDEO_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `\u274c Video too large \\(${esc(fileSizeMB.toFixed(1))}MB\\)\\.\nMax: ${config.VIDEO_MAX_FILE_SIZE_MB}MB\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const uploadsDir = ensureUploadsDir(session.workingDirectory);
  const timestamp = Date.now();
  const mimeExt: Record<string, string> = {
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'video/x-matroska': '.mkv', 'video/avi': '.avi',
  };
  const ext = mimeExt[video.mime_type || ''] || '.mp4';
  const destPath = path.join(uploadsDir, `video_${timestamp}_${sanitizeFileName(video.file_unique_id)}${ext}`);

  try {
    await downloadTelegramFile(ctx, video.file_id, destPath);

    const buffer = fs.readFileSync(destPath);
    if (!buffer.length) throw new Error('Downloaded video is empty.');

    const extraInfo = `Duration: ${video.duration}s | Resolution: ${video.width}x${video.height}`;
    await sendMediaToAgent(ctx, destPath, 'video', ctx.message?.caption, extraInfo);
  } catch (error) {
    const errorMessage = sanitizeError(error);
    console.error('[Video] Error:', errorMessage);
    await ctx.reply(`\u274c Video error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}

// ── Video notes (circle videos) ─────────────────────────────────

export async function handleVideoNote(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const videoNote = ctx.message?.video_note;

  if (!keyInfo || !messageId || !messageDate || !videoNote) return;
  const { sessionKey } = keyInfo;

  if (isStaleMessage(messageDate)) return;
  if (isDuplicate(messageId)) return;
  markProcessed(messageId);

  const session = requireSession(ctx, sessionKey);
  if (!session) { await replyNoSession(ctx); return; }

  const uploadsDir = ensureUploadsDir(session.workingDirectory);
  const timestamp = Date.now();
  const destPath = path.join(uploadsDir, `videonote_${timestamp}_${sanitizeFileName(videoNote.file_unique_id)}.mp4`);

  try {
    await downloadTelegramFile(ctx, videoNote.file_id, destPath);

    const buffer = fs.readFileSync(destPath);
    if (!buffer.length) throw new Error('Downloaded video note is empty.');

    const extraInfo = `Duration: ${videoNote.duration}s | Circle video`;
    await sendMediaToAgent(ctx, destPath, 'video note (circle video)', undefined, extraInfo);
  } catch (error) {
    const errorMessage = sanitizeError(error);
    console.error('[VideoNote] Error:', errorMessage);
    await ctx.reply(`\u274c Video note error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}

// ── General documents (non-image) ───────────────────────────────

export async function handleDocument(ctx: Context): Promise<void> {
  const keyInfo = getSessionKeyFromCtx(ctx);
  const messageId = ctx.message?.message_id;
  const messageDate = ctx.message?.date;
  const document = ctx.message?.document;

  if (!keyInfo || !messageId || !messageDate || !document) return;
  const { sessionKey } = keyInfo;

  if (isStaleMessage(messageDate)) return;
  if (isDuplicate(messageId)) return;
  markProcessed(messageId);

  const session = requireSession(ctx, sessionKey);
  if (!session) { await replyNoSession(ctx); return; }

  const fileSizeBytes = document.file_size || 0;
  const fileSizeMB = fileSizeBytes / (1024 * 1024);

  if (fileSizeMB > config.VIDEO_MAX_FILE_SIZE_MB) {
    await ctx.reply(
      `\u274c File too large \\(${esc(fileSizeMB.toFixed(1))}MB\\)\\.\nMax: ${config.VIDEO_MAX_FILE_SIZE_MB}MB\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const uploadsDir = ensureUploadsDir(session.workingDirectory);
  const timestamp = Date.now();
  const originalName = document.file_name ? sanitizeFileName(document.file_name) : `file_${document.file_unique_id}`;
  const destPath = path.join(uploadsDir, `${timestamp}_${originalName}`);

  try {
    await downloadTelegramFile(ctx, document.file_id, destPath);

    const buffer = fs.readFileSync(destPath);
    if (!buffer.length) throw new Error('Downloaded file is empty.');

    const extraInfo = [
      `Original filename: ${document.file_name || 'unknown'}`,
      `MIME type: ${document.mime_type || 'unknown'}`,
      `Size: ${fileSizeMB.toFixed(1)}MB`,
    ].join(' | ');

    await sendMediaToAgent(ctx, destPath, 'document', ctx.message?.caption, extraInfo);
  } catch (error) {
    const errorMessage = sanitizeError(error);
    console.error('[Document] Error:', errorMessage);
    await ctx.reply(`\u274c Document error: ${esc(errorMessage)}`, { parse_mode: 'MarkdownV2' });
  }
}
