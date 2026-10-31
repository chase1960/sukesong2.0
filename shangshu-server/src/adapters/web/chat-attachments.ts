/**
 * 对话附件：从**前端报上来的文件引用**把内容读回来（PKG-024-T01，2026-10-22）。
 *
 * **权限照旧**：读字节走的是**既有的授权读口**（`file_content` 公共附件契约）——
 * 那条口在统一内核里核「当前身份对这条记录有读权 ＋ 文件确实挂在这条记录上 ＋ 字段级 read 闸」。
 * 本文件**不另设一套权限**，只是把那条口的结果分成两类：
 * · **图片** ⇒ 读回字节 ⇒ 交给模型**看**（`image_base64`）；
 * · **其它文件** ⇒ **只留引用**（`reference`）⇒ 内容**不进提示词**，由工具自己去读。
 *
 * **为什么非图片不给字节**：大文件塞进提示词会把请求撑爆（规范要求），
 * 而且文件域已经有正文/段落读口（`files.document_text`／`files.paragraphs`）——
 * 传引用、让工具读，就是复用那条既有路径，不造第二套。
 *
 * **读不到就明说**：每一份读不到的附件都要带**原因**进 `dropped`，
 * 让上层把「哪一份没进来」说给用户和模型听 —— 不许模型假装看过。
 */
import type { ChatAttachment } from '../../core/chat.ts';

/** 附件引用：文件挂在哪条记录上 ＋ 固定版本的原件引用。 */
export interface ChatAttachmentRef {
  ref_doctype: string;
  ref_name: string;
  file: string;
}

/** 读回来的附件：图片带字节，其它只带引用。 */
export interface ResolvedChatAttachment extends ChatAttachment {}

export interface ChatAttachmentResolution {
  attachments: ResolvedChatAttachment[];
  /** 读不到/不合规的附件：**必须带原因**（上层要明说）。 */
  dropped: { name: string; reason: string }[];
}

/** 一轮最多带几个附件。 */
export const MAX_CHAT_ATTACHMENTS = 8;
/**
 * 一张图最大多少**原始字节**。
 *
 * ⚠️ **这个数不是拍脑袋的**：模型出口（nginx 反代 `token-plan-cn.xiaomimimo.com`）
 * 把**请求体**限在 **4MB**（`client_max_body_size 4m`，3850 那套也一样）；
 * 图片进请求体是 **base64**（胀 4/3）⇒ 原始图片必须**比 4MB 小一截**，
 * 否则整轮对话会被出口挡掉（413），**连文字都发不出去**。
 * ⇒ 原始 2MB → base64 约 2.7MB，加上提示词仍在 4MB 以内。
 */
export const MAX_CHAT_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * 模型能「看」的图片类型（**实测过的**）。
 *
 * ⚠️ 只放**真的验过**的：PNG 实测能看（3850 的 `mimo-v2.6-pro` 正确读出图里的形状与颜色）。
 * JPG/JPEG 与 PNG 同属模型普遍支持的那一族；**TIFF/TIFF 不在列** ——
 * 文件域允许收，但模型那边不保证看得懂 ⇒ 那种只给引用，让工具去读。
 */
const VISION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
/** 内核回的 content-type 里，**只认这两个**是模型看得懂的图。 */
const VISION_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);

/** 由**原件名**推类型（不采信前端报的类型）；认不出来时用内核回的 content-type 兜底。 */
export function mimeOfFileName(name: string, contentType?: string): string {
  const ext = String(name || '').toLowerCase().split('.').pop() || '';
  const known = VISION_MIME[ext]
    || ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', xml: 'application/xml',
          zip: 'application/zip', tif: 'image/tiff', tiff: 'image/tiff' } as Record<string, string>)[ext];
  if (known) return known;
  const fallback = String(contentType || '').split(';')[0].trim().toLowerCase();
  return fallback || 'application/octet-stream';
}

