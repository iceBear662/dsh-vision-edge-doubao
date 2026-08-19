// dsh-vision-edge-doubao 豆包桥接（Windows 侧运行，Edge 优先）
// 轮询队列 http://localhost:9340/pending → CDP 控制已登录 Edge → 豆包发图识图 → 回写结果
//
// 前置：先运行 start-vision-edge.ps1（启动 Edge 调试实例 9333），或手动：
//   msedge.exe --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir=%USERPROFILE%\.vision-edge-profile https://www.doubao.com/chat/
// 并在该 Edge 窗口登录一次豆包（登录态保存在独立 profile，重启不丢）。
import puppeteer from "puppeteer-core";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9333";
const QUEUE = process.env.QUEUE_URL || "http://localhost:9340";
const POLL_MS = 2000;
const REPLY_TIMEOUT_MS = 240000;
// 豆包回答模式：expert（专家，默认，更精准）| quick（快速）
const DOUBAO_MODE = process.env.DOUBAO_MODE || "expert";

let browser = null;

async function connect() {
	if (browser) {
		try {
			await browser.pages();
			return browser;
		} catch {
			browser = null;
		}
	}
	console.log("[bridge] 连接 Edge CDP:", CDP);
	browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
	console.log("[bridge] CDP 已连接");
	return browser;
}

async function getDoubaoPage() {
	const b = await connect();
	const pages = await b.pages();
	const page = pages.find((p) => p.url().includes("doubao.com/chat"))
		|| pages.find((p) => p.url().includes("doubao.com"));
	if (!page) {
		const fresh = await b.newPage();
		await fresh.goto("https://www.doubao.com/chat/", { waitUntil: "domcontentloaded", timeout: 60000 });
		await new Promise((r) => setTimeout(r, 8000));
		return fresh;
	}
	return page;
}

/** 上传图片：找 accept 含图片的隐藏 file input */
async function uploadImage(page, filePath) {
	const inputs = await page.$$('input[type="file"]');
	if (!inputs.length) throw new Error("豆包页面找不到文件上传入口");
	let target = null;
	for (const input of inputs) {
		const accept = await input.evaluate((el) => el.accept);
		if (/png|jpg|jpeg|webp/i.test(accept)) { target = input; break; }
	}
	if (!target) target = inputs[0];
	await target.uploadFile(filePath);
	await new Promise((r) => setTimeout(r, 5000));
}

/** 输入文字（豆包新版用 ProseMirror contenteditable，旧版用 textarea）。
 * 用 CDP Input.insertText 一次性插入整段文本，避免逐字符键盘输入导致的
 * 漏字/截断/顺序错乱；插入前清空输入框残留内容。
 * 注意：用 focus() 而非 click() —— 长会话页 DOM 较大时 click 触发的滚动/
 * 重渲染会让 CDP evaluate 挂起（实测复现过）。 */
async function typePrompt(page, text) {
	let ta = await page.$("textarea");
	if (!ta) ta = await page.$('[contenteditable="true"]');
	if (!ta) throw new Error("豆包输入框未找到（可能未登录或页面改版）");
	await page.evaluate((el) => el.focus(), ta);
	await new Promise((r) => setTimeout(r, 300));
	// 清空输入框残留（Ctrl+A + Backspace）
	await page.keyboard.down("Control");
	await page.keyboard.press("KeyA");
	await page.keyboard.up("Control");
	await page.keyboard.press("Backspace");
	await new Promise((r) => setTimeout(r, 300));
	// 一次性插入全文（不走逐字符事件）
	const cdp = await page.createCDPSession();
	await cdp.send("Input.insertText", { text });
	await new Promise((r) => setTimeout(r, 600));
}

/** 滚动消息列表到底部（豆包消息列表是虚拟滚动：发送后若不滚动，
 * 新消息/回复的行不会渲染，桥接就检测不到回复 —— 实测过的根因）。 */
async function scrollToBottom(page) {
	await page.evaluate(() => {
		const sc = document.querySelector('[class*="scroller"]');
		if (sc) sc.scrollTop = sc.scrollHeight;
		window.scrollTo(0, document.body.scrollHeight);
		const sc2 = document.querySelector('[class*="scroller"]');
		if (sc2) sc2.scrollTop = sc2.scrollHeight;
	});
}

/** 确保豆包处于指定回答模式（expert 专家 / quick 快速）。
 * 模式切换入口：输入框上方按钮栏的 mode-select 下拉（Radix menu）。
 * 流程：读当前模式 → 非目标模式则滚动按钮到视口中央 + 真实鼠标点击
 * 打开菜单（evaluate click 在按钮贴视口边缘时可能无效，实测踩过）→
 * 轮询等菜单出现 → 点目标项。任何失败都静默返回（不阻塞识图任务）。 */
