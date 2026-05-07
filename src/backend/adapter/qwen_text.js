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
                    url.includes('conversation') || url.includes('qwen') || url.includes('tongyi')) {
                    logger.info('适配器', `发现 API: ${method} ${url} (${contentType.substring(0, 50)})`, meta);
                }
            }

            // SSE 响应处理
            if (contentType.includes('text/event-stream') || contentType.includes('application/stream+json')) {
                logger.info('适配器', `收到 SSE 响应: ${url}`, meta);
                try {
                    const body = await response.text();
                    const parsed = parseSSEResponse(body);
                    if (parsed.text) {
                        resultText += parsed.text;
                    }
                    if (parsed.complete) {
                        isComplete = true;
                    }
                } catch (e) {
                    logger.warn('适配器', `SSE 解析错误: ${e.message}`, meta);
                }
            }

            // JSON 响应处理
            if (contentType.includes('application/json') && method === 'POST' && status === 200) {
                if (url.includes('chat') || url.includes('completion') || url.includes('conversation')) {
                    logger.info('适配器', `收到 JSON 响应: ${url}`, meta);
                    try {
                        const body = await response.text();
                        const parsed = parseJsonResponse(body);
                        if (parsed.text) {
                            resultText = parsed.text;
                            isComplete = true;
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
 * 解析 SSE 响应
 * @param {string} body - SSE 响应体
 * @returns {{text: string, complete: boolean}}
 */
function parseSSEResponse(body) {
    let resultText = '';
    let isComplete = false;

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

            } catch {}
        }
    }

    return { text: resultText, complete: isComplete };
}

/**
 * 解析 JSON 响应
 * @param {string} body - JSON 响应体
 * @returns {{text: string, complete: boolean}}
 */
function parseJsonResponse(body) {
    let resultText = '';
    let isComplete = false;

    try {
        const data = JSON.parse(body);

        // 通义千问 API 响应格式
        if (data.output && data.output.text) {
            resultText = data.output.text;
            isComplete = true;
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

    } catch {}

    return { text: resultText, complete: isComplete };
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