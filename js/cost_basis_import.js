/**
 * IBKR statement CSV -> ledger event drafts. DOM-free and Node-testable.
 *
 * Two export shapes are supported: a Flex Query flat CSV (one header row,
 * configurable columns, usually carrying a TradeID) and an Activity
 * Statement CSV (multi-section, each row prefixed with its section name).
 *
 * Rules this parser will not bend:
 *
 * - A required column that cannot be identified fails the file. Guessing a
 *   column in a money record is worse than making someone map it.
 * - IBKR records one assignment as two rows - the option closing at zero and
 *   the share delivery. They are paired into ONE event. An unpaired row
 *   becomes a problem row; it is never imported as an ordinary trade,
 *   because that would book the delivery twice or lose it entirely.
 * - Nothing here writes. The page must show the preview and let a human
 *   commit it.
 * - Cash follows the statement, not a re-derivation: Proceeds already
 *   carries IBKR's sign convention (negative when buying) and Comm/Fee is
 *   already negative, so cashAmount = proceeds + commission.
 *
 * IBKR localises statements: a Chinese account exports section names and
 * column headers in Chinese while DataDiscriminator and the Notes/Codes
 * letters stay English. Both languages are recognised here. Two traps that
 * only a real export reveals:
 *
 * - A Chinese Trades header names BOTH the contract column and the
 *   notes column 代码, so a name->index map keyed by header text silently
 *   overwrites the symbol with the codes. Columns are matched by scanning
 *   every occurrence and taking the first unclaimed one.
 * - One section can carry SEVERAL header rows with different layouts
 *   (Financial Instrument Information emits one for stocks and another for
 *   options). Records are grouped under the header that was in force when
 *   they were read; mapping a whole section through its last header would
 *   silently shift every earlier row by a column.
 */

