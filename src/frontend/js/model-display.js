// Policy is supplied by the server; this engine contains no model-specific rules.
(() => {
    let policy = {};
    let accounts = [];
    const patterns = new Map();
    const coverage = new Map();
    const normalize = value => String(value || '').trim().toLowerCase()
        .replace(/^(?:openai|antigravity|models)\//, '').replace(/^antigravity-/, '')
        .replace(/[ _]/g, '-');
    const groupKey = value => normalize(value).replace(/-\(?(?:low|medium|high|xhigh|thinking)\)?$/, '').replace(/[^a-z0-9]/g, '');
    const identity = quota => (modelIds(quota).length ? modelIds(quota) : [quota.groupName]).map(normalize);
    function matches(values, selectors = []) {
        return selectors.some(selector => {
            if (!patterns.has(selector)) patterns.set(selector, new RegExp(selector, 'i'));
            return values.some(value => patterns.get(selector).test(value));
        });
    }

    function configure(value = {}) {
        policy = value;
        patterns.clear();
        coverage.clear();
    }

    function setAccounts(value) {
        accounts = value || [];
        coverage.clear();
    }

    function isVisibleModel(model) {
        const id = normalize(typeof model === 'string' ? model : model?.id || model?.modelId || model?.name || model?.groupName);
        if (matches([id], policy.visibility?.showPatterns)) return true;
        return !matches([id], policy.visibility?.hidePatterns);
    }

    function modelIds(quota) {
        return quota.modelIds?.length ? quota.modelIds : quota.modelId ? [quota.modelId] : [];
    }

    function visibleQuotas(account) {
        return (account.quota || []).flatMap(quota => {
            const ids = modelIds(quota);
            // One upstream quota row may contain members of several display groups.
            return ids.length
                ? ids.filter(isVisibleModel).map(id => ({ ...quota, modelId: id, modelIds: [id] }))
                : isVisibleModel(quota.groupName) ? [quota] : [];
        });
    }

    function quotaPool(account, quota) {
        const windows = account.quotaWindows || [];
        const names = [quota.limitName, quota.groupName].filter(Boolean).map(groupKey);
        const specific = windows.find(window => names.includes(groupKey(window.groupName)));
        if (specific) return specific.groupName;
        const declared = windows.find(window => groupKey(window.groupName) === groupKey(quota.familyName));
        for (const rule of policy.poolRules || []) {
            if (!matches(identity(quota), rule.patterns)) continue;
            if (rule.preferDeclaredPool && declared) return declared.groupName;
            for (const pool of rule.pools) {
                const existing = windows.find(window => groupKey(window.groupName) === groupKey(pool));
                if (existing) return existing.groupName;
            }
            return rule.pools[0];
        }
        return declared?.groupName || quota.familyName || quota.groupName || 'Other';
    }

    function groupName(account, quota) {
        const pool = quotaPool(account, quota);
        for (const [index, rule] of (policy.groups || []).entries()) {
            if (!matches(identity(quota), rule.patterns)) continue;
            if (rule.separateWhen !== 'different-accounts') return rule.name;
            const key = JSON.stringify([index, pool]);
            if (!coverage.has(key)) {
                const members = accounts.length ? accounts : [account];
                const poolAccounts = members.filter(member => visibleQuotas(member).some(q => quotaPool(member, q) === pool));
                const restricted = poolAccounts.filter(member => visibleQuotas(member).some(q => quotaPool(member, q) === pool && matches(identity(q), rule.patterns)));
                coverage.set(key, restricted.length > 0 && restricted.length < poolAccounts.length);
            }
            if (coverage.get(key)) return rule.name;
        }
        return pool;
    }

    function orderGroups(names) {
        const order = policy.groupOrder || [];
        const rank = name => order.includes(name) ? order.indexOf(name) : order.length;
        return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    }

    globalThis.AntigravityModelDisplay = Object.freeze({ configure, setAccounts, isVisibleModel, modelIds, visibleQuotas, quotaPool, groupName, orderGroups });
})();
