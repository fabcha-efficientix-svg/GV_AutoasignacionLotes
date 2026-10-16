/* eslint-disable no-unused-vars */
/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 * Grupo Vida - Autoasigna lote a componentes de la WO según Bin Transfers de WMS.
 * - Los picks de WMS llevan el número de la WO en la Nota del Bin Transfer (ej. "WO113", "WO138").
 * - Las reversas de picking de WMS NO llevan Nota: se emparejan por contenido
 *   (mismo artículo, lote y cantidad en unidad base, con bin origen/destino invertidos).
 * - Omite componentes fantasma (PHANTOM) y líneas sin detalle de inventario.
 * - Normaliza cantidades a unidad base para conciliar unidades del BT (ej. CJ10) vs WO (ej. KG).
 */
// eslint-disable-next-line no-undef
define(['N/record', 'N/search', 'N/redirect', 'N/format', 'N/log'], (record, search, redirect, format, log) => {

    const FLD_ESTADO = 'custbodygv_estado_autoasig';
    const FLD_ERROR = 'custbody_gv_estado_autoasig_error';
    const ESTADO = { PENDIENTE: '1', ASIGNADA: '2', PARCIAL: '3', DIFERENCIA: '4', ERROR: '5' };
    const TOL = 0.0001;
    const key = (item, lot, bin) => [item, lot, bin].join('|');
    const round5 = n => Math.round(n * 100000) / 100000;

    const rateCache = {}; // key: itemId|unitId -> conversionrate
    const utCache = {};   // key: utId -> { [uomId]: rate }

    /** Obtiene el factor de conversión a unidad base para un artículo y unidad dada. */
    const getUnitRate = (itemId, unitId) => {
        if (!unitId) return 1;
        const k = itemId + '|' + unitId;
        if (rateCache[k] !== undefined) return rateCache[k];
        let rate = 1;
        try {
            const lf = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: ['unitstype'] });
            const ut = lf.unitstype && lf.unitstype[0] && lf.unitstype[0].value;
            if (ut) {
                if (!utCache[ut]) {
                    utCache[ut] = {};
                    const utRec = record.load({ type: record.Type.UNITS_TYPE, id: ut });
                    const n = utRec.getLineCount({ sublistId: 'uom' });
                    for (let i = 0; i < n; i++) {
                        const uomId = String(utRec.getSublistValue({ sublistId: 'uom', fieldId: 'internalid', line: i }));
                        const conv = Number(utRec.getSublistValue({ sublistId: 'uom', fieldId: 'conversionrate', line: i })) || 1;
                        utCache[ut][uomId] = conv;
                    }
                }
                if (utCache[ut][String(unitId)] !== undefined) {
                    rate = utCache[ut][String(unitId)];
                }
            }
        } catch (e) {
            log.error('GV_SL: getUnitRate', 'item ' + itemId + ' unit ' + unitId + ' | ' + e.message);
        }
        rateCache[k] = rate;
        return rate;
    };

    /** Determina si una línea de la WO es asignable (descarta fantasmas y líneas sin inventory detail). */
    const isAssignableLine = (wo, line) => {
        const src = wo.getSublistValue({ sublistId: 'item', fieldId: 'itemsource', line });
        const avail = wo.getSublistValue({ sublistId: 'item', fieldId: 'inventorydetailavail', line });
        if (String(src).toUpperCase() === 'PHANTOM') return false;
        if (avail === false || avail === 'F') return false;
        return true;
    };

    const getInventoryDetail = (rec, sublistId, line) => {
        try {
            return rec.getSublistSubrecord({ sublistId, fieldId: 'inventorydetail', line });
        } catch (e) {
            log.debug('GV_SL: getInventoryDetail sin subrecord', `sublist: ${sublistId}, line: ${line}, error: ${e.message}`);
            return null;
        }
    };

    const readAssignments = (bt) => {
        const out = [];
        const n = bt.getLineCount({ sublistId: 'inventory' });
        for (let i = 0; i < n; i++) {
            const item = String(bt.getSublistValue({ sublistId: 'inventory', fieldId: 'item', line: i }));
            const unitId = bt.getSublistValue({ sublistId: 'inventory', fieldId: 'itemunits', line: i });
            const rate = getUnitRate(item, unitId);

            const inv = getInventoryDetail(bt, 'inventory', i);
            if (!inv) continue;
            const m = inv.getLineCount({ sublistId: 'inventoryassignment' });
            for (let j = 0; j < m; j++) {
                const g = f => inv.getSublistValue({ sublistId: 'inventoryassignment', fieldId: f, line: j });
                const rawQty = Number(g('quantity')) || 0;
                out.push({
                    item, 
                    lot: String(g('issueinventorynumber') || ''), 
                    qty: rawQty * rate, // Cantidad convertida a UNIDAD BASE
                    from: String(g('binnumber') || ''), 
                    to: String(g('tobinnumber') || ''), 
                    reversed: false
                });
            }
        }
        log.debug('GV_SL: readAssignments BT ' + bt.id, { totalLineas: n, totalAsignaciones: out.length });
        return out;
    };

    const searchIds = (filters) => {
        const ids = [];
        search.create({ type: search.Type.BIN_TRANSFER, filters, columns: ['internalid'] })
            .run().each(r => { ids.push(r.id); return true; });
        return ids;
    };

    /** Surtido neto vigente por item|lote|bin en unidad base, descontando reversas emparejadas. */
    const getNetPicked = (woTranId, woLocation) => {
        const picks = [];
        let minDate = null;
        const pickIds = searchIds([['mainline', 'is', 'T'], 'and', ['memo', 'is', woTranId]]);
        log.debug('GV_SL: getNetPicked - BTs encontrados con nota', { woTranId, count: pickIds.length, ids: pickIds });

        pickIds.forEach(id => {
            const bt = record.load({ type: record.Type.BIN_TRANSFER, id });
            const d = bt.getValue('trandate');
            if (d && (!minDate || d < minDate)) minDate = d;
            const asigs = readAssignments(bt);
            log.debug('GV_SL: BT ' + id + ' leído', { trandate: d, asignaciones: asigs });
            asigs.forEach(a => picks.push(a));
        });
        if (!picks.length) {
            log.debug('GV_SL: getNetPicked - Sin picks', 'No se encontraron Bin Transfers para ' + woTranId);
            return [];
        }

        // Reversas: Bin Transfers sin Nota en la misma ubicación, desde la fecha del primer pick.
        const revFilters = [['mainline', 'is', 'T'], 'and', ['memo', 'isempty', '']];
        if (woLocation) revFilters.push('and', ['location', 'anyof', woLocation]);
        if (minDate) revFilters.push('and', ['trandate', 'onorafter', format.format({ value: minDate, type: format.Type.DATE })]);
        const revIds = searchIds(revFilters);
        log.debug('GV_SL: getNetPicked - Candidatos reversa', { minDate, woLocation, count: revIds.length, ids: revIds });

        revIds.forEach(id => {
            const bt = record.load({ type: record.Type.BIN_TRANSFER, id });
            const asigs = readAssignments(bt);
            asigs.forEach(r => {
                const p = picks.find(x => !x.reversed && x.item === r.item && x.lot === r.lot &&
                    Math.abs(x.qty - r.qty) < TOL && x.to === r.from && x.from === r.to);
                if (p) {
                    p.reversed = true;
                    log.debug('GV_SL: Reversa emparejada (en unidad base)', { pickEmparejado: p, reversa: r });
                }
            });
        });

        const net = {};
        picks.filter(p => !p.reversed).forEach(p => {
            if (p.to) net[key(p.item, p.lot, p.to)] = (net[key(p.item, p.lot, p.to)] || 0) + p.qty;
            if (p.from) net[key(p.item, p.lot, p.from)] = (net[key(p.item, p.lot, p.from)] || 0) - p.qty;
        });
        const result = Object.keys(net).filter(k => net[k] > TOL).map(k => {
            const [item, lot, bin] = k.split('|');
            return { item, lot, bin, qty: net[k] };
        });
        log.debug('GV_SL: getNetPicked - Surtido neto final (base)', result);
        return result;
    };

    const setEstado = (woId, estado, mensaje = '') => {
        log.debug('GV_SL: setEstado', { woId, estado, mensaje });
        return record.submitFields({
            type: record.Type.WORK_ORDER, 
            id: woId, 
            values: { 
                [FLD_ESTADO]: estado,
                [FLD_ERROR]: mensaje || ''
            },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });
    };

    const onRequest = (ctx) => {
        const woId = ctx.request.parameters.woid;
        const back = () => redirect.toRecord({ type: record.Type.WORK_ORDER, id: woId });
        log.debug('GV_SL: onRequest inicio', { woId, parameters: ctx.request.parameters });

        try {
            const wo = record.load({ type: record.Type.WORK_ORDER, id: woId, isDynamic: false });
            const tranId = wo.getValue('tranid');
            const location = wo.getValue('location');
            const lines = wo.getLineCount({ sublistId: 'item' });
            log.debug('GV_SL: WO cargada', { tranId, location, lines, status: wo.getValue('status'), orderstatus: wo.getValue('orderstatus') });

            const picked = getNetPicked(tranId, location);
            log.audit('GV autoasig ' + tranId, 'surtido neto (base): ' + JSON.stringify(picked) + ' | lineas WO: ' + lines);

            // Validación todo-o-nada para componentes que manejan inventario asignable:
            // 1. Omite líneas fantasma (PHANTOM) y componentes sin detalle de inventario (inventorydetailavail = F).
            // 2. Compara cantidades en UNIDAD BASE usando el factor de conversión de la línea de la WO.
            const plan = [];
            let ok = picked.length > 0;
            const diferencias = [];

            for (let i = 0; i < lines; i++) {
                const item = String(wo.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }));

                if (!isAssignableLine(wo, i)) {
                    log.debug('GV_SL: Línea ' + i + ' omitida', { item, motivo: 'Fantasma / sin inventory detail' });
                    continue;
                }

                const sub = getInventoryDetail(wo, 'item', i);
                if (!sub) {
                    log.debug('GV_SL: Línea ' + i + ' omitida', { item, motivo: 'Sin subrecord de inventory detail' });
                    continue;
                }

                let woRate = Number(wo.getSublistValue({ sublistId: 'item', fieldId: 'unitconversionrate', line: i })) || 0;
                if (!woRate) {
                    const woUnitId = wo.getSublistValue({ sublistId: 'item', fieldId: 'units', line: i });
                    woRate = getUnitRate(item, woUnitId);
                }

                const reqLine = Number(wo.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i })) || 0;
                const reqBase = reqLine * woRate;

                const mine = picked.filter(p => p.item === item);
                const gotBase = mine.reduce((s, p) => s + p.qty, 0);
                log.debug('GV_SL: Línea ' + i + ' evaluada', { item, reqLine, woRate, reqBase, gotBase, countPicks: mine.length });

                if (Math.abs(gotBase - reqBase) > TOL) {
                    ok = false;
                    const itemName = wo.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || item;
                    diferencias.push({ line: i, item, itemName, reqBase, gotBase });
                    log.audit('GV autoasig diferencia', 'linea ' + i + ' item ' + item + ' reqBase ' + reqBase + ' gotBase ' + gotBase);
                    log.debug('GV_SL: Diferencia detectada en línea ' + i, { item, itemName, reqBase, gotBase });
                } else {
                    plan.push({ line: i, mine, woRate });
                }
            }

            if (!ok) {
                let nuevoEstado = ESTADO.PENDIENTE;
                let errorMsg = '';

                if (picked.length === 0) {
                    nuevoEstado = ESTADO.PENDIENTE;
                    errorMsg = `No se encontraron traslados de inventario (Bin Transfers) de WMS con Nota "${tranId}" en la ubicación.`;
                } else {
                    nuevoEstado = ESTADO.DIFERENCIA;
                    const detalleDiff = diferencias.map(d => {
                        const diff = round5(d.gotBase - d.reqBase);
                        const tipo = diff < 0 ? `Faltante: ${Math.abs(diff)}` : `Sobrante: +${diff}`;
                        return `• Línea ${d.line + 1} (${d.itemName}): Req. Base ${round5(d.reqBase)}, Surtido Base ${round5(d.gotBase)} [${tipo}]`;
                    }).join('\n');
                    errorMsg = `Diferencias detectadas entre componentes de la WO y surtido WMS:\n${detalleDiff}`;
                }

                log.debug('GV_SL: Validación no superada, asignando estado', { nuevoEstado, errorMsg, diferencias, totalPicks: picked.length });
                setEstado(woId, nuevoEstado, errorMsg);
                return back();
            }

            // El bin NO se asigna en la WO (el detalle del componente no tiene bin): queda para el Work Order Issue.
            // Idempotente: si el detalle ya coincide con el surtido, no se toca.
            // Las cantidades se escriben en la UNIDAD DE LA LÍNEA DE LA WO.
            let changed = false;
            log.debug('GV_SL: Procesando asignación del plan', { totalLineasAsignables: plan.length });

            plan.forEach(({ line, mine, woRate }) => {
                const byLot = {};
                mine.forEach(p => { 
                    const qtyWo = p.qty / woRate; // Convertir de base a unidad de la línea WO
                    byLot[p.lot] = (byLot[p.lot] || 0) + qtyWo; 
                });
                Object.keys(byLot).forEach(l => { byLot[l] = round5(byLot[l]); });

                const sub = getInventoryDetail(wo, 'item', line);
                if (!sub) return;

                const cur = {};
                for (let k = 0; k < sub.getLineCount({ sublistId: 'inventoryassignment' }); k++) {
                    const l = String(sub.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: k }));
                    cur[l] = round5((cur[l] || 0) + (Number(sub.getSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: k })) || 0));
                }
                const lots = Object.keys(byLot);
                const isIdentical = lots.length === Object.keys(cur).length && lots.every(l => cur[l] !== undefined && Math.abs(cur[l] - byLot[l]) < TOL);
                log.debug('GV_SL: Comparando detalle línea ' + line, { lotsSurtidos: byLot, lotsActuales: cur, esIdentico: isIdentical });

                if (isIdentical) return;
                changed = true;
                log.debug('GV_SL: Reasignando lotes en línea ' + line, byLot);

                for (let k = sub.getLineCount({ sublistId: 'inventoryassignment' }) - 1; k >= 0; k--)
                    sub.removeLine({ sublistId: 'inventoryassignment', line: k });

                lots.forEach((lot, idx) => {
                    try {
                        sub.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber', line: idx, value: lot });
                    } catch (e) {
                        log.error('GV lote rechazado', 'lote ' + lot + ' linea ' + line + ' | ' + e.message);
                        throw e;
                    }
                    sub.setSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', line: idx, value: byLot[lot] });
                });
            });

            if (!changed) {
                log.debug('GV_SL: Idempotencia - Sin cambios necesarios', { woId, estado: ESTADO.ASIGNADA });
                setEstado(woId, ESTADO.ASIGNADA, '');
                log.audit('GV autoasig OK', 'WO ' + woId + ' ya estaba asignada, sin cambios');
                return back();
            }

            log.debug('GV_SL: Guardando WO con estado Asignada', { woId });
            wo.setValue({ fieldId: FLD_ESTADO, value: ESTADO.ASIGNADA });
            wo.setValue({ fieldId: FLD_ERROR, value: '' });
            try {
                wo.save({ ignoreMandatoryFields: true });
                log.debug('GV_SL: WO guardada exitosamente', { woId });
            } catch (saveErr) {
                const lotInfo = {};
                plan.forEach(({ line, mine }) => mine.forEach(p => {
                    if (lotInfo[p.lot]) return;
                    try { lotInfo[p.lot] = search.lookupFields({ type: 'inventorynumber', id: p.lot, columns: ['inventorynumber', 'item', 'location'] }); }
                    catch (x) { lotInfo[p.lot] = 'lookup fallo: ' + x.message; }
                }));
                const locs = plan.map(pl => 'l' + pl.line + '=' + wo.getSublistValue({ sublistId: 'item', fieldId: 'location', line: pl.line }));
                log.error('GV save rechazado', saveErr.message + ' | lotes: ' + JSON.stringify(lotInfo) + ' | ubic lineas: ' + locs.join(',') + ' | ubic WO: ' + wo.getValue('location'));
                throw saveErr;
            }
            log.audit('GV autoasig OK', 'WO ' + woId + ' asignada, componentes: ' + plan.length);
        } catch (e) {
            log.error('GV autoasignacion WO ' + woId, e.name + ': ' + e.message);
            try { 
                setEstado(woId, ESTADO.ERROR, 'Error en autoasignación: ' + (e.message || e.name || 'Error inesperado')); 
            } catch (x) { /* noop */ }
        }
        back();
    };
    return { onRequest };
});
