import { readAttachment, userContent, outputText, consumeEvents } from './playground-api.js';
const $ = id => document.getElementById(id);
let models = [], attachments = [], history = [], controller = null, reading = false;
function newSessionId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    if (globalThis.crypto?.getRandomValues) {
        const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
        return `session-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
let session = newSessionId();
const selections = { chat: '', image: 'gemini-3.1-flash-image' };
let imageModels = [
    { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image (Nano Banana 2)' },
];
let mode = 'chat';
function currentModel() { return $('model-select').value === '__custom__' ? $('model').value.trim() : $('model-select').value; }
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function themePreference() {
    try { return localStorage.theme || 'system'; } catch { return 'system'; }
}
function applyTheme() {
    const preference = themePreference();
    document.documentElement.classList.toggle('dark', preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
    $('icon-sun').classList.toggle('hidden', preference !== 'light');
    $('icon-moon').classList.toggle('hidden', preference !== 'dark');
    $('icon-system').classList.toggle('hidden', preference !== 'system');
    $('theme').title = `Theme: ${{ system: 'System', light: 'Light', dark: 'Dark' }[preference]}`;
}
$('theme').onclick = () => {
    const next = { system: 'light', light: 'dark', dark: 'system' }[themePreference()];
    try { if (next === 'system') localStorage.removeItem('theme'); else localStorage.theme = next; } catch {}
    applyTheme();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
window.addEventListener('storage', event => { if (event.key === 'theme') applyTheme(); });
applyTheme();
function busy() {
    const active = !!controller;
    for (const id of ['mode', 'model-select', 'model', 'effort', 'instructions', 'size', 'ratio', 'clear', 'reload', 'prompt']) $(id).disabled = active || reading;
    $('send').disabled = active || reading;
    $('files').disabled = active || reading;
    $('upload').setAttribute('aria-disabled', String(active || reading));
    $('upload').tabIndex = active || reading ? -1 : 0;
    $('stop').hidden = !active;
    syncThinkingLevels();
    renderAttachments();
}
function populate(preferred = currentModel()) {
    const select = $('model-select'); select.replaceChildren();
    const options = mode === 'image' ? imageModels : models;
    const groups = mode === 'image' ? [{ name: 'Images', items: options }] : [
        { name: 'Antigravity', items: options.filter(item => item.owned_by !== 'codex') },
        { name: 'Codex', items: options.filter(item => item.owned_by === 'codex') },
    ];
    for (const group of groups) {
        if (!group.items.length) continue;
        const container = document.createElement('optgroup'); container.label = group.name;
        for (const model of group.items) {
            const option = document.createElement('option'); option.value = model.id;
            option.textContent = model.name || model.id;
            container.append(option);
        }
        select.append(container);
    }
    const custom = document.createElement('option'); custom.value = '__custom__'; custom.textContent = 'Custom model…'; select.append(custom);
    const found = preferred && options.some(item => item.id === preferred);
    select.value = found ? preferred : preferred ? '__custom__' : options[0]?.id || '__custom__';
    $('model-custom').hidden = select.value !== '__custom__';
    $('model').value = select.value === '__custom__' ? preferred : '';
    $('model-status').textContent = ''; $('model-status').hidden = true;
    syncThinkingLevels();
}
function syncThinkingLevels() {
    const model = (mode === 'image' ? imageModels : models).find(item => item.id === currentModel());
    const levels = mode === 'chat' && model?.thinking_levels;
    const select = $('effort');
    const previous = select.value;
    select.replaceChildren();
    const fixed = Array.isArray(levels) && levels.length === 1;
    const defaultOption = document.createElement('option'); defaultOption.value = '';
    defaultOption.textContent = model?.default_thinking_level && mode === 'chat'
        ? `${fixed ? 'Fixed' : 'Default'} (${model.default_thinking_level})` : 'Default';
    select.append(defaultOption);
    for (const level of fixed ? [] : Array.isArray(levels) ? levels : ['low', 'medium', 'high']) {
        const option = document.createElement('option'); option.value = level; option.textContent = level;
        select.append(option);
    }
    select.value = !fixed && (!levels || levels.includes(previous)) ? previous : '';
    if (select.selectedIndex < 0) select.value = '';
    select.disabled = !!controller || reading || fixed;
}
$('model-select').onchange = () => {
    $('model-custom').hidden = $('model-select').value !== '__custom__';
    $('model').value = '';
    if (!$('model-custom').hidden) $('model').focus();
    syncThinkingLevels();
};
$('model').oninput = syncThinkingLevels;
async function loadModels() {
    $('reload').disabled = true; $('model-status').textContent = 'Loading…'; $('model-status').hidden = false;
    try {
        const response = await fetch('/v1/models', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (!Array.isArray(result.data)) throw new Error('Invalid model list');
        const preferred = currentModel();
        const wasListed = (mode === 'image' ? imageModels : models).some(item => item.id === preferred);
        models = result.data.filter(item => typeof item?.id === 'string' && item.id.trim() && !item.disabled);
        if (Array.isArray(result.antigravity?.imageModels)) imageModels = result.antigravity.imageModels;
        const stillListed = (mode === 'image' ? imageModels : models).some(item => item.id === preferred);
        populate(wasListed && !stillListed ? '' : preferred);
    } catch (e) { populate(); $('model-status').textContent = `Could not load models: ${e.message}`; $('model-status').hidden = false; }
    finally { $('reload').disabled = !!controller; }
}
$('reload').onclick = loadModels;
function reset() { history = []; session = newSessionId(); $('messages').replaceChildren(); error(); $('status').textContent = 'Ready'; }
$('clear').onclick = () => { reset(); attachments = []; $('prompt').value = ''; renderAttachments(); };
$('mode').onchange = () => {
    selections[mode] = currentModel(); mode = $('mode').value;
    const image = mode === 'image';
    $('chat-options').hidden = image; $('image-options').hidden = !image;
    $('upload').textContent = image ? '+ Add images' : '+ Attach';
    $('files').accept = image ? 'image/png,image/jpeg,image/webp,image/gif' : 'image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.jsonl,.log,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql';
    $('heading').textContent = image ? 'Images' : 'Chat'; $('send').textContent = image ? 'Generate' : 'Send';
    $('clear').textContent = image ? 'Clear' : 'New chat';
    $('prompt').placeholder = image ? 'Prompt' : 'Message';
    attachments = []; renderAttachments(); populate(selections[mode]); reset();
};
function renderAttachments() {
    $('attachments').replaceChildren();
    attachments.forEach((file, index) => {
        const item = document.createElement('div'); item.className = 'attachment';
        if (file.url) { const image = document.createElement('img'); image.src = file.url; image.alt = file.name; item.append(image); }
        const name = document.createElement('span'); name.textContent = file.name; item.append(name);
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.disabled = !!controller || reading;
        remove.onclick = () => { attachments.splice(index, 1); renderAttachments(); }; item.append(remove); $('attachments').append(item);
    });
}
async function addFiles(files) {
    if (controller || reading) return;
    error(); reading = true; busy();
    // Capture the mode so a mode switch during reading cannot attach files to image generation.
    const selectedMode = mode;
    try {
        const selected = [...files];
        if (selectedMode === 'image' && selected.some(file => !/^image\/(png|jpeg|webp|gif)$/.test(file.type))) throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
        if (selected.length + attachments.length > 8) throw new Error('Up to 8 attachments allowed.');
        if ([...selected, ...attachments].reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) throw new Error('Attachments exceed 10 MB.');
        const loaded = await Promise.all(selected.map(readAttachment));
        if (mode === selectedMode) attachments.push(...loaded);
    } catch (e) { error(e.message); }
    finally { reading = false; $('files').value = ''; busy(); }
}
$('upload').onkeydown = event => {
    if ((event.key === 'Enter' || event.key === ' ') && !$('files').disabled) {
        event.preventDefault(); $('files').click();
    }
};
$('files').onchange = () => addFiles($('files').files);
$('composer').ondragover = event => { event.preventDefault(); };
$('composer').ondrop = event => { event.preventDefault(); addFiles(event.dataTransfer.files); };
$('prompt').onpaste = event => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles(event.clipboardData.files); } };
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } };
$('stop').onclick = () => controller?.abort();
function message(role, text, files = []) {
    const element = document.createElement('article'); element.className = `message ${role}`;
    const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? 'You' : [...models, ...imageModels].find(model => model.id === currentModel())?.name || currentModel();
    const body = document.createElement('div'); body.className = 'message-body'; body.textContent = text; element.append(label, body);
    for (const file of files) {
        if (file.url) { const img = document.createElement('img'); img.src = file.url; img.alt = file.name; element.append(img); }
        else { const name = document.createElement('div'); name.textContent = `Attachment: ${file.name}`; name.className = 'usage'; element.append(name); }
    }
    $('messages').append(element); element.scrollIntoView({ block: 'nearest' });
    return { element, body };
}
function note(element, text, className = 'usage') { const node = document.createElement('div'); node.className = className; node.textContent = text; element.append(node); }
$('composer').onsubmit = async event => {
    event.preventDefault(); if (controller || reading) return;
    const prompt = $('prompt').value.trim(), model = currentModel(), files = [...attachments];
    if (!model) return error('Select a model.');
    if (!prompt && (mode === 'image' || !files.length)) return error(mode === 'image' ? 'Enter a prompt.' : 'Enter a message or attach a file.');
    error(); controller = new AbortController(); busy(); $('status').textContent = mode === 'image' ? 'Generating…' : 'Responding…';
    message('user', prompt, files);
    const assistant = message('assistant', '');
    const input = { role: 'user', content: userContent(prompt, files) };
    let text = '', complete = false;
    try {
        const effort = $('effort').value;
        const body = mode === 'image'
            ? { model, prompt, ...(files.length ? { images: files.map(file => file.url) } : {}), image_size: $('size').value, aspect_ratio: $('ratio').value, n: 1, response_format: 'b64_json', ...(effort ? { thinking_level: effort } : {}) }
            : { model, input: [...history, input], stream: true, store: false, instructions: $('instructions').value, ...(effort ? { reasoning: { effort } } : {}) };
        const response = await fetch(mode === 'image' ? '/v1/images/generations' : '/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'session-id': session }, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) { const raw = await response.text(); let detail; try { detail = JSON.parse(raw).error?.message; } catch {} throw new Error(detail || `Request failed (HTTP ${response.status}): ${raw.slice(0, 300)}`); }
        if (mode === 'image') {
            const result = await response.json();
            if (!result.data?.length) throw new Error('No image returned.');
            for (const [index, item] of result.data.entries()) {
                const mime = item.mime_type || 'image/png';
                if (!/^image\/(png|jpeg|webp|gif)$/.test(mime) || !item.b64_json) throw new Error('Unsupported image format.');
                const url = `data:${mime};base64,${item.b64_json}`;
                const img = document.createElement('img'); img.src = url; img.alt = prompt;
                const link = document.createElement('a'); link.href = url; link.download = `generated-${Date.now()}-${index}.${mime.split('/')[1]}`; link.textContent = 'Download'; assistant.element.append(img, link);
            }
            complete = true;
        } else {
            let reasoning = '', reasoningNode;
            const finish = result => {
                if (result.error) throw new Error(result.error.message || 'Generation failed');
                if (result.status === 'incomplete' || result.status === 'failed') throw new Error(`Response incomplete: ${result.incomplete_details?.reason || result.status}`);
                text = outputText(result) || text; assistant.body.textContent = text; complete = true;
                if (result.usage) note(assistant.element, `Input ${result.usage.input_tokens ?? '—'} · Output ${result.usage.output_tokens ?? '—'} tokens`);
            };
            if (response.headers.get('content-type')?.includes('text/event-stream')) {
                await consumeEvents(response, event => {
                    if (event.type === 'error' || event.type === 'response.failed') throw new Error(event.error?.message || event.response?.error?.message || event.message || 'Generation failed');
                    if (event.type === 'response.output_text.delta') { text += event.delta || ''; assistant.body.textContent = text; }
                    if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(event.type)) {
                        if (!reasoningNode) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Reasoning'; reasoningNode = document.createElement('pre'); details.append(summary, reasoningNode); assistant.element.insertBefore(details, assistant.body); }
                        reasoning += event.delta || ''; reasoningNode.textContent = reasoning;
                    }
                    if (['response.completed', 'response.incomplete'].includes(event.type)) finish(event.response);
                });
                if (!complete) throw new Error('Connection interrupted.');
            } else finish(await response.json());
            if (!text) throw new Error('No text returned.');
            history.push(input, { role: 'assistant', content: [{ type: 'output_text', text }] });
        }
        $('prompt').value = ''; attachments = []; $('status').textContent = 'Done';
    } catch (e) {
        const stopped = controller.signal.aborted;
        const detail = stopped ? 'Generation stopped.' : e.message;
        note(assistant.element, detail, 'failure'); error(stopped ? '' : detail); $('status').textContent = stopped ? 'Stopped' : 'Failed';
    } finally { controller = null; busy(); $('prompt').focus(); }
};
loadModels();
