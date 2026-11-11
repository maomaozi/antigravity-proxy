import { describe, expect, test } from 'bun:test';
import { buildCurlSnippet, classifyModel, consumeEvents, formatBytes, outputText, readAttachment, userContent } from '../../src/frontend/js/playground-api.js';
import { validateResponsesRequest } from '../../src/api/openai/responses';

const playgroundHtml = await Bun.file(new URL('../../src/frontend/playground.html', import.meta.url)).text();

describe('playground existing API compatibility', () => {
    test('text files and images produce supported multi-turn Responses input', async () => {
        const text = await readAttachment(new File(['你好,world'], 'sample.csv', { type: 'text/csv' }));
        const image = await readAttachment(new File([new Uint8Array([1, 2, 3])], 'sample.png', { type: 'image/png' }));
        expect(image.url).toBe('data:image/png;base64,AQID');
        const content = userContent('分析附件', [text, image]);
        expect(content[1]).toEqual({ type: 'input_text', text: 'Attachment: sample.csv\n\n你好,world' });
        expect(validateResponsesRequest({ model: 'antigravity-gemini-3.8-flash', stream: true, store: false, input: [
            { role: 'user', content },
            { role: 'assistant', content: [{ type: 'output_text', text: '收到' }] },
            { role: 'user', content: userContent('继续', []) },
        ] })).toBeUndefined();
    });
    test('rejects unsupported, disguised binary and oversized attachments', async () => {
        await expect(readAttachment(new File(['binary'], 'report.pdf', { type: 'application/pdf' }))).rejects.toThrow('Unsupported file');
        await expect(readAttachment(new File(['a\0b'], 'report.txt'))).rejects.toThrow('binary data');
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
    test('classifies models across Antigravity families, Codex pool, and Image studio', () => {
        expect(classifyModel({ id: 'antigravity-gemini-3.8-flash', name: 'Gemini 3.8 Flash', owned_by: 'antigravity' })).toMatchObject({
            family: 'Gemini',
            providerKey: 'antigravity',
            isTierAlias: false,
        });
        expect(classifyModel({ id: 'antigravity-claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', owned_by: 'antigravity' })).toMatchObject({
            family: 'Claude',
            providerKey: 'antigravity',
            isTierAlias: true,
            tierLabel: 'high',
        });
        expect(classifyModel({ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol', owned_by: 'codex' })).toMatchObject({
            family: 'Codex',
            providerKey: 'codex',
        });
        expect(classifyModel({ id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' }, 'image')).toMatchObject({
            family: 'Image',
            providerKey: 'image',
        });
    });
    test('formats attachment byte counts and builds reproducible cURL snippets', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(2048)).toBe('2 KB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');

        const chatCurl = buildCurlSnippet({
            mode: 'chat',
            model: 'antigravity-claude-sonnet-5-5',
            prompt: 'Hello world',
            effort: 'high',
            sessionId: 'session-test-1',
            origin: 'http://127.0.0.1:3001',
        });
        expect(chatCurl).toContain("http://127.0.0.1:3001/v1/responses");
        expect(chatCurl).toContain("'session-id: session-test-1'");
        expect(chatCurl).toContain('"effort": "high"');

        const imageCurl = buildCurlSnippet({
            mode: 'image',
            model: 'gemini-3.1-flash-image',
            prompt: 'Render a cube',
            size: '2K',
            ratio: '16:9',
            origin: 'http://127.0.0.1:3001',
        });
        expect(imageCurl).toContain("http://127.0.0.1:3001/v1/images/generations");
        expect(imageCurl).toContain('"image_size": "2K"');
        expect(imageCurl).toContain('"aspect_ratio": "16:9"');
    });
    test('renders structured workspace onboarding, model catalog controls, and attachment staging UI', () => {
        expect(playgroundHtml).toContain('id="model-search"');
        expect(playgroundHtml).toContain('id="model-family-tabs"');
        expect(playgroundHtml).toContain('id="model-cards"');
        expect(playgroundHtml).toContain('id="empty-state"');
        expect(playgroundHtml).toContain('id="starter-grid"');
        expect(playgroundHtml).toContain('id="attachments-panel"');
        expect(playgroundHtml).toContain('id="drop-overlay"');
        expect(playgroundHtml).toContain('id="code-modal"');
    });
});
