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
const TARGET_URL = 'https://chat.baidu.com/';

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
            const errorText = await page.locator('text=/请登录|Sign in|Login|系统繁忙/').first().textContent({ timeout: 3000 }).catch(() => null);
            if (errorText) {
                logger.warn('适配器', `检测到页面提示: ${errorText}`, meta);
                if (errorText.includes('请登录') || errorText.includes('Sign in') || errorText.includes('Login')) {
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

        // 3. 启动 API 监听 - 使用 route 拦截 SSE 响应
        logger.debug('适配器', '启动网络请求监听...', meta);

        let resultText = '';
        let isComplete = false;
        let collectedReferences = [];
        let sseResolve = null;
        const ssePromise = new Promise(resolve => { sseResolve = resolve; });

        // 使用 page.route 拦截 SSE 响应并读取流
        await page.route('**/aichat/api/conversation**', async (route) => {
            try {
                const response = await route.fetch();
                const body = await response.text();
                logger.info('适配器', `route 拦截到 SSE 响应，长度: ${body.length}`, meta);

                // 解析 SSE 数据
                const parsed = parseResponse(body, meta);
                logger.info('适配器', `解析结果: text=${parsed.text.length}字符, references=${parsed.references.length}, complete=${parsed.complete}`, meta);
                if (parsed.text) resultText = parsed.text;
                if (parsed.references && parsed.references.length > 0) {
                    for (const ref of parsed.references) {
                        if (ref.url && !collectedReferences.some(r => r.url === ref.url)) {
                            collectedReferences.push(ref);
                        }
                    }
                }
                isComplete = true;
                if (sseResolve) { sseResolve(); sseResolve = null; }

                await route.fulfill({ response });
            } catch (e) {
                logger.warn('适配器', `route 拦截错误: ${e.message}`, meta);
                try { await route.continue(); } catch {}
            }
        });

        // 监听所有响应，记录 API 端点
        const logAllResponses = (response) => {
            const url = response.url();
            const method = response.request().method();
            const status = response.status();
            const contentType = response.headers()['content-type'] || '';

            if (method === 'POST' && status === 200 && (
                url.includes('chat') ||
                url.includes('completion') ||
                url.includes('stream')
            )) {
                logger.info('适配器', `发现 API: ${method} ${url} (${contentType.substring(0, 50)})`, meta);
            }
        };
        page.on('response', logAllResponses);

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

        // 5. 等待响应 - 等待 SSE route 拦截完成
        logger.info('适配器', '等待生成结果...', meta);

        // 等待 SSE 或超时
        const timeoutPromise = sleep(waitTimeout, waitTimeout + 1000).then(() => 'timeout');
        const raceResult = await Promise.race([ssePromise.then(() => 'sse'), timeoutPromise]);

        if (raceResult === 'sse') {
            logger.info('适配器', 'SSE 响应接收完成', meta);
        } else {
            logger.warn('适配器', '等待 SSE 超时', meta);
        }

        // 如果 SSE 没有获取到内容，尝试从页面 DOM 获取
        if (!resultText || resultText.trim().length < 10) {
            logger.debug('适配器', 'SSE 未获取到内容，尝试从 DOM 获取...', meta);
            await sleep(2000, 3000);

            try {
                const pageReply = await page.evaluate(() => {
                    const selectors = ['.chat-answer-content', '.answer-content', '[class*="answer"]', '[class*="msg-content"]', '[class*="response-content"]'];
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
                    logger.info('适配器', `从 DOM 获取到回复 (${resultText.length} 字符)`, meta);
                }
            } catch {}
        }

        // 清理监听器
        page.off('response', logAllResponses);
        try { await page.unroute('**/aichat/api/conversation**'); } catch {}

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
 * 解析 chat.baidu.com SSE 响应体
 * SSE 格式: event:message\ndata:{...}\n\n
 * 数据结构: data.data.message.content.generator.data.value = 增量 markdown 文本
 * 搜索引用: data.data.message.content.generator.data.searchCitations.list[]
 * @param {string} body - 响应体
 * @param {object} [meta={}] - 日志元数据
 * @returns {{text: string, complete: boolean, references: Array}}
 */
function parseResponse(body, meta = {}) {
    let resultText = '';
    let isComplete = false;
    const references = [];

    if (!body.includes('data:')) {
        return { text: resultText, complete: isComplete, references };
    }

    const lines = body.split('\n');
    let currentEvent = '';
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith('event:')) {
            currentEvent = trimmed.substring(6).trim();
            continue;
        }

        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.substring(5).trim();
        if (!dataStr || dataStr === '[DONE]') {
            if (dataStr === '[DONE]') isComplete = true;
            continue;
        }

        try {
            const data = JSON.parse(dataStr);

            // chat.baidu.com 格式: data.data.message.content.generator
            const message = data?.data?.message;
            if (message) {
                const content = message.content;
                if (content) {
                    // 提取 generator 数据
                    const generator = content.generator;
                    if (generator) {
                        // 调试：记录组件类型
                        if (generator.component) {
                            logger.debug('适配器', `SSE 组件: ${generator.component}`, meta);
                        }

                        // 只处理 markdown-yiyan 组件 (AI 的文本回复)
                        if (generator.component === 'markdown-yiyan') {
                            // 提取文本: generator.data.value (增量 markdown)
                            if (generator.data && typeof generator.data.value === 'string') {
                                resultText += generator.data.value;
                            }
                        }

                        // 从 thinkingSteps 组件提取搜索引用
                        if (generator.component === 'thinkingSteps' && generator.data) {
                            // referenceList 数组格式
                            if (generator.data.referenceList && Array.isArray(generator.data.referenceList)) {
                                for (const item of generator.data.referenceList) {
                                    const url = item.url || item.link || '';
                                    const title = item.title || item.name || '';
                                    const site = item.site || item.source || '';
                                    if (url && !references.some(r => r.url === url)) {
                                        references.push({ url, title, site });
                                    }
                                }
                            }
                            // referenceListArr 数组格式
                            if (generator.data.referenceListArr && Array.isArray(generator.data.referenceListArr)) {
                                for (const item of generator.data.referenceListArr) {
                                    if (typeof item === 'object') {
                                        const url = item.url || item.link || '';
                                        const title = item.title || item.name || '';
                                        const site = item.site || item.source || '';
                                        if (url && !references.some(r => r.url === url)) {
                                            references.push({ url, title, site });
                                        }
                                    }
                                }
                            }
                        }

                        // 检查完成标记
                        if (generator.isFinished === true) {
                            isComplete = true;
                        }
                    }
                }

                // 检查 metaData 中的状态
                if (message.metaData) {
                    if (message.metaData.state === 'complete-resp' || message.metaData.endTurn === true) {
                        isComplete = true;
                    }
                }
            }
        } catch {}
    }

    return { text: resultText, complete: isComplete, references };
}

/**
 * 适配器 manifest
 */
export const manifest = {
    id: 'yiyan_text',
    displayName: '百度AI聊天 (chat.baidu.com)',
    description: '使用百度AI聊天(chat.baidu.com)生成文本。需要已登录的百度账户。',

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