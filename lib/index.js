/**
 * dsh-vision-edge-doubao — server half（纯 host 插件，零构建）。
 *
 * 提供 vision 工具（与原 dsh-vision-web 参数兼容），识图后端：
 *   - 通道：豆包 Web（Edge 调试实例 + bridge-edge.mjs 桥接，零成本免 API key）
 *   - 提示词：回答优先 + 数学建模图专项（几何/流程图/图表/表格/公式），见 prompt.js
 *   - 缓存：会话 evidence 记录（持久）+ 内存 LRU
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import {
  VISION_MODEL,
  VISION_PROMPT_VERSION,
  normalizeDetail,
  normalizeVisionMode,
  normalizeVisionResponse,
  buildVisionPrompt,
  visionCacheKey,
  sha256,
  makeVisionRecord,
  visionRecordText,
  visionRecordsFromMessages,
  findVisionRecord,
  VisionPromiseCache
} from "./prompt.js";
import { WebVisionQueue } from "./queue.js";

export const name = "dsh-vision-edge-doubao";
export const inject = ["tools", "sessions", "attachments"];

export const Config = z.object({
  defaultChannel: z.union([z.const("auto"), z.const("web")]).default("auto"),
  // 豆包 Web 通道（Edge 桥接）
  webChannel: z.object({
    enabled: z.boolean().default(true),
    queuePort: z.number().default(9340),
    timeoutMs: z.number().default(240000)
  }).default(),
  cacheMax: z.number().default(64),
  // 本地图片路径白名单（空 = 允许任意路径）
  allowedImageDirs: z.array(z.string()).default([])
});

function resolveChannel(cfg, requested) {
  const channel = String(requested || cfg.defaultChannel || "auto");
  if (channel === "auto") {
    return cfg.webChannel?.enabled !== false ? "web" : "web";
  }
  return channel;
}

function mimeForPath(imagePath) {
  const lower = String(imagePath).toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "image/jpeg";
}

function pathIsAllowed(cfg, imagePath) {
  const roots = Array.isArray(cfg.allowedImageDirs) ? cfg.allowedImageDirs.filter(Boolean) : [];
  if (!roots.length) return true;
  const candidate = realpathSync(imagePath);
  return roots.some((root) => {
    let resolvedRoot;
    try { resolvedRoot = realpathSync(root); } catch { resolvedRoot = resolve(root); }
    return candidate === resolvedRoot || candidate.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep);
  });
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

/** auto 档：先 standard triage，判 complex 则升级 deep（类似原插件，但回答始终走优化提示词） */
async function runAdaptiveVision(cfg, queue, detail, mode, prompt, region, images, signal) {
  const runOne = async (oneDetail, triage) => {
    const built = buildVisionPrompt({ detail: oneDetail, mode, userPrompt: prompt, region, imageCount: images.length, triage });
    const raw = await queue.recognize({
      prompt: built,
      images: images.map((img) => ({ b64: img.b64, mime: img.mime })),
      model: VISION_MODEL,
      timeoutMs: cfg.webChannel?.timeoutMs || 240000,
      signal
    });
    if (raw.error) return raw;
    const normalized = normalizeVisionResponse(raw.text);
    return {
      text: normalized.answer,
      evidence: normalized.evidence,
      clarify: normalized.clarify || [],
      complexity: normalized.complexity,
      structured: normalized.structured
    };
  };

  if (detail !== "auto") {
    const result = await runOne(detail, false);
    return { ...result, detail, mode, model: VISION_MODEL, escalated: false };
  }
  const first = await runOne("standard", true);
  if (first.error) return { ...first, detail: "auto", mode, model: VISION_MODEL, escalated: false };
  if (first.complexity !== "complex") {
    return { ...first, detail: "auto", mode, model: VISION_MODEL, escalated: false };
  }
  const deep = await runOne("deep", false);
  if (deep.error) {
    return { ...first, detail: "auto", mode, model: VISION_MODEL, escalated: false, escalationError: deep.error };
  }
  return { ...deep, detail: "auto", mode, model: VISION_MODEL, escalated: true };
}

