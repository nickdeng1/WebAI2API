/**
 * @fileoverview 文心一言 (Yiyan/ERNIE) 文本生成适配器
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
const TARGET_URL = 'https://yiyan.baidu.com/';

// 输入框可能的选择器列表 (按优先级排序)
const INPUT_SELECTORS = [
    'textarea.chat-input',
    'textarea.semi-input-textarea',
    'textarea[placeholder]',
    '.chat-input-container textarea',
    '.input-box textarea',
    'textarea',
    '[contenteditable="true"]',
    '.ProseMirror',
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

        // 检查是否有错误提示
        try {
            const errorText = await page.locator('text=/请登录|登录|Sign in|Login|系统繁忙/').first().textContent({ timeout: 3000 }).catch(() => null);
            if (errorText) {
                logger.warn('适配器', `检测到页面提示: ${errorText}`, meta);
                if (errorText.includes('登录') || errorText.includes('Sign in') || errorText.includes('Login')) {
                    return { error: '需要登录百度账户，请先在浏览器中登录文心一言' };
                }
                if (errorText.includes('繁忙')) {
                    return { error: '系统繁忙，请稍后再试' };
                }
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

            const textareaCount = await page.locator('textarea').count();
            const inputCount = await page.locator('input').count();
            const contenteditableCount = await page.locator('[contenteditable="true"]').count();
            logger.debug('适配器', `textarea=${textareaCount}, input=${inputCount}, contenteditable=${contenteditableCount}`, meta);

            return { error: '未找到输入框，请检查文心一言页面结构或是否已登录' };
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

        // 3. 启动 API 监听
        logger.debug('适配器', '启动网络请求监听...', meta);

        let resultText = '';
        let isComplete = false;
        let wsReceived = false;

        // 监听 WebSocket 消息
        page.on('websocket', ws => {
            logger.info('适配器', `发现 WebSocket: ${ws.url()}`, meta);
            ws.on('framereceived', frame => {
                try {
                    const payload = frame.payload;
                    if (payload && typeof payload === 'string') {
                        logger.debug('适配器', `WebSocket 消息: ${payload.substring(0, 500)}`, meta);
                        // 尝试解析 WebSocket 消息
                        try {
                            const data = JSON.parse(payload);
                            // 检查是否有文本内容
                            if (data.content || data.text || data.message) {
                                resultText += (data.content || data.text || data.message);
                                wsReceived = true;
                            }
                            // 检查是否有 SSE 格式数据
                            if (data.data && data.data.content) {
                                resultText += data.data.content;
                                wsReceived = true;
                            }
                        } catch {}
                    }
                } catch (e) {
                    logger.debug('适配器', `WebSocket 解析失败: ${e.message}`, meta);
                }
            });
        });

        // 监听所有响应，记录 API 端点
        const logAllResponses = (response) => {
            const url = response.url();
            const method = response.request().method();
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            if (method === 'POST' && status === 200 && (
                url.includes('yiyan') ||
                url.includes('chat') ||
                url.includes('completion') ||
                url.includes('stream')
            )) {
                logger.info('适配器', `发现 API: ${method} ${url} (${contentType.substring(0, 50)})`, meta);
            }
        };
        page.on('response', logAllResponses);

        // 监听 SSE 响应 - 文心一言使用 eb/chat/conversation/v2
        // 同时监听 history API 获取完整回复
        const handleResponse = async (response) => {
            const url = response.url();
            const method = response.request().method();
            const status = response.status();

            // 文心一言聊天 API: eb/chat/conversation/v2 (SSE)
            if (url.includes('eb/chat/conversation') && method === 'POST' && status === 200) {
                logger.info('适配器', `收到文心一言响应: ${url}`, meta);

                try {
                    const body = await response.text();
                    logger.info('适配器', `响应内容长度: ${body.length}`, meta);
                    if (body.length > 0) {
                        logger.debug('适配器', `响应内容预览: ${body.substring(0, 2000)}`, meta);
                    }

                    // 解析 SSE 响应
                    const parsed = parseResponse(body);
                    logger.debug('适配器', `解析结果: text=${parsed.text.length}字符, complete=${parsed.complete}`, meta);
                    if (parsed.text) {
                        resultText += parsed.text;
                    }
                    if (parsed.complete) {
                        isComplete = true;
                    }
                } catch (e) {
                    logger.warn('适配器', `响应解析错误: ${e.message}`, meta);
                }
            }

            // 监听 history API 获取完整回复
            if (url.includes('eb/chat/history') && method === 'POST' && status === 200) {
                logger.info('适配器', `收到 history 响应: ${url}`, meta);

                try {
                    const body = await response.text();
                    logger.info('适配器', `history 响应内容长度: ${body.length}`, meta);
                    if (body.length > 0) {
                        logger.debug('适配器', `history 响应内容预览: ${body.substring(0, 2000)}`, meta);
                    }

                    // 解析 history 响应获取 AI 回复
                    try {
                        const data = JSON.parse(body);
                        // history 响应结构: data.data.chats 是一个对象 (key: chatId, value: chat object)
                        if (data.data && data.data.chats) {
                            const chats = data.data.chats;
                            // 遍历所有聊天消息
                            for (const chatId of Object.keys(chats)) {
                                const chat = chats[chatId];
                                // 跳过用户消息
                                if (chat.role === 'user') continue;
                                // 提取 AI 回复 (role: "robot")
                                if (chat.role === 'robot' && chat.message && Array.isArray(chat.message)) {
                                    for (const msg of chat.message) {
                                        if (msg.contentType === 'text' && msg.content && msg.content.trim()) {
                                            resultText = msg.content;
                                            isComplete = true;
                                            logger.info('适配器', `从 history 获取到 AI 回复 (${resultText.length} 字符)`, meta);
                                        }
                                    }
                                }
                            }
                        }
                        // 兼容 chatList 数组格式 (备用)
                        if (data.data && data.data.chatList) {
                            for (const chat of data.data.chatList) {
                                if (chat.role === 'user') continue;
                                if (chat.message && Array.isArray(chat.message)) {
                                    for (const msg of chat.message) {
                                        if (msg.content && msg.content.trim()) {
                                            resultText = msg.content;
                                            isComplete = true;
                                            logger.info('适配器', `从 chatList 获取到回复`, meta);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        logger.warn('适配器', `history 解析失败: ${e.message}`, meta);
                    }
                } catch (e) {
                    logger.warn('适配器', `history 响应错误: ${e.message}`, meta);
                }
            }
        };
        page.on('response', handleResponse);

        // 4. 点击发送按钮
        logger.debug('适配器', '寻找发送按钮...', meta);

        const sendSelectors = [
            'button[type="submit"]',
            'button:has-text("发送")',
            'button[aria-label*="发送"]',
            'button[aria-label*="Send"]',
            'button[class*="send"]',
            'button.send-btn',
            '.chat-send-button',
        ];

        let sendClicked = false;
        for (const selector of sendSelectors) {
            try {
                const btn = page.locator(selector).first();
                const count = await btn.count();
                if (count > 0 && await btn.isVisible()) {
                    logger.info('适配器', `找到发送按钮，选择器: ${selector}`, meta);
                    await safeClick(page, btn, { bias: 'button' });
                    sendClicked = true;
                    break;
                }
            } catch (e) {
                logger.debug('适配器', `发送按钮选择器 ${selector} 失败: ${e.message}`, meta);
            }
        }

        if (!sendClicked) {
            logger.info('适配器', '未找到发送按钮，尝试多种发送方式...', meta);
            const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(modifierKey);
            await page.keyboard.press('Enter');
            await page.keyboard.up(modifierKey);
            await sleep(500, 800);
            await page.keyboard.press('Enter');
        }

        // 5. 等待响应 - 使用循环等待，等待内容稳定
        logger.info('适配器', '等待生成结果...', meta);

        // 循环等待，直到获取到内容且内容稳定或超时
        const maxWaitTime = Math.min(waitTimeout, 60000); // 最大等待 60 秒
        const startTime = Date.now();
        let lastContentLength = 0;
        let stableCount = 0; // 内容稳定的次数计数
        let lastCheckTime = 0;

        while (Date.now() - startTime < maxWaitTime) {
            const elapsed = Date.now() - startTime;

            // 每 500ms 检查一次
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
                        // 文心一言的回复结构：
                        // AI 消息通常在特定的容器中，排除用户输入区域
                        const selectors = [
                            // 文心一言特定选择器
                            '.chat-answer-content',
                            '.answer-content',
                            '[class*="answer"]',
                            '.chat-message-robot',
                            '[class*="robot-message"]',
                            '[class*="ai-reply"]',
                            '.chat-item-ai',
                        ];

                        for (const selector of selectors) {
                            try {
                                const elements = document.querySelectorAll(selector);
                                for (const el of elements) {
                                    const text = (el.textContent || '').trim();
                                    // 排除太短的内容和用户输入
                                    if (text.length > 20) {
                                        // 尝试排除用户消息区域
                                        if (el.closest('[class*="user"]') || el.closest('[class*="input"]')) continue;
                                        return text;
                                    }
                                }
                            } catch {}
                        }

                        // 通用方法：查找最新的聊天消息（排除用户输入框）
                        const chatContainers = document.querySelectorAll('[class*="chat-item"], [class*="message-item"]');
                        for (const container of chatContainers) {
                            // 跳过用户消息
                            if (container.className.toLowerCase().includes('user')) continue;
                            const text = (container.textContent || '').trim();
                            if (text.length > 30 && !text.includes('输入框') && !text.includes('发送')) {
                                return text;
                            }
                        }

                        return null;
                    });

                    if (pageReply && typeof pageReply === 'string' && pageReply.trim().length > 20) {
                        const currentLength = pageReply.trim().length;

                        // 检查内容是否稳定（不再增长）
                        if (currentLength === lastContentLength) {
                            stableCount++;
                            // 内容连续 3 次检查长度不变，认为生成完成
                            if (stableCount >= 3) {
                                resultText = pageReply.trim();
                                logger.info('适配器', `从页面获取到稳定回复 (${resultText.length} 字符, 稳定计数: ${stableCount})`, meta);
                                break;
                            }
                        } else if (currentLength > lastContentLength) {
                            // 内容还在增长，重置稳定计数
                            stableCount = 0;
                            lastContentLength = currentLength;
                            logger.debug('适配器', `内容增长中 (${currentLength} 字符)`, meta);
                        }
                    }
                } catch (e) {
                    // 页面评估失败，继续等待
                }
            }

            // 等待 300ms 后再次检查
            await sleep(200, 400);
        }

        // 如果循环等待后仍未获取内容，再等待一段时间让 history API 可能返回
        if (!resultText || resultText.trim().length < 10) {
            logger.debug('适配器', '循环等待结束，额外等待 3 秒检查 history...', meta);
            await sleep(2500, 3500);

            // 最后一次尝试从页面获取
            try {
                const pageReply = await page.evaluate(() => {
                    const selectors = ['.chat-answer-content', '.answer-content', '[class*="answer"]'];
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
        page.off('response', logAllResponses);

        // 确保 resultText 是字符串
        if (typeof resultText !== 'string') {
            resultText = String(resultText || '');
        }

        if (!resultText || resultText.trim() === '') {
            logger.warn('适配器', '回复内容为空', meta);
            return { error: '回复内容为空' };
        }

        logger.info('适配器', `已获取文本内容 (${resultText.length} 字符)`, meta);
        logger.info('适配器', '文本生成完成，任务完成', meta);

        return { text: resultText.trim() };

    } catch (err) {
        const pageError = normalizePageError(err, meta);
        if (pageError) return pageError;

        logger.error('适配器', '生成任务失败', { ...meta, error: err.message });
        return { error: `生成任务失败: ${err.message}` };
    }
}

/**
 * 解析响应体（支持 SSE 和 JSON 格式）
 * 文心一言格式：event:major + data:{createChatResponseVoCommonResult:{chat:{...}}}
 * AI 回复在 parentChat 或后续消息的 content 字段中
 * @param {string} body - 响应体
 * @returns {{text: string, complete: boolean}}
 */
