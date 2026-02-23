/**
 * Custom Vanilla JS P&L Chart using HTML5 Canvas
 * Draws a Profit & Loss curve for a given Option Combo group over a price range.
 */

class PnLChart {
    /**
     * @param {HTMLCanvasElement} canvas 
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        // Handle high DPI displays for crisp rendering
        this.dpr = window.devicePixelRatio || 1;

        // Settings
        this.padding = { top: 20, right: 30, bottom: 30, left: 60 };
        this.pointsCount = 100;
        this.gridColor = '#E5E7EB';
        this.axisColor = '#9CA3AF';
        this.textColor = '#6B7280';
        this.profitColor = 'rgba(5, 150, 105, 0.8)'; // Emerald
        this.lossColor = 'rgba(220, 38, 38, 0.8)'; // Red
        this.fillOpacity = 0.15;

        // Tooltip State
        this.hoverX = null;
        this.hoverY = null;
        this.hoverData = null;

        // Cache drawn background to optimize tooltip rendering
        this.chartImageCache = null;

        // Bind events
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseLeave = this.handleMouseLeave.bind(this);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
    }

    /**
     * Resizes the canvas respecting DPR
     */
    resize() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = Math.max(250, rect.height); // Minimum height 250px

        this.canvas.width = this.width * this.dpr;
        this.canvas.height = this.height * this.dpr;
        this.canvas.style.width = `${this.width}px`;
        this.canvas.style.height = `${this.height}px`;