/**
 * 这份原件**是不是模型看得懂的图**。
 *
 * ⚠️ **只能看原件名与内核给的类型** —— **不能看引用里的编号**：
 * `frappe_file` 是哈希编号（没有扩展名）⇒ 拿它判类型，**图永远认不出来**
 * （2026-10-22 隔离沙箱实测踩到：助手答「我看不到图像像素」，只按文件名猜的）。
 */
export function isVisionImage(name: string, contentType?: string): boolean {
  const ext = String(name || '').toLowerCase().split('.').pop() || '';
  if (VISION_MIME[ext]) return true;
  return VISION_CONTENT_TYPES.has(String(contentType || '').split(';')[0].trim().toLowerCase());
}

function isRef(value: unknown): value is ChatAttachmentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return ['ref_doctype', 'ref_name', 'file'].every(key => {
    const v = ref[key];
    return typeof v === 'string' && v.trim().length > 0 && v.length <= 140;
  });
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message || '读取失败').slice(0, 160);
}

/**
 * 把前端报上来的附件读回来。
 *
 * `deps.readFile` 就是**既有的授权读口**（`authorizedFileReaders.readFile`）：
 * 读不到就是读不到（权限/挂载/字段闸在那边判），本文件只负责如实记下原因。
 */
export async function resolveChatAttachments(raw: unknown, deps: {
  readFile: (ref: ChatAttachmentRef, verifyOnly?: boolean) => Promise<{ name: string; bytes: Buffer; contentType?: string }>;
}): Promise<ChatAttachmentResolution> {
  const attachments: ResolvedChatAttachment[] = [];
  const dropped: { name: string; reason: string }[] = [];
  if (!Array.isArray(raw) || !raw.length) return { attachments, dropped };
  const list = raw.slice(0, MAX_CHAT_ATTACHMENTS);
  if (raw.length > MAX_CHAT_ATTACHMENTS) {
    dropped.push({ name: '附件', reason: `一轮最多带 ${MAX_CHAT_ATTACHMENTS} 个附件，多出来的没有带入` });
  }
  for (const item of list) {
    const name = String((item as any)?.name || '').slice(0, 200) || '附件';
    if (!isRef((item as any)?.ref)) {
      dropped.push({ name, reason: '附件引用无效（要带文件编号与固定版本引用）' });
      continue;
    }
    const ref = (item as any).ref as ChatAttachmentRef;
    try {
      // ① **先只核读权**（不取字节）—— 顺便拿到**原件名**与**内核给的类型**。
      //    谁能读那个文件，谁才能从对话里看到它（这一道对图片也一样）。
      const probe = await deps.readFile(ref, true);
      const originalName = probe.name || name;
      const mime = mimeOfFileName(originalName, probe.contentType);
      if (!isVisionImage(originalName, probe.contentType)) {
        // ② 其它文件：**只给引用**，内容不进提示词（正文由工具去读）。
        attachments.push({ name: originalName, mime, reference: JSON.stringify(ref) });
        continue;
      }
      // ③ 图片：**取字节** ⇒ 模型自己看像素。
      const original = await deps.readFile(ref);
      const realName = original.name || originalName;
      const realMime = mimeOfFileName(realName, original.contentType || probe.contentType);
      if (!isVisionImage(realName, original.contentType || probe.contentType)) {
        // 原件名与类型对不上（不是模型看得懂的图）⇒ 降级成引用，不硬塞。
        attachments.push({ name: realName, mime: realMime, reference: JSON.stringify(ref) });
        continue;
      }
      if (original.bytes.length > MAX_CHAT_IMAGE_BYTES) {
        dropped.push({ name: realName, reason: `图片超过 ${Math.round(MAX_CHAT_IMAGE_BYTES / 1024 / 1024)}MB，没有带入` });
        continue;
      }
      attachments.push({ name: realName, mime: realMime, image_base64: original.bytes.toString('base64') });
    } catch (error) {
      dropped.push({ name, reason: reasonOf(error) });
    }
  }
  return { attachments, dropped };
}