(function attachCostBasisImport(globalScope) {
    'use strict';

    const SHARE_EPSILON = 1e-6;

    // Column aliases seen across Flex Query and Activity Statement exports.
    // Order matters: the first alias present wins.
    // Declaration order is load-bearing: a field declared earlier claims a
    // shared column name first. `symbol` before `codes` is what keeps the
    // Chinese statement's duplicate 代码 columns apart.
    const COLUMN_ALIASES = Object.freeze({
        account: ['clientaccountid', 'account', 'accountid', 'account id', '账户'],
        // Declared before `symbol` so a Flex export binds the underlying to
        // its own column and leaves `symbol` holding the contract's local
        // symbol. An Activity Statement has only the latter.
        underlyingSymbol: ['underlyingsymbol', 'underlying symbol', '底层'],
        symbol: ['symbol', '代码'],
        assetClass: ['assetclass', 'asset class', 'asset category', 'assetcategory',
                     '资产分类'],
        tradeDate: ['tradedate', 'trade date', 'date/time', 'datetime', 'date',
                    '日期/时间', '日期'],
        quantity: ['quantity', 'qty', '数量'],
        price: ['tradeprice', 'trade price', 't. price', 'price', '交易价格'],
        proceeds: ['proceeds', '收益'],
        commission: ['ibcommission', 'comm/fee', 'commission', 'comm', '佣金/税', '佣金'],
        right: ['putcall', 'put/call', 'right', '看跌/看涨', '类型'],
        strike: ['strike', '执行'],
        expiry: ['expiry', 'expiration', 'lasttradedate', 'last trade date', '到期'],
        multiplier: ['multiplier', '乘数', '合约乘数'],
        externalRef: ['tradeid', 'trade id', 'ibexecid', 'transactionid', 'execid',
                      '交易编号'],
        conId: ['conid', 'con id', '合约编号'],
        codes: ['notes/codes', 'notes', 'code', 'codes', '代码', '备注/代码'],
        discriminator: ['datadiscriminator', 'data discriminator'],
        description: ['description', '描述'],
        amount: ['amount', '金额'],
        // Activity Statements carry the original lot basis and the realised
        // result on closing rows.  They are the only authoritative way to
        // reconstruct a pre-period opening when the closing position is zero.
        basis: ['basis', 'cost basis', 'costbasis', '成本基础', '基础'],
        realizedPnl: ['realized p/l', 'realized pnl', 'realizedpnl',
                      'realized profit/loss', '已实现的损益'],
    });

    // Section names as IBKR spells them in each language.
    const SECTION_ALIASES = Object.freeze({
        trades: ['trades', '交易'],
        dividends: ['dividends', '股息'],
        withholdingTax: ['withholding tax', 'withholding taxes', '预扣税', '代扣税'],
        accountInformation: ['account information', '账户信息'],
        instruments: ['financial instrument information', '金融产品信息'],
        openPositions: ['open positions', '未平仓持仓'],
        corporateActions: ['corporate actions', '公司行动'],
    });

    const REQUIRED_TRADE_COLUMNS = Object.freeze([
        'symbol', 'assetClass', 'tradeDate', 'quantity',
    ]);

    const OPTION_ASSET_CLASSES = Object.freeze([
        'opt', 'options', 'equity and index options',
        '股票和指数期权', '股票期权', '指数期权', '期权',
    ]);
    const FOP_ASSET_CLASSES = Object.freeze([
        'fop', 'futures options', 'futures option', '期货期权',
    ]);
    const FUTURE_ASSET_CLASSES = Object.freeze([
        'fut', 'future', 'futures', '期货',
    ]);
    const STOCK_ASSET_CLASSES = Object.freeze([
        'stk', 'stocks', 'stock', 'etf', '股票', '基金',
    ]);

    /** RFC4180-ish reader: quoted fields, doubled quotes, CRLF or LF. */
    function parseCsv(text) {
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;
        // A BOM would otherwise ride along inside the first header cell and
        // stop the first column from ever matching an alias.
        const source = String(text === null || text === undefined ? '' : text)
            .replace(/^\uFEFF/, '');

        for (let index = 0; index < source.length; index += 1) {
            const character = source[index];
            if (quoted) {
                if (character === '"') {
                    if (source[index + 1] === '"') {
                        field += '"';
                        index += 1;
                    } else {
                        quoted = false;
                    }
                } else {
                    field += character;
                }
                continue;
            }
            if (character === '"') {
                quoted = true;
            } else if (character === ',') {
                row.push(field);
                field = '';
            } else if (character === '\n' || character === '\r') {
                if (character === '\r' && source[index + 1] === '\n') index += 1;
                row.push(field);
                field = '';
                if (row.some((value) => value !== '')) rows.push(row);
                row = [];
            } else {
                field += character;
            }
        }
        row.push(field);
        if (row.some((value) => value !== '')) rows.push(row);
        return rows;
    }

    function _normalizeHeader(value) {
        return String(value === null || value === undefined ? '' : value)
            .trim().toLowerCase().replace(/\s+/g, ' ');
    }

    function _upper(value) {
        return String(value === null || value === undefined ? '' : value)
            .trim().replace(/\s+/g, ' ').toUpperCase();
    }

    function _number(value) {
        if (value === null || value === undefined) return null;
        // Statements ship thousands separators and parenthesised negatives.
        const text = String(value).trim().replace(/,/g, '');
        if (!text) return null;
        const negated = /^\((.*)\)$/.exec(text);
        const parsed = parseFloat(negated ? negated[1] : text);
        if (!Number.isFinite(parsed)) return null;
        return negated ? -parsed : parsed;
    }

    function _isoDate(value) {
        const text = String(value === null || value === undefined ? '' : value).trim();
        if (!text) return '';
        const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
        if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
        const slashed = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(text);
        if (slashed) return `${slashed[1]}-${slashed[2]}-${slashed[3]}`;
        const digits = text.replace(/[^0-9]/g, '');
        if (digits.length >= 8) {
            return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        }
        return '';
    }

    /**
     * IBKR timestamps are account-local wall-clock values. Keep them that
     * way: converting through Date would silently move a trade to another
     * day on machines in a different timezone. The fixed-width result sorts
     * lexicographically. Date-only records describe an end-of-day balance.
     */
    function _brokerTimestamp(value) {
        const text = String(value === null || value === undefined ? '' : value).trim();
        const date = _isoDate(text);
        if (!date) return '';
        const time = /(?:^|[\s,T])(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
        if (time) {
            return `${date}T${time[1].padStart(2, '0')}:${time[2]}:${time[3] || '00'}`;
        }
        // Flex Query commonly emits account-local time as YYYYMMDD;HHMMSS
        // (and some custom queries remove the semicolon as well). Treating
        // that as an end-of-day date would break second-level reconciliation.
        const compact = /(?:^|[\s,T;])(\d{2})(\d{2})(\d{2})(?:\D|$)/.exec(text)
            || /^\D*\d{8}(\d{2})(\d{2})(\d{2})\D*$/.exec(text);
        if (!compact) return `${date}T23:59:59`;
        return `${date}T${compact[1]}:${compact[2]}:${compact[3]}`;
    }

    const PERIOD_MONTHS = Object.freeze({
        january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
        july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
        '一月': 1, '二月': 2, '三月': 3, '四月': 4, '五月': 5, '六月': 6,
        '七月': 7, '八月': 8, '九月': 9, '十月': 10, '十一月': 11, '十二月': 12,
    });

    function _periodEndDate(value) {
        const text = String(value === null || value === undefined ? '' : value).trim();
        const dates = [];
        const words = /(January|February|March|April|May|June|July|August|September|October|November|December|一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)\s+(\d{1,2}),\s*(\d{4})/gi;
        let match = words.exec(text);
        while (match) {
            const month = PERIOD_MONTHS[match[1].toLowerCase()] || PERIOD_MONTHS[match[1]];
            dates.push(`${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`);
            match = words.exec(text);
        }
        const iso = /(\d{4})-(\d{2})-(\d{2})/g;
        match = iso.exec(text);
        while (match) {
            dates.push(`${match[1]}-${match[2]}-${match[3]}`);
            match = iso.exec(text);
        }
        return dates.length ? dates[dates.length - 1] : '';
    }

    /** End of the reporting period, independent of the selected symbol. */
    function extractStatementThrough(rows) {
        let found = '';
        (rows || []).forEach((row) => {
            if (_normalizeHeader(row[0]) !== 'statement'
                || _normalizeHeader(row[1]) !== 'data'
                || _normalizeHeader(row[2]) !== 'period') return;
            const end = _periodEndDate(row[3]);
            if (end) found = `${end}T23:59:59`;
        });
        return found;
    }

    function _expiryDigits(value) {
        const iso = _isoDate(value);
        return iso ? iso.replace(/-/g, '') : '';
    }

    function _contractDigits(value) {
        const digits = String(value === null || value === undefined ? '' : value)
            .replace(/[^0-9]/g, '');
        return digits.length >= 8 ? digits.slice(0, 8)
            : (digits.length >= 6 ? digits.slice(0, 6) : '');
    }

    function _right(value) {
        const text = _upper(value);
        if (text.startsWith('P')) return 'P';
        if (text.startsWith('C')) return 'C';
        return '';
    }

    function _codes(value) {
        return _upper(value).split(/[;,\s|]+/).filter(Boolean);
    }

    function _assetKind(value) {
        const text = _normalizeHeader(value);
        if (FOP_ASSET_CLASSES.indexOf(text) >= 0) return 'fop';
        if (FUTURE_ASSET_CLASSES.indexOf(text) >= 0) return 'future';
        if (OPTION_ASSET_CLASSES.indexOf(text) >= 0) return 'option';
        if (STOCK_ASSET_CLASSES.indexOf(text) >= 0) return 'stock';
        return '';
    }

    /**
     * Map header names onto canonical fields; unknown headers are reported.
     *
     * Every occurrence of an alias is considered, not just the first. A
     * Chinese Trades header carries 代码 twice - the contract and the notes -
     * and stopping at the first match would leave the notes column unmapped
     * and every assignment misread as an ordinary trade.
     */
    function buildMapping(headers) {
        const normalized = (headers || []).map(_normalizeHeader);
        const mapping = {};
        const used = new Set();
        Object.keys(COLUMN_ALIASES).forEach((field) => {
            const aliases = COLUMN_ALIASES[field];
            for (let index = 0; index < aliases.length; index += 1) {
                const alias = aliases[index];
                for (let position = 0; position < normalized.length; position += 1) {
                    if (normalized[position] === alias && !used.has(position)) {
                        mapping[field] = position;
                        used.add(position);
                        return;
                    }
                }
            }
        });
        const unmapped = normalized
            .map((name, index) => ({ name, index }))
            .filter((item) => item.name && !used.has(item.index))
            .map((item) => item.name);
        return { mapping, unmapped, headers: normalized };
    }

    function _sectionMatches(name, sectionKey) {
        // Fail closed on an unknown key: an exception raised in here would
        // propagate out of the importer and take the page down with it.
        const aliases = SECTION_ALIASES[sectionKey];
        if (!aliases) return false;
        return aliases.indexOf(_normalizeHeader(name)) >= 0;
    }

    function detectFormat(rows) {
        if (!rows || !rows.length) return 'unknown';
        const sections = rows.map((row) => _normalizeHeader(row[0]));
        const looksSectioned = rows.some(
            (row) => _normalizeHeader(row[1]) === 'header'
                || _normalizeHeader(row[1]) === 'data');
        const hasKnownSection = sections.some(
            (name) => _sectionMatches(name, 'trades')
                || _sectionMatches(name, 'dividends')
                || _sectionMatches(name, 'accountInformation'));
        if (looksSectioned && hasKnownSection) {
            return 'activity';
        }
        // A header row carrying several statement column names is a flat
        // export even when a required one is absent: naming the missing
        // column is far more useful than "this is not a statement".
        const mapped = buildMapping(rows[0]).mapping;
        if (Object.keys(mapped).length >= 3) {
            return 'flex';
        }
        return 'unknown';
    }

    /**
     * Pull one section out of an Activity Statement.
     *
     * Only Data rows are taken. When a DataDiscriminator column exists,
     * "Order" rows are preferred and "Trade" rows are used only if there are
     * no Order rows: the two describe the same fill at different
     * granularities, and taking both double-counts every trade.
     */
    function extractSection(rows, sectionKey) {
        const groups = [];
        let current = null;
        (rows || []).forEach((row, index) => {
            if (!_sectionMatches(row[0], sectionKey)) return;
            const rowType = _normalizeHeader(row[1]);
            if (rowType === 'header') {
                const headers = row.slice(2);
                current = { headers, built: buildMapping(headers), records: [] };
                groups.push(current);
                return;
            }
            // SubTotal and Total rows repeat figures already counted in the
            // Data rows; taking them would double every position.
            if (rowType !== 'data' || !current) return;
            current.records.push({ values: row.slice(2), lineNumber: index + 1 });
        });
        if (!groups.length) return null;

        groups.forEach((group) => {
            const discriminator = group.built.mapping.discriminator;
            if (discriminator === undefined) return;
            // Order and Trade rows describe the same fill at different
            // granularities; taking both double-counts every trade.
            const orders = group.records.filter(
                (record) => _normalizeHeader(record.values[discriminator]) === 'order');
            const trades = group.records.filter(
                (record) => _normalizeHeader(record.values[discriminator]) === 'trade');
            if (orders.length) {
                group.records = orders;
            } else if (trades.length) {
                group.records = trades;
            }
            // Neither label matched: some sections discriminate by something
            // else entirely (Open Positions says "Summary"), and a locale
            // could translate the values. Dropping every row there would
            // fail silently as "0 drafts" with nothing to explain it, so
            // the records are kept as they are.

        });
        return { groups };
    }

    function _cellsToRecord(values, mapping) {
        const record = {};
        Object.keys(mapping).forEach((field) => {
            record[field] = values[mapping[field]];
        });
        return record;
    }

    function _classifyTrade(record, options) {
        const codes = _codes(record.codes);
        const assetKind = _assetKind(record.assetClass);
        const futuresBook = _upper((options || {}).secType) === 'FUT';
        if (assetKind === 'fop' || assetKind === 'option') {
            if ((assetKind === 'fop') !== futuresBook) return '';
            if (codes.indexOf('A') >= 0) return 'assignment_option_leg';
            if (codes.indexOf('EX') >= 0) return 'exercise_option_leg';
            if (codes.indexOf('EP') >= 0) return 'option_expiry';
            return 'option_trade';
        }
        if (assetKind === 'stock') {
            if (futuresBook) return '';
            if (codes.indexOf('A') >= 0 || codes.indexOf('EX') >= 0) {
                return 'delivery_share_leg';
            }
            return 'share_trade';
        }
        if (assetKind === 'future' && futuresBook) return 'future_leg';
        return '';
    }

    function _cash(record) {
        const proceeds = _number(record.proceeds);
        const commission = _number(record.commission);
        if (proceeds === null) return null;
        return _round(proceeds + (commission === null ? 0 : commission), 6);
    }

    function _fees(record) {
        const commission = _number(record.commission);
        return commission === null ? 0 : _round(Math.abs(commission), 6);
    }

    function _round(value, places) {
        const factor = Math.pow(10, places);
        return Math.round((value + Number.EPSILON) * factor) / factor;
    }

    /**
     * Deterministic 64-bit-ish digest, two FNV-1a lanes with different seeds.
     *
     * Neither the browser nor Node offers a synchronous SHA, and this only
     * has to be stable and collision-free across the few thousand rows of a
     * statement - not cryptographic.
     */
    function _hash16(text) {
        const source = String(text === null || text === undefined ? '' : text);
        let low = 0x811c9dc5;
        let high = 0x01000193;
        for (let index = 0; index < source.length; index += 1) {
            const code = source.charCodeAt(index);
            low = Math.imul(low ^ code, 0x01000193) >>> 0;
            high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
        }
        return (`0000000${low.toString(16)}`).slice(-8)
            + (`0000000${high.toString(16)}`).slice(-8);
    }

    /**
     * A stable fingerprint for one statement row.
     *
     * An Activity Statement carries NO trade id, so without this every
     * re-import of an overlapping period would book every trade a second
     * time - the exact failure the ledger cannot survive. Price, proceeds,
     * commission, and codes are deliberately included in addition to the
     * account/timestamp/contract/quantity tuple: two independent fills can
     * legitimately have the same contract, size, and second.
     *
     * Exact duplicate rows still have the same fingerprint. parse() assigns
     * a deterministic occurrence suffix to their external refs so both
     * fills survive while the first occurrence keeps the historical key.
     */
    function _contentKey(record) {
        return `stmt-${_hash16([
            _upper(record.account),
            String(record.tradeDate || ''),
            _upper(record.symbol),
            String(record.quantity || ''),
            String(record.price || ''),
            String(record.proceeds || ''),
            String(record.commission || ''),
            _upper(record.codes),
        ].join('|'))}`;
    }

    /**
     * Preserve a multiset of byte-equivalent Activity Statement rows.
     *
     * The first occurrence deliberately keeps `stmt-<hash>` for backwards
     * compatibility with ledgers imported before occurrence tracking. Later
     * occurrences become `stmt-<hash>-2`, `-3`, and so on. A cumulative
     * statement containing the same rows therefore recreates the same key
     * set regardless of where unrelated rows were added.
     *
     * Real Flex/IB execution ids are broker identities and must never receive
     * an occurrence suffix: repeating one of those means the same execution.
     */
    function _assignContentOccurrenceRef(built, record, occurrences) {
        if (String(record.externalRef || '').trim()) return;
        const item = built.event || built.pending;
        if (!item || !item.externalRef) return;
        const baseRef = item.externalRef;
        const key = `${item.account}\u0000${baseRef}`;
        const occurrence = (occurrences.get(key) || 0) + 1;
        occurrences.set(key, occurrence);
        if (occurrence > 1) item.externalRef = `${baseRef}-${occurrence}`;
        if (item.contentKey) item.contentKey = item.externalRef;
    }

    const MONTHS = Object.freeze({
        JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
        JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    });

    /**
     * Read a contract out of a local symbol.
     *
     * An Activity Statement carries no strike, expiry, or right columns -
     * the whole contract is packed into the Symbol field, either as
     * "TQQQ 17JUL26 45 P" or as an OSI code. Returns null when the text is
     * not a contract, which is how stock rows fall through.
     */
    function parseOptionSymbol(text) {
        const value = _upper(text).replace(/\s+/g, ' ').trim();
        if (!value) return null;

        const spaced = /^([A-Z0-9.\-]+) (\d{1,2})([A-Z]{3})(\d{2}|\d{4}) ([0-9.]+) ([CP])$/
            .exec(value);
        if (spaced) {
            const month = MONTHS[spaced[3]];
            if (!month) return null;
            const year = spaced[4].length === 2 ? `20${spaced[4]}` : spaced[4];
            const strike = parseFloat(spaced[5]);
            if (!Number.isFinite(strike)) return null;
            return {
                underlying: spaced[1],
                expiry: `${year}${month}${spaced[2].padStart(2, '0')}`,
                strike,
                right: spaced[6],
            };
        }

        const osi = /^([A-Z0-9.\-]+) ?(\d{6})([CP])(\d{8})$/.exec(value);
        if (osi) {
            return {
                underlying: osi[1],
                expiry: `20${osi[2]}`,
                strike: parseInt(osi[4], 10) / 1000,
                right: osi[3],
            };
        }
        return null;
    }

    /** The underlying a row belongs to, however the statement spells it. */
    function resolveUnderlying(record, options) {
        const explicit = _upper(record.underlyingSymbol);
        if (explicit) return explicit;
        const exactDetail = options && options.instruments
            ? options.instruments.get(`SYM|${_upper(record.symbol)}`) : null;
        if (exactDetail && !exactDetail.ambiguous && exactDetail.underlying) {
            return _upper(exactDetail.underlying);
        }
        const parsed = parseOptionSymbol(record.symbol);
        if (parsed) return parsed.underlying;
        return _upper(record.symbol);
    }

    function _optionIdentity(record, options) {
        const parsed = parseOptionSymbol(record.symbol);
        const right = _right(record.right) || (parsed ? parsed.right : '');
        const strikeColumn = _number(record.strike);
        const strike = strikeColumn === null
            ? (parsed ? parsed.strike : null) : strikeColumn;
        const expiry = _expiryDigits(record.expiry) || (parsed ? parsed.expiry : '');
        const underlying = resolveUnderlying(record, options);

        // Column first, then the instrument table, then the book default.
        // Never silently assume 100: an adjusted contract that delivers a
        // different number of shares would misstate the whole position.
        let perContract = Math.abs(_number(record.multiplier) || 0);
        let conId = _number(record.conId);
        const exactDetail = options.instruments
            ? options.instruments.get(`SYM|${_upper(record.symbol)}`) : null;
        const fallbackDetail = (options.instruments && right && strike !== null && expiry)
            ? options.instruments.get(
                _instrumentKey(underlying, expiry, right, strike, null))
            : null;
        const detail = exactDetail && !exactDetail.ambiguous
            ? exactDetail
            : (fallbackDetail && !fallbackDetail.ambiguous ? fallbackDetail : null);
        if (!perContract && detail && detail.multiplier) perContract = detail.multiplier;
        // The statement carries the broker's own contract number in its
        // instrument section. Recording it lets the ledger tell two real
        // contracts apart when structure alone cannot.
        if (conId === null && detail && detail.conId !== null) conId = detail.conId;
        return {
            right,
            strike,
            expiry,
            conId,
            localSymbol: _upper(record.symbol) || null,
            sharesPerContract: perContract || options.defaultSharesPerContract,
        };
    }

    function _futureIdentity(record, options) {
        const localSymbol = _upper(record.symbol);
        const detail = options.instruments
            ? options.instruments.get(`SYM|${localSymbol}`) : null;
        const unambiguous = detail && !detail.ambiguous ? detail : null;
        const expiry = _contractDigits(record.expiry)
            || (unambiguous ? _contractDigits(unambiguous.expiry) : '');
        const multiplier = Math.abs(_number(record.multiplier) || 0)
            || (unambiguous ? Math.abs(_number(unambiguous.multiplier) || 0) : 0)
            || options.defaultSharesPerContract;
        const conId = _number(record.conId) === null
            ? (unambiguous ? unambiguous.conId : null) : _number(record.conId);
        return {
            expiry,
            conId,
            localSymbol: localSymbol || null,
            sharesPerContract: multiplier,
            underlying: resolveUnderlying(record, options),
        };
    }

    /**
     * Turn one statement row into a draft, or into a problem describing why
     * it could not become one.
     */
    function _buildDraft(record, classification, options, lineNumber) {
        const account = String(record.account || options.accountFallback || '').trim();
        const tradeDate = _isoDate(record.tradeDate);
        const brokerTimestamp = _brokerTimestamp(record.tradeDate);
        const quantity = _number(record.quantity);
        const price = _number(record.price);
        const cash = _cash(record);
        const fees = _fees(record);
        const brokerBasis = _number(record.basis);
        const brokerRealizedPnl = _number(record.realizedPnl);
        const brokerCodes = _codes(record.codes);
        // A Flex export has a real trade id; an Activity Statement does not,
        // and then the row's own content is the identity.
        const originalExternalRef = String(record.externalRef || '').trim()
            || _contentKey(record);
        const aliasKey = `${account}\u0000${originalExternalRef}`;
        const aliases = options.externalRefAliases || {};
        const externalRef = Object.prototype.hasOwnProperty.call(aliases, aliasKey)
            ? String(aliases[aliasKey] || originalExternalRef)
            : originalExternalRef;

        if (!tradeDate) {
            return { problem: 'trade date could not be read' };
        }
        if (quantity === null || Math.abs(quantity) < SHARE_EPSILON) {
            return { problem: 'quantity is missing or zero' };
        }

        if (classification === 'share_trade') {
            if (price === null) return { problem: 'share price is missing' };
            return {
                event: {
                    kind: 'share_trade',
                    tradeDate,
                    brokerTimestamp,
                    account,
                    shares: quantity,
                    price: Math.abs(price),
                    fees,
                    cashAmount: cash === null
                        ? _round(-(quantity * Math.abs(price)) - fees, 6)
                        : cash,
                    source: 'csv_import',
                    tag: brokerCodes.indexOf('C') >= 0
                        ? 'ibkr_close'
                        : (brokerCodes.indexOf('O') >= 0 ? 'ibkr_open' : ''),
                    brokerBasis,
                    brokerRealizedPnl,
                    brokerCodes,
                    brokerCloseCash: cash === null
                        ? _round(-(quantity * Math.abs(price)) - fees, 6)
                        : cash,
                    externalRef,
                    note: `IBKR ${record.tradeDate || ''}`.trim(),
                },
            };
        }

        if (classification === 'delivery_share_leg') {
            // Held back for pairing: this row carries the real settlement
            // cash, and its option leg carries the contract identity.
            return {
                pending: {
                    classification,
                    account,
                    tradeDate,
                    brokerTimestamp,
                    rawTradeDate: String(record.tradeDate || ''),
                    quantity,
                    identity: null,
                    price,
                    fees,
                    cash,
                    externalRef,
                    contentKey: _contentKey(record),
                    lineNumber,
                    symbol: resolveUnderlying(record, options),
                },
            };
        }

        if (classification === 'future_leg') {
            const future = _futureIdentity(record, options);
            if (!future.expiry) return { problem: 'FUT contract month could not be read' };
            if (price === null) return { problem: 'FUT trade price is missing' };
            return {
                pending: {
                    classification,
                    account,
                    tradeDate,
                    brokerTimestamp,
                    rawTradeDate: String(record.tradeDate || ''),
                    quantity,
                    identity: future,
                    // Futures can trade below zero (CL did in 2020).  The
                    // signed statement price is economically meaningful.
                    price,
                    fees,
                    cash,
                    codes: _codes(record.codes),
                    externalRef,
                    contentKey: _contentKey(record),
                    lineNumber,
                    symbol: resolveUnderlying(record, options),
                },
            };
        }

        const identity = _optionIdentity(record, options);
        const optionSecType = _assetKind(record.assetClass) === 'fop' ? 'FOP' : 'OPT';
        if (!identity.right || identity.strike === null || !identity.expiry) {
            return { problem: 'option right, strike, or expiry could not be read' };
        }

        if (classification === 'option_trade') {
            if (price === null) return { problem: 'option premium is missing' };
            return {
                event: {
                    kind: 'option_trade',
                    tradeDate,
                    brokerTimestamp,
                    account,
                    right: identity.right,
                    strike: identity.strike,
                    expiry: identity.expiry,
                    contracts: quantity,
                    sharesPerContract: identity.sharesPerContract,
                    conId: identity.conId,
                    localSymbol: identity.localSymbol,
                    optionSecType,
                    price: Math.abs(price),
                    fees,
                    cashAmount: cash === null
                        ? _round(-(quantity * identity.sharesPerContract
                            * Math.abs(price)) - fees, 6)
                        : cash,
                    source: 'csv_import',
                    // O/C is not decoration.  A closing row must be applied
                    // against an existing lot and may never open the inverse
                    // position merely because an earlier report is absent.
                    tag: brokerCodes.indexOf('C') >= 0
                        ? 'ibkr_close'
                        : (brokerCodes.indexOf('O') >= 0 ? 'ibkr_open' : ''),
                    brokerBasis,
                    brokerRealizedPnl,
                    brokerCodes,
                    brokerCloseCash: cash === null
                        ? _round(-(quantity * identity.sharesPerContract
                            * Math.abs(price)) - fees, 6)
                        : cash,
                    externalRef,
                    note: `IBKR ${record.tradeDate || ''}`.trim(),
                },
            };
        }

        if (classification === 'option_expiry') {
            return {
                event: {
                    kind: 'option_expiry',
                    tradeDate,
                    brokerTimestamp,
                    account,
                    right: identity.right,
                    strike: identity.strike,
                    expiry: identity.expiry,
                    contracts: quantity,
                    // Part of the contract's identity: without it an
                    // adjusted contract's expiry would not line up with its
                    // own opening.
                    sharesPerContract: identity.sharesPerContract,
                    conId: identity.conId,
                    localSymbol: identity.localSymbol,
                    optionSecType,
                    fees,
                    cashAmount: _round(-fees, 6),
                    source: 'csv_import',
                    tag: 'ibkr_close',
                    brokerBasis,
                    brokerRealizedPnl,
                    brokerCodes,
                    brokerCloseCash: _round(-fees, 6),
                    externalRef,
                    note: `IBKR expired ${record.tradeDate || ''}`.trim(),
                },
            };
        }

        // Delivery legs are held back for pairing.
        return {
            pending: {
                classification,
                account,
                tradeDate,
                brokerTimestamp,
                rawTradeDate: String(record.tradeDate || ''),
                quantity,
                identity,
                price,
                fees,
                cash,
                externalRef,
                contentKey: _contentKey(record),
                lineNumber,
                symbol: resolveUnderlying(record, options),
                optionSecType,
                brokerBasis,
                brokerRealizedPnl,
                brokerCodes,
                brokerCloseCash: cash === null ? _round(-fees, 6) : cash,
            },
        };
    }

    /**
     * Join each option delivery leg with its share leg.
     *
     * The two rows carry the same account and date and the share count must
     * be exactly contracts x multiplier. Anything left over on EITHER side
     * is a problem row that blocks the batch. An unmatched share leg would
     * book the delivery twice once its option leg arrives; an unmatched
     * option leg has no evidence that any shares actually moved, and
     * inventing the delivery from the strike would change the share count
     * and the cost on a guess.
     */
    function _pairDeliveries(pendings, options) {
        const events = [];
        const problems = [];
        const shareLegs = pendings.filter(
            (item) => item.classification === 'delivery_share_leg');
        const futureLegs = pendings.filter(
            (item) => item.classification === 'future_leg');
        const optionLegs = pendings.filter(
            (item) => item.classification !== 'delivery_share_leg'
                && item.classification !== 'future_leg');
        const consumed = new Set();

        optionLegs.forEach((leg) => {
            const kind = leg.classification === 'assignment_option_leg'
                ? 'option_assignment'
                : 'option_exercise';
            const expectedShares = Math.abs(leg.quantity) * leg.identity.sharesPerContract;
            const acquires = kind === 'option_assignment'
                ? leg.identity.right === 'P'
                : leg.identity.right === 'C';
            const shares = acquires ? expectedShares : -expectedShares;

            if (leg.optionSecType === 'FOP') {
                const expectedFutures = acquires
                    ? Math.abs(leg.quantity) : -Math.abs(leg.quantity);
                const candidates = futureLegs.filter((candidate) => (
                    !consumed.has(candidate)
                    && candidate.account === leg.account
                    && candidate.tradeDate === leg.tradeDate
                    && candidate.symbol === leg.symbol
                    && Math.abs(candidate.quantity - expectedFutures) < SHARE_EPSILON
                    && (!leg.brokerTimestamp || !candidate.brokerTimestamp
                        || candidate.brokerTimestamp === leg.brokerTimestamp)
                ));
                const strikeMatches = candidates.filter((candidate) => (
                    candidate.price !== null && leg.identity.strike !== null
                    && Math.abs(candidate.price - leg.identity.strike) < 1e-6));
                const matches = strikeMatches.length ? strikeMatches : candidates;
                if (matches.length !== 1) {
                    problems.push({
                        lineNumber: leg.lineNumber,
                        reason: matches.length
                            ? `${kind} has multiple matching FUT delivery legs`
                            : `${kind} has no matching FUT delivery leg; the delivered `
                                + 'contract month and direction would be a guess',
                        raw: `${leg.account} ${leg.tradeDate} ${leg.quantity} FOP `
                            + `${leg.identity.right}${leg.identity.strike}`,
                    });
                    return;
                }
                const match = matches[0];
                consumed.add(match);
                const fees = _round(leg.fees + match.fees, 6);
                events.push({
                    kind,
                    tradeDate: leg.tradeDate,
                    brokerTimestamp: leg.brokerTimestamp || match.brokerTimestamp,
                    account: leg.account,
                    right: leg.identity.right,
                    strike: leg.identity.strike,
                    expiry: leg.identity.expiry,
                    contracts: leg.quantity,
                    sharesPerContract: leg.identity.sharesPerContract,
                    conId: leg.identity.conId,
                    localSymbol: leg.identity.localSymbol,
                    optionSecType: 'FOP',
                    futureExpiry: match.identity.expiry,
                    futureConId: match.identity.conId,
                    futureLocalSymbol: match.identity.localSymbol,
                    futureContracts: match.quantity,
                    price: leg.identity.strike,
                    fees,
                    cashAmount: _round(-fees, 6),
                    source: 'csv_import',
                    tag: 'ibkr_close',
                    brokerBasis: leg.brokerBasis,
                    brokerRealizedPnl: leg.brokerRealizedPnl,
                    brokerCodes: leg.brokerCodes,
                    brokerCloseCash: leg.brokerCloseCash,
                    externalRef: leg.externalRef || leg.contentKey,
                    note: `IBKR FOP ${kind} ${leg.rawTradeDate || leg.tradeDate}`,
                    lineNumber: leg.lineNumber,
                });
                return;
            }

            // Two assignments can settle on the same date for the same share
            // count and differ only in strike - a wheel that had several
            // puts assigned at once does exactly that. Matching on quantity
            // alone would then hand each event the other's settlement cash,
            // so the delivery price is tried first and quantity-only is the
            // fallback for statements that omit it.
            const candidates = shareLegs.filter((candidate) => (
                !consumed.has(candidate)
                && candidate.account === leg.account
                && candidate.tradeDate === leg.tradeDate
                && Math.abs(candidate.quantity - shares) < SHARE_EPSILON
            ));
            const match = candidates.find((candidate) => (
                candidate.price !== null
                && leg.identity.strike !== null
                && Math.abs(Math.abs(candidate.price) - leg.identity.strike) < 1e-6
            )) || candidates[0];
            if (match) consumed.add(match);

            if (!match) {
                problems.push({
                    lineNumber: leg.lineNumber,
                    reason: `${kind} has no matching share delivery leg in this `
                        + 'file; the share count and settlement cash would be a guess',
                    raw: `${leg.account} ${leg.tradeDate} ${leg.quantity} contracts `
                        + `${leg.identity.right}${leg.identity.strike}`,
                });
                return;
            }
            const fees = _round(leg.fees + match.fees, 6);
            const cash = match.cash !== null
                ? _round(match.cash - leg.fees, 6)
                : _round(-(shares * leg.identity.strike) - fees, 6);

            events.push({
                kind,
                tradeDate: leg.tradeDate,
                brokerTimestamp: leg.brokerTimestamp,
                account: leg.account,
                right: leg.identity.right,
                strike: leg.identity.strike,
                expiry: leg.identity.expiry,
                contracts: leg.quantity,
                shares,
                sharesPerContract: leg.identity.sharesPerContract,
                conId: leg.identity.conId,
                localSymbol: leg.identity.localSymbol,
                optionSecType: 'OPT',
                price: leg.identity.strike,
                fees,
                cashAmount: cash,
                source: 'csv_import',
                tag: 'ibkr_close',
                brokerBasis: leg.brokerBasis,
                brokerRealizedPnl: leg.brokerRealizedPnl,
                brokerCodes: leg.brokerCodes,
                brokerCloseCash: leg.brokerCloseCash,
                // Keyed off the option leg alone: it is identical in every
                // statement that covers the date, whereas which share row it
                // pairs with could depend on row order.
                externalRef: leg.externalRef || leg.contentKey,
                note: `IBKR ${kind} ${leg.rawTradeDate || leg.tradeDate}`,
                lineNumber: leg.lineNumber,
            });
        });

        shareLegs.forEach((leg) => {
            if (consumed.has(leg)) return;
            problems.push({
                lineNumber: leg.lineNumber,
                reason: 'share delivery leg has no matching option leg in this file',
                raw: `${leg.account} ${leg.tradeDate} ${leg.quantity} shares`,
            });
        });

        const remainingFutures = futureLegs.filter((leg) => !consumed.has(leg));
        const groups = new Map();
        remainingFutures.forEach((leg) => {
            const key = [leg.account, leg.brokerTimestamp || leg.tradeDate, leg.symbol].join('|');
            const group = groups.get(key) || [];
            group.push(leg);
            groups.set(key, group);
        });
        groups.forEach((legs) => {
            const closes = legs.filter((leg) => leg.codes.indexOf('C') >= 0);
            const opens = legs.filter((leg) => leg.codes.indexOf('O') >= 0);
            const rollCandidate = legs.length === 2 && closes.length === 1 && opens.length === 1;
            if (rollCandidate) {
                const oldLeg = closes[0];
                const newLeg = opens[0];
                const provesRoll = oldLeg !== newLeg
                    && oldLeg.quantity * newLeg.quantity < 0
                    && Math.abs(oldLeg.identity.sharesPerContract
                        - newLeg.identity.sharesPerContract) < SHARE_EPSILON
                    && oldLeg.identity.expiry !== newLeg.identity.expiry;
                if (!provesRoll) {
                    legs.forEach((leg) => problems.push({
                        lineNumber: leg.lineNumber,
                        reason: 'FUT rows look like a roll but quantity, multiplier, or '
                            + 'contract month does not prove a unique transfer',
                        raw: `${leg.account} ${leg.rawTradeDate} ${leg.identity.localSymbol}`,
                    }));
                    return;
                }
                const movedSize = Math.min(
                    Math.abs(oldLeg.quantity), Math.abs(newLeg.quantity));
                const retained = Math.sign(newLeg.quantity) * movedSize;
                const oldFeeUsed = oldLeg.fees * movedSize / Math.abs(oldLeg.quantity);
                const newFeeUsed = newLeg.fees * movedSize / Math.abs(newLeg.quantity);
                const fees = _round(oldFeeUsed + newFeeUsed, 6);
                const rollGroup = `roll-${_hash16([
                    oldLeg.externalRef, newLeg.externalRef,
                ].sort().join('|'))}`;
                events.push({
                    kind: 'futures_roll',
                    tradeDate: oldLeg.tradeDate,
                    brokerTimestamp: oldLeg.brokerTimestamp || newLeg.brokerTimestamp,
                    account: oldLeg.account,
                    futureExpiry: oldLeg.identity.expiry,
                    futureConId: oldLeg.identity.conId,
                    futureLocalSymbol: oldLeg.identity.localSymbol,
                    // The opening leg's sign is the retained position direction.
                    futureContracts: retained,
                    sharesPerContract: oldLeg.identity.sharesPerContract,
                    price: oldLeg.price,
                    rollToExpiry: newLeg.identity.expiry,
                    rollToConId: newLeg.identity.conId,
                    rollToLocalSymbol: newLeg.identity.localSymbol,
                    rollToPrice: newLeg.price,
                    rollGroup,
                    fees,
                    cashAmount: _round(-fees, 6),
                    source: 'csv_import',
                    externalRef: rollGroup,
                    note: `IBKR FUT roll ${oldLeg.rawTradeDate || oldLeg.tradeDate}; `
                        + `spread ${_round(newLeg.price - oldLeg.price, 6)}`,
                    lineNumber: Math.min(oldLeg.lineNumber, newLeg.lineNumber),
                });
                // A broker may close two old contracts while opening only one
                // new one (or open an extra new contract) in the same timestamped
                // pair. The common quantity is the roll; the excess is a real
                // outright FUT fill and must not disappear into the spread.
                [
                    {
                        leg: oldLeg,
                        quantity: _round(oldLeg.quantity + retained, 6),
                        fees: _round(oldLeg.fees - oldFeeUsed, 6),
                    },
                    {
                        leg: newLeg,
                        quantity: _round(newLeg.quantity - retained, 6),
                        fees: _round(newLeg.fees - newFeeUsed, 6),
                    },
                ].forEach((remainder) => {
                    if (Math.abs(remainder.quantity) < SHARE_EPSILON) return;
                    const leg = remainder.leg;
                    events.push({
                        kind: 'futures_trade',
                        tradeDate: leg.tradeDate,
                        brokerTimestamp: leg.brokerTimestamp,
                        account: leg.account,
                        futureExpiry: leg.identity.expiry,
                        futureConId: leg.identity.conId,
                        futureLocalSymbol: leg.identity.localSymbol,
                        futureContracts: remainder.quantity,
                        sharesPerContract: leg.identity.sharesPerContract,
                        price: leg.price,
                        fees: remainder.fees,
                        cashAmount: _round(-remainder.fees, 6),
                        source: 'csv_import',
                        externalRef: `fut-residual-${_hash16([
                            leg.externalRef, rollGroup, remainder.quantity,
                        ].join('|'))}`,
                        note: `IBKR FUT residual ${leg.rawTradeDate || leg.tradeDate} `
                            + `beside ${rollGroup}`,
                        lineNumber: leg.lineNumber,
                    });
                });
                return;
            }
            if (legs.length > 1 && closes.length && opens.length) {
                legs.forEach((leg) => problems.push({
                    lineNumber: leg.lineNumber,
                    reason: 'ambiguous FUT roll group; old and new legs are not unique',
                    raw: `${leg.account} ${leg.rawTradeDate} ${leg.identity.localSymbol}`,
                }));
                return;
            }
            legs.forEach((leg) => events.push({
                kind: 'futures_trade',
                tradeDate: leg.tradeDate,
                brokerTimestamp: leg.brokerTimestamp,
                account: leg.account,
                futureExpiry: leg.identity.expiry,
                futureConId: leg.identity.conId,
                futureLocalSymbol: leg.identity.localSymbol,
                futureContracts: leg.quantity,
                sharesPerContract: leg.identity.sharesPerContract,
                price: leg.price,
                fees: leg.fees,
                cashAmount: _round(-leg.fees, 6),
                source: 'csv_import',
                externalRef: leg.externalRef,
                note: `IBKR FUT ${leg.rawTradeDate || leg.tradeDate}`,
                lineNumber: leg.lineNumber,
            }));
        });

        return { events, problems };
    }

    /**
     * The account number, which the Trades section does not carry.
     *
     * Without it every imported row lands on a blank account and the
     * per-account reconciliation against TWS can never match. The Account
     * Information section is a name/value list, so the row labelled
     * Account / 账户 holds it.
     */
    function extractAccount(rows) {
        const section = extractSection(rows, 'accountInformation');
        if (!section) return '';
        let found = '';
        section.groups.forEach((group) => {
            group.records.forEach((record) => {
                const label = _normalizeHeader(record.values[0]);
                if (!found && (label === 'account' || label === '账户')) {
                    found = String(record.values[1] || '').trim();
                }
            });
        });
        return found;
    }

    /**
     * Contract details the Trades section omits, keyed by contract identity.
     *
     * The multiplier matters: an adjusted contract does not deliver 100
     * shares, and assuming it does would misstate both the share count and
     * the cost. The two sections spell the same contract differently - OSI
     * in one column, spaced form in another - so both are parsed into the
     * same key.
     */
    function extractInstruments(rows) {
        const section = extractSection(rows, 'instruments');
        const byKey = new Map();
        if (!section) return byKey;
        section.groups.forEach((group) => {
            const mapping = group.built.mapping;
            group.records.forEach((record) => {
                const values = _cellsToRecord(record.values, mapping);
                const detail = {
                    multiplier: Math.abs(_number(values.multiplier) || 0) || null,
                    conId: _number(values.conId),
                    underlying: _upper(values.underlyingSymbol) || null,
                    expiry: _contractDigits(values.expiry) || null,
                    assetKind: _assetKind(values.assetClass),
                };
                if (!detail.multiplier && detail.conId === null) return;
                [values.symbol, values.description].forEach((text) => {
                    const exact = _upper(text);
                    if (exact) _storeInstrumentDetail(byKey, `SYM|${exact}`, detail);
                    const parsed = parseOptionSymbol(text);
                    if (parsed) {
                        // Registered under both the multiplier-bearing key and
                        // a bare one, so a trade row that has no multiplier
                        // column can still find its contract.
                        _storeInstrumentDetail(byKey, _instrumentKey(
                            parsed.underlying, parsed.expiry, parsed.right,
                            parsed.strike, detail.multiplier), detail);
                        _storeInstrumentDetail(byKey, _instrumentKey(
                            parsed.underlying, parsed.expiry, parsed.right,
                            parsed.strike, null), detail);
                        return;
                    }
                    const plain = _upper(text);
                    if (plain) _storeInstrumentDetail(byKey, `STK|${plain}`, detail);
                });
            });
        });
        return byKey;
    }

    function _storeInstrumentDetail(target, key, detail) {
        const previous = target.get(key);
        if (!previous) {
            target.set(key, detail);
            return;
        }
        const previousId = previous.conId === null ? '' : String(previous.conId);
        const nextId = detail.conId === null ? '' : String(detail.conId);
        if (previousId === nextId
            && previous.multiplier === detail.multiplier) return;
        // A structural fallback is useful only while it identifies exactly
        // one instrument. Exact local-symbol entries remain usable.
        target.set(key, { ambiguous: true });
    }

    /**
     * Contract identity for the instrument table and the opening derivation.
     *
     * The multiplier is part of the key: an adjusted contract delivers a
     * different number of shares, so merging it with the standard contract
     * of the same strike and expiry would blend two different positions.
     */
    function _instrumentKey(underlying, expiry, right, strike, multiplier) {
        return [
            'OPT', underlying, expiry, right,
            Number(strike).toFixed(4),
            multiplier === undefined || multiplier === null
                ? '' : String(Math.abs(_number(multiplier) || 0)),
        ].join('|');
    }

    function _resolvePositionIdentities(items, symbol, defaultSharesPerContract) {
        const list = Array.isArray(items) ? items : [];
        const groups = new Map();
        function structuralKey(item) {
            return _instrumentKey(
                _upper(item.underlying || symbol), item.expiry, item.right,
                item.strike, item.sharesPerContract || defaultSharesPerContract);
        }
        list.forEach((item) => {
            const key = structuralKey(item);
            const group = groups.get(key) || {
                conIds: new Set(), localSymbols: new Set(), localToConIds: new Map(),
            };
            const conId = item.conId === null || item.conId === undefined
                || item.conId === '' ? '' : String(item.conId);
            const localSymbol = _upper(item.localSymbol);
            if (conId) group.conIds.add(conId);
            if (localSymbol) group.localSymbols.add(localSymbol);
            if (conId && localSymbol) {
                const mapped = group.localToConIds.get(localSymbol) || new Set();
                mapped.add(conId);
                group.localToConIds.set(localSymbol, mapped);
            }
            groups.set(key, group);
        });
        const resolved = new Map();
        list.forEach((item) => {
            const structural = structuralKey(item);
            const group = groups.get(structural);
            const conId = item.conId === null || item.conId === undefined
                || item.conId === '' ? '' : String(item.conId);
            const localSymbol = _upper(item.localSymbol);
            let identity = '';
            if (conId) {
                identity = `con:${conId}`;
            } else if (group.conIds.size) {
                const mapped = localSymbol && group.localToConIds.get(localSymbol);
                if (mapped && mapped.size === 1) {
                    identity = `con:${Array.from(mapped)[0]}`;
                } else if (!localSymbol && group.conIds.size === 1) {
                    identity = `con:${Array.from(group.conIds)[0]}`;
                } else {
                    identity = localSymbol ? `ambiguous:${localSymbol}` : 'ambiguous';
                }
            } else if (localSymbol) {
                identity = `local:${localSymbol}`;
            } else if (group.localSymbols.size === 1) {
                identity = `local:${Array.from(group.localSymbols)[0]}`;
            } else if (group.localSymbols.size > 1) {
                identity = 'ambiguous';
            }
            resolved.set(item, identity ? `${structural}|#${identity}` : structural);
        });
        return resolved;
    }

    function _existingExternalRefStates(items) {
        const states = new Map();
        (items || []).forEach((item) => {
            if (item && typeof item === 'object' && item.externalRef) {
                const key = `${String(item.account || '')}\u0000${item.externalRef}`;
                states.set(key, {
                    voided: Boolean(item.voidedAtUtc),
                    excluded: item.includeInCost === false,
                });
            } else if (typeof item === 'string' && item) {
                // Backwards-compatible input used by callers that only know
                // the reference. It is sufficient for de-duplication, but it
                // carries no evidence that the stored row is inactive.
                states.set(item, { voided: false, excluded: false });
            }
        });
        return states;
    }

    function _blockedSuppressedRows(events, options) {
        const states = _existingExternalRefStates(
            options && options.existingExternalRefs);
        const seen = new Set();
        const problems = [];
        (events || []).forEach((event) => {
            if (!event || !event.externalRef) return;
            const key = `${String(event.account || '')}\u0000${event.externalRef}`;
            const state = states.get(key);
            if (!state || (!state.voided && !state.excluded) || seen.has(key)) return;
            seen.add(key);
            const condition = state.voided
                ? 'a voided ledger event'
                : 'a ledger event excluded from cost';
            problems.push({
                lineNumber: event.lineNumber || 0,
                reason: `statement row matches ${condition}; its broker reference still `
                    + 'blocks append import. Use replacement rebuild so the original cash '
                    + 'and position are restored together.',
                raw: String(event.externalRef),
            });
        });
        return problems;
    }

    function _buildDividends(rows, options) {
        const section = extractSection(rows, 'dividends');
        if (!section) return [];
        const events = [];
        section.groups.forEach((group) => {
        const mapping = group.built.mapping;
        group.records.forEach((record) => {
            const values = _cellsToRecord(record.values, mapping);
            const amount = _number(values.amount);
            const tradeDate = _isoDate(values.tradeDate);
            const description = String(values.description || '');
            if (amount === null || !tradeDate) return;
            if (!_cashDescriptionMatchesSymbol(description, options.symbol)) {
                return;
            }
            if (amount <= 0) return;
            events.push({
                kind: 'dividend',
                tradeDate,
                brokerTimestamp: _brokerTimestamp(values.tradeDate),
                account: String(values.account || options.accountFallback || '').trim(),
                cashAmount: _round(amount, 6),
                fees: 0,
                source: 'csv_import',
                externalRef: `stmt-${_hash16([
                    _upper(values.account), tradeDate, description, String(amount),
                ].join('|'))}`,
                note: description.slice(0, 200),
                lineNumber: record.lineNumber,
            });
        });
        });
        return events;
    }

    function _cashDescriptionMatchesSymbol(description, symbol) {
        const wanted = _upper(symbol);
        if (!wanted) return true;
        const text = _upper(description);
        if (!text) return false;
        const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // QQQ must not match QQQM, and SQQQ must not match QQQ. IBKR normally
        // places the exact symbol at the start, before a CUSIP in parentheses,
        // but bounded matching also supports localized prefix text.
        return new RegExp(`(^|[^A-Z0-9.\\-])${escaped}(?=$|[^A-Z0-9.\\-])`).test(text);
    }

    function _buildWithholdingTaxes(rows, options) {
        const section = extractSection(rows, 'withholdingTax');
        if (!section) return [];
        const events = [];
        section.groups.forEach((group) => {
            const mapping = group.built.mapping;
            group.records.forEach((record) => {
                const values = _cellsToRecord(record.values, mapping);
                const amount = _number(values.amount);
                const tradeDate = _isoDate(values.tradeDate);
                const description = String(values.description || '');
                if (amount === null || Math.abs(amount) < 1e-9 || !tradeDate) return;
                if (!_cashDescriptionMatchesSymbol(description, options.symbol)) return;
                const withheld = Math.abs(amount);
                events.push({
                    kind: 'fee',
                    tradeDate,
                    brokerTimestamp: _brokerTimestamp(values.tradeDate),
                    account: String(values.account || options.accountFallback || '').trim(),
                    cashAmount: _round(-withheld, 6),
                    fees: _round(withheld, 6),
                    source: 'csv_import',
                    tag: 'withholding_tax',
                    externalRef: `stmt-${_hash16([
                        'withholding-tax', _upper(values.account), tradeDate,
                        description, String(amount),
                    ].join('|'))}`,
                    note: `IBKR withholding tax: ${description}`.slice(0, 200),
                    lineNumber: record.lineNumber,
                });
            });
        });
        return events;
    }

    function _corporateActionProblems(rows, options) {
        const section = extractSection(rows, 'corporateActions');
        if (!section) return [];
        const wanted = _upper(options && options.symbol);
        const problems = [];
        section.groups.forEach((group) => {
            group.records.forEach((record) => {
                const raw = record.values.join(',');
                const upperRaw = _upper(raw);
                if (wanted && upperRaw.indexOf(wanted) < 0) return;
                problems.push({
                    lineNumber: record.lineNumber,
                    reason: 'statement contains a corporate action for this underlying; '
                        + 'confirm the split ratio and every adjusted option/FOP contract '
                        + 'identity before importing',
                    raw,
                });
            });
        });
        return problems;
    }

    /**
     * End-of-period positions the statement reports for one underlying.
     *
     * Only Summary rows are read: an export that also emits Lot rows breaks
     * the same position into tax lots, and counting both doubles it.
     */
    function extractEndPositions(rows, options) {
        const section = extractSection(rows, 'openPositions');
        if (!section) return null;
        const wanted = _upper(options.symbol);
        const result = {
            // The Open Positions section is a complete end-of-period
            // inventory.  Its lack of rows for the selected symbol is proof
            // of a zero balance, not proof that the section had no data.
            hasData: true, shares: 0, shareCostBasis: null,
            options: new Map(), futures: new Map(),
        };
        section.groups.forEach((group) => {
            const mapping = group.built.mapping;
            group.records.forEach((record) => {
                if (mapping.discriminator !== undefined
                    && _normalizeHeader(record.values[mapping.discriminator]) !== 'summary') {
                    return;
                }
                const values = _cellsToRecord(record.values, mapping);
                const quantity = _number(values.quantity);
                if (quantity === null) return;
                const assetKind = _assetKind(values.assetClass);
                if (assetKind === 'future') {
                    const identity = _futureIdentity(values, options);
                    if (!identity.expiry) return;
                    if (wanted && identity.underlying !== wanted) return;
                    const brokerIdentity = identity.conId !== null
                        && identity.conId !== undefined
                        ? `con:${identity.conId}`
                        : (identity.localSymbol
                            ? `local:${identity.localSymbol}` : '');
                    const structural = [
                        identity.expiry, identity.sharesPerContract,
                    ].join('|');
                    const key = brokerIdentity
                        ? `${structural}|#${brokerIdentity}` : structural;
                    const previous = result.futures.get(key);
                    result.futures.set(key, Object.assign({}, previous || identity, {
                        key,
                        quantity: _round(
                            (previous ? previous.quantity : 0) + quantity, 6),
                    }));
                    return;
                }
                const parsed = parseOptionSymbol(values.symbol);
                const underlying = parsed ? parsed.underlying : _upper(values.symbol);
                if (wanted && underlying !== wanted) return;
                if (!parsed || assetKind === 'stock') {
                    result.shares = _round(result.shares + quantity, 6);
                    const positionBasis = _number(values.basis);
                    if (positionBasis !== null) {
                        result.shareCostBasis = _round(
                            (result.shareCostBasis || 0) + positionBasis, 6);
                    }
                    return;
                }
                const perContract = Math.abs(_number(values.multiplier) || 0)
                    || options.defaultSharesPerContract;
                const localSymbol = _upper(values.symbol);
                const exactDetail = options.instruments
                    ? options.instruments.get(`SYM|${localSymbol}`) : null;
                const conId = exactDetail && !exactDetail.ambiguous
                    ? exactDetail.conId : null;
                const identity = conId !== null && conId !== undefined
                    ? `con:${conId}` : (localSymbol ? `local:${localSymbol}` : '');
                const structuralKey = _instrumentKey(
                    underlying, parsed.expiry, parsed.right, parsed.strike, perContract);
                const key = identity ? `${structuralKey}|#${identity}` : structuralKey;
                const previous = result.options.get(key);
                result.options.set(key, {
                    key,
                    underlying,
                    right: parsed.right,
                    strike: parsed.strike,
                    expiry: parsed.expiry,
                    sharesPerContract: perContract,
                    conId,
                    localSymbol,
                    quantity: _round((previous ? previous.quantity : 0) + quantity, 6),
                    positionBasis: _number(values.basis) === null
                        ? (previous ? previous.positionBasis : null)
                        : _round(_number(previous && previous.positionBasis)
                            + _number(values.basis), 6),
                });
            });
        });
        return result;
    }

    /**
     * What the account already held when the statement period opened.
     *
     * This is arithmetic, not inference: the statement reports the closing
     * position and the batch says how much it moved, so
     * `opening = closing - delta` is exact. It matters because a
     * partial-period statement is silent about contracts that were open the
     * whole time - importing without them leaves the ledger short of real
     * positions, and a cost computed against a wrong position is worse than
     * no cost at all.
     *
     * Option stubs carry zero premium (the file does not contain it) and are
     * tagged, so the gap stays visible instead of being quietly invented.
     * The share opening is only REPORTED, never drafted: its cost basis is
     * genuinely unknown here, and guessing it would corrupt the one number
     * this whole page exists to get right.
     *
     * `existingOpen` / `existingShares` describe what the ledger ALREADY
     * holds and are netted out. Without them, importing next week's
     * statement - which shows the closes of positions this ledger opened
     * with real premium, but not their openings - would add a second,
     * premium-less copy of every one of them and leave the ledger holding
     * contracts that are already gone.
     */
    function deriveOpeningPositions(rows, events, options) {
        const opts = options || {};
        const symbol = _upper(opts.symbol);
        if (!symbol) return null;
        const end = extractEndPositions(rows, opts);
        if (!end || !end.hasData) return null;

        // A statement covers ONE account. Netting it against every account's
        // holdings would let one account's position cancel another's - the
        // ledger would then invent an opening that never existed.
        const account = String(opts.accountFallback || '');
        const existingItems = (opts.existingOpen || []).filter((item) => {
            const strike = _number(item.strike);
            return item.right && strike !== null
                && String(item.account || '') === account;
        });
        const alreadyShares = opts.existingSharesByAccount
            ? _number(opts.existingSharesByAccount[account]) || 0
            : _number(opts.existingShares) || 0;

        // The database de-duplicates statement rows by account+externalRef.
        // Opening arithmetic must use that SAME effective batch. Otherwise
        // an overlapping/repeated statement subtracts movements that will be
        // skipped at commit time, and the resulting prior_open stubs rewind
        // the ledger back to the statement's opening position.
        const knownRefStates = _existingExternalRefStates(opts.existingExternalRefs);
        const blockedSuppressedEvents = new Set();
        const effectiveEvents = (events || []).filter((event) => {
            if (!event.externalRef) return true;
            const known = knownRefStates.get(
                `${String(event.account || '')}\u0000${event.externalRef}`);
            if (known && (known.voided || known.excluded)) {
                blockedSuppressedEvents.add(event);
            }
            return !known;
        });

        const allOptionEvents = (events || []).filter((event) => (
            event.right && event.strike !== null && event.strike !== undefined
            && event.contracts !== null && event.contracts !== undefined));
        const optionEvents = effectiveEvents.filter((event) => (
            event.right && event.strike !== null && event.strike !== undefined
            && event.contracts !== null && event.contracts !== undefined));
        const optionEventSet = new Set(optionEvents);
        const endItems = Array.from(end.options.values());
        const identityKeys = _resolvePositionIdentities(
            existingItems.concat(allOptionEvents, endItems),
            symbol, opts.defaultSharesPerContract);
        const blockedIdentityKeys = new Set();
        blockedSuppressedEvents.forEach((event) => {
            if (allOptionEvents.indexOf(event) >= 0) {
                blockedIdentityKeys.add(identityKeys.get(event));
            }
        });

        const alreadyOpen = new Map();
        existingItems.forEach((item) => {
            const key = identityKeys.get(item);
            alreadyOpen.set(key, _round(
                (_number(alreadyOpen.get(key)) || 0)
                + (_number(item.contracts) || 0), 6));
        });

        const delta = new Map();
        let shareDelta = 0;
        effectiveEvents.forEach((event) => {
            if (event.shares !== null && event.shares !== undefined) {
                shareDelta = _round(shareDelta + _number(event.shares), 6);
            }
            if (!optionEventSet.has(event)) return;
            const key = identityKeys.get(event);
            const previous = delta.get(key) || { quantity: 0, event, events: [] };
            previous.quantity = _round(previous.quantity + _number(event.contracts), 6);
            previous.events.push(event);
            delta.set(key, previous);
        });

        const endByKey = new Map();
        endItems.forEach((item) => {
            const key = identityKeys.get(item);
            const previous = endByKey.get(key);
            endByKey.set(key, Object.assign({}, previous || item, {
                quantity: _round(
                    _number(previous && previous.quantity) + _number(item.quantity), 6),
            }));
        });

        const drafts = [];
        const problems = [];
        const keys = new Set([...endByKey.keys(), ...delta.keys()]);
        keys.forEach((key) => {
            const closing = endByKey.get(key);
            const moved = delta.get(key);
            const opening = _round(
                (closing ? closing.quantity : 0)
                - (moved ? moved.quantity : 0)
                - (alreadyOpen.get(key) || 0), 6);
            if (Math.abs(opening) < SHARE_EPSILON) return;
            // The real statement row cannot be appended because its unique
            // broker reference belongs to an inactive ledger row. The batch
            // receives a blocking problem below; do not also offer a
            // zero-premium surrogate for the same contract.
            if (blockedIdentityKeys.has(key)) return;
            if (key.indexOf('|#ambiguous') >= 0) {
                // Several real contracts share this structural key and the
                // statement's position section carries no contract number to
                // tell them apart. Drafting here would guess which one the
                // position belongs to, so it is reported for a human instead.
                const sample = (closing && closing) || (moved && moved.event) || {};
                problems.push({
                    lineNumber: 0,
                    reason: 'opening position cannot be attributed: several '
                        + 'contracts share this strike, expiry and multiplier '
                        + 'and the statement gives no contract number',
                    raw: `${symbol} ${sample.expiry || ''} ${sample.right || ''}`
                        + `${sample.strike === undefined ? '' : sample.strike}`,
                });
                return;
            }
            const descriptor = closing || {
                right: moved.event.right,
                strike: moved.event.strike,
                expiry: moved.event.expiry,
                conId: moved.event.conId,
                localSymbol: moved.event.localSymbol,
                sharesPerContract: moved.event.sharesPerContract
                    || opts.defaultSharesPerContract,
            };
            const periodEvents = (moved && moved.events) || [];
            const closingEvents = periodEvents.filter((event) => (
                event.tag === 'ibkr_close'
                || event.kind === 'option_expiry'
                || event.kind === 'option_assignment'
                || event.kind === 'option_exercise'));
            const closingQuantity = closingEvents.reduce(
                (sum, event) => _round(sum + (_number(event.contracts) || 0), 6), 0);
            const closingBasisCash = closingEvents.reduce(
                (sum, event) => _round(sum + (_number(event.brokerBasis) || 0), 6), 0);
            const endingQuantity = _number(closing && closing.quantity) || 0;
            const endingPositionBasis = _number(closing && closing.positionBasis);
            // Open Positions Cost Basis uses asset/liability sign, so its
            // corresponding opening cash is the negative. Trades.Basis on a
            // closing row already carries the historical opening-cash sign.
            const basisCash = _round(closingBasisCash
                - (endingPositionBasis || 0), 6);
            const sharesPerContract = descriptor.sharesPerContract
                || opts.defaultSharesPerContract;
            function basisClosesCleanly(event) {
                const basis = _number(event.brokerBasis);
                const realized = _number(event.brokerRealizedPnl);
                const closeCash = _number(event.brokerCloseCash);
                if (basis === null || realized === null || closeCash === null
                    || (event.brokerCodes || []).indexOf('W') >= 0) return false;
                if (event.kind === 'option_assignment'
                    || event.kind === 'option_exercise') {
                    // IBKR transfers the option basis into the delivered
                    // underlying on exercise/assignment.  The option row
                    // therefore reports zero close proceeds and zero realized
                    // P/L, while Basis is still the exact historical opening
                    // cash that the ledger needs.  Requiring Basis + cash =
                    // realized here would discard valid premium evidence.
                    return Math.abs(closeCash) < 0.02 && Math.abs(realized) < 0.02;
                }
                return Math.abs(basis + closeCash - realized) < 0.02;
            }
            // Basis is safe only when every movement for this identity is a
            // broker-labelled close, every close carries Basis, no part of
            // the opening is already represented in the ledger, and those
            // closes consume exactly the missing opening.  Anything weaker
            // could mix an in-period lot or a different tax lot into the
            // reconstructed cash and therefore stays visibly unknown.
            const basisIsComplete = (periodEvents.length > 0
                    || Math.abs(endingQuantity) >= SHARE_EPSILON)
                && closingEvents.length === periodEvents.length
                && closingEvents.every((event) => _number(event.brokerBasis) !== null)
                && closingEvents.every(basisClosesCleanly)
                && (Math.abs(endingQuantity) < SHARE_EPSILON
                    || endingPositionBasis !== null)
                && Math.abs(closingQuantity + opening - endingQuantity)
                    < SHARE_EPSILON
                && Math.abs(alreadyOpen.get(key) || 0) < SHARE_EPSILON
                && sharesPerContract > 0;
            const basisPrice = basisIsComplete
                ? _round(-basisCash / (opening * sharesPerContract), 8) : null;
            const usesBrokerBasis = basisIsComplete
                && basisPrice !== null && basisPrice >= 0;
            const hasBrokerBasisEvidence = endingPositionBasis !== null
                || closingEvents.some((event) => _number(event.brokerBasis) !== null);
            if (hasBrokerBasisEvidence && !usesBrokerBasis) {
                problems.push({
                    lineNumber: (moved && moved.event && moved.event.lineNumber) || 0,
                    reason: 'IBKR Basis exists but cannot be attributed safely to the '
                        + 'missing opening (O/C mix, adjustment code, or Basis + close '
                        + 'cash != realized P/L); use a complete earlier statement',
                    raw: `${symbol} ${descriptor.expiry || ''} ${descriptor.right || ''}`
                        + `${descriptor.strike === undefined ? '' : descriptor.strike}`,
                });
            }
            drafts.push({
                kind: 'option_trade',
                optionSecType: _upper(opts.secType) === 'FUT' ? 'FOP' : 'OPT',
                tradeDate: opts.openingDate || '',
                account: opts.accountFallback || '',
                right: descriptor.right,
                strike: descriptor.strike,
                expiry: descriptor.expiry,
                contracts: opening,
                sharesPerContract,
                conId: descriptor.conId === undefined ? null : descriptor.conId,
                localSymbol: descriptor.localSymbol || '',
                price: usesBrokerBasis ? basisPrice : 0,
                fees: 0,
                cashAmount: usesBrokerBasis ? basisCash : 0,
                source: 'csv_import',
                tag: usesBrokerBasis ? 'prior_basis' : 'prior_open',
                // Deliberately excludes the quantity: at most ONE opening
                // stub per contract per account, so importing a later
                // statement that re-derives the same opening cannot add a
                // second one.
                externalRef: `prior-${_hash16([
                    _upper(opts.accountFallback), symbol, descriptor.expiry,
                    descriptor.right, String(descriptor.strike),
                    String(descriptor.sharesPerContract || ''),
                    descriptor.conId === null || descriptor.conId === undefined
                        ? _upper(descriptor.localSymbol) : `con:${descriptor.conId}`,
                ].join('|'))}`,
                note: usesBrokerBasis
                    ? 'Held before this statement period; opening cash reconstructed '
                        + 'from IBKR Basis on the complete closing rows.'
                    : 'Held before this statement period; premium is not in this '
                        + 'file - fill it in or import the earlier statement.',
            });
        });
        drafts.sort((left, right) => (
            `${left.expiry}${left.right}${left.strike}`
                < `${right.expiry}${right.right}${right.strike}` ? -1 : 1));

        let openingShares = Array.from(blockedSuppressedEvents).some(
            (event) => event.shares !== null && event.shares !== undefined)
            ? 0 : _round(end.shares - shareDelta - alreadyShares, 6);
        const shareDrafts = [];
        if (Math.abs(openingShares) >= SHARE_EPSILON) {
            const shareMovements = effectiveEvents.filter(
                (event) => event.shares !== null && event.shares !== undefined);
            const shareCloses = shareMovements.filter(
                (event) => event.kind === 'share_trade' && event.tag === 'ibkr_close');
            const closeShares = shareCloses.reduce(
                (sum, event) => _round(sum + (_number(event.shares) || 0), 6), 0);
            const closingShareBasisCash = shareCloses.reduce(
                (sum, event) => _round(sum + (_number(event.brokerBasis) || 0), 6), 0);
            const endingShareBasis = _number(end.shareCostBasis);
            const shareBasisCash = _round(closingShareBasisCash
                - (endingShareBasis || 0), 6);
            const shareBasisComplete = (shareMovements.length > 0
                    || Math.abs(end.shares) >= SHARE_EPSILON)
                && shareCloses.length === shareMovements.length
                && shareCloses.every((event) => (
                    _number(event.brokerBasis) !== null
                    && _number(event.brokerRealizedPnl) !== null
                    && _number(event.brokerCloseCash) !== null
                    && Math.abs(_number(event.brokerBasis)
                        + _number(event.brokerCloseCash)
                        - _number(event.brokerRealizedPnl)) < 0.02
                    && (event.brokerCodes || []).indexOf('W') < 0))
                && (Math.abs(end.shares) < SHARE_EPSILON
                    || endingShareBasis !== null)
                && Math.abs(closeShares + openingShares - end.shares) < SHARE_EPSILON
                && Math.abs(alreadyShares) < SHARE_EPSILON;
            const sharePrice = shareBasisComplete
                ? _round(-shareBasisCash / openingShares, 8) : null;
            if (shareBasisComplete && sharePrice !== null && sharePrice >= 0) {
                shareDrafts.push({
                    kind: 'opening_balance', tradeDate: opts.openingDate || '',
                    account: opts.accountFallback || '', shares: openingShares,
                    price: sharePrice, fees: 0, cashAmount: shareBasisCash,
                    source: 'csv_import', tag: 'prior_basis',
                    externalRef: `prior-share-${_hash16([
                        _upper(opts.accountFallback), symbol,
                    ].join('|'))}`,
                    note: 'Held before this statement period; opening cash '
                        + 'reconstructed from IBKR Basis on complete share closing rows.',
                });
                openingShares = 0;
            } else if (endingShareBasis !== null || shareCloses.some(
                (event) => _number(event.brokerBasis) !== null)) {
                problems.push({
                    lineNumber: shareCloses[0] ? shareCloses[0].lineNumber : 0,
                    reason: 'IBKR share Basis exists but cannot be attributed safely '
                        + '(O/C mix, adjustment code, or Basis + close cash != realized '
                        + 'P/L); use a complete earlier statement',
                    raw: `${symbol} shares`,
                });
            }
        }

        return {
            drafts,
            shareDrafts,
            problems,
            openingShares,
            closingShares: end.shares,
        };
    }

    function _futureMovement(event, target, quantity) {
        const isTarget = target === true;
        return {
            event,
            account: String(event.account || ''),
            expiry: _contractDigits(isTarget
                ? event.rollToExpiry : (event.futureExpiry || event.expiry)),
            sharesPerContract: Math.abs(_number(event.sharesPerContract) || 0),
            conId: isTarget ? event.rollToConId : event.futureConId,
            localSymbol: _upper(isTarget
                ? event.rollToLocalSymbol : event.futureLocalSymbol),
            quantity: _round(quantity, 6),
        };
    }

    function _resolveFuturePositionIdentities(items) {
        const groups = new Map();
        function structural(item) {
            return [_contractDigits(item.expiry).slice(0, 6),
                item.sharesPerContract || ''].join('|');
        }
        (items || []).forEach((item) => {
            const key = structural(item);
            const group = groups.get(key) || {
                conIds: new Set(), localSymbols: new Set(), localToConIds: new Map(),
            };
            const conId = item.conId === null || item.conId === undefined
                || item.conId === '' ? '' : String(item.conId);
            const localSymbol = _upper(item.localSymbol);
            if (conId) group.conIds.add(conId);
            if (localSymbol) group.localSymbols.add(localSymbol);
            if (conId && localSymbol) {
                const mapped = group.localToConIds.get(localSymbol) || new Set();
                mapped.add(conId);
                group.localToConIds.set(localSymbol, mapped);
            }
            groups.set(key, group);
        });
        const resolved = new Map();
        (items || []).forEach((item) => {
            const key = structural(item);
            const group = groups.get(key);
            const conId = item.conId === null || item.conId === undefined
                || item.conId === '' ? '' : String(item.conId);
            const localSymbol = _upper(item.localSymbol);
            let identity = '';
            if (conId) {
                identity = `con:${conId}`;
            } else if (group.conIds.size) {
                const mapped = localSymbol && group.localToConIds.get(localSymbol);
                if (mapped && mapped.size === 1) identity = `con:${Array.from(mapped)[0]}`;
                else if (!localSymbol && group.conIds.size === 1) {
                    identity = `con:${Array.from(group.conIds)[0]}`;
                } else identity = 'ambiguous';
            } else if (localSymbol) {
                identity = `local:${localSymbol}`;
            } else if (group.localSymbols.size === 1) {
                identity = `local:${Array.from(group.localSymbols)[0]}`;
            } else if (group.localSymbols.size > 1) {
                identity = 'ambiguous';
            }
            resolved.set(item, identity ? `${key}|#${identity}` : key);
        });
        return resolved;
    }

    /**
     * Prove whether an Activity Statement contains the whole FUT opening.
     * A missing earlier FUT can never be drafted at price zero: unlike an
     * option premium stub, that would make the headline cost itself false.
     */
    function deriveOpeningFutures(rows, events, options) {
        const opts = options || {};
        const end = extractEndPositions(rows, opts);
        if (!end || !end.hasData) return null;
        const account = String(opts.accountFallback || '');
        const existing = (opts.existingOpenFutures || [])
            .filter((item) => String(item.account || '') === account)
            .map((item) => ({
                account,
                expiry: _contractDigits(item.expiry || item.futureExpiry),
                sharesPerContract: Math.abs(_number(
                    item.sharesPerContract || item.multiplier) || 0),
                conId: item.conId === undefined ? item.futureConId : item.conId,
                localSymbol: item.localSymbol || item.futureLocalSymbol || '',
                quantity: _number(item.contracts === undefined
                    ? item.futureContracts : item.contracts) || 0,
            }));
        const knownRefs = _existingExternalRefStates(opts.existingExternalRefs);
        const effective = (events || []).filter((event) => {
            if (!event.externalRef) return true;
            return !knownRefs.has(`${String(event.account || '')}\u0000${event.externalRef}`);
        });
        const movements = [];
        effective.forEach((event) => {
            if (event.kind === 'futures_roll') {
                const retained = _number(event.futureContracts) || 0;
                movements.push(_futureMovement(event, false, -retained));
                movements.push(_futureMovement(event, true, retained));
                return;
            }
            if (event.kind === 'futures_trade'
                || ((event.kind === 'option_assignment'
                    || event.kind === 'option_exercise')
                    && _upper(event.optionSecType) === 'FOP')) {
                movements.push(_futureMovement(
                    event, false, _number(event.futureContracts) || 0));
            }
        });
        const ending = Array.from(end.futures.values()).map((item) => ({
            account,
            expiry: item.expiry,
            sharesPerContract: item.sharesPerContract,
            conId: item.conId,
            localSymbol: item.localSymbol,
            quantity: item.quantity,
        }));
        const identities = _resolveFuturePositionIdentities(
            existing.concat(movements, ending));
        function totals(items) {
            const result = new Map();
            items.forEach((item) => {
                const key = identities.get(item);
                result.set(key, _round((result.get(key) || 0) + item.quantity, 6));
            });
            return result;
        }
        const already = totals(existing);
        const delta = totals(movements);
        const closing = totals(ending);
        const keys = new Set([...already.keys(), ...delta.keys(), ...closing.keys()]);
        const openingFutures = [];
        const problems = [];
        keys.forEach((key) => {
            const opening = _round(
                (closing.get(key) || 0) - (delta.get(key) || 0)
                - (already.get(key) || 0), 6);
            if (Math.abs(opening) < SHARE_EPSILON) return;
            const sample = ending.find((item) => identities.get(item) === key)
                || movements.find((item) => identities.get(item) === key)
                || existing.find((item) => identities.get(item) === key) || {};
            openingFutures.push(Object.assign({}, sample, { quantity: opening }));
            problems.push({
                lineNumber: 0,
                reason: 'statement begins with an existing FUT position whose entry '
                    + 'price is not in this file; import an earlier covering statement '
                    + 'or record/adopt a reviewed FUT baseline before appending',
                raw: `${opts.symbol || ''} ${sample.expiry || ''} FUT ${opening}`,
            });
        });
        return {
            drafts: [], problems, openingShares: 0, closingShares: 0,
            openingFutures,
        };
    }

    function deriveFuturesBookOpenings(rows, events, options) {
        const optionOpenings = deriveOpeningPositions(rows, events, options);
        const futureOpenings = deriveOpeningFutures(rows, events, options);
        if (!optionOpenings && !futureOpenings) return null;
        return {
            drafts: optionOpenings ? optionOpenings.drafts : [],
            problems: (optionOpenings ? optionOpenings.problems : []).concat(
                futureOpenings ? futureOpenings.problems : []),
            openingShares: 0,
            closingShares: 0,
            openingFutures: futureOpenings ? futureOpenings.openingFutures : [],
        };
    }

    /**
     * Parse a statement into reviewable drafts.
     *
     * Returns { format, events, problems, summary, unmappedColumns }. Every
     * event is a draft: the caller previews them and a human commits.
     */
    function parse(text, options) {
        const opts = Object.assign({
            symbol: '',
            secType: 'STK',
            defaultSharesPerContract: 100,
            accountFallback: '',
            targetAccount: '',
        }, options || {});
        opts.symbol = _upper(opts.symbol);
        opts.targetAccount = String(opts.targetAccount || '').trim();

        const rows = parseCsv(text);
        const format = detectFormat(rows);
        const periodThrough = format === 'activity' ? extractStatementThrough(rows) : '';
        if (format === 'unknown') {
            return {
                format,
                events: [],
                problems: [{
                    lineNumber: 0,
                    reason: 'file is neither a Flex Query nor an Activity Statement CSV',
                    raw: '',
                }],
                summary: { total: 0, drafted: 0, problems: 1, skipped: 0, byKind: {} },
                unmappedColumns: [],
                statementThrough: '',
            };
        }

        let groups;
        if (format === 'activity') {
            // The account lives in its own section, and the multipliers in
            // another; both are read before any row is classified.
            opts.accountFallback = extractAccount(rows) || opts.accountFallback;
            opts.instruments = extractInstruments(rows);
            const section = extractSection(rows, 'trades');
            if (!section) {
                return {
                    format,
                    events: _buildDividends(rows, opts).concat(
                        _buildWithholdingTaxes(rows, opts)),
                    problems: [{
                        lineNumber: 0,
                        reason: 'no Trades section found in the statement',
                        raw: '',
                    }],
                    summary: { total: 0, drafted: 0, problems: 1, skipped: 0, byKind: {} },
                    unmappedColumns: [],
                    account: opts.accountFallback,
                    statementThrough: periodThrough,
                };
            }
            groups = section.groups;
        } else {
            groups = [{
                built: buildMapping(rows[0]),
                records: rows.slice(1).map((row, index) => ({
                    values: row, lineNumber: index + 2,
                })),
            }];
        }

        const mappedAccount = groups.some(
            (group) => group.built.mapping.account !== undefined);
        if (opts.targetAccount && !opts.accountFallback && !mappedAccount) {
            return {
                format,
                events: [],
                problems: [{
                    lineNumber: 0,
                    reason: `statement account could not be verified for ledger ${opts.targetAccount}`,
                    raw: '',
                }],
                summary: { total: 0, drafted: 0, problems: 1, skipped: 0, byKind: {} },
                unmappedColumns: [],
                account: '',
                statementThrough: periodThrough,
            };
        }
        if (opts.targetAccount && opts.accountFallback
            && _upper(opts.accountFallback) !== _upper(opts.targetAccount)) {
            return {
                format,
                events: [],
                problems: [{
                    lineNumber: 0,
                    reason: `statement account ${opts.accountFallback} does not match ledger account ${opts.targetAccount}`,
                    raw: '',
                }],
                summary: { total: 0, drafted: 0, problems: 1, skipped: 0, byKind: {} },
                unmappedColumns: [],
                account: opts.accountFallback,
                statementThrough: periodThrough,
            };
        }

        for (let index = 0; index < groups.length; index += 1) {
            const missing = REQUIRED_TRADE_COLUMNS.filter(
                (field) => groups[index].built.mapping[field] === undefined);
            if (missing.length) {
                return {
                    format,
                    events: [],
                    problems: [{
                        lineNumber: 1,
                        reason: `required columns could not be identified: ${missing.join(', ')}`,
                        raw: groups[index].built.headers.join(','),
                    }],
                    summary: { total: 0, drafted: 0, problems: 1, skipped: 0, byKind: {} },
                    unmappedColumns: groups[index].built.unmapped,
                    account: opts.accountFallback,
                    statementThrough: periodThrough,
                };
            }
        }

        const events = [];
        const problems = [];
        const pendings = [];
        const contentRefOccurrences = new Map();
        const brokerRefLines = new Map();
        let skipped = 0;
        let total = 0;
        const unmapped = [];

        groups.forEach((group) => {
        total += group.records.length;
        group.built.unmapped.forEach((name) => {
            if (unmapped.indexOf(name) < 0) unmapped.push(name);
        });
        group.records.forEach((record) => {
            const values = _cellsToRecord(record.values, group.built.mapping);
            const rowAccount = String(values.account || opts.accountFallback || '').trim();
            if (opts.targetAccount
                && _upper(rowAccount) !== _upper(opts.targetAccount)) {
                skipped += 1;
                return;
            }
            const symbol = resolveUnderlying(values, opts);
            if (opts.symbol && symbol !== opts.symbol) {
                skipped += 1;
                return;
            }
            const classification = _classifyTrade(values, opts);
            if (!classification) {
                problems.push({
                    lineNumber: record.lineNumber,
                    reason: `unrecognized asset class "${values.assetClass || ''}" `
                        + `for this ${opts.secType} ledger`,
                    raw: record.values.join(','),
                });
                return;
            }
            const brokerRef = String(values.externalRef || '').trim();
            if (brokerRef) {
                const brokerRefKey = `${rowAccount}\u0000${brokerRef}`;
                if (brokerRefLines.has(brokerRefKey)) {
                    problems.push({
                        lineNumber: record.lineNumber,
                        reason: `duplicate broker execution id ${brokerRef} in this file; `
                            + `first seen on line ${brokerRefLines.get(brokerRefKey)}`,
                        raw: record.values.join(','),
                    });
                    return;
                }
                brokerRefLines.set(brokerRefKey, record.lineNumber);
            }
            const built1 = _buildDraft(values, classification, opts, record.lineNumber);
            if (built1.problem) {
                problems.push({
                    lineNumber: record.lineNumber,
                    reason: built1.problem,
                    raw: record.values.join(','),
                });
                return;
            }
            _assignContentOccurrenceRef(built1, values, contentRefOccurrences);
            if (built1.pending) {
                pendings.push(built1.pending);
                return;
            }
            events.push(Object.assign({ lineNumber: record.lineNumber }, built1.event));
        });
        });

        const paired = _pairDeliveries(pendings, opts);
        const allEvents = events.concat(paired.events);
        const openings = format === 'activity'
            ? (_upper(opts.secType) === 'FUT'
                ? deriveFuturesBookOpenings(rows, allEvents, opts)
                : deriveOpeningPositions(rows, allEvents, opts))
            : null;
        if (openings && openings.problems && openings.problems.length) {
            // These block the commit like any other unresolved row: an
            // unattributable opening is exactly the kind of guess this
            // importer must not make silently.
            problems.push(...openings.problems);
        }
        if (format === 'activity' && _upper(opts.secType) !== 'FUT') {
            allEvents.push(..._buildDividends(rows, opts));
            allEvents.push(..._buildWithholdingTaxes(rows, opts));
        }
        problems.push(..._corporateActionProblems(rows, opts));
        // A void/exclusion removes the row from the active ledger but the
        // database intentionally retains its broker reference. Append import
        // would therefore skip the real cash/position and must fail closed;
        // replacement rebuild is the only coherent recovery path.
        problems.push(..._blockedSuppressedRows(allEvents, opts));
        allEvents.sort((left, right) => {
            const leftTimestamp = left.brokerTimestamp || _brokerTimestamp(left.tradeDate);
            const rightTimestamp = right.brokerTimestamp || _brokerTimestamp(right.tradeDate);
            if (leftTimestamp !== rightTimestamp) {
                return leftTimestamp < rightTimestamp ? -1 : 1;
            }
            return (left.lineNumber || 0) - (right.lineNumber || 0);
        });

        const eventThrough = allEvents.reduce((latest, event) => {
            const timestamp = event.brokerTimestamp || _brokerTimestamp(event.tradeDate);
            return timestamp > latest ? timestamp : latest;
        }, '');

        const byKind = {};
        allEvents.forEach((item) => {
            byKind[item.kind] = (byKind[item.kind] || 0) + 1;
        });

        return {
            format,
            events: allEvents,
            problems: problems.concat(paired.problems),
            summary: {
                total,
                drafted: allEvents.length,
                problems: problems.length + paired.problems.length,
                skipped,
                byKind,
            },
            unmappedColumns: unmapped,
            account: opts.accountFallback,
            openings,
            statementThrough: periodThrough || eventThrough,
        };
    }

    globalScope.OptionComboCostBasisImport = {
        parseCsv,
        buildMapping,
        detectFormat,
        extractSection,
        extractAccount,
        extractStatementThrough,
        extractInstruments,
        extractEndPositions,
        deriveOpeningPositions,
        deriveOpeningFutures,
        deriveFuturesBookOpenings,
        parseOptionSymbol,
        resolveUnderlying,
        parse,
    };
})(typeof window !== 'undefined' ? window : globalThis);
