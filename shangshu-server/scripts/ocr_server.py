"""ocr-service —— 尚书通用 OCR/抽取服务（spec §8）。

从 caizhengfa-tools 剥离：只留「文件 → 结构化字段 + 置信度 + 校验警告」。
- mock：按文件内容哈希派生一张 plausible 发票，演示链路用。
- dashscope / vllm / qwen-ocr：走 OpenAI 兼容协议调视觉大模型（qwen-vl / qwen-vl-ocr），按 INVOICE_EXTRACT_PROMPT 抽发票字段。

接口：
  GET  /health
  POST /extract   multipart: file, doc_type, provider, api_key, base_url, model
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI(title="shangshu ocr-service")

INVOICE_TYPES = ["普票", "专票", "电子普", "电子专", "其他"]

INVOICE_EXTRACT_PROMPT = """你是发票字段结构化抽取器。

任务：从下面这张发票图片中抽取字段，只返回 JSON，不要 markdown，不要解释。

规则：
1. invoice_type 从以下五选一：普票 / 专票 / 电子普 / 电子专 / 其他。
   - 增值税普通发票（纸质）= 普票；增值税专用发票（纸质）= 专票。
   - 数电普通发票 / 全电普通发票 / 电子普通发票 = 电子普；其对应的专用发票 = 电子专。
2. amount_ex_tax = 金额（不含税）；tax_amount = 税额；total_amount = 价税合计。单位元，数字。三者满足 total ≈ ex + tax。
3. issued_at = 开票日期，用 YYYY-MM-DD。
4. invoice_code / invoice_no（关键，按发票类型判断）：
   - 纸质发票：invoice_code = 发票代码（10 或 12 位数字）；invoice_no = 发票号码（通常 8 位数字）。
   - 数电 / 全电发票：**没有发票代码**，invoice_code 留空 ""；invoice_no = 发票号码，是 20 位连续数字，必须整体保留为单个字符串，绝不能拆成两段。
5. seller_name = 销售方名称；buyer_name = 购买方名称。
   数电发票布局：页面上半部分从左到右两栏，左栏标题「购买方信息」，右栏标题「销售方信息」。
   seller_name 只填右栏「销售方信息」下「名称：」后的公司名；buyer_name 只填左栏「购买方信息」下「名称：」后的公司名。
   纸质发票同理：先找「销售方」「购买方」文字标签所在的栏，再取栏内公司名。
   只认栏目标题的位置，绝不按公司名猜测、不按语义推断谁买谁卖。
6. 严禁把字段标签（如「价税合计」「销售方」「税额」「购买方」）当作数据填进去；提取不到的字段返回空字符串或 0，不要臆造。

