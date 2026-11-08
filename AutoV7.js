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
                                alert('🚨 Đã HẾT TOKEN hoặc vượt quá quota của Gemini API Key! Vui lòng đổi Key khác tại nút 🔑.');
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
                                alert('🚨 Đã HẾT TOKEN hoặc vượt quá quota của Gemini API Key! Vui lòng đổi Key khác tại nút 🔑.');
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
            document.querySelectorAll('.tb-inject-fill-l3-loop-btn').forEach(b => { b.textContent = '⏹ Stop'; b.style.backgroundColor = '#dc2626'; });

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
            document.querySelectorAll('.tb-inject-fill-l3-loop-btn').forEach(b => { b.textContent = 'L3 All'; b.style.backgroundColor = '#059669'; });
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
                b.textContent = '⏳ Collect';
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
                    b.textContent = 'Fill All';
                    b.style.backgroundColor = '#4338ca';
                });
                return;
            }

            // --- 2. BÁO ĐANG GỬI LÊN GEMINI XỬ LÝ BATCH ---
            loopButtons.forEach(b => {
                b.textContent = `🤖 AI (${descriptionsToProcess.length})`;
            });

            console.log(`📦 Đã gom được ${descriptionsToProcess.length} mô tả. Đang gửi lên Gemini batch...`);

            // 2. Gửi toàn bộ mảng mô tả lên Gemini một lần duy nhất
            const batchResults = await translateBatchWithGemini(descriptionsToProcess);

            // --- 3. BÁO ĐANG ĐIỀN DỮ LIỆU VÀO FORM ---
            loopButtons.forEach(b => {
                b.textContent = '✍️ Filling';
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
            b.textContent = 'Fill All';
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
                totalSeconds += Number(statsData.approvedSeconds) || 0;
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



    // ==================== ADD-ON: REPORT DETAILS TAB (EPISODE-BASED REPORT) ====================
    // Luồng tính:
    //   1. /tasks (phân trang)            -> danh sách task, lọc status = delivered
    //   2. /tasks/{taskId}                -> submission.id
    //   3. /submissions/{submissionId}    -> artifacts[].data.episodes
    //   4. Thời lượng cắt = Σ (end_seconds - start_seconds) -> giờ, tiền theo tháng / khoảng ngày
    // Tổng quát: Total Hours = approvedSeconds (my-stats); Total Earnings = (approvedSeconds + extra-hours) × rate
    // (cùng công thức với ô tiền cạnh nút Fetch).
    const REPORT_TASKS_PAGE_SIZE = 20;
    const REPORT_MAX_PAGES = 200;
    const REPORT_RATE_PER_HOUR = 50000;
    const REPORT_CONCURRENCY = 3;                       // số task xử lý song song
    const REPORT_CACHE_KEY = 'tb_report_task_cut_cache_v1';
    const REPORT_CACHE_VERSION = 1;
    // Ngày dùng để xếp task vào tháng/khoảng ngày (ưu tiên từ trái sang phải)
    // [SỬA NGÀY] Xếp task theo createdAt của danh sách /tasks, quy đổi theo giờ máy (VN, UTC+7)
    // -> khớp với cột CREATED trên trang TBrain (vd 2026-11-03T17:42:17Z -> 04/11, 2026-11-03T14:00:57Z -> 03/11).

    const reportState = {
        loading: false, loaded: false, error: null,
        progress: { phase: '', done: 0, total: 0 },
        approvedSeconds: null, bonusSeconds: 0,
        statusCounts: {},
        entries: [],            // mỗi task delivered: { taskId, title, date, day, seconds }
        failed: [],             // taskId lỗi khi lấy submission
        mode: 'overview',       // 'overview' | 'range'
        rangeFrom: '', rangeTo: '',
        updatedAt: null
    };

    // ---------- helpers ----------
    const reportEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const reportSleep = ms => new Promise(r => setTimeout(r, ms));
    const reportPad = n => String(n).padStart(2, '0');
    const reportHours = sec => { const m = Math.round((Number(sec) || 0) / 60); return `${Math.floor(m / 60)}h ${reportPad(m % 60)}m`; };
    const reportMoneyNum = sec => Math.round((Number(sec) || 0) / 3600 * REPORT_RATE_PER_HOUR);
    const reportMoney = sec => `${reportMoneyNum(sec).toLocaleString('vi-VN')} đ`;
    const reportDate = raw => { const d = raw ? new Date(raw) : null; return d && !isNaN(d.getTime()) ? d : null; };
    // Ngày lịch theo giờ máy (giống cột CREATED trên TBrain)
    const reportDayKey = d => d ? `${d.getFullYear()}-${reportPad(d.getMonth() + 1)}-${reportPad(d.getDate())}` : 'unknown';
    const reportMonthOf = dayKey => dayKey === 'unknown' ? 'unknown' : dayKey.slice(0, 7);
    const reportMonthLabel = k => k === 'unknown' ? 'Không rõ ngày' : `Tháng ${Number(k.slice(5))}/${k.slice(0, 4)}`;
    const reportDayLabel = k => k === 'unknown' ? 'Không rõ ngày' : `${k.slice(8)}/${k.slice(5, 7)}/${k.slice(0, 4)}`;

    function reportLoadCache() {
        try { const c = JSON.parse(localStorage.getItem(REPORT_CACHE_KEY)); return c && typeof c === 'object' ? c : {}; } catch (_) { return {}; }
    }
    function reportSaveCache(cache) {
        try { localStorage.setItem(REPORT_CACHE_KEY, JSON.stringify(cache)); } catch (_) { }
    }

    async function reportGetJson(endpoint, token, attempt = 1) {
        const res = await origFetch.call(window, endpoint, {
            method: 'GET',
            headers: { Authorization: `Bearer ${token}`, Accept: '*/*' },
            credentials: 'include',
            cache: 'no-store'
        });
        if (res.status === 429 && attempt <= 3) {           // bị rate limit -> chờ rồi thử lại
            const retryAfter = Number(res.headers.get('retry-after'));
            await reportSleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt);
            return reportGetJson(endpoint, token, attempt + 1);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} – ${endpoint.split('?')[0].replace(API_BASE, '')}`);
        return res.json();
    }

    async function reportRunPool(items, limit, worker) {
        let cursor = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (cursor < items.length) {
                const idx = cursor++;
                await worker(items[idx], idx);
            }
        });
        await Promise.all(runners);
    }

    // ---------- data ----------
    async function fetchAllProjectTasksForReport(token) {
        const allTasks = [];
        for (let page = 1; page <= REPORT_MAX_PAGES; page++) {
            const body = await reportGetJson(`${API_BASE}/api/v1/tasks?page=${page}&pageSize=${REPORT_TASKS_PAGE_SIZE}&projectId=${encodeURIComponent(PROJECT_ID)}`, token);
            const rows = Array.isArray(body?.data) ? body.data : [];
            allTasks.push(...rows);
            const total = Number(body?.pagination?.total);
            reportSetProgress('Đang tải danh sách task', allTasks.length, Number.isFinite(total) ? total : allTasks.length);
            if (rows.length < REPORT_TASKS_PAGE_SIZE || (Number.isFinite(total) && allTasks.length >= total)) break;
            await reportSleep(120);
        }
        return allTasks;
    }

    // taskId -> submission -> Σ thời lượng episodes
    async function reportFetchTaskCut(taskId, token, cache) {
        const cached = cache[taskId];
        if (cached && cached.v === REPORT_CACHE_VERSION) return cached;   // delivered không đổi -> dùng cache

        const task = await reportGetJson(`${API_BASE}/api/v1/tasks/${encodeURIComponent(taskId)}`, token);
        const submissionId = task?.submission?.id;
        if (!submissionId) throw new Error('Task không có submission');

        const sub = await reportGetJson(`${API_BASE}/api/v1/submissions/${encodeURIComponent(submissionId)}`, token);
        let seconds = 0, episodes = 0;
        for (const artifact of (Array.isArray(sub?.artifacts) ? sub.artifacts : [])) {
            const eps = artifact?.data?.episodes;
            if (!Array.isArray(eps)) continue;
            for (const ep of eps) {
                const start = Number(ep?.start_seconds), end = Number(ep?.end_seconds);
                if (Number.isFinite(start) && Number.isFinite(end) && end > start) { seconds += end - start; episodes++; }
            }
        }
        const reviewedAt = (Array.isArray(sub?.reviewHistory) ? sub.reviewHistory : [])
            .map(r => r?.createdAt).filter(Boolean).sort().pop() || null;

        const entry = {
            v: REPORT_CACHE_VERSION,
            submissionId,
            title: sub?.taskTitle || task?.title || '',
            submittedAt: sub?.submittedAt || null,
            reviewedAt,
            createdAt: task?.createdAt || null,
            seconds, episodes
        };
        cache[taskId] = entry;
        return entry;
    }

    function reportSetProgress(phase, done, total) {
        reportState.progress = { phase, done, total };
        renderReportDetails(document.getElementById('tb-report-details-panel'));
    }

    async function loadReportDetails(force = false) {
        if (reportState.loading || (reportState.loaded && !force)) return;
        reportState.loading = true;
        reportState.error = null;
        reportSetProgress('Đang chuẩn bị', 0, 0);
        try {
            const candidate = findToken() || findToken(true);
            if (!candidate?.token) throw new Error('Không tìm thấy access token – hãy tải lại trang hoặc đăng nhập lại.');
            const token = candidate.token;

            // Tổng quát (giống ô tiền cạnh nút Fetch)
            const [statsData, extraData] = await Promise.all([
                reportGetJson(STATS_API_URL, token).catch(() => null),
                reportGetJson(EXTRA_HOURS_API_URL, token).catch(() => [])
            ]);
            const approved = Number(statsData?.approvedSeconds);
            reportState.approvedSeconds = Number.isFinite(approved) ? approved : null;
            reportState.bonusSeconds = (Array.isArray(extraData) ? extraData : []).reduce((s, i) => s + (Number(i?.seconds) || 0), 0);

            // Danh sách task
            const tasks = await fetchAllProjectTasksForReport(token);
            const statusCounts = {};
            for (const t of tasks) { const st = String(t?.status || 'unknown').toLowerCase(); statusCounts[st] = (statusCounts[st] || 0) + 1; }
            reportState.statusCounts = statusCounts;

            const deliveredTasks = tasks.filter(t => String(t?.status || '').toLowerCase() === 'delivered' && t?.id);
            const taskInfo = new Map(deliveredTasks.map(t => [t.id, t]));
            const deliveredIds = deliveredTasks.map(t => t.id);

            // Lặp từng task delivered -> submission -> episodes
            const cache = reportLoadCache();
            const entries = [], failed = [];
            let done = 0;
            reportSetProgress('Đang tính thời lượng episode', 0, deliveredIds.length);
            await reportRunPool(deliveredIds, REPORT_CONCURRENCY, async taskId => {
                try {
                    const c = await reportFetchTaskCut(taskId, token, cache);
                    const info = taskInfo.get(taskId);
                    const date = reportDate(info?.createdAt || c.createdAt);
                    entries.push({ taskId, title: info?.title || c.title, date, day: reportDayKey(date), seconds: c.seconds });
                } catch (err) {
                    console.warn('[TBRAIN REPORT] Lỗi task', taskId, err.message);
                    failed.push(taskId);
                }
                done++;
                if (done % 3 === 0 || done === deliveredIds.length) reportSetProgress('Đang tính thời lượng episode', done, deliveredIds.length);
            });
            reportSaveCache(cache);

            entries.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
            Object.assign(reportState, { loaded: true, entries, failed, updatedAt: new Date() });
            if (!reportState.rangeFrom && !reportState.rangeTo) reportApplyPreset('thisMonth', false);
        } catch (err) {
            console.error('[TBRAIN REPORT] Lỗi tải báo cáo:', err);
            reportState.error = err.message;
        } finally {
            reportState.loading = false;
            renderReportDetails(document.getElementById('tb-report-details-panel'));
        }
    }

    // ---------- aggregate ----------
    function reportGroup(entries, keyFn) {
        const map = new Map();
        for (const e of entries) {
            const k = keyFn(e.day);
            if (!map.has(k)) map.set(k, { key: k, tasks: 0, seconds: 0 });
            const g = map.get(k); g.tasks++; g.seconds += e.seconds;
        }
        return [...map.values()].sort((a, b) => a.key === 'unknown' ? 1 : b.key === 'unknown' ? -1 : b.key.localeCompare(a.key));
    }
    const reportSum = entries => entries.reduce((t, e) => ({ tasks: t.tasks + 1, seconds: t.seconds + e.seconds }), { tasks: 0, seconds: 0 });

    function reportFilterRange() {
        // So sánh theo chuỗi ngày YYYY-MM-DD (ngày tạo task theo giờ máy)
        const from = reportState.rangeFrom, to = reportState.rangeTo;
        return reportState.entries.filter(e => e.day !== 'unknown' && (!from || e.day >= from) && (!to || e.day <= to));
    }

    function reportApplyPreset(preset, rerender = true) {
        const today = new Date();
        const d = (y, m, day) => reportDayKey(new Date(y, m, day));
        const y = today.getFullYear(), m = today.getMonth();
        const presets = {
            today: [reportDayKey(today), reportDayKey(today)],
            last7: [d(y, m, today.getDate() - 6), reportDayKey(today)],
            thisMonth: [d(y, m, 1), d(y, m + 1, 0)],
            lastMonth: [d(y, m - 1, 1), d(y, m, 0)],
            all: ['', '']
        };
        if (!presets[preset]) return;
        [reportState.rangeFrom, reportState.rangeTo] = presets[preset];
        if (rerender) renderReportDetails(document.getElementById('tb-report-details-panel'));
    }

    // ---------- render ----------
    function reportStatCard(label, value, sub, accent = '') {
        return `<div class="tbr-card ${accent}"><span class="tbr-card-label">${label}</span><strong class="tbr-card-value">${value}</strong><small class="tbr-card-sub">${sub}</small></div>`;
    }

    function reportRenderOverview() {
        const s = reportState;
        const sum = reportSum(s.entries);
        const months = reportGroup(s.entries, reportMonthOf);
        const maxSec = Math.max(1, ...months.map(r => r.seconds));
        const approved = s.approvedSeconds;
        const diff = approved == null ? null : sum.seconds - approved;
        const diffText = approved == null ? 'Không lấy được my-stats'
            : Math.abs(diff) < 60 ? '✓ Khớp với giờ cắt từ episodes'
                : `Giờ cắt từ episodes: ${reportHours(sum.seconds)} (${diff > 0 ? '+' : '−'}${reportHours(Math.abs(diff))})`;

        const statusPills = Object.entries(s.statusCounts).sort((a, b) => b[1] - a[1])
            .map(([st, n]) => `<span class="tbr-pill ${st === 'delivered' ? 'is-ok' : ''}">${reportEsc(st)} <b>${n}</b></span>`).join('');

        const rows = months.map(r => `
            <tr>
                <td class="tbr-strong">${reportEsc(reportMonthLabel(r.key))}</td>
                <td class="tbr-num">${r.tasks}</td>
                <td class="tbr-num">${reportHours(r.seconds)}</td>
                <td class="tbr-num tbr-money">${reportMoney(r.seconds)}</td>
                <td class="tbr-bar-cell"><div class="tbr-bar"><span style="width:${(r.seconds / maxSec * 100).toFixed(1)}%"></span></div></td>
            </tr>`).join('');

        return `
            <div class="tbr-cards">
                ${reportStatCard('Total Hours', approved == null ? '—' : reportHours(approved), diffText, 'is-blue')}
                ${reportStatCard('Total Earnings', approved == null ? '—' : reportMoney(approved + s.bonusSeconds), `Gồm bonus ${reportHours(s.bonusSeconds)} · ${REPORT_RATE_PER_HOUR.toLocaleString('vi-VN')} đ/h`, 'is-green')}
                ${reportStatCard('Delivered Tasks', s.entries.length, 'Task đã được tính tiền', 'is-violet')}
                ${reportStatCard('Tháng này', reportMoney(reportSum(s.entries.filter(e => reportMonthOf(e.day) === reportMonthOf(reportDayKey(new Date())))).seconds), 'Tính từ giờ cắt episodes', 'is-amber')}
            </div>
            <div class="tbr-pills">${statusPills || ''}</div>
            <div class="tbr-table-card">
                <div class="tbr-table-head"><span>Thống kê theo tháng</span><small>Tiền = giờ cắt × ${REPORT_RATE_PER_HOUR.toLocaleString('vi-VN')} đ</small></div>
                <div class="tbr-scroll">
                    <table class="tbr-table">
                        <thead><tr><th>Tháng</th><th class="tbr-num">Tasks</th><th class="tbr-num">Giờ cắt</th><th class="tbr-num">Thu nhập</th><th>Tỷ trọng</th></tr></thead>
                        <tbody>${rows || '<tr><td colspan="5" class="tbr-empty">Chưa có task delivered.</td></tr>'}</tbody>
                        <tfoot><tr><td>Tổng</td><td class="tbr-num">${sum.tasks}</td><td class="tbr-num">${reportHours(sum.seconds)}</td><td class="tbr-num">${reportMoney(sum.seconds)}</td><td></td></tr></tfoot>
                    </table>
                </div>
            </div>`;
    }

    function reportRenderRange() {
        const s = reportState;
        const list = reportFilterRange();
        const sum = reportSum(list);
        const days = reportGroup(list, k => k);
        const maxSec = Math.max(1, ...days.map(r => r.seconds));
        const presetBtn = (id, label) => `<button type="button" class="tbr-chip" data-tbr-preset="${id}">${label}</button>`;

        const dayRows = days.map(r => `
            <tr>
                <td class="tbr-strong">${reportDayLabel(r.key)}</td>
                <td class="tbr-num">${r.tasks}</td>
                <td class="tbr-num">${reportHours(r.seconds)}</td>
                <td class="tbr-num tbr-money">${reportMoney(r.seconds)}</td>
                <td class="tbr-bar-cell"><div class="tbr-bar"><span style="width:${(r.seconds / maxSec * 100).toFixed(1)}%"></span></div></td>
            </tr>`).join('');

        const taskRows = list.map(e => `
            <tr>
                <td>${reportDayLabel(e.day)}</td>
                <td class="tbr-title" title="${reportEsc(e.taskId)}">${reportEsc(e.title || e.taskId)}</td>
                <td class="tbr-num">${reportHours(e.seconds)}</td>
                <td class="tbr-num tbr-money">${reportMoney(e.seconds)}</td>
            </tr>`).join('');

        const days_count = s.rangeFrom && s.rangeTo
            ? Math.max(1, Math.round((new Date(`${s.rangeTo}T00:00:00`) - new Date(`${s.rangeFrom}T00:00:00`)) / 864e5) + 1) : null;

        return `
            <div class="tbr-range-bar">
                <label class="tbr-field"><span>Từ ngày</span><input type="date" id="tbr-from" value="${reportEsc(s.rangeFrom)}"></label>
                <label class="tbr-field"><span>Đến ngày</span><input type="date" id="tbr-to" value="${reportEsc(s.rangeTo)}"></label>
                <button type="button" class="tbr-btn tbr-btn-primary" data-tbr-action="apply-range">Thống kê</button>
                <div class="tbr-chips">
                    ${presetBtn('today', 'Hôm nay')}${presetBtn('last7', '7 ngày')}${presetBtn('thisMonth', 'Tháng này')}${presetBtn('lastMonth', 'Tháng trước')}${presetBtn('all', 'Tất cả')}
                </div>
            </div>
            <div class="tbr-range-caption">${s.rangeFrom || s.rangeTo
                ? `Khoảng: <b>${s.rangeFrom ? reportDayLabel(s.rangeFrom) : '…'}</b> → <b>${s.rangeTo ? reportDayLabel(s.rangeTo) : '…'}</b>${days_count ? ` · ${days_count} ngày` : ''}`
                : 'Toàn bộ thời gian'}</div>
            <div class="tbr-cards">
                ${reportStatCard('Giờ cắt', reportHours(sum.seconds), `${(sum.seconds / 3600).toFixed(2)} giờ`, 'is-blue')}
                ${reportStatCard('Thu nhập', reportMoney(sum.seconds), `${REPORT_RATE_PER_HOUR.toLocaleString('vi-VN')} đ/h`, 'is-green')}
                ${reportStatCard('Tasks', sum.tasks, 'Task delivered trong khoảng', 'is-violet')}
                ${reportStatCard('TB / ngày', days_count ? reportHours(sum.seconds / days_count) : '—', days_count ? reportMoney(sum.seconds / days_count) : 'Chọn đủ from/to', 'is-amber')}
            </div>
            <div class="tbr-table-card">
                <div class="tbr-table-head"><span>Theo ngày</span><small>${days.length} ngày có dữ liệu</small></div>
                <div class="tbr-scroll">
                    <table class="tbr-table">
                        <thead><tr><th>Ngày</th><th class="tbr-num">Tasks</th><th class="tbr-num">Giờ cắt</th><th class="tbr-num">Thu nhập</th><th>Tỷ trọng</th></tr></thead>
                        <tbody>${dayRows || '<tr><td colspan="5" class="tbr-empty">Không có task nào trong khoảng này.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
            <div class="tbr-table-card">
                <div class="tbr-table-head"><span>Chi tiết task</span><small>${list.length} task</small></div>
                <div class="tbr-scroll tbr-scroll-y">
                    <table class="tbr-table">
                        <thead><tr><th>Ngày</th><th>Task</th><th class="tbr-num">Giờ cắt</th><th class="tbr-num">Thu nhập</th></tr></thead>
                        <tbody>${taskRows || '<tr><td colspan="4" class="tbr-empty">—</td></tr>'}</tbody>
                    </table>
                </div>
            </div>`;
    }

    function reportBindPanel(panel) {
        if (panel.dataset.tbrBound) return;
        panel.dataset.tbrBound = 'true';
        panel.addEventListener('click', event => {
            const el = event.target?.closest?.('[data-tbr-action], [data-tbr-preset], [data-tbr-mode]');
            if (!el || !panel.contains(el)) return;
            if (el.dataset.tbrMode) {
                reportState.mode = el.dataset.tbrMode;
                renderReportDetails(panel);
            } else if (el.dataset.tbrPreset) {
                reportApplyPreset(el.dataset.tbrPreset);
            } else if (el.dataset.tbrAction === 'refresh') {
                void loadReportDetails(true);
            } else if (el.dataset.tbrAction === 'clear-cache') {
                localStorage.removeItem(REPORT_CACHE_KEY);
                void loadReportDetails(true);
            } else if (el.dataset.tbrAction === 'apply-range') {
                const from = panel.querySelector('#tbr-from')?.value || '';
                const to = panel.querySelector('#tbr-to')?.value || '';
                if (from && to && from > to) { reportState.rangeFrom = to; reportState.rangeTo = from; }
                else { reportState.rangeFrom = from; reportState.rangeTo = to; }
                renderReportDetails(panel);
            }
        });
        panel.addEventListener('keydown', event => {
            if (event.key === 'Enter' && event.target?.matches?.('#tbr-from, #tbr-to')) {
                event.preventDefault();
                panel.querySelector('[data-tbr-action="apply-range"]')?.click();
            }
        });
    }

    function renderReportDetails(panel) {
        if (!panel) return;
        reportBindPanel(panel);
        const s = reportState;
        const p = s.progress;
        const pct = p.total ? Math.min(100, Math.round(p.done / p.total * 100)) : 0;

        const header = `
            <div class="tbr-header">
                <div>
                    <div class="tbr-title-main">Report Details</div>
                    <div class="tbr-subtitle">${s.updatedAt ? `Cập nhật ${s.updatedAt.toLocaleString('vi-VN')}` : 'Thống kê giờ cắt & thu nhập từ task delivered'}</div>
                </div>
                <div class="tbr-header-actions">
                    <div class="tbr-seg" role="tablist">
                        <button type="button" data-tbr-mode="overview" class="${s.mode === 'overview' ? 'is-active' : ''}">Tổng quát</button>
                        <button type="button" data-tbr-mode="range" class="${s.mode === 'range' ? 'is-active' : ''}">Theo khoảng ngày</button>
                    </div>
                    <button type="button" class="tbr-btn" data-tbr-action="refresh" ${s.loading ? 'disabled' : ''}>${s.loading ? '⏳' : '↻'} Refresh</button>
                    <button type="button" class="tbr-btn tbr-btn-ghost" data-tbr-action="clear-cache" title="Xóa cache giờ cắt và tải lại toàn bộ" ${s.loading ? 'disabled' : ''}>Xóa cache</button>
                </div>
            </div>`;

        const progress = s.loading ? `
            <div class="tbr-progress">
                <div class="tbr-progress-text"><span>${reportEsc(p.phase)}</span><span>${p.total ? `${p.done}/${p.total} · ${pct}%` : ''}</span></div>
                <div class="tbr-progress-track"><span style="width:${p.total ? pct : 8}%"></span></div>
            </div>` : '';

        const errorBox = s.error ? `<div class="tbr-alert is-error">❌ ${reportEsc(s.error)}</div>` : '';
        const failedBox = s.failed.length ? `<div class="tbr-alert is-warn">⚠️ ${s.failed.length} task không lấy được submission, chưa được tính. Bấm Refresh để thử lại.</div>` : '';

        let body = '';
        if (s.loaded) body = s.mode === 'range' ? reportRenderRange() : reportRenderOverview();
        else if (!s.loading && !s.error) body = '<div class="tbr-empty-state">Mở tab để bắt đầu tải dữ liệu…</div>';

        panel.innerHTML = `<div class="tbr-wrap">${header}${progress}${errorBox}${failedBox}${body}
            <div class="tbr-footnote">Giờ cắt = Σ (end_seconds − start_seconds) của các episode trong submission. Ngày của task = ngày tạo (createdAt) theo giờ máy, giống cột CREATED trên TBrain.</div></div>`;
    }

    function injectReportDetailsStyles() {
        if (document.getElementById('tb-report-details-style')) return;
        const style = document.createElement('style');
        style.id = 'tb-report-details-style';
        style.textContent = `
            #tb-report-details-panel { width:100%; min-height:240px; color:#e2e8f0; font-variant-numeric: tabular-nums; }
            #tb-report-details-panel .tbr-wrap { padding:16px 0 28px; display:flex; flex-direction:column; gap:14px; }
            #tb-report-details-panel .tbr-header { display:flex; justify-content:space-between; align-items:flex-end; gap:12px; flex-wrap:wrap; }
            #tb-report-details-panel .tbr-title-main { font-size:20px; font-weight:800; color:#f8fafc; letter-spacing:-.01em; }
            #tb-report-details-panel .tbr-subtitle { font-size:11px; color:#94a3b8; margin-top:3px; }
            #tb-report-details-panel .tbr-header-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            #tb-report-details-panel .tbr-seg { display:inline-flex; padding:3px; border-radius:10px; background:#0b1422; border:1px solid #1f2d42; }
            #tb-report-details-panel .tbr-seg button { padding:6px 12px; border-radius:7px; font-size:12px; font-weight:600; color:#94a3b8; background:transparent; border:0; cursor:pointer; transition:all .15s; }
            #tb-report-details-panel .tbr-seg button:hover { color:#e2e8f0; }
            #tb-report-details-panel .tbr-seg button.is-active { background:#2563eb; color:#fff; box-shadow:0 1px 6px rgba(37,99,235,.45); }
            #tb-report-details-panel .tbr-btn { height:32px; padding:0 12px; border-radius:9px; border:1px solid #2a3a52; background:#152033; color:#e2e8f0; font-size:12px; font-weight:600; cursor:pointer; transition:all .15s; }
            #tb-report-details-panel .tbr-btn:hover:not(:disabled) { background:#1d2b44; border-color:#3b4f6e; }
            #tb-report-details-panel .tbr-btn:disabled { opacity:.55; cursor:wait; }
            #tb-report-details-panel .tbr-btn-primary { background:#2563eb; border-color:#2563eb; color:#fff; }
            #tb-report-details-panel .tbr-btn-primary:hover:not(:disabled) { background:#1d4ed8; border-color:#1d4ed8; }
            #tb-report-details-panel .tbr-btn-ghost { background:transparent; color:#94a3b8; }
            #tb-report-details-panel .tbr-progress { padding:12px 14px; border:1px solid #1f2d42; border-radius:12px; background:#0f1a2b; }
            #tb-report-details-panel .tbr-progress-text { display:flex; justify-content:space-between; font-size:11px; color:#94a3b8; margin-bottom:8px; }
            #tb-report-details-panel .tbr-progress-track { height:6px; border-radius:999px; background:#1e293b; overflow:hidden; }
            #tb-report-details-panel .tbr-progress-track span { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#3b82f6,#22d3ee); transition:width .25s ease; }
            #tb-report-details-panel .tbr-alert { padding:10px 14px; border-radius:10px; font-size:12px; }
            #tb-report-details-panel .tbr-alert.is-error { background:rgba(127,29,29,.25); border:1px solid rgba(248,113,113,.35); color:#fca5a5; }
            #tb-report-details-panel .tbr-alert.is-warn { background:rgba(120,53,15,.25); border:1px solid rgba(251,191,36,.35); color:#fcd34d; }
            #tb-report-details-panel .tbr-cards { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
            #tb-report-details-panel .tbr-card { position:relative; overflow:hidden; display:flex; flex-direction:column; gap:6px; padding:16px; border-radius:14px; border:1px solid #1f2d42; background:linear-gradient(180deg,#132036,#0e1828); }
            #tb-report-details-panel .tbr-card::before { content:''; position:absolute; inset:0 0 auto 0; height:3px; background:var(--tbr-accent,#3b82f6); }
            #tb-report-details-panel .tbr-card.is-blue { --tbr-accent:#3b82f6; }
            #tb-report-details-panel .tbr-card.is-green { --tbr-accent:#10b981; }
            #tb-report-details-panel .tbr-card.is-violet { --tbr-accent:#8b5cf6; }
            #tb-report-details-panel .tbr-card.is-amber { --tbr-accent:#f59e0b; }
            #tb-report-details-panel .tbr-card-label { font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#94a3b8; }
            #tb-report-details-panel .tbr-card-value { font-size:24px; font-weight:800; line-height:1.15; color:#f8fafc; }
            #tb-report-details-panel .tbr-card-sub { font-size:11px; color:#64748b; }
            #tb-report-details-panel .tbr-pills { display:flex; flex-wrap:wrap; gap:6px; }
            #tb-report-details-panel .tbr-pill { padding:4px 10px; border-radius:999px; border:1px solid #26364b; background:#0f1a2b; font-size:11px; color:#94a3b8; text-transform:capitalize; }
            #tb-report-details-panel .tbr-pill b { color:#e2e8f0; margin-left:3px; }
            #tb-report-details-panel .tbr-pill.is-ok { border-color:rgba(16,185,129,.4); color:#6ee7b7; }
            #tb-report-details-panel .tbr-table-card { border:1px solid #1f2d42; border-radius:14px; background:#0f1a2b; overflow:hidden; }
            #tb-report-details-panel .tbr-table-head { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid #1f2d42; font-size:13px; font-weight:700; color:#f1f5f9; }
            #tb-report-details-panel .tbr-table-head small { font-size:11px; font-weight:500; color:#64748b; }
            #tb-report-details-panel .tbr-scroll { overflow-x:auto; }
            #tb-report-details-panel .tbr-scroll-y { max-height:420px; overflow-y:auto; }
            #tb-report-details-panel .tbr-table { width:100%; min-width:640px; border-collapse:collapse; font-size:12px; text-align:left; }
            #tb-report-details-panel .tbr-table th { position:sticky; top:0; z-index:1; padding:10px 16px; background:#0b1422; color:#64748b; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; white-space:nowrap; }
            #tb-report-details-panel .tbr-table td { padding:11px 16px; border-top:1px solid #172338; color:#cbd5e1; white-space:nowrap; }
            #tb-report-details-panel .tbr-table tbody tr:hover td { background:#13203a; }
            #tb-report-details-panel .tbr-table tfoot td { background:#132036; color:#f8fafc; font-weight:800; border-top:1px solid #26364b; }
            #tb-report-details-panel .tbr-num { text-align:right; }
            #tb-report-details-panel .tbr-strong { color:#f1f5f9; font-weight:650; }
            #tb-report-details-panel .tbr-money { color:#6ee7b7; font-weight:650; }
            #tb-report-details-panel .tbr-title { max-width:320px; overflow:hidden; text-overflow:ellipsis; font-family:ui-monospace,monospace; font-size:11px; }
            #tb-report-details-panel .tbr-bar-cell { width:22%; min-width:120px; }
            #tb-report-details-panel .tbr-bar { height:8px; border-radius:999px; background:#1e293b; overflow:hidden; }
            #tb-report-details-panel .tbr-bar span { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#2563eb,#22d3ee); }
            #tb-report-details-panel .tbr-empty { text-align:center; color:#64748b; padding:22px; }
            #tb-report-details-panel .tbr-empty-state { padding:30px; text-align:center; color:#64748b; border:1px dashed #26364b; border-radius:14px; }
            #tb-report-details-panel .tbr-range-bar { display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap; padding:14px 16px; border:1px solid #1f2d42; border-radius:14px; background:#0f1a2b; }
            #tb-report-details-panel .tbr-field { display:flex; flex-direction:column; gap:5px; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#94a3b8; }
            #tb-report-details-panel .tbr-field input { height:32px; padding:0 10px; border-radius:9px; border:1px solid #2a3a52; background:#0b1422; color:#e2e8f0; font-size:12px; color-scheme:dark; }
            #tb-report-details-panel .tbr-field input:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,.2); }
            #tb-report-details-panel .tbr-chips { display:flex; gap:6px; flex-wrap:wrap; margin-left:auto; }
            #tb-report-details-panel .tbr-chip { height:28px; padding:0 11px; border-radius:999px; border:1px solid #2a3a52; background:transparent; color:#94a3b8; font-size:11px; font-weight:600; cursor:pointer; }
            #tb-report-details-panel .tbr-chip:hover { color:#e2e8f0; border-color:#3b82f6; }
            #tb-report-details-panel .tbr-range-caption { font-size:12px; color:#94a3b8; }
            #tb-report-details-panel .tbr-range-caption b { color:#e2e8f0; }
            #tb-report-details-panel .tbr-footnote { font-size:10px; color:#475569; }
            #tb-report-details-panel button:focus-visible { outline:2px solid #60a5fa; outline-offset:2px; }
            @media (max-width:900px) { #tb-report-details-panel .tbr-cards { grid-template-columns:repeat(2,minmax(0,1fr)); } #tb-report-details-panel .tbr-chips { margin-left:0; } }
        `;
        document.head.appendChild(style);
    }

    function showReportDetailsTab(tab, panel) {
        const tablist = tab?.closest('[role="tablist"]');
        if (!tablist || !panel) return;
        tablist.querySelectorAll('[role="tab"]').forEach(item => {
            const active = item === tab;
            item.setAttribute('aria-selected', String(active));
            item.setAttribute('tabindex', active ? '0' : '-1');
            item.classList.toggle('border-brand-blue', active);
            item.classList.toggle('font-medium', active);
            item.classList.toggle('text-fg', active);
            item.classList.toggle('border-transparent', !active);
            item.classList.toggle('text-fg-muted', !active);
        });
        // Chỉ ẩn các panel gốc khi custom tab đang mở. Khi quay lại tab gốc,
        // restoreNativeReportPanels() sẽ khôi phục panel tương ứng với tab được chọn.
        tablist.parentElement?.querySelectorAll('[role="tabpanel"]').forEach(item => {
            item.hidden = item !== panel;
            item.style.display = item === panel ? '' : 'none';
        });
        panel.hidden = false;
        panel.style.display = '';

        // [ĐÃ SỬA] render state hiện tại + tải dữ liệu thật (lần đầu), sau đó dùng nút Refresh
        renderReportDetails(panel);
        void loadReportDetails();
    }

    function restoreNativeReportPanels(tablist) {
        if (!tablist) return;
        const selectedTab = Array.from(tablist.querySelectorAll('[role="tab"]'))
            .find(item => item.id !== 'tb-report-details-tab' && item.getAttribute('aria-selected') === 'true');
        const selectedPanelId = selectedTab?.getAttribute('aria-controls');
        const customPanel = document.getElementById('tb-report-details-panel');
        if (customPanel) {
            customPanel.hidden = true;
            customPanel.style.display = 'none';
        }

        // Khôi phục đúng panel gốc theo aria-controls, không để trạng thái hidden
        // do lần mở Report Details trước đó khóa các tab khác.
        const panelRoot = tablist.parentElement;
        panelRoot?.querySelectorAll('[role="tabpanel"]').forEach(panel => {
            if (panel.id === 'tb-report-details-panel') return;
            const active = !!selectedPanelId && panel.id === selectedPanelId;
            panel.hidden = !active;
            panel.style.display = active ? '' : 'none';
        });
    }

    function injectReportDetailsTab() {
        const reportTab = document.querySelector('[data-testid="my-project-tab-reports"]');
        const tablist = reportTab?.closest('[role="tablist"]');
        if (!reportTab || !tablist) return;
        injectReportDetailsStyles();
        if (!tablist.dataset.tbReportDetailsBound) {
            tablist.dataset.tbReportDetailsBound = 'true';
            tablist.addEventListener('click', event => {
                const clickedTab = event.target?.closest?.('[role="tab"]');
                if (clickedTab && clickedTab.id !== 'tb-report-details-tab') {
                    // Đợi React xử lý click và cập nhật aria-selected/aria-controls trước,
                    // sau đó mới đồng bộ lại các panel gốc.
                    setTimeout(() => restoreNativeReportPanels(tablist), 0);
                }
            }, true);
        }

        let detailsTab = document.getElementById('tb-report-details-tab');
        if (!detailsTab) {
            detailsTab = document.createElement('button');
            detailsTab.id = 'tb-report-details-tab';
            detailsTab.type = 'button';
            detailsTab.setAttribute('role', 'tab');
            detailsTab.setAttribute('data-tab-id', 'report-details');
            detailsTab.setAttribute('data-testid', 'my-project-tab-report-details');
            detailsTab.setAttribute('aria-selected', 'false');
            detailsTab.setAttribute('tabindex', '-1');
            detailsTab.className = 'mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors border-transparent text-fg-muted hover:text-fg';
            detailsTab.textContent = 'Report Details';
            detailsTab.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                const currentPanel = document.getElementById('tb-report-details-panel');
                showReportDetailsTab(detailsTab, currentPanel);
            });
            reportTab.insertAdjacentElement('afterend', detailsTab);
        } else if (detailsTab.previousElementSibling !== reportTab) {
            reportTab.insertAdjacentElement('afterend', detailsTab);
        }

        let panel = document.getElementById('tb-report-details-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'tb-report-details-panel';
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', 'tb-report-details-tab');
            panel.hidden = true;
            panel.style.display = 'none';
            renderReportDetails(panel); // [ĐÃ SỬA] thay cho bảng mock

            const reportPanelId = reportTab.getAttribute('aria-controls');
            const reportPanel = reportPanelId ? document.getElementById(reportPanelId) : null;
            if (reportPanel?.parentElement) reportPanel.insertAdjacentElement('afterend', panel);
            else {
                const panelContainer = document.querySelector('[role="tabpanel"]')?.parentElement;
                if (panelContainer) panelContainer.appendChild(panel);
            }
        }
    }
    // ==================== END ADD-ON: REPORT DETAILS TAB ====================

    /* ---------------------------------------------------------------------
     * UI INJECTION - CHUYỂN TẤT CẢ CỤM ĐIỀU KHIỂN VỀ BÊN PHẢI HEADER
     * --------------------------------------------------------------------- */
    function injectUIControls() {
        if (!document.getElementById('tb-master-ui-style')) {
            const style = document.createElement('style');
            style.id = 'tb-master-ui-style';
            style.textContent = `
                #tb-helper-toolbar, #tb-fetch-control-wrapper {
                    display: flex; align-items: center; gap: 4px; margin-right: 6px; flex-shrink: 0;
                    padding: 3px 4px; border: 1px solid rgba(148,163,184,.25); border-radius: 8px;
                    background: rgba(15,23,42,.55);
                }
                #tb-fetch-control-wrapper { position: relative; }
                #tb-helper-toolbar .tb-action-btn,
                #tb-fetch-control-wrapper button {
                    display: inline-flex; align-items: center; justify-content: center;
                    height: 24px !important; padding: 0 7px !important; border-radius: 6px !important;
                    border: 1px solid rgba(255,255,255,.14) !important; color: #fff !important;
                    font-size: 11px !important; font-weight: 600 !important; line-height: 1;
                    white-space: nowrap; flex-shrink: 0; cursor: pointer; transition: filter .15s ease;
                }
                #tb-helper-toolbar .tb-action-btn:hover,
                #tb-fetch-control-wrapper button:hover { filter: brightness(1.15); }
                #tb-helper-toolbar .tb-action-btn:active,
                #tb-fetch-control-wrapper button:active { filter: brightness(.95); }
                #tb-l3-custom-input {
                    height: 24px; width: 92px; padding: 0 6px; border-radius: 6px; font-size: 11px;
                    background-color: #ffffff !important; color: #000000 !important; border: 1px solid #cbd5e1 !important;
                }
                #tb-inject-copy      { background-color: #6366f1; }
                #tb-inject-paste     { background-color: #2563eb; }
                #tb-inject-paste-all { background-color: #0f766e; }
                #tb-helper-toolbar .tb-sep { width: 1px; height: 16px; background: rgba(148,163,184,.35); margin: 0 1px; }

                #tb-fetch-control-wrapper .tb-fetch-toggle[data-active="true"]  { background: #16a34a; }
                #tb-fetch-control-wrapper .tb-fetch-toggle[data-active="false"] { background: #dc2626; }
                #tb-fetch-control-wrapper .tb-key-btn { background: #64748b; padding: 0 6px !important; }
                #tb-earnings-card {
                    display: flex; align-items: center; height: 24px; padding: 0 7px;
                    border: 1px solid rgba(52,211,153,.4); border-radius: 6px; background: rgba(6,78,59,.55);
                }
                #tb-earnings-label { display: none; }
                #tb-earnings-display { color: #ecfdf5; font-size: 11px; font-weight: 800; white-space: nowrap; }
                #tb-fetch-control-wrapper .tb-fetch-setting {
                    width: 48px; height: 24px; padding: 0 3px; border: 1px solid rgba(148,163,184,.35);
                    border-radius: 6px; background: rgba(15,23,42,.75); color: #e2e8f0; text-align: center;
                    font-size: 10px; font-weight: 600; outline: none;
                }
                #tb-fetch-control-wrapper .tb-fetch-setting:focus { border-color: #60a5fa; }
            `;
            document.head.appendChild(style);
        }

        // Tìm div chứa class 'ml-auto' nằm ở góc phải của header
        const headerRightContainer = document.querySelector('header div.ml-auto');

        if (headerRightContainer && !document.getElementById('tb-helper-toolbar')) {
            const makeBtn = (id, label, title, onClick, extraClass = '', bg = '') => {
                const b = document.createElement('button');
                b.id = id;
                b.type = 'button';
                b.className = `tb-action-btn ${extraClass}`.trim();
                b.title = title;
                b.textContent = label;
                if (bg) b.style.backgroundColor = bg;
                b.addEventListener('click', onClick);
                return b;
            };
            const sep = () => { const s = document.createElement('span'); s.className = 'tb-sep'; return s; };

            const helperToolbar = document.createElement('div');
            helperToolbar.id = 'tb-helper-toolbar';

            const l3Input = document.createElement('input');
            l3Input.id = 'tb-l3-custom-input';
            l3Input.type = 'text';
            l3Input.placeholder = 'L3...';

            helperToolbar.append(
                l3Input,
                makeBtn('tb-inject-single-l3', 'L3', 'Fill L3 cho episode hiện tại', runFillSingleL3, '', '#10b981'),
                makeBtn('tb-inject-l3-loop', 'L3 All', 'Fill L3 cho tất cả episode (#)', runLoopFillL3, 'tb-inject-fill-l3-loop-btn', '#059669'),
                sep(),
                makeBtn('tb-inject-loop', 'Fill All', 'AI Fill tất cả episode (@)', runLoopAllEpisodes, 'tb-inject-loop-btn', '#4338ca'),
                sep(),
                makeBtn('tb-inject-paste', 'Paste', 'Paste vào episode hiện tại ($)', runPasteSegment),
                makeBtn('tb-inject-paste-all', 'Paste All', 'Paste vào tất cả episode', runPasteAllSegments),
                makeBtn('tb-inject-copy', 'Copy', 'Copy dữ liệu episode hiện tại', runCopySegment)
            );

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
            wrapper.className = "";

            // Hiển thị thu nhập tổng (bao gồm bonus) từ API thống kê.
            const earningsCard = document.createElement("div");
            earningsCard.id = "tb-earnings-card";
            earningsCard.title = "Total earnings (đã gồm bonus)";
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
            toggleBtn.title = "Bật/tắt tự động Fetch Task";

            function updateToggleButton() {
                toggleBtn.textContent = isActive ? "● Fetch ON" : "● Fetch OFF";
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
            pollInput.title = "Poll interval (ms)";
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
            durationInput.title = "Min duration (giây)";
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
            btnKey.className = "tb-key-btn";
            btnKey.title = "Gemini API Key";
            btnKey.textContent = "🔑";

            // Tạo Popup Modal nhập Key
            const tokenModal = document.createElement("div");
            tokenModal.style.cssText = "display: none; position: absolute; top: 32px; right: 0; background: #1e293b; border: 1px solid #475569; padding: 12px; border-radius: 8px; z-index: 9999; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); width: 260px;";

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

        if (e.key === '@') {
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
    setInterval(injectReportDetailsTab, 500);
    console.log('✅ Master Tbrain Script (No Tool in Activity) is ready.');
})();
