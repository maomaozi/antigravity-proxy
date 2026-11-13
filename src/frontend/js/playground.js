import { readAttachment, userContent, outputText, consumeEvents, formatBytes, classifyModel, buildCurlSnippet, isVisibleModel } from './playground-api.js';

const $ = id => document.getElementById(id);

let models = [];
let attachments = [];
let history = [];
let controller = null;
let reading = false;
let selectedFamily = 'all';
let modelSearchQuery = '';
let showTierVariants = false;
let dragDepth = 0;

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

const INSTRUCTION_PRESETS = {
    architect: 'You are a principal systems architect. Provide structured, production-grade analysis with concise code examples and explicit trade-offs.',
    concise: 'Respond in terse, high-signal technical bullet points. Omit filler and pleasantries.',
    json: 'Respond strictly with valid JSON matching the requested structure. Do not wrap in markdown code fences.',
};

const CHAT_STARTERS = [
    {
        tag: 'Architecture',
        title: 'Failover & Session Affinity Review',
        desc: 'Analyze multi-account OAuth pool routing and sticky cache affinity trade-offs.',
        prompt: 'Explain the architectural trade-offs between sticky session-to-account affinity (for prompt cache hits) and randomized load balancing across OAuth credential pools. Give concrete failure recovery rules.',
    },
    {
        tag: 'Reasoning',
        title: 'Concurrency Bug Diagnosis',
        desc: 'Test multi-step thinking traces on a subtle async stream race condition.',
        prompt: 'A Node/Bun SSE proxy occasionally drops the final JSON frame when a chunk boundary splits a multibyte UTF-8 character across two ReadableStream reads. Show why this happens and write a minimal, zero-copy fix.',
    },
    {
        tag: 'Multimodal',
        title: 'Log / Config / Screenshot Audit',
        desc: 'Attach up to 8 code, JSON, log, or image files and inspect them together.',
        prompt: 'Review the attached files or screenshots. Summarize key anomalies, root causes, and concrete remediation steps in order of severity.',
    },
    {
        tag: 'Structured Output',
        title: 'Strict JSON Schema Extraction',
        desc: 'Verify deterministic structured payload synthesis for downstream pipelines.',
        prompt: 'Generate a realistic JSON array of 3 upstream model quota windows containing fields: pool, window ("5h" | "7d"), remainingFraction (0..1), and resetIso.',
    },
];

const IMAGE_STARTERS = [
    {
        tag: 'Isometric 3D',
        title: 'Minimalist Server Rack Telemetry Hub',
        desc: '1K · 16:9 widescreen technical illustration with emerald accents.',
        ratio: '16:9',
        size: '1K',
        prompt: 'Isometric cutaway of a high-density subterranean AI compute cluster, matte zinc enclosures, subtle emerald fiber-optic status LEDs, architectural lighting, octane render, crisp technical detail.',
    },
    {
        tag: 'Product Studio',
        title: 'Industrial Monospace Mechanical Keypad',
        desc: '1K · 1:1 macro hardware photography on dark anodized aluminum.',
        ratio: '1:1',
        size: '1K',
        prompt: 'Top-down studio macro photograph of a custom dark anodized aluminum macro pad with translucent emerald keycaps and crisp white JetBrains Mono legends, soft rim lighting, 85mm lens.',
    },
    {
        tag: 'Editorial Poster',
        title: 'Orbital Gravity Wave Observatory',
        desc: '2K · 3:4 Swiss typographic brutalist poster aesthetic.',
        ratio: '3:4',
        size: '2K',
        prompt: 'Swiss neo-brutalist scientific exhibition poster of an orbital gravitational wave interferometer above a dark planet, high-contrast geometric grid lines, emerald and stark white palette.',
    },
    {
        tag: 'Image-to-Image',
        title: 'Reference Style & Composition Remix',
        desc: 'Attach 1–8 reference images (+ Add reference images) to guide generation.',
        ratio: '1:1',
        size: '1K',
        prompt: 'Reimagine the attached reference image in a clean technical blueprint style with dark zinc surfaces and glowing emerald schematic annotations.',
    },
];

function currentModel() {
    return $('model-select').value === '__custom__' ? $('model').value.trim() : $('model-select').value;
}

function currentModelObject() {
    const id = currentModel();
    return (mode === 'image' ? imageModels : models).find(item => item.id === id);
}

function error(message = '') {
    $('error').textContent = message;
    $('error').hidden = !message;
}

function updateSessionDisplay() {
    if ($('session-id-display')) {
        $('session-id-display').textContent = session;
        $('session-id-display').title = session;
    }
}

