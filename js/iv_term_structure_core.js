/**
 * IV term structure aggregation helpers used by the standalone monitoring page.
 * Keep this file DOM-free so it can stay easy to test and reuse.
 */

(function attachIvTermStructureCore(globalScope) {
    const DEFAULT_BUCKET_DEFINITIONS = Object.freeze([
        { label: '1D', targetDays: 1 },
        { label: '3D', targetDays: 3 },
        { label: '1W', targetDays: 7 },
        { label: '3W', targetDays: 21 },
        { label: '1M', targetDays: 30 },
        { label: '3M', targetDays: 90 },
        { label: '6M', targetDays: 180 },
    ]);

    function cloneBucketDefinitions(definitions) {
        return (Array.isArray(definitions) ? definitions : DEFAULT_BUCKET_DEFINITIONS).map((entry) => ({
            label: String(entry && entry.label || '').trim() || 'Bucket',
            targetDays: Math.max(0, parseInt(entry && entry.targetDays, 10) || 0),
        }));
    }

    function _coercePositiveNumber(value) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    function _roundNumber(value, decimals) {
        if (!Number.isFinite(value)) {
            return null;
        }
        const factor = 10 ** Math.max(0, decimals || 0);
        return Math.round(value * factor) / factor;
    }

    function _computeAverageIv(callIv, putIv) {
        if (!Number.isFinite(callIv) || !Number.isFinite(putIv)) {
            return null;
        }
        return _roundNumber((callIv + putIv) / 2, 6);
    }

    function buildExpiryDetailRows(expiryRows, quotesBySubId) {
        const quotes = quotesBySubId && typeof quotesBySubId === 'object'
            ? quotesBySubId
            : {};

        return (Array.isArray(expiryRows) ? expiryRows : [])
            .map((entry) => {
                const callQuote = entry && entry.atmCallSubId ? quotes[entry.atmCallSubId] : null;
                const putQuote = entry && entry.atmPutSubId ? quotes[entry.atmPutSubId] : null;
                const callIv = _coercePositiveNumber(callQuote && callQuote.iv);
                const putIv = _coercePositiveNumber(putQuote && putQuote.iv);
                const atmIv = _computeAverageIv(callIv, putIv);

                return {
                    expiry: String(entry && entry.expiry || '').trim(),
                    dte: Math.max(0, parseInt(entry && entry.dte, 10) || 0),
                    atmStrike: _coercePositiveNumber(entry && entry.atmStrike),
                    callIv,
                    putIv,
                    atmIv,
                    callMark: _coercePositiveNumber(callQuote && callQuote.mark),
                    putMark: _coercePositiveNumber(putQuote && putQuote.mark),
                    hasCompletePair: Number.isFinite(callIv) && Number.isFinite(putIv),
                    atmCallSubId: String(entry && entry.atmCallSubId || '').trim(),
                    atmPutSubId: String(entry && entry.atmPutSubId || '').trim(),
                };
            })
            .filter((entry) => entry.expiry)
            .sort((left, right) => (
                left.dte - right.dte
                || String(left.expiry).localeCompare(String(right.expiry))
            ));
    }

    function _pickNearestDetailRow(detailRows, targetDays) {
        let match = null;
        let matchDistance = Number.POSITIVE_INFINITY;

        for (const row of (Array.isArray(detailRows) ? detailRows : [])) {
            if (!row || !Number.isFinite(row.dte)) {
                continue;
            }

            const distance = Math.abs(row.dte - targetDays);
            if (
                match === null
                || distance < matchDistance
                || (distance === matchDistance && row.dte < match.dte)
                || (distance === matchDistance && row.dte === match.dte && String(row.expiry) < String(match.expiry))
            ) {
                match = row;
                matchDistance = distance;
            }
        }

        return match;
    }

    function buildBucketRows(detailRows, bucketDefinitions) {
        const buckets = cloneBucketDefinitions(bucketDefinitions);
        const normalizedRows = Array.isArray(detailRows) ? detailRows.slice() : [];

        return buckets.map((bucket) => {
            const match = _pickNearestDetailRow(normalizedRows, bucket.targetDays);
            return {
                label: bucket.label,
                targetDays: bucket.targetDays,
                matchedExpiry: match ? String(match.expiry || '') : null,
                matchedDte: match && Number.isFinite(match.dte) ? match.dte : null,
                atmStrike: match && Number.isFinite(match.atmStrike) ? match.atmStrike : null,
                callIv: match && Number.isFinite(match.callIv) ? match.callIv : null,
                putIv: match && Number.isFinite(match.putIv) ? match.putIv : null,
                atmIv: match && Number.isFinite(match.atmIv) ? match.atmIv : null,
                hasCompletePair: !!(match && match.hasCompletePair === true),
            };
        });
    }

    function buildSampleRecord(symbol, underlyingPrice, bucketRows, detailRows, sampledAt, quoteDate) {
        return {
            symbol: String(symbol || '').trim().toUpperCase(),
            sampledAt: String(sampledAt || '').trim(),
            quoteDate: String(quoteDate || '').trim(),
            underlyingPrice: _coercePositiveNumber(underlyingPrice),
            buckets: Array.isArray(bucketRows) ? bucketRows.map((row) => ({ ...row })) : [],
            details: Array.isArray(detailRows) ? detailRows.map((row) => ({ ...row })) : [],
        };
    }

    globalScope.OptionComboIvTermStructureCore = {
        DEFAULT_BUCKET_DEFINITIONS: cloneBucketDefinitions(DEFAULT_BUCKET_DEFINITIONS),
        cloneBucketDefinitions,
        buildExpiryDetailRows,
        buildBucketRows,
        buildSampleRecord,
    };
})(typeof window !== 'undefined' ? window : globalThis);
