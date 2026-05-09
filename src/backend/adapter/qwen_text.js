/**
 * @fileoverview 通义千问 (Qwen/Tongyi) 文本生成适配器
 */

import {
    sleep,
    humanType,
    safeClick
} from '../engine/utils.js';
import {
    normalizePageError,
    waitForInput,
    gotoWithCheck
} from '../utils/index.js';
import { logger } from '../../utils/logger.js';

// --- 配置常量 ---
const TARGET_URL = 'https://www.qianwen.com/';

// 输入框可能的选择器列表 (按优先级排序)
const INPUT_SELECTORS = [
    'textarea.chat-input',
    'textarea[placeholder]',
    '.chat-input-container textarea',
    '.input-box textarea',
    'textarea',
    '[contenteditable="true"]',
    '.ProseMirror',
    'div[contenteditable="true"]',
];

// 发送按钮选择器
const SEND_BUTTON_SELECTORS = [
    'button[type="submit"]',
    'button:has-text("发送")',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[class*="send"]',
    'button.send-btn',
    '.chat-send-button',
    'button:has-text("Send")',
];

/**
 * 查找输入框 (尝试多个选择器)
 * @param {import('playwright-core').Page} page
 * @param {object} meta
 * @returns {Promise<import('playwright-core').Locator|null>}
 */
async function findInputBox(page, meta = {}) {
    for (const selector of INPUT_SELECTORS) {
        try {
            const locator = page.locator(selector).first();
            const count = await locator.count();
            if (count > 0) {
                const isVisible = await locator.isVisible();
                if (isVisible) {
                    logger.info('适配器', `找到输入框，选择器: ${selector}`, meta);
                    return locator;
                }
            }
        } catch (e) {
            logger.debug('适配器', `选择器 ${selector} 检测失败: ${e.message}`, meta);
        }
    }
    return null;
}

/**
 * 查找发送按钮
 * @param {import('playwright-core').Page} page
 * @param {object} meta
 * @returns {Promise<import('playwright-core').Locator|null>}
 */
async function findSendButton(page, meta = {}) {
    for (const selector of SEND_BUTTON_SELECTORS) {
        try {
            const locator = page.locator(selector).first();
            const count = await locator.count();
            if (count > 0) {
                const isVisible = await locator.isVisible();
                if (isVisible) {
                    logger.info('适配器', `找到发送按钮，选择器: ${selector}`, meta);
                    return locator;
                }
            }
        } catch (e) {
            logger.debug('适配器', `发送按钮选择器 ${selector} 失败: ${e.message}`, meta);
        }
    }
    return null;
}

/**
 * 执行文本生成任务
 * @param {object} context - 浏览器上下文 { page, config }
 * @param {string} prompt - 提示词
 * @param {string[]} imgPaths - 图片路径数组 (此适配器暂不支持)
 * @param {string} [modelId] - 模型 ID
 * @param {object} [meta={}] - 日志元数据
 * @returns {Promise<{text?: string, reasoning?: string, error?: string}>}
 */