function parseResponse(body) {
    let resultText = '';
    let isComplete = false;

    // 文心一言 SSE 格式
    if (body.includes('event:') && body.includes('data:')) {
        const lines = body.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // 解析 data 行
            if (trimmed.startsWith('data:')) {
                const dataStr = trimmed.substring(5).trim();
                if (!dataStr || dataStr === '[DONE]') {
                    if (dataStr === '[DONE]') isComplete = true;
                    continue;
                }

                try {
                    const data = JSON.parse(dataStr);

                    // 文心一言格式：data.createChatResponseVoCommonResult
                    if (data.data && data.data.createChatResponseVoCommonResult) {
                        const result = data.data.createChatResponseVoCommonResult.data;

                        // parentChat 是 AI 的回复容器
                        if (result.parentChat) {
                            const parentChat = result.parentChat;
                            // 检查 message 数组
                            if (parentChat.message && Array.isArray(parentChat.message)) {
                                for (const msg of parentChat.message) {
                                    if (msg.content) {
                                        resultText += msg.content;
                                    }
                                    if (msg.text) {
                                        resultText += msg.text;
                                    }
                                }
                            }
                            // 检查是否有完成标记
                            if (parentChat.stop || parentChat.mode === 'finish') {
                                isComplete = true;
                            }
                        }

                        // chat 是用户消息或后续 AI 消息
                        if (result.chat) {
                            const chat = result.chat;
                            // 跳过用户消息 (role: "user")
                            if (chat.role === 'robot' && chat.message) {
                                for (const msg of chat.message) {
                                    if (msg.content) {
                                        resultText += msg.content;
                                    }
                                }
                            }
                        }
                    }

                    // OpenAI 兼容格式 (备用)
                    if (data.choices && Array.isArray(data.choices)) {
                        for (const choice of data.choices) {
                            const delta = choice.delta;
                            if (delta && delta.content) {
                                resultText += delta.content;
                            }
                            if (choice.finish_reason) {
                                isComplete = true;
                            }
                        }
                    }

                    // 其他可能的格式
                    if (data.result && typeof data.result === 'string') {
                        resultText += data.result;
                    }
                    if (data.text) {
                        resultText += data.text;
                    }
                    if (data.content) {
                        resultText += data.content;
                    }

                    if (data.is_end || data.done || data.finish) {
                        isComplete = true;
                    }
                } catch {}
            }
        }
    } else if (body.includes('data:')) {
        // 简单 SSE 格式
        const lines = body.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
                const dataStr = trimmed.substring(5).trim();
                if (!dataStr) continue;
                try {
                    const data = JSON.parse(dataStr);
                    if (data.result) resultText += data.result;
                    if (data.text) resultText += data.text;
                    if (data.content) resultText += data.content;
                } catch {}
            }
        }
    } else {
        // 尝试纯 JSON 格式
        try {
            const data = JSON.parse(body);
            if (data.result) resultText += data.result;
            if (data.text) resultText += data.text;
            if (data.content) resultText += data.content;
        } catch {}

        // Connect RPC 格式备用
        let pos = 0;
        while (pos < body.length) {
            const braceIndex = body.indexOf('{', pos);
            if (braceIndex === -1) break;
            let depth = 0;
            let start = braceIndex;
            for (let i = braceIndex; i < body.length; i++) {
                if (body[i] === '{') depth++;
                else if (body[i] === '}') depth--;
                if (depth === 0) {
                    const jsonStr = body.substring(start, i + 1);
                    pos = i + 1;
                    try {
                        const data = JSON.parse(jsonStr);
                        if (data.heartbeat) continue;
                        if (data.block && data.block.text && data.block.text.content) {
                            resultText += data.block.text.content;
                        }
                    } catch {
                        pos = braceIndex + 1;
                    }
                    break;
                }
            }
        }
    }

    return { text: resultText, complete: isComplete };
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'yiyan_text',
    displayName: '文心一言 (ERNIE)',
    description: '使用百度文心一言生成文本。需要已登录的百度账户。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        { id: 'ernie-4.0', imagePolicy: 'optional', type: 'text' },
        { id: 'ernie-4.0-turbo', imagePolicy: 'optional', type: 'text' },
        { id: 'ernie-3.5', imagePolicy: 'optional', type: 'text' }
    ],

    navigationHandlers: [],

    generate
};