async function ensureDoubaoMode(page) {
	if (!DOUBAO_MODE) return;
	const target = DOUBAO_MODE === "quick" ? "快速" : "专家";
	try {
		const current = await page.evaluate(() => {
			const el = document.querySelector('[data-valid-btn="mode-select-action-btn"]');
			return el ? (el.innerText || "").trim().split("\n")[0].trim() : "";
		});
		if (!current) return;
		if (current === target) {
			console.log(`[bridge] 豆包模式已是「${target}」，无需切换`);
			return;
		}

		// 滚动按钮到视口中央（按钮贴页面底部边缘时点击会失效）
		await page.evaluate(() => {
			const el = document.querySelector('[data-valid-btn="mode-select-action-btn"]');
			if (el) el.scrollIntoView({ block: "center", inline: "center" });
		});
		await new Promise((r) => setTimeout(r, 800));

		// 真实鼠标点击打开菜单（优先），失败再退 evaluate click
		const btn = await page.$('[data-valid-btn="mode-select-action-btn"]');
		let openedByMouse = false;
		if (btn) {
			const box = await btn.boundingBox();
			if (box) {
				await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
				openedByMouse = true;
			}
		}
		// 轮询等菜单打开
		let menuOpened = false;
		for (let i = 0; i < 6; i++) {
			await new Promise((r) => setTimeout(r, 500));
			menuOpened = await page.evaluate(() => {
				const el = document.querySelector('[data-valid-btn="mode-select-action-btn"]');
				const parent = el ? el.closest('[aria-expanded]') : null;
				return parent ? parent.getAttribute("data-state") === "open" : false;
			});
			if (menuOpened) break;
		}
		if (!menuOpened && !openedByMouse) {
			await page.evaluate(() => {
				document.querySelector('[data-valid-btn="mode-select-action-btn"]')?.click();
			});
			await new Promise((r) => setTimeout(r, 1500));
			menuOpened = await page.evaluate(() => {
				const el = document.querySelector('[data-valid-btn="mode-select-action-btn"]');
				const parent = el ? el.closest('[aria-expanded]') : null;
				return parent ? parent.getAttribute("data-state") === "open" : false;
			});
		}
		if (!menuOpened) {
			console.log(`[bridge] 豆包模式切换（${current} → ${target}）: 菜单未打开，跳过`);
			return;
		}

		// 按 aria-labelledby 定位菜单并点击目标模式
		const result = await page.evaluate((tgt) => {
			const tid = document.querySelector('[data-valid-btn="mode-select-action-btn"]')
				?.closest("[aria-haspopup]")?.id;
			if (!tid) return "no-trigger";
			const content = document.querySelector('[data-radix-menu-content][aria-labelledby="' + tid + '"]');
			if (!content) return "no-menu";
			const items = [...content.querySelectorAll('[role="menuitem"]')];
			const item = items.find((b) => (b.innerText || "").trim() === tgt);
			if (!item) return "no-item: " + items.map((i) => (i.innerText || "").trim()).join(",");
			item.click();
			return "clicked";
		}, target);
		console.log(`[bridge] 豆包模式切换（${current} → ${target}）: ${result}`);
		await new Promise((r) => setTimeout(r, 2000));
	} catch (e) {
		console.log(`[bridge] 豆包模式切换失败（忽略，继续任务）: ${String(e?.message || e).slice(0, 120)}`);
	}
}

/** 消息列表最后一个非空行文本（虚拟滚动下 = 最新渲染的消息行）。
 * 不依赖 justify-end/md-box 等易变特征。 */
async function lastMessageText(page) {
	return await page.evaluate(() => {
		const li = document.querySelector('[class*="list_items"]');
		if (!li) return "";
		const rows = [...li.children];
		for (let i = rows.length - 1; i >= 0; i--) {
			const t = (rows[i].innerText || "").trim();
			if (t) return t;
		}
		return "";
	});
}

/**
 * 发送后等待豆包回复完成（虚拟滚动兼容）。
 * 阶段 1（等新消息）：最后一行文本必须 != 发送前最后一行（beforeLast），
 * 确保新消息/新回复已渲染出来——否则会把上一任务的旧回复误当本次回复（实测踩过）。
 * 阶段 2（等稳定）：新内容连续两次相同即视为回复稳定，返回该文本。
 * 关键 1：任务提示词本身（用户消息）含「你是视觉识别专家」/「用户要求：」特征，
 * 若最后一行是用户消息（豆包尚未回复），跳过稳定计数，继续等待。
 * 关键 2（专家模式）：豆包专家模式先输出「思考块」再输出最终回答；思考块
 * 稳定后最终回答可能延迟 10-30 秒才渲染。通过「生成中指示」（停止按钮/
 * 思考中字样）判断是否仍在生成——生成中则重置稳定计数继续等待，
 * 避免把思考草稿当最终回答返回（实测踩过）。
 */
