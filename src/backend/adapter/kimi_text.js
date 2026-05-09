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
    gotoWithCheck,
    waitApiResponse
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
            const errorText = await page.locator('text=/系统繁忙|请稍后再试|请登录|Sign in|Login/').first().textContent({ timeout: 3000 }).catch(() => null);
            if (errorText) {
                logger.warn('适配器', `检测到页面提示: ${errorText}`, meta);
                if (errorText.includes('请登录') || errorText.includes('Sign in') || errorText.includes('Login')) {
                    return { error: '需要登录 Kimi 账户，请先在浏览器中登录' };
                }
                if (errorText.includes('繁忙')) {
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

        // 2. 聚焦输入框
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

        // 3. 启动 API 监听 - 使用 waitApiResponse 被动等待完整响应
        logger.debug('适配器', '启动网络请求监听...', meta);

        // 先启动响应等待 (Promise)，再输入和发送
        const apiResponsePromise = waitApiResponse(page, {
            urlMatch: 'ChatService/Chat',
            method: 'POST',
            timeout: waitTimeout,
            meta
        });

        // 4. 输入提示词
        logger.info('适配器', '输入提示词...', meta);

        await sleep(500, 800);
        await humanType(page, inputLocator, prompt);
        await sleep(300, 500);

        // 5. 点击发送按钮 (尝试多个选择器)
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

        // 6. 等待响应
        logger.info('适配器', '等待生成结果...', meta);

        let resultText = '';
        let collectedReferences = [];

        try {
            const response = await apiResponsePromise;
            // Connect RPC 使用二进制前缀，必须用 body() 获取原始 Buffer
            // 不能用 text()，因为 UTF-8 解码会破坏二进制长度字段
            const bodyBuffer = await response.body();
            logger.info('适配器', `ConnectRPC 响应接收完成，长度: ${bodyBuffer.length}`, meta);

            // 解析 Connect RPC 响应
            const parsed = parseConnectRpcResponse(bodyBuffer, meta);
            logger.info('适配器', `解析结果: text=${parsed.text.length}字符, refs=${parsed.references.length}, complete=${parsed.complete}`, meta);
            resultText = parsed.text || '';
            collectedReferences = parsed.references || [];
        } catch (e) {
            if (e.message?.includes('API_TIMEOUT')) {
                logger.warn('适配器', '等待 ConnectRPC 超时', meta);
            } else {
                logger.warn('适配器', `等待 ConnectRPC 失败: ${e.message}`, meta);
            }
        }

        // 如果 API 响应没获取到内容，尝试从页面 DOM 获取
        if (!resultText || resultText.trim().length < 10) {
            logger.debug('适配器', 'ConnectRPC 未获取到内容，尝试从 DOM 获取...', meta);
            await sleep(2000, 3000);
            try {
                const pageReply = await page.evaluate(() => {
                    const replyElements = document.querySelectorAll('[class*="message"], [class*="reply"], [class*="response"]');
                    for (const el of replyElements) {
                        if (el.className.includes('user') || el.className.includes('input')) continue;
                        const text = el.textContent || '';
                        if (text.length > 10 && !text.includes('正在思考') && !text.includes('thinking')) {
                            return text;
                        }
                    }
                    return null;
                });
                if (pageReply && pageReply.trim().length > 20) {
                    resultText = pageReply.trim();
                    logger.info('适配器', `从 DOM 获取到回复 (${resultText.length} 字符)`, meta);
                }
            } catch {}
        }

        if (!resultText || resultText.trim() === '') {
            logger.warn('适配器', '回复内容为空', meta);
            return { error: '回复内容为空' };
        }

        logger.info('适配器', `已获取文本内容 (${resultText.length} 字符)`, meta);

        // 拼接搜索引用
        let finalText = resultText.trim();
        if (collectedReferences.length > 0) {
            const refsText = '\n\n---\n**参考资料：**\n' + collectedReferences.map((ref, i) => {
                const siteLabel = ref.site ? ` (${ref.site})` : '';
                return `- [${i + 1}] ${ref.title}${siteLabel}: ${ref.url}`;
            }).join('\n');
            finalText += refsText;
            logger.info('适配器', `已提取 ${collectedReferences.length} 条搜索引用`, meta);
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
 * 解析 Connect RPC 响应体，提取最终文本和搜索引用
 * Connect RPC streaming 格式: 每个消息 = 1字节flags + 4字节长度(N) + N字节JSON body
 * Kimi JSON 格式:
 *   {"op":"set", "mask":"block.text", "block":{"text":{"content":"你好"}}}
 *   {"op":"append", "mask":"block.text.content", "block":{"text":{"content":"！"}}}
 *   搜索引用: message.refs.searchChunks 中包含 url 和 title
 * @param {Buffer} buf - Connect RPC 原始响应 Buffer（由 response.body() 获取）
 * @param {object} [meta={}] - 日志元数据
 * @returns {{text: string, complete: boolean, references: Array}}
 */
function parseConnectRpcResponse(buf, meta = {}) {
    let resultText = '';
    let isComplete = false;
    const references = [];

    let offset = 0;
    let msgCount = 0;
    let skippedCount = 0;

    while (offset < buf.length - 5) {
        // 读取 5 字节前缀: 1字节 flags + 4字节消息长度 (big-endian)
        const flags = buf[offset];
        const msgLen = buf.readUInt32BE(offset + 1);

        // 合理性检查：消息长度不能超过剩余数据，且不能过大
        if (msgLen <= 0 || msgLen > buf.length - offset - 5 || msgLen > 10 * 1024 * 1024) {
            skippedCount++;
            offset++;
            continue;
        }

        const msgStart = offset + 5;
        const msgEnd = msgStart + msgLen;
        const jsonStr = buf.subarray(msgStart, msgEnd).toString('utf-8');
        msgCount++;

        try {
            const data = JSON.parse(jsonStr);
            if (!data.heartbeat) {
                // 提取文本内容
                if (data.op === 'set' || data.op === 'append') {
                    const block = data.block;
                    if (block) {
                        if (block.text && block.text.content) {
                            resultText += block.text.content;
                        }
                    }

                    // 从 message.refs.searchChunks 提取搜索引用
                    // Kimi 格式: data.message.refs.searchChunks[].base = { title, url, siteName }
                    if (data.message && data.message.refs) {
                        const refs = data.message.refs;
                        // searchChunks - 搜索结果列表
                        if (refs.searchChunks && Array.isArray(refs.searchChunks)) {
                            for (const chunk of refs.searchChunks) {
                                const base = chunk.base || chunk;
                                if (base.url && !references.some(r => r.url === base.url)) {
                                    references.push({
                                        url: base.url,
                                        title: base.title || base.name || '',
                                        site: base.siteName || base.site || ''
                                    });
                                }
                            }
                        }
                        // usedSearchChunks - 实际使用的引用
                        if (refs.usedSearchChunks && Array.isArray(refs.usedSearchChunks)) {
                            for (const chunk of refs.usedSearchChunks) {
                                const base = chunk.base || chunk;
                                if (base.url && !references.some(r => r.url === base.url)) {
                                    references.push({
                                        url: base.url,
                                        title: base.title || base.name || '',
                                        site: base.siteName || base.site || ''
                                    });
                                }
                            }
                        }
                    }
                }

                // 检查完成标记 - Kimi 的 role 可能不在同一条消息里
                if (data.message && data.message.status === 'MESSAGE_STATUS_COMPLETED') {
                    isComplete = true;
                }
            }
        } catch {
            // JSON 解析失败，跳过
        }

        offset = msgEnd;
    }

    logger.info('适配器', `ConnectRPC 解析统计: 总消息=${msgCount}, 跳过=${skippedCount}, 文本=${resultText.length}字符, 引用=${references.length}, complete=${isComplete}`, meta);

    return { text: resultText, complete: isComplete, references };
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