function updateStatusUI(stateText, variant = 'ready') {
    const statusEl = $('status');
    const dotEl = $('status-dot');
    statusEl.textContent = stateText;
    if (!dotEl) return;
    dotEl.className = 'w-1.5 h-1.5 rounded-full ';
    if (variant === 'busy') {
        dotEl.className += 'bg-amber-500 animate-pulse';
    } else if (variant === 'error') {
        dotEl.className += 'bg-rose-500';
    } else {
        dotEl.className += 'bg-emerald-500';
    }
}

function updateWorkspaceState() {
    const messageCount = $('messages').children.length;
    if ($('empty-state')) {
        $('empty-state').hidden = messageCount > 0;
    }
    if ($('turn-counter')) {
        const turns = mode === 'image' ? Math.floor(messageCount / 2) : Math.floor(history.length / 2);
        $('turn-counter').textContent = `${turns} ${turns === 1 ? 'turn' : 'turns'}`;
    }
}

function updatePromptStats() {
    if (!$('prompt-stats')) return;
    const value = $('prompt').value || '';
    const chars = value.length;
    const estTokens = chars ? Math.max(1, Math.ceil(chars / 4)) : 0;
    $('prompt-stats').textContent = chars ? `${chars} chars · ~${estTokens} tok` : '0 chars';
}

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

function renderStarters() {
    const grid = $('starter-grid');
    if (!grid) return;
    grid.replaceChildren();
    const items = mode === 'image' ? IMAGE_STARTERS : CHAT_STARTERS;
    for (const item of items) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'starter-card';
        const top = document.createElement('div');
        top.className = 'flex items-center justify-between gap-2 w-full';
        const tag = document.createElement('span');
        tag.className = 'px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-[9px] font-bold uppercase tracking-wider';
        tag.textContent = item.tag;
        const arrow = document.createElement('span');
        arrow.className = 'text-[10px] text-zinc-400 font-bold';
        arrow.textContent = 'Use prompt →';
        top.append(tag, arrow);

        const title = document.createElement('div');
        title.className = 'text-xs font-bold text-zinc-900 dark:text-white';
        title.textContent = item.title;

        const desc = document.createElement('div');
        desc.className = 'text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed';
        desc.textContent = item.desc;

        card.append(top, title, desc);
        card.onclick = () => {
            if (controller || reading) return;
            $('prompt').value = item.prompt;
            if (mode === 'image') {
                if (item.size) setSizeValue(item.size);
                if (item.ratio) setRatioValue(item.ratio);
            }
            updatePromptStats();
            $('prompt').focus();
        };
        grid.append(card);
    }
}

function updateInspector() {
    const id = currentModel();
    const modelObj = currentModelObject();
    const meta = classifyModel(modelObj || (id ? { id, name: id, owned_by: 'custom' } : null), mode);

    if ($('active-model-badge')) {
        $('active-model-badge').textContent = modelObj?.name || id || 'No model selected';
    }
    if ($('inspector-id')) {
        $('inspector-id').textContent = id || '—';
        $('inspector-id').title = id || '';
    }
    if ($('inspector-summary')) {
        $('inspector-summary').textContent = meta.summary;
    }
    if ($('inspector-provider')) {
        const providerEl = $('inspector-provider');
        if (meta.providerKey === 'codex') {
            providerEl.textContent = 'Codex OAuth Pool';
            providerEl.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20';
        } else if (meta.providerKey === 'image') {
            providerEl.textContent = 'Antigravity Image Pool';
            providerEl.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20';
        } else if (meta.providerKey === 'custom') {
            providerEl.textContent = 'Custom Route';
            providerEl.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-zinc-500/10 text-zinc-600 dark:text-zinc-300 border border-zinc-500/20';
        } else {
            providerEl.textContent = `Antigravity · ${meta.family}`;
            providerEl.className = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20';
        }
    }
}

