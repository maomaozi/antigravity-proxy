import { readAttachment, userContent, outputText, consumeEvents } from './playground-api.js';
const $ = id => document.getElementById(id);
let models = [], attachments = [], history = [], controller = null, reading = false;
let session = crypto.randomUUID();
const selections = { chat: '', image: 'gemini-3.1-flash-image' };
let mode = 'chat';
function error(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function theme() {
    let preference = 'system';
    try { preference = localStorage.getItem('theme') || 'system'; } catch {}
    document.documentElement.classList.toggle('dark', preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches));
}
$('theme').onclick = () => { const dark = !document.documentElement.classList.contains('dark'); document.documentElement.classList.toggle('dark', dark); try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch {} };
theme();
function busy() {
    const active = !!controller;
    for (const id of ['mode', 'model', 'effort', 'instructions', 'size', 'ratio', 'clear', 'reload', 'prompt']) $(id).disabled = active || reading;
    $('send').disabled = active || reading;
    $('upload').disabled = active || reading;
    $('stop').hidden = !active;
    renderAttachments();
}
function populate() {
    $('models').replaceChildren();
    const options = mode === 'image' ? [{ id: 'gemini-3.1-flash-image', name: '图片生成 · 示例上游 ID' }] : models;
    for (const model of options) {
        const option = document.createElement('option'); option.value = model.id; option.label = `${model.name || model.id} · ${model.owned_by || 'image'}`; $('models').append(option);
    }
}
async function loadModels() {
    $('reload').disabled = true; $('model-status').textContent = '正在加载模型…';
    try {
        const response = await fetch('/v1/models');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (!Array.isArray(result.data)) throw new Error('模型列表格式错误');
        models = result.data; populate();
        if (mode === 'chat' && !$('model').value) $('model').value = models[0]?.id || '';
        $('model-status').textContent = `已加载 ${models.length} 个聊天模型，也可输入模型 ID。`;
    } catch (e) { $('model-status').textContent = `模型加载失败：${e.message}。可重试或手动输入 ID。`; }
    finally { $('reload').disabled = !!controller; }
}
$('reload').onclick = loadModels;
function reset() { history = []; session = crypto.randomUUID(); $('messages').replaceChildren(); error(); $('status').textContent = '就绪'; }
$('clear').onclick = () => { reset(); attachments = []; $('prompt').value = ''; renderAttachments(); };
$('mode').onchange = () => {
    selections[mode] = $('model').value; mode = $('mode').value;
    $('model').value = selections[mode] || models[0]?.id || '';
    const image = mode === 'image';
    $('chat-options').hidden = image; $('image-options').hidden = !image;
    $('upload').textContent = image ? '＋ 添加参考图' : '＋ 添加附件';
    $('file-hint').textContent = image
        ? '支持 PNG / JPEG / WebP / GIF；最多 8 张，总计 10 MB。图片会随提示词发送给生图模型。'
        : '支持 PNG / JPEG / WebP / GIF 和 UTF-8 文本、代码文件；最多 8 个，总计 10 MB。文本文件会作为消息正文发送，图片理解取决于模型能力。';
    $('files').accept = image ? 'image/png,image/jpeg,image/webp,image/gif' : 'image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.jsonl,.log,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql';
    $('heading').textContent = image ? '图片生成' : '多轮聊天'; $('send').textContent = image ? '生成图片' : '发送';
    $('prompt').placeholder = image ? '描述你想生成的画面…' : '输入消息… Enter 发送，Shift + Enter 换行';
    attachments = []; renderAttachments(); populate(); reset();
};
function renderAttachments() {
    $('attachments').replaceChildren();
    attachments.forEach((file, index) => {
        const item = document.createElement('div'); item.className = 'attachment';
        if (file.url) { const image = document.createElement('img'); image.src = file.url; image.alt = file.name; item.append(image); }
        const name = document.createElement('span'); name.textContent = file.name; item.append(name);
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${file.name}`); remove.disabled = !!controller || reading;
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
        if (selectedMode === 'image' && selected.some(file => !/^image\/(png|jpeg|webp|gif)$/.test(file.type))) throw new Error('图片生成仅支持 PNG、JPEG、WebP 或 GIF 参考图。');
        if (selected.length + attachments.length > 8) throw new Error('最多添加 8 个附件。');
        if ([...selected, ...attachments].reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) throw new Error('附件总大小不能超过 10 MB。');
        const loaded = await Promise.all(selected.map(readAttachment));
        if (mode === selectedMode) attachments.push(...loaded);
    } catch (e) { error(e.message); }
    finally { reading = false; $('files').value = ''; busy(); }
}
$('upload').onclick = () => $('files').click();
$('files').onchange = () => addFiles($('files').files);
$('composer').ondragover = event => { event.preventDefault(); };
$('composer').ondrop = event => { event.preventDefault(); addFiles(event.dataTransfer.files); };
$('prompt').onpaste = event => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles(event.clipboardData.files); } };
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } };
$('stop').onclick = () => controller?.abort();
function message(role, text, files = []) {
    $('empty')?.remove();
    const element = document.createElement('article'); element.className = `message ${role}`;
    const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? '你' : $('model').value;
    const body = document.createElement('div'); body.className = 'message-body'; body.textContent = text; element.append(label, body);
    for (const file of files) {
        if (file.url) { const img = document.createElement('img'); img.src = file.url; img.alt = file.name; element.append(img); }
        else { const name = document.createElement('div'); name.textContent = `附件：${file.name}`; name.className = 'usage'; element.append(name); }
    }
    $('messages').append(element); element.scrollIntoView({ block: 'nearest' });
    return { element, body };
}
function note(element, text, className = 'usage') { const node = document.createElement('div'); node.className = className; node.textContent = text; element.append(node); }
$('composer').onsubmit = async event => {
    event.preventDefault(); if (controller || reading) return;
    const prompt = $('prompt').value.trim(), model = $('model').value.trim(), files = [...attachments];
    if (!model) return error('请先选择或输入模型 ID。');
    if (!prompt && (mode === 'image' || !files.length)) return error(mode === 'image' ? '请输入图片修改要求。' : '请输入消息或添加附件。');
    error(); controller = new AbortController(); busy(); $('status').textContent = mode === 'image' ? '正在生成图片…' : '正在回复…';
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
        if (!response.ok) { const raw = await response.text(); let detail; try { detail = JSON.parse(raw).error?.message; } catch {} throw new Error(detail || `请求失败（HTTP ${response.status}）：${raw.slice(0, 300)}`); }
        if (mode === 'image') {
            const result = await response.json();
            if (!result.data?.length) throw new Error('接口未返回图片。');
            for (const [index, item] of result.data.entries()) {
                const mime = item.mime_type || 'image/png';
                if (!/^image\/(png|jpeg|webp|gif)$/.test(mime) || !item.b64_json) throw new Error('接口返回了不支持的图片格式。');
                const url = `data:${mime};base64,${item.b64_json}`;
                const img = document.createElement('img'); img.src = url; img.alt = prompt;
                const link = document.createElement('a'); link.href = url; link.download = `generated-${Date.now()}-${index}.${mime.split('/')[1]}`; link.textContent = '下载图片'; assistant.element.append(img, link);
            }
            complete = true;
        } else {
            let reasoning = '', reasoningNode;
            const finish = result => {
                if (result.error) throw new Error(result.error.message || '生成失败');
                if (result.status === 'incomplete' || result.status === 'failed') throw new Error(`回复未完成：${result.incomplete_details?.reason || result.status}`);
                text = outputText(result) || text; assistant.body.textContent = text; complete = true;
                if (result.usage) note(assistant.element, `输入 ${result.usage.input_tokens ?? '—'} / 输出 ${result.usage.output_tokens ?? '—'} tokens`);
            };
            if (response.headers.get('content-type')?.includes('text/event-stream')) {
                await consumeEvents(response, event => {
                    if (event.type === 'error' || event.type === 'response.failed') throw new Error(event.error?.message || event.response?.error?.message || event.message || '生成失败');
                    if (event.type === 'response.output_text.delta') { text += event.delta || ''; assistant.body.textContent = text; }
                    if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(event.type)) {
                        if (!reasoningNode) { const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '思考过程'; reasoningNode = document.createElement('pre'); details.append(summary, reasoningNode); assistant.element.insertBefore(details, assistant.body); }
                        reasoning += event.delta || ''; reasoningNode.textContent = reasoning;
                    }
                    if (['response.completed', 'response.incomplete'].includes(event.type)) finish(event.response);
                });
                if (!complete) throw new Error('连接已中断，回复未完成。');
            } else finish(await response.json());
            if (!text) throw new Error('模型未返回文本，请调整输入后重试。');
            history.push(input, { role: 'assistant', content: [{ type: 'output_text', text }] });
        }
        $('prompt').value = ''; attachments = []; $('status').textContent = '已完成';
    } catch (e) {
        const stopped = controller.signal.aborted;
        const detail = stopped ? '已停止生成。' : e.message;
        note(assistant.element, detail, 'failure'); error(stopped ? '' : detail); $('status').textContent = stopped ? '已停止' : '请求失败';
    } finally { controller = null; busy(); $('prompt').focus(); }
};
loadModels();