async function waitReply(page, beforeLast) {
	const startedAt = Date.now();
	let phase = "waitNew";
	let lastText = "";
	let stableCount = 0;
	const isUserMessage = (t) => t.includes("你是视觉识别专家") || t.includes("用户要求：");
	const isGenerating = async () => await page.evaluate(() => {
		// 停止/生成中按钮
		const stop = [...document.querySelectorAll("button")].find((b) =>
			/停止|stop/i.test((b.innerText || "") + (b.getAttribute("aria-label") || "")));
		if (stop) return true;
		// 思考中/生成中提示
		return /思考中|生成中|正在思考/.test((document.body.innerText || "").slice(-500));
	});
	while (Date.now() - startedAt < REPLY_TIMEOUT_MS) {
		await scrollToBottom(page);
		await new Promise((r) => setTimeout(r, 2500));
		const text = await lastMessageText(page);
		if (!text) continue;
		if (isUserMessage(text)) {
			// 最后一行仍是用户消息（任务 prompt），豆包还没开始回复——继续等
			lastText = text;
			stableCount = 0;
			continue;
		}
		if (await isGenerating()) {
			// 豆包仍在思考/生成（专家模式思考块稳定不代表完成）——重置稳定计数
			stableCount = 0;
			lastText = text;
			continue;
		}
		if (phase === "waitNew") {
			if (text !== beforeLast) {
				// 新内容出现（用户+回复一起渲染时，这里已是回复）
				phase = "watch";
				lastText = text;
				stableCount = 0;
			}
			continue;
		}
		if (text === lastText) {
			stableCount++;
			if (stableCount >= 2 && text.length > 5) return text;
		} else {
			stableCount = 0;
			lastText = text;
		}
	}
	throw new Error("等待豆包回复超时");
}

async function handleJob(job) {
	console.log(`[bridge] 处理任务 ${job.id}: ${job.prompt.slice(0, 50)}`);
	// 发送前确认任务未被取消（队列 /cancel 会删除任务）
	try {
		const check = await fetch(`${QUEUE}/job/${job.id}`, { signal: AbortSignal.timeout(5000) });
		if (!check.ok) {
			console.log(`[bridge] 任务 ${job.id} 已被取消，跳过发送`);
			return;
		}
	} catch { /* 队列暂不可达：继续处理，避免任务卡死 */ }
	const page = await getDoubaoPage();
	await page.bringToFront();
	// 图片写入 Windows 可见临时目录
	const fs = await import("node:fs");
	const path = await import("node:path");
	const stamp = `${job.id}-${job.images.length}`;
	const filePaths = [];
	for (let i = 0; i < job.images.length; i++) {
		const img = job.images[i];
		const ext = img.mime === "image/png" ? ".png" : img.mime === "image/webp" ? ".webp" : ".jpg";
		const p = `C:\\Temp\\doubao-bridge\\img-${stamp}-${i}${ext}`;
		fs.writeFileSync(p, Buffer.from(img.b64, "base64"));
		filePaths.push(p);
	}
	try {
		// 发送前确保豆包处于目标回答模式（专家/快速）
		await ensureDoubaoMode(page);
		// 发送前最后一行（用于判断新消息是否渲染出现）
		const beforeLast = await lastMessageText(page);
		for (const p of filePaths) await uploadImage(page, p);
		// 完整任务提示词（含数学建模专项要点），不再截断到 200 字符
		const question = job.prompt.slice(0, 4000);
		await typePrompt(page, question);
		await page.keyboard.press("Enter");
		console.log("[bridge] 已发送，等待豆包回复…");
		const reply = await waitReply(page, beforeLast);
		console.log(`[bridge] 回复完成 (${reply.length} 字): ${reply.slice(0, 60)}…`);
		await fetch(`${QUEUE}/result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: job.id, text: reply })
		});
	} catch (e) {
		console.log(`[bridge] 任务 ${job.id} 失败: ${String(e?.message || e).slice(0, 200)}`);
		await fetch(`${QUEUE}/result`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: job.id, error: String(e?.message || e).slice(0, 1000) })
		});
	} finally {
		for (const p of filePaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
	}
}

async function main() {
	console.log("[bridge] dsh-vision-edge-doubao 豆包桥接启动, 队列:", QUEUE);
	// 启动时自检 CDP 连通性
	try {
		const b = await connect();
		await b.disconnect();
		console.log("[bridge] Edge CDP 连通 ✅");
	} catch (e) {
		console.log("[bridge] ⚠️ Edge CDP 不可连:", String(e?.message || e).slice(0, 120));
		console.log("[bridge] 请先运行 start-vision-edge.ps1 启动 Edge 调试实例并登录豆包");
	}
	for (;;) {
		try {
			const res = await fetch(`${QUEUE}/pending`, { signal: AbortSignal.timeout(8000) });
			if (res.ok) {
				const job = await res.json();
				if (job && job.id) {
					await handleJob(job);
					continue;
				}
			}
		} catch (e) {
			console.log("[bridge] 队列不可达:", String(e?.message || e).slice(0, 80));
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
}

main().catch((e) => {
	console.error("[bridge] 致命错误:", e);
	process.exit(1);
});