        this.ctx.scale(this.dpr, this.dpr);
    }

    /**
     * Handles mouse movement over the canvas for tooltip
     */
    handleMouseMove(e) {
        if (!this.lastRenderData || this.lastRenderData.data.length === 0) return;

        const rect = this.canvas.getBoundingClientRect();
        // Mouse CSS coordinates
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const { minS, maxS, drawW, padding } = this.lastRenderData;

        // If outside internal draw area (horizontally)
        if (mouseX < padding.left || mouseX > padding.left + drawW) {
            this.handleMouseLeave();
            return;
        }

        // Map mouseX to simulated price
        const priceAtMouse = minS + ((mouseX - padding.left) / drawW) * (maxS - minS);

        // Find closest data point
        let closestPt = this.lastRenderData.data[0];
        let minDiff = Math.abs(closestPt.x - priceAtMouse);

        for (let i = 1; i < this.lastRenderData.data.length; i++) {
            const px = this.lastRenderData.data[i];
            const diff = Math.abs(px.x - priceAtMouse);
            if (diff < minDiff) {
                minDiff = diff;
                closestPt = px;
            }
        }

        this.hoverData = closestPt;
        this.hoverX = mouseX;
        this.hoverY = mouseY;

        this.drawWithTooltip();
    }

    handleMouseLeave() {
        if (this.hoverData) {
            this.hoverData = null;
            this.hoverX = null;
            this.hoverY = null;
            this.drawWithTooltip(); // Clears tooltip
        }
    }

    /**
     * Main draw function creates the static chart and caches it
     * @param {Object} group 
     * @param {Object} globalState 
     * @param {number} minS 
     * @param {number} maxS 
     */
    draw(group, globalState, minS, maxS) {
        this.resize();
        this.ctx.clearRect(0, 0, this.width, this.height);

        if (!group || group.legs.length === 0 || minS >= maxS) {
            this.drawEmptyState();
            this.lastRenderData = null;
            return;
        }

        // Generate data points
        const data = [];
        let minPnL = Infinity;
        let maxPnL = -Infinity;
        let trueMinPnL = Infinity;
        let trueMaxPnL = -Infinity;

        const diffDays = (d1Str, d2Str) => {
            const d1 = new Date(d1Str + 'T00:00:00Z');
            const d2 = new Date(d2Str + 'T00:00:00Z');
            const diffTime = d2 - d1;
            return Math.max(0, Math.round(diffTime / 86400000));
        };

        const globalSimDateStr = globalState.simulatedDate;
        const globalSimDateObj = new Date(globalSimDateStr + 'T00:00:00Z');

        // Pre-process legs to avoid running expensive Date calculations in the loop
        const processedLegs = group.legs.map(leg => {
            const expDateObj = new Date(leg.expDate + 'T00:00:00Z');
            const isExpired = expDateObj <= globalSimDateObj;
            const simCalDTE = isExpired ? 0 : diffDays(globalSimDateStr, leg.expDate);
            const simTradDTE = Math.max(0, Math.round(simCalDTE * 252 / 365));
            const simIV = Math.max(0.001, leg.iv + globalState.ivOffset);
            const timeToMaturityYears = simTradDTE / 252.0;
            const costBasis = leg.pos * 100 * leg.cost;

            return {
                type: leg.type,
                pos: leg.pos,
                strike: leg.strike,
                simTradDTE,
                simCalDTE,
                simIV,
                timeToMaturityYears,
                costBasis
            };
        });

        const step = (maxS - minS) / (this.pointsCount - 1);
        for (let i = 0; i < this.pointsCount; i++) {
            const currentS = minS + (i * step);
            let simValue = 0;
            let totalCostBasis = 0;

            for (let j = 0; j < processedLegs.length; j++) {
                const l = processedLegs[j];
                totalCostBasis += l.costBasis;

                let pricePerShare = 0;
                if (l.simCalDTE > 0) {
                    pricePerShare = calculateOptionPrice(l.type, currentS, l.strike, l.timeToMaturityYears, globalState.interestRate, l.simIV);
                } else {
                    if (l.type === 'call') pricePerShare = Math.max(0, currentS - l.strike);
                    if (l.type === 'put') pricePerShare = Math.max(0, l.strike - currentS);
                }
                simValue += l.pos * 100 * pricePerShare;
            }

            const pnl = simValue - totalCostBasis;
            data.push({ x: currentS, y: pnl });

            if (pnl < trueMinPnL) trueMinPnL = pnl;
            if (pnl > trueMaxPnL) trueMaxPnL = pnl;
            if (pnl < minPnL) minPnL = pnl;
            if (pnl > maxPnL) maxPnL = pnl;
        }

        // Add 10% vertical padding to data extrema to prevent hugging the edges
        const pnlRange = maxPnL - minPnL;
        if (pnlRange === 0) {
            maxPnL += 10;
            minPnL -= 10;
        } else {
            maxPnL += pnlRange * 0.1;
            minPnL -= pnlRange * 0.1;
        }

        // Internal drawing bounds
        const drawW = this.width - this.padding.left - this.padding.right;
        const drawH = this.height - this.padding.top - this.padding.bottom;

        // Coordinate Mapping Helpers
        const mapX = val => this.padding.left + ((val - minS) / (maxS - minS)) * drawW;
        const mapY = val => this.padding.top + drawH - (((val - minPnL) / (maxPnL - minPnL)) * drawH);

        const yZero = Math.max(this.padding.top, Math.min(this.padding.top + drawH, mapY(0)));

        this.drawAxes(minS, maxS, minPnL, maxPnL, mapX, mapY, drawW, drawH, globalState);

        // Draw Current Underlying Price Reference Line
        const currentS = globalState.underlyingPrice;
        if (currentS >= minS && currentS <= maxS) {
            const curX = mapX(currentS);
            this.ctx.beginPath();
            this.ctx.setLineDash([5, 5]);
            this.ctx.moveTo(curX, this.padding.top);
            this.ctx.lineTo(curX, this.padding.top + drawH);
            this.ctx.strokeStyle = '#6366F1'; // Indigo
            this.ctx.lineWidth = 1.5;
            this.ctx.stroke();
            this.ctx.setLineDash([]);

            // Label for current price
            this.ctx.fillStyle = '#6366F1';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'bottom';
            this.ctx.fillText(`Current: $${currentS.toFixed(2)}`, curX, this.padding.top - 5);
        }

        // Clip drawing area to not leak into padding
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(this.padding.left, this.padding.top, drawW, drawH);
        this.ctx.clip();

        // Draw Zero Line (X-Axis Baseline inside clip)
        this.ctx.beginPath();
        this.ctx.moveTo(this.padding.left, yZero);
        this.ctx.lineTo(this.padding.left + drawW, yZero);
        this.ctx.strokeStyle = this.axisColor;
        this.ctx.lineWidth = 1;
        this.ctx.stroke();

        // Path creation
        this.ctx.beginPath();
        this.ctx.moveTo(mapX(data[0].x), mapY(data[0].y));
        data.forEach(pt => {
            this.ctx.lineTo(mapX(pt.x), mapY(pt.y));
        });

        // Split stroke by profit/loss (approximated visually with a custom gradient)
        // A linear gradient from top to bottom
        const curveGradient = this.ctx.createLinearGradient(0, this.padding.top, 0, this.padding.top + drawH);

        // Figure out gradient stops for 0 line
        let zeroRatio = (yZero - this.padding.top) / drawH;
        // Clamp between 0 and 1
        zeroRatio = Math.max(0, Math.min(1, zeroRatio));

        if (zeroRatio > 0 && zeroRatio < 1) {
            curveGradient.addColorStop(0, this.profitColor);
            curveGradient.addColorStop(zeroRatio - 0.001, this.profitColor);
            curveGradient.addColorStop(zeroRatio + 0.001, this.lossColor);
            curveGradient.addColorStop(1, this.lossColor);
        } else if (zeroRatio >= 1) {
            // All Profit
            curveGradient.addColorStop(0, this.profitColor);
            curveGradient.addColorStop(1, this.profitColor);
        } else {
            // All Loss
            curveGradient.addColorStop(0, this.lossColor);
            curveGradient.addColorStop(1, this.lossColor);
        }

        this.ctx.strokeStyle = curveGradient;
        this.ctx.lineWidth = 2.5;
        this.ctx.lineJoin = 'round';
        this.ctx.stroke();

        // Optional Fill Area
        this.ctx.lineTo(mapX(data[data.length - 1].x), yZero);
        this.ctx.lineTo(mapX(data[0].x), yZero);
        this.ctx.closePath();

        const fillGradient = this.ctx.createLinearGradient(0, this.padding.top, 0, this.padding.top + drawH);
        if (zeroRatio > 0 && zeroRatio < 1) {
            fillGradient.addColorStop(0, `rgba(5, 150, 105, ${this.fillOpacity})`);
            fillGradient.addColorStop(zeroRatio - 0.001, `rgba(5, 150, 105, ${this.fillOpacity})`);
            fillGradient.addColorStop(zeroRatio + 0.001, `rgba(220, 38, 38, ${this.fillOpacity})`);
            fillGradient.addColorStop(1, `rgba(220, 38, 38, ${this.fillOpacity})`);
        } else if (zeroRatio >= 1) {
            fillGradient.addColorStop(0, `rgba(5, 150, 105, ${this.fillOpacity})`);
            fillGradient.addColorStop(1, `rgba(5, 150, 105, ${this.fillOpacity})`);
        } else {
            fillGradient.addColorStop(0, `rgba(220, 38, 38, ${this.fillOpacity})`);
            fillGradient.addColorStop(1, `rgba(220, 38, 38, ${this.fillOpacity})`);
        }

        this.ctx.fillStyle = fillGradient;
        this.ctx.fill();

        // Find and draw break-even points (zero crossings)
        this.ctx.font = '11px Inter, sans-serif';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'bottom';

        let breakEvens = [];
        for (let i = 1; i < data.length; i++) {
            const p1 = data[i - 1];
            const p2 = data[i];

            // Check if signs are different (crossing zero)
            if ((p1.y > 0 && p2.y <= 0) || (p1.y < 0 && p2.y >= 0)) {
                // Linear interpolation to find exact X where Y = 0
                const t = Math.abs(p1.y) / (Math.abs(p1.y) + Math.abs(p2.y));
                const zeroX = p1.x + t * (p2.x - p1.x);

                // Avoid drawing duplicates too close to each other
                if (breakEvens.length === 0 || Math.abs(breakEvens[breakEvens.length - 1] - zeroX) > (maxS - minS) * 0.05) {
                    breakEvens.push(zeroX);

                    const px = mapX(zeroX);

                    // Draw dot on the zero line
                    this.ctx.beginPath();
                    this.ctx.arc(px, yZero, 4, 0, Math.PI * 2);
                    this.ctx.fillStyle = '#F59E0B'; // Amber string for break-even
                    this.ctx.fill();
                    this.ctx.strokeStyle = '#fff';
                    this.ctx.lineWidth = 1.5;
                    this.ctx.stroke();

                    // Calc % change
                    let pctLabel = '0.0%';
                    if (currentS > 0) {
                        const pct = ((zeroX - currentS) / currentS) * 100;
                        pctLabel = (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
                    }

                    // Draw label
                    const labelStr = `BE: $${zeroX.toFixed(2)} (${pctLabel})`;

                    // Box background for label legibility
                    const textWidth = this.ctx.measureText(labelStr).width;
                    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                    this.ctx.fillRect(px - textWidth / 2 - 4, yZero - 22, textWidth + 8, 16);

                    this.ctx.fillStyle = '#D97706'; // Darker amber for text
                    this.ctx.fillText(labelStr, px, yZero - 8);
                }
            }
        }

        this.ctx.restore(); // Remove clip

        // Draw Max Profit / Loss labels in the top-left corner
        this.ctx.font = '12px Inter, sans-serif';
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'top';

        const formatMoney = val => (val >= 0 ? '+' : '-') + '$' + Math.abs(val).toFixed(2);

        // Use darker variations for text rendering for clarity
        this.ctx.fillStyle = '#059669'; // Emerald 600
        this.ctx.fillText(`Max Profit (in range): ${formatMoney(trueMaxPnL)}`, this.padding.left + 10, this.padding.top + 10);

        this.ctx.fillStyle = '#DC2626'; // Red 600
        this.ctx.fillText(`Max Loss (in range): ${formatMoney(trueMinPnL)}`, this.padding.left + 10, this.padding.top + 28);

        // Cache parameters for tooltips
        this.lastRenderData = {
            data, minS, maxS, minPnL, maxPnL, drawW, drawH, padding: this.padding, mapX, mapY, globalState
        };

        // Cache the drawn canvas pixels to offscreen image
        if (!this.offscreenCanvas) {
            this.offscreenCanvas = document.createElement('canvas');
        }
        this.offscreenCanvas.width = this.canvas.width;
        this.offscreenCanvas.height = this.canvas.height;
        this.offscreenCanvas.getContext('2d').drawImage(this.canvas, 0, 0);

        this.drawWithTooltip(); // initial check if mouse is still hovering
    }

    /**
     * Restores cached chart and overlays tooltip
     */
    drawWithTooltip() {
        if (!this.offscreenCanvas) return;

        // Clear and restore static background
        this.ctx.clearRect(0, 0, this.width, this.height);
        this.ctx.save();
        this.ctx.scale(1 / this.dpr, 1 / this.dpr);
        this.ctx.drawImage(this.offscreenCanvas, 0, 0);
        this.ctx.restore();

        if (this.hoverData && this.lastRenderData) {
            const { mapX, mapY, padding, drawH, globalState } = this.lastRenderData;
            const px = mapX(this.hoverData.x);
            const py = mapY(this.hoverData.y);

            // Draw vertical crosshair line
            this.ctx.beginPath();
            this.ctx.moveTo(px, padding.top);
            this.ctx.lineTo(px, padding.top + drawH);
            this.ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
            this.ctx.lineWidth = 1;
            this.ctx.stroke();

            // Draw Point Dot
            this.ctx.beginPath();
            this.ctx.arc(px, py, 4, 0, Math.PI * 2);
            this.ctx.fillStyle = this.hoverData.y >= 0 ? this.profitColor : this.lossColor;
            this.ctx.fill();
            this.ctx.strokeStyle = '#fff';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();

            // Draw Tooltip Box
            const currentUnderlying = globalState.underlyingPrice;
            let percentChange = 0;
            if (currentUnderlying > 0) {
                percentChange = ((this.hoverData.x - currentUnderlying) / currentUnderlying) * 100;
            }

            const lines = [
                `Price: $${this.hoverData.x.toFixed(2)} (${percentChange > 0 ? '+' : ''}${percentChange.toFixed(1)}%)`,
                `P&L: ${this.hoverData.y >= 0 ? '+' : ''}$${this.hoverData.y.toFixed(2)}`
            ];

            this.ctx.font = '12px Inter, sans-serif';
            let maxWidth = 0;
            lines.forEach(line => {
                const w = this.ctx.measureText(line).width;
                if (w > maxWidth) maxWidth = w;
            });

            const tipW = maxWidth + 16;
            const tipH = 40;
            let tipX = px + 10;
            let tipY = this.hoverY - 20;

            // Keep tooltip within bounds
            if (tipX + tipW > this.width - 5) tipX = px - tipW - 10;
            if (tipY < 5) tipY = 5;
            if (tipY + tipH > this.height - 5) tipY = this.height - tipH - 5;

            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            this.ctx.strokeStyle = '#E5E7EB';
            this.ctx.lineWidth = 1;
            // Draw rounded rect
            this.ctx.beginPath();
            this.ctx.roundRect(tipX, tipY, tipW, tipH, 4);
            this.ctx.fill();
            this.ctx.stroke();

            this.ctx.fillStyle = '#111827';
            this.ctx.textAlign = 'left';
            this.ctx.textBaseline = 'top';
            this.ctx.fillText(lines[0], tipX + 8, tipY + 6);

            this.ctx.fillStyle = this.hoverData.y >= 0 ? this.profitColor : this.lossColor;
            this.ctx.fontWeight = 'bold';
            this.ctx.fillText(lines[1], tipX + 8, tipY + 22);
        }
    }

    drawAxes(minS, maxS, minPnL, maxPnL, mapX, mapY, drawW, drawH, globalState) {
        this.ctx.font = '11px Inter, sans-serif';
        this.ctx.fillStyle = this.textColor;

        // Y-axis (PnL) Ticks
        const tickCountY = 5;
        this.ctx.textAlign = 'right';
        this.ctx.textBaseline = 'middle';
        this.ctx.lineWidth = 1;

        for (let i = 0; i <= tickCountY; i++) {
            const pnlTick = minPnL + (maxPnL - minPnL) * (i / tickCountY);
            const y = mapY(pnlTick);

            this.ctx.beginPath();
            this.ctx.moveTo(this.padding.left, y);
            this.ctx.lineTo(this.padding.left + drawW, y);
            this.ctx.strokeStyle = this.gridColor;
            this.ctx.stroke();

            // Label
            // Formatting helper
            let formatted = (pnlTick > 0 ? '+' : '') + Math.round(pnlTick);
            if (Math.abs(pnlTick) >= 1000) {
                formatted = (pnlTick > 0 ? '+' : '') + (pnlTick / 1000).toFixed(1) + 'k';
            }
            this.ctx.fillText(formatted, this.padding.left - 8, y);
        }

        // X-axis (Price) Ticks (Make them denser, e.g. 10 ticks)
        const tickCountX = 10;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'top';

        const currentUnderlying = globalState.underlyingPrice;

        for (let i = 0; i <= tickCountX; i++) {
            const sTick = minS + (maxS - minS) * (i / tickCountX);
            const x = mapX(sTick);

            this.ctx.beginPath();
            this.ctx.moveTo(x, this.padding.top);
            this.ctx.lineTo(x, this.padding.top + drawH);
            this.ctx.strokeStyle = this.gridColor;
            this.ctx.stroke();

            // Calculate percentage from current price
            let pctLabel = '';
            if (currentUnderlying > 0) {
                const pct = ((sTick - currentUnderlying) / currentUnderlying) * 100;
                // Add % below price
                pctLabel = (pct > 0 ? '+' : '') + pct.toFixed(1) + '%';
            }

            // Draw Price
            this.ctx.fillStyle = this.textColor;
            this.ctx.fillText(`$${sTick.toFixed(1)}`, x, this.padding.top + drawH + 4);
            // Draw % 
            this.ctx.fillStyle = '#9CA3AF'; // lighter gray
            this.ctx.fillText(pctLabel, x, this.padding.top + drawH + 16);
        }

        // Adjust padding to accommodate two lines of text on X axis
        this.padding.bottom = 40;

        // Draw bounding box
        this.ctx.strokeRect(this.padding.left, this.padding.top, drawW, drawH);
    }

    drawEmptyState() {
        this.ctx.font = '14px Inter, sans-serif';
        this.ctx.fillStyle = this.textColor;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText("Not enough data to calculate P&L curve.", this.width / 2, this.height / 2);
    }
}
