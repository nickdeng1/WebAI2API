/**
 * @fileoverview Kimi (月之暗面) 文本生成适配器
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
// Kimi 官网已迁移到 www.kimi.com
const TARGET_URL = 'https://www.kimi.com/';

// 输入框可能的选择器列表 (按优先级排序)
const INPUT_SELECTORS = [
    'textarea.chat-input',          // 类似 Doubao 的类名
    'textarea.semi-input-textarea', // Doubao 使用的类名
    'textarea[placeholder]',        // 有 placeholder 的 textarea
    '.chat-input-container textarea', // ZenMux 风格
    '.input-box textarea',          // 通用聊天输入框
    'textarea',                     // 最通用的 textarea
    '[contenteditable="true"]',     // contenteditable 元素
    '.ProseMirror',                 // zAI 风格
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
                // 检查是否可见
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
            const errorText = await page.locator('text=/System is currently busy|系统繁忙|请稍后再试|登录|Sign in|Login/').first().textContent({ timeout: 3000 }).catch(() => null);
            if (errorText) {
                logger.warn('适配器', `检测到页面提示: ${errorText}`, meta);
                if (errorText.includes('登录') || errorText.includes('Sign in') || errorText.includes('Login')) {
                    return { error: '需要登录 Kimi 账户，请先在浏览器中登录' };
                }
                if (errorText.includes('busy') || errorText.includes('繁忙')) {
                    return { error: 'Kimi 系统繁忙，请稍后再试' };
                }
            }
        } catch {}

        // 1. 查找输入框 (尝试多个选择器)
        logger.debug('适配器', '正在寻找输入框...', meta);
        let inputLocator = await findInputBox(page, meta);

        if (!inputLocator) {
            // 尝试截图调试
            logger.warn('适配器', '未找到输入框，尝试截图调试...', meta);
            try {
                const screenshot = await page.screenshot({ fullPage: false });
                logger.debug('适配器', `页面截图已保存 (${screenshot.length} bytes)`, meta);
            } catch (e) {
                logger.debug('适配器', `截图失败: ${e.message}`, meta);
            }

            // 打印页面 HTML 结构用于调试
            const htmlContent = await page.content();
            logger.debug('适配器', `页面 HTML 长度: ${htmlContent.length}`, meta);

            // 尝试获取所有 textarea 和 input 元素
            const textareaCount = await page.locator('textarea').count();
            const inputCount = await page.locator('input').count();
            const contenteditableCount = await page.locator('[contenteditable="true"]').count();
            logger.debug('适配器', `textarea=${textareaCount}, input=${inputCount}, contenteditable=${contenteditableCount}`, meta);

            return { error: '未找到输入框，请检查 Kimi 页面结构或是否已登录' };
        }

        // 2. 输入提示词
        logger.info('适配器', '输入提示词...', meta);

        // 尝试多种方式聚焦输入框
        try {
            // 方式1: 直接 focus
            await inputLocator.focus({ timeout: 10000 });
            logger.debug('适配器', '使用 focus() 聚焦输入框', meta);
        } catch (e) {
            logger.debug('适配器', `focus 失败: ${e.message}，尝试 force click`, meta);
            // 方式2: 强制点击
            try {
                await inputLocator.click({ force: true, timeout: 10000 });
            } catch (e2) {
                logger.warn('适配器', `force click 失败: ${e2.message}`, meta);
            }
        }

        await sleep(500, 800);
        await humanType(page, inputLocator, prompt);
        await sleep(300, 500);

        // 3. 启动 API 监听 (监控所有网络请求以找到正确的端点)
        logger.debug('适配器', '启动网络请求监听...', meta);

        let resultText = '';
        let isComplete = false;
        let foundApiEndpoint = null;

        // 监听所有响应，记录 API 端点
        const logAllResponses = (response) => {
            const url = response.url();
            const method = response.request().method();
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            // 只记录可能的 API 调用 (Kimi 使用 www.kimi.com/apiv2/)
            if (method === 'POST' && status === 200 && url.includes('kimi.com')) {
                logger.info('适配器', `发现 Kimi API: ${method} ${url} (${contentType.substring(0, 50)})`, meta);
                if (contentType.includes('event-stream') || contentType.includes('octet-stream')) {
                    foundApiEndpoint = url;
                }
            }
        };
        page.on('response', logAllResponses);

        // Kimi 使用 WebSocket 或 Connect RPC 流式传输，需要监听多种响应类型
        // Connect RPC 使用 application/connect+json 或 application/connect+proto
        const responsePromise = page.waitForResponse(async (response) => {
            const url = response.url();
            const method = response.request().method();
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            // 匹配 Kimi 的聊天 API (Connect RPC)
            // 主要端点: kimi.gateway.chat.v1.ChatService/Chat
            if (!url.includes('ChatService/Chat')) return false;
            if (method !== 'POST') return false;
            if (status !== 200) return false;

            logger.info('适配器', `匹配到 Connect RPC 响应: ${url}`, meta);
            logger.debug('适配器', `内容类型: ${contentType}`, meta);

            try {
                const body = await response.text();
                logger.info('适配器', `响应内容长度: ${body.length}`, meta);
                // 打印前2000字符用于调试
                if (body.length > 0) {
                    logger.debug('适配器', `响应内容预览: ${body.substring(0, 2000)}`, meta);
                }

                // Connect RPC 使用特殊的流式格式
                // 每行是一个 JSON 对象，带有特定字段
                const parsed = parseConnectRpcResponse(body);
                logger.debug('适配器', `解析结果: text=${parsed.text.length}字符, complete=${parsed.complete}`, meta);
                if (parsed.text) {
                    resultText = parsed.text;
                }
                if (parsed.complete) {
                    isComplete = true;
                }

                return isComplete;
            } catch (e) {
                logger.warn('适配器', `响应解析错误: ${e.message}`, meta);
                return false;
            }
        }, { timeout: waitTimeout });

        // 4. 点击发送按钮 (尝试多个选择器)
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
            // 如果找不到发送按钮，尝试多种发送方式
            logger.info('适配器', '未找到发送按钮，尝试多种发送方式...', meta);

            // 方式1: Ctrl/Cmd + Enter (某些编辑器使用此组合)
            const modifierKey = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(modifierKey);
            await page.keyboard.press('Enter');
            await page.keyboard.up(modifierKey);
            await sleep(500, 800);

            // 方式2: 普通 Enter
            await page.keyboard.press('Enter');
        }

        // 5. 等待响应 - 监听两种方式：API 响应和页面元素变化
        logger.info('适配器', '等待生成结果...', meta);

        // 方式1: 等待页面上的回复内容出现（更可靠）
        // Kimi 页面上显示回复后会有特定的元素结构
        const replyPromise = page.waitForFunction(() => {
            // 检查页面上是否有回复内容
            // Kimi 的回复通常在 message-item 或类似元素中
            const replyElements = document.querySelectorAll('[class*="message"], [class*="reply"], [class*="response"]');
            for (const el of replyElements) {
                // 跳过用户发送的消息（通常有 user 或 input 标识）
                if (el.className.includes('user') || el.className.includes('input')) continue;
                const text = el.textContent || '';
                // 检查是否有足够的文本内容（非空且不是 loading 提示）
                if (text.length > 10 && !text.includes('正在思考') && !text.includes('thinking') && !text.includes('...')) {
                    return text;
                }
            }
            return null;
        }, { timeout: waitTimeout }).catch(e => {
            logger.warn('适配器', `页面回复等待失败: ${e.message}`, meta);
            return null;
        });

        // 方式2: 等待 API 响应完成（作为补充）
        try {
            // 等待一段时间让 Kimi 生成响应
            const apiResult = await Promise.race([
                responsePromise,
                replyPromise.then(text => {
                    if (text) {
                        resultText = text;
                        isComplete = true;
                    }
                    return isComplete;
                })
            ]);

            if (isComplete && resultText) {
                logger.info('适配器', `从页面获取到回复内容 (${resultText.length} 字符)`, meta);
            }
        } catch (e) {
            // 检查页面上的回复内容
            const pageReply = await replyPromise;
            if (pageReply) {
                resultText = pageReply;
                logger.info('适配器', `从页面获取到回复内容 (${resultText.length} 字符)`, meta);
            } else {
                // 打印发现的 API 端点信息
                if (foundApiEndpoint) {
                    logger.info('适配器', `发现的 SSE 端点: ${foundApiEndpoint}`, meta);
                }
                page.off('response', logAllResponses);
                const pageError = normalizePageError(e, meta);
                if (pageError) return pageError;
                throw e;
            }
        }

        // 清理监听器
        page.off('response', logAllResponses);

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
 * 解析 SSE 响应体，提取最终文本
 * @param {string} body - SSE 响应体
 * @returns {{text: string, complete: boolean}}
 */