async function generate(context, prompt, imgPaths, modelId, meta = {}) {
    const { page, config } = context;
    const waitTimeout = config?.backend?.pool?.waitTimeout ?? 120000;

    try {
        logger.info('适配器', '开启新会话...', meta);
        await gotoWithCheck(page, TARGET_URL);

        // 等待页面加载
        await sleep(2000, 3000);

        // 检测登录页面或错误页面
        const pageUrl = page.url();
        logger.debug('适配器', `当前页面 URL: ${pageUrl}`, meta);

        // 检查是否有登录提示
        try {
            const loginText = await page.locator('text=/请登录|登录|Sign in|Login|需要登录/').first().textContent({ timeout: 3000 }).catch(() => null);
            if (loginText) {
                logger.warn('适配器', `检测到登录提示: ${loginText}`, meta);
                return { error: '需要登录阿里云账户，请先在浏览器中登录通义千问' };
            }
        } catch {}

        // 1. 查找输入框
        logger.debug('适配器', '正在寻找输入框...', meta);
        let inputLocator = await findInputBox(page, meta);

        if (!inputLocator) {
            logger.warn('适配器', '未找到输入框，尝试截图调试...', meta);
            try {
                const screenshot = await page.screenshot({ fullPage: false });
                logger.debug('适配器', `页面截图已保存 (${screenshot.length} bytes)`, meta);
            } catch (e) {
                logger.debug('适配器', `截图失败: ${e.message}`, meta);
            }

            // 输出页面元素信息
            const textareaCount = await page.locator('textarea').count();
            const inputCount = await page.locator('input').count();
            const contenteditableCount = await page.locator('[contenteditable="true"]').count();
            logger.debug('适配器', `textarea=${textareaCount}, input=${inputCount}, contenteditable=${contenteditableCount}`, meta);

            return { error: '未找到输入框，请检查通义千问页面结构或是否已登录' };
        }

        // 2. 输入提示词
        logger.info('适配器', '输入提示词...', meta);

        try {
            await inputLocator.focus({ timeout: 10000 });
            logger.debug('适配器', '使用 focus() 聚焦输入框', meta);
        } catch (e) {
            logger.debug('适配器', `focus 失败: ${e.message}，尝试 force click`, meta);
            try {
                await inputLocator.click({ force: true, timeout: 10000 });
            } catch (e2) {
                logger.warn('适配器', `force click 失败: ${e2.message}`, meta);
            }
        }

        await sleep(500, 800);
        await humanType(page, inputLocator, prompt);
        await sleep(300, 500);

        // 3. 启动响应监听
        logger.debug('适配器', '启动网络请求监听...', meta);

        let resultText = '';
        let isComplete = false;
        let collectedReferences = [];  // 收集搜索引用

        // 监听 WebSocket 消息 (通义千问可能使用 WebSocket)
        page.on('websocket', ws => {
            logger.info('适配器', `发现 WebSocket: ${ws.url()}`, meta);
            ws.on('framereceived', frame => {
                try {
                    const payload = frame.payload;
                    if (payload && typeof payload === 'string') {
                        logger.debug('适配器', `WebSocket 消息: ${payload.substring(0, 500)}`, meta);
                        try {
                            const data = JSON.parse(payload);
                            // 通义千问可能的响应格式
                            if (data.output || data.text || data.content || data.result) {
                                const text = data.output?.text || data.text || data.content || data.result || '';
                                if (text) {
                                    resultText += text;
                                    isComplete = true;
                                }
                            }
                        } catch {}
                    }
                } catch (e) {
                    logger.debug('适配器', `WebSocket 解析失败: ${e.message}`, meta);
                }
            });
        });

        // 监听 SSE/API 响应
        const handleResponse = async (response) => {
            const url = response.url();
            const method = response.request().method();
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            // 记录可能相关的 API 请求
            if (method === 'POST' && status === 200) {
                if (url.includes('chat') || url.includes('completion') || url.includes('stream') ||
                    url.includes('conversation') || url.includes('qwen') || url.includes('tongyi') ||
                    url.includes('api') || url.includes('bot')) {
                    logger.info('适配器', `发现 API: ${method} ${url} (${contentType.substring(0, 50)})`, meta);
                }
            }

            // SSE 响应处理
            if (contentType.includes('text/event-stream') || contentType.includes('application/stream+json')) {
                logger.info('适配器', `收到 SSE 响应: ${url}`, meta);
                try {
                    const body = await response.text();
                    const parsed = parseSSEResponse(body, meta);
                    if (parsed.text) {
                        resultText += parsed.text;
                    }
                    if (parsed.complete) {
                        isComplete = true;
                    }
                    if (parsed.references && parsed.references.length > 0) {
                        for (const ref of parsed.references) {
                            // 去重：使用 url 作为唯一标识
                            if (ref.url && !collectedReferences.some(r => r.url === ref.url)) {
                                collectedReferences.push(ref);
                            }
                        }
                    }
                } catch (e) {
                    logger.warn('适配器', `SSE 解析错误: ${e.message}`, meta);
                }
            }

            // JSON 响应处理
            if (contentType.includes('application/json') && method === 'POST' && status === 200) {
                if (url.includes('chat') || url.includes('completion') || url.includes('conversation') ||
                    url.includes('api') || url.includes('bot') || url.includes('message')) {
                    logger.info('适配器', `收到 JSON 响应: ${url}`, meta);
                    try {
                        const body = await response.text();
                        const parsed = parseJsonResponse(body, meta);
                        if (parsed.text) {
                            resultText = parsed.text;
                            isComplete = true;
                        }
                        if (parsed.references && parsed.references.length > 0) {
                            for (const ref of parsed.references) {
                                if (!collectedReferences.some(r => r.url === ref.url)) {
                                    collectedReferences.push(ref);
                                }
                            }
                        }
                    } catch (e) {
                        logger.warn('适配器', `JSON 解析错误: ${e.message}`, meta);
                    }
                }
            }
        };
        page.on('response', handleResponse);

        // 4. 点击发送按钮
        logger.debug('适配器', '寻找发送按钮...', meta);

        let sendClicked = false;
        const sendBtn = await findSendButton(page, meta);

        if (sendBtn) {
            await safeClick(page, sendBtn, { bias: 'button' });
            sendClicked = true;
        }

        if (!sendClicked) {
            logger.info('适配器', '未找到发送按钮，尝试键盘发送...', meta);
            const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(modifierKey);
            await page.keyboard.press('Enter');
            await page.keyboard.up(modifierKey);
            await sleep(500, 800);
            await page.keyboard.press('Enter');
        }

        // 5. 等待响应
        logger.info('适配器', '等待生成结果...', meta);

        const maxWaitTime = Math.min(waitTimeout, 60000);
        const startTime = Date.now();
        let lastContentLength = 0;
        let stableCount = 0;
        let lastCheckTime = 0;

        while (Date.now() - startTime < maxWaitTime) {
            const elapsed = Date.now() - startTime;

            if (Date.now() - lastCheckTime > 500) {
                lastCheckTime = Date.now();

                // 检查是否已从 API 获取到内容
                if (resultText && resultText.trim().length > 10) {
                    logger.info('适配器', `已从 API 获取到内容 (${elapsed}ms)`, meta);
                    break;
                }

                // 尝试从页面获取回复内容
                try {
                    const pageReply = await page.evaluate(() => {
                        // 通义千问可能的回复选择器
                        const selectors = [
                            '.chat-answer',
                            '.answer-content',
                            '.response-content',
                            '.ai-message',
                            '.message-content',
                            '[class*="answer"]',
                            '[class*="response"]',
                            '[class*="reply"]',
                        ];

                        for (const selector of selectors) {
                            try {
                                const elements = document.querySelectorAll(selector);
                                for (const el of elements) {
                                    const text = (el.textContent || '').trim();
                                    if (text.length > 20) {
                                        // 排除用户消息区域
                                        if (el.closest('[class*="user"]') || el.closest('[class*="input"]')) continue;
                                        return text;
                                    }
                                }
                            } catch {}
                        }

                        // 通用方法：查找最新的聊天消息
                        const chatContainers = document.querySelectorAll('[class*="chat-item"], [class*="message-item"], [class*="conversation-item"]');
                        for (const container of chatContainers) {
                            if (container.className.toLowerCase().includes('user')) continue;
                            const text = (container.textContent || '').trim();
                            if (text.length > 30 && !text.includes('输入') && !text.includes('发送')) {
                                return text;
                            }
                        }

                        return null;
                    });

                    // 提取搜索引用链接（通义千问的特殊处理）
                    const searchReferences = await page.evaluate(() => {
                        const refs = [];
                        const debugInfo = [];  // 调试信息

                        // 专门查找通义千问的引用链接区域
                        // 通义千问的引用通常在聊天消息下方，带有"来源"标记

                        // 0. 调试：记录所有外部链接和可能相关的元素
                        const allLinks = document.querySelectorAll('a[href]');
                        for (const link of allLinks) {
                            const href = link.href || '';
                            if (href.startsWith('http') && !href.includes('qianwen.com') && !href.includes('alicdn.com') && !href.includes('track.uc.cn')) {
                                const text = link.textContent?.trim().slice(0, 50) || '';
                                const className = link.className || '';
                                const parentClass = link.parentElement?.className || '';
                                debugInfo.push({ href, text, className, parentClass });
                            }
                        }

                        // 调试：查找包含"来源"的所有元素的类名
                        const sourceElements = document.querySelectorAll('*');
                        for (const el of sourceElements) {
                            const text = el.textContent || '';
                            if (text.includes('篇来源') || text.match(/^\d+篇来源$/)) {
                                debugInfo.push({
                                    type: 'source_element',
                                    tagName: el.tagName,
                                    className: el.className,
                                    text: text.slice(0, 100),
                                    innerHTML: el.innerHTML?.slice(0, 200)
                                });
                                // 查找这个元素的父级和兄弟元素
                                const parent = el.parentElement;
                                if (parent) {
                                    debugInfo.push({
                                        type: 'parent_element',
                                        tagName: parent.tagName,
                                        className: parent.className,
                                        innerHTML: parent.innerHTML?.slice(0, 300)
                                    });
                                }
                            }
                        }

                        // 1. 查找所有带有 cite/reference 类的链接
                        const citeElements = document.querySelectorAll('[class*="cite"], [class*="reference"], [class*="source"]');
                        for (const el of citeElements) {
                            const links = el.querySelectorAll('a[href]');
                            for (const link of links) {
                                const href = link.href || '';
                                const text = link.textContent?.trim() || '';
                                if (href && href.startsWith('http') && !href.includes('qianwen.com') && !href.includes('alicdn.com')) {
                                    refs.push({ url: href, title: text.slice(0, 100) });
                                }
                            }
                        }

                        // 2. 查找"来源"或"N篇来源"区域下的链接
                        const sourceContainers = document.querySelectorAll('div, section, span');
                        for (const container of sourceContainers) {
                            const text = container.textContent || '';
                            if (text.includes('来源') || text.match(/\d+篇来源/)) {
                                // 找到包含"来源"的容器，查找其中的链接
                                const links = container.querySelectorAll('a[href]');
                                for (const link of links) {
                                    const href = link.href || '';
                                    const text = link.textContent?.trim() || '';
                                    if (href && href.startsWith('http') && !href.includes('qianwen.com') && !href.includes('alicdn.com')) {
                                        refs.push({ url: href, title: text.slice(0, 100) });
                                    }
                                }
                                // 也查找父级和兄弟元素
                                const parent = container.parentElement;
                                if (parent) {
                                    const parentLinks = parent.querySelectorAll('a[href]');
                                    for (const link of parentLinks) {
                                        const href = link.href || '';
                                        const text = link.textContent?.trim() || '';
                                        if (href && href.startsWith('http') && !href.includes('qianwen.com') && !href.includes('alicdn.com') && !refs.some(r => r.url === href)) {
                                            refs.push({ url: href, title: text.slice(0, 100) });
                                        }
                                    }
                                }
                            }
                        }

                        // 3. 查找气泡/卡片类型的引用元素
                        const bubbleRefs = document.querySelectorAll('[class*="bubble"], [class*="card"], [class*="link-card"]');
                        for (const bubble of bubbleRefs) {
                            const link = bubble.querySelector('a[href]');
                            if (link) {
                                const href = link.href || '';
                                const text = link.textContent?.trim() || bubble.getAttribute('title') || '';
                                if (href && href.startsWith('http') && !href.includes('qianwen.com') && !href.includes('alicdn.com')) {
                                    refs.push({ url: href, title: text.slice(0, 100) });
                                }
                            }
                        }

                        return { refs, debugInfo };
                    });

                    if (searchReferences.debugInfo && searchReferences.debugInfo.length > 0) {
                        // logger.info('适配器', `DOM 调试信息: ${JSON.stringify(searchReferences.debugInfo.slice(0, 10))}`, meta);
                    }

                    if (searchReferences.refs && searchReferences.refs.length > 0) {
                        logger.info('适配器', `从 DOM 发现 ${searchReferences.refs.length} 条引用链接`, meta);
                        // 将 DOM 获取的 URL 合并到已收集的引用中
                        for (const ref of searchReferences.refs) {
                            if (!collectedReferences.some(r => r.url === ref.url)) {
                                collectedReferences.push(ref);
                            }
                        }
                    }

                    if (pageReply && typeof pageReply === 'string' && pageReply.trim().length > 20) {
                        const currentLength = pageReply.trim().length;

                        if (currentLength === lastContentLength) {
                            stableCount++;
                            if (stableCount >= 3) {
                                resultText = pageReply.trim();
                                logger.info('适配器', `从页面获取到稳定回复 (${resultText.length} 字符)`, meta);
                                break;
                            }
                        } else if (currentLength > lastContentLength) {
                            stableCount = 0;
                            lastContentLength = currentLength;
                            logger.debug('适配器', `内容增长中 (${currentLength} 字符)`, meta);
                        }
                    }
                } catch (e) {
                    // 页面评估失败，继续等待
                }
            }

            await sleep(200, 400);
        }

        // 额外等待检查
        if (!resultText || resultText.trim().length < 10) {
            logger.debug('适配器', '循环等待结束，额外等待 3 秒...', meta);
            await sleep(2500, 3500);

            try {
                const pageReply = await page.evaluate(() => {
                    const selectors = ['.chat-answer', '.answer-content', '.response-content', '.ai-message'];
                    for (const selector of selectors) {
                        const elements = document.querySelectorAll(selector);
                        for (const el of elements) {
                            const text = (el.textContent || '').trim();
                            if (text.length > 20) {
                                if (el.closest('[class*="user"]') || el.closest('[class*="input"]')) continue;
                                return text;
                            }
                        }
                    }
                    return null;
                });
                if (pageReply && pageReply.trim().length > 20) {
                    resultText = pageReply.trim();
                    logger.info('适配器', `最后一次尝试获取成功 (${resultText.length} 字符)`, meta);
                }
            } catch {}
        }

        // 清理监听器
        page.off('response', handleResponse);

        // 确保 resultText 是字符串
        if (typeof resultText !== 'string') {
            resultText = String(resultText || '');
        }

        if (!resultText || resultText.trim() === '') {
            logger.warn('适配器', '回复内容为空', meta);
            return { error: '回复内容为空' };
        }

        logger.info('适配器', `已获取文本内容 (${resultText.length} 字符)`, meta);

        // 拼接搜索引用到正文末尾
        let finalText = resultText.trim();
        if (collectedReferences.length > 0) {
            // 去重：基于 url
            const uniqueRefs = [];
            for (const ref of collectedReferences) {
                if (ref.url && !uniqueRefs.some(r => r.url === ref.url)) {
                    uniqueRefs.push(ref);
                }
            }

            if (uniqueRefs.length > 0) {
                const refsText = '\n\n---\n**参考资料：**\n' + uniqueRefs.map((ref, i) => {
                    const title = ref.title || ref.name || '';
                    const url = ref.url || '';
                    if (title && url) {
                        return `- [${i + 1}] ${title}: ${url}`;
                    } else if (url) {
                        return `- [${i + 1}] ${url}`;
                    } else {
                        // 没有 URL 时，显示来源名称
                        const sourceName = ref.title || ref.summary?.slice(0, 100) || '未知来源';
                        return `- [${i + 1}] ${sourceName}`;
                    }
                }).join('\n');
                finalText += refsText;
                logger.info('适配器', `已提取 ${uniqueRefs.length} 条搜索引用（含 URL）`, meta);
            }
        }

        logger.info('适配器', '文本生成完成，任务完成', meta);

        return { text: finalText };

    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    }
}

