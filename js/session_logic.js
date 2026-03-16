/**
 * Pure session import/export and mode-selection helpers.
 */

(function attachSessionLogic(globalScope) {
    function isGroupIncludedInGlobal(group) {
        return group.includedInGlobal !== false;
    }

    function groupHasDeterministicCost(group) {
        return (group.legs || []).some(leg => Math.abs(parseFloat(leg.cost) || 0) > 0);
    }

    function resolveGroupViewModeChange(group, requestedMode) {
        if (requestedMode === 'amortized' && !groupHasDeterministicCost(group)) {
            return group.viewMode || 'active';
        }
        return requestedMode;
    }

    function getRenderableGroupViewMode(group) {
        const currentMode = group.viewMode || 'active';
        if (!groupHasDeterministicCost(group) && currentMode !== 'settlement') {
            return 'trial';
        }
        return currentMode;
    }

    function buildExportState(state) {
        return JSON.parse(JSON.stringify(state));
    }

    function normalizeImportedState(currentState, importedState, initialDateStr, generateId, addDays) {
        const nextState = {
            underlyingSymbol: importedState.underlyingSymbol || 'SPY',
            underlyingContractMonth: importedState.underlyingContractMonth || '',
            underlyingPrice: importedState.underlyingPrice || 100,
            baseDate: importedState.baseDate || initialDateStr,
            simulatedDate: importedState.baseDate || initialDateStr,
            interestRate: importedState.interestRate !== undefined ? importedState.interestRate : 0.03,
            ivOffset: importedState.ivOffset || 0,
            groups: currentState.groups.slice(),
            hedges: currentState.hedges.slice(),
        };

        if (importedState.simulatedDate) {
            nextState.simulatedDate = importedState.simulatedDate;
        } else if (importedState.daysPassed !== undefined) {
            nextState.simulatedDate = addDays(nextState.baseDate, importedState.daysPassed);
        } else {
            nextState.simulatedDate = nextState.baseDate;
        }

        function migrateLegs(legsArr) {
            return legsArr.map(leg => {
                const newLeg = { ...leg, id: generateId() };
                if (newLeg.dte !== undefined && newLeg.expDate === undefined) {
                    newLeg.expDate = addDays(nextState.baseDate, newLeg.dte);
                    delete newLeg.dte;
                }
                if (newLeg.currentPrice === undefined) {
                    newLeg.currentPrice = 0.00;
                }
                if (newLeg.closePrice === undefined) {
                    newLeg.closePrice = null;
                }
                return newLeg;
            });
        }

        let importedGroups = [];
        if (importedState.legs && Array.isArray(importedState.legs) && (!importedState.groups || importedState.groups.length === 0)) {
            importedGroups = [{
                id: generateId(),
                name: 'Legacy Combo',
                includedInGlobal: true,
                settleUnderlyingPrice: null,
                legs: migrateLegs(importedState.legs)
            }];
        } else {
            const parsedGroups = Array.isArray(importedState.groups) ? importedState.groups : [];
            importedGroups = parsedGroups.map(g => ({
                ...g,
                id: generateId(),
                includedInGlobal: isGroupIncludedInGlobal(g),
                settleUnderlyingPrice: g.settleUnderlyingPrice !== undefined ? g.settleUnderlyingPrice : null,
                legs: migrateLegs(Array.isArray(g.legs) ? g.legs : [])
            }));
        }

        nextState.groups.push(...importedGroups);

        if (importedState.hedges && Array.isArray(importedState.hedges)) {
            nextState.hedges.push(...importedState.hedges.map(h => ({
                ...h,
                id: generateId()
            })));
        }

        return nextState;
    }

    globalScope.OptionComboSessionLogic = {
        isGroupIncludedInGlobal,
        groupHasDeterministicCost,
        resolveGroupViewModeChange,
        getRenderableGroupViewMode,
        buildExportState,
        normalizeImportedState,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