function parseSSEResponse(body) {
    const lines = body.split('\n');
    let resultText = '';
    let isComplete = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 解析 SSE 格式
        if (line.startsWith('data:')) {
            const dataStr = line.substring(5).trim();
            if (!dataStr || dataStr === '[DONE]' || dataStr === '{}') {
                if (dataStr === '[DONE]') {
                    isComplete = true;
                }
                continue;
            }

            try {
                const data = JSON.parse(dataStr);

                // OpenAI 兼容格式 (Kimi 可能使用)
                if (data.choices && Array.isArray(data.choices)) {
                    for (const choice of data.choices) {
                        const delta = choice.delta;
                        if (delta && delta.content) {
                            resultText += delta.content;
                        }
                        // 检查完成标记
                        if (choice.finish_reason) {
                            isComplete = true;
                        }
                    }
                }

                // 其他可能的格式
                if (data.text) {
                    resultText += data.text;
                }
                if (data.content) {
                    resultText += data.content;
                }
                if (data.message) {
                    resultText += data.message;
                }

                // 完成标记
                if (data.done === true || data.is_end === true || data.finish === true) {
                    isComplete = true;
                }

            } catch {
                // JSON 解析失败，跳过
            }
        }

        // 检查 event 行的完成标记
        if (line.startsWith('event:')) {
            const eventType = line.substring(6).trim();
            if (eventType === 'done' || eventType === 'end' || eventType === 'finish') {
                isComplete = true;
            }
        }
    }

    return { text: resultText, complete: isComplete };
}

