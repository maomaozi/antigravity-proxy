import { describe, expect, test } from 'bun:test';
import { consumeEvents, outputText, readAttachment, userContent } from '../../src/frontend/js/playground-api.js';
import { validateResponsesRequest } from '../../src/api/openai/responses';

describe('playground existing API compatibility', () => {
    test('text files and images produce supported multi-turn Responses input', async () => {
        const text = await readAttachment(new File(['你好,world'], 'sample.csv', { type: 'text/csv' }));
        const image = await readAttachment(new File([new Uint8Array([1, 2, 3])], 'sample.png', { type: 'image/png' }));
        expect(image.url).toBe('data:image/png;base64,AQID');
        const content = userContent('分析附件', [text, image]);
        expect(content[1]).toEqual({ type: 'input_text', text: '附件：sample.csv\n\n你好,world' });
        expect(validateResponsesRequest({ model: 'antigravity-gemini-3.1-pro', stream: true, store: false, input: [
            { role: 'user', content },
            { role: 'assistant', content: [{ type: 'output_text', text: '收到' }] },
            { role: 'user', content: userContent('继续', []) },
        ] })).toBeUndefined();
    });
    test('rejects unsupported, disguised binary and oversized attachments', async () => {
        await expect(readAttachment(new File(['binary'], 'report.pdf', { type: 'application/pdf' }))).rejects.toThrow('不支持');
        await expect(readAttachment(new File(['a\0b'], 'report.txt'))).rejects.toThrow('二进制');
        await expect(readAttachment(new File([new Uint8Array([255])], 'report.txt'))).rejects.toThrow('UTF-8');
        await expect(readAttachment(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.txt'))).rejects.toThrow('10 MB');
    });
    test('parses SSE split across UTF-8 bytes and CRLF delimiters, including final frame', async () => {
        const payload = ': heartbeat\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed"}}';
        const bytes = new TextEncoder().encode(payload);
        const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
        const events: any[] = [];
        await consumeEvents(response, (event: any) => events.push(event));
        expect(events.map(event => event.type)).toEqual(['response.output_text.delta', 'response.completed']);
        expect(events[0].delta).toBe('你好');
    });
    test('propagates upstream errors instead of treating them as success', async () => {
        const response = new Response('data: {"type":"error","message":"quota exceeded"}\n\n');
        await expect(consumeEvents(response, (event: any) => { throw new Error(event.message); })).rejects.toThrow('quota exceeded');
    });
    test('extracts only assistant output text', () => {
        expect(outputText({ output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'hidden' }] }, { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] })).toBe('answer');
    });
});