/**
 * 解析 SSE 响应
 * @param {string} body - SSE 响应体
 * @param {object} meta - 日志元数据
 * @returns {{text: string, complete: boolean, references: Array}}
 */
function parseSSEResponse(body, meta = {}) {
    let resultText = '';
    let isComplete = false;
    let references = [];  // 收集搜索引用

    const lines = body.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.substring(5).trim();
            if (!dataStr || dataStr === '[DONE]') {
                if (dataStr === '[DONE]') isComplete = true;
                continue;
            }

            try {
                const data = JSON.parse(dataStr);

                // 调试：记录引用相关的 SSE 数据结构
                // logger.debug('适配器', `SSE 引用数据: ${JSON.stringify(data).slice(0, 500)}`, meta);

                // 通义千问特有的格式: data.messages 数组
                if (data.data && data.data.messages && Array.isArray(data.data.messages)) {
                    for (const msg of data.data.messages) {
                        // 提取文本内容 (mime_type: multi_load/iframe) - 注意：content 是累积的完整内容
                        if (msg.mime_type === 'multi_load/iframe' && msg.content) {
                            resultText = msg.content;  // 直接赋值，不要追加
                        }

                        // 提取搜索引用 (mime_type: bar/iframe 或 bar/progress) - 包含完整 URL
                        if ((msg.mime_type === 'bar/iframe' || msg.mime_type === 'bar/progress') && msg.meta_data) {
                            // bar/iframe 格式: meta_data.sources[].content.list[]
                            if (msg.meta_data.sources && Array.isArray(msg.meta_data.sources)) {
                                for (const source of msg.meta_data.sources) {
                                    if (source.type === 'source' && source.content && source.content.list) {
                                        for (const item of source.content.list) {
                                            const url = item.url || item.raw_url || '';
                                            const title = item.title || item.name || '';
                                            const summary = item.summary || '';
                                            if (url && !references.some(r => r.url === url)) {
                                                references.push({ url, title, summary });
                                            }
                                        }
                                    }
                                }
                            }
                            // bar/progress 格式: meta_data.list[]
                            if (msg.meta_data.list && Array.isArray(msg.meta_data.list)) {
                                for (const item of msg.meta_data.list) {
                                    const url = item.url || item.raw_url || '';
                                    const title = item.title || item.name || '';
                                    const summary = item.summary || '';
                                    if (url && !references.some(r => r.url === url)) {
                                        references.push({ url, title, summary });
                                    }
                                }
                            }
                        }

                        // 完成标记 (status: finished)
                        if (msg.status === 'finished' || data.data.status === 'finished') {
                            isComplete = true;
                        }
                    }
                }

                // 通义千问可能的格式
                if (data.output && data.output.text) {
                    resultText += data.output.text;
                }
                if (data.text) {
                    resultText += data.text;
                }
                if (data.content) {
                    resultText += data.content;
                }
                if (data.delta && data.delta.content) {
                    resultText += data.delta.content;
                }

                // OpenAI 兼容格式
                if (data.choices && Array.isArray(data.choices)) {
                    for (const choice of data.choices) {
                        if (choice.delta && choice.delta.content) {
                            resultText += choice.delta.content;
                        }
                        if (choice.text) {
                            resultText += choice.text;
                        }
                        if (choice.finish_reason) {
                            isComplete = true;
                        }
                    }
                }

                // 完成标记
                if (data.is_end || data.done || data.finish || data.stop === true) {
                    isComplete = true;
                }

                // 提取搜索引用 - 通义千问可能的格式
                // 格式1: search_results / searchReferences / references 字段
                if (data.search_results && Array.isArray(data.search_results)) {
                    for (const ref of data.search_results) {
                        const url = ref.url || ref.link || '';
                        const title = ref.title || ref.name || '';
                        if (url && !references.some(r => r.url === url)) {
                            references.push({ title, url });
                        }
                    }
                }

                if (data.references && Array.isArray(data.references)) {
                    for (const ref of data.references) {
                        const url = ref.url || ref.link || '';
                        const title = ref.title || ref.name || '';
                        if (url && !references.some(r => r.url === url)) {
                            references.push({ title, url });
                        }
                    }
                }

                // 格式2: output 中包含引用
                if (data.output) {
                    if (data.output.search_results && Array.isArray(data.output.search_results)) {
                        for (const ref of data.output.search_results) {
                            const url = ref.url || ref.link || '';
                            const title = ref.title || ref.name || '';
                            if (url && !references.some(r => r.url === url)) {
                                references.push({ title, url });
                            }
                        }
                    }
                    if (data.output.references && Array.isArray(data.output.references)) {
                        for (const ref of data.output.references) {
                            const url = ref.url || ref.link || '';
                            const title = ref.title || ref.name || '';
                            if (url && !references.some(r => r.url === url)) {
                                references.push({ title, url });
                            }
                        }
                    }
                }

                // 格式3: data 中包含 web_search 或 source 相关字段
                if (data.web_search && data.web_search.results) {
                    for (const ref of data.web_search.results) {
                        const url = ref.url || ref.link || '';
                        const title = ref.title || ref.name || '';
                        if (url && !references.some(r => r.url === url)) {
                            references.push({ title, url });
                        }
                    }
                }

                // 格式4: sources 字段
                if (data.sources && Array.isArray(data.sources)) {
                    for (const ref of data.sources) {
                        const url = ref.url || ref.link || '';
                        const title = ref.title || ref.name || '';
                        if (url && !references.some(r => r.url === url)) {
                            references.push({ title, url });
                        }
                    }
                }

                // 调试：记录未知的数据结构
                if (Object.keys(data).length > 0 && !data.output && !data.text && !data.content && !data.delta && !data.choices && !data.search_results && !data.references && !data.web_search && !data.sources) {
                    logger.debug('适配器', `SSE 未知结构: ${JSON.stringify(data).slice(0, 200)}`, meta);
                }

            } catch {}
        }
    }

    if (references.length > 0) {
        logger.info('适配器', `SSE 解析发现 ${references.length} 条引用`, meta);
    }

    return { text: resultText, complete: isComplete, references };
}

