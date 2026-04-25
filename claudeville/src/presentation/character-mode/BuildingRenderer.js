import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';

const BUILDING_STYLES = {
    command: {
        wallColor: '#6b4328',
        roofColor: '#9b1816',
        accentColor: '#f2d36b',
        trimColor: '#2f2017',
        wallHeight: 54,
        hasAntenna: true,
        hasFlag: true,
        windowGlow: true,
    },
    forge: {
        wallColor: '#59402d',
        roofColor: '#3e3b39',
        accentColor: '#ff8a2a',
        trimColor: '#261d17',
        wallHeight: 43,
        hasChimney: true,
        hasAnvil: true,
    },
    mine: {
        wallColor: '#4b4035',
        roofColor: '#6a5134',
        accentColor: '#eec85d',
        trimColor: '#251b14',
        wallHeight: 38,
        customRoof: 'mine',
        hasMineEntrance: true,
        hasPickaxe: true,
        hasGems: true,
    },
    taskboard: {
        wallColor: '#5d4a34',
        roofColor: '#766046',
        accentColor: '#78c6e7',
        trimColor: '#2a2119',
        wallHeight: 34,
        customRoof: 'taskboard',
        hasPostits: true,
    },
    chathall: {
        wallColor: '#40566a',
        roofColor: '#6f96b7',
        accentColor: '#88d67e',
        trimColor: '#23313d',
        wallHeight: 42,
        hasRoundRoof: true,
        hasBubble: true,
    },
};

export class BuildingRenderer {
    constructor(particleSystem) {
        this.particleSystem = particleSystem;
        this.buildings = [];
        this.hoveredBuilding = null;
        this.torchFrame = 0;
        this.agentSprites = [];
        this.roofAlpha = new Map(); // Roof opacity per building (1=roof visible, 0=interior visible)
    }

    setBuildings(buildings) {
        this.buildings = Array.from(buildings.values());
    }

    setAgentSprites(sprites) {
        this.agentSprites = sprites;
    }

    update() {
        this.torchFrame += 0.08;

        // Update roof opacity (Sims-style effect)
        for (const b of this.buildings) {
            const center = this._getBuildingCenter(b);
            const halfW = b.width * TILE_WIDTH / 4;
            const style = BUILDING_STYLES[b.type];
            if (!style) continue;

            // Check whether an agent is near the building
            let agentNear = false;
            for (const sprite of this.agentSprites) {
                const dx = sprite.x - center.x;
                const dy = sprite.y - center.y;
                if (Math.abs(dx) < halfW + 15 && dy > -style.wallHeight - 10 && dy < 20) {
                    agentNear = true;
                    break;
                }
            }

            const current = this.roofAlpha.get(b) ?? 1;
            const target = agentNear ? 0 : 1;
            const speed = 0.06;
            const next = current + (target - current) * speed;
            this.roofAlpha.set(b, next);

            this._spawnTorchParticles(b);
            if (b.type === 'forge') {
                this._spawnSmokeParticles(b);
            }
            if (b.type === 'mine') {
                if (Math.random() < 0.02) {
                    this.particleSystem.spawn('sparkle', center.x, center.y - 20, 1);
                }
            }
        }
    }

    _getBuildingCenter(building) {
        const cx = building.position.tileX + building.width / 2;
        const cy = building.position.tileY + building.height / 2;
        return {
            x: (cx - cy) * TILE_WIDTH / 2,
            y: (cx + cy) * TILE_HEIGHT / 2,
        };
    }

    _spawnTorchParticles(building) {
        if (Math.random() > 0.15) return;
        const center = this._getBuildingCenter(building);
        const style = BUILDING_STYLES[building.type];
        if (!style) return;
        const halfW = building.width * TILE_WIDTH / 4;
        this.particleSystem.spawn('torch', center.x - halfW - 5, center.y - style.wallHeight + 10, 1);
        this.particleSystem.spawn('torch', center.x + halfW + 5, center.y - style.wallHeight + 10, 1);
    }

    _spawnSmokeParticles(building) {
        if (Math.random() > 0.08) return;
        const center = this._getBuildingCenter(building);
        this.particleSystem.spawn('smoke', center.x + 15, center.y - 55, 1);
    }

