/* 日常表格值的整包确认：只读预览/读回，执行仍由原resolve入口负责。 */
(() => {
  const MAX_CELLS = 2000, PAGE_SIZE = 25;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const scalar = value => value === null || ['string','boolean'].includes(typeof value)
    || typeof value === 'number' && Number.isFinite(value);
  const text = value => value === null ? '空' : value === true ? '是' : value === false ? '否' : String(value);
  const same = (a, b) => typeof a === typeof b && a === b;
  const list = values => [...new Set(values)];
  const requireValue = (condition, message) => { if (!condition) throw Error(message); };

  window.createTableValueConfirmationPresenters = function({request, changed = () => {}}) {
    const restored = new WeakMap(), snapshots = new WeakMap();
    const json = async (path, init) => {
      const data = await request(path, init);
      if (!object(data) || data.ok === false || data.error) throw Error(data?.error || '核对数据读取失败');
      return data;
    };
    const service = async (id, payload) => {
      const data = await json('api/platform/services/' + id + '/invoke', {
        method:'POST', headers:{'content-type':'application/json'}, cache:'no-store', body:JSON.stringify({payload})});
      return data.result || data;
    };
    async function payload(confirm) {
      if (object(confirm.payload)) return confirm.payload;
      if (!restored.has(confirm)) {
        const data = await service('platform.action_proposal.values', {proposal_id:confirm.id});
        requireValue(data.id === confirm.id && data.capability === confirm.capability && object(data.payload),
                     '候选内容与原提案不一致，请重新读取');
        restored.set(confirm, data.payload);
      }
      return restored.get(confirm);
    }
    function plan(confirm, p) {
      requireValue(typeof p.object_id === 'string' && p.object_id, '表格引用不完整，请重新读取');
      const companion = confirm.capability === 'platform.object.companion_write';
      const cells = [], names = [], headers = [], rowVersions = new Map();
      if (companion) {
        requireValue(typeof p.file_id === 'string' && p.file_id && typeof p.definition_revision === 'string'
          && p.definition_revision && object(p.expected_modified) && Number.isInteger(p.expected_content_version)
          && Number.isInteger(p.expected_structure_version), '原表版本或绑定缺失，请重新读取');
        requireValue(Array.isArray(p.cells), '候选单元格缺失，请重新读取');
        for (const item of p.cells) {
          requireValue(object(item) && typeof item.row_id === 'string' && item.row_id
            && typeof item.header === 'string' && item.header && object(item.value)
            && ['text','number','boolean','date','empty'].includes(item.value.type), '候选位置或值不完整');
          const value = item.value.type === 'empty' ? null : item.value.value;
          requireValue(scalar(value), '候选须为可核对的单元格值');
          cells.push({row:item.row_id, field:item.header, value, kind:item.value.type});
          names.push(item.row_id); headers.push(item.header);
        }
        for (const name of list(names)) {
          requireValue(typeof p.expected_modified[name] === 'string' && p.expected_modified[name], '原读取缺少行版本，请重新读取');
          rowVersions.set(name, p.expected_modified[name]);
        }
      } else {
        requireValue(Array.isArray(p.records) && p.records.length <= 50, '一次确认最多50行，请缩小范围');
        for (const record of p.records) {
          requireValue(object(record) && typeof record.name === 'string' && record.name
            && typeof record.expected_modified === 'string' && record.expected_modified
            && object(record.values) && Object.keys(record.values).length, '候选记录或原版本缺失');
          requireValue(!rowVersions.has(record.name), '同一行不能重复提交');
          rowVersions.set(record.name, record.expected_modified); names.push(record.name);
          for (const [field,value] of Object.entries(record.values)) {
            requireValue(scalar(value), '候选须为可核对的单元格值');
            cells.push({row:record.name, field, value}); headers.push(field);
          }
        }
      }
      requireValue(cells.length > 0 && cells.length <= MAX_CELLS && list(names).length <= 50
        && list(headers).length <= 64, '本次确认须为最多2000格、50行、64列，请缩小范围');
      requireValue(new Set(cells.map(c => JSON.stringify([c.row,c.field]))).size === cells.length,
                   '同一位置不能重复提交');
      return {companion, cells, names:list(names), fields:list(headers), rowVersions};
    }
    function definition(data, p) {
      const def = data.object;
      requireValue(object(def) && def.id === p.object_id && Array.isArray(def.fields)
        && def.revision === p.expected_revision, '字段定义已变化或当前不可读，请重新读取');
      requireValue(typeof (def.title || def.name) === 'string' && (def.title || def.name), '表名不可读取');
      return def;
    }
    async function read(confirm, p, after) {
      const wanted = plan(confirm,p);
      const defPromise = json('api/platform/objects/' + encodeURIComponent(p.object_id), {cache:'no-store'});
      if (!wanted.companion) {
        // 定义和本包值独立并行读取，不按行重装详情，不因取行标识多读整行。
        const [raw,packet] = await Promise.all([defPromise,
          service('platform.object.values_read', {object_id:p.object_id,names:wanted.names,fields:wanted.fields})]);
        const def = definition(raw,p);
        requireValue(def.source === 'managed' && def.operations?.includes('update'), '当前不能修改这张表');
        const fields = new Map(def.fields.map(f => [f.id,f]));
        for (const key of wanted.fields) requireValue(fields.get(key)?.label && own(def.input_schema?.properties || {}, key),
          '字段已变化或不可编辑，请重新读取');
        const rows = rowMap(packet.rows,wanted.names,'name');
        for (const name of wanted.names) {
          requireValue(typeof rows.get(name).modified === 'string' && rows.get(name).modified, '当前行版本不可读取');
          if (!after) requireValue(rows.get(name).modified === wanted.rowVersions.get(name), '记录已被修改，请重新读取候选');
        }
        const entries = wanted.cells.map(c => {
          const row = rows.get(c.row); requireValue(own(row,c.field) && scalar(row[c.field]), '目标值不可读取');
          return {...c, before:row[c.field], label:c.row + ' · ' + fields.get(c.field).label};
        });
        return {title:def.title || def.name, entries, names:wanted.names, objectId:p.object_id};
      }
      const packetPromise = service('files.sheet_read', {table:p.file_id,row_ids:wanted.names,headers:wanted.fields});
      const [raw,packet] = await Promise.all([defPromise,packetPromise]);
      const def = definition(raw,p), binding = def.companion;
      requireValue(binding?.object_id === p.object_id && binding.file_id === p.file_id
        && binding.definition_revision === p.definition_revision && Array.isArray(binding.field_columns),
        '表格绑定已变化，请重新读取候选');
      requireValue(packet.table === p.file_id && Array.isArray(packet.headers) && packet.writable === true,
                   '当前表格不可编辑或读取失败');
      if (!after) requireValue(packet.content_version === p.expected_content_version
        && packet.structure_version === p.expected_structure_version, '表格内容或结构已变化，请重新读取候选');
      else requireValue(packet.content_version === after.content_version && packet.structure_version === after.structure_version,
                        '保存后的表格版本已变化，请到原表核对');
      const rows = rowMap(packet.rows,wanted.names,'row_id');
      const columns = new Map(binding.field_columns.map(c => [c.header,c]));
      const fields = new Map(def.fields.map(f => [f.id,f]));
      const entries = wanted.cells.map(c => {
        const row = rows.get(c.row), cell = row.values?.[c.field], column = columns.get(c.field);
        requireValue(packet.headers.includes(c.field) && object(cell) && !cell.hidden && cell.type !== 'hidden'
          && own(cell,'value') && scalar(cell.value), '目标列已变化或当前不可读');
        if (column) requireValue(fields.get(column.field_id)?.label && def.operations?.includes('update'), '原字段不可修改');
        const version = after ? after.source_versions?.[c.row] : wanted.rowVersions.get(c.row);
        requireValue(typeof version === 'string' && version && row.source_modified === version,
                     '原记录已变化或版本不可核实，请重新读取');
        return {...c, before:cell.value, sourceType:column?.type,
          label:(Number.isInteger(row.row_index) ? '第 ' + row.row_index + ' 行（' + c.row + '）' : c.row)
            + ' · ' + c.field + (column && fields.get(column.field_id).label !== c.field
              ? '（' + fields.get(column.field_id).label + '）' : '')};
      });
      return {title:packet.table_title || def.title || def.name, entries,names:wanted.names,objectId:p.object_id};
    }
    function rowMap(rows,names,key) {
      requireValue(Array.isArray(rows) && rows.length === names.length, '本次目标行没有完整读回');
      const map = new Map();
      for (const row of rows) {
        requireValue(object(row) && names.includes(row[key]) && !map.has(row[key]), '读回的行身份不匹配');
        map.set(row[key],row);
      }
      return map;
    }
    function summary(state, saved) {
      const changes = state.entries.filter(c => !same(c.before,c.value)).map(c => ({label:c.label,before:text(c.before),after:text(c.value)}));
      return {title:(saved ? '已保存 · ' : '修改 · ') + state.title,
        lines:[changes.length ? '共 ' + changes.length + ' 处修改，确认后整组保存。' : '目标值与当前值一致，无需修改。'],
        changes, confirmLabel:'确认整组修改', objectId:state.objectId, recordName:state.names.length === 1 ? state.names[0] : null,
        ...(saved ? {tone:'success'} : {})};
    }
    function paginate(value, index=0) {
      if (!own(value,'changes') && ['pending','error'].includes(value.tone)) {
        return {changes:[],index:0,page:1,pages:1,total:0};
      }
      requireValue(Array.isArray(value.changes) && value.changes.length <= MAX_CELLS
        && value.changes.every(c => ['label','before','after'].every(k => typeof c[k] === 'string')), '修改预览不完整');
      const pages = Math.max(1,Math.ceil(value.changes.length/PAGE_SIZE));
      const page = Math.max(0,Math.min(pages-1,Number.isInteger(index) ? index : 0));
      return {changes:value.changes.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE),index:page,page:page+1,pages,total:value.changes.length};
    }
    const presenter = {
      paginate,
      async prepare(confirm) {
        const p = await payload(confirm), state = await read(confirm,p);
        snapshots.set(confirm,{payload:JSON.stringify(p),state});
        return summary(state,false);
      },
      async afterExecution(confirm,response) {
        const p = await payload(confirm), prior = snapshots.get(confirm), receipt = response.result;
        requireValue(prior?.payload === JSON.stringify(p) && object(receipt), '保存回执或原预览缺失，请到原表核对');
        const wanted = plan(confirm,p);
        requireValue(receipt.object_id === p.object_id, '保存回执不属于原表');
        if (wanted.companion) requireValue((receipt.table || receipt.file_id) === p.file_id
          && receipt.definition_revision === p.definition_revision, '保存回执的表格绑定不一致');
        else requireValue(receipt.revision === p.expected_revision && receipt.written === wanted.names.length
          && receipt.record_version_checked === true && JSON.stringify(receipt.records) === JSON.stringify(wanted.names),
          '整包保存回执不完整，请到原表核对');
        const actual = await read(confirm,p,wanted.companion ? receipt : {});
        for (const c of actual.entries) {
          const clearedText = c.kind === 'empty' && ['text','long_text','choice'].includes(c.sourceType)
            && c.before === '' && c.value === null;
          requireValue(same(c.before,c.value) || clearedText, '保存后的值与候选不一致，请到原表核对，不要重复确认');
        }
        changed({object_id:p.object_id,name:actual.names.length === 1 ? actual.names[0] : null});
        return summary(prior.state,true);
      },
    };
    return {'platform.object.update_many':presenter,'platform.object.companion_write':presenter};
  };
})();
