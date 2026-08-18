/**
 * dsh-vision-edge-doubao — 豆包 Web 通道队列服务。
 *
 * 架构（借鉴 dsh-vision-web）：
 *   插件 host (DSH)                Windows 桥接 (node + puppeteer-core)
 *   ┌────────────────┐  :9340      ┌──────────────────────────────┐
 *   │ submit(图+提示) │ ◀──轮询───▶ │ /pending → CDP 驱动 Edge(9333)│
 *   │ 轮询 /job/:id   │             │ → 豆包发图 → 读回复 → /result │
 *   └────────────────┘             └──────────────────────────────┘
 * 队列监听 127.0.0.1，桥接主动轮询（Windows 侧无需暴露端口）。
 */

import { createServer } from "node:http";

export class WebVisionQueue {
  constructor(port = 9340) {
    this.port = port;
    this.jobs = new Map();
    this.jobCache = new Map();
    this.server = null;
  }

  start() {
    if (this.server) return;
    this.server = createServer((req, res) => this.#handle(req, res));
    this.server.listen(this.port, "127.0.0.1");
  }

  stop() {
    this.server?.close();
    this.server = null;
  }

  async #handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;
    const send = (code, obj) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 40 * 1024 * 1024) req.destroy(); });
      req.on("end", () => resolve(raw));
    });

    try {
      // DSH 插件提交任务
      if (path === "/submit" && req.method === "POST") {
        const body = JSON.parse(await readBody() || "{}");
        const id = String(body.id || `wv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        const images = Array.isArray(body.images) ? body.images : body.image ? [{ b64: body.image, mime: body.mime || "image/jpeg" }] : [];
        if (!images.length || !images[0].b64) return send(400, { error: "缺少图片" });
        this.jobs.set(id, {
          id,
          prompt: String(body.prompt || "请用中文描述图片内容"),
          images,
          model: body.model,
          createdAt: Date.now(),
          status: "pending"
        });
        return send(200, { id });
      }
      // DSH 插件取消任务（调用被中断/取消时，避免桥接继续把消息发送到豆包）
      if (path === "/cancel" && req.method === "POST") {
        const body = JSON.parse(await readBody() || "{}");
        const id = String(body.id || "");
        const job = this.jobs.get(id);
        if (job) {
          this.jobs.delete(id);
          return send(200, { ok: true, cancelled: true });
        }
        return send(404, { error: "任务不存在" });
      }
      // 桥接轮询待办
      if (path === "/pending" && req.method === "GET") {
        const pending = [...this.jobs.values()].filter((j) => j.status === "pending");
        const job = pending[0];
        if (job) job.status = "running";
        return send(200, job ? { id: job.id, prompt: job.prompt, images: job.images, model: job.model } : null);
      }
      // 桥接回写结果
      if (path === "/result" && req.method === "POST") {
        const body = JSON.parse(await readBody() || "{}");
        const job = this.jobs.get(String(body.id));
        if (!job) return send(404, { error: "任务不存在" });
        job.status = "done";
        job.result = body.error ? { error: String(body.error).slice(0, 4000) } : { text: String(body.text || "") };
        this.jobs.delete(job.id);
        this.jobCache.set(job.id, job);
        setTimeout(() => this.jobCache.delete(job.id), 30000);
        return send(200, { ok: true });
      }
      // DSH 插件轮询结果
      if (path.startsWith("/job/") && req.method === "GET") {
        const id = decodeURIComponent(path.slice(5));
        const job = this.jobCache.get(id) || this.jobs.get(id);
        if (!job) return send(404, { error: "任务不存在或已过期" });
        return send(200, { status: job.status, result: job.result || null });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: String(e?.message || e).slice(0, 500) });
    }
  }

  /** DSH 插件侧：提交任务并等待结果（轮询，最多 timeoutMs） */
  async recognize({ prompt, images, model, timeoutMs = 240000, signal }) {
    this.start();
    const id = `wv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const submit = await fetch(`http://127.0.0.1:${this.port}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, prompt, images, model })
      });
      if (!submit.ok) return { error: `web 通道提交失败: ${await submit.text()}` };
    } catch (e) {
      return { error: `web 通道队列不可达: ${String(e?.message || e).slice(0, 300)}` };
    }
    const startedAt = Date.now();
    const cancel = async () => {
      try {
        await fetch(`http://127.0.0.1:${this.port}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id })
        });
      } catch { /* 队列不可达时任务自然过期 */ }
    };
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) {
        await cancel();
        return { error: "已取消" };
      }
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/job/${id}`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) continue;
        const body = await res.json();
        if (body.status === "done" && body.result) {
          return body.result.error ? { error: body.result.error } : { text: body.result.text };
        }
      } catch { /* 服务暂不可用，重试 */ }
    }
    await cancel();
    return { error: "网页 AI 通道等待回复超时（请确认 Windows 桥接服务在运行且 Edge 已登录豆包）" };
  }
}
