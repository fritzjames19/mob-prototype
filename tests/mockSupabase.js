// A small in-memory stand-in for the Supabase JS client, supporting the subset of the
// query builder actually used in this codebase: select/eq/in/order/limit/single/maybeSingle,
// insert, update, upsert. Good enough to exercise real route logic without a live database.
export function makeMockSupabase() {
  const tables = {};
  function rows(name) { if (!tables[name]) tables[name] = []; return tables[name]; }

  function matches(row, filters) {
    return filters.every(f => {
      if (f.type === 'eq') return row[f.col] === f.val;
      if (f.type === 'in') return f.vals.includes(row[f.col]);
      return true;
    });
  }

  function table(name) {
    let filters = [];
    let orderCol = null, orderAsc = true, limitN = null;
    let mode = 'select';
    let insertObj = null, updatePatch = null, upsertObj = null;

    const builder = {
      select() { mode = mode === 'insert' ? 'insert-select' : mode; return builder; },
      eq(col, val) { filters.push({ type: 'eq', col, val }); return builder; },
      in(col, vals) { filters.push({ type: 'in', col, vals }); return builder; },
      order(col, opts) { orderCol = col; orderAsc = !(opts && opts.ascending === false); return builder; },
      limit(n) { limitN = n; return builder; },
      insert(obj) { insertObj = { ...obj }; mode = 'insert'; return builder; },
      update(patch) { updatePatch = patch; mode = 'update'; return builder; },
      upsert(obj) { upsertObj = obj; mode = 'upsert'; return execUpsert(); },
      async single() {
        const result = await runSelect();
        if (result.data.length === 0) return { data: null, error: { message: 'not found' } };
        return { data: result.data[0], error: null };
      },
      async maybeSingle() {
        const result = await runSelect();
        return { data: result.data[0] || null, error: null };
      },
      then(resolve) {
        // awaited directly, e.g. `await table.update(x).eq(...)` or a bare select
        if (mode === 'update') return resolve(execUpdate());
        if (mode === 'insert' || mode === 'insert-select') return resolve(execInsert());
        resolve(runSelectSync());
      },
    };

    function runSelectSync() {
      let data = rows(name).filter(r => matches(r, filters));
      if (orderCol) data = [...data].sort((a, b) => orderAsc ? (a[orderCol] > b[orderCol] ? 1 : -1) : (a[orderCol] < b[orderCol] ? 1 : -1));
      if (limitN) data = data.slice(0, limitN);
      return { data, error: null };
    }
    async function runSelect() { return runSelectSync(); }

    function execUpdate() {
      const all = rows(name);
      const matched = all.filter(r => matches(r, filters));
      matched.forEach(r => Object.assign(r, updatePatch));
      return { data: matched, error: null };
    }
    function execInsert() {
      const id = insertObj.id || (name + '_' + (rows(name).length + 1));
      const row = { id, ...insertObj };
      rows(name).push(row);
      return { data: [row], error: null };
    }
    function execUpsert() {
      const all = rows(name);
      // naive: match on all keys present in the conflict-relevant composite (attacker_player_id + defender_ref for our use case)
      const keyCols = Object.keys(upsertObj).filter(k => k !== 'grudge');
      const existing = all.find(r => keyCols.every(k => r[k] === upsertObj[k]));
      if (existing) Object.assign(existing, upsertObj);
      else all.push({ ...upsertObj });
      return Promise.resolve({ data: [upsertObj], error: null });
    }

    return builder;
  }

  return { from: table, _tables: tables };
}
