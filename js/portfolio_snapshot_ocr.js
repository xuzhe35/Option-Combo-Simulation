/* Recognized words -> reviewable TWS-layout candidates. Never fills invisible data. */
(function (g) {
    'use strict';
    const S = g.OptionComboPortfolioSnapshotSchema, C = g.OptionComboPortfolioSnapshotCore;
    const COLS = ['dailyPnl', 'description', 'mark', 'costBasis', 'quantity', 'unrealizedPnl',
        'deltaDollars', 'marketValue', 'avgPrice', 'theta', 'lastPrice', 'displayIv'];
    const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    function validWord(w) {
        return w && typeof w.text === 'string' && Array.isArray(w.bbox) && w.bbox.length === 4
            && w.bbox.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
            && w.bbox[2] > 0 && w.bbox[3] > 0
            && w.bbox[0] + w.bbox[2] <= 1.001 && w.bbox[1] + w.bbox[3] <= 1.001;
    }
    function group(words) {
        const rows = [];
        const sorted = [...words].sort((a, b) => (a.bbox[1] + a.bbox[3] / 2) - (b.bbox[1] + b.bbox[3] / 2));
        for (const w of sorted) {
            const cy = w.bbox[1] + w.bbox[3] / 2;
            let row = rows.find(r => Math.abs(r.cy - cy) < Math.min(r.height, w.bbox[3]) * .5);
            if (!row) { row = { cy, height: w.bbox[3], words: [] }; rows.push(row); }
            row.words.push(w);
        }
        return rows.map(row => ({ ...row, words: row.words.sort((a, b) => a.bbox[0] - b.bbox[0]),
            text: row.words.sort((a, b) => a.bbox[0] - b.bbox[0]).map(w => w.text).join(' ') }));
    }
    const LABELS = [['DAILYPL'], ['FININSTRUMENT','FINANCIALINSTRUMENT'], ['MARK'], ['COSTBASIS'], ['POS'], ['UNRLZDPL'],
        ['DELTADLLRS'], ['MKTVALUE'], ['AVGPRICE'], ['PTFTHETA','PORTFTHETA'], ['LAST'], ['IMPLDVL', 'IMPLDVOL', 'IV']];
    const LABEL_TITLES = ['DAILY P&L（日盈亏）','FIN INSTRUMENT（合约）','MARK','COST BASIS（成本）','POS（数量）',
        'UNRLZD P&L（浮动盈亏）','DELTA DLLRS','MKT VALUE（市值）','AVG PRICE（均价）','PTF THETA','LAST','IMPLD VL / IV'];
    const labelText = text => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const HEADER_WORDS = new Set('DAILY PL FIN FINANCIAL INSTRUMENT MARK COST BASIS POS UNRLZD DELTA DLLRS MKT VALUE AVG PRICE PORTF PTF THETA LAST IMPLD VL VOL IV'.split(' '));
    const columnIndex=(x,edges)=>edges.findIndex((left,i)=>i+1<edges.length&&x>=left&&x<edges[i+1]);
    function detectLayout(words, rereads = [], aspect = 1) {
        const fail = text => { throw new Error('表头无法确认：' + text + '。' + (text==='表头局部重读坐标无效'
            ? '本机 OCR 的定位未通过校验，原图已保留，请重新识别。' : '请保留完整表头及列标签后重试。')); };
        const original = group(words).find(r => labelText(r.text).includes('INSTRUMENT'));
        if (!original) return fail('未找到 FIN INSTRUMENT');
        function locate(header) {
            const tokens = header.words.flatMap(w => {
                const text = labelText(w.text);
                const candidates = Array.isArray(w.headerPartCandidates) ? w.headerPartCandidates.slice(0,32).filter(parts => Array.isArray(parts) && parts.length === 2
                    && parts.every(p => typeof p.text === 'string' && HEADER_WORDS.has(labelText(p.text)))) : [];
                const alternatives = new Set(candidates.map(parts => parts.map(p => labelText(p.text)).join('|')));
                if (alternatives.size > 1) return fail('粘连表头有多个可能拆分');
                const parts = w.headerParts || candidates[0];
                if (!parts) {
                    // A symbol whose only ink is a clipped sliver of the neighbouring glyph is not a label.
                    if (!text && w.inkEvidence === 'edge_fragment_only') return [];
                    if (text.startsWith('LASTIMPLD')) return fail('LAST 与 IV 标签粘连，缺少可靠字符定位证据，请重新识别清晰原图');
                    let symbol = w.text.trim();
                    // One '|' may be dropped from a symbol-only token only on the side where
                    // pixels prove a frame line spanning at least three text heights.
                    const rule = w.frameRule;
                    if (!text && rule && validWord({ text: '', bbox: rule.bbox }) && rule.bbox[3] >= w.bbox[3] * 3
                        && rule.bbox[0] >= w.bbox[0] - .003 && rule.bbox[0] + rule.bbox[2] <= w.bbox[0] + w.bbox[2] + .003) {
                        if (rule.side === 'left' && symbol.startsWith('|')) symbol = symbol.slice(1);
                        else if (rule.side === 'right' && symbol.endsWith('|')) symbol = symbol.slice(0, -1);
                        if (!symbol) return [];
                    }
                    if (!text && !['+/-','▲','▼','▴','▾'].includes(symbol)) return fail('发现不支持的额外列或文字：' + w.text);
                    return text ? [{ ...w, text, originalLabel: w.text }] : [];
                }
                if (!Array.isArray(parts) || !parts.length || parts.length > 4) return fail('粘连标签缺少可靠字符定位证据');
                const sort = parts.at(-1)?.text === '▲' && parts.at(-1)?.coordinateEvidence === 'filled_sort_triangle';
                if (!parts.every(p => validWord(p)
                    && p.bbox[0] >= w.bbox[0] - .001 && p.bbox[0] + p.bbox[2] <= w.bbox[0] + w.bbox[2] + .001
                    && Math.abs(p.bbox[1] + p.bbox[3] / 2 - w.bbox[1] - w.bbox[3] / 2) <= w.bbox[3] / 2)
                    || parts.map(p => labelText(p.text)).join('') !== (sort ? text.replace(/A$/, '') : text)) return fail('粘连标签缺少可靠字符定位证据');
                return parts.filter(p => labelText(p.text)).map(p => ({ ...p, text: labelText(p.text), originalLabel: p.text }));
            });
            const used = new Set();
            // Explicit second TWS presentation: expanded instrument/theta labels,
            // ending at LAST with no IV column. Missing IV in the established
            // abbreviated presentation remains an error, not an optional label.
            const hasLabel=name=>tokens.some((_,i)=>[1,2,3].some(n=>tokens.slice(i,i+n).map(w=>w.text).join('')===name));
            const expanded=hasLabel('FINANCIALINSTRUMENT')&&hasLabel('PORTFTHETA');
            const hasIv=tokens.some(w=>['IMPLD','VL','VOL','IV','IMPLDVL','IMPLDVOL'].includes(w.text));
            const labels=expanded&&!hasIv?LABELS.slice(0,-1):LABELS;
            const headers = labels.map((aliases, index) => {
                const hits = [];
                for (let i = 0; i < tokens.length; i++) for (let n = 1; n <= 3 && i + n <= tokens.length; n++) {
                    if (!aliases.includes(tokens.slice(i, i + n).map(w => w.text).join(''))) continue;
                    hits.push({ key: COLS[index], left: tokens[i].bbox[0], right: tokens[i + n - 1].bbox[0] + tokens[i + n - 1].bbox[2], indices: Array.from({length:n},(_,j)=>i+j) });
                }
                if (hits.length !== 1) return fail(LABEL_TITLES[index] + ' 标签未能唯一定位');
                hits[0].indices.forEach(i => used.add(i));
                return hits[0];
            });
            // TWS appends the literal E+ display control to FIN INSTRUMENT.
            // A sort triangle is ignored only after native filled-glyph proof;
            // arbitrary OCR 'A' (or any new column label) is never whitelisted.
            const end = headers[1].indices.at(-1), suffix = tokens[end + 1];
            if (suffix?.originalLabel === 'E+' && suffix.bbox[0] - headers[1].right <= suffix.bbox[2] * 1.5) used.add(end + 1);
            // TWS draws its expand/collapse-all control (+/-) left of the first column
            // label. A token without letters wholly left of DAILY P&L heads no column; an
            // extra column always carries a lettered label and is still rejected.
            const rowControl = w => !/[A-Z]/.test(w.text) && w.bbox[0] + w.bbox[2] <= headers[0].left;
            const extra = tokens.filter((w, i) => !used.has(i) && !rowControl(w));
            if (extra.length) return fail('发现不支持的额外列或文字：' + extra.map(w => w.originalLabel || w.text).join(' '));
            // Pixel cleanup must prove the labels; do not relax column ownership.
            const overlap = .0001;
            if (headers.some((h, i) => i && h.left < headers[i - 1].right - overlap)) return fail('列顺序或标签重叠不受支持');
            return headers.map(({indices, ...h}) => h);
        }
        // Two measured header crops may repair OCR segmentation, but each must
        // independently locate every label and reject every unconsumed word.
        let header = original, headers, evidence = [];
        if (rereads.length) {
            if (rereads.length !== 2 || new Set(rereads.map(p => p.scale)).size !== 2 || !rereads.every(p => [2,3].includes(p.scale)
                && Array.isArray(p.words) && p.words.length <= 100 && p.words.every(w => validWord(w)
                    && Math.abs(w.bbox[1] + w.bbox[3]/2 - original.cy) <= original.height))) return fail('表头局部重读坐标无效');
            const candidates = rereads.map(p => {
                const ws = [...p.words].sort((a,b)=>a.bbox[0]-b.bbox[0]);
                const h = { ...original, words: ws, text: ws.map(w=>w.text).join(' ') };
                return { h, labels: locate(h), scale: p.scale };
            });
            if (candidates[0].labels.length!==candidates[1].labels.length||candidates[0].labels.some((h,i)=>['left','right'].some(k=>Math.abs(h[k]-candidates[1].labels[i][k]) > original.height * .3))) return fail('两次表头定位不一致');
            header = candidates[1].h; headers = candidates[1].labels; evidence = S.clone(rereads);
        } else headers = locate(header);
        // Keep the established indentation tolerance tied to the first-pass MARK
        // observation; trimming header ink must not shrink the row-noise margin.
        const mark = original.words.find(w => labelText(w.text) === 'MARK');
        const scale = (mark?.bbox[2] || headers[2].right - headers[2].left) / .038;
        const gap = Math.min(header.height * .2, (headers[3].left - headers[2].right) / 4);
        const body = words.filter(w => w.bbox[1] > header.cy + header.height / 2);
        const marks = body.filter(w => /^[+-]?[0-9][0-9,.]*$/.test(w.text)
            && Math.abs(w.bbox[0] + w.bbox[2] - headers[2].right) < (headers[2].right - headers[2].left) * .3);
        const descriptionEnd = Math.min(headers[2].left, ...(marks.length ? marks.map(w => w.bbox[0] - Math.max(gap, .0001)) : [headers[2].left]));
        const edges = [0, headers[1].left, descriptionEnd];
        for (let i = 2; i < headers.length - 1; i++) edges.push(headers[i].right + Math.max(0, Math.min(header.height * .2, (headers[i + 1].left - headers[i].right) / 4)));
        edges.push(1);
        if (edges.some((e, i) => !Number.isFinite(e) || e < 0 || e > 1 || (i && e <= edges[i - 1]))) return fail('列边界不清晰');
        return { header, headers, edges, scale, evidence };
    }
    function quantityCrops(result) {
        // Cell review (protocol 2) reads every quantity cell through reviewCrops.
        if (result.recognition.reviewProtocol === 2) return [];
        const edges = result.recognition.tableLayout.edges;
        return result.sourceRows.filter(r => ['position','unclassified'].includes(r.rowType) && singleContract(r.normalizedCells?.description || '')
                && !r.rawCells.quantity && r.cellBounds)
            .slice(0, 64).map(r => {
                const b = r.cellBounds, pad = b[3] * .1, top = Math.max(0, b[1] - pad), bottom = Math.min(1, b[1] + b[3] + pad);
                return { field: 'quantity', cropBbox: [edges[4], top, edges[5] - edges[4], bottom - top] };
            });
    }
    function reviewPlan(rows, layout) {
        const body = rows.filter(r=>r.cy>layout.header.cy+layout.header.height/2);
        const daily = body.flatMap(r=>r.words).filter(w=>w.bbox[0]<layout.edges[1] && /^[+-]?[0-9][0-9,.]*$/.test(w.text));
        const left = Math.max(0,Math.min(layout.headers[0].left,...daily.map(w=>w.bbox[0]))-layout.header.height*.3);
        return body.map((row,index)=>{
            const top=row.band?row.band[0]:Math.min(...row.words.map(w=>w.bbox[1])),bottom=row.band?row.band[1]:Math.max(...row.words.map(w=>w.bbox[1]+w.bbox[3]));
            const y=Math.max(0,top-row.height*.2,index?(body[index-1].cy+row.cy)/2:0);
            const end=Math.min(1,bottom+row.height*.2,index+1<body.length?(row.cy+body[index+1].cy)/2:1);
            const crop=(field,x,right)=>({field,cropBbox:[x,y,right-x,end-y]});
            return {row,description:crop('descriptionRow',layout.edges[1],layout.edges[2]),quantity:crop('quantity',layout.edges[4],layout.edges[5]),
                numeric:Object.fromEntries(layout.headers.filter(h=>!['description','quantity','avgPrice','dailyPnl'].includes(h.key)).map(h=>{const i=COLS.indexOf(h.key);return [h.key,crop(h.key,layout.edges[i],layout.edges[i+1])];})),
                daily:crop('dailyPnl',left,layout.edges[1]),avg:crop('avgPrice',layout.edges[8],layout.edges[9])};
        });
    }
    function validGlyphRepeat(word, scale) {
        const e=word.glyphRepeatEvidence;if(!e)return true;
        if(e.method!=='identical_source_patch'||e.scale!==scale||!Array.isArray(e.copies)||![3,7].includes(e.copies.length)
            ||!e.copies.every(t=>t===word.text)||e.recognizedText!==e.copies.join('')
            ||!Array.isArray(e.sourceBbox)||e.sourceBbox.length!==4||!e.sourceBbox.every((v,i)=>v===word.bbox[i])
            ||!validWord({text:'',bbox:e.canvasBox})||!Array.isArray(e.canvasSize)||e.canvasSize.length!==2
            ||!e.canvasSize.every(v=>Number.isInteger(v)&&v>0&&v<=8192)
            ||!Number.isInteger(e.margin)||e.margin<=0||!Number.isInteger(e.tileWidth)||e.tileWidth<=0)return false;
        const [w,h]=e.canvasSize,b=e.canvasBox,sourceWidth=e.tileWidth-(e.copies.length===3?1:4)*scale;
        return sourceWidth>0&&w===e.margin*2+e.tileWidth*e.copies.length&&h>e.margin*2
            &&b[0]*w>=e.margin-scale*2&&(b[0]+b[2])*w<=e.margin+e.tileWidth*e.copies.length+scale*2
            &&b[0]*w<e.margin+sourceWidth/2&&(b[0]+b[2])*w>e.margin+e.tileWidth*(e.copies.length-1)+sourceWidth/2;
    }
    function reviewPasses(result, request) {
        const epsilonX=result.width>0?2/result.width:.001,epsilonY=result.height>0?2/result.height:.001,b=request.cropBbox;
        // Protocol 2 engines must also report the pixels actually read; reading outside the
        // requested crop (e.g. a neighbouring row) invalidates the evidence.
        const readInside=w=>result.reviewProtocol!==2||(validWord({text:'',bbox:w.readBbox})&&w.readBbox[0]>=b[0]-epsilonX&&w.readBbox[1]>=b[1]-epsilonY
            &&w.readBbox[0]+w.readBbox[2]<=b[0]+b[2]+epsilonX&&w.readBbox[1]+w.readBbox[3]<=b[1]+b[3]+epsilonY);
        const matches=(Array.isArray(result.reviewRereads)?result.reviewRereads:[]).filter(r=>r&&r.field===request.field
            && validWord({text:'',bbox:r.cropBbox}) && r.cropBbox.every((v,i)=>Math.abs(v-b[i])<=(i%2?epsilonY:epsilonX)));
        if(matches.length!==1)return null;
        const r=matches[0];
        const scales=request.field==='descriptionRow'?[2,3,4]:[3,4];
        if(!Array.isArray(r.passes)||r.passes.length!==scales.length||new Set(r.passes.map(p=>p?.scale)).size!==scales.length
            ||!r.passes.every(p=>scales.includes(p?.scale)&&Array.isArray(p.words)&&p.words.length>0&&p.words.length<=200
                &&p.words.every(w=>{const q=w.inkBbox||w.bbox;return validWord(w)&&validGlyphRepeat(w,p.scale)&&validWord({text:'',bbox:q})&&readInside(w)
                    &&q[0]>=w.bbox[0]-epsilonX&&q[1]>=w.bbox[1]-epsilonY
                    &&q[0]+q[2]<=w.bbox[0]+w.bbox[2]+epsilonX&&q[1]+q[3]<=w.bbox[1]+w.bbox[3]+epsilonY
                    &&q[0]>=b[0]-epsilonX&&q[0]+q[2]<=b[0]+b[2]+epsilonX&&q[1]>=b[1]-epsilonY&&q[1]+q[3]<=b[1]+b[3]+epsilonY;})))return null;
        return S.clone(r);
    }
    function rowCells(words, edges) {
        const cells={};
        for(const w of [...words].sort((a,b)=>a.bbox[0]-b.bbox[0])){
            const x=w.bbox[0]+w.bbox[2]/2,j=columnIndex(x,edges);
            if(j>=0)(cells[COLS[j]]||=[]).push(w.text);
        }
        return Object.fromEntries(Object.entries(cells).map(([k,v])=>[k,v.join(' ')]));
    }
    function verifiedRow(result, request, edges) {
        const evidence=reviewPasses(result,request);if(!evidence)return null;
        const originals=result.words.filter(w=>validWord(w)&&w.bbox[1]+w.bbox[3]/2>=request.cropBbox[1]&&w.bbox[1]+w.bbox[3]/2<=request.cropBbox[1]+request.cropBbox[3]);
        const candidates=evidence.passes.map(p=>{
            const unique=[];
            const label=t=>/^[.…]+$/.test(t)?'…':t;
            for(const word of p.words){
                const same=unique.find(w=>overlap(w.bbox,word.bbox)>.6);
                if(same){if(label(same.text)!==label(word.text))return {pass:p,signature:null};continue;}
                unique.push(word);
            }
            const anchored=unique.map(word=>{
                const matches=originals.map(w=>({w,score:overlap(word.bbox,w.bbox)})).filter(m=>m.score>=.3).sort((a,b)=>b.score-a.score);
                if(!matches[0]||(matches[1]&&matches[0].score-matches[1].score<.1))return word;
                return {...word,lineId:matches[0].w.lineId,exchangeSlot:/^@[A-Z]+$/.test(matches[0].w.text)};
            });
            const words=refineWords(anchored,result.rereads,edges[1],edges[2]);
            const cells=rowCells(words,edges),desc=cells.description||'',probe=C.position('probe','probe');terms(desc,probe);
            const contract=completeContract(desc),i=probe.instrument;
            // A malformed date, missing strike or non-ASCII code is not a competing
            // complete contract. Never choose between two different complete identities.
            const incomplete=!/^TOTAL\b/i.test(desc)&&!comboSignal(desc)&&(atomicLike(desc)||/@/.test(desc))&&(!contract||/[^\x00-\x7F…‘’“”]/.test(desc)
                ||(['OPT','FOP'].includes(i.secType)&&!i.right)||i.secType==='FOP'&&!i.tradingClass);
            return {pass:{...p,words},contract,signature:incomplete?null:JSON.stringify({description:contract?i:desc.replace(/(?:\s*[.…])+$/,'').toUpperCase().replace(/[^A-Z0-9.]/g,'')})};
        });
        const eligible=candidates.filter(c=>c.signature!==null),contracts=eligible.filter(c=>c.contract);
        // Text lacking a complete contract (e.g. a missing exchange marker) is
        // retained, not compared as if it were a different complete identity.
        // Generic strategy parents still use matching labels when no complete
        // contract is present. A single complete contract cannot prove a row.
        const complete=contracts.length?contracts:eligible;
        if(complete.length<2||new Set(complete.map(c=>c.signature)).size!==1)return null;
        const passes=complete.slice(0,2).map(c=>c.pass);
        const words=S.clone(passes[0].words).filter(w=>w.bbox[0]+w.bbox[2]/2>=edges[1]&&w.bbox[0]+w.bbox[2]/2<edges[2]).sort((a,b)=>a.bbox[0]-b.bbox[0]);
        const first=words.find(w=>w.bbox[0]+w.bbox[2]/2>=edges[1]);
        const starts=passes.map(p=>[...p.words].sort((a,b)=>a.bbox[0]-b.bbox[0]).find(w=>w.bbox[0]+w.bbox[2]/2>=edges[1]));
        if(first&&starts.every(w=>w&&validWord({text:'',bbox:w.inkBbox}))
            &&Math.abs(starts[0].inkBbox[0]-starts[1].inkBbox[0])<=.001){
            first.layoutEvidence={method:'aligned_row_crop_ink_geometry',originalBbox:S.clone(first.bbox),
                selectedBbox:starts[0].inkBbox.map((v,i)=>(v+starts[1].inkBbox[i])/2),
                passes:passes.map((p,i)=>({scale:p.scale,text:starts[i].text,bbox:starts[i].bbox,inkBbox:starts[i].inkBbox}))};
        }
        return {words,evidence:{...evidence,allPasses:evidence.passes,passes,method:'row_crop_consensus',status:'agreed'}};
    }
    function verifiedNumber(result,request){
        const evidence=reviewPasses(result,request);if(!evidence)return null;
        const values=evidence.passes.map(p=>{try{return S.decimal([...p.words].sort((a,b)=>a.bbox[0]-b.bbox[0]).map(w=>w.text).join(' '),request.field==='displayIv');}catch(_){return null;}});
        if(values[0]===null||values[0]!==values[1])return null;
        return {...evidence,method:request.field+'_crop_consensus',status:'agreed',selectedValue:values[0]};
    }
    function unreadNumber(result,request){
        const b=request.cropBbox,epsilonX=2/(result.width||2000),epsilonY=2/(result.height||2000);
        const matches=(result.reviewRereads||[]).filter(r=>r.field===request.field&&Array.isArray(r.cropBbox)
            &&r.cropBbox.length===4&&r.cropBbox.every((v,i)=>Math.abs(v-b[i])<=(i%2?epsilonY:epsilonX)));
        if(matches.length!==1)return null;
        const r=matches[0];
        if(!Array.isArray(r.passes)||r.passes.length!==2||new Set(r.passes.map(p=>p.scale)).size!==2
            ||!r.passes.every(p=>[3,4].includes(p.scale)&&validWord({text:'',bbox:p.numericInkBbox})
                &&p.numericInkBbox[0]>=b[0]-epsilonX&&p.numericInkBbox[1]>=b[1]-epsilonY
                &&p.numericInkBbox[0]+p.numericInkBbox[2]<=b[0]+b[2]+epsilonX
                &&p.numericInkBbox[1]+p.numericInkBbox[3]<=b[1]+b[3]+epsilonY)
            ||overlap(r.passes[0].numericInkBbox,r.passes[1].numericInkBbox)<.8)return null;
        return {...S.clone(r),method:'visible_numeric_ink_unread',status:'unresolved'};
    }
    function terms(description, p) {
        const i = p.instrument;
        const symbol = description.match(/^([A-Z][A-Z0-9.]*)\b/);
        i.symbol = symbol ? symbol[1] : null;
        const fop = description.match(/^[A-Z][A-Z0-9.]*\s+FOP\s*\(([A-Z0-9][A-Z0-9.]{0,11})\)/i);
        const hasFop = /^[A-Z][A-Z0-9.]*\s+FOP\b/i.test(description);
        i.secType = /^[A-Z][A-Z0-9.]*$/.test(description) ? 'STK'
            : hasFop ? 'FOP' : /\b(?:CALL|PUT|CAL|CA|PU)\b/i.test(description) && /\d\s+(?:CALL|PUT|CAL|CA|PU)(?:\.+|…+)?(?=\s|$)/i.test(description) ? 'OPT' : /@\w+/.test(description) ? 'FUT' : /\b(?:CALL|PUT|CAL|CA|PU)\b/i.test(description) ? 'OPT' : 'STK';
        i.tradingClass = fop ? fop[1] : null;
        const expiry = description.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})\s*['’‘"“]?\s*(\d{2})\b/i);
        if (expiry) {
            try { i.expiryDate = S.date('20' + expiry[3] + '-' + MONTHS[expiry[1].toLowerCase()] + '-' + expiry[2].padStart(2, '0')); } catch (_) { /* leave unknown */ }
            if (!hasFop && i.secType === 'STK') i.secType = 'UNKNOWN';
        }
        if (expiry && ['OPT', 'FOP'].includes(i.secType)) {
            const rest = description.slice(expiry.index + expiry[0].length).trim();
            const strike = rest.match(/^(\d+(?:\.\d+)?)\s+((?:CALL|CAL|CA|PUT|PU)(?:\.+|…+)?)(?=\s|$)/i);
            if (strike) {
                i.strike = S.decimal(strike[1]);
                i.right = /^PU/i.test(strike[2]) ? 'P' : 'C';
                if (!/^(CALL|PUT)$/i.test(strike[2])) p.rightInterpretation = {
                    method: 'option_right_prefix', token: strike[2], value: i.right };
            }
        }
        i.exchange = description.match(/@([A-Z]+)/)?.[1] || null;
        // The header gives no currency/deliverable proof, so these remain unknown.
        if (hasFop && !fop) p.issues.push('FOP 交易类别未完整识别');
        if (i.secType === 'FUT' && expiry && /^\d+(?:\.\d+)?\s/.test(description.slice(expiry.index + expiry[0].length).trim())) p.issues.push('期货描述中出现疑似期权行权价，请确认合约类型');
    }
    const SHORT_CODE = /^\(?[A-Z][A-Z0-9]{0,10}(?:\.[A-Z0-9]{1,4})?\)?$/;
    const CLASS_TOKEN = /^[([][A-Z0-9][A-Z0-9]{0,10}(?:\.[A-Z0-9]{1,4})?[)\]]$/;
    function overlap(a, b) {
        const x = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
        const y = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
        const union = a[2] * a[3] + b[2] * b[3] - x * y;
        return union > 0 ? x * y / union : 0;
    }
    function refineWords(words, rereads, left, right) {
        const byLine = new Map();
        for (const r of (Array.isArray(rereads) ? rereads.slice(0, 96) : [])) {
            if (r && Array.isArray(r.passes) && r.passes.length <= 3) byLine.set(r.lineId, r);
        }
        return words.map(word => {
            const x = word.bbox[0] + word.bbox[2] / 2, line = byLine.get(word.lineId);
            const preceding = words.filter(w => w.lineId === word.lineId && w.bbox[0] < word.bbox[0]
                && w.bbox[0] + w.bbox[2] / 2 >= left).sort((a, b) => b.bbox[0] - a.bbox[0])[0];
            const classContext = /^FOP$/i.test(preceding?.text || '') && CLASS_TOKEN.test(word.text);
            const exchangeContext=word.exchangeSlot===true||/^@[A-Z]+$/.test(word.text);
            if (!line || x < left || x >= right || (!SHORT_CODE.test(word.text) && !classContext&&!exchangeContext)) return word;
            const matches = line.passes.filter(p => p && [2, 3].includes(p.scale)).map(pass => {
                if (!Array.isArray(pass.words) || pass.words.length > 1000) return null;
                const candidates = pass.words.filter(validWord).map(w => ({ ...w, score: overlap(word.bbox, w.bbox) }))
                    .filter(w => w.score >= .3
                        && (exchangeContext ? /^@[A-Z]+$/.test(w.text) : classContext ? /^\([A-Z0-9][A-Z0-9.]{0,11}\)$/.test(w.text)
                            : SHORT_CODE.test(w.text) && word.text.startsWith('(') === w.text.startsWith('(')
                                && word.text.endsWith(')') === w.text.endsWith(')')))
                    .sort((a, b) => b.score - a.score);
                if (!candidates[0] || (candidates[1] && candidates[0].text !== candidates[1].text
                    && candidates[0].score - candidates[1].score < .1)) return null;
                return { scale: pass.scale, text: candidates[0].text, bbox: candidates[0].bbox,
                    ...(candidates[0].inkBbox ? { inkBbox: candidates[0].inkBbox } : {}) };
            });
            if (matches.length !== 2 || matches.some(m => !m) || new Set(matches.map(m => m.scale)).size !== 2) return word;
            const agreed = matches[0].text === matches[1].text;
            const next = { ...word };
            if (agreed && matches.every(m => validWord({ text: '', bbox: m.inkBbox }) && overlap(m.bbox, m.inkBbox) >= .3)
                && Math.abs(matches[0].inkBbox[0] - matches[1].inkBbox[0]) <= .001
                && matches.every(m => Math.abs(m.inkBbox[0] - word.bbox[0]) <= word.bbox[2] * .35)) {
                next.layoutEvidence = { method: 'aligned_crop_ink_geometry', originalBbox: S.clone(word.bbox),
                    selectedBbox: word.bbox.map((_, i) => (matches[0].inkBbox[i] + matches[1].inkBbox[i]) / 2), passes: matches };
            }
            if (!agreed || matches[0].text !== word.text) {
                next.text = agreed ? matches[0].text : word.text; next.originalText = word.text;
                next.refinement = { method: 'crop_consensus', status: agreed ? 'agreed' : 'disagreed',
                    originalText: word.text, selectedText: agreed ? matches[0].text : word.text, passes: matches };
            }
            return next;
        });
    }
    function comboSignal(desc) {
        // Names are hints for collapsed rows; expanded unknown names use the indentation tree.
        if (/^[A-Z][A-Z0-9.]*$/.test(desc)) return false;
        const label = desc.replace(/^[A-Z][A-Z0-9.]*\s+/, '').replace(/\bFOP\s*[([][A-Z0-9][A-Z0-9.]{0,11}[)\]]/gi, 'FOP');
        const withoutDates = label.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '');
        return /\d+(?:\.\d+)?\s*\/\s*\d/.test(withoutDates)
            || /\b(?:BAG|COMBO|SPREAD|STRADDLE|STRANGLE|CONDOR|BUTTERFLY|CALENDAR|DIAGONAL|COLLAR|COVERED\s*CALL|RATIO|VERTICAL|SYNTHETIC|BearP|BullP|BearC|BullC)\b/i.test(label)
            || /(?:Iron|BrokenWing|Covered)(?:Condor|Butterfly|Call)\b/i.test(label)
            || (label.match(/\b(?:CALL|PUT)\b/gi) || []).length > 1;
    }
    function quantityFromRereads(rereads, row, left, right) {
        if (!Array.isArray(rereads)) return null;
        const inRow = b => Math.abs(b[1] + b[3] / 2 - row.cy) <= row.height * .6;
        const crops = rereads.slice(0, 64).filter(r => r?.field === 'quantity' && validWord({ text: '', bbox: r.cropBbox })
            && Math.abs(r.cropBbox[0] - left) < .003 && Math.abs(r.cropBbox[0] + r.cropBbox[2] - right) < .003
            && inRow(r.cropBbox) && r.cropBbox[3] <= row.height * 2.2
            && r.cropBbox[1] <= row.cy && r.cropBbox[1] + r.cropBbox[3] >= row.cy);
        if (crops.length !== 1) return null;
        const crop = crops[0];
        if (!Array.isArray(crop.passes) || crop.passes.length !== 2 || new Set(crop.passes.map(p => p?.scale)).size !== 2) return null;
        const passes = [];
        for (const pass of crop.passes) {
            if (![3, 4].includes(pass?.scale) || !Array.isArray(pass.words) || !pass.words.length || pass.words.length > 32) return null;
            if (!pass.words.every(w => validWord(w) && inRow(w.bbox)
                && w.bbox[0] + w.bbox[2] / 2 >= left && w.bbox[0] + w.bbox[2] / 2 < right
                && w.bbox[0] >= crop.cropBbox[0] - .001 && w.bbox[0] + w.bbox[2] <= right + .001
                && w.bbox[1] >= crop.cropBbox[1] - .001
                && w.bbox[1] + w.bbox[3] <= crop.cropBbox[1] + crop.cropBbox[3] + .001)) return null;
            const text = [...pass.words].sort((a, b) => a.bbox[0] - b.bbox[0]).map(w => w.text).join(' ');
            let value;
            try { value = S.decimal(text); } catch (_) { return null; }
            if (value === null) return null;
            passes.push({ scale: pass.scale, text, value, words: S.clone(pass.words) });
        }
        if (passes[0].value !== passes[1].value) return null;
        return { method: 'quantity_crop_consensus', status: 'agreed', originalValue: null,
            selectedValue: passes[0].value, cropBbox: S.clone(crop.cropBbox), passes };
    }
    function atomicLike(desc) {
        if (/^[A-Z][A-Z0-9.]*$/.test(desc)) return true;
        // Incomplete single-contract terms remain positions with missing fields, not invented summaries.
        return /\bFOP\s*\(/i.test(desc) || /\b(?:CALL|PUT|CAL|CA|PU)\b/i.test(desc)
            || (/@[A-Z]+/.test(desc) && /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d/i.test(desc));
    }
    function singleContract(desc) {
        if (/^[A-Z][A-Z0-9.]*$/.test(desc)) return true;
        const p = C.position('probe', 'probe'); terms(desc, p);
        return p.instrument.secType === 'FUT' ? !!p.instrument.expiryDate
            : ['OPT', 'FOP'].includes(p.instrument.secType) && !!p.instrument.expiryDate && p.instrument.strike !== null;
    }
    function completeContract(desc){
        const symbol='[A-Z][A-Z0-9.]*',date="(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s*\\d{1,2}\\s*['’‘\"“]?\\s*\\d{2}";
        const dots='(?:\\s*[.…]+)?',exchange='(?:\\s+@[A-Z]+)?';
        return singleContract(desc)&&(new RegExp('^'+symbol+'$').test(desc)
            ||new RegExp('^'+symbol+'\\s+'+date+'\\s+@[A-Z]+'+dots+'$','i').test(desc)
            ||new RegExp('^'+symbol+'\\s+(?:FOP\\s*\\([A-Z0-9][A-Z0-9.]{0,11}\\)\\s+)?'+date+'\\s+\\d+(?:\\.\\d+)?\\s+(?:CALL|CAL|CA|PUT|PU)'+dots+exchange+dots+'$','i').test(desc));
    }
    function refineNumericWords(words, rereads) {
        return words.map(w => {
            const matches = (Array.isArray(rereads) ? rereads.slice(0,32) : []).filter(r => r.originalText === w.text
                && Array.isArray(r.originalBbox) && overlap(r.originalBbox,w.bbox) > .95);
            if (matches.length !== 1) return w;
            const r = matches[0];
            if (r.method !== 'vertical_border_crop_consensus' || !validWord({text:'',bbox:r.cropBbox}) || !validWord({text:'',bbox:r.ruleBbox})
                || overlap(r.cropBbox,w.bbox) < .5 || Math.abs(r.cropBbox[0]-w.bbox[0])>.001 || r.ruleBbox[0]<w.bbox[0]+w.bbox[2]/2
                || r.ruleBbox[3]<w.bbox[3]*2 || r.cropBbox[0]+r.cropBbox[2]>r.ruleBbox[0]+.001
                || !Array.isArray(r.passes) || r.passes.length !== 2 || new Set(r.passes.map(p=>p.scale)).size !== 2) return w;
            const texts = r.passes.map(p => {
                if (![2,3].includes(p.scale) || !Array.isArray(p.words) || !p.words.length || p.words.length > 8
                    || !p.words.every(x=>validWord(x) && x.bbox[0]>=r.cropBbox[0]-.001 && x.bbox[0]+x.bbox[2]<=r.cropBbox[0]+r.cropBbox[2]+.001
                        && x.bbox[1]>=r.cropBbox[1]-.001 && x.bbox[1]+x.bbox[3]<=r.cropBbox[1]+r.cropBbox[3]+.001)) return null;
                const text = [...p.words].sort((a,b)=>a.bbox[0]-b.bbox[0]).map(x=>x.text).join('');
                return /^[+-]?[0-9][0-9,.]*%?$/.test(text) && (text.match(/^[+-]/)?.[0]||'')===(w.text.match(/^[+-]/)?.[0]||'') ? text : null;
            });
            if (!texts[0] || texts[0] !== texts[1]) return w;
            return {...w,text:texts[0],originalText:w.text,refinement:{...S.clone(r),status:'agreed',selectedText:texts[0]}};
        });
    }
    // Protocol 2 (cell review): the engine measures text-line bands from pixels. A word
    // joins the band its box overlaps most (detector boxes are taller than glyphs); a
    // word touching no band still forms its own row, so no text silently disappears.
    function bandRows(words, bands) {
        if (!Array.isArray(bands) || bands.length > 4000 || !bands.every((b, i) => Array.isArray(b) && b.length === 2
            && b.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) && b[0] < b[1]
            && (!i || bands[i - 1][1] <= b[0]))) throw new Error('识别结果的行带证据无效，请重新识别。');
        const rows = bands.map(b => ({ cy: (b[0] + b[1]) / 2, height: b[1] - b[0], band: b, words: [] })), loose = [];
        for (const w of words) {
            const shared = r => Math.min(w.bbox[1] + w.bbox[3], r.band[1]) - Math.max(w.bbox[1], r.band[0]);
            const row = rows.reduce((best, r) => shared(r) > (best ? shared(best) : 0) ? r : best, null);
            (row ? row.words : loose).push(w);
        }
        return [...rows, ...(loose.length ? group(loose) : [])].sort((a, b) => a.cy - b.cy)
            .map(row => { const ws = [...row.words].sort((a, b) => a.bbox[0] - b.bbox[0]); return { ...row, words: ws, text: ws.map(w => w.text).join(' ') }; });
    }
    // A cell whose crop held no glyph ink at either scale is blank, not unread.
    function cellAnswers(result, request) {
        const b = request.cropBbox, epsilonX = result.width > 0 ? 2 / result.width : .001, epsilonY = result.height > 0 ? 2 / result.height : .001;
        return (Array.isArray(result.reviewRereads) ? result.reviewRereads : []).filter(r => r && r.field === request.field
            && Array.isArray(r.cropBbox) && r.cropBbox.length === 4 && r.cropBbox.every((v, i) => Math.abs(v - b[i]) <= (i % 2 ? epsilonY : epsilonX)));
    }
    function blankCell(result, request) {
        const matches = cellAnswers(result, request);
        return matches.length === 1 && matches[0].blank === true && Array.isArray(matches[0].passes) && matches[0].passes.length === 2
            && new Set(matches[0].passes.map(p => p?.scale)).size === 2 && matches[0].passes.every(p => [3, 4].includes(p?.scale) && Array.isArray(p.words) && !p.words.length);
    }
    // A legal first reading and an agreed same-cell reread that differ: neither is proven.
    function readingConflict(label, c) {
        return label + ' 首读 ' + c.first + ' 与两次同格放大读数 ' + c.reread + ' 不一致'
            + ((Number(c.first) < 0) !== (Number(c.reread) < 0) ? '（正负号也不同）' : '') + '；保留未知，请核对原图。';
    }
    // Why a cell-review value stayed unknown; a blank cell has no problem.
    function cellProblem(label, c) {
        if (!c || c.proof || c.blank) return null;
        return c.signConflict ? label + ' 两次读数一致，但正负号与单元格像素中的负号不符；保留未知，请核对原图。'
            : !c.answered ? label + ' 单元格未收到局部复核答复；保留未知，请重试或核对原图。'
            : label + ' 单元格两次放大读数不一致或无法识别为数字；保留未知，请核对原图。';
    }
    function normalize(result, sourceId) {
        if (!result || !Array.isArray(result.words) || result.words.length > 12000 || !result.words.every(validWord)) throw new Error('识别结果不是有效的文字定位数据');
        const aspect = result.width > 0 && result.height > 0 ? result.height / result.width : 1;
        const layout = detectLayout(result.words, result.headerRereads || [], aspect), { header, edges, scale } = layout;
        const refined = refineNumericWords(refineWords(result.words, result.rereads, edges[1], edges[2]), result.numericRereads);
        // Protocol 2 (cell review, RapidOCR): rows come from measured pixel bands and every
        // numeric cell is adopted only when its 3x and 4x crops agree; the first pass only
        // locates text. Protocol 1 (Vision) keeps its targeted reviews unchanged.
        const cellMode = result.reviewProtocol === 2;
        const plans = reviewPlan(cellMode ? bandRows(refined, result.rowBands) : group(refined), {...layout,width:result.width});
        const sourceRows = [], positions = [], cash = [], unmatched = [];
        const entries = [], structureIssues = [], tolerance = .004 * scale;
        const reviewCrops = [], requireReview = result.reviewProtocol === 1 || cellMode;
        const cellRequests = plan => Object.fromEntries([['dailyPnl', plan.daily], ['quantity', plan.quantity], ['avgPrice', plan.avg], ...Object.entries(plan.numeric)]
            .filter(([key]) => layout.headers.some(h => h.key === key)));
        let afterCash = false;
        for (const plan of plans) {
            const originalRow = plan.row, rowReview = requireReview ? verifiedRow(result,plan.description,edges) : null;
            const cellReviews = {};
            if (cellMode) for (const [key, request] of Object.entries(cellRequests(plan))) {
                // Two reads of the same pixels can drop a one-pixel minus together, so the
                // sign must also match the engine's pixel evidence for a leading dash.
                const read = verifiedNumber(result, request);
                const signConflict = !!read && (typeof read.leadingDash !== 'boolean' || (Number(read.selectedValue) < 0) !== read.leadingDash);
                cellReviews[key] = { request, proof: signConflict ? null : read, signConflict, blank: blankCell(result, request),
                    answered: cellAnswers(result, request).length > 0 };
            }
            const row = rowReview ? {...originalRow, words:[...rowReview.words,
                ...originalRow.words.filter(w=>{const x=w.bbox[0]+w.bbox[2]/2;return x<edges[1]||x>=edges[2];})].sort((a,b)=>a.bbox[0]-b.bbox[0])} : originalRow;
            const cells = {}, originals = {};
            const excludedDecorations = [];
            for (const w of row.words) {
                const x = w.bbox[0] + w.bbox[2] / 2;
                const index = columnIndex(x,edges);
                const d = w.decorationEvidence, next = row.words.find(n=>n.bbox[0]>w.bbox[0] && /^[0-9]/.test(n.text));
                if (index >= 2 && /^[^\p{L}\p{N}]+$/u.test(w.text) && d?.method === 'compact_colored_square' && d.fill >= .75
                    && validWord({text:'',bbox:d.inkBbox}) && next && columnIndex(next.bbox[0]+next.bbox[2]/2,edges)===index
                    && next.bbox[0] - (d.inkBbox[0] + d.inkBbox[2]) > d.inkBbox[2] * 3) {
                    excludedDecorations.push(S.clone(w)); continue;
                }
                if (index >= 0) (cells[COLS[index]] ||= []).push(w.text);
            }
            for (const w of originalRow.words) {
                if(excludedDecorations.some(d=>d.text===w.text&&overlap(d.bbox,w.bbox)>.99))continue;
                const x=w.bbox[0]+w.bbox[2]/2,j=columnIndex(x,edges);
                if(j>=0)(originals[COLS[j]]||=[]).push(w.originalText??w.text);
            }
            const normalizedCells = Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v.join(' ')]));
            const rawCells = Object.fromEntries(Object.entries(originals).map(([k, v]) => [k, v.join(' ')]));
            const desc = (normalizedCells.description || '').trim();
            const isTotal = /^TOTAL\b/i.test(desc), isCash = /\b[A-Z]{3}\s+CASH\b/i.test(desc);
            const combo = comboSignal(desc);
            const alignedNumbers = Object.keys(rawCells).some(k => !['description'].includes(k) && /[0-9]/.test(rawCells[k]))
                || Object.values(cellReviews).some(c => c.proof);
            const looksPosition = /^[A-Za-z][A-Za-z0-9.]*\b/.test(desc) && (alignedNumbers || (desc.includes(' ') && singleContract(desc)));
            const footerPosition = afterCash && !isCash && alignedNumbers && ((desc.includes(' ') && singleContract(desc)) || (rawCells.mark && rawCells.marketValue));
            const codeOnly = /^[A-Z][A-Z0-9.]*$/.test(desc);
            // A measured band whose text the first pass missed entirely is reviewed, not dropped.
            const wordless = cellMode && !originalRow.words.length && !rowReview;
            const decoration = !wordless && ((afterCash && !isCash && !footerPosition) || (!isTotal && !isCash && !combo && !looksPosition && !alignedNumbers && !codeOnly));
            const incompleteRow = !isCash&&!isTotal&&!combo&&((codeOnly&&!alignedNumbers)||(alignedNumbers&&!looksPosition));
            const reviewPending = requireReview && !rowReview && !afterCash && !isCash && !decoration;
            const originalIdentity=C.position('probe','probe'),reviewedIdentity=C.position('probe','probe');
            terms(rawCells.description||'',originalIdentity);terms(desc,reviewedIdentity);
            const dailyNeedsReview=requireReview&&rowReview&&JSON.stringify(originalIdentity.instrument)!==JSON.stringify(reviewedIdentity.instrument);
            const averageReview = requireReview ? verifiedNumber(result,plan.avg) : null;
            const dailyReview = requireReview ? verifiedNumber(result,plan.daily) : null;
            const numericReviews={}, unreadNumericCells={}, numericRequests=[], numericChecks={}, numericConflicts={};
            if(requireReview&&!cellMode)for(const [key,request]of Object.entries(plan.numeric)){
                let first=null;try{first=S.decimal(normalizedCells[key],key==='displayIv');}catch(_){}
                // A broker price qualifier is source text, not a decoration. Never
                // request a numeric-only replacement that could discard its letters.
                if(key==='lastPrice'&&/\p{L}/u.test(normalizedCells[key]||''))continue;
                const proof=verifiedNumber(result,request);
                if(first!==null){
                    // A legal first reading is still checked against the same cell at 3x/4x:
                    // agreement confirms it; an agreed reread that differs proves neither
                    // reading (two rereads can drop the same digit), so the value stays
                    // unknown with both readings; no agreement keeps it marked as unchecked.
                    if(!proof){numericRequests.push(request);numericChecks[key]='unchecked';}
                    else if(proof.selectedValue===first)numericChecks[key]='confirmed';
                    else{numericChecks[key]='reread_conflict';numericConflicts[key]={first,reread:proof.selectedValue};}
                    continue;
                }
                if(proof)numericReviews[key]=proof;else{
                    numericRequests.push(request);const unresolved=unreadNumber(result,request);if(unresolved)unreadNumericCells[key]=unresolved;
                }
            }
            if(cellMode&&!decoration&&(!afterCash||isCash)){
                if(!rowReview&&!isCash)reviewCrops.push(plan.description);
                for(const [key,c] of Object.entries(cellReviews))if(!c.proof&&!c.blank&&(isCash?key==='marketValue':!isTotal))reviewCrops.push(c.request);
            }else if(requireReview&&!cellMode&&!afterCash&&!isCash&&!decoration){
                if(!rowReview)reviewCrops.push(plan.description);
                if(!isTotal&&rawCells.avgPrice&&!averageReview)reviewCrops.push(plan.avg);
                if(!isTotal&&!dailyReview)reviewCrops.push(plan.daily);
                if(!isTotal)reviewCrops.push(...numericRequests);
            }
            if (decoration) unmatched.push({ rawText: row.text, bbox: [0, Math.max(0, row.cy - row.height), 1, row.height * 2] });
            const descriptionWords = row.words.filter(w => { const x = w.bbox[0] + w.bbox[2] / 2; return x >= edges[1] && x < edges[2]; });
            const first = descriptionWords[0], measurement = first?.layoutEvidence;
            const indent = measurement?.selectedBbox[0] ?? first?.bbox[0] ?? edges[1];
            const indentRange = measurement ? [Math.min(...measurement.passes.map(p => p.inkBbox[0])), Math.max(...measurement.passes.map(p => p.inkBbox[0]))] : [indent, indent];
            entries.push({ row, originalRow, rowReview, averageReview, dailyReview, numericReviews, numericChecks, numericConflicts, cellReviews, unreadNumericCells, dailyNeedsReview, reviewPending, incompleteRow, hierarchyNeutral:decoration||incompleteRow, rawCells, normalizedCells, excludedDecorations, desc, isTotal, isCash, combo: afterCash ? false : combo, decoration, footerPosition, afterCash, indent, indentRange,
                indentMeasurement: measurement || { method: 'first_pass', originalBbox: first?.bbox || null },
                atomic: !afterCash && atomicLike(desc), single: !afterCash && singleContract(desc) });
            if (isCash) afterCash = true;
        }
        const isIndented = (child, parent) => child.indentRange[0] > parent.indentRange[1] + tolerance;
        const stack = [];
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index], { row, rawCells, normalizedCells, desc, isTotal, isCash } = entry;
            const next = entries.slice(index + 1).find(e => !e.hierarchyNeutral);
            const indentedChildren = next && !next.isTotal && !next.isCash && isIndented(next, entry);
            const combo = entry.combo || (indentedChildren && !entry.single);
            const id = 'row-' + (sourceRows.length + 1);
            const top = row.band ? row.band[0] : Math.min(...row.words.map(w => w.bbox[1])), bottom = row.band ? row.band[1] : Math.max(...row.words.map(w => w.bbox[1] + w.bbox[3]));
            const ambiguous = !isTotal && !isCash && !combo && indentedChildren && entry.single;
            const type = entry.decoration ? 'decoration' : entry.reviewPending||entry.incompleteRow ? 'unclassified' : isTotal ? 'group_summary' : isCash ? 'cash' : combo ? 'combo_summary' : entry.atomic && !ambiguous ? 'position' : 'unclassified';
            if (isTotal || isCash) stack.length = 0;
            while (!entry.hierarchyNeutral && stack.length && !isIndented(entry, stack.at(-1))) {
                const parent = stack.at(-1);
                if (entry.indentRange[1] > parent.indentRange[0] + tolerance) structureIssues.push({ rowId: id,
                    code: 'indentation_uncertain', message: '两次局部重读的缩进处于归属边界，无法确认组合归属，请对照原图。' });
                stack.pop();
            }
            const sourceRow = { rowId: id, sourceId, rowType: type, parentRowId: entry.hierarchyNeutral ? null : stack.at(-1)?.id || null,
                bbox: [0, Math.max(0, top - row.height * .2), 1, Math.min(1 - Math.max(0, top - row.height * .2), bottom - top + row.height * .4)],
                cellBounds: [0, top, 1, bottom - top],
                rawText: entry.originalRow.words.map(w => w.originalText ?? w.text).join(' '), recognizedText: row.words.map(w=>w.text).join(' '), rawCells, normalizedCells,
                ocrRefinements: row.words.filter(w => w.refinement).map(w => w.refinement),
                ...(entry.rowReview?{rowRefinement:entry.rowReview.evidence}:{}),
                ...(entry.averageReview?{averageRefinement:entry.averageReview}:{}),
                ...(entry.dailyReview?{dailyRefinement:entry.dailyReview}:{}),
                ...(Object.keys(entry.numericReviews).length?{numericCellRefinements:entry.numericReviews}:{}),
                ...(Object.keys(entry.unreadNumericCells).length?{unreadNumericCells:entry.unreadNumericCells}:{}),
                ...(cellMode?{cellReviews:Object.fromEntries(Object.entries(entry.cellReviews).map(([k,c])=>[k,c.proof||{method:c.blank?'blank_cell':c.signConflict?'sign_conflict':'cell_unconfirmed',status:c.blank?'blank':'unresolved'}]))}:{}),
                ...(row.band?{rowBand:S.clone(row.band)}:{}),
                excludedDecorations: entry.excludedDecorations,
                classificationEvidence: { reason: entry.footerPosition ? 'possible_additional_table_after_cash' : entry.afterCash && !isCash ? 'below_cash_footer' : entry.decoration ? 'no_aligned_table_evidence' : 'aligned_table_row' },
                hierarchyEvidence: { indent: entry.indent, indentRange: entry.indentRange, indentMeasurement: entry.indentMeasurement } };
            if (type === 'combo_summary') {
                sourceRow.hierarchyEvidence.reason = indentedChildren ? 'indented_children' : 'strategy_or_multiple_terms';
                stack.push({ id, indent: entry.indent, indentRange: entry.indentRange });
            }
            if (type === 'unclassified') structureIssues.push({ rowId: id, code: 'row_role_ambiguous',
                message: entry.reviewPending ? '本行的合约与数值归属尚未通过局部重读，保留原文，暂不计仓；请重试或人工核对。'
                    : ambiguous ? '本行像单独持仓，但同时带缩进子行；无法确认是否汇总，暂不计入原子持仓。'
                    : '未能确认本行是单独合约还是组合；原文保留，暂不计入原子持仓。' });
            sourceRows.push(sourceRow);
            if (isCash) {
                // Cash keeps the same field evidence as a position value: the first reading,
                // why it stayed unknown, and any machine correction for the batch confirmation.
                let amount = null, originalAmount = null, problem = null, corrections = [];
                try { originalAmount = S.decimal(rawCells.marketValue); } catch (_) { /* unknown */ }
                if (cellMode) {
                    const c = entry.cellReviews.marketValue;
                    amount = c?.proof?.selectedValue ?? null; problem = cellProblem('现金金额', c);
                    if (amount !== null && amount !== originalAmount) corrections = [c.proof];
                } else {
                    amount = originalAmount;
                    if (amount === null && rawCells.marketValue) problem = '现金金额原文无法确认：' + rawCells.marketValue + '；保留未知，请核对原图。';
                }
                cash.push({ sourceRowId: id, currency: desc.match(/[A-Z]{3}/)?.[0] || null, amount, raw: rawCells.marketValue || null,
                    originalAmount, problem, corrections, reviewStatus: 'unreviewed' });
            }
            if (type !== 'position') continue;
            const p = C.position(id, id);
            terms(desc, p);
            const firstPass = C.position(id, id); terms(rawCells.description || '', firstPass);
            if(!rawCells.description?.trim())firstPass.instrument=S.instrument();
            const quantityRefinement = !cellMode && !rawCells.quantity?.trim() ? quantityFromRereads(result.quantityRereads, row, edges[4], edges[5]) : null;
            if (quantityRefinement) sourceRow.quantityRefinement = quantityRefinement;
            for (const f of S.FIELDS) {
                const key = f.path.startsWith('displayValues.') ? f.path.split('.')[1] : f.path;
                const raw = rawCells[key] ?? null;
                let value = S.get(p, f.path), problem = null;
                if (f.kind === 'number' || f.kind === 'percent') {
                    if (f.path === 'instrument.strike' || f.path === 'instrument.multiplier') { /* terms/unknown */ }
                    else {
                        try { value = f.path === 'quantity' && quantityRefinement ? quantityRefinement.selectedValue : S.decimal(normalizedCells[key] ?? raw, f.kind === 'percent'); }
                        catch (_) { value = null; problem = f.label + ' 原文无法确认：' + raw; }
                        if(value===null&&entry.numericReviews[key]){value=entry.numericReviews[key].selectedValue;problem=null;}
                        const check=cellMode?null:entry.numericChecks[key];
                        if(check==='reread_conflict'){value=null;problem=readingConflict(f.label,entry.numericConflicts[key]);}
                        if(check==='unchecked')problem=f.label+' 首读未经同格复核（两次放大缺失或不一致），数值仅供参考，请核对原图。';
                        if(value===null&&entry.unreadNumericCells[key])problem=f.label+' 单元格检测到字形，但两次局部识别未能确认数字；保留未知，请核对原图。';
                        if(cellMode){
                            const c=entry.cellReviews[key];
                            if(c?.proof){value=c.proof.selectedValue;problem=null;}
                            else{value=null;problem=cellProblem(f.label,c);}
                        }else if(requireReview&&(key==='avgPrice'||key==='dailyPnl'&&entry.dailyNeedsReview)){
                            const numberReview=key==='avgPrice'?entry.averageReview:entry.dailyReview;
                            let original=null;try{original=S.decimal(raw);}catch(_){}
                            if(key==='dailyPnl'&&numberReview&&original!==null&&original!==numberReview.selectedValue){
                                entry.numericConflicts[key]={first:original,reread:numberReview.selectedValue};
                                value=null;problem=readingConflict(f.label,entry.numericConflicts[key]);
                            }else if(numberReview&&(key==='dailyPnl'||original===null||(Number(original)<0)===(Number(numberReview.selectedValue)<0)))value=numberReview.selectedValue;
                            else{value=null;problem=f.label+'局部重读缺失、不一致或符号变化；首轮数字仅供对照，请核对原图。';}
                        }
                    }
                }
                S.set(p, f.path, value);
                let originalValue = f.path === 'quantity' && quantityRefinement ? null : f.path.startsWith('instrument.') ? S.get(firstPass, f.path) : value;
                if(!f.path.startsWith('instrument.')){try{originalValue=S.decimal(raw,f.kind==='percent');}catch(_){originalValue=null;}}
                const numericCorrections = row.words.filter(w=>w.refinement?.method==='vertical_border_crop_consensus'
                    && columnIndex(w.bbox[0]+w.bbox[2]/2,edges)===COLS.indexOf(key)).map(w=>w.refinement);
                if (numericCorrections.length) { try {originalValue=S.decimal(raw,f.kind==='percent');}catch(_){originalValue=null;} }
                const corrections = cellMode && entry.cellReviews[key]?.proof && originalValue!==value && value!==null ? [entry.cellReviews[key].proof]
                    : f.path === 'quantity' && quantityRefinement ? [quantityRefinement]
                    : originalValue!==value&&value!==null&&entry.numericReviews[key] ? [entry.numericReviews[key]]
                    : originalValue!==value&&value!==null&&key==='avgPrice'&&entry.averageReview ? [entry.averageReview]
                    : originalValue!==value&&value!==null&&key==='dailyPnl'&&entry.dailyReview ? [entry.dailyReview]
                    : originalValue!==value&&entry.rowReview&&f.path.startsWith('instrument.') ? [entry.rowReview.evidence]
                    : f.path.startsWith('instrument.')&&originalValue!==value ? sourceRow.ocrRefinements.filter(r => r.status === 'agreed') : numericCorrections;
                p.fieldEvidence[f.path] = { source: 'ocr', raw: raw ?? (f.path.startsWith('instrument.') ? rawCells.description : null),
                    originalValue, recognizedValue: value, corrections, reviewStatus: 'unreviewed', problem };
                if (cellMode && entry.cellReviews[key] && !entry.cellReviews[key].blank && !entry.cellReviews[key].proof)
                    p.fieldEvidence[f.path].cellCheck = 'unresolved';
                if(!cellMode&&entry.numericChecks[key])p.fieldEvidence[f.path].cellCheck=entry.numericChecks[key];
                if(!cellMode&&entry.numericConflicts[key])p.fieldEvidence[f.path].conflictingReadings=S.clone(entry.numericConflicts[key]);
                if(f.path==='displayValues.displayIv'&&!layout.headers.some(h=>h.key==='displayIv'))p.fieldEvidence[f.path].availability='column_not_present';
                if (f.path === 'instrument.right' && p.rightInterpretation) p.fieldEvidence[f.path].interpretation = p.rightInterpretation;
            }
            delete p.rightInterpretation;
            if (sourceRow.ocrRefinements.some(r => r.status === 'disagreed')) p.issues.push('局部放大重读不一致，保留首次文字，请人工核对。');
            if (sourceRow.ocrRefinements.some(r=>r.method==='vertical_border_crop_consensus')) p.issues.push('数字中的边框已按像素证据裁除并局部重读，请对照原图核对。');
            positions.push(p);
        }
        const byId = new Map(sourceRows.map(r => [r.rowId, r]));
        for (const parent of sourceRows.filter(r => r.rowType === 'combo_summary')) {
            const descendants = sourceRows.filter(r => {
                let ancestor = r.parentRowId;
                while (ancestor) { if (ancestor === parent.rowId) return true; ancestor = byId.get(ancestor)?.parentRowId; }
                return false;
            });
            const legs = descendants.filter(r => r.rowType === 'position');
            const unknown = descendants.some(r => r.rowType === 'unclassified')
                || descendants.some(r => r.rowType === 'combo_summary' && !sourceRows.some(c => c.parentRowId === r.rowId));
            parent.combo = { childRowIds: sourceRows.filter(r => r.parentRowId === parent.rowId).map(r => r.rowId),
                atomicLegRowIds: legs.map(r => r.rowId), status: !descendants.length ? 'collapsed' : legs.length < 2 || unknown ? 'incomplete' : 'expanded_visible',
                expectedLegCount: null };
            if (parent.combo.status !== 'expanded_visible') structureIssues.push({ rowId: parent.rowId,
                code: parent.combo.status === 'collapsed' ? 'combo_collapsed' : 'combo_legs_incomplete',
                message: !descendants.length ? '组合未展开或子腿不可见；不把父行当持仓，也不猜测子腿。'
                    : '组合仅见部分腿或有未分类子行；当前原子持仓不代表完整组合。' });
        }
        if (!sourceRows.length) throw new Error('找到了表头，但未读取到可核验的行。请调整截图后重试。');
        const normalized = { sourceRows, positions, cash, accountSummary: {}, recognition: {
            status: 'needs_review', provider: result.engine, model: result.model, promptVersion: 'tws-row-review-v8', reviewProtocol: result.reviewProtocol || null,
            runId: result.runId, elapsedMs: result.elapsedMs, header: header.text, tableLayout: { edges, headers: layout.headers, columns:layout.headers.map(h=>h.key), evidence: layout.evidence },
            warnings: ['所有字段均待人工核对；仅识别当前可见范围。', '账号和持仓日期未从到期分组或弹窗推断。'],
            structureIssues, refinements: [...refined.filter(w => w.refinement).map(w => w.refinement),
                ...sourceRows.filter(r => r.quantityRefinement).map(r => ({ rowId: r.rowId, ...r.quantityRefinement }))],
            unmatchedRows: unmatched, originalWords: S.clone(result.words), originalLines: S.clone(result.lines || []),
            originalRereads: S.clone(result.rereads || []), originalQuantityRereads: S.clone(result.quantityRereads || []),
            originalReviewRereads: S.clone(result.reviewRereads || []) } };
        normalized.recognition.quantityCrops = quantityCrops(normalized);
        normalized.recognition.reviewCrops = reviewCrops.slice(0,cellMode?2048:1024);
        return S.redactRecognition(normalized);
    }
    g.OptionComboPortfolioSnapshotOcr = Object.freeze({ normalize, group, detectLayout, quantityCrops });
})(typeof globalThis !== 'undefined' ? globalThis : this);