function renderModelCards() {
    const container = $('model-cards');
    if (!container) return;
    container.replaceChildren();

    const options = mode === 'image' ? imageModels : models;
    const selectedValue = $('model-select').value;
    const activeId = currentModel();
    const query = modelSearchQuery.trim().toLowerCase();

    let hiddenTierCount = 0;
    const filtered = options.filter(item => {
        const meta = classifyModel(item, mode);
        const idLower = String(item.id).toLowerCase();
        const baseCandidate = idLower.replace(/-(low|medium|high|xhigh)$/, '');
        const hasBaseSibling = baseCandidate !== idLower && options.some(other => String(other.id).toLowerCase() === baseCandidate);

        if (mode === 'chat' && selectedFamily !== 'all' && selectedFamily !== 'custom') {
            if (meta.family !== selectedFamily) return false;
        }
        if (query) {
            const haystack = `${item.name || ''} ${item.id} ${meta.family} ${meta.provider}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        } else if (mode === 'chat' && hasBaseSibling && !showTierVariants && item.id !== activeId) {
            hiddenTierCount++;
            return false;
        }
        return true;
    });

    if ($('toggle-variants')) {
        $('toggle-variants').hidden = mode === 'image';
        $('toggle-variants').textContent = showTierVariants
            ? 'Hide Tier IDs'
            : hiddenTierCount > 0
            ? `+ ${hiddenTierCount} Tier IDs`
            : '+ Tier IDs';
        $('toggle-variants').classList.toggle('border-emerald-500/60', showTierVariants);
        $('toggle-variants').classList.toggle('text-emerald-600', showTierVariants);
    }

    if ($('model-count-badge')) {
        $('model-count-badge').textContent = filtered.length === options.length
            ? `${options.length}`
            : `${filtered.length}/${options.length}`;
    }

    if (selectedFamily !== 'custom') {
        for (const item of filtered) {
            const meta = classifyModel(item, mode);
            const card = document.createElement('button');
            card.type = 'button';
            card.setAttribute('role', 'option');
            const isSelected = selectedValue !== '__custom__' && item.id === selectedValue;
            card.setAttribute('aria-selected', String(isSelected));
            card.className = `model-card${isSelected ? ' active' : ''}`;
            card.disabled = !!controller || reading;

            const titleRow = document.createElement('div');
            titleRow.className = 'model-card-title';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'truncate';
            nameSpan.textContent = item.name || item.id;

            const badges = document.createElement('div');
            badges.className = 'flex items-center gap-1 shrink-0';

            if (item.recommended) {
                const rec = document.createElement('span');
                rec.className = 'px-1 py-0.2 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[8px] font-bold uppercase';
                rec.textContent = 'Recommended';
                badges.append(rec);
            }

            const poolBadge = document.createElement('span');
            poolBadge.className = meta.providerKey === 'codex'
                ? 'px-1 py-0.2 rounded border border-amber-300/60 dark:border-amber-800 text-amber-600 dark:text-amber-400 text-[8px] font-bold uppercase'
                : 'px-1 py-0.2 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 text-[8px] font-bold uppercase';
            poolBadge.textContent = meta.providerKey === 'codex' ? 'Codex' : meta.family;
            badges.append(poolBadge);

            titleRow.append(nameSpan, badges);

            const subRow = document.createElement('div');
            subRow.className = 'model-card-sub';

            const idSpan = document.createElement('span');
            idSpan.className = 'truncate font-mono opacity-80';
            idSpan.textContent = item.id;

            const levelsSpan = document.createElement('span');
            levelsSpan.className = 'shrink-0 text-[8px] uppercase tracking-wider';
            if (Array.isArray(item.thinking_levels) && item.thinking_levels.length) {
                levelsSpan.textContent = item.thinking_levels.length === 1
                    ? `effort: ${item.thinking_levels[0]}`
                    : `effort: ${item.thinking_levels.join('/')}`;
            } else if (mode === 'image') {
                levelsSpan.textContent = '512–4K · 14 ratios';
            } else if (meta.providerKey === 'codex') {
                levelsSpan.textContent = 'effort: low/med/high';
            }

            subRow.append(idSpan, levelsSpan);
            card.append(titleRow, subRow);

            card.onclick = () => {
                if (controller || reading) return;
                $('model-select').value = item.id;
                $('model-select').dispatchEvent(new Event('change'));
            };
            container.append(card);
        }
    }

    const customCard = document.createElement('button');
    customCard.type = 'button';
    const isCustom = selectedValue === '__custom__';
    customCard.className = `model-card${isCustom ? ' active' : ''}`;
    customCard.disabled = !!controller || reading;
    customCard.innerHTML = `
        <div class="model-card-title">
            <span>Custom Model ID…</span>
            <span class="px-1 py-0.2 rounded border border-zinc-200 dark:border-zinc-800 text-zinc-500 text-[8px] font-bold uppercase">Manual</span>
        </div>
        <div class="model-card-sub">
            <span>Specify any upstream Antigravity or Codex model ID</span>
        </div>
    `;
    customCard.onclick = () => {
        if (controller || reading) return;
        $('model-select').value = '__custom__';
        $('model-select').dispatchEvent(new Event('change'));
    };
    container.append(customCard);
}

function renderEffortPills() {
    const container = $('effort-pills');
    if (!container) return;
    container.replaceChildren();
    const select = $('effort');
    const options = [...select.options];
    container.className = `grid gap-1.5 ${options.length <= 2 ? 'grid-cols-2' : options.length === 3 ? 'grid-cols-3' : options.length === 5 ? 'grid-cols-5' : 'grid-cols-4'}`;
    for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const active = select.value === opt.value;
        btn.className = `param-pill ${active ? 'active' : ''}`;
        btn.disabled = select.disabled;
        const title = document.createElement('span');
        title.className = 'text-[10px] font-bold uppercase';
        const sub = document.createElement('small');
        if (opt.value === '') {
            title.textContent = select.disabled && opt.textContent.startsWith('Fixed') ? 'Fixed' : 'Auto';
            const match = opt.textContent.match(/\(([^)]+)\)/);
            sub.textContent = match ? match[1] : 'Default';
        } else {
            title.textContent = opt.value;
            sub.textContent = opt.value === 'minimal' ? 'Fastest' : opt.value === 'low' ? 'Fast' : opt.value === 'medium' ? 'Balanced' : 'Deep';
        }
        btn.append(title, sub);
        btn.onclick = () => {
            if (select.disabled) return;
            select.value = opt.value;
            select.dispatchEvent(new Event('change'));
        };
        container.append(btn);
    }

    const selectedOpt = select.options[select.selectedIndex];
    const labelText = selectedOpt ? selectedOpt.textContent : 'Default';
    if ($('effort-status-badge')) $('effort-status-badge').textContent = labelText;
    if ($('active-effort-badge')) {
        $('active-effort-badge').textContent = mode === 'image'
            ? `${$('size').value} · ${$('ratio').value}`
            : labelText;
    }
}

function busy() {
    const active = !!controller;
    const disabled = active || reading;
    for (const id of ['mode', 'model-select', 'model', 'effort', 'instructions', 'size', 'ratio', 'clear', 'reload', 'prompt']) {
        if ($(id)) $(id).disabled = disabled;
    }
    if ($('model-search')) $('model-search').disabled = disabled;
    document.querySelectorAll('#mode-btn-chat, #mode-btn-image, #size-pills button, #ratio-quick-grid button, #instruction-presets button, #model-family-tabs button').forEach(btn => {
        btn.disabled = disabled;
    });
    $('send').disabled = disabled;
    $('files').disabled = disabled;
    $('upload').setAttribute('aria-disabled', String(disabled));
    $('upload').tabIndex = disabled ? -1 : 0;
    $('stop').hidden = !active;
    syncThinkingLevels();
    renderModelCards();
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
    renderModelCards();
}
function syncThinkingLevels() {
    const model = currentModelObject();
    const levels = mode === 'chat' ? model?.thinking_levels : ['minimal', 'low', 'medium', 'high'];
    const select = $('effort');
    const previous = select.value;
    select.replaceChildren();
    const fixed = mode === 'chat' && Array.isArray(levels) && levels.length === 1;
    const none = mode === 'chat' && Array.isArray(levels) && levels.length === 0;
    const defaultOption = document.createElement('option'); defaultOption.value = '';
    defaultOption.textContent = model?.default_thinking_level && mode === 'chat'
        ? `${fixed ? 'Fixed' : 'Default'} (${model.default_thinking_level})`
        : none
        ? 'Standard'
        : 'Default';
    select.append(defaultOption);
    const selectableLevels = fixed || none ? [] : Array.isArray(levels) ? levels : ['low', 'medium', 'high'];
    for (const level of selectableLevels) {
        const option = document.createElement('option'); option.value = level; option.textContent = level;
        select.append(option);
    }
    select.value = !fixed && !none && (!levels || selectableLevels.includes(previous)) ? previous : '';
    if (select.selectedIndex < 0) select.value = '';
    select.disabled = !!controller || reading || fixed || none;
    if ($('effort-hint')) {
        $('effort-hint').textContent = fixed
            ? `Locked to ${model.default_thinking_level} by this model tier.`
            : none
            ? 'This model uses standard inference without configurable thinking tiers.'
            : mode === 'image'
            ? 'Optional prompt-refinement thinking budget before image synthesis.'
            : 'Controls internal reasoning budget before streaming the final answer.';
    }
    renderEffortPills();
    updateInspector();
}
$('effort').onchange = () => {
    renderEffortPills();
};

function setSizeValue(size) {
    $('size').value = size;
    const labels = { '512': '512px Fast Preview', '1K': '1K Standard', '2K': '2K High Detail', '4K': '4K Ultra Master' };
    if ($('size-label-badge')) $('size-label-badge').textContent = labels[size] || size;
    document.querySelectorAll('#size-pills [data-size]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.size === size);
    });
    renderEffortPills();
}

function setRatioValue(ratio) {
    $('ratio').value = ratio;
    document.querySelectorAll('#ratio-quick-grid [data-ratio]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.ratio === ratio);
    });
    renderEffortPills();
}

document.querySelectorAll('#size-pills [data-size]').forEach(btn => {
    btn.onclick = () => {
        if (controller || reading) return;
        setSizeValue(btn.dataset.size);
    };
});
$('size').onchange = () => setSizeValue($('size').value);

document.querySelectorAll('#ratio-quick-grid [data-ratio]').forEach(btn => {
    btn.onclick = () => {
        if (controller || reading) return;
        setRatioValue(btn.dataset.ratio);
    };
});
$('ratio').onchange = () => setRatioValue($('ratio').value);

document.querySelectorAll('#instruction-presets [data-preset]').forEach(btn => {
    btn.onclick = () => {
        if (controller || reading) return;
        const key = btn.dataset.preset;
        $('instructions').value = key === 'clear' ? '' : (INSTRUCTION_PRESETS[key] || '');
        $('instructions').focus();
    };
});

document.querySelectorAll('#model-family-tabs [data-family]').forEach(tab => {
    tab.onclick = () => {
        if (controller || reading) return;
        selectedFamily = tab.dataset.family;
        document.querySelectorAll('#model-family-tabs [data-family]').forEach(el => {
            el.classList.toggle('active', el.dataset.family === selectedFamily);
        });
        if (selectedFamily === 'custom') {
            $('model-select').value = '__custom__';
            $('model-select').dispatchEvent(new Event('change'));
        } else {
            renderModelCards();
        }
    };
});

if ($('model-search')) {
    $('model-search').oninput = () => {
        modelSearchQuery = $('model-search').value;
        renderModelCards();
    };
}

if ($('toggle-variants')) {
    $('toggle-variants').onclick = () => {
        showTierVariants = !showTierVariants;
        renderModelCards();
    };
}

$('model-select').onchange = () => {
    $('model-custom').hidden = $('model-select').value !== '__custom__';
    if ($('model-select').value !== '__custom__') {
        $('model').value = '';
        if (selectedFamily === 'custom') {
            selectedFamily = 'all';
            document.querySelectorAll('#model-family-tabs [data-family]').forEach(el => {
                el.classList.toggle('active', el.dataset.family === 'all');
            });
        }
    } else if (!$('model-custom').hidden) {
        $('model').focus();
    }
    syncThinkingLevels();
    renderModelCards();
};
$('model').oninput = syncThinkingLevels;
async function loadModels() {
    $('reload').disabled = true; $('model-status').textContent = 'Loading…'; $('model-status').hidden = false;
    try {
        const response = await fetch('/v1/models', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const displayResponse = await fetch('/api/model-display', { cache: 'no-store' });
        if (!displayResponse.ok) throw new Error(`Display configuration HTTP ${displayResponse.status}`);
        globalThis.AntigravityModelDisplay.configure(await displayResponse.json());
        const result = await response.json();
        if (!Array.isArray(result.data)) throw new Error('Invalid model list');
        const preferred = currentModel();
        const wasListed = (mode === 'image' ? imageModels : models).some(item => item.id === preferred);
        models = result.data.filter(item => typeof item?.id === 'string' && item.id.trim() && !item.disabled && isVisibleModel(item));
        if (Array.isArray(result.antigravity?.imageModels)) imageModels = result.antigravity.imageModels.filter(isVisibleModel);
        const stillListed = (mode === 'image' ? imageModels : models).some(item => item.id === preferred);
        populate(wasListed && !stillListed ? '' : preferred);
        if ($('catalog-summary')) {
            const antigravityCount = models.filter(m => m.owned_by !== 'codex').length;
            const codexCount = models.filter(m => m.owned_by === 'codex').length;
            $('catalog-summary').textContent = `${antigravityCount} Antigravity · ${codexCount} Codex · ${imageModels.length} Image`;
        }
    } catch (e) {
        populate();
        $('model-status').textContent = `Could not load models: ${e.message}`;
        $('model-status').hidden = false;
        if ($('catalog-summary')) $('catalog-summary').textContent = 'Catalog offline';
    }
    finally { $('reload').disabled = !!controller; }
}
$('reload').onclick = loadModels;
function reset() {
    history = [];
    session = newSessionId();
    updateSessionDisplay();
    $('messages').replaceChildren();
    error();
    updateStatusUI('Ready', 'ready');
    updateWorkspaceState();
}
$('clear').onclick = () => {
    reset();
    attachments = [];
    $('prompt').value = '';
    updatePromptStats();
    renderAttachments();
};
if ($('copy-session')) {
    $('copy-session').onclick = async () => {
        try {
            await navigator.clipboard.writeText(session);
            $('copy-session').textContent = 'Copied!';
            setTimeout(() => { $('copy-session').textContent = 'Copy ID'; }, 1200);
        } catch {}
    };
}
if ($('rotate-session')) {
    $('rotate-session').onclick = () => {
        if (controller || reading) return;
        session = newSessionId();
        updateSessionDisplay();
        $('rotate-session').textContent = 'Rotated!';
        setTimeout(() => { $('rotate-session').textContent = 'Rotate'; }, 1000);
    };
}
function applyModeUI() {
    const image = mode === 'image';
    $('mode').value = mode;
    if ($('mode-btn-chat')) {
        $('mode-btn-chat').classList.toggle('active', !image);
        $('mode-btn-chat').querySelector('.mode-dot').className = `mode-dot w-1.5 h-1.5 rounded-full ${!image ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-700'}`;
    }
    if ($('mode-btn-image')) {
        $('mode-btn-image').classList.toggle('active', image);
        $('mode-btn-image').querySelector('.mode-dot').className = `mode-dot w-1.5 h-1.5 rounded-full ${image ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-700'}`;
    }
    if ($('endpoint-badge')) {
        $('endpoint-badge').textContent = image ? 'POST /v1/images/generations' : 'POST /v1/responses';
    }
    if ($('mode-protocol-tag')) {
        $('mode-protocol-tag').textContent = image ? 'REST b64_json' : 'SSE Stream';
    }
    if ($('model-filter-controls')) {
        $('model-filter-controls').hidden = image;
    }
    $('chat-options').hidden = image;
    $('image-options').hidden = !image;
    $('upload').textContent = image ? '+ Add reference images' : '+ Attach';
    $('files').accept = image
        ? 'image/png,image/jpeg,image/webp,image/gif'
        : 'image/png,image/jpeg,image/webp,image/gif,.txt,.md,.csv,.json,.jsonl,.log,.xml,.yaml,.yml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql';
    $('heading').textContent = image ? 'Images' : 'Chat';
    $('send').textContent = image ? 'Generate' : 'Send';
    if ($('clear-label')) $('clear-label').textContent = image ? 'Clear studio' : 'New chat';
    else $('clear').textContent = image ? 'Clear' : 'New chat';
    $('prompt').placeholder = image
        ? 'Describe the image to generate, composition, lighting, or how to transform reference images...'
        : 'Ask anything, paste screenshots (Ctrl+V), or drop code/text files here...';
    if ($('attachment-hint-text')) {
        $('attachment-hint-text').textContent = image
            ? 'Reference images optional: Drop or paste up to 8 PNG, JPEG, WebP, or GIF images (max 10 MB total)'
            : 'Drop files, paste images, or attach: PNG, JPG, WebP, GIF & code/text (.md, .json, .ts, .py, .log…) · Max 8 files / 10 MB';
    }
    if ($('drop-overlay-hint')) {
        $('drop-overlay-hint').textContent = image
            ? 'Up to 8 reference images (10 MB total) · PNG, JPEG, WebP, GIF'
            : 'Up to 8 attachments (10 MB total) · Images & UTF-8 text/code files';
    }
    if ($('guide-mode-tag')) $('guide-mode-tag').textContent = image ? 'Nano Banana 2 Image Studio' : 'Responses Stream API';
    if ($('guide-title')) {
        $('guide-title').textContent = image
            ? 'Synthesize high-resolution visuals & remix reference images'
            : 'Test multi-turn reasoning, multimodal inputs & pool routing';
    }
    if ($('guide-subtitle')) {
        $('guide-subtitle').textContent = image
            ? 'Backed by Antigravity Google OAuth image pools with configurable 512–4K resolution, 14 aspect ratios, and up to 8 reference images.'
            : 'Requests route through your active Antigravity and Codex OAuth pools with automatic failover and sticky session cache affinity.';
    }
    if ($('attachments-title')) {
        $('attachments-title').textContent = image ? 'Reference Images' : 'Staged Context Files';
    }
    renderStarters();
}
$('mode').onchange = () => {
    selections[mode] = currentModel(); mode = $('mode').value;
    applyModeUI();
    attachments = []; renderAttachments(); populate(selections[mode]); reset();
};
for (const btnId of ['mode-btn-chat', 'mode-btn-image']) {
    if ($(btnId)) {
        $(btnId).onclick = () => {
            const target = $(btnId).dataset.modeValue;
            if (mode !== target && !controller && !reading) {
                $('mode').value = target;
                $('mode').dispatchEvent(new Event('change'));
            }
        };
    }
}
function renderAttachments() {
    $('attachments').replaceChildren();
    const totalBytes = attachments.reduce((sum, item) => sum + (item.size || 0), 0);
    if ($('attachments-panel')) {
        $('attachments-panel').hidden = attachments.length === 0;
    }
    if ($('attachments-quota')) {
        $('attachments-quota').textContent = `${attachments.length} / 8 files · ${formatBytes(totalBytes)} / 10 MB`;
    }
    if ($('attachments-progress')) {
        const pct = Math.min(100, Math.max(attachments.length ? 3 : 0, Math.round((totalBytes / (10 * 1024 * 1024)) * 100)));
        $('attachments-progress').style.width = `${pct}%`;
    }
    if ($('clear-attachments')) {
        $('clear-attachments').disabled = !!controller || reading;
    }
    attachments.forEach((file, index) => {
        const item = document.createElement('div'); item.className = 'attachment';
        if (file.url) { const image = document.createElement('img'); image.src = file.url; image.alt = file.name; item.append(image); }
        else {
            const badge = document.createElement('span');
            badge.className = 'attachment-badge';
            const ext = file.name.includes('.') ? file.name.split('.').pop().slice(0, 4) : 'TXT';
            badge.textContent = ext;
            item.append(badge);
        }
        const meta = document.createElement('div'); meta.className = 'attachment-meta';
        const name = document.createElement('span'); name.className = 'font-bold truncate max-w-[180px]'; name.textContent = file.name;
        const size = document.createElement('span'); size.className = 'attachment-size tabular-nums';
        const lines = typeof file.text === 'string' ? `${file.text.split(/\r?\n/).length}L · ` : 'Image · ';
        size.textContent = `${lines}${formatBytes(file.size)}`;
        meta.append(name, size); item.append(meta);
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.disabled = !!controller || reading;
        remove.onclick = () => { attachments.splice(index, 1); renderAttachments(); }; item.append(remove); $('attachments').append(item);
    });
}
if ($('clear-attachments')) {
    $('clear-attachments').onclick = () => {
        if (controller || reading) return;
        attachments = [];
        renderAttachments();
    };
}
async function addFiles(files) {
    if (controller || reading || !files?.length) return;
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
const workspaceEl = document.querySelector('.workspace');
if (workspaceEl) {
    workspaceEl.addEventListener('dragenter', event => {
        if (controller || reading || !event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
        dragDepth++;
        if ($('drop-overlay')) $('drop-overlay').hidden = false;
    });
    workspaceEl.addEventListener('dragover', event => {
        if (!event.dataTransfer?.types?.includes('Files')) return;
        event.preventDefault();
    });
    workspaceEl.addEventListener('dragleave', event => {
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0 && $('drop-overlay')) $('drop-overlay').hidden = true;
    });
    workspaceEl.addEventListener('drop', event => {
        event.preventDefault();
        dragDepth = 0;
        if ($('drop-overlay')) $('drop-overlay').hidden = true;
        if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
    });
}
$('composer').ondragover = event => { event.preventDefault(); };
$('composer').ondrop = event => {
    event.preventDefault();
    dragDepth = 0;
    if ($('drop-overlay')) $('drop-overlay').hidden = true;
    addFiles(event.dataTransfer.files);
};
$('prompt').onpaste = event => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles(event.clipboardData.files); } };
$('prompt').oninput = updatePromptStats;
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); } };
$('stop').onclick = () => controller?.abort();
function openCodeModal() {
    if (!$('code-modal')) return;
    const snippet = buildCurlSnippet({
        mode,
        model: currentModel(),
        prompt: $('prompt').value.trim(),
        instructions: $('instructions').value.trim(),
        effort: $('effort').value,
        size: $('size').value,
        ratio: $('ratio').value,
        sessionId: session,
        origin: location.origin,
        attachments,
    });
    $('code-modal-content').textContent = snippet;
    $('code-modal').hidden = false;
}
function closeCodeModal() {
    if ($('code-modal')) $('code-modal').hidden = true;
}
if ($('open-code-modal')) $('open-code-modal').onclick = openCodeModal;
if ($('Quick-curl')) $('Quick-curl').onclick = openCodeModal;
if ($('close-code-modal')) $('close-code-modal').onclick = closeCodeModal;
if ($('code-modal')) {
    $('code-modal').onclick = event => {
        if (event.target === $('code-modal')) closeCodeModal();
    };
}
if ($('copy-curl-modal')) {
    $('copy-curl-modal').onclick = async () => {
        try {
            await navigator.clipboard.writeText($('code-modal-content').textContent || '');
            $('copy-curl-modal').textContent = 'Copied!';
            setTimeout(() => { $('copy-curl-modal').textContent = 'Copy cURL'; }, 1400);
        } catch {}
    };
}
window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('code-modal') && !$('code-modal').hidden) {
        closeCodeModal();
    }
});
function message(role, text, files = []) {
    const element = document.createElement('article'); element.className = `message ${role}`;
    const header = document.createElement('div'); header.className = 'message-header';
    const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? 'You' : [...models, ...imageModels].find(model => model.id === currentModel())?.name || currentModel();
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const timeBadge = document.createElement('span'); timeBadge.className = 'text-[9px] text-zinc-400 font-normal';
    timeBadge.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    actions.append(timeBadge);
    if (role === 'user' && text) {
        const reuseBtn = document.createElement('button');
        reuseBtn.type = 'button'; reuseBtn.className = 'message-action-btn'; reuseBtn.textContent = 'Reuse';
        reuseBtn.onclick = () => {
            if (controller || reading) return;
            $('prompt').value = text;
            updatePromptStats();
            $('prompt').focus();
        };
        actions.append(reuseBtn);
    }
    const body = document.createElement('div'); body.className = 'message-body'; body.textContent = text;
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button'; copyBtn.className = 'message-action-btn'; copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(body.textContent || '');
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        } catch {}
    };
    actions.append(copyBtn);
    header.append(label, actions);
    element.append(header, body);
    for (const file of files) {
        if (file.url) { const img = document.createElement('img'); img.src = file.url; img.alt = file.name; element.append(img); }
        else { const name = document.createElement('div'); name.textContent = `Attachment: ${file.name} (${formatBytes(file.size)})`; name.className = 'usage'; element.append(name); }
    }
    $('messages').append(element);
    updateWorkspaceState();
    element.scrollIntoView({ block: 'nearest' });
    return { element, body };
}
function note(element, text, className = 'usage') { const node = document.createElement('div'); node.className = className; node.textContent = text; element.append(node); }
$('composer').onsubmit = async event => {
    event.preventDefault(); if (controller || reading) return;
    const prompt = $('prompt').value.trim(), model = currentModel(), files = [...attachments];
    if (!model) return error('Select a model.');
    if (!prompt && (mode === 'image' || !files.length)) return error(mode === 'image' ? 'Enter a prompt.' : 'Enter a message or attach a file.');
    error(); controller = new AbortController(); busy();
    const startedAt = performance.now();
    updateStatusUI(mode === 'image' ? 'Generating…' : 'Responding…', 'busy');
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
            const elapsedSec = ((performance.now() - startedAt) / 1000).toFixed(2);
            assistant.body.textContent = `${$('size').value} · Aspect ${$('ratio').value} · Completed in ${elapsedSec}s`;
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
                const elapsedSec = Math.max(0.05, (performance.now() - startedAt) / 1000);
                if (result.usage) {
                    const outTokens = Number(result.usage.output_tokens) || 0;
                    const speed = outTokens > 0 ? ` · ${(outTokens / elapsedSec).toFixed(1)} tok/s` : '';
                    note(assistant.element, `Input ${result.usage.input_tokens ?? '—'} · Output ${result.usage.output_tokens ?? '—'} tokens · ${elapsedSec.toFixed(2)}s${speed}`);
                }
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
        $('prompt').value = ''; updatePromptStats(); attachments = []; updateStatusUI('Done', 'ready'); updateWorkspaceState();
    } catch (e) {
        const stopped = controller.signal.aborted;
        const detail = stopped ? 'Generation stopped.' : e.message;
        note(assistant.element, detail, 'failure'); error(stopped ? '' : detail); updateStatusUI(stopped ? 'Stopped' : 'Failed', stopped ? 'ready' : 'error');
    } finally { controller = null; busy(); $('prompt').focus(); }
};
updateSessionDisplay();
applyModeUI();
updateWorkspaceState();
updatePromptStats();
loadModels();