function registerVisionTool(ctx, cfg, queue, visionCache) {
  const pluginName = "dsh-vision-edge-doubao";
  const run = async (args, exec) => {
    const prompt = String(args.prompt || "用中文详细描述图片内容").trim();
    const detail = normalizeDetail(args.detail);
    const mode = normalizeVisionMode(args.mode);
    const region = String(args.region || "").trim();
    const channel = resolveChannel(cfg, args.channel);

    const attachmentIds = uniqueStrings([args.attachment_id, ...(Array.isArray(args.attachment_ids) ? args.attachment_ids : [])]);
    const imagePaths = uniqueStrings([args.image_path, ...(Array.isArray(args.image_paths) ? args.image_paths : [])]);
    if (!attachmentIds.length && !imagePaths.length) return { error: "需要 attachment_id、attachment_ids、image_path 或 image_paths" };
    if (attachmentIds.length + imagePaths.length > 8) return { error: "一次最多处理 8 张图片" };
    if (mode === "compare" && attachmentIds.length + imagePaths.length < 2) return { error: "compare 模式至少需要 2 张图片" };
    if (mode === "region" && !region) return { error: "region 模式需要 region，例如 0.1,0.2,0.8,0.9" };

    // 收集会话附件引用与历史 evidence 记录
    const messages = exec.agent?.session?.deriveMessages() || [];
    const attachmentRefs = new Map();
    collectAttachmentRefs(messages, attachmentRefs);
    const records = visionRecordsFromMessages(messages, pluginName);
    const attachments = ctx.get("attachments");
    const images = [];

    for (const id of attachmentIds) {
      const ref = attachmentRefs.get(id);
      if (!attachments) return { error: "attachments 服务未就绪" };
      if (!ref) return { error: `当前会话里缺少附件 ${id} 的完整引用，请重新粘贴该图片` };
      try {
        const stored = await attachments.readImage(ref, exec.signal);
        const bytes = Buffer.from(stored.data);
        const canonicalRef = stored.ref || ref;
        attachmentRefs.set(id, canonicalRef);
        images.push({ id, b64: bytes.toString("base64"), mime: canonicalRef.mediaType || "image/jpeg", digest: sha256(bytes), ref: canonicalRef });
      } catch (error) {
        if (exec.signal.aborted) throw exec.signal.reason || error;
        return { error: `读取附件 ${id} 失败: ${String(error?.message || error).slice(0, 500)}` };
      }
    }
    for (const imagePath of imagePaths) {
      try {
        if (!pathIsAllowed(cfg, imagePath)) return { error: `图片路径超出 allowedImageDirs: ${imagePath}` };
        const bytes = readFileSync(imagePath);
        images.push({ id: `path:${resolve(imagePath)}`, b64: bytes.toString("base64"), mime: mimeForPath(imagePath), digest: sha256(bytes) });
      } catch (error) {
        return { error: `读取图片失败: ${String(error?.message || error).slice(0, 500)}` };
      }
    }

    const key = visionCacheKey({
      attachmentIds: images.map((image) => image.id),
      imageDigests: images.map((image) => image.digest),
      prompt,
      detail,
      mode,
      region,
      model: VISION_MODEL,
      channel
    });

    // 持久缓存：会话里已有同 key 的 evidence 记录 → 直接返回
    const durable = findVisionRecord(messages, key, pluginName);
    if (durable) {
      return {
        text: durable.answer,
        attachment_ids: durable.attachmentIds,
        cache_hit: true,
        model: durable.model,
        detail: durable.detail,
        mode: durable.mode,
        channel: durable.channel,
        escalated: Boolean(durable.escalated),
        clarify: durable.clarify || [],
        evidence_json: JSON.stringify(durable.evidence || {})
      };
    }

    // 内存缓存 + 执行
    const cached = visionCache.get(key);
    let outcome, cacheHit = false;
    if (cached) {
      outcome = await cached;
      cacheHit = true;
    } else {
      const pending = runAdaptiveVision(cfg, queue, detail, mode, prompt, region, images, exec.signal);
      visionCache.set(key, pending, cfg.cacheMax || 64);
      outcome = await pending;
      if (outcome.error) visionCache.delete(key);
    }
    if (outcome.error) return { error: outcome.error };

    const record = makeVisionRecord({
      key,
      attachmentIds: images.map((image) => image.id),
      attachmentRefs: images.map((image) => image.ref).filter(Boolean),
      imageDigests: images.map((image) => image.digest),
      prompt: prompt.slice(0, 12000),
      promptHash: sha256(prompt),
      model: outcome.model || VISION_MODEL,
      detail,
      mode,
      region,
      channel,
      escalated: Boolean(outcome.escalated),
      clarify: Array.isArray(outcome.clarify) ? outcome.clarify.slice(0, 3) : [],
      evidence: outcome.evidence || { summary: outcome.text },
      answer: String(outcome.text || "").slice(0, 20000)
    });
    exec.deferContext(createUserMessage({
      content: [{ type: "text", text: visionRecordText(record) }],
      source: {
        kind: "plugin",
        plugin: pluginName,
        form: "notice",
        summary: `视觉证据已记录：${record.attachmentIds.join(", ")}`.slice(0, 120)
      }
    }));
    return {
      text: record.answer,
      attachment_ids: record.attachmentIds,
      cache_hit: cacheHit,
      model: record.model,
      detail: record.detail,
      mode: record.mode,
      channel: record.channel,
      escalated: record.escalated,
      clarify: record.clarify,
      evidence_json: JSON.stringify(record.evidence)
    };
  };

  ctx.tools.register(defineTool({
    name: "vision",
    description: "用视觉模型（豆包 Web 通道）检查对话图片或本地图片。看到 [图片附件 attachment=...] 时调用；把用户本轮原话完整传入 prompt。单图用 attachment_id，多图用 attachment_ids。mode 可选 glance、ocr、region、compare、math（数学建模图专项：几何/流程图/图表/表格/公式）。detail 可选 auto、fast、standard、deep。返回的 clarify 字段是视觉模型提出的「需要向用户确认的问题」——若非空，用 ask_user_question 向用户提问澄清，用户回答后再结合补充信息重新调用 vision 以获得更精确的识别。",
    parameters: {
      attachment_id: { type: "string", description: "单个对话图片附件 id" },
      attachment_ids: { type: "array", items: { type: "string" }, description: "多个对话图片附件 id，顺序会保留" },
      image_path: { type: "string", description: "本地图片文件路径" },
      image_paths: { type: "array", items: { type: "string" }, description: "多个本地图片文件路径" },
      prompt: { type: "string", description: "理解要求；传入用户本轮完整原话，可附带用户已补充的澄清信息" },
      detail: { type: "string", enum: ["auto", "fast", "standard", "deep"], description: "思考档位，默认 auto" },
      mode: { type: "string", enum: ["glance", "ocr", "region", "compare", "math"], description: "任务模式，默认 glance；math=数学建模图专项" },
      region: { type: "string", description: "region 模式的区域，例如归一化坐标 0.1,0.2,0.8,0.9，或自然语言区域" },
      channel: { type: "string", enum: ["auto", "web"], description: "识图通道，默认 auto（豆包 Web）" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          text: { type: "string", required: true },
          attachment_ids: { type: "array", items: { type: "string" }, required: true },
          cache_hit: { type: "boolean", required: true },
          model: { type: "string", required: true },
          detail: { type: "string", required: true },
          mode: { type: "string", required: true },
          channel: { type: "string", required: true },
          escalated: { type: "boolean", required: true },
          clarify: { type: "array", items: { type: "string" }, required: true, description: "视觉模型提出的需要向用户确认的问题（可为空数组）" },
          evidence_json: { type: "string", required: true }
        },
        additionalProperties: false
      },
      render(_args, value) {
        return [{ type: "text", text: String(value.text) }];
      }
    },
    timeoutMs: 260000,
    async execute(args, exec) {
      const result = await run(args, exec);
      if (result.error) throw new Error(result.error);
      return result;
    }
  }));
  ctx.logger?.info("[dsh-vision-edge-doubao] vision 工具已注册（mode 含 math 专项）");
}

function collectAttachmentRefs(content, target) {
  for (const block of content || []) {
    if (block?.type === "image" && block.attachment?.attachmentId) {
      target.set(block.attachment.attachmentId, block.attachment);
    } else if (block?.type === "tool-result") {
      collectAttachmentRefs(block.content, target);
    }
  }
}

export function apply(ctx, config) {
  const cfg = { ...config, ...(config || {}) };
  const queue = new WebVisionQueue(cfg.webChannel?.queuePort || 9340);
  const visionCache = new VisionPromiseCache();
  try {
    registerVisionTool(ctx, cfg, queue, visionCache);
  } catch (e) {
    ctx.logger?.warn(`[dsh-vision-edge-doubao] vision 工具注册失败: ${e?.message}`);
  }
  ctx.effect(() => {
    queue.stop();
  }, "dsh-vision-edge-doubao: queue dispose");
}

export const __testing = Object.freeze({
  normalizeDetail,
  normalizeVisionMode,
  normalizeVisionResponse,
  buildVisionPrompt,
  visionCacheKey,
  makeVisionRecord,
  visionRecordText,
  visionRecordsFromMessages,
  findVisionRecord,
  VISION_PROMPT_VERSION
});
