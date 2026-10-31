"""Managed PDF page images. No original-byte response, path input, or shared cache."""
import base64
import json
import subprocess
import sys

MAX_BYTES = 20 * 1024 * 1024
MAX_PAGES = 2000
MAX_EDGE = 1800
MAX_PIXELS = 2400000


def render_page(content, page):
    """Worker-only renderer; all native handles close even on malformed content."""
    import math
    import pypdfium2 as pdfium
    if not isinstance(content, bytes) or not content or len(content) > MAX_BYTES:
        raise ValueError('PDF 文件为空或超过20MB预览范围')
    if isinstance(page, bool) or not isinstance(page, int) or page < 1:
        raise ValueError('PDF 页码无效')
    document = pdfium.PdfDocument(content)
    try:
        count = len(document)
        if not 1 <= count <= MAX_PAGES or page > count:
            raise ValueError('PDF 页码或总页数超出预览范围')
        sheet = document[page - 1]
        try:
            width, height = sheet.get_size()
            if not all(math.isfinite(x) and x > 0 for x in (width, height)):
                raise ValueError('PDF 页面尺寸无效')
            scale = min(1.5, MAX_EDGE / max(width, height), math.sqrt(MAX_PIXELS / (width * height)))
            bitmap = sheet.render(scale=scale, rotation=0)
            try:
                from io import BytesIO
                image = bitmap.to_pil()
                try:
                    output = BytesIO(); image.save(output, format='PNG')
                    return {'page': page, 'page_count': count, 'width': image.width, 'height': image.height,
                            'mime_type': 'image/png', 'image_base64': base64.b64encode(output.getvalue()).decode('ascii')}
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            sheet.close()
    finally:
        document.close()


def isolated_page(content, page):
    if not isinstance(content, bytes) or not content or len(content) > MAX_BYTES:
        raise ValueError('PDF 文件为空或超过20MB预览范围')
    try:
        response = subprocess.run([sys.executable, '-m', 'shangshu_core.pdf_preview', str(page)],
                                  input=content, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                  timeout=20, check=False)
        if response.returncode or len(response.stdout) > 16 * 1024 * 1024:
            raise ValueError('PDF 页面无法渲染，请核对文件或稍后重试')
        result = json.loads(response.stdout)
        if result.get('mime_type') != 'image/png':
            raise ValueError('PDF 页面渲染回执无效')
        return result
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as error:
        raise ValueError('PDF 页面预览暂不可用，请稍后重试') from error


def preview(_service, payload, _context):
    import frappe
    from shangshu_core.attachments import get_record_attachments
    from shangshu_core.org_admin import preview_allows
    from shangshu_core.public_api.http import _field_acl_gate
    from shangshu_core.field_access import check_content_ready
    doctype, name, file_id = (payload[key] for key in ('ref_doctype', 'ref_name', 'file'))
    get_record_attachments(doctype, name, [file_id])
    if preview_allows(frappe.session.user, name) is False:
        frappe.throw('无权预览该记录附件', frappe.PermissionError)
    _field_acl_gate(doctype, name, file_id)
    check_content_ready(doctype, name, file_id)
    file = frappe.get_doc('File', file_id)
    if not (file.file_name or '').lower().endswith('.pdf'):
        frappe.throw('该附件不是 PDF 文件', frappe.ValidationError)
    page = payload.get('page', 1)
    if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= MAX_PAGES:
        frappe.throw('PDF 页码无效', frappe.ValidationError)
    try:
        return isolated_page(file.get_content(), page)
    except ValueError as error:
        frappe.throw(str(error), frappe.ValidationError)


if __name__ == '__main__':
    # Native parsing is isolated from the web worker and receives only controlled bytes.
    try:
        import resource
        if sys.platform.startswith("linux"):
            resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
        content = sys.stdin.buffer.read(MAX_BYTES + 1)
        sys.stdout.write(json.dumps(render_page(content, int(sys.argv[1]))))
    except Exception:
        sys.exit(1)
