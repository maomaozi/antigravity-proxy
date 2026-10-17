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