只返回 JSON：
{
  "invoice_code": "",
  "invoice_no": "",
  "invoice_type": "普票",
  "seller_name": "",
  "buyer_name": "",
  "amount_ex_tax": 0,
  "tax_amount": 0,
  "total_amount": 0,
  "issued_at": "",
  "check_code": ""
}
"""


# ============== 校验警告（正则，只标黄不改值，复用 caizhengfa 思路）==============
def validate_invoice(f: dict[str, Any]) -> dict[str, str]:
    w: dict[str, str] = {}
    code = re.sub(r"\s+", "", str(f.get("invoice_code") or ""))
    no = re.sub(r"\s+", "", str(f.get("invoice_no") or ""))
    if code and not re.fullmatch(r"\d{10,12}", code):
        w["invoice_code"] = f"代码格式可能不对（{code}）"
    if no and not re.fullmatch(r"\d{6,9}|\d{20}", no):
        w["invoice_no"] = f"号码格式可能不对（{no}）"  # 纸质 6-9 位 / 数电全电 20 位均合法
    for k in ("amount_ex_tax", "tax_amount", "total_amount"):
        v = f.get(k)
        if isinstance(v, (int, float)) and v < 0:
            w[k] = f"{k} 为负数，请核实"
    d = str(f.get("issued_at") or "")
    if d and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
        w["issued_at"] = f"日期格式可能不对（{d}）"
    if not any([f.get("invoice_code"), f.get("invoice_no"), f.get("seller_name"), f.get("total_amount")]):
        w["_overall"] = "关键字段几乎全空，疑似非发票或识别失败，请人工核实"
    return w


def _confidence(f: dict[str, Any], w: dict[str, str]) -> float:
    # R3（2026-08-14）：放开上限，让「高置信」档真实存在——干净单据可达 0.95，
    # 供自动入账阈值（ocr.confidence_auto_book，默认 0.9）做分支；有警告/缺字段仍压回 0.8 以下。
    filled = sum(1 for v in (f.get("invoice_code"), f.get("invoice_no"), f.get("seller_name"),
                             f.get("total_amount"), f.get("issued_at")) if v)
    base = min(0.98, 0.55 + 0.08 * filled)
    if w:
        base = min(base, 0.8)
    return round(max(0.3, base), 2)


def _normalize(raw: dict[str, Any]) -> dict[str, Any]:
    def num(v):
        try:
            return float(str(v).replace(",", "").strip() or 0)
        except Exception:
            return 0
    t = str(raw.get("invoice_type") or "其他").strip()
    if t not in INVOICE_TYPES:
        t = "其他"
    return {
        "invoice_code": str(raw.get("invoice_code") or "").strip(),
        "invoice_no": str(raw.get("invoice_no") or "").strip(),
        "invoice_type": t,
        "seller_name": str(raw.get("seller_name") or "").strip(),
        "buyer_name": str(raw.get("buyer_name") or "").strip(),
        "amount_ex_tax": num(raw.get("amount_ex_tax")),
        "tax_amount": num(raw.get("tax_amount")),
        "total_amount": num(raw.get("total_amount")),
        "issued_at": str(raw.get("issued_at") or "").strip(),
        "check_code": str(raw.get("check_code") or "").strip(),
    }


# ============== mock：按文件哈希派生一张 plausible 发票 ==============
_MOCK_SELLERS = [
    ("永鑫钢铁有限公司", "南京建工集团有限公司", "专票"),
    ("蓝海制造科技有限公司", "银舟实业贸易有限公司", "电子普"),
    ("明远企业管理咨询中心", "银舟实业贸易有限公司", "普票"),
    ("恒泰贸易股份有限公司", "南京建工集团有限公司", "电子专"),
]


def _mock_extract(content: bytes, filename: str) -> dict[str, Any]:
    # 只按文件内容哈希派生：同内容 = 同发票号，便于演示去重（真实 OCR 读内容，本就如此）
    h = int(hashlib.md5(content).hexdigest(), 16)
    seller, buyer, itype = _MOCK_SELLERS[h % len(_MOCK_SELLERS)]
    seq = (h % 90000) + 10000
    total = ((h >> 8) % 9000 + 1000) * 10 + 80  # 一点零头
    tax = round(total / 1.13 * 0.13, 2)
    ex = round(total - tax, 2)
    code = f"03200{ (h % 900000):06d}"
    no = f"{ (h >> 4) % 100000000:08d}"
    return _normalize({
        "invoice_code": code, "invoice_no": no, "invoice_type": itype,
        "seller_name": seller, "buyer_name": buyer,
        "amount_ex_tax": ex, "tax_amount": tax, "total_amount": total,
        "issued_at": "2026-07-12", "check_code": "",
    })


# ============== real：级联抽取 ==============
# ① 数电 PDF 文字层 + 坐标确定性解析（不出错、零成本）
# ② 文字层在但版式不认得 → 文本模型（qwen3:8b）从纯文本抽字段
# ③ 无文字层（扫描件/照片/纸质票拍照）→ 视觉模型（qwen2.5vl:7b）位置锚定提示词
# 每层出口都过 _review_rules 复核（购销方一致性/金额勾稽），并记 ocr_path 供归因。

# 我方公司名（进项发票购买方应≈它）。单租户单部署，可用环境变量覆盖。
EXPECTED_BUYER = os.environ.get("SS_EXPECTED_BUYER", "")
# 文本复核/抽取模型（Ollama 上的文本模型）
TEXT_MODEL = os.environ.get("SS_TEXT_MODEL", "qwen3:8b")


def _text_layer(content: bytes) -> tuple[str, list, dict] | None:
    """PDF 文字层：返回 (全文, 带坐标块列表, 首页 rawdict)。无文字层/乱码率高 → None（判扫描件）。"""
    try:
        import fitz
        doc = fitz.open(stream=content, filetype="pdf")
        if len(doc) == 0:
            return None
        page = doc[0]
        text = "\n".join(doc[i].get_text() for i in range(min(len(doc), 2)))
        blocks = page.get_text("blocks")
        rawdict = page.get_text("rawdict")
        doc.close()
    except Exception:
        return None
    t = (text or "").strip()
    if len(t) < 100:
        return None
    # 乱码粗判：CJK+常用符号占比过低视为字体编码乱码
    cjk = sum(1 for c in t if "一" <= c <= "鿿")
    if cjk / max(len(t), 1) < 0.15:
        return None
    return text, blocks, rawdict


def _parse_railway(text: str) -> dict[str, Any] | None:
    """铁路电子客票：全国统一样式但与数电发票完全不同（无销售/购买方栏、无小写行）。"""
    if "铁路电子客票" not in text:
        return None
    f: dict[str, Any] = {"invoice_code": "", "check_code": "", "invoice_type": "电子普"}
    m = re.search(r"发票号码[:：]\s*(\d{20})", text)
    if not m:
        return None
    f["invoice_no"] = m.group(1)
    m = re.search(r"票价[:：]\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)", text) or re.search(r"[¥￥]\s*([\d,]+(?:\.\d+)?)", text)
    if not m:
        return None
    total = float(m.group(1).replace(",", ""))
    # 票面不单独印税额；按公司既有入账惯例：不含税=票价、税额=0（如要按 9% 抵扣由会计在飞书手调）
    f["total_amount"], f["amount_ex_tax"], f["tax_amount"] = total, total, 0
    # PDF 中文字体常把相邻数字抽成「2 0 2 6 年0 8 月2 4 日」。
    date_text = re.sub(r"(?<=\d)\s+(?=\d)", "", text)
    m = re.search(r"开票日期[:：]\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", date_text)
    if m:
        f["issued_at"] = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    # 购买方：「统一社会信用代码」前的公司名块；销售方优先取票面全称。
    m = re.search(r"([一-鿿（）()]{4,40})\s*\n?\s*统一社会信用代码", text)
    if m:
        f["buyer_name"] = m.group(1)
    seller = re.search(r"(?:^|\n)销售方(?:信息)?[：:]?[ \t]*\n[ \t]*([^\n]+)", text)
    seller_name = seller.group(1).strip() if seller else ""
    f["seller_name"] = seller_name if "中国铁路" in seller_name else ("中国铁路" if "中国铁路" in text else "")
    if not (f.get("buyer_name") and f.get("seller_name")):
        return None
    return _normalize(f)


def _parse_shudian(text: str, blocks: list, rawdict: dict) -> dict[str, Any] | None:
    """数电发票确定性解析：版式固定（左栏购买方/右栏销售方），按坐标归属，杜绝购销互换。"""
    norm = lambda s: re.sub(r"\s+", "", s)
    if "电子发票" not in norm(text):
        return None
    f: dict[str, Any] = {"invoice_code": "", "check_code": ""}
    f["invoice_type"] = "电子专" if "专用发票" in norm(text[:200]) else "电子普"
    m = re.search(r"发票号码[:：]?\s*(\d{20})", norm(text)) or re.search(r"(\d{20})", text)
    if not m:
        return None
    f["invoice_no"] = m.group(1)
    m = re.search(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", text)
    if m:
        f["issued_at"] = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    # 金额：优先扫「（小写）」之后；失败再扫全文（部分 PDF 合计行在小写标记之前）。
    # 在候选两位小数里找首个「等于另两个之和」的作为价税合计（顺序无关，勾稽验证）。
    def _find_amounts(seg: str, limit: int) -> bool:
        vals = [float(x.replace(",", "")) for x in re.findall(r"(\d[\d,]*\.\d{2})(?!\d)", seg)[:limit]]
        for i in range(len(vals)):
            others = [vals[j] for j in range(len(vals)) if j != i]
            for a in range(len(others)):
                for b in range(a + 1, len(others)):
                    if abs(vals[i] - others[a] - others[b]) < 0.02:
                        ex, tax = max(others[a], others[b]), min(others[a], others[b])
                        f["total_amount"], f["amount_ex_tax"], f["tax_amount"] = vals[i], ex, tax
                        return True
        return False
    m = re.search(r"[（(]\s*小写\s*[）)]", text)
    if not (_find_amounts(text[m.end():], 8) if m else False):
        if not _find_amounts(text, 14):
            return None
    # 购销方：「名称：」所在行 = 公司名行；按销售/购买标签列的 x 中分线归属（左=购买方，右=销售方）
    seller_x = buyer_x = None
    for b in blocks:
        nt = norm(b[4])
        if "销售方信息" in nt:
            seller_x = b[0]
        elif "购买方信息" in nt:
            buyer_x = b[0]
    if seller_x is None or buyer_x is None:
        return None
    name_ys = sorted({round(b[1]) for b in blocks if "名称：" in norm(b[4]) or "名称:" in norm(b[4])})
    if not name_ys:
        return None
    mids = (seller_x + buyer_x) / 2
    label_rects = [b[:4] for b in blocks if "销售方信息" in norm(b[4]) or "购买方信息" in norm(b[4])]
    LABEL_CHARS = set("购买方信息销售名称：:")

    def in_rect(cx: float, cy: float, r) -> bool:
        return r[0] - 2 <= cx <= r[2] + 2 and r[1] - 2 <= cy <= r[3] + 2

    # 字符级拆分：有的 PDF 把两栏公司名合并成一个文本块（块级分不开），按字符 x 坐标归列。
    # 标签字符（销售方信息/购买方信息/名称：）按「在标签矩形内 且 字符属于标签字符集」剔除，
    # 避免误伤与标签矩形轻微重叠的公司名首字。
    for row_y in name_ys:  # 可能有多个「名称：」（如项目名称），逐行试
        name_rects = [b[:4] for b in blocks
                      if ("名称：" in norm(b[4]) or "名称:" in norm(b[4])) and abs((b[1] + b[3]) / 2 - row_y) <= 14]
        excl = label_rects + name_rects
        left: list[tuple[float, str]] = []
        right: list[tuple[float, str]] = []
        for b in rawdict.get("blocks", []):
            for ln in b.get("lines", []):
                for sp in ln.get("spans", []):
                    cy = (sp["bbox"][1] + sp["bbox"][3]) / 2
                    if not (row_y - 4 <= cy <= row_y + 12):  # 与名称行同带
                        continue
                    for ch in sp.get("chars", []):
                        cx = (ch["bbox"][0] + ch["bbox"][2]) / 2
                        if ch["c"] in LABEL_CHARS and any(in_rect(cx, cy, r) for r in excl):
                            continue
                        (right if cx > mids else left).append((cx, ch["c"]))
        L = "".join(c for _, c in sorted(left)).lstrip("：:")
        R = "".join(c for _, c in sorted(right)).lstrip("：:")
        if L and R:
            f["buyer_name"], f["seller_name"] = L, R
            break
    if not (f.get("invoice_no") and f.get("total_amount") and f.get("seller_name") and f.get("buyer_name")):
        return None
    return _normalize(f)


TEXT_EXTRACT_PROMPT = """你是发票字段结构化抽取器。下面是发票 PDF 的文字层内容，从中抽取字段，只返回 JSON，不要 markdown，不要解释。
规则同视觉版：seller_name=销售方名称（「销售方信息」栏内），buyer_name=购买方名称（「购买方信息」栏内），只认栏目标题不按语义猜；
数电发票无发票代码留空；invoice_no 是 20 位连续数字不拆分；amount_ex_tax=金额（不含税），tax_amount=税额，total_amount=价税合计（小写）；issued_at=YYYY-MM-DD。
只返回 JSON：{"invoice_code":"","invoice_no":"","invoice_type":"电子普","seller_name":"","buyer_name":"","amount_ex_tax":0,"tax_amount":0,"total_amount":0,"issued_at":"","check_code":""}

