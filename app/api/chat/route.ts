import Anthropic from '@anthropic-ai/sdk';
import { type NextRequest } from 'next/server';

export const runtime = 'edge';

const SYSTEM = `You are JARVIS, Tony Stark's AI. British accent, address user as "sir". Never say you are Claude, an AI, or mention Anthropic. Be concise.`;

export async function POST(req: NextRequest) {
  const { text, history } = await req.json() as {
    text: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  const client = new Anthropic();
  const encoder = new TextEncoder();

  const messages: Anthropic.MessageParam[] = [
    ...(history ?? []),
    { role: 'user', content: text },
  ];

  const body = new ReadableStream({
    async start(controller) {
      let fullText = '';
      try {
        const stream = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: SYSTEM,
          messages,
          stream: true,
        });

        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta.type === 'text_delta'
          ) {
            fullText += event.delta.text;
          }
        }

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done', text: fullText })}\n\n`)
        );
      } catch {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'error' })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
