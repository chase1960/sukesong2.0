"""Pure evidence contracts. A valid quote is traceable, not proof of a candidate's ability."""
import hashlib
import json


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def criteria_rows(required, preferred):
    def array(value):
        return json.loads(value) if isinstance(value, str) else value
    return [{'id': 'c' + str(index + 1), 'criterion': value, 'required': required_}
            for index, (value, required_) in enumerate(
                [(v, True) for v in array(required)] + [(v, False) for v in array(preferred)])]


def validate_matrix(criteria, source, matrix):
    if not isinstance(source, str) or not source.strip() or len(source) > 100000:
        raise ValueError('原文必须为 1–100000 字符的人工核对文本')
    if not isinstance(matrix, list) or len(matrix) != len(criteria):
        raise ValueError('必须逐项覆盖岗位标准，缺证也须明确登记')
    expected = {row['id'] for row in criteria}
    seen = set()
    normalized = []
    for row in matrix:
        if not isinstance(row, dict) or set(row) - {'criterion_id', 'status', 'citations', 'question'}:
            raise ValueError('证据字段不合法')
        key, status = row.get('criterion_id'), row.get('status')
        if key not in expected or key in seen or status not in ('supported', 'contradictory', 'missing'):
            raise ValueError('证据条件重复、未知或状态无效')
        seen.add(key)
        citations = row.get('citations', [])
        if not isinstance(citations, list) or len(citations) > 5:
            raise ValueError('每项最多五条引用')
        if (status == 'missing' and citations) or (status != 'missing' and not citations):
            raise ValueError('有证据须引用，缺证不能伪造引用')
        quotes = []
        for citation in citations:
            if not isinstance(citation, dict):
                raise ValueError('引用必须为对象')
            start, end, quote = citation.get('start'), citation.get('end'), citation.get('quote')
            if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(source):
                raise ValueError('引用位置越界；位置按 Unicode 字符计算')
            if not isinstance(quote, str) or source[start:end] != quote or not quote.strip():
                raise ValueError('引用必须与原文逐字一致')
            quotes.append({'start': start, 'end': end, 'quote': quote})
        question = row.get('question', '')
        if not isinstance(question, str) or len(question) > 1000:
            raise ValueError('追问最多 1000 字')
        if status != 'supported' and not question.strip():
            raise ValueError('缺证或冲突须登记追问')
        normalized.append({'criterion_id': key, 'status': status, 'citations': quotes, 'question': question})
    return normalized


def review_snapshot(application, job, resume, rubric, criteria, rules):
    return {'application': application.name, 'application_revision': application.revision,
            'job': job.name, 'job_revision': job.revision, 'jd_revision': job.current_jd_revision,
            'rubric': rubric.name, 'rubric_revision': rubric.revision, 'criteria': criteria,
            'resume': resume.name, 'resume_revision': resume.revision, 'file_reference': resume.file_reference,
            'file_sha256': resume.file_sha256, 'rule_versions': rules}