/**
 * 解析 JSON 响应
 * @param {string} body - JSON 响应体
 * @param {object} meta - 日志元数据
 * @returns {{text: string, complete: boolean, references: Array}}
 */
function parseJsonResponse(body, meta = {}) {
    let resultText = '';
    let isComplete = false;
    let references = [];  // 收集搜索引用

    try {
        const data = JSON.parse(body);

        // 通义千问 API 响应格式
        if (data.output && data.output.text) {
            resultText = data.output.text;
            isComplete = true;
            // 提取 output 中的引用
            if (data.output.search_results && Array.isArray(data.output.search_results)) {
                for (const ref of data.output.search_results) {
                    const url = ref.url || ref.link || '';
                    const title = ref.title || ref.name || '';
                    if (url) references.push({ title, url });
                }
            }
            if (data.output.references && Array.isArray(data.output.references)) {
                for (const ref of data.output.references) {
                    const url = ref.url || ref.link || '';
                    const title = ref.title || ref.name || '';
                    if (url) references.push({ title, url });
                }
            }
        }
        if (data.result) {
            resultText = data.result;
            isComplete = true;
        }
        if (data.data && data.data.text) {
            resultText = data.data.text;
            isComplete = true;
        }
        if (data.content) {
            resultText = data.content;
            isComplete = true;
        }
        if (data.text) {
            resultText = data.text;
            isComplete = true;
        }

        // 提取顶层的搜索引用
        if (data.search_results && Array.isArray(data.search_results)) {
            for (const ref of data.search_results) {
                const url = ref.url || ref.link || '';
                const title = ref.title || ref.name || '';
                if (url) references.push({ title, url });
            }
        }
        if (data.references && Array.isArray(data.references)) {
            for (const ref of data.references) {
                const url = ref.url || ref.link || '';
                const title = ref.title || ref.name || '';
                if (url) references.push({ title, url });
            }
        }
        if (data.web_search && data.web_search.results && Array.isArray(data.web_search.results)) {
            for (const ref of data.web_search.results) {
                const url = ref.url || ref.link || '';
                const title = ref.title || ref.name || '';
                if (url) references.push({ title, url });
            }
        }
        if (data.sources && Array.isArray(data.sources)) {
            for (const ref of data.sources) {
                const url = ref.url || ref.link || '';
                const title = ref.title || ref.name || '';
                if (url) references.push({ title, url });
            }
        }

        // 调试：记录完整响应结构（可能包含引用）
        logger.debug('适配器', `JSON 响应结构: ${JSON.stringify(data).slice(0, 500)}`, meta);

    } catch {}

    if (references.length > 0) {
        logger.info('适配器', `JSON 解析发现 ${references.length} 条引用`, meta);
    }

    return { text: resultText, complete: isComplete, references };
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'qwen_text',
    displayName: '通义千问 (Qwen)',
    description: '使用阿里云通义千问生成文本。需要已登录的阿里云账户。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        { id: 'qwen-turbo', imagePolicy: 'optional', type: 'text' },
        { id: 'qwen-plus', imagePolicy: 'optional', type: 'text' },
        { id: 'qwen-max', imagePolicy: 'optional', type: 'text' },
        { id: 'qwen-max-longcontext', imagePolicy: 'optional', type: 'text' },
        { id: 'qwen-long', imagePolicy: 'optional', type: 'text' }
    ],

    navigationHandlers: [],

    generate
};