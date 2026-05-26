import { type NextRequest } from 'next/server';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const JARVIS_VOICE = 'en-GB-RyanNeural';

export async function POST(req: NextRequest) {
  const { text } = await req.json() as { text: string };

  const clean = text
    .replace(/```[\s\S]*?```/g, 'code block.')
    .replace(/[#*`_>~]/g, '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 1000);

  if (!clean) {
    return Response.json({ audio: null });
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(JARVIS_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-'));
    try {
      const { audioFilePath } = await tts.toFile(dir, clean);
      const audio = fs.readFileSync(audioFilePath).toString('base64');
      return Response.json({ audio });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    return Response.json({ audio: null });
  }
}