    drawShadows(ctx) {
        ctx.save();
        ctx.fillStyle = 'rgba(14, 9, 6, 0.36)';
        for (const b of this.buildings) {
            const center = this._getBuildingCenter(b);
            const style = BUILDING_STYLES[b.type];
            if (!style) continue;
            const halfW = b.width * TILE_WIDTH / 4;
            const halfH = b.height * TILE_HEIGHT / 4;
            ctx.beginPath();
            ctx.ellipse(center.x + 8, center.y + 6, halfW + 5, halfH + 3, 0.2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    draw(ctx) {
        for (const b of this.buildings) {
            this._drawBuilding(ctx, b);
        }
    }

    getLightSources() {
        const sources = [];
        for (const b of this.buildings) {
            const style = BUILDING_STYLES[b.type];
            if (!style) continue;
            const center = this._getBuildingCenter(b);
            const halfW = b.width * TILE_WIDTH / 4;
            sources.push(
                { x: center.x - halfW - 5, y: center.y - style.wallHeight + 10, radius: 58, color: 'rgba(255, 146, 47, 0.18)' },
                { x: center.x + halfW + 5, y: center.y - style.wallHeight + 10, radius: 58, color: 'rgba(255, 146, 47, 0.18)' },
            );
            if (style.windowGlow) {
                sources.push({ x: center.x, y: center.y - style.wallHeight / 2, radius: 70, color: 'rgba(255, 214, 116, 0.12)' });
            }
            if (b.type === 'forge') {
                sources.push({ x: center.x - halfW + 13, y: center.y - style.wallHeight / 2, radius: 82, color: 'rgba(255, 86, 30, 0.2)' });
            }
        }
        return sources;
    }

    _drawBuilding(ctx, building) {
        const style = BUILDING_STYLES[building.type];
        if (!style) return;
        const center = this._getBuildingCenter(building);
        const halfW = building.width * TILE_WIDTH / 4;
        const halfH = building.height * TILE_HEIGHT / 4;
        const alpha = this.roofAlpha.get(building) ?? 1;

        ctx.save();
        ctx.translate(center.x, center.y);

        // Foundation (isometric diamond)
        ctx.fillStyle = '#3f3122';
        ctx.beginPath();
        ctx.moveTo(0, -halfH);
        ctx.lineTo(halfW, 0);
        ctx.lineTo(0, halfH);
        ctx.lineTo(-halfW, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#241811';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        const wh = style.wallHeight;

        // === 1. Back wall (always visible - adds depth when agents enter) ===
        ctx.fillStyle = this._lighten(style.wallColor, -15);
        // Back wall left (top→left)
        ctx.beginPath();
        ctx.moveTo(-halfW, 0);
        ctx.lineTo(-halfW, -wh);
        ctx.lineTo(0, -wh - halfH);
        ctx.lineTo(0, -halfH);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(36, 24, 17, 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Back wall right (top→right)
        ctx.fillStyle = this._lighten(style.wallColor, -5);
        ctx.beginPath();
        ctx.moveTo(halfW, 0);
        ctx.lineTo(halfW, -wh);
        ctx.lineTo(0, -wh - halfH);
        ctx.lineTo(0, -halfH);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        this._drawWallTexture(ctx, halfW, halfH, wh, style, 'back');

        // === 2. Interior floor and furniture (visible when the roof opens) ===
        if (alpha < 0.95) {
            ctx.save();
            ctx.globalAlpha = 1 - alpha;
            this._drawInterior(ctx, building, halfW, halfH, style);
            ctx.restore();
        }

        // === 3. Front wall (fades out when agents approach) ===
        ctx.save();
        ctx.globalAlpha = alpha;
        // Front wall left (left→bottom)
        ctx.fillStyle = style.wallColor;
        ctx.beginPath();
        ctx.moveTo(-halfW, 0);
        ctx.lineTo(0, halfH);
        ctx.lineTo(0, halfH - wh);
        ctx.lineTo(-halfW, -wh);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(36, 24, 17, 0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Front wall right (bottom→right)
        ctx.fillStyle = this._lighten(style.wallColor, 20);
        ctx.beginPath();
        ctx.moveTo(0, halfH);
        ctx.lineTo(halfW, 0);
        ctx.lineTo(halfW, -wh);
        ctx.lineTo(0, halfH - wh);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        this._drawWallTexture(ctx, halfW, halfH, wh, style, 'front');

        // Front wall window
        this._drawFrontWindows(ctx, halfW, halfH, wh, style);
        ctx.restore();

        // === 4. Roof (fades out when agents approach) ===
        if (alpha > 0.05) {
            ctx.save();
            ctx.globalAlpha = alpha;
            if (style.customRoof === 'mine') {
                this._drawMineRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'taskboard') {
                this._drawTaskBoardRoof(ctx, halfW, halfH, style);
            } else if (style.hasRoundRoof) {
                this._drawRoundRoof(ctx, halfW, halfH, style);
            } else {
                this._drawTriangleRoof(ctx, halfW, halfH, style);
            }
            ctx.restore();
        }

        // Back wall window (always visible)
        this._drawWindows(ctx, halfW, style);

        // Building-specific decorations
        this._drawDecorations(ctx, building, halfW, halfH, style);

        // Torches on both sides
        this._drawTorch(ctx, -halfW - 5, -style.wallHeight + 10);
        this._drawTorch(ctx, halfW + 5, -style.wallHeight + 10);

        // Label
        const isHovered = this.hoveredBuilding === building;
        ctx.font = isHovered ? 'bold 8px "Press Start 2P", monospace' : '7px "Press Start 2P", monospace';
        ctx.textAlign = 'center';
        const labelW = ctx.measureText(building.label).width + 12;
        const labelY = halfH + 14;
        ctx.fillStyle = isHovered ? 'rgba(59, 42, 26, 0.95)' : 'rgba(40, 30, 22, 0.8)';
        ctx.strokeStyle = isHovered ? THEME.text : 'rgba(199, 157, 76, 0.45)';
        ctx.lineWidth = 1;
        ctx.fillRect(-labelW / 2, labelY - 8, labelW, 13);
        ctx.strokeRect(-labelW / 2 + 0.5, labelY - 7.5, labelW - 1, 12);
        ctx.fillStyle = isHovered ? THEME.text : '#b9a27f';
        ctx.fillText(building.label, 0, labelY + 1);

        ctx.restore();
    }

    _drawInterior(ctx, building, halfW, halfH, style) {
        // Interior floor (light tone)
        ctx.fillStyle = this._lighten(style.wallColor, 40);
        ctx.beginPath();
        ctx.moveTo(0, -halfH);
        ctx.lineTo(halfW - 2, 0);
        ctx.lineTo(0, halfH - 2);
        ctx.lineTo(-halfW + 2, 0);
        ctx.closePath();
        ctx.fill();

        // Floor grid pattern
        ctx.strokeStyle = this._lighten(style.wallColor, 25);
        ctx.lineWidth = 0.5;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(i * (halfW / 3), -halfH + Math.abs(i) * (halfH / 3));
            ctx.lineTo(i * (halfW / 3), halfH - Math.abs(i) * (halfH / 3));
            ctx.stroke();
        }

        // Interior furniture by building
        switch (building.type) {
            case 'command':
                // Center table
                ctx.fillStyle = '#6b4a2a';
                ctx.fillRect(-10, -4, 20, 8);
                // Monitor
                ctx.fillStyle = '#1a3a5a';
                ctx.fillRect(-7, -3, 6, 5);
                ctx.fillRect(1, -3, 6, 5);
                // Screen glow
                ctx.fillStyle = 'rgba(74, 158, 255, 0.6)';
                ctx.fillRect(-6, -2, 4, 3);
                ctx.fillRect(2, -2, 4, 3);
                break;
            case 'forge':
                // Furnace
                ctx.fillStyle = '#5a3a2a';
                ctx.fillRect(-8, -6, 8, 8);
                ctx.fillStyle = '#ff4400';
                ctx.fillRect(-7, -4, 6, 4);
                // Workbench
                ctx.fillStyle = '#7a5a3a';
                ctx.fillRect(2, -3, 10, 6);
                break;
            case 'mine':
                // Ore pile
                ctx.fillStyle = '#8a7a5a';
                ctx.beginPath();
                ctx.arc(-5, 0, 5, 0, Math.PI * 2);
                ctx.fill();
                // Sparkling ore
                ctx.fillStyle = '#ffd700';
                ctx.fillRect(-7, -2, 2, 2);
                ctx.fillStyle = '#00ffff';
                ctx.fillRect(-3, 1, 2, 2);
                // Rails
                ctx.strokeStyle = '#888';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(3, -halfH + 5);
                ctx.lineTo(3, halfH - 5);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(7, -halfH + 5);
                ctx.lineTo(7, halfH - 5);
                ctx.stroke();
                break;
            case 'taskboard':
                // Kanban board
                ctx.fillStyle = '#eee';
                ctx.fillRect(-10, -6, 20, 10);
                ctx.strokeStyle = '#999';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(-10, -6, 20, 10);
                // Column divider
                ctx.beginPath();
                ctx.moveTo(-3, -6);
                ctx.lineTo(-3, 4);
                ctx.moveTo(4, -6);
                ctx.lineTo(4, 4);
                ctx.stroke();
                // Sticky notes
                ctx.fillStyle = '#ff6b6b';
                ctx.fillRect(-8, -4, 4, 3);
                ctx.fillStyle = '#ffd43b';
                ctx.fillRect(-1, -3, 4, 3);
                ctx.fillStyle = '#51cf66';
                ctx.fillRect(5, -4, 4, 3);
                break;
            case 'chathall':
                // Round table
                ctx.fillStyle = '#6b5a4a';
                ctx.beginPath();
                ctx.ellipse(0, 0, 8, 5, 0, 0, Math.PI * 2);
                ctx.fill();
                // Chairs
                ctx.fillStyle = '#8b6a4a';
                ctx.beginPath();
                ctx.arc(-10, -2, 3, 0, Math.PI * 2);
                ctx.arc(10, -2, 3, 0, Math.PI * 2);
                ctx.arc(0, 6, 3, 0, Math.PI * 2);
                ctx.arc(0, -7, 3, 0, Math.PI * 2);
                ctx.fill();
                break;
        }
    }

    _drawTriangleRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const ov = 5; // Eave overhang
        const peakY = -wh - halfH - 12; // Roof peak

        // Eave vertices (top wall diamond plus overhang)
        const left  = { x: -halfW - ov, y: -wh };
        const back  = { x: 0,           y: -halfH - wh - ov };
        const right = { x:  halfW + ov, y: -wh };
        const front = { x: 0,           y:  halfH - wh + ov };

        // 1) Back side left (darkest, drawn first because it is behind)
        ctx.fillStyle = this._lighten(style.roofColor, -15);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(back.x, back.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        // 2) Back side right
        ctx.fillStyle = this._lighten(style.roofColor, -5);
        ctx.beginPath();
        ctx.moveTo(back.x, back.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        // 3) Front side left (visible to the viewer)
        ctx.fillStyle = style.roofColor;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(front.x, front.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        // 4) Front side right (brightest, most visible side)
        ctx.fillStyle = this._lighten(style.roofColor, 20);
        ctx.beginPath();
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        // Roof ridge line
        ctx.strokeStyle = this._lighten(style.roofColor, -25);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(0, peakY);
        ctx.lineTo(right.x, right.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(0, peakY);
        ctx.stroke();

        this._drawRoofShingles(ctx, left, right, front, peakY, style);
    }

    _drawRoundRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const ov = 5;

        // Roof support (top wall diamond plus overhang)
        ctx.fillStyle = this._lighten(style.roofColor, -15);
        ctx.beginPath();
        ctx.moveTo(-halfW - ov, -wh);
        ctx.lineTo(0, -halfH - wh - ov);
        ctx.lineTo(halfW + ov, -wh);
        ctx.lineTo(0, halfH - wh + ov);
        ctx.closePath();
        ctx.fill();

        // Dome body
        ctx.fillStyle = style.roofColor;
        ctx.beginPath();
        ctx.ellipse(0, -wh, halfW + ov, halfH + 14, 0, Math.PI, 0);
        ctx.fill();

        // Dome highlight
        ctx.fillStyle = this._lighten(style.roofColor, 20);
        ctx.beginPath();
        ctx.ellipse(0, -wh, halfW * 0.65, halfH + 6, 0, Math.PI, 0);
        ctx.fill();

        ctx.strokeStyle = 'rgba(240, 235, 206, 0.18)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.ellipse(0, -wh + i * 5, halfW + ov - i * 7, halfH + 10 - i * 4, 0, Math.PI, 0);
            ctx.stroke();
        }
    }

    _drawMineRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const crownY = -wh - halfH - 8;

        // Craggy earth berm instead of a tidy roof.
        ctx.fillStyle = this._lighten(style.roofColor, -18);
        ctx.beginPath();
        ctx.moveTo(-halfW - 7, -wh + 1);
        ctx.lineTo(-halfW * 0.6, crownY + 4);
        ctx.lineTo(-halfW * 0.25, crownY - 5);
        ctx.lineTo(0, crownY + 1);
        ctx.lineTo(halfW * 0.35, crownY - 7);
        ctx.lineTo(halfW * 0.72, crownY + 4);
        ctx.lineTo(halfW + 7, -wh + 1);
        ctx.lineTo(0, halfH - wh + 6);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, 9);
        ctx.beginPath();
        ctx.moveTo(-halfW - 3, -wh + 2);
        ctx.lineTo(-halfW * 0.25, crownY + 2);
        ctx.lineTo(0, halfH - wh + 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = this._lighten(style.roofColor, 18);
        ctx.beginPath();
        ctx.moveTo(halfW + 3, -wh + 2);
        ctx.lineTo(halfW * 0.35, crownY - 4);
        ctx.lineTo(0, halfH - wh + 5);
        ctx.closePath();
        ctx.fill();

        // Timber braces mark it clearly as a mine adit.
        ctx.strokeStyle = '#8c6a42';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.42, -wh + 7);
        ctx.lineTo(-halfW * 0.24, crownY + 2);
        ctx.lineTo(halfW * 0.24, crownY + 2);
        ctx.lineTo(halfW * 0.42, -wh + 7);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.3, -wh + 4);
        ctx.lineTo(halfW * 0.3, -wh + 4);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(35, 23, 17, 0.38)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
            const x = -halfW + 8 + i * (halfW / 2.2);
            ctx.beginPath();
            ctx.moveTo(x, -wh + 2);
            ctx.lineTo(x + 8, -wh - 7 - (i % 2) * 3);
            ctx.stroke();
        }
    }

    _drawTaskBoardRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const capY = -wh - halfH - 6;

        // Open guild notice pavilion: lintel, banner, and sign cap.
        ctx.fillStyle = this._lighten(style.roofColor, -12);
        ctx.beginPath();
        ctx.moveTo(-halfW - 8, -wh - 1);
        ctx.lineTo(0, capY);
        ctx.lineTo(halfW + 8, -wh - 1);
        ctx.lineTo(0, -wh + 13);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, 14);
        ctx.beginPath();
        ctx.moveTo(-halfW - 4, -wh + 1);
        ctx.lineTo(0, -wh + 13);
        ctx.lineTo(halfW + 4, -wh + 1);
        ctx.lineTo(0, -wh + 7);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = style.trimColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-halfW - 7, -wh);
        ctx.lineTo(0, capY);
        ctx.lineTo(halfW + 7, -wh);
        ctx.stroke();

