import { TILE_WIDTH, TILE_HEIGHT } from '../../config/constants.js';
import { THEME } from '../../config/theme.js';

const BUILDING_STYLES = {
    command: {
        wallColor: '#4a3726',
        roofColor: '#a12525',
        accentColor: '#ffd86f',
        trimColor: '#251810',
        coreColor: '#86defd',
        bannerColor: '#ffd56d',
        wallHeight: 60,
        customRoof: 'command',
        hasAntenna: true,
        hasFlag: true,
        windowGlow: true,
    },
    forge: {
        wallColor: '#6a4630',
        roofColor: '#2f3032',
        accentColor: '#ff8a2a',
        trimColor: '#211611',
        wallHeight: 50,
        customRoof: 'forge',
        hasChimney: true,
        hasAnvil: true,
    },
    mine: {
        wallColor: '#463a32',
        roofColor: '#5b4a37',
        accentColor: '#f5c85b',
        trimColor: '#241811',
        wallHeight: 44,
        customRoof: 'mine',
        hasMineEntrance: true,
        hasPickaxe: true,
        hasGems: true,
    },
    taskboard: {
        wallColor: '#6a4f34',
        roofColor: '#4f7f83',
        accentColor: '#f2d36b',
        trimColor: '#2a1d14',
        wallHeight: 38,
        customRoof: 'taskboard',
        hasPostits: true,
    },
    chathall: {
        wallColor: '#745031',
        roofColor: '#86683a',
        accentColor: '#e4b85c',
        trimColor: '#2f2118',
        wallHeight: 42,
        customRoof: 'chathall',
        hasBubble: true,
        windowGlow: true,
    },
    observatory: {
        wallColor: '#4a382b',
        roofColor: '#241b17',
        accentColor: '#c9903f',
        trimColor: '#2b1c14',
        wallHeight: 52,
        customRoof: 'observatory',
        windowGlow: true,
    },
    archive: {
        wallColor: '#5d432b',
        roofColor: '#2e2119',
        accentColor: '#d8b96d',
        trimColor: '#2a1a12',
        wallHeight: 46,
        customRoof: 'archive',
        windowGlow: true,
    },
    portal: {
        wallColor: '#3d3f52',
        roofColor: '#1b2034',
        accentColor: '#76d8ff',
        trimColor: '#171625',
        wallHeight: 54,
        customRoof: 'portal',
        windowGlow: true,
    },
    alchemy: {
        wallColor: '#4f3151',
        roofColor: '#613f73',
        accentColor: '#c9f26b',
        trimColor: '#24152b',
        wallHeight: 43,
        customRoof: 'alchemy',
        windowGlow: true,
    },
    sanctuary: {
        wallColor: '#4f5e3c',
        roofColor: '#6d7441',
        accentColor: '#f2d36b',
        trimColor: '#25311e',
        wallHeight: 36,
        customRoof: 'sanctuary',
        windowGlow: true,
    },
    watchtower: {
        wallColor: '#d8d0bd',
        roofColor: '#9f2f2c',
        accentColor: '#ffd36a',
        trimColor: '#1e2830',
        wallHeight: 72,
        customRoof: 'watchtower',
        windowGlow: true,
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
        this.motionScale = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ? 0 : 1;
    }

    setMotionScale(scale) {
        this.motionScale = scale;
    }

    setBuildings(buildings) {
        this.buildings = Array.from(buildings.values());
    }

    setAgentSprites(sprites) {
        this.agentSprites = sprites;
    }

    update() {
        this.torchFrame += 0.08 * (this.motionScale || 0);

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

            this._spawnThemeParticles(b, center, style, halfW);
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
        this.particleSystem.spawn('smoke', center.x + 20, center.y - 82, 1);
        if (Math.random() < 0.35) {
            this.particleSystem.spawn('torch', center.x - 24, center.y - 25, 1);
        }
    }

    _spawnThemeParticles(building, center, style, halfW) {
        if (!this.motionScale) return;
        switch (building.type) {
            case 'command':
                if (Math.random() < 0.055) {
                    this.particleSystem.spawn('sparkle', center.x, center.y - style.wallHeight - 48, 1);
                }
                if (Math.random() < 0.022) {
                    this.particleSystem.spawn('sparkle', center.x + (Math.random() - 0.5) * 22, center.y - style.wallHeight - 36, 1);
                }
                if (Math.random() < 0.018) {
                    this.particleSystem.spawn('sparkle', center.x + (Math.random() - 0.5) * 26, center.y - style.wallHeight - 26, 1);
                }
                break;
            case 'forge':
                this._spawnSmokeParticles(building);
                if (Math.random() < 0.13) {
                    this.particleSystem.spawn('mining', center.x - halfW + 18, center.y - style.wallHeight / 2 - 8, 1);
                }
                break;
            case 'mine':
                if (Math.random() < 0.045) {
                    this.particleSystem.spawn('sparkle', center.x - 14 + Math.random() * 28, center.y - 20 - Math.random() * 22, 1);
                }
                if (Math.random() < 0.025) {
                    this.particleSystem.spawn('mining', center.x - 16, center.y + 7, 1);
                }
                break;
            case 'taskboard':
                if (Math.random() < 0.02) {
                    this.particleSystem.spawn('sparkle', center.x, center.y - style.wallHeight - 7, 1);
                }
                break;
            case 'chathall':
                if (Math.random() < 0.035) {
                    this.particleSystem.spawn('sparkle', center.x - halfW * 0.35 + Math.random() * halfW * 0.7, center.y - style.wallHeight - 8, 1);
                }
                break;
            case 'observatory':
                if (Math.random() < 0.04) {
                    this.particleSystem.spawn('sparkle', center.x + 4, center.y - style.wallHeight - 48, 1);
                }
                break;
            case 'portal':
                if (Math.random() < 0.05) {
                    this.particleSystem.spawn('sparkle', center.x, center.y - style.wallHeight - 18, 1);
                }
                break;
            case 'alchemy':
                if (Math.random() < 0.045) {
                    this.particleSystem.spawn('sparkle', center.x - halfW * 0.25 + Math.random() * halfW * 0.5, center.y - style.wallHeight - 5, 1);
                }
                break;
            case 'watchtower':
                if (Math.random() < 0.03) {
                    this.particleSystem.spawn('sparkle', center.x, center.y - style.wallHeight - 40, 1);
                }
                break;
        }
    }

    drawShadows(ctx) {
        ctx.save();
        for (const b of this.buildings) {
            const center = this._getBuildingCenter(b);
            const style = BUILDING_STYLES[b.type];
            if (!style) continue;
            const halfW = b.width * TILE_WIDTH / 4;
            const halfH = b.height * TILE_HEIGHT / 4;

            const landmarkBoost = ['command', 'forge', 'portal', 'observatory', 'sanctuary'].includes(b.type) ? 1 : 0;
            const wallWeight = Math.min(1, style.wallHeight / 72);
            const castAlpha = 0.18 + wallWeight * 0.16 + landmarkBoost * 0.04;
            const contactAlpha = 0.32 + wallWeight * 0.2 + landmarkBoost * 0.05;

            ctx.fillStyle = `rgba(12, 8, 6, ${castAlpha})`;
            ctx.beginPath();
            ctx.ellipse(center.x + 18 + landmarkBoost * 6, center.y + 14, halfW + 20 + landmarkBoost * 8, halfH + 9, 0.18, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = `rgba(8, 5, 4, ${contactAlpha})`;
            ctx.beginPath();
            ctx.ellipse(center.x + 3, center.y + 5, halfW + 8, halfH + 4, 0.06, 0, Math.PI * 2);
            ctx.fill();

            const anchor = ctx.createRadialGradient(center.x, center.y + 2, 4, center.x, center.y + 5, halfW + halfH + 12);
            anchor.addColorStop(0, `rgba(5, 3, 2, ${0.18 + landmarkBoost * 0.04})`);
            anchor.addColorStop(0.58, 'rgba(7, 4, 3, 0.08)');
            anchor.addColorStop(1, 'rgba(7, 4, 3, 0)');
            ctx.fillStyle = anchor;
            ctx.beginPath();
            ctx.ellipse(center.x, center.y + 4, halfW + 14, halfH + 8, 0, 0, Math.PI * 2);
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
            const halfH = b.height * TILE_HEIGHT / 4;
            switch (b.type) {
            case 'command':
                sources.push(
                    { x: center.x, y: center.y - style.wallHeight - halfH - 42, radius: 102, color: 'rgba(255, 219, 118, 0.24)' },
                    { x: center.x - 16, y: center.y - style.wallHeight - halfH - 24, radius: 58, color: 'rgba(140, 230, 255, 0.16)' },
                    { x: center.x + 14, y: center.y - style.wallHeight + 4, radius: 72, color: 'rgba(255, 214, 116, 0.12)' },
                );
                break;
                case 'forge':
                    sources.push(
                        { x: center.x - halfW + 15, y: center.y - style.wallHeight / 2 - 2, radius: 104, color: 'rgba(255, 86, 30, 0.24)' },
                        { x: center.x - 2, y: center.y - style.wallHeight - halfW * 0.12, radius: 70, color: 'rgba(255, 143, 45, 0.16)' },
                    );
                    break;
                case 'mine':
                    sources.push(
                        { x: center.x, y: center.y - 7, radius: 60, color: 'rgba(245, 200, 91, 0.16)' },
                        { x: center.x + halfW - 16, y: center.y - 10, radius: 44, color: 'rgba(95, 218, 255, 0.11)' },
                    );
                    break;
                case 'taskboard':
                    sources.push({ x: center.x, y: center.y - style.wallHeight + 12, radius: 72, color: 'rgba(242, 211, 107, 0.17)' });
                    break;
                case 'chathall':
                    sources.push(
                        { x: center.x, y: center.y - style.wallHeight / 2, radius: 88, color: 'rgba(255, 183, 77, 0.16)' },
                        { x: center.x - halfW + 12, y: center.y - style.wallHeight - 6, radius: 48, color: 'rgba(241, 231, 205, 0.1)' },
                    );
                    break;
                case 'observatory':
                    sources.push(
                        { x: center.x + 4, y: center.y - style.wallHeight - halfH - 42, radius: 92, color: 'rgba(255, 191, 90, 0.2)' },
                        { x: center.x, y: center.y - style.wallHeight / 2, radius: 70, color: 'rgba(201, 144, 63, 0.13)' },
                    );
                    break;
                case 'archive':
                    sources.push(
                        { x: center.x, y: center.y - style.wallHeight / 2, radius: 76, color: 'rgba(216, 185, 109, 0.14)' },
                        { x: center.x - halfW + 12, y: center.y - style.wallHeight + 8, radius: 42, color: 'rgba(255, 226, 154, 0.14)' },
                    );
                    break;
                case 'portal':
                    sources.push(
                        { x: center.x, y: center.y - style.wallHeight - 8, radius: 98, color: 'rgba(118, 216, 255, 0.2)' },
                        { x: center.x, y: center.y - style.wallHeight + 5, radius: 62, color: 'rgba(154, 111, 255, 0.12)' },
                    );
                    break;
                case 'alchemy':
                    sources.push(
                        { x: center.x, y: center.y - style.wallHeight - halfH - 18, radius: 78, color: 'rgba(201, 242, 107, 0.16)' },
                        { x: center.x + halfW - 12, y: center.y - style.wallHeight / 2, radius: 48, color: 'rgba(234, 126, 255, 0.12)' },
                    );
                    break;
                case 'sanctuary':
                    sources.push({ x: center.x, y: center.y - style.wallHeight / 2, radius: 76, color: 'rgba(242, 211, 107, 0.12)' });
                    break;
                case 'watchtower':
                    sources.push(
                        { x: center.x, y: center.y - style.wallHeight - halfH - 24, radius: 124, color: 'rgba(255, 211, 106, 0.2)' },
                        { x: center.x, y: center.y - style.wallHeight / 2, radius: 58, color: 'rgba(255, 211, 106, 0.08)' },
                    );
                    break;
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

        this._drawBuildingGroundStory(ctx, building, halfW, halfH, style);

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
        this._drawFoundationMaterial(ctx, halfW, halfH, style);

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
        this._drawEaveAmbientOcclusion(ctx, halfW, halfH, wh, style);
        ctx.restore();

        // === 4. Roof (fades out when agents approach) ===
        if (alpha > 0.05) {
            ctx.save();
            ctx.globalAlpha = alpha;
            if (style.customRoof === 'mine') {
                this._drawMineRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'taskboard') {
                this._drawTaskBoardRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'forge') {
                this._drawForgeRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'chathall') {
                this._drawChatHallRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'command') {
                this._drawCommandRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'observatory') {
                this._drawObservatoryRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'archive') {
                this._drawArchiveRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'portal') {
                this._drawPortalRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'alchemy') {
                this._drawAlchemyRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'sanctuary') {
                this._drawSanctuaryRoof(ctx, halfW, halfH, style);
            } else if (style.customRoof === 'watchtower') {
                this._drawWatchtowerRoof(ctx, halfW, halfH, style);
            } else if (style.hasRoundRoof) {
                this._drawRoundRoof(ctx, halfW, halfH, style);
            } else {
                this._drawTriangleRoof(ctx, halfW, halfH, style);
            }
            this._drawRoofEdgeHighlights(ctx, building.type, halfW, halfH, style);
            ctx.restore();
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        // Windows, shell-mounted decorations, and roof activity fade with the shell.
        this._drawWindows(ctx, halfW, style);
        this._drawDecorations(ctx, building, halfW, halfH, style);
        this._drawBuildingLightProps(ctx, building, halfW, halfH, style);
        this._drawAnimatedBuildingLayer(ctx, building, halfW, halfH, style);
        this._drawExteriorSetDressing(ctx, building, halfW, halfH, style);
        ctx.restore();

        this._drawOpenSilhouetteAnchors(ctx, building, halfW, halfH, style, alpha);

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

    _drawExteriorSetDressing(ctx, building, halfW, halfH, style) {
        const wh = style.wallHeight;
        switch (building.type) {
            case 'forge':
                ctx.fillStyle = '#211611';
                ctx.fillRect(-halfW - 18, halfH - wh + 4, 28, 9);
                ctx.fillStyle = '#5e666b';
                ctx.fillRect(-halfW - 13, halfH - wh + 1, 18, 5);
                ctx.fillStyle = '#ff8a2a';
                ctx.fillRect(-halfW - 5, halfH - wh - 3, 5, 4);
                break;
            case 'mine':
                ctx.strokeStyle = '#2a1c14';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(-halfW + 4, halfH - wh + 6);
                ctx.lineTo(-halfW - 26, halfH - wh + 23);
                ctx.moveTo(-halfW + 13, halfH - wh + 10);
                ctx.lineTo(-halfW - 17, halfH - wh + 27);
                ctx.stroke();
                ctx.fillStyle = '#f5c85b';
                ctx.fillRect(-halfW - 21, halfH - wh + 16, 3, 3);
                break;
            case 'chathall':
                ctx.fillStyle = '#6b4225';
                ctx.fillRect(halfW + 2, halfH - wh - 11, 9, 14);
                ctx.fillStyle = '#d8b96d';
                ctx.fillRect(halfW + 4, halfH - wh - 7, 5, 2);
                ctx.fillStyle = '#a23b2a';
                ctx.beginPath();
                ctx.moveTo(-halfW - 8, halfH - wh - 18);
                ctx.lineTo(-halfW + 20, halfH - wh - 24);
                ctx.lineTo(-halfW + 16, halfH - wh - 13);
                ctx.lineTo(-halfW - 11, halfH - wh - 8);
                ctx.closePath();
                ctx.fill();
                break;
            case 'archive':
                ctx.fillStyle = '#d8b96d';
                ctx.fillRect(-halfW - 10, halfH - wh - 16, 8, 19);
                ctx.fillStyle = '#5d432b';
                ctx.fillRect(-halfW - 8, halfH - wh - 12, 4, 10);
                break;
            case 'portal':
                ctx.strokeStyle = 'rgba(118, 216, 255, 0.72)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(halfW + 6, -wh - 7, 11, Math.PI * 0.85, Math.PI * 1.82);
                ctx.stroke();
                ctx.fillStyle = 'rgba(118, 216, 255, 0.18)';
                ctx.beginPath();
                ctx.ellipse(halfW + 2, -wh - 4, 9, 16, 0, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'sanctuary':
                ctx.fillStyle = '#355c2b';
                for (const x of [-halfW - 8, halfW + 8]) {
                    ctx.beginPath();
                    ctx.moveTo(x, halfH - wh - 30);
                    ctx.lineTo(x + 11, halfH - wh - 10);
                    ctx.lineTo(x - 11, halfH - wh - 10);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = '#664a2c';
                    ctx.fillRect(x - 1, halfH - wh - 10, 2, 12);
                    ctx.fillStyle = '#355c2b';
                }
                break;
            case 'watchtower':
                ctx.strokeStyle = '#1e2830';
                ctx.lineWidth = 1.4;
                ctx.beginPath();
                ctx.moveTo(0, -wh - halfH - 46);
                ctx.lineTo(0, -wh - halfH - 35);
                ctx.moveTo(0, -wh - halfH - 46);
                ctx.lineTo(6, -wh - halfH - 41);
                ctx.lineTo(0, -wh - halfH - 38);
                ctx.stroke();
                break;
        }
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
                // Rune-lined command deck
                ctx.fillStyle = '#3f2a18';
                ctx.fillRect(-26, -12, 52, 18);
                ctx.fillStyle = '#251b12';
                ctx.fillRect(-22, -8, 44, 11);
                ctx.fillStyle = '#5a412a';
                for (let i = 0; i < 9; i++) {
                    ctx.fillRect(-20 + i * 5.4, -10, 1, 12);
                }

                // Central tactical table.
                ctx.fillStyle = '#4d371f';
                ctx.fillRect(-9, -3, 18, 8);
                ctx.fillStyle = '#2f2016';
                ctx.fillRect(-8, -2, 16, 6);
                ctx.strokeStyle = '#f9e7a8';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(-5, 1);
                ctx.lineTo(5, 1);
                ctx.moveTo(-8, -1);
                ctx.lineTo(8, -1);
                ctx.stroke();

                // Glowing status cores.
                const signalPulse = 0.45 + Math.sin(this.torchFrame * 1.8) * 0.25;
                const core = ctx.createRadialGradient(0, -2, 0, 0, -2, 8);
                core.addColorStop(0, `rgba(132, 231, 255, ${0.22 + signalPulse * 0.25})`);
                core.addColorStop(0.6, `rgba(132, 231, 255, ${0.09 + signalPulse * 0.1})`);
                core.addColorStop(1, 'rgba(132, 231, 255, 0)');
                ctx.fillStyle = core;
                ctx.beginPath();
                ctx.ellipse(0, -2, 10, 6, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = style.coreColor;
                ctx.beginPath();
                ctx.arc(0, -1, 2.4, 0, Math.PI * 2);
                ctx.fill();

                // Console glyph markers.
                const glyphs = [
                    { x: -18, y: -1 },
                    { x: 17, y: -1 },
                    { x: 1, y: -8 },
                ];
                for (const g of glyphs) {
                    ctx.fillStyle = '#ffeeb3';
                    ctx.beginPath();
                    ctx.arc(g.x, g.y, 1.8, 0, Math.PI * 2);
                    ctx.fill();
                }
                break;
            case 'forge':
                // Hearth, anvil, and bench keep the open-roof view readable.
                ctx.fillStyle = '#2c1b14';
                ctx.fillRect(-18, -9, 20, 15);
                ctx.fillStyle = '#7d3b19';
                ctx.fillRect(-15, -6, 14, 10);
                ctx.fillStyle = '#ff5a1f';
                ctx.fillRect(-13, -4, 10, 7);
                ctx.fillStyle = '#ffd27a';
                ctx.fillRect(-10, -2, 4, 3);
                ctx.fillStyle = 'rgba(255, 91, 20, 0.24)';
                ctx.beginPath();
                ctx.ellipse(-8, 0, 18, 10, 0, 0, Math.PI * 2);
                ctx.fill();

                ctx.fillStyle = '#5e666b';
                ctx.fillRect(5, -2, 13, 4);
                ctx.fillRect(2, -5, 18, 4);
                ctx.fillRect(10, 2, 5, 6);
                ctx.fillStyle = '#8b5b31';
                ctx.fillRect(-1, 7, 25, 4);
                ctx.fillStyle = '#b77637';
                ctx.fillRect(2, 5, 19, 2);
                break;
            case 'mine':
                // Underground track and sorted ore piles.
                ctx.strokeStyle = 'rgba(31, 24, 19, 0.75)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(0, -halfH + 4);
                ctx.lineTo(-5, halfH - 5);
                ctx.moveTo(8, -halfH + 7);
                ctx.lineTo(5, halfH - 3);
                ctx.stroke();
                ctx.strokeStyle = '#8b7357';
                ctx.lineWidth = 1;
                for (let y = -halfH + 8; y < halfH - 4; y += 8) {
                    ctx.beginPath();
                    ctx.moveTo(-2, y);
                    ctx.lineTo(9, y + 2);
                    ctx.stroke();
                }

                ctx.fillStyle = '#77644c';
                ctx.beginPath();
                ctx.ellipse(-halfW * 0.34, 1, 8, 5, -0.25, 0, Math.PI * 2);
                ctx.ellipse(-halfW * 0.18, 5, 7, 4, 0.15, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#30231a';
                ctx.beginPath();
                ctx.ellipse(halfW * 0.3, -2, 7, 4, 0.25, 0, Math.PI * 2);
                ctx.fill();

                const interiorSpark = Math.sin(this.torchFrame * 3.4) > 0.15;
                ctx.fillStyle = interiorSpark ? '#f9d76d' : '#a57936';
                ctx.fillRect(-halfW * 0.38, -2, 2, 2);
                ctx.fillStyle = interiorSpark ? '#76e7ff' : '#286b78';
                ctx.fillRect(halfW * 0.27, -4, 2, 2);
                break;
            case 'taskboard':
                // Lit planning table with a miniature kanban spread.
                ctx.fillStyle = '#4d321f';
                ctx.fillRect(-14, -7, 28, 12);
                ctx.fillStyle = '#765331';
                ctx.fillRect(-12, -9, 24, 10);
                ctx.strokeStyle = '#2f2016';
                ctx.lineWidth = 1;
                ctx.strokeRect(-12.5, -9.5, 25, 11);
                ctx.fillStyle = '#e9d59a';
                ctx.fillRect(-9, -7, 6, 7);
                ctx.fillStyle = '#bfe4ef';
                ctx.fillRect(-2, -7, 5, 7);
                ctx.fillStyle = '#f0a49a';
                ctx.fillRect(5, -7, 6, 7);
                ctx.fillStyle = 'rgba(47, 32, 22, 0.45)';
                for (const x of [-7, -1, 7]) {
                    ctx.fillRect(x, -5, 3, 1);
                    ctx.fillRect(x, -2, 2, 1);
                }
                ctx.fillStyle = 'rgba(242, 211, 107, 0.38)';
                ctx.beginPath();
                ctx.arc(0, -4, 17, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'chathall':
                // Hearth table and benches for a busy tavern common room.
                ctx.fillStyle = '#735133';
                ctx.beginPath();
                ctx.ellipse(0, 0, 10, 6, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#3f2c1d';
                ctx.fillRect(-9, -2, 18, 2);
                ctx.fillStyle = '#9a6a3b';
                ctx.fillRect(-16, -7, 9, 3);
                ctx.fillRect(7, -7, 9, 3);
                ctx.fillRect(-16, 6, 9, 3);
                ctx.fillRect(7, 6, 9, 3);
                ctx.fillStyle = '#f2d36b';
                ctx.fillRect(-3, -2, 2, 2);
                ctx.fillRect(4, 1, 2, 2);
                ctx.fillStyle = '#c95735';
                ctx.fillRect(-halfW + 6, -halfH + 7, 10, 6);
                ctx.fillStyle = 'rgba(255, 148, 46, 0.52)';
                ctx.fillRect(-halfW + 8, -halfH + 9, 6, 3);
                break;
            case 'observatory':
                // Candlelit research desk: parchment, compass, and scrolls.
                ctx.fillStyle = '#3b2618';
                ctx.fillRect(-15, -8, 30, 12);
                ctx.fillStyle = '#7a4f2c';
                ctx.fillRect(-12, -10, 24, 9);
                ctx.fillStyle = '#d1a96b';
                ctx.fillRect(-9, -8, 9, 6);
                ctx.fillRect(3, -7, 7, 5);
                ctx.strokeStyle = '#8b5b2f';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(-4, -5, 3, 0, Math.PI * 2);
                ctx.moveTo(-4, -8);
                ctx.lineTo(-4, -2);
                ctx.moveTo(-7, -5);
                ctx.lineTo(-1, -5);
                ctx.moveTo(4, -5);
                ctx.lineTo(9, -5);
                ctx.stroke();
                ctx.fillStyle = '#ffbf5a';
                ctx.fillRect(12, -9, 2, 5);
                ctx.fillStyle = 'rgba(255, 191, 90, 0.26)';
                ctx.beginPath();
                ctx.arc(12, -8, 10, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'archive':
                ctx.fillStyle = '#3a2418';
                for (const x of [-18, -5, 8]) {
                    ctx.fillRect(x, -12, 9, 22);
                    ctx.fillStyle = '#d8b96d';
                    ctx.fillRect(x + 2, -9, 5, 1);
                    ctx.fillRect(x + 2, -4, 4, 1);
                    ctx.fillRect(x + 2, 2, 5, 1);
                    ctx.fillStyle = '#3a2418';
                }
                ctx.fillStyle = '#b98b4a';
                ctx.fillRect(-8, 8, 18, 5);
                ctx.fillStyle = '#ead8a6';
                ctx.fillRect(-5, 6, 12, 5);
                break;
            case 'portal':
                ctx.strokeStyle = '#76d8ff';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.ellipse(0, -3, 17, 23, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = 'rgba(118, 216, 255, 0.25)';
                ctx.beginPath();
                ctx.ellipse(0, -3, 11, 17, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#2d2444';
                ctx.fillRect(-17, 12, 34, 5);
                break;
            case 'alchemy':
                ctx.fillStyle = '#38233f';
                ctx.fillRect(-17, -8, 34, 12);
                ctx.fillStyle = '#7f4b88';
                ctx.fillRect(-14, -10, 28, 9);
                for (const p of [[-8, -7, '#c9f26b'], [2, -8, '#76d8ff'], [9, -5, '#f0a6ff']]) {
                    ctx.fillStyle = p[2];
                    ctx.beginPath();
                    ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.fillStyle = 'rgba(201, 242, 107, 0.22)';
                ctx.beginPath();
                ctx.arc(0, -5, 19, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'sanctuary':
                ctx.fillStyle = '#354227';
                ctx.beginPath();
                ctx.ellipse(0, 1, 20, 10, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#8a6a3d';
                ctx.fillRect(-18, -5, 36, 4);
                ctx.fillRect(-16, 6, 32, 4);
                ctx.fillStyle = '#f2d36b';
                ctx.fillRect(-2, -7, 4, 8);
                break;
            case 'watchtower':
                ctx.fillStyle = '#2d3135';
                ctx.fillRect(-12, -12, 24, 22);
                ctx.fillStyle = '#a8d9ff';
                ctx.fillRect(-8, -8, 5, 5);
                ctx.fillRect(3, -8, 5, 5);
                ctx.strokeStyle = '#1b1f24';
                ctx.beginPath();
                ctx.moveTo(-12, 2);
                ctx.lineTo(12, 2);
                ctx.moveTo(0, -12);
                ctx.lineTo(0, 10);
                ctx.stroke();
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

    _drawCommandRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const ov = 10;
        const peakY = -wh - halfH - 40;
        const ridgeY = -wh - halfH - 18;
        const left = { x: -halfW - ov, y: -wh - 1 };
        const back = { x: 0, y: -halfH - wh - ov };
        const right = { x: halfW + ov, y: -wh - 1 };
        const front = { x: 0, y: halfH - wh + ov * 0.7 };

        // Citadel-grade roof shell with deeper silhouette.
        ctx.fillStyle = this._lighten(style.roofColor, -24);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(back.x, back.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, -12);
        ctx.beginPath();
        ctx.moveTo(back.x, back.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, 2);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(front.x, front.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, 24);
        ctx.beginPath();
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, peakY);
        ctx.closePath();
        ctx.fill();

        // Outer battlement ring on the main roof edge.
        ctx.fillStyle = this._lighten(style.wallColor, -14);
        for (let i = -2; i < 3; i++) {
            ctx.fillRect(i * 12 - 8, -wh - 12, 7, 9);
            ctx.fillRect(i * 12 + 3, -wh - 12, 3, 7);
        }

        // Defensible watch-towers rising from the parapet line.
        ctx.fillStyle = this._lighten(style.wallColor, -6);
        for (const tower of [
            { x: left.x + 15, y: -wh + 2 },
            { x: right.x - 24, y: -wh + 2 },
            { x: -2, y: ridgeY + 4 },
        ]) {
            ctx.fillRect(tower.x, tower.y, 10, 17);
            ctx.fillStyle = this._lighten(style.roofColor, -10);
            ctx.fillRect(tower.x + 1, tower.y - 6, 8, 7);
            ctx.fillStyle = this._lighten(style.wallColor, -6);
        }

        // Central command spire and crystal socket.
        const spireY = ridgeY - 20;
        ctx.fillStyle = this._lighten(style.roofColor, -4);
        ctx.beginPath();
        ctx.moveTo(-11, ridgeY + 4);
        ctx.lineTo(11, ridgeY + 4);
        ctx.lineTo(0, spireY + 6);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = this._lighten(style.wallColor, -15);
        ctx.beginPath();
        ctx.moveTo(0, spireY);
        ctx.lineTo(-6, spireY + 6);
        ctx.lineTo(6, spireY + 6);
        ctx.closePath();
        ctx.fill();

        // Signal glow cap.
        const beaconPulse = this.motionScale ? 0.25 + (Math.sin(this.torchFrame) + 1) / 2 * 0.18 : 0.3;
        const capGlow = ctx.createRadialGradient(0, spireY + 2, 0, 0, spireY + 2, 10);
        capGlow.addColorStop(0, `rgba(255, 215, 111, ${beaconPulse + 0.45})`);
        capGlow.addColorStop(1, 'rgba(255, 215, 111, 0)');
        ctx.fillStyle = capGlow;
        ctx.beginPath();
        ctx.ellipse(0, spireY + 2, 6, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Rune grooves across the roof core.
        ctx.strokeStyle = 'rgba(255, 221, 130, 0.34)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const y = ridgeY + 4 + i * 5;
            ctx.beginPath();
            ctx.moveTo(-halfW - 2, y);
            ctx.lineTo(0, ridgeY - 2 + i * 3);
            ctx.lineTo(halfW + 2, y);
            ctx.stroke();
        }

        ctx.strokeStyle = '#2b160f';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(0, peakY);
        ctx.lineTo(right.x, right.y);
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(0, peakY);
        ctx.stroke();
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
        const ridgeY = -wh - halfH - 15;
        const mouthY = -wh + 7;

        // Layered crag silhouette, scaled up so the mine reads as a landmark.
        ctx.fillStyle = '#2f271f';
        ctx.beginPath();
        ctx.moveTo(-halfW - 12, mouthY + 3);
        ctx.lineTo(-halfW * 0.88, -wh - halfH + 1);
        ctx.lineTo(-halfW * 0.58, ridgeY + 8);
        ctx.lineTo(-halfW * 0.32, ridgeY - 8);
        ctx.lineTo(-halfW * 0.08, ridgeY + 1);
        ctx.lineTo(halfW * 0.2, ridgeY - 11);
        ctx.lineTo(halfW * 0.5, ridgeY + 4);
        ctx.lineTo(halfW * 0.82, -wh - halfH + 2);
        ctx.lineTo(halfW + 13, mouthY + 3);
        ctx.lineTo(0, halfH - wh + 9);
        ctx.closePath();
        ctx.fill();

        const rockFace = ctx.createLinearGradient(-halfW, ridgeY - 10, halfW, mouthY + 12);
        rockFace.addColorStop(0, this._lighten(style.roofColor, -22));
        rockFace.addColorStop(0.45, this._lighten(style.roofColor, -3));
        rockFace.addColorStop(1, this._lighten(style.roofColor, 15));
        ctx.fillStyle = rockFace;
        ctx.beginPath();
        ctx.moveTo(-halfW - 8, mouthY);
        ctx.lineTo(-halfW * 0.72, -wh - halfH + 5);
        ctx.lineTo(-halfW * 0.44, ridgeY - 2);
        ctx.lineTo(-halfW * 0.2, ridgeY + 9);
        ctx.lineTo(halfW * 0.12, ridgeY - 6);
        ctx.lineTo(halfW * 0.38, ridgeY + 6);
        ctx.lineTo(halfW * 0.68, -wh - halfH + 7);
        ctx.lineTo(halfW + 8, mouthY);
        ctx.lineTo(0, halfH - wh + 6);
        ctx.closePath();
        ctx.fill();

        // Faceted planes keep the mountain readable on the isometric map.
        ctx.fillStyle = 'rgba(110, 91, 67, 0.72)';
        ctx.beginPath();
        ctx.moveTo(-halfW - 4, mouthY + 1);
        ctx.lineTo(-halfW * 0.44, ridgeY - 1);
        ctx.lineTo(-halfW * 0.05, halfH - wh + 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(151, 125, 82, 0.56)';
        ctx.beginPath();
        ctx.moveTo(halfW + 4, mouthY + 1);
        ctx.lineTo(halfW * 0.12, ridgeY - 6);
        ctx.lineTo(halfW * 0.05, halfH - wh + 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(27, 20, 16, 0.35)';
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.2, ridgeY + 9);
        ctx.lineTo(halfW * 0.12, ridgeY - 6);
        ctx.lineTo(halfW * 0.05, halfH - wh + 5);
        ctx.closePath();
        ctx.fill();

        // Golden ore seam and cool crystal veins.
        ctx.strokeStyle = 'rgba(245, 200, 91, 0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.62, -wh - halfH + 10);
        ctx.lineTo(-halfW * 0.38, -wh - halfH + 1);
        ctx.lineTo(-halfW * 0.12, -wh - halfH + 8);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(95, 218, 255, 0.48)';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(halfW * 0.27, ridgeY + 5);
        ctx.lineTo(halfW * 0.45, -wh - halfH + 18);
        ctx.lineTo(halfW * 0.68, mouthY - 9);
        ctx.stroke();

        // Heavy timber cap and braces over the adit.
        ctx.strokeStyle = '#5a371f';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.56, mouthY + 4);
        ctx.lineTo(-halfW * 0.33, -wh - halfH + 8);
        ctx.lineTo(halfW * 0.33, -wh - halfH + 8);
        ctx.lineTo(halfW * 0.56, mouthY + 4);
        ctx.stroke();
        ctx.strokeStyle = '#a77a45';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.55, mouthY + 2);
        ctx.lineTo(-halfW * 0.32, -wh - halfH + 7);
        ctx.lineTo(halfW * 0.32, -wh - halfH + 7);
        ctx.lineTo(halfW * 0.55, mouthY + 2);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.38, mouthY - 8);
        ctx.lineTo(halfW * 0.38, mouthY - 8);
        ctx.stroke();
        ctx.lineCap = 'butt';

        ctx.strokeStyle = 'rgba(35, 23, 17, 0.45)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 6; i++) {
            const x = -halfW + 8 + i * (halfW / 2.5);
            ctx.beginPath();
            ctx.moveTo(x, mouthY - 1);
            ctx.lineTo(x + 8, mouthY - 15 - (i % 3) * 4);
            ctx.stroke();
        }
    }

    _drawTaskBoardRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const capY = -wh - halfH - 14;
        const eaveY = -wh - 2;
        const frontY = -wh + 14;

        // Hero notice pavilion: broad canopy with bright front eave.
        ctx.fillStyle = this._lighten(style.roofColor, -18);
        ctx.beginPath();
        ctx.moveTo(-halfW - 12, eaveY);
        ctx.lineTo(0, capY);
        ctx.lineTo(halfW + 12, eaveY);
        ctx.lineTo(0, frontY);
        ctx.closePath();
        ctx.fill();

        const frontGradient = ctx.createLinearGradient(0, capY, 0, frontY);
        frontGradient.addColorStop(0, this._lighten(style.roofColor, 28));
        frontGradient.addColorStop(1, this._lighten(style.roofColor, 4));
        ctx.fillStyle = frontGradient;
        ctx.beginPath();
        ctx.moveTo(-halfW - 6, eaveY + 4);
        ctx.lineTo(0, frontY + 2);
        ctx.lineTo(halfW + 6, eaveY + 4);
        ctx.lineTo(0, -wh + 5);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = style.trimColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-halfW - 11, eaveY + 1);
        ctx.lineTo(0, capY);
        ctx.lineTo(halfW + 11, eaveY + 1);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(38, 26, 18, 0.28)';
        ctx.lineWidth = 1;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(i * 9, capY + 5);
            ctx.lineTo(i * 14, eaveY + 3);
            ctx.stroke();
        }

        ctx.fillStyle = '#8d6435';
        ctx.fillRect(-23, -wh - 13, 46, 11);
        ctx.fillStyle = '#d9bd70';
        ctx.fillRect(-20, -wh - 11, 40, 7);
        ctx.strokeStyle = '#332216';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(-23.5, -wh - 13.5, 47, 12);
        ctx.fillStyle = '#7a1f1f';
        ctx.beginPath();
        ctx.arc(-8, -wh - 7, 2.4, 0, Math.PI * 2);
        ctx.arc(8, -wh - 7, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#2f2016';
        ctx.fillRect(-13, -wh - 8, 6, 1.4);
        ctx.fillRect(3, -wh - 8, 7, 1.4);

        ctx.fillStyle = style.accentColor;
        ctx.beginPath();
        ctx.moveTo(0, capY - 6);
        ctx.lineTo(5, capY + 1);
        ctx.lineTo(0, capY + 8);
        ctx.lineTo(-5, capY + 1);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#3a2718';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    _drawForgeRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const ov = 8;
        const ridgeY = -wh - halfH - 14;
        const left = { x: -halfW - ov, y: -wh + 1 };
        const right = { x: halfW + ov, y: -wh + 1 };
        const front = { x: 0, y: halfH - wh + ov };
        const back = { x: 0, y: -halfH - wh - ov };

        // Low blacksmith roof with a broken, heat-blackened silhouette.
        ctx.fillStyle = this._lighten(style.roofColor, -18);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(back.x, back.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, -6);
        ctx.beginPath();
        ctx.moveTo(back.x, back.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = style.roofColor;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(front.x, front.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, 16);
        ctx.beginPath();
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#16110f';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(0, ridgeY);
        ctx.lineTo(right.x, right.y);
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(0, ridgeY);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 117, 33, 0.34)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            const t = i / 4;
            ctx.beginPath();
            ctx.moveTo(left.x * (1 - t), left.y * (1 - t) + ridgeY * t);
            ctx.lineTo(front.x * (1 - t), front.y * (1 - t) + ridgeY * t);
            ctx.lineTo(right.x * (1 - t), right.y * (1 - t) + ridgeY * t);
            ctx.stroke();
        }

        // Iron ridge cap and ember cracks.
        ctx.fillStyle = '#171311';
        ctx.beginPath();
        ctx.moveTo(-5, ridgeY - 2);
        ctx.lineTo(5, ridgeY - 2);
        ctx.lineTo(8, ridgeY + 5);
        ctx.lineTo(-8, ridgeY + 5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 168, 74, 0.42)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.42, -wh - 3);
        ctx.lineTo(-halfW * 0.24, -wh - 11);
        ctx.lineTo(-halfW * 0.1, -wh - 9);
        ctx.moveTo(halfW * 0.18, -wh - 10);
        ctx.lineTo(halfW * 0.34, -wh - 3);
        ctx.stroke();
    }

    _drawChatHallRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const ov = 16;
        const ridgeY = -wh - halfH - 13;
        const left = { x: -halfW - ov, y: -wh + 1 };
        const back = { x: 0, y: -halfH - wh - ov };
        const right = { x: halfW + ov, y: -wh + 1 };
        const front = { x: 0, y: halfH - wh + ov * 0.86 };

        // Broad timber-and-thatch roof makes the hall read as a tavern, not a citadel.
        ctx.fillStyle = this._lighten(style.roofColor, -18);
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(back.x, back.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, -6);
        ctx.beginPath();
        ctx.moveTo(back.x, back.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = style.roofColor;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(front.x, front.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, 16);
        ctx.beginPath();
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(0, ridgeY);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#3a2417';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(left.x, left.y);
        ctx.lineTo(0, ridgeY);
        ctx.lineTo(right.x, right.y);
        ctx.moveTo(front.x, front.y);
        ctx.lineTo(0, ridgeY);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(246, 205, 119, 0.26)';
        ctx.lineWidth = 1.2;
        for (let i = 1; i <= 3; i++) {
            const t = i / 5;
            ctx.beginPath();
            ctx.moveTo(left.x * (1 - t), left.y * (1 - t) + ridgeY * t);
            ctx.lineTo(front.x * (1 - t), front.y * (1 - t) + ridgeY * t);
            ctx.lineTo(right.x * (1 - t), right.y * (1 - t) + ridgeY * t);
            ctx.stroke();
        }

        ctx.fillStyle = 'rgba(47, 33, 24, 0.42)';
        ctx.beginPath();
        ctx.ellipse(0, -wh + 4, halfW + 13, 12, 0, 0, Math.PI);
        ctx.fill();

        ctx.strokeStyle = 'rgba(232, 184, 91, 0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-halfW - 9, -wh + 2);
        ctx.quadraticCurveTo(-halfW * 0.42, -wh + 11, 0, -wh + 5);
        ctx.quadraticCurveTo(halfW * 0.42, -wh + 11, halfW + 9, -wh + 2);
        ctx.stroke();

        ctx.fillStyle = '#4b3524';
        ctx.fillRect(halfW * 0.35, ridgeY + 10, 7, 16);
        ctx.fillStyle = '#2b1c14';
        ctx.fillRect(halfW * 0.33, ridgeY + 8, 9, 3);

        ctx.fillStyle = '#5a3a22';
        ctx.fillRect(-18, ridgeY + 16, 36, 10);
        ctx.fillStyle = '#f1d28a';
        ctx.fillRect(-13, ridgeY + 18, 26, 5);
        ctx.strokeStyle = '#2f2118';
        ctx.lineWidth = 1;
        ctx.strokeRect(-18.5, ridgeY + 15.5, 37, 11);

        ctx.fillStyle = '#e4b85c';
        ctx.beginPath();
        ctx.ellipse(0, ridgeY + 20.5, 5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawObservatoryRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const capY = -wh - halfH - 13;
        const baseY = -wh + 1;
        const frontY = halfH - wh + 7;

        // Steep tar-shingle cap and brass armillary crown: fantasy research, not modern optics.
        ctx.fillStyle = this._lighten(style.roofColor, -10);
        ctx.beginPath();
        ctx.moveTo(-halfW - 8, baseY);
        ctx.lineTo(0, capY);
        ctx.lineTo(halfW + 8, baseY);
        ctx.lineTo(0, frontY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = this._lighten(style.roofColor, 14);
        ctx.beginPath();
        ctx.moveTo(-halfW - 3, baseY + 4);
        ctx.lineTo(0, frontY + 1);
        ctx.lineTo(halfW + 3, baseY + 4);
        ctx.lineTo(0, -wh + 4);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = '#120d0b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-halfW - 8, baseY);
        ctx.lineTo(0, capY);
        ctx.lineTo(halfW + 8, baseY);
        ctx.moveTo(0, frontY);
        ctx.lineTo(0, capY);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(201, 144, 63, 0.34)';
        ctx.lineWidth = 1;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(i * 10, baseY + 1);
            ctx.lineTo(0, capY + 5);
            ctx.stroke();
        }

        this._drawAstrolabeCrown(ctx, 4, capY - 13, style, 0, 1);
    }

    _drawArchiveRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const shelfY = -wh - halfH - 8;
        const frontY = halfH - wh + 7;
        const books = ['#2e2119', '#6f4427', '#d8b96d', '#8a5f35', '#ead8a6'];

        ctx.fillStyle = '#1d130d';
        ctx.beginPath();
        ctx.moveTo(-halfW - 9, -wh + 3);
        ctx.lineTo(0, shelfY - 19);
        ctx.lineTo(halfW + 9, -wh + 3);
        ctx.lineTo(0, frontY);
        ctx.closePath();
        ctx.fill();

        for (let i = -4; i <= 4; i++) {
            const x = i * 8;
            const h = 17 + (Math.abs(i) % 3) * 5;
            ctx.fillStyle = books[(i + 8) % books.length];
            ctx.fillRect(x - 3, shelfY - h, 6, h + 17);
            ctx.fillStyle = 'rgba(255, 238, 184, 0.45)';
            ctx.fillRect(x - 1, shelfY - h + 4, 2, h - 1);
        }

        ctx.fillStyle = '#2f1f14';
        ctx.fillRect(-halfW - 7, shelfY + 11, halfW * 2 + 14, 8);
        ctx.fillStyle = style.accentColor;
        ctx.beginPath();
        ctx.moveTo(0, shelfY - 28);
        ctx.lineTo(5, shelfY - 19);
        ctx.lineTo(0, shelfY - 10);
        ctx.lineTo(-5, shelfY - 19);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#2a1a12';
        ctx.lineWidth = 2;
        ctx.strokeRect(-halfW - 7.5, shelfY + 10.5, halfW * 2 + 15, 9);
    }

    _drawPortalRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const baseY = -wh + 6;
        const topY = -wh - halfH - 34;

        const shell = ctx.createLinearGradient(-halfW, topY, halfW, baseY + 16);
        shell.addColorStop(0, '#111322');
        shell.addColorStop(0.46, '#211f35');
        shell.addColorStop(1, '#32334a');
        ctx.fillStyle = shell;
        ctx.beginPath();
        ctx.moveTo(-halfW - 8, baseY);
        ctx.lineTo(-halfW * 0.52, topY + 18);
        ctx.lineTo(0, topY);
        ctx.lineTo(halfW * 0.52, topY + 18);
        ctx.lineTo(halfW + 8, baseY);
        ctx.lineTo(0, halfH - wh + 9);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#10101c';
        ctx.lineWidth = 2.2;
        ctx.stroke();

        ctx.strokeStyle = 'rgba(118, 216, 255, 0.22)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const inset = i * 8;
            ctx.beginPath();
            ctx.moveTo(-halfW - 1 + inset * 0.45, baseY - 1 - inset * 0.35);
            ctx.lineTo(0, topY + 7 + inset * 0.55);
            ctx.lineTo(halfW + 1 - inset * 0.45, baseY - 1 - inset * 0.35);
            ctx.stroke();
        }

        ctx.strokeStyle = style.accentColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(0, -wh - 6, halfW * 0.52, halfH + 25, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(154, 111, 255, 0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(0, -wh - 6, halfW * 0.34, halfH + 17, 0.35, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = 'rgba(118, 216, 255, 0.24)';
        ctx.beginPath();
        ctx.ellipse(0, -wh - 6, halfW * 0.26, halfH + 12, 0, 0, Math.PI * 2);
        ctx.fill();
        for (const x of [-halfW * 0.58, halfW * 0.58]) {
            ctx.fillStyle = '#24233a';
            ctx.fillRect(x - 5, -wh - halfH - 6, 10, halfH + 31);
            ctx.fillStyle = style.accentColor;
            ctx.fillRect(x - 3, -wh - halfH - 2, 6, 5);
            ctx.fillStyle = 'rgba(8, 9, 18, 0.34)';
            ctx.fillRect(x - 5, -wh - halfH + halfH + 18, 10, 7);
        }
    }

    _drawAlchemyRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const domeY = -wh - halfH - 12;
        const frontY = halfH - wh + 8;

        ctx.fillStyle = '#24152b';
        ctx.beginPath();
        ctx.moveTo(-halfW - 6, -wh + 4);
        ctx.lineTo(0, domeY - 18);
        ctx.lineTo(halfW + 6, -wh + 4);
        ctx.lineTo(0, frontY);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = this._lighten(style.roofColor, 14);
        ctx.beginPath();
        ctx.moveTo(-halfW, -wh + 7);
        ctx.lineTo(0, frontY + 2);
        ctx.lineTo(halfW, -wh + 7);
        ctx.lineTo(0, -wh - 3);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = 'rgba(201, 242, 107, 0.76)';
        ctx.beginPath();
        ctx.arc(0, domeY - 11, 12, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(118, 216, 255, 0.48)';
        ctx.beginPath();
        ctx.arc(-4, domeY - 14, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#c9f26b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, domeY + 1);
        ctx.lineTo(0, domeY + 19);
        ctx.quadraticCurveTo(-16, domeY + 23, -18, domeY + 39);
        ctx.moveTo(0, domeY + 19);
        ctx.quadraticCurveTo(16, domeY + 23, 18, domeY + 39);
        ctx.stroke();
        ctx.fillStyle = '#f0a6ff';
        ctx.beginPath();
        ctx.arc(-18, domeY + 40, 5, 0, Math.PI * 2);
        ctx.arc(18, domeY + 40, 5, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawSanctuaryRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const y = -wh - halfH - 7;
        const frontY = halfH - wh + 8;
        ctx.fillStyle = '#25311e';
        for (const tree of [
            { x: -halfW * 0.6, h: 25, r: 14 },
            { x: halfW * 0.62, h: 23, r: 13 },
            { x: 0, h: 31, r: 18 },
        ]) {
            ctx.fillRect(tree.x - 2, -wh - tree.h + 7, 4, tree.h + 18);
            ctx.fillStyle = '#6d7441';
            ctx.beginPath();
            ctx.arc(tree.x, -wh - tree.h, tree.r, 0, Math.PI * 2);
            ctx.arc(tree.x - tree.r * 0.45, -wh - tree.h + 7, tree.r * 0.72, 0, Math.PI * 2);
            ctx.arc(tree.x + tree.r * 0.45, -wh - tree.h + 7, tree.r * 0.72, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#25311e';
        }

        ctx.fillStyle = this._lighten(style.roofColor, -16);
        ctx.beginPath();
        ctx.moveTo(-halfW - 10, -wh + 2);
        ctx.quadraticCurveTo(-halfW * 0.35, y - 10, 0, y);
        ctx.quadraticCurveTo(halfW * 0.35, y - 10, halfW + 10, -wh + 2);
        ctx.lineTo(0, frontY);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = this._lighten(style.roofColor, 12);
        ctx.beginPath();
        ctx.moveTo(-halfW - 4, -wh + 6);
        ctx.quadraticCurveTo(0, y + 7, halfW + 4, -wh + 6);
        ctx.lineTo(0, frontY + 3);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#25311e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-halfW - 10, -wh + 2);
        ctx.quadraticCurveTo(0, y - 14, halfW + 10, -wh + 2);
        ctx.stroke();
        ctx.fillStyle = '#f2d36b';
        ctx.beginPath();
        ctx.arc(0, y - 1, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(242, 211, 107, 0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, y - 1, 11, 0, Math.PI * 2);
        ctx.stroke();
    }

    _drawFoundationMaterial(ctx, halfW, halfH, style) {
        ctx.save();
        ctx.strokeStyle = 'rgba(13, 9, 6, 0.38)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            const t = i / 4;
            ctx.beginPath();
            ctx.moveTo(-halfW * (1 - t), halfH * t);
            ctx.lineTo(0, halfH * (1 - t));
            ctx.lineTo(halfW * (1 - t), halfH * t);
            ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(230, 190, 118, 0.16)';
        ctx.beginPath();
        ctx.moveTo(-halfW + 4, -1);
        ctx.lineTo(0, -halfH + 3);
        ctx.lineTo(halfW - 4, -1);
        ctx.stroke();
        ctx.fillStyle = 'rgba(9, 5, 3, 0.22)';
        ctx.beginPath();
        ctx.ellipse(0, halfH - 1, halfW * 0.78, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = this._lighten(style.trimColor, 10);
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.moveTo(-halfW + 2, 0);
        ctx.lineTo(0, halfH - 1);
        ctx.lineTo(halfW - 2, 0);
        ctx.stroke();
        ctx.restore();
    }

    _drawEaveAmbientOcclusion(ctx, halfW, halfH, wh, style) {
        ctx.save();
        ctx.strokeStyle = 'rgba(10, 6, 4, 0.34)';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-halfW + 3, -wh + 1);
        ctx.lineTo(0, halfH - wh + 2);
        ctx.lineTo(halfW - 3, -wh + 1);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 228, 156, 0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-halfW + 4, -wh + 4);
        ctx.lineTo(0, halfH - wh + 5);
        ctx.lineTo(halfW - 4, -wh + 4);
        ctx.stroke();

        ctx.fillStyle = style.trimColor;
        ctx.globalAlpha = 0.65;
        for (const x of [-halfW + 8, halfW - 11]) {
            ctx.fillRect(x, -wh + 2, 3, 8);
        }
        ctx.restore();
    }

    _drawRoofEdgeHighlights(ctx, type, halfW, halfH, style) {
        const wh = style.wallHeight;
        const landmark = ['command', 'forge', 'portal', 'observatory', 'sanctuary'].includes(type);

        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(16, 9, 7, 0.46)';
        ctx.lineWidth = landmark ? 2.4 : 1.7;
        ctx.beginPath();
        ctx.moveTo(-halfW - 4, -wh + 2);
        ctx.lineTo(0, halfH - wh + 6);
        ctx.lineTo(halfW + 4, -wh + 2);
        ctx.stroke();

        ctx.strokeStyle = this._lighten(style.roofColor, landmark ? 42 : 30);
        ctx.globalAlpha = landmark ? 0.34 : 0.22;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-halfW + 3, -wh + 1);
        ctx.lineTo(0, halfH - wh + 2);
        ctx.lineTo(halfW - 3, -wh + 1);
        ctx.stroke();

        ctx.globalAlpha = landmark ? 0.32 : 0.2;
        ctx.strokeStyle = style.accentColor;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(i * (halfW / 3), -wh - 2);
            ctx.lineTo(i * (halfW / 4), -wh - halfH * 0.55);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawWatchtowerRoof(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const deckY = -wh - halfH + 4;
        ctx.fillStyle = '#1e2830';
        ctx.fillRect(-halfW - 5, deckY, halfW * 2 + 10, 8);
        ctx.fillStyle = '#32414a';
        ctx.fillRect(-halfW - 1, deckY - 7, halfW * 2 + 2, 7);
        ctx.strokeStyle = '#ffd36a';
        ctx.lineWidth = 1;
        for (let x = -halfW; x <= halfW; x += 9) {
            ctx.beginPath();
            ctx.moveTo(x, deckY - 7);
            ctx.lineTo(x, deckY + 8);
            ctx.stroke();
        }

        const lanternY = deckY - 25;
        ctx.fillStyle = '#27343d';
        ctx.fillRect(-18, lanternY - 5, 36, 21);
        ctx.fillStyle = 'rgba(255, 225, 137, 0.72)';
        ctx.fillRect(-13, lanternY - 1, 7, 13);
        ctx.fillRect(-3, lanternY - 2, 6, 14);
        ctx.fillRect(7, lanternY - 1, 7, 13);
        ctx.strokeStyle = '#121a20';
        ctx.lineWidth = 1;
        for (const x of [-16, -5, 5, 16]) {
            ctx.beginPath();
            ctx.moveTo(x, lanternY - 5);
            ctx.lineTo(x, lanternY + 16);
            ctx.stroke();
        }
        ctx.strokeRect(-18.5, lanternY - 5.5, 37, 22);

        ctx.fillStyle = style.roofColor;
        ctx.beginPath();
        ctx.moveTo(-23, lanternY - 7);
        ctx.lineTo(0, lanternY - 25);
        ctx.lineTo(23, lanternY - 7);
        ctx.lineTo(0, lanternY);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#591b1c';
        ctx.lineWidth = 2;
        ctx.stroke();
        this._drawBeaconLantern(ctx, 0, lanternY + 3, style.accentColor);
    }

    _drawAstrolabeCrown(ctx, x, y, style, rotation = 0, alpha = 1) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rotation);
        ctx.globalAlpha *= alpha;

        ctx.strokeStyle = style.accentColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(0, 0, 18, 10, 0, 0, Math.PI * 2);
        ctx.ellipse(0, 0, 10, 18, 0.28, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 191, 90, 0.72)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 14, -0.2, Math.PI * 1.28);
        ctx.stroke();
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            const x1 = Math.cos(a) * 15;
            const y1 = Math.sin(a) * 8;
            const x2 = Math.cos(a) * 19;
            const y2 = Math.sin(a) * 10;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        ctx.fillStyle = '#ffbf5a';
        ctx.beginPath();
        ctx.moveTo(0, -5);
        ctx.lineTo(5, 0);
        ctx.lineTo(0, 6);
        ctx.lineTo(-5, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#5a371f';
        ctx.stroke();
        ctx.restore();
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

    _drawBuildingLightProps(ctx, building, halfW, halfH, style) {
        switch (building.type) {
            case 'command':
                this._drawBeaconLantern(ctx, 0, -style.wallHeight - halfH - 43, '#ffd56d');
                this._drawPinLight(ctx, -halfW + 14, -style.wallHeight - halfH + 4, style.coreColor);
                this._drawPinLight(ctx, halfW - 14, -style.wallHeight - halfH + 4, style.coreColor);
                break;
            case 'forge':
                this._drawTorch(ctx, -halfW + 4, -style.wallHeight / 2 - 6);
                break;
            case 'mine':
                this._drawTorch(ctx, -halfW * 0.52, -style.wallHeight + 12);
                break;
            case 'taskboard':
                this._drawPinLight(ctx, -halfW + 13, -style.wallHeight + 12, style.accentColor);
                this._drawPinLight(ctx, halfW - 13, -style.wallHeight + 12, style.accentColor);
                break;
            case 'chathall':
                this._drawPinLight(ctx, 0, halfH - style.wallHeight / 2 - 4, '#ffcf78');
                break;
            case 'observatory':
                this._drawBeaconLantern(ctx, 4, -style.wallHeight - halfH - 26, '#ffbf5a');
                break;
            case 'archive':
                this._drawPinLight(ctx, -halfW + 11, -style.wallHeight + 10, '#d8b96d');
                this._drawPinLight(ctx, halfW - 11, -style.wallHeight + 10, '#d8b96d');
                break;
            case 'portal':
                this._drawBeaconLantern(ctx, 0, -style.wallHeight - 6, '#76d8ff');
                break;
            case 'alchemy':
                this._drawPinLight(ctx, halfW - 12, -style.wallHeight / 2 - 5, '#c9f26b');
                break;
            case 'sanctuary':
                this._drawPinLight(ctx, 0, halfH - style.wallHeight / 2 - 2, '#f2d36b');
                break;
            case 'watchtower':
                this._drawBeaconLantern(ctx, 0, -style.wallHeight - halfH - 24, '#ffd36a');
                break;
        }
    }

    _drawOpenSilhouetteAnchors(ctx, building, halfW, halfH, style, roofAlpha) {
        if (roofAlpha > 0.82) return;

        ctx.save();
        ctx.globalAlpha = 0.18 + (0.82 - roofAlpha) * 0.6;

        switch (building.type) {
            case 'command': {
                const crownY = -style.wallHeight - halfH - 18;
                ctx.fillStyle = '#281910';
                for (let x = -22; x <= 16; x += 12) {
                    ctx.fillRect(x, crownY + 14, 8, 6);
                }
                ctx.fillStyle = '#d1a95a';
                ctx.fillRect(-18, crownY + 8, 10, 11);
                ctx.fillRect(8, crownY + 8, 10, 11);
                ctx.fillStyle = '#f7e1a8';
                ctx.fillRect(-16, crownY + 5, 7, 4);
                ctx.fillRect(10, crownY + 5, 7, 4);
                ctx.strokeStyle = '#ffd56d';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(0, crownY + 19);
                ctx.lineTo(0, crownY - 22);
                ctx.stroke();
                ctx.fillStyle = style.coreColor;
                ctx.beginPath();
                ctx.arc(0, crownY - 22, 3.6, 0, Math.PI * 2);
                ctx.fill();
                break;
            }
            case 'chathall': {
                ctx.fillStyle = '#4b3020';
                ctx.fillRect(-halfW - 12, -style.wallHeight + 9, halfW * 2 + 24, 5);
                ctx.fillStyle = '#f1d28a';
                for (const x of [-halfW * 0.55, 0, halfW * 0.55]) {
                    ctx.beginPath();
                    ctx.ellipse(x, -style.wallHeight + 12, 6, 4, 0, 0, Math.PI * 2);
                    ctx.fill();
                }
                break;
            }
        }

        ctx.restore();
    }

    _drawBeaconLantern(ctx, x, y, color) {
        ctx.fillStyle = 'rgba(255, 213, 109, 0.18)';
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillRect(x - 3, y - 3, 6, 6);
        ctx.strokeStyle = '#3a2417';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }

    _drawPinLight(ctx, x, y, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(242, 211, 107, 0.2)';
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawBuildingGroundStory(ctx, building, halfW, halfH, style) {
        const t = this.torchFrame;
        ctx.save();

        switch (building.type) {
            case 'command': {
                const pulse = this.motionScale ? (Math.sin(t * 1.5) + 1) / 2 : 0.45;
                ctx.fillStyle = `rgba(44, 29, 18, ${0.34 + pulse * 0.14})`;
                ctx.beginPath();
                ctx.ellipse(0, 2, halfW + 16 + pulse * 6, halfH + 10 + pulse * 3, 0, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = `rgba(255, 219, 118, ${0.24 + pulse * 0.24})`;
                ctx.lineWidth = 1.2;
                for (let i = 0; i < 4; i++) {
                    const grow = i * 10 + pulse * 6;
                    ctx.beginPath();
                    ctx.ellipse(0, 1, halfW + 12 + grow, halfH + 7 + grow * 0.48, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.fillStyle = `rgba(140, 230, 255, ${0.1 + pulse * 0.12})`;
                for (let i = -1; i <= 1; i++) {
                    ctx.fillRect(i * 4 - 1, -style.wallHeight + i * 4 - 18, 2.5, 12);
                }
                break;
            }
            case 'forge':
                ctx.fillStyle = 'rgba(50, 28, 19, 0.38)';
                ctx.beginPath();
                ctx.ellipse(-halfW * 0.18, 7, halfW + 18, halfH + 9, 0.05, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = 'rgba(255, 113, 42, 0.18)';
                ctx.lineWidth = 1;
                for (let i = 0; i < 3; i++) {
                    const y = -3 + i * 8;
                    ctx.beginPath();
                    ctx.moveTo(-halfW - 8, y);
                    ctx.lineTo(-halfW * 0.3, y + 6);
                    ctx.lineTo(halfW * 0.35, y + 1);
                    ctx.stroke();
                }
                break;
            case 'mine':
                ctx.strokeStyle = 'rgba(37, 28, 20, 0.62)';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(-8, halfH - 2);
                ctx.lineTo(-halfW - 28, halfH + 18);
                ctx.moveTo(8, halfH - 2);
                ctx.lineTo(-halfW - 12, halfH + 22);
                ctx.stroke();
                ctx.strokeStyle = 'rgba(166, 145, 113, 0.45)';
                ctx.lineWidth = 1;
                for (let i = 0; i < 4; i++) {
                    ctx.beginPath();
                    ctx.moveTo(-halfW - 23 + i * 5, halfH + 17 - i * 3);
                    ctx.lineTo(-halfW - 11 + i * 5, halfH + 21 - i * 3);
                    ctx.stroke();
                }
                break;
            case 'taskboard':
                ctx.fillStyle = 'rgba(242, 211, 107, 0.1)';
                ctx.beginPath();
                ctx.ellipse(0, 3, halfW + 16, halfH + 12, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#d9bd70';
                for (const p of [[-halfW - 14, 0], [-halfW - 5, halfH + 8], [halfW + 10, halfH * 0.35]]) {
                    ctx.fillRect(p[0], p[1], 6, 4);
                    ctx.fillStyle = '#9fd9d1';
                }
                break;
            case 'chathall':
                ctx.fillStyle = 'rgba(255, 174, 70, 0.12)';
                ctx.beginPath();
                ctx.ellipse(0, 5, halfW + 13, halfH + 11, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#4b3020';
                ctx.fillRect(-halfW - 13, halfH * 0.25, 12, 5);
                ctx.fillRect(halfW + 1, halfH * 0.3, 12, 5);
                ctx.fillStyle = '#c9914c';
                ctx.fillRect(-halfW - 11, halfH * 0.2, 8, 3);
                ctx.fillRect(halfW + 3, halfH * 0.25, 8, 3);
                break;
            case 'observatory':
                ctx.strokeStyle = 'rgba(201, 144, 63, 0.2)';
                ctx.lineWidth = 1.2;
                for (let i = 0; i < 3; i++) {
                    ctx.beginPath();
                    ctx.ellipse(0, 2, halfW + 8 + i * 9, halfH + 7 + i * 4, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.fillStyle = 'rgba(74, 56, 43, 0.36)';
                ctx.beginPath();
                ctx.ellipse(0, 4, halfW + 8, halfH + 9, 0, 0, Math.PI * 2);
                ctx.fill();
                this._drawAstrolabeCrown(ctx, 4, -style.wallHeight - halfH - 26, style, 0, 0.38);
                break;
            case 'archive':
                ctx.fillStyle = 'rgba(216, 185, 109, 0.11)';
                ctx.beginPath();
                ctx.ellipse(0, 4, halfW + 11, halfH + 8, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = 'rgba(85, 58, 34, 0.42)';
                ctx.lineWidth = 1;
                for (let i = -2; i <= 2; i++) {
                    ctx.beginPath();
                    ctx.moveTo(i * 10, -halfH);
                    ctx.lineTo(i * 14, halfH);
                    ctx.stroke();
                }
                break;
            case 'portal':
                ctx.strokeStyle = 'rgba(118, 216, 255, 0.26)';
                ctx.lineWidth = 1.2;
                for (let i = 0; i < 3; i++) {
                    ctx.beginPath();
                    ctx.ellipse(0, 2, halfW + 8 + i * 11, halfH + 7 + i * 5, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                break;
            case 'alchemy':
                ctx.fillStyle = 'rgba(201, 242, 107, 0.11)';
                ctx.beginPath();
                ctx.ellipse(0, 2, halfW + 12, halfH + 9, 0, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'sanctuary':
                ctx.fillStyle = 'rgba(242, 211, 107, 0.08)';
                ctx.beginPath();
                ctx.ellipse(0, 5, halfW + 14, halfH + 12, 0, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'watchtower':
                ctx.strokeStyle = 'rgba(168, 217, 255, 0.16)';
                ctx.lineWidth = 1;
                for (let i = 0; i < 4; i++) {
                    ctx.beginPath();
                    ctx.ellipse(0, 1, halfW + 8 + i * 8, halfH + 6 + i * 3, 0, 0, Math.PI * 2);
                    ctx.stroke();
                }
                break;
        }

        ctx.restore();
    }

    _drawAnimatedBuildingLayer(ctx, building, halfW, halfH, style) {
        const t = this.torchFrame;
        const motion = this.motionScale;
        ctx.save();

        switch (building.type) {
            case 'command':
                this._drawCommandActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'forge':
                this._drawForgeActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'mine':
                this._drawMineActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'taskboard':
                this._drawTaskBoardActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'chathall':
                this._drawChatHallActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'observatory':
                this._drawObservatoryActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'archive':
                this._drawArchiveActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'portal':
                this._drawPortalActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'alchemy':
                this._drawAlchemyActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'sanctuary':
                this._drawSanctuaryActivity(ctx, halfW, halfH, style, t, motion);
                break;
            case 'watchtower':
                this._drawWatchtowerActivity(ctx, halfW, halfH, style, t, motion);
                break;
        }

        ctx.restore();
    }

    _drawCommandActivity(ctx, halfW, halfH, style, t, motion) {
        const beaconY = -style.wallHeight - halfH - 43;
        const coreY = -style.wallHeight - halfH - 22;
        const pulse = motion ? (Math.sin(t * 2.2) + 1) / 2 : 0.6;
        const sweep = motion ? (t * 0.7) % 1 : 0.35;
        const rotation = motion ? t * 0.45 : 0;

        ctx.strokeStyle = `rgba(255, 213, 109, ${0.28 + pulse * 0.35})`;
        ctx.lineWidth = 1.2;
        for (let i = 0; i < 3; i++) {
            const r = 7 + i * 6 + pulse * 5;
            ctx.beginPath();
            ctx.ellipse(0, beaconY, r, r * 0.55, 0, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.fillStyle = '#fff1b8';
        ctx.beginPath();
        ctx.arc(0, beaconY, 3 + pulse * 1.5, 0, Math.PI * 2);
        ctx.fill();

        const corePulse = motion ? Math.sin(t * 3.1) * 0.9 + 1.1 : 1;
        ctx.fillStyle = `rgba(132, 231, 255, ${0.24 + corePulse * 0.18})`;
        ctx.beginPath();
        ctx.arc(0, coreY, 1.8 + corePulse * 0.6, 0, Math.PI * 2);
        ctx.fill();

        // Defensive banners and rotating glyph sweep.
        const wave = motion ? Math.sin(t * 3) * 2 : 0;
        const flagY = -style.wallHeight - 20;
        for (const [sx, ox] of [[-halfW - 12, 9], [halfW + 12, -4]]) {
            ctx.fillStyle = style.bannerColor;
            ctx.beginPath();
            ctx.moveTo(sx, flagY);
            ctx.quadraticCurveTo(sx + ox, flagY - 8 + wave, sx + (sx > 0 ? 6 : 26), flagY - 2);
            ctx.quadraticCurveTo(sx + ox + (sx > 0 ? 6 : 20), flagY + 6, sx, flagY + 8);
            ctx.closePath();
            ctx.fill();
        }

        ctx.fillStyle = this._lighten(style.roofColor, 20);
        const sweepY = -style.wallHeight - halfH - 24;
        ctx.beginPath();
        ctx.moveTo(0, sweepY);
        ctx.lineTo(Math.cos(rotation + sweep) * 15, sweepY + Math.sin(rotation + sweep) * 12);
        ctx.lineTo(Math.cos(rotation + sweep + 0.18) * 15, sweepY + Math.sin(rotation + sweep + 0.18) * 12);
        ctx.closePath();
        ctx.fill();
    }

    _drawForgeActivity(ctx, halfW, halfH, style, t, motion) {
        const flame = motion ? Math.sin(t * 7) * 3 : 0;
        const hearthX = -halfW + 18;
        const hearthY = -style.wallHeight / 2 - 5;

        ctx.fillStyle = `rgba(255, 84, 24, ${0.24 + (motion ? Math.max(0, Math.sin(t * 4)) * 0.16 : 0.1)})`;
        ctx.beginPath();
        ctx.ellipse(hearthX, hearthY, 28 + flame, 18 + flame * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ff4d16';
        ctx.beginPath();
        ctx.moveTo(hearthX - 5, hearthY + 6);
        ctx.quadraticCurveTo(hearthX - 7, hearthY - 8 - flame, hearthX, hearthY - 11);
        ctx.quadraticCurveTo(hearthX + 9, hearthY - 4 + flame, hearthX + 5, hearthY + 6);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffe28a';
        ctx.beginPath();
        ctx.moveTo(hearthX - 1, hearthY + 5);
        ctx.quadraticCurveTo(hearthX, hearthY - 5 - flame * 0.4, hearthX + 4, hearthY + 5);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 178, 84, 0.38)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const x = -halfW + 4 + i * 9;
            const rise = motion ? Math.sin(t * 3 + i) * 3 : 0;
            ctx.beginPath();
            ctx.moveTo(x, -style.wallHeight - 2);
            ctx.quadraticCurveTo(x + 4, -style.wallHeight - 13 + rise, x + 1, -style.wallHeight - 25);
            ctx.stroke();
        }
    }

    _drawMineActivity(ctx, halfW, halfH, style, t, motion) {
        const cartShift = motion ? Math.sin(t * 1.7) * 3 : 0;
        ctx.fillStyle = '#2a211b';
        ctx.fillRect(-halfW - 23 + cartShift, halfH + 9, 18, 8);
        ctx.fillStyle = '#8c5f34';
        ctx.fillRect(-halfW - 21 + cartShift, halfH + 6, 14, 7);
        ctx.fillStyle = '#17110d';
        ctx.beginPath();
        ctx.arc(-halfW - 18 + cartShift, halfH + 17, 2.5, 0, Math.PI * 2);
        ctx.arc(-halfW - 9 + cartShift, halfH + 17, 2.5, 0, Math.PI * 2);
        ctx.fill();

        const glint = motion ? Math.max(0, Math.sin(t * 4.5)) : 0.65;
        ctx.strokeStyle = `rgba(255, 245, 174, ${0.22 + glint * 0.5})`;
        ctx.lineWidth = 1;
        for (const p of [[-halfW + 18, -1], [halfW - 16, 4], [2, -style.wallHeight + 10]]) {
            ctx.beginPath();
            ctx.moveTo(p[0], p[1] - 5);
            ctx.lineTo(p[0], p[1] + 5);
            ctx.moveTo(p[0] - 5, p[1]);
            ctx.lineTo(p[0] + 5, p[1]);
            ctx.stroke();
        }
    }

    _drawTaskBoardActivity(ctx, halfW, halfH, style, t, motion) {
        const phase = motion ? Math.floor(t * 2.2) % 4 : 1;
        const boardY = -style.wallHeight / 2 - 15;
        const boardX = -halfW + 1;
        const boardW = halfW * 2 - 2;
        const x = boardX + 5 + phase * ((boardW - 12) / 4);

        ctx.strokeStyle = 'rgba(255, 241, 184, 0.82)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - 1.5, boardY + 3.5, 12, 10);

        ctx.fillStyle = `rgba(242, 211, 107, ${motion ? 0.18 + Math.max(0, Math.sin(t * 3)) * 0.18 : 0.22})`;
        ctx.beginPath();
        ctx.arc(0, -style.wallHeight - 7, 13, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawChatHallActivity(ctx, halfW, halfH, style, t, motion) {
        const swing = motion ? Math.sin(t * 2.1) * 0.15 : 0;
        const signX = halfW - 19;
        const signY = -style.wallHeight + 4;

        ctx.save();
        ctx.translate(signX, signY);
        ctx.rotate(swing);
        ctx.fillStyle = '#e4b85c';
        ctx.beginPath();
        ctx.moveTo(-9, -5);
        ctx.lineTo(3, -10);
        ctx.lineTo(10, -1);
        ctx.lineTo(-2, 5);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#3a2417';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#3a2417';
        ctx.fillRect(-1, -4, 3, 3);
        ctx.restore();

        const glow = motion ? 0.2 + Math.max(0, Math.sin(t * 2.8)) * 0.22 : 0.28;
        ctx.fillStyle = `rgba(255, 207, 120, ${glow})`;
        ctx.beginPath();
        ctx.ellipse(0, -style.wallHeight + 4, halfW + 11, 11, 0, 0, Math.PI);
        ctx.fill();
    }

    _drawObservatoryActivity(ctx, halfW, halfH, style, t, motion) {
        const pulse = motion ? (Math.sin(t * 2.4) + 1) / 2 : 0.55;
        const ringX = 4;
        const ringY = -style.wallHeight - halfH - 26;
        const rotation = motion ? t * 0.28 : 0.15;

        this._drawAstrolabeCrown(ctx, ringX, ringY, style, rotation, 0.55 + pulse * 0.35);

        ctx.fillStyle = `rgba(255, 191, 90, ${0.22 + pulse * 0.26})`;
        ctx.beginPath();
        ctx.arc(ringX, ringY, 18 + pulse * 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = `rgba(255, 191, 90, ${0.28 + pulse * 0.3})`;
        ctx.lineWidth = 1;
        for (const p of [[ringX - 12, ringY - 4], [ringX + 13, ringY + 3], [ringX, ringY + 13]]) {
            ctx.beginPath();
            ctx.moveTo(p[0], p[1] - 4);
            ctx.lineTo(p[0], p[1] + 4);
            ctx.moveTo(p[0] - 4, p[1]);
            ctx.lineTo(p[0] + 4, p[1]);
            ctx.stroke();
        }
    }

    _drawArchiveActivity(ctx, halfW, halfH, style, t, motion) {
        const glow = motion ? 0.18 + Math.max(0, Math.sin(t * 2.4)) * 0.2 : 0.25;
        ctx.fillStyle = `rgba(216, 185, 109, ${glow})`;
        ctx.beginPath();
        ctx.ellipse(0, -style.wallHeight / 2 - 5, halfW + 4, 12, 0, 0, Math.PI);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 238, 184, 0.5)';
        ctx.lineWidth = 1;
        const pageX = motion ? Math.sin(t * 2) * 3 : 1;
        ctx.beginPath();
        ctx.moveTo(pageX - 8, -style.wallHeight - 3);
        ctx.quadraticCurveTo(pageX, -style.wallHeight - 8, pageX + 8, -style.wallHeight - 3);
        ctx.stroke();
    }

    _drawPortalActivity(ctx, halfW, halfH, style, t, motion) {
        const spin = motion ? t * 0.55 : 0.2;
        const y = -style.wallHeight - 6;
        ctx.save();
        ctx.translate(0, y);
        ctx.rotate(spin);
        ctx.strokeStyle = 'rgba(118, 216, 255, 0.66)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(0, 0, halfW * 0.35, halfH + 12, 0, 0, Math.PI * 2);
        ctx.ellipse(0, 0, halfW * 0.18, halfH + 18, Math.PI / 2.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = 'rgba(118, 216, 255, 0.22)';
        ctx.beginPath();
        ctx.arc(0, y, 16 + (motion ? Math.sin(t * 3) * 3 : 1), 0, Math.PI * 2);
        ctx.fill();
    }

    _drawAlchemyActivity(ctx, halfW, halfH, style, t, motion) {
        const bubble = motion ? Math.sin(t * 4) * 3 : 0;
        for (const p of [[-10, -style.wallHeight + 1, '#c9f26b'], [2, -style.wallHeight - 9, '#76d8ff'], [12, -style.wallHeight - 1, '#f0a6ff']]) {
            ctx.fillStyle = p[2];
            ctx.beginPath();
            ctx.arc(p[0], p[1] + bubble, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.strokeStyle = 'rgba(201, 242, 107, 0.48)';
        ctx.beginPath();
        ctx.moveTo(-halfW + 8, -style.wallHeight / 2);
        ctx.quadraticCurveTo(0, -style.wallHeight - 12, halfW - 8, -style.wallHeight / 2);
        ctx.stroke();
    }

    _drawSanctuaryActivity(ctx, halfW, halfH, style, t, motion) {
        const pulse = motion ? (Math.sin(t * 1.4) + 1) / 2 : 0.45;
        ctx.strokeStyle = `rgba(242, 211, 107, ${0.16 + pulse * 0.16})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(0, -style.wallHeight / 2, halfW * 0.7 + pulse * 6, halfH + pulse * 3, 0, 0, Math.PI * 2);
        ctx.stroke();
    }

    _drawWatchtowerActivity(ctx, halfW, halfH, style, t, motion) {
        const y = -style.wallHeight - halfH - 24;
        const sweep = motion ? Math.sin(t * 1.7) : 0.2;
        ctx.fillStyle = 'rgba(255, 211, 106, 0.2)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(sweep * 82 - 28, y + 23);
        ctx.lineTo(sweep * 82 + 28, y + 23);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff0b8';
        ctx.beginPath();
        ctx.arc(0, y, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawDecorations(ctx, building, halfW, halfH, style) {
        switch (building.type) {
            case 'command':
                this._drawCommandDecorations(ctx, halfW, halfH, style);
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
                this._drawChatHallDecorations(ctx, halfW, halfH, style);
                break;
            case 'observatory':
                this._drawObservatoryDecorations(ctx, halfW, halfH, style);
                break;
            case 'archive':
                this._drawArchiveDecorations(ctx, halfW, halfH, style);
                break;
            case 'portal':
                this._drawPortalDecorations(ctx, halfW, halfH, style);
                break;
            case 'alchemy':
                this._drawAlchemyDecorations(ctx, halfW, halfH, style);
                break;
            case 'sanctuary':
                this._drawSanctuaryDecorations(ctx, halfW, halfH, style);
                break;
            case 'watchtower':
                this._drawWatchtowerDecorations(ctx, halfW, halfH, style);
                break;
        }
    }

    _drawArchiveDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        ctx.fillStyle = '#2f1f14';
        ctx.fillRect(-halfW + 8, -wh + 7, 12, wh - 5);
        ctx.fillRect(halfW - 20, -wh + 7, 12, wh - 5);
        const books = ['#d8b96d', '#9fd9d1', '#c9914c', '#e7d6a4'];
        for (let i = 0; i < 7; i++) {
            ctx.fillStyle = books[i % books.length];
            ctx.fillRect(-halfW + 10 + (i % 2) * 5, -wh + 10 + i * 5, 4, 8);
            ctx.fillRect(halfW - 18 + (i % 2) * 5, -wh + 9 + i * 5, 4, 8);
        }
        ctx.fillStyle = '#ead8a6';
        ctx.fillRect(-12, halfH - wh / 3 - 8, 24, 11);
        ctx.strokeStyle = '#5d432b';
        ctx.lineWidth = 1;
        ctx.strokeRect(-12.5, halfH - wh / 3 - 8.5, 25, 12);
        ctx.fillStyle = '#6f4427';
        ctx.fillRect(-8, halfH - wh / 3 - 4, 16, 1.5);
        ctx.fillRect(-7, halfH - wh / 3, 14, 1.5);
    }

    _drawPortalDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        for (const x of [-halfW + 9, halfW - 15]) {
            ctx.fillStyle = '#211f35';
            ctx.fillRect(x, -wh + 2, 10, wh + 1);
            ctx.fillStyle = '#76d8ff';
            ctx.fillRect(x + 3, -wh + 7, 4, 9);
            ctx.fillRect(x + 3, -wh + 25, 4, 9);
        }
        ctx.strokeStyle = 'rgba(118, 216, 255, 0.48)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-halfW + 14, -wh + 12);
        ctx.lineTo(0, -wh - 2);
        ctx.lineTo(halfW - 10, -wh + 12);
        ctx.stroke();
    }

    _drawAlchemyDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        ctx.fillStyle = '#2b1731';
        ctx.fillRect(-halfW + 9, -wh / 2 - 8, 13, 15);
        ctx.fillRect(halfW - 22, -wh / 2 - 5, 13, 12);
        ctx.fillStyle = '#c9f26b';
        ctx.fillRect(-halfW + 12, -wh / 2 - 4, 7, 8);
        ctx.fillStyle = '#f0a6ff';
        ctx.fillRect(halfW - 19, -wh / 2 - 2, 7, 6);
        ctx.strokeStyle = '#24152b';
        ctx.lineWidth = 1;
        ctx.strokeRect(-halfW + 8.5, -wh / 2 - 8.5, 14, 16);
        ctx.strokeRect(halfW - 22.5, -wh / 2 - 5.5, 14, 13);
        ctx.fillStyle = '#d8b96d';
        ctx.fillRect(-8, halfH - wh / 3 - 6, 16, 8);
    }

    _drawSanctuaryDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        ctx.fillStyle = '#25311e';
        ctx.fillRect(-halfW + 7, -wh + 9, 7, wh + 2);
        ctx.fillRect(halfW - 14, -wh + 9, 7, wh + 2);
        ctx.fillStyle = '#8b9b57';
        ctx.beginPath();
        ctx.arc(-halfW + 10, -wh + 7, 10, 0, Math.PI * 2);
        ctx.arc(halfW - 10, -wh + 7, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#f2d36b';
        ctx.fillRect(-3, halfH - wh / 2 - 5, 6, 13);
        ctx.fillStyle = 'rgba(242, 211, 107, 0.24)';
        ctx.beginPath();
        ctx.arc(0, halfH - wh / 2, 15, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawWatchtowerDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        ctx.fillStyle = 'rgba(159, 47, 44, 0.9)';
        for (const y of [-wh + 12, -wh + 33, -wh + 54]) {
            ctx.fillRect(-halfW + 5, y, halfW * 2 - 10, 5);
        }
        ctx.fillStyle = '#1e2830';
        ctx.beginPath();
        ctx.moveTo(-8, halfH - 18);
        ctx.lineTo(8, halfH - 18);
        ctx.lineTo(8, halfH - 4);
        ctx.lineTo(-8, halfH - 4);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ffd36a';
        ctx.fillRect(-6, -wh + 19, 5, 7);
        ctx.fillRect(3, -wh + 39, 5, 7);
        ctx.fillRect(-3, -wh + 58, 6, 6);
    }

    _drawCommandDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const beaconY = -wh - halfH - 24;
        const bannerY = -wh - 6;

        // Command mast and signal bead.
        ctx.strokeStyle = '#6a5240';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(0, -wh + 8);
        ctx.lineTo(0, -wh - halfH - 4);
        ctx.stroke();
        ctx.fillStyle = style.coreColor;
        ctx.beginPath();
        ctx.arc(0, -wh - halfH - 4, 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(132, 231, 255, 0.3)';
        ctx.beginPath();
        ctx.ellipse(0, -wh - halfH - 4, 8, 5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Defensive banners at both flanks.
        for (const b of [-1, 1]) {
            const x = b * (halfW - 12);
            ctx.fillStyle = this._lighten(style.bannerColor, -8);
            ctx.fillRect(x, bannerY + 4, b * 2, 2);
            ctx.fillStyle = style.bannerColor;
            ctx.beginPath();
            ctx.moveTo(x, bannerY + 4);
            ctx.quadraticCurveTo(x + b * 16, bannerY - 4, x + b * 26, bannerY + 2);
            ctx.quadraticCurveTo(x + b * 12, bannerY + 8, x, bannerY + 9);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = '#281c12';
            ctx.fillRect(x + b * 10, bannerY - 1, b * 6, 2);
        }

        // Glowing runic glyph band.
        ctx.fillStyle = 'rgba(255, 219, 120, 0.38)';
        for (let i = -2; i <= 2; i++) {
            const gx = i * 7;
            ctx.fillRect(gx - 1, beaconY + i + 1, 2, 5);
            ctx.fillRect(gx + 1, beaconY + i + 3, 1, 3);
        }

        // Parapet crenellations (readability from distance).
        ctx.fillStyle = this._lighten(style.wallColor, -16);
        for (let x = -halfW + 8; x < halfW - 6; x += 10) {
            const h = (Math.abs((x / 10) % 2) < 1 ? 8 : 5);
            ctx.fillRect(x, -wh + 5, 5, h);
        }
        ctx.strokeStyle = 'rgba(132, 231, 255, 0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-halfW + 6, -wh + 4);
        ctx.lineTo(halfW - 6, -wh + 4);
        ctx.stroke();
    }

    _drawObservatoryDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const ringX = 4;
        const ringY = -wh - halfH - 26;

        ctx.strokeStyle = '#2b1c14';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-5, -wh - halfH + 2);
        ctx.lineTo(ringX - 7, ringY + 9);
        ctx.moveTo(8, -wh - halfH + 3);
        ctx.lineTo(ringX + 8, ringY + 9);
        ctx.stroke();

        // Gear teeth and chain braces under the armillary crown.
        ctx.strokeStyle = '#c9903f';
        ctx.lineWidth = 1.3;
        for (let i = 0; i < 10; i++) {
            const a = i * Math.PI * 2 / 10;
            ctx.beginPath();
            ctx.moveTo(ringX + Math.cos(a) * 10, ringY + 15 + Math.sin(a) * 5);
            ctx.lineTo(ringX + Math.cos(a) * 14, ringY + 15 + Math.sin(a) * 7);
            ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(201, 144, 63, 0.55)';
        ctx.beginPath();
        ctx.moveTo(ringX - 17, ringY + 10);
        ctx.lineTo(ringX - 19, -wh - 4);
        ctx.moveTo(ringX + 17, ringY + 10);
        ctx.lineTo(ringX + 19, -wh - 4);
        ctx.stroke();

        ctx.fillStyle = '#3b2618';
        ctx.fillRect(-halfW + 10, -wh / 2 - 10, 13, 14);
        ctx.fillStyle = 'rgba(255, 191, 90, 0.76)';
        ctx.fillRect(-halfW + 13, -wh / 2 - 7, 7, 8);
        ctx.strokeStyle = '#2b1c14';
        ctx.lineWidth = 1;
        ctx.strokeRect(-halfW + 9.5, -wh / 2 - 10.5, 14, 15);

        ctx.fillStyle = '#d1a96b';
        ctx.fillRect(halfW - 24, -wh / 2 - 5, 12, 8);
        ctx.strokeStyle = '#7a4f2c';
        ctx.beginPath();
        ctx.moveTo(halfW - 22, -wh / 2 - 2);
        ctx.lineTo(halfW - 14, -wh / 2 - 2);
        ctx.moveTo(halfW - 22, -wh / 2 + 1);
        ctx.lineTo(halfW - 15, -wh / 2 + 1);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 191, 90, 0.18)';
        ctx.beginPath();
        ctx.arc(ringX, ringY, 18, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawChatHallDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;

        // Warm bay window, pub sign, and chat mark signal a social hub.
        ctx.fillStyle = '#3c2418';
        ctx.fillRect(-9, halfH - wh / 2 - 10, 18, 12);
        ctx.fillStyle = 'rgba(255, 210, 91, 0.82)';
        ctx.fillRect(-6, halfH - wh / 2 - 7, 5, 7);
        ctx.fillRect(2, halfH - wh / 2 - 7, 5, 7);
        ctx.strokeStyle = '#7c4d2e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, halfH - wh / 2 - 8);
        ctx.lineTo(0, halfH - wh / 2 + 1);
        ctx.stroke();

        ctx.fillStyle = '#9e3e32';
        ctx.fillRect(-halfW + 8, -wh + 4, 8, 12);
        ctx.fillStyle = '#e4b85c';
        ctx.fillRect(-halfW + 11, -wh + 4, 2, 12);

        ctx.fillStyle = 'rgba(255, 168, 62, 0.22)';
        ctx.beginPath();
        ctx.arc(0, halfH - wh / 2 - 4, 20, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawForgeDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const hearthX = -halfW + 6;
        const hearthY = -wh / 2 - 13;

        // Twin chimney stack creates the landmark silhouette.
        ctx.fillStyle = '#211915';
        ctx.fillRect(15, -wh - halfH - 34, 12, 33);
        ctx.fillStyle = '#34302c';
        ctx.fillRect(18, -wh - halfH - 29, 10, 28);
        ctx.fillStyle = '#51463d';
        ctx.fillRect(12, -wh - halfH - 37, 18, 5);
        ctx.fillStyle = '#16110f';
        ctx.fillRect(14, -wh - halfH - 40, 14, 4);
        ctx.fillStyle = 'rgba(255, 122, 35, 0.22)';
        ctx.fillRect(20, -wh - halfH - 27, 4, 21);
        ctx.strokeStyle = '#100c0a';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(15.5, -wh - halfH - 33.5, 11, 32);
        ctx.strokeRect(18.5, -wh - halfH - 28.5, 9, 27);

        // Front furnace mouth with layered heat bloom.
        const glow = ctx.createRadialGradient(hearthX + 12, hearthY + 8, 2, hearthX + 12, hearthY + 8, 26);
        glow.addColorStop(0, 'rgba(255, 226, 132, 0.68)');
        glow.addColorStop(0.45, 'rgba(255, 93, 24, 0.32)');
        glow.addColorStop(1, 'rgba(255, 93, 24, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.ellipse(hearthX + 12, hearthY + 8, 31, 23, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#1b110d';
        ctx.fillRect(hearthX, hearthY, 24, 22);
        ctx.fillStyle = '#3d2419';
        ctx.fillRect(hearthX + 2, hearthY + 2, 20, 18);
        ctx.fillStyle = '#ff4d16';
        ctx.fillRect(hearthX + 5, hearthY + 7, 14, 10);
        ctx.fillStyle = '#ffd27a';
        ctx.fillRect(hearthX + 9, hearthY + 9, 6, 5);
        ctx.strokeStyle = '#0f0a08';
        ctx.lineWidth = 2;
        ctx.strokeRect(hearthX + 0.5, hearthY + 0.5, 23, 21);
        ctx.strokeStyle = '#8e4d25';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hearthX + 4, hearthY + 5);
        ctx.lineTo(hearthX + 20, hearthY + 5);
        ctx.moveTo(hearthX + 4, hearthY + 18);
        ctx.lineTo(hearthX + 20, hearthY + 18);
        ctx.stroke();

        // Iron braces and glowing ingots sell the workshop craft cue.
        ctx.strokeStyle = '#17100c';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-halfW + 3, -wh + 5);
        ctx.lineTo(-halfW + 3, 1);
        ctx.moveTo(halfW - 5, -wh + 5);
        ctx.lineTo(halfW - 5, -1);
        ctx.stroke();
        ctx.fillStyle = '#ff9a3d';
        ctx.fillRect(halfW - 23, -8, 14, 3);
        ctx.fillStyle = '#e03f17';
        ctx.fillRect(halfW - 20, -4, 10, 2);

        // Anvil and hammer at the front edge.
        ctx.fillStyle = '#35393d';
        ctx.fillRect(-10, -2, 17, 5);
        ctx.fillRect(-14, -6, 25, 5);
        ctx.fillRect(-4, 3, 6, 8);
        ctx.fillStyle = '#777f84';
        ctx.fillRect(-11, -7, 17, 2);
        ctx.strokeStyle = '#16191b';
        ctx.lineWidth = 1;
        ctx.strokeRect(-10.5, -2.5, 17, 5);
        ctx.strokeStyle = '#9b6a36';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(12, -8);
        ctx.lineTo(24, 4);
        ctx.stroke();
        ctx.fillStyle = '#6c7175';
        ctx.fillRect(8, -11, 13, 4);
    }

    _drawMineDecorations(ctx, halfW, halfH, style) {
        const wh = style.wallHeight;
        const mouthY = 1;

        // Deep portal with warm inner light and clear timber framing.
        const mouthGlow = ctx.createRadialGradient(0, mouthY - 5, 4, 0, mouthY - 1, 24);
        mouthGlow.addColorStop(0, 'rgba(251, 199, 95, 0.36)');
        mouthGlow.addColorStop(0.55, 'rgba(63, 35, 20, 0.72)');
        mouthGlow.addColorStop(1, 'rgba(12, 8, 6, 0.95)');
        ctx.fillStyle = mouthGlow;
        ctx.beginPath();
        ctx.ellipse(0, mouthY - 1, 19, 15, 0, Math.PI, 0);
        ctx.lineTo(19, mouthY + 8);
        ctx.lineTo(-19, mouthY + 8);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#070504';
        ctx.fillRect(-16, mouthY - 2, 32, 12);

        ctx.strokeStyle = '#4c2e1b';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, mouthY, 21, Math.PI, 0);
        ctx.moveTo(-19, mouthY + 8);
        ctx.lineTo(-19, mouthY - 7);
        ctx.moveTo(19, mouthY + 8);
        ctx.lineTo(19, mouthY - 7);
        ctx.stroke();
        ctx.strokeStyle = '#b07d46';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, mouthY, 20, Math.PI, 0);
        ctx.moveTo(-18, mouthY + 8);
        ctx.lineTo(-18, mouthY - 7);
        ctx.moveTo(18, mouthY + 8);
        ctx.lineTo(18, mouthY - 7);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-15, mouthY - 10);
        ctx.lineTo(15, mouthY - 10);
        ctx.moveTo(-12, mouthY + 2);
        ctx.lineTo(12, mouthY + 2);
        ctx.stroke();
        ctx.lineCap = 'butt';

        // Track leaves the mouth and sells the resource extraction purpose.
        ctx.strokeStyle = '#2b221b';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-7, mouthY + 8);
        ctx.lineTo(-18, halfH + 2);
        ctx.moveTo(7, mouthY + 8);
        ctx.lineTo(18, halfH + 2);
        ctx.stroke();
        ctx.strokeStyle = '#9a8a75';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(-7, mouthY + 8);
        ctx.lineTo(-18, halfH + 2);
        ctx.moveTo(7, mouthY + 8);
        ctx.lineTo(18, halfH + 2);
        ctx.stroke();
        ctx.strokeStyle = '#6e4a2d';
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
            const y = mouthY + 10 + i * 7;
            ctx.beginPath();
            ctx.moveTo(-10 - i * 2, y);
            ctx.lineTo(10 + i * 2, y);
            ctx.stroke();
        }

        // Loaded cart and ore spill in the foreground.
        ctx.fillStyle = '#211914';
        ctx.fillRect(-halfW + 6, 6, 24, 11);
        ctx.fillStyle = '#5b3b24';
        ctx.fillRect(-halfW + 8, 3, 20, 10);
        ctx.fillStyle = '#8e6335';
        ctx.fillRect(-halfW + 10, 1, 16, 5);
        ctx.strokeStyle = '#2a1a10';
        ctx.lineWidth = 1;
        ctx.strokeRect(-halfW + 8.5, 3.5, 19, 9);
        ctx.fillStyle = '#16100d';
        ctx.beginPath();
        ctx.arc(-halfW + 12, 16, 3, 0, Math.PI * 2);
        ctx.arc(-halfW + 25, 16, 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#74614a';
        ctx.beginPath();
        ctx.ellipse(-halfW + 19, -1, 11, 5, -0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#3c2d22';
        ctx.beginPath();
        ctx.ellipse(halfW - 14, 7, 10, 5, 0.2, 0, Math.PI * 2);
        ctx.fill();

        // Tools and sign details at the face of the mine.
        ctx.strokeStyle = '#7a4a25';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(halfW - 10, -5);
        ctx.lineTo(halfW + 6, -23);
        ctx.moveTo(halfW - 3, -4);
        ctx.lineTo(halfW + 10, -16);
        ctx.stroke();
        ctx.strokeStyle = '#b8b9ae';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(halfW + 1, -23);
        ctx.quadraticCurveTo(halfW + 10, -27, halfW + 13, -19);
        ctx.moveTo(halfW + 1, -23);
        ctx.quadraticCurveTo(halfW - 6, -25, halfW - 9, -17);
        ctx.stroke();

        ctx.fillStyle = '#c39a57';
        ctx.fillRect(-13, -wh + 5, 26, 7);
        ctx.strokeStyle = '#352115';
        ctx.lineWidth = 1;
        ctx.strokeRect(-13.5, -wh + 4.5, 27, 8);
        ctx.fillStyle = '#3a2415';
        ctx.fillRect(-8, -wh + 8, 16, 1.5);

        // Animated crystals and token-like ore glints.
        const glint = Math.sin(this.torchFrame * 3) > 0.15;
        ctx.fillStyle = glint ? '#78e8ff' : '#2a8796';
        ctx.beginPath();
        ctx.moveTo(halfW - 20, -7);
        ctx.lineTo(halfW - 16, -15);
        ctx.lineTo(halfW - 12, -7);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = glint ? '#f8d96c' : '#9b742e';
        ctx.fillRect(-halfW + 17, -3, 3, 3);
        ctx.fillRect(halfW - 18, 4, 2, 2);
        if (glint) {
            ctx.strokeStyle = 'rgba(255, 245, 174, 0.8)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(-halfW + 18.5, -7);
            ctx.lineTo(-halfW + 18.5, 2);
            ctx.moveTo(-halfW + 14, -2.5);
            ctx.lineTo(-halfW + 23, -2.5);
            ctx.moveTo(halfW - 16, 0);
            ctx.lineTo(halfW - 16, 8);
            ctx.moveTo(halfW - 20, 4);
            ctx.lineTo(halfW - 12, 4);
            ctx.stroke();
        }
    }

    _drawTaskBoardDecorations(ctx, halfW, halfH, style) {
        // Freestanding quest board with deep posts, parchment lanes, and pin lights.
        const boardY = -style.wallHeight / 2 - 15;
        const boardH = 29;
        const boardX = -halfW + 1;
        const boardW = halfW * 2 - 2;

        ctx.fillStyle = 'rgba(242, 211, 107, 0.16)';
        ctx.beginPath();
        ctx.ellipse(0, boardY + boardH / 2, halfW + 11, 24, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#2f1f14';
        ctx.fillRect(-halfW + 3, -style.wallHeight + 2, 6, style.wallHeight + 12);
        ctx.fillRect(halfW - 9, -style.wallHeight + 2, 6, style.wallHeight + 12);
        ctx.fillStyle = '#845c32';
        ctx.fillRect(-halfW + 5, -style.wallHeight + 2, 2, style.wallHeight + 10);
        ctx.fillRect(halfW - 7, -style.wallHeight + 2, 2, style.wallHeight + 10);

        ctx.fillStyle = '#3d2918';
        ctx.fillRect(boardX - 3, boardY - 3, boardW + 6, boardH + 6);
        ctx.fillStyle = '#73502d';
        ctx.fillRect(boardX, boardY, boardW, boardH);
        ctx.strokeStyle = '#21150e';
        ctx.lineWidth = 2;
        ctx.strokeRect(boardX - 2.5, boardY - 2.5, boardW + 5, boardH + 5);

        ctx.strokeStyle = '#d7ad55';
        ctx.lineWidth = 1;
        ctx.strokeRect(boardX + 2.5, boardY + 2.5, boardW - 5, boardH - 5);
        ctx.strokeStyle = 'rgba(42, 28, 17, 0.55)';
        ctx.beginPath();
        ctx.moveTo(boardX + boardW / 3, boardY + 4);
        ctx.lineTo(boardX + boardW / 3, boardY + boardH - 4);
        ctx.moveTo(boardX + boardW * 2 / 3, boardY + 4);
        ctx.lineTo(boardX + boardW * 2 / 3, boardY + boardH - 4);
        ctx.stroke();

        const noticeColors = ['#ead89c', '#d8ecff', '#f2a79d', '#bfe7a5', '#e5c0ef', '#f4cf6a', '#f7e6b2', '#9fd9d1'];
        for (let i = 0; i < noticeColors.length; i++) {
            const col = i % 4;
            const row = Math.floor(i / 4);
            const px = boardX + 5 + col * ((boardW - 12) / 4);
            const py = boardY + 5 + row * 12;
            ctx.fillStyle = 'rgba(34, 22, 14, 0.28)';
            ctx.fillRect(px + 1, py + 1, 9, 7);
            ctx.fillStyle = noticeColors[i];
            ctx.fillRect(px, py, 9, 7);
            ctx.fillStyle = '#8f5131';
            ctx.fillRect(px + 4, py - 1, 2, 2);
            ctx.fillStyle = 'rgba(41, 30, 22, 0.52)';
            ctx.fillRect(px + 2, py + 2, 5, 1);
            ctx.fillRect(px + 2, py + 5, 4, 1);
        }

        ctx.fillStyle = style.accentColor;
        ctx.beginPath();
        ctx.moveTo(-4, boardY - 5);
        ctx.lineTo(4, boardY - 5);
        ctx.lineTo(6, boardY - 1);
        ctx.lineTo(0, boardY + 4);
        ctx.lineTo(-6, boardY - 1);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#2a1b10';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = style.roofColor;
        ctx.beginPath();
        ctx.moveTo(halfW - 7, -style.wallHeight + 3);
        ctx.lineTo(halfW - 7, -style.wallHeight - 13);
        ctx.lineTo(halfW + 6, -style.wallHeight - 9);
        ctx.lineTo(halfW - 7, -style.wallHeight - 4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#2a1b10';
        ctx.lineWidth = 1;
        ctx.stroke();

        for (const x of [-halfW + 13, halfW - 13]) {
            ctx.fillStyle = '#f2d36b';
            ctx.beginPath();
            ctx.arc(x, -style.wallHeight + 12, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = 'rgba(242, 211, 107, 0.24)';
            ctx.beginPath();
            ctx.arc(x, -style.wallHeight + 12, 9, 0, Math.PI * 2);
            ctx.fill();
        }
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
        ctx.strokeStyle = 'rgba(20, 12, 8, 0.42)';
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

        ctx.strokeStyle = 'rgba(255, 224, 151, 0.12)';
        ctx.lineWidth = 0.8;
        for (let i = 0; i < 2; i++) {
            const y = -wh + 13 + i * (wh / 3.2);
            ctx.beginPath();
            ctx.moveTo(-halfW + 7 + i * 5, y - 1);
            ctx.lineTo(-2, y + halfH * 0.34);
            ctx.moveTo(halfW - 7 - i * 5, y - 1);
            ctx.lineTo(2, y + halfH * 0.34);
            ctx.stroke();
        }

        ctx.fillStyle = 'rgba(8, 5, 3, 0.1)';
        ctx.beginPath();
        ctx.moveTo(-halfW, -wh);
        ctx.lineTo(-halfW, -wh + 12);
        ctx.lineTo(0, -wh - halfH + 12);
        ctx.lineTo(0, -wh - halfH);
        ctx.closePath();
        ctx.fill();

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

            ctx.strokeStyle = 'rgba(11, 7, 5, 0.3)';
            ctx.lineWidth = 1.3;
            ctx.beginPath();
            ctx.moveTo(-halfW + 3, -wh + 2);
            ctx.lineTo(0, halfH - wh + 1);
            ctx.lineTo(halfW - 3, -wh + 2);
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
