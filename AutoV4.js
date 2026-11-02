(function () {
    'use strict';

    /* =====================================================================
     * TBRAIN AUTO-FILL & AUTO-FETCH – MASTER SCRIPT (NO TOOL IN ACTIVITY)
     * ===================================================================== */
    // ==================== CONFIG: GEMINI API ====================
    const GEMINI_API_KEY = "AQ.Ab8RN6IV2eqvm1jOX_d6tGQfOD-AXR91muc0tB5Sqb-K5uYeoA"; // Thay API Key của bạn vào đây
    const TOKEN_STORAGE_KEY = 'tb_gemini_api_key_custom';

    const PROJECT_ID = "cfbe006a-9012-41bc-ba3c-afa8a3338139";

    let POLL_INTERVAL = 2000;
    let MIN_DURATION_SECONDS = 7200;

    const EXCLUDED_TASK_L1 = new Set([
        "Automotive and Transport",
        "Construction and Hardware"
    ]);

    const TOKEN_RETRY_INTERVAL = 60000;
    const API_BASE = "https://api.tbrain.ai";
    const API_URL = `${API_BASE}/api/v1/tasks/pool?projectId=${PROJECT_ID}&page=1&pageSize=20`;
    const STATS_API_URL = `${API_BASE}/api/v1/tasks/my-stats?projectId=${PROJECT_ID}`;
    const EXTRA_HOURS_API_URL = `${API_BASE}/api/v1/my/extra-hours?projectId=${PROJECT_ID}`;

    const CLICK_URL = "https://beacon.tbrain.ai";
    const REQUEST_TIMEOUT = 5000;
    const NOTIFY_ON_FIRST_POLL = true;
    const MAX_SEEN_IDS = 5000;
    const AUTO_ACQUIRE = true;
    const PERF_LOG = true;

    const RATE_LIMIT_RESERVE = 30;
    const MIN_SAFE_POLL_INTERVAL = 2500;
    const MAX_SAFE_POLL_INTERVAL = 15000;
    const RATE_LIMIT_FALLBACK_WAIT = 30000;
    const RATE_LIMIT_SAFETY_MS = 1000;
    const MAX_CONCURRENT_ACQUIRE = 2;

    const url = "https://generativelanguage.googleapis.com/v1beta/interactions";

    // ==================== UNIFIED VIDEO RATE CONTROL: 10X / 16X ====================
    // Một bộ quản lý duy nhất cho click 10X/16X và phím tắt Ctrl+Shift.
    let pressTimer = null;
    let isHolding = false;
    let isFastForwardActive = false;
    let selectedCustomPlaybackRate = null;
    let customRateRestore = new Map();
    let customRatePreviousButton = null;
    let keyboardRateRestore = new Map();
    let keyboardPreviousButton = null;
    let customRateVideoObserver = null;
    const customRateObservedVideos = new WeakSet();

    const customRateInactiveClass = 'flex h-9 items-center justify-center rounded border border-tb-border text-fg-2 hover:bg-hover w-auto px-2 font-mono text-xs transition-all';
    const customRateActiveClass = 'flex h-9 items-center justify-center rounded border hover:bg-hover w-auto px-2 font-mono text-xs border-brand-blue bg-brand-blue/15 font-semibold text-fg underline underline-offset-2 opacity-100';

    function updateCustomRateButtons(activeRate) {
        [10, 16].forEach(rate => {
            const button = document.getElementById(`tb-transport-rate-${rate}`);
            if (!button) return;
            button.disabled = false;
            button.setAttribute('aria-pressed', String(activeRate === rate));
            button.className = activeRate === rate ? customRateActiveClass : customRateInactiveClass;
        });
    }

    function getActiveNativeRateButton(ratesContainer) {
        if (!ratesContainer) return null;
        return Array.from(ratesContainer.querySelectorAll('[aria-pressed="true"]'))
            .find(button => button.id !== 'tb-transport-rate-10' && button.id !== 'tb-transport-rate-16') || null;
    }

    function captureVideoRates(targetMap) {
        document.querySelectorAll('video').forEach(video => {
            if (!targetMap.has(video)) targetMap.set(video, video.playbackRate);
        });
    }

    function getRestoreFallbackRate(rateMap) {
        for (const rate of rateMap.values()) {
            if (Number.isFinite(rate) && rate > 0) return rate;
        }
        return 1;
    }

    function enforceCustomRateOnVideo(video) {
        if (!video || !video.isConnected) return;

        const forcedRate = isFastForwardActive ? 10 : selectedCustomPlaybackRate;
        if (forcedRate === null) return;

        if (isFastForwardActive) {
            // Video được TBrain tạo mới trong lúc giữ phím cần có tốc độ khôi phục hợp lý.
            const keyboardBaseRate = selectedCustomPlaybackRate !== null
                ? selectedCustomPlaybackRate
                : getRestoreFallbackRate(keyboardRateRestore);
            if (!keyboardRateRestore.has(video)) keyboardRateRestore.set(video, keyboardBaseRate);

            // Giữ lại tốc độ nền ban đầu để lần tắt custom rate khôi phục chính xác.
            if (selectedCustomPlaybackRate !== null && !customRateRestore.has(video)) {
                customRateRestore.set(video, getRestoreFallbackRate(customRateRestore));
            }
        } else if (!customRateRestore.has(video)) {
            customRateRestore.set(video, getRestoreFallbackRate(customRateRestore));
        }

        try {
            if (video.playbackRate !== forcedRate) video.playbackRate = forcedRate;
        } catch (err) {
            console.warn('Could not enforce custom playback rate:', err);
        }
    }

    function scheduleCustomRateEnforcement(video) {
        // Một số lần pause/play khiến player cập nhật playbackRate về 1X sau event hiện tại.
        // Re-apply sau event loop để không bị thao tác nội bộ của player ghi đè.
        setTimeout(() => enforceCustomRateOnVideo(video), 0);
        setTimeout(() => enforceCustomRateOnVideo(video), 60);
    }

    function observeCustomRateVideo(video) {
        if (!video || customRateObservedVideos.has(video)) return;
        customRateObservedVideos.add(video);

        ['play', 'playing', 'loadedmetadata', 'ratechange'].forEach(eventName => {
            video.addEventListener(eventName, () => {
                if (isFastForwardActive || selectedCustomPlaybackRate !== null) {
                    scheduleCustomRateEnforcement(video);
                }
            });
        });

        enforceCustomRateOnVideo(video);
    }

    function observeCustomRateVideos(root = document) {
        if (root.matches && root.matches('video')) observeCustomRateVideo(root);
        if (root.querySelectorAll) root.querySelectorAll('video').forEach(observeCustomRateVideo);
    }

    function startCustomRateVideoObserver() {
        if (customRateVideoObserver || !document.documentElement || typeof MutationObserver === 'undefined') return;
        customRateVideoObserver = new MutationObserver(records => {
            for (const record of records) {
                record.addedNodes.forEach(node => {
                    if (node.nodeType === 1) observeCustomRateVideos(node);
                });
            }
        });
        customRateVideoObserver.observe(document.documentElement, { childList: true, subtree: true });
        observeCustomRateVideos(document);
    }

    function applyCustomPlaybackRate(rate) {
        document.querySelectorAll('video').forEach(video => {
            observeCustomRateVideo(video);
            video.playbackRate = rate;
            video.play().catch(err => console.log('Play error:', err.message));
        });
    }

    function restoreVideoRates(rateMap) {
        rateMap.forEach((rate, video) => {
            if (video && video.isConnected) {
                try { video.playbackRate = rate; } catch (err) { console.warn('Could not restore playback rate:', err); }
            }
        });
        rateMap.clear();
    }

    function restoreNativeRateButton(button) {
        if (!button || !button.isConnected) return;
        button.setAttribute('aria-pressed', 'true');
        button.className = 'flex h-9 items-center justify-center rounded border hover:bg-hover disabled:opacity-40 w-auto px-2 font-mono text-xs border-brand-blue bg-brand-blue/15 font-semibold text-fg underline underline-offset-2';
        // Đồng bộ lại state nội bộ của player với tốc độ native đã lưu.
        button.click();
    }

    function selectCustomPlaybackRate(rate) {
        if (isFastForwardActive) return;

        if (selectedCustomPlaybackRate === rate) {
            selectedCustomPlaybackRate = null;
            restoreVideoRates(customRateRestore);
            restoreNativeRateButton(customRatePreviousButton);
            customRatePreviousButton = null;
            updateCustomRateButtons(null);
            return;
        }

        // Khi chuyển 10X <-> 16X, giữ nguyên tốc độ gốc đã lưu từ lần bật đầu tiên.
        if (selectedCustomPlaybackRate === null) {
            customRateRestore = new Map();
            captureVideoRates(customRateRestore);
            customRatePreviousButton = getActiveNativeRateButton(document.querySelector('[data-testid="transport-rates"]'));
        }

        selectedCustomPlaybackRate = rate;
        const nativeButton = getActiveNativeRateButton(document.querySelector('[data-testid="transport-rates"]'));
        if (nativeButton) {
            nativeButton.setAttribute('aria-pressed', 'false');
            nativeButton.className = 'flex h-9 items-center justify-center rounded border border-tb-border text-fg-2 hover:bg-hover disabled:opacity-40 w-auto px-2 font-mono text-xs';
        }

        updateCustomRateButtons(rate);
        applyCustomPlaybackRate(rate);
    }

    function activateKeyboard10x() {
        if (isFastForwardActive) return;

        isFastForwardActive = true;
        keyboardRateRestore = new Map();
        captureVideoRates(keyboardRateRestore);
        keyboardPreviousButton = selectedCustomPlaybackRate === null
            ? getActiveNativeRateButton(document.querySelector('[data-testid="transport-rates"]'))
            : null;

        if (keyboardPreviousButton) {
            keyboardPreviousButton.setAttribute('aria-pressed', 'false');
            keyboardPreviousButton.className = 'flex h-9 items-center justify-center rounded border border-tb-border text-fg-2 hover:bg-hover disabled:opacity-40 w-auto px-2 font-mono text-xs';
        }

        updateCustomRateButtons(10);
        applyCustomPlaybackRate(10);
    }

    function deactivateKeyboard10x() {
        if (!isFastForwardActive) return;

        isFastForwardActive = false;
        restoreVideoRates(keyboardRateRestore);

        if (selectedCustomPlaybackRate !== null) {
            updateCustomRateButtons(selectedCustomPlaybackRate);
        } else {
            updateCustomRateButtons(null);
            restoreNativeRateButton(keyboardPreviousButton);
        }
        keyboardPreviousButton = null;
    }

    function cancelKeyboardShortcut() {
        // Luôn hủy timer, kể cả khi người dùng mất focus trước ngưỡng 500ms.
        isHolding = false;
        if (pressTimer !== null) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
        if (isFastForwardActive) deactivateKeyboard10x();
    }

    function injectCustomRateButtons() {
        const ratesContainer = document.querySelector('[data-testid="transport-rates"]');
        if (!ratesContainer) return;

        let btn10x = document.getElementById('tb-transport-rate-10');
        if (!btn10x) {
            btn10x = document.createElement('button');
            btn10x.id = 'tb-transport-rate-10';
            btn10x.type = 'button';
            btn10x.setAttribute('data-testid', 'transport-rate-10');
            btn10x.setAttribute('aria-pressed', 'false');
            btn10x.textContent = '10x';
            ratesContainer.appendChild(btn10x);
        }
        btn10x.disabled = false;
        btn10x.title = 'Click to toggle 10x; hold Ctrl+Shift (>500ms) for temporary 10x';
        btn10x.className = customRateInactiveClass;
        if (!btn10x.dataset.tbClickBound) {
            btn10x.dataset.tbClickBound = 'true';
            btn10x.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                selectCustomPlaybackRate(10);
            });
        }

        let btn16x = document.getElementById('tb-transport-rate-16');
        if (!btn16x) {
            btn16x = document.createElement('button');
            btn16x.id = 'tb-transport-rate-16';
            btn16x.type = 'button';
            btn16x.setAttribute('data-testid', 'transport-rate-16');
            btn16x.setAttribute('aria-pressed', 'false');
            btn16x.textContent = '16x';
            btn10x.insertAdjacentElement('afterend', btn16x);
        }
        btn16x.disabled = false;
        btn16x.title = 'Click to toggle 16x';
        btn16x.className = customRateInactiveClass;
        if (!btn16x.dataset.tbClickBound) {
            btn16x.dataset.tbClickBound = 'true';
            btn16x.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                selectCustomPlaybackRate(16);
            });
        }

        if (!ratesContainer.dataset.tbCustomRateBound) {
            ratesContainer.dataset.tbCustomRateBound = 'true';
            ratesContainer.addEventListener('click', event => {
                const target = event.target && event.target.closest ? event.target.closest('button') : null;
                if (!target || target.id === 'tb-transport-rate-10' || target.id === 'tb-transport-rate-16') return;

                // Click tốc độ native (ví dụ 8X) phải chuyển quyền điều khiển lại cho TBrain.
                selectedCustomPlaybackRate = null;
                customRateRestore.clear();
                customRatePreviousButton = null;
                if (isFastForwardActive) {
                    isFastForwardActive = false;
                    isHolding = false;
                    if (pressTimer !== null) clearTimeout(pressTimer);
                    pressTimer = null;
                    keyboardRateRestore.clear();
                    keyboardPreviousButton = null;
                }
                updateCustomRateButtons(null);
            });
        }

        updateCustomRateButtons(isFastForwardActive ? 10 : selectedCustomPlaybackRate);
    }

    document.addEventListener('keydown', event => {
        if (event.repeat) return;
        if (event.ctrlKey && event.shiftKey && !isHolding) {
            isHolding = true;
            pressTimer = setTimeout(() => {
                pressTimer = null;
                if (isHolding && !isFastForwardActive && document.hasFocus()) activateKeyboard10x();
            }, 500);
        }
    });

    document.addEventListener('keyup', event => {
        if (event.key === 'Control' || event.key === 'Shift' || !event.ctrlKey || !event.shiftKey) {
            cancelKeyboardShortcut();
        }
    });

    window.addEventListener('blur', cancelKeyboardShortcut);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) cancelKeyboardShortcut();
    });
    window.addEventListener('pagehide', cancelKeyboardShortcut);

    setInterval(injectCustomRateButtons, 500);
    startCustomRateVideoObserver();
    // ==================== END UNIFIED VIDEO RATE CONTROL ====================


    // Danh sách ID các nút cần quản lý trạng thái Disable/Enable khi click
    const CONTROL_BUTTON_IDS = [
        'tb-inject-fill',       // Nút Fill 1
        'tb-inject-loop',       // Nút Fill All
        'tb-inject-single-l3',  // Nút Fill L3
        'tb-inject-l3-loop'     // Nút Fill L3 All
    ];

    // Hàm khóa/mở khóa toàn bộ nút chức năng
    function setAllButtonsDisabled(isDisabled, activeBtnId = null) {
        CONTROL_BUTTON_IDS.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.disabled = isDisabled;
                if (isDisabled) {
                    btn.style.opacity = '0.6';
                    btn.style.cursor = 'not-allowed';
                    // if (id === activeBtnId) {
                    //     btn.dataset.origText = btn.innerHTML;
                    //     btn.innerHTML = '⏳ Processing...';
                    //     btn.style.backgroundColor = '#d97706'; // Màu cam đang xử lý
                    // }
                } else {
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                    if (id === activeBtnId && btn.dataset.origText) {
                        btn.innerHTML = btn.dataset.origText;
                        btn.style.backgroundColor = '';
                    }
                }
            }
        });
    }

    // 1. Task Definition & Output Format Definition
    const promptSystem = `Translate the Vietnamese action description into English and generate an activity slug.
    Return ONLY a valid JSON object with exactly four fields: `;

    // 1. Task Definition & Output Format Definition
    const promptSystemBatch = `Analyze the following list of Vietnamese action descriptions. 
                Return ONLY a valid JSON array containing an object for each input in the exact same order.
                Each object must have exactly four fields:`;

    // 2. Rules & Skill Group Guidelines & Examples
    const promptRules = `
    {
    "desc": "English action description",
    "act": "object-action1-action2",
    "skill": "Exact Skill Group Name",
    "difficulty": "Easy"
    }
    Rules:
    - desc: concise, natural English translation starting with a V-ing verb.
    - act: lowercase words separated by hyphens.
    - Start act with the main object.
    - Represent EVERY main action in the description.
    - Convert each action into its gerund form ending in "-ing".
    - If multiple actions are connected by "and" or "và", include ALL of them in their original order.
    - Combine the object and all gerund actions into one slug.
    - Never convert gerunds to base verbs.
    - Do not include tools, methods, articles, or unnecessary prepositional phrases in act unless they are essential to identify the action.
    - Do not duplicate the same action.
    - skill: MUST be EXACTLY ONE of the following valid group names based on the nature of the work:
        1. "Pick and Place / Object Handling" (Simple moving, lifting, transferring objects without altering them)
        2. "Tool Use & Technical Manipulation" (Using tools, crafting, weaving, carving, drilling, shaping materials like baskets, wood, metal)
        3. "Food Preparation & Cooking" (Chopping, cooking, mixing ingredients, washing food)
        4. "Mechanical / Automotive Work" (Repairing vehicles, tires, engines)
        5. "Repair & Maintenance" (Fixing broken furniture, appliances, plumbing)
        6. "Assembly & Installation" (Putting components together, screwing, mounting furniture)
        7. "Construction & Building" (Bricklaying, plastering, pouring concrete, heavy building)
        8. "Cleaning & Sanitation" (Wiping surfaces, sweeping, mopping, washing)
        9. "Organization & Tidying" (Arranging items in drawers, sorting books, tidying)
        10. "Packing & Bagging" (Folding, Boxing, wrapping, sealing packages)
        11. "Clothing & Laundry" (Folding clothes, ironing, sewing, laundering)
        12. "Inventory & Stock Management" (Counting stock, shelving, labeling items)
        13. "Retail & Service Operations" (Cashier checkout, serving customers)
        14. "Human Interaction & Handoffs" (Handing items to someone, greeting)
        15. "Healthcare & Caregiving" (First aid, feeding patients, applying bandages)
        16. "Home Appliance Interaction" (Operating microwaves, washing machines)
        17. "Electronics & Diagnostics" (Soldering circuit boards, testing electronics)
        18. "Dish Handling" (Washing and stacking plates, cups, cutlery)
    - difficulty: must be strictly one of these three values: "Easy", "Medium", or "Hard". Follow these strict classification rules`

    // 3. Final Constraints & Input Payload
    const promptInput = (text) => `- Return valid JSON only. Do not use Markdown fences or add explanations. Vietnamese action description: "${text}"`
    const promptInputBatch = (textsArray) => `- Return valid JSON array only. Do not use Markdown fences or add explanations.
        Input list of Vietnamese descriptions:
        ${JSON.stringify(textsArray)}`;

    // ==================== CONFIG: AUTO-FILL ====================
    const CONFIG = {
        panelId: 'tb-helper-panel',
        segmentSelector: '',
        copyRequiresAllFields: true,
        activitySeparator: '_',
        maxObjectWords: 2,
        minL3Score: 18,
        delayBetweenEpisodes: 50,

        selectors: {
            description: [
                'textarea[data-testid="label-task-description"]',
                'textarea[name*="description" i]',
                'textarea[id*="description" i]'
            ],
            activity: [
                'input[data-testid*="activity" i]',
                'input[name*="activity" i]',
                'input[id*="activity" i]',
                'input[placeholder*="activity" i]'
            ],
            skillGroup: [
                'input[data-testid*="skill" i]',
                'input[name*="skill" i]',
                'input[id*="skill" i]',
                'input[placeholder*="skill" i]'
            ],
            scene: [
                'input[data-testid*="scene" i]',
                'input[data-testid*="environment" i]',
                'input[name*="scene" i]',
                'input[id*="scene" i]',
                'input[placeholder*="scene" i]',
                'input[placeholder*="environment" i]'
            ]
        }
    };

    async function translateToEnglish(text) {
        if (!text) return text;

        const currentApiKey = typeof window.getStoredApiKey === 'function' ? window.getStoredApiKey() : GEMINI_API_KEY;
        if (currentApiKey) {
            let delay = 2000;
            const maxRetries = 3;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const prompt = `${promptSystem}\n\n${promptRules}\n\n${promptInput(text)}`;

                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': currentApiKey
                        },
                        body: JSON.stringify({
                            model: 'gemini-3.1-flash-lite',
                            input: prompt
                        })
                    });

                    if (response.status === 429 || response.status === 503 || response.status === 500) {
                        if (response.status === 429) {
                            const errText = await response.text().catch(() => "");
                            if (errText.toLowerCase().includes('quota') || errText.toLowerCase().includes('resource_exhausted')) {
                                alert('🚨 Đã HẾT TOKEN hoặc vượt quá quota của Gemini API Key! Vui lòng đổi Key khác tại nút 🔑 Key.');
                                throw new Error("Quota exceeded");
                            }
                        }
                        if (attempt === maxRetries) throw new Error(`API Error status: ${response.status}`);
                        console.warn(`⚠️ API quá tải (${response.status}). Thử lại lần ${attempt}/${maxRetries} sau ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                        delay *= 2;
                        continue;
                    }

                    if (!response.ok) {
                        const errorBody = await response.text();
                        console.error(
                            `Gemini API Error: ${response.status}`,
                            errorBody
                        );
                    } else {
                        const data = await response.json();
                        let rawText = null;

                        // 1. Kiểm tra cấu trúc Interactions / Steps mới của bạn
                        if (Array.isArray(data?.steps)) {
                            for (const step of data.steps) {
                                if (step.type === "model_output" && Array.isArray(step.content)) {
                                    const textItem = step.content.find(c => c.type === "text" && c.text);
                                    if (textItem) {
                                        rawText = textItem.text;
                                        break;
                                    }
                                }
                            }
                        }

                        // 2. Dự phòng thêm cấu trúc generateContent cũ (nếu có sau này)
                        if (!rawText && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                            rawText = data.candidates[0].content.parts[0].text;
                        }

                        // 3. Tiến hành làm sạch và Parse JSON an toàn
                        if (rawText && typeof rawText === 'string') {
                            try {
                                const cleanJsonStr = rawText
                                    .replace(/```json/gi, '')
                                    .replace(/```/g, '')
                                    .trim();

                                const parsedObj = JSON.parse(cleanJsonStr);

                                if (parsedObj && parsedObj.desc && parsedObj.act) {
                                    console.log(`🤖 [GEMINI JSON PARSED]:`, parsedObj);

                                    return {
                                        desc: parsedObj.desc.trim(),
                                        act: parsedObj.act.toLowerCase().trim(),
                                        skill: parsedObj.skill && parsedObj.skill.trim() !== "" ? parsedObj.skill.trim() : "Pick and Place / Object Handling",
                                        difficulty: ["Easy", "Medium", "Hard"].includes(parsedObj.difficulty) ? parsedObj.difficulty : "Easy"
                                    };
                                }
                            } catch (parseError) {
                                console.error("Lỗi cú pháp JSON từ Gemini trả về:", parseError, "Raw Text:", rawText);
                            }
                        }

                        console.warn("Gemini returned invalid JSON or empty output:", data);
                    }
                    break;
                } catch (e) {
                    if (e.message.includes("Quota exceeded")) break;
                    console.error(`❌ Lỗi lần thử ${attempt}:`, e);
                    if (attempt === maxRetries) break;
                    await new Promise(r => setTimeout(r, delay));
                    delay *= 2;
                }
            }
        }

        return textsArray.map(t => ({
            desc: t,
            act: t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-') || "object-action",
            skill: "Pick and Place / Object Handling",
            difficulty: "Easy"
        }));
    }

    async function translateBatchWithGemini(textsArray) {
        if (!Array.isArray(textsArray) || textsArray.length === 0) return [];

        const currentApiKey = typeof window.getStoredApiKey === 'function' ? window.getStoredApiKey() : GEMINI_API_KEY;

        if (currentApiKey) {
            let delay = 2000;
            const maxRetries = 3;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const prompt = `${promptSystemBatch}\n\n${promptRules}\n\n${promptInputBatch(textsArray)}`;

                    const response = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': currentApiKey
                        },
                        body: JSON.stringify({
                            model: 'gemini-3.1-flash-lite',
                            input: prompt
                        })
                    });

                    if (response.status === 429 || response.status === 503 || response.status === 500) {
                        if (response.status === 429) {
                            const errText = await response.text().catch(() => "");
                            if (errText.toLowerCase().includes('quota') || errText.toLowerCase().includes('resource_exhausted')) {
                                alert('🚨 Đã HẾT TOKEN hoặc vượt quá quota của Gemini API Key! Vui lòng đổi Key khác tại nút 🔑 Key.');
                                break;
                            }
                        }
                        if (attempt === maxRetries) break;
                        console.warn(`⚠️ Batch API quá tải. Thử lại lần ${attempt}/${maxRetries}...`);
                        await new Promise(r => setTimeout(r, delay));
                        delay *= 2;
                        continue;
                    }

                    if (response.ok) {
                        const data = await response.json();
                        let rawText = null;

                        if (Array.isArray(data?.steps)) {
                            for (const step of data.steps) {
                                if (step.type === "model_output" && Array.isArray(step.content)) {
                                    const textItem = step.content.find(c => c.type === "text" && c.text);
                                    if (textItem) {
                                        rawText = textItem.text;
                                        break;
                                    }
                                }
                            }
                        }

                        if (rawText) {
                            const cleanJsonStr = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
                            const parsedArray = JSON.parse(cleanJsonStr);

                            if (Array.isArray(parsedArray)) {
                                console.log(`🤖 [GEMINI BATCH PARSED]:`, parsedArray);
                                return parsedArray.map(item => ({
                                    desc: item.desc ? item.desc.trim() : "",
                                    act: item.act ? item.act.toLowerCase().trim() : "object-action",
                                    skill: item.skill || "Pick and Place / Object Handling",
                                    difficulty: ["Easy", "Medium", "Hard"].includes(item.difficulty) ? item.difficulty : "Easy"
                                }));
                            }
                        }
                    }
                    break;
                } catch (e) {
                    console.error(`❌ Lỗi Batch API lần thử ${attempt}:`, e);
                    if (attempt === maxRetries) break;
                    await new Promise(r => setTimeout(r, delay));
                    delay *= 2;
                }
            }
        }


        // Fallback dự phòng nếu lỗi API: Trả về mảng mặc định tương ứng số lượng đầu vào
        return textsArray.map(t => ({
            desc: t,
            act: t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, '-') || "object-action",
            skill: "Pick and Place / Object Handling",
            difficulty: "Easy"
        }));
    }

    function normalizeText(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[’']/g, '')
            .replace(/[-_/]/g, ' ')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function findFirstElement(selectors, root = document) {
        for (const selector of selectors) {
            const el = root.querySelector(selector);
            if (el) return el;
        }
        return null;
    }

    function findInputNearLabel(labelTexts, root = document) {
        const candidates = Array.from(root.querySelectorAll('label, span, p, div'))
            .filter(el => el.children.length <= 2 && el.textContent.trim().length < 60);

        const label = candidates.find(el => {
            const t = normalizeText(el.textContent);
            return labelTexts.some(l => t === normalizeText(l) || t.startsWith(normalizeText(l)));
        });
        if (!label) return null;

        if (label.matches('label') && label.htmlFor) {
            const linked = document.getElementById(label.htmlFor);
            if (linked) return linked;
        }

        let node = label;
        for (let depth = 0; depth < 4 && node; depth++) {
            const input = node.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
            if (input) return input;
            node = node.parentElement;
        }
        return null;
    }

    const getDescriptionElement = (root = document) => findFirstElement(CONFIG.selectors.description, root) || findInputNearLabel(['task description', 'description'], root);
    const getActivityElement = (root = document) => findFirstElement(CONFIG.selectors.activity, root) || findInputNearLabel(['activity'], root);
    const getSkillGroupElement = (root = document) => findFirstElement(CONFIG.selectors.skillGroup, root) || findInputNearLabel(['skill group', 'skill'], root);
    const getSceneElement = (root = document) => findFirstElement(CONFIG.selectors.scene, root) || findInputNearLabel(['scene environment l3', 'environment l3', 'scene', 'l3'], root);

    function setNativeValue(element, value) {
        if (!element) return false;
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(element, value); else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function clickOptionByText(targetText) {
        const target = normalizeText(targetText);
        const activeListboxes = Array.from(document.querySelectorAll('[role="listbox"], .dropdown-menu, .MuiAutocomplete-popper, [class*="dropdown"], [class*="menu"]'))
            .filter(el => el.offsetParent !== null);

        let candidates = [];
        if (activeListboxes.length > 0) {
            for (const box of activeListboxes) {
                const items = Array.from(box.querySelectorAll('button, [role="option"], [role="button"], li, div, span'))
                    .filter(el => el.offsetParent !== null && normalizeText(el.textContent) === target);
                candidates = candidates.concat(items);
            }
        }

        if (candidates.length === 0) {
            candidates = Array.from(document.querySelectorAll('button, [role="option"], [role="button"], li, div, span'))
                .filter(el => el.offsetParent !== null && normalizeText(el.textContent) === target);
        }

        if (candidates.length === 0) return false;
        candidates[0].click();
        return true;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function setComboBoxValue(element, value) {
        if (!element || !value) return false;

        // 1. Focus và kích hoạt mở combobox
        element.focus();
        element.click();
        await sleep(100);

        // 2. Gán giá trị thông qua React Native Value Setter (nếu có)
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(element, value);
        else element.value = value;

        // 3. Bắn các sự kiện bàn phím và input để React state bắt được thay đổi
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(200);

        // 4. Thử tìm và click vào option khớp với giá trị trong dropdown nếu có
        if (clickOptionByText(value)) {
            await sleep(100);
            element.blur();
            return true;
        }

        // 5. Nếu không có option khớp, gửi phím Enter để xác nhận giá trị custom
        ['keydown', 'keypress', 'keyup'].forEach(type => {
            element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        });

        await sleep(150);
        element.blur();

        // 6. Kiểm tra lại lần cuối, nếu bị React reset thì cưỡng bức gán lại giá trị setter
        if (element.value !== value) {
            if (setter) setter.call(element, value);
            else element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
        }

        return true;
    }

    const CLIPBOARD_KEY = 'tbHelperSegmentClipboard';
    function storageGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
    function storageSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { } }

    let segmentClipboard = storageGet(CLIPBOARD_KEY);
    const DIFFICULTY_NAMES = ['Easy', 'Medium', 'Hard'];

    function readDifficulty(root) {
        const isVisible = el => el.offsetParent !== null || el.getClientRects().length > 0;
        const isSelectedEl = el => {
            if (['aria-checked', 'aria-pressed', 'aria-selected', 'aria-current'].some(a => el.getAttribute(a) === 'true')) return true;
            const state = el.getAttribute('data-state');
            if (state && /^(checked|on|active|selected)$/i.test(state)) return true;
            const cls = (el.className && el.className.toString()) || '';
            if (/(^|[\s_-])(selected|active|checked)([\s_-]|$)/i.test(cls)) return true;
            const input = el.matches('input') ? el : el.querySelector('input[type="radio"], input[type="checkbox"]');
            return !!(input && input.checked);
        };
        const candidates = Array.from(root.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], [role="tab"], label, li')).filter(isVisible);
        const hit = candidates.find(el => DIFFICULTY_NAMES.some(n => normalizeText(n) === normalizeText(el.textContent)) && isSelectedEl(el));
        if (hit) return DIFFICULTY_NAMES.find(n => normalizeText(n) === normalizeText(hit.textContent));
        return '';
    }

    function getCurrentSegmentRoot() {
        const descEl = getDescriptionElement();
        if (!descEl) return document.body;
        let node = descEl;
        while (node && node !== document.body) {
            if (node.querySelectorAll('[data-testid^="episode-index-row-"]').length > 0 || node.classList.contains('segment') || node.tagName === 'FORM') {
                return node;
            }
            node = node.parentElement;
        }
        return document.body;
    }

    function readCurrentSegmentData() {
        const root = getCurrentSegmentRoot();
        const val = el => (el && 'value' in el ? String(el.value).trim() : '');
        return {
            description: val(getDescriptionElement(root)),
            activity: val(getActivityElement(root)),
            skillGroup: val(getSkillGroupElement(root)),
            difficulty: readDifficulty(root),
            l3: val(getSceneElement(root))
        };
    }

    let isLoopRunning = false;
    let isL3LoopRunning = false;

    async function analyze(description) {
        // 1. Gọi hàm translateToEnglish để lấy về object gồm 4 trường do Gemini phân tích
        const result = await translateToEnglish(description);

        // Nếu vì lý do nào đó (lỗi mạng, hết quota) mà hàm trả về chuỗi thay vì object, ta có cơ chế phòng thủ:
        if (!result || typeof result !== 'object') {
            return {
                desc: description,
                act: "object-action",
                skill: { name: 'Pick and Place / Object Handling' },
                difficulty: { name: 'Easy' }
            };
        }

        // 2. Tách các biến ra từ kết quả trả về của Gemini
        const desc = result.desc;
        const act = result.act;

        // Định dạng lại thành object mà các hàm set giá trị form Tbrain đang cần
        const skill = { name: result.skill };
        const difficulty = { name: result.difficulty };

        // 3. Trả về đầy đủ để script tự động điền vào các ô input trên giao diện
        return { desc, act, skill, difficulty };
    }

    async function runAutoFill() {
        const currentBtnId = 'tb-inject-fill';
        setAllButtonsDisabled(true, currentBtnId);

        // Tìm nút Fill 1 trên giao diện (bạn có thể thay thế ID này nếu đặt khác)
        const fillSingleBtn = document.getElementById('tb-inject-fill') || document.querySelector('.tb-inject-fill-btn');

        if (fillSingleBtn) {
            fillSingleBtn.textContent = '⏳ Analyzing...';
            fillSingleBtn.style.backgroundColor = '#d97706'; // Màu cam báo đang xử lý
            fillSingleBtn.disabled = true;
        }

        try {
            const descEl = getDescriptionElement();
            if (!descEl || !descEl.value.trim()) {
                if (fillSingleBtn) resetFillBtn(fillSingleBtn);
                return false;
            }

            const rawText = descEl.value.trim();
            const result = await analyze(rawText);

            if (result.desc && result.desc !== rawText) {
                setNativeValue(descEl, result.desc);
            }

            const activityEl = getActivityElement();
            if (activityEl) setNativeValue(activityEl, result.act);

            const skillEl = getSkillGroupElement();
            // Xử lý linh hoạt đề phòng result.skill có thể là string hoặc object
            const skillName = typeof result.skill === 'object' ? result.skill.name : result.skill;
            if (skillEl) await setComboBoxValue(skillEl, skillName);
            else clickOptionByText(skillName);

            const diffName = typeof result.difficulty === 'object' ? result.difficulty.name : result.difficulty;
            clickOptionByText(diffName);

            // --- BỔ SUNG LOGIC KIỂM TRA L3 TẠI ĐÂY ---
            const inputEl = document.getElementById('tb-l3-custom-input');
            const customVal = inputEl ? inputEl.value.trim() : '';
            if (customVal) {
                const sceneEl = getSceneElement();
                if (sceneEl) await setComboBoxValue(sceneEl, customVal);
            }
            // ----------------------------------------

            segmentClipboard = readCurrentSegmentData();
            storageSet(CLIPBOARD_KEY, segmentClipboard);

            // Báo thành công tạm thời trên nút
            if (fillSingleBtn) {
                fillSingleBtn.textContent = '✅ Done!';
                fillSingleBtn.style.backgroundColor = '#10b981'; // Màu xanh lá thành công
            }

            setTimeout(() => {
                if (fillSingleBtn) resetFillBtn(fillSingleBtn);
            }, 1200);

            return true;
        } catch (err) {
            console.error("Lỗi khi chạy AutoFill:", err);
            if (fillSingleBtn) {
                fillSingleBtn.textContent = '❌ Error';
                fillSingleBtn.style.backgroundColor = '#dc2626'; // Màu đỏ báo lỗi
                setTimeout(() => resetFillBtn(fillSingleBtn), 1500);
            }
            return false;
        } finally {
            setAllButtonsDisabled(false, currentBtnId);
        }
    }

    // Hàm phụ trợ đưa nút về trạng thái bình thường
    function resetFillBtn(btn) {
        btn.textContent = '⚡ Fill 1'; // Đổi lại tên nhãn nút ban đầu của bạn nếu khác
        btn.style.backgroundColor = '#2563eb'; // Màu xanh dương gốc của nút
        btn.disabled = false;
    }

    function runCopySegment() {
        segmentClipboard = readCurrentSegmentData();
        storageSet(CLIPBOARD_KEY, segmentClipboard);

        const btnCopy = document.getElementById('tb-inject-copy');
        if (btnCopy) {
            const originalText = btnCopy.innerHTML;
            btnCopy.innerHTML = '✅ Copied!';
            btnCopy.style.backgroundColor = '#059669';
            setTimeout(() => {
                btnCopy.innerHTML = originalText;
                btnCopy.style.backgroundColor = '#6366f1';
            }, 1000);
        }
        console.log('[TBRAIN] Đã copy thông tin segment:', segmentClipboard);
    }

    async function runPasteSegment() {
        if (!segmentClipboard) { alert('Chưa có dữ liệu nào được lưu.'); return; }
        const root = getCurrentSegmentRoot();
        const data = segmentClipboard;
        try {
            if (data.description) { const el = getDescriptionElement(root); if (el) setNativeValue(el, data.description); }
            if (data.activity) { const el = getActivityElement(root); if (el) setNativeValue(el, data.activity); }
            if (data.skillGroup) { const el = getSkillGroupElement(root); if (el) await setComboBoxValue(el, data.skillGroup); }
            if (data.difficulty) { clickOptionByText(data.difficulty, root); }
            if (data.l3) { const el = getSceneElement(root); if (el) await setComboBoxValue(el, data.l3); }
        } catch (err) { console.error('Lỗi khi paste:', err); }
    }

    // ==================== ADD-ON: PASTE ALL EPISODES ====================
    async function runPasteAllSegments() {
        if (!segmentClipboard) { alert('Chưa có dữ liệu nào được lưu.'); return; }

        const episodeButtons = Array.from(document.querySelectorAll('[data-testid^="episode-index-row-"]'));
        if (!episodeButtons.length) {
            alert('Không tìm thấy danh sách episode.');
            return;
        }

        const data = segmentClipboard;
        const btnPasteAll = document.getElementById('tb-inject-paste-all');
        const originalText = btnPasteAll ? btnPasteAll.innerHTML : '';
        let pastedCount = 0;

        try {
            if (btnPasteAll) {
                btnPasteAll.disabled = true;
                btnPasteAll.innerHTML = '⏳ Pasting...';
            }

            for (let idx = 0; idx < episodeButtons.length; idx++) {
                const btn = episodeButtons[idx];
                btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                btn.click();
                await sleep(CONFIG.delayBetweenEpisodes);

                const root = getCurrentSegmentRoot();
                if (data.description) {
                    const el = getDescriptionElement(root);
                    if (el) setNativeValue(el, data.description);
                }
                if (data.activity) {
                    const el = getActivityElement(root);
                    if (el) setNativeValue(el, data.activity);
                }
                if (data.skillGroup) {
                    const el = getSkillGroupElement(root);
                    if (el) await setComboBoxValue(el, data.skillGroup);
                }
                if (data.difficulty) clickOptionByText(data.difficulty);
                if (data.l3) {
                    const el = getSceneElement(root);
                    if (el) await setComboBoxValue(el, data.l3);
                }

                pastedCount++;
                await sleep(50);
            }

            console.log(`[TBRAIN] Paste All hoàn tất: ${pastedCount}/${episodeButtons.length} episode.`, data);
            if (btnPasteAll) btnPasteAll.innerHTML = `✅ ${pastedCount}/${episodeButtons.length}`;
        } catch (err) {
            console.error('Lỗi khi Paste All:', err);
            if (btnPasteAll) btnPasteAll.innerHTML = '❌ Error';
        } finally {
            if (btnPasteAll) {
                setTimeout(() => {
                    btnPasteAll.innerHTML = originalText;
                    btnPasteAll.disabled = false;
                }, 1200);
            }
        }
    }
    // ==================== END ADD-ON: PASTE ALL EPISODES ====================

    async function runFillSingleL3() {
        const currentBtnId = 'tb-inject-single-l3';
        setAllButtonsDisabled(true, currentBtnId);

        try {
            const inputEl = document.getElementById('tb-l3-custom-input');
            const customVal = inputEl ? inputEl.value.trim() : '';
            if (!customVal) { alert('Vui lòng nhập giá trị L3 vào ô text box trước!'); return; }
            const sceneEl = getSceneElement();
            console.log('sceneEl')
            console.log(sceneEl)
            console.log('customVal')
            console.log(customVal)
            if (sceneEl) await setComboBoxValue(sceneEl, customVal);
        } catch (err) {
            console.error("Lỗi khi chạy Fill L3:", err);
        } finally {
            setAllButtonsDisabled(false, currentBtnId);
        }
    }

    async function runLoopFillL3() {
        const currentBtnId = 'tb-inject-l3-loop';
        setAllButtonsDisabled(true, currentBtnId);

        try {
            if (isL3LoopRunning) { isL3LoopRunning = false; return; }
            const inputEl = document.getElementById('tb-l3-custom-input');
            const customVal = inputEl ? inputEl.value.trim() : '';
            if (!customVal) { alert('Vui lòng nhập giá trị L3 vào ô text box trước!'); return; }

            const episodeButtons = Array.from(document.querySelectorAll('[data-testid^="episode-index-row-"]'));
            if (!episodeButtons.length) { runFillSingleL3(); return; }

            isL3LoopRunning = true;
            document.querySelectorAll('.tb-inject-fill-l3-loop-btn').forEach(b => { b.textContent = '⏹ Stop Fill L3 All'; b.style.backgroundColor = '#dc2626'; });

            for (let idx = 0; idx < episodeButtons.length; idx++) {
                if (!isL3LoopRunning) break;
                const btn = episodeButtons[idx];
                btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                btn.click();
                await sleep(CONFIG.delayBetweenEpisodes);
                if (!isL3LoopRunning) break;
                const sceneEl = getSceneElement();
                if (sceneEl) await setComboBoxValue(sceneEl, customVal);
                await sleep(300);
            }
        } catch (err) {
            console.error("Lỗi khi chạy Fill L3 All:", err);
        } finally {
            isL3LoopRunning = false;
            document.querySelectorAll('.tb-inject-fill-l3-loop-btn').forEach(b => { b.textContent = '🔄 Fill L3 All'; b.style.backgroundColor = '#059669'; });
            setAllButtonsDisabled(false, currentBtnId);
        }
    }

    async function runLoopAllEpisodes() {
        const currentBtnId = 'tb-inject-loop';
        setAllButtonsDisabled(true, currentBtnId);

        try {
            if (isLoopRunning) { isLoopRunning = false; return; }

            const episodeButtons = Array.from(document.querySelectorAll('[data-testid^="episode-index-row-"]'));
            if (!episodeButtons.length) { alert('Không tìm thấy danh sách episode.'); return; }

            isLoopRunning = true;

            // --- 1. HIỆN TRẠNG THÁI LOADING TRÊN NÚT ---
            const loopButtons = document.querySelectorAll('.tb-inject-loop-btn');
            loopButtons.forEach(b => {
                b.textContent = '⏳ Collecting...';
                b.style.backgroundColor = '#d97706'; // Màu cam báo đang chạy
                b.disabled = true;
            });

            document.querySelectorAll('.tb-inject-loop-btn').forEach(b => {
                b.textContent = '⏹ Stop';
                b.style.backgroundColor = '#dc2626';
            });

            const descriptionsToProcess = [];
            const validButtons = [];

            // 1. Duyệt qua tất cả các episode để thu thập mô tả (description)
            for (let idx = 0; idx < episodeButtons.length; idx++) {
                if (!isLoopRunning) break;
                const btn = episodeButtons[idx];
                btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                btn.click();
                await sleep(CONFIG.delayBetweenEpisodes);

                const descEl = getDescriptionElement();
                const textVal = descEl ? descEl.value.trim() : "";

                if (textVal && textVal !== 'no description yet') {
                    descriptionsToProcess.push(textVal);
                    validButtons.push(btn);
                }
            }

            if (descriptionsToProcess.length === 0) {
                alert('Không tìm thấy mô tả nào hợp lệ để xử lý.');
                isLoopRunning = false;
                document.querySelectorAll('.tb-inject-loop-btn').forEach(b => {
                    b.textContent = '🔄 Fill All';
                    b.style.backgroundColor = '#4338ca';
                });
                return;
            }

            // --- 2. BÁO ĐANG GỬI LÊN GEMINI XỬ LÝ BATCH ---
            loopButtons.forEach(b => {
                b.textContent = `🤖 AI Analyzing (${descriptionsToProcess.length})...`;
            });

            console.log(`📦 Đã gom được ${descriptionsToProcess.length} mô tả. Đang gửi lên Gemini batch...`);

            // 2. Gửi toàn bộ mảng mô tả lên Gemini một lần duy nhất
            const batchResults = await translateBatchWithGemini(descriptionsToProcess);

            // --- 3. BÁO ĐANG ĐIỀN DỮ LIỆU VÀO FORM ---
            loopButtons.forEach(b => {
                b.textContent = '✍️ Filling Data...';
            });

            // 3. Duyệt lại từng episode để điền kết quả tương ứng đã nhận từ mảng trả về
            for (let i = 0; i < validButtons.length; i++) {
                if (!isLoopRunning) break;
                const btn = validButtons[i];
                const res = batchResults[i];

                if (!res) continue;

                btn.click();
                await sleep(CONFIG.delayBetweenEpisodes);

                const root = getCurrentSegmentRoot();

                // Điền Description
                const descEl = getDescriptionElement(root);
                if (descEl && res.desc) setNativeValue(descEl, res.desc);

                // Điền Activity
                const activityEl = getActivityElement(root);
                if (activityEl && res.act) setNativeValue(activityEl, res.act);

                // Điền Skill Group
                const skillEl = getSkillGroupElement(root);
                if (skillEl) await setComboBoxValue(skillEl, res.skill);
                else clickOptionByText(res.skill);

                // Điền Difficulty
                if (res.difficulty) clickOptionByText(res.difficulty, root);

                // Kiểm tra L3 Custom nếu có
                const inputEl = document.getElementById('tb-l3-custom-input');
                const customVal = inputEl ? inputEl.value.trim() : '';
                if (customVal) {
                    const sceneEl = getSceneElement(root);
                    if (sceneEl) await setComboBoxValue(sceneEl, customVal);
                }

                await sleep(50);
            }

            // --- 4. HOÀN TẤT, TRẢ LẠI TRẠNG THÁI NÚT BAN ĐẦU ---
            resetLoopButtons();
        } catch (err) {
            console.error("Lỗi khi chạy Fill All:", err);
        } finally {
            setAllButtonsDisabled(false, currentBtnId);
        }
        console.log('✅ Đã hoàn tất Fill All theo dạng Batch Array!');
    }

    // Hàm phụ trợ reset nút về trạng thái ban đầu
    function resetLoopButtons() {
        isLoopRunning = false;
        document.querySelectorAll('.tb-inject-loop-btn').forEach(b => {
            b.textContent = '🔄 Fill All';
            b.style.backgroundColor = '#4338ca'; // Màu gốc
            b.disabled = false;
        });
    }

    /* ---------------------------------------------------------------------
     * AUTO-FETCH LOGIC & NETWORK INTERCEPTION
     * --------------------------------------------------------------------- */
    const log = {
        info: (...a) => console.log("[INFO]", ...a),
        warn: (...a) => console.warn("[WARN]", ...a),
        error: (...a) => console.error("[ERROR]", ...a)
    };

    const now = () => performance.now();
    function perf(label, start) { if (PERF_LOG) log.info(`[PERF] ${label}: ${(now() - start).toFixed(1)} ms`); }

    const rateLimitState = { limit: null, remaining: null, resetAt: 0, pauseUntil: 0, lastStatus: null };

    function readRateLimitHeaders(response) {
        const headers = response.headers;
        const limitRaw = headers.get("x-ratelimit-limit");
        const remainingRaw = headers.get("x-ratelimit-remaining");
        const resetRaw = headers.get("x-ratelimit-reset");

        const limit = limitRaw === null ? NaN : Number(limitRaw);
        const remaining = remainingRaw === null ? NaN : Number(remainingRaw);

        if (Number.isFinite(limit) && limit >= 0) rateLimitState.limit = limit;
        if (Number.isFinite(remaining) && remaining >= 0) rateLimitState.remaining = remaining;

        if (resetRaw !== null) {
            const reset = Number(resetRaw);
            if (Number.isFinite(reset) && reset >= 0) {
                rateLimitState.resetAt = reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000;
            }
        }
        rateLimitState.lastStatus = response.status;
        if (response.status === 429) {
            rateLimitState.pauseUntil = Math.max(rateLimitState.pauseUntil, Date.now() + RATE_LIMIT_FALLBACK_WAIT + RATE_LIMIT_SAFETY_MS);
        }
    }

    async function waitForRateLimit() {
        while (!stopped) {
            const waitMs = rateLimitState.pauseUntil - Date.now();
            if (waitMs <= 0) return;
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        throw new Error("Task monitor stopped");
    }

    function getAdaptivePollInterval() {
        return Math.max(POLL_INTERVAL, MIN_SAFE_POLL_INTERVAL);
    }

    const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
    const interceptedTokens = new Map();
    const rejectedTokens = new Set();
    let cachedTokenCandidate = null;
    let lastTokenValue = null;

    function decodePayload(token) {
        try {
            let p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            p += "=".repeat((4 - p.length % 4) % 4);
            const binary = atob(p);
            const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (_) { return null; }
    }

    function scoreSource(source) {
        let score = 0;
        if (/access|auth|jwt|bearer|token|session/i.test(source)) score += 2;
        if (/refresh/i.test(source)) score -= 5;
        return score;
    }

    function scanString(raw, source, found) {
        if (typeof raw !== "string" || raw.length < 20) return;
        JWT_RE.lastIndex = 0;
        let match;
        while ((match = JWT_RE.exec(raw)) !== null) {
            const token = match[0];
            if (rejectedTokens.has(token)) continue;
            const payload = decodePayload(token);
            if (!payload) continue;
            const candidate = { token, source, payload, score: scoreSource(source) };
            const existing = found.get(token);
            if (!existing || candidate.score > existing.score) found.set(token, candidate);
        }
    }

    function scanStorage(storage, label, found) {
        try {
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key !== null) scanString(storage.getItem(key), `${label}:${key}`, found);
            }
        } catch (_) { }
    }

    function scanCookies(found) {
        try {
            for (const pair of document.cookie.split(";")) {
                const index = pair.indexOf("=");
                if (index >= 0) scanString(pair.slice(index + 1).trim(), `cookie:${pair.slice(0, index).trim()}`, found);
            }
        } catch (_) { }
    }

    function findToken(forceScan = false) {
        const timestamp = Date.now();
        if (!forceScan && cachedTokenCandidate) {
            const cached = cachedTokenCandidate;
            const expiry = Number(cached.payload.exp);
            if (!rejectedTokens.has(cached.token) && (!expiry || expiry * 1000 > timestamp + 5000)) return cached;
            cachedTokenCandidate = null;
        }

        const found = new Map();
        for (const token of interceptedTokens.keys()) {
            if (!rejectedTokens.has(token)) {
                const payload = decodePayload(token);
                if (payload) found.set(token, { token, source: "intercepted request", payload, score: 10 });
            }
        }

        if (forceScan || found.size === 0) {
            scanStorage(window.localStorage, "localStorage", found);
            scanStorage(window.sessionStorage, "sessionStorage", found);
            scanCookies(found);
        }

        let best = null;
        for (const candidate of found.values()) {
            if (!rejectedTokens.has(candidate.token)) {
                const expiry = Number(candidate.payload.exp);
                if (!expiry || expiry * 1000 > timestamp + 5000) {
                    if (!best || candidate.score > best.score) best = candidate;
                }
            }
        }
        cachedTokenCandidate = best;
        return best;
    }

    const origFetch = window.fetch;
    const xhrProto = XMLHttpRequest.prototype;
    const origOpen = xhrProto.open;
    const origSetHeader = xhrProto.setRequestHeader;

    function captureAuth(value, url) {
        try {
            if (typeof value !== "string" || !url) return;
            const parsed = new URL(String(url), location.href);
            if (parsed.hostname.endsWith("tbrain.ai")) {
                JWT_RE.lastIndex = 0;
                let match;
                while ((match = JWT_RE.exec(value)) !== null) interceptedTokens.set(match[0], Date.now());
            }
        } catch (_) { }
    }

    function readHeaders(headers) {
        if (!headers) return null;
        try {
            if (headers instanceof Headers) return headers.get("authorization");
            if (Array.isArray(headers)) {
                for (const pair of headers) if (String(pair[0]).toLowerCase() === "authorization") return String(pair[1]);
            } else if (typeof headers === "object") {
                for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") return String(headers[key]);
            }
        } catch (_) { }
        return null;
    }

    window.fetch = function (input, init) {
        try {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
            const auth = readHeaders(init && init.headers) || readHeaders(input && input.headers);
            if (auth) captureAuth(auth, url);
        } catch (_) { }
        return origFetch.apply(this, arguments);
    };

    xhrProto.open = function (method, url) { this.tbMonitorUrl = String(url); return origOpen.apply(this, arguments); };
    xhrProto.setRequestHeader = function (name, value) {
        if (String(name).toLowerCase() === "authorization") captureAuth(value, this.tbMonitorUrl);
        return origSetHeader.apply(this, arguments);
    };

    let audioCtx = null;
    let deniedLogged = false;

    async function ensurePermission() {
        if (!("Notification" in window)) return false;
        if (Notification.permission === "granted") return true;
        if (Notification.permission === "denied") {
            if (!deniedLogged) {
                log.warn("Notification permission denied.");
                deniedLogged = true;
            }
            return false;
        }
        try {
            return await Notification.requestPermission() === "granted";
        } catch (_) {
            return false;
        }
    }

    function unlockAudio() {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC && !audioCtx) audioCtx = new AC();
            if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
        } catch (_) { }
    }

    function beep() {
        try {
            if (!audioCtx) unlockAudio();
            if (!audioCtx || audioCtx.state !== "running") return;
            const start = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.frequency.value = 880;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(start);
            osc.stop(start + 0.15);
        } catch (_) { }
    }

    async function showAcquireNotification(acquiredTasks) {
        if (!acquiredTasks || acquiredTasks.length === 0) return;
        beep();

        if (!(await ensurePermission())) {
            log.info("[NOTIFICATION PERMISSION DENIED]", acquiredTasks);
            return;
        }

        try {
            for (const item of acquiredTasks) {
                const hours = Number.isFinite(item.durationSeconds)
                    ? (item.durationSeconds / 3600).toFixed(2)
                    : "Unknown";

                const title = "🚀 Đã nhận Task mới thành công!";
                const body = `ID: ${item.id}\nThời lượng: ${hours} giờ`;

                const notification = new Notification(title, {
                    body: body,
                    tag: `tbrain-acquired-${item.id}`,
                    renotify: true
                });

                notification.onclick = event => {
                    event.preventDefault();
                    window.open(CLICK_URL, "_blank");
                    try { window.focus(); } catch (_) { }
                    notification.close();
                };
            }
        } catch (error) {
            log.error("Notification failed:", error.message);
        }
    }

    function getTaskId(task) {
        if (!task) return null;
        const id = task.id !== undefined ? task.id : task.taskId !== undefined ? task.taskId : task._id;
        return id != null ? String(id) : null;
    }

    async function fetchPool(token) {
        await waitForRateLimit();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            const response = await origFetch.call(window, API_URL, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
                credentials: "include",
                cache: "no-store",
                signal: controller.signal
            });
            readRateLimitHeaders(response);
            return response;
        } finally { clearTimeout(timeout); }
    }

    async function acquireTask(token, taskObj) {
        await waitForRateLimit();
        const id = getTaskId(taskObj);
        try {
            const response = await origFetch.call(window, `${API_BASE}/api/v1/tasks/${encodeURIComponent(id)}/acquire`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "*/*" },
                credentials: "include",
                body: "{}"
            });
            readRateLimitHeaders(response);
            return { taskObj, id, ok: response.ok, status: response.status };
        } catch (error) {
            return { taskObj, id, ok: false, status: 0 };
        }
    }

    async function acquireNew(token, taskList) {
        let successfullyAcquired = [];
        for (const taskObj of taskList) {
            const res = await acquireTask(token, taskObj);
            if (res.ok) {
                successfullyAcquired.push({
                    id: res.id,
                    durationSeconds: taskObj.durationSeconds
                });
            }
        }

        if (successfullyAcquired.length > 0) {
            await showAcquireNotification(successfullyAcquired);
        }

        return { success: successfullyAcquired.length, total: taskList.length };
    }

    function extractTasks(body) {
        if (Array.isArray(body)) return body;
        if (!body || typeof body !== "object") return null;
        for (const key of ["tasks", "items", "results", "data", "records", "rows", "content"]) {
            if (Array.isArray(body[key])) return body[key];
        }
        return null;
    }

    const seenIds = new Set();
    let firstPoll = true;
    let timer = null;
    let stopped = false;
    let cycleRunning = false;

    async function runCycle() {
        let candidate = findToken() || findToken(true);
        if (!candidate) return TOKEN_RETRY_INTERVAL;

        let response;
        try {
            response = await fetchPool(candidate.token);
        } catch (_) {
            return getAdaptivePollInterval();
        }

        if (response.status === 401 || response.status === 403) {
            rejectedTokens.add(candidate.token);
            cachedTokenCandidate = null;
            return TOKEN_RETRY_INTERVAL;
        }

        if (!response.ok) return getAdaptivePollInterval();

        let body;
        try { body = await response.json(); } catch (_) { return getAdaptivePollInterval(); }

        const tasks = extractTasks(body);
        if (!tasks) return getAdaptivePollInterval();
        if (stopped || !isFetchTaskEnabled()) return getAdaptivePollInterval();

        const eligibleTasks = [];
        for (const task of tasks) {
            const id = getTaskId(task);
            if (id === null || seenIds.has(id)) continue;
            seenIds.add(id);

            const taskL1 = typeof task.envL1 === "string" ? task.envL1.trim() : "";
            if (EXCLUDED_TASK_L1.has(taskL1)) continue;

            const duration = Number(task && task.durationSeconds);
            if (Number.isFinite(duration) && duration > MIN_DURATION_SECONDS) {
                eligibleTasks.push(task);
            }
        }

        if (eligibleTasks.length > 0) {
            if (AUTO_ACQUIRE) {
                await acquireNew(candidate.token, eligibleTasks);
            }
        }

        return getAdaptivePollInterval();
    }

    function isFetchTaskEnabled() {
        try {
            const savedState = localStorage.getItem('tb_fetch_active_state');
            return savedState === null ? true : JSON.parse(savedState) === true;
        } catch (_) {
            return false;
        }
    }

    async function tick() {
        if (!isFetchTaskEnabled() || stopped || cycleRunning) return;
        cycleRunning = true;
        try {
            const delay = await runCycle();
            if (!stopped) timer = setTimeout(tick, delay);
        } catch (_) {
            if (!stopped) timer = setTimeout(tick, getAdaptivePollInterval());
        } finally {
            cycleRunning = false;
        }
    }

    function stop() {
        stopped = true;
        clearTimeout(timer);
    }

    tick();
    if (isFetchTaskEnabled()) void ensurePermission();

    // ==================== QUẢN LÝ GEMINI API KEY BẰNG LOCALSTORAGE ====================
    function getStoredApiKey() {
        // Ưu tiên lấy key người dùng đã nhập trong UI, nếu không có thì lấy biến cứng mặc định
        const saved = localStorage.getItem(TOKEN_STORAGE_KEY);
        return saved ? JSON.parse(saved) : (typeof GEMINI_API_KEY !== 'undefined' ? GEMINI_API_KEY : "");
    }

    function saveStoredApiKey(key) {
        localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(key.trim()));
    }

    // ==================== EARNINGS CALCULATION (FROM SCRIPT C) ====================
    async function updateMyEarnings() {
        const candidate = findToken() || findToken(true);
        if (!candidate) return;

        const earningsEl = document.getElementById('tb-earnings-display');
        if (!earningsEl) return;

        try {
            const [statsRes, extraRes] = await Promise.all([
                origFetch.call(window, STATS_API_URL, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${candidate.token}`, Accept: "*/*" },
                    credentials: "include"
                }),
                origFetch.call(window, EXTRA_HOURS_API_URL, {
                    method: "GET",
                    headers: { Authorization: `Bearer ${candidate.token}`, Accept: "*/*" },
                    credentials: "include"
                })
            ]);

            let totalSeconds = 0;
            if (statsRes.ok) {
                const statsData = await statsRes.json();
                totalSeconds += Number(statsData.labelledSeconds) || 0;
            }

            if (extraRes.ok) {
                const extraData = await extraRes.json();
                if (Array.isArray(extraData)) {
                    extraData.forEach(item => {
                        totalSeconds += Number(item.seconds) || 0;
                    });
                }
            }

            const hours = totalSeconds / 3600;
            const totalMoney = hours * 50000;
            earningsEl.textContent = `💰 ${Math.round(totalMoney).toLocaleString('vi-VN')} đ`;
            earningsEl.title = `Tổng thời gian (Đã gồm bonus): ${hours.toFixed(2)}h (${totalSeconds.toFixed(0)} giây)`;
        } catch (err) {
            console.error("Lỗi cập nhật thu nhập và giờ bonus:", err);
        }
    }

    function calculateEarningsFromTimeline() {
        const timelineEl = document.querySelector('[data-testid="timeline-hours"]');
        if (!timelineEl) return 0;

        const text = timelineEl.textContent || '';
        const recordedPart = text.split('/')[0].trim();
        let totalMinutes = 0;

        const hourMatch = recordedPart.match(/(\d+)\s*h/);
        const minMatch = recordedPart.match(/(\d+)\s*min/);

        if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60;
        if (minMatch) totalMinutes += parseInt(minMatch[1], 10);

        if (!hourMatch && !minMatch) {
            const titleText = timelineEl.getAttribute('title') || '';
            const timeMatch = titleText.match(/(\d+):(\d+):(\d+)/);
            if (timeMatch) {
                const h = parseInt(timeMatch[1], 10);
                const m = parseInt(timeMatch[2], 10);
                const sec = parseInt(timeMatch[3], 10);
                totalMinutes = h * 60 + m + sec / 60;
            }
        }

        return Math.round((totalMinutes / 60) * 50000);
    }

    function injectTimelineEarningsDisplay() {
        const timelineEl = document.querySelector('[data-testid="timeline-hours"]');
        if (timelineEl && !document.getElementById('tb-timeline-earnings')) {
            const earningsBadge = document.createElement('span');
            earningsBadge.id = 'tb-timeline-earnings';
            earningsBadge.className = 'ml-2 px-2 py-0.5 text-xs font-bold text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 rounded';
            earningsBadge.textContent = '💰 0 đ';
            timelineEl.insertAdjacentElement('afterend', earningsBadge);
        }

        const earningsBadge = document.getElementById('tb-timeline-earnings');
        if (earningsBadge) {
            const money = calculateEarningsFromTimeline();
            earningsBadge.textContent = `💰 ${money.toLocaleString('vi-VN')} đ`;
        }
    }

    setInterval(injectTimelineEarningsDisplay, 1000);
    // ==================== END EARNINGS CALCULATION ====================

    /* ---------------------------------------------------------------------
     * UI INJECTION - CHUYỂN TẤT CẢ CỤM ĐIỀU KHIỂN VỀ BÊN PHẢI HEADER
     * --------------------------------------------------------------------- */
    function injectUIControls() {
        if (!document.getElementById('tb-master-ui-style')) {
            const style = document.createElement('style');
            style.id = 'tb-master-ui-style';
            style.textContent = `
                #tb-helper-toolbar {
                    display: flex; align-items: center; gap: 7px; margin-right: 10px; flex-shrink: 0;
                    padding: 6px 8px; border: 1px solid rgba(148,163,184,.28); border-radius: 12px;
                    background: linear-gradient(135deg, rgba(30,41,59,.78), rgba(15,23,42,.62));
                    box-shadow: 0 5px 18px rgba(2,6,23,.22), inset 0 1px 0 rgba(255,255,255,.06);
                    backdrop-filter: blur(10px);
                }
                #tb-helper-toolbar .tb-action-btn {
                    height: 31px !important; padding: 0 11px !important; border-radius: 8px !important;
                    border: 1px solid rgba(255,255,255,.17) !important; color: #fff !important;
                    font-size: 11px !important; font-weight: 750 !important; letter-spacing: .15px;
                    white-space: nowrap; box-shadow: 0 2px 7px rgba(2,6,23,.22);
                    transition: transform .15s ease, filter .15s ease, box-shadow .15s ease;
                }
                #tb-helper-toolbar .tb-action-btn:hover {
                    filter: brightness(1.13); transform: translateY(-1px);
                    box-shadow: 0 5px 12px rgba(2,6,23,.28);
                }
                #tb-helper-toolbar .tb-action-btn:active { transform: translateY(0) scale(.97); }
                #tb-inject-copy { background: linear-gradient(135deg,#6366f1,#7c3aed) !important; border-color: rgba(167,139,250,.65) !important; }
                #tb-inject-paste { background: linear-gradient(135deg,#0284c7,#2563eb) !important; border-color: rgba(125,211,252,.65) !important; }
                #tb-inject-paste-all { background: linear-gradient(135deg,#059669,#0f766e) !important; border-color: rgba(110,231,183,.65) !important; }
                #tb-fetch-control-wrapper {
                    display: flex; align-items: center; gap: 8px; margin-right: 10px; padding: 6px 8px;
                    border: 1px solid rgba(148,163,184,.3); border-radius: 12px;
                    background: linear-gradient(135deg,rgba(30,41,59,.82),rgba(15,23,42,.68));
                    box-shadow: 0 5px 18px rgba(2,6,23,.22), inset 0 1px 0 rgba(255,255,255,.06);
                    backdrop-filter: blur(10px);
                }
                #tb-fetch-control-wrapper .tb-fetch-toggle {
                    height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid rgba(255,255,255,.2);
                    color: #fff; font-size: 11px; font-weight: 800; letter-spacing: .2px; white-space: nowrap;
                    box-shadow: 0 3px 9px rgba(2,6,23,.25); transition: transform .15s ease, filter .15s ease;
                }
                #tb-fetch-control-wrapper .tb-fetch-toggle:hover { filter: brightness(1.12); transform: translateY(-1px); }
                #tb-fetch-control-wrapper .tb-fetch-toggle[data-active="true"] {
                    background: linear-gradient(135deg,#16a34a,#0f766e); border-color: rgba(110,231,183,.7);
                }
                #tb-fetch-control-wrapper .tb-fetch-toggle[data-active="false"] {
                    background: linear-gradient(135deg,#ef4444,#b91c1c); border-color: rgba(252,165,165,.7);
                }
                #tb-earnings-card {
                    display: flex; flex-direction: column; justify-content: center; gap: 1px; min-width: 126px;
                    padding: 4px 10px; border: 1px solid rgba(52,211,153,.42); border-radius: 9px;
                    background: linear-gradient(135deg,rgba(6,78,59,.72),rgba(6,95,70,.38));
                    box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 3px 9px rgba(2,6,23,.18);
                }
                #tb-earnings-label { color: #a7f3d0; font-size: 8px; line-height: 1.1; font-weight: 800; letter-spacing: .9px; }
                #tb-earnings-display { color: #ecfdf5; font-size: 13px; line-height: 1.25; font-weight: 900; white-space: nowrap; text-shadow: 0 1px 8px rgba(16,185,129,.25); }
                #tb-fetch-control-wrapper .tb-fetch-setting {
                    width: 62px; height: 29px; padding: 0 4px; border: 1px solid rgba(148,163,184,.35);
                    border-radius: 7px; background: rgba(15,23,42,.75); color: #e2e8f0; text-align: center;
                    font-size: 11px; font-weight: 700; outline: none;
                }
                #tb-fetch-control-wrapper .tb-fetch-setting:focus { border-color: #60a5fa; box-shadow: 0 0 0 2px rgba(96,165,250,.2); }
                #tb-fetch-control-wrapper button:not(.tb-fetch-toggle) {
                    height: 30px; padding: 0 10px; border: 1px solid rgba(255,255,255,.16);
                    border-radius: 8px; color: #fff; font-size: 11px; font-weight: 700;
                    box-shadow: 0 2px 7px rgba(2,6,23,.2); transition: filter .15s ease, transform .15s ease;
                }
                #tb-fetch-control-wrapper button:not(.tb-fetch-toggle):hover { filter: brightness(1.12); transform: translateY(-1px); }
            `;
            document.head.appendChild(style);
        }

        // Tìm div chứa class 'ml-auto' nằm ở góc phải của header
        const headerRightContainer = document.querySelector('header div.ml-auto');

        if (headerRightContainer && !document.getElementById('tb-inject-fill')) {
            // Style chuẩn chiều cao 28px (h-7) đồng bộ với giao diện header
            const btnBaseClass = "inline-flex h-7 items-center justify-center rounded-md px-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 shrink-0";

            // Tạo một Wrapper chứa toàn bộ thanh công cụ tự động
            const helperToolbar = document.createElement('div');
            helperToolbar.id = 'tb-helper-toolbar';
            helperToolbar.className = 'flex items-center gap-1.5 mr-2';

            // 1. Ô nhập L3 Custom
            const l3Input = document.createElement('input');
            l3Input.id = 'tb-l3-custom-input';
            l3Input.type = 'text';
            l3Input.placeholder = 'Enter L3...';
            l3Input.style.cssText = 'height: 28px; width: 120px; background-color: #ffffff !important; color: #000000 !important; border: 1px solid #cbd5e1 !important; border-radius: 6px; padding: 0 8px; font-size: 12px;';

            // 2. Nút Fill 1
            const btnFill = document.createElement('button');
            btnFill.id = 'tb-inject-fill';
            btnFill.type = 'button';
            btnFill.className = btnBaseClass;
            btnFill.style.cssText = 'background-color: #4f46e5;';
            btnFill.innerHTML = '⚡ Fill 1';
            btnFill.addEventListener('click', runAutoFill);

            // 3. Nút Fill All
            const btnLoop = document.createElement('button');
            btnLoop.id = 'tb-inject-loop';
            btnLoop.type = 'button';
            btnLoop.className = `tb-inject-loop-btn ${btnBaseClass}`;
            btnLoop.style.cssText = 'background-color: #4338ca;';
            btnLoop.innerHTML = '🔄 Fill All';
            btnLoop.addEventListener('click', runLoopAllEpisodes);

            // 4. Nút Fill L3 Only
            const btnFillSingleL3 = document.createElement('button');
            btnFillSingleL3.id = 'tb-inject-single-l3';
            btnFillSingleL3.type = 'button';
            btnFillSingleL3.className = btnBaseClass;
            btnFillSingleL3.style.cssText = 'background-color: #10b981;';
            btnFillSingleL3.innerHTML = '🎯 Fill L3';
            btnFillSingleL3.addEventListener('click', runFillSingleL3);

            // 5. Nút Fill L3 All
            const btnFillL3Loop = document.createElement('button');
            btnFillL3Loop.id = 'tb-inject-l3-loop';
            btnFillL3Loop.type = 'button';
            btnFillL3Loop.className = `tb-inject-fill-l3-loop-btn ${btnBaseClass}`;
            btnFillL3Loop.style.cssText = 'background-color: #059669;';
            btnFillL3Loop.innerHTML = '🔄 Fill L3 All';
            btnFillL3Loop.addEventListener('click', runLoopFillL3);

            // 6. Nút Copy
            const btnCopy = document.createElement('button');
            btnCopy.id = 'tb-inject-copy';
            btnCopy.type = 'button';
            btnCopy.className = `${btnBaseClass} tb-action-btn`;
            btnCopy.innerHTML = '📋 Copy';
            btnCopy.addEventListener('click', runCopySegment);

            // 7. Nút Paste
            const btnPaste = document.createElement('button');
            btnPaste.id = 'tb-inject-paste';
            btnPaste.type = 'button';
            btnPaste.className = `${btnBaseClass} tb-action-btn`;
            btnPaste.innerHTML = '📥 Paste';
            btnPaste.addEventListener('click', runPasteSegment);

            // 8. Nút Paste All: paste dữ liệu đã Copy vào toàn bộ episode
            const btnPasteAll = document.createElement('button');
            btnPasteAll.id = 'tb-inject-paste-all';
            btnPasteAll.type = 'button';
            btnPasteAll.className = `${btnBaseClass} tb-action-btn`;
            btnPasteAll.innerHTML = '📥 Paste All';
            btnPasteAll.addEventListener('click', runPasteAllSegments);

            helperToolbar.appendChild(l3Input);
            helperToolbar.appendChild(btnFillSingleL3);
            helperToolbar.appendChild(btnFillL3Loop);
            helperToolbar.appendChild(btnFill);
            helperToolbar.appendChild(btnLoop);
            helperToolbar.appendChild(btnPaste);
            helperToolbar.appendChild(btnPasteAll);
            helperToolbar.appendChild(btnCopy);

            headerRightContainer.insertBefore(helperToolbar, headerRightContainer.firstChild);
        }

        // Auto-Fetch Control Wrapper (nếu có nút theme toggle ở bên phải)
        const themeToggleBtn = document.querySelector('[data-testid="theme-toggle"]');
        if (themeToggleBtn && !document.getElementById("tb-fetch-control-wrapper")) {
            // 1. Khai báo các Key localStorage để lưu trạng thái
            const STORAGE_KEYS = {
                active: 'tb_fetch_active_state',
                poll: 'tb_poll_interval_val',
                duration: 'tb_min_duration_val',
                token: 'tb_gemini_api_key_custom'
            };

            // Đọc lại trạng thái đã lưu trước đó (nếu có), không dùng cứng default
            let isActive = isFetchTaskEnabled();
            let currentPoll = localStorage.getItem(STORAGE_KEYS.poll) !== null ? parseInt(localStorage.getItem(STORAGE_KEYS.poll), 10) : POLL_INTERVAL;
            let currentDuration = localStorage.getItem(STORAGE_KEYS.duration) !== null ? parseInt(localStorage.getItem(STORAGE_KEYS.duration), 10) : MIN_DURATION_SECONDS;

            POLL_INTERVAL = currentPoll;
            MIN_DURATION_SECONDS = currentDuration;

            const wrapper = document.createElement("div");
            wrapper.id = "tb-fetch-control-wrapper";
            wrapper.className = "flex items-center gap-2 mr-2 bg-tag-gray-bg/40 px-2 py-1 rounded-md border border-tb-border shrink-0 relative";

            // Hiển thị thu nhập tổng (bao gồm bonus) từ API thống kê.
            const earningsCard = document.createElement("div");
            earningsCard.id = "tb-earnings-card";
            const earningsLabel = document.createElement("span");
            earningsLabel.id = "tb-earnings-label";
            earningsLabel.textContent = "TOTAL EARNINGS";
            const earningsDisplay = document.createElement("span");
            earningsDisplay.id = "tb-earnings-display";
            earningsDisplay.textContent = "💰 0 đ";
            earningsCard.appendChild(earningsLabel);
            earningsCard.appendChild(earningsDisplay);

            const toggleBtn = document.createElement("button");
            toggleBtn.type = "button";
            toggleBtn.className = "tb-fetch-toggle";

            function updateToggleButton() {
                toggleBtn.textContent = isActive ? "● FETCH TASK: ON" : "● FETCH TASK: OFF";
                toggleBtn.dataset.active = String(isActive);
            }
            updateToggleButton();

            toggleBtn.onclick = () => {
                isActive = !isActive;
                localStorage.setItem(STORAGE_KEYS.active, JSON.stringify(isActive));
                if (isActive) { stopped = false; updateToggleButton(); void ensurePermission(); tick(); }
                else { stop(); updateToggleButton(); }
            };

            const pollInput = document.createElement("input");
            pollInput.type = "number";
            pollInput.value = currentPoll; // Dùng giá trị đã lưu
            pollInput.className = "tb-fetch-setting";
            pollInput.onchange = e => {
                const val = parseInt(e.target.value, 10);
                if (val >= 500) {
                    POLL_INTERVAL = val;
                    localStorage.setItem(STORAGE_KEYS.poll, val);
                }
            };

            const durationInput = document.createElement("input");
            durationInput.type = "number";
            durationInput.value = currentDuration; // Dùng giá trị đã lưu
            durationInput.className = "tb-fetch-setting";
            durationInput.onchange = e => {
                const val = parseInt(e.target.value, 10);
                if (val >= 0) {
                    MIN_DURATION_SECONDS = val;
                    localStorage.setItem(STORAGE_KEYS.duration, val);
                }
            };

            // ==================== TÍCH HỢP NÚT & MODAL API KEY ====================
            window.getStoredApiKey = function () {
                const saved = localStorage.getItem(STORAGE_KEYS.token);
                return saved ? JSON.parse(saved) : (typeof GEMINI_API_KEY !== 'undefined' ? GEMINI_API_KEY : "");
            };

            const btnKey = document.createElement("button");
            btnKey.type = "button";
            btnKey.className = "px-2 py-1 text-xs font-semibold rounded text-white hover:opacity-90";
            btnKey.style.backgroundColor = "#64748b";
            btnKey.textContent = "🔑 Key";

            // Tạo Popup Modal nhập Key
            const tokenModal = document.createElement("div");
            tokenModal.style.cssText = "display: none; position: absolute; top: 40px; right: 0; background: #1e293b; border: 1px solid #475569; padding: 12px; border-radius: 8px; z-index: 9999; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); width: 260px;";

            tokenModal.innerHTML = `
                <div style="font-size: 11px; color: #f8fafc; margin-bottom: 6px; font-weight: 600;">Nhập Gemini API Key:</div>
                <input type="password" id="tb-token-input" value="${window.getStoredApiKey()}" placeholder="Dán API Key vào đây..." style="width: 100%; height: 26px; background: #0f172a; color: #fff; border: 1px solid #64748b; border-radius: 4px; padding: 0 6px; font-size: 11px; margin-bottom: 8px; box-sizing: border-box;" />
                <div style="display: flex; justify-content: flex-end; gap: 6px;">
                    <button type="button" id="tb-token-save" style="background: #10b981; color: white; border: none; padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;">Lưu</button>
                    <button type="button" id="tb-token-close" style="background: #475569; color: white; border: none; padding: 3px 8px; border-radius: 4px; font-size: 11px; cursor: pointer;">Đóng</button>
                </div>
            `;

            btnKey.onclick = (e) => {
                e.stopPropagation();
                const isVisible = tokenModal.style.display === "block";
                tokenModal.style.display = isVisible ? "none" : "block";
                if (!isVisible) {
                    tokenModal.querySelector("#tb-token-input").value = window.getStoredApiKey();
                }
            };

            setTimeout(() => {
                const saveBtn = tokenModal.querySelector('#tb-token-save');
                const closeBtn = tokenModal.querySelector('#tb-token-close');
                const inputEl = tokenModal.querySelector('#tb-token-input');

                if (saveBtn) {
                    saveBtn.onclick = () => {
                        const newKey = inputEl.value.trim();
                        localStorage.setItem(STORAGE_KEYS.token, JSON.stringify(newKey));
                        tokenModal.style.display = 'none';
                    };
                }
                if (closeBtn) {
                    closeBtn.onclick = () => {
                        tokenModal.style.display = 'none';
                    };
                }
            }, 100);
            // =====================================================================

            wrapper.appendChild(earningsCard);
            wrapper.appendChild(toggleBtn);
            wrapper.appendChild(pollInput);
            wrapper.appendChild(durationInput);
            wrapper.appendChild(btnKey);
            wrapper.appendChild(tokenModal);

            themeToggleBtn.insertAdjacentElement("beforebegin", wrapper);

            // Cập nhật thu nhập ngay khi tạo giao diện và sau đó mỗi 30 giây.
            updateMyEarnings();
            setInterval(updateMyEarnings, 30000);
        }

        // Giữ toàn bộ thanh công cụ Fill/Copy/Paste ngay bên trái cụm Earnings + Fetch Task.
        // Chạy lại mỗi lần injectUIControls kiểm tra DOM để hỗ trợ trường hợp header render chậm.
        const helperToolbarEl = document.getElementById('tb-helper-toolbar');
        const fetchControlWrapperEl = document.getElementById('tb-fetch-control-wrapper');
        if (helperToolbarEl && fetchControlWrapperEl && fetchControlWrapperEl.parentElement) {
            const targetParent = fetchControlWrapperEl.parentElement;
            if (helperToolbarEl.parentElement !== targetParent || helperToolbarEl.nextElementSibling !== fetchControlWrapperEl) {
                targetParent.insertBefore(helperToolbarEl, fetchControlWrapperEl);
            }
        }
    }

    document.addEventListener('keydown', function (e) {
        // Chỉ kích hoạt khi không gõ trong ô input/textarea khác (ngoại trừ ô nhập L3 tùy chỉnh)
        const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
        const activeId = document.activeElement ? document.activeElement.id : '';

        if (activeTag === 'textarea' || (activeTag === 'input' && activeId !== 'tb-l3-custom-input')) {
            return;
        }

        if (e.key === '!') {
            e.preventDefault();
            const btn = document.getElementById('tb-inject-fill');
            if (btn) btn.click();
        } else if (e.key === '@') {
            e.preventDefault();
            const btn = document.getElementById('tb-inject-loop'); // Nút "Fill All" (Loop All)
            if (btn) btn.click();
        } else if (e.key === '#') {
            e.preventDefault();
            const btn = document.getElementById('tb-inject-l3-loop'); // Nút "Fill L3 All"
            if (btn) btn.click();
        } else if (e.key === '$') {
            e.preventDefault();
            const btn = document.getElementById('tb-inject-paste'); // Nút "Paste"
            if (btn) btn.click();
        }
    });

    setInterval(injectUIControls, 500);
    console.log('✅ Master Tbrain Script (No Tool in Activity) is ready.');
})();
