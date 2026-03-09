import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { config } from '../config.js';
import { downloadFileSecure, getTelegramFileUrl } from '../utils/download.js';

const GROQ_WHISPER_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_WHISPER_MODEL = 'whisper-large-v3-turbo';

export interface TranscribeOptions {
  /** Timeout in milliseconds. Defaults to config.VOICE_TIMEOUT_MS */
  timeoutMs?: number;
  /** If true, return empty string instead of throwing on empty result */
  allowEmpty?: boolean;
}

/**
 * Transcribe an audio file. Uses Groq Whisper API if GROQ_API_KEY is set,
 * otherwise falls back to local faster-whisper (Python) if available.
 */
export async function transcribeFile(filePath: string, options?: TranscribeOptions): Promise<string> {
  if (config.GROQ_API_KEY) {
    return transcribeWithGroq(filePath, options);
  }
  return transcribeWithLocalWhisper(filePath, options);
}

/**
 * Transcribe using the Groq Whisper API directly via fetch.
 */
async function transcribeWithGroq(filePath: string, options?: TranscribeOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? config.VOICE_TIMEOUT_MS;
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), fileName);
  formData.append('model', GROQ_WHISPER_MODEL);
  formData.append('language', config.VOICE_LANGUAGE);
  formData.append('response_format', 'json');

  const response = await fetch(GROQ_WHISPER_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.GROQ_API_KEY}`,
    },
    body: formData,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq Whisper API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = (await response.json()) as { text?: string };
  const transcript = (result.text || '').trim();

  if (!transcript && !options?.allowEmpty) {
    throw new Error('Empty transcription result');
  }

  return transcript;
}

/**
 * Transcribe using local faster-whisper via Python subprocess.
 * Falls back gracefully if faster-whisper is not installed.
 */
async function transcribeWithLocalWhisper(filePath: string, options?: TranscribeOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? config.VOICE_TIMEOUT_MS;
  const language = config.VOICE_LANGUAGE;
  const model = config.LOCAL_WHISPER_MODEL;

  const pythonScript = `
import sys, json
from faster_whisper import WhisperModel
model = WhisperModel("${model}", device="cpu", compute_type="int8")
segments, info = model.transcribe(sys.argv[1], language="${language}", beam_size=5, vad_filter=True)
text = " ".join(s.text.strip() for s in segments)
print(json.dumps({"text": text.strip()}))
`;

  return new Promise((resolve, reject) => {
    const proc = execFile(
      'python3',
      ['-c', pythonScript, filePath],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          if (stderr?.includes('No module named')) {
            reject(new Error('Voice transcription unavailable: neither GROQ_API_KEY nor local faster-whisper is configured. Install with: pip3 install faster-whisper'));
          } else {
            reject(new Error(`Local whisper error: ${(stderr || error.message).slice(0, 300)}`));
          }
          return;
        }

        try {
          const result = JSON.parse(stdout.trim()) as { text?: string };
          const transcript = (result.text || '').trim();

          if (!transcript && !options?.allowEmpty) {
            reject(new Error('Empty transcription result'));
            return;
          }

          resolve(transcript);
        } catch {
          reject(new Error(`Failed to parse whisper output: ${stdout.slice(0, 200)}`));
        }
      }
    );
  });
}

/**
 * Download a file from Telegram servers securely.
 * Constructs the URL via getTelegramFileUrl and delegates to downloadFileSecure.
 */
export function downloadTelegramAudio(botToken: string, filePath: string, destPath: string): Promise<void> {
  const fileUrl = getTelegramFileUrl(botToken, filePath);
  return downloadFileSecure(fileUrl, destPath);
}