发票文字层：
"""


def _to_png_images(content: bytes, mime: str) -> list[bytes]:
    """统一成 PNG 字节列表：PDF 按页栅格化（最多 3 页），图片原样返回。
    视觉模型（qwen2.5vl 等）只吃 png/jpg，不吃 PDF，故 PDF 必须先转图。"""
    is_pdf = mime == "application/pdf" or content[:4] == b"%PDF"
    if not is_pdf:
        return [content]
    try:
        import fitz  # pymupdf（纯 pip，无系统依赖）
    except ImportError:
        raise HTTPException(status_code=500, detail="PDF 解析需 pymupdf：pip install pymupdf")
    out: list[bytes] = []
    doc = fitz.open(stream=content, filetype="pdf")
    for i in range(min(len(doc), 3)):  # 发票一般 1 页，最多取 3 页避免 token 爆
        # dpi=200：300 会让 Ollama 视觉模型 400 拒收（超像素上限），200 是清晰度与可接受性的平衡点。
        out.append(doc[i].get_pixmap(dpi=200).tobytes("png"))
    doc.close()
    return out


def _chat(base_url: str, api_key: str, model: str, prompt: str, images: list[bytes] | None = None) -> str:
    """OpenAI 兼容 chat 调用，返回文本内容。"""
    import httpx
    content_parts: list[dict] = [{"type": "text", "text": prompt}]
    for img in images or []:
        b64 = base64.b64encode(img).decode()
        content_parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
    payload = {"model": model, "temperature": 0.0, "messages": [{"role": "user", "content": content_parts}]}
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    r = httpx.post(url, json=payload, headers=headers, timeout=180)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _json_from(text: str) -> dict[str, Any]:
    m = re.search(r"\{[\s\S]*\}", text or "")
    try:
        return json.loads(m.group(0)) if m else {}
    except Exception:
        return {}


def _review_rules(f: dict[str, Any], w: dict[str, str], expected_buyer: str = '') -> dict[str, Any]:
    """购销方与金额勾稽只给复核提示，不能把正常销项票自动翻成进项票。"""
    seller, buyer = f.get("seller_name", ""), f.get("buyer_name", "")
    exp = expected_buyer or EXPECTED_BUYER

    def is_us(name: str) -> bool:
        # 模糊匹配：发票上常印简称（如「南京市银聆科技」），去常见后缀后双向包含即算
        strip = lambda s: re.sub(r"(有限责任公司|股份有限公司|有限公司)$", "", s or "")
        a, b = strip(name), strip(exp)
        return bool(a) and len(a) >= 4 and (a in b or b in a)

    if exp and seller and buyer:
        if is_us(seller) and not is_us(buyer):
            w["seller_buyer"] = f"我方在销售方栏，可能为出项发票；请核对发票方向与购销方（保留原识别，未自动对调）"
        elif not is_us(buyer) and not is_us(seller):
            w["buyer_name"] = f"购买方与销售方均非「{exp}」，请人工核实"
        elif not is_us(buyer):
            w["buyer_name"] = f"购买方非「{exp}」，请人工核实"
    ex, tax, tot = f.get("amount_ex_tax", 0), f.get("tax_amount", 0), f.get("total_amount", 0)
    if tot and ex and abs(tot - ex - tax) > 0.02:
        w["total_amount"] = f"价税合计({tot}) ≠ 不含税({ex}) + 税额({tax})，请人工核实"
    return f


def _try_text_rule(content: bytes, mime: str) -> dict[str, Any] | None:
    is_pdf = mime == "application/pdf" or content[:4] == b"%PDF"
    if not is_pdf:
        return None
    layer = _text_layer(content)
    if not layer:
        return None
    text, blocks, rawdict = layer
    return _parse_railway(text) or _parse_shudian(text, blocks, rawdict)


def _try_text_llm(content: bytes, mime: str, *, base_url: str, api_key: str) -> dict[str, Any] | None:
    is_pdf = mime == "application/pdf" or content[:4] == b"%PDF"
    if not is_pdf:
        return None
    layer = _text_layer(content)
    if not layer:
        return None
    text, _, _ = layer
    try:
        out = _chat(base_url, api_key, TEXT_MODEL, TEXT_EXTRACT_PROMPT + text[:6000])
        f2 = _normalize(_json_from(out))
        if f2.get("invoice_no") or f2.get("seller_name"):
            return f2
    except Exception:
        pass
    return None


def _try_vision(content: bytes, mime: str, *, base_url: str, api_key: str, model: str) -> dict[str, Any]:
    images = _to_png_images(content, mime)
    if not images:
        raise HTTPException(status_code=400, detail="无法解析为图片（仅支持 png/jpg/pdf）")
    out = _chat(base_url, api_key, model, INVOICE_EXTRACT_PROMPT, images)
    return _normalize(_json_from(out))


def _extract_force_path(content: bytes, mime: str, force_path: str, *, base_url: str, api_key: str, model: str, require_key: bool = True) -> tuple[dict[str, Any], str]:
    """单路径抽取；无结果时 422，供办事流程逐步留痕。"""
    fp = force_path.strip()
    if fp == "text-rule":
        f = _try_text_rule(content, mime)
        if not f:
            raise HTTPException(status_code=422, detail="text-rule 无文字层或版式未匹配")
        return f, "text-rule"
    if require_key and not api_key:
        raise HTTPException(status_code=400, detail="云模型 api_key 为空，请在系统配置填 key；本地文字层解析不需要密钥")
    if fp == "text-llm":
        f = _try_text_llm(content, mime, base_url=base_url, api_key=api_key)
        if not f:
            raise HTTPException(status_code=422, detail="text-llm 未结构化出有效字段")
        return f, "text-llm"
    if fp == "vision":
        try:
            return _try_vision(content, mime, base_url=base_url, api_key=api_key, model=model), "vision"
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"vision 调用失败：{e}")
    raise HTTPException(status_code=400, detail=f"未知 force_path: {force_path}")


def _real_extract(content: bytes, mime: str, *, base_url: str, api_key: str, model: str, require_key: bool = True) -> tuple[dict[str, Any], str]:
    """级联抽取，返回 (fields, ocr_path)。"""
    f = _try_text_rule(content, mime)
    if f:
        return f, "text-rule"
    if require_key and not api_key:
        raise HTTPException(status_code=400, detail="云模型 api_key 为空，请在系统配置填 key；本地文字层解析不需要密钥")
    f = _try_text_llm(content, mime, base_url=base_url, api_key=api_key)
    if f:
        return f, "text-llm"
    return _try_vision(content, mime, base_url=base_url, api_key=api_key, model=model), "vision"


# ============== 路由 ==============
def _document_text(content: bytes, mime: str) -> dict[str, Any]:
    """读取普通 PDF 的真实文字层；不套用发票规则、不调用云模型。"""
    if mime != "application/pdf":
        raise HTTPException(status_code=422, detail="正文提取暂仅支持带文字层的 PDF，图片或扫描件需使用识别服务")
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="PDF 超过正文提取的 20 MB 限制")
    import fitz
    try:
        with fitz.open(stream=content, filetype="pdf") as document:
            if document.needs_pass:
                raise HTTPException(status_code=422, detail="无法读取加密 PDF，请先提供可读取的文件")
            pages = []
            text_length = 0
            for page in document:
                text = page.get_text("text").strip()
                text_length += len(text) + (1 if pages else 0)
                if text_length > 20000:
                    raise HTTPException(status_code=413, detail="PDF 正文超过 20000 字符，请拆分后读取；未返回截断内容")
                pages.append(text)
            raw_text = "\n".join(pages).strip()
    except HTTPException:
        raise
    except Exception as exc:
        # PyMuPDF 不同版本会抛 FileDataError 或底层 FzError；均不回传库内部错误。
        raise HTTPException(status_code=422, detail="PDF 损坏或无法读取其文字层") from exc
    if not raw_text:
        raise HTTPException(status_code=422, detail="PDF 没有可读取的文字层；扫描件需要识别服务，不会返回模拟正文")
    return {"fields": {}, "confidence": 1, "validation_warnings": {},
            "raw_text": raw_text, "ocr_path": "document-text"}


@app.get("/health")
def health():
    return {"ok": True, "service": "shangshu ocr-service"}


@app.post("/extract")
async def extract(
    file: UploadFile = File(...),
    doc_type: str = Form("invoice"),
    provider: str = Form("mock"),
    api_key: str = Form(""),
    base_url: str = Form("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    model: str = Form("qwen-vl-plus"),
    force_path: str = Form(""),
    expected_buyer: str = Form(""),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    if doc_type == "document_text":
        return JSONResponse(_document_text(content, file.content_type or ""))
    ocr_path = "mock"
    if provider == "mock":
        fields = _mock_extract(content, file.filename or "")
        raw_text = "[mock] 按文件哈希派生的示例发票字段"
        # 指定步骤不改变真实来源，模拟数据不能伪装成文字层或视觉抽取。
        ocr_path = "mock"
    elif provider in ("dashscope", "vllm", "qwen-ocr"):
        mime = file.content_type or "image/png"
        if force_path:
            fields, ocr_path = _extract_force_path(content, mime, force_path,
                                                    base_url=base_url, api_key=api_key, model=model, require_key=provider != 'vllm')
            raw_text = f"[real:{ocr_path}] 单路径抽取"
        else:
            fields, ocr_path = _real_extract(content, mime,
                                               base_url=base_url, api_key=api_key, model=model, require_key=provider != 'vllm')
            raw_text = f"[real:{ocr_path}] 级联抽取"
    else:
        raise HTTPException(status_code=400, detail=f"未知 provider: {provider}")

    warnings = validate_invoice(fields)
    if provider in ("dashscope", "vllm", "qwen-ocr"):
        fields = _review_rules(fields, warnings, expected_buyer)  # 仅提示，不自动对调购销方
    confidence = _confidence(fields, warnings)
    return JSONResponse({
        "fields": fields, "confidence": confidence,
        "validation_warnings": warnings, "raw_text": raw_text,
        "ocr_path": ocr_path if provider in ("dashscope", "vllm", "qwen-ocr") else ocr_path,
    })


if __name__ == "__main__":
    import uvicorn
    # 端口由父进程（core/infra/ocr.ts）经 PORT 环境变量下发；缺省 8001。
    # 双实例部署（如路演演示实例）用 runtime_config.ocr.port 避让端口冲突。
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8001")))