        ctx.fillStyle = '#e8d7a6';
        ctx.fillRect(-17, -wh - 9, 34, 9);
        ctx.strokeStyle = '#3d2a19';
        ctx.lineWidth = 1;
        ctx.strokeRect(-17.5, -wh - 9.5, 35, 10);
        ctx.fillStyle = '#3d2a19';
        ctx.fillRect(-11, -wh - 6, 22, 2);
        ctx.fillRect(-8, -wh - 2, 16, 1.5);
    }

    _drawFrontWindows(ctx, halfW, halfH, wh, style) {
        const glow = style.windowGlow ? 'rgba(255, 200, 50, 0.7)' : 'rgba(100, 150, 200, 0.5)';
        ctx.fillStyle = style.trimColor;
        ctx.fillRect(-halfW / 2 - 4, -wh / 2 - 3, 7, 7);
        ctx.fillRect(halfW / 2 - 4, -wh / 2 - 3, 7, 7);
        ctx.fillStyle = glow;
        // Front wall left window
        const lx = -halfW / 2;
        const ly = -wh / 2;
        ctx.fillRect(lx - 3, ly - 2, 5, 5);
        // Front wall right window
        const rx = halfW / 2;
        ctx.fillRect(rx - 3, ly - 2, 5, 5);
        // Door (Front wall bottom center)
        ctx.fillStyle = style.trimColor;
        ctx.fillRect(-5, halfH - wh / 3 - 4, 10, wh / 3 + 3);
        ctx.fillStyle = this._lighten(style.wallColor, -20);
        ctx.fillRect(-3, halfH - wh / 3 - 2, 6, wh / 3);
        ctx.fillStyle = '#f2d36b';
        ctx.fillRect(1, halfH - wh / 5, 1.5, 1.5); // Door handle
    }

    _drawWindows(ctx, halfW, style) {
        const windowY = -style.wallHeight / 2 - 2;
        // Left wall windows
        ctx.fillStyle = style.trimColor;
        ctx.fillRect(-halfW + 5, windowY - 5, 7, 8);
        ctx.fillRect(-halfW + 15, windowY - 5, 7, 8);
        ctx.fillRect(halfW - 12, windowY - 5, 7, 8);
        ctx.fillStyle = style.windowGlow ? 'rgba(255, 204, 83, 0.72)' : 'rgba(127, 186, 213, 0.55)';
        ctx.fillRect(-halfW + 6, windowY - 4, 5, 6);
        ctx.fillRect(-halfW + 16, windowY - 4, 5, 6);
        // Right wall windows
        ctx.fillRect(halfW - 11, windowY - 4, 5, 6);
        if (style.windowGlow) {
            ctx.fillStyle = 'rgba(255, 200, 50, 0.15)';
            ctx.beginPath();
            ctx.arc(-halfW + 8, windowY, 8, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawDecorations(ctx, building, halfW, halfH, style) {
        switch (building.type) {
            case 'command':
                // Antenna
                ctx.strokeStyle = '#888';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(0, -style.wallHeight - halfH - 12);
                ctx.lineTo(0, -style.wallHeight - halfH - 28);
                ctx.stroke();
                ctx.fillStyle = '#ff0000';
                ctx.beginPath();
                ctx.arc(0, -style.wallHeight - halfH - 28, 2, 0, Math.PI * 2);
                ctx.fill();
                // Flag
                ctx.fillStyle = style.accentColor;
                ctx.beginPath();
                ctx.moveTo(halfW + 8, -style.wallHeight - 5);
                ctx.lineTo(halfW + 8, -style.wallHeight - 20);
                ctx.lineTo(halfW + 18, -style.wallHeight - 15);
                ctx.lineTo(halfW + 8, -style.wallHeight - 10);
                ctx.fill();
                ctx.strokeStyle = '#382116';
                ctx.lineWidth = 1;
                ctx.stroke();
                break;
            case 'forge':
                this._drawForgeDecorations(ctx, halfW, halfH, style);
                break;
            case 'mine':
                this._drawMineDecorations(ctx, halfW, halfH, style);
                break;
            case 'taskboard':
                this._drawTaskBoardDecorations(ctx, halfW, halfH, style);
                break;
            case 'chathall':
                // Speech bubble decoration
                ctx.fillStyle = 'rgba(241, 231, 205, 0.9)';
                ctx.beginPath();
                ctx.ellipse(halfW - 5, -style.wallHeight - 8, 8, 6, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#2b2a30';
                ctx.font = '6px "Press Start 2P", monospace';
                ctx.textAlign = 'center';
                ctx.fillText('...', halfW - 5, -style.wallHeight - 6);
                break;
        }
    }

    _drawForgeDecorations(ctx, halfW, halfH, style) {
        // Heavy chimney and glowing firebox make this read as a working forge.
        ctx.fillStyle = '#37302c';
        ctx.fillRect(12, -style.wallHeight - halfH - 20, 8, 18);
        ctx.fillStyle = '#4b423b';
        ctx.fillRect(10, -style.wallHeight - halfH - 22, 12, 3);
        ctx.strokeStyle = '#211814';
        ctx.lineWidth = 1;
        ctx.strokeRect(12.5, -style.wallHeight - halfH - 19.5, 7, 17);

        ctx.fillStyle = '#1d1410';
        ctx.fillRect(-halfW + 5, -style.wallHeight / 2 - 8, 16, 14);
        ctx.fillStyle = '#ff5a1f';
        ctx.fillRect(-halfW + 8, -style.wallHeight / 2 - 5, 10, 8);
        ctx.fillStyle = '#ffd27a';
        ctx.fillRect(-halfW + 11, -style.wallHeight / 2 - 3, 4, 4);
        ctx.fillStyle = 'rgba(255, 108, 36, 0.22)';
        ctx.beginPath();
        ctx.arc(-halfW + 13, -style.wallHeight / 2 - 1, 14, 0, Math.PI * 2);
        ctx.fill();

        // Anvil and hammer at the front edge.
        ctx.fillStyle = '#4d5358';
        ctx.fillRect(-8, -2, 10, 4);
        ctx.fillRect(-11, -5, 16, 3);
        ctx.fillRect(-4, 2, 4, 5);
        ctx.strokeStyle = '#9b6a36';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(8, -5);
        ctx.lineTo(17, 4);
        ctx.stroke();
        ctx.fillStyle = '#6c7175';
        ctx.fillRect(5, -8, 9, 3);
    }

    _drawMineDecorations(ctx, halfW, halfH, style) {
        // Mine entrance
        ctx.fillStyle = '#21150f';
        ctx.beginPath();
        ctx.arc(0, 0, 14, Math.PI, 0);
        ctx.fill();
        ctx.fillStyle = '#0f0905';
        ctx.fillRect(-12, -4, 24, 8);
        ctx.strokeStyle = '#8c6a42';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 16, Math.PI, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-13, 1);
        ctx.lineTo(-13, -10);
        ctx.moveTo(13, 1);
        ctx.lineTo(13, -10);
        ctx.stroke();

        // Rails and mine cart.
        ctx.strokeStyle = '#6d6258';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-8, 4);
        ctx.lineTo(-16, halfH - 2);
        ctx.moveTo(8, 4);
        ctx.lineTo(16, halfH - 2);
        ctx.stroke();
        ctx.fillStyle = '#3a302a';
        ctx.fillRect(-halfW + 8, 3, 14, 7);
        ctx.fillStyle = '#795f3f';
        ctx.fillRect(-halfW + 10, 1, 10, 4);
        ctx.fillStyle = '#1a1512';
        ctx.fillRect(-halfW + 10, 10, 3, 2);
        ctx.fillRect(-halfW + 17, 10, 3, 2);

        // Pickaxe
        ctx.strokeStyle = '#8b4513';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(halfW - 8, -6);
        ctx.lineTo(halfW + 6, -20);
        ctx.stroke();
        ctx.strokeStyle = '#9ca0a0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(halfW + 1, -20);
        ctx.quadraticCurveTo(halfW + 8, -24, halfW + 11, -17);
        ctx.moveTo(halfW + 1, -20);
        ctx.quadraticCurveTo(halfW - 4, -22, halfW - 7, -16);
        ctx.stroke();

        // Gem sparkles
        if (Math.sin(this.torchFrame * 3) > 0.5) {
            ctx.fillStyle = '#00ffff';
            ctx.fillRect(-6, -1, 2, 2);
            ctx.fillStyle = '#ff00ff';
            ctx.fillRect(3, -2, 2, 2);
            ctx.fillStyle = '#ffd95c';
            ctx.fillRect(-halfW + 14, 0, 2, 2);
        }
    }

    _drawTaskBoardDecorations(ctx, halfW, halfH, style) {
        // Freestanding guild board framed with posts and parchment notices.
        ctx.fillStyle = '#3a2718';
        ctx.fillRect(-halfW + 5, -style.wallHeight + 6, 5, style.wallHeight + 8);
        ctx.fillRect(halfW - 10, -style.wallHeight + 6, 5, style.wallHeight + 8);
        ctx.fillStyle = '#6f4d2b';
        ctx.fillRect(-halfW + 1, -style.wallHeight / 2 - 12, halfW * 2 - 2, 25);
        ctx.strokeStyle = '#2a1b10';
        ctx.lineWidth = 2;
        ctx.strokeRect(-halfW + 1.5, -style.wallHeight / 2 - 11.5, halfW * 2 - 3, 24);

        const noticeColors = ['#ead89c', '#d8ecff', '#f2a79d', '#bfe7a5', '#e5c0ef', '#f4cf6a'];
        for (let i = 0; i < noticeColors.length; i++) {
            ctx.fillStyle = noticeColors[i];
            const px = -halfW + 6 + (i % 3) * 13;
            const py = -style.wallHeight / 2 - 8 + Math.floor(i / 3) * 10;
            ctx.fillRect(px, py, 9, 7);
            ctx.fillStyle = 'rgba(41, 30, 22, 0.5)';
            ctx.fillRect(px + 2, py + 2, 5, 1);
            ctx.fillRect(px + 2, py + 5, 4, 1);
        }

        ctx.fillStyle = style.accentColor;
        ctx.beginPath();
        ctx.moveTo(halfW - 6, -style.wallHeight + 4);
        ctx.lineTo(halfW - 6, -style.wallHeight - 12);
        ctx.lineTo(halfW + 5, -style.wallHeight - 8);
        ctx.lineTo(halfW - 6, -style.wallHeight - 4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#2a1b10';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    _drawTorch(ctx, x, y) {
        // Torch pole
        ctx.fillStyle = '#6d3e1e';
        ctx.fillRect(x - 1, y, 2, 10);
        // Flame
        const flicker = Math.sin(this.torchFrame * 6 + x) * 2;
        ctx.fillStyle = '#ff7a1a';
        ctx.beginPath();
        ctx.ellipse(x, y - 2, 3, 5 + flicker, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffe28a';
        ctx.beginPath();
        ctx.ellipse(x, y - 1, 1.5, 3 + flicker * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        // Glow
        ctx.fillStyle = 'rgba(255, 151, 56, 0.13)';
        ctx.beginPath();
        ctx.arc(x, y, 15, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawWallTexture(ctx, halfW, halfH, wh, style, side) {
        ctx.save();
        ctx.strokeStyle = 'rgba(35, 23, 17, 0.34)';
        ctx.lineWidth = 1;

        const yTop = -wh + 7;
        const yBottom = halfH - 8;
        for (let i = 0; i < 3; i++) {
            const y = yTop + i * (wh / 4);
            ctx.beginPath();
            ctx.moveTo(-halfW + 4, y);
            ctx.lineTo(0, y + halfH * 0.45);
            ctx.lineTo(halfW - 4, y);
            ctx.stroke();
        }

        ctx.strokeStyle = style.trimColor;
        ctx.lineWidth = 2;
        if (side === 'front') {
            ctx.beginPath();
            ctx.moveTo(-halfW + 2, -wh + 3);
            ctx.lineTo(-halfW + 2, -2);
            ctx.moveTo(halfW - 2, -wh + 3);
            ctx.lineTo(halfW - 2, -2);
            ctx.moveTo(-halfW * 0.45, -wh + 5);
            ctx.lineTo(-halfW * 0.45, yBottom);
            ctx.moveTo(halfW * 0.45, -wh + 5);
            ctx.lineTo(halfW * 0.45, yBottom);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawRoofShingles(ctx, left, right, front, peakY, style) {
        ctx.save();
        ctx.strokeStyle = 'rgba(43, 27, 21, 0.28)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            const t = i / 4;
            ctx.beginPath();
            ctx.moveTo(left.x * (1 - t), left.y * (1 - t) + peakY * t);
            ctx.lineTo(front.x * (1 - t), front.y * (1 - t) + peakY * t);
            ctx.lineTo(right.x * (1 - t), right.y * (1 - t) + peakY * t);
            ctx.stroke();
        }
        ctx.strokeStyle = this._lighten(style.roofColor, 28);
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        ctx.moveTo(front.x - 6, front.y - 2);
        ctx.lineTo(0, peakY + 4);
        ctx.stroke();
        ctx.restore();
    }

    _lighten(hex, amount) {
        const num = parseInt(hex.replace('#', ''), 16);
        const clamp = v => Math.max(0, Math.min(255, v));
        const r = clamp((num >> 16) + amount);
        const g = clamp(((num >> 8) & 0xff) + amount);
        const b = clamp((num & 0xff) + amount);
        return `rgb(${r},${g},${b})`;
    }

    drawBubbles(ctx, world) {
        for (const b of this.buildings) {
            const agentsInBuilding = [];
            for (const agent of world.agents.values()) {
                if (b.containsPoint(agent.position.tileX, agent.position.tileY)) {
                    agentsInBuilding.push(agent);
                }
            }
            if (agentsInBuilding.length > 0) {
                const center = this._getBuildingCenter(b);
                const style = BUILDING_STYLES[b.type];
                if (!style) continue;
                const text = `${agentsInBuilding.length} agent${agentsInBuilding.length > 1 ? 's' : ''}`;
                ctx.save();
                ctx.font = '7px sans-serif';
                const tw = ctx.measureText(text).width + 8;
                const bx = center.x;
                const by = center.y - style.wallHeight - 30;
                ctx.fillStyle = 'rgba(48, 31, 19, 0.94)';
                ctx.strokeStyle = '#d7b979';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(bx - tw / 2, by - 7);
                ctx.lineTo(bx + tw / 2, by - 7);
                ctx.lineTo(bx + tw / 2 + 4, by - 3);
                ctx.lineTo(bx + tw / 2 + 4, by + 5);
                ctx.lineTo(bx + 4, by + 5);
                ctx.lineTo(bx, by + 10);
                ctx.lineTo(bx - 4, by + 5);
                ctx.lineTo(bx - tw / 2 - 4, by + 5);
                ctx.lineTo(bx - tw / 2 - 4, by - 3);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#f3e2bd';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(text, bx, by);
                ctx.restore();
            }
        }
    }

    hitTest(screenX, screenY) {
        for (const b of this.buildings) {
            const center = this._getBuildingCenter(b);
            const style = BUILDING_STYLES[b.type];
            if (!style) continue;
            const halfW = b.width * TILE_WIDTH / 4;
            if (Math.abs(screenX - center.x) < halfW && screenY > center.y - style.wallHeight - 20 && screenY < center.y + 10) {
                return b;
            }
        }
        return null;
    }
}