/**
 * 解析 Connect RPC 响应体，提取最终文本
 * Connect RPC 格式：每个消息前有长度前缀（5字节不可见字符），然后是 JSON
 * Kimi 格式:
 *   {"op":"set", "mask":"block.text", "block":{"text":{"content":"你好"}}}
 *   {"op":"append", "mask":"block.text.content", "block":{"text":{"content":"！"}}}
 * @param {string} body - Connect RPC 响应体
 * @returns {{text: string, complete: boolean}}
 */
function parseConnectRpcResponse(body) {
    let resultText = '';
    let isComplete = false;

    // Connect RPC 流式响应包含长度前缀和 JSON 内容
    // 消息格式: [5字节长度][JSON对象][5字节长度][JSON对象]...
    // 我们需要找到所有 JSON 对象

    // 方法：找到所有 { 开始的位置，然后解析 JSON
    let pos = 0;
    while (pos < body.length) {
        // 找到下一个 { 的位置
        const braceIndex = body.indexOf('{', pos);
        if (braceIndex === -1) break;

        // 从这个位置尝试解析 JSON
        // JSON 对象可能很长，需要找到完整的 JSON
        let jsonStr = '';
        let depth = 0;
        let start = braceIndex;

        for (let i = braceIndex; i < body.length; i++) {
            const char = body[i];
            if (char === '{') depth++;
            else if (char === '}') depth--;

            if (depth === 0) {
                jsonStr = body.substring(start, i + 1);
                pos = i + 1;
                break;
            }
        }

        if (!jsonStr || depth !== 0) {
            pos = braceIndex + 1;
            continue;
        }

        try {
            const data = JSON.parse(jsonStr);

            // 跳过心跳消息
            if (data.heartbeat) continue;

            // Kimi 流式文本格式
            // 1. op="set" + mask="block.text" 初始化文本块
            // 2. op="append" + mask="block.text.content" 增量追加文本
            if (data.op === 'set' || data.op === 'append') {
                const block = data.block;
                if (block && block.text && block.text.content) {
                    resultText += block.text.content;
                }
            }

            // 检查消息状态完成
            if (data.message && data.message.status) {
                if (data.message.status === 'MESSAGE_STATUS_COMPLETED') {
                    // 如果是 assistant 消息完成，则标记完成
                    if (data.message.role === 'assistant') {
                        isComplete = true;
                    }
                }
            }

            // 旧的格式检查（备用）
            if (data.op === 'set' && data.message) {
                const message = data.message;
                if (message.text) resultText += message.text;
                if (message.content) resultText += message.content;
            }

        } catch (e) {
            // JSON 解析失败，跳过
            pos = braceIndex + 1;
        }
    }

    return { text: resultText, complete: isComplete };
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'kimi_text',
    displayName: 'Kimi (月之暗面)',
    description: '使用 Kimi 官网生成文本。需要已登录的 Kimi 账户。',

    getTargetUrl(config, workerConfig) {
        return TARGET_URL;
    },

    models: [
        { id: 'kimi-k1', imagePolicy: 'optional', type: 'text' },
        { id: 'kimi-k1.5', imagePolicy: 'optional', type: 'text' },
        { id: 'kimi-k2', imagePolicy: 'optional', type: 'text' }
    ],

    navigationHandlers: [],

    generate
};