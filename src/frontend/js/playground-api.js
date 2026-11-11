const TEXT_EXTENSION = /\.(txt|md|csv|jsonl?|log|xml|ya?ml|html?|css|[cm]?js|tsx?|jsx|py|go|rs|java|c|cpp|h|sh|sql)$/i;
export async function readAttachment(file) {
    const image = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
    if (!image && !TEXT_EXTENSION.test(file.name) && !file.type.startsWith('text/')) throw new Error(`Unsupported file: ${file.name}.`);
    if (file.size > 10 * 1024 * 1024) throw new Error('Attachments exceed 10 MB.');
    if (!image) {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); } catch { throw new Error(`${file.name} is not valid UTF-8 text.`); }
        if (text.includes('\0')) throw new Error(`${file.name} contains binary data.`);
        return { name: file.name, size: file.size, text };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { name: file.name, size: file.size, url: `data:${file.type};base64,${btoa(binary)}` };
}
export function userContent(prompt, attachments) {
    const content = [];
    if (prompt) content.push({ type: 'input_text', text: prompt });
    for (const file of attachments) content.push(file.url
        ? { type: 'input_image', image_url: file.url }
        : { type: 'input_text', text: `Attachment: ${file.name}\n\n${file.text}` });
    return content;
}
export function outputText(response) {
    return (response.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('');
}
export function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 1 : 2).replace(/\.0+$/, '')} KB`;
    return `${(value / (1024 * 1024)).toFixed(2).replace(/\.0+$/, '')} MB`;
}
export function classifyModel(model, mode = 'chat') {
    if (!model || !model.id) {
        return { family: 'Custom', provider: 'Custom', providerKey: 'custom', isTierAlias: false, tierLabel: '', summary: 'Custom model identifier routed verbatim' };
    }
    const id = String(model.id).toLowerCase();
    const name = String(model.name || model.id);
    if (mode === 'image' || id.includes('image')) {
        return {
            family: 'Image',
            provider: 'Antigravity',
            providerKey: 'image',
            isTierAlias: false,
            tierLabel: '',
            summary: 'Multimodal text-to-image & reference image studio',
        };
    }
    const tierMatch = id.match(/-(low|medium|high)$/) || name.match(/\((Low|Medium|High)\)$/i);
    const isTierAlias = Boolean(tierMatch && !id.endsWith('-thinking'));
    const tierLabel = tierMatch ? tierMatch[1].toLowerCase() : '';
    if (model.owned_by === 'codex') {
        return {
            family: 'Codex',
            provider: 'Codex',
            providerKey: 'codex',
            isTierAlias: false,
            tierLabel: '',
            summary: 'OpenAI Codex OAuth pool · Responses & tool search',
        };
    }
    if (id.includes('claude')) {
        const isOpus = id.includes('opus');
        return {
            family: 'Claude',
            provider: 'Antigravity',
            providerKey: 'antigravity',
            isTierAlias,
            tierLabel,
            summary: isOpus ? 'Deep reasoning, architecture & complex coding' : 'Balanced speed, coding & analytical reasoning',
        };
    }
    if (id.includes('gemini')) {
        const isLite = id.includes('lite');
        const isArgon = id.includes('argon') || id.includes('gemini-4');
        return {
            family: 'Gemini',
            provider: 'Antigravity',
            providerKey: 'antigravity',
            isTierAlias,
            tierLabel,
            summary: isArgon
                ? 'Next-gen frontier reasoning & multimodal synthesis'
                : isLite
                ? 'High-throughput, low-latency responses'
                : 'Fast multimodal reasoning & general agent tasks',
        };
    }
    if (id.includes('gpt')) {
        return {
            family: 'GPT',
            provider: 'Antigravity',
            providerKey: 'antigravity',
            isTierAlias,
            tierLabel,
            summary: 'Open-weights reasoning model via Antigravity pool',
        };
    }
    return {
        family: 'Other',
        provider: model.owned_by === 'codex' ? 'Codex' : 'Antigravity',
        providerKey: model.owned_by === 'codex' ? 'codex' : 'antigravity',
        isTierAlias,
        tierLabel,
        summary: 'Upstream language model',
    };
}
export function buildCurlSnippet({ mode = 'chat', model = '', prompt = '', instructions = '', effort = '', size = '1K', ratio = '1:1', sessionId = 'playground-session', origin = 'http://127.0.0.1:3000', attachments = [] } = {}) {
    const targetModel = model || (mode === 'image' ? 'gemini-3.1-flash-image' : 'antigravity-gemini-3.8-flash');
    const samplePrompt = prompt || (mode === 'image' ? 'Isometric cyberpunk server room, emerald lighting' : 'Summarize the proxy routing architecture.');
    const endpoint = `${origin.replace(/\/$/, '')}${mode === 'image' ? '/v1/images/generations' : '/v1/responses'}`;
    const payload = mode === 'image'
        ? {
            model: targetModel,
            prompt: samplePrompt,
            ...(attachments.length ? { images: attachments.map((_, idx) => `<data:image/png;base64,...#${idx + 1}>`) } : {}),
            image_size: size || '1K',
            aspect_ratio: ratio || '1:1',
            n: 1,
            response_format: 'b64_json',
            ...(effort ? { thinking_level: effort } : {}),
        }
        : {
            model: targetModel,
            stream: true,
            store: false,
            ...(instructions ? { instructions } : {}),
            ...(effort ? { reasoning: { effort } } : {}),
            input: [
                {
                    role: 'user',
                    content: [
                        { type: 'input_text', text: samplePrompt },
                        ...attachments.map(file => file.url
                            ? { type: 'input_image', image_url: `<data:image/...;base64,${file.name}>` }
                            : { type: 'input_text', text: `Attachment: ${file.name}\n\n<file_content>` }),
                    ],
                },
            ],
        };
    const jsonBody = JSON.stringify(payload, null, 2).replaceAll("'", "'\\''");
    return `curl -N -X POST '${endpoint}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'session-id: ${sessionId}' \\\n  -d '${jsonBody}'`;
}
export async function consumeEvents(response, onEvent) {
    if (!response.body) throw new Error('Empty response.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let data = [];
    const line = value => {
        if (!value) {
            if (data.length) {
                const raw = data.join('\n');
                data = [];
                if (raw !== '[DONE]') onEvent(JSON.parse(raw));
            }
        } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            let index;
            while ((index = pending.indexOf('\n')) >= 0) {
                line(pending.slice(0, index).replace(/\r$/, ''));
                pending = pending.slice(index + 1);
            }
            if (done) { if (pending) line(pending.replace(/\r$/, '')); line(''); break; }
        }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
